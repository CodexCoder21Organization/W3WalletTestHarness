# W3WalletTestHarness

A shared TypeScript test harness for the W3Wallet ecosystem's e2e suites.
Consolidates the helpers that previously lived inside individual repo
`tests/` directories so that every consumer's tests can be fully
self-contained — no shared files inside `tests/` anymore.

## What's in here

This harness provides:

- **Real W3WalletDaemon lifecycle** — spawn the daemon JAR, wait for `/health`,
  stop cleanly, wipe SQLite between tests.
- **W3WalletExtension build** — build the unpacked Chrome extension once,
  reuse the dist across tests.
- **Chromium launcher** — persistent Playwright context with the extension
  loaded, plus a SW-origin resolver.
- **Self-signed certs** — `node-forge`-based CA + server cert with
  configurable SAN list, deterministically cached on disk.
- **Demo servers** — HTTPS static-file server for the JS coin-collector demo
  and a JAR launcher (with optional TLS reverse proxy) for the JVM-side demo.
- **Daemon WebSocket client** — direct JSON-RPC client for cross-checking
  the daemon's state from outside the browser.
- **Coin-demo Playwright drivers** — `mintCoinAndWait`, `getCoinValue`, etc,
  reusable across both coin-collector demos.
- **NetLab wrapper** — thin Node wrapper around `netlab-cli` for the
  NAT-traversal test suite.
- **Relay config** — defaults to the public ambient relay; env-overridable.
- **Test-only clock** — direct SQLite writes to expire permissions without
  waiting wall-clock time.

NO mocks. Every helper drives real processes and files. Polls instead of
sleeps; every timeout error explains what was expected and what the last
observed value was.

## Install

In a consumer repo's `package.json`:

```json
{
  "devDependencies": {
    "w3wallet-test-harness": "github:CodexCoder21Organization/W3WalletTestHarness"
  }
}
```

then `npm install`. The harness's `prepare` script runs `tsc` automatically
when installed from a git URL, so the compiled `dist/` is available
immediately — no extra build step in the consumer repo.

For a specific commit or branch:

```json
"w3wallet-test-harness": "github:CodexCoder21Organization/W3WalletTestHarness#main"
```

## Minimal usage

```ts
import {
  buildExtension,
  generateLocalhostCerts,
  launchChromiumWithExtension,
  startDaemon,
  startJsDemo,
  waitForW3Wallet,
} from 'w3wallet-test-harness';

const certs = generateLocalhostCerts({ outputDir: '/tmp/w3w-certs' });
const daemon = await startDaemon();
const demo = await startJsDemo({ certs, port: 18443 });
const extDir = buildExtension();
const browser = await launchChromiumWithExtension({ extensionDir: extDir });

const page = await browser.context.newPage();
await page.goto(demo.url);
await waitForW3Wallet(page);
expect(await page.title()).toContain('Coin Collector');

await browser.close();
await demo.stop();
await daemon.stop();
```

## Module reference

### `paths` — cross-repo path discovery
`reposRoot()`, `repoPaths()`, `requirePath(p, label)`,
`cloneAndBuildOnDemand(repoName, org?, buildCommand?)`,
`cacheDir()`. Honors env overrides for every artifact (see below).

### `environment` — env-var validation
`readE2EEnv()`, `requireE2EEnv([...])`, `envIntOr(name, fallback)`. Fails fast
with a descriptive message listing every missing variable.

### `certs` — TLS cert generation
`generateLocalhostCerts({outputDir, hostnames?, force?})`,
`getCertSubjectAltNames(pem)`. Result is cached on disk and keyed by SAN set.

### `processes` — generic process management
`spawnProcess(cmd, args, opts)`, `killProcess(child, killTimeoutMs?)`,
`pollUntil(predicate, {timeoutMs, intervalMs?, describeFailure})`.

### `daemon` — W3WalletDaemon lifecycle
`DaemonManager` class, `startDaemon(opts?)`, `buildDaemonIfNeeded()`,
`waitForHttpHealth(url, timeoutMs?)`, `waitForDaemonDown(url, timeoutMs?)`,
`isDaemonReachable(url)`, `wipeSqliteFiles(dbPath)`. Builds the daemon JAR
on demand if not present.

### `daemonClient` — direct daemon WebSocket RPC
`DaemonWebSocketClient`, `groupCapabilitiesByCoin(caps)`. Speaks the
JSON-RPC envelope (`{id, method, params, origin}`) by default; `sendRaw()`
for legacy `type`-tagged envelopes.

### `extension` — extension build helper
`buildExtension({sourceDir?, distDir?, force?})`. Idempotent: skips the
build when `dist/manifest.json` already exists.

