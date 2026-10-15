ALTER TABLE "household" ADD COLUMN "telegram_group_link_code" text;--> statement-breakpoint
ALTER TABLE "household" ADD COLUMN "telegram_group_link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "telegram_link_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notification_telegram_message_idx" ON "notification" USING btree ("household_id","telegram_message_id") WHERE "notification"."telegram_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "household" ADD CONSTRAINT "household_telegram_group_chat_id_unique" UNIQUE("telegram_group_chat_id");--> statement-breakpoint
ALTER TABLE "household" ADD CONSTRAINT "household_telegram_group_link_code_unique" UNIQUE("telegram_group_link_code");