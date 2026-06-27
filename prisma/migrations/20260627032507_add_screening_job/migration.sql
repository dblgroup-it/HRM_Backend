-- CreateTable
CREATE TABLE "screening_jobs" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "shortlisted" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screening_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "screening_jobs_requisition_id_key" ON "screening_jobs"("requisition_id");

-- AddForeignKey
ALTER TABLE "screening_jobs" ADD CONSTRAINT "screening_jobs_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
