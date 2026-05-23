# Inbox signatures + Pulse thread comments

**Date:** 2026-05-22
**Status:** Draft, pending Jordan review

## 1. Goal

Bring the new Inbox app to feature-parity with Jordan's existing email tool so it can fully replace it. Two features:

1. **Per-inbox HTML email signature.** Each shared inbox (Acquisitions, etc.) has its own editable HTML signature that's appended to outgoing replies and composes.
2. **@-mentioned comments under email threads.** Internal team conversation rendered under each email thread, with @-mentions that notify and grant the mentioned user read access to that thread.

The second feature is built as a generic **Pulse entity-comments** subsystem plus an **embed widget**, not as Inbox-local tables. This follows the rule in `project_pulse.md`: "When building a new propspot app that needs comments/discussion, do NOT build a per-app comments table. Expose entity IDs and leave a slot for Pulse to inject."

## 2. Scope

**In scope:**

- `inbox_shared.signature_html` column + editor in `admin-shared.html` + signature appended in `lib/threading.js → buildRawMessage()` for replies and composes.
- New `pulse_entity_threads(entity_type, entity_id)` table.
- New nullable `chat_messages.entity_thread_id` column, with `chat_messages_target_check` expanded to "channel xor dm xor entity_thread."
- New Pulse REST endpoints under `/api/pulse/entity-threads/...` for list/post/edit/delete.
- "@-mention grants read on this thread" authorization: a `pulse_entity_thread_grants` table mints a read-only grant per (user, entity_thread) when a mention fires.
- Pulse SSE stream emits new event types `entity_thread.message_created` etc., filtered server-side by the caller's grants.
- A vanilla-JS embed widget served at `pulse.propspot.io/widget.js` that renders into any `<div id="pulse-slot" data-entity-type="..." data-entity-id="...">`.
- Inbox `thread.html` loads the widget script. (The `<div id="pulse-slot">` is already there.)
- In-app badge count: the unread-mentions counter shows on Inbox's own list page (per-thread chip + a header total). Cross-app sidebar badge — i.e. the `📧 ●N` indicator on the Inbox tile in FieldCam/Maintenance/etc. — is deferred (see below).

**Out of scope (deferred to follow-up specs):**

