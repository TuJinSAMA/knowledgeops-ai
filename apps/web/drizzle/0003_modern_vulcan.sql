CREATE TABLE "rag_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"query" text NOT NULL,
	"rewritten_query" text,
	"retrieval_config" jsonb,
	"retrieved_chunks" jsonb,
	"final_context" text,
	"model" text,
	"response" text,
	"token_usage" jsonb,
	"cost_estimate" numeric(12, 6),
	"latency_ms" integer,
	"stage_latency_ms" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_traces_workspace_idx" ON "rag_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rag_traces_conversation_idx" ON "rag_traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "rag_traces_message_idx" ON "rag_traces" USING btree ("message_id");