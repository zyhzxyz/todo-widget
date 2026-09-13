import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { applyOperations, backupSchema, businessSchema, dateSchema, idSchema, instantSchema, mutationSchema, timeOfDaySchema, type BusinessData, type Snapshot, type Todo } from '../../shared/domain.ts';
import { dateInZone } from '../../shared/time.ts';
import { ApiError } from './errors.ts';
import { Store } from './store.ts';
import type { ServerConfig } from './config.ts';

declare module 'fastify' { interface FastifyRequest { actor: 'app' | 'bot' | '' } }
const businessOnly = (state: BusinessData): BusinessData => ({ lists: state.lists, todos: state.todos, diary: state.diary });
const hashToken = (token: string) => createHash('sha256').update(token).digest();
const envelope = { mutationId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(500), listId: idSchema.default('list-inbox'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'), notes: z.string().max(50_000).optional(),
  dueDate: dateSchema.optional(), goalStartDate: dateSchema.optional(), goalEndDate: dateSchema.optional(),
  reminderAt: instantSchema.optional(), reminderTime: timeOfDaySchema.optional(),
}).strict();
const botActionSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('create'), task: createTaskSchema }).strict(),
  z.object({ ...envelope, action: z.literal('complete'), taskId: idSchema, completed: z.boolean(), date: dateSchema.optional() }).strict(),
  z.object({ ...envelope, action: z.literal('remind'), taskId: idSchema, reminderAt: instantSchema.nullable().optional(), reminderTime: timeOfDaySchema.nullable().optional() }).strict().refine(v => v.reminderAt !== undefined || v.reminderTime !== undefined, 'Specify reminderAt or reminderTime').refine(v => !(v.reminderAt && v.reminderTime), 'Choose one reminder mode'),
]);
const leaseParams = z.object({ id: z.string().regex(/^[a-f0-9]{40}$/) });
const leaseBody = z.object({ leaseToken: z.string().uuid() }).strict();
function botTask(todo: Todo) {
  const { timeEntries: _time, completionNotes: _journal, ...task } = todo;
  return task;
}
function botView(state: Snapshot, now: number) {
  return { revision: state.revision, timeZone: state.timeZone, serverTime: new Date(now).toISOString(), today: dateInZone(now, state.timeZone), lists: state.lists, tasks: state.todos.filter(todo => !todo.deletedAt).map(botTask) };
}

