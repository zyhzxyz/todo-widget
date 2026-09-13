import {
  Archive,
  BarChart3,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  GripHorizontal,
  ListChecks,
  Lock,
  Minus,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type SetStateAction,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { currentMonitor, LogicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { calendarDates, localDate, shiftCalendarMonth } from "./lib/dates";
import { businessDate, businessDateTime, setBusinessTimeZone } from "./lib/businessClock";
import { wallToInstant } from "../shared/time";
import type { BusinessData, Todo, TodoList, DiaryEntry, TimeEntry, Priority } from "../shared/domain";
import { mainWindow } from "./lib/native";
import { useBusinessData } from "./hooks/useBusinessData";
import { DataSettings, DataStatusBanner } from "./components/DataSettings";
import { useClockMinute } from "./hooks/useClockMinute";

type WidgetSettings = {
  alwaysOnTop: boolean;
  locked: boolean;
  collapsed: boolean;
  activeListId: string;
  showCompleted: boolean;
  tint: string;
  eyeCare: boolean;
  eyeCareMinutes: number;
  topDefaultMigrated: boolean;
};

type StoredTodo = Partial<Todo> & {
  id?: string;
  title?: string;
  completed?: boolean;
  priority?: Priority;
  dueDate?: string;
  notifyDate?: string;
  notifyAt?: string;
  startDate?: string;
  endDate?: string;
  goalStartDate?: string;
  goalEndDate?: string;
  completionDates?: string[];
  notes?: string;
  completionNotes?: string;
  isGroup?: boolean;
  parentId?: string;
  collapsed?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type VisibleGroup = {
  list: TodoList;
  todos: Todo[];
};

type CompletionEvent = {
  date: string;
  title: string;
  listName: string;
};

type ListMenu = {
  listId: string;
  x: number;
  y: number;
} | null;

type TodoMenu = {
  todoId: string;
  x: number;
  y: number;
} | null;

type CreationMode = "task" | "notification" | "group" | "goal";

type CreationMenu = {
  x: number;
  y: number;
} | null;

const text = {
  title: "\u5f85\u529e\u6e05\u5355",
  inbox: "\u5f85\u529e",
  today: "\u4eca\u5929",
  important: "\u91cd\u8981",
  completed: "\u5b8c\u6210",
  newList: "\u65b0\u6e05\u5355",
  addList: "\u65b0\u589e\u7a97\u53e3",
  renameList: "\u91cd\u547d\u540d\u7a97\u53e3",
  deleteList: "\u5220\u9664\u7a97\u53e3",
  createList: "\u65b0\u5efa\u7a97\u53e3",
  cannotDelete: "\u9ed8\u8ba4\u7a97\u53e3\u4e0d\u80fd\u5220\u9664",
  addTask: "\u6dfb\u52a0\u4efb\u52a1",
  unpin: "\u53d6\u6d88\u7f6e\u9876",
  pin: "\u7f6e\u9876",
  unlockPosition: "\u89e3\u9501\u4f4d\u7f6e",
  lockPosition: "\u9501\u5b9a\u4f4d\u7f6e",
  expand: "\u5c55\u5f00",
  collapse: "\u6298\u53e0",
  minimize: "\u6700\u5c0f\u5316",
  close: "\u5173\u95ed",
  settings: "\u8bbe\u7f6e",
  searchTasks: "\u641c\u7d22\u4efb\u52a1",
  searchPlaceholder: "\u641c\u7d22\u5f85\u529e",
  draftPlaceholder: "\u5199\u4e0b\u4e00\u4e2a\u5f85\u529e",
  priority: "\u4f18\u5148\u7ea7",
  low: "\u4f4e",
  normal: "\u666e\u901a",
  high: "\u91cd\u8981",
  notify: "\u901a\u77e5",
  dailyGoal: "\u6bcf\u65e5\u76ee\u6807",
  taskGroup: "\u4efb\u52a1\u96c6",
  childTask: "\u5b50\u4efb\u52a1",
  groupHasOpenChildren: "\u5148\u5b8c\u6210\u4efb\u52a1\u96c6\u91cc\u7684\u5c0f\u4efb\u52a1",
  createTask: "\u521b\u5efa\u4efb\u52a1",
  createNotification: "\u521b\u5efa\u901a\u77e5",
  createTaskGroup: "\u521b\u5efa\u4efb\u52a1\u96c6",
  taskName: "\u4efb\u52a1\u540d\u79f0",
  notificationName: "\u901a\u77e5\u540d\u79f0",
  notificationTime: "\u901a\u77e5\u65f6\u95f4",
  taskDuration: "\u6301\u7eed\u65f6\u95f4",
  groupName: "\u4efb\u52a1\u96c6\u540d\u79f0",
  subtasks: "\u5b50\u4efb\u52a1",
  addSubtask: "\u6dfb\u52a0\u5b50\u4efb\u52a1",
  save: "\u4fdd\u5b58",
  start: "\u5f00\u59cb",
  end: "\u7ed3\u675f",
  cancel: "\u53d6\u6d88",
  add: "\u6dfb\u52a0",
  todoList: "\u5f85\u529e\u5217\u8868",
  empty: "\u6ca1\u6709\u5f85\u529e\u4e8b\u9879",
  completedEmpty: "\u8fd8\u6ca1\u6709\u5b8c\u6210\u7684\u4efb\u52a1",
  markOpen: "\u6807\u8bb0\u4e3a\u672a\u5b8c\u6210",
  markDone: "\u6807\u8bb0\u4e3a\u5b8c\u6210",
  deleteTask: "\u5220\u9664\u4efb\u52a1",
  open: "\u672a\u5b8c\u6210",
  finished: "\u5df2\u5b8c\u6210",
  moveBack: "\u6062\u590d\u5230\u539f\u6e05\u5355",
  heatmap: "\u5b8c\u6210\u70ed\u529b\u56fe",
  calendar: "\u5b8c\u6210\u65e5\u5386",
  latestDone: "\u6700\u8fd1\u5b8c\u6210",
  none: "\u65e0",
  color: "\u57fa\u7840\u989c\u8272",
  notes: "\u5907\u6ce8",
  editNotes: "\u7f16\u8f91\u5907\u6ce8",
  notesPlaceholder: "\u6dfb\u52a0\u5907\u6ce8...",
  prevMonth: "\u4e0a\u4e2a\u6708",
  nextMonth: "\u4e0b\u4e2a\u6708",
  completedOn: "\u5f53\u5929\u5b8c\u6210",
  autoStart: "\u5f00\u673a\u81ea\u542f\u52a8",
  notifyDate: "\u901a\u77e5\u65e5\u671f",
  eyeCare: "\u62a4\u773c\u63d0\u9192",
  eyeCareMinutes: "\u63d0\u9192\u95f4\u9694\uff08\u5206\u949f\uff09",
  eyeCareTitle: "\u8be5\u4f11\u606f\u4e00\u4e0b\u4e86",
  eyeCareBody:
    "\u5c4f\u5e55\u5df2\u8fde\u7eed\u4eae\u8d77\u8d85\u8fc7 {minutes} \u5206\u949f\uff0c\u770b\u770b\u8fdc\u5904\uff0c\u6d3b\u52a8\u4e00\u4e0b\u8eab\u4f53\u3002",
  editTask: "\u7f16\u8f91\u4efb\u52a1",
  addTaskToGroup: "\u6dfb\u52a0\u4efb\u52a1\u5230\u6b64\u4efb\u52a1\u96c6",
  removeFromGroup: "\u79fb\u9664\u4efb\u52a1\u96c6",
  selectTask: "\u9009\u62e9\u4efb\u52a1",
  noAvailableTasks: "\u5f53\u524d\u7a97\u53e3\u6ca1\u6709\u53ef\u6dfb\u52a0\u7684\u4efb\u52a1",
  renameTask: "\u91cd\u547d\u540d\u4efb\u52a1",
  creationNotes: "\u521b\u5efa\u5907\u6ce8",
  creationNotesPlaceholder: "\u6dfb\u52a0\u5b8c\u6210\u76ee\u6807\u7b49\u5907\u6ce8...",
  completionNotes: "\u5b8c\u6210\u8bf4\u660e",
  completionNotesPlaceholder: "\u586b\u5199\u5b8c\u6210\u60c5\u51b5\u8bf4\u660e...",
  confirmCompletion: "\u786e\u8ba4\u5b8c\u6210",
  diary: "\u65e5\u8bb0",
  diaryFor: "\u65e5\u8bb0",
  editDiary: "\u7f16\u8f91\u65e5\u8bb0",
  noDiaryEntries: "\u5f53\u5929\u6ca1\u6709\u5b8c\u6210\u7684\u4efb\u52a1",
  todayDiary: "\u4eca\u65e5\u65e5\u8bb0",
  standaloneDiary: "\u65e5\u8bb0\u5185\u5bb9",
  standaloneDiaryPlaceholder: "\u5199\u4e0b\u4eca\u5929\u7684\u60f3\u6cd5\u3001\u611f\u53d7\u6216\u603b\u7ed3...",
  saveDiary: "\u4fdd\u5b58\u65e5\u8bb0",
  startTimer: "\u5f00\u59cb\u8ba1\u65f6",
  stopTimer: "\u505c\u6b62\u8ba1\u65f6",
  timeSpent: "\u8017\u65f6",
  totalTime: "\u603b\u8ba1\u65f6\u95f4",
  hours: "\u5c0f\u65f6",
  minutes: "\u5206\u949f",
  seconds: "\u79d2",
  timeDistribution: "\u65f6\u95f4\u5206\u5e03",
  noTimeData: "\u5f53\u5929\u6ca1\u6709\u8ba1\u65f6\u6570\u636e",
};

const TODO_STORAGE_KEY = "todo-widget.todos";
const LISTS_STORAGE_KEY = "todo-widget.lists";
const SETTINGS_STORAGE_KEY = "todo-widget.settings";
const DIARY_STORAGE_KEY = "todo-widget.diary";
const DEFAULT_EYE_CARE_MINUTES = 120;
const DEFAULT_INBOX_ID = "list-inbox";
const DEFAULT_TODAY_ID = "list-today";
const DEFAULT_IMPORTANT_ID = "list-important";
const DEFAULT_LIST_IDS = new Set([DEFAULT_INBOX_ID, DEFAULT_TODAY_ID, DEFAULT_IMPORTANT_ID]);
const COMPLETE_ANIMATION_MS = 980;

const tintPresets = [
  { id: "blue", label: "\u84dd", rgb: "44, 62, 80", accent: "94, 163, 255" },
  { id: "teal", label: "\u9752", rgb: "28, 73, 76", accent: "45, 212, 191" },
  { id: "green", label: "\u7eff", rgb: "34, 68, 50", accent: "74, 222, 128" },
  { id: "purple", label: "\u7d2b", rgb: "58, 47, 80", accent: "168, 139, 250" },
  { id: "gray", label: "\u7070", rgb: "46, 52, 58", accent: "180, 190, 200" },
];

const priorityRank: Record<Priority, number> = {
  high: 0,
  notify: 1,
  normal: 2,
  low: 3,
};

const defaultLists: TodoList[] = [
  createList(DEFAULT_INBOX_ID, text.inbox),
  createList(DEFAULT_TODAY_ID, text.today),
  createList(DEFAULT_IMPORTANT_ID, text.important),
];

const defaultSettings: WidgetSettings = {
  alwaysOnTop: false,
  locked: false,
  collapsed: false,
  activeListId: DEFAULT_INBOX_ID,
  showCompleted: false,
  tint: "blue",
  eyeCare: true,
  eyeCareMinutes: DEFAULT_EYE_CARE_MINUTES,
  topDefaultMigrated: true,
};

const seedTodos: Todo[] = [
  createTodo("\u9879\u76ee\u7ba1\u7406\u65b0\u4efb\u52a1", "normal", DEFAULT_TODAY_ID, today()),
  createTodo("\u4e3a\u9879\u76ee\u7ec4\u91c7\u8d2d\u8bbe\u5907", "high", DEFAULT_IMPORTANT_ID),
  createTodo(
    "\u5b8c\u6210\u6570\u636e\u5b89\u5168\u5408\u89c4\u6027\u81ea\u67e5",
    "low",
    DEFAULT_INBOX_ID,
    undefined,
    true,
  ),
  createTodo(
    "\u9884\u7b97\u7f16\u5236\uff1a\u5236\u5b9a\u5b63\u5ea6\u90e8\u95e8\u9884\u7b97",
    "normal",
    DEFAULT_INBOX_ID,
  ),
  createTodo(
    "\u529e\u516c\u533a\u6253\u5370\u673a\u7ef4\u62a4\u4e0e\u8017\u6750\u66f4\u6362",
    "low",
    DEFAULT_INBOX_ID,
    undefined,
    true,
  ),
];

function createList(id: string, name: string): TodoList {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
  };
}

function createTodo(
  title: string,
  priority: Priority,
  listId: string,
  dueDate?: string,
  completed = false,
  goalStartDate?: string,
  goalEndDate?: string,
  notes?: string,
  notifyDate?: string,
  isGroup = false,
  parentId?: string,
  startDate?: string,
  endDate?: string,
  notifyAt?: string,
  collapsed = false,
  completionNotes?: string,
): Todo {
  const now = new Date().toISOString();
  const completionDates = completed ? [today()] : [];

  return {
    id: crypto.randomUUID(),
    title,
    completed,
    priority,
    listId,
    dueDate,
    notifyDate,
    notifyAt,
    startDate,
    endDate,
    goalStartDate,
    goalEndDate,
    completionDates,
    notes,
    completionNotes,
    isGroup,
    parentId,
    collapsed,
    createdAt: now,
    updatedAt: now,
    timeEntries: [],
    totalTimeSpent: 0,
  };
}

function today() {
  return businessDate();
}

function dateTimeLocal(date = new Date()) {
  return businessDateTime(date);
}

function monthLabel(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    if ([TODO_STORAGE_KEY, LISTS_STORAGE_KEY, DIARY_STORAGE_KEY].includes(key)) throw new Error("Invalid local business JSON; preserve the original store");
    return fallback;
  }
}

function normalizeLists() {
  const saved = readJson<TodoList[]>(LISTS_STORAGE_KEY, []);
  if (!Array.isArray(saved) || saved.some(list => !list || typeof list.id !== "string" || typeof list.name !== "string")) throw new Error("Invalid local lists");
  const cleanSaved = saved;
  const ids = new Set(cleanSaved.map((list) => list.id));
  const missingDefaults = defaultLists.filter((list) => !ids.has(list.id));
  return [...missingDefaults, ...cleanSaved];
}

function inferLegacyListId(todo: StoredTodo) {
  if (todo.listId) return todo.listId;
  if (todo.dueDate === today()) return DEFAULT_TODAY_ID;
  if (todo.priority === "high") return DEFAULT_IMPORTANT_ID;
  return DEFAULT_INBOX_ID;
}

function normalizeTodos() {
  // A saved empty array is intentional. Only a missing store gets demo tasks.
  const saved = readJson<StoredTodo[] | null>(TODO_STORAGE_KEY, null);
  const source = localStorage.getItem(TODO_STORAGE_KEY) === null ? seedTodos : saved;
  if (!Array.isArray(source) || source.some(todo => !todo || typeof todo.title !== "string" || !todo.title.trim() || (todo.completionDates !== undefined && !Array.isArray(todo.completionDates)) || (todo.timeEntries !== undefined && !Array.isArray(todo.timeEntries)))) throw new Error("Invalid local tasks");

  return source
    .filter((todo) => todo?.title)
    .map((todo) => {
      const now = new Date().toISOString();
      const updatedDate = todo.updatedAt ? localDate(new Date(todo.updatedAt)) : today();
      const completionDates =
        todo.completionDates && todo.completionDates.length > 0
          ? Array.from(new Set(todo.completionDates))
          : todo.completed
            ? [updatedDate]
            : [];

      return {
        id: todo.id || crypto.randomUUID(),
        title: todo.title || "",
        completed: Boolean(todo.completed),
        priority: todo.priority || "normal",
        listId: inferLegacyListId(todo),
        dueDate: todo.dueDate,
        notifyDate: todo.notifyDate,
        notifyAt: todo.notifyAt,
        reminderAt: todo.reminderAt,
        reminderTime: todo.reminderTime,
        startDate: todo.startDate,
        endDate: todo.endDate,
        goalStartDate: todo.goalStartDate,
        goalEndDate: todo.goalEndDate,
        completionDates,
        notes: todo.notes,
        completionNotes: todo.completionNotes,
        isGroup: Boolean(todo.isGroup),
        parentId: todo.parentId,
        collapsed: Boolean(todo.collapsed),
        createdAt: todo.createdAt || now,
        updatedAt: todo.updatedAt || now,
        timeEntries: todo.timeEntries || [],
        totalTimeSpent: todo.totalTimeSpent || 0,
      };
    });
}

function normalizeSettings(lists: TodoList[]) {
  const rawSaved = readJson<Partial<WidgetSettings> & { filter?: string }>(
    SETTINGS_STORAGE_KEY,
    defaultSettings,
  );
  const saved: Partial<WidgetSettings> & { filter?: string } = rawSaved && typeof rawSaved === "object" && !Array.isArray(rawSaved) ? rawSaved : defaultSettings;
  const firstListId = lists[0]?.id || DEFAULT_INBOX_ID;
  const migratedActiveList =
    saved.activeListId ||
    (saved.filter === "today"
      ? DEFAULT_TODAY_ID
      : saved.filter === "important"
        ? DEFAULT_IMPORTANT_ID
        : firstListId);
  const activeListId = lists.some((list) => list.id === migratedActiveList)
    ? migratedActiveList
    : firstListId;

  return {
    alwaysOnTop: saved.topDefaultMigrated ? (saved.alwaysOnTop ?? defaultSettings.alwaysOnTop) : false,
    locked: saved.locked ?? defaultSettings.locked,
    collapsed: false,
    activeListId,
    showCompleted: saved.showCompleted ?? false,
    tint: saved.tint ?? defaultSettings.tint,
    eyeCare: saved.eyeCare ?? defaultSettings.eyeCare,
    eyeCareMinutes: Math.max(1, Number(saved.eyeCareMinutes ?? defaultSettings.eyeCareMinutes)),
    topDefaultMigrated: true,
  };
}

function isGoal(todo: Todo) {
  return Boolean(todo.goalStartDate && todo.goalEndDate);
}

function isGoalActiveToday(todo: Todo) {
  const current = today();
  return Boolean(
    todo.goalStartDate &&
      todo.goalEndDate &&
      todo.goalStartDate <= current &&
      current <= todo.goalEndDate,
  );
}

function isOpenToday(todo: Todo) {
  if (isGoal(todo)) {
    return isGoalActiveToday(todo) && !todo.completionDates.includes(today());
  }

  return !todo.completed;
}

function shouldShowTodo(todo: Todo) {
  const currentDate = today();
  if (todo.notifyAt && todo.notifyAt > dateTimeLocal()) return false;
  if (todo.notifyDate && todo.notifyDate > currentDate) return false;
  if (todo.startDate && todo.startDate > currentDate) return false;
  return true;
}

function sortTodos(a: Todo, b: Todo) {
  const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
  if (rankDiff !== 0) return rankDiff;
  return b.createdAt.localeCompare(a.createdAt);
}

function priorityLabel(priority: Priority) {
  if (priority === "high") return text.important;
  if (priority === "notify") return text.notify;
  if (priority === "low") return "\u4f4e\u4f18\u5148\u7ea7";
  return text.normal;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}${text.hours}${m}${text.minutes}`;
  } else if (m > 0) {
    return `${m}${text.minutes}${s}${text.seconds}`;
  } else {
    return `${s}${text.seconds}`;
  }
}

function canDeleteList(listId: string) {
  return !DEFAULT_LIST_IDS.has(listId);
}

function isOpenOrCompleting(todo: Todo, completingIds: Set<string>) {
  return isOpenToday(todo) || completingIds.has(todo.id);
}

function getOpenChildTodos(groupId: string, todos: Todo[], completingIds: Set<string>) {
  return todos.filter(
    (todo) =>
      todo.parentId === groupId &&
      shouldShowTodo(todo) &&
      isOpenOrCompleting(todo, completingIds),
  );
}

function shouldStayOpen(todo: Todo, todos: Todo[], completingIds: Set<string>) {
  if (!todo.isGroup) {
    return shouldShowTodo(todo) && isOpenOrCompleting(todo, completingIds);
  }

  const children = todos.filter((item) => item.parentId === todo.id);
  if (children.length === 0) {
    return shouldShowTodo(todo) && isOpenOrCompleting(todo, completingIds);
  }

  return getOpenChildTodos(todo.id, todos, completingIds).length > 0 || completingIds.has(todo.id);
}

function loadLocalBusiness(): BusinessData {
  const diary = readJson<DiaryEntry[]>(DIARY_STORAGE_KEY, []);
  if (!Array.isArray(diary) || diary.some(entry => !entry || typeof entry.id !== "string" || typeof entry.date !== "string" || typeof entry.content !== "string")) throw new Error("Invalid local diary");
  return { lists: normalizeLists(), todos: normalizeTodos(), diary };
}

function App() {
  const appWindow = useMemo(mainWindow, []);
  const clockMinute = useClockMinute();
  const listTabsRef = useRef<HTMLDivElement>(null);
  const eyeCareActiveMsRef = useRef(0);
  const eyeCareLastTickRef = useRef(Date.now());
  const { store: dataStore, view: dataView } = useBusinessData(loadLocalBusiness);
  setBusinessTimeZone(dataView.timeZone);
  const { lists, todos, diary: standaloneDiaryEntries } = dataView.data;
  const setTodos = (update: SetStateAction<Todo[]>) => dataStore.set("todos", update);
  const setLists = (update: SetStateAction<TodoList[]>) => dataStore.set("lists", update);
  const setStandaloneDiaryEntries = (update: SetStateAction<DiaryEntry[]>) => dataStore.set("diary", update);
  const [settings, setSettings] = useState<WidgetSettings>(() => normalizeSettings(lists));
  const [draft, setDraft] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [taskStart, setTaskStart] = useState("");
  const [taskEnd, setTaskEnd] = useState("");
  const [notifyAt, setNotifyAt] = useState(dateTimeLocal());
  const [useTaskTime, setUseTaskTime] = useState(false);
  const [useReminder, setUseReminder] = useState(false);
  const [dailyReminderTime, setDailyReminderTime] = useState("");
  const [creationMode, setCreationMode] = useState<CreationMode | null>(null);
  const [creationMenu, setCreationMenu] = useState<CreationMenu>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [completingIds, setCompletingIds] = useState<string[]>([]);
  const [listMenu, setListMenu] = useState<ListMenu>(null);
  const [todoMenu, setTodoMenu] = useState<TodoMenu>(null);
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editReminder, setEditReminder] = useState("");
  const [editDailyReminder, setEditDailyReminder] = useState("");
  const [editTaskPriority, setEditTaskPriority] = useState<Priority>("normal");
  const [editTaskStart, setEditTaskStart] = useState(today());
  const [editTaskEnd, setEditTaskEnd] = useState(today());
  const [addTaskToGroupId, setAddTaskToGroupId] = useState<string | null>(null);
  const [hoveredTodoId, setHoveredTodoId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [renamingTodoId, setRenamingTodoId] = useState<string | null>(null);
  const [renameTodoDraft, setRenameTodoDraft] = useState("");
  const [creationNotes, setCreationNotes] = useState("");
  const [completingTodoId, setCompletingTodoId] = useState<string | null>(null);
  const [completionNotesDraft, setCompletionNotesDraft] = useState("");
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [diaryDate, setDiaryDate] = useState<string | null>(null);
  const [editingDiaryId, setEditingDiaryId] = useState<string | null>(null);
  const [diaryNotesDraft, setDiaryNotesDraft] = useState("");
  const [standaloneDiaryDraft, setStandaloneDiaryDraft] = useState("");
  const [eyeCareNotificationVisible, setEyeCareNotificationVisible] = useState(false);
  const [timingTodoId, setTimingTodoId] = useState<string | null>(null);
  const [timerStartTime, setTimerStartTime] = useState<number | null>(null);
  const [timerElapsed, setTimerElapsed] = useState(0);
  const [timerPaused, setTimerPaused] = useState(false);
  const [timerPausedAt, setTimerPausedAt] = useState<number | null>(null);
  const [timerAccumulatedTime, setTimerAccumulatedTime] = useState(0);
  const [editingTimeSpent, setEditingTimeSpent] = useState<number | null>(null);
  const timerWindowRef = useRef<WebviewWindow | null>(null);
  const todosRef = useRef<Todo[]>([]);
  const timingTodoIdRef = useRef<string | null>(null);
  const timerStartTimeRef = useRef<number | null>(null);
  const timerSessionStartRef = useRef<number | null>(null);
  const timerEntryIdRef = useRef<string | null>(null);
  const timerWindowGenerationRef = useRef(0);
  const timerWindowClosingRef = useRef<Promise<void>>(Promise.resolve());
  const timerElapsedRef = useRef(0);
  const timerPausedRef = useRef(false);
  const timerAccumulatedTimeRef = useRef(0);

  todosRef.current = todos;

  useEffect(() => {
    if (!lists.some(list => list.id === settings.activeListId)) {
      setSettings(current => ({ ...current, activeListId: DEFAULT_INBOX_ID }));
    }
  }, [lists, settings.activeListId]);

  const activeList = lists.find((list) => list.id === settings.activeListId) || lists[0];
  const completingIdSet = useMemo(() => new Set(completingIds), [completingIds]);
  const openTodos = useMemo(
    () => todos.filter((todo) => shouldStayOpen(todo, todos, completingIdSet)),
    [clockMinute, completingIdSet, todos],
  );
  const completedEvents = useMemo(() => getCompletionEvents(todos, lists), [lists, todos]);
  const openCount = openTodos.length;
  const completedCount = completedEvents.length;
  const activeIsInbox = settings.activeListId === DEFAULT_INBOX_ID;
  const tint = tintPresets.find((preset) => preset.id === settings.tint) || tintPresets[0];

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    // One owner for the native flag: dismissing a reminder restores the preference.
    appWindow.setAlwaysOnTop(settings.alwaysOnTop || eyeCareNotificationVisible).catch(() => undefined);
  }, [appWindow, settings.alwaysOnTop, eyeCareNotificationVisible]);

  useEffect(() => {
    invoke<boolean>("get_autostart_enabled")
      .then((enabled) => setAutoStartEnabled(enabled))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!settings.eyeCare) {
      eyeCareActiveMsRef.current = 0;
      eyeCareLastTickRef.current = Date.now();
      return undefined;
    }

    const resetWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        eyeCareActiveMsRef.current = 0;
      }
      eyeCareLastTickRef.current = Date.now();
    };

    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(now - eyeCareLastTickRef.current, 60 * 1000);
      eyeCareLastTickRef.current = now;

      if (document.visibilityState !== "visible") return;

      eyeCareActiveMsRef.current += elapsed;
      if (eyeCareActiveMsRef.current >= settings.eyeCareMinutes * 60 * 1000) {
        setEyeCareNotificationVisible(true);
        eyeCareActiveMsRef.current = 0;
      }
    }, 60 * 1000);

    document.addEventListener("visibilitychange", resetWhenHidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resetWhenHidden);
    };
  }, [settings.eyeCare, settings.eyeCareMinutes]);

  useEffect(() => {
    if (eyeCareNotificationVisible) {
      const audio = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIGGS57OihUBELTKXh8bllHAU2jdXvzn0vBSh+zPDajzsKElyx6OyrWBUIQ5zd8sFuJAUuhM/z24k2CBhku+zooVARC0yl4fG5ZRwFNo3V7859LwUofsz");
      audio.play().catch(() => {});

    }
  }, [eyeCareNotificationVisible]);

  useEffect(() => {
    if (!appWindow.native) return;
    let unlistenPause: (() => void) | undefined;
    let unlistenStop: (() => void) | undefined;
    let unlistenReady: (() => void) | undefined;
    let disposed = false;

    listen("timer-pause-toggle", () => {
      if (timerPausedRef.current && dataStore.canWrite) {
        resumeTimer();
      } else {
        pauseTimer();
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenPause = unlisten;
      }
    });

    listen("timer-stop", () => {
      stopTimer();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenStop = unlisten;
      }
    });

    listen("timer-ready", () => {
      emitTimerUpdate();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenReady = unlisten;
      }
    });

    return () => {
      disposed = true;
      unlistenPause?.();
      unlistenStop?.();
      unlistenReady?.();
    };
  }, []);

  // 计时器更新
  useEffect(() => {
    if (!timingTodoId || !timerStartTime) return;

    const timer = window.setInterval(() => {
      const startTime = timerStartTimeRef.current;
      if (!timerPausedRef.current && startTime) {
        const elapsed = timerAccumulatedTimeRef.current + Math.floor((Date.now() - startTime) / 1000);
        timerElapsedRef.current = elapsed;
        setTimerElapsed(elapsed);
        if (elapsed % 5 === 0) checkpointTimer();

        emitTimerUpdate(timingTodoIdRef.current, elapsed, false);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [timingTodoId, timerStartTime]);

  // Persist an interrupted session locally without uploading live timer ticks.
  useEffect(() => {
    const checkpoint = () => checkpointTimer();
    window.addEventListener("beforeunload", checkpoint);
    document.addEventListener("visibilitychange", checkpoint);
    return () => {
      window.removeEventListener("beforeunload", checkpoint);
      document.removeEventListener("visibilitychange", checkpoint);
    };
  }, []);

  const visibleGroups = useMemo(() => {
    if (settings.showCompleted) return [];

    const lowerQuery = query.trim().toLowerCase();
    const matchesQuery = (todo: Todo) => !lowerQuery || todo.title.toLowerCase().includes(lowerQuery);
    const matchesParentQuery = (todo: Todo) => {
      if (!todo.parentId) return false;
      const parent = todos.find((item) => item.id === todo.parentId);
      return Boolean(parent && matchesQuery(parent));
    };
    const hasMatchingOpenChild = (todo: Todo) =>
      getOpenChildTodos(todo.id, todos, completingIdSet).some((child) => matchesQuery(child));
    const isInCurrentView = (todo: Todo) => activeIsInbox || todo.listId === settings.activeListId;
    const visible = todos
      .filter((todo) => {
        if (!isInCurrentView(todo) || !shouldStayOpen(todo, todos, completingIdSet)) return false;
        if (todo.isGroup) return matchesQuery(todo) || hasMatchingOpenChild(todo);
        return matchesQuery(todo) || matchesParentQuery(todo);
      })
      .sort(sortTodos);

    if (!activeIsInbox) {
      return visible.length > 0 && activeList ? [{ list: activeList, todos: visible }] : [];
    }

    return lists
      .map((list) => ({
        list,
        todos: visible.filter((todo) => todo.listId === list.id),
      }))
      .filter((group) => group.todos.length > 0);
  }, [clockMinute, activeIsInbox, activeList, completingIdSet, lists, query, settings.activeListId, settings.showCompleted, todos]);

  const completedTodos = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return todos
      .filter((todo) => todo.completed || todo.completionDates.length > 0)
      .filter((todo) => !lowerQuery || todo.title.toLowerCase().includes(lowerQuery))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [query, todos]);

  const heatmapDays = useMemo(() => getHeatmapDays(completedEvents, calendarMonth), [completedEvents, calendarMonth]);
  const latestEvents = completedEvents.slice(0, 5);
  const selectedDateEvents = useMemo(() => {
    if (!selectedDate) return [];
    return completedEvents.filter((event) => event.date === selectedDate);
  }, [completedEvents, selectedDate]);

  const diaryEntries = useMemo(() => {
    if (!diaryDate) return { completedTodos: [], standaloneDiary: undefined };
    const completedTodos = todos.filter((todo) => todo.completionDates.includes(diaryDate));
    const standaloneDiary = standaloneDiaryEntries.find((entry) => entry.date === diaryDate);
    return { completedTodos, standaloneDiary };
  }, [diaryDate, todos, standaloneDiaryEntries]);

  function updateSettings(patch: Partial<WidgetSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function scrollListsToEnd() {
    window.setTimeout(() => {
      const listTabs = listTabsRef.current;
      if (!listTabs) return;

      listTabs.scrollTo({
        left: listTabs.scrollWidth,
        behavior: "smooth",
      });
    }, 0);
  }

  function handleListWheel(event: WheelEvent<HTMLDivElement>) {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.currentTarget.scrollBy({
      left: event.deltaY,
      behavior: "smooth",
    });
  }

  function resetCreationForm(mode: CreationMode) {
    setDraft("");
    setPriority(mode === "notification" ? "notify" : "normal");
    setTaskStart(mode === "goal" ? today() : "");
    setTaskEnd(mode === "goal" ? today() : "");
    setUseReminder(false);
    setDailyReminderTime("");
    setNotifyAt(dateTimeLocal());
    setUseTaskTime(false);
    setCreationNotes("");
  }

  function beginCreation(mode: CreationMode) {
    if (!dataStore.canWrite) return;
    resetCreationForm(mode);
    setCreationMode(mode);
    setCreationMenu(null);
    setSearchOpen(false);
    setQuery("");
    updateSettings({ showCompleted: false, collapsed: false });
  }

  function closeCreationModal() {
    setCreationMode(null);
    setCreationMenu(null);
    resetCreationForm("task");
  }

  function submitCreation(event: FormEvent) {
    event.preventDefault();
    if (!dataStore.canWrite) return;
    const title = draft.trim();
    if (!title || !creationMode || settings.showCompleted || !activeList) return;

    const start = useTaskTime && taskStart ? taskStart : undefined;
    const end = useTaskTime && taskEnd ? taskEnd : undefined;
    const normalizedStart = start && end && start > end ? end : start;
    const normalizedEnd = start && end && start > end ? start : end;
    const targetListId = activeIsInbox ? DEFAULT_INBOX_ID : activeList.id;
    const notes = creationNotes.trim() || undefined;

    if (creationMode === "goal") {
      if (!taskStart || !taskEnd || taskStart > taskEnd) { alert("请填写有效的目标起止日期。"); return; }
      const goal = createTodo(title, priority, targetListId, undefined, false, taskStart, taskEnd, notes);
      goal.reminderTime = dailyReminderTime || undefined;
      setTodos(current => [goal, ...current]);
      closeCreationModal();
      return;
    }
    let reminderAt: string | undefined;
    if (creationMode === "task" && useReminder) {
      try { reminderAt = wallToInstant(notifyAt, dataView.timeZone); }
      catch { alert("提醒时间无效或处于夏令时歧义时段，请重新选择。"); return; }
    }

    if (creationMode === "group") {
      // 只创建任务集，不创建子任务
      const group = createTodo(
        title,
        "normal",
        targetListId,
        undefined,
        false,
        undefined,
        undefined,
        notes,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
      );

      setTodos((current) => [group, ...current]);
      closeCreationModal();
      return;
    }

    if (creationMode === "notification") {
      const notifyTime = notifyAt || dateTimeLocal();
      setTodos((current) => [
        createTodo(
          title,
          "notify",
          targetListId,
          undefined,
          false,
          undefined,
          undefined,
          notes,
          notifyTime.slice(0, 10),
          false,
          undefined,
          undefined,
          undefined,
          notifyTime,
        ),
        ...current,
      ]);
      closeCreationModal();
      return;
    }

    setTodos((current) => [
      { ...createTodo(
        title,
        priority,
        targetListId,
        undefined,
        false,
        undefined,
        undefined,
        notes,
        undefined,
        false,
        undefined,
        normalizedStart,
        normalizedEnd,
      ), reminderAt },
      ...current,
    ]);
    closeCreationModal();
  }

  function addList() {
    if (!dataStore.canWrite) return;
    const id = `list-${crypto.randomUUID()}`;
    const newList = createList(id, `${text.newList} ${lists.length + 1}`);

    setLists((current) => [...current, newList]);
    updateSettings({ activeListId: id, showCompleted: false, collapsed: false });
    setRenamingListId(id);
    setRenameDraft(newList.name);
    setListMenu(null);
    scrollListsToEnd();
  }

  function startRename(listId = activeList?.id) {
    if (!dataStore.canWrite) return;
    const target = lists.find((list) => list.id === listId);
    if (!target || settings.showCompleted) return;
    setRenamingListId(target.id);
    setRenameDraft(target.name);
    setListMenu(null);
  }

  function deleteList(listId: string) {
    if (!dataStore.canWrite) return;
    if (!canDeleteList(listId)) return;

    setLists((current) => current.filter((list) => list.id !== listId));
    setTodos((current) =>
      current.map((todo) =>
        todo.listId === listId ? { ...todo, listId: DEFAULT_INBOX_ID, updatedAt: new Date().toISOString() } : todo,
      ),
    );
    if (settings.activeListId === listId) {
      updateSettings({ activeListId: DEFAULT_INBOX_ID, showCompleted: false });
    }
    setRenamingListId(null);
    setRenameDraft("");
    setListMenu(null);
  }

  function commitRename() {
    if (!dataStore.canWrite) return;
    if (!renamingListId) return;
    const name = renameDraft.trim();

    if (!name) {
      if (canDeleteList(renamingListId)) {
        deleteList(renamingListId);
      } else {
        setRenamingListId(null);
        setRenameDraft("");
      }
      return;
    }

    setLists((current) =>
      current.map((list) => (list.id === renamingListId ? { ...list, name } : list)),
    );
    setRenamingListId(null);
    setRenameDraft("");
  }

  function openListMenu(event: MouseEvent, listId: string) {
    event.preventDefault();
    setListMenu({
      listId,
      x: Math.min(event.clientX, window.innerWidth - 128),
      y: Math.min(event.clientY, window.innerHeight - 88),
    });
  }

  function completeTodo(id: string) {
    if (!dataStore.canWrite) return;
    if (completingIds.includes(id)) return;

    const todo = todos.find((item) => item.id === id);
    if (!todo) return;

    if (todo.isGroup && getOpenChildTodos(todo.id, todos, completingIdSet).length > 0) {
      return;
    }

    if (todo.completed && !isGoal(todo)) {
      setTodos((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, completed: false, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      return;
    }

    if (isGoal(todo) && todo.completionDates.includes(today())) {
      setTodos((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                completionDates: item.completionDates.filter((date) => date !== today()),
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      return;
    }

    // 打开完成说明对话框
    setCompletingTodoId(id);
    setCompletionNotesDraft("");
  }

  function confirmCompletion() {
    if (!dataStore.canWrite) return;
    if (!completingTodoId) return;
    const id = completingTodoId;
    const completionNotes = completionNotesDraft.trim() || undefined;
    const finalTimeSpent = editingTimeSpent !== null ? editingTimeSpent : undefined;
    const timerSession = timingTodoIdRef.current === id ? finishTimerSession() : null;
    if (timingTodoIdRef.current === id) return; // Recovery journal failed; keep the live timer.

    setCompletingIds((current) => [...current, id]);
    setCompletingTodoId(null);
    setCompletionNotesDraft("");
    setEditingTimeSpent(null);

    setTodos((current) => {
      const target = current.find((item) => item.id === id);
      const updated = current.map((item) => {
        if (item.id !== id) return item;

        const completionDates = Array.from(new Set([...item.completionDates, today()]));
        const timerEntry =
          timerSession?.todoId === id && timerSession.duration > 0
            ? timerSession.entry
            : null;
        return {
          ...item,
          completed: isGoal(item) ? item.completed : true,
          completionDates,
          completionNotes,
          timeEntries: timerEntry ? [...item.timeEntries, timerEntry] : item.timeEntries,
          totalTimeSpent:
            finalTimeSpent !== undefined
              ? finalTimeSpent
              : item.totalTimeSpent + (timerEntry?.duration ?? 0),
          updatedAt: new Date().toISOString(),
        };
      });

      if (!target?.parentId) return updated;

      const parent = updated.find((item) => item.id === target.parentId);
      if (!parent?.isGroup || getOpenChildTodos(parent.id, updated, new Set()).length > 0) {
        return updated;
      }

      return updated.map((item) =>
        item.id === parent.id
          ? {
              ...item,
              completed: true,
              completionDates: Array.from(new Set([...item.completionDates, today()])),
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
    });
    window.setTimeout(() => {
      setCompletingIds((current) => current.filter((itemId) => itemId !== id));
    }, COMPLETE_ANIMATION_MS);
  }

  function removeTodo(id: string) {
    if (!dataStore.canWrite) return;
    if (timingTodoIdRef.current === id) { alert("请先停止计时，再删除任务。"); return; }
    setTodos((current) =>
      current
        .filter((todo) => todo.id !== id)
        .map((todo) =>
          todo.parentId === id ? { ...todo, parentId: undefined, updatedAt: new Date().toISOString() } : todo,
        ),
    );
  }

  function toggleGroupCollapse(id: string) {
    if (!dataStore.canWrite) return;
    setTodos((current) =>
      current.map((todo) =>
        todo.id === id ? { ...todo, collapsed: !todo.collapsed, updatedAt: new Date().toISOString() } : todo,
      ),
    );
  }

  function openQuickAddFromBlank(event: MouseEvent<HTMLElement>) {
    if (!dataStore.canWrite) return;
    // 待办窗口不能创建任务
    if (activeIsInbox) {
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target.closest(
        ".todo-row, button, input, select, textarea, .creation-modal, .creation-menu, .list-menu, .todo-menu, .settings-panel, .calendar-modal, .eye-care-toast",
      )
    ) {
      return;
    }

    event.preventDefault();
    setListMenu(null);
    setTodoMenu(null);
    setCreationMenu({
      x: Math.min(event.clientX, window.innerWidth - 136),
      y: Math.min(event.clientY, window.innerHeight - 116),
    });
  }

  function startTodoDrag(event: DragEvent<HTMLElement>, todo: Todo) {
    if (!dataStore.canWrite) return;
    // draggable 属性已经控制了哪些任务可以拖拽
    // 这里只需要设置拖拽数据
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-todo-id", todo.id);
    event.dataTransfer.setData("text/plain", todo.id);
  }

  function allowGroupDrop(event: DragEvent<HTMLElement>, groupId: string) {
    const group = todos.find((todo) => todo.id === groupId);
    if (!group?.isGroup) return;

    // 必须调用 preventDefault 才能允许 drop
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }

  function dropTodoIntoGroup(event: DragEvent<HTMLElement>, groupId: string) {
    if (!dataStore.canWrite) return;
    event.preventDefault();
    event.stopPropagation();

    const draggedId = event.dataTransfer.getData("application/x-todo-id") || event.dataTransfer.getData("text/plain");
    if (!draggedId) {
      console.log("No dragged ID found");
      return;
    }

    const group = todos.find((todo) => todo.id === groupId);
    const dragged = todos.find((todo) => todo.id === draggedId);

    console.log("Drop attempt:", { draggedId, groupId, group: group?.title, dragged: dragged?.title });

    // 检查：任务集必须存在
    if (!group?.isGroup) {
      console.log("Target is not a group");
      return;
    }

    // 检查：被拖拽的任务必须存在
    if (!dragged) {
      console.log("Dragged task not found");
      return;
    }

    // 检查：不能拖自己
    if (dragged.id === group.id) {
      console.log("Cannot drag into self");
      return;
    }

    // 检查：不能拖任务集
    if (dragged.isGroup) {
      console.log("Cannot drag a group into another group");
      return;
    }

    // 如果已经在这个任务集中，不做任何操作
    if (dragged.parentId === groupId) {
      console.log("Already in this group");
      return;
    }

    console.log("Drop successful, updating todos");

    setTodos((current) =>
      current.map((todo) =>
        todo.id === dragged.id
          ? {
              ...todo,
              parentId: group.id,
              listId: group.listId,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
  }

  function openTodoMenu(event: MouseEvent, todoId: string) {
    event.preventDefault();
    event.stopPropagation();
    setTodoMenu({
      todoId,
      x: Math.min(event.clientX, window.innerWidth - 128),
      y: Math.min(event.clientY, window.innerHeight - 88),
    });
  }

  function startEditNotes(todoId: string) {
    if (!dataStore.canWrite) return;
    const todo = todos.find((item) => item.id === todoId);
    if (!todo) return;
    setEditingNotesId(todoId);
    setNotesDraft(todo.notes || "");
    setTodoMenu(null);
  }

  function startEditTask(todoId: string) {
    if (!dataStore.canWrite) return;
    const todo = todos.find((item) => item.id === todoId);
    if (!todo) return;
    setEditingTaskId(todoId);
    setEditTaskPriority(todo.priority === "notify" ? "normal" : todo.priority);
    setEditTaskStart(todo.goalStartDate || todo.startDate || "");
    setEditTaskEnd(todo.goalEndDate || todo.endDate || "");
    setEditReminder(todo.reminderAt ? dateTimeLocal(new Date(todo.reminderAt)) : todo.notifyAt || "");
    setEditDailyReminder(todo.reminderTime || "");
    setTodoMenu(null);
  }

  function commitTaskEdit() {
    if (!dataStore.canWrite) return;
    if (!editingTaskId) return;
    const start = editTaskStart || undefined;
    const end = editTaskEnd || undefined;
    const original = todos.find(todo => todo.id === editingTaskId);
    if (original && isGoal(original) && (!start || !end || start > end || original.completionDates.some(date => date < start || date > end))) { alert("目标范围不能为空或排除已有完成记录。"); return; }
    let reminderAt: string | undefined;
    try { reminderAt = editReminder ? wallToInstant(editReminder, dataView.timeZone) : undefined; } catch { alert("提醒时间无效，请重新选择。"); return; }
    const normalizedStart = start && end && start > end ? end : start;
    const normalizedEnd = start && end && start > end ? start : end;

    setTodos((current) =>
      current.map((todo) =>
        todo.id === editingTaskId
          ? {
              ...todo,
              priority: editTaskPriority,
              startDate: isGoal(todo) ? todo.startDate : normalizedStart,
              endDate: isGoal(todo) ? todo.endDate : normalizedEnd,
              goalStartDate: isGoal(todo) ? normalizedStart : undefined,
              goalEndDate: isGoal(todo) ? normalizedEnd : undefined,
              reminderAt: todo.isGroup || (isGoal(todo) && editDailyReminder) ? undefined : reminderAt,
              reminderTime: isGoal(todo) ? editDailyReminder || undefined : undefined,
              notifyAt: undefined,
              notifyDate: undefined,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
    setEditingTaskId(null);
  }

  function openAddTaskToGroup(groupId: string) {
    if (!dataStore.canWrite) return;
    setAddTaskToGroupId(groupId);
    setTodoMenu(null);
  }

  function addTaskToGroup(taskId: string, groupId: string) {
    if (!dataStore.canWrite) return;
    setTodos((current) =>
      current.map((todo) =>
        todo.id === taskId
          ? {
              ...todo,
              parentId: groupId,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
    setAddTaskToGroupId(null);
  }

  function removeFromGroup(taskId: string) {
    if (!dataStore.canWrite) return;
    setTodos((current) =>
      current.map((todo) =>
        todo.id === taskId
          ? {
              ...todo,
              parentId: undefined,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
    setTodoMenu(null);
  }

  function startRenameTodo(todoId: string) {
    if (!dataStore.canWrite) return;
    const todo = todos.find((item) => item.id === todoId);
    if (!todo) return;
    setRenamingTodoId(todoId);
    setRenameTodoDraft(todo.title);
    setTodoMenu(null);
  }

  function commitTodoRename() {
    if (!dataStore.canWrite) return;
    if (!renamingTodoId) return;
    const title = renameTodoDraft.trim();

    if (!title) {
      setRenamingTodoId(null);
      setRenameTodoDraft("");
      return;
    }

    setTodos((current) =>
      current.map((todo) =>
        todo.id === renamingTodoId ? { ...todo, title, updatedAt: new Date().toISOString() } : todo,
      ),
    );
    setRenamingTodoId(null);
    setRenameTodoDraft("");
  }

  function commitNotes() {
    if (!dataStore.canWrite) return;
    if (!editingNotesId) return;
    const notes = notesDraft.trim();
    setTodos((current) =>
      current.map((todo) =>
        todo.id === editingNotesId ? { ...todo, notes, updatedAt: new Date().toISOString() } : todo,
      ),
    );
    setEditingNotesId(null);
    setNotesDraft("");
  }

  function changeCalendarMonth(offset: number) {
    setCalendarMonth((current) => shiftCalendarMonth(current, offset));
    setSelectedDate(null);
  }

  function openDiary(date: string) {
    setDiaryDate(date);
    setDiaryOpen(true);
    setCalendarOpen(false);
    setSettingsOpen(false);
    const existingEntry = standaloneDiaryEntries.find((entry) => entry.date === date);
    setStandaloneDiaryDraft(existingEntry?.content || "");
  }

  function saveStandaloneDiary() {
    if (!dataStore.canWrite) return;
    if (!diaryDate) return;
    const content = standaloneDiaryDraft.trim();

    setStandaloneDiaryEntries((current) => {
      const existingIndex = current.findIndex((entry) => entry.date === diaryDate);
      const now = new Date().toISOString();

      if (existingIndex >= 0) {
        // 更新现有条目
        if (content) {
          const updated = [...current];
          updated[existingIndex] = {
            ...updated[existingIndex],
            content,
            updatedAt: now,
          };
          return updated;
        } else {
          // 如果内容为空，删除条目
          return current.filter((entry) => entry.date !== diaryDate);
        }
      } else if (content) {
        // 创建新条目
        return [
          ...current,
          {
            id: crypto.randomUUID(),
            date: diaryDate,
            content,
            createdAt: now,
            updatedAt: now,
          },
        ];
      }
      return current;
    });
  }

  function startEditDiary(todoId: string) {
    if (!dataStore.canWrite) return;
    const todo = todos.find((item) => item.id === todoId);
    if (!todo) return;
    setEditingDiaryId(todoId);
    setDiaryNotesDraft(todo.completionNotes || "");
  }

  function commitDiaryEdit() {
    if (!dataStore.canWrite) return;
    if (!editingDiaryId) return;
    const completionNotes = diaryNotesDraft.trim() || undefined;
    setTodos((current) =>
      current.map((todo) =>
        todo.id === editingDiaryId ? { ...todo, completionNotes, updatedAt: new Date().toISOString() } : todo,
      ),
    );
    setEditingDiaryId(null);
    setDiaryNotesDraft("");
  }

  function toggleAutoStart() {
    const newValue = !autoStartEnabled;
    invoke("set_autostart_enabled", { enabled: newValue })
      .then(() => setAutoStartEnabled(newValue))
      .catch(() => undefined);
  }

  function startDragging() {
    if (!settings.locked) {
      appWindow.startDragging().catch(() => undefined);
    }
  }

  function startBlankDragging(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || settings.locked) return;
    if (!(event.target instanceof Element)) return;

    const blockedSelector = [
      "button",
      "input",
      "textarea",
      "select",
      "a",
      "[contenteditable='true']",
      ".todo-row",
      ".list-tabs",
      ".rename-form",
      ".search-row",
      ".settings-panel",
      ".calendar-modal",
      ".list-menu",
      ".creation-menu",
      ".todo-menu",
      ".modal-scrim",
      ".notes-editor",
    ].join(",");

    if (event.target.closest(blockedSelector)) return;
    appWindow.startDragging().catch(() => undefined);
  }

  function closeWindow() {
    stopTimer();
    if (timingTodoIdRef.current) return;
    if ((dataStore.getSnapshot().hasPending || dataStore.getSnapshot().timerRecoveryCount) && !window.confirm("存在未确认的修改或计时，已保留本机恢复记录。确定关闭？")) return;
    appWindow.close().catch(() => undefined);
  }

  function minimizeWindow() {
    appWindow.minimize().catch(() => undefined);
  }

  function emitTimerUpdate(
    todoId = timingTodoIdRef.current,
    elapsed = timerElapsedRef.current,
    paused = timerPausedRef.current,
  ) {
    if (!todoId || !timerWindowRef.current) return;

    const todo = todosRef.current.find((item) => item.id === todoId);
    timerWindowRef.current
      .emit("timer-update", {
        title: todo?.title || "",
        elapsed,
        paused,
      })
      .catch(() => undefined);
  }

  async function startTimer(todoId: string) {
    if (!dataStore.canWrite) return;
    if (!todosRef.current.some((todo) => todo.id === todoId)) return;
    if (timingTodoIdRef.current === todoId) return;
    // Commit the previous session before replacing its refs or native window.
    stopTimer();
    if (timingTodoIdRef.current) return;
    const generation = ++timerWindowGenerationRef.current;
    const startedAt = Date.now();

    timingTodoIdRef.current = todoId;
    timerStartTimeRef.current = startedAt;
    timerSessionStartRef.current = startedAt;
    timerEntryIdRef.current = crypto.randomUUID();
    timerElapsedRef.current = 0;
    timerPausedRef.current = false;
    timerAccumulatedTimeRef.current = 0;

    setTimingTodoId(todoId);
    setTimerStartTime(startedAt);
    setTimerElapsed(0);
    setTimerPaused(false);
    setTimerPausedAt(null);
    setTimerAccumulatedTime(0);
    setTodoMenu(null);

    if (!appWindow.native) return; // Web mode uses the compact in-page timer.
    try {
      await timerWindowClosingRef.current;
      if (generation !== timerWindowGenerationRef.current) return;
      const existingTimerWindow = await WebviewWindow.getByLabel("timer").catch(() => null);
      if (generation !== timerWindowGenerationRef.current) return;
      if (existingTimerWindow) {
        await existingTimerWindow.close().catch(() => undefined);
      }

      const monitor = await currentMonitor();
      if (generation !== timerWindowGenerationRef.current) return;
      const timerWidth = 280;
      const timerHeight = 100;
      const scaleFactor = monitor?.scaleFactor || window.devicePixelRatio || 1;
      const workAreaPosition = monitor?.workArea?.position || monitor?.position;
      const workAreaSize = monitor?.workArea?.size || monitor?.size;
      const x =
        workAreaPosition && workAreaSize
          ? Math.round((workAreaPosition.x + workAreaSize.width) / scaleFactor - timerWidth - 20)
          : Math.max(20, window.screen.availWidth - timerWidth - 20);
      const y = workAreaPosition ? Math.round(workAreaPosition.y / scaleFactor + 20) : 20;

      console.log("Creating timer window at:", { x, y, scaleFactor });

      const timerUrl = "/timer.html";

      const timerWindow = new WebviewWindow("timer", {
        url: timerUrl,
        title: "Timer",
        width: timerWidth,
        height: timerHeight,
        decorations: false,
        transparent: true,
        alwaysOnTop: false,
        skipTaskbar: true,
        resizable: false,
        x,
        y,
        visible: false,
      });

      console.log("Timer window instance created");
      timerWindowRef.current = timerWindow;

      timerWindow.once("tauri://created", () => {
        if (generation !== timerWindowGenerationRef.current) return;
        console.log("Timer window created successfully");
        timerWindow
          .setPosition(new LogicalPosition(x, y))
          .then(() => timerWindow.show())
          .catch(() => timerWindow.show().catch(() => undefined));
        window.setTimeout(() => {
          if (generation === timerWindowGenerationRef.current) emitTimerUpdate();
        }, 100);
      });

      timerWindow.once("tauri://error", (event) => {
        console.error("Timer window error:", event);
        alert("计时器窗口创建失败: " + JSON.stringify(event));
      });
    } catch (error) {
      console.error("Error creating timer window:", error);
      alert("创建计时器窗口时出错: " + error);
    }
  }

  function pauseTimer() {
    const startTime = timerStartTimeRef.current;
    if (!timerPausedRef.current && startTime) {
      const currentElapsed = timerAccumulatedTimeRef.current + Math.floor((Date.now() - startTime) / 1000);

      timerPausedRef.current = true;
      timerAccumulatedTimeRef.current = currentElapsed;
      timerElapsedRef.current = currentElapsed;
      setTimerPaused(true);
      setTimerPausedAt(Date.now());
      setTimerAccumulatedTime(currentElapsed);
      setTimerElapsed(currentElapsed);
      checkpointTimer();
      emitTimerUpdate(timingTodoIdRef.current, currentElapsed, true);
    }
  }

  function resumeTimer() {
    if (timerPausedRef.current && dataStore.canWrite) {
      const resumedAt = Date.now();

      timerPausedRef.current = false;
      timerStartTimeRef.current = resumedAt;
      setTimerPaused(false);
      setTimerStartTime(resumedAt);
      setTimerPausedAt(null);
      emitTimerUpdate(timingTodoIdRef.current, timerElapsedRef.current, false);
    }
  }

  function getCurrentTimerDuration() {
    const startTime = timerStartTimeRef.current;
    if (!startTime) return 0;

    if (timerPausedRef.current) {
      return timerElapsedRef.current;
    }

    return timerAccumulatedTimeRef.current + Math.floor((Date.now() - startTime) / 1000);
  }

  function resetTimerSession() {
    ++timerWindowGenerationRef.current;
    if (timerWindowRef.current) {
      timerWindowClosingRef.current = timerWindowRef.current.close().catch(() => undefined);
      timerWindowRef.current = null;
    }

    timingTodoIdRef.current = null;
    timerStartTimeRef.current = null;
    timerSessionStartRef.current = null;
    timerEntryIdRef.current = null;
    timerElapsedRef.current = 0;
    timerPausedRef.current = false;
    timerAccumulatedTimeRef.current = 0;

    setTimingTodoId(null);
    setTimerStartTime(null);
    setTimerElapsed(0);
    setTimerPaused(false);
    setTimerPausedAt(null);
    setTimerAccumulatedTime(0);
  }

  function checkpointTimer() {
    const todoId = timingTodoIdRef.current;
    const start = timerSessionStartRef.current;
    const id = timerEntryIdRef.current;
    if (!todoId || !start || !id) return;
    dataStore.preserveTimer(todoId, { id, startTime: new Date(start).toISOString(), endTime: new Date().toISOString(), duration: getCurrentTimerDuration() });
  }

  function finishTimerSession() {
    const todoId = timingTodoIdRef.current;
    const startTime = timerStartTimeRef.current;
    if (!todoId || !startTime) return null;

    const duration = getCurrentTimerDuration();
    const entry: TimeEntry & { id: string } = {
      id: timerEntryIdRef.current ?? crypto.randomUUID(),
      startTime: new Date(timerSessionStartRef.current ?? startTime).toISOString(),
      endTime: new Date().toISOString(),
      duration,
    };

    if (!dataStore.preserveTimer(todoId, entry)) return null;
    resetTimerSession();
    return { todoId, duration, entry };
  }

  function stopTimer() {
    const timerSession = finishTimerSession();
    if (!timerSession || timerSession.duration <= 0) return;

    setTodos((current) =>
      current.map((todo) =>
        todo.id === timerSession.todoId
          ? {
              ...todo,
              timeEntries: [...todo.timeEntries, timerSession.entry],
              totalTimeSpent: todo.totalTimeSpent + timerSession.duration,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
  }

  function formatTime(seconds: number): string {
    return formatDuration(seconds);
  }

  return (
    <main
      className={[
        "widget",
        settings.collapsed ? "collapsed" : "",
        searchOpen ? "searching" : "",
        dataView.mode === "remote" || dataView.error || dataView.timerRecoveryCount ? "with-data-status" : "",
      ].join(" ")}
      style={
        {
          "--widget-tint": tint.rgb,
          "--accent": tint.accent,
        } as CSSProperties
      }
      onClick={() => {
        setListMenu(null);
        setTodoMenu(null);
        setCreationMenu(null);
      }}
      onMouseDown={startBlankDragging}
    >
      <header className="titlebar">
        <button
          aria-label={settings.locked ? text.lockPosition : "\u62d6\u52a8\u79fb\u52a8\u7a97\u53e3"}
          className="drag-zone"
          onMouseDown={startDragging}
          title={settings.locked ? text.lockPosition : "\u62d6\u52a8\u79fb\u52a8\u7a97\u53e3"}
          type="button"
        >
          <GripHorizontal size={16} />
          <ListChecks size={16} />
          <span>{settings.showCompleted ? text.completed : activeList?.name || text.title}</span>
        </button>

        <div className="window-actions">
          <button
            aria-label={text.searchTasks}
            className={searchOpen ? "icon-button active" : "icon-button subtle"}
            onClick={() => {
              setSearchOpen((current) => {
                if (current) setQuery("");
                return !current;
              });
            }}
            title={text.searchTasks}
            type="button"
          >
            <Search size={14} />
          </button>
          <button
            aria-label={text.calendar}
            className={calendarOpen ? "icon-button active" : "icon-button subtle"}
            onClick={() => {
              setCalendarOpen(true);
              setDiaryOpen(false);
            }}
            title={text.calendar}
            type="button"
          >
            <BarChart3 size={14} />
          </button>
          <button
            aria-label={text.todayDiary}
            className={diaryOpen && diaryDate === today() ? "icon-button active" : "icon-button subtle"}
            onClick={() => {
              openDiary(today());
              setCalendarOpen(false);
            }}
            title={text.todayDiary}
            type="button"
          >
            <BookOpen size={14} />
          </button>
          <button
            aria-label={settings.showCompleted ? text.todoList : text.completed}
            className={settings.showCompleted ? "icon-button active" : "icon-button subtle"}
            onClick={() => updateSettings({ showCompleted: !settings.showCompleted, collapsed: false })}
            title={settings.showCompleted ? text.todoList : text.completed}
            type="button"
          >
            {settings.showCompleted ? <Archive size={14} /> : <CheckCheck size={14} />}
          </button>
          <button
            aria-label={settings.alwaysOnTop ? text.unpin : text.pin}
            disabled={!appWindow.native}
            className={settings.alwaysOnTop ? "icon-button active" : "icon-button"}
            onClick={() => updateSettings({ alwaysOnTop: !settings.alwaysOnTop })}
            title={settings.alwaysOnTop ? text.unpin : text.pin}
            type="button"
          >
            {settings.alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button
            aria-label={settings.locked ? text.unlockPosition : text.lockPosition}
            disabled={!appWindow.native}
            className={settings.locked ? "icon-button active" : "icon-button"}
            onClick={() => updateSettings({ locked: !settings.locked })}
            title={settings.locked ? text.unlockPosition : text.lockPosition}
            type="button"
          >
            {settings.locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          <button
            aria-label={text.settings}
            className="icon-button"
            onClick={() => setSettingsOpen((current) => !current)}
            title={text.settings}
            type="button"
          >
            <Settings size={14} />
          </button>
          <button
            aria-label={text.minimize}
            disabled={!appWindow.native}
            className="icon-button"
            onClick={minimizeWindow}
            title={text.minimize}
            type="button"
          >
            <Minus size={15} />
          </button>
          <button
            aria-label={text.close}
            disabled={!appWindow.native}
            className="icon-button close"
            onClick={closeWindow}
            title={text.close}
            type="button"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {!settings.collapsed && (
        <>
          <DataStatusBanner view={dataView} onOpen={() => setSettingsOpen(true)} />
          {!settings.showCompleted && (
            <section className="list-strip" aria-label="\u6e05\u5355\u7a97\u53e3">
              <div className="list-tabs" onWheel={handleListWheel} ref={listTabsRef}>
                {lists.map((list) =>
                  renamingListId === list.id ? (
                    <form
                      className="rename-form"
                      key={list.id}
                      onClick={(event) => event.stopPropagation()}
                      onSubmit={(event) => {
                        event.preventDefault();
                        commitRename();
                      }}
                    >
                      <input
                        autoFocus
                        onBlur={commitRename}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onFocus={(event) => event.target.select()}
                        value={renameDraft}
                      />
                    </form>
                  ) : (
                    <button
                      className={settings.activeListId === list.id ? "list-tab active" : "list-tab"}
                      key={list.id}
                      onClick={() => updateSettings({ activeListId: list.id, showCompleted: false })}
                      onContextMenu={(event) => openListMenu(event, list.id)}
                      onDoubleClick={() => {
                        setRenamingListId(list.id);
                        setRenameDraft(list.name);
                      }}
                      title={canDeleteList(list.id) ? text.deleteList : text.cannotDelete}
                      type="button"
                    >
                      {list.name}
                    </button>
                  ),
                )}
              </div>
            </section>
          )}

          {searchOpen && (
            <div className="search-row">
              <Search size={14} />
              <input
                aria-label={text.searchTasks}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder={text.searchPlaceholder}
                value={query}
              />
            </div>
          )}

          <section
            className={
              (settings.showCompleted ? completedTodos.length : visibleGroups.length) === 0
                ? "todo-list empty-list"
                : "todo-list"
            }
            aria-label={text.todoList}
            onContextMenu={openQuickAddFromBlank}
          >
            {settings.showCompleted ? (
              completedTodos.length === 0 ? (
                <p className="empty">{text.completedEmpty}</p>
              ) : (
                completedTodos.map((todo) => renderTodo(todo, true))
              )
            ) : visibleGroups.length === 0 ? (
              <p className="empty">{text.empty}</p>
            ) : (
              visibleGroups.map((group) => (
                <section className="todo-group" key={group.list.id}>
                  {activeIsInbox && (
                    <header className="group-header">
                      <span>{group.list.name}</span>
                    </header>
                  )}
                  {renderGroupTodos(group)}
                </section>
              ))
            )}
          </section>

          <footer>
            {!appWindow.native && timingTodoId && <div className="browser-timer" aria-label="计时器">
              <strong>{formatTime(timerElapsed)}</strong>
              <button type="button" onClick={timerPaused ? resumeTimer : pauseTimer} disabled={timerPaused && !dataStore.canWrite}>{timerPaused ? "继续" : "暂停"}</button>
              <button type="button" onClick={stopTimer}>停止并保存</button>
            </div>}
            <span>
              {openCount} {text.open} / {completedCount} {text.finished}
            </span>
            <button
              className="footer-link"
              onClick={() => updateSettings({ showCompleted: !settings.showCompleted })}
              type="button"
            >
              {settings.showCompleted ? text.todoList : text.completed}
            </button>
          </footer>

          {listMenu && (
            <div
              className="list-menu"
              onClick={(event) => event.stopPropagation()}
              style={{ left: listMenu.x, top: listMenu.y }}
            >
              <button onClick={addList} type="button">
                {text.createList}
              </button>
              <button onClick={() => startRename(listMenu.listId)} type="button">
                {text.renameList}
              </button>
              <button
                disabled={!canDeleteList(listMenu.listId)}
                onClick={() => deleteList(listMenu.listId)}
                type="button"
              >
                {canDeleteList(listMenu.listId) ? text.deleteList : text.cannotDelete}
              </button>
            </div>
          )}

          {creationMenu && !settings.showCompleted && (
            <div
              className="creation-menu"
              onClick={(event) => event.stopPropagation()}
              style={{ left: creationMenu.x, top: creationMenu.y }}
            >
              <button onClick={() => beginCreation("group")} type="button">
                {text.createTaskGroup}
              </button>
              <button onClick={() => beginCreation("notification")} type="button">
                {text.createNotification}
              </button>
              <button onClick={() => beginCreation("goal")} type="button">创建每日目标</button>
              <button onClick={() => beginCreation("task")} type="button">
                {text.createTask}
              </button>
            </div>
          )}

          {creationMode && !settings.showCompleted && (
            <div className="modal-scrim" onClick={closeCreationModal}>
              <form className="creation-modal" onClick={(event) => event.stopPropagation()} onSubmit={submitCreation}>
                <header>
                  <span>
                    {creationMode === "group"
                      ? text.createTaskGroup
                      : creationMode === "notification"
                        ? text.createNotification
                        : creationMode === "goal" ? "创建每日目标" : text.createTask}
                  </span>
                  <button onClick={closeCreationModal} type="button">
                    <X size={14} />
                  </button>
                </header>

                <label className="form-field">
                  <span>
                    {creationMode === "group"
                      ? text.groupName
                      : creationMode === "notification"
                        ? text.notificationName
                        : text.taskName}
                  </span>
                  <input
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={text.draftPlaceholder}
                    value={draft}
                  />
                </label>

                {creationMode !== "notification" && (
                  <label className="form-field">
                    <span>{text.priority}</span>
                    <select
                      aria-label={text.priority}
                      onChange={(event) => setPriority(event.target.value as Priority)}
                      value={priority}
                    >
                      <option value="low">{text.low}</option>
                      <option value="normal">{text.normal}</option>
                      <option value="high">{text.high}</option>
                    </select>
                  </label>
                )}

                {creationMode === "task" && (
                  <>
                    <div className="dual-fields">
                      <label className="setting-check">
                        <input
                          checked={useTaskTime}
                          onChange={(event) => setUseTaskTime(event.target.checked)}
                          type="checkbox"
                        />
                        {text.taskDuration}
                      </label>
                    </div>
                    {useTaskTime && (
                      <div className="dual-fields">
                        <label className="form-field">
                          <span>{text.start}</span>
                          <input onChange={(event) => setTaskStart(event.target.value)} type="date" value={taskStart} />
                        </label>
                        <label className="form-field">
                          <span>{text.end}</span>
                          <input onChange={(event) => setTaskEnd(event.target.value)} type="date" value={taskEnd} />
                        </label>
                      </div>
                    )}
                  </>
                )}

                {creationMode === "goal" && <>
                  <div className="dual-fields">
                    <label className="form-field"><span>目标开始日期</span><input type="date" required value={taskStart} onChange={event => setTaskStart(event.target.value)} /></label>
                    <label className="form-field"><span>目标结束日期</span><input type="date" required value={taskEnd} min={taskStart} onChange={event => setTaskEnd(event.target.value)} /></label>
                  </div>
                  <label className="form-field"><span>每日 QQ 提醒（可留空）</span><input type="time" value={dailyReminderTime} onChange={event => setDailyReminderTime(event.target.value)} /></label>
                  <small>每天独立打卡；提醒使用 {dataView.timeZone}，需要连接服务器并绑定机器人。</small>
                </>}
                {creationMode === "task" && <>
                  <label className="setting-check"><input type="checkbox" checked={useReminder} onChange={event => setUseReminder(event.target.checked)} />设置 QQ 提醒</label>
                  {useReminder && <label className="form-field"><span>提醒时间（{dataView.timeZone}）</span><input type="datetime-local" required value={notifyAt} onChange={event => setNotifyAt(event.target.value)} /></label>}
                  {useReminder && <small>需连接服务器并绑定 AstrBot；任务会立即显示，而不是等到提醒时间。</small>}
                </>}

                {creationMode === "notification" && (
                  <label className="form-field">
                    <span>{text.notificationTime}</span>
                    <input onChange={(event) => setNotifyAt(event.target.value)} type="datetime-local" value={notifyAt} />
                  </label>
                )}

                <label className="form-field">
                  <span>{text.creationNotes}</span>
                  <textarea
                    onChange={(event) => setCreationNotes(event.target.value)}
                    placeholder={text.creationNotesPlaceholder}
                    rows={3}
                    value={creationNotes}
                  />
                </label>

                <div className="quick-add-actions">
                  <button className="text-button ghost" onClick={closeCreationModal} type="button">
                    {text.cancel}
                  </button>
                  <button className="text-button primary" type="submit">
                    {text.save}
                  </button>
                </div>
              </form>
            </div>
          )}

          {todoMenu && (
            <div
              className="todo-menu"
              onClick={(event) => event.stopPropagation()}
              style={{ left: todoMenu.x, top: todoMenu.y }}
            >
              {todos.find((todo) => todo.id === todoMenu.todoId)?.isGroup && (
                <>
                  <button onClick={() => openAddTaskToGroup(todoMenu.todoId)} type="button">
                    {text.addTaskToGroup}
                  </button>
                  <button onClick={() => startEditTask(todoMenu.todoId)} type="button">
                    {text.editTask}
                  </button>
                </>
              )}
              {!todos.find((todo) => todo.id === todoMenu.todoId)?.isGroup && (
                <>
                  <button onClick={() => startEditTask(todoMenu.todoId)} type="button">
                    {text.editTask}
                  </button>
                  {todos.find((todo) => todo.id === todoMenu.todoId)?.parentId && (
                    <button onClick={() => removeFromGroup(todoMenu.todoId)} type="button">
                      {text.removeFromGroup}
                    </button>
                  )}
                  {timingTodoId === todoMenu.todoId ? (
                    <button onClick={stopTimer} type="button">
                      {text.stopTimer}
                    </button>
                  ) : (
                    <button onClick={() => startTimer(todoMenu.todoId)} type="button">
                      {text.startTimer}
                    </button>
                  )}
                </>
              )}
              <button onClick={() => startEditNotes(todoMenu.todoId)} type="button">
                {text.editNotes}
              </button>
            </div>
          )}

          {editingNotesId && (
            <div className="notes-editor" onClick={(event) => event.stopPropagation()}>
              <textarea
                autoFocus
                onChange={(event) => setNotesDraft(event.target.value)}
                onBlur={commitNotes}
                placeholder={text.notesPlaceholder}
                value={notesDraft}
              />
            </div>
          )}

          {completingTodoId && (() => {
            const completingTodo = todos.find((t) => t.id === completingTodoId);
            const runningTimeSpent =
              completingTodo && timingTodoId === completingTodo.id ? timerElapsed : 0;
            const currentTimeSpent =
              editingTimeSpent !== null
                ? editingTimeSpent
                : (completingTodo?.totalTimeSpent || 0) + runningTimeSpent;

            return (
              <div className="modal-scrim" onClick={() => {
                setCompletingTodoId(null);
                setEditingTimeSpent(null);
              }}>
                <form
                  className="creation-modal"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    confirmCompletion();
                  }}
                >
                  <header>
                    <span>{text.confirmCompletion}</span>
                    <button onClick={() => {
                      setCompletingTodoId(null);
                      setEditingTimeSpent(null);
                    }} type="button">
                      <X size={14} />
                    </button>
                  </header>

                  {completingTodo && currentTimeSpent > 0 && (
                    <label className="form-field">
                      <span>{text.totalTime}</span>
                      <div className="time-input-group">
                        <input
                          type="number"
                          min="0"
                          placeholder={text.hours}
                          value={Math.floor(currentTimeSpent / 3600)}
                          onChange={(event) => {
                            const hours = Math.max(0, Number(event.target.value) || 0);
                            const minutes = Math.floor((currentTimeSpent % 3600) / 60);
                            const seconds = currentTimeSpent % 60;
                            setEditingTimeSpent(hours * 3600 + minutes * 60 + seconds);
                          }}
                        />
                        <span>{text.hours}</span>
                        <input
                          type="number"
                          min="0"
                          max="59"
                          placeholder={text.minutes}
                          value={Math.floor((currentTimeSpent % 3600) / 60)}
                          onChange={(event) => {
                            const hours = Math.floor(currentTimeSpent / 3600);
                            const minutes = Math.max(0, Math.min(59, Number(event.target.value) || 0));
                            const seconds = currentTimeSpent % 60;
                            setEditingTimeSpent(hours * 3600 + minutes * 60 + seconds);
                          }}
                        />
                        <span>{text.minutes}</span>
                      </div>
                    </label>
                  )}

                  <label className="form-field">
                    <span>{text.completionNotes}</span>
                    <textarea
                      autoFocus
                      onChange={(event) => setCompletionNotesDraft(event.target.value)}
                      placeholder={text.completionNotesPlaceholder}
                      rows={4}
                      value={completionNotesDraft}
                    />
                  </label>

                  <div className="quick-add-actions">
                    <button className="text-button ghost" onClick={() => {
                      setCompletingTodoId(null);
                      setEditingTimeSpent(null);
                    }} type="button">
                      {text.cancel}
                    </button>
                    <button className="text-button primary" type="submit">
                      {text.confirmCompletion}
                    </button>
                  </div>
                </form>
              </div>
            );
          })()}

          {editingTaskId && (
            <div className="modal-scrim" onClick={() => setEditingTaskId(null)}>
              <form
                className="creation-modal"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  commitTaskEdit();
                }}
              >
                <header>
                  <span>{text.editTask}</span>
                  <button onClick={() => setEditingTaskId(null)} type="button">
                    <X size={14} />
                  </button>
                </header>

                <label className="form-field">
                  <span>{text.priority}</span>
                  <select
                    aria-label={text.priority}
                    onChange={(event) => setEditTaskPriority(event.target.value as Priority)}
                    value={editTaskPriority}
                  >
                    <option value="low">{text.low}</option>
                    <option value="normal">{text.normal}</option>
                    <option value="high">{text.high}</option>
                  </select>
                </label>

                <div className="dual-fields">
                  <label className="form-field">
                    <span>{text.start}</span>
                    <input onChange={(event) => setEditTaskStart(event.target.value)} type="date" value={editTaskStart} />
                  </label>
                  <label className="form-field">
                    <span>{text.end}</span>
                    <input onChange={(event) => setEditTaskEnd(event.target.value)} type="date" value={editTaskEnd} />
                  </label>
                </div>

                {!todos.find(todo => todo.id === editingTaskId)?.isGroup && <>
                  <label className="form-field"><span>一次性 QQ 提醒（留空取消）</span><input type="datetime-local" value={editReminder} onChange={event => setEditReminder(event.target.value)} /></label>
                  {todos.find(todo => todo.id === editingTaskId)?.goalStartDate && <label className="form-field"><span>每日 QQ 提醒（留空取消）</span><input type="time" value={editDailyReminder} onChange={event => setEditDailyReminder(event.target.value)} /></label>}
                  <small>时区 {dataView.timeZone}；提醒需要服务器与 QQ 绑定。</small>
                </>}

                <div className="quick-add-actions">
                  <button className="text-button ghost" onClick={() => setEditingTaskId(null)} type="button">
                    {text.cancel}
                  </button>
                  <button className="text-button primary" type="submit">
                    {text.save}
                  </button>
                </div>
              </form>
            </div>
          )}

          {addTaskToGroupId && (() => {
            const group = todos.find((todo) => todo.id === addTaskToGroupId);
            const availableTasks = todos.filter(
              (todo) =>
                !todo.isGroup &&
                !todo.completed &&
                !todo.parentId &&
                todo.listId === group?.listId &&
                shouldShowTodo(todo)
            );

            return (
              <div className="modal-scrim" onClick={() => setAddTaskToGroupId(null)}>
                <div className="creation-modal" onClick={(event) => event.stopPropagation()}>
                  <header>
                    <span>{text.selectTask}</span>
                    <button onClick={() => setAddTaskToGroupId(null)} type="button">
                      <X size={14} />
                    </button>
                  </header>

                  <div className="task-select-list">
                    {availableTasks.length === 0 ? (
                      <p className="empty">{text.noAvailableTasks}</p>
                    ) : (
                      availableTasks.map((task) => (
                        <button
                          key={task.id}
                          className="task-select-item"
                          onClick={() => addTaskToGroup(task.id, addTaskToGroupId)}
                          type="button"
                        >
                          <span className={`priority-dot ${task.priority}`} />
                          <span>{task.title}</span>
                        </button>
                      ))
                    )}
                  </div>

                  <div className="quick-add-actions">
                    <button className="text-button ghost" onClick={() => setAddTaskToGroupId(null)} type="button">
                      {text.cancel}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {settingsOpen && (
            <section className="settings-panel" onClick={(event) => event.stopPropagation()}>
              <header>
                <span>{text.settings}</span>
                <button onClick={() => setSettingsOpen(false)} type="button">
                  <X size={13} />
                </button>
              </header>
              <div className="setting-row">
                <span>{text.color}</span>
                <div className="swatches">
                  {tintPresets.map((preset) => (
                    <button
                      aria-label={preset.label}
                      className={settings.tint === preset.id ? "swatch active" : "swatch"}
                      key={preset.id}
                      onClick={() => updateSettings({ tint: preset.id })}
                      style={{ "--swatch": preset.accent } as CSSProperties}
                      title={preset.label}
                      type="button"
                    />
                  ))}
                </div>
              </div>
              <label className="setting-check">
                <input
                  checked={settings.alwaysOnTop}
                  onChange={(event) => updateSettings({ alwaysOnTop: event.target.checked })}
                  type="checkbox"
                />
                {text.pin}
              </label>
              <label className="setting-check">
                <input
                  disabled={!appWindow.native}
                  checked={autoStartEnabled}
                  onChange={toggleAutoStart}
                  type="checkbox"
                />
                {text.autoStart}
              </label>
              <label className="setting-check">
                <input
                  checked={settings.eyeCare}
                  onChange={(event) => updateSettings({ eyeCare: event.target.checked })}
                  type="checkbox"
                />
                {text.eyeCare}
              </label>
              <label className="setting-number">
                <span>{text.eyeCareMinutes}</span>
                <input
                  min="1"
                  onChange={(event) =>
                    updateSettings({ eyeCareMinutes: Math.max(1, Number(event.target.value) || 1) })
                  }
                  type="number"
                  value={settings.eyeCareMinutes}
                />
              </label>
              <DataSettings store={dataStore} view={dataView} timerActive={!!timingTodoId} />
            </section>
          )}

          {calendarOpen && (
            <section className="calendar-modal" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <span>{text.calendar}</span>
                  <small>{monthLabel(calendarMonth)}</small>
                </div>
                <div className="calendar-nav">
                  <button onClick={() => changeCalendarMonth(-1)} title={text.prevMonth} type="button">
                    <ChevronLeft size={14} />
                  </button>
                  <button onClick={() => changeCalendarMonth(1)} title={text.nextMonth} type="button">
                    <ChevronRight size={14} />
                  </button>
                  <button onClick={() => setCalendarOpen(false)} type="button">
                    <X size={14} />
                  </button>
                </div>
              </header>
              <div className="calendar-grid" aria-label={text.heatmap}>
                {heatmapDays.map((day) => (
                  <button
                    className={`calendar-day level-${Math.min(day.count, 4)} ${selectedDate === day.date ? "selected" : ""}`}
                    key={day.date}
                    onClick={() => {
                      if (day.count > 0) {
                        openDiary(day.date);
                      } else {
                        setSelectedDate(selectedDate === day.date ? null : day.date);
                      }
                    }}
                    type="button"
                  >
                    <strong>{Number(day.date.slice(8))}</strong>
                    <span>{day.count > 0 ? day.count : ""}</span>
                  </button>
                ))}
              </div>
              {selectedDate ? (
                <div className="date-details">
                  <div className="date-details-header">
                    <span>{text.completedOn}</span>
                    <small>{selectedDate}</small>
                  </div>
                  <div className="date-details-list">
                    {selectedDateEvents.length > 0 ? (
                      selectedDateEvents.map((event, index) => (
                        <div className="date-detail-item" key={index}>
                          <Check size={12} />
                          <span>{event.title}</span>
                          <small>{event.listName}</small>
                        </div>
                      ))
                    ) : (
                      <p className="empty-detail">{text.none}</p>
                    )}
                  </div>
                  {(() => {
                    const timeDistribution = getTimeDistribution(todos, selectedDate);
                    if (timeDistribution.length > 0) {
                      return (
                        <div className="time-distribution-compact">
                          <strong>{text.timeDistribution}</strong>
                          <PieChart data={timeDistribution} size={100} />
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              ) : (
                <div className="latest-events">
                  <span>{text.latestDone}</span>
                  <small>
                    {latestEvents.length > 0
                      ? latestEvents.map((event) => `${event.date.slice(5)} ${event.title}`).join(" / ")
                      : text.none}
                  </small>
                </div>
              )}
            </section>
          )}

          {diaryOpen && diaryDate && (
            <section className="calendar-modal" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <span>{text.diary}</span>
                  <small>{diaryDate}</small>
                </div>
                <div className="calendar-nav">
                  <button onClick={() => setDiaryOpen(false)} type="button">
                    <X size={14} />
                  </button>
                </div>
              </header>
              <div className="diary-list">
                <div className="standalone-diary-section">
                  <strong>{text.standaloneDiary}</strong>
                  <textarea
                    onChange={(event) => setStandaloneDiaryDraft(event.target.value)}
                    onBlur={saveStandaloneDiary}
                    placeholder={text.standaloneDiaryPlaceholder}
                    rows={5}
                    value={standaloneDiaryDraft}
                  />
                </div>

                {diaryEntries.completedTodos && diaryEntries.completedTodos.length > 0 && (
                  <div className="completed-tasks-section">
                    <strong>完成的任务</strong>
                    {diaryEntries.completedTodos.map((todo) => {
                      const listName = lists.find((list) => list.id === todo.listId)?.name || text.inbox;
                      const isEditing = editingDiaryId === todo.id;

                      // 计算当天的实际工作时间
                      const timeOnDate = todo.timeEntries
                        ?.filter((entry) => businessDate(new Date(entry.startTime)) === diaryDate)
                        .reduce((sum, entry) => sum + entry.duration, 0) || 0;

                      return (
                        <div className="diary-entry" key={todo.id}>
                          <div className="diary-entry-header">
                            <div className="diary-entry-title">
                              <Check size={14} />
                              <span>{todo.title}</span>
                            </div>
                            <small>{listName}</small>
                          </div>
                          {todo.notes && (
                            <div className="diary-entry-notes">
                              <strong>{text.creationNotes}:</strong>
                              <p>{todo.notes}</p>
                            </div>
                          )}
                          {timeOnDate > 0 && (
                            <div className="diary-entry-time">
                              <strong>{text.timeSpent}:</strong>
                              <span>{formatTime(timeOnDate)}</span>
                            </div>
                          )}
                          {isEditing ? (
                            <div className="diary-entry-completion">
                              <strong>{text.completionNotes}:</strong>
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  commitDiaryEdit();
                                }}
                              >
                                <textarea
                                  autoFocus
                                  onChange={(event) => setDiaryNotesDraft(event.target.value)}
                                  onBlur={commitDiaryEdit}
                                  placeholder={text.completionNotesPlaceholder}
                                  rows={3}
                                  value={diaryNotesDraft}
                                />
                              </form>
                            </div>
                          ) : (
                            <div className="diary-entry-completion" onDoubleClick={() => startEditDiary(todo.id)}>
                              <strong>{text.completionNotes}:</strong>
                              <p>{todo.completionNotes || text.none}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {diaryDate && (() => {
                  const timeDistribution = getTimeDistribution(todos, diaryDate);
                  if (timeDistribution.length > 0) {
                    return (
                      <div className="time-distribution-section">
                        <strong>{text.timeDistribution}</strong>
                        <div className="time-chart-container">
                          <PieChart data={timeDistribution} size={200} />
                          <div className="time-legend">
                            {timeDistribution.map((item) => (
                              <div className="time-legend-item" key={item.todoId}>
                                <span className="legend-color" style={{ backgroundColor: `rgba(${item.color}, 0.8)` }} />
                                <span className="legend-title">{item.title}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            </section>
          )}
        </>
      )}

      {eyeCareNotificationVisible && (
        <div className="eye-care-notification">
          <div className="eye-care-content">
            <h3>{text.eyeCareTitle}</h3>
            <p>{text.eyeCareBody.replace("{minutes}", String(settings.eyeCareMinutes))}</p>
            <button
              className="text-button primary"
              onClick={() => setEyeCareNotificationVisible(false)}
              type="button"
            >
              知道了
            </button>
          </div>
        </div>
      )}

    </main>
  );

  function renderGroupTodos(group: VisibleGroup) {
    const visibleIds = new Set(group.todos.map((todo) => todo.id));
    const topLevelTodos = group.todos
      .filter((todo) => !todo.parentId || !visibleIds.has(todo.parentId))
      .sort(sortTodos);

    return topLevelTodos.map((todo) => {
      const children = todo.isGroup
        ? group.todos.filter((child) => child.parentId === todo.id).sort(sortTodos)
        : [];

      return (
        <div className={todo.isGroup ? "todo-stack task-stack" : "todo-stack"} key={todo.id}>
          {renderTodo(todo, false)}
          {children.length > 0 && !todo.collapsed && (
            <div className="child-todos">
              {children.map((child) => renderTodo(child, false, true))}
            </div>
          )}
        </div>
      );
    });
  }

  function renderTodo(todo: Todo, completedView: boolean, childView = false) {
    const isCompleting = completingIds.includes(todo.id);
    const openChildren = todo.isGroup ? getOpenChildTodos(todo.id, todos, completingIdSet) : [];
    const isDone =
      completedView ||
      (!todo.isGroup && todo.completed) ||
      (todo.isGroup && todo.completed && openChildren.length === 0);
    const goalText =
      isGoal(todo) && todo.goalStartDate && todo.goalEndDate
        ? ` / ${todo.goalStartDate.slice(5)}-${todo.goalEndDate.slice(5)}`
        : "";
    const durationText =
      todo.startDate && todo.endDate
        ? ` / ${todo.startDate.slice(5)}-${todo.endDate.slice(5)}`
        : todo.startDate
          ? ` / ${todo.startDate.slice(5)}`
          : "";
    const notifyText = todo.reminderTime ? ` / 每日提醒 ${todo.reminderTime}` : todo.reminderAt ? ` / 提醒 ${dateTimeLocal(new Date(todo.reminderAt)).slice(5).replace("T", " ")}` : todo.notifyAt ? ` / ${todo.notifyAt.slice(5, 10)} ${todo.notifyAt.slice(11)}` : "";
    const kindText = todo.isGroup ? text.taskGroup : childView ? text.childTask : "";
    const showTooltip = hoveredTodoId === todo.id && todo.notes;
    const isRenaming = renamingTodoId === todo.id;

    return (
      <article
        className={[
          "todo-row",
          todo.isGroup ? "task-group-row" : "",
          childView ? "child-task-row" : "",
          isDone ? "done" : "",
          isCompleting ? "completing" : "",
        ].join(" ")}
        key={todo.id}
        draggable={dataStore.canWrite && !completedView && !todo.isGroup && !isDone}
        onDragOver={(event) => (!completedView && todo.isGroup ? allowGroupDrop(event, todo.id) : undefined)}
        onDragStart={(event) => startTodoDrag(event, todo)}
        onDrop={(event) => (!completedView && todo.isGroup ? dropTodoIntoGroup(event, todo.id) : undefined)}
        onMouseEnter={() => setHoveredTodoId(todo.id)}
        onMouseLeave={() => setHoveredTodoId(null)}
        onContextMenu={(event) => openTodoMenu(event, todo.id)}
      >
        <button
          aria-label={isDone ? text.moveBack : text.markDone}
          className={`check-button ${todo.priority} ${isCompleting ? "bursting" : ""}`}
          disabled={!dataStore.canWrite || isCompleting || (!completedView && todo.isGroup && openChildren.length > 0)}
          onClick={() => completeTodo(todo.id)}
          title={!completedView && todo.isGroup && openChildren.length > 0 ? text.groupHasOpenChildren : undefined}
          type="button"
        >
          {isDone || isCompleting || (isGoal(todo) && todo.completionDates.includes(today())) ? (
            <Check size={14} />
          ) : (
            <Circle size={16} />
          )}
          {isCompleting && (
            <span className="particles" aria-hidden="true">
              {Array.from({ length: 8 }).map((_, index) => (
                <i key={index} />
              ))}
            </span>
          )}
        </button>
        {isRenaming ? (
          <form
            className="todo-rename-form"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              commitTodoRename();
            }}
          >
            <input
              autoFocus
              onBlur={commitTodoRename}
              onChange={(event) => setRenameTodoDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              value={renameTodoDraft}
            />
          </form>
        ) : (
          <div className="todo-text" onDoubleClick={() => startRenameTodo(todo.id)}>
            <span>{todo.title}</span>
            <small>
              {kindText ? `${kindText} \u00b7 ` : ""}
              {todo.dueDate ? `${todo.dueDate} \u00b7 ` : ""}
              {priorityLabel(todo.priority)}
              {goalText}
              {durationText}
              {notifyText}
            </small>
          </div>
        )}
        <div className="todo-actions">
          {todo.isGroup && (
            <button
              className={todo.collapsed ? "collapse-button collapsed" : "collapse-button"}
              onClick={(event) => {
                event.stopPropagation();
                toggleGroupCollapse(todo.id);
              }}
              type="button"
            >
              <ChevronDown size={14} />
            </button>
          )}
          <button
            aria-label={text.deleteTask}
            className="delete-button"
            disabled={!dataStore.canWrite || isCompleting}
            onClick={() => removeTodo(todo.id)}
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
        {showTooltip && (
          <div className="todo-tooltip">
            <span>{todo.notes}</span>
          </div>
        )}
      </article>
    );
  }
}

function getCompletionEvents(todos: Todo[], lists: TodoList[]): CompletionEvent[] {
  return todos
    .flatMap((todo) => {
      const listName = lists.find((list) => list.id === todo.listId)?.name || text.inbox;
      return todo.completionDates.map((date) => ({
        date,
        title: todo.title,
        listName,
      }));
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function getHeatmapDays(events: CompletionEvent[], month: Date) {
  const dates = calendarDates(month);

  return dates.map((date) => {
    const dayEvents = events.filter((event) => event.date === date);
    return {
      date,
      count: dayEvents.length,
      titles: dayEvents.map((event) => event.title),
    };
  });
}

type TimeDistribution = {
  todoId: string;
  title: string;
  timeSpent: number;
  percentage: number;
  color: string;
};

function getTimeDistribution(todos: Todo[], date: string): TimeDistribution[] {
  const colors = [
    "94, 163, 255",
    "168, 139, 250",
    "74, 222, 128",
    "251, 191, 36",
    "248, 113, 113",
    "45, 212, 191",
    "251, 146, 60",
    "244, 114, 182",
  ];

  // 统计每个任务在指定日期的实际工作时间
  const timeByTodo = new Map<string, { title: string; timeSpent: number }>();

  todos.forEach((todo) => {
    if (!todo.timeEntries || todo.timeEntries.length === 0) return;

    // 计算该任务在指定日期的所有时间条目
    const timeOnDate = todo.timeEntries
      .filter((entry) => {
        // 检查时间条目是否在指定日期
        const entryDate = businessDate(new Date(entry.startTime));
        return entryDate === date;
      })
      .reduce((sum, entry) => sum + entry.duration, 0);

    if (timeOnDate > 0) {
      const existing = timeByTodo.get(todo.id);
      if (existing) {
        existing.timeSpent += timeOnDate;
      } else {
        timeByTodo.set(todo.id, {
          title: todo.title,
          timeSpent: timeOnDate,
        });
      }
    }
  });

  // 转换为数组并计算百分比
  const todosWithTime = Array.from(timeByTodo.entries()).map(([todoId, data], index) => ({
    todoId,
    title: data.title,
    timeSpent: data.timeSpent,
    percentage: 0,
    color: colors[index % colors.length],
  }));

  const totalTime = todosWithTime.reduce((sum, item) => sum + item.timeSpent, 0);

  if (totalTime === 0) return [];

  // 按时间从多到少排序
  return todosWithTime
    .map((item) => ({
      ...item,
      percentage: (item.timeSpent / totalTime) * 100,
    }))
    .sort((a, b) => b.timeSpent - a.timeSpent);
}

function PieChart({ data, size = 120 }: { data: TimeDistribution[]; size?: number }) {
  if (data.length === 0) {
    return (
      <div className="pie-chart-empty" style={{ width: size, height: size }}>
        <span>{text.noTimeData}</span>
      </div>
    );
  }

  const radius = size / 2;
  const centerX = radius;
  const centerY = radius;
  const pieRadius = radius * 0.6; // 从 0.35 增大到 0.6
  const labelRadius = radius * 0.85; // 从 0.75 增大到 0.85

  if (data.length === 1) {
    const item = data[0];
    const timeText = formatDuration(item.timeSpent);

    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pie-chart">
        <circle
          cx={centerX}
          cy={centerY}
          fill={`rgba(${item.color}, 0.8)`}
          r={pieRadius}
          stroke="rgba(0,0,0,0.1)"
          strokeWidth="1"
        >
          <title>{`${item.title}: 100.0%`}</title>
        </circle>
        {/* 引导线和标签 - 放在右侧 */}
        <line
          x1={centerX + pieRadius}
          y1={centerY}
          x2={centerX + labelRadius}
          y2={centerY}
          stroke={`rgba(${item.color}, 0.6)`}
          strokeWidth="1"
        />
        <line
          x1={centerX + labelRadius}
          y1={centerY}
          x2={centerX + labelRadius + 15}
          y2={centerY}
          stroke={`rgba(${item.color}, 0.6)`}
          strokeWidth="1"
        />
        <text
          x={centerX + labelRadius + 18}
          y={centerY}
          fill="rgba(255,255,255,0.9)"
          fontSize="12"
          dominantBaseline="middle"
          textAnchor="start"
        >
          {timeText}
        </text>
      </svg>
    );
  }

  let currentAngle = -90;

  const slices = data.map((item) => {
    const angle = (item.percentage / 100) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    const midAngle = (startAngle + endAngle) / 2;

    currentAngle = endAngle;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const midRad = (midAngle * Math.PI) / 180;

    const x1 = centerX + pieRadius * Math.cos(startRad);
    const y1 = centerY + pieRadius * Math.sin(startRad);
    const x2 = centerX + pieRadius * Math.cos(endRad);
    const y2 = centerY + pieRadius * Math.sin(endRad);

    const largeArc = angle > 180 ? 1 : 0;

    const pathData = [
      `M ${centerX} ${centerY}`,
      `L ${x1} ${y1}`,
      `A ${pieRadius} ${pieRadius} 0 ${largeArc} 1 ${x2} ${y2}`,
      "Z",
    ].join(" ");

    // 标签位置 - 从圆边缘开始
    const edgeX = centerX + pieRadius * Math.cos(midRad);
    const edgeY = centerY + pieRadius * Math.sin(midRad);
    const labelX = centerX + labelRadius * Math.cos(midRad);
    const labelY = centerY + labelRadius * Math.sin(midRad);

    // 水平延伸方向
    const isRightSide = labelX > centerX;
    const labelEndX = isRightSide ? labelX + 20 : labelX - 20; // 从 15 增加到 20
    const labelEndY = labelY;

    // 文字对齐方式
    const textAnchor: "start" | "end" = isRightSide ? "start" : "end";
    const textX = isRightSide ? labelEndX + 5 : labelEndX - 5; // 从 3 增加到 5

    return {
      pathData,
      color: item.color,
      title: item.title,
      percentage: item.percentage,
      timeSpent: item.timeSpent,
      edgeX,
      edgeY,
      labelX,
      labelY,
      labelEndX,
      labelEndY,
      textX,
      textY: labelEndY,
      textAnchor,
      isRightSide,
    };
  });

  // 防重叠算法：调整标签的 Y 坐标
  const minSpacing = 16; // 最小间距（像素）
  const leftLabels = slices.filter(s => !s.isRightSide).sort((a, b) => a.textY - b.textY);
  const rightLabels = slices.filter(s => s.isRightSide).sort((a, b) => a.textY - b.textY);

  // 调整左侧标签
  for (let i = 1; i < leftLabels.length; i++) {
    const prev = leftLabels[i - 1];
    const curr = leftLabels[i];
    if (curr.textY - prev.textY < minSpacing) {
      curr.textY = prev.textY + minSpacing;
      curr.labelEndY = curr.textY;
    }
  }

  // 调整右侧标签
  for (let i = 1; i < rightLabels.length; i++) {
    const prev = rightLabels[i - 1];
    const curr = rightLabels[i];
    if (curr.textY - prev.textY < minSpacing) {
      curr.textY = prev.textY + minSpacing;
      curr.labelEndY = curr.textY;
    }
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pie-chart">
      {/* 绘制扇形 */}
      {slices.map((slice, index) => (
        <path key={`slice-${index}`} d={slice.pathData} fill={`rgba(${slice.color}, 0.8)`} stroke="rgba(0,0,0,0.1)" strokeWidth="1">
          <title>{`${slice.title}: ${slice.percentage.toFixed(1)}%`}</title>
        </path>
      ))}
      {/* 绘制引导线和标签 */}
      {slices.map((slice, index) => (
        <g key={`label-${index}`}>
          {/* 第一段：从圆边缘到外圈 */}
          <line
            x1={slice.edgeX}
            y1={slice.edgeY}
            x2={slice.labelX}
            y2={slice.labelY}
            stroke={`rgba(${slice.color}, 0.6)`}
            strokeWidth="1"
          />
          {/* 第二段：水平延伸 */}
          <line
            x1={slice.labelX}
            y1={slice.labelY}
            x2={slice.labelEndX}
            y2={slice.labelEndY}
            stroke={`rgba(${slice.color}, 0.6)`}
            strokeWidth="1"
          />
          <text
            x={slice.textX}
            y={slice.textY}
            fill="rgba(255,255,255,0.9)"
            fontSize="11"
            dominantBaseline="middle"
            textAnchor={slice.textAnchor}
          >
            {formatDuration(slice.timeSpent)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default App;
