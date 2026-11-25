ALTER TABLE "evaluation_cases" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD COLUMN "promoted_case_id" uuid;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_promoted_case_id_evaluation_cases_id_fk" FOREIGN KEY ("promoted_case_id") REFERENCES "public"."evaluation_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_traces_promoted_case_idx" ON "rag_traces" USING btree ("promoted_case_id");