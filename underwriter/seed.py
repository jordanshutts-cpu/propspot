"""
Seed the SQLite DB from every .xlsx file in `properties/`.

Run:
    python seed.py              # add new files; leave existing data alone
    python seed.py --reset      # wipe the DB and re-import everything
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import db
from extractor import extract


PROPERTIES_DIR = Path(__file__).parent / "properties"


def seed(reset: bool = False, user: str = "system-import") -> None:
    if reset:
        print("Resetting DB...")
        db.reset_all()
    db.init_db()

    files = sorted(p for p in PROPERTIES_DIR.glob("*.xlsx") if not p.name.startswith("~$"))
    if not files:
        print(f"No .xlsx files found in {PROPERTIES_DIR}")
        return

    for f in files:
        try:
            assumptions = extract(f)
        except Exception as e:
            print(f"  SKIP {f.name}: {e}")
            continue
        if not assumptions.get("address"):
            print(f"  SKIP {f.name}: could not parse address")
            continue
        prop_id = db.upsert_property_from_xlsx(assumptions, user=user)
        print(f"  OK   [{prop_id}] {assumptions['address']}  ({f.name})")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--reset", action="store_true",
                   help="Wipe the DB and re-import all spreadsheets")
    p.add_argument("--user", default="system-import",
                   help="Username to attribute the import to")
    args = p.parse_args()
    seed(reset=args.reset, user=args.user)
    print("\nDone. Run `python app.py` to launch the dashboard.")
