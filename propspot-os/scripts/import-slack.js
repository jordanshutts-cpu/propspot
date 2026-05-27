#!/usr/bin/env node
/**
 * One-off: migrate a 6-year Slack export into Pulse (channels, messages,
 * file attachments, reactions, threads via reply_to_id).
 *
 * Idempotent / resume-safe via partial unique indexes on
 *   chat_channels.slack_channel_id
 *   chat_messages.slack_message_ts
 *   chat_attachments.slack_file_id
 * and the existing chat_reactions (message_id, user_id, emoji) constraint.
 *
 * Required env:
 *   DATABASE_URL            Prop Spot Postgres
 *   CLOUDINARY_CLOUD_NAME   (only for --migrate when messages have files)
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * Usage:
 *   node scripts/import-slack.js                              # dry run
 *   node scripts/import-slack.js --migrate                    # live
 *   node scripts/import-slack.js --migrate --limit-channels 1 # smoke test
 *   node scripts/import-slack.js --migrate --concurrency 10   # bump upload parallelism
 *   node scripts/import-slack.js --export-path /tmp/foo       # override default
 */

require('dotenv').config();
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const { Pool }     = require('pg');
const cloudinary   = require('cloudinary').v2;

// ── Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DO_WRITE       = args.includes('--migrate');
const CONCURRENCY    = parseInt(argVal('--concurrency', '5'), 10);
const LIMIT_CHANNELS = parseInt(argVal('--limit-channels', '0'), 10) || null;
const EXPORT_PATH    = argVal('--export-path', '/tmp/slack-export');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!fs.existsSync(EXPORT_PATH)) { console.error(`Export path not found: ${EXPORT_PATH}`); process.exit(1); }

const db = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const CLOUDINARY_OK = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (DO_WRITE && CLOUDINARY_OK) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ── Constants ───────────────────────────────────────────────────────────
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_purpose', 'channel_topic',
  'channel_archive', 'channel_unarchive', 'channel_name',
  'pinned_item', 'unpinned_item',
]);
const BOT_CHANNEL_NAME_RE = /^(.+[-_]notifications|.+[-_]screening|.+[-_]bot)$/;

// Slack reaction name → emoji char. Hardcoded for the most common.
// Unknown names are logged and skipped (the emoji column is ≤ 8 chars,
// so we can't store the name as a fallback).
const EMOJI_MAP = {
  '+1':'👍','thumbsup':'👍','-1':'👎','thumbsdown':'👎',
  'heart':'❤️','hearts':'💕','heart_eyes':'😍','two_hearts':'💕','blue_heart':'💙','green_heart':'💚','yellow_heart':'💛','purple_heart':'💜','black_heart':'🖤','white_heart':'🤍','orange_heart':'🧡',
  'fire':'🔥','tada':'🎉','party_popper':'🎉','clap':'👏','pray':'🙏','100':'💯','eyes':'👀',
  'thinking_face':'🤔','smile':'😄','smiley':'😃','grin':'😁','grinning':'😀','joy':'😂','rofl':'🤣','laughing':'😆',
  'wink':'😉','blush':'😊','cool':'😎','sunglasses':'😎','sob':'😭','cry':'😢',
  'rage':'😡','angry':'😠','triumph':'😤','muscle':'💪','wave':'👋','ok_hand':'👌',
  'point_up':'☝️','point_down':'👇','point_left':'👈','point_right':'👉','raised_hands':'🙌',
  'rocket':'🚀','star':'⭐','sparkles':'✨','zap':'⚡','bulb':'💡','warning':'⚠️',
  'white_check_mark':'✅','heavy_check_mark':'✔️','check':'✅','x':'❌','heavy_multiplication_x':'✖️','no_entry':'⛔',
  'question':'❓','exclamation':'❗','grey_question':'❔','grey_exclamation':'❕',
  'house':'🏠','house_with_garden':'🏡','office':'🏢','construction':'🚧','hammer':'🔨','hammer_and_wrench':'🛠️','wrench':'🔧','toolbox':'🧰','nail_care':'💅',
  'moneybag':'💰','money_with_wings':'💸','dollar':'💵','credit_card':'💳','chart_with_upwards_trend':'📈','chart_with_downwards_trend':'📉','bar_chart':'📊',
  'phone':'☎️','telephone':'☎️','telephone_receiver':'📞','iphone':'📱','email':'📧','envelope':'✉️','calendar':'📅','date':'📆','clock1':'🕐','alarm_clock':'⏰',
  'pencil':'✏️','pencil2':'✏️','memo':'📝','clipboard':'📋','page_facing_up':'📄','page_with_curl':'📃','open_file_folder':'📂','file_folder':'📁','floppy_disk':'💾',
  'mag':'🔍','mag_right':'🔎','key':'🔑','lock':'🔒','unlock':'🔓','link':'🔗',
  'thumbsup_all':'👍','+1::skin-tone-1':'👍','+1::skin-tone-2':'👍','+1::skin-tone-3':'👍','+1::skin-tone-4':'👍','+1::skin-tone-5':'👍','+1::skin-tone-6':'👍',
  'wave::skin-tone-2':'👋','clap::skin-tone-2':'👏','muscle::skin-tone-2':'💪','pray::skin-tone-2':'🙏',
};
function emojiFor(name) {
  if (!name) return null;
  const direct = EMOJI_MAP[name];
  if (direct) return direct;
  // Strip skin-tone suffix and retry.
  const bare = name.split('::')[0];
  return EMOJI_MAP[bare] || null;
}

