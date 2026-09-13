"""Fast unit tests, no AstrBot/QQ account, network or third-party test dependencies."""
import asyncio
import copy
import importlib
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from integrations.astrbot_plugin_todo_widget.core import (
    ApiError, Controller, HttpClient, Journal, ReminderWorker, Settings, UserError,
    authorize, server_url, valid_message_id,
)

CONFIG = dict(enabled=True, server_url="http://127.0.0.1:3210", bot_token="b" * 40,
              allowed_qq_ids=["12345678"], allowed_platform_ids=["qq-test"])
SETTINGS = Settings.from_config(CONFIG)
JOB_ID = "a" * 40


class Event:
    def __init__(self, sender="12345678", platform="qq-test", group="", kind="aiocqhttp", message_id="98765", text="/待办 查询"):
        self.sender, self.platform, self.group, self.kind = sender, platform, group, kind
        self.unified_msg_origin = f"{platform}:FriendMessage:{sender}"
        self.message_obj = SimpleNamespace(message_id=message_id)
        self.text, self.stopped = text, False

    def get_sender_id(self): return self.sender
    def get_platform_id(self): return self.platform
    def get_platform_name(self): return self.kind
    def get_group_id(self): return self.group
    def is_private_chat(self): return not self.group
    def get_message_str(self): return self.text
    def plain_result(self, text): return text
    def stop_event(self): self.stopped = True


class API:
    def __init__(self):
        self.calls = []
        self.binding = {**authorize(SETTINGS, Event()).binding(), "version": 1}
        self.view = dict(revision=0, serverTime="2026-09-13T01:00:00Z", today="2026-09-13", timeZone="Asia/Shanghai", lists=[{"id": "list-inbox", "name": "待办"}], tasks=[])
        self.mutations = {}
        self.drop_response = False
        self.conflict = False
        self.ack_failures = 0
        self.valid = True
        self.job = dict(id=JOB_ID, leaseToken="1c801e88-d7f4-43fd-ac09-e76f1b3d2a70", scheduledAt="2026-09-13T01:00:00Z", timeZone="Asia/Shanghai", todoId="task-1", title="test [CQ:at,qq=all]", binding=self.binding, attempts=1)
        self.claimed = False
        self.status = "pending"

    async def request(self, path, body=None, method=None):
        self.calls.append((path, copy.deepcopy(body), method))
        if path == "/binding":
            if method == "DELETE":
                self.binding = None
                return {"unbound": True}
            if body is not None:
                self.binding = {**body, "version": 1}
            return {"binding": copy.deepcopy(self.binding)}
        if path == "/tasks":
            return copy.deepcopy(self.view)
        if path == "/actions":
            key = body["mutationId"]
            if key in self.mutations:
                return {**self.mutations[key], "replayed": True}
            if self.conflict or body["expectedRevision"] != self.view["revision"]:
                raise ApiError(409, "REVISION_CONFLICT")
            self.view["revision"] += 1
            task = {**body.get("task", {}), "id": "task-1", "completed": False, "completionDates": []}
            self.view["tasks"].append(task)
            result = dict(ok=True, revision=self.view["revision"], taskId=task["id"], task=task, timeZone="Asia/Shanghai", replayed=False)
            self.mutations[key] = result
            if self.drop_response:
                self.drop_response = False
                raise ApiError(0)
            return result
        if path.endswith("/claim"):
            if self.claimed or self.status == "sent":
                return {"jobs": []}
            self.claimed = True
            return {"jobs": [copy.deepcopy(self.job)]}
        if path.endswith("/validate"):
            return {"valid": self.valid}
        if path.endswith("/ack"):
            if self.ack_failures:
                self.ack_failures -= 1
                raise ApiError(0)
            self.status = "sent"
            return {"status": "sent"}
        if path.endswith("/nack"):
            self.status = "pending"
            return {"status": "pending"}
        raise AssertionError(path)


