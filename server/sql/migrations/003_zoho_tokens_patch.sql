-- 003_zoho_tokens_patch.sql

-- Create table if not already there
CREATE TABLE IF NOT EXISTS zoho_tokens (
  id            uuid PRIMARY KEY,
  zoho_user_id  text,
  access_token  text NOT NULL,
  refresh_token text,
  expires_at    timestamptz,
  api_domain    text,
  token_type    text,
  scope         text,
  revoked       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Ensure missing columns are added for older installs
ALTER TABLE zoho_tokens
  ADD COLUMN IF NOT EXISTS zoho_user_id  text,
  ADD COLUMN IF NOT EXISTS access_token  text,
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS expires_at    timestamptz,
  ADD COLUMN IF NOT EXISTS api_domain    text,
  ADD COLUMN IF NOT EXISTS token_type    text,
  ADD COLUMN IF NOT EXISTS scope         text,
  ADD COLUMN IF NOT EXISTS revoked       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_zoho_tokens_user
  ON zoho_tokens (zoho_user_id);

CREATE INDEX IF NOT EXISTS idx_zoho_tokens_expires_active
  ON zoho_tokens (expires_at)
  WHERE revoked IS NOT TRUE;
