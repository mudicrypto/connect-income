import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard for a bug class found twice (milestone 2 latest tick, milestone 3
 * product assignment): `SELECT x::text ... ORDER BY x` sorts by the TEXT output
 * column, so "9" > "10". Qualify the column (t.x) or alias the cast differently.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

export function findTextOrderBy(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(/`[^`]*`|"SELECT[^"]*"/gs)) {
    const sql = m[0];
    if (!sql.includes("ORDER BY")) continue;
    const select = sql.split(/\bFROM\b/)[0] ?? "";
    // Output names produced by an unqualified or qualified cast without AS (name = column name),
    // or by an explicit "AS name" on a ::text cast.
    const outputs = new Set<string>([
      ...[...select.matchAll(/(?:\w+\.)?(\w+)::text(?!\s+AS)/g)].map((x) => x[1]!),
      ...[...select.matchAll(/::text\s+AS\s+"?(\w+)"?/g)].map((x) => x[1]!),
    ]);
    for (const ob of sql.matchAll(/ORDER BY ([^`)]*?)(?:\bLIMIT\b|\bFOR\b|\)|`|$)/gs)) {
      for (const term of ob[1]!.split(",")) {
        const col = term.trim().split(/\s+/)[0] ?? "";
        if (col && !col.includes(".") && outputs.has(col)) hits.push(`ORDER BY ${col} sorts a ::text output column`);
      }
    }
  }
  return hits;
}

describe("SQL lint", () => {
  it("detects the text-ordering bug class", () => {
    expect(findTextOrderBy("`SELECT id::text, x FROM t WHERE a = 1 ORDER BY id DESC LIMIT 1`")).toHaveLength(1);
    expect(findTextOrderBy("`SELECT t.seq::text FROM t ORDER BY seq`")).toHaveLength(1);
    expect(findTextOrderBy("`SELECT t.id::text FROM t ORDER BY t.id`")).toHaveLength(0);
    expect(findTextOrderBy("`SELECT id::text AS \"tid\" FROM t ORDER BY id`")).toHaveLength(0);
  });

  it("no source file orders by a text-cast output column", () => {
    const offenders = files(root).flatMap((f) => findTextOrderBy(readFileSync(f, "utf8")).map((h) => `${path.relative(root, f)}: ${h}`));
    expect(offenders).toEqual([]);
  });
});
