import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { BusinessStore } from "../src/data/businessStore";
import { emitTo, listen } from "@tauri-apps/api/event";
import { readFileSync } from "node:fs";

const native = vi.hoisted(() => ({
  main: {
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
  },
  getByLabel: vi.fn().mockResolvedValue(null),
  listeners: new Map<string, { callback: (event: { payload: unknown }) => void; target?: { kind: string; label?: string } }>(),
  updates: [] as Array<{ sessionId: string; elapsed: number; paused: boolean; theme: { rgb: string; accent: string } }>,
  windows: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => native.main,
  currentMonitor: vi.fn().mockResolvedValue(null),
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void, options?: { target: { kind: string; label?: string } }) => {
    native.listeners.set(name, { callback, target: options?.target });
    return () => native.listeners.delete(name);
  }),
  // Match Tauri's actual routing: emitTo(label) excludes global/Any listeners.
  emitTo: vi.fn(async (label: string, name: string, payload: unknown) => {
    if (name === "timer-update") native.updates.push(payload as typeof native.updates[number]);
    const entry = native.listeners.get(name);
    if (entry?.target?.label === label && entry.target.kind !== "Any") entry.callback({ payload });
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = (...args: unknown[]) => native.getByLabel(...args);
    close = vi.fn().mockResolvedValue(undefined);
    emit = vi.fn().mockResolvedValue(undefined);
    setPosition = vi.fn().mockResolvedValue(undefined);
    show = vi.fn().mockResolvedValue(undefined);
    constructor() { native.windows.push(this); }
    once = vi.fn(async (event: string, handler: () => void) => {
      if (event === "tauri://created") await Promise.resolve().then(handler);
      return () => {};
    });
  },
}));

