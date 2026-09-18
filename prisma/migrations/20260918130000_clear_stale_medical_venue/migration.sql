-- Forget venues that were never actually chosen.
--
-- The venue is remembered per candidate so a corrected address survives a
-- re-send. That rule is right, but it cannot tell a deliberate choice from a
-- default that happened to be stored — and the default used to be the Gulshan
-- corporate office before the examination venue was settled as Jinnat Complex.
--
-- Any row still holding the old corporate-office text was stamped with that
-- default, not chosen by anyone, so clearing it lets the current default apply.
-- A genuinely typed address is left alone: this matches only the exact opening
-- of the old default, not any address that merely mentions the office.
UPDATE "onboardings"
   SET "medical_venue" = NULL
 WHERE "medical_venue" LIKE 'DBL Group Corporate Office:%';