// ── CSV / JSON parsing helpers ──────────────────────────────────────────
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// ── Bounded-concurrency runner ─────────────────────────────────────────
async function runConcurrent(items, n, worker) {
  const results = [];
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, pull));
  return results;
}

// ── User mapping (Slack user_id → PropSpot user_id) ────────────────────
async function buildUserMap() {
  const slackUsers = readJson(path.join(EXPORT_PATH, 'users.json'));
  // Slack user metadata we'll need later for the "**Name:** " body prefix
  const slackById = new Map();
  for (const u of slackUsers) {
    const realName = u.profile?.real_name_normalized || u.profile?.real_name || u.real_name || u.name;
    const email    = (u.profile?.email || '').toLowerCase();
    slackById.set(u.id, { name: realName, email, is_bot: !!u.is_bot });
  }

  const { rows: psUsers } = await db.query(
    'SELECT id, full_name, email, google_email FROM users'
  );
  const psByName  = new Map();
  const psByLocal = new Map();
  for (const u of psUsers) {
    if (u.full_name) psByName.set(u.full_name.toLowerCase().trim().replace(/\s+/g, ' '), u.id);
    for (const e of [u.email, u.google_email]) {
      if (!e) continue;
      const local = e.toLowerCase().split('@')[0];
      if (local) psByLocal.set(local, u.id);
    }
  }

  const slackIdToPsId = new Map();
  for (const [sid, info] of slackById) {
    const nameKey  = (info.name || '').toLowerCase();
    const localKey = (info.email || '').toLowerCase().split('@')[0];
    const psId = psByName.get(nameKey) || (localKey && psByLocal.get(localKey)) || null;
    if (psId) slackIdToPsId.set(sid, psId);
  }
  return { slackById, slackIdToPsId };
}

// ── Channel filtering ──────────────────────────────────────────────────
function listChannelFolders() {
  return fs.readdirSync(EXPORT_PATH).filter(name => {
    const full = path.join(EXPORT_PATH, name);
    return fs.statSync(full).isDirectory();
  });
}

function loadChannelMessages(channelFolder) {
  const folder = path.join(EXPORT_PATH, channelFolder);
  const files  = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort();
  const out    = [];
  for (const f of files) {
    try {
      const msgs = readJson(path.join(folder, f));
      if (Array.isArray(msgs)) out.push(...msgs);
    } catch (_) {}
  }
  // Sort by ts (string compare works because Slack ts is a fixed-format float).
  out.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return out;
}

function botShare(messages, sample = 500) {
  if (messages.length === 0) return 1; // empty channel → treat as bot
  const slice = messages.slice(0, sample);
  let bot = 0;
  for (const m of slice) {
    if (m.subtype === 'bot_message' || (m.bot_id && !m.user)) bot++;
  }
  return bot / slice.length;
}

