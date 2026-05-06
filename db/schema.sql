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

-- Migrations (idempotent)
ALTER TABLE photos ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'image';

-- ── Folders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT  DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Property Access ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'view',
  granted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(property_id, user_id)
);

-- ── Share Links ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS share_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT UNIQUE NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  folder_id   UUID REFERENCES folders(id) ON DELETE CASCADE,
  label       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';
ALTER TABLE photos ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
-- Make oldest user the admin (bootstrap)
UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1) AND role = 'member';
