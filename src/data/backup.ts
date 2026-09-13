import { backupSchema, emptyBusiness, type Backup } from '../../shared/domain';

/** Current versioned JSON, or an explicit object holding the four old localStorage keys. */
export function parseBackup(raw: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Backup {
  const data: unknown = JSON.parse(raw);
  const current = backupSchema.safeParse(data);
  if (current.success) return current.data;
  if (!data || typeof data !== 'object' || !('todo-widget.todos' in data)) throw new Error('不是支持的备份格式。请先在设置中导出 JSON，不要上传 LevelDB 文件。');
  const record = data as Record<string, unknown>;
  const get = (key: string, fallback: unknown) => {
    const value = record[key]; return value === undefined ? fallback : typeof value === 'string' ? JSON.parse(value) : value;
  };
  const defaults = emptyBusiness();
  // Legacy partial objects should first be opened/exported by the desktop normalizer;
  // do not silently drop malformed records or invent completion history here.
  const lists = get('todo-widget.lists', defaults.lists);
  return backupSchema.parse({
    format: 'todo-widget.backup', version: 1, exportedAt: new Date().toISOString(), timeZone,
    business: { todos: get('todo-widget.todos', []), lists, diary: get('todo-widget.diary', []) },
    deviceSettings: get('todo-widget.settings', {}),
  });
}

export async function saveBackupFile(backup: Backup, label = 'todo-widget'): Promise<void> {
  return saveJsonFile(backup, label);
}

export async function saveJsonFile(value: unknown, label: string): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  const name = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.backup.json`;
  if ('__TAURI_INTERNALS__' in window) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: name, filters: [{ name: 'Todo Widget JSON backup', extensions: ['json'] }] });
    if (path) await writeTextFile(path, content);
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
