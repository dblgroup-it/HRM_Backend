-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'HR_MANAGER', 'MANAGEMENT', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "EmployeeSource" AS ENUM ('ZINGHR', 'MANUAL');

-- CreateEnum
CREATE TYPE "SeatCategory" AS ENUM ('OFFICER', 'STAFF', 'WORKER');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PROFILE_GENERATED', 'POSTED');

-- CreateEnum
CREATE TYPE "RequirementType" AS ENUM ('EXISTING', 'NEW');

-- CreateEnum
CREATE TYPE "RequisitionSource" AS ENUM ('FACTORY', 'HO');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('TOP', 'MODERATE', 'ORDINARY');

-- CreateEnum
CREATE TYPE "EmploymentNature" AS ENUM ('PERMANENT', 'TEMPORARY', 'CONTRACTUAL');

-- CreateEnum
CREATE TYPE "ComputerRequirement" AS ENUM ('NOT_APPLICABLE', 'DESKTOP', 'LAPTOP');

-- CreateEnum
CREATE TYPE "SeatingArrangement" AS ENUM ('EXISTING', 'NEW');

-- CreateEnum
CREATE TYPE "ApprovalRole" AS ENUM ('DEPARTMENT_HEAD', 'FACTORY_HR', 'SBU_HEAD', 'CORPORATE_HR');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'INFO_REQUESTED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'NEED_MORE_INFO');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "unit_name" TEXT,
    "unit_id" TEXT,
    "address" TEXT,
    "joining_date" TIMESTAMP(3),
    "line_manager_name" TEXT,
    "line_manager_code" TEXT,
    "source" "EmployeeSource" NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "category" "SeatCategory" NOT NULL DEFAULT 'OFFICER',
    "sanctioned" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "requirement_type" "RequirementType" NOT NULL,
    "source" "RequisitionSource" NOT NULL,
    "required_posts" INTEGER NOT NULL,
    "total_vacant_posts" INTEGER NOT NULL,
    "unit_factory" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "place_of_posting" TEXT NOT NULL,
    "vacant_date" TIMESTAMP(3),
    "when_needed_date" TIMESTAMP(3),
    "priority" "Priority" NOT NULL DEFAULT 'MODERATE',
    "employment_nature" "EmploymentNature" NOT NULL DEFAULT 'PERMANENT',
    "contractual_purpose" TEXT,
    "job_description" TEXT NOT NULL,
    "education" TEXT NOT NULL,
    "experience" TEXT NOT NULL,
    "others" TEXT,
    "computer" "ComputerRequirement" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "computer_reason" TEXT,
    "seating" "SeatingArrangement" NOT NULL DEFAULT 'EXISTING',
    "preferred_sources" TEXT[],
    "status" "RequisitionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "role_profile" JSONB,
    "posting" JSONB,
    "raised_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "role" "ApprovalRole" NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "assignee" TEXT NOT NULL DEFAULT '',
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT NOT NULL DEFAULT '',
    "acted_at" TIMESTAMP(3),

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_activities" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" "ApprovalDecision" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requisition_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'zinghr',
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_code_key" ON "users"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_unit_id_idx" ON "employees"("unit_id");

-- CreateIndex
CREATE INDEX "employees_department_idx" ON "employees"("department");

-- CreateIndex
CREATE UNIQUE INDEX "units_name_key" ON "units"("name");

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_unit_id_name_key" ON "departments"("unit_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "positions_unit_id_department_id_designation_key" ON "positions"("unit_id", "department_id", "designation");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_code_key" ON "requisitions"("code");

-- CreateIndex
CREATE INDEX "requisitions_status_idx" ON "requisitions"("status");

-- CreateIndex
CREATE INDEX "requisitions_unit_factory_idx" ON "requisitions"("unit_factory");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_requisition_id_order_index_key" ON "approval_steps"("requisition_id", "order_index");

-- CreateIndex
CREATE INDEX "requisition_activities_requisition_id_idx" ON "requisition_activities"("requisition_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_activities" ADD CONSTRAINT "requisition_activities_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
