-- Place of posting: DBL's sites by name, alongside the full letter addresses.
--
-- Place of posting reads the job_location list (the same one the offer and
-- appointment letters print), which until now held only full postal
-- addresses. HR picks a posting by site name, so the sites are added and
-- listed first (negative sort order), in the order HR gave them.

INSERT INTO "master_options" ("id", "kind", "value", "parent", "sort_order", "is_active", "created_at", "updated_at") VALUES
  ('mo_jobloc_site_01', 'job_location', 'Jinnat Complex', '', -13, true, NOW(), NOW()),
  ('mo_jobloc_site_02', 'job_location', 'Glory Complex', '', -12, true, NOW(), NOW()),
  ('mo_jobloc_site_03', 'job_location', 'Mymun Complex', '', -11, true, NOW(), NOW()),
  ('mo_jobloc_site_04', 'job_location', 'Sreehatta EZ', '', -10, true, NOW(), NOW()),
  ('mo_jobloc_site_05', 'job_location', 'Thanbee Complex', '', -9, true, NOW(), NOW()),
  ('mo_jobloc_site_06', 'job_location', 'Matin Complex', '', -8, true, NOW(), NOW()),
  ('mo_jobloc_site_07', 'job_location', 'JKL 2 Complex', '', -7, true, NOW(), NOW()),
  ('mo_jobloc_site_08', 'job_location', 'Mawna Complex', '', -6, true, NOW(), NOW()),
  ('mo_jobloc_site_09', 'job_location', 'FFL 2 Complex', '', -5, true, NOW(), NOW()),
  ('mo_jobloc_site_10', 'job_location', 'Corporate Head Office', '', -4, true, NOW(), NOW()),
  ('mo_jobloc_site_11', 'job_location', 'Corporate Head Office Uttara', '', -3, true, NOW(), NOW()),
  ('mo_jobloc_site_12', 'job_location', 'Pharma Complex', '', -2, true, NOW(), NOW()),
  ('mo_jobloc_site_13', 'job_location', 'Farmgate Office', '', -1, true, NOW(), NOW())
ON CONFLICT ("kind", "value", "parent") DO UPDATE
  SET "sort_order" = EXCLUDED."sort_order", "is_active" = true, "updated_at" = NOW();
