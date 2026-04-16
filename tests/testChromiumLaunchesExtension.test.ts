/**
 * Self-test: launching Chromium with the extension and waiting for the
 * service worker to register.
 *
 * Requires (a) a built extension dist dir and (b) a graphical environment
 * (Xvfb). Skipped when either is missing — Chrome extensions cannot run in
 * headless mode.
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import {
  buildExtension,
  cleanupProfileDir,
  launchChromiumWithExtension,
  repoPaths,
} from '../src';

const paths = repoPaths();
const envDir = process.env.W3WALLET_EXTENSION_DIR;
const sourceAvailable =
  fs.existsSync(paths.extensionProject) ||
  (envDir && fs.existsSync(path.join(envDir, 'manifest.json')));
// Chrome extensions require a graphical context.
const hasDisplay = !!process.env.DISPLAY;
// Verify the Playwright Chromium binary is actually present. CI installs it
// via `npx playwright install`; local dev environments may not have it.
let chromiumInstalled = false;
try {
  const exe = chromium.executablePath();
  chromiumInstalled = !!exe && fs.existsSync(exe);
} catch {
  chromiumInstalled = false;
}
const describeIfRunnable =
  sourceAvailable && hasDisplay && chromiumInstalled
    ? describe
    : describe.skip;

if (!sourceAvailable || !hasDisplay || !chromiumInstalled) {
  // eslint-disable-next-line no-console
  console.warn(
    `[testChromiumLaunchesExtension] skipping. ` +
      `extensionAvailable=${sourceAvailable} hasDisplay=${hasDisplay} ` +
      `chromiumInstalled=${chromiumInstalled}. On CI, run under xvfb-run ` +
      `after 'npx playwright install --with-deps chromium'.`,
  );
}

describeIfRunnable('launchChromiumWithExtension', () => {
  test('launches chromium and the extension service worker registers', async () => {
    const distDir = buildExtension();
    const launched = await launchChromiumWithExtension({
      extensionDir: distDir,
    });
    try {
      const origin = await launched.extensionOrigin;
      expect(origin).toMatch(/^chrome-extension:\/\//);
    } finally {
      await launched.close();
      cleanupProfileDir(launched.userDataDir);
    }
  }, 120_000);
});
