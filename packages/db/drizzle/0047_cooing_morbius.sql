CREATE TYPE "public"."check_status" AS ENUM('up', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."check_type" AS ENUM('http', 'tcp', 'process', 'postgres', 'mysql');--> statement-breakpoint
CREATE TABLE "check_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"status" "check_status" NOT NULL,
	"latency_ms" integer,
	"metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE "check_samples_rollup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"up_count" integer NOT NULL,
	"down_count" integer NOT NULL,
	"latency_ms_avg" real,
	"latency_ms_max" integer
);
--> statement-breakpoint
CREATE TABLE "server_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu_pct" real NOT NULL,
	"load_1m" real NOT NULL,
	"mem_used_bytes" bigint NOT NULL,
	"mem_total_bytes" bigint NOT NULL,
	"swap_used_bytes" bigint NOT NULL,
	"disk_used_bytes" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"net_rx_bytes" bigint NOT NULL,
	"net_tx_bytes" bigint NOT NULL,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metrics_rollup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu_pct_avg" real NOT NULL,
	"cpu_pct_max" real NOT NULL,
	"load_1m_avg" real NOT NULL,
	"load_1m_max" real NOT NULL,
	"mem_used_bytes_avg" bigint NOT NULL,
	"mem_used_bytes_max" bigint NOT NULL,
	"mem_total_bytes" bigint NOT NULL,
	"disk_used_bytes_avg" bigint NOT NULL,
	"disk_used_bytes_max" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"net_rx_bytes_sum" bigint NOT NULL,
	"net_tx_bytes_sum" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"key_hash" text NOT NULL,
	"sample_interval_seconds" integer DEFAULT 30 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"agent_version" text,
	"alert_thresholds" jsonb DEFAULT '{"cpuPct":95,"memPct":90,"diskPct":90,"sustainedMinutes":5}'::jsonb NOT NULL,
	"active_alerts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "service_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"type" "check_type" NOT NULL,
	"name" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"dsn_encrypted" text,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" "check_status" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_latency_ms" integer,
	"last_error" text,
	"down_since" timestamp with time zone,
	"down_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_samples" ADD CONSTRAINT "check_samples_check_id_service_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."service_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_samples_rollup" ADD CONSTRAINT "check_samples_rollup_check_id_service_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."service_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metrics_rollup" ADD CONSTRAINT "server_metrics_rollup_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_projects" ADD CONSTRAINT "server_projects_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_projects" ADD CONSTRAINT "server_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checks" ADD CONSTRAINT "service_checks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_samples_check_ts_unique" ON "check_samples" USING btree ("check_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "check_samples_rollup_check_ts_unique" ON "check_samples_rollup" USING btree ("check_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "server_metrics_server_ts_unique" ON "server_metrics" USING btree ("server_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "server_metrics_rollup_server_ts_unique" ON "server_metrics_rollup" USING btree ("server_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "server_projects_server_id_project_id_unique" ON "server_projects" USING btree ("server_id","project_id");--> statement-breakpoint
CREATE INDEX "server_projects_project_id_idx" ON "server_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "service_checks_server_id_idx" ON "service_checks" USING btree ("server_id");