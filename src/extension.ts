/**
 * W3WalletExtension build helper.
 *
 * Builds (or reuses) the unpacked extension dist directory used by Chromium's
 * --load-extension. Idempotent: if a dist/manifest.json already exists, no
 * rebuild is performed.
 *
 * Consolidates extensionBuilder.ts (PR2) and extension.ts (PR1).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { repoPaths, requirePath } from './paths';

export interface BuildExtensionOptions {
  /**
   * Source directory of the W3WalletExtension repo. Defaults to
   * {@link repoPaths().extensionProject}.
   */
  sourceDir?: string;
  /**
   * Override for the dist output path (must contain manifest.json after a
   * successful build). Defaults to `<sourceDir>/dist`.
   */
  distDir?: string;
  /**
   * Force a rebuild even if dist/manifest.json already exists.
   */
  force?: boolean;
}

/**
 * Build the extension if dist/manifest.json is missing. Returns the absolute
 * path of the dist directory.
 *
 * Honors `W3WALLET_EXTENSION_DIR` (set via {@link repoPaths}) — when present,
 * the build is skipped entirely and the env-provided directory is used.
 */
export function buildExtension(options: BuildExtensionOptions = {}): string {
  // If the env override pointed somewhere with a manifest already, use it.
  const paths = repoPaths();
  const sourceDir = options.sourceDir ?? paths.extensionProject;
  const distDir = options.distDir ?? path.join(sourceDir, 'dist');
  const manifest = path.join(distDir, 'manifest.json');

  if (
    process.env.W3WALLET_EXTENSION_DIR &&
    fs.existsSync(path.join(process.env.W3WALLET_EXTENSION_DIR, 'manifest.json'))
  ) {
    return process.env.W3WALLET_EXTENSION_DIR;
  }

  if (!options.force && fs.existsSync(manifest)) return distDir;

  requirePath(sourceDir, 'W3WalletExtension project directory');

  if (!fs.existsSync(path.join(sourceDir, 'node_modules'))) {
    // eslint-disable-next-line no-console
    console.log('[harness] npm install (W3WalletExtension)');
    execSync('npm install --no-audit --no-fund', {
      cwd: sourceDir,
      stdio: 'inherit',
    });
  }
  // eslint-disable-next-line no-console
  console.log('[harness] npm run build (W3WalletExtension)');
  execSync('npm run build', { cwd: sourceDir, stdio: 'inherit' });

  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Extension build finished but manifest.json was not produced at ${manifest}. ` +
        `Check 'npm run build' output above for errors. ` +
        `Source dir: ${sourceDir}.`,
    );
  }
  return distDir;
}
