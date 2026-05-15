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

-- Property-level status across the overall lifecycle. Distinct from
-- per-record statuses in prospects/leads/opportunities/purchases/projects
-- (this is the rollup of "what is the property currently doing").
ALTER TABLE properties ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'purchasing';
-- Drop and recreate the status check so we can add new states ('sold')
-- without leaving a stale, incomplete constraint behind. Idempotent.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_status_check') THEN
    ALTER TABLE properties DROP CONSTRAINT properties_status_check;
  END IF;
  ALTER TABLE properties ADD CONSTRAINT properties_status_check
    CHECK (status IN ('purchasing','renovating','selling','renting','rented','sold','dropped'));
END $$;
CREATE INDEX IF NOT EXISTS properties_status_idx ON properties(status);

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

-- ── Holdings Desk ─────────────────────────────────────────────────────────
-- Per-property system of record for recurring obligations: utilities, insurance,
-- property taxes, mortgages, business licenses, HOA. Each item captures the
-- provider/account, linked propspot contact, billing cadence, and free-form
-- category-specific extras in `details` JSONB. Payments and documents are
-- first-class children so a receipt PDF can be attached to a specific payment.
CREATE TABLE IF NOT EXISTS holdings_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category             TEXT NOT NULL,            -- utility | insurance | property_tax | mortgage | business_license | hoa
  name                 TEXT NOT NULL,
  -- Provider / account info
  vendor               TEXT,
  account_number       TEXT,
  provider_phone       TEXT,
  provider_email       TEXT,
  provider_website     TEXT,
  provider_portal_url  TEXT,
  provider_address     TEXT,
  contact_id           UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Money / cadence
  amount               NUMERIC(12,2),
  frequency            TEXT NOT NULL DEFAULT 'monthly',  -- monthly | quarterly | semiannual | annual | one_time | variable
  next_due_date        DATE,
  start_date           DATE,
  end_date             DATE,
  -- State
  status               TEXT NOT NULL DEFAULT 'active',   -- active | paused | closed
  auto_pay             BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_days_before INT NOT NULL DEFAULT 7,
  -- Extensible
  details              JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes                TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS holdings_items_property_idx ON holdings_items(property_id);
CREATE INDEX IF NOT EXISTS holdings_items_category_idx ON holdings_items(category);
CREATE INDEX IF NOT EXISTS holdings_items_due_idx      ON holdings_items(next_due_date);
CREATE INDEX IF NOT EXISTS holdings_items_status_idx   ON holdings_items(status);
CREATE INDEX IF NOT EXISTS holdings_items_contact_idx  ON holdings_items(contact_id);

CREATE TABLE IF NOT EXISTS holdings_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES holdings_items(id) ON DELETE CASCADE,
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  amount              NUMERIC(12,2) NOT NULL,
  paid_on             DATE NOT NULL,
  covers_period_start DATE,
  covers_period_end   DATE,
  method              TEXT,             -- ach | check | card | cash | autopay | other
  reference           TEXT,             -- check#, confirmation#
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS holdings_payments_item_idx     ON holdings_payments(item_id);
CREATE INDEX IF NOT EXISTS holdings_payments_property_idx ON holdings_payments(property_id);
CREATE INDEX IF NOT EXISTS holdings_payments_paid_idx     ON holdings_payments(paid_on DESC);

CREATE TABLE IF NOT EXISTS holdings_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID NOT NULL REFERENCES holdings_items(id) ON DELETE CASCADE,
  payment_id    UUID REFERENCES holdings_payments(id) ON DELETE SET NULL,
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label         TEXT,
  doc_type      TEXT,                     -- policy | declarations | statement | bill | receipt | certificate | other
  url           TEXT NOT NULL,
  cloudinary_id TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  valid_from    DATE,
  valid_to      DATE,
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS holdings_documents_item_idx     ON holdings_documents(item_id);
CREATE INDEX IF NOT EXISTS holdings_documents_payment_idx  ON holdings_documents(payment_id);
CREATE INDEX IF NOT EXISTS holdings_documents_property_idx ON holdings_documents(property_id);

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

