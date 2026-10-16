/* Horaire — screens and interactions. Rules live in logic.js, words in i18n.js. */
(function () {
  'use strict';
  const H = window.Horaire;
  const STORE = 'horaire.v1';
  const HOUR_PX = matchMedia('(max-width: 600px)').matches ? 34 : 44;   // width of one hour in the day view
  document.documentElement.style.setProperty('--hour', HOUR_PX + 'px');
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const norm = s => fold(s).trim();

  let state = load();
  const now = new Date();
  const ui = {
    tab: 'schedule',
    week: H.mondayOf(now),
    day: (now.getDay() + 6) % 7,
    view: 'day',   // always open on today's day view
    station: 'kitchen',   // which station the day view shows
    search: '',
    searchOpen: false,
    short: new Map(),
    boardKey: '',
    teamSearch: '',
    undo: null,
    issues: null,
  };

  // ---------- words & formats ----------
  const t = (key, p) => window.I18N.t(state.settings.lang, key, p);
  const locale = () => (state.settings.lang === 'fr' ? 'fr-CA' : 'en-CA');
  function fmtT(min) {
    min = ((min % H.DAY) + H.DAY) % H.DAY;
    const h = Math.floor(min / 60), m = min % 60;
    return state.settings.lang === 'fr' ? h + 'h' + (m ? String(m).padStart(2, '0') : '') : h + ':' + String(m).padStart(2, '0');
  }
  const fmtRange = (s, e) => fmtT(s) + '–' + fmtT(e);
  const fmtH = h => String(Math.round(h * 10) / 10).replace('.', state.settings.lang === 'fr' ? ',' : '.') + ' h';
  const fmtDate = (iso, opts = { day: 'numeric', month: 'short' }) => H.parseIso(iso).toLocaleDateString(locale(), opts);
  const weekLabel = () => fmtDate(ui.week) + ' – ' + fmtDate(H.addDays(ui.week, 6));
  // "12–18 oct." when the week stays in one month, to fit the header on a phone.
  function weekLabelShort() {
    const a = H.parseIso(ui.week), end = H.addDays(ui.week, 6);
    return a.getMonth() === H.parseIso(end).getMonth() ? `${a.getDate()}–${fmtDate(end)}` : weekLabel();
  }
  const empName = id => (H.findEmp(state, id) || {}).name || '?';

  // "Alexandre Tremblay" → "Alexandre T.", unless two people would look the same.
  function shortNames() {
    const short = n => { const w = n.trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : n; };
    const count = {};
    state.employees.forEach(e => { const s = short(e.name); count[s] = (count[s] || 0) + 1; });
    return new Map(state.employees.map(e => [e.id, count[short(e.name)] > 1 ? e.name : short(e.name)]));
  }
  const shortName = id => ui.short.get(id) || empName(id);

  // Assigned vs wanted hours, shown under a name: "24 h / 32 h" plus a bar.
  // Quiet when fine; orange under their minimum, red over their max.
  function hoursInfo(e, h) {
    if (!e) return '';
    const cls = h > e.maxHours ? 'over' : h < e.minHours ? 'under' : 'fine';
    const pct = e.maxHours ? Math.min(100, (h / e.maxHours) * 100) : 0;
    const minMark = e.minHours && e.maxHours ? `<b style="left:${Math.min(100, (e.minHours / e.maxHours) * 100)}%"></b>` : '';
    const label = `${fmtH(h)} / ${e.maxHours} h` + (cls === 'under' ? ` · ${t('hrsMin', { min: e.minHours })}` : '');
    return `<span class="hrs ${cls}" title="${esc(t('hrsTitle', { h: fmtH(h), max: e.maxHours, min: e.minHours }))}">
      <span>${label}</span><span class="hrs-bar"><i style="width:${pct}%"></i>${minMark}</span></span>`;
  }

  function reason(b) {
    const p = { ...b };
    if (b.total != null) p.total = fmtH(b.total);
    if (b.hours != null) p.h = fmtH(b.hours);
    if (b.from) { p.from = fmtDate(b.from); p.to = fmtDate(b.to); p.note = b.note ? ' (' + b.note + ')' : ''; }
    return esc(t('r_' + b.code, p));
  }

  // ---------- storage ----------
  function load() {
    try { return H.migrate(JSON.parse(localStorage.getItem(STORE))); } catch { return H.defaultState(); }
  }
  let persistAsked = false;
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { toast(t('saveFailed')); }
    if (!persistAsked && navigator.storage && navigator.storage.persist) {
      persistAsked = true;
      navigator.storage.persist().catch(() => {});
    }
  }
  const shiftsOf = (key = ui.week) => H.weekShifts(state, key);
  function setShifts(list, key = ui.week) { state.weeks[key] = { shifts: list }; save(); }
  function remember() { ui.undo = { key: ui.week, shifts: shiftsOf().map(s => ({ ...s })) }; }
  function undo() {
    if (!ui.undo) return;
    state.weeks[ui.undo.key] = { shifts: ui.undo.shifts };
    ui.undo = null;
    save();
    closeSheet();
    render();
    toast(t('undone'));
  }
  function upsertShift(sh) {
    const list = shiftsOf().filter(s => s.id !== sh.id);
    list.push(sh);
    setShifts(list);
  }

  // ---------- shell ----------
  const ICONS = {
    schedule: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    team: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.7.2 4.4 2.3 5 5"/></svg>',
    needs: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  };

  function render() {
    document.documentElement.lang = state.settings.lang;
    if (ui.tab === 'schedule') {
      ui.issues = H.weekIssues(state, ui.week);
      ui.short = shortNames();
    }
    const body = { schedule: scheduleTab, team: teamTab, needs: needsTab, settings: settingsTab }[ui.tab]();
    const prevLeft = ($('.gantt') || {}).scrollLeft;
    $('#app').innerHTML = header() + `<main id="main">${body}</main>` + nav();
    placeTimeline(prevLeft);
  }

  // Day view: keep the scroll position while working on the same day; on a
  // newly opened day, start at the current hour (today) or at 6h.
  function placeTimeline(prevLeft) {
    const g = $('.gantt');
    if (!g) { ui.boardKey = ''; return; }
    const key = ui.week + ui.day + ui.station;
    if (key === ui.boardKey && prevLeft != null) { g.scrollLeft = prevLeft; return; }
    ui.boardKey = key;
    const isToday = H.addDays(ui.week, ui.day) === H.isoOf(new Date());
    const n = new Date();
    scrollTimeline(isToday ? n.getHours() * 60 - 60 : 6 * 60);
  }

  function scrollTimeline(min) {
    const g = $('.gantt');
    if (g) g.scrollLeft = Math.max(0, (min - +g.dataset.ws) / 60 * HOUR_PX);
  }

  const searchIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';

  // Schedule header: week, Day/Week switch and search all on one line, so the
  // schedule itself starts higher on the screen.
  function header() {
    if (ui.tab !== 'schedule') {
      return `<header class="top"><span class="brand">${t('appName')}</span><h1 class="title">${t('tab_' + ui.tab)}</h1></header>`;
    }
    const weeknav = `<div class="weeknav">
        <button class="icon-btn" data-action="week" data-d="-7" aria-label="${t('prevWeek')}">‹</button>
        <button class="weeklabel" data-action="week-today" title="${t('thisWeek')}">${weekLabelShort()}</button>
        <button class="icon-btn" data-action="week" data-d="7" aria-label="${t('nextWeek')}">›</button>
      </div>`;
    if (!state.employees.length) return `<header class="top"><span class="brand">${t('appName')}</span>${weeknav}</header>`;
    const searching = ui.searchOpen || ui.search;
    return `<header class="top sched">
      ${weeknav}
      <div class="seg small" role="group" aria-label="${t('view')}">
        <button data-action="view" data-v="day" aria-pressed="${ui.view === 'day'}">${t('day')}</button>
        <button data-action="view" data-v="week" aria-pressed="${ui.view === 'week'}">${t('week')}</button>
      </div>
      <button class="icon-btn search-btn ${searching ? 'on' : ''}" data-action="search-toggle" aria-label="${t('searchName')}" aria-expanded="${!!searching}">${searchIcon}</button>
      ${searching ? `<div class="search searchbar">
        <input id="search" type="search" placeholder="${t('searchName')}" aria-label="${t('searchName')}"
          value="${esc(ui.search)}" autocomplete="off" autocorrect="off" enterkeyhint="search">
        <ul id="suggest" class="suggest" hidden></ul></div>` : ''}
    </header>`;
  }

  function nav() {
    return `<nav class="tabs">${['schedule', 'team', 'needs', 'settings'].map(k => `
      <button data-action="tab" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${ICONS[k]}<span>${t('tab_' + k)}</span></button>`).join('')}
    </nav>`;
  }

  // ---------- schedule tab ----------
  // Order on the page = order of importance: where am I, what's wrong,
  // the one main action, then the schedule itself. Rare actions sit at the bottom.
  function scheduleTab() {
    if (!state.employees.length) return gettingStarted();
    const hasShifts = shiftsOf().length > 0;
    const otherWeek = ui.week !== H.mondayOf(new Date());
    return `
      ${otherWeek ? `<div class="notice">${t('otherWeek')} <button class="link" data-action="week-today">${t('backToThisWeek')}</button></div>` : ''}
      ${nextStepCard()}
      <div class="actions-row">
        <button class="btn" data-action="add-shift">${t('addShift')}</button>
        <button class="btn" data-action="copy-week">${t('copyLastWeekShort')}</button>
        <button class="btn" data-action="share">${t('share')}</button>
      </div>
      ${ui.view === 'day' ? dayChips() + dayBar() : `<div class="legend-row">
        <span><i class="sw kitchen"></i>${t('kitchen')}</span><span><i class="sw front"></i>${t('front')}</span>
        <button class="link" data-action="help">${t('whatsThis')}</button></div>`}
      <div id="board">${board()}</div>
      <p class="hint center">${ui.view === 'day' ? t('tapShiftHint') : t('tapCellHint')}</p>
      ${backupBanner()}
      ${hasShifts ? `<p class="center"><button class="link danger" data-action="clear-week">${t('clearWeek')}</button></p>` : ''}`;
  }

  const whenOf = sh => `${t('days')[sh.day]} ${fmtRange(sh.start, sh.end)} · ${t(sh.station)}`;
  const gapDayOf = g => Math.min(6, Math.floor(g.start / H.DAY));

  // "What do I do now?" — one card, one clear step, with the button to do it.
  // Problems are shown one at a time, earliest first, instead of as a count.
  function nextStepCard() {
    const card = (kind, title, body, buttons) => `<section class="next ${kind}">
      <p class="next-label">${t('ns_label')}</p><h2>${title}</h2>${body}<div class="stack">${buttons}</div></section>`;

    if (!shiftsOf().length) {
      return card('neutral', t('ns_emptyTitle'), `<p>${t('ns_emptyBody')}</p>`,
        `<button class="btn primary big" data-action="generate">${t('generate')}</button>`);
    }
    const is = ui.issues;
    const byTime = (a, b) => a.shift.day - b.shift.day || a.shift.start - b.shift.start;
    const blocks = is.items.filter(i => i.kind === 'block').sort(byTime);
    const open = is.items.filter(i => i.kind === 'open').sort(byTime);
    const total = blocks.length + open.length + is.gaps.length;

    // Week ready: shrink to one line so the schedule gets the space.
    if (!total) {
      return `<button class="next-compact" data-action="share"><span>${t('ns_doneShort')}</span><b>${t('share')} ›</b></button>`;
    }

    let problem, buttons;
    if (blocks.length) {
      const b = blocks[0];
      problem = `<b>${esc(empName(b.shift.empId))}</b> · ${whenOf(b.shift)}<br><span class="err">${b.list.map(reason).join(' · ')}</span>`;
      buttons = `<button class="btn primary" data-action="replace" data-id="${b.shift.id}">${t('replaceSomeone')}</button>
        <button class="btn" data-action="edit-shift" data-id="${b.shift.id}">${t('edit')}</button>`;
    } else if (open.length) {
      problem = `${t('ns_openShift')} <b>${whenOf(open[0].shift)}</b>`;
      buttons = `<button class="btn primary" data-action="replace" data-id="${open[0].shift.id}">${t('findSomeone')}</button>`;
    } else {
      const g = is.gaps[0];
      problem = t('ns_gap', { day: t('days')[gapDayOf(g)], range: fmtRange(g.start, g.end), station: t(g.station), n: g.missing });
      buttons = `<button class="btn primary" data-action="gap-fill" data-start="${g.start}" data-end="${g.end}" data-station="${g.station}">${t('findSomeone')}</button>
        <button class="btn" data-action="goto-day" data-d="${gapDayOf(g)}" data-st="${g.station}" data-min="${g.start - gapDayOf(g) * H.DAY}">${t('seeDay')}</button>`;
    }
    return card('bad', t('ns_fixTitle', { n: total }),
      `<div class="next-problem">${problem}</div>`,
      buttons + (total > 1 ? `<button class="link" data-action="issues">${t('ns_seeAll', { n: total })} ›</button>` : ''));
  }

  // Things to fix on a day (optionally for one station): gaps, conflicts, open shifts.
  function problemsOn(d, st) {
    const is = ui.issues;
    return is.gaps.filter(g => gapDayOf(g) === d && (!st || g.station === st)).length
      + is.items.filter(it => (it.kind === 'block' || it.kind === 'open') && it.shift.day === d && (!st || it.shift.station === st)).length;
  }

  // Day title with jump buttons, then Kitchen | Front tabs.
  function dayBar() {
    const iso = H.addDays(ui.week, ui.day);
    const isToday = iso === H.isoOf(new Date());
    const jumps = [['jumpMorning', 6], ['jumpEvening', 14], ['jumpNight', 22]];
    return `<div class="day-bar">
        <h2 class="day-title">${t('daysShort')[ui.day]} ${fmtDate(iso)}${isToday ? ` <span class="today">${t('today')}</span>` : ''}</h2>
        <div class="jumps" role="group" aria-label="${t('jumpTo')}">
          ${jumps.map(([k, h]) => `<button class="chip-btn" data-action="jump" data-h="${h}">${t(k)}</button>`).join('')}
        </div>
      </div>
      <div class="station-row">
        <div class="seg station-tabs" role="tablist">
          ${H.STATIONS.map(st => {
            const n = problemsOn(ui.day, st);
            return `<button role="tab" data-action="station" data-st="${st}" aria-selected="${ui.station === st}">
              <i class="sw ${st}"></i>${t(st)}${n ? `<span class="count-badge">${n}</span>` : ''}</button>`;
          }).join('')}
        </div>
        <button class="icon-btn help-btn" data-action="help" aria-label="${t('whatsThis')}" title="${t('whatsThis')}">?</button>
      </div>`;
  }

  // Empty app: a numbered path instead of an empty grid full of red.
  function gettingStarted() {
    return `<section class="card onboard">
      <h2>${t('gs_title')}</h2>
      <p class="hint">${t('gs_intro')}</p>
      <ol class="steps">
        <li><b>${t('gs_1')}</b><span>${t('gs_1b')}</span>
          <button class="btn primary" data-action="add-emp">${t('addFirst')}</button></li>
        <li><b>${t('gs_2')}</b><span>${t('gs_2b')}</span>
          <button class="btn" data-action="tab" data-tab="needs">${t('gs_2btn')}</button></li>
        <li><b>${t('gs_3')}</b><span>${t('gs_3b')}</span></li>
      </ol>
    </section>
    <section class="card"><p class="hint">${t('gs_demo')}</p>
      <button class="btn" data-action="demo">${t('loadDemo')}</button></section>`;
  }

  function openHelp() {
    const row = (sample, text) => `<li><span class="help-sample">${sample}</span><span>${text}</span></li>`;
    openSheet(`<div class="form"><h2>${t('helpTitle')}</h2>
      <h3>${t('helpColors')}</h3>
      <ul class="help-list">
        ${row(`<span class="chip kitchen">6h–14h</span>`, t('help_kitchen'))}
        ${row(`<span class="chip front">6h–14h</span>`, t('help_front'))}
        ${row(`<span class="chip kitchen">9h–17h ↻</span>`, t('help_regular'))}
        ${row(`<span class="chip front blocked">6h–14h</span>`, t('help_blocked'))}
        ${row(`<span class="chip front forced">6h–14h</span>`, t('help_forced'))}
        ${row(`<span class="chip front open">6h–14h</span>`, t('help_open'))}
        ${row(`<span class="cov-sample short">−1</span>`, t('help_short'))}
        ${row(`<span class="count-badge static">2</span>`, t('help_dot'))}
        ${row(hoursInfo({ maxHours: 32, minHours: 0 }, 24), t('help_hours'))}
        ${row(hoursInfo({ maxHours: 32, minHours: 24 }, 16), t('help_hoursUnder'))}
      </ul>
      <h3>${t('helpHow')}</h3>
      <ul class="plain how">${['how_1', 'how_2', 'how_3', 'how_4', 'how_5'].map(k => `<li>${t(k)}</li>`).join('')}</ul>
      <div class="btns"><span class="spacer"></span><button class="btn primary" data-action="close">${t('gotIt')}</button></div></div>`);
  }

  function backupBanner() {
    if (!state.employees.length) return '';
    const last = state.meta.lastBackup && new Date(state.meta.lastBackup);
    if (last && Date.now() - last < 7 * 864e5) return '';
    return `<div class="banner">${t('backupReminder')} <button class="link" data-action="backup">${t('backupNow')}</button></div>`;
  }

  // A number per day instead of a dot: a dot on every day stops meaning anything.
  function dayChips() {
    return `<div class="daychips" role="tablist">${t('daysShort').map((d, i) => {
      const n = problemsOn(i);
      return `<button role="tab" data-action="day" data-d="${i}" aria-selected="${ui.day === i}"
        ${n ? `aria-label="${d} ${t('problemsN', { n })}"` : ''}>
        ${d}<b>${H.parseIso(H.addDays(ui.week, i)).getDate()}</b>${n ? `<i class="count-badge">${n}</i>` : ''}</button>`;
    }).join('')}</div>`;
  }

  const board = () => (ui.view === 'day' ? dayView() : weekView());

  function matches(name, q) {
    q = norm(q);
    if (!q) return true;
    const n = norm(name);
    return n.includes(q) || n.split(/[\s-]+/).map(w => w[0]).join('').startsWith(q);
  }

  function flags() {
    const m = new Map();
    for (const it of ui.issues.items) {
      if (it.kind === 'block') m.set(it.shift.id, 'blocked');
      else if (it.kind === 'forced') m.set(it.shift.id, 'forced');
      else if (it.kind === 'warn' && !m.has(it.shift.id)) m.set(it.shift.id, 'warned');
    }
    return m;
  }

  function dayView() {
    const d = ui.day;
    const today = shiftsOf().filter(s => s.day === d);
    let ws = 6 * 60, we = 30 * 60;
    today.forEach(s => { ws = Math.min(ws, Math.floor(s.start / 60) * 60); we = Math.max(we, Math.ceil(s.end / 60) * 60); });
    const n = (we - ws) / 60, width = n * HOUR_PX;
    const fl = flags();
    const bar = s => `<button class="bar ${s.station} ${fl.get(s.id) || ''} ${s.empId ? '' : 'open'}" data-action="edit-shift" data-id="${s.id}"
      style="left:${(s.start - ws) / 60 * HOUR_PX}px;width:${(s.end - s.start) / 60 * HOUR_PX - 2}px">${fmtRange(s.start, s.end)}${s.regular ? ' ↻' : ''}</button>`;
    const row = (name, list) => `<div class="g-row">${name}<div class="g-track" style="width:${width}px">${list.map(bar).join('')}</div></div>`;

    let html = `<div class="g-row g-head"><div class="g-name"></div><div class="g-track" style="width:${width}px">
      ${Array.from({ length: n }, (_, i) => `<span style="left:${i * HOUR_PX}px">${fmtT(ws + i * 60)}</span>`).join('')}</div></div>`;
    const st = ui.station;
    html += coverageRow(st, d, ws, n, width);
    const open = today.filter(s => !s.empId && s.station === st);
    if (open.length) html += row(`<div class="g-name"><span class="open-label">${t('openShifts')}</span></div>`, open);

    const shown = new Set(state.employees.filter(e => matches(e.name, ui.search)).map(e => e.id));
    const weekAll = shiftsOf();
    const list = today.filter(s => s.empId && s.station === st);
    const ids = [...new Set(list.map(s => s.empId))].filter(id => shown.has(id))
      .sort((a, b) => empName(a).localeCompare(empName(b), 'fr'));
    if (!ids.length) html += `<div class="g-empty">${ui.search ? t('noMatch') : t('nobody')}</div>`;
    for (const id of ids) {
      html += row(`<div class="g-name"><button class="link" data-action="edit-emp" data-id="${id}" title="${esc(empName(id))}">${esc(shortName(id))}</button>
        ${hoursInfo(H.findEmp(state, id), H.weekHours(weekAll, id))}</div>`, list.filter(s => s.empId === id));
    }
    return `<div class="gantt ${st}" data-ws="${ws}">${html}</div>
      <button class="btn wide" data-action="add-shift" data-day="${d}" data-station="${st}">${t(st === 'kitchen' ? 'addShiftKitchen' : 'addShiftFront')}</button>`;
  }

  // Only the hours that are short of people are marked; the rest stays quiet.
  function coverageRow(st, d, ws, n, width) {
    const { need, cov } = ui.issues;
    let cells = '', anyShort = false;
    for (let i = 0; i < n; i++) {
      const a = (d * H.DAY + ws + i * 60) / H.SLOT;
      if (a + 1 >= H.SLOTS) break;
      const want = Math.max(need[st][a], need[st][a + 1]);
      const have = Math.min(cov[st][a], cov[st][a + 1]);
      if (have >= want) { cells += '<span></span>'; continue; }
      anyShort = true;
      cells += `<span class="short" title="${t('covTitle', { have, want })}">−${want - have}</span>`;
    }
    return `<div class="g-row cov"><div class="g-name">${anyShort
      ? `<small class="err">${t('missingRow')}</small>` : `<small class="ok">✓ ${t('covered')}</small>`}</div>
      <div class="g-track cov-cells" style="width:${width}px">${cells}</div></div>`;
  }

  function weekView() {
    const shifts = shiftsOf();
    const fl = flags();
    const emps = state.employees.filter(e => e.active && matches(e.name, ui.search)).sort(H.byName);
    const days = t('daysShort');
    const chip = s => `<button class="chip ${s.station} ${fl.get(s.id) || ''} ${s.empId ? '' : 'open'}" data-action="edit-shift" data-id="${s.id}">
      ${fmtRange(s.start, s.end)}${s.regular ? ' ↻' : ''}</button>`;
    const head = `<tr><th class="name">${t('team')}</th>
      ${days.map((d, i) => `<th>${d} ${H.parseIso(H.addDays(ui.week, i)).getDate()}</th>`).join('')}</tr>`;
    // Worst shortage per station per day, for the section headers.
    const missing = {};
    for (const g of ui.issues.gaps) {
      const k = g.station + gapDayOf(g);
      missing[k] = Math.max(missing[k] || 0, g.missing);
    }
    let body = '';
    // One section per station; someone trained on both appears in both,
    // and each section only shows that station's shifts.
    for (const st of H.STATIONS) {
      const other = H.STATIONS.find(x => x !== st);
      const people = emps.filter(e => e.stations.includes(st) || shifts.some(s => s.empId === e.id && s.station === st));
      body += `<tr class="sec ${st}"><th class="name">${t(st)} <small>(${people.length})</small></th>
        ${days.map((_, i) => {
          const m = missing[st + i];
          return `<td>${m ? `<span class="sec-bad">${t('missingN', { n: m })}</span>` : '<span class="sec-ok">✓</span>'}</td>`;
        }).join('')}</tr>`;
      const open = shifts.filter(s => !s.empId && s.station === st);
      if (open.length) {
        body += `<tr class="open-row"><th class="name">${t('openShifts')}</th>
          ${days.map((_, i) => `<td>${open.filter(s => s.day === i).map(chip).join('')}</td>`).join('')}</tr>`;
      }
      for (const e of people) {
        const h = H.weekHours(shifts, e.id);
        body += `<tr><th class="name"><button class="link" data-action="edit-emp" data-id="${e.id}" title="${esc(e.name)}">${esc(shortName(e.id))}</button>${hoursInfo(e, h)}</th>
          ${days.map((_, i) => {
            const iso = H.addDays(ui.week, i);
            const off = e.timeOff.some(o => o.from <= iso && iso <= o.to);
            const na = !e.availability[i].length;
            const mine = shifts.filter(s => s.empId === e.id && s.day === i && s.station === st);
            const elsewhere = shifts.some(s => s.empId === e.id && s.day === i && s.station === other);
            return `<td class="cell ${off ? 'off' : na ? 'na' : ''}" data-action="add-shift" data-emp="${e.id}" data-day="${i}" data-station="${st}">
              ${off ? `<span class="tag">${t('timeOffShort')}</span>` : ''}
              ${mine.map(chip).join('')}
              ${elsewhere ? `<span class="tag other">${t(other)}</span>` : !mine.length && !off && !na ? '<span class="plus" aria-hidden="true">+</span>' : ''}</td>`;
          }).join('')}</tr>`;
      }
      if (!people.length) body += `<tr><td colspan="8" class="muted pad">${ui.search ? t('noMatch') : t('nobody')}</td></tr>`;
    }
    return `<div class="wk-wrap"><table class="wk"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function updateBoard() {
    const b = $('#board');
    if (!b) return;
    const prevLeft = ($('.gantt') || {}).scrollLeft;
    b.innerHTML = board();
    placeTimeline(prevLeft);
  }

  function showSuggest() {
    const box = $('#suggest');
    if (!box) return;
    const q = ui.search.trim();
    const list = q ? state.employees.filter(e => matches(e.name, q)).sort(H.byName).slice(0, 8) : [];
    if (!list.length || (list.length === 1 && norm(list[0].name) === norm(q))) { box.hidden = true; return; }
    box.innerHTML = list.map(e => `<li><button type="button" data-action="suggest-pick" data-name="${esc(e.name)}">${highlight(e.name, q)}</button></li>`).join('');
    box.hidden = false;
  }

  function highlight(name, q) {
    const chars = [...name];
    const folded = chars.map(fold);
    const i = folded.join('').indexOf(norm(q));
    if (i < 0 || folded.some(f => f.length !== 1)) return esc(name);
    const len = norm(q).length;
    return esc(chars.slice(0, i).join('')) + '<b>' + esc(chars.slice(i, i + len).join('')) + '</b>' + esc(chars.slice(i + len).join(''));
  }

  // ---------- shift editor ----------
  function openShiftEditor({ id, empId, day, start, end, station }) {
    const existing = id && shiftsOf().find(s => s.id === id);
    const sh = existing ? { ...existing } : {
      id: H.uid(), empId: empId || null, day: day ?? ui.day,
      start: start ?? 6 * 60, end: end ?? 14 * 60, station: station || 'kitchen',
    };
    if (!existing && empId && !station) {
      const e = H.findEmp(state, empId);
      if (e && e.stations.length) sh.station = e.stations[0];
    }
    const emps = state.employees.filter(e => e.active).sort(H.byName);
    openSheet(`
      <form class="form" id="shift-form" data-id="${sh.id}">
        <h2>${existing ? t('editShift') : t('newShift')}</h2>
        <label class="field">${t('person')}
          <select name="empId"><option value="">${t('openShiftOption')}</option>
          ${emps.map(e => `<option value="${e.id}" ${e.id === sh.empId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
        <label class="field">${t('dayLabel')}
          <select name="day">${t('days').map((d, i) => `<option value="${i}" ${i === sh.day ? 'selected' : ''}>${d} ${fmtDate(H.addDays(ui.week, i))}</option>`).join('')}</select></label>
        <div class="tpls">${state.settings.templates.map(tp => `<button type="button" class="chip-btn" data-action="tpl" data-s="${tp.start}" data-e="${tp.end}">
          ${esc(tp.label || fmtRange(tp.start, tp.end))}</button>`).join('')}</div>
        <div class="row2">
          <label class="field">${t('start')}<input type="time" name="start" value="${H.toHHMM(sh.start)}" step="900" required></label>
          <label class="field">${t('end')}<input type="time" name="end" value="${H.toHHMM(sh.end)}" step="900" required></label>
        </div>
        <fieldset class="field"><legend>${t('station')}</legend><div class="seg radios">
          ${H.STATIONS.map(st => `<label><input type="radio" name="station" value="${st}" ${sh.station === st ? 'checked' : ''}><span>${t(st)}</span></label>`).join('')}
        </div></fieldset>
        <div id="shift-msg" class="msg">${shiftMessages(sh)}</div>
        <div class="stack">
          <button type="submit" class="btn primary" id="shift-save">${t('save')}</button>
          ${existing ? `<button type="button" class="btn" data-action="replace" data-id="${sh.id}">${existing.empId ? t('replaceSomeone') : t('findSomeone')}</button>` : ''}
        </div>
        <div class="btns">
          ${existing ? `<button type="button" class="link danger" data-action="delete-shift" data-id="${sh.id}">${t('deleteShift')}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="link" data-action="close">${t('cancel')}</button>
        </div>
      </form>`);
  }

  function readShiftForm(form) {
    const f = form.elements;
    const old = shiftsOf().find(s => s.id === form.dataset.id) || {};
    return {
      ...old,
      id: form.dataset.id,
      empId: f.empId.value || null,
      day: +f.day.value,
      ...H.span(f.start.value || '00:00', f.end.value || '00:00'),
      station: (form.querySelector('input[name=station]:checked') || {}).value || 'kitchen',
    };
  }

  function shiftMessages(sh) {
    if (!sh.empId) return `<p class="hint">${t('openShiftHint')}</p>`;
    const res = H.check(state, ui.week, sh);
    const emp = H.findEmp(state, sh.empId);
    const total = H.weekHours(shiftsOf().filter(s => s.id !== sh.id), sh.empId) + H.hours(sh);
    return res.blocks.map(b => `<p class="err">${reason(b)}</p>`).join('')
      + res.warns.map(w => `<p class="warn">${reason(w)}</p>`).join('')
      + (res.blocks.length ? '' : `<p class="ok">${t('okHours', { h: fmtH(total), max: emp.maxHours })}</p>`);
  }

  function refreshShiftForm() {
    const form = $('#shift-form');
    if (!form) return;
    form.dataset.confirm = '';
    const btn = $('#shift-save');
    btn.textContent = t('save');
    btn.className = 'btn primary';
    $('#shift-msg').innerHTML = shiftMessages(readShiftForm(form));
  }

  function submitShift(form) {
    const sh = readShiftForm(form);
    const res = sh.empId ? H.check(state, ui.week, sh) : { blocks: [] };
    if (res.blocks.length && form.dataset.confirm !== '1') {
      form.dataset.confirm = '1';
      const btn = $('#shift-save');
      btn.textContent = t('assignAnyway');
      btn.className = 'btn danger';
      $('#shift-msg').insertAdjacentHTML('beforeend', `<p class="err strong">${t('overrideHint')}</p>`);
      return;
    }
    if (res.blocks.length) sh.forced = true; else delete sh.forced;
    remember();
    upsertShift(sh);
    closeSheet();
    ui.day = sh.day;
    render();
    toast(res.blocks.length ? t('savedForced') : t('saved'), true);
  }

  // ---------- replace ----------
  function openReplace(id) {
    const sh = shiftsOf().find(s => s.id === id);
    if (!sh) return;
    const list = H.replacements(state, ui.week, id);
    const yes = list.filter(r => !r.blocks.length), no = list.filter(r => r.blocks.length);
    openSheet(`<div class="form">
      <h2>${sh.empId ? t('replaceTitle') : t('findSomeone')}</h2>
      <p class="muted">${t('days')[sh.day]} · ${fmtRange(sh.start, sh.end)} · ${t(sh.station)}${sh.empId ? ' · ' + esc(empName(sh.empId)) : ''}</p>
      ${yes.length ? `<p class="hint">${t('replaceHint')}</p><ul class="pick">${yes.map(r => `<li>
          <button class="pick-btn" data-action="assign" data-id="${id}" data-emp="${r.emp.id}">
            <b>${esc(r.emp.name)}</b><span>${t('hoursThisWeek', { h: fmtH(r.hours), max: r.emp.maxHours })}</span>
            ${r.warns.map(w => `<small class="warn">${reason(w)}</small>`).join('')}
          </button></li>`).join('')}</ul>`
        : `<p class="err">${t('noReplacement')}</p>`}
      ${no.length ? `<details><summary>${t('notEligible', { n: no.length })}</summary><ul class="plain">
        ${no.map(r => `<li><b>${esc(r.emp.name)}</b> — ${r.blocks.map(reason).join(' · ')}</li>`).join('')}</ul></details>` : ''}
      ${sh.empId ? `<div class="leave-open"><p class="hint">${t('leaveOpenHint')}</p>
        <button class="btn" data-action="make-open" data-id="${id}">${t('leaveOpen')}</button></div>` : ''}
      <div class="btns"><span class="spacer"></span><button class="btn" data-action="close">${t('close')}</button></div>
    </div>`);
  }

  function assign(id, empId) {
    const sh = shiftsOf().find(s => s.id === id);
    if (!sh) return;
    remember();
    upsertShift({ ...sh, empId, forced: undefined });
    closeSheet();
    render();
    toast(t('assignedTo', { name: empName(empId) }), true);
  }

  // ---------- issues ----------
  function openIssues() {
    const is = H.weekIssues(state, ui.week);
    const when = sh => `${t('daysShort')[sh.day]} ${fmtRange(sh.start, sh.end)} · ${t(sh.station)}`;
    const of = k => is.items.filter(i => i.kind === k);
    const sec = (title, inner) => inner ? `<h3>${title}</h3><ul class="issues">${inner}</ul>` : '';
    const gapDay = g => Math.min(6, Math.floor(g.start / H.DAY));
    const html =
      sec(t('conflicts'), of('block').map(i => `<li class="err-li"><b>${esc(empName(i.shift.empId))}</b> · ${when(i.shift)}
        <div>${i.list.map(reason).join(' · ')}</div>
        <div class="btns"><button class="btn small" data-action="replace" data-id="${i.shift.id}">${t('replace')}</button>
        <button class="btn small" data-action="edit-shift" data-id="${i.shift.id}">${t('edit')}</button></div></li>`).join(''))
      + sec(t('gaps'), is.gaps.map(g => `<li class="err-li">${t('gapLine', {
          day: t('daysShort')[gapDay(g)], range: fmtRange(g.start, g.end), station: t(g.station), n: g.missing })}
        <div class="btns"><button class="btn small" data-action="gap-fill" data-start="${g.start}" data-end="${g.end}" data-station="${g.station}">${t('findSomeone')}</button>
        <button class="btn small" data-action="goto-day" data-d="${gapDay(g)}" data-st="${g.station}" data-min="${g.start - gapDay(g) * H.DAY}">${t('seeDay')}</button></div></li>`).join(''))
      + sec(t('openShifts'), of('open').map(i => `<li>${when(i.shift)}
        <div class="btns"><button class="btn small" data-action="replace" data-id="${i.shift.id}">${t('findSomeone')}</button></div></li>`).join(''))
      + sec(t('forcedShifts'), of('forced').map(i => `<li><b>${esc(empName(i.shift.empId))}</b> · ${when(i.shift)}<div class="muted">${i.list.map(reason).join(' · ')}</div></li>`).join(''))
      + sec(t('warnings'), of('warn').map(i => `<li><b>${esc(empName(i.shift.empId))}</b> · ${when(i.shift)}<div class="warn">${i.list.map(reason).join(' · ')}</div></li>`).join(''));
    openSheet(`<div class="form"><h2>${t('issuesTitle')}</h2>${html || `<p class="ok">${t('allGood')}</p>`}
      <div class="btns"><span class="spacer"></span><button class="btn" data-action="close">${t('close')}</button></div></div>`);
  }

  function fillGap(el) {
    const start = +el.dataset.start, end = +el.dataset.end;
    const day = Math.min(6, Math.floor(start / H.DAY));
    const s = start - day * H.DAY;
    const sh = { id: H.uid(), empId: null, day, start: s, end: Math.min(end - day * H.DAY, s + state.settings.maxShift * 60), station: el.dataset.station };
    remember();
    upsertShift(sh);
    render();
    openReplace(sh.id);
  }

  // ---------- generate, copy, clear ----------
  function onGenerate() {
    if (!state.employees.length) return toast(t('needTeam'));
    if (!shiftsOf().length) return runGenerate('keep');
    openSheet(`<div class="form"><h2>${t('generate')}</h2><p>${t('genChoice')}</p>
      <div class="stack">
        <button class="btn primary" data-action="gen-run" data-mode="keep">${t('genKeep')}</button>
        <button class="btn" data-action="gen-run" data-mode="redo">${t('genRedo')}</button>
        <button class="btn" data-action="close">${t('cancel')}</button>
      </div></div>`);
  }

  function runGenerate(mode) {
    remember();
    if (mode === 'redo') state.weeks[ui.week] = { shifts: [] };
    const { shifts, report } = H.generate(state, ui.week);
    setShifts(shifts);
    render();
    const gapDay = g => Math.min(6, Math.floor(g.start / H.DAY));
    openSheet(`<div class="form"><h2>${t('genDone')}</h2>
      <p>${t('genSummary', { added: report.added + report.filledOpen, regulars: report.regulars })}</p>
      ${report.skipped.length ? `<h3>${t('skippedRegulars')}</h3><ul class="issues">${report.skipped.map(s => `<li><b>${esc(empName(s.empId))}</b> ·
        ${t('daysShort')[s.shift.day]} ${fmtRange(s.shift.start, s.shift.end)}<div class="muted">${s.blocks.map(reason).join(' · ')}</div></li>`).join('')}</ul>` : ''}
      ${report.gaps.length ? `<h3>${t('gapsLeft')}</h3><p class="hint">${t('gapsExplain')}</p><ul class="issues">${report.gaps.map(g => `<li class="err-li">${t('gapLine', {
          day: t('daysShort')[gapDay(g)], range: fmtRange(g.start, g.end), station: t(g.station), n: g.missing })}</li>`).join('')}</ul>`
        : `<p class="ok">${t('noGaps')}</p>`}
      <h3>${t('nextSteps')}</h3>
      <div class="stack">
        ${report.gaps.length ? `<button class="btn primary" data-action="issues">${t('seeProblems')}</button>` : ''}
        <button class="btn ${report.gaps.length ? '' : 'primary'}" data-action="share">${t('shareSchedule')}</button>
      </div>
      <div class="btns"><button class="link" data-action="undo">${t('undoGenerate')}</button><span class="spacer"></span>
        <button class="link" data-action="close">${t('close')}</button></div></div>`);
  }

  function openShare() {
    openSheet(`<div class="form"><h2>${t('shareTitle')}</h2><p class="hint">${t('shareHint')}</p><div class="stack">
      <button class="btn primary" data-action="export-image">${t('exportImage')}</button>
      <button class="btn" data-action="print">${t('printPdf')}</button>
      <button class="btn" data-action="close">${t('cancel')}</button></div></div>`);
  }

  function copyLastWeek() {
    closeSheet();
    const prev = H.addDays(ui.week, -7);
    if (!shiftsOf(prev).length) return toast(t('prevEmpty'));
    if (shiftsOf().length && !confirm(t('copyReplaceConfirm'))) return;
    remember();
    const { shifts, dropped } = H.copyWeek(state, prev, ui.week);
    setShifts(shifts);
    render();
    if (!dropped.length) return toast(t('copied', { n: shifts.length }), true);
    openSheet(`<div class="form"><h2>${t('copied', { n: shifts.length })}</h2><p>${t('droppedExplain')}</p>
      <ul class="issues">${dropped.map(d => `<li><b>${esc(empName(d.shift.empId))}</b> · ${t('daysShort')[d.shift.day]} ${fmtRange(d.shift.start, d.shift.end)}
        <div class="muted">${d.blocks.map(reason).join(' · ')}</div></li>`).join('')}</ul>
      <div class="btns"><button class="btn" data-action="undo">${t('undo')}</button><span class="spacer"></span><button class="btn primary" data-action="close">${t('ok')}</button></div></div>`);
  }

  function clearWeek() {
    closeSheet();
    if (!shiftsOf().length || !confirm(t('clearConfirm'))) return;
    remember();
    setShifts([]);
    render();
    toast(t('cleared'), true);
  }

  // ---------- export ----------
  function exportRows() {
    const shifts = shiftsOf();
    const emps = state.employees.filter(e => shifts.some(s => s.empId === e.id)).sort(H.byName);
    const rows = emps.map(e => ({ name: e.name, list: shifts.filter(s => s.empId === e.id), total: fmtH(H.weekHours(shifts, e.id)) }));
    const open = shifts.filter(s => !s.empId);
    if (open.length) rows.unshift({ name: t('openShifts'), list: open, total: '' });
    return rows;
  }
  const cellText = list => list.sort((a, b) => a.start - b.start).map(s => fmtRange(s.start, s.end) + ' ' + t(s.station + 'Short')).join(' + ');

  async function exportImage() {
    closeSheet();
    const rows = exportRows();
    if (!rows.length) return toast(t('nothingToExport'));
    const NAME = 200, COL = 128, TOT = 70, ROW = 30, TOP = 86, S = 2;
    const W = NAME + 7 * COL + TOT, Ht = TOP + ROW * (rows.length + 1) + 16;
    const c = document.createElement('canvas');
    c.width = W * S; c.height = Ht * S;
    const g = c.getContext('2d');
    g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, Ht);
    g.fillStyle = '#111'; g.font = '600 20px system-ui, sans-serif';
    g.fillText(t('scheduleTitle', { range: weekLabel() }), 14, 34);
    g.fillStyle = '#555'; g.font = '13px system-ui, sans-serif';
    g.fillText(t('exportLegend'), 14, 60);
    const text = (s, x, y, w, color = '#111', font = '13px system-ui, sans-serif') => {
      g.save(); g.beginPath(); g.rect(x, y - 16, w - 8, 22); g.clip();
      g.fillStyle = color; g.font = font; g.fillText(s, x, y); g.restore();
    };
    let y = TOP;
    g.fillStyle = '#eef0f3'; g.fillRect(0, y, W, ROW);
    text(t('team'), 10, y + 20, NAME, '#111', '600 13px system-ui, sans-serif');
    t('daysShort').forEach((d, i) => text(`${d} ${H.parseIso(H.addDays(ui.week, i)).getDate()}`, NAME + i * COL + 8, y + 20, COL, '#111', '600 13px system-ui, sans-serif'));
    text(t('total'), NAME + 7 * COL + 8, y + 20, TOT, '#111', '600 13px system-ui, sans-serif');
    rows.forEach((r, k) => {
      y += ROW;
      if (k % 2) { g.fillStyle = '#f7f8fa'; g.fillRect(0, y, W, ROW); }
      text(r.name, 10, y + 20, NAME);
      for (let i = 0; i < 7; i++) {
        const list = r.list.filter(s => s.day === i);
        if (!list.length) continue;
        const color = list.every(s => s.station === 'kitchen') ? '#a3480b' : list.every(s => s.station === 'front') ? '#1d4fa3' : '#111';
        text(cellText(list), NAME + i * COL + 8, y + 20, COL, color);
      }
      text(r.total, NAME + 7 * COL + 8, y + 20, TOT);
    });
    g.strokeStyle = '#d5d9df'; g.lineWidth = 1;
    for (let i = 0; i <= 7; i++) { const x = NAME + i * COL + 0.5; g.beginPath(); g.moveTo(x, TOP); g.lineTo(x, y + ROW); g.stroke(); }
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    await shareOrDownload(blob, `horaire-${ui.week}.png`);
  }

  function printWeek() {
    closeSheet();
    const rows = exportRows();
    if (!rows.length) return toast(t('nothingToExport'));
    const days = t('daysShort');
    $('#print-root').innerHTML = `<h1>${t('scheduleTitle', { range: weekLabel() })}</h1><p>${t('exportLegend')}</p>
      <table><thead><tr><th>${t('team')}</th>${days.map((d, i) => `<th>${d} ${H.parseIso(H.addDays(ui.week, i)).getDate()}</th>`).join('')}<th>${t('total')}</th></tr></thead>
      <tbody>${rows.map(r => `<tr><th>${esc(r.name)}</th>${days.map((_, i) => `<td>${esc(cellText(r.list.filter(s => s.day === i)))}</td>`).join('')}<td>${r.total}</td></tr>`).join('')}</tbody></table>`;
    setTimeout(() => window.print(), 50);
  }

  async function shareOrDownload(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; } catch (err) { if (err.name === 'AbortError') return false; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return true;
  }

  // ---------- team tab ----------
  function teamTab() {
    return `<p class="hint pad">${t('teamIntro')}</p>
      <div class="toolbar">
        <div class="search"><input id="team-search" type="search" placeholder="${t('searchName')}" aria-label="${t('searchName')}"
          value="${esc(ui.teamSearch)}" autocomplete="off" autocorrect="off"></div>
        <button class="btn primary" data-action="add-emp">${t('addPerson')}</button>
      </div>
      <ul id="emp-list" class="emp-list">${empList()}</ul>`;
  }

  function empList() {
    const today = H.isoOf(new Date()), soon = H.addDays(today, 30);
    const list = state.employees.filter(e => matches(e.name, ui.teamSearch)).sort(H.byName);
    if (!list.length) return `<li class="muted pad">${state.employees.length ? t('noMatch') : t('noTeamYet')}</li>`;
    return list.map(e => {
      const off = e.timeOff.find(o => o.to >= today && o.from <= soon);
      return `<li><button class="emp ${e.active ? '' : 'inactive'}" data-action="edit-emp" data-id="${e.id}">
        <b>${esc(e.name)}</b>
        <span class="badges">${e.stations.map(s => `<i class="badge ${s}">${t(s)}</i>`).join('')}
          ${e.minor ? `<i class="badge minor">${t('minor')}</i>` : ''}
          ${e.regulars.length ? `<i class="badge reg">↻ ${t('regularShort')}</i>` : ''}
          ${off ? `<i class="badge off">${t('offBadge', { from: fmtDate(off.from), to: fmtDate(off.to) })}</i>` : ''}</span>
        <small>${t('maxH', { h: e.maxHours })}${e.active ? '' : ' · ' + t('inactive')}</small>
      </button></li>`;
    }).join('') + `<li class="muted pad">${t('teamCount', { n: state.employees.length })}</li>`;
  }

  const timeIn = (cls, min) => `<input type="time" class="${cls}" value="${H.toHHMM(min)}" step="900" aria-label="${cls === 'r-s' ? t('start') : t('end')}">`;
  const delBtn = () => `<button type="button" class="icon-btn" data-action="row-del" aria-label="${t('remove')}">×</button>`;
  const rangeRow = r => `<div class="range">${timeIn('r-s', r.start)}<span>–</span>${timeIn('r-e', r.end)}${delBtn()}</div>`;
  const stationSelect = v => `<select class="r-st" aria-label="${t('station')}">${H.STATIONS.map(st => `<option value="${st}" ${st === v ? 'selected' : ''}>${t(st)}</option>`).join('')}</select>`;
  const regRow = r => `<div class="reg">
      <div class="daypick">${t('daysShort').map((d, i) => `<label><input type="checkbox" value="${i}" ${r.days.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      <div class="range">${timeIn('r-s', r.start)}<span>–</span>${timeIn('r-e', r.end)}${stationSelect(r.station)}${delBtn()}</div>
    </div>`;
  const offRow = o => `<div class="range off-row">
      <input type="date" class="o-f" value="${o.from}" aria-label="${t('from')}"><span>→</span>
      <input type="date" class="o-t" value="${o.to}" aria-label="${t('to')}">
      <input type="text" class="o-n" value="${esc(o.note)}" placeholder="${t('note')}">${delBtn()}</div>`;

  function openEmpEditor(id) {
    // A new person starts available all day; the manager only marks the exceptions.
    const e = id ? H.findEmp(state, id) : H.normEmp({ name: '', stations: [], availability: Array(7).fill([{ start: 0, end: H.DAY }]) });
    const avRows = t('days').map((d, i) => {
      const r = e.availability[i];
      const mode = !r.length ? 'none' : (r.length === 1 && r[0].start === 0 && r[0].end >= H.DAY) ? 'all' : 'custom';
      return `<div class="av-day" data-day="${i}">
        <div class="av-head"><b>${d}</b><select class="av-mode" aria-label="${d}">
          ${['all', 'custom', 'none'].map(m => `<option value="${m}" ${m === mode ? 'selected' : ''}>${t('av_' + m)}</option>`).join('')}</select></div>
        <div class="av-ranges" ${mode === 'custom' ? '' : 'hidden'}>
          ${(mode === 'custom' ? r : [{ start: 6 * 60, end: 14 * 60 }]).map(rangeRow).join('')}
          <button type="button" class="link" data-action="av-add">${t('addRange')}</button></div>
      </div>`;
    }).join('');
    openSheet(`<form class="form" id="emp-form" data-id="${id || ''}">
      <h2>${id ? esc(e.name) : t('newPerson')}</h2>
      <label class="field">${t('name')}<input name="name" value="${esc(e.name)}" autocomplete="off" autocapitalize="words" required></label>
      <fieldset class="field"><legend>${t('stations')}</legend><div class="checks">
        ${H.STATIONS.map(st => `<label class="check"><input type="checkbox" name="st" value="${st}" ${e.stations.includes(st) ? 'checked' : ''}><span>${t(st)}</span></label>`).join('')}
      </div></fieldset>
      <div class="row2">
        <label class="field">${t('maxHours')}<input name="maxHours" type="number" inputmode="numeric" min="0" max="80" value="${e.maxHours}"></label>
        <label class="field">${t('minHours')}<input name="minHours" type="number" inputmode="numeric" min="0" max="80" value="${e.minHours}"></label>
      </div>
      <label class="check"><input type="checkbox" name="minor" ${e.minor ? 'checked' : ''}><span>${t('minorLabel')}</span></label>
      <p class="hint">${t('minorHint')}</p>

      <h3>${t('availability')}</h3><p class="hint">${t('availHint')}</p>
      <div class="av">${avRows}</div>
      <button type="button" class="link" data-action="av-copy-mon">${t('copyMonday')}</button>

      <h3>${t('regulars')}</h3><p class="hint">${t('regularsHint')}</p>
      <div id="reg-list">${e.regulars.map(regRow).join('')}</div>
      <button type="button" class="link" data-action="reg-add">${t('addRegular')}</button>

      <h3>${t('timeOff')}</h3><p class="hint">${t('timeOffHint')}</p>
      <div id="off-list">${e.timeOff.map(offRow).join('')}</div>
      <button type="button" class="link" data-action="off-add">${t('addTimeOff')}</button>

      <h3>${t('statusTitle')}</h3>
      <label class="check"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}><span>${t('activeLabel')}</span></label>
      <div id="emp-msg" class="msg"></div>
      <div class="btns sticky">
        ${id ? `<button type="button" class="btn danger" data-action="delete-emp" data-id="${id}">${t('delete')}</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="close">${t('cancel')}</button>
        <button class="btn primary" type="submit">${t('save')}</button>
      </div>
    </form>`);
  }

  function submitEmp(form) {
    const f = form.elements;
    const name = f.name.value.trim();
    const stations = $$('input[name=st]:checked', form).map(i => i.value);
    const errors = [];
    if (!name) errors.push(t('errName'));
    if (!stations.length) errors.push(t('errStation'));
    const times = row => {
      const s = $('.r-s', row).value, e = $('.r-e', row).value;
      return s && e && s !== e ? H.span(s, e) : null;
    };
    const availability = $$('.av-day', form).map(div => {
      const mode = $('.av-mode', div).value;
      if (mode === 'none') return [];
      if (mode === 'all') return [{ start: 0, end: H.DAY }];
      return $$('.range', div).map(times).filter(Boolean);
    });
    const regulars = $$('.reg', form).map(div => {
      const tm = times($('.range', div));
      const days = $$('.daypick input:checked', div).map(i => +i.value);
      return tm && days.length ? { id: H.uid(), days, ...tm, station: $('.r-st', div).value } : null;
    }).filter(Boolean);
    if (regulars.some(r => !stations.includes(r.station))) errors.push(t('errRegStation'));
    const timeOff = $$('.off-row', form).map(div => {
      let from = $('.o-f', div).value, to = $('.o-t', div).value || from;
      if (!from) return null;
      if (to < from) [from, to] = [to, from];
      return { id: H.uid(), from, to, note: $('.o-n', div).value.trim() };
    }).filter(Boolean);
    if (errors.length) {
      $('#emp-msg').innerHTML = errors.map(x => `<p class="err">${esc(x)}</p>`).join('');
      $('#emp-msg').scrollIntoView({ block: 'center' });
      return;
    }
    const id = form.dataset.id;
    const emp = H.normEmp({
      id: id || H.uid(), name, stations, availability, regulars, timeOff,
      maxHours: Math.max(0, +f.maxHours.value || 0), minHours: Math.max(0, +f.minHours.value || 0),
      minor: f.minor.checked, active: f.active.checked,
    });
    state.employees = id ? state.employees.map(e => (e.id === id ? emp : e)) : [...state.employees, emp];
    save();
    closeSheet();
    render();
    toast(t('saved'));
  }

  function deleteEmp(id) {
    const e = H.findEmp(state, id);
    if (!e || !confirm(t('deleteEmpConfirm', { name: e.name }))) return;
    const thisWeek = H.mondayOf(new Date());
    for (const [key, w] of Object.entries(state.weeks)) {
      w.shifts = key >= thisWeek
        ? w.shifts.map(s => (s.empId === id ? { ...s, empId: null, forced: undefined } : s))
        : w.shifts.filter(s => s.empId !== id);
    }
    state.employees = state.employees.filter(x => x.id !== id);
    save();
    closeSheet();
    render();
    toast(t('deletedEmp', { name: e.name }));
  }

  // ---------- needs tab ----------
  function needsTab() {
    return `<p class="hint pad">${t('needsHint')}</p>` + t('days').map((d, i) => `
      <section class="card" data-day="${i}">
        <div class="card-head"><h3>${d}</h3><button class="link" data-action="need-copy" data-day="${i}">${t('copyToAll')}</button></div>
        <div class="need-grid need-head"><span>${t('from')}</span><span>${t('to')}</span><span>${t('kitchen')}</span><span>${t('front')}</span><span></span></div>
        ${state.staffing[i].map((b, j) => `<div class="need-grid need-row" data-day="${i}" data-j="${j}">
          <input type="time" data-f="start" value="${H.toHHMM(b.start)}" step="1800" aria-label="${t('from')}">
          <input type="time" data-f="end" value="${H.toHHMM(b.end)}" step="1800" aria-label="${t('to')}">
          <input type="number" inputmode="numeric" min="0" max="30" data-f="kitchen" value="${b.kitchen}" aria-label="${t('kitchen')}">
          <input type="number" inputmode="numeric" min="0" max="30" data-f="front" value="${b.front}" aria-label="${t('front')}">
          <button class="icon-btn" data-action="need-del" data-day="${i}" data-j="${j}" aria-label="${t('remove')}">×</button></div>`).join('')}
        <button class="link" data-action="need-add" data-day="${i}">${t('addBlock')}</button>
      </section>`).join('');
  }

  function updateNeed(el) {
    const row = el.closest('.need-row');
    const b = state.staffing[+row.dataset.day][+row.dataset.j];
    if (el.dataset.f === 'start' || el.dataset.f === 'end') {
      const s = $('[data-f=start]', row).value, e = $('[data-f=end]', row).value;
      if (s && e && s !== e) Object.assign(b, H.span(s, e));
    } else {
      b[el.dataset.f] = Math.max(0, Math.round(+el.value || 0));
    }
    save();
  }

  // ---------- settings tab ----------
  function settingsTab() {
    const s = state.settings;
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return `
      <section class="card"><h3>${t('language')}</h3><div class="seg">
        ${['fr', 'en'].map(l => `<button data-action="lang" data-lang="${l}" aria-pressed="${s.lang === l}">${l === 'fr' ? 'Français' : 'English'}</button>`).join('')}
      </div></section>
      <section class="card"><h3>${t('templates')}</h3><p class="hint">${t('templatesHint')}</p>
        ${s.templates.map((tp, j) => `<div class="range tpl-row" data-j="${j}">
          <input type="text" data-f="label" value="${esc(tp.label)}" placeholder="${t('labelOptional')}" aria-label="${t('labelOptional')}">
          <input type="time" data-f="start" value="${H.toHHMM(tp.start)}" step="900" aria-label="${t('start')}">
          <input type="time" data-f="end" value="${H.toHHMM(tp.end)}" step="900" aria-label="${t('end')}">
          <button class="icon-btn" data-action="tpl-del" data-j="${j}" aria-label="${t('remove')}">×</button></div>`).join('')}
        <button class="link" data-action="tpl-add">${t('addTemplate')}</button>
        <div class="row2">
          <label class="field">${t('minShift')}<input type="number" inputmode="numeric" data-setting="minShift" value="${s.minShift}" min="1" max="12"></label>
          <label class="field">${t('maxShift')}<input type="number" inputmode="numeric" data-setting="maxShift" value="${s.maxShift}" min="1" max="16"></label>
        </div>
      </section>
      <section class="card"><h3>${t('minorsTitle')}</h3>
        <label class="check"><input type="checkbox" data-setting="schoolPeriod" ${s.schoolPeriod ? 'checked' : ''}><span>${t('schoolPeriod')}</span></label>
        <p class="hint">${t('minorRules')}</p>
      </section>
      <section class="card"><h3>${t('backup')}</h3><p class="hint">${t('backupHint')}</p>
        <p>${t('lastBackup')} <b>${state.meta.lastBackup ? fmtDate(state.meta.lastBackup.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) : t('never')}</b></p>
        <div class="btns"><button class="btn primary" data-action="backup">${t('backupNow')}</button>
          <label class="btn">${t('restore')}<input type="file" id="restore-file" accept=".json,application/json" hidden></label></div>
      </section>
      ${installed ? '' : `<section class="card"><h3>${t('installTitle')}</h3><p class="hint">${t('installHint')}</p></section>`}
      <section class="card"><h3>${t('demoTitle')}</h3><p class="hint">${t('demoHint')}</p>
        <div class="btns"><button class="btn" data-action="demo">${t('loadDemo')}</button>
          <button class="btn danger" data-action="wipe">${t('wipe')}</button></div>
      </section>
      <section class="card"><h3>${t('privacyTitle')}</h3><p class="hint">${t('privacyHint')}</p></section>`;
  }

  function updateTpl(el) {
    const row = el.closest('.tpl-row');
    const tp = state.settings.templates[+row.dataset.j];
    if (el.dataset.f === 'label') tp.label = el.value.trim();
    else {
      const s = $('[data-f=start]', row).value, e = $('[data-f=end]', row).value;
      if (s && e && s !== e) Object.assign(tp, H.span(s, e));
    }
    save();
  }

  function updateSetting(el) {
    const k = el.dataset.setting;
    state.settings[k] = el.type === 'checkbox' ? el.checked : Math.max(1, +el.value || 1);
    save();
  }

  async function backup() {
    const name = `horaire-sauvegarde-${H.isoOf(new Date())}.json`;
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    if (!(await shareOrDownload(blob, name))) return;
    state.meta.lastBackup = new Date().toISOString();
    save();
    render();
    toast(t('backupDone'));
  }

  async function restore(file) {
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || !Array.isArray(raw.employees)) throw new Error('shape');
      if (!confirm(t('restoreConfirm', { n: raw.employees.length }))) return;
      state = H.migrate(raw);
      save();
      render();
      toast(t('restored'));
    } catch {
      toast(t('restoreFailed'));
    }
  }

  function loadDemo() {
    if (state.employees.length && !confirm(t('demoConfirm'))) return;
    state.employees = H.demoTeam();
    state.weeks = {};
    save();
    ui.tab = 'schedule';
    render();
    toast(t('demoLoaded'));
  }

  function wipe() {
    if (!confirm(t('wipeConfirm'))) return;
    const lang = state.settings.lang;
    state = H.defaultState();
    state.settings.lang = lang;
    save();
    render();
  }

  // ---------- sheet & toast ----------
  const sheet = $('#sheet');
  function openSheet(html) {
    $('#sheet-body').innerHTML = html;
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }
  function closeSheet() { if (sheet.open) sheet.close(); }
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

  let toastTimer;
  function toast(msg, withUndo) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>${withUndo && ui.undo ? `<button data-action="undo">${t('undo')}</button>` : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, withUndo ? 7000 : 3000);
  }

  // ---------- events ----------
  const actions = {
    tab: el => { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    week: el => { ui.week = H.addDays(ui.week, +el.dataset.d); render(); },
    'week-today': () => { ui.week = H.mondayOf(new Date()); ui.day = (new Date().getDay() + 6) % 7; render(); },
    view: el => { ui.view = el.dataset.v; render(); },
    day: el => { ui.day = +el.dataset.d; render(); },
    generate: onGenerate,
    'gen-run': el => { closeSheet(); runGenerate(el.dataset.mode); },
    'add-shift': el => openShiftEditor({
      empId: el.dataset.emp, day: el.dataset.day != null ? +el.dataset.day : ui.day, station: el.dataset.station,
    }),
    'edit-shift': el => openShiftEditor({ id: el.dataset.id }),
    tpl: el => {
      const f = $('#shift-form').elements;
      f.start.value = H.toHHMM(+el.dataset.s);
      f.end.value = H.toHHMM(+el.dataset.e);
      refreshShiftForm();
    },
    'delete-shift': el => {
      remember();
      setShifts(shiftsOf().filter(s => s.id !== el.dataset.id));
      closeSheet(); render(); toast(t('deleted'), true);
    },
    'make-open': el => {
      const sh = shiftsOf().find(s => s.id === el.dataset.id);
      remember();
      upsertShift({ ...sh, empId: null, forced: undefined });
      closeSheet();
      render();
      toast(t('leftOpen'), true);
    },
    replace: el => openReplace(el.dataset.id),
    assign: el => assign(el.dataset.id, el.dataset.emp),
    issues: openIssues,
    'gap-fill': fillGap,
    'goto-day': el => {
      closeSheet();
      ui.view = 'day';
      ui.day = +el.dataset.d;
      if (el.dataset.st) ui.station = el.dataset.st;
      render();
      if (el.dataset.min) scrollTimeline(+el.dataset.min);
      $('.gantt')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    jump: el => scrollTimeline(+el.dataset.h * 60),
    station: el => { ui.station = el.dataset.st; render(); },
    'search-toggle': () => {
      const open = !(ui.searchOpen || ui.search);
      ui.searchOpen = open;
      if (!open) ui.search = '';
      render();
      if (open) $('#search').focus();
    },
    share: () => { closeSheet(); openShare(); },
    help: openHelp,
    'copy-week': copyLastWeek,
    'clear-week': clearWeek,
    'export-image': exportImage,
    print: printWeek,
    close: closeSheet,
    undo,
    'suggest-pick': el => {
      ui.search = el.dataset.name;
      $('#search').value = ui.search;
      $('#suggest').hidden = true;
      updateBoard();
    },
    'add-emp': () => openEmpEditor(null),
    'edit-emp': el => openEmpEditor(el.dataset.id),
    'delete-emp': el => deleteEmp(el.dataset.id),
    'av-add': el => el.insertAdjacentHTML('beforebegin', rangeRow({ start: 6 * 60, end: 14 * 60 })),
    'row-del': el => (el.closest('.reg') || el.closest('.range')).remove(),
    'av-copy-mon': () => {
      const [mon, ...rest] = $$('#emp-form .av-day');
      const mode = $('.av-mode', mon).value;
      rest.forEach(div => {
        $('.av-mode', div).value = mode;
        $('.av-ranges', div).innerHTML = $('.av-ranges', mon).innerHTML;
        $('.av-ranges', div).hidden = mode !== 'custom';
        // innerHTML does not carry typed-in values, so copy them over
        const src = $$('input', $('.av-ranges', mon)), dst = $$('input', $('.av-ranges', div));
        src.forEach((inp, k) => { dst[k].value = inp.value; });
      });
    },
    'reg-add': () => {
      const st = ($('#emp-form input[name=st]:checked') || {}).value || 'kitchen';
      $('#reg-list').insertAdjacentHTML('beforeend', regRow({ days: [], start: 6 * 60, end: 14 * 60, station: st }));
    },
    'off-add': () => {
      const today = H.isoOf(new Date());
      $('#off-list').insertAdjacentHTML('beforeend', offRow({ from: today, to: today, note: '' }));
    },
    'need-add': el => {
      const list = state.staffing[+el.dataset.day];
      const last = list[list.length - 1];
      list.push({ start: last ? last.end % H.DAY : 6 * 60, end: (last ? last.end % H.DAY : 6 * 60) + 4 * 60, kitchen: 1, front: 1 });
      save(); render();
    },
    'need-del': el => { state.staffing[+el.dataset.day].splice(+el.dataset.j, 1); save(); render(); },
    'need-copy': el => {
      if (!confirm(t('copyToAllConfirm', { day: t('days')[+el.dataset.day] }))) return;
      const src = state.staffing[+el.dataset.day];
      state.staffing = state.staffing.map(() => src.map(b => ({ ...b })));
      save(); render(); toast(t('saved'));
    },
    'tpl-add': () => { state.settings.templates.push({ id: H.uid(), label: '', start: 9 * 60, end: 17 * 60 }); save(); render(); },
    'tpl-del': el => { state.settings.templates.splice(+el.dataset.j, 1); save(); render(); },
    lang: el => { state.settings.lang = el.dataset.lang; save(); render(); },
    backup,
    demo: loadDemo,
    wipe,
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });

  document.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'shift-form') submitShift(e.target);
    else if (e.target.id === 'emp-form') submitEmp(e.target);
  });

  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'search') { ui.search = el.value; updateBoard(); showSuggest(); }
    else if (el.id === 'team-search') { ui.teamSearch = el.value; $('#emp-list').innerHTML = empList(); }
    else if (el.closest('#shift-form')) refreshShiftForm();
  });

  document.addEventListener('change', e => {
    const el = e.target;
    if (el.closest('#shift-form')) {
      if (el.name === 'empId' && el.value) {
        const emp = H.findEmp(state, el.value);
        const radio = emp && emp.stations.length === 1 && $(`#shift-form input[name=station][value=${emp.stations[0]}]`);
        if (radio) radio.checked = true;
      }
      refreshShiftForm();
    } else if (el.classList.contains('av-mode')) {
      $('.av-ranges', el.closest('.av-day')).hidden = el.value !== 'custom';
    } else if (el.closest('.need-row')) updateNeed(el);
    else if (el.closest('.tpl-row')) updateTpl(el);
    else if (el.dataset.setting) updateSetting(el);
    else if (el.id === 'restore-file') restore(el.files[0]);
  });

  document.addEventListener('focusout', e => {
    if (e.target.id === 'search') setTimeout(() => { const b = $('#suggest'); if (b) b.hidden = true; }, 200);
  });
  document.addEventListener('focusin', e => { if (e.target.id === 'search') showSuggest(); });

  render();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
