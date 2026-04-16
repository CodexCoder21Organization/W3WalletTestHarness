/**
 * HTTPS static-file server for the W3WalletJavascriptCoinCollectorDemo (and
 * any other static demo).
 *
 * Consolidates demoServers.ts (PR1, startJsDemo + startStaticHtmlServer) and
 * demoServer.ts (PR2, DemoStaticServer). Uses Node's built-in `https` so
 * there are no extra dependencies.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { TestCerts } from './certs';
import { repoPaths, requirePath } from './paths';

export interface JsDemoServer {
  /** Public HTTPS URL the browser should hit. */
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartJsDemoOptions {
  /** Cert + key to serve TLS with. */
  certs: TestCerts;
  /** TCP port to bind. */
  port: number;
  /**
   * Directory containing the demo's index.html / app.js / styles.css.
   * Defaults to {@link repoPaths().jsDemoDir}.
   */
  htmlDir?: string;
  /** Bind host. Defaults to 0.0.0.0 so the browser can use localhost or 127.0.0.1. */
  host?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/**
 * Serve a static directory over HTTPS. Resolves once the listener is bound.
 */
export async function startJsDemo(
  options: StartJsDemoOptions,
): Promise<JsDemoServer> {
  const root = path.resolve(options.htmlDir ?? repoPaths().jsDemoDir);
  requirePath(root, 'JS demo HTML directory');

  const server = https.createServer(
    {
      cert: fs.readFileSync(options.certs.serverCertPath),
      key: fs.readFileSync(options.certs.serverKeyPath),
    },
    (req, res) => {
      try {
        const urlPath = (req.url ?? '/').split('?')[0];
        let rel = decodeURIComponent(urlPath);
        if (rel === '/' || rel === '') rel = '/index.html';
        const filePath = path.normalize(path.join(root, rel));
        if (!filePath.startsWith(root)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end(`Not found: ${rel}`);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader(
          'Content-Type',
          CONTENT_TYPES[ext] ?? 'application/octet-stream',
        );
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(filePath).pipe(res);
      } catch (e) {
        res.statusCode = 500;
        res.end(`Internal error: ${(e as Error).message}`);
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) =>
      reject(
        new Error(
          `Failed to bind JS demo server on ${options.host ?? '0.0.0.0'}:${options.port}: ${
            (e as Error).message
          }`,
        ),
      ),
    );
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
  });

  return {
    url: `https://localhost:${options.port}`,
    port: options.port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Serve a fixed HTML body at https://localhost:<port>/. Useful for
 * cross-domain tests that need ad-hoc pages with predictable hostnames.
 */
export async function startStaticHtmlServer(
  certs: TestCerts,
  port: number,
  html: string,
): Promise<JsDemoServer> {
  const server = https.createServer(
    {
      cert: fs.readFileSync(certs.serverCertPath),
      key: fs.readFileSync(certs.serverKeyPath),
    },
    (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  return {
    url: `https://localhost:${port}`,
    port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
