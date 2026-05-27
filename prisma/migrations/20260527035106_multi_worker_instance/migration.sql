-- AlterTable: add instance_id (with default for backward-compat), hostname, pid
ALTER TABLE "claude_workers"
  ADD COLUMN "instance_id" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "hostname" TEXT,
  ADD COLUMN "pid" INTEGER;

-- DropIndex: the single-token bottleneck (blocks multi-worker presence)
DROP INDEX "claude_workers_token_id_key";

-- CreateIndex: composite unique (user_id, token_id, instance_id)
-- Allows multiple worker containers with the same token but different instance ids.
CREATE UNIQUE INDEX "claude_workers_user_id_token_id_instance_id_key"
  ON "claude_workers"("user_id", "token_id", "instance_id");

-- AlterTable: claude_jobs.worker_instance_id — which worker claimed the job
ALTER TABLE "claude_jobs"
  ADD COLUMN "worker_instance_id" TEXT;

-- CreateIndex: lookup jobs by worker
CREATE INDEX "claude_jobs_worker_instance_id_idx"
  ON "claude_jobs"("worker_instance_id");
