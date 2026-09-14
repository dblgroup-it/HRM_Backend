-- Job locations offered on the offer / appointment letters, as master options
-- so HR can maintain the list without a release.

INSERT INTO "master_options" ("id", "kind", "value", "parent", "sort_order", "is_active", "created_at", "updated_at") VALUES
  ('mo_jobloc_001', 'job_location', 'House No. 10-A (5th Floor), Road No. 4, Gulshan 1, Gulshan Model Town, Dhaka, 1212, Bangladesh', '', 0, true, NOW(), NOW()),
  ('mo_jobloc_002', 'job_location', 'South Avenue Tower (4th Floor), House No. 50, Road No.3, Block No. SW(H), Gulshan 1, Dhaka, Gulshan Model Town, 1212, Bangladesh', '', 1, true, NOW(), NOW()),
  ('mo_jobloc_003', 'job_location', 'Sardagonj, Kashimpur, Dhaka, 1346, Bangladesh', '', 2, true, NOW(), NOW()),
  ('mo_jobloc_004', 'job_location', 'Danua, Sreepur, Gazipur, 1740, Bangladesh.', '', 3, true, NOW(), NOW()),
  ('mo_jobloc_005', 'job_location', 'Nayapara, Kashimpur, Dhaka, 1346, Bangladesh', '', 4, true, NOW(), NOW()),
  ('mo_jobloc_006', 'job_location', 'Surabari, Kashimpur, Dhaka, 1346, Bangladesh', '', 5, true, NOW(), NOW()),
  ('mo_jobloc_007', 'job_location', '2nd Floor, House 10, Road 04, Gulshan 1, Dhaka 1212, Bangladesh', '', 6, true, NOW(), NOW()),
  ('mo_jobloc_008', 'job_location', 'Mariali, Joydevpur Gazipur, 1700, Bangladesh', '', 7, true, NOW(), NOW()),
  ('mo_jobloc_009', 'job_location', 'Kharuali, Word No-7, Bhaluka, Municipal Area, Mymensingh, Bangladesh.', '', 8, true, NOW(), NOW()),
  ('mo_jobloc_010', 'job_location', 'Teperbari, Sreepur, Gazipur, 1740, Bangladesh', '', 9, true, NOW(), NOW()),
  ('mo_jobloc_011', 'job_location', 'BGMEA Complex, West Tower, Floor 11, House:7/7A, Block:H-1, Sector-17, Uttara, Dhaka-1230, Bangladesh.', '', 10, true, NOW(), NOW()),
  ('mo_jobloc_012', 'job_location', 'ABC Northridge, 12 Floor, House No. 51, Road No. 15, Rabindra Sarani, Sector No. 03, Uttara, Dhaka, 1230, Bangladesh', '', 11, true, NOW(), NOW()),
  ('mo_jobloc_013', 'job_location', 'Village/PO : Sherpur, Thana- Moulvibazar Sadar, Moulvibazar, Bangladesh', '', 12, true, NOW(), NOW()),
  ('mo_jobloc_014', 'job_location', 'Sardagonj, Kashimpur, Dhaka, Savar Kashem Cotton Mills, 1346, Bangladesh', '', 13, true, NOW(), NOW()),
  ('mo_jobloc_015', 'job_location', 'Dulal Brothers Limited. Nascent Tower,  4th Floor, 806/A Agrabad, C/A Chittagong, 4100, Bangladesh', '', 14, true, NOW(), NOW()),
  ('mo_jobloc_016', 'job_location', '102, Green Road, Farmgate, Tejgaon, Dhaka, 1215, Bangladesh', '', 15, true, NOW(), NOW()),
  ('mo_jobloc_017', 'job_location', '3rd Floor, House 10, Road 04, Gulshan 1, Dhaka 1212, Bangladesh', '', 16, true, NOW(), NOW()),
  ('mo_jobloc_018', 'job_location', 'Suite No. 4B, House No. 1/B, Road No. 8, Block-I, Banani, Dhaka - 1213, Bangladesh.', '', 17, true, NOW(), NOW()),
  ('mo_jobloc_019', 'job_location', 'House: 323/426, CDA Avenue, Lalkhan Bazar, Khulshi, Chattogram (Beside of Amin Centre Shopping complex)', '', 18, true, NOW(), NOW()),
  ('mo_jobloc_020', 'job_location', 'Bashundhara City Shopping Complex', '', 19, true, NOW(), NOW()),
  ('mo_jobloc_021', 'job_location', 'Road-11, Banani, Dhaka', '', 20, true, NOW(), NOW()),
  ('mo_jobloc_022', 'job_location', '102 Green Road, Farmgate, Tejgaon, Dhaka, Tejgaon TSO, 1215, Bangladesh.', '', 21, true, NOW(), NOW()),
  ('mo_jobloc_023', 'job_location', 'BGMEA Bhaban ( 7th Floor), 669/E Jhautala Road, South Khulshi, Chittagong', '', 22, true, NOW(), NOW()),
  ('mo_jobloc_024', 'job_location', 'Dhaka, Bangladesh', '', 23, true, NOW(), NOW()),
  ('mo_jobloc_025', 'job_location', 'Road-27, Dhanmondi, Dhaka', '', 24, true, NOW(), NOW())
ON CONFLICT ("kind", "value", "parent") DO NOTHING;
