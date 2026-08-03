-- Apply VARCHAR column types to bounded string fields (TEXT stays for long-form content).

-- approval_steps
ALTER TABLE "approval_steps" ALTER COLUMN "title" TYPE VARCHAR(150);
ALTER TABLE "approval_steps" ALTER COLUMN "subtitle" TYPE VARCHAR(200);
ALTER TABLE "approval_steps" ALTER COLUMN "assignee" TYPE VARCHAR(150);

-- bdjobs_posts
ALTER TABLE "bdjobs_posts" ALTER COLUMN "bdjobs_job_id" TYPE VARCHAR(50);
ALTER TABLE "bdjobs_posts" ALTER COLUMN "status" TYPE VARCHAR(20);

-- candidates
ALTER TABLE "candidates" ALTER COLUMN "name" TYPE VARCHAR(150);
ALTER TABLE "candidates" ALTER COLUMN "email" TYPE VARCHAR(254);
ALTER TABLE "candidates" ALTER COLUMN "phone" TYPE VARCHAR(20);
ALTER TABLE "candidates" ALTER COLUMN "source" TYPE VARCHAR(20);
ALTER TABLE "candidates" ALTER COLUMN "cv_file_id" TYPE VARCHAR(100);
ALTER TABLE "candidates" ALTER COLUMN "salary_expectation" TYPE VARCHAR(50);

-- committee_members
ALTER TABLE "committee_members" ALTER COLUMN "role" TYPE VARCHAR(20);

-- departments
ALTER TABLE "departments" ALTER COLUMN "name" TYPE VARCHAR(150);

-- employees
ALTER TABLE "employees" ALTER COLUMN "employee_code" TYPE VARCHAR(20);
ALTER TABLE "employees" ALTER COLUMN "designation" TYPE VARCHAR(150);
ALTER TABLE "employees" ALTER COLUMN "department" TYPE VARCHAR(150);
ALTER TABLE "employees" ALTER COLUMN "section" TYPE VARCHAR(150);
ALTER TABLE "employees" ALTER COLUMN "grade" TYPE VARCHAR(50);
ALTER TABLE "employees" ALTER COLUMN "category" TYPE VARCHAR(50);
ALTER TABLE "employees" ALTER COLUMN "unit_name" TYPE VARCHAR(200);
ALTER TABLE "employees" ALTER COLUMN "location" TYPE VARCHAR(200);
ALTER TABLE "employees" ALTER COLUMN "gender" TYPE VARCHAR(10);
ALTER TABLE "employees" ALTER COLUMN "line_manager_name" TYPE VARCHAR(150);
ALTER TABLE "employees" ALTER COLUMN "line_manager_code" TYPE VARCHAR(20);

-- evaluation_tokens
ALTER TABLE "evaluation_tokens" ALTER COLUMN "token" TYPE VARCHAR(64);
ALTER TABLE "evaluation_tokens" ALTER COLUMN "status" TYPE VARCHAR(20);

-- exam_attempts
ALTER TABLE "exam_attempts" ALTER COLUMN "token" TYPE VARCHAR(64);
ALTER TABLE "exam_attempts" ALTER COLUMN "status" TYPE VARCHAR(20);

-- interview_rounds
ALTER TABLE "interview_rounds" ALTER COLUMN "location" TYPE VARCHAR(500);
ALTER TABLE "interview_rounds" ALTER COLUMN "calendar_event_id" TYPE VARCHAR(200);

-- notifications
ALTER TABLE "notifications" ALTER COLUMN "type" TYPE VARCHAR(50);
ALTER TABLE "notifications" ALTER COLUMN "title" TYPE VARCHAR(200);
ALTER TABLE "notifications" ALTER COLUMN "link" TYPE VARCHAR(500);

