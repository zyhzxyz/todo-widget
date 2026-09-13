# Todo Widget — AstrBot 插件

默认禁用，仅白名单 QQ **私聊**。服务器存任务，插件通过独立 bot token 访问；QQ/NapCat 不直接打开 SQLite，不需要同步 LevelDB。Python 3.12+，Linux/Docker；依赖已安装的 AstrBot（当前容器框架已隔离检查 Star、事件接口、命令和工具装饰器）。

## 安装（不会自动替你安装或重启机器人）

本 GitHub 仓库是 monorepo，**不要将整个 todo-widget 仓库作为 AstrBot 插件直接安装**。

1. 仓库根目录运行 `python3 tools/package_astrbot.py`，得到 `artifacts/astrbot_plugin_todo_widget.zip`，然后使用 AstrBot 的本地插件 ZIP 上传安装。 也可从 `feature/server-astrbot` 的成功 GitHub Actions 下载 `astrbot-plugin-todo-widget` artifact：先解压 Actions 的外层 ZIP，再上传其中的 `astrbot_plugin_todo_widget.zip`，不要上传外层包。
2. 或者只复制这个目录到 AstrBot 的 `data/plugins/astrbot_plugin_todo_widget`，确认所有文件归 AstrBot 容器的运行 UID/GID 所有，再由管理员加载插件。不要改整个 `data` 树的权限。
3. 在插件配置里填写 `server_url`、独立 **bot token**、`allowed_qq_ids`（字符串列表）和 `allowed_platform_ids`（平台**实例 ID**，不是类型名 `aiocqhttp`）。先保持禁用，检查地址和白名单后启用。
4. 由允许的 QQ 在指定平台私聊发送 `/待办 绑定`。绑定收件人只来自真实消息事件，工具/模型不能指定另一个人。已有其他绑定时先从桌面解除，不能直接抢占。
5. 管理员确认后执行真实发送验收：建一个几分钟后的提醒，同时检查桌面状态和实际 QQ 消息；不能把单元测试当成真实送达。

**网络：** AstrBot/NapCat 使用 host 网络时，API 也使用 host 网络且仅监听 `127.0.0.1:3210`，插件地址就是 `http://127.0.0.1:3210`。如果换为 Docker bridge，须让服务在同一私有网络，使用 `http://todo-api:3210` 并显式启用 `allow_internal_http`；容器的 `localhost` 不会指向另一个 bridge 容器。公网必须 HTTPS。

## 命令

- `/待办 绑定`、`/待办 解除绑定`：只处理当前私聊。
- `/待办 查询 [关键词或精确ID]`：返回服务器日期/时区与任务；重名先查询再决定。
- `/待办 添加 买牛奶`：普通任务，不默认设提醒。
- `/待办 目标 2026-09-14 2026-10-14 20:30 每天读书`：每日目标；`20:30` 可改为 `不提醒`。
- `/待办 完成 任务ID [YYYY-MM-DD]`、`/待办 撤销 任务ID [YYYY-MM-DD]`：每日目标默认服务器今天。
- `/待办 提醒 任务ID 2026-09-14T20:30:00+08:00`：一次性提醒。
- `/待办 提醒 任务ID 每日20:30`：只适用于每日目标。
- `/待办 提醒 任务ID 清除`：取消提醒。
- `/待办 重试`：用原编号/原请求确认未完成的写入，不重复创建。

四个自然语言工具：`todo_widget_query/create/complete/remind`。每个工具都重复校验真实事件身份，不能靠提示词绕过白名单。工具要求精确任务 ID、明确日期和带时区的一次性时间；提示模型遇到“晚上”“过几天”等模糊表达先追问。自然语言理解仍依赖所接 LLM，重要任务请核对返回的 ID、日期和时刻；确定性命令不依赖 LLM。

## 权限与数据

- bot token 不能读取日记、完整导出、完成说明或详细计时，不能调用桌面写入 API。查询工具还会进一步缩减字段。
- 普通任务截止日期不是提醒时间。只在显式设置提醒后推送；一次性提醒和每日提醒互斥。
- token 位于 AstrBot 插件配置中，不会写入本插件日志；它仍是密钥，应保护配置文件和宿主机账户。不要发给模型或提交 Git。
- 专用日志目录：`/AstrBot/data/plugin_data/astrbot_plugin_todo_widget/`，目录 0700，日志 0600。包含任务操作和发送回执等个人数据，只能由运行插件的 UID 写入。
- 损坏日志、不同 server_url 对应的旧日志、第二个进程争用、磁盘写入失败均 fail-closed，不自动清空。处理前先备份，不要随手删日志。
- 插件日志保留最多 10,000 个操作用于消息重放去重，达到上限时拒绝新写入而不是遗失幂等编号。归档维护须先停插件、确认无未确认操作并保留旧日志；归档后不能再重放旧 QQ 事件。

## 发送可靠性与边界

服务器 SQLite outbox → 一次领取1条（120秒租约）→ 再验证任务/绑定 → OneBot `send_private_msg`（显式 text segment，不执行标题里的 CQ 码）→ **非零 `message_id`** → 本机原子回执日志 + fsync → API ACK。

`Context.send_message()` 返回 True 只代表找到平台，不能当送达；此插件不使用这个 bool 来 ACK。错误、无回执、QQ 超时走 NACK。ACK 丢失先重试 ACK；租约变更时沿用持久化回执，不重复发送。发送中卸载会等待有界的当前 tick 收尾。

这是**至少一次**语义，不是 exactly-once：QQ 已收到但进程在回执落盘前被杀死，或者 QQ 超时但其实已发送，仍可能重复。拿到回执也不等于用户已阅读。完成/删除/改期在最终验证前会取消旧提醒；最终检查与 QQ 发送之间极短的竞态无法跨两个系统做原子事务。

- 失败退避从15秒起，最多8次，之后状态 `failed`；无绑定不消耗次数。
- 一次性只补发24小时内的提醒，每日只补当天，避免恢复后一口气刷历史记录。
- 失败/错过的提醒不自动无限重发；修复网络/权限后，由用户设置**新的提醒时刻**重新排程，并在桌面“QQ 提醒状态”检查。
- 回执写不进去时停止 worker，不盲目继续发。检查目录 UID/GID、磁盘、日志权限；不要未经核对删除日志重启。

共享文件：本版只发送文字，**不需要** AstrBot/NapCat 共享附件目录。如果以后加附件，只共享独立的 `/AstrBot/data/todo-widget-exchange`，不要让 NapCat 写 API 的数据库卷。已有 AstrBot/NapCat 若整棵 `/AstrBot/data` 共享且均以 root 运行，这不是安全隔离边界；需由管理员另行缩小挂载范围。
