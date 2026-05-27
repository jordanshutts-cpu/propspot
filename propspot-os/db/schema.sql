-- ============================================================
--  Prop Spot — PostgreSQL Schema
--  Idempotent: every CREATE uses IF NOT EXISTS.
--  Triggers and functions use CREATE OR REPLACE.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Org Settings (singleton row — one per workspace) ──────────────────
CREATE TABLE IF NOT EXISTS org_settings (
  id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name          TEXT NOT NULL DEFAULT 'My Company',
  company_logo_url      TEXT,
  company_logo_cloud_id TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO org_settings (id, company_name) VALUES (1, 'My Company') ON CONFLICT DO NOTHING;

-- ── Calendar Events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT,
  event_type   TEXT NOT NULL DEFAULT 'general' CHECK (event_type IN ('closing','purchase','inspection','meeting','deadline','general')),
  visibility   TEXT NOT NULL DEFAULT 'company' CHECK (visibility IN ('company','personal')),
  start_at     TIMESTAMPTZ NOT NULL,
  end_at       TIMESTAMPTZ,
  all_day      BOOLEAN NOT NULL DEFAULT FALSE,
  property_id  UUID REFERENCES properties(id) ON DELETE SET NULL,
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS calendar_events_start_idx ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS calendar_events_creator_idx ON calendar_events(created_by);
CREATE INDEX IF NOT EXISTS calendar_events_property_idx ON calendar_events(property_id);
-- Mirror Google Calendar event when this event was written through to the
-- user's Google Calendar (personal visibility + caller has a calendar grant).
-- google_event_id is the id from calendar.googleapis.com; meet_url is the
-- conferenceData hangoutLink when the event was created with a Meet.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_id TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS meet_url        TEXT;

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
-- Profile fields added later (idempotent).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_cloudinary_id TEXT;

-- Google Workspace SSO linkage. google_sub is Google's stable user ID
-- (the `sub` claim). google_email is captured at link time so users
-- can see which Workspace account they linked. Partial unique indexes
-- prevent two users from claiming the same Google account, while
-- allowing many users with NULL (not yet linked).
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email TEXT;
-- Per-user Google Calendar OAuth refresh token (encrypted via inbox-crypto).
-- NULL when the user hasn't connected their calendar yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_refresh_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_connected_at      TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uniq
  ON users (google_sub)   WHERE google_sub   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_email_uniq
  ON users (google_email) WHERE google_email IS NOT NULL;

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

-- CompanyCam project linkage: every property may carry the CC project ID
-- it was migrated from, so we can later attach photos via the CC API.
-- Partial unique index = many NULLs allowed, but no two rows share the
-- same CC project.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS companycam_project_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS properties_companycam_project_uniq
  ON properties (companycam_project_id) WHERE companycam_project_id IS NOT NULL;

-- Operator-facing fields added later (idempotent ALTERs).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner              TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS county             TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tms                TEXT;          -- Tax Map Number
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lockbox_code       TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS purchase_date      DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS purchase_price     NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sold_date          DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sold_price         NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lender_contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS seller_contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS properties_lender_idx  ON properties(lender_contact_id);
CREATE INDEX IF NOT EXISTS properties_seller_idx  ON properties(seller_contact_id);
CREATE INDEX IF NOT EXISTS properties_county_idx  ON properties(county);
CREATE INDEX IF NOT EXISTS properties_tms_idx     ON properties(tms);

-- Operator-facing fields imported from the legacy spreadsheet.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS properties_owner_contact_idx ON properties(owner_contact_id);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS strategy             TEXT;          -- Fix N' Flip | LTR | STR | Wholesale | Wholetail | LTR Fund I
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_type        TEXT;          -- SFH | Mobile | etc.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS data_source          TEXT;          -- Referral | FC | PPL | MLS | PPC | Wholesaler | 8020 Data | FC - Auction
ALTER TABLE properties ADD COLUMN IF NOT EXISTS conversion_method    TEXT;          -- Door Knocking | Cold Calling | Wholesaler | Auction | etc.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS acquisition_agent_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;

-- Loan / financial details
ALTER TABLE properties ADD COLUMN IF NOT EXISTS bridge_origination_fee NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS loan_servicing_fee     NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS reno_holdback          NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS total_borrowed         NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS purchase_loan_amount   NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lender_arv             NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS interest_rate          NUMERIC(6,4);  -- 0.1099 == 10.99%
ALTER TABLE properties ADD COLUMN IF NOT EXISTS reno_budget            NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS reno_spent             NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS reno_draws_received    NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS uw_arv                 NUMERIC(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS investment_type        TEXT CHECK (investment_type IN ('rental','flip'));

CREATE INDEX IF NOT EXISTS properties_strategy_idx      ON properties(strategy);
CREATE INDEX IF NOT EXISTS properties_investment_type_idx ON properties(investment_type);
CREATE INDEX IF NOT EXISTS properties_acq_agent_idx ON properties(acquisition_agent_contact_id);

-- ── Property files (PDFs, deeds, inspection reports, etc.) ─────────────
-- Stored in Cloudinary; we keep just the metadata + URL here.
CREATE TABLE IF NOT EXISTS property_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  url           TEXT NOT NULL,
  cloudinary_id TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS property_files_property_idx ON property_files(property_id);
CREATE INDEX IF NOT EXISTS property_files_created_idx  ON property_files(created_at DESC);

-- Property-level status across the overall lifecycle. Distinct from
-- per-record statuses in prospects/leads/opportunities/purchases/projects
-- (this is the rollup of "what is the property currently doing").
ALTER TABLE properties ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'purchasing';
-- Drop and recreate the status check whenever we add new states. Idempotent.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_status_check') THEN
    ALTER TABLE properties DROP CONSTRAINT properties_status_check;
  END IF;
  ALTER TABLE properties ADD CONSTRAINT properties_status_check
    CHECK (status IN (
      'prospect','purchasing','renovating','selling','renting','rented','sold','dropped',
      'assigned','listed_for_rent','listed_for_sale','under_contract_buyer'
    ));
END $$;
CREATE INDEX IF NOT EXISTS properties_status_idx ON properties(status);

-- Sub-status for properties still in the 'purchasing' lifecycle: lets us
-- group the Acquisitions board into Approved to Close / Due Diligence /
-- Under Contract / Assigning lanes without inventing top-level statuses.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS acquisition_status TEXT NOT NULL DEFAULT 'under_contract';

-- Sub-status for properties in the 'renovating' lifecycle — drives the
-- Projects kanban. Mirrors acquisition_status pattern.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS project_status TEXT NOT NULL DEFAULT 'planning';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_project_status_check') THEN
    ALTER TABLE properties DROP CONSTRAINT properties_project_status_check;
  END IF;
  ALTER TABLE properties ADD CONSTRAINT properties_project_status_check
    CHECK (project_status IN ('planning','in_progress','punch_list','ready_to_list'));
END $$;
CREATE INDEX IF NOT EXISTS properties_project_status_idx ON properties(project_status) WHERE status = 'renovating';

-- Drop the old CHECK BEFORE migrating values. The first release of this
-- column shipped a CHECK that only allowed 'purchasing','due_diligence',
-- 'approved_to_close'; if we leave that in place, the rename UPDATE
-- below would violate it and break startup.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_acq_status_check;

-- Migrate any old 'purchasing' value (from the initial release of this
-- column) to the renamed 'under_contract'.
UPDATE properties SET acquisition_status = 'under_contract' WHERE acquisition_status = 'purchasing';

-- Make sure the column default tracks the current canonical name (handles
-- the case where the column already existed with the old default).
ALTER TABLE properties ALTER COLUMN acquisition_status SET DEFAULT 'under_contract';

-- Re-apply the CHECK with the full current value list. Idempotent because
-- we just dropped any previous version of this constraint above.
ALTER TABLE properties ADD CONSTRAINT properties_acq_status_check
  CHECK (acquisition_status IN ('approved_to_close','due_diligence','under_contract','assigning'));

CREATE INDEX IF NOT EXISTS properties_acq_status_idx ON properties(acquisition_status);

-- Anticipated purchase / close date — set while a property is still in the
-- Acquisitions pipeline. Kept separate from purchase_date so the projected
-- vs actual close dates can both be tracked. purchase_date stays blank
-- until the deal actually closes. No back-migration — existing rows keep
-- whatever purchase_date they already had; operator fills the new field
-- manually going forward.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS anticipated_close_date DATE;
CREATE INDEX IF NOT EXISTS properties_antic_close_idx ON properties(anticipated_close_date);

-- ── Contacts ──────────────────────────────────────────────────────────────
-- type ENUM kept as TEXT + CHECK for forward-compat (easy to add new types).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contact_type') THEN
    CREATE TYPE contact_type AS ENUM (
      'seller','buyer','lender','contractor','inspector','property_manager',
      'utility_company','buyer_agent','listing_agent','closing_attorney',
      'accountant','acquisition_agent','owner','other'
    );
  END IF;
END $$;
-- Idempotent enum extensions (PG12+). Must be outside a transaction.
ALTER TYPE contact_type ADD VALUE IF NOT EXISTS 'acquisition_agent';
ALTER TYPE contact_type ADD VALUE IF NOT EXISTS 'owner';

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

-- CompanyCam migration linkage. Lets the photo importer resume safely
-- if interrupted (and skip already-migrated photos on re-run).
ALTER TABLE photos ADD COLUMN IF NOT EXISTS companycam_photo_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS photos_companycam_uniq
  ON photos (companycam_photo_id) WHERE companycam_photo_id IS NOT NULL;

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

-- ── Lawn maintenance ────────────────────────────────────────────────────────
-- One row per property. Rows are OPTIONAL — properties with no row default
-- to enabled_mode='auto' and inherit visibility from property.status. The
-- maintenance app's lawn page handles the inclusion logic in its SELECT.
CREATE TABLE IF NOT EXISTS lawn_maintenance (
  property_id          UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  enabled_mode         TEXT NOT NULL DEFAULT 'auto',  -- auto | force_on | force_off
  assigned_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  frequency_days       INT NOT NULL DEFAULT 14,
  last_mowed_at        TIMESTAMPTZ,
  last_mowed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Arrival marker. Set by the "Check In" button when the technician reaches
  -- the property. Lat/lng captured if the browser grants geolocation so we
  -- can spot-verify on-site presence.
  last_checked_in_at   TIMESTAMPTZ,
  last_checked_in_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  last_checked_in_lat  DOUBLE PRECISION,
  last_checked_in_lng  DOUBLE PRECISION,
  sign_for_sale        BOOLEAN NOT NULL DEFAULT FALSE,
  sign_for_rent        BOOLEAN NOT NULL DEFAULT FALSE,
  route_position       INT,
  route_pin            TEXT CHECK (route_pin IN ('first','last')),
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lawn_maintenance ADD COLUMN IF NOT EXISTS route_pin TEXT CHECK (route_pin IN ('first','last'));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lawn_maintenance_mode_check') THEN
    ALTER TABLE lawn_maintenance DROP CONSTRAINT lawn_maintenance_mode_check;
  END IF;
  ALTER TABLE lawn_maintenance ADD CONSTRAINT lawn_maintenance_mode_check
    CHECK (enabled_mode IN ('auto','force_on','force_off'));
END $$;
CREATE INDEX IF NOT EXISTS lawn_maint_assigned_idx ON lawn_maintenance(assigned_user_id);
CREATE INDEX IF NOT EXISTS lawn_maint_route_idx    ON lawn_maintenance(route_position);

-- Per-mow event log. The lawn_maintenance.last_mowed_* columns above
-- are a denormalized cache of the most recent event here; the maintenance
-- app refreshes them on every event insert/update/delete.
CREATE TABLE IF NOT EXISTS lawn_mow_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  mowed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mowed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS lawn_mow_events_property_idx ON lawn_mow_events(property_id);
CREATE INDEX IF NOT EXISTS lawn_mow_events_mowed_at_idx ON lawn_mow_events(mowed_at DESC);

-- One-time backfill: if a property has last_mowed_at set on lawn_maintenance
-- but no events exist for it yet, create a single seed event so the history
-- isn't lost. Idempotent — the NOT EXISTS guard prevents re-runs from
-- creating duplicates.
INSERT INTO lawn_mow_events (property_id, mowed_at, mowed_by, notes)
SELECT lm.property_id, lm.last_mowed_at, lm.last_mowed_by, '(seeded from cache)'
  FROM lawn_maintenance lm
 WHERE lm.last_mowed_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM lawn_mow_events e WHERE e.property_id = lm.property_id
   );

-- ── Pulse satellite (team chat) ─────────────────────────────────────────────
-- Owned by Prop Spot; read/written by the pulse.propspot.io app via the
-- shared DATABASE_URL (Model A). Phase 1: channels + channel membership +
-- messages. Phase 2 adds DMs, attachments, mentions, presence.
CREATE TABLE IF NOT EXISTS chat_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  is_private  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_channels_slug_idx ON chat_channels(slug);

CREATE TABLE IF NOT EXISTS chat_channel_members (
  channel_id   UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  last_read_at TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_channel_members_user_idx ON chat_channel_members(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
  dm_id             UUID,  -- FK added in Phase 2 once chat_dms exists
  sender_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  client_message_id UUID,  -- echoed back to dedupe optimistic UI
  body              TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  edited_at         TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ
);
-- Exactly one of channel_id / dm_id must be set.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_target_check') THEN
    ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_target_check
      CHECK ((channel_id IS NULL) <> (dm_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_dm_idx      ON chat_messages(dm_id,      created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx  ON chat_messages(sender_id,  created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_dedup_idx
  ON chat_messages(sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- ── Pulse: DMs (1:1 + group) ────────────────────────────────────────────────
-- 1:1 DMs get a deterministic `dm_key` (sorted user uuids joined by ':') so the
-- partial unique index dedupes them. Group DMs leave dm_key NULL — multiple
-- group DMs over the same membership are allowed (matches Slack behavior).
CREATE TABLE IF NOT EXISTS chat_dms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group   BOOLEAN NOT NULL DEFAULT FALSE,
  dm_key     TEXT,  -- canonical key for 1:1 dedup; NULL for group DMs
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_dms_dm_key_uniq
  ON chat_dms(dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_dm_members (
  dm_id        UUID NOT NULL REFERENCES chat_dms(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (dm_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_dm_members_user_idx ON chat_dm_members(user_id);
-- Per-user "hide from sidebar" — soft delete. A DM stays gone from this
-- user's list until a newer message arrives, at which point hidden_at <
-- last_message_at and the GET /dms query lets it back in.
ALTER TABLE chat_dm_members ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

-- Now that chat_dms exists, retroactively add the FK on chat_messages.dm_id.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_dm_fk') THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_dm_fk
      FOREIGN KEY (dm_id) REFERENCES chat_dms(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── Pulse: attachments ──────────────────────────────────────────────────────
-- One row per file attached to a message. Cloudinary owns the bytes; we keep
-- the URL + metadata. Allowed mime types are enforced at the upload route, not
-- at the DB.
CREATE TABLE IF NOT EXISTS chat_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  cloudinary_id TEXT,
  mime_type     TEXT,
  size_bytes    BIGINT,
  filename      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_attachments_message_idx ON chat_attachments(message_id);

-- ── Pulse: mentions ─────────────────────────────────────────────────────────
-- Server parses `<@uuid>` tokens out of message body on POST and writes one
-- row here per mentioned user. Drives the "@me" feed + notifications.
CREATE TABLE IF NOT EXISTS chat_mentions (
  message_id        UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  mentioned_user_id UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, mentioned_user_id)
);
CREATE INDEX IF NOT EXISTS chat_mentions_user_idx
  ON chat_mentions(mentioned_user_id, message_id);

-- ── Pulse: presence ─────────────────────────────────────────────────────────
-- One row per user. Client POSTs a heartbeat every ~30s while open; we treat
-- any user with last_seen_at within the past 60s as "online". The push token
-- column is wired now (no-op) so Capacitor mobile wrap doesn't need a
-- migration later.
CREATE TABLE IF NOT EXISTS chat_user_presence (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at      TIMESTAMPTZ DEFAULT NOW(),
  device_push_token TEXT
);
CREATE INDEX IF NOT EXISTS chat_user_presence_last_seen_idx
  ON chat_user_presence(last_seen_at DESC);

-- ── Pulse: per-user sidebar sections (v2) ───────────────────────────────────
-- Each user organizes their own sidebar. A section is a named, ordered group;
-- an item links a channel or DM into a section (XOR). Channels/DMs not in any
-- section render under a default "Channels" / "Direct Messages" group.
CREATE TABLE IF NOT EXISTS chat_sidebar_sections (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  collapsed  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_sidebar_sections_user_idx
  ON chat_sidebar_sections(user_id, position);

CREATE TABLE IF NOT EXISTS chat_sidebar_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES chat_sidebar_sections(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
  dm_id      UUID REFERENCES chat_dms(id)      ON DELETE CASCADE,
  position   INT NOT NULL DEFAULT 0,
  CHECK ((channel_id IS NULL) <> (dm_id IS NULL))
);
CREATE INDEX IF NOT EXISTS chat_sidebar_items_section_idx
  ON chat_sidebar_items(section_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS chat_sidebar_items_channel_uniq
  ON chat_sidebar_items(section_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_sidebar_items_dm_uniq
  ON chat_sidebar_items(section_id, dm_id) WHERE dm_id IS NOT NULL;

-- ── Pulse: channel archiving ────────────────────────────────────────────────
-- An archived channel disappears from the default sidebar but keeps its
-- members + message history. Anyone can unarchive (subject to the same authz
-- as archiving — channel admins or account owners). #general can't be archived.
ALTER TABLE chat_channels
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE chat_channels
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_channels_archived_idx
  ON chat_channels(archived_at) WHERE archived_at IS NOT NULL;

-- ── Inbox satellite (email collaboration) ───────────────────────────────────
-- Owned by Prop Spot; read/written by the inbox.propspot.io app via Gmail API
-- (Microsoft Graph in Phase 2). Shared team inboxes route alias mail into
-- per-inbox conversation threads that can be tagged to a property and have
-- attachments saved into FieldCam's photo storage.

-- Connected company mailboxes (Workspace logins propspot reads/sends on behalf of).
CREATE TABLE IF NOT EXISTS inbox_mailboxes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  email                    TEXT NOT NULL UNIQUE,
  display_name             TEXT,
  refresh_token_encrypted  TEXT NOT NULL,
  oauth_scopes             TEXT NOT NULL,
  connected_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at             TIMESTAMPTZ,
  sync_state               JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','paused','error')),
  status_reason            TEXT
);

-- Shared inboxes (team-owned, the unit users get access to).
-- An inbox is "personal" when owner_user_id is set — visible only to that
-- user, no app-grants needed. NULL owner_user_id = traditional team inbox.
CREATE TABLE IF NOT EXISTS inbox_shared (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT,
  icon         TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE inbox_shared ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS inbox_shared_owner_idx ON inbox_shared(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Alias → shared inbox routing (one alias delivers to exactly one shared inbox).
CREATE TABLE IF NOT EXISTS inbox_alias_routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id      UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  alias_email     TEXT NOT NULL,
  shared_inbox_id UUID NOT NULL REFERENCES inbox_shared(id) ON DELETE CASCADE,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mailbox_id, alias_email)
);
CREATE INDEX IF NOT EXISTS inbox_alias_routes_mailbox_idx ON inbox_alias_routes(mailbox_id);
CREATE INDEX IF NOT EXISTS inbox_alias_routes_inbox_idx   ON inbox_alias_routes(shared_inbox_id);

-- Aliases the owner has explicitly dismissed from the "Unrouted" suggestion
-- list (e.g. one-off plus-addressed aliases like utilities+dave@). Mail still
-- lands in the mailbox; we just stop nagging the admin to route it.
CREATE TABLE IF NOT EXISTS inbox_alias_dismissals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id    UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  alias_email   TEXT NOT NULL,
  dismissed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mailbox_id, alias_email)
);
CREATE INDEX IF NOT EXISTS inbox_alias_dismissals_mailbox_idx ON inbox_alias_dismissals(mailbox_id);

-- Normalized email thread (groups messages with the same provider thread id).
CREATE TABLE IF NOT EXISTS inbox_threads (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shared_inbox_id      UUID REFERENCES inbox_shared(id) ON DELETE SET NULL,
  mailbox_id           UUID NOT NULL REFERENCES inbox_mailboxes(id) ON DELETE CASCADE,
  provider_thread_id   TEXT NOT NULL,
  subject              TEXT,
  participants         TEXT[] NOT NULL DEFAULT '{}',
  last_message_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count        INT NOT NULL DEFAULT 0,
  has_attachments      BOOLEAN NOT NULL DEFAULT FALSE,
  unread               BOOLEAN NOT NULL DEFAULT TRUE,
  property_id          UUID REFERENCES properties(id) ON DELETE SET NULL,
  tagged_at            TIMESTAMPTZ,
  tagged_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','archived','snoozed')),
  snooze_until         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mailbox_id, provider_thread_id)
);
CREATE INDEX IF NOT EXISTS inbox_threads_shared_inbox_idx
  ON inbox_threads(shared_inbox_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS inbox_threads_property_idx
  ON inbox_threads(property_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS inbox_threads_assigned_idx
  ON inbox_threads(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS inbox_threads_status_idx
  ON inbox_threads(status);

-- Individual messages within a thread.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  provider_message_id  TEXT NOT NULL,
  from_email           TEXT NOT NULL,
  from_name            TEXT,
  to_emails            TEXT[] NOT NULL DEFAULT '{}',
  cc_emails            TEXT[] NOT NULL DEFAULT '{}',
  delivered_to_alias   TEXT,
  subject              TEXT,
  snippet              TEXT,
  body_html            TEXT,
  body_text            TEXT,
  received_at          TIMESTAMPTZ NOT NULL,
  is_outbound          BOOLEAN NOT NULL DEFAULT FALSE,
  sent_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  raw_headers          JSONB,
  UNIQUE (thread_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx
  ON inbox_messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS inbox_messages_alias_idx
  ON inbox_messages(delivered_to_alias);

-- Attachments on inbox messages (lazy-fetched from provider until saved).
CREATE TABLE IF NOT EXISTS inbox_attachments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id              UUID NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  filename                TEXT NOT NULL,
  mime_type               TEXT NOT NULL,
  size_bytes              BIGINT,
  provider_attachment_id  TEXT NOT NULL,
  UNIQUE (message_id, provider_attachment_id)
);
CREATE INDEX IF NOT EXISTS inbox_attachments_message_idx ON inbox_attachments(message_id);

-- Saves of attachments to properties (links email attachment to Cloudinary photo).
CREATE TABLE IF NOT EXISTS inbox_attachment_saves (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id  UUID NOT NULL REFERENCES inbox_attachments(id) ON DELETE CASCADE,
  property_id    UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  photo_id       UUID REFERENCES photos(id) ON DELETE SET NULL,
  saved_filename TEXT NOT NULL,
  saved_folder   TEXT NOT NULL,
  saved_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inbox_attachment_saves_property_idx
  ON inbox_attachment_saves(property_id);
CREATE INDEX IF NOT EXISTS inbox_attachment_saves_attachment_idx
  ON inbox_attachment_saves(attachment_id);

-- ── Inbox data hygiene ───────────────────────────────────────────────────────
-- Step 1: null out delivered_to_alias on OUTBOUND messages. Outbound mail
-- has no "delivered alias" — from_email IS the sending alias. The previous
-- detection fallback was incorrectly capturing recipient addresses (e.g.
-- external clients, BuilderTrend BCC receipts) as if they were aliases.
-- Idempotent.
UPDATE inbox_messages
   SET delivered_to_alias = NULL
 WHERE delivered_to_alias IS NOT NULL
   AND is_outbound = TRUE;

-- Step 2: backfill delivered_to_alias from the saved raw_headers JSONB
-- for INBOUND messages where the value is NULL. An earlier over-aggressive
-- cleanup nulled legitimate cross-domain values (e.g. hoa@sellrh.com
-- forwarded to operations@restorationhomes.com); raw_headers preserves the
-- authoritative `Delivered-To` value Gmail's MTA set. Idempotent — only
-- touches rows where delivered_to_alias IS NULL.
UPDATE inbox_messages
   SET delivered_to_alias = LOWER(TRIM(raw_headers->>'Delivered-To'))
 WHERE delivered_to_alias IS NULL
   AND is_outbound = FALSE
   AND raw_headers ? 'Delivered-To'
   AND TRIM(raw_headers->>'Delivered-To') <> '';

-- Step 2b: same backfill but using X-Original-To as a secondary source
-- for any inbound row that lacks Delivered-To.
UPDATE inbox_messages
   SET delivered_to_alias = LOWER(TRIM(raw_headers->>'X-Original-To'))
 WHERE delivered_to_alias IS NULL
   AND is_outbound = FALSE
   AND raw_headers ? 'X-Original-To'
   AND TRIM(raw_headers->>'X-Original-To') <> '';

-- ── 2026-05-22: Inbox HTML signatures + Pulse entity-comments ──────────────

-- A) Per-shared-inbox HTML signature. NULL/empty = no signature appended.
ALTER TABLE inbox_shared
  ADD COLUMN IF NOT EXISTS signature_html TEXT;

-- B) Pulse entity-threads — one row per "comments-on-external-entity" thread.
-- entity_id has no FK so Pulse stays decoupled from consumer apps' tables.
CREATE TABLE IF NOT EXISTS pulse_entity_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);
-- C) chat_messages picks up a third optional target (entity_thread_id).
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS entity_thread_id UUID
    REFERENCES pulse_entity_threads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS chat_messages_entity_thread_idx
  ON chat_messages(entity_thread_id, created_at DESC);

-- D) Swap the channel-xor-dm check for channel-xor-dm-xor-entity_thread.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_target_check') THEN
    ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_target_check;
  END IF;
  ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_target_check
    CHECK (
      (channel_id       IS NOT NULL)::int +
      (dm_id            IS NOT NULL)::int +
      (entity_thread_id IS NOT NULL)::int = 1
    );
END $$;

-- E) Per-(user, entity_thread) read grants. Mention writes a row here;
-- ambient access (owner / inbox-grant) is computed via the authz view below.
CREATE TABLE IF NOT EXISTS pulse_entity_thread_grants (
  entity_thread_id UUID NOT NULL REFERENCES pulse_entity_threads(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,
  granted_via      TEXT NOT NULL,
  granted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS pulse_entity_thread_grants_user_idx
  ON pulse_entity_thread_grants(user_id);

-- F) Ambient-authz view for entity_type='inbox_thread'.
CREATE OR REPLACE VIEW pulse_authz_inbox_thread AS
SELECT t.id AS entity_id, u.id AS user_id
  FROM inbox_threads t
  CROSS JOIN users u
  LEFT JOIN app_grants ag
    ON ag.user_id = u.id
   AND ag.app_id  = (SELECT id FROM apps WHERE slug = 'inbox')
 WHERE u.is_owner = TRUE
    OR (ag.scope ? 'all')
    OR (
      ag.scope ? 'inbox_ids'
      AND t.shared_inbox_id IS NOT NULL
      AND (ag.scope->'inbox_ids') @> to_jsonb(t.shared_inbox_id::text)
    );

-- G) Per-(user, entity_thread) read marker. Powers unread-mention counts.
CREATE TABLE IF NOT EXISTS pulse_entity_thread_reads (
  entity_thread_id UUID NOT NULL REFERENCES pulse_entity_threads(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,
  last_read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS pulse_entity_thread_reads_user_idx
  ON pulse_entity_thread_reads(user_id);

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
    'work_orders','lawn_maintenance',
    'chat_channels',
    'inbox_threads',
    'pulse_entity_threads'
  ]) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_set_updated ON %I; ' ||
      'CREATE TRIGGER %I_set_updated BEFORE UPDATE ON %I ' ||
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

-- ── Underwriter Deals ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uw_deals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
  address           TEXT NOT NULL,
  city              TEXT,
  state             TEXT,
  zip               TEXT,
  county            TEXT,
  sqft              NUMERIC,
  list_price        NUMERIC,
  prelim_title_json JSONB,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS uw_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID NOT NULL REFERENCES uw_deals(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('initial_pro_forma','actual_results')),
  data_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(deal_id, kind)
);

CREATE TABLE IF NOT EXISTS uw_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID NOT NULL REFERENCES uw_deals(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB,
  changed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Conditional: only create this index if uw_audit_log actually has a
-- deal_id column. The Python underwriter satellite (underwriter/) creates
-- the same table with a `property_id` column instead, and when that
-- service boots first the unguarded CREATE INDEX crashes initDb() and
-- prevents propspot-os from starting (Railway healthcheck times out).
-- TODO(jordan): resolve the two underwriting systems' schema conflict —
-- pick one canonical owner of these tables. Both versions cannot work.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'uw_audit_log' AND column_name = 'deal_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS uw_audit_deal_idx
      ON uw_audit_log(deal_id, changed_at DESC);
  END IF;
END $$;

-- ── Marker table for one-time data operations (so embedded UPDATE blocks
-- in this file don't re-run on every initDb startup). Tiny and reusable —
-- any future "run this exactly once on deploy" cleanup uses the same table.
CREATE TABLE IF NOT EXISTS inbox_one_time_ops (
  op_id  TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2026-05-23: per-shared-inbox tabs (unassigned / assigned / snoozed /
-- archived / trash / spam). Expand the inbox_threads.status CHECK to allow
-- the two new states. Idempotent — drops the existing CHECK (whatever PG
-- auto-named it) and re-adds under a named constraint.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'inbox_threads'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE inbox_threads DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE inbox_threads
    ADD CONSTRAINT inbox_threads_status_check
    CHECK (status IN ('open','archived','snoozed','trash','spam'));
END $$;

-- ── New-chrome Phase 2: per-user sidebar state ─────────────────────────
-- Pinned properties stay in the user's sidebar across sessions; recent
-- properties auto-populate from /api/properties/:id GET hits so the
-- "Recent" list always reflects what the user actually visited.

CREATE TABLE IF NOT EXISTS pinned_properties (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  position    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_pinned_user_position
  ON pinned_properties (user_id, position, pinned_at);

CREATE TABLE IF NOT EXISTS recent_properties (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_user_time
  ON recent_properties (user_id, visited_at DESC);

-- ── Emoji reactions on Pulse messages ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_reactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL CHECK (char_length(emoji) <= 8),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS chat_reactions_message_idx ON chat_reactions(message_id);
CREATE INDEX IF NOT EXISTS chat_reactions_user_idx    ON chat_reactions(user_id);

-- ── Reply-to threading on Pulse messages ─────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'chat_messages' AND column_name = 'reply_to_id'
  ) THEN
    ALTER TABLE chat_messages
      ADD COLUMN reply_to_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS chat_messages_reply_to_idx ON chat_messages(reply_to_id);

-- ── Tasks (To-Do Tracker) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date        DATE,
  property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
  created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tasks_assigned_idx ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS tasks_created_by_idx ON tasks(created_by);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks(due_date);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','private'));

CREATE TABLE IF NOT EXISTS task_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  is_done     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_items_task_idx ON task_items(task_id);

CREATE TABLE IF NOT EXISTS task_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  url             TEXT NOT NULL,
  cloudinary_id   TEXT,
  mime_type       TEXT,
  size_bytes      INT,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments(task_id);
ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS task_item_id UUID REFERENCES task_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS task_attachments_item_idx ON task_attachments(task_item_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id);

-- ── Task mentions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_mentions (
  comment_id        UUID NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  mentioned_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (comment_id, mentioned_user_id)
);
CREATE INDEX IF NOT EXISTS task_mentions_user_idx ON task_mentions(mentioned_user_id);

-- ── Task Projects (Kanban columns) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS task_projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT DEFAULT '#2563eb',
  visibility  TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','private')),
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES task_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);

-- ── Drive: folders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drive_folders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    UUID REFERENCES drive_folders(id) ON DELETE CASCADE,
  property_id  UUID REFERENCES properties(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  team_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drive_folders_parent_idx   ON drive_folders(parent_id);
CREATE INDEX IF NOT EXISTS drive_folders_property_idx ON drive_folders(property_id);
ALTER TABLE drive_folders ADD COLUMN IF NOT EXISTS drive_type TEXT NOT NULL DEFAULT 'shared' CHECK (drive_type IN ('shared','personal'));
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS drive_type TEXT NOT NULL DEFAULT 'shared' CHECK (drive_type IN ('shared','personal'));

-- ── Drive: files ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drive_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id     UUID REFERENCES drive_folders(id) ON DELETE CASCADE,
  property_id   UUID REFERENCES properties(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  url           TEXT NOT NULL,
  cloudinary_id TEXT,
  mime_type     TEXT,
  size_bytes    BIGINT,
  team_visible  BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drive_files_folder_idx   ON drive_files(folder_id);
CREATE INDEX IF NOT EXISTS drive_files_property_idx ON drive_files(property_id);

-- ── Drive: permissions (Google Drive-style) ──────────────────────────
CREATE TABLE IF NOT EXISTS drive_permissions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  UUID REFERENCES drive_folders(id) ON DELETE CASCADE,
  file_id    UUID REFERENCES drive_files(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','owner')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK ((folder_id IS NULL) != (file_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_perms_folder_user_uniq ON drive_permissions(folder_id, user_id) WHERE folder_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS drive_perms_file_user_uniq ON drive_permissions(file_id, user_id) WHERE file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS drive_perms_user_idx ON drive_permissions(user_id);

-- ── 2026-05-23 one-time: archive every open thread with no activity in the
-- last 30 days. Lets Jordan start with a clean Unassigned/Assigned view
-- without years of backfilled history cluttering the lists. Owners can
-- still un-archive any thread individually from the Archived tab.
-- Guarded by inbox_one_time_ops so re-running schema.sql is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_one_time_ops WHERE op_id = 'archive_stale_open_2026_05_23') THEN
    UPDATE inbox_threads
       SET status = 'archived'
     WHERE status = 'open'
       AND last_message_at < NOW() - INTERVAL '30 days';
    INSERT INTO inbox_one_time_ops (op_id) VALUES ('archive_stale_open_2026_05_23');
  END IF;
END $$;

-- ── 2026-05-23 one-time: archive every currently-unassigned open thread,
-- regardless of age. The 30-day cleanup above caught old backlog; this
-- pass catches everything else in the Unassigned tab so Jordan can start
-- from zero. New mail arriving AFTER this runs still defaults to
-- status=open + assigned_to_user_id=NULL and shows up in Unassigned
-- normally — the marker prevents the UPDATE from firing again on those.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_one_time_ops WHERE op_id = 'archive_all_unassigned_2026_05_23') THEN
    UPDATE inbox_threads
       SET status = 'archived'
     WHERE status = 'open'
       AND assigned_to_user_id IS NULL;
    INSERT INTO inbox_one_time_ops (op_id) VALUES ('archive_all_unassigned_2026_05_23');
  END IF;
END $$;

-- ── 2026-05-23 one-time: archive every thread in the Acquisitions shared
-- inbox (across all tabs — Unassigned, Assigned, Snoozed), except threads
-- already archived. Jordan requested a clean reset for that inbox.
-- New mail arriving AFTER this runs still lands in Acquisitions normally
-- with status='open' — the marker only blocks THIS UPDATE from re-firing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_one_time_ops WHERE op_id = 'archive_all_acquisitions_2026_05_23') THEN
    UPDATE inbox_threads
       SET status = 'archived'
     WHERE shared_inbox_id = (SELECT id FROM inbox_shared WHERE slug = 'acquisitions')
       AND status <> 'archived';
    INSERT INTO inbox_one_time_ops (op_id) VALUES ('archive_all_acquisitions_2026_05_23');
  END IF;
END $$;

-- ── 2026-05-23 one-time: backfill shared_inbox_id on orphaned outbound
-- threads. A bug in the compose path (see inbox/routes/messages.js) means
-- some outbound emails get persisted with shared_inbox_id=NULL — they then
-- appear in the global "Open" view but don't count toward any individual
-- inbox's open_count, causing the sidebar-vs-list mismatch Jordan reported.
--
-- This UPDATE looks at every orphan thread, finds its outbound messages,
-- looks up the alias_route matching that from_email + mailbox, and writes
-- the resulting shared_inbox_id back onto the thread. The mailbox_id join
-- prevents cross-mailbox bleed when the same alias address lives in
-- multiple connected Google Workspace mailboxes.
--
-- After this UPDATE, the very next block below catches any orphan that
-- just got routed to Acquisitions and archives it too (so Jordan's
-- requested "Acquisitions empty" state is restored end-to-end).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_one_time_ops WHERE op_id = 'backfill_orphan_outbound_2026_05_23') THEN
    -- Note: ar.mailbox_id = t.mailbox_id must live in WHERE, not in the
    -- JOIN's ON clause — Postgres won't let an UPDATE's target alias (t)
    -- be referenced from inside an additional-FROM join's ON predicate.
    UPDATE inbox_threads t
       SET shared_inbox_id = ar.shared_inbox_id
      FROM inbox_messages m
      JOIN inbox_alias_routes ar
        ON LOWER(m.from_email) = LOWER(ar.alias_email)
     WHERE t.id = m.thread_id
       AND ar.mailbox_id = t.mailbox_id
       AND t.shared_inbox_id IS NULL
       AND m.is_outbound = TRUE;
    INSERT INTO inbox_one_time_ops (op_id) VALUES ('backfill_orphan_outbound_2026_05_23');
  END IF;
END $$;

-- ── 2026-05-23 one-time: re-run the Acquisitions archive after the
-- orphan backfill above, so any thread that just got routed into
-- Acquisitions also gets archived. Without this second pass, those
-- newly-routed orphans would still show as 'open' in Acquisitions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_one_time_ops WHERE op_id = 'archive_acquisitions_after_backfill_2026_05_23') THEN
    UPDATE inbox_threads
       SET status = 'archived'
     WHERE shared_inbox_id = (SELECT id FROM inbox_shared WHERE slug = 'acquisitions')
       AND status <> 'archived';
    INSERT INTO inbox_one_time_ops (op_id) VALUES ('archive_acquisitions_after_backfill_2026_05_23');
  END IF;
END $$;

-- ── Mention read receipts ─────────────────────────────────────────
-- One row per (user, source, source_id) when a user has acknowledged
-- seeing a mention. Absence = unread. Source identifies which table
-- the source_id refers to (pulse=chat_messages.id, task=task_comments.id,
-- fieldcam=comments.id). source_id is UUID for all three.
CREATE TABLE IF NOT EXISTS user_mention_reads (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('pulse','task','fieldcam')),
  source_id  UUID NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source, source_id)
);
CREATE INDEX IF NOT EXISTS user_mention_reads_user_idx ON user_mention_reads(user_id);

-- ── External-worker support (2026-05-26) ────────────────────────────────────
-- Assignee on a work order. Either a team member (users.user_type='team') or
-- an invited external worker (users.user_type='external_worker'). Replaces
-- the never-surfaced assigned_contact_id column going forward; that column
-- stays in place but is no longer read or written.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS work_orders_assigned_user_idx
  ON work_orders(assigned_user_id);

-- users.user_type — distinguishes regular team members from external workers
-- (vendors / contractors) invited to a stripped-down portal. Existing rows
-- default to 'team' via the column DEFAULT.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'team';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_user_type_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_user_type_check
      CHECK (user_type IN ('team','external_worker'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_user_type_idx ON users(user_type);

-- =====================================================================
-- Ink'd — in-PropSpot document signing
-- See docs/superpowers/specs/2026-05-26-inkd-signing-app-design.md
-- =====================================================================

CREATE TABLE IF NOT EXISTS inkd_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  category        TEXT,
  description     TEXT,
  source_pdf_url  TEXT NOT NULL,
  source_pdf_id   TEXT NOT NULL,
  page_count      INT NOT NULL,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inkd_templates_category ON inkd_templates(category) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS inkd_template_fields (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID NOT NULL REFERENCES inkd_templates(id) ON DELETE CASCADE,
  page_number       INT NOT NULL,
  x_pct             NUMERIC(6,4) NOT NULL,
  y_pct             NUMERIC(6,4) NOT NULL,
  width_pct         NUMERIC(6,4) NOT NULL,
  height_pct        NUMERIC(6,4) NOT NULL,
  field_type        TEXT NOT NULL CHECK (field_type IN ('text','signature','initial','date','checkbox')),
  label             TEXT,
  recipient_role    TEXT,
  required          BOOLEAN NOT NULL DEFAULT TRUE,
  autofill_source   TEXT,
  display_order     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inkd_template_fields_template ON inkd_template_fields(template_id, page_number, display_order);

CREATE TABLE IF NOT EXISTS inkd_envelopes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id              UUID REFERENCES inkd_templates(id),
  source_pdf_url           TEXT NOT NULL,
  source_pdf_id            TEXT NOT NULL,
  page_count               INT NOT NULL,
  name                     TEXT NOT NULL,
  property_id              UUID REFERENCES properties(id),
  opportunity_id           UUID REFERENCES opportunities(id),
  contact_id               UUID REFERENCES contacts(id),
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','completed','voided','expired')),
  reminders_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_schedule        JSONB NOT NULL DEFAULT '[3,7]'::jsonb,
  expires_at               TIMESTAMPTZ,
  sent_at                  TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  filed_at                 TIMESTAMPTZ,
  filed_property_file_id   UUID REFERENCES property_files(id),
  final_pdf_url            TEXT,
  final_pdf_id             TEXT,
  final_pdf_hash           TEXT,
  created_by               UUID NOT NULL REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inkd_envelopes_status ON inkd_envelopes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inkd_envelopes_property ON inkd_envelopes(property_id) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inkd_recipients (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id            UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  role                   TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  email                  TEXT NOT NULL,
  phone                  TEXT,
  contact_id             UUID REFERENCES contacts(id),
  signing_order          INT NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','notified','viewed','signed','declined','expired')),
  sign_token_hash        TEXT NOT NULL UNIQUE,
  sign_token_expires_at  TIMESTAMPTZ NOT NULL,
  notified_at            TIMESTAMPTZ,
  viewed_at              TIMESTAMPTZ,
  signed_at              TIMESTAMPTZ,
  signed_ip              INET,
  signed_user_agent      TEXT,
  decline_reason         TEXT,
  last_reminded_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inkd_recipients_envelope ON inkd_recipients(envelope_id, signing_order);

CREATE TABLE IF NOT EXISTS inkd_field_values (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id         UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  template_field_id   UUID REFERENCES inkd_template_fields(id),
  page_number         INT NOT NULL,
  x_pct               NUMERIC(6,4) NOT NULL,
  y_pct               NUMERIC(6,4) NOT NULL,
  width_pct           NUMERIC(6,4) NOT NULL,
  height_pct          NUMERIC(6,4) NOT NULL,
  field_type          TEXT NOT NULL CHECK (field_type IN ('text','signature','initial','date','checkbox')),
  label               TEXT,
  recipient_id        UUID REFERENCES inkd_recipients(id) ON DELETE CASCADE,
  value               TEXT,
  value_filled_at     TIMESTAMPTZ,
  value_filled_by     UUID REFERENCES users(id),
  autofilled          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_inkd_field_values_envelope ON inkd_field_values(envelope_id, page_number);

CREATE TABLE IF NOT EXISTS inkd_audit_events (
  id            BIGSERIAL PRIMARY KEY,
  envelope_id   UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  recipient_id  UUID REFERENCES inkd_recipients(id),
  event_type    TEXT NOT NULL,
  event_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            INET,
  user_agent    TEXT,
  user_id       UUID REFERENCES users(id),
  details       JSONB
);
CREATE INDEX IF NOT EXISTS idx_inkd_audit_envelope ON inkd_audit_events(envelope_id, event_at);
