/**
 * Test-only clock helpers.
 *
 * The W3WalletDaemon does not currently expose a test-clock hook (a proper
 * `--test-clock` CLI flag is tracked elsewhere). Until that ships, tests
 * simulate the passage of time by writing directly to the daemon's SQLite
 * database — specifically, the `permissions.expires_at` column — to force
 * expiry without actually waiting.
 *
 * This is safe in tests because each test owns its own daemon instance and
 * its own database. Production code MUST NOT use these helpers.
 */

import Database from 'better-sqlite3';

export interface PermissionRow {
  id: string;
  profile_id: string;
  capability_id: string;
  granted_to: string;
  granted_by: string;
  access_level: string;
  expires_at: number | null;
  granted_at: number;
  session_id: string | null;
}

/**
 * Read every permission row from the daemon DB. Opens the database read-only
 * so we don't race with the daemon process.
 */
export function listPermissions(dbPath: string): PermissionRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT * FROM permissions ORDER BY granted_at DESC')
      .all() as PermissionRow[];
  } finally {
    db.close();
  }
}

/**
 * Rewrite a single permission row's `expires_at` column. Pass a past
 * timestamp (e.g. `Date.now() - 1000`) to simulate immediate expiry.
 *
 * Throws when the permission id does not exist; the error includes every
 * existing id so the caller can debug typos quickly.
 */
export function setPermissionExpiry(
  dbPath: string,
  permissionId: string,
  expiresAtMs: number,
): void {
  const db = new Database(dbPath);
  try {
    const result = db
      .prepare('UPDATE permissions SET expires_at = ? WHERE id = ?')
      .run(expiresAtMs, permissionId);
    if (result.changes === 0) {
      const existing = db
        .prepare('SELECT id FROM permissions')
        .all() as Array<{ id: string }>;
      throw new Error(
        `setPermissionExpiry: no permission row with id=${permissionId} in ${dbPath}. ` +
          `Existing ids: ${
            existing.map((p) => p.id).join(', ') || '<none>'
          }.`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Expire every permission whose `granted_to` column matches the provided
 * domain. Returns the number of rows affected.
 */
export function expireAllPermissionsFor(
  dbPath: string,
  grantedToDomain: string,
): number {
  const db = new Database(dbPath);
  try {
    const r = db
      .prepare('UPDATE permissions SET expires_at = ? WHERE granted_to = ?')
      .run(Date.now() - 1000, grantedToDomain);
    return r.changes;
  } finally {
    db.close();
  }
}
