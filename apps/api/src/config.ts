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
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: overrides.databaseUrl ?? required("DATABASE_URL"),
    port: overrides.port ?? Number(process.env.API_PORT ?? 4000),
    devMode: overrides.devMode ?? bool(process.env.DEV_MODE, false),
    cookieSecure: overrides.cookieSecure ?? bool(process.env.COOKIE_SECURE, false),
    sessionTtlHours: overrides.sessionTtlHours ?? 24 * 7,
    maturitySweepIntervalMs: overrides.maturitySweepIntervalMs ?? 30_000,
  };
}
