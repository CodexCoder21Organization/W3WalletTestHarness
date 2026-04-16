/**
 * Self-test: real daemon + WS client round-trip.
 *
 * Starts a real W3WalletDaemon, connects via DaemonWebSocketClient, and
 * verifies that listCapabilities() returns an array.
 *
 * Skipped when the daemon JAR is not available.
 */
import * as fs from 'fs';
import {
  DaemonWebSocketClient,
  groupCapabilitiesByCoin,
  repoPaths,
  startDaemon,
} from '../src';

const paths = repoPaths();
const daemonAvailable = fs.existsSync(paths.daemonJar);
const describeIfDaemon = daemonAvailable ? describe : describe.skip;

if (!daemonAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[testDaemonClient] skipping: no daemon JAR at ${paths.daemonJar}.`,
  );
}

describeIfDaemon('DaemonWebSocketClient', () => {
  test('listCapabilities returns an array on a fresh daemon', async () => {
    const daemon = await startDaemon({ port: 17381 });
    const client = new DaemonWebSocketClient({
      url: daemon.wsUrl,
      origin: 'https://localhost',
      rpcTimeoutMs: 15_000,
      connectTimeoutMs: 10_000,
    });
    try {
      await client.connect();
      const caps = await client.listCapabilities();
      expect(Array.isArray(caps)).toBe(true);
      // A fresh daemon has no coins, so the grouping is also empty.
      expect(groupCapabilitiesByCoin(caps).size).toBe(0);
    } finally {
      await client.close();
      await daemon.stop();
    }
  }, 120_000);
});
