/**
 * 常驻「运行日志」抽屉 —— Uranus 插件版 v2（按原版补丁 1:1 复刻）。
 *
 * 原版是 636 行 React，深度嵌在 store.jsx 的 LogContext 和 shell.jsx 里。
 * 这一版不碰任何内部，用原生 DOM + 现成的 /api 把同样的界面和功能搬进来：
 *  - 同一条 SSE：/api/logs/stream（上游自带）
 *  - 日志行、五级筛选、搜索、暂停、清空、默认展开、拖动、问题角标 —— 全复刻
 *  - 模型快切：优先走 /api/role-model（装了补丁时），没有就用
 *    GET /api/config + PUT /api/config 读改写实现同样效果（纯上游也能用）
 *
 * 传给插件的 ctx = { id, name, version, config }。config 是加载时的快照。
 */

const POS_KEY = "uranus-plugin-log-drawer.pos.v2";
const OPEN_KEY = "uranus-plugin-log-drawer.open.v2";
const DEFAULT_OPEN_KEY = "uranus-plugin-log-drawer.defaultOpen.v2";
const LEVEL_KEY = "uranus-plugin-log-drawer.level.v2";

/* 五级：和后端 server/src/logs.js 的 LEVELS 一字不差 */
const LEVEL_ORDER = ["debug", "info", "warn", "error", "critical"];
const LEVEL_FILTERS = [
  { id: "debug", label: "DEBUG" },
  { id: "info", label: "INFO" },
  { id: "warn", label: "WARNING" },
  { id: "error", label: "ERROR" },
  { id: "critical", label: "CRITICAL" },
];

/* 模型快切三档 */
const TARGET_ORDER = ["chat", "offline", "fallback"];
const TARGET_LABEL = { chat: "聊天", offline: "线下", fallback: "兜底" };