const key = "todo-widget.todos";
const makeTodo = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `任务${id}`, priority: "normal", listId: "list-today", completed: false,
  ...extra,
});
const seed = (todos?: unknown[], settings = {}) => {
  if (todos !== undefined) localStorage.setItem(key, JSON.stringify(todos));
  localStorage.setItem("todo-widget.settings", JSON.stringify({
    eyeCare: false, topDefaultMigrated: true, activeListId: "list-today", ...settings,
  }));
};
const stored = () => JSON.parse(localStorage.getItem(key) ?? "[]");
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function timerAction(title: string, action: "开始计时" | "停止计时") {
  fireEvent.contextMenu(within(document.querySelector(".todo-list")!).getByText(title));
  fireEvent.click(screen.getByRole("button", { name: action }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00+08:00"));
  localStorage.clear();
  sessionStorage.clear();
  native.listeners.clear();
  native.windows.length = 0;
  native.updates.length = 0;
  native.getByLabel.mockReset().mockResolvedValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.getElementById("test-timer-host")?.remove();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  document.documentElement.style.removeProperty("--widget-tint");
  document.documentElement.style.removeProperty("--accent");
  cleanup();
  vi.useRealTimers();
});

describe("storage initialization", () => {
  it("keeps an intentionally empty task store empty across mounts", async () => {
    seed([]);
    const first = render(<App />);
    await flush();
    expect(stored()).toEqual([]);
    first.unmount();
    render(<App />);
    await flush();
    expect(stored()).toEqual([]);
  });

  it("still supplies sample tasks for a genuinely new installation", async () => {
    seed();
    render(<App />);
    await flush();
    expect(stored()).toHaveLength(5);
  });
});

describe("time-dependent task views", () => {
  it("shows a scheduled task when due without any click or tab switch", async () => {
    seed([makeTodo("提醒", { priority: "notify", notifyDate: "2026-09-13", notifyAt: "2026-09-13T12:01" })]);
    render(<App />);
    expect(screen.queryByText("任务提醒")).toBeNull();
    await advance(61_000);
    expect(screen.getByText("任务提醒")).toBeTruthy();
    expect(document.querySelector("footer")?.textContent).toMatch(/^1 /);
  });

  it("reopens a daily goal after local midnight and updates the open count", async () => {
    vi.setSystemTime(new Date("2026-09-13T23:59:58+08:00"));
    seed([makeTodo("每日", { goalStartDate: "2026-09-13", goalEndDate: "2026-09-15", completionDates: ["2026-09-13"] })]);
    render(<App />);
    expect(screen.queryByText("任务每日")).toBeNull();
    await advance(3000);
    expect(screen.getByText("任务每日")).toBeTruthy();
    expect(document.querySelector("footer")?.textContent).toMatch(/^1 /);
  });

  it("refreshes overdue tasks immediately on resume/focus", async () => {
    seed([makeTodo("恢复", { startDate: "2026-09-14" })]);
    render(<App />);
    expect(screen.queryByText("任务恢复")).toBeNull();
    vi.setSystemTime(new Date("2026-09-14T09:00:00+08:00"));
    fireEvent.focus(window);
    expect(screen.getByText("任务恢复")).toBeTruthy();
  });
});

describe("native always-on-top preference", () => {
  it("does not undo a saved pin preference at startup", async () => {
    seed([], { alwaysOnTop: true });
    render(<App />);
    await flush();
    expect(native.main.setAlwaysOnTop.mock.calls.map(call => call[0])).toEqual([true]);
  });

  it.each([true, false])("restores pin=%s after dismissing the eye-care reminder", async pinned => {
    seed([], { alwaysOnTop: pinned, eyeCare: true, eyeCareMinutes: 1 });
    render(<App />);
    await advance(60_000);
    expect(native.main.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(native.main.setAlwaysOnTop).toHaveBeenLastCalledWith(pinned);
  });
});

describe("timer session ownership", () => {
  it("saves A before switching to B, and saves B independently", async () => {
    seed([makeTodo("A"), makeTodo("B")]);
    render(<App />);
    await timerAction("任务A", "开始计时");
    await advance(65_000);
    await timerAction("任务B", "开始计时");
    await advance(5000);
    await timerAction("任务B", "停止计时");
    const [a, b] = stored();
    expect(a.totalTimeSpent).toBe(65);
    expect(a.timeEntries).toHaveLength(1);
    expect(a.timeEntries[0].duration).toBe(65);
    expect(b.totalTimeSpent).toBe(5);
    expect(b.timeEntries).toHaveLength(1);
  });

  it("excludes paused time but preserves the original session start", async () => {
    seed([makeTodo("A")]);
    render(<App />);
    await timerAction("任务A", "开始计时");
    await advance(10_000);
    await act(async () => { await emitTo("main", "timer-set-paused", { sessionId: native.updates.at(-1)!.sessionId, paused: true }); });
    await advance(20_000);
    await act(async () => { await emitTo("main", "timer-set-paused", { sessionId: native.updates.at(-1)!.sessionId, paused: false }); });
    await advance(5000);
    await timerAction("任务A", "停止计时");
    expect(stored()[0].timeEntries[0]).toEqual({
      id: expect.any(String),
      startTime: "2026-09-13T04:00:00.000Z", endTime: "2026-09-13T04:00:35.000Z", duration: 15,
    });
  });

  it("does not create a stale native window when the first start resolves late", async () => {
    let resolveOld!: (value: null) => void;
    native.getByLabel.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    seed([makeTodo("A"), makeTodo("B")]);
    render(<App />);
    await timerAction("任务A", "开始计时");
    await advance(3000);
    await timerAction("任务B", "开始计时");
    await act(async () => resolveOld(null));
    expect(native.windows).toHaveLength(1);
    expect(stored()[0].totalTimeSpent).toBe(3);
  });
});

describe("data protection and daily goal creation", () => {
  it("protects malformed local business JSON instead of overwriting it with demo tasks", async () => {
    localStorage.setItem(key, '{broken JSON');
    render(<App />); await flush();
    expect(localStorage.getItem(key)).toBe('{broken JSON');
    expect(screen.getByText('存储异常 · 只读保护')).toBeTruthy();
  });
  it("creates a daily goal with independent dates and an optional daily reminder", async () => {
    seed([]); render(<App />); await flush();
    const surface = document.querySelector('.todo-list') || document.querySelector('.task-list');
    expect(surface).toBeTruthy();
    fireEvent.contextMenu(surface!);
    fireEvent.click(screen.getByRole('button', { name: '创建每日目标' }));
    const title = document.querySelector('.creation-modal input:not([type])') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '每天读书' } });
    fireEvent.change(screen.getByLabelText('目标开始日期'), { target: { value: '2026-09-13' } });
    fireEvent.change(screen.getByLabelText('目标结束日期'), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText('每日 QQ 提醒（可留空）'), { target: { value: '20:30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' })); await flush();
    expect(stored()[0]).toMatchObject({ title: '每天读书', goalStartDate: '2026-09-13', goalEndDate: '2026-10-13', reminderTime: '20:30', completionDates: [] });
  });
});


