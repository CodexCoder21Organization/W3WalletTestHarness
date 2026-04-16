/**
 * Self-test: starting and stopping a real W3WalletDaemon JAR.
 *
 * Skipped automatically when no daemon JAR is reachable — either via
 * W3WALLET_DAEMON_JAR or via the sibling-directory fallback. CI in this
 * repo's workflow is configured to set W3WALLET_DAEMON_JAR before running
 * the suite.
 */
import * as fs from 'fs';
import {
  isDaemonReachable,
  repoPaths,
  startDaemon,
  waitForDaemonDown,
  waitForHttpHealth,
} from '../src';

const paths = repoPaths();
const daemonAvailable = fs.existsSync(paths.daemonJar);
const describeIfDaemon = daemonAvailable ? describe : describe.skip;

if (!daemonAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[testDaemonLifecycle] skipping: no daemon JAR at ${paths.daemonJar}. ` +
      `Set W3WALLET_DAEMON_JAR or check out W3WalletDaemon as a sibling dir.`,
  );
}

describeIfDaemon('DaemonManager / startDaemon', () => {
  test('starts the daemon, /health responds 200, then stop()s cleanly', async () => {
    const daemon = await startDaemon({ port: 17380 });
    try {
      await waitForHttpHealth(`${daemon.httpUrl}/health`, 10_000);
      expect(daemon.dbPath).toMatch(/wallet\.db$/);
      expect(daemon.wsUrl).toBe('ws://127.0.0.1:17380/ws');
    } finally {
      await daemon.stop();
    }
    await waitForDaemonDown(`${daemon.httpUrl}/health`, 10_000);
    expect(await isDaemonReachable(`${daemon.httpUrl}/health`)).toBe(false);
  }, 120_000);
});
