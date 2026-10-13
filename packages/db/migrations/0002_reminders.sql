CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'telegram_group');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('heads_up', 'milestone', 'nudge', 'due', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('planned', 'sent', 'cancelled');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid,
	"reminder_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notification_attempts_non_negative" CHECK ("notification"."attempts" >= 0),
	CONSTRAINT "notification_in_app_has_member" CHECK ("notification"."channel" <> 'in_app' OR "notification"."member_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"member_id" uuid,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'planned' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_occurrence_key_uq" UNIQUE("occurrence_id","key")
);
--> statement-breakpoint
CREATE TABLE "service_heartbeat" (
	"service" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_reminder_id_reminder_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_occurrence_id_occurrence_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_pending_idx" ON "notification" USING btree ("channel","next_attempt_at") WHERE "notification"."sent_at" IS NULL AND "notification"."failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notification_member_created_at_idx" ON "notification" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "reminder_status_fire_at_idx" ON "reminder" USING btree ("status","fire_at");