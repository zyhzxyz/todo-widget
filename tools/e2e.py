"""Isolated real-HTTP integration smoke. Never uses production AstrBot, data or QQ.

python3 tools/e2e.py                         # Node subprocess + temporary SQLite
python3 tools/e2e.py --docker-image todo-widget-api:integration-test --browser
--docker-image uses deploy/compose.yml in an isolated Linux host-network project.
--browser additionally needs tools/requirements-e2e.txt and Chromium.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from integrations.astrbot_plugin_todo_widget.core import ApiError, Controller, HttpClient, Journal, ReminderWorker, Settings, UserError


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(base, path, token="", body=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    with urlopen(Request(base + path, data=data, headers=headers, method=method or ("POST" if body is not None else "GET")), timeout=12) as response:
        return json.load(response)


class Event:
    def __init__(self, message_id="50001", sender="12345678"):
        self.message_obj = SimpleNamespace(message_id=message_id)
        self.sender = sender
        self.unified_msg_origin = f"isolated-test:FriendMessage:{sender}"

    def get_sender_id(self): return self.sender
    def get_platform_id(self): return "isolated-test"
    def get_platform_name(self): return "aiocqhttp"
    def get_group_id(self): return ""
    def is_private_chat(self): return True


class DropOneResponse:
    """API commits successfully, but the client's first response is lost."""
    def __init__(self, api, suffix): self.api, self.suffix, self.dropped = api, suffix, False
    async def request(self, path, body=None, method=None):
        result = await self.api.request(path, body, method)
        if path.endswith(self.suffix) and not self.dropped:
            self.dropped = True
            raise ApiError(0, "SIMULATED_RESPONSE_LOSS")
        return result


class FakeOneBot:
    def __init__(self): self.fail = True; self.delivered = []
    async def send(self, job):
        if self.fail:
            raise RuntimeError("Synthetic QQ failure; no real message was sent")
        self.delivered.append(job["id"])
        return {"message_id": 70000 + len(self.delivered)}


# Mirrors the stopped-service recovery example in docs/DEPLOYMENT.md.
# The source is mounted read-only in the Docker case; old DB/WAL/SHM are retained.
RESTORE_SCRIPT = r"""
const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const [sourcePath, root] = process.argv.slice(1);
const source = new DatabaseSync(sourcePath, {readOnly: true});
if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Invalid backup');
source.close();
const stamp = Date.now();
const staged = root + '/restore-' + stamp + '.db';
fs.copyFileSync(sourcePath, staged, fs.constants.COPYFILE_EXCL);
fs.chmodSync(staged, 0o600);
const restored = fs.openSync(staged, 'r');
try { fs.fsyncSync(restored); } finally { fs.closeSync(restored); }
const rollback = root + '/rollback-' + stamp;
fs.mkdirSync(rollback, {mode: 0o700});
for (const name of ['todo.db', 'todo.db-wal', 'todo.db-shm'])
  if (fs.existsSync(root + '/' + name)) fs.renameSync(root + '/' + name, rollback + '/' + name);
fs.renameSync(staged, root + '/todo.db');
for (const path of [rollback, root]) {
  const directory = fs.openSync(path, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
"""