class PluginFixture(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.journal = Journal(self.directory, SETTINGS.url)
        self.api = API()
        self.controller = Controller(SETTINGS, self.api, self.journal)
        self.event = Event()

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

class CoreTests(PluginFixture):
    async def test_all_operations_reject_untrusted_events_before_any_http(self):
        events = [Event(sender="99999999"), Event(group="12345"), Event(platform="wrong"), Event(kind="telegram")]
        for event in events:
            for operation in [self.controller.bind(event), self.controller.query(event), self.controller.create(event, "secret"), self.controller.complete(event, "id"), self.controller.remind(event, "id", clear=True), self.controller.retry(event), self.controller.unbind(event)]:
                with self.assertRaises(UserError):
                    await operation
        self.assertEqual(self.api.calls, [])

    async def test_binding_comes_from_event_and_cannot_replace_another_recipient(self):
        self.api.binding = None
        await self.controller.bind(self.event)
        self.assertEqual(self.api.binding["senderId"], self.event.sender)
        self.assertEqual(self.api.binding["session"], self.event.unified_msg_origin)
        self.api.binding = {**self.api.binding, "senderId": "99999999"}
        with self.assertRaises(UserError):
            await self.controller.bind(self.event)
        with self.assertRaises(UserError):
            await self.controller.query(self.event)

    async def test_unbound_cannot_read_or_write(self):
        self.api.binding = None
        with self.assertRaises(UserError): await self.controller.query(self.event)
        with self.assertRaises(UserError): await self.controller.create(self.event, "blocked")
        self.assertFalse(any(c[0] in {"/actions", "/tasks"} for c in self.api.calls))

    async def test_query_has_account_clock_and_no_extra_private_fields(self):
        self.api.view["tasks"] = [{"id": "goal", "title": "Read", "completed": False, "goalStartDate": "2026-09-01", "completionDates": ["2026-09-13"], "completionNotes": "private", "timeEntries": ["private"]}]
        result = await self.controller.query(self.event)
        self.assertEqual(result["timeZone"], "Asia/Shanghai")
        self.assertTrue(result["tasks"][0]["completedToday"])
        self.assertNotIn("private", json.dumps(result))

    async def test_durable_request_precedes_http_and_same_event_is_idempotent(self):
        original = self.api.request
        async def checked(path, body=None, method=None):
            if path == "/actions":
                saved = json.loads(self.journal.path.read_text())
                self.assertEqual(saved["operations"][body["mutationId"]]["body"], body)
            return await original(path, body, method)
        self.api.request = checked
        one, two = await asyncio.gather(self.controller.create(self.event, "Read"), self.controller.create(self.event, "Read"))
        self.assertTrue(one["ok"] and two["ok"])
        self.assertEqual(len(self.api.mutations), 1)
        self.assertEqual(sum(c[0] == "/actions" for c in self.api.calls), 1)

    async def test_lost_response_and_restart_retry_original_body(self):
        self.api.drop_response = True
        with self.assertRaises(UserError): await self.controller.create(self.event, "Read")
        old = next(iter(self.journal.state["operations"].values()))["body"]
        with self.assertRaises(UserError): await self.controller.create(Event(message_id="98766"), "Another")
        self.journal.close()
        self.journal = Journal(self.directory, SETTINGS.url)
        self.controller = Controller(SETTINGS, self.api, self.journal)
        result = await self.controller.retry(Event(message_id="98767"))
        self.assertTrue(result["ok"] and result["replayed"])
        self.assertEqual(len(self.api.mutations), 1)
        self.assertEqual([c[1] for c in self.api.calls if c[0] == "/actions"], [old, old])

    async def test_conflict_is_not_blindly_retried_with_new_revision(self):
        self.api.conflict = True
        for _ in range(2):
            with self.assertRaises(UserError): await self.controller.create(self.event, "Read")
        self.assertEqual(sum(c[0] == "/actions" for c in self.api.calls), 1)
        self.assertEqual(self.api.view["revision"], 0)

    async def test_disk_failure_prevents_mutation(self):
        with patch.object(self.journal, "_persist", side_effect=UserError("disk full")):
            with self.assertRaises(UserError): await self.controller.create(self.event, "Read")
        self.assertFalse(any(c[0] == "/actions" for c in self.api.calls))

    async def test_missing_real_message_id_cannot_mutate(self):
        with self.assertRaises(UserError): await self.controller.create(Event(message_id=""), "Read")
        self.assertFalse(any(c[0] == "/actions" for c in self.api.calls))

    async def test_exact_date_and_one_reminder_mode_required(self):
        cases = [dict(due_date="tomorrow"), dict(due_date="2026-02-30"), dict(goal_start="2026-09-13"), dict(reminder_at="2026-09-14T20:30:00"), dict(reminder_time="20:30"), dict(goal_start="2026-09-13", goal_end="2026-10-13", reminder_at="2026-09-14T20:30:00+08:00", reminder_time="20:30")]
        for kwargs in cases:
            with self.assertRaises(UserError): await self.controller.create(self.event, "Read", **kwargs)
        self.assertFalse(any(c[0] == "/actions" for c in self.api.calls))

    async def test_goal_remind_complete_and_clear_shapes(self):
        result = await self.controller.create(self.event, "Read", goal_start="2026-09-13", goal_end="2026-10-13", reminder_time="20:30")
        self.assertEqual(result["task"]["reminderTime"], "20:30")
        await self.controller.complete(Event(message_id="98766"), "task-1", False, "2026-09-13")
        self.assertEqual(self.api.calls[-1][1]["completed"], False)
        await self.controller.remind(Event(message_id="98767"), "task-1", clear=True)
        self.assertIsNone(self.api.calls[-1][1]["reminderAt"])
        self.assertIsNone(self.api.calls[-1][1]["reminderTime"])

    def test_corrupt_or_other_source_journal_is_preserved(self):
        self.journal.close()
        for raw in ['{broken', 'null', '{"version":1}']:
            self.journal.path.write_text(raw)
            with self.assertRaises(UserError): Journal(self.directory, SETTINGS.url)
            self.assertEqual(self.journal.path.read_text(), raw)

    def test_directory_and_journal_are_private_and_locked(self):
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.journal.path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(UserError): Journal(self.directory, SETTINGS.url)
        self.assertNotIn(SETTINGS.token, self.journal.path.read_text())


class WorkerTests(PluginFixture):
    async def test_worker_requires_nonzero_receipt(self):
        for response in [True, None, {}, {"message_id": 0}, {"message_id": "0"}, {"message_id": True}]:
            self.api = API()
            sender = AsyncMock(return_value=response)
            worker = ReminderWorker(SETTINGS, self.api, self.journal, sender)
            await worker.tick()
            self.assertEqual(self.api.status, "pending")
            self.assertFalse(any(c[0].endswith("/ack") for c in self.api.calls))
            self.assertTrue(any(c[0].endswith("/nack") for c in self.api.calls))

    async def test_worker_qq_failure_never_acks(self):
        sender = AsyncMock(side_effect=RuntimeError("QQ failure with private response"))
        await ReminderWorker(SETTINGS, self.api, self.journal, sender).tick()
        self.assertEqual(self.api.status, "pending")
        self.assertFalse(any(c[0].endswith("/ack") for c in self.api.calls))

    async def test_worker_cancelled_or_changed_task_not_sent(self):
        self.api.valid = False
        sender = AsyncMock(return_value={"message_id": 123})
        await ReminderWorker(SETTINGS, self.api, self.journal, sender).tick()
        sender.assert_not_called()

    async def test_worker_disallowed_binding_consumes_no_attempts(self):
        self.api.binding["senderId"] = "99999999"
        sender = AsyncMock()
        await ReminderWorker(SETTINGS, self.api, self.journal, sender).tick()
        sender.assert_not_called()
        self.assertFalse(any(c[0].endswith("/claim") for c in self.api.calls))

    async def test_worker_ack_loss_restarts_without_resending(self):
        sender = AsyncMock(return_value={"message_id": -123})
        self.api.ack_failures = 1
        await ReminderWorker(SETTINGS, self.api, self.journal, sender).tick()
        self.assertIn(JOB_ID, self.journal.state["receipts"])
        self.journal.close(); self.journal = Journal(self.directory, SETTINGS.url)
        await ReminderWorker(SETTINGS, self.api, self.journal, sender).tick()
        self.assertEqual(sender.await_count, 1)
        self.assertEqual(self.api.status, "sent")
        self.assertEqual(self.journal.state["receipts"], {})

    async def test_worker_reclaimed_lease_uses_durable_receipt(self):
        sender = AsyncMock(return_value={"message_id": 123})
        self.api.ack_failures = 2
        worker = ReminderWorker(SETTINGS, self.api, self.journal, sender)
        await worker.tick()
        self.api.claimed = False
        self.api.job["leaseToken"] = "947d9051-21bd-415e-a172-b477b927a05e"
        await worker.tick()
        self.assertEqual(sender.await_count, 1)
        self.assertEqual(self.api.status, "sent")
        self.assertEqual(self.api.calls[-1][1]["leaseToken"], self.api.job["leaseToken"])

    async def test_worker_disk_failure_after_send_halts(self):
        sender = AsyncMock(return_value={"message_id": 123})
        worker = ReminderWorker(SETTINGS, self.api, self.journal, sender)
        with patch.object(self.journal, "put", side_effect=UserError("disk full")):
            with self.assertRaises(UserError): await worker.tick()
        self.assertTrue(worker.halted)
        self.api.claimed = False
        await worker.tick()
        self.assertEqual(sender.await_count, 1)
        self.assertFalse(any(c[0].endswith("/ack") for c in self.api.calls))

class SettingsTests(unittest.TestCase):
    def test_defaults_disabled_and_enabled_requires_both_allowlists(self):
        self.assertFalse(Settings.from_config({}).enabled)
        for changes in [{"allowed_qq_ids": []}, {"allowed_platform_ids": []}, {"bot_token": "short"}]:
            with self.assertRaises(UserError): Settings.from_config({**CONFIG, **changes})

    def test_only_explicit_private_network_http_and_no_embedded_credentials(self):
        for url in ["http://public.example", "https://a:b@private.example", "https://private.example/?token=secret", "https://private.example/api", "file:///tmp/x"]:
            with self.assertRaises(UserError): server_url(url)
        self.assertEqual(server_url("http://todo-api:3210", True), "http://todo-api:3210")

    def test_message_id_validation(self):
        for bad in [None, True, False, "", "0", 0, "abc", "0.0", 1.2]:
            self.assertFalse(valid_message_id(bad))
        for good in [-123, "123", "-456"]:
            self.assertTrue(valid_message_id(good))


def load_adapter():
    """Unit-test handler bodies with no framework side effects; real loader tested separately."""
    star = types.ModuleType("astrbot.api.star")
    class Star:
        def __init__(self, context, config=None):
            self.context = context; self.logger = logging.getLogger("todo-widget-tests")
    star.Star, star.Context = Star, object
    star.StarTools = SimpleNamespace(get_data_dir=lambda _: (_ for _ in ()).throw(AssertionError("unexpected data access")))
    star.register = lambda *args, **kwargs: lambda cls: cls
    event = types.ModuleType("astrbot.api.event")
    event.AstrMessageEvent = Event
    event.filter = SimpleNamespace(command=lambda *args, **kwargs: lambda fn: fn, llm_tool=lambda *args, **kwargs: lambda fn: fn)
    modules = {"astrbot": types.ModuleType("astrbot"), "astrbot.api": types.ModuleType("astrbot.api"), "astrbot.api.star": star, "astrbot.api.event": event}
    with patch.dict(sys.modules, modules):
        return importlib.import_module("integrations.astrbot_plugin_todo_widget.main")


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_llm_tool_and_command_checks_real_identity(self):
        plugin = load_adapter().TodoWidgetPlugin(SimpleNamespace(), CONFIG)
        plugin.controller = SimpleNamespace(query=AsyncMock(), create=AsyncMock(), complete=AsyncMock(), remind=AsyncMock())
        for event in [Event(sender="99999999"), Event(group="12345"), Event(platform="wrong")]:
            calls = [plugin.tool_query(event), plugin.tool_create(event, "Read"), plugin.tool_complete(event, "id"), plugin.tool_remind(event, "id", clear=True)]
            for call in calls:
                self.assertFalse(json.loads(await call)["ok"])
            messages = [v async for v in plugin.todo_command(event)]
            self.assertIn("拒绝", messages[0])
        for method in vars(plugin.controller).values():
            method.assert_not_called()

    async def test_default_disabled_does_not_open_files_or_start_worker(self):
        plugin = load_adapter().TodoWidgetPlugin(SimpleNamespace(), {})
        await plugin.initialize()
        self.assertIsNone(plugin.worker_task)
        self.assertFalse(json.loads(await plugin.tool_query(Event()))["ok"])
        await plugin.terminate()

    async def test_sender_uses_onebot_text_segments_not_context_bool_or_cq_codes(self):
        client = SimpleNamespace(call_action=AsyncMock(return_value={"message_id": 123}))
        platform = SimpleNamespace(meta=lambda: SimpleNamespace(name="aiocqhttp"), get_client=lambda: client)
        context = SimpleNamespace(get_platform_inst=lambda _: platform)
        plugin = load_adapter().TodoWidgetPlugin(context, CONFIG)
        plugin.worker = SimpleNamespace(allowed_binding=lambda _: True)
        result = await plugin._send_private(API().job)
        self.assertEqual(result["message_id"], 123)
        args, kwargs = client.call_action.call_args
        self.assertEqual(args, ("send_private_msg",))
        self.assertEqual(kwargs["user_id"], 12345678)
        self.assertEqual(kwargs["message"][0]["type"], "text")
        self.assertIn("[CQ:at,qq=all]", kwargs["message"][0]["data"]["text"])

    async def test_wrong_platform_adapter_not_sent(self):
        platform = SimpleNamespace(meta=lambda: SimpleNamespace(name="telegram"))
        plugin = load_adapter().TodoWidgetPlugin(SimpleNamespace(get_platform_inst=lambda _: platform), CONFIG)
        plugin.worker = SimpleNamespace(allowed_binding=lambda _: True)
        with self.assertRaises(UserError): await plugin._send_private(API().job)


if __name__ == "__main__":
    unittest.main()
