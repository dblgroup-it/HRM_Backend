-- Interview venues and offer special notes, as master options so they stay
-- editable rather than compiled in.
--
-- meeting_room: parent is the building, value the room; the UI shows
-- "<building> :: <room>", which is how the rooms were given to us.
-- special_note: flat list of the fixed terms HR attaches to an appointment.

INSERT INTO "master_options" ("id", "kind", "value", "parent", "sort_order", "is_active", "created_at", "updated_at") VALUES
  ('mo_room_001', 'meeting_room', 'Room-301', 'Head Office', 0, true, NOW(), NOW()),
  ('mo_room_002', 'meeting_room', 'Room-302', 'Head Office', 1, true, NOW(), NOW()),
  ('mo_room_003', 'meeting_room', 'Room-303', 'Head Office', 2, true, NOW(), NOW()),
  ('mo_room_004', 'meeting_room', 'Room-401', 'Head Office', 3, true, NOW(), NOW()),
  ('mo_room_005', 'meeting_room', 'Room-402', 'Head Office', 4, true, NOW(), NOW()),
  ('mo_room_006', 'meeting_room', 'HR Meeting Room-501', 'Head Office', 5, true, NOW(), NOW()),
  ('mo_room_007', 'meeting_room', 'Room-601', 'Head Office', 6, true, NOW(), NOW()),
  ('mo_room_008', 'meeting_room', 'Room-602', 'Head Office', 7, true, NOW(), NOW()),
  ('mo_room_009', 'meeting_room', 'Conference Room-701', 'Head Office', 8, true, NOW(), NOW()),
  ('mo_room_010', 'meeting_room', 'Room-702', 'Head Office', 9, true, NOW(), NOW()),
  ('mo_room_011', 'meeting_room', 'Room-703', 'Head Office', 10, true, NOW(), NOW()),
  ('mo_room_012', 'meeting_room', 'R201', 'Pharma Building', 100, true, NOW(), NOW()),
  ('mo_room_013', 'meeting_room', 'R202', 'Pharma Building', 101, true, NOW(), NOW()),
  ('mo_room_014', 'meeting_room', 'R203', 'Pharma Building', 102, true, NOW(), NOW()),
  ('mo_room_015', 'meeting_room', 'R301', 'Pharma Building', 103, true, NOW(), NOW()),
  ('mo_room_016', 'meeting_room', 'R801', 'Pharma Building', 104, true, NOW(), NOW()),
  ('mo_room_017', 'meeting_room', 'Room 3025 R&D', 'Pharma Plant', 200, true, NOW(), NOW()),
  ('mo_room_018', 'meeting_room', 'Room 4030 QA', 'Pharma Plant', 201, true, NOW(), NOW()),
  ('mo_room_019', 'meeting_room', 'Room 4064 SCM', 'Pharma Plant', 202, true, NOW(), NOW()),
  ('mo_room_020', 'meeting_room', 'Room 4078 QC', 'Pharma Plant', 203, true, NOW(), NOW()),
  ('mo_room_021', 'meeting_room', 'Room 4082 General', 'Pharma Plant', 204, true, NOW(), NOW()),
  ('mo_room_022', 'meeting_room', 'Room 4095 GPB West', 'Pharma Plant', 205, true, NOW(), NOW()),
  ('mo_room_023', 'meeting_room', 'Room Engineering', 'Pharma Plant', 206, true, NOW(), NOW()),
  ('mo_room_024', 'meeting_room', 'Room R&D-Validation', 'Pharma Plant', 207, true, NOW(), NOW()),
  ('mo_room_025', 'meeting_room', 'Ceramics-201', 'Ceramics Building', 300, true, NOW(), NOW()),
  ('mo_room_026', 'meeting_room', 'Ceramics-301', 'Ceramics Building', 301, true, NOW(), NOW()),
  ('mo_room_027', 'meeting_room', 'Digital-201', 'Digital Building', 400, true, NOW(), NOW()),
  ('mo_room_028', 'meeting_room', 'Digital-301', 'Digital Building', 401, true, NOW(), NOW()),
  ('mo_note_001', 'special_note', 'Salary may be reviewed after six month based on performance', '', 0, true, NOW(), NOW()),
  ('mo_note_002', 'special_note', 'Salary and position may be reviewed after six month based on performance', '', 1, true, NOW(), NOW()),
  ('mo_note_003', 'special_note', 'Full with bonus will be provided.', '', 2, true, NOW(), NOW()),
  ('mo_note_004', 'special_note', 'Partial 25% Eid Bonus will be provided', '', 3, true, NOW(), NOW()),
  ('mo_note_005', 'special_note', 'Partial 50% Eid Bonus will be provided', '', 4, true, NOW(), NOW()),
  ('mo_note_006', 'special_note', 'Tax will be reimbursed.', '', 5, true, NOW(), NOW())
ON CONFLICT ("kind", "value", "parent") DO NOTHING;
