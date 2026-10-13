function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env.`);
  return value;
}

export interface Config {
  databaseUrl: string;
  port: number;
  devMode: boolean;
  cookieSecure: boolean;
  sessionTtlHours: number;
  maturitySweepIntervalMs: number;
  /** Seconds between automatic synthetic market ticks + engine runs; 0 disables. */
  simAutoTickSeconds: number;
  /**
   * Which proxies may set X-Forwarded-For (Fastify trustProxy). The API listens on 127.0.0.1
   * behind a proxy (Vite in dev), so by default only loopback proxies are trusted; without
   * this every request shares the proxy's IP and one client can exhaust everyone's rate limit.
   */
  trustProxy: string | false;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: overrides.databaseUrl ?? required("DATABASE_URL"),
    port: overrides.port ?? Number(process.env.API_PORT ?? 4000),
    devMode: overrides.devMode ?? bool(process.env.DEV_MODE, false),
    cookieSecure: overrides.cookieSecure ?? bool(process.env.COOKIE_SECURE, false),
    sessionTtlHours: overrides.sessionTtlHours ?? 24 * 7,
    maturitySweepIntervalMs: overrides.maturitySweepIntervalMs ?? 30_000,
    simAutoTickSeconds: overrides.simAutoTickSeconds ?? Math.max(0, Number(process.env.SIM_AUTOTICK_SECONDS ?? 0) || 0),
    trustProxy: overrides.trustProxy ?? (process.env.TRUST_PROXY === "false" ? false : process.env.TRUST_PROXY || "loopback"),
  };
}
