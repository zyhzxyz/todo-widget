# 服务器部署、迁移与运维

第一版是**单用户、服务器业务数据单一真源**，不是多人 SaaS。保留独立本地模式，远程模式断网只读，不做自动双向合并。

```text
Windows Tauri / 可选浏览器 -- HTTPS + app token --> API -- 私有 SQLite 数据卷
QQ <--> NapCat <--> AstrBot 插件 -- bot token ------^
                               本机回执/操作日志（不含token）
```

## 0. 获取 Windows 与插件构建产物

在 [GitHub Actions / Checks](https://github.com/zyhzxyz/todo-widget/actions/workflows/ci.yml) 中选择 **`feature/server-astrbot` 分支、对应提交且全部通过**的运行，再下载页面底部的 Artifacts。`main` 的基础修复版不包含服务器模式，不要选错分支。

- `todo-widget-windows`：解压得到 `todo-widget.exe`。当前 CI 使用 `--no-bundle`，这是 Windows 可执行文件，不是安装器；需要 Windows/WebView2 环境。
- `astrbot-plugin-todo-widget`：先解开 Actions 下载的外层 ZIP，再把里面的 **`astrbot_plugin_todo_widget.zip`** 上传到 AstrBot。不要上传 Actions 外层 ZIP，也不要把整个项目当插件安装。
- 构建成功只证明能生成产物，不等于实际 Windows/QQ 验收。更新前退出旧程序并备份旧数据，保留原 EXE；应用标识仍是 `com.local.todo-widget`，不要删除 AppData 中的旧配置或 LevelDB 来“干净安装”。

下载 Actions 产物需要登录可访问该仓库的 GitHub 账号。产物会按仓库保留期过期；过期时选更新的成功运行，或按 README 自行构建。插件安装、加载/重启与真实发信仍需用户单独确认。

## 1. 新服务的隔离与凭据

需要 Docker Engine + Compose v2（以下 host 网络适用于 Linux 服务器）。代码无需访问 Windows 原始 LevelDB，部署不会把个人数据加入 Git。

```bash
cd /path/to/todo-widget
python3 tools/init_server_env.py          # 生成 deploy/.env，0600；不打印密钥、不覆盖已有文件
# 用可信编辑器打开 deploy/.env，设置账户时区和精确 CORS origin。
# 将两个token分别复制到桌面和插件设置；不要复制到聊天、日志、命令行参数或Git。
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
curl --fail http://127.0.0.1:3210/healthz
```

- `.env.example` 中 token 留空，未生成密钥时服务拒绝启动。`TODO_APP_TOKEN` 与 `TODO_BOT_TOKEN` 必须不同，随机至少32字符。
- 默认 `Asia/Shanghai`。数据库记住时区，已有数据库不能通过改环境变量偷偷平移历史日期；备份导入也必须匹配时区。
- 默认服务仅监听宿主机 loopback 的3210端口，不要把它直接暴露公网。确认3210没有被其他服务占用；若需更换，修改 compose 的 `TODO_PORT` 和代理/插件地址。
- 容器以 UID/GID `1000:1000`（node）运行，根文件系统只读，丢弃 Linux capabilities，SQLite 数据文件0600、目录0700，只写独立命名卷 `todo-widget_todo-data` 的 `/var/lib/todo-widget`。禁止 `docker compose down -v`，它会删数据卷。
- 若改为 bind mount，**仅新建专用目录**并赋给运行 UID/GID，例如管理员建立 `/srv/todo-widget/data` 并设 `1000:1000`/0700；不要递归 chmod/chown 整棵 AstrBot 数据目录，更不要使用0777。
- Docker 组拥有接近 root 的权限。宿主机管理员能查看容器环境中的 token，这不是对宿主机管理员的隔离边界。
- 如环境文件放项目外，可设置 `TODO_ENV_FILE=/absolute/private/todo.env` 再执行 Compose；默认仍为 `deploy/.env`，已加入 Git 忽略。

## 2. 公网 HTTPS 与本地连接

将 `deploy/Caddyfile.example` 的域名换成自己的域名，DNS 指向服务器；使用宿主机或 host 网络里的 Caddy 反代 loopback3210。已有 Nginx/面板也可实现相同反代，无需替换现有代理。

- 放行 HTTPS 所需端口（通常80/443），但不放行3210；不要误改已有机器人的端口/网络。
- CORS 精确允许 Tauri origin：`tauri://localhost,http://tauri.localhost,https://tauri.localhost`。使用网页客户端时额外加入真实 HTTPS 网页 origin，不允许 `*`。
- 桌面设置输入 `https://todo.example.com`（不带 `/api/v1`）和 **app token**。客户端拒绝公网明文 HTTP 和 URL 内嵌凭据，不跟随重定向。
- 如暂时没有域名，可先通过受保护的 SSH 端口转发将服务器 loopback3210 转到本机3210，再连接 `http://127.0.0.1:3210`；不要用公网 HTTP 代替 TLS。
- 服务器只提供 API，不自动提供网页静态文件。可选网页版本需先 `npm ci && npm run build`，由 HTTPS 静态服务提供 `dist/` 并配置 API origin。浏览器没有托盘、原生窗口等桌面功能，不能当完整 Windows 构建验收。

## 3. 首次迁移 Windows 旧数据

1. 使用包含该功能的 Tauri 构建，在**原本地模式**下打开“设置 → 数据与服务器”，导出原本地业务 JSON。额外保留“本机原始存储”导出。关闭旧应用后保留 WebView2 用户目录的离线副本。
2. 核对任务、清单、目标完成日、累计计时与日记。升级/导出不会批量修正旧 `completionDates`；无法可靠判断历史日期是否曾受 UTC 问题影响。
3. 连接服务器。连接只会读取服务器，**不会自动上传本地数据**；空服务器应显示空任务。
4. 选择 JSON 预检，核对数量和时区，再确认导入。只允许 pristine 数据库导入；已有数据时拒绝覆盖。
5. 刷新、重启、重新输入会话 token，检查服务器数据；切回原本地模式仍应看到原数据。目标/任务计时/完成历史放服务器，窗口设置留本机。
6. 确认服务器备份和恢复流程后，再把服务器模式当作日常入口。旧 LevelDB 副本不要立刻删掉。

不要使用 Syncthing 同步在线 LevelDB、SQLite 主文件或 WAL/SHM。可以同步**已完成的、一致性备份文件**，但不能以文件同步代替数据库/API。

断网、保存冲突或待确认日志存在时不能继续远程编辑。原操作重试使用相同 UUID；冲突先导出再明确放弃、刷新。运行计时每5秒有本机检查点，停止后未能上传可补记；强杀可能丢最后检查点后的秒数。计时恢复副本未处理时不允许切换数据源。

## 4. AstrBot / NapCat Docker 接入

详见 [插件安装、命令与可靠性说明](../integrations/astrbot_plugin_todo_widget/README.md)。仓库不是可直接 Git 安装的单插件仓库；先生成插件专用 ZIP。

已观察到的用户现有结构（未修改）：AstrBot 与 NapCat 都使用 **host network**，都将宿主机 `/home/zyhzxyz/astrbot/data` 映射到 `/AstrBot/data`。因此：

- 插件的 API URL 可直接用 `http://127.0.0.1:3210`。这和上面的 API host 网络/loopback监听配套。
- bot token 只给插件，app token 只给桌面；两者不能互换。
- 填真实 QQ 白名单和**平台实例 ID**。启用后由该 QQ 私聊 `/待办 绑定`；非白名单、群聊和错误平台一律拒绝。
- 本版只发送文字，**无需共享文件**。插件在 `/AstrBot/data/plugin_data/astrbot_plugin_todo_widget` 保留原子操作/回执日志；API 数据库不挂给 AstrBot/NapCat。
- 未来如发附件，只新增 `/AstrBot/data/todo-widget-exchange`（或两容器各自映射同一宿主机子目录到相同容器路径），设置精确 UID/GID 权限。NapCat 必须能在**自己的容器文件系统**读取消息中的附件路径。
- 现有共享整个 `/AstrBot/data` 且两个进程均为 root 时，NapCat 理论上也能读取 AstrBot 插件配置；本次不擅自改变已有挂载。若要更强隔离，另行规划缩小挂载、独立配置卷和非 root 账号。

### 如果以后换 Docker bridge

不要照抄 host 网络的 `localhost` 地址。给 API 与 AstrBot 配置相同的私有网络，API 在容器内部监听 `0.0.0.0:3210`，插件访问 `http://todo-api:3210` 并明确打开仅私网的 `allow_internal_http`。宿主机 HTTPS 代理如需访问，则只发布 `127.0.0.1:3210:3210`；不要发布 `0.0.0.0:3210:3210`。

不要把整套已有 `astrbot.yml` 换成本仓库的 Compose：这里仅管理新增 API，生产机器人安装、重启、绑定和发信需用户确认。

## 5. 一致性在线备份

API 用 SQLite WAL，**不能直接 cp 正在运行的 todo.db**。内置备份使用 SQLite online backup API，包含已提交 WAL 内容，并做 integrity check。目标文件必须不存在。

```bash
umask 077
backup="todo-$(date +%Y%m%d-%H%M%S).db"
mkdir -p "$HOME/todo-widget-backups"
chmod 700 "$HOME/todo-widget-backups"
docker compose -f deploy/compose.yml exec -T todo-api \
  node server/src/backup.ts /var/lib/todo-widget/todo.db "/var/lib/todo-widget/$backup" &&
docker compose -f deploy/compose.yml cp \
  "todo-api:/var/lib/todo-widget/$backup" "$HOME/todo-widget-backups/$backup" &&
chmod 600 "$HOME/todo-widget-backups/$backup"
# 验证导出的文件后，可清理卷中这一个临时副本；不要删 todo.db / WAL。
```

非 Docker：`npm run server:backup -- /absolute/source/todo.db /absolute/new-backup.db`（Node24）。备份应加密异地保存并设置保留策略；JSON 业务备份不包含 outbox/幂等账本，不能代替完整运维备份。

AstrBot 插件的 `journal.json` 同样包含个人数据。需要同时备份时先停插件、等待当前 tick 收尾，再备份其专用目录；不要在原子替换文件时手工拼接内容。令牌环境文件与 AstrBot 配置应单独加密备份，不入 Git。

## 6. 恢复（先停服务，不直接覆盖运行中的 SQLite）

1. 暂停/卸载提醒插件并等待收尾，停止 API：`docker compose -f deploy/compose.yml stop todo-api`。不要删卷。
2. 确认备份来源、校验和、日期、数据库账户时区。为当前数据保留 rollback 副本。恢复时保证没有另一 API 进程写该卷。
3. 以下是保留旧 DB/WAL/SHM 后恢复单文件一致性备份的示例。`RESTORE_FILE` 必须是绝对路径、备份必须能由 UID1000读取；不要为了方便改成世界可读。

```bash
RESTORE_FILE="$HOME/todo-widget-backups/todo-YYYYMMDD-HHMMSS.db"
test -f "$RESTORE_FILE" &&
docker compose -f deploy/compose.yml run --rm --no-deps -T --interactive=false \
  --entrypoint node -v "$RESTORE_FILE:/restore/source.db:ro" todo-api -e '
const fs = require("node:fs");
const {DatabaseSync} = require("node:sqlite");
const source = new DatabaseSync("/restore/source.db", {readOnly:true});
if (source.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw Error("Invalid backup");
source.close();
const root = "/var/lib/todo-widget";
const stamp = Date.now();
const staged = root + "/restore-" + stamp + ".db";
fs.copyFileSync("/restore/source.db", staged, fs.constants.COPYFILE_EXCL);
fs.chmodSync(staged, 0o600);
const restored = fs.openSync(staged, "r");
try { fs.fsyncSync(restored); } finally { fs.closeSync(restored); }
const rollback = root + "/rollback-" + stamp;
fs.mkdirSync(rollback, {mode:0o700});
for (const name of ["todo.db", "todo.db-wal", "todo.db-shm"])
  if (fs.existsSync(root + "/" + name)) fs.renameSync(root + "/" + name, rollback + "/" + name);
fs.renameSync(staged, root + "/todo.db");
for (const path of [rollback, root]) {
  const directory = fs.openSync(path, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
console.log("Restored; previous database files retained in rollback directory.");' &&
docker compose -f deploy/compose.yml up -d todo-api
```

恢复脚本先复制并落盘备份，复制失败不移动旧数据库；只有恢复命令成功才重新启动。任一步骤报错都保持停止，检查文件后再继续。

4. 暂不启用提醒插件。检查 health、任务、目标完成日、日记、计时、revision、绑定和提醒状态。用原时区启动；如拒绝时区不匹配，不要绕过校验。
5. 恢复旧备份会回退数据与发送状态，备份之后已经收到的 QQ 消息不会“撤回”。重新启用插件前检查旧提醒并取消/改期，核对插件日志；**不能保证恢复旧备份后绝无重复提醒**。
6. 若恢复失败，保持停止状态，保留失败文件，从 rollback 中恢复对应 DB/WAL/SHM 整套文件，再重新检查。不要混用不同时点的主文件与 WAL。

## 7. 可复现检查与真实验收

```bash
npm ci
npm run check:tauri-versions                 # Python 3.12；npm/Rust 锁文件版本一致
npm run test:tools
npm test
npm run test:server
npm run typecheck
npm run typecheck:server
npm run typecheck:tests
npm run build
python3 -m unittest discover -s tests/plugin -v
python3 tools/package_astrbot.py
npm run test:e2e                             # 临时 Node API/SQLite + 模拟 OneBot
# 可选真实 Chromium UI + 独立 Docker 测试，不需要生产 token：
python3 -m venv .venv
source .venv/bin/activate                    # 以下示例为 Linux
python3 -m pip install -r tools/requirements-e2e.txt
python3 -m playwright install chromium
docker build -f deploy/Dockerfile -t todo-widget-api:integration-test .
npm run test:e2e -- --docker-image todo-widget-api:integration-test --browser
```

端到端脚本检查密钥文件0600和拒绝覆盖，使用随机测试 token、合成任务，并在 finally 中清理。Docker 路径直接使用本仓库的 Compose 配置，以随机项目名/loopback端口创建独立容器与卷；只有该隔离项目会执行带卷清理，绝不针对生产项目。测试包含在线备份、停服后从只读备份恢复、保留旧 DB/WAL/SHM，以及恢复后业务数据/绑定/outbox/幂等记录核对。不会读取生产 AstrBot 配置、Windows数据或调用真实QQ。测试API是实际HTTP与SQLite；QQ回执是模拟，不声称真实送达。

Linux 如缺 Chromium 系统库，可在有管理员权限的测试环境运行 `python3 -m playwright install --with-deps chromium`（CI 使用此方式）。

上线前须确认对应提交的 Windows CI 通过，并手工验收：Tauri 文件保存/托盘/计时窗口、真实旧数据迁移；白名单QQ创建任务→桌面显示、桌面提醒→真实QQ送达；群聊拒绝、断网只读、并发冲突；真实服务器备份恢复。见 [计划验收清单](SERVER_ASTRBOT_PLAN.md)。
