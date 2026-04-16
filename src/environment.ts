/**
 * Centralized parsing and validation of environment variables consumed by
 * the harness. Test runners typically populate these from a `run-e2e.sh`
 * script or a CI workflow step; the harness fails fast with a descriptive
 * error message when a required variable is missing.
 */

export interface E2EEnv {
  demoUrl?: string;
  daemonUrl?: string;
  daemonWebsocketUrl?: string;
  daemonSqlitePath?: string;
  extensionDistDir?: string;
}

/**
 * Read optional e2e environment variables. Use {@link requireE2EEnv} when
 * you want to fail fast on missing variables.
 */
export function readE2EEnv(): E2EEnv {
  return {
    demoUrl: process.env.DEMO_URL,
    daemonUrl: process.env.DAEMON_URL,
    daemonWebsocketUrl: process.env.DAEMON_WS_URL,
    daemonSqlitePath: process.env.DAEMON_SQLITE_PATH,
    extensionDistDir: process.env.EXTENSION_DIST_DIR,
  };
}

/**
 * Read e2e environment variables and throw if any of {@link required} are
 * absent. The error message lists every missing variable so misconfigured
 * runs surface the full problem rather than reporting one at a time.
 */
export function requireE2EEnv(
  required: (keyof E2EEnv)[],
): Required<Pick<E2EEnv, (typeof required)[number]>> {
  const env = readE2EEnv();
  const envVarNameByKey: Record<keyof E2EEnv, string> = {
    demoUrl: 'DEMO_URL',
    daemonUrl: 'DAEMON_URL',
    daemonWebsocketUrl: 'DAEMON_WS_URL',
    daemonSqlitePath: 'DAEMON_SQLITE_PATH',
    extensionDistDir: 'EXTENSION_DIST_DIR',
  };
  const missing = required
    .filter((k) => env[k] === undefined || env[k] === '')
    .map((k) => envVarNameByKey[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `These are typically populated by a run-e2e.sh wrapper or CI workflow ` +
        `that builds the daemon JAR, demo, and extension dist before invoking ` +
        `the test command.`,
    );
  }
  const out = {} as Record<string, string>;
  for (const k of required) {
    out[k] = env[k] as string;
  }
  return out as Required<Pick<E2EEnv, (typeof required)[number]>>;
}

/**
 * Parse a numeric env variable, returning a fallback if absent. Throws if
 * the variable is set but does not parse as an integer.
 */
export function envIntOr(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(
      `Environment variable ${name}=${JSON.stringify(v)} is not an integer.`,
    );
  }
  return n;
}
