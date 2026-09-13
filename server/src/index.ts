import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
process.umask(0o077);
const config = readConfig();
const app = await buildApp(config, { logger: true });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: config.host, port: config.port });
