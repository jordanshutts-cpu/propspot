"""
Database persistence layer — supports SQLite (local dev) and Postgres (cloud).

  Local dev:  no config needed; uses underwriter.db next to this file.
  Production: set DATABASE_URL env var (Railway provides this automatically).

Each property has TWO underwriter snapshots:
    'initial_pro_forma'   the assumptions at intake (planning baseline)
    'actual_results'      the assumptions reflecting reality as the deal plays out

Every field-level edit writes a row to audit_log.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

# ---------------------------------------------------------------------------
# DB backend detection
# ---------------------------------------------------------------------------
_DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Railway sometimes gives postgres:// — psycopg2 needs postgresql://
if _DATABASE_URL.startswith("postgres://"):
    _DATABASE_URL = "postgresql://" + _DATABASE_URL[len("postgres://"):]

USE_POSTGRES = bool(_DATABASE_URL)
DB_PATH = Path(__file__).parent / "underwriter.db"


KINDS = ("initial_pro_forma", "actual_results")
KIND_LABELS = {
    "initial_pro_forma": "Initial Pro Forma",
    "actual_results":    "Actual Results",
}


# ---------------------------------------------------------------------------
# Schema — two flavours (only primary-key syntax differs)
# ---------------------------------------------------------------------------
_SCHEMA_COMMON = """
CREATE TABLE IF NOT EXISTS uw_properties (
    id                {PK},
    address           TEXT    NOT NULL,
    city              TEXT,
    state             TEXT,
    zip               TEXT,
    county            TEXT,
    sqft              REAL,
    list_price        REAL,
    source_file       TEXT,
    prelim_title_json TEXT,
    added_at          TEXT    NOT NULL,
    added_by          TEXT    NOT NULL,
    UNIQUE(address)
);

