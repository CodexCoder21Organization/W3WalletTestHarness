/**
 * Relay configuration helpers.
 *
 * The W3Wallet ecosystem uses a libp2p relay to bridge a daemon behind NAT
 * to outside consumers. Spinning up a relay in a TypeScript test is brittle,
 * so by default we point tests at the public ambient relay running at
 * 198.199.106.165:4002 — the same relay the production daemon's bootstrap
 * list contains.
 *
 * Tests that need a hermetic relay can launch one themselves (e.g. via the
 * NetLab harness) and point the harness at it via env override.
 */

export interface RelayConfig {
  host: string;
  port: number;
  /** /ip4/<host>/tcp/<port> multiaddr suitable for jvm-libp2p TCP transport. */
  multiaddr: string;
}

export const DEFAULT_PUBLIC_RELAY_HOST = '198.199.106.165';
export const DEFAULT_PUBLIC_RELAY_PORT = 4002;

/**
 * Resolve the relay configuration from env vars, falling back to the
 * shared public relay. Recognized env vars:
 *   - W3WALLET_RELAY_HOST
 *   - W3WALLET_RELAY_PORT
 *   - W3WALLET_RELAY_MULTIADDR
 */
export function usePublicRelay(): RelayConfig {
  const host = process.env.W3WALLET_RELAY_HOST ?? DEFAULT_PUBLIC_RELAY_HOST;
  const port = Number(
    process.env.W3WALLET_RELAY_PORT ?? DEFAULT_PUBLIC_RELAY_PORT,
  );
  const multiaddr =
    process.env.W3WALLET_RELAY_MULTIADDR ?? `/ip4/${host}/tcp/${port}`;
  return { host, port, multiaddr };
}

/** Backwards-compatible alias used by older test code. */
export function resolveRelayConfig(): RelayConfig {
  return usePublicRelay();
}

/**
 * Placeholder for in-process relay startup. Currently throws because
 * spinning up a real libp2p relay requires Java and a built UrlRelayServer
 * JAR — consumers that need this should use the NetLab harness instead and
 * point the daemon at the relay multiaddr it produces.
 */
export async function startLocalRelay(): Promise<RelayConfig> {
  throw new Error(
    'startLocalRelay() is not yet implemented in this harness. ' +
      'Use usePublicRelay() to point at the public relay, or use the netlab ' +
      'harness (see netlab.ts) to launch a UrlRelayServer JAR inside a ' +
      'NetLab topology.',
  );
}
