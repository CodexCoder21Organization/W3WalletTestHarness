/**
 * Self-signed TLS certificate generation for test HTTPS servers.
 *
 * Consolidates the cert-generation logic that previously lived in two
 * different W3Wallet test suites:
 *   - W3WalletTests/e2e-playwright/tests/harness/certs.ts (CA + server cert,
 *     multi-SAN for cross-domain tests)
 *   - W3WalletJavascriptCoinCollectorDemo/tests-e2e/fixtures/cert.ts
 *     (single localhost cert)
 *
 * Generated artifacts are cached on disk so consecutive test runs reuse the
 * same cert; the cache key is derived from the SAN set so that adding a
 * new SAN forces a regeneration.
 *
 * Browsers must be launched with `--ignore-certificate-errors` /
 * `ignoreHTTPSErrors` so the self-signed cert is accepted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as forge from 'node-forge';

export interface TestCerts {
  /** PEM of the CA certificate. */
  caCertPem: string;
  /** PEM of the server certificate (signed by the CA). */
  serverCertPem: string;
  /** PEM of the server private key. */
  serverKeyPem: string;
  /** Backwards-compatible alias for serverCertPem. */
  certPem: string;
  /** Backwards-compatible alias for serverKeyPem. */
  keyPem: string;
  /** Directory the .pem files are written to. */
  dir: string;
  /** Path of the CA cert .pem file. */
  caCertPath: string;
  /** Path of the server cert .pem file. */
  serverCertPath: string;
  /** Path of the server key .pem file. */
  serverKeyPath: string;
  /** Backwards-compatible alias for serverCertPath. */
  certPath: string;
  /** Backwards-compatible alias for serverKeyPath. */
  keyPath: string;
}

export interface GenerateLocalhostCertsOptions {
  /** Directory to write the .pem files into. Created if missing. */
  outputDir: string;
  /**
   * Additional DNS names to include in subjectAltName. A small set of
   * defaults is always added (localhost + site-a.test/site-b.test/site-c.test
   * etc) so consumers don't need to remember the convention.
   */
  hostnames?: string[];
  /**
   * If true, regenerate even if cached files exist and match the SAN set.
   * Defaults to false.
   */
  force?: boolean;
}

const DEFAULT_HOSTNAMES = [
  'localhost',
  'site-a.test',
  'site-b.test',
  'site-c.test',
  'site-a.localhost',
  'site-b.localhost',
  'site-c.localhost',
];

/**
 * Generate (or reuse) a CA + server cert valid for `localhost`, `127.0.0.1`,
 * `::1`, and any additional hostnames you pass in.
 *
 * The result is deterministic per SAN set: the digest of the sorted SAN list
 * is recorded alongside the cert files; if the cached digest matches, the
 * existing cert is returned untouched.
 */
export function generateLocalhostCerts(
  options: GenerateLocalhostCertsOptions,
): TestCerts {
  const { outputDir, hostnames = [], force = false } = options;
  fs.mkdirSync(outputDir, { recursive: true });

  const altNames = new Set<string>([...DEFAULT_HOSTNAMES, ...hostnames]);
  const sortedSans = [...altNames].sort();
  const digest = crypto
    .createHash('sha256')
    .update(sortedSans.join('|'))
    .digest('hex')
    .slice(0, 16);

  const caCertPath = path.join(outputDir, 'ca.crt');
  const serverCertPath = path.join(outputDir, 'localhost.crt');
  const serverKeyPath = path.join(outputDir, 'localhost.key');
  const cacheKeyPath = path.join(outputDir, '.san-digest');

  if (
    !force &&
    fs.existsSync(caCertPath) &&
    fs.existsSync(serverCertPath) &&
    fs.existsSync(serverKeyPath) &&
    fs.existsSync(cacheKeyPath) &&
    fs.readFileSync(cacheKeyPath, 'utf8').trim() === digest
  ) {
    const caCertPem = fs.readFileSync(caCertPath, 'utf8');
    const serverCertPem = fs.readFileSync(serverCertPath, 'utf8');
    const serverKeyPem = fs.readFileSync(serverKeyPath, 'utf8');
    return buildResult({
      caCertPem,
      serverCertPem,
      serverKeyPem,
      dir: outputDir,
      caCertPath,
      serverCertPath,
      serverKeyPath,
    });
  }

  const pki = forge.pki;

  // Generate CA
  const caKeys = pki.rsa.generateKeyPair(2048);
  const caCert = pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(
    caCert.validity.notBefore.getFullYear() + 5,
  );
  const caAttrs = [
    { name: 'commonName', value: 'W3Wallet Test Harness CA' },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'W3Wallet Tests' },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // Generate server cert signed by CA
  const serverKeys = pki.rsa.generateKeyPair(2048);
  const serverCert = pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = '02';
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notAfter = new Date();
  serverCert.validity.notAfter.setFullYear(
    serverCert.validity.notBefore.getFullYear() + 2,
  );
  serverCert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  serverCert.setIssuer(caAttrs);

  // subjectAltName supports two GeneralName types: DNS (2) and IP (7).
  const altNameEntries: { type: number; value?: string; ip?: string }[] = [];
  for (const n of sortedSans) {
    altNameEntries.push({ type: 2, value: n });
  }
  altNameEntries.push({ type: 7, ip: '127.0.0.1' });
  altNameEntries.push({ type: 7, ip: '::1' });

  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      nonRepudiation: true,
    },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames: altNameEntries },
  ]);
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const caCertPem = pki.certificateToPem(caCert);
  const serverCertPem = pki.certificateToPem(serverCert);
  const serverKeyPem = pki.privateKeyToPem(serverKeys.privateKey);

  fs.writeFileSync(caCertPath, caCertPem);
  fs.writeFileSync(serverCertPath, serverCertPem);
  fs.writeFileSync(serverKeyPath, serverKeyPem);
  fs.writeFileSync(cacheKeyPath, digest);

  return buildResult({
    caCertPem,
    serverCertPem,
    serverKeyPem,
    dir: outputDir,
    caCertPath,
    serverCertPath,
    serverKeyPath,
  });
}

