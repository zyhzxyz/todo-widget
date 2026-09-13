import type { Todo } from './domain.ts';

/** A group and its currently present children form one recoverable deletion batch. */
export function deletionIds(todos: Todo[], id: string): Set<string> {
  const target = todos.find(todo => todo.id === id && !todo.deletedAt);
  if (!target) return new Set();
  return new Set(todos.filter(todo => !todo.deletedAt &&
    (todo.id === id || (target.isGroup && todo.parentId === id))).map(todo => todo.id));
}

export function trashTodo(todos: Todo[], id: string, now: string, batchId: string): Todo[] {
  const ids = deletionIds(todos, id);
  if (!ids.size) return todos;
  return todos.map(todo => ids.has(todo.id)
    ? { ...todo, deletedAt: now, deletionBatchId: batchId, updatedAt: now }
    : todo);
}

/** Restore only this batch, never children that were deleted separately earlier. */
export function restoreTodo(todos: Todo[], id: string, now: string): Todo[] {
  const target = todos.find(todo => todo.id === id && todo.deletedAt);
  if (!target) return todos;
  const ids = new Set(todos.filter(todo => todo.deletedAt && (todo.id === id ||
    (target.isGroup && todo.parentId === id && todo.deletionBatchId === target.deletionBatchId)))
    .map(todo => todo.id));
  return todos.map(todo => {
    if (!ids.has(todo.id)) return todo;
    const parent = todos.find(item => item.id === todo.parentId);
    return {
      ...todo, deletedAt: undefined, deletionBatchId: undefined, updatedAt: now,
      // Restoring a child by itself must not hide it under a still-deleted group.
      parentId: parent && (!parent.deletedAt || ids.has(parent.id)) ? parent.id : undefined,
      // Do not silently re-send an old reminder after recovering a task.
      reminderAt: undefined, reminderTime: undefined, notifyAt: undefined, notifyDate: undefined,
    };
  });
}

/** Completion history/notes/time stay intact; a goal undo removes only the selected day. */
export function undoCompletion(todos: Todo[], id: string, date: string, now: string): Todo[] {
  const target = todos.find(todo => todo.id === id && !todo.deletedAt);
  if (!target || (target.goalStartDate ? !target.completionDates.includes(date) : !target.completed)) return todos;
  return todos.map(todo => {
    if (todo.deletedAt) return todo;
    if (todo.id !== id && todo.id !== target.parentId && !(target.isGroup && todo.parentId === id)) return todo;
    return {
      ...todo, completed: false, updatedAt: now,
      completionDates: todo.goalStartDate ? todo.completionDates.filter(day => day !== date) : todo.completionDates,
    };
  });
}
