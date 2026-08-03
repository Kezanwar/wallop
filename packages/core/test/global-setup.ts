import { runMigrations } from "@wallop/db";

export async function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("Missing DATABASE_URL_TEST");
  await runMigrations(url);
}
