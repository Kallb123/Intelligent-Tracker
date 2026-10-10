CREATE TYPE "public"."assignment_mode" AS ENUM('fixed', 'any', 'rotation');--> statement-breakpoint
CREATE TYPE "public"."bank_holiday_region" AS ENUM('england-and-wales', 'scotland', 'northern-ireland');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('upcoming', 'active', 'started', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reminder_profile" AS ENUM('silent', 'gentle', 'standard', 'persistent');--> statement-breakpoint
CREATE TYPE "public"."reminder_slot" AS ENUM('evening', 'morning', 'custom_time');--> statement-breakpoint
CREATE TYPE "public"."schedule_kind" AS ENUM('once', 'fixed', 'after_completion');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid,
	"task_id" uuid,
	"occurrence_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_holiday" (
	"region" "bank_holiday_region" NOT NULL,
	"date" date NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "bank_holiday_region_date_pk" PRIMARY KEY("region","date")
);
--> statement-breakpoint
CREATE TABLE "household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"locale" text DEFAULT 'en-GB' NOT NULL,
	"bank_holiday_region" "bank_holiday_region" DEFAULT 'england-and-wales' NOT NULL,
	"ical_public_host" text DEFAULT 'calendar.kallum.uk' NOT NULL,
	"telegram_group_chat_id" bigint,
	"default_reminder_profile" "reminder_profile" DEFAULT 'standard' NOT NULL,
	"morning_slot" time DEFAULT '08:00' NOT NULL,
	"evening_slot" time DEFAULT '19:00' NOT NULL,
	"quiet_hours_start" time DEFAULT '21:30' NOT NULL,
	"quiet_hours_end" time DEFAULT '07:30' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"telegram_user_id" bigint,
	"telegram_link_code" text,
	"preferred_reminder_times" time[] DEFAULT '{}'::time[] NOT NULL,
	"away_until" date,
	"ical_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "member_telegram_link_code_unique" UNIQUE("telegram_link_code"),
	CONSTRAINT "member_ical_token_unique" UNIQUE("ical_token")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"due_date" date,
	"due_at" timestamp with time zone,
	"start_at" timestamp with time zone,
	"assignee_id" uuid,
	"status" "occurrence_status" DEFAULT 'upcoming' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"snoozed_until" timestamp with time zone,
	"milestone_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occurrence_task_due_date_uq" UNIQUE("task_id","due_date"),
	CONSTRAINT "occurrence_task_due_at_uq" UNIQUE("task_id","due_at"),
	CONSTRAINT "occurrence_single_due" CHECK ("occurrence"."due_date" IS NULL OR "occurrence"."due_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"reminder_slot" "reminder_slot" DEFAULT 'evening' NOT NULL,
	"reminder_custom_time" time,
	"effort_minutes" integer,
	"schedule_kind" "schedule_kind" NOT NULL,
	"due_date" date,
	"due_at" timestamp with time zone,
	"all_day" boolean DEFAULT true NOT NULL,
	"rrule" text,
	"interval_after_completion_days" integer,
	"lead_time_days" integer,
	"reminder_profile" "reminder_profile" DEFAULT 'standard' NOT NULL,
	"assignment_mode" "assignment_mode" DEFAULT 'fixed' NOT NULL,
	"rotation_cursor" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_all_day_matches_due_at" CHECK ("task"."all_day" = ("task"."due_at" IS NULL)),
	CONSTRAINT "task_due_date_only_when_all_day" CHECK ("task"."due_date" IS NULL OR "task"."all_day"),
	CONSTRAINT "task_custom_time_set" CHECK ("task"."reminder_slot" <> 'custom_time' OR "task"."reminder_custom_time" IS NOT NULL),
	CONSTRAINT "task_after_completion_interval" CHECK ("task"."schedule_kind" <> 'after_completion' OR "task"."interval_after_completion_days" IS NOT NULL),
	CONSTRAINT "task_interval_positive" CHECK ("task"."interval_after_completion_days" IS NULL OR "task"."interval_after_completion_days" > 0),
	CONSTRAINT "task_lead_time_non_negative" CHECK ("task"."lead_time_days" IS NULL OR "task"."lead_time_days" >= 0),
	CONSTRAINT "task_effort_positive" CHECK ("task"."effort_minutes" IS NULL OR "task"."effort_minutes" > 0),
	CONSTRAINT "task_rotation_cursor_non_negative" CHECK ("task"."rotation_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_assignee" (
	"task_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "task_assignee_task_id_member_id_pk" PRIMARY KEY("task_id","member_id"),
	CONSTRAINT "task_assignee_task_position_uq" UNIQUE("task_id","position"),
	CONSTRAINT "task_assignee_position_non_negative" CHECK ("task_assignee"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"offset_days_before_due" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "task_milestone_task_position_uq" UNIQUE("task_id","position"),
	CONSTRAINT "task_milestone_offset_non_negative" CHECK ("task_milestone"."offset_days_before_due" >= 0)
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_occurrence_id_occurrence_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_assignee_id_member_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_completed_by_member_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_milestone" ADD CONSTRAINT "task_milestone_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_household_created_at_idx" ON "activity" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_task_id_idx" ON "activity" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_username_lower_uq" ON "member" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "member_household_id_idx" ON "member" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "session_member_id_idx" ON "session" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrence_task_undated_uq" ON "occurrence" USING btree ("task_id") WHERE "occurrence"."due_date" IS NULL AND "occurrence"."due_at" IS NULL;--> statement-breakpoint
CREATE INDEX "occurrence_status_due_date_idx" ON "occurrence" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "occurrence_status_due_at_idx" ON "occurrence" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "occurrence_status_start_at_idx" ON "occurrence" USING btree ("status","start_at");--> statement-breakpoint
CREATE INDEX "occurrence_assignee_status_idx" ON "occurrence" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "task_household_id_idx" ON "task" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "task_assignee_member_id_idx" ON "task_assignee" USING btree ("member_id");