/**
 * Thin Node wrapper around `netlab-cli` for tests that need a full network
 * topology (NAT, relays, multi-host scenarios).
 *
 * The CLI is shelled out via `child_process.spawn` and produces real Docker
 * containers via the NetLab service. Configuration is via env vars so the
 * suite can run unchanged against either the shared `url://netlab/` service
 * (64.225.38.247) or a locally-running NetLabWorkerServer.
 *
 *   NETLAB_CLI_JAR       Absolute path to the NetLabCLI fatJar
 *                        (default: /srv/w3wallet-netlab-test/jars/netlab-cli-all.jar).
 *   NETLAB_SERVICE_URL   NetLab service URL (default: url://netlab/).
 *   NETLAB_JAR_DIR       Where W3Wallet JARs are staged on the NetLab server
 *                        (default: /srv/w3wallet-netlab-test/jars).
 *   NETLAB_WORK_DIR      Per-host work-dir root on the NetLab server
 *                        (default: /srv/w3wallet-netlab-test/work).
 *   NETLAB_SKIP          If "true", consumers should call {@link skipReason}
 *                        and bail out of any test that requires Docker.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const NETLAB_CLI_JAR =
  process.env.NETLAB_CLI_JAR ||
  '/srv/w3wallet-netlab-test/jars/netlab-cli-all.jar';
export const NETLAB_SERVICE_URL =
  process.env.NETLAB_SERVICE_URL || 'url://netlab/';
export const NETLAB_JAR_DIR =
  process.env.NETLAB_JAR_DIR || '/srv/w3wallet-netlab-test/jars';
export const NETLAB_WORK_DIR =
  process.env.NETLAB_WORK_DIR || '/srv/w3wallet-netlab-test/work';
export const NETLAB_SKIP = process.env.NETLAB_SKIP === 'true';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

export interface RunNetlabCliOptions {
  /** Per-call timeout in ms. Defaults to 180_000. */
  timeoutMs?: number;
  /** Pass `--json` to the CLI. */
  json?: boolean;
}

/**
 * Invoke `netlab-cli` with the given arguments. Always passes `--service-url`.
 * Returns exit code + captured output. Throws only on spawn-level errors.
 */
