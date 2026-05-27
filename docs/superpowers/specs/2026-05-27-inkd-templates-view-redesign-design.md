# Ink'd — Templates View Redesign (SignNow-style rows)

**Status:** Design approved by Jordan — ready for implementation plan
**Date:** 2026-05-27
**Owner:** Jordan Shutts

---

## 1. Overview

Jordan modeled the existing Ink'd dashboard on SignNow but the Templates lane still uses thin, low-density rows that don't match the reference. This spec covers a focused redesign of just the Templates lane inside `/inkd.html`: rich rows with a primary action button ("Send for signature"), a secondary actions menu ("⋯"), and a small backend addition to display signer count per template.

This is **Phase 1** of a larger SignNow-style direction. The send flow (recipient-first modal, per-recipient field placement, "Prepare and Send" vs. "Invite to Sign" vs. "Create Invite Link" modes) is explicitly deferred to a later phase.

---

## 2. Goals

1. Templates lane visually matches Jordan's SignNow reference: bigger rows, primary green action button, "⋯" overflow menu.
2. Each row surfaces enough metadata to identify the template at a glance: name, last-updated date, signer count, page count.
3. The "Send for signature" button opens the existing new-envelope modal with the template pre-selected — one fewer step in the send flow.
4. Add Duplicate as a secondary action (not previously available).
5. Ship in 1–2 PRs without touching the send flow.

---

## 3. Non-goals (explicit YAGNI for this phase)

- Send flow redesign (recipient-first modal, per-recipient field placement, three distinct send modes, "Me Fill Out Now") — deferred to Phase 2.
- PDF thumbnail previews on rows — generic doc icon only.
- "View invites (N)" link — would require a per-template envelope-count query; deferred.
- Folder structure / "Shared Team Folders" sidebar — deferred.
- Multi-column sortable table (Recent / Owner / Type filters in the SignNow toolbar) — current single search field is enough for v1.
- Dashboard (Documents lane) redesign — out of scope.

---

## 4. Where it lives

All changes scoped to existing files:

```
propspot-os/
├── routes/inkd/
│   └── templates.js          # MODIFY: list query adds signer_count; ADD POST /:id/duplicate
├── public/
│   ├── inkd.html             # unchanged
│   ├── inkd.css              # MODIFY: new .tpl-row + .tpl-menu styles
│   └── inkd.js               # MODIFY: templateRow() rebuild + openNewEnvelope(templateId)
```

No schema changes. No new routes besides one duplicate endpoint. No new dependencies.

---

## 5. Row anatomy

Three-column CSS grid:

```
┌──────┬───────────────────────────────────────┬─────────────────────────────────┐
│ 📄   │  Template name (bold)                 │  [ Send for signature ]  [ ⋯ ]  │
│      │  Updated May 18, 2026 · Signers: 2 ·  │                                 │
│      │  1 page                               │                                 │
└──────┴───────────────────────────────────────┴─────────────────────────────────┘
```

- **Icon cell** (48px wide): generic 📄 in a styled box (border, neutral background). Reserves room for a real PDF thumbnail in a future phase without re-layout.
- **Content cell** (1fr): template name in bold, then a single meta line: `Updated <date> · Signers: <n> · <n> page[s]`.
- **Actions cell** (auto width):
  - **"Send for signature"** — primary green button using `var(--brand)`.
  - **"⋯"** — neutral icon button that opens a dropdown menu.

Row hover: subtle background tint via existing `var(--brand-light, rgba(97,183,70,.05))`.

---

## 6. Interactions

| User action | Behavior |
|---|---|
| Click row body (icon, name, or meta line) | Navigate to `/inkd-template-editor.html?id=<template_id>` — unchanged from today. |
| Click **"Send for signature"** button | Open the existing new-envelope modal (`#new-env-modal`) with this template pre-selected in `#ne-template` and the select disabled so the user can only edit the property + click Continue. |
| Click **"⋯"** button | Open a dropdown menu positioned below-right of the button. Outside click closes it. |
| Click menu item **"Edit template"** | Same as clicking row body — navigate to editor. |
| Click menu item **"Duplicate"** | `POST /api/inkd/templates/:id/duplicate` → on success, prepend the new template to `state.templates`, re-render, then navigate to the editor for the new template so the user can rename it. |
| Click menu item **"Archive"** | Same as today's "Archive" button: `DELETE /api/inkd/templates/:id`, remove from `state.templates`, re-render. |

