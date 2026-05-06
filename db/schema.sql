-- ============================================================
--  FieldCam — PostgreSQL Schema
--  Railway runs this automatically on first deploy via server.js
--  You can also run it manually in Railway's DB console.
-- ============================================================

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  full_name       TEXT,
  password_hash   TEXT,               -- null until invite is accepted
  invite_token    TEXT,               -- short-lived invite token
  invite_expires  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Properties ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  address     TEXT,
  notes       TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  cover_url   TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Photos ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS photos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  url            TEXT NOT NULL,
  cloudinary_id  TEXT,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  notes          TEXT,
  taken_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS photos_property_id_idx ON photos(property_id);
CREATE INDEX IF NOT EXISTS photos_taken_at_idx    ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS properties_created_idx ON properties(created_at DESC);
