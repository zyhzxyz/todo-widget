# Todo Widget

Windows 桌面待办小组件，使用 **Tauri 2 + React + TypeScript**。包含任务清单、任务集、独立计时窗口、完成日历和日记。

> 此功能分支增加独立的服务器模式，原本地模式仍保留。实现范围和验收门槛见 [计划](docs/SERVER_ASTRBOT_PLAN.md)，接口见 [API 文档](docs/API.md)，上线步骤见 [部署与恢复指南](docs/DEPLOYMENT.md)；历史 `*_OPTIMIZATION.md` 等文件是开发过程记录，不代表当前验收结果。近期修复见 [CHANGELOG.md](CHANGELOG.md)。

## 开发与构建

需要 Node.js 24；桌面构建还需要 Rust，以及 [Tauri Windows 开发依赖](https://v2.tauri.app/start/prerequisites/)。

```powershell
npm ci
npm test                 # 自动化回归测试
npm run build            # TypeScript 检查 + 前端构建
npm run tauri:dev        # 桌面开发模式
npm run tauri:build      # 生成 EXE（不生成安装包）
npm run tauri:bundle     # 生成安装包
```

EXE 路径：`src-tauri\target\release\todo-widget.exe`。GitHub Actions 成功完成 Windows 构建后，也可从对应 workflow 的 artifact 下载 `todo-widget-windows`。 服务器模式请选择 `feature/server-astrbot` 分支的成功运行；Windows/插件产物的解压方式见 [下载说明](docs/DEPLOYMENT.md#0-获取-windows-与插件构建产物)。

单独的 `npm run dev` 只是前端开发服务器；原生窗口功能需要从 Tauri 启动，不能将普通浏览器预览当成完整桌面程序。

## 当前功能与操作

- 半透明无边框窗口、拖动、位置锁定、置顶和系统托盘。
- 待办总览与清单标签；右键清单可新建、重命名、删除非默认清单。
- 在非“待办总览”的清单空白处右键，创建任务、任务集或定时显示的通知任务。
- 任务完成/取消完成、搜索、优先级排序、备注和任务集折叠。
- 右键空白处创建每日目标，设置起止日期及可选的每日 QQ 提醒；普通任务支持一次性 QQ 提醒（服务器模式 + 机器人绑定后发送）。
- 右键任务开始/停止计时，独立计时窗口支持暂停、继续。
- 完成日历、时间分布与日记；日历目前是主窗口内面板，并非独立原生窗口。
- 护眼提醒目前为应用内提示音和提示面板，并非 Windows 系统通知。
- 窗口不显示在任务栏，最小化后通过系统托盘恢复；开机启动可在设置中切换。

## 个人数据

**纯本地模式**的任务、清单、设置和日记保存在 WebView2 的 `localStorage`，不在 Git 仓库中。服务器模式的业务数据存入 API 的独立 SQLite 数据卷，设备设置仍留本机。原本地数据目录通常为：

```text
%LOCALAPPDATA%\com.local.todo-widget\EBWebView\Default\Local Storage\leveldb\
```

存储键：`todo-widget.todos`、`todo-widget.lists`、`todo-widget.settings`、`todo-widget.diary`。计时和每日完成记录包含在任务数据中。

不要通过 Syncthing 双向同步正在使用中的 LevelDB 目录。也不要将个人数据或访问令牌提交到 Git。升级前应保留备份；设置中的“数据与服务器”提供显式 JSON 导出、空服务器预检/导入，而不是直接搬运浏览器数据库文件。

## 服务器模式与迁移

1. 先在原本地模式的设置面板导出 JSON，核对任务、完成记录和日记，保留离线备份。
2. 按 [部署指南](docs/DEPLOYMENT.md) 启动独立 API 服务（Docker Compose 或 Node 24，两个不同的随机 token）。默认只监听 `127.0.0.1:3210`；公网连接必须配置 HTTPS。
3. 桌面设置输入服务器地址和 **app token**。连接本身不上传本地任务；新服务器应显示空数据。
4. 选择备份文件预检并确认导入。仅允许向原始空数据库导入；账户时区必须和备份一致（中国用户通常 `Asia/Shanghai`）。
5. 原本地业务数据和设备设置保留；远程数据用独立只读缓存。不要双向同步 LevelDB 或在线 SQLite。

远程模式断网只读。并发修改返回冲突，不覆盖服务器；请求结果不明时保留原操作编号重试。待保存内容可导出后明确放弃；切换数据源不会偷偷合并任务。

访问 token 仅存当前会话，不是系统密码保险库。缓存、JSON 备份及待确认日志包含个人数据，应保护设备账户。运行中的计时每 5 秒保留本机恢复副本，停止后确认写入才清理；崩溃或系统强杀可能丢失最后一个检查点后的秒数，暂停/离线计时不会假装已上传。恢复副本可手动补记、导出或放弃。

## AstrBot / QQ

[插件安装与使用](integrations/astrbot_plugin_todo_widget/README.md)。先运行 `npm run package:plugin`，在 AstrBot 中安装生成的专用 ZIP；**不要直接把本仓库作为 Git 插件安装**。默认禁用，配置 bot token、QQ 白名单和平台实例 ID 后，使用自己的 QQ 私聊绑定。

- QQ 命令或自然语言工具可以查询、创建任务/每日目标、完成任务、设置提醒；模糊日期需要确认，API 成功才算写入。
- 桌面任务存到服务器后，由持久化提醒队列交给插件发送。失败退避重试，取得 OneBot `message_id` 并持久化回执后才 ACK。
- 当前为**文字提醒，无需与 NapCat 共享任务数据库**。用户现有两个容器均为 host 网络，可访问服务器 loopback API；换成 bridge 时必须调整网络地址。
- QQ 已收到但回执尚未落盘时崩溃等场景仍可能重复，不承诺 exactly-once。

## 测试范围

`npm test` 覆盖本地日期/月份、到期显示、跨日每日目标、空清单重启、置顶恢复、计时切换/暂停及异步窗口竞态。原生 Tauri API 在自动化前端测试中被模拟，不能代替真实 Windows 的托盘、多显示器、休眠与窗口操作验收。

`npm run check:tauri-versions` 比较 npm/Rust 锁文件中的 Tauri API/插件 major.minor，允许 patch 差异；`npm run test:tools` 检查版本漂移检测逻辑（Python 3.12）。它不能代替原生构建。

服务器/API 与桌面数据层测试：`npm run test:server`；插件单元测试：`npm run test:plugin`（Python 3.12）。`npm run test:e2e` 使用临时 Node API/SQLite 和模拟 OneBot，覆盖请求丢失、重启、提醒失败与备份恢复。真实 Chromium + 隔离 Docker Compose 测试见 [部署指南](docs/DEPLOYMENT.md#7-可复现检查与真实验收)。

GitHub Actions 检查前端/服务/插件/工具、隔离端到端并构建插件 ZIP 和 Windows EXE；已通过的提交与运行链接见 [计划进度记录](docs/SERVER_ASTRBOT_PLAN.md#进度记录)，后续提交以各自的 CI 结果为准。真实 Windows 原生操作、用户旧数据迁移与真实 QQ 收发仍需单独验收，自动化不会调用生产机器人。

## 早期原型

`TodoWidget.ps1` 和 `Start-TodoWidget.cmd` 是早期 PowerShell/WPF 原型，正式使用以 Tauri 版本为准。
