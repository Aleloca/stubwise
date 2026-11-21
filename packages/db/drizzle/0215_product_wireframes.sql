-- Area 11, F6: le bozze di schermata di Claude. Il blocco `wireframe` di una
-- pagina nomina la bozza (`wireframeId`) e una sua variante (`variant`, indice
-- in `variants`). Lo SVG lo disegna il modello e il server lo RIPULISCE prima
-- di salvarlo (`sanitizeWireframeSvg`). Il disegno è un lavoro della coda della
-- doc (`source_kind = 'wireframe'`).
CREATE TABLE "product_wireframes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"block_id" text NOT NULL,
	"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'drawing' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_wireframes_status_chk" CHECK ("status" in ('drawing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "product_wireframes_page_idx" ON "product_wireframes" ("page_id");
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" DROP CONSTRAINT "product_doc_jobs_source_kind_chk";
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD CONSTRAINT "product_doc_jobs_source_kind_chk" CHECK ("source_kind" in ('email', 'meeting', 'decision', 'task', 'release', 'first_version', 'wireframe'));