-- ── FieldCam-owned data (lives in Prop Spot's DB) ───────────────────────────
-- FieldCam reads/writes these tables directly via the shared DATABASE_URL.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Folders ────────────────────────────────────────────────────────────────────
-- Per-property organization (e.g. "Before", "After", "Inspection").
CREATE TABLE IF NOT EXISTS folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT  DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS folders_property_idx ON folders(property_id);

-- Photos ─────────────────────────────────────────────────────────────────────
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
ALTER TABLE photos ADD COLUMN IF NOT EXISTS folder_id  UUID REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'image';
ALTER TABLE photos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS photos_property_id_idx ON photos(property_id);
CREATE INDEX IF NOT EXISTS photos_taken_at_idx    ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS photos_uploader_idx    ON photos(uploaded_by);
CREATE INDEX IF NOT EXISTS photos_folder_idx      ON photos(folder_id);
CREATE INDEX IF NOT EXISTS photos_deleted_at_idx  ON photos(deleted_at);

-- users.role — admin/member. Owners are auto-promoted to admin so FieldCam's
-- existing role checks keep working without a separate sync step.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';
UPDATE users SET role = 'admin' WHERE is_owner = TRUE AND role <> 'admin';

-- property_access — restrict properties to a named subset of users. A property
-- with zero rows here is org-public (subject to the fieldcam app grant);
-- one or more rows lock it down.
CREATE TABLE IF NOT EXISTS property_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'view',
  granted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(property_id, user_id)
);
CREATE INDEX IF NOT EXISTS property_access_user_idx     ON property_access(user_id);
CREATE INDEX IF NOT EXISTS property_access_property_idx ON property_access(property_id);

-- share_links — public read-only URLs for a property (or folder within).
CREATE TABLE IF NOT EXISTS share_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT UNIQUE NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  folder_id   UUID REFERENCES folders(id) ON DELETE CASCADE,
  label       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS share_links_property_idx ON share_links(property_id);

-- comments — per-photo discussion with @mention support (resolved against
-- users.full_name in routes/comments.js).
CREATE TABLE IF NOT EXISTS comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id   UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comments_photo_id_idx ON comments(photo_id);

-- ── Maintenance satellite (work-order tracking) ─────────────────────────────
-- Owned by Prop Spot; read/written by the maintenance.propspot.io app via
-- the shared DATABASE_URL (Model A).
CREATE TABLE IF NOT EXISTS work_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT,
  category            TEXT,                                       -- plumbing | electrical | hvac | roofing | landscaping | cleaning | appliance | pest | general | other
  priority            TEXT NOT NULL DEFAULT 'normal',             -- low | normal | high | urgent
  status              TEXT NOT NULL DEFAULT 'open',               -- open | scheduled | in_progress | completed | cancelled
  assigned_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  reported_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  scheduled_for       DATE,
  completed_at        TIMESTAMPTZ,
  cost_cents          INTEGER,
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_priority_check') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_priority_check
      CHECK (priority IN ('low','normal','high','urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_status_check') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
      CHECK (status IN ('open','scheduled','in_progress','completed','cancelled'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS work_orders_property_idx  ON work_orders(property_id);
CREATE INDEX IF NOT EXISTS work_orders_status_idx    ON work_orders(status);
CREATE INDEX IF NOT EXISTS work_orders_priority_idx  ON work_orders(priority);
CREATE INDEX IF NOT EXISTS work_orders_scheduled_idx ON work_orders(scheduled_for);

-- Updates / comment thread on a work order.
CREATE TABLE IF NOT EXISTS work_order_updates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS work_order_updates_wo_idx ON work_order_updates(work_order_id);

-- ── updated_at triggers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'properties','contacts','prospects','leads','opportunities','purchases','projects',
    'holdings_items','holdings_payments','holdings_documents',
    'work_orders'
  ]) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_set_updated ON %I; ' ||
      'CREATE TRIGGER %I_set_updated BEFORE UPDATE ON %I ' ||
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;