describe("damaged values and timer checkpoints", () => {
  it.each(["null", "", "{}"])("does not seed over an existing invalid task value %s", async raw => {
    localStorage.setItem(key, raw); render(<App />); await flush();
    expect(localStorage.getItem(key)).toBe(raw);
    expect(screen.getByText('存储异常 · 只读保护')).toBeTruthy();
  });
  it("checkpoints live timing with the same ID later used on stop", async () => {
    seed([makeTodo("A")]); render(<App />); await timerAction("任务A", "开始计时");
    await advance(7000);
    const checkpoint = JSON.parse(localStorage.getItem('todo-widget.timer-recovery:local')!)[0];
    expect(checkpoint.entry.duration).toBe(5);
    expect(stored()[0].timeEntries).toHaveLength(0);
    await timerAction("任务A", "停止计时");
    expect(stored()[0].timeEntries[0].id).toBe(checkpoint.entry.id);
    expect(stored()[0].timeEntries[0].duration).toBe(7);
    expect(JSON.parse(localStorage.getItem('todo-widget.timer-recovery:local')!)).toEqual([]);
  });
});

async function mountNativeTimer() {
  const html = readFileSync('public/timer.html', 'utf8');
  const script = readFileSync('public/timer.js', 'utf8');
  const host = document.createElement('div');
  host.id = 'test-timer-host';
  host.innerHTML = html.split('<body>')[1].split('<script')[0];
  document.body.appendChild(host);
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    window: { getCurrentWindow: () => native.main }, event: { listen, emitTo },
  };
  await act(async () => { window.eval(script); await Promise.resolve(); });
  return within(host);
}
const headerButton = (name: string) => within(document.querySelector('.titlebar')!).getByRole('button', { name });

