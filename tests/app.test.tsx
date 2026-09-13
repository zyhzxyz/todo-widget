import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const native = vi.hoisted(() => ({
  main: {
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
  },
  getByLabel: vi.fn().mockResolvedValue(null),
  listeners: new Map<string, () => void>(),
  windows: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => native.main,
  currentMonitor: vi.fn().mockResolvedValue(null),
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    native.listeners.set(name, callback);
    return () => native.listeners.delete(name);
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
  fireEvent.contextMenu(screen.getByText(title));
  fireEvent.click(screen.getByRole("button", { name: action }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00+08:00"));
  localStorage.clear();
  native.listeners.clear();
  native.windows.length = 0;
  native.getByLabel.mockReset().mockResolvedValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => {
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
    act(() => native.listeners.get("timer-pause-toggle")?.());
    await advance(20_000);
    act(() => native.listeners.get("timer-pause-toggle")?.());
    await advance(5000);
    await timerAction("任务A", "停止计时");
    expect(stored()[0].timeEntries[0]).toEqual({
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
