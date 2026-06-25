-- CreateTable
CREATE TABLE "bdjobs_posts" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "bdjobs_job_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "form_data" JSONB NOT NULL,
    "error_message" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bdjobs_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bdjobs_posts_requisition_id_key" ON "bdjobs_posts"("requisition_id");

-- AddForeignKey
ALTER TABLE "bdjobs_posts" ADD CONSTRAINT "bdjobs_posts_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
