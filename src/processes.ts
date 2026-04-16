/**
 * Generic child-process spawn / kill helpers with readiness polling.
 *
 * Used internally by daemon.ts and demoJvm.ts. Exported so consumers can
 * launch ad-hoc processes (e.g. a custom server jar) with the same
 * conventions: descriptive timeout errors, captured stdout/stderr buffers,
 * and graceful SIGTERM-then-SIGKILL teardown.
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';

export interface ManagedProcess {
  process: ChildProcess;
  /** Tail of captured stdout (last 64 KiB). */
  stdout(): string;
  /** Tail of captured stderr (last 64 KiB). */
  stderr(): string;
  /** Stop the process via SIGTERM, escalating to SIGKILL after the timeout. */
  stop(killTimeoutMs?: number): Promise<void>;
}

export interface SpawnProcessOptions extends SpawnOptions {
  /** Callback that receives every stdout chunk (decoded as UTF-8). */
  onStdout?: (chunk: string) => void;
  /** Callback that receives every stderr chunk (decoded as UTF-8). */
  onStderr?: (chunk: string) => void;
  /** Prefix appended to forwarded stdout/stderr. Defaults to nothing. */
  logPrefix?: string;
  /**
   * Forward captured output to the parent's stdout/stderr. Useful when
   * debugging locally; off by default to keep test output clean.
   */
  inheritOutput?: boolean;
}

const MAX_BUFFER_BYTES = 64 * 1024;

/**
 * Spawn a child process with stdout/stderr capture. Output is retained in a
 * sliding 64 KiB buffer so the process's tail can be included in error
 * messages when readiness polling fails.
 */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions = {},
): ManagedProcess {
  const {
    onStdout,
    onStderr,
    logPrefix = '',
    inheritOutput = false,
    ...spawnOpts
  } = options;
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spawnOpts,
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  const handle = (
    data: Buffer,
    bufRef: 'stdout' | 'stderr',
    forward: NodeJS.WriteStream,
  ) => {
    const text = data.toString('utf-8');
    if (bufRef === 'stdout') {
      stdoutBuf = (stdoutBuf + text).slice(-MAX_BUFFER_BYTES);
      onStdout?.(text);
    } else {
      stderrBuf = (stderrBuf + text).slice(-MAX_BUFFER_BYTES);
      onStderr?.(text);
    }
    if (inheritOutput) {
      forward.write(`${logPrefix}${text}`);
    }
  };

  child.stdout?.on('data', (b: Buffer) => handle(b, 'stdout', process.stdout));
  child.stderr?.on('data', (b: Buffer) => handle(b, 'stderr', process.stderr));

  return {
    process: child,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    async stop(killTimeoutMs: number = 5000) {
      await killProcess(child, killTimeoutMs);
    },
  };
}

/**
 * Politely terminate a child process: send SIGTERM, wait up to
 * {@link killTimeoutMs}, then escalate to SIGKILL.
 *
 * No-op if the process has already exited.
 */
export async function killProcess(
  child: ChildProcess,
  killTimeoutMs: number = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  try {
    child.kill('SIGTERM');
  } catch {
    // Process already dead — fall through.
  }
  const escalation = setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }, killTimeoutMs);
  await exited;
  clearTimeout(escalation);
}

/**
 * Resolve once {@link predicate} returns true, or throw a descriptive Error
 * after {@link timeoutMs}. The error includes whatever string {@link describeFailure}
 * returns so callers can attach context (last response, child stdout tail, etc).
 */
export async function pollUntil(
  predicate: () => Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    describeFailure: () => string;
  },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (e) {
      lastError = e as Error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const ctx = options.describeFailure();
  const errSuffix = lastError ? ` Last error: ${lastError.message}.` : '';
  throw new Error(
    `Polling timed out after ${options.timeoutMs}ms. ${ctx}${errSuffix}`,
  );
}