### `chromium` — extension-loaded browser launcher
`launchChromiumWithExtension({extensionDir, userDataDir?, extraArgs?, env?, viewport?})`,
`launchChromiumWithoutExtension({userDataDir?})`, `cleanupProfileDir(dir)`.
Always launches headed because Chrome refuses to load extensions in
headless mode — CI must use Xvfb.

### `demoJs` — JS coin-collector static server
`startJsDemo({certs, port, htmlDir?, host?})`,
`startStaticHtmlServer(certs, port, html)`. HTTPS via Node's built-in `https`.

### `demoJvm` — JVM coin-collector launcher
`startJvmDemo({port, jarPath?, httpsPort?, cert?, daemonUrl?, ...})`,
`buildJvmDemoIfNeeded()`. Optional TLS reverse proxy fronting the HTTP
backend.

### `relay` — relay config
`usePublicRelay()`, `resolveRelayConfig()`, `startLocalRelay()` (throws —
use NetLab instead). Defaults to the public ambient relay at
`198.199.106.165:4002`.

### `clock` — test-only permission expiry
`listPermissions(dbPath)`, `setPermissionExpiry(dbPath, id, expiresAtMs)`,
`expireAllPermissionsFor(dbPath, grantedToDomain)`.

### `coinHelpers` — Playwright drivers for the coin demos
`mintCoinAndWait(page)`, `listCoinCards(page)`, `getCoinValue(page, id)`,
`readCoinCount(page)`, `readCapabilityCount(page)`, `readTotalValueCents(page)`,
`waitForW3Wallet(page, timeoutMs?)`, `waitForConnectedStatus(page, timeoutMs?)`.

### `netlab` — `netlab-cli` wrapper for the NAT-traversal suite
`runNetlabCli(args, opts?)`, `applyTopology(name, file)`,
`deleteTopology(name)`, `fetchLogs(name, host)`, `execInHost(...)`,
`parseDaemonUrl(logs)`, `waitForDaemonHealth(...)`,
`waitForNetlabHttpHealth(...)`, `skipReason()`, `uniqueTopologyName(scenario)`,
`buildTopology(name, overrides?)`, `writeTopologyTempFile(topology, scenario)`,
`deleteTopologyTempFile(filePath)`.

## Environment variables

| Variable                       | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `W3WALLET_REPOS_ROOT`          | Override the directory containing sibling W3Wallet repos.                  |
| `W3WALLET_DAEMON_JAR`          | Path to the pre-built W3WalletDaemon fat JAR.                              |
| `W3WALLET_EXTENSION_DIR`       | Path to a pre-built unpacked extension (with `manifest.json`).             |
| `W3WALLET_JS_DEMO_DIR`         | Path to the JS demo's HTML root (default: sibling demo dir).               |
| `W3WALLET_JVM_DEMO_JAR`        | Path to the pre-built JVM demo fat JAR.                                    |
| `W3WALLET_HARNESS_CACHE_DIR`   | Cache root for `cloneAndBuildOnDemand`. Defaults to a tmpdir.              |
| `W3WALLET_RELAY_HOST`          | Override relay host (default: `198.199.106.165`).                          |
| `W3WALLET_RELAY_PORT`          | Override relay port (default: `4002`).                                     |
| `W3WALLET_RELAY_MULTIADDR`     | Override the full multiaddr.                                               |
| `NETLAB_CLI_JAR`               | Path to the NetLabCLI fat JAR.                                             |
| `NETLAB_SERVICE_URL`           | NetLab service URL (default: `url://netlab/`).                             |
| `NETLAB_JAR_DIR`               | NetLab server-side directory hosting W3Wallet JARs.                        |
| `NETLAB_WORK_DIR`              | NetLab server-side per-host work-dir root.                                 |
| `NETLAB_SKIP`                  | If `true`, NetLab tests are expected to skip themselves.                   |
| `DEMO_URL` / `DAEMON_URL` / `DAEMON_WS_URL` / `DAEMON_SQLITE_PATH` / `EXTENSION_DIST_DIR` | Consumed by `requireE2EEnv()` for runs orchestrated by `run-e2e.sh`. |

## Building

```sh
npm ci
npm run build
```

Output: `dist/` containing CJS JavaScript and `.d.ts` type definitions.

## Self-tests

```sh
npm test
```

Runs Jest. Cert tests always run. Daemon / extension / Chromium tests
auto-skip with a console warning when the corresponding artifact (JAR,
extension source, `$DISPLAY`) is unavailable. The CI workflow in
`.github/workflows/ci.yml` runs the full set under `xvfb-run`.
