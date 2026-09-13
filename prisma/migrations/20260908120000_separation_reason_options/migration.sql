-- "Reason for leaving" becomes a fixed dropdown rather than free text.
--
-- Seeded into master_options like the other fixed vocabularies, so the list can
-- be corrected without a deploy. Free-text reasons already captured stay in the
-- column untouched — the column type does not change.
INSERT INTO "master_options" ("id", "kind", "value", "parent", "sort_order", "updated_at")
VALUES
  (gen_random_uuid()::text, 'separation_reason', 'Personal', '', 0, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Family', '', 1, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Better Opportunity', '', 2, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Higher Studies', '', 3, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Govt Job', '', 4, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Cultural Issue', '', 5, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Line Manager Issue', '', 6, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Work Life Balance', '', 7, NOW()),
  (gen_random_uuid()::text, 'separation_reason', 'Financial Issues', '', 8, NOW())
ON CONFLICT ("kind","value","parent") DO NOTHING;
