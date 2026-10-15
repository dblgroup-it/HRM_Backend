-- Candidate Approval by email (2026-10-15). When Factory HR sends finalists
-- to the Factory HR Head, each Head gets ONE email per send — one candidate,
-- or all of a batch — with a personal link to a page where they approve,
-- return or reject without signing in. The row is that link: who it is for,
-- which candidates it covers, until when. Only the SHA-256 of the token is
-- kept; the raw value lives in the email alone. The decision itself is still
-- written to first_interview_approvals, so the in-app page and the link
-- cannot disagree, and the first Head to decide settles each candidate.
CREATE TABLE IF NOT EXISTS "candidate_approval_links" (
  "id"                TEXT NOT NULL,
  "user_id"           TEXT NOT NULL,
  "token_hash"        VARCHAR(64) NOT NULL,
  "candidate_ids"     TEXT[] NOT NULL,
  "submitted_by_name" VARCHAR(150),
  "token_expires_at"  TIMESTAMP(3) NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "candidate_approval_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_approval_links_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_approval_links_token_hash_key"
  ON "candidate_approval_links"("token_hash");
CREATE INDEX IF NOT EXISTS "candidate_approval_links_user_id_idx"
  ON "candidate_approval_links"("user_id");
