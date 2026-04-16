/**
 * JVM-side demo server lifecycle.
 *
 * Spawns the W3WalletJvmServerSideCoinCollectorDemo fat JAR and (optionally)
 * fronts it with a TLS-terminating reverse proxy so the browser can hit
 * https://localhost:<port> directly.
 *
 * Consolidates demoServers.ts (PR1 startJvmDemo) and processes.ts (PR3
 * DemoServerProcess).
 */

import { ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { TestCerts } from './certs';
import {
  ManagedProcess,
  killProcess,
  spawnProcess,
} from './processes';
import { repoPaths, requirePath } from './paths';
import { waitForHttpHealth } from './daemon';

export interface JvmDemoHandle {
  /** Public URL exposed to the browser (HTTPS if cert provided, else HTTP). */
  url: string;
  /** The HTTPS port the browser hits (= backendPort if no proxy). */
  port: number;
  /** The raw HTTP port the JVM is listening on. */
  backendPort: number;
  /** The JVM child process. */
  process: ChildProcess;
  /** Underlying ManagedProcess for stdout/stderr access. */
  managed: ManagedProcess;
  stop(): Promise<void>;
}

export interface StartJvmDemoOptions {
  /**
   * Backend HTTP port the JVM listens on. If {@link httpsPort} is also set,
   * an HTTPS reverse proxy is launched that forwards to this port.
   */
  port: number;
  /**
   * Path of the JVM demo fat JAR. Defaults to {@link repoPaths().jvmDemoJar}.
   */
  jarPath?: string;
  /**
   * If set, the demo is fronted by an HTTPS reverse proxy on this port and
   * `url` returns `https://localhost:<httpsPort>`. Requires {@link cert}.
   */
  httpsPort?: number;
  /**
   * Cert + key for the optional HTTPS reverse proxy. Required when
   * {@link httpsPort} is set.
   */
  cert?: TestCerts;
  /** Optional --daemon-url argument forwarded to the JVM demo. */
  daemonUrl?: string;
  /** Wait this long for the JVM to report ready. Defaults to 60s. */
  startupTimeoutMs?: number;
  /** Forward JVM stdout/stderr to the parent. Defaults to false. */
  inheritOutput?: boolean;
  /** Extra env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the JVM demo if its JAR is missing. No-op when W3WALLET_JVM_DEMO_JAR
 * is set and points at an existing file.
 */
export function buildJvmDemoIfNeeded(): string {
  const paths = repoPaths();
  if (fs.existsSync(paths.jvmDemoJar)) return paths.jvmDemoJar;
  if (process.env.W3WALLET_JVM_DEMO_JAR) {
    throw new Error(
      `W3WALLET_JVM_DEMO_JAR=${process.env.W3WALLET_JVM_DEMO_JAR} but the file does not exist.`,
    );
  }
  requirePath(paths.jvmDemoProject, 'W3WalletJvmServerSideCoinCollectorDemo');
  // eslint-disable-next-line no-console
  console.log('[harness] Building JVM demo fatJar...');
  execSync('./gradlew fatJar --no-daemon', {
    cwd: paths.jvmDemoProject,
    stdio: 'inherit',
  });
  if (!fs.existsSync(paths.jvmDemoJar)) {
    throw new Error(
      `JVM demo JAR not produced at ${paths.jvmDemoJar}. ` +
        `Check './gradlew fatJar' output above for errors.`,
    );
  }
  return paths.jvmDemoJar;
}

export async function startJvmDemo(
  options: StartJvmDemoOptions,
): Promise<JvmDemoHandle> {
  const jar = options.jarPath ?? buildJvmDemoIfNeeded();
  const backendPort = options.port;

  const args = ['-jar', jar, '--port', String(backendPort)];
  if (options.daemonUrl) args.push('--daemon-url', options.daemonUrl);

  const managed = spawnProcess('java', args, {
    inheritOutput: options.inheritOutput ?? false,
    logPrefix: '[jvm-demo] ',
    env: { ...process.env, ...(options.env ?? {}) },
  });

  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
  await waitForHttpHealth(
    `http://127.0.0.1:${backendPort}/health`,
    startupTimeoutMs,
  ).catch((e) => {
    throw new Error(
      `JVM demo on port ${backendPort} did not respond on /health within ` +
        `${startupTimeoutMs}ms. ${(e as Error).message} ` +
        `Last stderr: ${managed.stderr().slice(-1024)}`,
    );
  });

  // No HTTPS proxy requested → return the HTTP backend directly.
  if (options.httpsPort === undefined) {
    return {
      url: `http://localhost:${backendPort}`,
      port: backendPort,
      backendPort,
      process: managed.process,
      managed,
      async stop() {
        await killProcess(managed.process);
      },
    };
  }

  if (!options.cert) {
    throw new Error(
      'startJvmDemo: httpsPort was set but no cert was provided. ' +
        'Pass `cert: generateLocalhostCerts(...)` to enable the TLS reverse proxy.',
    );
  }
  const httpsPort = options.httpsPort;
  const cert = options.cert;

  const proxy = https.createServer(
    {
      cert: fs.readFileSync(cert.serverCertPath),
      key: fs.readFileSync(cert.serverKeyPath),
    },
    (req, res) => {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (e) => {
        res.statusCode = 502;
        res.end(`Bad gateway: ${e.message}`);
      });
      req.pipe(proxyReq);
    },
  );
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(httpsPort, '0.0.0.0', () => resolve());
  });

  return {
    url: `https://localhost:${httpsPort}`,
    port: httpsPort,
    backendPort,
    process: managed.process,
    managed,
    async stop() {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await killProcess(managed.process);
    },
  };
}
