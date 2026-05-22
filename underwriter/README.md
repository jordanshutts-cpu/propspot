# Restoration Homes — Multi-Property Underwriter

Portfolio dashboard for evaluating Flip vs Long-Term Rental (DSCR) on every
property in inventory. Lets you:

- See a sortable / filterable summary of all properties with their key metrics.
- Click any address to drill into the full underwriter for that property.
- Edit assumptions live, with calculations updating instantly.
- Compare **Original** assumptions (frozen at intake) against **Current** edits side-by-side.
- See an **audit log** of every change — who edited what, when, and what changed.

## Layout

```
underwriters/
├── app.py             ← multi-page Dash shell + routing + user picker
├── model.py           ← shared compute() (validated against V16.2 spreadsheet)
├── extractor.py       ← .xlsx → assumptions dict (handles V16.2 + V16.3)
├── db.py              ← SQLite schema, queries, audit-log writes
├── seed.py            ← scans properties/*.xlsx → loads into DB
├── styles.py          ← shared style dicts + number formatters
├── pages/
│   ├── portfolio.py   ← /  — sortable table of all properties
│   └── property.py    ← /property/<id> — drill-in with original-vs-current
├── properties/        ← drop new .xlsx files here, run `python seed.py`
└── underwriter.db     ← SQLite, gitignored (seeded from properties/)
```

## First-time setup

**Easiest (Windows):** double-click `Start Underwriter.bat` — it installs
dependencies, seeds the DB on first run, and starts the dashboard.

**Manual:**

```bash
pip install dash openpyxl dash_mantine_components
python seed.py            # populates DB from properties/*.xlsx (~1s for 5 files)
python app.py             # starts Dash at http://127.0.0.1:8050
```

Open <http://127.0.0.1:8050> — you'll land on the portfolio table.

## Adding new properties

1. Drop the V16.x `.xlsx` into `properties/`
2. Run `python seed.py` again — it adds new files and skips ones already in the DB
3. Refresh the portfolio page

To re-import everything (e.g. after fixing the extractor or updating a spreadsheet):

```bash
python seed.py --reset    # WIPES the DB and rebuilds from xlsx files
                          # ⚠ destroys all manual edits + audit history
```

## How the audit log works

- The first time a property is imported, two snapshots are written to SQLite:
  **`original`** (frozen forever) and **`current`** (mutable).
- Every field-level edit on the property detail page:
  - Compares the new value against the current snapshot
  - Writes a row to `audit_log` (`property_id`, `field`, `old_value`,
    `new_value`, `changed_by`, `changed_at`)
  - Updates the `current` snapshot
- The "Acting as:" name in the header is whatever you type — saved to
  `localStorage` so you don't retype it. Honor-system attribution.
- "Revert all to Original" rolls the current snapshot back to original
  field-by-field, recording each rollback in the audit log.

## Inspecting the DB directly

```bash
sqlite3 underwriter.db
sqlite> SELECT address, count(*) FROM audit_log
    ...> JOIN properties ON properties.id = audit_log.property_id
    ...> GROUP BY address;
```

## Calculation reference

The validated single-property formula port lives in `model.compute()`. All
formulas are direct ports of the V16.2 Dashboard tab — see git history for
the original `validate.py` that proved 30/30 cells matched the spreadsheet's
cached values.

Best-strategy pick logic mirrors Dashboard F17/G17:

- DSCR IRR > 25%  →  **DSCR**
- Else Flip IRR > 1000%  →  **Flip**
- Else  →  **None** (neither passes the threshold)

## Caveats / known limitations

- **V16.3 calculation parity:** the extractor reads V16.3 cells from the same
  positions as V16.2. For most fields this works, but a few V16.3
  spreadsheets show 5–15% differences from their cached IRR/profit values
  vs what `model.compute()` produces. The 379 Curtis V16.2 case is exact
  (30/30 cells match). Worth a closer look once we standardize on V16.3+.
- **No real auth:** anyone can type any name into "Acting as:" and edits are
  attributed to that string. Fine for a trusted internal team; if you need
  real attribution later, add login.
- **Local SQLite only:** each machine has its own DB. If two collaborators
  edit independently, their audit logs diverge. Migrate to shared Postgres
  (or a server-deployed Dash app + shared DB) when collaborator count > 1.

## Roadmap

- [ ] Auto-populate the Property panel from external comp sources (currently
      sourced from the spreadsheet's Standard Comp Comparison tab)
- [ ] V16.3 calculation parity — close the small variance gaps
- [ ] Sensitivity tables (IRR vs ARV, IRR vs purchase price, IRR vs rent)
- [ ] Snapshot history (not just original + current — track every named
      version, e.g. "post-inspection", "after seller counter")
- [ ] Multi-user deployment with real auth
