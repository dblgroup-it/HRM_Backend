-- E-signature on a user's profile.
--
-- A roughly 3:1 image, stored in Google Drive like the profile picture and
-- served through a proxy route rather than a public Drive link.
--
-- `signature_uploaded_by_id` records who put it there, and is the whole rule:
-- when it equals the user's own id the signature is theirs, and HR may not
-- replace or remove it. Kept as a plain id rather than a foreign key — it is an
-- audit marker, the only question asked of it is "is this the owner", and a
-- self-relation on users would have to be maintained for nothing.
--
-- All three columns are nullable and additive: a user without a signature
-- behaves exactly as before, and older code ignores them entirely.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "signature_file_id"        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "signature_uploaded_by_id" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "signature_uploaded_at"    TIMESTAMP(3);
