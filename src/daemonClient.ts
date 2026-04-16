/**
 * Direct WebSocket RPC client for the W3WalletDaemon.
 *
 * The daemon's WalletWebSocketHandler only accepts messages with a `type`
 * field containing a snake_case operation name (e.g. `list_capabilities`)
 * along with operation-specific params flattened onto the envelope — not
 * JSON-RPC style. This client translates camelCase method calls into that
 * envelope:
 *   call("listCapabilities", { domain })  →  {"type":"list_capabilities",
 *                                              "domain":"…","id":N,
 *                                              "origin":"…"}
 * Responses come back shaped as
 *   {"id":N, "type":"list_capabilities_response", "capabilities":[…]}
 * so `call` extracts the non-metadata fields ({capabilities, capability,
 * profile, profiles, result, …}) and returns them sensibly.
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
    string,
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
      requestId?: string;
      type?: string;
      error?: { message?: string } | string;
      success?: boolean;
      [k: string]: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // non-JSON heartbeat — ignore
    }
    // Drop the daemon's pong heartbeat.
    if (msg.type === 'pong') return;
    const requestId = msg.requestId;
    if (typeof requestId !== 'string') return;
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    this.pending.delete(requestId);
    // The daemon signals errors either via an `error` field or via
    // `success: false` with the failure details inline on the envelope.
    if (msg.error) {
      const errMsg =
        typeof msg.error === 'string'
          ? msg.error
          : (msg.error.message ?? JSON.stringify(msg.error));
      waiter.reject(new Error(`Daemon RPC error: ${errMsg}`));
      return;
    }
    if (msg.success === false) {
      const m = (msg.message as string | undefined) ?? JSON.stringify(msg);
      waiter.reject(new Error(`Daemon RPC failed: ${m}`));
      return;
    }
    waiter.resolve(msg);
  }

  /**
   * Invoke a daemon operation using its `type`-tagged envelope. The method
   * argument is camelCase (e.g. `listCapabilities`) and is translated to
   * snake_case (`list_capabilities`) to match the daemon's protocol. The
   * params object is flattened onto the envelope. Returns the full response
   * object so callers can pick off `capabilities`, `capability`, `profile`,
   * etc. as needed.
   */
  async call<T = unknown>(method: string, params: object = {}): Promise<T> {
    await this.connect();
    if (!this.ws) throw new Error('DaemonWebSocketClient not connected');
    const requestId = `rpc-${this.nextId++}`;
    const type = camelToSnake(method);
    const envelope: Record<string, unknown> = {
      requestId,
      type,
      origin: this.opts.origin,
      ...params,
    };
    const payload = JSON.stringify(envelope);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(requestId);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(
            new Error(
              `Daemon RPC '${method}' (type=${type}) timed out after ${this.opts.rpcTimeoutMs}ms. ` +
                `Envelope: ${payload}`,
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

  async listCapabilities(
    params: Record<string, unknown> = {},
  ): Promise<DaemonCapability[]> {
    const result = await this.call<{ capabilities?: unknown }>(
      'listCapabilities',
      params,
    );
    return normalizeCapabilities(result.capabilities);
  }

  async createCapability(
    params: Record<string, unknown>,
  ): Promise<DaemonCapability> {
    const result = await this.call<{ capability?: DaemonCapability }>(
      'createCapability',
      params,
    );
    if (result.capability) return result.capability;
    return result as unknown as DaemonCapability;
  }

  async updateCapability(
    capabilityId: string,
    updates: Record<string, unknown>,
  ): Promise<DaemonCapability> {
    const result = await this.call<{ capability?: DaemonCapability }>(
      'updateCapability',
      { capabilityId, ...updates },
    );
    if (result.capability) return result.capability;
    return result as unknown as DaemonCapability;
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
    if (result.profile) return result.profile;
    return result as unknown as DaemonProfile;
  }
}

/** camelCase → snake_case for daemon message `type` names. */
function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');
}

function normalizeCapabilities(raw: unknown): DaemonCapability[] {
  if (Array.isArray(raw)) return raw as DaemonCapability[];
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
