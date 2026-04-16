/**
 * W3WalletDaemon lifecycle manager.
 *
 * Spawns a real W3WalletDaemon JAR for each test. Consolidates the daemon
 * harnesses that previously lived in:
 *   - W3WalletTests/e2e-playwright/tests/harness/daemon.ts
 *   - W3WalletJavascriptCoinCollectorDemo/tests-e2e/fixtures/daemon.ts
 *   - W3WalletJvmServerSideCoinCollectorDemo/e2e-browser/fixtures/processes.ts
 *
 * Tests deliberately interact with a real daemon — there are no mocks. State
 * isolation is achieved by giving each daemon a fresh SQLite database and
 * (optionally) a fresh peers directory.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  ManagedProcess,
  killProcess,
  pollUntil,
  spawnProcess,
} from './processes';
import { repoPaths, requirePath } from './paths';

const DEFAULT_PORT = 7380;

export interface DaemonHandle {
  /** The underlying ManagedProcess. */
  managed: ManagedProcess;
  /** ws://127.0.0.1:<port>/ws */
  wsUrl: string;
  /** http://127.0.0.1:<port> */
  httpUrl: string;
  /** Absolute path of the SQLite database the daemon was launched with. */
  dbPath: string;
  /** Absolute path of the peers directory the daemon was launched with. */
  peersDir: string;
  /** Port the daemon is listening on. */
  port: number;
  /** url://w3wallet.daemon.<peerId>/ once parsed from logs (UrlProtocol). */
  daemonUrl(): string | null;
  /** Stop the daemon and wait for it to exit. */
  stop(): Promise<void>;
  /**
   * Wipe the SQLite database. Must be called AFTER stop() and BEFORE the
   * next start() — sqlite-jdbc holds the file open while the daemon runs.
   */
  wipeDatabase(): void;
}

export interface StartDaemonOptions {
  /** Port to bind to. Defaults to 7380. */
  port?: number;
  /** Directory for db + peers + work files. Defaults to a fresh tmp dir. */
  workDir?: string;
  /** Explicit JAR path. Defaults to {@link repoPaths().daemonJar}. */
  jarPath?: string;
  /** Forward daemon stdout/stderr to the parent. Defaults to false. */
  inheritOutput?: boolean;
  /** Extra env for the JVM. */
  env?: NodeJS.ProcessEnv;
  /** Wait this long for readiness. Defaults to 60s. */
  startupTimeoutMs?: number;
  /** Pass `--enable-url-protocol`. Defaults to false. */
  enableUrlProtocol?: boolean;
  /** Pass `--bootstrap-peer <multiaddr>` to the daemon. */
  bootstrapPeer?: string;
  /**
   * Wipe the SQLite database before starting. Defaults to true so each
   * start() begins from empty state.
   */
  wipeDatabaseOnStart?: boolean;
}

/**
 * Class wrapping the daemon lifecycle. Most consumers will prefer the
 * functional {@link startDaemon} entry point.
 */
export class DaemonManager {
  private handle: DaemonHandle | null = null;

  async start(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
    if (this.handle) {
      throw new Error(
        'DaemonManager.start() called while a daemon is already running. ' +
          'Call stop() first.',
      );
    }
    this.handle = await startDaemon(options);
    return this.handle;
  }

  async stop(): Promise<void> {
    if (!this.handle) return;
    const h = this.handle;
    this.handle = null;
    await h.stop();
  }

  current(): DaemonHandle | null {
    return this.handle;
  }
}

/**
 * Build the daemon JAR if it's not already present at {@link repoPaths().daemonJar}.
 * Honors the W3WALLET_DAEMON_JAR override (if set, no build is attempted).
 */
export function buildDaemonIfNeeded(): string {
  const paths = repoPaths();
  if (fs.existsSync(paths.daemonJar)) return paths.daemonJar;
  if (process.env.W3WALLET_DAEMON_JAR) {
    throw new Error(
      `W3WALLET_DAEMON_JAR=${process.env.W3WALLET_DAEMON_JAR} but the file does not exist. ` +
        `Either remove the env override or build the JAR first.`,
    );
  }
  requirePath(paths.daemonProject, 'W3WalletDaemon project directory');
  // eslint-disable-next-line no-console
  console.log('[harness] Building W3WalletDaemon fatJar...');
  execSync('./gradlew fatJar --no-daemon', {
    cwd: paths.daemonProject,
    stdio: 'inherit',
  });
  if (!fs.existsSync(paths.daemonJar)) {
    throw new Error(
      `Daemon JAR was not produced at ${paths.daemonJar} after './gradlew fatJar'. ` +
        `Check the gradle build output above for compilation errors.`,
    );
  }
  return paths.daemonJar;
}

/**
 * Start the daemon as a child process and wait until it reports ready.
 * Returns a {@link DaemonHandle} with stop/wipeDatabase helpers.
 */
