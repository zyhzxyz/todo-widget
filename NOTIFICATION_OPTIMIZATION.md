# 护眼提醒和折叠功能优化

## 优化内容

### 1. 恢复任务集折叠按钮 ✅
- **恢复折叠小三角按钮**
  - 任务集右侧重新显示折叠/展开按钮
  - 点击可以收起或展开子任务
  - 保留简化的右键菜单（不再有"收纳子任务"选项）

- **实现细节**
  - 恢复 `ChevronDown` 图标导入
  - 恢复 `toggleGroupCollapse(id)` 函数
  - 恢复折叠按钮 UI 组件

### 2. 护眼提醒改用 Windows 系统通知 ✅
- **从应用内模态框改为系统通知**
  - 不再在应用内弹出提醒框
  - 直接使用 Windows 系统通知
  - 通知出现在屏幕右下角
  - 更符合 Windows 用户习惯

- **技术实现**
  - 添加 Tauri 通知插件依赖
    - 前端：`@tauri-apps/plugin-notification`
    - 后端：`tauri-plugin-notification = "2"`
  - 在 `tauri.conf.json` 中启用通知权限
  - 在 Rust 主文件中注册通知插件
  - 修改前端代码使用系统通知 API

- **删除的代码**
  - `eyeCareVisible` 状态
  - `setEyeCareVisible` 调用
  - `resetEyeCareClock()` 函数
  - `snoozeEyeCare()` 函数
  - `EYE_CARE_SNOOZE_MS` 常量
  - 护眼提醒模态框 UI
  - "已休息"和"稍后提醒"按钮

## 代码改动

### Tauri 配置 (tauri.conf.json)
```json
{
  "plugins": {
    "notification": {
      "all": true
    }
  }
}
```

### Rust 依赖 (Cargo.toml)
```toml
[dependencies]
tauri-plugin-notification = "2"
```

### Rust 主文件 (main.rs)
```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // ...
}
```

### 前端通知调用 (App.tsx)
```typescript
if (eyeCareActiveMsRef.current >= settings.eyeCareMinutes * 60 * 1000) {
  // 使用系统通知
  import("@tauri-apps/plugin-notification").then(({ sendNotification }) => {
    sendNotification({
      title: text.eyeCareTitle,
      body: text.eyeCareBody.replace("{minutes}", String(settings.eyeCareMinutes)),
    });
  });
  eyeCareActiveMsRef.current = 0;
}
```

## 用户体验改进

### 折叠功能
- **更直观**：小三角按钮清楚地表明任务集可以折叠
- **更灵活**：用户可以自由控制任务集的展开/收起状态
- **保持简洁**：右键菜单不再有冗余的折叠选项

### 系统通知
- **更原生**：使用 Windows 原生通知，符合系统习惯
- **不打扰**：通知出现在右下角，不会遮挡应用界面
- **更简洁**：不需要手动点击"已休息"按钮
- **自动消失**：系统通知会自动消失，不需要手动关闭

## 对比

### 护眼提醒 - 优化前
- 应用内弹出模态框
- 遮挡应用界面
- 需要点击"已休息"或"稍后提醒"
- 不符合 Windows 通知习惯

### 护眼提醒 - 优化后
- Windows 系统通知
- 出现在右下角
- 自动消失
- 符合系统习惯

### 折叠功能 - 优化前（第一次改动）
- 删除了折叠按钮
- 子任务始终显示
- 用户反馈需要折叠功能

### 折叠功能 - 优化后
- 恢复折叠按钮
- 保留简化的右键菜单
- 用户可以自由控制

## 版本信息
- 优化日期：2026-05-24
- 优化类型：功能改进
- 主要改进：
  1. 恢复任务集折叠按钮
  2. 护眼提醒改用 Windows 系统通知
