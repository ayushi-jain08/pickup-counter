export interface Config {
  port: number;
  databaseUrl: string;
  webhookSecret: string;
  /** How long a new order holds its stock. */
  holdSeconds: number;
  /** How often the background sweeper flips lapsed holds to `expired`. */
  sweepIntervalMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: positiveInt(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    webhookSecret: required(env, 'WEBHOOK_SECRET'),
    holdSeconds: positiveInt(env, 'HOLD_SECONDS', 120),
    sweepIntervalMs: positiveInt(env, 'SWEEP_INTERVAL_MS', 5000),
  };
}
