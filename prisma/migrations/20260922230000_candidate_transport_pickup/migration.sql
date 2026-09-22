-- Where this person is picked up from.
--
-- The requisition cannot answer it: at requisition time nobody is selected,
-- so nobody knows where they live. It is asked in the interview room, by
-- whoever takes the rest of the package (factory HR, on the first interview),
-- and read again by HR when they go through the hire's facility requirements
-- and have to arrange the run.

ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "transport_pickup" VARCHAR(200);
