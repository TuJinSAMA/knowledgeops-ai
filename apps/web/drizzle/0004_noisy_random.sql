CREATE TYPE "public"."feedback_rating" AS ENUM('HELPFUL', 'NOT_HELPFUL');--> statement-breakpoint
CREATE TYPE "public"."feedback_report_type" AS ENUM('WRONG_ANSWER', 'MISSING_KNOWLEDGE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."feedback_review_status" AS ENUM('NEW', 'PENDING_REVIEW', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "answer_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"trace_id" uuid,
	"user_id" text NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"report_type" "feedback_report_type",
	"comment" text,
	"review_status" "feedback_review_status" DEFAULT 'NEW' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_trace_id_rag_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."rag_traces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_feedback_workspace_message_user_idx" ON "answer_feedback" USING btree ("workspace_id","message_id","user_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_workspace_idx" ON "answer_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_message_idx" ON "answer_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_review_status_idx" ON "answer_feedback" USING btree ("review_status");