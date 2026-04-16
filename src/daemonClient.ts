/**
 * Direct WebSocket RPC client for the W3WalletDaemon.
 *
 * Consolidates two prior implementations:
 *   - W3WalletJavascriptCoinCollectorDemo (used `type`-tagged envelopes)
 *   - W3WalletJvmServerSideCoinCollectorDemo (used JSON-RPC `method`/`params`
 *     envelopes)
 *
 * The daemon supports both envelope styles. This client defaults to the
 * JSON-RPC style ({id, method, params, origin}) which is more recent, but
 * exposes a low-level {@link sendRaw} hook for tests that want to assert on
 * legacy `type`-tagged messages.
 *
 * No mocks: tests that use this class must point it at a running daemon
 * started by {@link DaemonManager}.
 */

import WebSocket from 'ws';

export interface DaemonCapability {
  id: string;
  name?: string;
  publicPart?: {
    type?: string;
    customType?: string;
    metadata?: Record<string, string>;
  };
  /** Other fields the daemon may attach. */
  [key: string]: unknown;
}

export interface DaemonProfile {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface DaemonWebSocketClientOptions {
  /** Full ws:// or wss:// URL of the daemon WebSocket endpoint. */
  url: string;
  /** Origin header sent on the WS handshake. Required by daemon ACL. */
  origin: string;
  /**
   * Set false (default) for self-signed certs (wss://localhost). Set true
   * for production endpoints.
   */
  rejectUnauthorized?: boolean;
  /** Per-call RPC timeout. Defaults to 30s. */
  rpcTimeoutMs?: number;
  /** Connection timeout. Defaults to 15s. */
  connectTimeoutMs?: number;
}

export class DaemonWebSocketClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly opts: Required<DaemonWebSocketClientOptions>;

  constructor(options: DaemonWebSocketClientOptions) {
    this.opts = {
      rejectUnauthorized: false,
      rpcTimeoutMs: 30_000,
      connectTimeoutMs: 15_000,
      ...options,
    };
  }

  /** Open the WebSocket and resolve once the handshake completes. */
  async connect(): Promise<void> {
    if (this.ws) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, {
        headers: { Origin: this.opts.origin },
        rejectUnauthorized: this.opts.rejectUnauthorized,
      });
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `DaemonWebSocketClient timed out after ${this.opts.connectTimeoutMs}ms ` +
              `connecting to ${this.opts.url} (Origin: ${this.opts.origin}). ` +
              `Is the daemon running and is the Origin allowed?`,
          ),
        );
      }, this.opts.connectTimeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('error', (err) => {
        clearTimeout(timer);
        for (const { reject: rej } of this.pending.values()) rej(err);
        this.pending.clear();
        reject(err);
      });
      ws.on('close', () => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('daemon websocket closed'));
        }
        this.pending.clear();
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number | string;
      result?: unknown;
      error?: { message?: string } | string;
      [k: string]: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // non-JSON heartbeat — ignore
    }
    const idValue = msg.id;
    const numericId =
      typeof idValue === 'number'
        ? idValue
        : typeof idValue === 'string'
          ? Number.parseInt(idValue, 10)
          : NaN;
    if (Number.isNaN(numericId)) return;
    const waiter = this.pending.get(numericId);
    if (!waiter) return;
    this.pending.delete(numericId);
    if (msg.error) {
      const errMsg =
        typeof msg.error === 'string'
          ? msg.error
          : (msg.error.message ?? JSON.stringify(msg.error));
      waiter.reject(new Error(`Daemon RPC error: ${errMsg}`));
      return;
    }
    waiter.resolve(msg.result !== undefined ? msg.result : msg);
  }

  /**
   * Invoke an RPC method via JSON-RPC envelope. Returns the `result` field
   * of the response. For older daemon protocols that respond without a
   * `result` field, the entire response object is returned.
   */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    if (!this.ws) throw new Error('DaemonWebSocketClient not connected');
    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      origin: this.opts.origin,
    });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              `Daemon RPC '${method}' timed out after ${this.opts.rpcTimeoutMs}ms. ` +
                `Params: ${JSON.stringify(params)}`,
            ),
          );
        }
      }, this.opts.rpcTimeoutMs);
    });
  }

  /**
   * Send a raw JSON-serializable object over the WebSocket without expecting
   * a reply. Used for legacy `type`-tagged envelopes.
   */
  async sendRaw(payload: object): Promise<void> {
    await this.connect();
    if (!this.ws) throw new Error('DaemonWebSocketClient not connected');
    await new Promise<void>((resolve, reject) => {
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Close the WebSocket and reject any in-flight RPCs. */
  async close(): Promise<void> {
    if (!this.ws) return;
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      await new Promise<void>((resolve) => {
        this.ws!.once('close', () => resolve());
        try {
          this.ws!.close();
        } catch {
          resolve();
        }
      });
    }
    this.ws = null;
  }

  // ---- High-level convenience methods --------------------------------------

  async listCapabilities(): Promise<DaemonCapability[]> {
    const result = await this.call<unknown>('listCapabilities', {});
    return normalizeCapabilities(result);
  }

  async createCapability(
    params: Record<string, unknown>,
  ): Promise<DaemonCapability> {
    const result = await this.call<{ capability?: DaemonCapability }>(
      'createCapability',
      params,
    );
    if (result && typeof result === 'object' && 'capability' in result) {
      return result.capability as DaemonCapability;
    }
    return result as unknown as DaemonCapability;
  }

  async updateCapability(
    capabilityId: string,
    updates: Record<string, unknown>,
  ): Promise<DaemonCapability> {
    return this.call<DaemonCapability>('updateCapability', {
      capabilityId,
      ...updates,
    });
  }

  async deleteCapability(capabilityId: string): Promise<void> {
    await this.call<unknown>('deleteCapability', { capabilityId });
  }

  async createProfile(
    params: Record<string, unknown> = {},
  ): Promise<DaemonProfile> {
    const result = await this.call<{ profile?: DaemonProfile }>(
      'createProfile',
      params,
    );
    if (result && typeof result === 'object' && 'profile' in result) {
      return result.profile as DaemonProfile;
    }
    return result as unknown as DaemonProfile;
  }
}

function normalizeCapabilities(raw: unknown): DaemonCapability[] {
  if (Array.isArray(raw)) return raw as DaemonCapability[];
  if (raw && typeof raw === 'object' && 'capabilities' in raw) {
    const list = (raw as { capabilities?: unknown }).capabilities;
    if (Array.isArray(list)) return list as DaemonCapability[];
  }
  return [];
}

/**
 * Group capabilities by `publicPart.metadata.coinId`. Capabilities without a
 * coinId are dropped. Each coin in the JVM-side demo is represented by 4
 * capabilities (visibility, setValue, setColor, discard).
 */
export function groupCapabilitiesByCoin(
  caps: DaemonCapability[],
): Map<string, DaemonCapability[]> {
  const byCoin = new Map<string, DaemonCapability[]>();
  for (const cap of caps) {
    const coinId = cap.publicPart?.metadata?.coinId;
    if (!coinId) continue;
    const list = byCoin.get(coinId) ?? [];
    list.push(cap);
    byCoin.set(coinId, list);
  }
  return byCoin;
}