class Environment:
    def __init__(self, directory, image, browser):
        self.directory, self.image, self.browser = directory, image, browser
        self.port, self.web_port = free_port(), free_port()
        while self.web_port == self.port:
            self.web_port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.web = f"http://127.0.0.1:{self.web_port}"
        self.node = self.vite = None
        self.name = "todo-widget-e2e-" + uuid.uuid4().hex[:12]
        self.volume = self.name + "_todo-data"
        self.container_started = False
        self.container = None
        self.log = open(directory / "process.log", "w")
        # Exercise the documented secret generator without printing credentials.
        env_file = directory / ".env"
        generator = [sys.executable, str(ROOT / "tools/init_server_env.py"), "--output", str(env_file)]
        generated = subprocess.run(generator, check=True, capture_output=True, text=True)
        contents = env_file.read_text()
        assert env_file.stat().st_mode & 0o777 == 0o600
        duplicate = subprocess.run(generator, capture_output=True, text=True)
        assert duplicate.returncode != 0 and env_file.read_text() == contents, "must not overwrite existing secrets"
        values = dict(line.split("=", 1) for line in contents.splitlines() if line and not line.startswith("#"))
        self.app_token, self.bot_token = values["TODO_APP_TOKEN"], values["TODO_BOT_TOKEN"]
        assert self.app_token != self.bot_token and min(len(self.app_token), len(self.bot_token)) >= 32
        for token in [self.app_token, self.bot_token]:
            assert token not in generated.stdout + generated.stderr + duplicate.stdout + duplicate.stderr
        self.env = dict(TODO_APP_TOKEN=self.app_token, TODO_BOT_TOKEN=self.bot_token, TODO_TIMEZONE="Asia/Shanghai", TODO_HOST="127.0.0.1", TODO_PORT=str(self.port), TODO_DB_PATH=str(directory / "todo.db"), TODO_CORS_ORIGINS=self.web)
        self.compose_env = {**os.environ, "TODO_ENV_FILE": str(env_file)}
        self.compose_args = ["docker", "compose", "--project-name", self.name, "-f", str(ROOT / "deploy/compose.yml"), "-f", str(directory / "compose.override.json")]
        print("PASS configuration: independent random tokens, private 0600 file, overwrite refused, no credentials printed")

    def compose(self, *args, **kwargs):
        options = dict(check=True, cwd=ROOT, env=self.compose_env, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        options.update(kwargs)
        return subprocess.run([*self.compose_args, *args], **options)

    def start_node(self):
        self.node = subprocess.Popen(["node", "server/src/index.ts"], cwd=ROOT, env={**os.environ, **self.env}, stdout=self.log, stderr=self.log)

    def start(self):
        if self.image:
            # Use the production manifest, with an isolated project/volume, loopback port
            # and test credentials. Never read deploy/.env or touch an existing service.
            override = {"services": {"todo-api": {"image": self.image, "environment": {
                "TODO_HOST": "127.0.0.1", "TODO_PORT": str(self.port), "TODO_CORS_ORIGINS": self.web,
            }}}}
            (self.directory / "compose.override.json").write_text(json.dumps(override))
            self.compose("config", "--quiet")
            self.container_started = True  # Cleanup even if `up` fails part-way.
            self.compose("up", "--detach", "--no-build", "todo-api")
            self.container = self.compose("ps", "--quiet", "todo-api", stdout=subprocess.PIPE, text=True).stdout.strip()
            assert self.container
            network = subprocess.check_output(["docker", "inspect", "--format", "{{.HostConfig.NetworkMode}}", self.container], text=True).strip()
            assert network == "host"
        else:
            self.start_node()
        self.wait_health()
        if self.browser:
            # Terminate the actual owned process on cleanup, not just an npm wrapper.
            self.vite = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(self.web_port), "--strictPort"], cwd=ROOT, stdout=self.log, stderr=self.log)

    def wait_health(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                if request(self.base, "/healthz").get("ok"): return
            except (URLError, OSError): pass
            time.sleep(0.1)
        raise RuntimeError("Isolated API did not become healthy; no production service was touched")

    def backup_and_restart(self):
        if self.image:
            uid = subprocess.check_output(["docker", "exec", self.container, "id", "-u"], text=True).strip()
            assert uid == "1000", uid
            mode = subprocess.check_output(["docker", "exec", self.container, "stat", "-c", "%a", "/var/lib/todo-widget/todo.db"], text=True).strip()
            assert mode == "600", mode
            directory_mode = subprocess.check_output(["docker", "exec", self.container, "stat", "-c", "%a", "/var/lib/todo-widget"], text=True).strip()
            assert directory_mode == "700", directory_mode
            self.compose("exec", "-T", "todo-api", "node", "server/src/backup.ts", "/var/lib/todo-widget/todo.db", "/var/lib/todo-widget/verified-backup.db")
            self.compose("restart", "todo-api")
        else:
            subprocess.run(["node", "server/src/backup.ts", str(self.directory / "todo.db"), str(self.directory / "verified-backup.db")], check=True, cwd=ROOT, stdout=self.log, stderr=self.log)
            self.node.terminate(); self.node.wait(timeout=15)
            self.start_node()
        self.wait_health()

    def restore_backup(self):
        if self.image:
            self.compose("stop", "todo-api")
            # Mount the backup read-only. UID1000 owns it; no chmod777/root helper.
            self.compose("run", "--rm", "--no-deps", "-T", "--interactive=false", "--name", self.name + "-restore", "--entrypoint", "node", "--volume", self.volume + ":/restore:ro", "todo-api", "-e", RESTORE_SCRIPT, "/restore/verified-backup.db", "/var/lib/todo-widget")
            self.compose("start", "todo-api")
        else:
            self.node.terminate(); self.node.wait(timeout=15)
            subprocess.run(["node", "-e", RESTORE_SCRIPT, str(self.directory / "verified-backup.db"), str(self.directory)], check=True, cwd=ROOT, stdout=self.log, stderr=self.log)
            self.start_node()
        self.wait_health()

    def close(self):
        try:
            for process in [self.vite, self.node]:
                if process and process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=15)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
            if self.container_started:
                # Only our randomly named project. NEVER run this against the user's stack.
                subprocess.run(["docker", "rm", "--force", self.name + "-restore"], stdout=self.log, stderr=self.log)
                self.compose("down", "--volumes", "--remove-orphans", "--timeout", "60")
        finally:
            self.log.close()


