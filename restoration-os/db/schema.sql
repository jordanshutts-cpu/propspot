-- ============================================================
--  Prop Spot — PostgreSQL Schema
--  Idempotent: every CREATE uses IF NOT EXISTS.
--  Triggers and functions use CREATE OR REPLACE.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  full_name       TEXT,
  password_hash   TEXT,
  invite_token    TEXT,
  invite_expires  TIMESTAMPTZ,
  is_owner        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Apps Registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  base_url    TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── App Grants (per-user, per-app) ───────────────────────────────────────
-- scope JSONB shapes:
--   {"all": true}                     -- access everything in app
--   {"project_ids": ["uuid", ...]}    -- only listed projects
CREATE TABLE IF NOT EXISTS app_grants (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id      UUID NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  scope       JSONB NOT NULL DEFAULT '{"all": true}'::jsonb,
  granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id)
);

CREATE INDEX IF NOT EXISTS app_grants_app_idx  ON app_grants(app_id);
CREATE INDEX IF NOT EXISTS app_grants_user_idx ON app_grants(user_id);

-- ── Properties (canonical, unique per address) ────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_line1       TEXT NOT NULL,
  unit                TEXT,
  city                TEXT NOT NULL,
  state               TEXT NOT NULL,
  zip                 TEXT NOT NULL,
  normalized_address  TEXT UNIQUE NOT NULL,
  parcel_id           TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  cover_url           TEXT,
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS properties_parcel_idx  ON properties(parcel_id);
CREATE INDEX IF NOT EXISTS properties_created_idx ON properties(created_at DESC);

-- ── Contacts ──────────────────────────────────────────────────────────────
-- type ENUM kept as TEXT + CHECK for forward-compat (easy to add new types).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contact_type') THEN
    CREATE TYPE contact_type AS ENUM (
      'seller','buyer','lender','contractor','inspector','property_manager',
      'utility_company','buyer_agent','listing_agent','closing_attorney',
      'accountant','other'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        contact_type NOT NULL DEFAULT 'other',
  full_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  company     TEXT,
  notes       TEXT,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- set on invite acceptance
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contacts_type_idx  ON contacts(type);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts(LOWER(email));
CREATE INDEX IF NOT EXISTS contacts_user_idx  ON contacts(user_id);

-- ── Property ⇄ Contact bridge ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_contacts (
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  contact_id   UUID NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  role         TEXT NOT NULL,            -- mirrors contact.type by default; lets a contact play multiple roles
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (property_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS pc_property_idx ON property_contacts(property_id);
CREATE INDEX IF NOT EXISTS pc_contact_idx  ON property_contacts(contact_id);

-- ── Pipeline: prospects ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,        -- foreclosure_list | bankruptcy_list | probate_list | divorce_list | scraped | purchased_data
  channels          TEXT[] DEFAULT '{}',  -- text | cold_call | door_knock | direct_mail
  raw_name          TEXT,
  raw_phone         TEXT,
  raw_email         TEXT,
  raw_meta          JSONB,
  status            TEXT NOT NULL DEFAULT 'active',  -- active | attempted | responded | dead | promoted
  campaign_id       TEXT,
  notes             TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prospects_property_idx ON prospects(property_id);
CREATE INDEX IF NOT EXISTS prospects_status_idx   ON prospects(status);

-- ── Pipeline: leads ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source              TEXT NOT NULL,    -- ppl | ppc | organic_web | inbound_call | referral | prospect_response
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  motivation_notes    TEXT,
  status              TEXT NOT NULL DEFAULT 'new',     -- new | working | qualified | dead | promoted
  previous_prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS leads_property_idx ON leads(property_id);
CREATE INDEX IF NOT EXISTS leads_status_idx   ON leads(status);

-- ── Pipeline: opportunities ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  appointment_at      TIMESTAMPTZ,
  appointment_type    TEXT,             -- in_person | virtual
  asking_price        NUMERIC(12,2),
  our_offer           NUMERIC(12,2),
  status              TEXT NOT NULL DEFAULT 'active',  -- active | appointment_set | signed | lost | dead | promoted
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS opps_property_idx ON opportunities(property_id);
CREATE INDEX IF NOT EXISTS opps_status_idx   ON opportunities(status);

-- ── Pipeline: purchases ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  opportunity_id           UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  contract_date            DATE,
  expected_close_date      DATE,
  actual_close_date        DATE,
  purchase_price           NUMERIC(12,2),
  earnest_money            NUMERIC(12,2),
  lender_contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  attorney_contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  inspection_status        TEXT DEFAULT 'pending',     -- pending | scheduled | completed | waived
  title_status             TEXT DEFAULT 'pending',     -- pending | ordered | clear | issues
  due_diligence_status     TEXT DEFAULT 'pending',     -- pending | in_progress | passed | failed
  status                   TEXT NOT NULL DEFAULT 'under_contract', -- under_contract | closed | terminated | promoted
  notes                    TEXT,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS purchases_property_idx ON purchases(property_id);
CREATE INDEX IF NOT EXISTS purchases_status_idx   ON purchases(status);

-- ── Pipeline: projects ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  purchase_id              UUID REFERENCES purchases(id) ON DELETE SET NULL,
  kind                     TEXT NOT NULL,       -- flip | rental
  status                   TEXT NOT NULL DEFAULT 'renovating', -- renovating | listed_for_sale | listed_for_rent | rented | sold
  -- ongoing-obligation fields
  insurance_active         BOOLEAN DEFAULT FALSE,
  insurance_carrier        TEXT,
  utilities_status         TEXT DEFAULT 'off',  -- off | on | transferred
  taxes_paid_through       DATE,
  mortgage_active          BOOLEAN DEFAULT FALSE,
  last_mowed_at            TIMESTAMPTZ,
  last_cleaned_at          TIMESTAMPTZ,
  -- financial
  list_price               NUMERIC(12,2),
  sold_price               NUMERIC(12,2),
  monthly_rent             NUMERIC(10,2),
  sold_at                  TIMESTAMPTZ,
  rented_at                TIMESTAMPTZ,
  notes                    TEXT,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS projects_property_idx ON projects(property_id);
CREATE INDEX IF NOT EXISTS projects_status_idx   ON projects(status);
CREATE INDEX IF NOT EXISTS projects_kind_idx     ON projects(kind);

-- ── Activity log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_type   TEXT NOT NULL,        -- property | prospect | lead | opportunity | purchase | project | contact | user | grant | photo
  entity_id     UUID,
  action        TEXT NOT NULL,        -- created | updated | promoted | linked | unlinked | invited | accepted | granted | revoked | status_changed
  payload       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_entity_idx ON activity(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_actor_idx   ON activity(actor_user_id);

-- ── Photos (FieldCam-owned data, Prop Spot-hosted) ──────────────────────────
-- FieldCam reads/writes this table directly via the shared DATABASE_URL.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE TABLE IF NOT EXISTS photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  url             TEXT NOT NULL,
  cloudinary_id   TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  notes           TEXT,
  taken_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS photos_property_id_idx ON photos(property_id);
CREATE INDEX IF NOT EXISTS photos_taken_at_idx    ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS photos_uploader_idx    ON photos(uploaded_by);

-- ── updated_at triggers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'properties','contacts','prospects','leads','opportunities','purchases','projects'
  ]) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_set_updated ON %I; ' ||
      'CREATE TRIGGER %I_set_updated BEFORE UPDATE ON %I ' ||
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;
