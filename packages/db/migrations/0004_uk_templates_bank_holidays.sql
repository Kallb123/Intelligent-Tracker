CREATE TABLE "bank_holiday_sync" (
	"region" "bank_holiday_region" PRIMARY KEY NOT NULL,
	"synced_at" timestamp with time zone,
	"attempted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"title" text NOT NULL,
	"keywords" text[] NOT NULL,
	"defaults" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "occurrence" ADD COLUMN "source_due_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "working_days_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "remind_offset_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing occurrences predate working-day shifts, so their current due is their source identity.
UPDATE "occurrence"
SET "source_due_keys" = CASE
  WHEN "due_date" IS NOT NULL THEN ARRAY['d:' || "due_date"::text]
  WHEN "due_at" IS NOT NULL THEN ARRAY['t:' || ((extract(epoch FROM "due_at") * 1000)::bigint)::text]
  ELSE '{}'::text[]
END;