interface ResultArgs {
  caCertPem: string;
  serverCertPem: string;
  serverKeyPem: string;
  dir: string;
  caCertPath: string;
  serverCertPath: string;
  serverKeyPath: string;
}

function buildResult(args: ResultArgs): TestCerts {
  return {
    caCertPem: args.caCertPem,
    serverCertPem: args.serverCertPem,
    serverKeyPem: args.serverKeyPem,
    certPem: args.serverCertPem,
    keyPem: args.serverKeyPem,
    dir: args.dir,
    caCertPath: args.caCertPath,
    serverCertPath: args.serverCertPath,
    serverKeyPath: args.serverKeyPath,
    certPath: args.serverCertPath,
    keyPath: args.serverKeyPath,
  };
}

/**
 * Extract the subjectAltName entries (DNS + IP) from a PEM-encoded X.509
 * certificate. Returned as the original strings, sorted alphabetically. Used
 * by tests to verify that a cert covers the expected hostnames.
 *
 * Note on IP encoding: node-forge represents subjectAltName IP entries by
 * setting `type: 7` and storing the dotted-decimal string in `value` (bytes
 * for IPv6 in some inputs). We surface IPs in a normalized form by
 * preferring the `ip` field when present, then `value`. Bytes that contain
 * non-printable characters are converted to dotted-decimal/colon-hex.
 */
export function getCertSubjectAltNames(pem: string): string[] {
  const cert = forge.pki.certificateFromPem(pem);
  const ext = cert.getExtension('subjectAltName') as
    | { altNames?: { type: number; value?: string; ip?: string }[] }
    | undefined;
  if (!ext || !ext.altNames) return [];
  const out: string[] = [];
  for (const a of ext.altNames) {
    if (a.type === 7) {
      const ip = a.ip ?? decodeIpFromBytes(a.value ?? '');
      if (ip) out.push(ip);
    } else if (a.value) {
      out.push(a.value);
    } else if (a.ip) {
      out.push(a.ip);
    }
  }
  return out.sort();
}

/**
 * Decode an IP-address string that node-forge has serialized as raw bytes
 * (IPv4 = 4 bytes, IPv6 = 16 bytes). Returns null for unrecognized lengths.
 */
function decodeIpFromBytes(value: string): string | null {
  if (value.length === 4) {
    return [
      value.charCodeAt(0),
      value.charCodeAt(1),
      value.charCodeAt(2),
      value.charCodeAt(3),
    ].join('.');
  }
  if (value.length === 16) {
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      const hi = value.charCodeAt(i);
      const lo = value.charCodeAt(i + 1);
      parts.push(((hi << 8) | lo).toString(16));
    }
    // Compress longest run of zeros for canonical form.
    return collapseIpv6Zeros(parts.join(':'));
  }
  return null;
}

function collapseIpv6Zeros(addr: string): string {
  // Replace the longest run of ":0:0:..." with "::"; falls back to addr.
  const collapsed = addr.replace(/(^|:)(0(:0)*)(?=:|$)/, (match) => {
    if (match.startsWith(':')) return '::';
    return '::';
  });
  return collapsed;
}