// ── Body transformation (Slack → Pulse-compatible plain text) ──────────
function transformBody(text, slackById, channelById, slackToPsName) {
  if (!text) return '';
  let s = text;
  // User mentions: <@U016DT8J7GW>  →  @Jordan Shutts
  s = s.replace(/<@([A-Z0-9]+)>/g, (_, sid) => {
    const info = slackById.get(sid);
    return info ? `@${info.name || sid}` : `@${sid}`;
  });
  // Channel mentions: <#C12345|name>  →  #name (or #C12345 if missing)
  s = s.replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, cid, label) => `#${label || channelById.get(cid) || cid}`);
  // Broadcast mentions: <!channel>, <!here>, <!everyone>
  s = s.replace(/<!([a-z]+)(?:\|[^>]*)?>/g, (_, kw) => `@${kw}`);
  // Links: <https://url|label>  →  label (https://url)
  s = s.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, label) => `${label} (${url})`);
  // Bare links: <https://url>  →  https://url
  s = s.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url);
  // Decode the small set of HTML entities Slack escapes.
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return s;
}

// ── Cloudinary helpers ─────────────────────────────────────────────────
function uploadBufferToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: 'auto', overwrite: false },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// ── Schema self-migration ──────────────────────────────────────────────
async function selfMigrate() {
  await db.query(`
    ALTER TABLE chat_channels    ADD COLUMN IF NOT EXISTS slack_channel_id  TEXT;
    ALTER TABLE chat_messages    ADD COLUMN IF NOT EXISTS slack_message_ts  TEXT;
    ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS slack_file_id     TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_slack_uniq
      ON chat_channels (slack_channel_id) WHERE slack_channel_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_slack_uniq
      ON chat_messages (slack_message_ts) WHERE slack_message_ts IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS chat_attachments_slack_uniq
      ON chat_attachments (slack_file_id) WHERE slack_file_id IS NOT NULL;
  `);
}

// ── Channel upsert ─────────────────────────────────────────────────────
function slugify(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'channel';
}

