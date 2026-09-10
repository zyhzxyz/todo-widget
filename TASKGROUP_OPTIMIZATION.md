# 任务集功能优化

## 优化内容

### 1. 子任务右键菜单增强 ✅
- **新增"移除任务集"选项**
  - 子任务右键菜单现在包含"移除任务集"选项
  - 点击后将子任务从任务集中移除，恢复为独立任务
  - 实现函数：`removeFromGroup(taskId)`

### 2. 移除"收纳子任务"功能 ✅
- **删除折叠/展开按钮**
  - 任务集不再显示折叠/展开按钮
  - 子任务始终显示，不再支持收纳
  - 删除了 `toggleGroupCollapse` 函数
  - 删除了 `ChevronDown` 图标导入
  - 删除了 `childCount` 变量

- **简化右键菜单**
  - 任务集右键菜单移除"收纳子任务"/"展开子任务"选项
  - 保留"添加任务到此任务集"和"编辑任务"选项

### 3. 任务集支持优先级 ✅
- **创建任务集时可选择优先级**
  - 低优先级（灰色）
  - 普通优先级（蓝色）
  - 重要优先级（红色）

- **编辑任务集优先级**
  - 右键任务集 → 编辑任务
  - 可修改任务集的优先级

- **实现细节**
  - 修改创建模态框条件：`creationMode !== "notification"` 时显示优先级选择
  - 任务集和普通任务都支持优先级
  - 只有普通任务才显示开始/结束日期

## 代码改动

### 新增功能
```typescript
function removeFromGroup(taskId: string) {
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
```

### 删除功能
- `toggleGroupCollapse(id: string)` - 折叠/展开功能
- `childCount` 变量 - 子任务计数
- 折叠按钮 UI 组件
- `ChevronDown` 图标

### 修改逻辑
```typescript
// 优先级选择条件
{creationMode !== "notification" && (
  <label className="form-field">
    <span>{text.priority}</span>
    <select>...</select>
  </label>
)}

// 日期选择条件（仅普通任务）
{creationMode !== "notification" && creationMode !== "group" && (
  <div className="dual-fields">...</div>
)}
```

## 右键菜单结构

### 任务集右键菜单
- 添加任务到此任务集
- 编辑任务（优先级）
- 编辑备注

### 子任务右键菜单
- 编辑任务（优先级、时间）
- **移除任务集**（新增）
- 编辑备注

### 普通任务右键菜单
- 编辑任务（优先级、时间）
- 编辑备注

## 用户体验改进

1. **更简洁的界面**
   - 移除了不常用的折叠功能
   - 子任务始终可见，更直观

2. **更灵活的管理**
   - 子任务可以随时移除任务集
   - 任务集支持优先级，便于排序

3. **统一的交互**
   - 任务集和普通任务都支持优先级
   - 右键菜单逻辑更清晰

## 版本信息
- 优化日期：2026-05-24
- 优化类型：功能增强
- 主要改进：
  1. 子任务可移除任务集
  2. 删除折叠功能
  3. 任务集支持优先级