-- onboarding_docs
ALTER TABLE "onboarding_docs" ALTER COLUMN "label" TYPE VARCHAR(100);
ALTER TABLE "onboarding_docs" ALTER COLUMN "file_id" TYPE VARCHAR(100);
ALTER TABLE "onboarding_docs" ALTER COLUMN "mime_type" TYPE VARCHAR(100);
ALTER TABLE "onboarding_docs" ALTER COLUMN "status" TYPE VARCHAR(20);

-- onboardings
ALTER TABLE "onboardings" ALTER COLUMN "token" TYPE VARCHAR(64);
ALTER TABLE "onboardings" ALTER COLUMN "status" TYPE VARCHAR(30);
ALTER TABLE "onboardings" ALTER COLUMN "medical_status" TYPE VARCHAR(20);
ALTER TABLE "onboardings" ALTER COLUMN "it_email" TYPE VARCHAR(254);
ALTER TABLE "onboardings" ALTER COLUMN "it_asset_id" TYPE VARCHAR(50);

-- positions
ALTER TABLE "positions" ALTER COLUMN "designation" TYPE VARCHAR(150);
ALTER TABLE "positions" ALTER COLUMN "section" TYPE VARCHAR(150);

-- red_flag_registry
ALTER TABLE "red_flag_registry" ALTER COLUMN "email" TYPE VARCHAR(254);
ALTER TABLE "red_flag_registry" ALTER COLUMN "phone" TYPE VARCHAR(20);

-- requisition_activities
ALTER TABLE "requisition_activities" ALTER COLUMN "actor" TYPE VARCHAR(150);

-- requisitions
ALTER TABLE "requisitions" ALTER COLUMN "code" TYPE VARCHAR(20);
ALTER TABLE "requisitions" ALTER COLUMN "designation" TYPE VARCHAR(150);
ALTER TABLE "requisitions" ALTER COLUMN "unit_factory" TYPE VARCHAR(200);
ALTER TABLE "requisitions" ALTER COLUMN "department" TYPE VARCHAR(150);
ALTER TABLE "requisitions" ALTER COLUMN "section" TYPE VARCHAR(150);
ALTER TABLE "requisitions" ALTER COLUMN "place_of_posting" TYPE VARCHAR(200);
ALTER TABLE "requisitions" ALTER COLUMN "raised_by" TYPE VARCHAR(150);

-- roles
ALTER TABLE "roles" ALTER COLUMN "key" TYPE VARCHAR(50);
ALTER TABLE "roles" ALTER COLUMN "name" TYPE VARCHAR(100);

-- rubric_criteria
ALTER TABLE "rubric_criteria" ALTER COLUMN "label" TYPE VARCHAR(150);

-- settings (PK column type change)
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";
ALTER TABLE "settings" ALTER COLUMN "key" TYPE VARCHAR(100);
ALTER TABLE "settings" ADD PRIMARY KEY ("key");

-- sync_logs
ALTER TABLE "sync_logs" ALTER COLUMN "source" TYPE VARCHAR(20);
ALTER TABLE "sync_logs" ALTER COLUMN "status" TYPE VARCHAR(20);

-- units
ALTER TABLE "units" ALTER COLUMN "name" TYPE VARCHAR(200);

-- users
ALTER TABLE "users" ALTER COLUMN "employee_code" TYPE VARCHAR(20);
ALTER TABLE "users" ALTER COLUMN "name" TYPE VARCHAR(150);
ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(254);
ALTER TABLE "users" ALTER COLUMN "phone" TYPE VARCHAR(20);
ALTER TABLE "users" ALTER COLUMN "password_hash" TYPE VARCHAR(100);
ALTER TABLE "users" ALTER COLUMN "avatar_file_id" TYPE VARCHAR(100);
ALTER TABLE "users" ALTER COLUMN "two_factor_method" TYPE VARCHAR(10);
ALTER TABLE "users" ALTER COLUMN "two_factor_secret" TYPE VARCHAR(100);
ALTER TABLE "users" ALTER COLUMN "otp_hash" TYPE VARCHAR(100);