// These use the actual public/timer.js, not a direct call to pauseTimer().
describe('native timer button bridge', () => {
  it('routes pause/resume/stop to main, excludes paused time, and never drags a button', async () => {
    seed([makeTodo('A')]); render(<App />);
    await timerAction('任务A', '开始计时');
    const timer = await mountNativeTimer();
    await advance(10_000);
    const pause = timer.getByRole('button', { name: '暂停计时' });
    native.main.startDragging.mockClear();
    fireEvent.mouseDown(pause.querySelector('svg')!);
    expect(native.main.startDragging).not.toHaveBeenCalled();
    fireEvent.click(pause); await flush();
    expect(timer.getByText('已暂停')).toBeTruthy();
    await advance(20_000);
    expect(document.getElementById('timer-display')!.textContent).toBe('10秒');
    fireEvent.click(timer.getByRole('button', { name: '继续计时' })); await flush();
    await advance(5000);
    fireEvent.click(timer.getByRole('button', { name: '停止并保存' })); await flush();
    expect(stored()[0].totalTimeSpent).toBe(15);
    expect(stored()[0].timeEntries[0].startTime).toBe('2026-09-13T04:00:00.000Z');
    expect(native.windows[0].close).toHaveBeenCalledTimes(1);
  });

  it('updates the floating theme even while paused and keeps main-window controls available', async () => {
    seed([makeTodo('A')]); render(<App />);
    await timerAction('任务A', '开始计时');
    await mountNativeTimer();
    await advance(3000);
    const controls = within(screen.getByRole('group', { name: '计时器' }));
    fireEvent.click(controls.getByRole('button', { name: '暂停计时' })); await flush();
    fireEvent.click(headerButton('设置'));
    fireEvent.click(screen.getByRole('button', { name: '紫' })); await flush();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('168, 139, 250');
    expect(document.documentElement.style.getPropertyValue('--widget-tint')).toBe('58, 47, 80');
    await advance(5000);
    expect(native.updates.at(-1)).toMatchObject({ paused: true, elapsed: 3 });
    fireEvent.click(controls.getByRole('button', { name: '停止并保存' })); await flush();
    expect(stored()[0].totalTimeSpent).toBe(3);
  });

  it('ignores commands from an old window/session and reports a lost response visibly', async () => {
    seed([makeTodo('A')]); render(<App />);
    await timerAction('任务A', '开始计时');
    const timer = await mountNativeTimer();
    await advance(2000);
    await act(async () => { await emitTo('main', 'timer-set-paused', { sessionId: 'old-session', paused: true }); });
    expect(native.updates.at(-1)!.paused).toBe(false);
    native.listeners.delete('timer-set-paused');
    fireEvent.click(timer.getByRole('button', { name: '暂停计时' }));
    await advance(3000);
    expect(timer.getByText('未收到响应，请用主窗口底部按钮。')).toBeTruthy();
    expect((timer.getByRole('button', { name: '暂停计时' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('mutually exclusive tools', () => {
  it('switches calendar -> search -> settings -> diary -> recycle, and toggles or Esc closes', async () => {
    seed([makeTodo('A')]); render(<App />); await flush();
    fireEvent.click(headerButton('完成日历'));
    expect(screen.getByRole('region', { name: '完成日历面板' })).toBeTruthy();
    fireEvent.click(headerButton('搜索任务'));
    expect(document.querySelector('.tool-panel')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), { target: { value: 'absent' } });
    fireEvent.click(headerButton('设置'));
    expect(screen.queryByRole('textbox', { name: '搜索任务' })).toBeNull();
    expect(screen.getByRole('region', { name: '设置面板' })).toBeTruthy();
    fireEvent.click(headerButton('今日日记'));
    expect(document.querySelectorAll('.tool-panel')).toHaveLength(1);
    expect(screen.getByRole('region', { name: '日记面板' })).toBeTruthy();
    fireEvent.click(headerButton('回收站'));
    expect(document.querySelector('.tool-panel')).toBeNull();
    expect(screen.getByRole('tab', { name: /已删除/ })).toBeTruthy();
    fireEvent.click(headerButton('完成日历'));
    fireEvent.click(headerButton('完成日历'));
    expect(document.querySelector('.tool-panel')).toBeNull();
    fireEvent.click(headerButton('搜索任务'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: '搜索任务' })).toBeNull();
  });

  it('preserves diary text when switching tools via keyboard, without requiring a blur', async () => {
    seed([]); render(<App />); await flush();
    fireEvent.click(headerButton('今日日记'));
    fireEvent.change(screen.getByPlaceholderText('写下今天的想法、感受或总结...'), { target: { value: '测试日记草稿' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(headerButton('今日日记'));
    expect((screen.getByPlaceholderText('写下今天的想法、感受或总结...') as HTMLTextAreaElement).value).toBe('测试日记草稿');
    expect(JSON.parse(localStorage.getItem('todo-widget.diary')!)[0].content).toBe('测试日记草稿');
  });
});

describe('diary drafts through connection loss', () => {
  it('retains an unsaved daily draft while switching tools in read-only mode', async () => {
    seed([]); render(<App />); await flush();
    fireEvent.click(headerButton('今日日记'));
    const writable = vi.spyOn(BusinessStore.prototype, 'canWrite', 'get').mockReturnValue(false);
    fireEvent.change(screen.getByPlaceholderText('写下今天的想法、感受或总结...'), { target: { value: '断线前未保存的草稿' } });
    fireEvent.click(headerButton('完成日历'));
    fireEvent.click(headerButton('今日日记'));
    expect((screen.getByPlaceholderText('写下今天的想法、感受或总结...') as HTMLTextAreaElement).value).toBe('断线前未保存的草稿');
    expect(JSON.parse(localStorage.getItem('todo-widget.diary')!)).toEqual([]);
    writable.mockReturnValue(true);
    fireEvent.click(headerButton('设置'));
    expect(JSON.parse(localStorage.getItem('todo-widget.diary')!)[0].content).toBe('断线前未保存的草稿');
  });

  it('saves a retained completion-note draft before editing a different task after reconnecting', async () => {
    seed(['A', 'B'].map(id => makeTodo(id, { completed: true, completionDates: ['2026-09-13'] })));
    render(<App />); await flush();
    fireEvent.click(headerButton('今日日记'));
    const entry = (title: string) => screen.getByText(title).closest('.diary-entry')!;
    fireEvent.doubleClick(entry('任务A').querySelector('.diary-entry-completion')!);
    fireEvent.change(screen.getByPlaceholderText('填写完成情况说明...'), { target: { value: '不能丢失的完成说明' } });
    const writable = vi.spyOn(BusinessStore.prototype, 'canWrite', 'get').mockReturnValue(false);
    fireEvent.click(headerButton('完成日历'));
    fireEvent.click(headerButton('今日日记'));
    writable.mockReturnValue(true);
    fireEvent.doubleClick(entry('任务B').querySelector('.diary-entry-completion')!);
    expect(stored().find((todo: { id: string }) => todo.id === 'A').completionNotes).toBe('不能丢失的完成说明');
  });
});

describe('recycle bin and explicit undo', () => {
  it('offers a visible completion undo and restores the task without discarding notes or time', async () => {
    seed([makeTodo('A', { completed: true, completionDates: ['2026-09-13'], completionNotes: '已写好', totalTimeSpent: 25 })]);
    render(<App />); await flush();
    fireEvent.click(headerButton('回收站'));
    fireEvent.click(screen.getByRole('button', { name: '撤销完成' })); await flush();
    expect(stored()[0]).toMatchObject({ completed: false, completionNotes: '已写好', totalTimeSpent: 25 });
    expect(screen.queryByRole('article', { name: '任务A' })).toBeNull();
    fireEvent.click(headerButton('待办列表'));
    expect(screen.getByText('任务A')).toBeTruthy();
  });

  it('undoes the selected goal date only; a historical check-in never completes today by accident', async () => {
    seed([makeTodo('每日', { goalStartDate: '2026-09-10', goalEndDate: '2026-09-30', completionDates: ['2026-09-11', '2026-09-12'] })]);
    render(<App />); await flush();
    fireEvent.click(headerButton('回收站'));
    fireEvent.change(screen.getByRole('combobox', { name: '任务每日：要撤销的打卡日期' }), { target: { value: '2026-09-11' } });
    fireEvent.click(screen.getByRole('button', { name: '撤销打卡' })); await flush();
    expect(stored()[0].completionDates).toEqual(['2026-09-12']);
    expect(screen.queryByText('确认完成')).toBeNull();
  });

  it('keeps a deleted task across remounts, exports its history, and restores without old reminders', async () => {
    seed([makeTodo('A', { notes: '重要测试记录', completionNotes: '过去的说明', reminderAt: '2026-09-13T05:00:00Z', totalTimeSpent: 50 })]);
    const first = render(<App />); await flush();
    fireEvent.click(screen.getByRole('button', { name: '删除任务' })); await flush();
    expect(stored()).toHaveLength(1);
    expect(stored()[0].deletedAt).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销删除' })).toBeTruthy();
    first.unmount(); render(<App />); await flush();
    expect(screen.queryByText('任务A')).toBeNull();
    fireEvent.click(headerButton('回收站'));
    fireEvent.click(screen.getByRole('tab', { name: /已删除/ }));
    expect(screen.getByText('任务A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复' })); await flush();
    expect(stored()[0]).toMatchObject({ notes: '重要测试记录', completionNotes: '过去的说明', totalTimeSpent: 50 });
    expect(stored()[0].deletedAt).toBeUndefined();
    expect(stored()[0].reminderAt).toBeUndefined();
  });

  it('shows an immediate undo action after completion, including during the completion animation', async () => {
    seed([makeTodo('A')]); render(<App />); await flush();
    fireEvent.click(screen.getByRole('button', { name: '标记为完成' }));
    fireEvent.change(screen.getByPlaceholderText('填写完成情况说明...'), { target: { value: '验收说明' } });
    fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
    fireEvent.click(within(document.querySelector('.user-notice')!).getByRole('button', { name: '撤销完成' }));
    await advance(1000);
    expect(stored()[0]).toMatchObject({ completed: false, completionNotes: '验收说明' });
    expect(screen.getByRole('button', { name: '标记为完成' })).toHaveProperty('disabled', false);
    expect(document.querySelector('.todo-row.completing')).toBeNull();
  });

  it('does not turn archive record clicks into native window dragging', async () => {
    seed([makeTodo('A', { completed: true, completionDates: ['2026-09-13'] })]);
    render(<App />); await flush();
    fireEvent.click(headerButton('回收站'));
    const summary = screen.getByRole('article', { name: '任务A' }).querySelector('summary')!;
    fireEvent.mouseDown(summary, { button: 0 });
    expect(native.main.startDragging).not.toHaveBeenCalled();
    fireEvent.click(summary);
    expect(summary.parentElement).toHaveProperty('open', true);
  });

  it('refuses to trash a group while its child is being timed', async () => {
    seed([makeTodo('组', { isGroup: true }), makeTodo('子', { parentId: '组' })]);
    render(<App />); await flush();
    await timerAction('任务子', '开始计时');
    fireEvent.click(within(screen.getByText('任务组').closest('article')!).getByRole('button', { name: '删除任务' }));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('子任务的计时'));
    expect(stored().every((todo: { deletedAt?: string }) => !todo.deletedAt)).toBe(true);
  });
});