export async function buildApp(config: ServerConfig, options: { store?: Store; logger?: boolean } = {}) {
  const store = options.store ?? new Store(config.dbPath, config.timeZone);
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: options.logger ? { redact: ['req.headers.authorization'], level: 'info' } : false, requestTimeout: 30_000 });
  app.decorateRequest('actor', '');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (origin && !config.origins.includes(origin)) throw new ApiError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
  });
  await app.register(cors, { origin: config.origins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const appHash = hashToken(config.appToken), botHash = hashToken(config.botToken);
  app.addHook('onRequest', async request => {
    if (request.method === 'OPTIONS' || request.routeOptions.url === '/healthz') return;
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 1024) throw new ApiError(401, 'UNAUTHORIZED', 'A Bearer token is required');
    const tokenHash = hashToken(authorization.slice(7));
    const isApp = timingSafeEqual(tokenHash, appHash), isBot = timingSafeEqual(tokenHash, botHash);
    if (!isApp && !isBot) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credential');
    request.actor = isApp ? 'app' : 'bot';
    const botRoute = request.routeOptions.url?.startsWith('/api/v1/bot/');
    if ((botRoute && request.actor !== 'bot') || (!botRoute && request.actor !== 'app')) throw new ApiError(403, 'FORBIDDEN', 'Credential does not have this capability');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'Invalid data; nothing was written', issues: error.issues.slice(0, 12).map(i => ({ path: i.path, message: i.message })) });
    } else if (error instanceof ApiError) {
      reply.status(error.statusCode).send({ error: error.code, message: error.message });
    } else {
      const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
      if (status >= 400 && status < 500) reply.status(status).send({ error: 'BAD_REQUEST', message: status === 429 ? 'Too many requests' : 'Request rejected' });
      else { app.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Request failed (details redacted)'); reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Server error; retry with the same operation ID' }); }
    }
  });
  app.get('/healthz', async () => ({ ok: true, service: 'todo-widget-api', version: 1 }));
  app.get('/api/v1/state', async () => store.snapshot());
  app.post('/api/v1/mutations', async request => {
    const body = mutationSchema.parse(request.body);
    return store.mutate('app', body.mutationId, body.expectedRevision, body, current => ({ business: applyOperations(businessOnly(current), body.operations) }));
  });
  app.get('/api/v1/export', async () => ({ format: 'todo-widget.backup', version: 1, exportedAt: new Date(store.now()).toISOString(), timeZone: store.timeZone, business: businessOnly(store.snapshot()) }));
  const importSchema = z.object({ ...envelope, backup: backupSchema }).strict();
  app.post('/api/v1/import/preview', async request => {
    const backup = backupSchema.parse(request.body);
    if (backup.timeZone !== store.timeZone) throw new ApiError(422, 'TIMEZONE_MISMATCH', 'Backup timezone must match server; calendar dates will not be guessed');
    const canImport = store.isEmpty();
    return { canImport, revision: store.revision(), counts: { tasks: backup.business.todos.length, lists: backup.business.lists.length, diary: backup.business.diary.length }, note: 'Device settings stay local. Original local data will not be removed. Historical completion dates are unchanged.' };
  });
  app.post('/api/v1/import', async request => {
    const body = importSchema.parse(request.body);
    if (body.backup.timeZone !== store.timeZone) throw new ApiError(422, 'TIMEZONE_MISMATCH', 'Backup and server timezone differ');
    return store.mutate('app', body.mutationId, body.expectedRevision, body, () => {
      if (!store.isEmpty()) throw new ApiError(409, 'SERVER_NOT_EMPTY', 'Import is allowed only into a pristine server');
      return { business: body.backup.business };
    });
  });
  app.get('/api/v1/status', async () => ({ timeZone: store.timeZone, revision: store.revision(), binding: store.getBinding(), reminders: store.reminderStats() }));
  app.delete('/api/v1/binding', async () => { store.unbind(); return { unbound: true }; });

  app.get('/api/v1/bot/tasks', async () => botView(store.snapshot(), store.now()));
  app.post('/api/v1/bot/actions', async request => {
    const body = botActionSchema.parse(request.body);
    const changed = store.mutate('bot', body.mutationId, body.expectedRevision, body, current => {
      const business = businessOnly(current);
      const now = new Date(store.now()).toISOString();
      let taskId: string;
      if (body.action === 'create') {
        taskId = randomUUID();
        business.todos.unshift({ ...body.task, id: taskId, completed: false, completionDates: [], isGroup: false, collapsed: false, createdAt: now, updatedAt: now, timeEntries: [], totalTimeSpent: 0 });
      } else {
        taskId = body.taskId;
        const todo = business.todos.find(t => t.id === taskId);
        if (!todo || todo.deletedAt) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task ID does not exist; do not guess an ID');
        if (todo.isGroup) throw new ApiError(422, 'GROUP_NOT_SUPPORTED', 'Modify group tasks from the desktop');
        if (body.action === 'complete') {
          const date = body.date ?? dateInZone(store.now(), store.timeZone);
          if (todo.goalStartDate) {
            if (date < todo.goalStartDate || date > todo.goalEndDate!) throw new ApiError(422, 'OUTSIDE_GOAL_RANGE', 'Completion date is outside the goal range');
            todo.completionDates = body.completed ? [...new Set([...todo.completionDates, date])] : todo.completionDates.filter(d => d !== date);
          } else {
            todo.completed = body.completed;
            if (body.completed) todo.completionDates = [...new Set([...todo.completionDates, date])];
          }
        } else {
          if (body.reminderAt !== undefined) { todo.reminderAt = body.reminderAt ?? undefined; todo.notifyAt = undefined; todo.notifyDate = undefined; }
          if (body.reminderTime !== undefined) {
            todo.reminderTime = body.reminderTime ?? undefined;
            if (body.reminderTime) { todo.reminderAt = undefined; todo.notifyAt = undefined; todo.notifyDate = undefined; }
          }
          if (body.reminderAt) todo.reminderTime = undefined;
        }
        todo.updatedAt = now;
      }
      return { business: businessSchema.parse(business), result: { taskId } };
    });
    const todo = changed.snapshot.todos.find(t => t.id === changed.result.taskId);
    return { ok: true, revision: changed.snapshot.revision, committedRevision: changed.committedRevision, replayed: changed.replayed, timeZone: store.timeZone, taskId: changed.result.taskId, task: todo && !todo.deletedAt ? botTask(todo) : null };
  });
  const bindingSchema = z.object({ senderId: z.string().regex(/^\d{5,20}$/), platformId: z.string().min(1).max(128), session: z.string().min(1).max(512) }).strict();
  app.get('/api/v1/bot/binding', async () => ({ binding: store.getBinding() }));
  app.post('/api/v1/bot/binding', async request => ({ binding: store.bind(bindingSchema.parse(request.body)) }));
  app.delete('/api/v1/bot/binding', async () => { store.unbind(); return { unbound: true }; });
  app.post('/api/v1/bot/reminders/claim', async request => {
    const body = z.object({ limit: z.number().int().min(1).max(10).default(1) }).strict().parse(request.body ?? {});
    return { jobs: store.claim(body.limit) };
  });
  app.post('/api/v1/bot/reminders/:id/validate', async request => {
    const { id } = leaseParams.parse(request.params);
    const body = leaseBody.parse(request.body);
    return { valid: store.validateLease(id, body.leaseToken) };
  });
  app.post('/api/v1/bot/reminders/:id/ack', async request => {
    const { id } = leaseParams.parse(request.params);
    const body = leaseBody.extend({ messageId: z.string().regex(/^-?\d{1,30}$/).refine(value => BigInt(value) !== 0n, 'A nonzero OneBot message ID is required') }).parse(request.body);
    return store.settle(id, body.leaseToken, body.messageId);
  });
  app.post('/api/v1/bot/reminders/:id/nack', async request => {
    const { id } = leaseParams.parse(request.params);
    const body = leaseBody.parse(request.body);
    return store.settle(id, body.leaseToken);
  });
  app.addHook('onClose', async () => { if (!options.store) store.close(); });
  await app.ready();
  return app;
}
