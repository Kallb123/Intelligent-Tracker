CREATE TABLE "quick_add_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"task" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quick_add_draft" ADD CONSTRAINT "quick_add_draft_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_add_draft" ADD CONSTRAINT "quick_add_draft_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;