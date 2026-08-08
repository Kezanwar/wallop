CREATE TABLE "design_reference_uploads" (
	"design_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "design_reference_uploads_design_id_upload_id_pk" PRIMARY KEY("design_id","upload_id")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime_type" text NOT NULL,
	"original_filename" text,
	"moderation_status" text DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "design_reference_uploads" ADD CONSTRAINT "design_reference_uploads_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_reference_uploads" ADD CONSTRAINT "design_reference_uploads_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_reference_uploads_upload_idx" ON "design_reference_uploads" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "uploads_owner_idx" ON "uploads" USING btree ("owner_id","created_at");