import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

export const DEFAULT_LISTS = [
  { id: 'list-inbox', name: '待办' },
  { id: 'list-today', name: '今天' },
  { id: 'list-important', name: '重要' },
] as const;
export const idSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { Temporal.PlainDate.from(value); return true; } catch { return false; }
}, 'Invalid calendar date');
export const instantSchema = z.string().max(40).refine(value => {
  try { Temporal.Instant.from(value); return true; } catch { return false; }
}, 'Expected ISO timestamp with Z or explicit UTC offset');
export const wallTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).refine(value => {
  try { Temporal.PlainDateTime.from(value); return true; } catch { return false; }
}, 'Invalid local date/time');
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const secondsSchema = z.number().int().min(0).max(315_576_000);
export const timeEntrySchema = z.object({
  id: idSchema.optional(),
  startTime: instantSchema,
  endTime: instantSchema.optional(),
  duration: secondsSchema,
}).strict().refine(e => !e.endTime || Date.parse(e.endTime) >= Date.parse(e.startTime), 'End precedes start');
export const todoSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  completed: z.boolean(),
  priority: z.enum(['low', 'normal', 'high', 'notify']),
  listId: idSchema,
  dueDate: dateSchema.optional(),
  notifyDate: dateSchema.optional(),
  notifyAt: wallTimeSchema.optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  goalStartDate: dateSchema.optional(),
  goalEndDate: dateSchema.optional(),
  reminderAt: instantSchema.optional(),
  reminderTime: timeOfDaySchema.optional(),
  completionDates: z.array(dateSchema).max(20_000),
  notes: z.string().max(50_000).optional(),
  completionNotes: z.string().max(50_000).optional(),
  isGroup: z.boolean(),
  parentId: idSchema.optional(),
  collapsed: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  deletedAt: instantSchema.optional(),
  deletionBatchId: z.string().uuid().optional(),
  timeEntries: z.array(timeEntrySchema).max(20_000),
  totalTimeSpent: secondsSchema,
}).strict().superRefine((todo, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!!todo.deletedAt !== !!todo.deletionBatchId) issue('Deletion timestamp and batch must be provided together');
  if (!!todo.goalStartDate !== !!todo.goalEndDate) issue('Both goal dates are required');
  if (todo.goalStartDate && todo.goalEndDate && todo.goalStartDate > todo.goalEndDate) issue('Goal range is reversed');
  if (todo.startDate && todo.endDate && todo.startDate > todo.endDate) issue('Task range is reversed');
  if (todo.reminderTime && todo.reminderAt) issue('Choose either a one-time reminder or a daily reminder');
  if (todo.reminderTime && !todo.goalStartDate) issue('Daily reminder requires a daily goal');
  if (todo.isGroup && (todo.goalStartDate || todo.parentId || todo.reminderAt || todo.reminderTime)) issue('Groups cannot be goals, children, or have reminders');
  if (new Set(todo.completionDates).size !== todo.completionDates.length) issue('Duplicate completion day');
  if (todo.goalStartDate && todo.goalEndDate && todo.completionDates.some(d => d < todo.goalStartDate! || d > todo.goalEndDate!)) issue('Goal completion outside its date range');
  const timeIds = todo.timeEntries.flatMap(e => e.id ? [e.id] : []);
  if (new Set(timeIds).size !== timeIds.length) issue('Duplicate time entry ID');
});
export const listSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(200), createdAt: instantSchema }).strict();
export const diarySchema = z.object({
  id: idSchema, date: dateSchema, content: z.string().max(200_000), createdAt: instantSchema, updatedAt: instantSchema,
}).strict();
export const businessSchema = z.object({
  lists: z.array(listSchema).min(3).max(200),
  todos: z.array(todoSchema).max(10_000),
  diary: z.array(diarySchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const key of ['lists', 'todos', 'diary'] as const) {
    if (new Set(state[key].map(v => v.id)).size !== state[key].length) issue(`Duplicate ${key} ID`);
  }
  const lists = new Set(state.lists.map(l => l.id));
  if (DEFAULT_LISTS.some(l => !lists.has(l.id))) issue('Default lists must be retained');
  const todos = new Map(state.todos.map(t => [t.id, t]));
  for (const todo of state.todos) {
    if (!lists.has(todo.listId)) issue(`Task ${todo.id} references missing list`);
    if (todo.parentId) {
      const parent = todos.get(todo.parentId);
      if (!parent?.isGroup || parent.listId !== todo.listId || parent.id === todo.id) issue(`Invalid parent for task ${todo.id}`);
      if (parent?.deletedAt && !todo.deletedAt) issue(`Active task ${todo.id} cannot belong to a deleted group`);
    }
  }
  if (new Set(state.diary.map(d => d.date)).size !== state.diary.length) issue('Only one diary entry per day');
});
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('todo.put'), value: todoSchema }).strict(),
  z.object({ type: z.literal('todo.delete'), id: idSchema }).strict(),
  z.object({ type: z.literal('list.put'), value: listSchema }).strict(),
  z.object({ type: z.literal('list.delete'), id: idSchema }).strict(),
  z.object({ type: z.literal('diary.put'), value: diarySchema }).strict(),
  z.object({ type: z.literal('diary.delete'), id: idSchema }).strict(),
]);
export const mutationSchema = z.object({
  mutationId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(operationSchema).min(1).max(20_000),
}).strict();
export const backupSchema = z.object({
  format: z.literal('todo-widget.backup'),
  version: z.literal(1),
  exportedAt: instantSchema,
  timeZone: z.string().max(100),
  business: businessSchema,
  deviceSettings: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const snapshotSchema = z.object({ ...businessSchema.shape, revision: z.number().int().nonnegative(), timeZone: z.string() }).strict().refine(s => businessSchema.safeParse({ lists: s.lists, todos: s.todos, diary: s.diary }).success, 'Invalid server snapshot');
export type Todo = z.infer<typeof todoSchema>;
export type TodoList = z.infer<typeof listSchema>;
export type DiaryEntry = z.infer<typeof diarySchema>;
export type TimeEntry = z.infer<typeof timeEntrySchema>;
export type Priority = Todo['priority'];
export type BusinessData = z.infer<typeof businessSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
export type Backup = z.infer<typeof backupSchema>;
export type Snapshot = BusinessData & { revision: number; timeZone: string };

export function emptyBusiness(now = new Date().toISOString()): BusinessData {
  return { lists: DEFAULT_LISTS.map(l => ({ ...l, createdAt: now })), todos: [], diary: [] };
}

/** Record-level changes + revision guard, never blind replacement of a stale whole snapshot. */
export function diffBusiness(before: BusinessData, after: BusinessData): Operation[] {
  const operations: Operation[] = [];
  for (const [key, kind] of [['lists', 'list'], ['todos', 'todo'], ['diary', 'diary']] as const) {
    const old = new Map(before[key].map(v => [v.id, v]));
    const next = new Map(after[key].map(v => [v.id, v]));
    for (const id of old.keys()) if (!next.has(id)) operations.push({ type: `${kind}.delete`, id });
    for (const [id, value] of next) {
      if (JSON.stringify(value) !== JSON.stringify(old.get(id))) operations.push({ type: `${kind}.put`, value } as Operation);
    }
  }
  return operations;
}

export function applyOperations(before: BusinessData, operations: Operation[]): BusinessData {
  const result = structuredClone({ lists: before.lists, todos: before.todos, diary: before.diary });
  for (const op of operations) {
    const key = op.type.startsWith('todo.') ? 'todos' : op.type.startsWith('list.') ? 'lists' : 'diary';
    const rows = result[key] as Array<Todo | TodoList | DiaryEntry>;
    const id = 'id' in op ? op.id : op.value.id;
    const index = rows.findIndex(row => row.id === id);
    if ('value' in op) {
      if (index < 0) { if (key === 'todos') rows.unshift(op.value); else rows.push(op.value); } else rows[index] = op.value;
    } else if (index >= 0) rows.splice(index, 1);
  }
  return businessSchema.parse(result);
}
