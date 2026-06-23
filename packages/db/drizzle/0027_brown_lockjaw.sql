CREATE TYPE "public"."doc_node_status" AS ENUM('pending', 'exploring', 'awaiting_children', 'ready_to_synthesize', 'synthesizing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."doc_tree" AS ENUM('technical', 'functional');--> statement-breakpoint
CREATE TABLE "doc_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"tree" "doc_tree" NOT NULL,
	"status" "doc_node_status" DEFAULT 'pending' NOT NULL,
	"pending_children" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"unit_ref" text,
	"title" text DEFAULT '' NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"source_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"links" jsonb,
	"error" text,
	"cost" numeric(12, 6),
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "doc_pages" ADD COLUMN "links" jsonb;--> statement-breakpoint
ALTER TABLE "doc_nodes" ADD CONSTRAINT "doc_nodes_generation_id_doc_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."doc_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_nodes" ADD CONSTRAINT "doc_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_nodes_generation_idx" ON "doc_nodes" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "doc_nodes_parent_idx" ON "doc_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "doc_nodes_claimable_idx" ON "doc_nodes" USING btree ("status","created_at");