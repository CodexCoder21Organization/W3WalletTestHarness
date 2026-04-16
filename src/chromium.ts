/**
 * Chromium launcher with the W3WalletExtension loaded unpacked.
 *
 * Chromium refuses to load unpacked extensions in non-persistent profiles
 * and refuses to load them at all when running headless. CI must therefore
 * use Xvfb (the GitHub workflow in this repo configures one).
 *
 * Consolidates the Chromium launchers from PR1 (extension.ts), PR2
 * (harness.ts), and PR3 (environment.ts).
 */

import { BrowserContext, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LaunchChromiumOptions {
  /** Absolute path to the unpacked extension dist (contains manifest.json). */
  extensionDir: string;
  /** User data dir; defaults to a fresh tmp dir. */
  userDataDir?: string;
  /** Additional Chromium args. */
  extraArgs?: string[];
  /** Additional env for the browser process. */
  env?: NodeJS.ProcessEnv;
  /** Viewport size. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
}

export interface LaunchedChromium {
  context: BrowserContext;
  userDataDir: string;
  extensionDir: string;
  /**
   * Resolves to `chrome-extension://<id>` once the extension's service
   * worker registers. Useful for navigating to extension-internal pages.
   */
  extensionOrigin: Promise<string>;
  close(): Promise<void>;
}

/**
 * Launch a persistent Chromium context with the given unpacked extension
 * loaded. The returned context survives across tabs; use it instead of a
 * regular `browser.newContext()`.
 */
export async function launchChromiumWithExtension(
  options: LaunchChromiumOptions,
): Promise<LaunchedChromium> {
  if (!fs.existsSync(options.extensionDir)) {
    throw new Error(
      `Extension dist dir does not exist: ${options.extensionDir}. ` +
        `Build the extension first via buildExtension() or set W3WALLET_EXTENSION_DIR.`,
    );
  }
  if (!fs.existsSync(path.join(options.extensionDir, 'manifest.json'))) {
    throw new Error(
      `Extension dir ${options.extensionDir} is missing manifest.json. ` +
        `It does not look like a valid unpacked extension build output.`,
    );
  }

  const userDataDir =
    options.userDataDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'w3wallet-chromium-'));
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--disable-extensions-except=${options.extensionDir}`,
    `--load-extension=${options.extensionDir}`,
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    ...(options.extraArgs ?? []),
  ];

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });

  const extensionOrigin = resolveExtensionOrigin(context);

  return {
    context,
    userDataDir,
    extensionDir: options.extensionDir,
    extensionOrigin,
    async close() {
      await context.close().catch(() => {
        // closing during shutdown can race with the browser already exiting;
        // swallow because we can't recover here.
      });
    },
  };
}

/**
 * Launch a headless Chromium context WITHOUT any extension. Useful for
 * negative tests that simulate a user who has not installed W3Wallet.
 */
export async function launchChromiumWithoutExtension(
  options: { userDataDir?: string } = {},
): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir =
    options.userDataDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'w3wallet-noext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    ignoreHTTPSErrors: true,
  });
  return { context, userDataDir };
}

async function resolveExtensionOrigin(
  ctx: BrowserContext,
  timeoutMs: number = 20_000,
): Promise<string> {
  const existing = ctx.serviceWorkers();
  if (existing.length > 0) {
    return new URL(existing[0].url()).origin;
  }
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for the W3Wallet extension ` +
            `service worker to register. Verify the extension was built and ` +
            `that Chromium was launched with --load-extension.`,
        ),
      );
    }, timeoutMs);
    ctx.once('serviceworker', (sw) => {
      clearTimeout(timer);
      resolve(new URL(sw.url()).origin);
    });
  });
}

/**
 * Best-effort cleanup of a temporary user-data dir. Profile dirs sometimes
 * contain UNIX sockets that rm rejects, so failures are swallowed.
 */
export function cleanupProfileDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
