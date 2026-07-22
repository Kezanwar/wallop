import { createDirectClient } from "@studia-nova/db";
import { writePing, readPings } from "@studia-nova/core";

async function main() {
  const db = createDirectClient();

  console.log("[worker] starting up...");

  await writePing(db, `worker started at ${new Date().toISOString()}`);
  const pings = await readPings(db);
  console.log(`[worker] ping table has ${pings.length} row(s):`);
  for (const p of pings) {
    console.log(`  - ${p.message}`);
  }

  console.log("[worker] ready. (idle — job processing comes later)");
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
