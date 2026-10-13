export interface TransitionArgs {
  pool: string;
  expected: string;
  key: string;
  approval: string;
  approver: string;
  dryRun: boolean;
}

const VALUE_FLAGS = new Set(["pool", "expected", "key", "approval", "approver"]);

/**
 * Strict argument parsing for the legacy-transition CLI (pre-token audit A2).
 * A DRY RUN IS THE DEFAULT: the transition executes only with an explicit
 * `--execute`. Unknown, repeated or malformed flags abort instead of being
 * silently ignored, so a typo can never turn a rehearsal into an execution.
 */
export function parseTransitionArgs(argv: string[]): TransitionArgs {
  const values = new Map<string, string>();
  let execute = false;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") execute = true;
    else if (a === "--dry-run") dry = true;
    else if (a.startsWith("--") && VALUE_FLAGS.has(a.slice(2))) {
      const name = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      if (values.has(name)) throw new Error(`--${name} given twice`);
      values.set(name, v);
      i++;
    } else throw new Error(`unknown argument ${a} (expected --pool --expected --key --approval --approver [--dry-run | --execute])`);
  }
  if (execute && dry) throw new Error("give either --dry-run or --execute, not both");
  const need = (k: string) => {
    const v = values.get(k);
    if (!v) throw new Error(`missing --${k}`);
    return v;
  };
  return { pool: need("pool"), expected: need("expected"), key: need("key"), approval: need("approval"), approver: need("approver"), dryRun: !execute };
}
