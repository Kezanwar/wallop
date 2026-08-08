ALTER TABLE "designs" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "allow_as_reference" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_guest";