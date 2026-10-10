CREATE TYPE "public"."password_token_purpose" AS ENUM('invite', 'reset');--> statement-breakpoint
CREATE TABLE "password_token" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"purpose" "password_token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_token" ADD CONSTRAINT "password_token_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_token" ADD CONSTRAINT "password_token_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_token_member_id_idx" ON "password_token" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_email_lower_uq" ON "member" USING btree (lower("email"));