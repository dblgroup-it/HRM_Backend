-- Add CHRO approval role + ESCALATED action for Corporate HR escalation
ALTER TYPE "ApprovalRole" ADD VALUE IF NOT EXISTS 'CHRO';
ALTER TYPE "ApprovalDecision" ADD VALUE IF NOT EXISTS 'ESCALATED';
