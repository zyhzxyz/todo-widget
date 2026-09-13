import { snapshotSchema, type Snapshot } from '../../shared/domain';

export class RemoteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function normalizeServerUrl(raw: string): string {
  const url = new URL(raw.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('远程连接必须使用 HTTPS；仅本机 localhost 允许 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('服务器地址不能包含用户名、密码、查询参数或片段。');
  return url.toString().replace(/\/+$/, '');
}
export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  constructor(baseUrl: string, token: string, transport: typeof fetch = fetch) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    this.token = token;
    this.transport = transport;
  }
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await this.transport(`${this.baseUrl}/api/v1${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit',
      });
      const data = await response.json();
      if (!response.ok) throw new RemoteError(response.status, typeof data.error === 'string' ? data.error : 'HTTP_ERROR', typeof data.message === 'string' ? data.message : `HTTP ${response.status}`);
      return data as T;
    } finally { clearTimeout(timeout); }
  }
  async state(): Promise<Snapshot> { return snapshotSchema.parse(await this.request('/state')); }
}
