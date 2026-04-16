/**
 * Self-test: cert generation produces a usable cert with the expected SAN
 * entries and is deterministic per SAN set.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateLocalhostCerts,
  getCertSubjectAltNames,
} from '../src/certs';

describe('generateLocalhostCerts', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3w-harness-cert-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('writes ca + server cert + key files', () => {
    const certs = generateLocalhostCerts({ outputDir: outDir });
    expect(fs.existsSync(certs.caCertPath)).toBe(true);
    expect(fs.existsSync(certs.serverCertPath)).toBe(true);
    expect(fs.existsSync(certs.serverKeyPath)).toBe(true);
    expect(certs.caCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(certs.serverCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(certs.serverKeyPem).toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
  });

  test('SAN list includes localhost, 127.0.0.1, ::1, and any extras', () => {
    const certs = generateLocalhostCerts({
      outputDir: outDir,
      hostnames: ['demo.test', 'foo.test'],
    });
    const sans = getCertSubjectAltNames(certs.serverCertPem);
    expect(sans).toEqual(expect.arrayContaining(['localhost']));
    expect(sans).toEqual(expect.arrayContaining(['127.0.0.1']));
    expect(sans).toEqual(expect.arrayContaining(['::1']));
    expect(sans).toEqual(expect.arrayContaining(['demo.test']));
    expect(sans).toEqual(expect.arrayContaining(['foo.test']));
  });

  test('reuses cached cert when SAN set is unchanged', () => {
    const a = generateLocalhostCerts({ outputDir: outDir });
    const b = generateLocalhostCerts({ outputDir: outDir });
    expect(b.serverCertPem).toBe(a.serverCertPem);
    expect(b.serverKeyPem).toBe(a.serverKeyPem);
  });

  test('regenerates when SAN set changes', () => {
    const a = generateLocalhostCerts({ outputDir: outDir });
    const b = generateLocalhostCerts({
      outputDir: outDir,
      hostnames: ['extra.test'],
    });
    expect(b.serverCertPem).not.toBe(a.serverCertPem);
  });

  test('force=true forces a rebuild even if SANs match', () => {
    const a = generateLocalhostCerts({ outputDir: outDir });
    const b = generateLocalhostCerts({ outputDir: outDir, force: true });
    expect(b.serverCertPem).not.toBe(a.serverCertPem);
  });
});
