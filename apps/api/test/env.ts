import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://connect:connect_dev@localhost:5432/connect_income_test";

if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
  // Tests drop the schema; refuse to run against anything not clearly a test DB.
  throw new Error(`TEST_DATABASE_URL must point at a database whose name ends in _test (got ${TEST_DATABASE_URL})`);
}
