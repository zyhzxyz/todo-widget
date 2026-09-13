import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** SQLite's online-backup API includes committed WAL pages. Never copy a live .db alone. */
export async function backupDatabase(source: string, destination: string) {
  if (!existsSync(source) || resolve(source) === resolve(destination) || existsSync(destination)) throw new Error('Source must exist; destination must be a new, different file');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
    chmodSync(destination, 0o600);
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      const result = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
    } finally { check.close(); }
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) { console.error('Usage: npm run server:backup -- /absolute/path/todo.db /absolute/path/new-backup.db'); process.exitCode = 2; }
  else { process.umask(0o077); await backupDatabase(resolve(source), resolve(destination)); console.log('Consistent SQLite backup created and verified.'); }
}
