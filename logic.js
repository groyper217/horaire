/*
 * Horaire — scheduling logic. No DOM code here, so it runs in the browser
 * and in Node (for tests).
 *
 * Time model: a shift belongs to a week (keyed by its Monday, "YYYY-MM-DD")
 * and a day (0 = Monday … 6 = Sunday). start/end are minutes from that day's
 * midnight; end can go past 1440 for shifts that cross midnight (22:00–06:00
 * is start 1320, end 1800).
 */
(function (root) {
  'use strict';

  const DAY = 1440;
  const WEEK = 7 * DAY;
  const SLOT = 30;                       // coverage is counted per half hour
  const SLOTS = (WEEK + DAY) / SLOT;     // the week plus Sunday night spill-over
  const STATIONS = ['kitchen', 'front'];
  const MIN_REST = 8 * 60;               // auto-fill never gives less rest than this
  // Québec rules for workers under 16 (Loi sur les normes du travail / LETE 2023).
  const MINOR = { weekMax: 17, weekdayMax: 10, nightStart: 23 * 60, nightEnd: 6 * 60 };

  // ---------- dates ----------
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function parseIso(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoOf(d); }
  function mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return isoOf(d);
  }

  // ---------- time ----------
  function toMin(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); }
  function toHHMM(min) { min = ((min % DAY) + DAY) % DAY; return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  // "22:00"–"06:00" crosses midnight: end <= start means the next day.
  function span(startHHMM, endHHMM) {
    const start = toMin(startHHMM);
    let end = toMin(endHHMM);
    if (end <= start) end += DAY;
    return { start, end };
  }
  const hours = sh => (sh.end - sh.start) / 60;
  const absOf = sh => [sh.day * DAY + sh.start, sh.day * DAY + sh.end];
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  // ---------- state ----------
  function defaultStaffing() {
    const day = { start: 6 * 60, end: 22 * 60, kitchen: 3, front: 5 };
    const night = { start: 22 * 60, end: 30 * 60, kitchen: 2, front: 3 };
    // Monday and Friday are stock-order days: the order arrives at 17h or later,
    // so +2 kitchen from 17h to 22h.
    const orderDay = [
      { start: 6 * 60, end: 17 * 60, kitchen: 3, front: 5 },
      { start: 17 * 60, end: 22 * 60, kitchen: 5, front: 5 },
      { ...night },
    ];
    return [0, 1, 2, 3, 4, 5, 6].map(d => (d === 0 || d === 4)
      ? orderDay.map(b => ({ ...b }))
      : [{ ...day }, { ...night }]);
  }

  function defaultState() {
    return {
      version: 1,
      settings: {
        lang: 'fr',
        schoolPeriod: true,
        minShift: 4,
        maxShift: 8,
        templates: [
          { id: uid(), label: '', start: 22 * 60, end: 30 * 60 },
          { id: uid(), label: '', start: 6 * 60, end: 14 * 60 },
          { id: uid(), label: '', start: 14 * 60, end: 22 * 60 },
          { id: uid(), label: '', start: 17 * 60, end: 22 * 60 },
        ],
      },
      employees: [],
      staffing: defaultStaffing(),
      weeks: {},
      meta: { lastBackup: null },
    };
  }

  // Fills in anything missing from a saved or imported state.
  function migrate(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const s = { ...base, ...raw };
    s.settings = { ...base.settings, ...(raw.settings || {}) };
    s.meta = { ...base.meta, ...(raw.meta || {}) };
    s.employees = Array.isArray(raw.employees) ? raw.employees.map(normEmp) : [];
    s.staffing = Array.isArray(raw.staffing) && raw.staffing.length === 7 ? raw.staffing : base.staffing;
    s.weeks = raw.weeks && typeof raw.weeks === 'object' ? raw.weeks : {};
    return s;
  }

  function normEmp(e) {
    return {
      id: e.id || uid(),
      name: String(e.name || '').trim(),
      stations: Array.isArray(e.stations) ? e.stations.filter(x => STATIONS.includes(x)) : [],
      maxHours: Number.isFinite(+e.maxHours) ? +e.maxHours : 40,
      minHours: Number.isFinite(+e.minHours) ? +e.minHours : 0,
      minor: !!e.minor,
      active: e.active !== false,
      availability: [0, 1, 2, 3, 4, 5, 6].map(d => (e.availability && e.availability[d]) || []),
      regulars: Array.isArray(e.regulars) ? e.regulars : [],
      timeOff: Array.isArray(e.timeOff) ? e.timeOff : [],
    };
  }

  const findEmp = (state, id) => state.employees.find(e => e.id === id);
  const weekShifts = (state, key) => (state.weeks[key] && state.weeks[key].shifts) || [];
  const weekHours = (shifts, empId) => shifts.filter(s => s.empId === empId).reduce((t, s) => t + hours(s), 0);
  const byName = (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });

  // ---------- availability & time off ----------
  // Availability as merged intervals on a week timeline, repeated one week
  // before and after so Sunday-night → Monday-morning ranges join up.
  function availIntervals(emp) {
    const list = [];
    emp.availability.forEach((ranges, d) => (ranges || []).forEach(r => {
      for (const k of [-1, 0, 1]) list.push([k * WEEK + d * DAY + r.start, k * WEEK + d * DAY + r.end]);
    }));
    list.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of list) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    return merged;
  }

  function timeOffHit(emp, weekKey, sh) {
    const first = addDays(weekKey, sh.day);
    const last = addDays(weekKey, sh.day + Math.floor((sh.end - 1) / DAY));
    return emp.timeOff.find(t => t.from && t.to && t.from <= last && first <= t.to) || null;
  }

  function touchesMinorNight(s, e) {
    for (let k = Math.floor(s / DAY) - 1; k <= Math.floor(e / DAY); k++) {
      const ws = k * DAY + MINOR.nightStart, we = (k + 1) * DAY + MINOR.nightEnd;
      if (s < we && e > ws) return true;
    }
    return false;
  }

  // ---------- the rule check ----------
  // Returns { blocks, warns }. blocks are hard rules (the app refuses unless
  // the manager overrides); warns are shown but allowed.
  // opts.shifts: this week's shifts (defaults to the saved ones)
  // opts.auto:   stricter rules used by the auto-scheduler
  // opts.cache:  Map for availability intervals (speed only)
  function check(state, weekKey, sh, opts = {}) {
    const blocks = [], warns = [];
    const emp = sh.empId && findEmp(state, sh.empId);
    if (!emp) return { blocks, warns };
    const cur = opts.shifts || weekShifts(state, weekKey);
    const [s, e] = absOf(sh);
    const len = hours(sh);

    if (!emp.active) blocks.push({ code: 'inactive' });
    if (!emp.stations.includes(sh.station)) blocks.push({ code: 'station' });
    const off = timeOffHit(emp, weekKey, sh);
    if (off) blocks.push({ code: 'timeoff', from: off.from, to: off.to, note: off.note || '' });
    let iv = opts.cache && opts.cache.get(emp.id);
    if (!iv) { iv = availIntervals(emp); if (opts.cache) opts.cache.set(emp.id, iv); }
    if (!iv.some(([a, b]) => a <= s && e <= b)) blocks.push({ code: 'avail' });

    const others = [];
    const collect = (list, offset) => list.forEach(o => {
      if (o.empId === emp.id && o.id !== sh.id && o.id !== opts.ignoreId) {
        others.push({ a: offset + o.day * DAY + o.start, b: offset + o.day * DAY + o.end, o, offset });
      }
    });
    collect(weekShifts(state, addDays(weekKey, -7)), -WEEK);
    collect(cur, 0);
    collect(weekShifts(state, addDays(weekKey, 7)), WEEK);

    if (others.some(x => x.a < e && s < x.b)) blocks.push({ code: 'overlap' });

    const thisWeek = others.filter(x => x.offset === 0);
    const total = thisWeek.reduce((t, x) => t + hours(x.o), 0) + len;
    if (total > emp.maxHours) blocks.push({ code: 'maxHours', max: emp.maxHours, total });
    else if (total > 40) warns.push({ code: 'overtime', total });

    if (emp.minor) {
      if (touchesMinorNight(s, e)) blocks.push({ code: 'minorNight' });
      if (state.settings.schoolPeriod) {
        if (total > MINOR.weekMax) blocks.push({ code: 'minorWeek', total, max: MINOR.weekMax });
        const weekday = thisWeek.filter(x => x.o.day < 5).reduce((t, x) => t + hours(x.o), 0) + (sh.day < 5 ? len : 0);
        if (sh.day < 5 && weekday > MINOR.weekdayMax) blocks.push({ code: 'minorWeekday', total: weekday, max: MINOR.weekdayMax });
      }
    }

    // Rest since the previous shift (checked one way so a pair is reported once).
    const prevEnd = Math.max(-Infinity, ...others.filter(x => x.b <= s).map(x => x.b));
    const nextStart = Math.min(Infinity, ...others.filter(x => x.a >= e).map(x => x.a));
    if (s - prevEnd < MIN_REST) (opts.auto ? blocks : warns).push({ code: 'rest', hours: (s - prevEnd) / 60 });
    else if (opts.auto && nextStart - e < MIN_REST) blocks.push({ code: 'rest', hours: (nextStart - e) / 60 });
    if (opts.auto && thisWeek.some(x => x.o.day === sh.day)) blocks.push({ code: 'sameDay' });

    if (len < state.settings.minShift || len > state.settings.maxShift) warns.push({ code: 'length', hours: len });
    return { blocks, warns };
  }

  // ---------- coverage ----------
  function coverage(state, shifts) {
    const need = { kitchen: new Int16Array(SLOTS), front: new Int16Array(SLOTS) };
    const cov = { kitchen: new Int16Array(SLOTS), front: new Int16Array(SLOTS) };
    const bounds = new Uint8Array(SLOTS + 1);   // where a staffing range starts or ends
    state.staffing.forEach((blocks, d) => (blocks || []).forEach(b => {
      const i0 = Math.floor((d * DAY + b.start) / SLOT), i1 = Math.min(SLOTS, Math.ceil((d * DAY + b.end) / SLOT));
      bounds[i0] = bounds[i1] = 1;
      for (const st of STATIONS) for (let i = i0; i < i1; i++) need[st][i] += b[st] || 0;
    }));
    shifts.forEach(sh => { if (sh.empId) addCov(cov, sh, 1); });
    return { need, cov, bounds };
  }

  function addCov(cov, sh, sign) {
    const [a, b] = absOf(sh);
    for (let i = Math.max(0, Math.floor(a / SLOT)); i < Math.min(SLOTS, Math.ceil(b / SLOT)); i++) cov[sh.station][i] += sign;
  }

  // Consecutive short-staffed half hours, grouped (split where a staffing
  // range starts, so a gap never runs across days). start/end are week minutes.
  function gapsOf({ need, cov, bounds }) {
    const gaps = [];
    for (const st of STATIONS) {
      let i = 0;
      while (i < SLOTS) {
        if (need[st][i] - cov[st][i] <= 0) { i++; continue; }
        let j = i, missing = 0;
        do { missing = Math.max(missing, need[st][j] - cov[st][j]); j++; }
        while (j < SLOTS && !bounds[j] && need[st][j] - cov[st][j] > 0);
        gaps.push({ station: st, start: i * SLOT, end: j * SLOT, missing });
        i = j;
      }
    }
    return gaps.sort((a, b) => a.start - b.start);
  }

  // ---------- auto-scheduler ----------
  // Greedy: place regular shifts, fill open shifts, then repeatedly take the
  // short-staffed half hour that the FEWEST people could cover and give it to
  // the best shift shape and the person with the fewest hours so far.
  function generate(state, weekKey) {
    const shifts = weekShifts(state, weekKey).map(s => ({ ...s }));
    const emps = state.employees.filter(e => e.active && e.name);
    const cache = new Map();
    const report = { regulars: 0, filledOpen: 0, added: 0, skipped: [], gaps: [] };
    const ok = (emp, sh, ignoreId) => check(state, weekKey, { ...sh, empId: emp.id }, { shifts, cache, auto: true, ignoreId }).blocks.length === 0;
    const pickEmployee = list => list.slice().sort((x, y) => {
      const hx = weekHours(shifts, x.id), hy = weekHours(shifts, y.id);
      const bx = hx < x.minHours ? 0 : 1, by = hy < y.minHours ? 0 : 1;
      return bx - by || hx / Math.max(x.maxHours, 1) - hy / Math.max(y.maxHours, 1) || hx - hy || byName(x, y);
    })[0];

    // 1. Regular shifts (checked with the normal rules, not the stricter auto ones).
    for (const emp of emps) for (const r of emp.regulars) for (const day of r.days || []) {
      if (shifts.some(s => s.empId === emp.id && s.day === day && s.start === r.start && s.end === r.end)) continue;
      const sh = { id: uid(), empId: emp.id, day, start: r.start, end: r.end, station: r.station, regular: true };
      const res = check(state, weekKey, sh, { shifts, cache });
      if (res.blocks.length) report.skipped.push({ empId: emp.id, shift: sh, blocks: res.blocks });
      else { shifts.push(sh); report.regulars++; }
    }

    // 2. Open shifts the manager created by hand.
    for (const sh of shifts.filter(s => !s.empId)) {
      const best = pickEmployee(emps.filter(e => ok(e, sh, sh.id)));
      if (best) { sh.empId = best.id; report.filledOpen++; }
    }

    // 3. Fill the staffing template.
    const cv = coverage(state, shifts);
    const { need, cov } = cv;
    const shapes = [];
    const addShape = (start, end) => { if (end > start && !shapes.some(p => p.start === start && p.end === end)) shapes.push({ start, end }); };
    state.settings.templates.forEach(t => addShape(t.start, t.end));
    emps.forEach(e => e.regulars.forEach(r => addShape(r.start, r.end)));

    const covering = { kitchen: Array.from({ length: SLOTS }, () => []), front: Array.from({ length: SLOTS }, () => []) };
    const cands = [];
    for (let day = 0; day < 7; day++) for (const p of shapes) for (const station of STATIONS) {
      const i0 = Math.floor((day * DAY + p.start) / SLOT), i1 = Math.min(SLOTS, Math.ceil((day * DAY + p.end) / SLOT));
      let demand = 0;
      for (let i = i0; i < i1; i++) demand += need[station][i];
      if (!demand) continue;
      const c = { day, start: p.start, end: p.end, station, i0, i1 };
      c.elig = emps.filter(e => ok(e, c));
      cands.push(c);
      for (let i = i0; i < i1; i++) covering[station][i].push(c);
    }

    const index = new Map(emps.map((e, i) => [e.id, i]));
    const stamp = new Int32Array(emps.length);
    let tick = 0;
    for (let guard = 0; guard < 2000; guard++) {
      let target = null;
      for (const st of STATIONS) for (let i = 0; i < SLOTS; i++) {
        if (need[st][i] - cov[st][i] <= 0) continue;
        tick++;
        let n = 0;
        for (const c of covering[st][i]) for (const e of c.elig) {
          const k = index.get(e.id);
          if (stamp[k] !== tick) { stamp[k] = tick; n++; }
        }
        if (n > 0 && (!target || n < target.n)) target = { st, i, n };
      }
      if (!target) break;

      let pick = null;
      for (const c of covering[target.st][target.i]) {
        if (!c.elig.length) continue;
        let gain = 0;
        for (let i = c.i0; i < c.i1; i++) if (need[c.station][i] - cov[c.station][i] > 0) gain++;
        if (!pick || gain > pick.gain) pick = { c, gain };
      }
      const emp = pickEmployee(pick.c.elig);
      const sh = { id: uid(), empId: emp.id, day: pick.c.day, start: pick.c.start, end: pick.c.end, station: pick.c.station, auto: true };
      shifts.push(sh);
      addCov(cov, sh, 1);
      report.added++;
      // Only this person's eligibility can have changed.
      for (const c of cands) if (c.elig.includes(emp) && !ok(emp, c)) c.elig = c.elig.filter(e => e !== emp);
    }

    report.gaps = gapsOf(cv);
    return { shifts, report };
  }

  // ---------- helpers used by the screens ----------
  function replacements(state, weekKey, shiftId) {
    const shifts = weekShifts(state, weekKey);
    const sh = shifts.find(s => s.id === shiftId);
    if (!sh) return [];
    return state.employees
      .filter(e => e.active && e.id !== sh.empId && e.stations.includes(sh.station))
      .map(emp => ({ emp, hours: weekHours(shifts, emp.id), ...check(state, weekKey, { ...sh, empId: emp.id }) }))
      .sort((x, y) => (x.blocks.length > 0) - (y.blocks.length > 0) || x.hours - y.hours || byName(x.emp, y.emp));
  }

  function weekIssues(state, weekKey) {
    const shifts = weekShifts(state, weekKey);
    const items = [];
    for (const sh of shifts) {
      if (!sh.empId) { items.push({ kind: 'open', shift: sh }); continue; }
      const res = check(state, weekKey, sh);
      if (res.blocks.length) items.push({ kind: sh.forced ? 'forced' : 'block', shift: sh, list: res.blocks });
      if (res.warns.length) items.push({ kind: 'warn', shift: sh, list: res.warns });
    }
    const cv = coverage(state, shifts);
    return { items, gaps: gapsOf(cv), need: cv.need, cov: cv.cov };
  }

  // Copies last week's shifts onto this one, dropping any that now break a rule.
  function copyWeek(state, fromKey, toKey) {
    const shifts = [], dropped = [];
    for (const src of weekShifts(state, fromKey)) {
      const sh = { ...src, id: uid() };
      delete sh.forced;
      const res = check(state, toKey, sh, { shifts });
      if (res.blocks.length) dropped.push({ shift: sh, blocks: res.blocks });
      else shifts.push(sh);
    }
    return { shifts, dropped };
  }

  // ---------- import a team list (pasted from WFM/Excel, or a CSV file) ----------
  const foldText = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const DAY_WORDS = [['lun', 'mon'], ['mar', 'tue'], ['mer', 'wed'], ['jeu', 'thu'], ['ven', 'fri'], ['sam', 'sat'], ['dim', 'sun']];

  function splitRows(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
    const delim = lines.some(l => l.includes('\t')) ? '\t'
      : lines.filter(l => l.includes(';')).length > lines.filter(l => l.includes(',')).length ? ';' : ',';
    return lines.map(line => {
      const cells = [];
      let cur = '', quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
        else if (c === delim && !quoted) { cells.push(cur.trim()); cur = ''; }
        else cur += c;
      }
      cells.push(cur.trim());
      return cells;
    });
  }

  // What each header column means, or null if the first row isn't a header.
  function readHeader(row) {
    const map = {};
    row.forEach((cell, i) => {
      const h = foldText(cell);
      if (!h) return;
      const day = DAY_WORDS.findIndex(ws => ws.some(w => h.startsWith(w)));
      if (/prenom|first/.test(h)) map.first = i;
      else if (/famille|last|surname/.test(h)) map.last = i;
      else if (/poste|station|position|role/.test(h)) map.station = i;
      else if (/min/.test(h)) map.min = i;
      else if (/max|heure|hour/.test(h)) map.max = i;
      else if (/^(nom|name|employe|employee|equipier)/.test(h)) map.name = i;
      else if (day >= 0 && h.length <= 9) (map.days = map.days || [])[day] = i;
    });
    // A real header names the person column, or lists several days ("Marc" alone is a name, not "Mardi").
    const days = (map.days || []).filter(x => x != null).length;
    return map.name != null || map.first != null || map.last != null || days >= 2 ? map : null;
  }

  function readStations(v) {
    const s = foldText(v);
    const k = /cuis|kitchen|grill|cook|prep/.test(s), f = /devant|front|caisse|comptoir|counter|service|drive|cash/.test(s);
    if (/deux|both|tous|all/.test(s) || (k && f)) return ['kitchen', 'front'];
    return k ? ['kitchen'] : f ? ['front'] : null;
  }

  // "6-14", "6h-14h", "16:00 - 23:00", "oui", "non" → availability ranges for one day.
  function readDay(v) {
    const s = foldText(v);
    if (!s || /^(non|no|n|x|-|indispo|off|ferme)$/.test(s)) return [];
    const m = s.match(/(\d{1,2})(?:[h:](\d{2}))?\s*h?\s*(?:-|–|a|to)\s*(\d{1,2})(?:[h:](\d{2}))?/);
    if (m) {
      const a = +m[1] * 60 + (+m[2] || 0);
      let b = +m[3] * 60 + (+m[4] || 0);
      if (b <= a) b += DAY;
      return [{ start: a, end: b }];
    }
    return [{ start: 0, end: DAY }];   // "oui", "dispo", "toute la journée", ✓ …
  }

  // Returns { people, notes } without changing anything; the screen shows a preview first.
  function parseTeamList(text, existing = []) {
    const rows = splitRows(text);
    const notes = { stationGuessed: 0, duplicates: [] };
    if (!rows.length) return { people: [], notes };
    const head = readHeader(rows[0]);
    const body = head ? rows.slice(1) : rows;
    const taken = new Set(existing.map(e => foldText(e.name)));
    const people = [];
    for (const r of body) {
      let name;
      if (head) {
        const first = head.first != null ? r[head.first] : '';
        const last = head.last != null ? r[head.last] : (head.first != null && head.name != null ? r[head.name] : '');
        name = first || last ? `${first} ${last}` : r[head.name ?? 0];
      } else if (r.length === 2 && /^[^\d]+$/.test(r[0]) && /^[^\d]+$/.test(r[1]) && !readStations(r[1])) {
        name = `${r[1]} ${r[0]}`;          // "Tremblay, Alexandre" → "Alexandre Tremblay"
      } else {
        name = r[0];
      }
      name = String(name || '').replace(/\s+/g, ' ').trim()
        .replace(/^([^,]+),\s*([^,]+)$/, '$2 $1');   // "Roy, Marc" → "Marc Roy"
      if (!name || /^\d+$/.test(name)) continue;
      if (taken.has(foldText(name))) { notes.duplicates.push(name); continue; }
      taken.add(foldText(name));

      const stationText = head && head.station != null ? r[head.station] : r.slice(1).find(readStations);
      let stations = stationText ? readStations(stationText) : null;
      if (!stations) { stations = ['kitchen', 'front']; notes.stationGuessed++; }
      const maxCell = head && head.max != null ? parseFloat(String(r[head.max]).replace(',', '.')) : NaN;
      const minCell = head && head.min != null ? parseFloat(String(r[head.min]).replace(',', '.')) : NaN;
      let availability = [0, 1, 2, 3, 4, 5, 6].map(() => [{ start: 0, end: DAY }]);
      if (head && head.days && head.days.some(i => i != null && r[i])) {
        availability = [0, 1, 2, 3, 4, 5, 6].map(d => (head.days[d] != null ? readDay(r[head.days[d]]) : [{ start: 0, end: DAY }]));
      }
      people.push(normEmp({
        name, stations, availability,
        maxHours: Number.isFinite(maxCell) ? maxCell : 40,
        minHours: Number.isFinite(minCell) ? minCell : 0,
      }));
    }
    return { people, notes };
  }

  // ---------- fake team for trying the app ----------
  function demoTeam(seed = 7) {
    let x = seed;
    const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
    const first = ['Alexandre', 'Camille', 'Gabriel', 'Léa', 'Samuel', 'Florence', 'William', 'Rosalie', 'Thomas', 'Juliette',
      'Nathan', 'Maëlle', 'Félix', 'Charlotte', 'Olivier', 'Mia', 'Xavier', 'Emma', 'Antoine', 'Zoé', 'Jacob', 'Sofia',
      'Mathis', 'Alice', 'Raphaël', 'Laurence', 'Loïc', 'Amira', 'Hugo', 'Béatrice', 'Karim', 'Clara', 'Émile', 'Noémie',
      'Vincent', 'Yasmine', 'Marco', 'Élodie', 'Adam', 'Jade', 'Rémi', 'Inès', 'Luca', 'Anaïs', 'Mohamed'];
    const last = ['Tremblay', 'Gagnon', 'Roy', 'Côté', 'Bouchard', 'Gauthier', 'Morin', 'Lavoie', 'Fortin', 'Gagné',
      'Ouellet', 'Pelletier', 'Bélanger', 'Lévesque', 'Bergeron', 'Leblanc', 'Paquette', 'Girard', 'Simard', 'Boucher',
      'Caron', 'Beaulieu', 'Cloutier', 'Dubé', 'Poirier', 'Fournier', 'Lapointe', 'Leclerc', 'Lefebvre', 'Poulin',
      'Thibault', 'St-Pierre', 'Nadeau', 'Martin', 'Landry', 'Martel', 'Bédard', 'Grenier', 'Lessard', 'Bernier',
      'Richard', 'Michaud', 'Hébert', 'Desjardins', 'Rossi'];
    const all = [{ start: 0, end: DAY }];
    const patterns = {
      full: () => [0, 1, 2, 3, 4, 5, 6].map(() => all),
      days: () => [0, 1, 2, 3, 4, 5, 6].map(() => [{ start: 6 * 60, end: 16 * 60 }]),
      evenings: () => [0, 1, 2, 3, 4, 5, 6].map(d => d < 5 ? [{ start: 16 * 60, end: 23 * 60 }] : all),
      nights: () => [0, 1, 2, 3, 4, 5, 6].map(() => [{ start: 21 * 60, end: 31 * 60 }]),
      weekend: () => [0, 1, 2, 3, 4, 5, 6].map(d => d === 4 ? [{ start: 16 * 60, end: 23 * 60 }] : d > 4 ? all : []),
    };
    const plan = [
      ...Array(8).fill('full'), ...Array(10).fill('days'), ...Array(12).fill('evenings'),
      ...Array(8).fill('nights'), ...Array(7).fill('weekend'),
    ];
    return plan.map((p, i) => {
      const r = rnd();
      const stations = r < 0.35 ? ['kitchen'] : r < 0.75 ? ['front'] : ['kitchen', 'front'];
      const minor = p === 'evenings' && i % 3 === 0;
      const emp = normEmp({
        name: first[i % first.length] + ' ' + last[(i * 7) % last.length],
        stations, minor,
        maxHours: minor ? 17 : p === 'weekend' ? 20 : [40, 32, 30, 24][Math.floor(rnd() * 4)],
        minHours: p === 'full' ? 24 : 0,
        availability: patterns[p](),
      });
      if (p === 'days' && i % 3 === 0) emp.regulars.push({ id: uid(), days: [0, 1, 2, 3, 4], start: 6 * 60, end: 14 * 60, station: emp.stations[0] });
      if (p === 'full' && i % 4 === 1) emp.regulars.push({ id: uid(), days: [0, 1, 2, 3, 4], start: 9 * 60, end: 17 * 60, station: emp.stations[0] });
      if (p === 'nights' && i % 2 === 0) emp.regulars.push({ id: uid(), days: [0, 2, 4, 6], start: 22 * 60, end: 30 * 60, station: emp.stations[0] });
      if (emp.regulars.length) emp.maxHours = 40;
      return emp;
    });
  }

  const api = {
    DAY, WEEK, SLOT, SLOTS, STATIONS, MINOR, MIN_REST,
    addDays, mondayOf, parseIso, isoOf, toMin, toHHMM, span, hours, absOf, uid,
    defaultState, defaultStaffing, migrate, normEmp, findEmp, weekShifts, weekHours, byName,
    availIntervals, timeOffHit, check, coverage, gapsOf, generate, replacements, weekIssues, copyWeek, demoTeam,
    parseTeamList,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Horaire = api;
})(typeof window !== 'undefined' ? window : globalThis);