async def browser_check(env, today):
    from playwright.async_api import async_playwright
    now = datetime.now(timezone.utc).isoformat()
    original = dict(id="original-local-only", title="Original local data must survive", completed=False, priority="normal", listId="list-inbox", completionDates=[], isGroup=False, collapsed=False, createdAt=now, updatedAt=now, timeEntries=[], totalTimeSpent=0)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 760})
        page = await context.new_page()
        errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('todo-widget.todos', " + json.dumps(json.dumps([original])) + ");")
        # Vite may still be starting.
        for attempt in range(50):
            try:
                await page.goto(env.web); break
            except Exception:
                if attempt == 49: raise
                await asyncio.sleep(0.1)
        await page.get_by_title("设置", exact=True).click()
        await page.locator('.data-settings input[type="url"]').fill(env.base)
        await page.locator('.data-settings input[type="password"]').fill(env.app_token)
        await page.get_by_role("button", name="连接服务器", exact=True).click()
        await page.locator(".data-status.online").wait_for()
        assert json.loads(await page.evaluate("localStorage.getItem('todo-widget.todos')")) == [original]
        async with page.expect_download() as downloaded:
            await page.get_by_role("button", name="导出原本地数据", exact=True).click()
        path = await (await downloaded.value).path()
        assert json.loads(Path(path).read_text())["business"]["todos"] == [original]
        await page.locator(".settings-panel > header button").click()
        await page.locator(".list-tabs").get_by_role("button", name="今天", exact=True).click()
        await page.locator(".todo-list").click(button="right", position={"x": 3, "y": 3})
        await page.get_by_role("button", name="创建每日目标", exact=True).click()
        await page.locator('.creation-modal input:not([type])').fill("Desktop-created daily goal")
        await page.get_by_label("目标开始日期", exact=True).fill(today)
        await page.get_by_label("目标结束日期", exact=True).fill((date.fromisoformat(today) + timedelta(days=1)).isoformat())
        await page.get_by_label("每日 QQ 提醒（可留空）", exact=True).fill("00:00")
        await page.get_by_role("button", name="保存", exact=True).click()
        await page.locator(".data-status.online").wait_for()
        await page.get_by_text("Desktop-created daily goal", exact=True).wait_for()
        await context.set_offline(True)
        await page.evaluate("window.dispatchEvent(new Event('focus'))")
        await page.locator(".data-status.offline").wait_for()
        assert await page.get_by_text("Desktop-created daily goal", exact=True).count() == 1
        goal_row = page.locator(".todo-row").filter(has_text="Desktop-created daily goal")
        assert await goal_row.locator(".check-button").is_disabled()
        assert await goal_row.get_attribute("draggable") == "false"
        await context.set_offline(False)
        await page.evaluate("window.dispatchEvent(new Event('online'))")
        await page.locator(".data-status.online").wait_for()
        assert not errors, errors
        assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")
        await browser.close()
    print("PASS browser: explicit remote connection, original local export/protection, daily goal -> API, offline read-only recovery")


