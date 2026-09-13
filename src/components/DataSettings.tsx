import { useState, type ChangeEvent } from 'react';
import type { Backup } from '../../shared/domain';
import type { BusinessStore, DataView, ImportPreview, ServerStatus } from '../data/businessStore';
import { parseBackup, saveBackupFile, saveJsonFile } from '../data/backup';

const labels = { 'storage-error': '存储异常 · 只读保护', local: '本地模式', connecting: '正在连接 · 只读', online: '服务器已连接', saving: '正在保存 · 暂停编辑', offline: '连接中断 · 只读', locked: '需要认证 · 只读', conflict: '保存冲突 · 只读' };
export function DataStatusBanner({ view, onOpen }: { view: DataView; onOpen: () => void }) {
  if (view.mode === 'local' && !view.error && !view.timerRecoveryCount) return null;
  return <button className={`data-status ${view.status}`} onClick={onOpen} type="button" aria-live="polite">
    <strong>{labels[view.status]}{view.hasPending ? ' · 有未确认修改' : ''}{view.timerRecoveryCount ? ` · ${view.timerRecoveryCount} 段待补记计时` : ''}</strong>
    <small>{view.error || `${view.timeZone} · revision ${view.revision ?? '—'} · 点击管理数据`}</small>
  </button>;
}
export function DataSettings({ store, view, timerActive }: { store: BusinessStore; view: DataView; timerActive: boolean }) {
  const [url, setUrl] = useState(view.baseUrl || 'http://127.0.0.1:3210');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [importData, setImportData] = useState<{ backup: Backup; preview: ImportPreview } | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const disabled = busy || view.status === 'saving' || view.status === 'connecting';
  async function run(action: () => Promise<unknown> | unknown) {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败，请检查连接。'); }
    finally { setBusy(false); }
  }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setImportData(null);
    await run(async () => {
      if (file.size > 16 * 1024 * 1024) throw new Error('备份超过 16 MiB，请分步迁移或联系维护者。');
      const backup = parseBackup(await file.text(), view.timeZone);
      const preview = await store.previewImport(backup);
      setImportData({ backup, preview });
    });
  }
  return <section className="data-settings" aria-label="数据与服务器">
    <h3>数据与服务器</h3>
    <p>{labels[view.status]}{view.mode === 'remote' ? ` · ${view.timeZone}` : ' · 原数据保留在这台设备'}</p>
    <div className="data-actions">
      <button type="button" disabled={busy} onClick={() => void run(() => saveBackupFile(store.makeBackup(), view.hasPending ? 'todo-widget-unsaved' : 'todo-widget'))}>导出当前数据</button>
      <button type="button" disabled={busy} onClick={() => void run(() => saveBackupFile(store.makeBackup('local'), 'todo-widget-original-local'))}>导出原本地数据</button>
      <button type="button" disabled={busy} onClick={() => void run(() => saveJsonFile(store.rawLocalBackup(), 'todo-widget-raw-local'))}>导出本机原始存储</button>
      {view.hasPending && <button type="button" disabled={busy} onClick={() => void run(() => saveJsonFile(store.recoveryBundle(), 'todo-widget-unsaved-recovery'))}>导出未确认原始记录</button>}
    </div>
    <label>服务器地址<input type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://todo.example.com" disabled={disabled || timerActive} /></label>
    <label>桌面 token<input type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder="不要使用 bot token" disabled={disabled || timerActive} /></label>
    <small>token 仅在当前会话保存，重启后需重新输入；不是系统密码保险库。公网必须 HTTPS。</small>
    <div className="data-actions">
      <button type="button" disabled={disabled || timerActive || !token.trim()} onClick={() => void run(async () => { await store.connect(url, token); setToken(''); setImportData(null); setServerStatus(null); })}>连接服务器</button>
      {view.mode === 'remote' && <button type="button" disabled={disabled || timerActive || view.hasPending || view.timerRecoveryCount > 0} onClick={() => void run(() => { store.useLocal(); setImportData(null); setServerStatus(null); })}>切回原本地模式</button>}
    </div>
    {timerActive && <p className="data-warning">请先停止计时，再切换数据源或导入。</p>}
    {view.mode === 'remote' && <>
      <p className="data-explanation">原本地数据不会上传或被覆盖。机器人创建的任务约 5 秒内刷新；断网只能查看缓存。</p>
      <div className="data-actions">
        <button type="button" disabled={disabled} onClick={() => void run(() => store.retry())}>{view.hasPending ? '重试原操作' : '刷新连接'}</button>
        {view.hasPending && <button type="button" disabled={disabled} onClick={() => {
          if (window.confirm('建议先导出当前数据。放弃本次未确认修改并重新读取服务器？已在服务器提交的操作不会被撤销。')) void run(() => store.discardPending());
        }}>放弃未确认修改</button>}
      </div>
      <label className="backup-import">迁移 JSON 到空服务器
        <input type="file" accept="application/json,.json" disabled={disabled || timerActive || view.status !== 'online' || view.hasPending} onChange={event => void selectFile(event)} />
      </label>
      {importData && <div className="import-preview">
        <p>预检：{importData.preview.counts.tasks} 个任务 / {importData.preview.counts.lists} 个清单 / {importData.preview.counts.diary} 篇日记</p>
        <p>{importData.preview.canImport ? '服务器为空。导入不会删除原本地文件，也不会迁移窗口设置。' : '服务器已有数据，拒绝覆盖；请使用新的空数据库迁移。'}</p>
        <button type="button" disabled={disabled || timerActive || !importData.preview.canImport || view.status !== 'online'} onClick={() => {
          if (window.confirm('确认将预检的业务数据导入空服务器？')) void run(async () => { await store.importBackup(importData.backup, importData.preview.revision); setImportData(null); });
        }}>确认导入到服务器</button>
      </div>}
      <div className="data-actions"><button type="button" disabled={disabled || view.status !== 'online'} onClick={() => void run(async () => { setServerStatus(await store.serverStatus()); })}>查看 QQ 提醒状态</button></div>
      {serverStatus && <div className="reminder-status">
        <p>{serverStatus.binding ? `绑定 QQ：${serverStatus.binding.senderId}（${serverStatus.binding.platformId}）` : '未绑定。请先配置 AstrBot 插件，再由允许的 QQ 私聊发送 /待办 绑定。'}</p>
        <small>{Object.entries(serverStatus.reminders).map(([state, count]) => `${state}: ${count}`).join(' · ') || '暂无提醒记录'}</small>
        {serverStatus.binding && <button type="button" disabled={disabled} onClick={() => {
          if (window.confirm('解除 QQ 提醒绑定？任务数据不受影响。')) void run(async () => { await store.unbind(); setServerStatus(await store.serverStatus()); });
        }}>解除 QQ 绑定</button>}
      </div>}
    </>}
    {view.timerRecoveryCount > 0 && <div className="timer-recovery">
      <p>{view.timerRecoveryCount} 段计时有本机恢复副本（含正在运行的计时）。停止后可补记，不自动加到别的任务上。</p>
      <div className="data-actions">
        <button type="button" disabled={disabled || timerActive || !store.canWrite} onClick={() => void run(() => store.recoverTimers())}>补记到原任务</button>
        <button type="button" disabled={busy} onClick={() => void run(() => saveJsonFile(store.getTimerRecoveries(), 'todo-widget-timer-recovery'))}>导出计时恢复记录</button>
        <button type="button" disabled={disabled || timerActive || view.hasPending} onClick={() => {
          if (window.confirm('建议先导出。确定放弃本机计时恢复副本？未保存的计时将不再补记，服务器记录不受影响。')) void run(() => store.discardTimerRecoveries());
        }}>放弃计时恢复副本</button>
      </div>
    </div>}
    {(notice || view.error) && <p className="data-warning" role="alert">{notice || view.error}</p>}
  </section>;
}
