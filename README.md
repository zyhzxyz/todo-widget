# Todo Widget

一个 Windows 桌面待办小组件。正式版本使用 Tauri + React + TypeScript，窗口是半透明、无边框、可拖动、可置顶的小组件。

## 直接运行

双击项目根目录里的快捷方式：

```text
Todo Widget.lnk
```

或者直接双击已打包的 exe：

```text
src-tauri\target\release\todo-widget.exe
```

这两种方式都不会打开 CMD 窗口。

## 开发运行

```powershell
npm run tauri:dev
```

## 重新打包

生成可直接双击的 exe：

```powershell
npm run tauri:build
```

生成安装包：

```powershell
npm run tauri:bundle
```

## 已实现

- 半透明无边框小组件窗口
- 拖动顶部移动窗口
- 置顶开关
- 位置锁定
- 折叠/展开
- 默认清单窗口：待办、今天、重要
- 待办总览会汇总所有未完成任务，并按窗口分组
- 新增清单窗口
- 重命名清单窗口
- 右键清单可删除非默认窗口，清单改为空名也会删除
- 右键清单也可以新建窗口
- 隐藏的完成视图
- 独立完成日历窗口，显示本月完成热力图和最近完成记录
- 添加任务
- 清单旁的 `+` 用于创建任务
- 添加每日目标任务：指定起止日期，每天出现一次
- 标记完成/取消完成
- 删除任务
- 搜索任务
- 完成动画和粒子反馈
- 重要任务优先排序
- 默认不置顶，可在设置里打开置顶
- 设置面板支持基础颜色切换
- 最小化会隐藏到任务栏，点击任务栏图标恢复
- 本地保存任务和窗口设置

## 备用原型

`TodoWidget.ps1` 和 `Start-TodoWidget.cmd` 是早期的 PowerShell + WPF 原型。正式使用建议运行 Tauri 版本。
