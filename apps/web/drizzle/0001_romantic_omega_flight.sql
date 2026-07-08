CREATE TYPE "public"."job_type" AS ENUM('INGEST_DOCUMENT', 'RUN_EVALUATION');--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ALTER COLUMN "document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "job_type" "job_type" DEFAULT 'INGEST_DOCUMENT' NOT NULL;