async function upsertChannel(slackCh, allUserIds, jordanId) {
  const slug = slugify(slackCh.name);
  // Try: match by slack_channel_id first (idempotent), then by slug.
  const { rows: byId } = await db.query(
    `SELECT id FROM chat_channels WHERE slack_channel_id = $1 LIMIT 1`, [slackCh.id]
  );
  if (byId[0]) return byId[0].id;

  const { rows: bySlug } = await db.query(
    `SELECT id FROM chat_channels WHERE slug = $1 LIMIT 1`, [slug]
  );
  if (bySlug[0]) {
    // Attach the Slack ID for future idempotency.
    await db.query(
      `UPDATE chat_channels SET slack_channel_id = $1 WHERE id = $2 AND slack_channel_id IS NULL`,
      [slackCh.id, bySlug[0].id]
    );
    return bySlug[0].id;
  }

  const { rows: ins } = await db.query(`
    INSERT INTO chat_channels (slug, name, description, is_private, created_by, slack_channel_id)
    VALUES ($1, $2, $3, FALSE, $4, $5)
    RETURNING id
  `, [slug, slackCh.name, slackCh.purpose?.value || slackCh.topic?.value || '', jordanId, slackCh.id]);
  const channelId = ins[0].id;

  // Add all PropSpot users as members.
  for (const uid of allUserIds) {
    await db.query(
      `INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [channelId, uid]
    );
  }
  return channelId;
}

// ── Main ───────────────────────────────────────────────────────────────
(async () => {
  console.log(DO_WRITE ? '=== LIVE MIGRATION ===' : '=== DRY RUN ===');
  console.log(`Export: ${EXPORT_PATH}`);
  if (DO_WRITE && !CLOUDINARY_OK) console.log('Cloudinary env not set → file attachments will be SKIPPED (messages still migrate)');
  console.log('');

  await selfMigrate();

  const { slackById, slackIdToPsId } = await buildUserMap();
  console.log(`User map: ${slackIdToPsId.size} Slack users mapped to PropSpot accounts.`);

  const { rows: allPs } = await db.query('SELECT id FROM users');
  const allUserIds = allPs.map(r => r.id);
  const { rows: jordan } = await db.query(`SELECT id FROM users WHERE email = 'jordan@sellrh.com' LIMIT 1`);
  const jordanId = jordan[0]?.id || null;

  const slackChannelsMeta = readJson(path.join(EXPORT_PATH, 'channels.json'));
  const channelById = new Map(slackChannelsMeta.map(c => [c.id, c.name]));
  const metaByName  = new Map(slackChannelsMeta.map(c => [c.name, c]));

  const folders = listChannelFolders();
  const channelDecisions = [];

  for (const folder of folders) {
    const meta = metaByName.get(folder) || { id: folder, name: folder };
    const messages = loadChannelMessages(folder);

    if (messages.length === 0) {
      channelDecisions.push({ folder, decision: 'SKIP', reason: 'empty', messages: 0, meta });
      continue;
    }
    if (BOT_CHANNEL_NAME_RE.test(folder)) {
      channelDecisions.push({ folder, decision: 'SKIP', reason: 'bot-name', messages: messages.length, meta });
      continue;
    }
    const share = botShare(messages);
    if (share > 0.95) {
      channelDecisions.push({ folder, decision: 'SKIP', reason: `bot-share=${(share*100).toFixed(0)}%`, messages: messages.length, meta });
      continue;
    }
    channelDecisions.push({ folder, decision: 'KEEP', reason: '', messages: messages.length, meta });
  }

  // Apply --limit-channels (only to KEEP set, smallest first to keep smoke tests fast).
  let kept = channelDecisions.filter(d => d.decision === 'KEEP');
  if (LIMIT_CHANNELS) {
    kept.sort((a, b) => a.messages - b.messages);
    kept = kept.slice(0, LIMIT_CHANNELS);
  }
  const keptFolders = new Set(kept.map(k => k.folder));

  console.log('\nChannels:');
  for (const d of channelDecisions) {
    const mark = d.decision === 'KEEP'
      ? (keptFolders.has(d.folder) ? '✅ KEEP' : '⏭ skipped-by-limit')
      : '⏭ SKIP';
    console.log(`  ${mark.padEnd(22)} ${d.folder.padEnd(40)} msgs=${String(d.messages).padStart(6)}  ${d.reason}`);
  }
  console.log(`\nSummary: ${kept.length} channels to migrate (${channelDecisions.filter(d => d.decision === 'SKIP').length} skipped).`);

  if (!DO_WRITE) {
    console.log('\nDry run complete — pass --migrate to actually write.');
    await db.end();
    return;
  }

  // ── Live migration loop ──
  const report = {
    channels:     0,
    messages:     0,
    msg_skipped:  0,  // already-migrated (resume)
    attachments:  0,
    att_errors:   0,
    reactions:    0,
    react_skipped:0,
  };

  for (const d of kept) {
    const messages = loadChannelMessages(d.folder);
    const channelId = await upsertChannel(d.meta, allUserIds, jordanId);
    console.log(`\n📁 ${d.folder}  channel_id=${channelId.slice(0,8)}  msgs=${messages.length}`);

    // Resume-safe: pull already-migrated slack_message_ts for this channel.
    const { rows: existing } = await db.query(
      `SELECT slack_message_ts, id FROM chat_messages WHERE channel_id = $1 AND slack_message_ts IS NOT NULL`,
      [channelId]
    );
    const tsToUuid = new Map(existing.map(r => [r.slack_message_ts, r.id]));

    let chMsgs = 0, chSkipped = 0, chAtt = 0, chReact = 0;

    for (const m of messages) {
      if (!m.ts) continue;
      if (SKIP_SUBTYPES.has(m.subtype)) { chSkipped++; continue; }
      if (tsToUuid.has(m.ts)) { chSkipped++; continue; }

      const slackSenderId = m.user || m.bot_id || null;
      const senderId = slackSenderId ? (slackIdToPsId.get(slackSenderId) || null) : null;

      let body = transformBody(m.text || '', slackById, channelById);
      if (!senderId) {
        const slackInfo = slackById.get(slackSenderId);
        const label = slackInfo?.name || m.username || m.bot_profile?.name || 'Unknown';
        body = `**${label}:** ${body}`;
      }
      if (!body.trim() && (!m.files || m.files.length === 0)) {
        // empty message, nothing to insert
        chSkipped++;
        continue;
      }

      const createdAt = new Date(parseFloat(m.ts) * 1000);
      const replyToId = (m.thread_ts && m.thread_ts !== m.ts) ? (tsToUuid.get(m.thread_ts) || null) : null;

      let newMessageId;
      try {
        const { rows } = await db.query(`
          INSERT INTO chat_messages (channel_id, sender_id, body, created_at, reply_to_id, slack_message_ts)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (slack_message_ts) WHERE slack_message_ts IS NOT NULL DO NOTHING
          RETURNING id
        `, [channelId, senderId, body, createdAt, replyToId, m.ts]);
        if (rows[0]) {
          newMessageId = rows[0].id;
          tsToUuid.set(m.ts, newMessageId);
          chMsgs++;
        } else {
          chSkipped++;
          continue;
        }
      } catch (err) {
        console.error(`  ❌ msg insert failed ts=${m.ts}: ${err.message}`);
        continue;
      }

      // ── Attachments
      if (CLOUDINARY_OK && Array.isArray(m.files) && m.files.length) {
        const fileResults = await runConcurrent(m.files, CONCURRENCY, async (f) => {
          if (!f.id || !f.url_private) return { skipped: 'no-url' };
          // Skip if already migrated.
          const { rows: had } = await db.query(`SELECT 1 FROM chat_attachments WHERE slack_file_id = $1 LIMIT 1`, [f.id]);
          if (had[0]) return { skipped: 'already' };
          const resp = await fetch(f.url_private);
          if (!resp.ok) throw new Error(`download ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const folder = `propspot/chat/slack-migration/${d.meta.id || 'unknown'}`;
          const up = await uploadBufferToCloudinary(buf, folder, `${f.id}`);
          await db.query(`
            INSERT INTO chat_attachments (message_id, url, cloudinary_id, mime_type, size_bytes, filename, slack_file_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (slack_file_id) WHERE slack_file_id IS NOT NULL DO NOTHING
          `, [newMessageId, up.secure_url, up.public_id, f.mimetype || null, f.size || null, f.name || null, f.id]);
          return { ok: true };
        });
        for (const r of fileResults) {
          if (r?.ok) { chAtt++; }
          else if (r?.error) { report.att_errors++; console.error(`  ⚠ file: ${r.error.message}`); }
        }
      }

      // ── Reactions
      if (Array.isArray(m.reactions) && m.reactions.length) {
        for (const r of m.reactions) {
          const emoji = emojiFor(r.name);
          if (!emoji) { report.react_skipped += (r.users || []).length; continue; }
          for (const slackUserId of (r.users || [])) {
            const psUid = slackIdToPsId.get(slackUserId);
            if (!psUid) { report.react_skipped++; continue; }
            try {
              await db.query(`
                INSERT INTO chat_reactions (message_id, user_id, emoji)
                VALUES ($1, $2, $3)
                ON CONFLICT (message_id, user_id, emoji) DO NOTHING
              `, [newMessageId, psUid, emoji]);
              chReact++;
            } catch (e) {
              // 8-char limit edge cases: skip silently
              report.react_skipped++;
            }
          }
        }
      }

      if (chMsgs > 0 && chMsgs % 500 === 0) {
        console.log(`  …${chMsgs} msgs (atts=${chAtt}, reacts=${chReact})`);
      }
    }

    console.log(`  ✓ ${d.folder}: +${chMsgs} msgs (+${chAtt} files, +${chReact} reacts, ${chSkipped} skipped)`);
    report.channels++;
    report.messages    += chMsgs;
    report.msg_skipped += chSkipped;
    report.attachments += chAtt;
    report.reactions   += chReact;
  }

  console.log('\n=== Summary ===');
  console.log(`Channels:           ${report.channels}`);
  console.log(`Messages inserted:  ${report.messages}`);
  console.log(`Messages skipped:   ${report.msg_skipped}`);
  console.log(`Attachments:        ${report.attachments}`);
  console.log(`Attachment errors:  ${report.att_errors}`);
  console.log(`Reactions:          ${report.reactions}`);
  console.log(`Reactions skipped:  ${report.react_skipped}  (unmapped users or unmapped emoji)`);
  await db.end();
})();
