(() => {
  const title = document.getElementById('timer-title');
  const display = document.getElementById('timer-display');
  const status = document.getElementById('timer-status');
  const pause = document.getElementById('pause-btn');
  const stop = document.getElementById('stop-btn');
  const api = window.__TAURI__;
  const currentWindow = api?.window?.getCurrentWindow?.();
  let sessionId = null, paused = false, canResume = false;
  let pending = null, timeout, readyRetry, unlisten, disposed = false, lastError = "";

  const error = message => { lastError = message; status.textContent = message; status.classList.add('error'); };
  const controls = () => {
    pause.disabled = !sessionId || !!pending || (paused && !canResume);
    stop.disabled = !sessionId || !!pending;
    pause.title = paused ? '继续计时' : '暂停计时';
    pause.setAttribute('aria-label', pause.title);
    pause.innerHTML = paused
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3l15 9-15 9z" /></svg>继续'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 4h5v16H5zm9 0h5v16h-5z" /></svg>暂停';
  };
  const clearPending = () => { clearTimeout(timeout); pending = null; controls(); };
  const request = async (event, payload = {}) => {
    if (!sessionId || pending) return;
    lastError = "";
    pending = crypto.randomUUID();
    const requestId = pending;
    controls();
    timeout = setTimeout(() => { clearPending(); error('未收到响应，请用主窗口底部按钮。'); }, 3000);
    try { await api.event.emitTo('main', event, { sessionId, requestId, ...payload }); }
    catch { clearPending(); error('发送失败，请用主窗口底部按钮。'); }
  };

  if (!currentWindow || !api?.event?.listen || !api?.event?.emitTo) {
    title.textContent = '计时器未连接';
    error('请从桌面小组件启动计时。');
    return;
  }

  // Never mark the controls as a native drag region. A press on an SVG inside a
  // button must remain a click rather than being consumed by startDragging().
  document.querySelector('.timer-content').addEventListener('mousedown', event => {
    if (event.button === 0 && !event.target.closest('button')) currentWindow.startDragging().catch(() => {});
  });
  pause.addEventListener('click', () => void request('timer-set-paused', { paused: !paused }));
  stop.addEventListener('click', () => void request('timer-stop'));

  api.event.listen('timer-update', event => {
    const state = event.payload;
    if (!state || typeof state.sessionId !== 'string' || !Number.isFinite(state.elapsed)) return;
    clearInterval(readyRetry);
    if (sessionId !== state.sessionId) { clearPending(); lastError = ""; }
    sessionId = state.sessionId;
    paused = !!state.paused;
    canResume = !!state.canResume;
    title.textContent = state.title;
    const seconds = Math.max(0, Math.floor(state.elapsed));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    display.textContent = hours ? `${hours}小时${minutes}分钟` : minutes ? `${minutes}分钟${seconds % 60}秒` : `${seconds}秒`;
    status.classList.remove('error');
    status.textContent = paused ? (canResume ? '已暂停' : '已暂停 · 当前只读') : '计时中';
    for (const [key, value] of [['--widget-tint', state.theme?.rgb], ['--accent', state.theme?.accent]]) {
      if (typeof value === 'string' && /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value)) document.documentElement.style.setProperty(key, value);
    }
    if (state.requestId === pending) { clearPending(); lastError = ""; }
    if (state.error) lastError = state.error;
    if (lastError) error(lastError);
    controls();
  }, { target: { kind: 'WebviewWindow', label: 'timer' } }).then(off => {
    if (disposed) { off(); return; }
    unlisten = off;
    const ready = () => api.event.emitTo('main', 'timer-ready').catch(() => error('连接失败，请用主窗口底部按钮。'));
    void ready();
    readyRetry = setInterval(() => { if (!sessionId) void ready(); }, 1000);
  }).catch(() => error('监听失败，请用主窗口底部按钮。'));

  window.addEventListener('pagehide', () => {
    disposed = true;
    clearTimeout(timeout); clearInterval(readyRetry); unlisten?.();
  }, { once: true });
})();