function readRaw(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key, val) {
  try { window.localStorage.setItem(key, val); } catch { /* 隐身模式忽略 */ }
}
function readJson(key, fallback) {
  try { const raw = readRaw(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJson(key, val) { writeRaw(key, JSON.stringify(val)); }

/** 毫秒时间 HH:MM:SS.mmm（照原版 fmtTime，用本地时区） */
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function isProblem(level) { return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf("warn"); }

const refValue = (ref) => (ref?.provider && ref?.modelId ? `${ref.provider}::${ref.modelId}` : "");
const parseRef = (value) => {
  const [provider = "", modelId = ""] = String(value ?? "").split("::");
  return { provider, modelId };
};
const roleLabel = (r) => r?.name?.trim() || "未命名角色";
const providerLabel = (p) => p?.name?.trim() || p?.id || "未命名服务商";
const modelLabel = (m) => m?.alias?.trim() || m?.model || "";

/** 内联 SVG（原版用 lucide，这里等价内联） */
const ICON = {
  terminal: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  radio: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
};

export default function logDrawer(ctx = {}) {
  const cfg = ctx.config ?? {};
  const limit = Math.min(Math.max(Number(cfg.maxRows) || 2000, 20), 5000);

  /* ===== 运行时状态：必须先声明（下面初始化会用到） ===== */
  let rows = [];
  let connected = false;
  let paused = false;
  let pendingCount = 0;
  let level = LEVEL_FILTERS.some((f) => f.id === cfg.level) ? cfg.level : "info";
  let query = "";
  let autoScroll = true;
  let switching = false;
  let note = null;
  let rolePick = "all";
  let target = "chat";
  let modelPick = "";
  let es = null;
  let raf = 0;
  let dragState = null;
  let serverConfig = null;
  let hasRoleModelApi = true;

  /* ===== 位置与开合 ===== */
  const winW = () => (typeof window !== "undefined" ? window.innerWidth : 1280);
  const winH = () => (typeof window !== "undefined" ? window.innerHeight : 800);
  function readPos() {
    const p = readJson(POS_KEY, null);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    return { x: Math.max(8, winW() - 140), y: Math.max(8, winH() - 64) };
  }
  let pos = readPos();
  const savedDefault = readRaw(DEFAULT_OPEN_KEY);
  const defaultOpen = savedDefault === null ? Boolean(cfg.defaultOpen ?? false) : savedDefault === "1";
  let open = defaultOpen ? true : readRaw(OPEN_KEY) === "1";
  if (savedDefault === null) writeRaw(DEFAULT_OPEN_KEY, defaultOpen ? "1" : "0");

  /* ===== 界面骨架 ===== */
  const root = document.createElement("div");
  root.id = "uranus-plugin-log-drawer";
  root.innerHTML = `
    <button class="jld-capsule" type="button" title="展开实时日志（可拖动到任意位置）">
      <span class="jld-radio">${ICON.radio}</span><span class="jld-capsule-text">实时日志</span>
      <span class="jld-disc" hidden>· 断开</span><span class="jld-problem" hidden>0</span>
    </button>
    <section class="jld-panel" aria-label="运行日志">
      <header class="jld-head">
        <div class="jld-head-left">
          <span class="jld-ico-term">${ICON.terminal}</span>
          <span class="jld-title">运行日志</span>
          <span class="jld-status"><span class="jld-radio">${ICON.radio}</span><span class="jld-status-text">已断开，重连中…</span></span>
        </div>
        <div class="jld-head-right">
          <button class="jld-btn jld-switch" type="button" title="快速切换模型" aria-label="快速切换模型">${ICON.cpu}<span>模型</span></button>
          <button class="jld-btn jld-close" type="button" title="收起日志" aria-label="收起日志">${ICON.x}</button>
        </div>
      </header>
      <div class="jld-switcher" hidden>
        <div class="jld-sw-row1">
          <select class="jld-role-sel" aria-label="选择角色"><option value="all">全部角色</option></select>
          <select class="jld-model-sel" aria-label="选择模型"><option value="">选一个模型…</option></select>
          <button class="jld-apply" type="button">${ICON.check}<span>切换</span></button>
        </div>
        <div class="jld-sw-row2">
          <div class="jld-targets">
            ${TARGET_ORDER.map((t) => `<button class="jld-target" type="button" data-target="${t}" title="${t === "fallback" ? "兜底＝原「副 API」，聊天和线下共用同一份" : `只切${TARGET_LABEL[t]}模型`}">${TARGET_LABEL[t]}</button>`).join("")}
          </div>
          <p class="jld-note" title=""></p>
        </div>
      </div>
      <div class="jld-tools">
        <div class="jld-levels">
          ${LEVEL_FILTERS.map((f) => `<button class="jld-level" type="button" data-level="${f.id}">${f.label}</button>`).join("")}
        </div>
        <div class="jld-search">${ICON.search}<input type="text" class="jld-q" placeholder="搜索关键词…" /></div>
        <button class="jld-btn jld-pause" type="button">${ICON.pause}<span class="jld-pause-text">暂停</span></button>
        <button class="jld-btn jld-clear" type="button" disabled>${ICON.trash}<span>清空</span></button>
      </div>
      <div class="jld-list-wrap">
        <div class="jld-list" data-scroll></div>
        <button class="jld-to-latest" type="button" hidden>回到最新</button>
      </div>
      <footer class="jld-foot">
        <label class="jld-default-label"><input type="checkbox" class="jld-default" />默认展开</label>
        <p>后端实时日志。链路断了先变红「已断开」，报错实时冒出 —— 不用切控制台。拖动标题栏可挪到任意位置。</p>
      </footer>
    </section>
  `;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const capsule = $(".jld-capsule");
  const panel = $(".jld-panel");
  const head = $(".jld-head");
  const list = $(".jld-list");
  const statusText = $(".jld-status-text");
  const problemBadge = $(".jld-problem");
  const discLabel = $(".jld-disc");
  const switcher = $(".jld-switcher");
  const switchBtn = $(".jld-switch");
  const roleSel = $(".jld-role-sel");
  const modelSel = $(".jld-model-sel");
  const applyBtn = $(".jld-apply");
  const noteEl = $(".jld-note");
  const qInput = $(".jld-q");
  const pauseBtn = $(".jld-pause");
  const pauseText = $(".jld-pause-text");
  const clearBtn = $(".jld-clear");
  const toLatest = $(".jld-to-latest");
  const defaultChk = $(".jld-default");

  /* ===== 定位（边缘避让） ===== */
  const PANEL_W = 440;
  const PANEL_EST_H = 430;
  function place() {
    if (open) {
      const estH = PANEL_EST_H + (switching ? 70 : 0);
      let left = pos.x;
      let top = pos.y;
      if (left + PANEL_W > winW() - 8) left = Math.max(8, winW() - PANEL_W - 8);
      if (top + estH > winH() - 8) top = Math.max(8, winH() - estH - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    } else {
      capsule.style.left = `${pos.x}px`;
      capsule.style.top = `${pos.y}px`;
    }
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    capsule.style.right = "auto";
    capsule.style.bottom = "auto";
  }

  function setOpen(next) {
    open = next;
    root.classList.toggle("jld-open", open);
    capsule.hidden = open;
    panel.hidden = !open;
    writeRaw(OPEN_KEY, open ? "1" : "0");
    place();
    if (open) {
      pendingCount = 0;
      schedule();
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
  }
  defaultChk.checked = defaultOpen;
  setOpen(open);

  function setDefaultOpen(next) {
    writeRaw(DEFAULT_OPEN_KEY, next ? "1" : "0");
    if (next) setOpen(true);
  }
  defaultChk.addEventListener("change", () => setDefaultOpen(defaultChk.checked));

  /* ===== 拖动（气泡和整条头部都能拖；轻点当点击） ===== */
  // self：允许 Draggable 容器自身即使带 button 标签也能拖（胶囊本体就是 button）。
  // 只对「内部的其它按钮/控件」放行拦截，避免碰到模型/关闭按钮就误拖动。
  function makeDrag(onTap, self) {
    return (e) => {
      if (e.button != null && e.button !== 0) return;
      const hit = e.target.closest(".jld-btn, .jld-switcher, button, select, input");
      if (hit && hit !== self) return;
      if (e.cancelable) e.preventDefault();
      dragState = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y, moved: false, onTap };
      root.classList.add("jld-dragging");
    };
  }
  function onMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.sx;
    const dy = e.clientY - dragState.sy;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragState.moved = true;
    pos = {
      x: Math.max(8, Math.min(dragState.bx + dx, winW() - 60)),
      y: Math.max(8, Math.min(dragState.by + dy, winH() - 48)),
    };
    place();
  }
  function onUp() {
    if (!dragState) return;
    const { moved, onTap } = dragState;
    dragState = null;
    root.classList.remove("jld-dragging");
    writeJson(POS_KEY, pos);
    if (!moved && onTap) onTap();
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  capsule.addEventListener("pointerdown", makeDrag(() => setOpen(true), capsule));
  head.addEventListener("pointerdown", makeDrag(null, head));

  /* ===== 按钮 ===== */
  // 不再额外挂 click：展开已由 makeDrag 的 onTap（轻点未拖动）处理，
  // 否则拖动结束 pointerup 后紧接着的 click 会误触发一次展开。
  $(".jld-close").addEventListener("click", (e) => { e.stopPropagation(); setOpen(false); });
  switchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switching = !switching;
    switcher.hidden = !switching;
    root.classList.toggle("jld-switch-on", switching);
    place();
    if (switching) loadServerConfig();
  });

  /* ===== 级别筛选 / 搜索 / 暂停 / 清空 ===== */
  function applyLevel() {
    level = readRaw(LEVEL_KEY) || "info";
    root.querySelectorAll(".jld-level").forEach((b) => {
      b.classList.toggle("jld-level-on", b.dataset.level === level);
    });
  }
  root.querySelectorAll(".jld-level").forEach((b) => {
    b.addEventListener("click", () => {
      level = b.dataset.level;
      writeRaw(LEVEL_KEY, level);
      applyLevel();
      schedule();
    });
  });
  applyLevel();

  qInput.addEventListener("input", () => { query = qInput.value.trim().toLowerCase(); schedule(); });

  function updatePauseBtn() {
    pauseBtn.classList.toggle("jld-paused", paused);
    pauseText.textContent = paused ? `继续${pendingCount ? `（+${pendingCount}）` : ""}` : "暂停";
    pauseBtn.querySelector("svg").outerHTML = paused ? ICON.play : ICON.pause;
  }
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    if (!paused) { pendingCount = 0; autoScroll = true; }
    updatePauseBtn();
    schedule();
  });
  clearBtn.addEventListener("click", () => {
    rows = [];
    pendingCount = 0;
    schedule();
  });
  toLatest.addEventListener("click", () => {
    autoScroll = true;
    toLatest.hidden = true;
    list.scrollTop = list.scrollHeight;
  });
  list.addEventListener("scroll", () => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    autoScroll = atBottom;
    toLatest.hidden = atBottom;
  });

  /* ===== 日志渲染 ===== */
  function filteredRows() {
    const minRank = LEVEL_ORDER.indexOf(level);
    return rows.filter((e) => {
      if (LEVEL_ORDER.indexOf(e.level) < minRank) return false;
      if (!query) return true;
      return (
        String(e.message ?? "").toLowerCase().includes(query) ||
        String(e.scope ?? "").toLowerCase().includes(query) ||
        String(e.detail ?? "").toLowerCase().includes(query)
      );
    });
  }

  function makeRow(entry) {
    const lv = entry.level ?? "info";
    const div = document.createElement("div");
    div.className = `jld-row jld-row-${lv}${isProblem(lv) ? " jld-row-warn" : ""}`;
    const line = document.createElement("div");
    line.className = "jld-row-line";
    const time = document.createElement("span");
    time.className = "jld-time";
    time.textContent = fmtTime(entry.ts);
    const scope = document.createElement("span");
    scope.className = `jld-scope jld-scope-${lv}`;
    scope.textContent = entry.scope ?? "系统";
    scope.title = entry.scope ?? "";
    const msg = document.createElement("button");
    msg.type = "button";
    msg.className = `jld-msg${isProblem(lv) ? " jld-msg-warn" : ""}`;
    const hasDetail = Boolean(entry.detail);
    if (hasDetail) msg.classList.add("has-detail");
    const text = document.createElement("span");
    text.className = "jld-msg-text";
    text.textContent = String(entry.message ?? "");
    msg.appendChild(text);
    let chev = null;
    if (hasDetail) {
      chev = document.createElement("span");
      chev.className = "jld-chev";
      chev.innerHTML = ICON.chevron;
      msg.appendChild(chev);
    }
    line.append(time, scope, msg);
    div.appendChild(line);
    if (hasDetail) {
      const pre = document.createElement("pre");
      pre.className = "jld-detail";
      pre.hidden = true;
      const code = document.createElement("code");
      code.textContent = String(entry.detail);
      pre.appendChild(code);
      msg.addEventListener("click", () => {
        pre.hidden = !pre.hidden;
        if (chev) chev.classList.toggle("jld-chev-open", !pre.hidden);
      });
      div.appendChild(pre);
    }
    return div;
  }

  function render() {
    raf = 0;
    const data = filteredRows();
    const frag = document.createDocumentFragment();
    if (!data.length) {
      const empty = document.createElement("div");
      empty.className = "jld-empty";
      const p = document.createElement("p");
      p.textContent = rows.length === 0
        ? "还没有日志。给线路号码发条 iMessage，或去「连接」点一下测试。"
        : "当前筛选条件下没有日志。";
      empty.appendChild(p);
      frag.appendChild(empty);
    } else {
      for (const e of data) frag.appendChild(makeRow(e));
    }
    list.replaceChildren(frag);
    clearBtn.disabled = rows.length === 0;
    const problems = rows.filter((e) => isProblem(e.level)).length;
    problemBadge.textContent = problems > 99 ? "99+" : String(problems);
    problemBadge.hidden = problems === 0;
    if (autoScroll && open) list.scrollTop = list.scrollHeight;
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(render); }

  function accept(entry) {
    if (!entry || typeof entry !== "object") return;
    if (rows.length && entry.id != null && rows.at(-1).id === entry.id) return;
    rows.push(entry);
    if (rows.length > limit) rows.splice(0, rows.length - limit);
    if (paused || !open) {
      pendingCount += 1;
      if (paused) updatePauseBtn();
    }
    schedule();
  }

  /* ===== 订阅 SSE ===== */
  function setConnected(next) {
    connected = next;
    statusText.textContent = next ? "实时连接中" : "已断开，重连中…";
    root.classList.toggle("jld-off", !next);
    discLabel.hidden = next;
  }
  function connect() {
    try {
      es = new EventSource("/api/logs/stream");
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try { accept(JSON.parse(e.data)); } catch { /* 一行坏日志不该弄死抽屉 */ }
      };
      es.onerror = () => setConnected(false);
    } catch {
      setConnected(false);
      statusText.textContent = "不可用";
    }
  }
  connect();

  /* ===== 模型快切 ===== */
  async function jfetch(url, opts = {}) {
    const r = await window.fetch(url, { credentials: "same-origin", ...opts });
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || j.message || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadServerConfig() {
    try {
      serverConfig = await jfetch("/api/config");
      renderSwitcher();
    } catch (e) {
      note = { ok: false, text: `读配置失败：${e.message}` };
      renderNote();
    }
  }

  function refState(ref) {
    if (!ref?.provider || !ref?.modelId) return { text: "", ok: false, empty: true };
    const p = (serverConfig?.providers ?? []).find((x) => x.id === ref.provider);
    const m = (p?.models ?? []).find((x) => x.id === ref.modelId);
    if (!p || !m) return { text: "引用已失效", ok: false };
    return { text: `${providerLabel(p)} · ${modelLabel(m)}`, ok: true, off: m.enabled === false };
  }

  function targetValue(role, kind) {
    if (kind === "offline") {
      const own = refState(role.offline?.model);
      if (!own.empty) {
        return { text: own.text, tag: own.ok ? (own.off ? "已关闭" : "") : "失效" };
      }
      const c = refState(role.chatModel);
      return { text: c.text || "未配", tag: c.ok ? "跟着聊天" : "" };
    }
    if (kind === "fallback") {
      const st = refState(role.fallbackModel);
      if (st.empty) return { text: "未配置", tag: "没有兜底" };
      if (!role.fallbackModel?.enabled) return { text: st.text, tag: "未启用" };
      if (!st.ok) return { text: st.text, tag: "失效" };
      return { text: st.text, tag: st.off ? "已关闭" : "" };
    }
    const st = refState(role.chatModel);
    return { text: st.text || "未配", tag: st.empty ? "" : st.ok ? (st.off ? "已关闭" : "") : "失效" };
  }

  function summarize(kind) {
    const roles = serverConfig?.roles ?? [];
    if (!roles.length) return { text: "还没有角色", tag: "" };
    const list = roles.map((r) => ({ name: roleLabel(r), ...targetValue(r, kind) }));
    const uniq = [...new Set(list.map((x) => `${x.text}|${x.tag}`))];
    if (uniq.length === 1) return list[0];
    return {
      text: `各人不同（${uniq.length} 种）`,
      tag: "",
      detail: list.map((x) => `${x.name}：${x.text}${x.tag ? `（${x.tag}）` : ""}`).join("\n"),
    };
  }

  function currentInfo() {
    const roles = serverConfig?.roles ?? [];
    const single = rolePick === "all" ? null : roles.find((r) => r.id === rolePick);
    return single ? targetValue(single, target) : summarize(target);
  }

  function renderNote() {
    if (!note) {
      const c = currentInfo();
      noteEl.textContent = `${TARGET_LABEL[target]} ${c.text}${c.tag ? `（${c.tag}）` : ""}`;
      noteEl.title = c.detail || noteEl.textContent;
      noteEl.className = "jld-note";
    } else {
      noteEl.textContent = note.text;
      noteEl.className = `jld-note ${note.ok ? "jld-note-ok" : "jld-note-bad"}`;
    }
  }

  function renderSwitcher() {
    const roles = serverConfig?.roles ?? [];
    const cur = roleSel.value;
    roleSel.innerHTML = `<option value="all">全部角色</option>` +
      roles.map((r) => `<option value="${r.id}">${roleLabel(r)}</option>`).join("");
    roleSel.value = [...roleSel.options].some((o) => o.value === cur) ? cur : "all";
    rolePick = roleSel.value;

    const groups = [];
    for (const p of serverConfig?.providers ?? []) {
      const models = [...(p.models ?? [])];
      if (models.length) groups.push({ p, models });
    }
    modelSel.innerHTML = `<option value="">选一个模型…</option>` +
      groups.map((g) => `<optgroup label="${providerLabel(g.p)}">` +
        g.models.map((m) => `<option value="${g.p.id}::${m.id}">${modelLabel(m)}</option>`).join("") +
        `</optgroup>`).join("");
    modelSel.value = modelPick;

    root.querySelectorAll(".jld-target").forEach((b) => {
      b.classList.toggle("jld-target-on", b.dataset.target === target);
    });
    renderNote();
  }

  function prefillModel() {
    const roles = serverConfig?.roles ?? [];
    const single = rolePick === "all" ? null : roles.find((r) => r.id === rolePick);
    if (!single) { modelPick = ""; modelSel.value = ""; return; }
    const ref = target === "offline"
      ? (single.offline?.model ?? single.chatModel)
      : target === "fallback" ? single.fallbackModel : single.chatModel;
    modelPick = refValue(ref);
    modelSel.value = modelPick;
  }

  roleSel.addEventListener("change", () => {
    rolePick = roleSel.value;
    note = null;
    prefillModel();
    renderNote();
  });
  modelSel.addEventListener("change", () => { modelPick = modelSel.value; note = null; renderNote(); });
  root.querySelectorAll(".jld-target").forEach((b) => {
    b.addEventListener("click", () => {
      target = b.dataset.target;
      note = null;
      root.querySelectorAll(".jld-target").forEach((x) => x.classList.toggle("jld-target-on", x === b));
      renderSwitcher();
      prefillModel();
    });
  });

  /** 应用模型：优先补丁接口，回退 GET+PUT config */
  async function applyModel() {
    const ref = parseRef(modelPick);
    if (!ref.provider || !ref.modelId) {
      note = { ok: false, text: "先在下拉里挑一个模型" };
      renderNote();
      return;
    }
    const roles = serverConfig?.roles ?? [];
    const ids = rolePick === "all" ? roles.map((r) => r.id) : [rolePick];
    if (!ids.length) {
      note = { ok: false, text: "没有可切的角色" };
      renderNote();
      return;
    }
    switching = true;
    applyBtn.disabled = true;
    note = null;
    renderNote();
    try {
      let where;
      if (hasRoleModelApi) {
        try {
          const r = await jfetch("/api/role-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roleIds: ids, provider: ref.provider, modelId: ref.modelId, target }),
          });
          where = String(r.where || "").replace(/模型$/, "") || TARGET_LABEL[target];
        } catch (e) {
          if (/404|not found/i.test(e.message)) hasRoleModelApi = false;
          else throw e;
        }
      }
      if (!hasRoleModelApi) {
        const fresh = await jfetch("/api/config");
        const picked = new Set(ids);
        const nextRoles = (fresh.roles ?? []).map((r) => {
          if (!picked.has(r.id)) return r;
          const n = { ...r };
          if (target === "chat") n.chatModel = { ...ref };
          if (target === "offline") n.offline = { ...(n.offline ?? {}), model: { ...ref } };
          if (target === "fallback") n.fallbackModel = { ...(n.fallbackModel ?? {}), ...ref, enabled: true };
          return n;
        });
        await jfetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fresh, roles: nextRoles }),
        });
        where = TARGET_LABEL[target];
      }
      serverConfig = await jfetch("/api/config");
      const chosen = (serverConfig.providers ?? []).find((p) => p.id === ref.provider)?.models?.find((m) => m.id === ref.modelId);
      note = { ok: true, text: `${where || TARGET_LABEL[target]}模型已切到 ${modelLabel(chosen) || ref.modelId}` };
    } catch (e) {
      note = { ok: false, text: String(e?.message ?? e) };
    } finally {
      switching = false;
      applyBtn.disabled = false;
      renderNote();
    }
  }
  applyBtn.addEventListener("click", applyModel);

  /* ===== 页面卸载断开 SSE ===== */
  window.addEventListener("pagehide", () => { try { es?.close(); } catch { /* ignore */ } }, { once: true });

  /* 自检钩子：确认初始化没半途中断 */
  root.__jldReady = true;
}