async def scenario(env):
    settings = Settings.from_config(dict(enabled=True, server_url=env.base, bot_token=env.bot_token, allowed_qq_ids=["12345678"], allowed_platform_ids=["isolated-test"]))
    api = HttpClient(settings)
    journal = Journal(env.directory / "plugin", env.base)
    try:
        controller = Controller(settings, api, journal)
        try:
            await controller.query(Event(sender="99999999"))
            raise AssertionError("unauthorized event accepted")
        except UserError: pass
        for path in ["/api/v1/state", "/api/v1/export", "/api/v1/status"]:
            try:
                await asyncio.to_thread(request, env.base, path, env.bot_token)
                raise AssertionError("bot accessed desktop capability")
            except HTTPError as error:
                assert error.code == 403
        await controller.bind(Event())
        print("PASS identity: private binding and separate bot/app capabilities")
        due = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
        dropping = Controller(settings, DropOneResponse(api, "/actions"), journal)
        try:
            await dropping.create(Event(), "Bot-created task", reminder_at=due)
            raise AssertionError("lost response incorrectly reported successful")
        except UserError: pass
        journal.close(); journal = Journal(env.directory / "plugin", env.base)
        controller = Controller(settings, api, journal)
        confirmed = await controller.retry(Event("50002"))
        assert confirmed["ok"] and confirmed["replayed"]
        view = await controller.query(Event())
        assert len(view["tasks"]) == 1 and view["tasks"][0]["title"] == "Bot-created task"
        print("PASS mutation: real HTTP lost response + plugin restart retry creates exactly one task")
        onebot = FakeOneBot()
        await ReminderWorker(settings, api, journal, onebot.send).tick()
        failed_at = time.monotonic()
        stats = await asyncio.to_thread(request, env.base, "/api/v1/status", env.app_token)
        assert stats["reminders"].get("pending") == 1 and not stats["reminders"].get("sent")
        if env.browser:
            await browser_check(env, view["today"])
            tasks = (await controller.query(Event()))["tasks"]
            assert any(t["title"] == "Desktop-created daily goal" for t in tasks)
        else:
            await controller.create(Event("50003"), "Synthetic daily goal", goal_start=view["today"], goal_end=view["today"], reminder_time="00:00")
        # Complete a second, due reminder before delivery to exercise cancellation over real HTTP.
        cancelled = await controller.create(Event("50004"), "Completed before delivery", reminder_at=due)
        await controller.complete(Event("50005"), cancelled["taskId"], True)
        await asyncio.sleep(max(0, 15.3 - (time.monotonic() - failed_at)))
        onebot.fail = False
        worker = ReminderWorker(settings, DropOneResponse(api, "/ack"), journal, onebot.send)
        await worker.tick()
        assert journal.state["receipts"], "ACK-loss receipt should remain durable"
        journal.close(); journal = Journal(env.directory / "plugin", env.base)
        worker = ReminderWorker(settings, api, journal, onebot.send)
        for _ in range(4): await worker.tick()
        assert len(onebot.delivered) == 2, onebot.delivered
        assert len(set(onebot.delivered)) == 2, "ACK retry must not re-send"
        stats = await asyncio.to_thread(request, env.base, "/api/v1/status", env.app_token)
        assert stats["reminders"].get("sent") == 2
        assert not journal.state["receipts"]
        print("PASS delivery: QQ failure/backoff, completed-task cancellation, daily reminder, durable ACK-loss recovery (simulated OneBot only)")
        before = await asyncio.to_thread(request, env.base, "/api/v1/state", env.app_token)
        await asyncio.to_thread(env.backup_and_restart)
        after = await asyncio.to_thread(request, env.base, "/api/v1/state", env.app_token)
        assert before == after
        print("PASS persistence: live SQLite backup/integrity check and service restart preserve the complete snapshot" + ("; Compose host network, container UID=1000, DB=0600, directory=0700" if env.image else ""))
        # Prove we restored the backup rather than merely restarting the same live DB.
        await controller.create(Event("50006"), "This post-backup task must disappear after restore")
        changed = await asyncio.to_thread(request, env.base, "/api/v1/state", env.app_token)
        assert changed["revision"] > before["revision"]
        await asyncio.to_thread(env.restore_backup)
        restored = await asyncio.to_thread(request, env.base, "/api/v1/state", env.app_token)
        assert restored == before
        assert await asyncio.to_thread(request, env.base, "/api/v1/status", env.app_token) == stats
        # The server's own idempotency ledger also survives, not just the plugin cache.
        saved_operation = next(op for op in journal.state["operations"].values() if op["body"].get("task", {}).get("title") == "Bot-created task")
        replayed = await api.request("/actions", saved_operation["body"])
        assert replayed["replayed"] and replayed["taskId"] == confirmed["taskId"]
        await ReminderWorker(settings, api, journal, onebot.send).tick()
        assert len(onebot.delivered) == 2, "restored acknowledged reminders must not be re-sent"
        print("PASS recovery: stopped-service restore from read-only backup retains tasks/revision/binding/outbox/idempotency and preserves old DB/WAL/SHM")
    finally:
        journal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-image")
    parser.add_argument("--browser", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="todo-widget-e2e-") as temp:
        env = Environment(Path(temp), args.docker_image, args.browser)
        try:
            env.start()
            asyncio.run(scenario(env))
        except Exception:
            # Only this isolated test log; redact even the disposable credentials.
            env.log.flush()
            diagnostic = (Path(temp) / "process.log").read_text(errors="replace")[-12_000:]
            for token in [env.app_token, env.bot_token]:
                diagnostic = diagnostic.replace(token, "[REDACTED]")
            print("Isolated process diagnostics:\n" + diagnostic, file=sys.stderr)
            raise
        finally:
            env.close()
    print("PASS all isolated end-to-end checks; test containers/volumes, processes and personal-like test data removed")


if __name__ == "__main__":
    main()