All button/menu clicks call `event.stopPropagation()` so the row-body navigation doesn't also fire.

---

## 7. Backend changes

### 7.1 `GET /api/inkd/templates` — add `signer_count`

Replace the current `SELECT id, name, category, …` query with one that left-joins the fields table and counts distinct `recipient_role`:

```sql
SELECT t.id, t.name, t.category, t.description, t.page_count,
       t.created_at, t.updated_at,
       COALESCE(s.signer_count, 0) AS signer_count
  FROM inkd_templates t
  LEFT JOIN (
    SELECT template_id, COUNT(DISTINCT recipient_role) AS signer_count
      FROM inkd_template_fields
      WHERE recipient_role IS NOT NULL
      GROUP BY template_id
  ) s ON s.template_id = t.id
  WHERE t.archived_at IS NULL
  ORDER BY t.updated_at DESC
```

`NULL` recipient_role values are excluded so creator-only fields (`autofill_source = 'today'`, etc.) don't inflate the count.

### 7.2 `POST /api/inkd/templates/:id/duplicate` — new endpoint

```js
router.post('/:id/duplicate', async (req, res) => {
  try {
    const src = await query('SELECT * FROM inkd_templates WHERE id=$1 AND archived_at IS NULL', [req.params.id]);
    if (!src.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const t = src.rows[0];

    const dup = (await query(
      `INSERT INTO inkd_templates
         (name, category, description, source_pdf_url, source_pdf_id, page_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [`${t.name} (copy)`, t.category, t.description,
       t.source_pdf_url, t.source_pdf_id, t.page_count, req.userId])
    ).rows[0];

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

Reuses the source template's `source_pdf_id` — no Cloudinary re-upload, no extra storage. The duplicate shares the underlying PDF.

---

## 8. Frontend changes

### 8.1 `public/inkd.css`

Add new section under the existing template styles:

```css
/* Template rows — SignNow-style rich layout */
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
.tpl-row .body .name { font-weight: 600; color: var(--text); }
.tpl-row .body .meta { font-size: .78rem; color: var(--text-muted); margin-top: 2px; }
.tpl-row .actions { display: flex; gap: 6px; align-items: center; }
.tpl-row .actions .send { padding: 7px 14px; background: var(--brand);
                          color: #fff; border: 0; border-radius: 6px;
                          font-weight: 600; font-size: .82rem; cursor: pointer; }
.tpl-row .actions .send:hover { background: var(--brand-dark, #4a9337); }
.tpl-row .actions .menu-trigger { padding: 6px 9px; background: transparent;
                                   border: 1px solid var(--border); border-radius: 6px;
                                   color: var(--text-muted); cursor: pointer; }
.tpl-row .actions .menu-trigger:hover { border-color: var(--brand); color: var(--brand); }

.tpl-menu { position: absolute; min-width: 160px; background: var(--surface);
            border: 1px solid var(--border); border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 4px; z-index: 200; }
.tpl-menu button { display: block; width: 100%; padding: 8px 12px; text-align: left;
                   background: transparent; border: 0; border-radius: 4px;
                   color: var(--text); font-size: .85rem; cursor: pointer; }
.tpl-menu button:hover { background: var(--brand-light, rgba(97,183,70,.08)); }
.tpl-menu button.danger { color: #ef4444; }
.tpl-menu button.danger:hover { background: #fef2f2; }
```

The existing `.inkd-row` rule is kept for the Documents/Archive lanes — it stays a grid-with-columns layout for envelopes (Name | Property | Status | Date | Actions).

### 8.2 `public/inkd.js`

**Rewrite `templateRow(t)`** (currently at lines 212–240) to emit the new structure:

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
  div.addEventListener('click', () => location.href = `/inkd-template-editor.html?id=${t.id}`);
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

**Modify `openNewEnvelope()`** (currently at line 342) to accept an optional `preSelectTemplateId`:

```js
async function openNewEnvelope(preSelectTemplateId) {
  // …existing body unchanged…
  if (tplSel) {
    tplSel.innerHTML = '<option value="">Pick a template…</option>' +
      templates.map(t => …).join('');
    if (preSelectTemplateId) {
      tplSel.value = preSelectTemplateId;
      tplSel.disabled = true;            // lock the choice
    } else {
      tplSel.disabled = false;
    }
  }
  // …rest unchanged…
}
```

