"""Browser regressions using synthetic data and an owned temporary API, never real QQ/data.

python3 tools/ui_regression.py [--docker-image IMAGE] [--screenshots DIRECTORY]
Requires tools/requirements-e2e.txt and Playwright Chromium.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from e2e import Environment, request


async def geometry(page, panel=False):
    measurements = await page.evaluate("""() => {
      const rect = selector => { const el = document.querySelector(selector); if (!el) return null;
        const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
      return {width:innerWidth,height:innerHeight,header:rect('.titlebar'),status:rect('.data-status'),workspace:rect('.workspace'),footer:rect('footer'),search:rect('.search-row'),list:rect('.todo-list'),panel:rect('.tool-panel'),
        buttons:[...document.querySelectorAll('.window-actions button')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}})};
    }""")
    m = measurements
    assert m['header']['bottom'] <= m['status']['top'], m
    assert m['status']['bottom'] <= m['workspace']['top'], m
    assert m['workspace']['bottom'] <= m['footer']['top'] + 1, m
    assert m['footer']['bottom'] <= m['height'], m
    assert all(b['left'] >= 0 and b['right'] <= m['width'] for b in m['buttons']), m
    assert m['workspace']['height'] > 0 and m['list']['height'] > 0, m
    assert await page.locator('.tool-panel').count() == int(panel)
    if panel:
        assert m['panel']['top'] >= m['workspace']['top'] - 1, m
        assert m['panel']['bottom'] <= m['workspace']['bottom'] + 1, m
    if m['search']:
        assert m['search']['bottom'] <= m['list']['top'] + 1, m


async def browser_checks(env, screenshots):
    from playwright.async_api import async_playwright
    now = datetime.now(timezone.utc).isoformat()
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    yesterday = (day - timedelta(days=1)).isoformat()
    def task(id, title, **extra):
        return dict(id=id, title=title, completed=False, priority='normal', listId='list-today',
                    completionDates=[], isGroup=False, collapsed=False, createdAt=now, updatedAt=now,
                    timeEntries=[], totalTimeSpent=0) | extra
    rows = [task('ui-task', '[UI测试] 可恢复的任务', notes='合成备注，不是真实数据', reminderAt=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()),
            task('ui-group', '[UI测试] 任务集', isGroup=True),
            task('ui-child', '[UI测试] 子任务', parentId='ui-group'),
            task('ui-done', '[UI测试] 已完成', completed=True, completionDates=[yesterday], totalTimeSpent=300),
            task('ui-goal', '[UI测试] 每日目标', goalStartDate=yesterday, goalEndDate=(day+timedelta(days=7)).isoformat(), completionDates=[yesterday], totalTimeSpent=1500)]
    request(env.base, '/api/v1/mutations', env.app_token, {
        'mutationId':str(uuid.uuid4()),'expectedRevision':0,'operations':[{'type':'todo.put','value':row} for row in rows]})
    original = [task('ui-original-local', '[UI测试] 原本地记录不要上传')]
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context(viewport={'width':320,'height':560})
        await context.add_init_script("""if (!localStorage.getItem('todo-widget.todos')) {
          localStorage.setItem('todo-widget.todos', %s);
          localStorage.setItem('todo-widget.settings', JSON.stringify({eyeCare:false,topDefaultMigrated:true,activeListId:'list-today'}));
        }""" % json.dumps(json.dumps(original)))
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        for attempt in range(60):
            try:
                await page.goto(env.web); break
            except Exception:
                if attempt == 59: raise
                await asyncio.sleep(.1)
        header = page.locator('.titlebar')
        async def tool(name): await header.get_by_role('button', name=name, exact=True).click()
        async def online(): await page.locator('.data-status.online').wait_for()
        async def capture(name):
            if screenshots: await page.screenshot(path=str(screenshots / (name + '.png')))
        await tool('设置')
        await page.locator('.data-settings input[type=url]').fill(env.base)
        await page.locator('.data-settings input[type=password]').fill(env.app_token)
        await page.get_by_role('button', name='连接服务器', exact=True).click()
        await online()
        await page.get_by_role('button', name='关闭设置', exact=True).click()
        for width, height in [(320,560), (280,320), (900,760)]:
            await page.set_viewport_size({'width':width,'height':height})
            await tool('完成日历'); await geometry(page, panel=True)
            await capture(f'calendar-{width}')
            await tool('搜索任务'); await geometry(page)
            await page.get_by_role('textbox', name='搜索任务', exact=True).fill('UI测试')
            await geometry(page); await capture(f'search-{width}')
            await tool('设置'); await geometry(page, panel=True)
            assert await page.locator('.search-row').count() == 0
            await tool('今日日记'); await geometry(page, panel=True)
            await tool('回收站'); await geometry(page)
            await page.get_by_role('tab', name='已删除', exact=False).click()
            await capture(f'recycle-{width}')
            await tool('待办列表')
            await tool('完成日历'); await tool('完成日历')
            assert await page.locator('.tool-panel').count() == 0
            await tool('搜索任务'); await page.keyboard.press('Escape')
            assert await page.locator('.search-row').count() == 0
        print('PASS UI: mutually exclusive tools, remote status/search/recycle layouts at 280, 320 and 900px')
        await page.set_viewport_size({'width':320,'height':560})
        row = page.locator('.todo-row').filter(has_text='[UI测试] 可恢复的任务')
        await row.click(button='right')
        await page.get_by_role('button', name='开始计时', exact=True).click()
        timer = page.get_by_role('group', name='计时器', exact=True)
        await asyncio.sleep(1.2)
        await timer.get_by_role('button', name='暂停计时', exact=True).click()
        elapsed = await timer.locator('strong').text_content()
        await asyncio.sleep(1.2)
        assert await timer.locator('strong').text_content() == elapsed
        await tool('设置'); await page.get_by_role('button', name='紫', exact=True).click()
        await geometry(page, panel=True); await capture('timer-and-settings-purple')
        await page.set_viewport_size({'width':280,'height':320})
        await geometry(page, panel=True); await capture('timer-and-settings-purple-minimum')
        await page.set_viewport_size({'width':320,'height':560})
        await tool('设置')
        await timer.get_by_role('button', name='继续计时', exact=True).click()
        await asyncio.sleep(1.2)
        await timer.get_by_role('button', name='停止并保存', exact=True).click(); await online()
        await row.get_by_role('button', name='标记为完成', exact=True).click()
        await page.get_by_placeholder('填写完成情况说明...').fill('合成验收说明')
        await page.get_by_role('button', name='确认完成', exact=True).click(); await online()
        await page.locator('.user-notice').get_by_role('button', name='撤销完成', exact=True).click(); await online()
        saved = next(t for t in request(env.base, '/api/v1/state', env.app_token)['todos'] if t['id']=='ui-task')
        assert not saved['completed'] and saved['totalTimeSpent'] >= 2 and saved['completionNotes']=='合成验收说明'
        await row.get_by_role('button', name='删除任务', exact=True).click(); await online()
        assert await page.locator('.user-notice').get_by_role('button', name='撤销删除', exact=True).is_visible()
        deleted = next(t for t in request(env.base, '/api/v1/state', env.app_token)['todos'] if t['id']=='ui-task')
        assert deleted['deletedAt'] and deleted['totalTimeSpent'] >= 2
        assert 'ui-task' not in [t['id'] for t in request(env.base, '/api/v1/bot/tasks', env.bot_token)['tasks']]
        await page.reload(); await online()
        await tool('回收站'); await page.get_by_role('tab', name='已删除', exact=False).click()
        card = page.get_by_role('article', name='[UI测试] 可恢复的任务', exact=True)
        await card.locator('summary').click(); await capture('recycle-records')
        await card.get_by_role('button', name='恢复', exact=True).click(); await online()
        recovered = next(t for t in request(env.base, '/api/v1/state', env.app_token)['todos'] if t['id']=='ui-task')
        assert not recovered.get('deletedAt') and not recovered.get('reminderAt')
        assert recovered['totalTimeSpent']==deleted['totalTimeSpent']
        await page.get_by_role('tab', name='已完成', exact=False).click()
        goal = page.get_by_role('article', name='[UI测试] 每日目标', exact=True)
        await goal.get_by_role('button', name='撤销打卡', exact=True).click(); await online()
        assert not next(t for t in request(env.base, '/api/v1/state', env.app_token)['todos'] if t['id']=='ui-goal')['completionDates']
        await tool('待办列表')
        group = page.locator('.todo-row').filter(has_text='[UI测试] 任务集')
        await group.get_by_role('button', name='删除任务', exact=True).click(); await online()
        await tool('回收站'); await page.get_by_role('tab', name='已删除', exact=False).click()
        await page.get_by_role('article', name='[UI测试] 任务集', exact=True).get_by_role('button', name='恢复任务集', exact=True).click(); await online()
        data = request(env.base, '/api/v1/state', env.app_token)
        assert all(not t.get('deletedAt') for t in data['todos'] if t['id'] in ['ui-group','ui-child'])
        assert json.loads(await page.evaluate("localStorage.getItem('todo-widget.todos')")) == original
        print('PASS UI: timer controls, completion undo, reload-safe recycle/restore, goal-day undo, group recovery, original local data untouched')
        await tool('待办列表')
        started = time.monotonic()
        request(env.base, '/api/v1/bot/actions', env.bot_token, {
            'mutationId':str(uuid.uuid4()),'expectedRevision':data['revision'],'action':'create',
            'task':{'title':'[UI测试] 机器人新任务','priority':'normal','listId':'list-today'}})
        await page.get_by_text('[UI测试] 机器人新任务', exact=True).wait_for(timeout=7500)
        assert time.monotonic()-started < 7.5
        print('PASS UI: real HTTP bot mutation appears on the next automatic poll (no reload or focus)')
        # Render the real floating-window HTML/JS with a synthetic Tauri bridge for visuals.
        floating = await context.new_page()
        await floating.set_viewport_size({'width':280,'height':100})
        floating.on('pageerror', lambda error: errors.append(str(error)))
        await floating.add_init_script("""window.__TAURI__ = { window: { getCurrentWindow: () => ({ startDragging: async () => {} }) }, event: {
          listen: async (name, callback, options) => { window.__timerUpdate = callback; window.__timerTarget = options.target; return () => {}; },
          emitTo: async () => {}
        }};""")
        await floating.goto(env.web + '/timer.html')
        await floating.evaluate("""() => window.__timerUpdate({payload:{sessionId:'synthetic-ui',title:'[UI测试] 暂停与主题',elapsed:75,paused:true,canResume:true,theme:{rgb:'58, 47, 80',accent:'168, 139, 250'}}})""")
        assert await floating.get_by_role('button', name='继续计时', exact=True).is_enabled()
        assert await floating.evaluate("window.__timerTarget.label") == 'timer'
        if screenshots: await floating.screenshot(path=str(screenshots / 'floating-timer-purple.png'))
        assert not errors, errors
        await browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker-image')
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if args.screenshots: args.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='todo-widget-ui-test-') as temp:
        env = Environment(Path(temp), args.docker_image, True)
        try:
            env.start()
            asyncio.run(browser_checks(env, args.screenshots))
        finally:
            env.close()
    print('PASS all UI regressions; only owned temporary processes/data were used and removed')


if __name__ == '__main__':
    main()
