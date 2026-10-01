ALTER TABLE "git_accounts" ADD COLUMN "is_default_reviewer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "git_accounts_default_reviewer_scope_uq" ON "git_accounts" USING btree ("provider",(CASE WHEN "provider" = 'bitbucket' THEN COALESCE("workspace", '') ELSE '' END)) WHERE "is_default_reviewer";
