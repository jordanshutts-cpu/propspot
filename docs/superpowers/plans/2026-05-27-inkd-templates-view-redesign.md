# Ink'd Templates View Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Templates lane inside `/inkd.html` with SignNow-style rich rows (icon, name, meta line, primary action button, "⋯" overflow menu) and add a backend `signer_count` field plus a Duplicate endpoint.

**Architecture:** All UI changes scoped to one HTML/CSS/JS trio (`public/inkd.{html,css,js}`); backend changes scoped to `routes/inkd/templates.js`. No schema changes. No new dependencies. Send flow is **not** touched — clicking "Send for signature" pre-selects the template in the existing new-envelope modal so the user can only set property + click Continue.

**Tech Stack:** Express + node-postgres on the backend (existing patterns), vanilla JS + CSS variables on the frontend, deployment via Railway on merge to `main`.

**Spec reference:** [`docs/superpowers/specs/2026-05-27-inkd-templates-view-redesign-design.md`](../specs/2026-05-27-inkd-templates-view-redesign-design.md)

**Branch:** Create from `origin/main` as `claude/inkd-templates-redesign-impl`. The spec already lives on `claude/inkd-templates-redesign-spec` — that branch should be merged into main before starting OR this branch should be rebased onto it once it lands.

---

## Working directory

All file paths in this plan are relative to:
```
/Users/jordanshutts/Library/Mobile Documents/com~apple~CloudDocs/Claude/propspot/propspot-os
```

except the spec/plan docs themselves, which live one level up at `propspot/docs/`.

**Before each subagent commit, verify the branch:**
```bash
git branch --show-current
```
Must print `claude/inkd-templates-redesign-impl`. iCloud sync can cause HEAD to shift between sessions — if you land on a different branch, `git checkout claude/inkd-templates-redesign-impl` before proceeding.

---

## File map

| File | Action | What it owns |
|---|---|---|
| `routes/inkd/templates.js` | Modify | Add `signer_count` to GET `/` query (Task 1). Add `POST /:id/duplicate` route handler (Task 2). |
| `public/inkd.css` | Modify | Append `.tpl-row` + `.tpl-menu` rules (Task 3). |
| `public/inkd.js` | Modify | Accept `preSelectTemplateId` in `openNewEnvelope` + reset on close (Task 4). Rewrite `templateRow`, add `openTemplateMenu`, add `duplicateTemplate` (Task 5). |

Existing `inkd.html` is untouched. Existing `templates.js` other endpoints (POST, PATCH, DELETE, fields PUT) are untouched.

---

## Task 1: Backend — add `signer_count` to templates list query

**Files:**
- Modify: `routes/inkd/templates.js` (current line range ~17–28, the GET `/` handler)

- [ ] **Step 1: Check the branch**

```bash
git branch --show-current
```
Expected: `claude/inkd-templates-redesign-impl`. If not, `git checkout claude/inkd-templates-redesign-impl`.

- [ ] **Step 2: Open `routes/inkd/templates.js` and locate the GET `/` handler**

It currently reads:
```js
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, description, page_count, created_at, updated_at
         FROM inkd_templates
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list templates' }); }
});
```

- [ ] **Step 3: Replace it with the version that returns `signer_count`**

```js
router.get('/', async (req, res) => {
  try {
    // signer_count = distinct recipient_role values across the template's
    // fields. NULL roles are excluded so creator-only fields (today, user.*)
    // don't inflate the count.
    const { rows } = await query(
      `SELECT t.id, t.name, t.category, t.description, t.page_count,
              t.created_at, t.updated_at,
              COALESCE(s.signer_count, 0)::int AS signer_count
         FROM inkd_templates t
         LEFT JOIN (
           SELECT template_id, COUNT(DISTINCT recipient_role) AS signer_count
             FROM inkd_template_fields
            WHERE recipient_role IS NOT NULL
            GROUP BY template_id
         ) s ON s.template_id = t.id
        WHERE t.archived_at IS NULL
        ORDER BY t.updated_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list templates' }); }
});
```

The `::int` cast forces a number; Postgres returns COUNT as a bigint string by default, which can cause `Number(t.signer_count)` to fail silently if the client doesn't coerce.

- [ ] **Step 4: Syntax-check the file**

```bash
node --check routes/inkd/templates.js
```
Expected: no output (silent success). If you see a parse error, fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add routes/inkd/templates.js
git commit -m "feat(inkd): templates list returns signer_count for new row layout"
```

