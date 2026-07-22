import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

// Placeholder table purely to prove generate -> migrate -> query works.
// We replace this with the real schema (users, designs, ...) next session.
export const pingTable = pgTable("ping", {
  id: uuid("id").primaryKey().defaultRandom(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
