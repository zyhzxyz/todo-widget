# 拖拽功能修复说明

## 问题分析

用户反馈：普通任务无法拖入任务集

## 修复内容

### 1. 简化 `startTodoDrag` 函数
**问题**：之前在函数中调用 `event.preventDefault()` 阻止了拖拽
**修复**：移除了所有阻止逻辑，因为 `draggable` 属性已经控制了哪些元素可以拖拽

```javascript
// 修复前
function startTodoDrag(event, todo) {
  if (todo.isGroup || todo.completed || completingIds.includes(todo.id)) {
    event.preventDefault();  // ❌ 这会阻止拖拽
    return;
  }
  // ...
}

// 修复后
function startTodoDrag(event, todo) {
  // draggable 属性已经控制了哪些任务可以拖拽
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-todo-id", todo.id);
  event.dataTransfer.setData("text/plain", todo.id);
}
```

### 2. 优化 `allowGroupDrop` 函数
**改进**：添加 `stopPropagation()` 防止事件冒泡

```javascript
function allowGroupDrop(event, groupId) {
  const group = todos.find((todo) => todo.id === groupId);
  if (!group?.isGroup) return;

  event.preventDefault();      // 必须调用才能允许 drop
  event.stopPropagation();     // 防止事件冒泡
  event.dataTransfer.dropEffect = "move";
}
```

### 3. 增强 `dropTodoIntoGroup` 函数
**改进**：
- 添加详细的 console.log 调试信息
- 分离每个检查条件，便于定位问题
- 添加注释说明每个检查的目的

```javascript
function dropTodoIntoGroup(event, groupId) {
  event.preventDefault();
  event.stopPropagation();

  const draggedId = event.dataTransfer.getData("application/x-todo-id") || 
                    event.dataTransfer.getData("text/plain");
  
  // 详细的检查和日志
  if (!draggedId) {
    console.log("No dragged ID found");
    return;
  }

  const group = todos.find((todo) => todo.id === groupId);
  const dragged = todos.find((todo) => todo.id === draggedId);

  console.log("Drop attempt:", { 
    draggedId, 
    groupId, 
    group: group?.title, 
    dragged: dragged?.title 
  });

  // 各种检查...
  // 每个检查都有对应的日志输出
}
```

## 调试方法

安装新版本后，打开浏览器开发者工具（F12），查看 Console 面板：

1. **拖拽开始时**：应该能看到拖拽数据被设置
2. **拖拽到任务集上时**：应该看到 "Drop attempt:" 日志
3. **如果失败**：会看到具体的失败原因（如 "Target is not a group"）
4. **如果成功**：会看到 "Drop successful, updating todos"

## 测试步骤

1. 在科研/生活窗口创建一个任务集
2. 创建一个普通任务
3. 拖拽普通任务到任务集上
4. 查看 Console 日志，确认拖拽流程
5. 检查任务是否成功进入任务集

## 关键点

- `draggable={!completedView && !todo.isGroup && !isDone}` 控制哪些元素可拖拽
- `onDragStart` 只负责设置拖拽数据，不应该阻止事件
- `onDragOver` 必须调用 `preventDefault()` 才能允许 drop
- `onDrop` 处理实际的拖放逻辑

## 版本信息

- 修复版本：0.1.0
- 修复日期：2026-05-24
- 修复次数：第二次优化
