import { resolve } from 'node:path';
import { validateTimeZone } from '../../shared/time.ts';
export type ServerConfig = { dbPath: string; timeZone: string; appToken: string; botToken: string; host: string; port: number; origins: string[] };
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const appToken = env.TODO_APP_TOKEN ?? '';
  const botToken = env.TODO_BOT_TOKEN ?? '';
  if (appToken.length < 32 || botToken.length < 32 || /\s/.test(appToken + botToken) || appToken === botToken) throw new Error('Set distinct TODO_APP_TOKEN and TODO_BOT_TOKEN (at least 32 characters each; generate randomly)');
  const port = Number(env.TODO_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TODO_PORT');
  return {
    dbPath: resolve(env.TODO_DB_PATH ?? '/var/lib/todo-widget/todo.db'),
    timeZone: validateTimeZone(env.TODO_TIMEZONE ?? 'Asia/Shanghai'),
    appToken, botToken, host: env.TODO_HOST ?? '127.0.0.1', port,
    origins: (env.TODO_CORS_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://127.0.0.1:1420,http://localhost:1420').split(',').map(s => s.trim()).filter(Boolean),
  };
}
