# API v1

Node.js **24+**（使用 `node:sqlite` 与原生 TypeScript 类型擦除）。安装：仓库根目录 `npm ci`。
所有业务端点必须 `Authorization: Bearer <token>`，JSON 请求，响应 `Cache-Control: no-store`。
API 默认 `127.0.0.1:3210`；只有 `/healthz` 无需认证。不要在 URL 中传 token。

## 环境变量

| 变量 | 默认/要求 |
| --- | --- |
| `TODO_APP_TOKEN` | 必填，随机 32 字符以上 |
| `TODO_BOT_TOKEN` | 必填，与 app token 不同；随机 32 字符以上 |
| `TODO_DB_PATH` | `/var/lib/todo-widget/todo.db`，必须是项目外路径 |
| `TODO_HOST` / `TODO_PORT` | `127.0.0.1` / `3210` |
| `TODO_TIMEZONE` | `Asia/Shanghai`，数据库创建后不允许静默更改 |
| `TODO_CORS_ORIGINS` | 默认仅 Tauri localhost 与 Vite localhost，逗号分隔；无通配符 |

建议分别用 `openssl rand -hex 32` 生成两个 token，放在 Git 之外、权限 600 的环境文件里。
`npm run server:start` 不自动读取 `.env`，可用 `node --env-file=/安全位置/todo.env server/src/index.ts`，或者 Docker `env_file`。

## 桌面 token

- `GET /api/v1/state` → `{revision,timeZone,lists,todos,diary}`。
- `POST /api/v1/mutations` → 原子应用记录级变更：
  ```json
  {"mutationId":"UUID","expectedRevision":0,"operations":[{"type":"todo.put","value":{"...":"完整任务字段，见 shared/domain.ts"}}]}
  ```
  变更类型：`todo.put/delete`、`list.put/delete`、`diary.put/delete`。删除用 `id`。
  成功返回 `{snapshot,committedRevision,replayed,result}`。
  旧 revision 返回 `409 REVISION_CONFLICT`，不能自动套用到新快照。相同幂等键与相同内容可安全重试；不同内容返回 `409 IDEMPOTENCY_MISMATCH`。
- `GET /api/v1/export` → 版本 1 业务备份。
- `POST /api/v1/import/preview`，body 为备份 → 数量、是否可导入、revision。
- `POST /api/v1/import`，body 为 `{mutationId,expectedRevision,backup}`。仅全新数据库（revision=0）可导入；全部校验、事务提交，拒绝覆盖现有数据。
- `GET /api/v1/status` → 提醒统计与当前绑定；`DELETE /api/v1/binding` 解除 QQ 绑定。

备份格式：`{format:"todo-widget.backup",version:1,exportedAt,timeZone,business:{lists,todos,diary},deviceSettings?}`。
`deviceSettings` 不写入服务器，不推测旧历史日期。时区不匹配则拒绝导入。

## Bot token（不能访问以上端点）

- `GET /api/v1/bot/tasks` → revision、服务器时间/日期/时区、清单、任务；**无日记、完成说明或详细计时记录**。
- `POST /api/v1/bot/actions`：公共字段 `mutationId`、`expectedRevision`。
  - `action:"create",task:{title,listId?,priority?,notes?,dueDate?,goalStartDate?,goalEndDate?,reminderAt?,reminderTime?}`。
  - `action:"complete",taskId,completed,date?`。每日目标按日期增删完成记录；普通任务设置明确状态，不做不幂等的 toggle。
  - `action:"remind",taskId,reminderAt?,reminderTime?`。`null` 清除对应提醒。
- `GET/POST/DELETE /api/v1/bot/binding`。绑定 body：`{senderId,platformId,session}`。必须由插件从已验证的真实私聊事件生成，不能从 LLM 参数获取。
- `POST /api/v1/bot/reminders/claim`，body `{limit:1}` → `{jobs:[{id,leaseToken,scheduledAt,todoId,title,binding,attempts}]}`。
- `POST /api/v1/bot/reminders/:id/validate`，body `{leaseToken}` → `{valid}`，发送前再次检查取消/租约。
- `POST /api/v1/bot/reminders/:id/ack`，body `{leaseToken,messageId}`。仅 OneBot 返回真实消息 ID 后使用。
- `POST /api/v1/bot/reminders/:id/nack`，body `{leaseToken}`。持久化退避重试。

凭据是能力边界，不是公开多用户账号系统。bot token 只交给受信任插件，不能暴露给聊天用户或 LLM。

## 时间与发送语义

`dueDate`/目标/完成日期是日历日期；`reminderAt` 是带偏移量的 ISO 瞬时；`reminderTime` 是服务器时区 `HH:mm`（仅每日目标）。
兼容旧 UI 的 `notifyAt` 本地日期时间，按服务器时区转换。仅有旧 `notifyDate` 时按当天 **09:00**；导入前应核对。
DST 模糊/不存在的一次性时刻拒绝；每日提醒遇此类时刻跳过当次，不猜测一小时。

worker 的 claim 即驱动调度，不靠 LLM 或纯内存定时任务；没有 worker 时任务留在 DB。
租约 120 秒；默认每次领 1 条，避免排队发信超过租约；8 次失败后 `failed`。
退避从 15 秒翻倍、最多 1 小时。一次性补发窗口 24 小时，每日目标只补当天。
完成、删除、改期可取消尚未发出的提醒；已在 QQ 请求途中的消息无法撤回。
投递是**至少一次**，进程崩溃窗口仍可能重复，不承诺 exactly-once。

## 备份

`npm run server:backup -- /var/lib/todo-widget/todo.db /安全备份目录/2026-09-13.db`

使用 SQLite 在线备份 API，包含已提交 WAL，并检查 integrity；目标必须不存在。
不要复制运行中 `.db` 单文件，也不要用 Syncthing 同步活跃 DB/WAL。

## 插件实现

见 [AstrBot 插件说明](../integrations/astrbot_plugin_todo_widget/README.md)。claim 返回的每个 job 同时包含 `timeZone`；ACK 的 `messageId` 必须是非零十进制整数字符串。一次性 `reminderAt` 与每日 `reminderTime` 互斥，bot 修改模式会清除旧模式。
