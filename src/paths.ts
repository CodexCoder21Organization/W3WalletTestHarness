/**
 * Cross-repo filesystem path discovery for the W3Wallet test ecosystem.
 *
 * The W3Wallet ecosystem consists of multiple sibling repositories:
 *   - W3WalletDaemon       (Kotlin/JVM daemon)
 *   - W3WalletExtension    (Chrome extension)
 *   - W3WalletJavascriptCoinCollectorDemo
 *   - W3WalletJvmServerSideCoinCollectorDemo
 *   - W3WalletDaemonLauncher
 *   - W3WalletInstaller
 *
 * Consumers of this harness need to locate each repo's build output. Resolution
 * order for every artifact:
 *
 *   1. Explicit env override (e.g. `W3WALLET_DAEMON_JAR`) — highest priority,
 *      used by CI to point at pre-built artifacts.
 *   2. A sibling-directory checkout under {@link reposRoot}, with a conventional
 *      `build/libs/<name>-all.jar` layout.
 *   3. {@link cloneAndBuildOnDemand} — clone via `gh repo clone` into a cache
 *      directory and build. Slowest, used as last resort.
 *
 * `reposRoot` itself can be overridden via `W3WALLET_REPOS_ROOT`; otherwise it
 * defaults to two directories above this file (so when the harness is installed
 * under `<consumer>/node_modules/w3wallet-test-harness`, it looks at the
 * consumer's own siblings).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

export interface RepoPaths {
  reposRoot: string;
  daemonProject: string;
  daemonJar: string;
  extensionProject: string;
  extensionDist: string;
  jsDemoDir: string;
  jvmDemoProject: string;
  jvmDemoJar: string;
  launcherProject: string;
  launcherJar: string;
  installerProject: string;
  installerJar: string;
  netlabCliJar: string;
}

/**
 * Resolve the directory that contains the W3Wallet sibling repositories.
 *
 * Honors `W3WALLET_REPOS_ROOT`. Otherwise climbs up from the harness install
 * location to find a directory that looks like a W3Wallet workspace
 * (contains a directory named `W3WalletDaemon` or `W3WalletExtension`); falls
 * back to two-levels-up if none is found.
 */
export function reposRoot(): string {
  const envOverride = process.env.W3WALLET_REPOS_ROOT;
  if (envOverride) return path.resolve(envOverride);

  // Walk upward from this file looking for a sibling W3Wallet repo.
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'W3WalletDaemon')) ||
      fs.existsSync(path.join(dir, 'W3WalletExtension'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: two levels above this file (typical sibling layout).
  return path.resolve(__dirname, '..', '..');
}

/**
 * Cache directory used by {@link cloneAndBuildOnDemand}. Honors
 * `W3WALLET_HARNESS_CACHE_DIR`; defaults to `<os.tmpdir()>/w3wallet-harness-cache`.
 */
export function cacheDir(): string {
  const override = process.env.W3WALLET_HARNESS_CACHE_DIR;
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), 'w3wallet-harness-cache');
}

/**
 * Compute all cross-repo paths. Env overrides take precedence over the
 * sibling-directory layout.
 */
export function repoPaths(): RepoPaths {
  const root = reposRoot();
  const daemonProject = path.resolve(root, 'W3WalletDaemon');
  const extensionProject = path.resolve(root, 'W3WalletExtension');
  const jsDemoDir = path.resolve(root, 'W3WalletJavascriptCoinCollectorDemo');
  const jvmDemoProject = path.resolve(
    root,
    'W3WalletJvmServerSideCoinCollectorDemo',
  );
  const launcherProject = path.resolve(root, 'W3WalletDaemonLauncher');
  const installerProject = path.resolve(root, 'W3WalletInstaller');

  return {
    reposRoot: root,
    daemonProject,
    daemonJar:
      process.env.W3WALLET_DAEMON_JAR ??
      path.resolve(
        daemonProject,
        'build/libs/W3WalletDaemon-1.0.0-SNAPSHOT-all.jar',
      ),
    extensionProject,
    extensionDist:
      process.env.W3WALLET_EXTENSION_DIR ??
      path.resolve(extensionProject, 'dist'),
    jsDemoDir: process.env.W3WALLET_JS_DEMO_DIR ?? jsDemoDir,
    jvmDemoProject,
    jvmDemoJar:
      process.env.W3WALLET_JVM_DEMO_JAR ??
      path.resolve(
        jvmDemoProject,
        'build/libs/W3WalletJvmServerSideCoinCollectorDemo-1.0.0-SNAPSHOT-all.jar',
      ),
    launcherProject,
    launcherJar: path.resolve(
      launcherProject,
      'build/libs/W3WalletDaemonLauncher-all.jar',
    ),
    installerProject,
    installerJar: path.resolve(
      installerProject,
      'build/libs/W3WalletInstaller-all.jar',
    ),
    netlabCliJar:
      process.env.NETLAB_CLI_JAR ??
      '/srv/w3wallet-netlab-test/jars/netlab-cli-all.jar',
  };
}

/** Assert a path exists or throw a descriptive error. */
export function requirePath(p: string, label: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(
      `Required ${label} not found at ${p}. ` +
        `Ensure the sibling repository is checked out and built. ` +
        `You can override the repo root via W3WALLET_REPOS_ROOT, or set ` +
        `the artifact-specific env var (W3WALLET_DAEMON_JAR, ` +
        `W3WALLET_EXTENSION_DIR, W3WALLET_JS_DEMO_DIR, W3WALLET_JVM_DEMO_JAR, ` +
        `NETLAB_CLI_JAR) to point at a pre-built artifact.`,
    );
  }
  return p;
}

/**
 * Clone a sibling repo into the harness cache via `gh repo clone` and run
 * a build command. Returns the absolute path of the cloned repo. Idempotent —
 * if the cache directory already exists, the clone is skipped.
 *
 * @param repoName e.g. `W3WalletDaemon`
 * @param org GitHub org, defaults to `CodexCoder21Organization`
 * @param buildCommand shell command to build inside the cloned repo. If
 *                     null/undefined, no build is attempted.
 */
export function cloneAndBuildOnDemand(
  repoName: string,
  org: string = 'CodexCoder21Organization',
  buildCommand?: string,
): string {
  const cache = cacheDir();
  fs.mkdirSync(cache, { recursive: true });
  const target = path.join(cache, repoName);

  if (!fs.existsSync(target)) {
    // eslint-disable-next-line no-console
    console.log(`[harness] cloning ${org}/${repoName} into ${target}`);
    execSync(`gh repo clone ${org}/${repoName} "${target}"`, {
      stdio: 'inherit',
    });
  }

  if (buildCommand) {
    // eslint-disable-next-line no-console
    console.log(`[harness] building ${repoName}: ${buildCommand}`);
    execSync(buildCommand, { cwd: target, stdio: 'inherit' });
  }
  return target;
}