CREATE TABLE IF NOT EXISTS uw_snapshots (
    id            {PK},
    property_id   INTEGER NOT NULL REFERENCES uw_properties(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK(kind IN ('initial_pro_forma','actual_results')),
    data_json     TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    updated_by    TEXT    NOT NULL,
    UNIQUE(property_id, kind)
);

CREATE TABLE IF NOT EXISTS uw_audit_log (
    id           {PK},
    property_id  INTEGER NOT NULL REFERENCES uw_properties(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK(kind IN ('initial_pro_forma','actual_results')),
    field        TEXT    NOT NULL,
    old_value    TEXT,
    new_value    TEXT,
    changed_by   TEXT    NOT NULL,
    changed_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS uw_users (
    id            {PK},
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user'
                            CHECK(role IN ('admin','user')),
    full_name     TEXT,
    email         TEXT,
    created_at    TEXT    NOT NULL,
    created_by    TEXT
);
"""

_SCHEMA_SQLITE = _SCHEMA_COMMON.replace("{PK}", "INTEGER PRIMARY KEY AUTOINCREMENT")
_SCHEMA_PG     = _SCHEMA_COMMON.replace("{PK}", "SERIAL PRIMARY KEY")

_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_audit_property "
    "ON uw_audit_log(property_id, kind, changed_at DESC);"
)


# ---------------------------------------------------------------------------
# Postgres wrapper — makes psycopg2 look like sqlite3 for the rest of this file
# ---------------------------------------------------------------------------
class _PgConn:
    """Thin wrapper so callers can use c.execute(sql, params).fetchone() etc."""

    def __init__(self, pg_conn):
        self._conn = pg_conn

    def execute(self, sql: str, params=()):
        import psycopg2.extras  # lazy import
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # Adapt ? placeholders to %s
        adapted = sql.replace("?", "%s")
        cur.execute(adapted, params if params else None)
        return cur

    def commit(self):   self._conn.commit()
    def rollback(self): self._conn.rollback()
    def close(self):    self._conn.close()


# ---------------------------------------------------------------------------
# Connection context manager
# ---------------------------------------------------------------------------
@contextmanager
def conn() -> Iterator:
    if USE_POSTGRES:
        import psycopg2
        pg = psycopg2.connect(_DATABASE_URL)
        c = _PgConn(pg)
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()
    else:
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        try:
            yield c
            c.commit()
        finally:
            c.close()


# ---------------------------------------------------------------------------
# Schema init
# ---------------------------------------------------------------------------
def init_db() -> None:
    schema = _SCHEMA_PG if USE_POSTGRES else _SCHEMA_SQLITE
    with conn() as c:
        if USE_POSTGRES:
            for stmt in _split_statements(schema):
                c.execute(stmt)
            c.execute(_INDEX_SQL)
        else:
            c.executescript(schema + "\n" + _INDEX_SQL)
        # Idempotent migrations for older DBs
        _migrate_add_column(c, "uw_properties", "prelim_title_json", "TEXT")


def _split_statements(sql: str) -> list[str]:
    """Split a multi-statement SQL string into individual statements."""
    return [s.strip() for s in sql.split(";") if s.strip()]


# ---------------------------------------------------------------------------
# Helper: INSERT and return the new row id
# ---------------------------------------------------------------------------
def _insert_id(c, sql: str, params: tuple) -> int:
    if USE_POSTGRES:
        cur = c.execute(sql + " RETURNING id", params)
        return cur.fetchone()["id"]
    else:
        c.execute(sql, params)
        return c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


# ---------------------------------------------------------------------------
# Password hashing — PBKDF2-HMAC-SHA256, 200k iterations, 16-byte random salt
# ---------------------------------------------------------------------------
_PBKDF2_ITER = 200_000


def _hash_password(plain: str) -> str:
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt, _PBKDF2_ITER)
    return f"pbkdf2:{_PBKDF2_ITER}:{salt.hex()}:{h.hex()}"


def _verify_password(plain: str, stored: str) -> bool:
    try:
        scheme, iters, salt_hex, hash_hex = stored.split(":", 3)
        if scheme != "pbkdf2":
            return False
        h = hashlib.pbkdf2_hmac(
            "sha256", plain.encode("utf-8"),
            bytes.fromhex(salt_hex), int(iters),
        )
        return hmac.compare_digest(h.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _migrate_add_column(c, table: str, column: str, type_decl: str) -> None:
    """Idempotently add a column to an existing table (both backends)."""
    if USE_POSTGRES:
        c.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {type_decl}")
    else:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {type_decl}")


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------
def create_property(*, address: str, city: str = "", state: str = "",
                    zip: str = "", county: str = "", sqft: float = 0,
                    list_price: float = 0, source_file: str = "",
                    pro_forma: dict, actual_results: dict | None = None,
                    user: str = "system") -> int:
    if not address:
        raise ValueError("Address is required")
    if actual_results is None:
        actual_results = dict(pro_forma)

    with conn() as c:
        existing = c.execute(
            "SELECT id FROM uw_properties WHERE address = ?", (address,)
        ).fetchone()
        if existing:
            raise ValueError(f"Property {address!r} already exists (id={existing['id']})")

        prop_id = _insert_id(c,
            """INSERT INTO uw_properties
                   (address, city, state, zip, county, sqft, list_price,
                    source_file, added_at, added_by)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (address, city, state, zip, county, sqft or 0, list_price or 0,
             source_file, now_iso(), user),
        )

        ts = now_iso()
        for kind, data in (("initial_pro_forma", pro_forma),
                            ("actual_results", actual_results)):
            c.execute(
                """INSERT INTO uw_snapshots
                       (property_id, kind, data_json, updated_at, updated_by)
                   VALUES (?,?,?,?,?)""",
                (prop_id, kind, json.dumps(_strip_meta(data)), ts, user),
            )
        return prop_id


def upsert_property_from_xlsx(assumptions: dict, user: str) -> int:
    """Used by seed.py — idempotent on (address).  Also persists prelim_title
    if the extractor produced one."""
    with conn() as c:
        existing = c.execute(
            "SELECT id FROM uw_properties WHERE address = ?",
            (assumptions["address"],),
        ).fetchone()
        if existing:
            return existing["id"]

    prop_id = create_property(
        address        = assumptions["address"],
        city           = assumptions.get("city", ""),
        state          = assumptions.get("state", ""),
        zip            = assumptions.get("zip", ""),
        county         = assumptions.get("county", ""),
        sqft           = assumptions.get("sqft", 0) or 0,
        list_price     = assumptions.get("listPrice", 0) or 0,
        source_file    = assumptions.get("source_file", ""),
        pro_forma      = assumptions,
        actual_results = None,
        user           = user,
    )

    pt = assumptions.get("prelim_title")
    if pt:
        set_prelim_title(prop_id, pt, user=user)
    return prop_id


def list_properties() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            """SELECT p.*,
                      (SELECT data_json  FROM uw_snapshots s
                         WHERE s.property_id = p.id AND s.kind = 'initial_pro_forma')
                          AS pro_forma_data,
                      (SELECT data_json  FROM uw_snapshots s
                         WHERE s.property_id = p.id AND s.kind = 'actual_results')
                          AS actual_data,
                      (SELECT updated_at FROM uw_snapshots s
                         WHERE s.property_id = p.id AND s.kind = 'actual_results')
                          AS actual_updated_at,
                      (SELECT updated_by FROM uw_snapshots s
                         WHERE s.property_id = p.id AND s.kind = 'actual_results')
                          AS actual_updated_by,
                      (SELECT updated_at FROM uw_snapshots s
                         WHERE s.property_id = p.id AND s.kind = 'initial_pro_forma')
                          AS pro_forma_updated_at
                 FROM uw_properties p
                ORDER BY p.address"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_property(prop_id: int) -> dict | None:
    with conn() as c:
        row = c.execute(
            "SELECT * FROM uw_properties WHERE id = ?", (prop_id,)
        ).fetchone()
        return dict(row) if row else None


def update_property_meta(prop_id: int, *, address: str | None = None,
                         city: str | None = None, state: str | None = None,
                         zip: str | None = None, county: str | None = None,
                         sqft: float | None = None,
                         list_price: float | None = None,
                         user: str = "system") -> None:
    fields = {"address": address, "city": city, "state": state, "zip": zip,
              "county": county, "sqft": sqft, "list_price": list_price}
    fields = {k: v for k, v in fields.items() if v is not None}
    if not fields:
        return
    with conn() as c:
        cur = c.execute("SELECT * FROM uw_properties WHERE id = ?", (prop_id,)).fetchone()
        if not cur:
            return
        ts = now_iso()
        sets = ", ".join(f"{k} = ?" for k in fields)
        params = list(fields.values()) + [prop_id]
        c.execute(f"UPDATE uw_properties SET {sets} WHERE id = ?", params)
        for k, v in fields.items():
            old = cur[k]
            if old != v:
                c.execute(
                    """INSERT INTO uw_audit_log
                           (property_id, kind, field, old_value, new_value,
                            changed_by, changed_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (prop_id, "initial_pro_forma", k,
                     json.dumps(old), json.dumps(v), user, ts),
                )


def get_prelim_title(prop_id: int) -> dict:
    with conn() as c:
        row = c.execute(
            "SELECT prelim_title_json FROM uw_properties WHERE id = ?",
            (prop_id,),
        ).fetchone()
        if not row or not row["prelim_title_json"]:
            return {}
        try:
            return json.loads(row["prelim_title_json"])
        except (TypeError, json.JSONDecodeError):
            return {}


def set_prelim_title(prop_id: int, data: dict, user: str) -> None:
    """Persist intake/title data and write a single audit-log entry."""
    with conn() as c:
        existing = c.execute(
            "SELECT prelim_title_json FROM uw_properties WHERE id = ?",
            (prop_id,),
        ).fetchone()
        old = existing["prelim_title_json"] if existing else None
        new_json = json.dumps(data, default=str)
        c.execute(
            "UPDATE uw_properties SET prelim_title_json = ? WHERE id = ?",
            (new_json, prop_id),
        )
        if old != new_json:
            c.execute(
                """INSERT INTO uw_audit_log
                       (property_id, kind, field, old_value, new_value,
                        changed_by, changed_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (prop_id, "initial_pro_forma", "prelim_title",
                 old, new_json, user, now_iso()),
            )


def get_snapshot(prop_id: int, kind: str) -> dict | None:
    with conn() as c:
        row = c.execute(
            "SELECT data_json FROM uw_snapshots WHERE property_id = ? AND kind = ?",
            (prop_id, kind),
        ).fetchone()
        if not row:
            return None
        return json.loads(row["data_json"])


# ---------------------------------------------------------------------------
# Edits + audit log
# ---------------------------------------------------------------------------
def apply_edits(prop_id: int, kind: str, new_data: dict, user: str) -> int:
    if kind not in KINDS:
        raise ValueError(f"Bad kind: {kind!r}")
    user = (user or "unknown").strip() or "unknown"

    with conn() as c:
        row = c.execute(
            "SELECT data_json FROM uw_snapshots WHERE property_id = ? AND kind = ?",
            (prop_id, kind),
        ).fetchone()
        if not row:
            raise ValueError(f"No {kind} snapshot for property {prop_id}")
        current = json.loads(row["data_json"])

        changes = []
        for key, new_val in new_data.items():
            old_val = current.get(key)
            if _normalized(old_val) != _normalized(new_val):
                changes.append((key, old_val, new_val))
        if not changes:
            return 0

        ts = now_iso()
        for field, old_val, new_val in changes:
            c.execute(
                """INSERT INTO uw_audit_log
                       (property_id, kind, field, old_value, new_value,
                        changed_by, changed_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (prop_id, kind, field,
                 json.dumps(old_val, default=str),
                 json.dumps(new_val, default=str),
                 user, ts),
            )

        merged = {**current, **new_data}
        c.execute(
            """UPDATE uw_snapshots
                  SET data_json = ?, updated_at = ?, updated_by = ?
                WHERE property_id = ? AND kind = ?""",
            (json.dumps(merged), ts, user, prop_id, kind),
        )
        return len(changes)


def revert_to_pro_forma(prop_id: int, user: str) -> int:
    pro_forma = get_snapshot(prop_id, "initial_pro_forma")
    if pro_forma is None:
        return 0
    return apply_edits(prop_id, "actual_results", pro_forma, user)


def get_audit_log(prop_id: int, kind: str | None = None,
                  limit: int = 500) -> list[dict]:
    with conn() as c:
        if kind:
            rows = c.execute(
                """SELECT * FROM uw_audit_log
                    WHERE property_id = ? AND kind = ?
                    ORDER BY changed_at DESC, id DESC LIMIT ?""",
                (prop_id, kind, limit),
            ).fetchall()
        else:
            rows = c.execute(
                """SELECT * FROM uw_audit_log
                    WHERE property_id = ?
                    ORDER BY changed_at DESC, id DESC LIMIT ?""",
                (prop_id, limit),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            for k in ("old_value", "new_value"):
                v = d[k]
                if v is None:
                    continue
                try:    d[k] = json.loads(v)
                except (TypeError, json.JSONDecodeError): pass
            out.append(d)
        return out


def known_users() -> list[str]:
    with conn() as c:
        rows = c.execute("""
            SELECT DISTINCT u FROM (
                SELECT added_by   AS u FROM uw_properties
                UNION SELECT updated_by AS u FROM uw_snapshots
                UNION SELECT changed_by AS u FROM uw_audit_log
            ) WHERE u IS NOT NULL AND u != ''
            ORDER BY u
        """).fetchall()
        return [r["u"] for r in rows]


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------
def has_any_users() -> bool:
    with conn() as c:
        row = c.execute("SELECT COUNT(*) AS n FROM uw_users").fetchone()
        return (row["n"] > 0)


def list_users() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT id, username, role, full_name, email, created_at, created_by "
            "FROM uw_users ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]


def get_user(username: str) -> Optional[dict]:
    with conn() as c:
        row = c.execute(
            "SELECT * FROM uw_users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None


def create_user(*, username: str, password: str, role: str = "user",
                full_name: str = "", email: str = "",
                created_by: str = "system") -> int:
    if not username or not password:
        raise ValueError("Username and password are required.")
    if role not in ("admin", "user"):
        raise ValueError(f"Invalid role: {role!r}")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    with conn() as c:
        existing = c.execute(
            "SELECT id FROM uw_users WHERE username = ?", (username,)
        ).fetchone()
        if existing:
            raise ValueError(f"User {username!r} already exists.")
        return _insert_id(c,
            """INSERT INTO uw_users
                  (username, password_hash, role, full_name, email,
                   created_at, created_by)
               VALUES (?,?,?,?,?,?,?)""",
            (username.strip(), _hash_password(password), role,
             (full_name or "").strip(), (email or "").strip(),
             now_iso(), created_by),
        )


def authenticate(username: str, password: str) -> Optional[dict]:
    user = get_user(username)
    if not user:
        return None
    if _verify_password(password, user["password_hash"]):
        return user
    return None


def update_password(username: str, new_password: str) -> None:
    if len(new_password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    with conn() as c:
        c.execute("UPDATE uw_users SET password_hash = ? WHERE username = ?",
                  (_hash_password(new_password), username))


def set_role(username: str, role: str) -> None:
    if role not in ("admin", "user"):
        raise ValueError(f"Invalid role: {role!r}")
    with conn() as c:
        c.execute("UPDATE uw_users SET role = ? WHERE username = ?",
                  (role, username))


def delete_user(username: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM uw_users WHERE username = ?", (username,))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
META_FIELDS = {"address", "city", "state", "zip", "county", "sqft",
               "listPrice", "list_price", "source_file"}


def _strip_meta(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in META_FIELDS}


def _normalized(v: Any) -> Any:
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def reset_property(prop_id: int) -> None:
    with conn() as c:
        c.execute("DELETE FROM uw_properties WHERE id = ?", (prop_id,))


def reset_all() -> None:
    if USE_POSTGRES:
        with conn() as c:
            for tbl in ("uw_audit_log", "uw_snapshots", "uw_properties", "uw_users"):
                c.execute(f"DROP TABLE IF EXISTS {tbl} CASCADE")
        init_db()
    else:
        if DB_PATH.exists():
            DB_PATH.unlink()
        init_db()