export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const jar = options.jarPath ?? buildDaemonIfNeeded();
  const port = options.port ?? DEFAULT_PORT;
  const workDir =
    options.workDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'w3wallet-daemon-'));
  fs.mkdirSync(workDir, { recursive: true });

  const dbPath = path.join(workDir, 'wallet.db');
  const peersDir = path.join(workDir, 'peers');
  fs.mkdirSync(peersDir, { recursive: true });

  if (options.wipeDatabaseOnStart !== false) {
    wipeSqliteFiles(dbPath);
  }

  const args = [
    '-jar',
    jar,
    '--port',
    String(port),
    '--db',
    dbPath,
    '--peers-directory',
    peersDir,
  ];
  if (options.enableUrlProtocol) args.push('--enable-url-protocol');
  if (options.bootstrapPeer) {
    args.push('--bootstrap-peer', options.bootstrapPeer);
  }

  const managed = spawnProcess('java', args, {
    env: { ...process.env, ...(options.env ?? {}) },
    inheritOutput: options.inheritOutput ?? false,
    logPrefix: '[daemon] ',
    cwd: workDir,
  });

  let parsedDaemonUrl: string | null = null;
  managed.process.stdout?.on('data', (b: Buffer) => {
    const m = /(url:\/\/w3wallet\.daemon\.[A-Za-z0-9]+\/?)/.exec(b.toString());
    if (m && !parsedDaemonUrl) {
      parsedDaemonUrl = m[1].endsWith('/') ? m[1] : m[1] + '/';
    }
  });

  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
  await waitForDaemonReady(managed, port, startupTimeoutMs);

  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const httpUrl = `http://127.0.0.1:${port}`;

  const handle: DaemonHandle = {
    managed,
    wsUrl,
    httpUrl,
    dbPath,
    peersDir,
    port,
    daemonUrl: () => parsedDaemonUrl,
    async stop() {
      await killProcess(managed.process);
    },
    wipeDatabase() {
      wipeSqliteFiles(dbPath);
    },
  };
  return handle;
}

/**
 * Wait until either the daemon prints its WS-ready banner OR /health
 * responds 200, whichever comes first. Either signal indicates the daemon
 * is accepting traffic.
 */
async function waitForDaemonReady(
  managed: ManagedProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  // Race two signals: a stdout banner OR HTTP /health 200. Either is enough.
  const bannerPromise = waitForReadyBanner(managed, timeoutMs);
  const healthPromise = waitForHttpHealth(
    `http://127.0.0.1:${port}/health`,
    timeoutMs,
  );
  await Promise.race([bannerPromise, healthPromise]).catch(async (firstErr) => {
    // If one signal failed, give the other a moment in case it's slower.
    try {
      await Promise.any([bannerPromise, healthPromise]);
    } catch {
      throw new Error(
        `Daemon failed to become ready on port ${port} within ${timeoutMs}ms. ` +
          `Reason: ${(firstErr as Error).message}. ` +
          `Last stdout: ${managed.stdout().slice(-1024)} ` +
          `Last stderr: ${managed.stderr().slice(-1024)}`,
      );
    }
  });
}

function waitForReadyBanner(
  managed: ManagedProcess,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `Daemon did not print a 'started on ws://' banner within ${timeoutMs}ms. ` +
            `Last stdout: ${managed.stdout().slice(-1024)}`,
        ),
      );
    }, timeoutMs);

    const check = () => {
      if (done) return;
      if (
        managed.stdout().includes('started on ws://') ||
        managed.stdout().includes('UrlProtocol service started')
      ) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    };
    managed.process.stdout?.on('data', check);
    managed.process.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Daemon exited with code ${code} before reporting ready. ` +
            `Last stderr: ${managed.stderr().slice(-1024)}`,
        ),
      );
    });
    check();
  });
}

/**
 * Poll an HTTP URL until it returns a 200 response, or throw a descriptive
 * timeout error. Used for both the daemon /health endpoint and any other
 * server fronted by the harness.
 */
export async function waitForHttpHealth(
  url: string,
  timeoutMs: number = 30_000,
): Promise<void> {
  let lastResponse = '';
  await pollUntil(
    () =>
      new Promise<boolean>((resolve) => {
        const req = http.get(url, (res) => {
          res.resume();
          lastResponse = `HTTP ${res.statusCode}`;
          resolve(res.statusCode === 200);
        });
        req.on('error', (e) => {
          lastResponse = e.message;
          resolve(false);
        });
        req.setTimeout(2000, () => {
          req.destroy();
          lastResponse = 'request timeout (2s)';
          resolve(false);
        });
      }),
    {
      timeoutMs,
      intervalMs: 500,
      describeFailure: () =>
        `Daemon did not become healthy at ${url} after ${timeoutMs}ms. ` +
        `Last response: ${lastResponse || 'n/a'}.`,
    },
  );
}

/** Returns true if the URL responds with any 2xx-4xx status; used to test
 * that the daemon process is gone after stop(). */
export async function isDaemonReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Wait until {@link isDaemonReachable} returns false, or throw on timeout. */
export async function waitForDaemonDown(
  url: string,
  timeoutMs: number = 10_000,
): Promise<void> {
  await pollUntil(async () => !(await isDaemonReachable(url)), {
    timeoutMs,
    intervalMs: 200,
    describeFailure: () =>
      `Daemon at ${url} was still reachable after ${timeoutMs}ms.`,
  });
}

/** Delete a SQLite file plus its -shm/-wal/-journal sidecars. */
export function wipeSqliteFiles(dbPath: string): void {
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
