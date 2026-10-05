ALTER TABLE "comments" ADD COLUMN "reply_to_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reply_to_comment_id_comments_id_fk" FOREIGN KEY ("reply_to_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_reply_to_comment_id_idx" ON "comments" USING btree ("reply_to_comment_id");