---

## Task 2: Backend — add `POST /api/inkd/templates/:id/duplicate` endpoint

**Files:**
- Modify: `routes/inkd/templates.js` (append after the `DELETE /:id` handler, before the `PUT /:id/fields` handler at ~line 175)

- [ ] **Step 1: Locate the insertion point**

In `routes/inkd/templates.js`, find the existing handler:
```js
// DELETE /api/inkd/templates/:id  — soft archive
router.delete('/:id', async (req, res) => {
  try {
    await query('UPDATE inkd_templates SET archived_at=now() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to archive template' }); }
});
```

The new endpoint goes immediately after the closing `});` of that block.

- [ ] **Step 2: Add the duplicate route**

```js
// POST /api/inkd/templates/:id/duplicate  — clone a template + its fields.
// Reuses the source PDF (source_pdf_id) instead of re-uploading — Cloudinary
// is already storing the bytes, and re-upload would double the storage cost
// while gaining nothing. The duplicated template is appended with "(copy)"
// so it's easy to spot in the list. The caller (front-end) navigates the
// user to the new template's editor so they can rename it immediately.
router.post('/:id/duplicate', async (req, res) => {
  try {
    const src = await query(
      'SELECT * FROM inkd_templates WHERE id=$1 AND archived_at IS NULL',
      [req.params.id]
    );
    if (!src.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const t = src.rows[0];

    const dup = (await query(
      `INSERT INTO inkd_templates
         (name, category, description, source_pdf_url, source_pdf_id, page_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        `${t.name} (copy)`,
        t.category,
        t.description,
        t.source_pdf_url,
        t.source_pdf_id,
        t.page_count,
        req.userId,
      ]
    )).rows[0];

    await query(
      `INSERT INTO inkd_template_fields
         (template_id, page_number, x_pct, y_pct, width_pct, height_pct,
          field_type, label, recipient_role, autofill_source, display_order)
       SELECT $1, page_number, x_pct, y_pct, width_pct, height_pct,
              field_type, label, recipient_role, autofill_source, display_order
         FROM inkd_template_fields
         WHERE template_id = $2`,
      [dup.id, t.id]
    );

    res.status(201).json(dup);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to duplicate template' });
  }
});
```

- [ ] **Step 3: Syntax-check the file**

```bash
node --check routes/inkd/templates.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add routes/inkd/templates.js
git commit -m "feat(inkd): POST /api/inkd/templates/:id/duplicate clones a template"
```

---

## Task 3: Frontend CSS — `.tpl-row` and `.tpl-menu` styles

**Files:**
- Modify: `public/inkd.css` (append to end of file)

- [ ] **Step 1: Append the new CSS block**

Open `public/inkd.css` and add at the end of the file:

```css
/* ── Template rows (SignNow-style rich layout) ────────────── */
.tpl-row { display: grid; grid-template-columns: 48px 1fr auto; gap: 14px;
           align-items: center; padding: 14px 18px;
           border-bottom: 1px solid var(--border); cursor: pointer;
           transition: background .1s; }
.tpl-row:last-child { border-bottom: 0; }
.tpl-row:hover { background: var(--brand-light, rgba(97,183,70,.05)); }
.tpl-row .icon { width: 40px; height: 48px; display: flex; align-items: center;
                 justify-content: center; background: var(--bg);
                 border: 1px solid var(--border); border-radius: 4px;
                 font-size: 1.4rem; color: var(--text-muted); }
