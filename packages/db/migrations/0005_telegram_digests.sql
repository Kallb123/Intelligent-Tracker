CREATE TYPE "public"."digest_kind" AS ENUM('morning', 'week_ahead');--> statement-breakpoint
CREATE TABLE "telegram_digest" (
	"household_id" uuid NOT NULL,
	"kind" "digest_kind" NOT NULL,
	"local_date" date NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"telegram_chat_id" bigint,
	"telegram_message_id" integer,
	CONSTRAINT "telegram_digest_household_id_kind_local_date_pk" PRIMARY KEY("household_id","kind","local_date")
);
--> statement-breakpoint
ALTER TABLE "telegram_digest" ADD CONSTRAINT "telegram_digest_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;