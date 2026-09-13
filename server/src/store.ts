import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { businessSchema, emptyBusiness, type BusinessData, type Snapshot, type Todo } from '../../shared/domain.ts';
import { dateInZone, reminderInstant, validateTimeZone, wallToInstant } from '../../shared/time.ts';
import { ApiError } from './errors.ts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type MutationRecord = { actor: string; hash: string; revision: number; result: string };
type MutationResult = { snapshot: Snapshot; committedRevision: number; replayed: boolean; result: Record<string, unknown> };
export type Binding = { senderId: string; platformId: string; session: string; version: number };
export type ClaimedReminder = { id: string; leaseToken: string; scheduledAt: string; todoId: string; title: string; binding: Binding; attempts: number };
type ReminderRow = { id: string; todo_id: string; scheduled_at: number; status: string; lease_token: string | null; lease_until: number | null; attempts: number; binding_version: number | null };
const HOUR = 3_600_000;
const MAX_ATTEMPTS = 8;

export class Store {
  readonly db: DatabaseSync;
  readonly timeZone: string;
  readonly now: () => number;
  constructor(path: string, timeZone = 'Asia/Shanghai', now = Date.now) {
    this.timeZone = validateTimeZone(timeZone);
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('Database is newer than this server; refusing to downgrade');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), json TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS completions (todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE, day TEXT NOT NULL, PRIMARY KEY(todo_id, day));
      CREATE TABLE IF NOT EXISTS time_entries (todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE, id TEXT NOT NULL, json TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(todo_id, id));
      CREATE TABLE IF NOT EXISTS diary (id TEXT PRIMARY KEY, day TEXT NOT NULL UNIQUE, json TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), sender_id TEXT NOT NULL, platform_id TEXT NOT NULL, session TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        scheduled_at INTEGER NOT NULL, day TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, binding_version INTEGER, receipt TEXT, last_error TEXT, sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, available_at, scheduled_at);
      PRAGMA user_version = 1;
    `);
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('revision', '0')").run();
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('timezone', ?)").run(this.timeZone);
      const savedZone = (this.db.prepare("SELECT value FROM meta WHERE key='timezone'").get() as { value: string }).value;
      if (savedZone !== this.timeZone) throw new Error(`Database timezone is ${savedZone}; refusing an implicit calendar migration`);
      if (!this.db.prepare('SELECT id FROM lists LIMIT 1').get()) this.writeBusiness(emptyBusiness(new Date(this.now()).toISOString()));
    });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot(): Snapshot {
    const read = <T>(table: string): T[] => (this.db.prepare(`SELECT json FROM ${table} ORDER BY position`).all() as { json: string }[]).map(row => JSON.parse(row.json));
    const todos = read<Todo>('todos');
    const byId = new Map(todos.map(t => [t.id, t]));
    for (const todo of todos) { todo.completionDates = []; todo.timeEntries = []; }
    for (const row of this.db.prepare('SELECT todo_id, day FROM completions ORDER BY day').all() as { todo_id: string; day: string }[]) byId.get(row.todo_id)!.completionDates.push(row.day);
    for (const row of this.db.prepare('SELECT todo_id, json FROM time_entries ORDER BY position').all() as { todo_id: string; json: string }[]) byId.get(row.todo_id)!.timeEntries.push(JSON.parse(row.json));
    return { revision: this.revision(), timeZone: this.timeZone, lists: read('lists'), todos, diary: read('diary') };
  }
  revision(): number { return Number((this.db.prepare("SELECT value FROM meta WHERE key='revision'").get() as { value: string }).value); }
  private writeBusiness(state: BusinessData) {
    // Upsert identities: deleting/reinserting every task would erase sent reminders.
    const putList = this.db.prepare('INSERT INTO lists VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, position=excluded.position');
    state.lists.forEach((list, i) => putList.run(list.id, JSON.stringify(list), i));
    const putTodo = this.db.prepare('INSERT INTO todos VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET list_id=excluded.list_id, json=excluded.json, position=excluded.position');
    const putCompletion = this.db.prepare('INSERT INTO completions VALUES (?, ?)');
    const putTime = this.db.prepare('INSERT INTO time_entries VALUES (?, ?, ?, ?)');
    state.todos.forEach((todo, i) => {
      const { completionDates, timeEntries, ...definition } = todo;
      putTodo.run(todo.id, todo.listId, JSON.stringify(definition), i);
      this.db.prepare('DELETE FROM completions WHERE todo_id=?').run(todo.id);
      this.db.prepare('DELETE FROM time_entries WHERE todo_id=?').run(todo.id);
      completionDates.forEach(day => putCompletion.run(todo.id, day));
      timeEntries.forEach((entry, position) => {
        const id = entry.id ?? `legacy-${digest([todo.id, position, entry]).slice(0, 32)}`;
        putTime.run(todo.id, id, JSON.stringify({ ...entry, id }), position);
      });
    });
    for (const [table, retained] of [['todos', new Set(state.todos.map(t => t.id))], ['lists', new Set(state.lists.map(l => l.id))]] as const) {
      for (const row of this.db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]) if (!retained.has(row.id)) this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    }
    this.db.exec('DELETE FROM diary');
    const putDiary = this.db.prepare('INSERT INTO diary VALUES (?, ?, ?, ?)');
    state.diary.forEach((entry, i) => putDiary.run(entry.id, entry.date, JSON.stringify(entry), i));
  }
  mutate(actor: 'app' | 'bot', id: string, expectedRevision: number, body: unknown,
    produce: (current: Snapshot) => { business: BusinessData; result?: Record<string, unknown> }): MutationResult {
    return this.transaction(() => {
      const hash = digest(body);
      const previous = this.db.prepare('SELECT actor, hash, revision, result FROM mutations WHERE id=?').get(id) as MutationRecord | undefined;
      if (previous) {
        if (previous.actor !== actor || previous.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'This operation ID was used with different content');
        return { snapshot: this.snapshot(), committedRevision: previous.revision, replayed: true, result: JSON.parse(previous.result) };
      }
      if (this.revision() !== expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Server data changed. Reload instead of overwriting it.');
      const { business, result = {} } = produce(this.snapshot());
      const clean = businessSchema.parse(business);
      for (const todo of clean.todos) {
        try { reminderInstant(todo, this.timeZone); }
        catch { throw new ApiError(422, 'INVALID_REMINDER_TIME', `Task ${todo.id}: ambiguous/nonexistent local reminder time; use an explicit UTC offset`); }
      }
      this.writeBusiness(clean);
      const revision = expectedRevision + 1;
      this.db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(String(revision));
      this.reconcileReminders();
      this.db.prepare('INSERT INTO mutations VALUES (?, ?, ?, ?, ?, ?)').run(id, actor, hash, revision, JSON.stringify(result), this.now());
      return { snapshot: this.snapshot(), committedRevision: revision, replayed: false, result };
    });
  }
  isEmpty(): boolean {
    const state = this.snapshot();
    return state.todos.length === 0 && state.diary.length === 0 && state.lists.length === 3 && this.revision() === 0;
  }
  getBinding(): Binding | null {
    const row = this.db.prepare('SELECT sender_id, platform_id, session, version FROM binding WHERE id=1').get() as { sender_id: string; platform_id: string; session: string; version: number } | undefined;
    return row ? { senderId: row.sender_id, platformId: row.platform_id, session: row.session, version: row.version } : null;
  }
  bind(binding: Omit<Binding, 'version'>): Binding {
    return this.transaction(() => {
      const old = this.getBinding();
      if (old?.senderId === binding.senderId && old.platformId === binding.platformId && old.session === binding.session) return old;
      const version = (old?.version ?? 0) + 1;
      this.db.prepare('INSERT INTO binding VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sender_id=excluded.sender_id, platform_id=excluded.platform_id, session=excluded.session, version=excluded.version').run(binding.senderId, binding.platformId, binding.session, version);
      this.db.prepare("UPDATE reminders SET status='pending', lease_token=NULL, lease_until=NULL WHERE status='leased'").run();
      return { ...binding, version };
    });
  }
  unbind() { this.transaction(() => { this.db.exec("DELETE FROM binding; UPDATE reminders SET status='pending', lease_token=NULL, lease_until=NULL WHERE status='leased';"); }); }
  private reconcileReminders() {
    const now = this.now();
    const today = dateInZone(now, this.timeZone);
    const wanted = new Set<string>();
    for (const todo of this.snapshot().todos) {
      if (todo.isGroup) continue;
      const goal = !!todo.goalStartDate;
      let at: string | undefined;
      let day: string | undefined;
      if (goal && todo.reminderTime) {
        if (todo.goalStartDate! > today || todo.goalEndDate! < today) continue;
        day = today;
        // During a DST gap/fold skip the ambiguous occurrence, never guess an hour.
        try { at = wallToInstant(`${today}T${todo.reminderTime}`, this.timeZone); } catch { continue; }
      } else { at = reminderInstant(todo, this.timeZone); }
      if (!at) continue;
      const scheduled = Date.parse(at);
      day ??= goal ? dateInZone(scheduled, this.timeZone) : undefined;
      const id = digest([todo.id, day ?? 'once', at]).slice(0, 40);
      wanted.add(id);
      const completed = goal ? todo.completionDates.includes(day!) : todo.completed;
      const active = !completed && (!goal || (todo.goalStartDate! <= day! && day! <= todo.goalEndDate!));
      const row = this.db.prepare('SELECT status FROM reminders WHERE id=?').get(id) as { status: string } | undefined;
      if (!row) {
        this.db.prepare('INSERT INTO reminders (id, todo_id, scheduled_at, day, status, available_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, todo.id, scheduled, day ?? null, active ? 'pending' : 'cancelled', scheduled);
      } else if (!active && ['pending', 'leased'].includes(row.status)) {
        this.db.prepare("UPDATE reminders SET status='cancelled', lease_token=NULL, lease_until=NULL WHERE id=?").run(id);
      } else if (active && row.status === 'cancelled') {
        this.db.prepare("UPDATE reminders SET status='pending', available_at=?, attempts=0 WHERE id=?").run(scheduled, id);
      }
    }
    for (const row of this.db.prepare("SELECT id FROM reminders WHERE status IN ('pending','leased')").all() as { id: string }[]) {
      if (!wanted.has(row.id)) this.db.prepare("UPDATE reminders SET status='cancelled', lease_token=NULL, lease_until=NULL WHERE id=?").run(row.id);
    }
    this.db.prepare("UPDATE reminders SET status='missed', lease_token=NULL, lease_until=NULL WHERE status IN ('pending','leased') AND scheduled_at < ?").run(now - 24 * HOUR);
    this.db.prepare("UPDATE reminders SET status='failed', lease_token=NULL, lease_until=NULL WHERE attempts>=? AND (status='pending' OR (status='leased' AND lease_until<=?))").run(MAX_ATTEMPTS, now);
  }
  claim(limit = 5): ClaimedReminder[] {
    return this.transaction(() => {
      this.reconcileReminders();
      const binding = this.getBinding();
      if (!binding) return [];
      const now = this.now();
      const rows = this.db.prepare("SELECT * FROM reminders WHERE scheduled_at<=? AND attempts<? AND ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<=?)) ORDER BY scheduled_at LIMIT ?").all(now, MAX_ATTEMPTS, now, now, limit) as ReminderRow[];
      const todos = new Map(this.snapshot().todos.map(t => [t.id, t]));
      return rows.map(row => {
        const leaseToken = randomUUID();
        this.db.prepare("UPDATE reminders SET status='leased', lease_token=?, lease_until=?, attempts=attempts+1, binding_version=? WHERE id=?").run(leaseToken, now + 120_000, binding.version, row.id);
        return { id: row.id, leaseToken, scheduledAt: new Date(row.scheduled_at).toISOString(), todoId: row.todo_id, title: todos.get(row.todo_id)!.title, binding, attempts: row.attempts + 1 };
      });
    });
  }
  validateLease(id: string, token: string): boolean {
    return this.transaction(() => {
      this.reconcileReminders();
      const row = this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id) as ReminderRow | undefined;
      return !!row && row.status === 'leased' && row.lease_token === token && row.lease_until! > this.now() && row.binding_version === this.getBinding()?.version;
    });
  }
  settle(id: string, token: string, receipt?: string) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id) as ReminderRow | undefined;
      if (row?.status === 'sent' && row.lease_token === token && receipt) return { status: 'sent' };
      if (!row || row.status !== 'leased' || row.lease_token !== token || row.binding_version !== this.getBinding()?.version) throw new ApiError(409, 'LEASE_LOST', 'Reminder was cancelled or claimed by another worker');
      if (receipt) {
        this.db.prepare("UPDATE reminders SET status='sent', receipt=?, sent_at=?, lease_until=NULL, last_error=NULL WHERE id=?").run(receipt, this.now(), id);
        return { status: 'sent' };
      }
      const status = row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const delay = Math.min(3_600_000, 15_000 * 2 ** Math.max(0, row.attempts - 1));
      // Error bodies can contain credentials or private platform responses: store only a code.
      this.db.prepare('UPDATE reminders SET status=?, available_at=?, lease_token=NULL, lease_until=NULL, last_error=? WHERE id=?').run(status, this.now() + delay, 'DELIVERY_FAILED', id);
      return { status };
    });
  }
  reminderStats(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT status, count(*) AS count FROM reminders GROUP BY status').all() as { status: string; count: number }[]).map(r => [r.status, r.count]));
  }
}
