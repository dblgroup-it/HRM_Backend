-- Line of Business + replacement details on a requisition.
--
-- Two related changes:
--
-- 1. `line_of_business` — DBL's business verticals, picked after the unit.
--    Seeded into master_options like the other fixed dropdowns so the list can
--    be corrected without a deploy.
--
-- 2. Replacement details. Requisition type stops being derived from the
--    organogram and becomes the requisitioner's declaration; when they say
--    REPLACE they must name who is being replaced and why they left. Columns
--    are nullable because every existing requisition predates the fields.

ALTER TABLE "requisitions"
  ADD COLUMN IF NOT EXISTS "line_of_business"         VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "replace_of_name"          VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "replace_of_employee_code" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "separation_reason"        TEXT,
  ADD COLUMN IF NOT EXISTS "replacement_remarks"      TEXT;

INSERT INTO "master_options" ("id", "kind", "value", "parent", "sort_order", "updated_at")
VALUES
  (gen_random_uuid()::text, 'line_of_business', 'AOP', '', 0, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Accessories', '', 1, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Agriculture', '', 2, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Button', '', 3, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Buying House', '', 4, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Ceramics Tiles', '', 5, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Digital Services', '', 6, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Distribution', '', 7, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Dredging', '', 8, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Dyeing and Finishing', '', 9, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Embroidery', '', 10, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Finishing', '', 11, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Garments', '', 12, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Healthcare', '', 13, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Knitting', '', 14, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Lifestyle', '', 15, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Lingerie', '', 16, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Packaging', '', 17, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Pharma', '', 18, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Screen Printing', '', 19, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Shared Services', '', 20, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Spinning', '', 21, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Telecom', '', 22, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Testing Services', '', 23, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Textile Recycling', '', 24, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Thread', '', 25, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Tours and Travels', '', 26, NOW()),
  (gen_random_uuid()::text, 'line_of_business', 'Washing', '', 27, NOW())
ON CONFLICT ("kind","value","parent") DO NOTHING;
