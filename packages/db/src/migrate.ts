import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

export async function runMigrations(connectionString: string) {
  const pool = new Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error("Missing DATABASE_URL_DIRECT");
  console.log("Running migrations...");
  runMigrations(url)
    .then(() => console.log("Migrations complete."))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
