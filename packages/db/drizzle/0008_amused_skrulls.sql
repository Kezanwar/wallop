ALTER TABLE "designs" ADD COLUMN "request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "designs_owner_request_idx" ON "designs" USING btree ("owner_id","request_id");