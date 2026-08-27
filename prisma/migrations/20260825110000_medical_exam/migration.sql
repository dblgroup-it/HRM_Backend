-- CreateTable
CREATE TABLE "medical_exams" (
    "id" TEXT NOT NULL,
    "onboarding_id" TEXT NOT NULL,
    "date_of_birth" DATE,
    "duty_position" TEXT,
    "ref_no" TEXT,
    "registration_no" TEXT,
    "exam_date" DATE,
    "issue_date" DATE,
    "consultant_name" TEXT,
    "height" TEXT,
    "weight" TEXT,
    "pulse" TEXT,
    "blood_pressure" TEXT,
    "vision_right_eye" TEXT,
    "vision_left_eye" TEXT,
    "vision_with_glass" BOOLEAN,
    "color_vision_yellow" TEXT,
    "color_vision_red" TEXT,
    "color_vision_green" TEXT,
    "color_vision_blue" TEXT,
    "hearing_right_ear" TEXT,
    "hearing_left_ear" TEXT,
    "speech" TEXT,
    "extremities" TEXT,
    "no_anemia_jaundice_etc" BOOLEAN,
    "stable_normotensive_nondiabetic" BOOLEAN,
    "urine_test_clear" BOOLEAN,
    "hepatitis_b_negative" BOOLEAN,
    "liver_function_normal" BOOLEAN,
    "past_illness_history" TEXT,
    "family_history_dm_htn" BOOLEAN,
    "family_history_detail" TEXT,
    "blood_group" TEXT,
    "fit_to_join" BOOLEAN,
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_exams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "medical_exams_onboarding_id_key" ON "medical_exams"("onboarding_id");

-- AddForeignKey
ALTER TABLE "medical_exams" ADD CONSTRAINT "medical_exams_onboarding_id_fkey" FOREIGN KEY ("onboarding_id") REFERENCES "onboardings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