.tpl-row .body { min-width: 0; }
.tpl-row .body .name { font-weight: 600; color: var(--text);
                       overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap; }
.tpl-row .body .meta { font-size: .78rem; color: var(--text-muted);
                       margin-top: 2px; overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap; }
.tpl-row .actions { display: flex; gap: 6px; align-items: center; }
.tpl-row .actions .send { padding: 7px 14px; background: var(--brand);
                          color: #fff; border: 0; border-radius: 6px;
                          font-weight: 600; font-size: .82rem; cursor: pointer;
                          font-family: inherit; }
.tpl-row .actions .send:hover { background: var(--brand-dark, #4a9337); }
.tpl-row .actions .menu-trigger { padding: 6px 9px; background: transparent;
                                   border: 1px solid var(--border); border-radius: 6px;
                                   color: var(--text-muted); cursor: pointer;
                                   font-family: inherit; }
.tpl-row .actions .menu-trigger:hover { border-color: var(--brand);
                                         color: var(--brand); }

/* ── Template row overflow menu ───────────────────────────── */
.tpl-menu { position: absolute; min-width: 160px; background: var(--surface);
            border: 1px solid var(--border); border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 4px; z-index: 200; }
.tpl-menu button { display: block; width: 100%; padding: 8px 12px;
                   text-align: left; background: transparent; border: 0;
                   border-radius: 4px; color: var(--text); font-size: .85rem;
                   cursor: pointer; font-family: inherit; }
.tpl-menu button:hover { background: var(--brand-light, rgba(97,183,70,.08)); }
.tpl-menu button.danger { color: #ef4444; }
.tpl-menu button.danger:hover { background: #fef2f2; }
```

The existing `.inkd-row` rule (used by the Documents + Archive lanes) stays untouched. Only template rows use the new `.tpl-row` class.

- [ ] **Step 2: Commit**

```bash
git add public/inkd.css
git commit -m "feat(inkd): .tpl-row + .tpl-menu styles for the new template rows"
```

---

## Task 4: Frontend JS — `openNewEnvelope` accepts a pre-selected template

**Files:**
- Modify: `public/inkd.js` (`openNewEnvelope` at ~line 342, `closeNewEnvelope` at ~line 389)

- [ ] **Step 1: Locate `openNewEnvelope`**

Find the function signature:
```js
async function openNewEnvelope() {
  try {
```

- [ ] **Step 2: Add the parameter and pre-selection logic**

Replace just the function signature line with:
```js
async function openNewEnvelope(preSelectTemplateId) {
  try {
```

Then find this block inside the function:
```js
    const tplSel = document.getElementById('ne-template');
    if (tplSel) {
      tplSel.innerHTML = '<option value="">Pick a template…</option>' +
        templates.map(t =>
          `<option value="${t.id}">${escapeHtml(t.name)}${t.category ? ' — ' + escapeHtml(t.category) : ''}</option>`
        ).join('');
    }
```

Replace it with:
```js
    const tplSel = document.getElementById('ne-template');
    if (tplSel) {
      tplSel.innerHTML = '<option value="">Pick a template…</option>' +
        templates.map(t =>
          `<option value="${t.id}">${escapeHtml(t.name)}${t.category ? ' — ' + escapeHtml(t.category) : ''}</option>`
        ).join('');
      // When the modal is opened from a template row's "Send for signature"
      // button, lock the dropdown so the user can only edit the property —
      // they already picked a template by clicking that specific row.
      if (preSelectTemplateId) {
        tplSel.value = String(preSelectTemplateId);
        tplSel.disabled = true;
      } else {
        tplSel.disabled = false;
      }
    }
```

- [ ] **Step 3: Make `closeNewEnvelope` re-enable the select**

Find `closeNewEnvelope`:
```js
function closeNewEnvelope() {
  const el = document.getElementById('new-env-modal');
  if (el) el.hidden = true;
}
```

Replace it with:
```js
function closeNewEnvelope() {
  const el = document.getElementById('new-env-modal');
  if (el) el.hidden = true;
  // Reset the template select so the next "+ Create → Document" flow isn't
  // stuck on the previous pre-selection.
  const tplSel = document.getElementById('ne-template');
  if (tplSel) tplSel.disabled = false;
}
```

- [ ] **Step 4: Syntax-check the file**

```bash
node --check public/inkd.js
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add public/inkd.js
git commit -m "feat(inkd): openNewEnvelope(preSelectTemplateId) locks template dropdown"
```

---

## Task 5: Frontend JS — Rebuild `templateRow` + add menu and duplicate helpers

**Files:**
- Modify: `public/inkd.js` (`templateRow` at ~line 212–240; new helpers appended near the other action functions)

- [ ] **Step 1: Replace `templateRow(t)` with the new structure**

Find the current function (the entire block beginning `function templateRow(t) {` and ending with `  return div;\n}` before the line `// ── Actions ───`).

Replace it with:
```js
function templateRow(t) {
  const div = document.createElement('div');
  div.className = 'tpl-row';
  const dateStr = new Date(t.updated_at || t.created_at).toLocaleDateString(
    'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const signers = Number(t.signer_count || 0);
  const pages   = Number(t.page_count || 0);
  div.innerHTML = `
    <div class="icon">📄</div>
    <div class="body">
      <div class="name">${escapeHtml(t.name)}</div>
      <div class="meta">Updated ${dateStr} · Signers: ${signers} · ${pages} ${pages === 1 ? 'page' : 'pages'}</div>
    </div>
    <div class="actions">
      <button class="send" type="button">Send for signature</button>
      <button class="menu-trigger" type="button" aria-label="More actions">⋯</button>
    </div>
  `;
  div.addEventListener('click', () => {
    location.href = `/inkd-template-editor.html?id=${t.id}`;
  });
  div.querySelector('.send').addEventListener('click', (ev) => {
    ev.stopPropagation();
    openNewEnvelope(t.id);
  });
  div.querySelector('.menu-trigger').addEventListener('click', (ev) => {
    ev.stopPropagation();
    openTemplateMenu(ev.currentTarget, t);
  });
  return div;
}
```

- [ ] **Step 2: Add `openTemplateMenu` helper**

Append immediately after the new `templateRow` function (before the `// ── Actions ───` comment):

```js
// Open the "⋯" overflow menu next to a template row's trigger button.
// Positioned absolutely under the trigger using its bounding rect so we
// don't have to make the row a positioned ancestor. A one-shot document
// click listener closes the menu when the user clicks anywhere else,
// including another row's trigger (whose own onclick fires first and
// opens its own menu — net effect: switching rows swaps menus cleanly).
let _openTplMenu = null;
function openTemplateMenu(trigger, t) {
  if (_openTplMenu) { _openTplMenu.remove(); _openTplMenu = null; }
  const menu = document.createElement('div');
  menu.className = 'tpl-menu';
  menu.innerHTML = `
    <button type="button" data-act="edit">Edit template</button>
    <button type="button" data-act="duplicate">Duplicate</button>
    <button type="button" data-act="archive" class="danger">Archive</button>
  `;
  const rect = trigger.getBoundingClientRect();
  menu.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
  menu.style.left = (window.scrollX + rect.right - 160) + 'px';
  document.body.appendChild(menu);
  _openTplMenu = menu;

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    ev.stopPropagation();
    menu.remove(); _openTplMenu = null;
    if (btn.dataset.act === 'edit') {
      location.href = `/inkd-template-editor.html?id=${t.id}`;
    } else if (btn.dataset.act === 'duplicate') {
      await duplicateTemplate(t.id);
    } else if (btn.dataset.act === 'archive') {
      if (!confirm('Archive this template?')) return;
      await api(`/api/inkd/templates/${t.id}`, { method: 'DELETE' });
      state.templates = state.templates.filter(x => x.id !== t.id);
      updateCounts();
      render();
    }
  });

  // Close on outside click. setTimeout + capture lets the current click
  // event finish bubbling before we register the listener — otherwise the
  // same click that opened the menu would also close it.
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev) {
      if (menu.contains(ev.target)) return;
      menu.remove();
      _openTplMenu = null;
      document.removeEventListener('click', onDoc);
    });
  }, 0);
}
```

- [ ] **Step 3: Add `duplicateTemplate` helper**

Append immediately after `openTemplateMenu` (still before `// ── Actions ───`):

```js
async function duplicateTemplate(id) {
  const r = await api(`/api/inkd/templates/${id}/duplicate`, { method: 'POST' });
  if (!r.ok) { showToast('Duplicate failed', 'error'); return; }
  const dup = await r.json();
  state.templates.unshift(dup);
  updateCounts();
  render();
  // Take the user straight to the editor so they can rename "X (copy)" —
  // matches SignNow's flow and avoids "I duplicated it, now where is it?"
  location.href = `/inkd-template-editor.html?id=${dup.id}`;
}
```

- [ ] **Step 4: Syntax-check the file**

```bash
node --check public/inkd.js
```
Expected: no output.

- [ ] **Step 5: Confirm both functions are referenced correctly**

```bash
grep -n "openTemplateMenu\|duplicateTemplate" public/inkd.js
```
Expected: at least 4 lines — `openTemplateMenu` defined once and called once (from `templateRow`), `duplicateTemplate` defined once and called once (from `openTemplateMenu`). If either is undefined or unreferenced, you missed a paste.

- [ ] **Step 6: Commit**

```bash
git add public/inkd.js
git commit -m "feat(inkd): rebuild templateRow + add openTemplateMenu + duplicateTemplate"
```

---

## Task 6: Push branch and open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin claude/inkd-templates-redesign-impl
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(inkd): Phase 1 — SignNow-style template rows + duplicate" --body "$(cat <<'EOF'
## Summary
Phase 1 of the SignNow-style Ink'd redesign — Templates lane only. Send flow untouched.

- Templates list rows: icon + name + "Updated <date> · Signers: N · M page(s)" + green "Send for signature" button + "⋯" menu.
- "⋯" menu offers Edit / Duplicate / Archive.
- "Send for signature" opens the existing new-envelope modal with this template pre-selected and the dropdown disabled (one fewer click).

## Backend
- \`GET /api/inkd/templates\` now returns \`signer_count\` (distinct \`recipient_role\` values across the template's fields).
- New \`POST /api/inkd/templates/:id/duplicate\` clones a template (including all fields) and reuses the source PDF — no Cloudinary re-upload.

## Frontend
- \`public/inkd.css\` — new \`.tpl-row\` and \`.tpl-menu\` rules.
- \`public/inkd.js\` — \`templateRow()\` rebuilt; \`openNewEnvelope\` accepts \`preSelectTemplateId\`; new \`openTemplateMenu\` + \`duplicateTemplate\` helpers; \`closeNewEnvelope\` re-enables the dropdown.

## Spec
[docs/superpowers/specs/2026-05-27-inkd-templates-view-redesign-design.md](docs/superpowers/specs/2026-05-27-inkd-templates-view-redesign-design.md)

## Test plan
After merge + Railway redeploy + hard-refresh \`/inkd.html\`:

- [ ] Templates lane shows new rows (icon, name, meta line, green Send button, ⋯).
- [ ] Documents + Archive lanes still use the old \`.inkd-row\` layout — no regression.
- [ ] Signer count is 0 for a freshly uploaded template with no role-assigned fields; rises to 2 for a template with buyer + seller fields.
- [ ] Click row body → opens template editor.
- [ ] Click "Send for signature" → modal opens, template dropdown is pre-selected and disabled, property picker works, Continue navigates to composer.
- [ ] Open the dashboard "+ Create → Document" → template dropdown is NOT disabled (next user can pick a different template).
- [ ] Click "⋯" → menu appears. Outside click closes it. Clicking another row's "⋯" switches menus.
- [ ] "Edit template" menu item → navigates to editor.
- [ ] "Duplicate" → new template "<Name> (copy)" appears at top of list, auto-opens in editor.
- [ ] "Archive" → confirm dialog → template disappears from list.
- [ ] Dark mode renders correctly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Hand the PR URL back to Jordan**

Report back: "PR opened at <url>. Merge, wait ~60s for Railway, hard-refresh `/inkd.html`, then walk the test plan."

---

## Task 7: Post-merge smoke test (Jordan-driven, not subagent)

This task runs after Jordan merges the PR. The implementer does NOT execute this — it's here so the test plan stays attached to the implementation plan in case anything regresses.

- [ ] **Step 1:** Jordan merges the PR on GitHub.
- [ ] **Step 2:** Wait ~60 seconds for Railway auto-deploy.
- [ ] **Step 3:** Hard-refresh `https://app.propspot.com/inkd.html` (Cmd+Shift+R).
- [ ] **Step 4:** Click Templates in the left sidebar. Confirm the new row layout.
- [ ] **Step 5:** Verify each item in the PR test plan above.
- [ ] **Step 6:** If any item fails, return to this plan and add a follow-up task.

---

## Self-review checklist (for the implementer, before opening the PR)

Run these `grep`s and visually scan results:

```bash
# Confirm signer_count survives JSON round-trip
grep -n "signer_count" routes/inkd/templates.js public/inkd.js
# Expect: 2 hits in templates.js (query SELECT + COUNT), 1 hit in inkd.js (templateRow uses t.signer_count)

# Confirm duplicate endpoint exists and is reachable from the client
grep -n "duplicate" routes/inkd/templates.js public/inkd.js
# Expect: route + duplicateTemplate function + at least one call site

# Confirm openTemplateMenu is wired from templateRow
grep -n "openTemplateMenu" public/inkd.js
# Expect: 1 definition + 1 call site

# Confirm no stale references to the old templateRow markup
grep -n "inkd-row.*tpl\|t.page_count.*page" public/inkd.js
# Expect: only the new templateRow paste — old "page_count} page" string from the prior
# version should be gone.

# Confirm CSS classes used by JS are defined in CSS
grep -n "tpl-row\|tpl-menu" public/inkd.css public/inkd.js
# Expect: definitions in inkd.css, usages in inkd.js.
```

If any expectation isn't met, fix before pushing.

---

## Notes for the implementer

- **Do NOT mock the database, do NOT add a test framework.** This project does not have unit tests; verification is the manual smoke test in Task 7. Adding tests in this PR would balloon scope.
- **Do NOT touch `inkd-send.html` / `inkd-send.js`.** The send flow is intentionally untouched in this phase. PR #212 (composer PDF + recipients fix) handles its bugs separately.
- **Do NOT add backwards-compat shims.** `openNewEnvelope()` with no argument keeps working (the parameter is optional via `undefined`). No need for default-arg syntax or guard rails beyond what's shown.
- **Do NOT generate PDF thumbnails.** Use the 📄 emoji in the styled icon box. Real thumbnails are explicitly Phase 2+.
- **Commits are per-task as written above.** Do not squash before pushing — small commits make the rollback story clean if any single task introduces a regression.
- **The "⋯" menu's `setTimeout(…, 0)` is intentional** — without it, the same click that opens the menu also closes it via the document-level listener. If you "clean it up" by registering the listener synchronously, the menu won't appear.