- Email notifications for mentions.
- Mobile push notifications. (Pulse `device_push_token` slot stays unused; we'll wire a Pulse-wide push pipeline in a separate spec.)
- Microsoft 365 / Outlook mail provider parity for the signature (Phase 2 of Inbox itself).
- Personal-mailbox signatures (Inbox Phase 2's personal-mailbox feature is itself deferred).
- Entity-comments support in other apps (FieldCam photos, Maintenance work orders). The infrastructure is built to be generic, but only Inbox consumes it in v1.
- Cross-app sidebar badge on the Inbox tile (visible from inside FieldCam, Maintenance, propspot-os, etc.). Would require each satellite to call Pulse's `unread-counts` endpoint and render a badge — fine work but 6 small repetitive changes outside this spec's core. Belongs in a follow-up "propspot-wide notifications" spec.
- WYSIWYG signature editor. v1 is raw HTML textarea with a live preview.
- Multiple signatures per inbox with a picker on send. v1 is one per inbox.

## 3. Architecture overview

```
                  ┌─────────────────────────────────────────┐
                  │              shared Postgres            │
                  │  (inbox_*, chat_*, pulse_entity_*)      │
                  └─────────────────────────────────────────┘
                       ▲                              ▲
                       │ shared DATABASE_URL          │
                       │                              │
        ┌──────────────┴──────────────┐    ┌──────────┴──────────┐
        │     inbox.propspot.io       │    │   pulse.propspot.io │
        │                             │    │                     │
        │  • signature stored on      │    │  • entity-threads   │
        │    inbox_shared             │    │    REST API         │
        │  • appended in              │    │  • SSE stream w/    │
        │    buildRawMessage()        │    │    entity events    │
        │                             │    │  • widget.js        │
        │  thread.html includes:      │◀───┤    (vanilla JS)     │
        │  <script                    │    │                     │
        │   src="pulse/widget.js">    │    │                     │
        └─────────────────────────────┘    └─────────────────────┘
                       ▲                              ▲
                       └──────────┬───────────────────┘
                                  │ same JWT_SECRET
                                  │
                            user's browser
                         (one JWT in localStorage)
```

The widget runs in the host page's origin (Inbox), but its requests go to `pulse.propspot.io`. Both apps share `JWT_SECRET` so the same bearer token authenticates against either backend. CORS on Pulse is already configured for satellite app origins.

## 4. Part A — Per-inbox HTML signatures

### 4.1 Data model

```sql
ALTER TABLE inbox_shared
  ADD COLUMN IF NOT EXISTS signature_html TEXT;
```

Nullable. Empty / NULL means "no signature appended."

### 4.2 Send pipeline change

`lib/threading.js → buildRawMessage()` takes a new optional arg `signatureHtml`. When present and non-empty, the function appends a separator + the signature to both the HTML and the plain-text branches of the multipart message:

- HTML branch: `bodyHtml + '<br><br>--<br>' + signatureHtml`
- Text branch: `bodyText + '\n\n-- \n' + stripHtml(signatureHtml)` (using a small inline HTML-to-text fallback; we don't pull in a library for this)

`routes/messages.js` resolves the signature by `shared_inbox_id` (joined to the thread) and passes it in. If the inbound request body has `include_signature: false`, the signature is skipped for that send.

### 4.3 Admin UI

`admin-shared.html` gets a third pane: when a shared inbox is selected, the right column shows the existing members list, and a new **Signature** card below it. The card has:

- A `<textarea>` for raw HTML (monospace, ~12 rows).
- A live `<iframe sandbox>` preview to the right (same sandboxing pattern Inbox already uses on `thread.html` line 172).
- A "Save signature" button. Calls `PATCH /api/shared-inboxes/:id` with `{ signature_html }`.

`routes/shared-inboxes.js → PATCH /:id`: extend the `allowed` array with `signature_html`. No additional validation — Jordan pastes whatever HTML his current tool exports.

### 4.4 Reply / compose UI

Both compose and reply forms gain a small checkbox row below the message body:

```
[✓] Include signature  (preview ▾)
```

Default checked when the resolved inbox has a non-empty signature; hidden when there's no signature on the inbox. Expanding "preview" toggles the same sandboxed iframe used in admin.

`submitReply()` / `submitCompose()` in the public JS passes `include_signature` along with the body.

### 4.5 Error handling

- Empty signature_html → endpoint accepts, signature is "cleared."
- Signature with broken HTML → sandboxed iframe contains the damage in preview; the outbound email contains it as-is (Gmail will render it however it renders).
- No JS sanitization in v1. Signatures are owner-edited only (`requireOwner` already gates the PATCH endpoint).

## 5. Part B — Pulse entity-comments (new Pulse subsystem)

### 5.1 Data model

```sql
-- One row per "comment thread" — i.e. the conversation list attached to one
-- external entity (one inbox_thread, one photo, one work_order, etc.).
CREATE TABLE pulse_entity_threads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,   -- 'inbox_thread' for v1; future: 'photo', etc.
  entity_id     UUID NOT NULL,   -- FK is enforced in app code, not DB, so Pulse
                                 -- stays decoupled from other apps' tables.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX pulse_entity_threads_lookup_idx
  ON pulse_entity_threads(entity_type, entity_id);

-- chat_messages picks up a third optional target.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS entity_thread_id UUID
    REFERENCES pulse_entity_threads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS chat_messages_entity_thread_idx
  ON chat_messages(entity_thread_id, created_at);

-- Replace the existing channel-xor-dm check with channel-xor-dm-xor-entity.
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_target_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_target_check
  CHECK (
    (channel_id        IS NOT NULL)::int +
    (dm_id             IS NOT NULL)::int +
    (entity_thread_id  IS NOT NULL)::int = 1
  );

-- Per-(user, entity_thread) read grants. Owners auto-have everything via
-- propspot-os; this table only stores the mention-derived grants.
CREATE TABLE pulse_entity_thread_grants (
  entity_thread_id UUID NOT NULL REFERENCES pulse_entity_threads(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,
  granted_via      TEXT NOT NULL,        -- 'mention' for v1; future: 'manual'
  granted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_thread_id, user_id)
);
CREATE INDEX pulse_entity_thread_grants_user_idx
  ON pulse_entity_thread_grants(user_id);
```

`pulse_entity_threads.entity_id` intentionally has no FK — Pulse never imports another app's table schema. Consumers (Inbox, FieldCam) are responsible for not handing Pulse a bogus id. When an entity row deletes, the consumer is responsible for calling `DELETE /api/pulse/entity-threads?type=...&id=...` to clean up (Inbox does this in the thread-delete path, which currently doesn't exist — see "Migrations & rollout").

### 5.2 Authorization model

A user can read / post to an entity_thread if **any** of these is true:

1. They are an owner (`users.is_owner = TRUE`).
2. The consumer app's "ambient" grant covers the underlying entity. For `entity_type = 'inbox_thread'`: the user has access to the shared inbox the thread belongs to (existing `app_grants.scope.inbox_ids` check).
3. There is a row in `pulse_entity_thread_grants(entity_thread_id, user_id)`.

Pulse can answer #1 and #3 on its own. For #2, Pulse needs to ask the consumer app "does user X have ambient access to entity Y?" There are two ways to do this:

- **Option A (chosen):** Each consumer registers a SQL view `pulse_authz_<entity_type>(entity_id, user_id)` that returns rows for (entity, user) pairs that have ambient access. Pulse's auth middleware joins against the right view based on `entity_type`. View definitions live in the consumer's schema migration, not Pulse's. Inbox ships:

  ```sql
  CREATE OR REPLACE VIEW pulse_authz_inbox_thread AS
  SELECT t.id AS entity_id, u.id AS user_id
    FROM inbox_threads t
    JOIN inbox_shared s   ON s.id = t.shared_inbox_id
    JOIN users u ON TRUE
    LEFT JOIN app_grants ag ON ag.user_id = u.id
                           AND ag.app_id = (SELECT id FROM apps WHERE slug='inbox')
   WHERE u.is_owner = TRUE
      OR ag.scope ? 'all'
      OR (ag.scope->'inbox_ids') @> to_jsonb(t.shared_inbox_id::text);
  ```

- Option B (rejected): a synchronous HTTP call from Pulse to the consumer app. Adds an inter-service round trip on every read. Pulse and consumers share the database; a view is cleaner.

### 5.3 REST API

All under `/api/pulse/entity-threads`, gated by the existing `requireAuth`:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/?type=inbox_thread&id=<uuid>` | Returns the thread row + its messages. Lazy-creates the row on first read. 403 if caller doesn't pass authz. |
| `POST` | `/?type=inbox_thread&id=<uuid>/messages` | Body: `{ body, client_message_id? }`. Parses `<@uuid>` mentions, writes `chat_messages` row, writes `chat_mentions` + `pulse_entity_thread_grants` rows for each mentioned user, broadcasts SSE. |
| `PATCH` | `/messages/:id` | Edit own message. Updates `chat_messages.edited_at`. |
| `DELETE` | `/messages/:id` | Soft delete own message via `chat_messages.deleted_at`. |
| `GET` | `/mentionable-users?type=inbox_thread&id=<uuid>` | Returns the full propspot user list, ordered by ambient-access-first then everyone else. Drives the @ picker. |
| `GET` | `/unread-counts?type=inbox_thread` | Returns `[{ entity_id, unread_mention_count }]` for the caller. Powers the Inbox sidebar badge. |

`client_message_id` lets the widget dedupe its optimistic insert against the SSE echo (same pattern Pulse already uses on `chat_messages_client_dedup_idx`).

### 5.4 SSE stream changes

Pulse's existing `/api/pulse/stream` SSE endpoint already publishes message events for channels/DMs. Add a new event type:

```json
{
  "type": "entity_thread.message_created",
  "entity_type": "inbox_thread",
  "entity_id": "...",
  "message": { "id": "...", "body": "...", "sender": { ... }, "created_at": "..." },
  "mentions": ["<user_uuid>", ...]
}
```

The server filters per-subscriber: a stream only receives events for entity_threads the subscriber has read access to. Filtering happens in [`pulse/lib/hub.js`](propspot/pulse/lib/hub.js) where the existing per-channel filter lives.

Edit / delete events follow the same pattern (`entity_thread.message_updated`, `entity_thread.message_deleted`).

### 5.5 Mention parsing

Reuse Pulse's existing approach: the client inserts `<@uuid>` tokens into the message body when the user picks someone from the @ picker. Server scans `body` with `/<@([0-9a-f-]{36})>/g`, writes one `chat_mentions` row per match, and writes a `pulse_entity_thread_grants` row for each mentioned user (idempotent on `ON CONFLICT DO NOTHING`).

If the mention picker is restricted to valid propspot users, no extra server-side validation of the uuid is required beyond "row exists in `users`."

## 6. Part C — Embed widget

### 6.1 Loader

A single script at `pulse.propspot.io/widget.js`:

- On load, finds every `<div id="pulse-slot" data-entity-type=... data-entity-id=...>` on the host page. (Or, more flexibly, all `[data-pulse-slot]` elements; v1 stays with `#pulse-slot` since `thread.html` already uses that.)
- If `data-entity-id` is empty (e.g. page hasn't loaded the thread yet), polls every 250ms for up to 5s, then gives up gracefully.
- Reads the bearer JWT from the **host app's** localStorage. Each propspot satellite namespaces its token (`inbox_token`, `fieldcam_token`, etc.) — the widget can't just hardcode one key. v1 uses a tiny inline handoff: before the `<script src=widget.js>` tag, the host page emits `<script>window.PULSE_AUTH = { token: getToken() };</script>`. The widget reads `window.PULSE_AUTH.token` and ignores localStorage entirely. This is explicit, debuggable, and works whatever the host's storage convention is.
- Connects to `${PULSE_URL}/api/pulse/stream?entity_type=...&entity_id=...` for live updates, passing the token as `?token=...` (SSE doesn't support custom auth headers in `EventSource`; the stream endpoint accepts the token via query param OR bearer, same pattern Pulse uses today).

### 6.2 Rendered DOM

Injected inside `#pulse-slot`:

```
┌─────────────────────────────────────────────────┐
│ 💬 Internal comments (3)                        │
├─────────────────────────────────────────────────┤
│ Jordan • 2:14 PM                                │
│   Hey @AccountingUser can you pay this?         │
│                                                 │
│ AccountingUser • 2:31 PM                        │
│   On it.                                        │
│                                                 │
│ ┌──────────────────────────────────────────┐   │
│ │ Type a comment… (@ to mention)           │   │
│ └──────────────────────────────────────────┘   │
│ Only people on this thread see these comments. │
└─────────────────────────────────────────────────┘
```

The composer textarea listens for `@` — pops a small floating picker hitting `GET /api/pulse/entity-threads/mentionable-users` (debounced search by name).

### 6.3 Auth handoff

The widget uses `fetch()` with `Authorization: Bearer <localStorage token>` — same JWT the host app uses, validated by Pulse with the shared `JWT_SECRET`. No new auth surface.

CORS: Pulse's existing `cors({ origin: process.env.APP_URL || '*' })` config in `pulse/server.js` needs to also allow `INBOX_URL`. We expand it to a function that checks the origin against the list of known satellite URLs from env (`OS_URL`, `HOLDINGS_URL`, `MAINTENANCE_URL`, `FIELDCAM_URL`, `INBOX_URL`).

### 6.4 Styling

Widget includes a small scoped CSS block (no global selectors) using `var(--brand, #61B746)` etc. so it picks up host page CSS variables when present and falls back to propspot brand defaults otherwise. The widget's container has the class `pulse-embed` to make it easy for host apps to override layout.

## 7. Part D — Inbox integration

Minimal Inbox-side change because the heavy lifting is in Pulse:

1. `inbox/public/thread.html`:
   - Add an inline auth handoff before the widget loads: `<script>window.PULSE_AUTH = { token: getToken() };</script>`.
   - Add `<script src="${PULSE_URL}/widget.js" defer></script>` near the bottom (after `app.js`).
   - Pass `PULSE_URL` through via the existing `/api/config` endpoint and `config.js` (`pulseUrl` is already there).
   - Set `pulse-slot`'s `data-entity-id` to `THREAD.id` (already done at `thread.html:139`).
2. `inbox/public/inbox.html` (the list page):
   - After the thread list loads, call `GET ${PULSE_URL}/api/pulse/entity-threads/unread-counts?type=inbox_thread` and render a small `💬N` chip on each thread row that has unread mentions for the caller. Also show a header total. Refresh on focus.
   - This stays inside the Inbox app's own pages. The Inbox tile in other apps' sidebars does NOT get a badge in v1 (see scope notes).
3. `inbox/routes/threads.js`: when a thread is deleted (currently we don't expose a delete; it cascades from mailbox/shared_inbox delete only), no explicit Pulse cleanup is needed because `pulse_entity_threads.entity_id` is just a UUID — orphaned rows are harmless and easy to garbage-collect later. v1 ignores cleanup.

## 8. Data flow walkthrough — "Jordan @s accounting on a bill thread"

1. Jordan opens Inbox thread `t_abc` in his browser. `thread.html` renders the email content; the Pulse widget script (already loaded via `<script src>`) finds `#pulse-slot`, reads `data-entity-id="t_abc"`, calls `GET pulse.propspot.io/api/pulse/entity-threads?type=inbox_thread&id=t_abc` with his JWT.
2. Pulse authz middleware joins `pulse_authz_inbox_thread` view: Jordan is an owner, allowed. Lazy-creates the `pulse_entity_threads` row if it doesn't exist. Returns `{ thread: {...}, messages: [] }`.
3. Jordan types `Hey @` → widget pops mention picker → `GET …/mentionable-users` returns the team list ordered with `acct@…` (no inbox access) below `jordan@…` (owner) but still selectable.
4. Jordan picks Accounting. Widget inserts `<@acct-uuid>` token, renders as a chip. Jordan hits Enter.
5. Widget `POST …/entity-threads?type=inbox_thread&id=t_abc/messages` with `{ body: 'Hey <@acct-uuid> can you pay this?', client_message_id: '<uuid>' }`.
6. Pulse:
   - Inserts `chat_messages` row with `entity_thread_id`, no `channel_id`, no `dm_id`.
   - Regex-extracts `<@acct-uuid>`, inserts `chat_mentions(message_id, mentioned_user_id)`.
   - Inserts `pulse_entity_thread_grants(entity_thread_id, user_id=acct-uuid, granted_via='mention', granted_by=jordan)`. Idempotent `ON CONFLICT DO NOTHING`.
   - Broadcasts SSE `entity_thread.message_created` to all subscribers who pass authz for this entity_thread. Now includes acct (because of the fresh grant).
7. On Accounting's open propspot session: SSE event arrives if they happen to be on an Inbox page; otherwise no badge update yet (v1 has no cross-app sidebar badge).
8. Accounting opens Inbox → list page hits `GET …/unread-counts?type=inbox_thread` → shows the bill thread with a `💬1` chip → clicks in → widget loads the comment, replies "On it."

## 9. Migrations & rollout

Single migration file (idempotent; goes into `propspot-os/db/schema.sql` per existing convention — it's the shared schema source):

```sql
-- 1. Inbox signatures
ALTER TABLE inbox_shared
  ADD COLUMN IF NOT EXISTS signature_html TEXT;

-- 2. Pulse entity-threads
CREATE TABLE IF NOT EXISTS pulse_entity_threads (...);
CREATE INDEX IF NOT EXISTS ...;
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS entity_thread_id UUID
    REFERENCES pulse_entity_threads(id) ON DELETE CASCADE;
-- (constraint swap done in a DO block guarded by pg_constraint check, same
--  pattern as the existing chat_messages_dm_fk DO block)

-- 3. Per-(user, entity_thread) grants
CREATE TABLE IF NOT EXISTS pulse_entity_thread_grants (...);

-- 4. Inbox-side authz view (lives at end of schema.sql so it sees both
--    inbox_* and app_grants tables already defined)
CREATE OR REPLACE VIEW pulse_authz_inbox_thread AS ...;
```

Rollout order:

1. Merge schema changes → propspot-os auto-deploys → tables/columns/view exist.
2. Merge Pulse changes (REST endpoints + SSE additions + widget.js + CORS expansion) → Pulse auto-deploys.
3. Merge Inbox changes (signature column wired in send pipeline + admin UI + thread.html widget script tag + sidebar badge) → Inbox auto-deploys.

Each step is backwards-compatible with the previous deployed version, so order isn't fragile. Inbox can ship before Pulse — the script tag will 404 until Pulse's deploy finishes and the widget simply doesn't render. No data corruption risk in any interleaving.

## 10. Testing strategy

**Manual smoke tests** (the propspot pattern; there's no automated test suite in the inbox/pulse subdirs today):

1. **Signature edit + preview** — open `/admin-shared.html`, pick Acquisitions, paste an HTML signature, see live preview, save, refresh, signature persists.
2. **Signature appended on reply** — open any thread, hit Reply, type a short body, send, then open the sent message in Gmail and verify the signature appears below the `--` separator.
3. **Signature skip checkbox** — same as #2 with the checkbox unchecked; verify no signature in the sent message.
4. **Empty signature** — clear the signature, save, reply — checkbox row is hidden, no separator appears.
5. **Mention picker shows everyone** — open any thread, type `@`, picker shows the full team including non-inbox-access users.
6. **Mention grants read** — Jordan @s a user with no Acquisitions grant from his browser. From a second browser logged in as that user, the thread appears in `unread-counts` and is openable. From a *third* user with no grant and no mention, the same thread is 403.
7. **SSE live update** — two browsers open the same thread; user A posts a comment; user B sees it appear without reload.
8. **Optimistic dedup** — user A's own post appears once (not twice) even though SSE echoes it back, because `client_message_id` matches.
9. **Edit + delete** — user A edits own message, sees "edited" badge. Deletes — message hidden behind `(deleted)` placeholder.
10. **Authz negative cases** — try `POST /entity-threads/...` from a user without ambient or mention grant → 403. Try `GET` on the same → 403. Try the SSE endpoint → connection accepted but no events for that entity flow through.

Tests #5–10 should be repeated end-to-end after the Pulse deploy and Inbox script-tag deploy land in production.

## 11. Open questions

None. Defaults locked in above (per-inbox single signature, raw-HTML textarea, in-app-only notifications, mention auto-grants read).
