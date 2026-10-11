import { loadConfig } from "../config.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const db = createPool(loadConfig().databaseUrl);
try {
  const applied = await migrate(db, console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied` : "database is up to date");
} finally {
  await db.end();
}
