import { describe, expect, it } from 'vitest';
import { backupSchema, businessSchema, emptyBusiness, type Todo } from '../shared/domain';
import { deletionIds, restoreTodo, trashTodo, undoCompletion } from '../shared/recycle';
import { parseBackup } from '../src/data/backup';

const now = '2026-09-13T04:00:00Z';
const batch = '10000000-0000-4000-8000-000000000001';
const olderBatch = '10000000-0000-4000-8000-000000000002';
const task = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id, title: `Synthetic ${id}`, completed: false, priority: 'normal', listId: 'list-inbox',
  completionDates: [], isGroup: false, collapsed: false, createdAt: now, updatedAt: now,
  timeEntries: [], totalTimeSpent: 0, ...extra,
});

describe('recoverable task deletion', () => {
  it('deletes/restores a group atomically without reviving an independently deleted child', () => {
    const rows = [task('group', { isGroup: true }), task('child', { parentId: 'group' }),
      task('old', { parentId: 'group', deletedAt: now, deletionBatchId: olderBatch })];
    expect([...deletionIds(rows, 'group')]).toEqual(['group', 'child']);
    const trashed = trashTodo(rows, 'group', now, batch);
    expect(rows[0].deletedAt).toBeUndefined();
    expect(trashed.every(todo => todo.deletedAt)).toBe(true);
    const recovered = restoreTodo(trashed, 'group', now);
    expect(recovered.map(todo => !!todo.deletedAt)).toEqual([false, false, true]);
    expect(recovered[1].parentId).toBe('group');
    expect(recovered[2].deletionBatchId).toBe(olderBatch);
    expect(businessSchema.safeParse({ ...emptyBusiness(now), todos: recovered }).success).toBe(true);
  });
  it('detaches a child restored alone and never places active tasks under deleted parents', () => {
    const trashed = trashTodo([task('group', { isGroup: true }), task('child', { parentId: 'group' })], 'group', now, batch);
    const recovered = restoreTodo(trashed, 'child', now);
    expect(recovered[0].deletedAt).toBeTruthy();
    expect(recovered[1].deletedAt).toBeUndefined();
    expect(recovered[1].parentId).toBeUndefined();
    expect(businessSchema.safeParse({ ...emptyBusiness(now), todos: recovered }).success).toBe(true);
    expect(businessSchema.safeParse({ ...emptyBusiness(now), todos: [trashed[0], { ...recovered[1], parentId: 'group' }] }).success).toBe(false);
  });
  it('round-trips tombstones, goal history, notes and time via exported/imported backups', () => {
    const original = task('goal', { goalStartDate: '2026-09-10', goalEndDate: '2026-09-30',
      completionDates: ['2026-09-11', '2026-09-12'], notes: 'Synthetic notes', completionNotes: 'Synthetic journal',
      reminderTime: '12:00', timeEntries: [{ id: 'entry', startTime: now, duration: 300 }], totalTimeSpent: 300 });
    const data = { ...emptyBusiness(now), todos: trashTodo([original], original.id, now, batch) };
    const backup = backupSchema.parse({ format: 'todo-widget.backup', version: 1, exportedAt: now, timeZone: 'Asia/Shanghai', business: data });
    const imported = parseBackup(JSON.stringify(backup));
    expect(imported.business).toEqual(data);
    const recovered = restoreTodo(imported.business.todos, original.id, now)[0];
    expect(recovered).toMatchObject({ ...original, reminderTime: undefined });
    expect(recovered.deletionBatchId).toBeUndefined();
  });
  it('preserves completion status on recovery, but cancels all old reminder modes', () => {
    const original = task('done', { completed: true, completionDates: ['2026-09-13'], reminderAt: now, notifyAt: '2026-09-13T12:00', notifyDate: '2026-09-13' });
    const recovered = restoreTodo(trashTodo([original], original.id, now, batch), original.id, now)[0];
    expect(recovered.completed).toBe(true);
    expect(recovered.completionDates).toEqual(['2026-09-13']);
    for (const field of ['reminderAt', 'reminderTime', 'notifyAt', 'notifyDate'] as const) expect(recovered[field]).toBeUndefined();
  });
  it('leaves missing/deleted/previously restored records unchanged on repeated operations', () => {
    const rows = [task('a')];
    expect(trashTodo(rows, 'missing', now, batch)).toBe(rows);
    expect(restoreTodo(rows, 'a', now)).toBe(rows);
    const deleted = trashTodo(rows, 'a', now, batch);
    expect(trashTodo(deleted, 'a', now, olderBatch)).toBe(deleted);
  });
});

describe('completion undo semantics', () => {
  it('undoes only the selected goal day, not the other completion dates or time entries', () => {
    const goal = task('goal', { goalStartDate: '2026-09-10', goalEndDate: '2026-09-30', completionDates: ['2026-09-11', '2026-09-13'], totalTimeSpent: 50 });
    const result = undoCompletion([goal], 'goal', '2026-09-11', now)[0];
    expect(result.completionDates).toEqual(['2026-09-13']);
    expect(result.totalTimeSpent).toBe(50);
    expect(undoCompletion([result], 'goal', '2026-09-12', now)).toEqual([result]);
  });
  it('reopens a parent on child undo, and reopens children on explicit group undo', () => {
    const rows = [task('group', { isGroup: true, completed: true }), task('child', { parentId: 'group', completed: true }),
      task('deleted', { parentId: 'group', completed: true, deletedAt: now, deletionBatchId: batch })];
    for (const id of ['child', 'group']) {
      const recovered = undoCompletion(rows, id, '2026-09-13', now);
      expect(recovered.map(todo => todo.completed)).toEqual([false, false, true]);
    }
  });
});