`closeNewEnvelope()` should re-enable the select on close so the next "+ Create → Document" flow isn't stuck disabled.

**Add `openTemplateMenu(trigger, t)`** — positions a `<div class="tpl-menu">` absolutely below the trigger, populates with Edit / Duplicate / Archive buttons, wires their handlers, and registers a one-shot document-click listener to close itself on outside click. Pattern matches the existing `#create-menu` toggle in `wireEvents()`.

**Add `duplicateTemplate(id)`**:

```js
async function duplicateTemplate(id) {
  const r = await api(`/api/inkd/templates/${id}/duplicate`, { method: 'POST' });
  if (!r.ok) { showToast('Duplicate failed', 'error'); return; }
  const dup = await r.json();
  state.templates.unshift(dup);
  updateCounts();
  render();
  location.href = `/inkd-template-editor.html?id=${dup.id}`;
}
```

---

## 9. Data flow

```
1. User opens /inkd.html → init() → GET /api/inkd/templates
   ← returns array with new signer_count column
2. User clicks Templates tab in sidebar (state.view = 'templates')
3. render() calls templateRow(t) per template → emits .tpl-row markup
4a. User clicks row body → location.href = /inkd-template-editor.html?id=…
4b. User clicks "Send for signature" → openNewEnvelope(t.id) → modal
    opens with template pre-selected + disabled → user picks property →
    Continue → /inkd-send.html?template_id=…&property_id=…
4c. User clicks "⋯" → openTemplateMenu(trigger, t) → menu appears →
    user picks Edit (→ editor) / Duplicate (→ duplicate endpoint → editor) /
    Archive (→ existing delete flow)
```

No changes to the send flow itself. The composer at `/inkd-send.html` works exactly as it does today (after PR #210 + PR #212 land).

---

## 10. Testing

Manual test plan after the implementation PR lands on Railway:

1. **Templates list renders new rows.** Each row shows icon, name, "Updated …" date, "Signers: N", page count, green "Send for signature" button, and "⋯" button. No regression in Documents or Archive lanes (still old layout).
2. **Signer count is correct.** A template with two distinct `recipient_role` values (e.g. buyer + seller fields) shows "Signers: 2". A template with no recipient_role fields shows "Signers: 0".
3. **Click row body** → navigates to `/inkd-template-editor.html?id=…`.
4. **Click "Send for signature"** → modal opens, template dropdown shows the template's name, dropdown is disabled. Property picker is empty + functional. Continue navigates to composer.
5. **Click "⋯"** → menu appears. Clicking outside closes it. Clicking another row's "⋯" closes any open menu first.
6. **"Edit template"** menu item → navigates to editor (same as row click).
7. **"Duplicate"** → new template "<Original name> (copy)" appears at the top of the list. Auto-navigates to the editor for the new one so the user can rename. All fields from the original are preserved.
8. **"Archive"** → template disappears from list, count drops.
9. **Existing send flow unaffected.** Clicking dashboard "+ Create → Document" still works (template select is NOT disabled, user picks).
10. **Theme:** light + dark mode both render correctly (uses existing CSS variables; no hard-coded grays).

---

## 11. Rollout

- Single PR (small enough — ~150 lines of JS + CSS + one route addition).
- No data migration. No schema change. No env vars.
- Railway auto-deploys on merge to `main`.
- Hard-refresh required client-side to pick up new JS/CSS — Jordan tests immediately after deploy.

---

## 12. Future phases (out of scope for this spec)

Documented here only so the design choices above don't paint us into a corner:

1. **Send flow redesign** — recipient-first modal, per-recipient field placement editor, three send modes (Prepare and Send / Invite to Sign / Create Invite Link), "Me (Fill Out Now)" mode.
2. **Real PDF thumbnails** on rows — either server-side generation at template upload (pdf-lib → PNG → Cloudinary) or client-side via pdf.js on the templates list.
3. **"View invites (N)"** link — needs `GET /api/inkd/templates/:id/envelopes` and a per-template envelope list view.
4. **Folder structure** — `inkd_template_folders` table + drag-to-folder UI.
5. **Sortable columns + advanced filters** — Recent / Owner / Type filters and column-sort toggles like SignNow's toolbar.

Each is independently shippable on top of the row redesign in this spec.