export function runNetlabCli(
  args: string[],
  options: RunNetlabCliOptions = {},
): Promise<CliResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const fullArgs: string[] = [
    '-jar',
    NETLAB_CLI_JAR,
    '--service-url',
    NETLAB_SERVICE_URL,
  ];
  if (options.json) fullArgs.push('--json');
  for (const a of args) fullArgs.push(a);

  return new Promise<CliResult>((resolve) => {
    const proc = spawn('java', fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const combined: string[] = [];

    proc.stdout.on('data', (b: Buffer) => {
      const s = b.toString('utf-8');
      stdout.push(s);
      combined.push(s);
    });
    proc.stderr.on('data', (b: Buffer) => {
      const s = b.toString('utf-8');
      stderr.push(s);
      combined.push(s);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        combined: combined.join(''),
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `spawn error: ${err.message}`,
        combined: `spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Apply a topology JSON file with up to 3 retries to absorb transient P2P
 * connection hiccups. Throws a descriptive Error on final failure.
 */
export async function applyTopology(
  topologyName: string,
  topologyFile: string,
): Promise<CliResult> {
  let last: CliResult | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await runNetlabCli(
      ['apply', topologyName, topologyFile],
      { timeoutMs: 240_000 },
    );
    last = result;
    if (result.exitCode === 0) return result;
    // eslint-disable-next-line no-console
    console.warn(
      `applyTopology attempt ${attempt}/3 failed (exit=${result.exitCode}). ` +
        `stderr=${result.stderr.trim()}`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `applyTopology failed after 3 attempts. ` +
      `topology=${topologyName} file=${topologyFile} ` +
      `lastExit=${last?.exitCode} ` +
      `stdout=${last?.stdout.trim() ?? ''} ` +
      `stderr=${last?.stderr.trim() ?? ''}`,
  );
}

/**
 * Delete a topology. Swallows errors because this is intended for `finally`
 * blocks; a leaked topology is logged so an operator can clean it up later.
 */
export async function deleteTopology(topologyName: string): Promise<void> {
  const result = await runNetlabCli(['delete', topologyName], {
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `deleteTopology(${topologyName}) exit=${result.exitCode}. ` +
        `stderr=${result.stderr.trim()}. Topology may be leaked — clean up via: ` +
        `netlab-cli --service-url ${NETLAB_SERVICE_URL} delete ${topologyName}`,
    );
  }
}

/** Fetch logs for a single host as a string via `netlab-cli logs --json`. */
export async function fetchLogs(
  topologyName: string,
  hostName: string,
): Promise<string> {
  const result = await runNetlabCli(['logs', topologyName, hostName], {
    json: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `netlab-cli logs ${topologyName} ${hostName} failed (exit=${result.exitCode}). ` +
        `stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
    );
  }
  // libp2p debug lines may precede the JSON object — skip to first '{'.
  const trimmed = result.stdout.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) {
    throw new Error(
      `netlab-cli logs returned no JSON object. raw output:\n${trimmed}`,
    );
  }
  const obj = JSON.parse(trimmed.substring(start));
  if (typeof obj.logs !== 'string') {
    throw new Error(
      `netlab-cli logs JSON missing 'logs' field. parsed=${JSON.stringify(obj)}`,
    );
  }
  return obj.logs;
}

/**
 * Return the absolute per-topology staging directory on the NetLab worker
 * host. Use the returned path as the volume-mount source in
 * {@link buildTopology} options: `"${stagingDir}/jars:/jars:ro"`. See
 * netlab-api `TopologyService.stagingDir()` for the contract.
 *
 * Creates the directory on the worker if it didn't already exist — safe to
 * call before uploading any files.
 */
export async function topologyStagingDir(topologyName: string): Promise<string> {
  const result = await runNetlabCli(['staging-dir', topologyName], {
    json: true,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `netlab-cli staging-dir ${topologyName} failed (exit=${result.exitCode}). ` +
        `stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
    );
  }
  const trimmed = result.stdout.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) {
    throw new Error(
      `netlab-cli staging-dir returned no JSON object. raw output:\n${trimmed}`,
    );
  }
  const obj = JSON.parse(trimmed.substring(start));
  if (typeof obj.stagingDir !== 'string') {
    throw new Error(
      `netlab-cli staging-dir JSON missing 'stagingDir' field. parsed=${JSON.stringify(obj)}`,
    );
  }
  return obj.stagingDir;
}

/**
 * Upload a local file into the topology's staging directory on the NetLab
 * worker host. The CLI streams the file across the wire in 1 MiB chunks so
 * large JARs do not buffer in memory.
 *
 * After this call returns, the uploaded file is accessible inside containers
 * that mount the topology's staging dir as a volume:
 *
 * ```ts
 * const dir = await topologyStagingDir(name);
 * await uploadFileToTopology(name, '/path/to/daemon-all.jar', 'jars/daemon-all.jar');
 * // In HostConfig.volumes: `"${dir}/jars:/jars:ro"` makes /jars/daemon-all.jar
 * // visible to the container.
 * ```
 */
export async function uploadFileToTopology(
  topologyName: string,
  localPath: string,
  destinationPath: string,
): Promise<void> {
  if (!fs.existsSync(localPath)) {
    throw new Error(
      `uploadFileToTopology: source file does not exist: ${localPath} ` +
        `(resolved to ${path.resolve(localPath)})`,
    );
  }
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) {
    throw new Error(
      `uploadFileToTopology: source must be a regular file, not a directory/symlink: ${localPath}`,
    );
  }
  // The CLI itself streams chunks — a wall-clock budget of 10 min per upload
  // is plenty for a ~100 MB JAR on a public-cloud link.
  const result = await runNetlabCli(
    ['upload-file', topologyName, localPath, destinationPath],
    { timeoutMs: 600_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `netlab-cli upload-file ${topologyName} ${localPath} ${destinationPath} ` +
        `failed (exit=${result.exitCode}). stdout=${result.stdout.trim()} ` +
        `stderr=${result.stderr.trim()}`,
    );
  }
}

/** Execute a command inside a host container and return the result. */
export async function execInHost(
  topologyName: string,
  hostName: string,
  command: string[],
  options: { timeoutMs?: number } = {},
): Promise<CliResult> {
  return runNetlabCli(['exec', topologyName, hostName, ...command], {
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

/**
 * Parse the W3WalletDaemon startup banner from its stdout logs. The daemon
 * prints `UrlProtocol service started at: url://w3wallet.daemon.{peerId}/`.
 * Throws a descriptive error (with the first 4 KiB of logs) if the banner
 * is missing.
 */
export function parseDaemonUrl(daemonLogs: string): string {
  const re =
    /UrlProtocol service started at:\s+(url:\/\/w3wallet\.daemon\.[^\s]+)/;
  const match = re.exec(daemonLogs);
  if (!match) {
    const snippet = daemonLogs.slice(0, 4096);
    throw new Error(
      `Could not find daemon URL banner in logs. Expected a line matching ` +
        `'UrlProtocol service started at: url://w3wallet.daemon.<peerId>/'. ` +
        `First 4 KiB of logs:\n${snippet}`,
    );
  }
  return match[1].endsWith('/') ? match[1] : match[1] + '/';
}

/**
 * Poll the daemon /health endpoint from inside a host container (via wget).
 * Throws on timeout with the last execInHost result for diagnosis.
 */
export async function waitForDaemonHealth(
  topologyName: string,
  hostName: string,
  daemonPort: number,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 2000;
  let lastErr: string | undefined;
  for (let i = 1; i <= attempts; i++) {
    const result = await execInHost(
      topologyName,
      hostName,
      [
        'sh',
        '-c',
        `wget -qO- http://127.0.0.1:${daemonPort}/health >/dev/null 2>&1 && echo OK || echo NO`,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode === 0 && result.stdout.includes('OK')) return;
    lastErr =
      `exit=${result.exitCode} stdout=${result.stdout.trim()} ` +
      `stderr=${result.stderr.trim()}`;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Daemon /health did not become ready after ${attempts} attempts ` +
      `(${(attempts * intervalMs) / 1000}s). Last result: ${lastErr}`,
  );
}

/**
 * Poll an HTTP URL from inside a host container. Used for the demo server
 * on `public-host`.
 */
export async function waitForNetlabHttpHealth(
  topologyName: string,
  hostName: string,
  url: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 2000;
  let lastErr: string | undefined;
  for (let i = 1; i <= attempts; i++) {
    const result = await execInHost(
      topologyName,
      hostName,
      ['sh', '-c', `wget -qO- ${url} >/dev/null 2>&1 && echo OK || echo NO`],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode === 0 && result.stdout.includes('OK')) return;
    lastErr =
      `exit=${result.exitCode} stdout=${result.stdout.trim()} ` +
      `stderr=${result.stderr.trim()}`;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${url} did not become ready after ${attempts} attempts. Last result: ${lastErr}`,
  );
}

/** Return a human-readable skip reason; consumers use this with describe.skip. */
export function skipReason(): string {
  return (
    'NETLAB_SKIP=true — skipping NetLab-backed test. ' +
    'Run with Docker and a reachable NetLab service to execute this test.'
  );
}

/** Produce a unique topology name well below NetLab's 63-char limit. */
export function uniqueTopologyName(scenario: string): string {
  const ts = Date.now();
  return `w3w-${scenario}-${ts}`;
}

export interface TopologyOverrides {
  /** Make the relay-host exit immediately (test_nat_relay_unavailable). */
  disableRelay?: boolean;
  /** Make the daemon-host exit immediately after a scripted message. */
  daemonExitAfterStart?: boolean;
  /**
   * Absolute path on the NetLab worker host where per-topology artifacts
   * have been uploaded. Typically obtained via {@link topologyStagingDir}.
   * When present, containers mount `${stagingDir}:/jars:ro` and
   * `${stagingDir}/work/<role>:/work`. When absent, buildTopology falls
   * back to `NETLAB_JAR_DIR` / `NETLAB_WORK_DIR` for back-compat with
   * the legacy `url://netlab/` deployment that pre-stages JARs on disk.
   */
  stagingDir?: string;
}

/**
 * Render the canonical W3Wallet NAT-traversal topology. Built
 * programmatically so tests can apply per-scenario variations (disabling
 * the relay, scripting an early daemon exit, …).
 *
 * `overrides.stagingDir` should be the absolute worker-host path returned
 * by {@link topologyStagingDir} — the suite then uploads JARs into it via
 * {@link uploadFileToTopology} and the containers mount `${stagingDir}`
 * as `/jars`. When omitted, falls back to the legacy `NETLAB_JAR_DIR` /
 * `NETLAB_WORK_DIR` host paths that presume a pre-staged jar location —
 * kept only for back-compat with the existing `url://netlab/` deployment.
 */
export function buildTopology(
  name: string,
  overrides: TopologyOverrides = {},
): object {
  const jarDir = overrides.stagingDir ?? NETLAB_JAR_DIR;
  const workDir = overrides.stagingDir
    ? `${overrides.stagingDir}/work`
    : NETLAB_WORK_DIR;

  const relayCommand = overrides.disableRelay
    ? ['sh', '-c', 'echo "relay disabled for test"; sleep 600']
    : [
        'sh',
        '-c',
        'set -e; cd /work && exec java -jar /jars/UrlRelayServer-all.jar ' +
          '--listen-port 4002 ' +
          '--peer-id-file /work/relay-peer-id.txt ' +
          '--multiaddress-file /work/relay-multiaddr.txt',
      ];

  const daemonCommand = overrides.daemonExitAfterStart
    ? [
        'sh',
        '-c',
        'set -e; ip route del default 2>/dev/null || true; ' +
          'ip route add default via 192.168.1.254; ' +
          'echo "daemon scripted exit"; sleep 5; exit 0',
      ]
    : [
        'sh',
        '-c',
        'set -e; ip route del default 2>/dev/null || true; ' +
          'ip route add default via 192.168.1.254; ' +
          'for i in $(seq 1 60); do ' +
          '[ -s /work/../relay/relay-multiaddr.txt ] && break; sleep 1; done; ' +
          'RELAY=$(cat /work/../relay/relay-multiaddr.txt); ' +
          'echo "Daemon using relay $RELAY"; ' +
          'exec java -jar /jars/W3WalletDaemon-1.0.0-SNAPSHOT-all.jar ' +
          '--port 7380 --db /work/wallet.db --bootstrap-peer "$RELAY"',
      ];

  return {
    name,
    description:
      'W3Wallet NAT-traversal test topology generated by the W3WalletTestHarness.',
    switches: {
      'public-switch': {
        subnet: '10.0.0.0/24',
        gateway: '10.0.0.1',
        internal: true,
      },
      'home-switch': {
        subnet: '192.168.1.0/24',
        gateway: '192.168.1.1',
        internal: true,
      },
    },
    gateways: {
      'nat-gateway': {
        internal_network: 'home-switch',
        internal_ip: '192.168.1.254',
        external_network: 'public-switch',
        external_ip: '10.0.0.254',
      },
    },
    hosts: {
      'relay-host': {
        image: 'eclipse-temurin:17-jre-jammy',
        networks: [{ network: 'public-switch', ip: '10.0.0.10' }],
        volumes: [
          `${jarDir}:/jars:ro`,
          `${workDir}/relay:/work`,
        ],
        environment: { ROLE: 'url_relay' },
        command: relayCommand,
      },
      'public-host': {
        image: 'eclipse-temurin:17-jre-jammy',
        networks: [{ network: 'public-switch', ip: '10.0.0.20' }],
        volumes: [
          `${jarDir}:/jars:ro`,
          `${workDir}/public:/work`,
          `${workDir}/relay:/work-relay:ro`,
        ],
        environment: { ROLE: 'demo_server' },
        command: [
          'sh',
          '-c',
          'set -e; for i in $(seq 1 60); do ' +
            '[ -s /work-relay/relay-multiaddr.txt ] && break; sleep 1; done; ' +
            'RELAY=$(cat /work-relay/relay-multiaddr.txt); ' +
            'echo "Demo server using relay $RELAY"; ' +
            'exec java -jar /jars/W3JvmServerSideWalletDemo-all.jar ' +
            '--port 8080 --bootstrap-peer "$RELAY"',
        ],
      },
      'daemon-host': {
        image: 'eclipse-temurin:17-jre-jammy',
        capabilities: ['NET_ADMIN'],
        networks: [{ network: 'home-switch', ip: '192.168.1.10' }],
        volumes: [
          `${jarDir}:/jars:ro`,
          `${workDir}/daemon:/work`,
          `${workDir}/relay:/work/../relay:ro`,
        ],
        environment: { ROLE: 'w3wallet_daemon' },
        command: daemonCommand,
      },
    },
  };
}

/**
 * Serialize a topology object to a temp JSON file in os.tmpdir(). Returns
 * the absolute path. Tests should clean up via {@link deleteTopologyTempFile}.
 */
export function writeTopologyTempFile(
  topology: object,
  scenario: string,
): string {
  const filePath = path.join(
    os.tmpdir(),
    `w3wallet-netlab-${scenario}-${Date.now()}.json`,
  );
  fs.writeFileSync(filePath, JSON.stringify(topology, null, 2), 'utf-8');
  return filePath;
}

/** Delete a temp topology file. Best-effort. */
export function deleteTopologyTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* best-effort */
  }
}
