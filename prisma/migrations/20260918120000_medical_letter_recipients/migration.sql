-- Who the medical test letter actually reached.
--
-- One "sent at" stamp could not answer the question somebody asks when a
-- candidate fails to turn up: was the candidate told, or only the clinic?
-- They are two separate emails and either can fail on its own, so each is
-- recorded on its own.
--
-- Additive and nullable; a letter sent before this migration keeps its
-- existing `medical_letter_sent_at` and simply reports neither side
-- individually, which is the truth about it.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "medical_letter_team_sent_at"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "medical_letter_candidate_sent_at" TIMESTAMP(3);
