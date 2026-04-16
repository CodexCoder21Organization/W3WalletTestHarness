/**
 * Self-test: buildExtension produces a manifest.json. Skipped when the
 * W3WalletExtension source is not available (no sibling checkout and no
 * W3WALLET_EXTENSION_DIR override).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildExtension, repoPaths } from '../src';

const paths = repoPaths();
const envDir = process.env.W3WALLET_EXTENSION_DIR;
const sourceAvailable =
  fs.existsSync(paths.extensionProject) ||
  (envDir &&
    fs.existsSync(path.join(envDir, 'manifest.json')));
const describeIfSource = sourceAvailable ? describe : describe.skip;

if (!sourceAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[testExtensionBuild] skipping: no W3WalletExtension source at ` +
      `${paths.extensionProject} and no W3WALLET_EXTENSION_DIR override.`,
  );
}

describeIfSource('buildExtension', () => {
  test('returns a dist dir that contains manifest.json', () => {
    const distDir = buildExtension();
    expect(fs.existsSync(distDir)).toBe(true);
    const manifest = path.join(distDir, 'manifest.json');
    expect(fs.existsSync(manifest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    expect(typeof parsed.name).toBe('string');
    expect(parsed.manifest_version).toBeGreaterThanOrEqual(2);
  }, 600_000);

  test('second call is idempotent (returns same path)', () => {
    const a = buildExtension();
    const b = buildExtension();
    expect(b).toBe(a);
  });
});
