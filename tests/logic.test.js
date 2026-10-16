// Run with:  node --test tests
const test = require('node:test');
const assert = require('node:assert');
const H = require('../logic.js');

const WEEK = '2026-10-19'; // a Monday

function stateWithDemo() {
  const s = H.defaultState();
  s.employees = H.demoTeam();
  return s;
}

test('mondayOf finds the Monday', () => {
  assert.strictEqual(H.mondayOf(new Date(2026, 9, 25)), '2026-10-19'); // Sunday
  assert.strictEqual(H.mondayOf(new Date(2026, 9, 19)), '2026-10-19');
});

test('span handles shifts crossing midnight', () => {
  assert.deepStrictEqual(H.span('22:00', '06:00'), { start: 1320, end: 1800 });
  assert.deepStrictEqual(H.span('06:00', '14:00'), { start: 360, end: 840 });
});

test('stock-order days (Mon, Fri) need 2 more kitchen from 17h to 22h', () => {
  const { need } = H.coverage(H.defaultState(), []);
  const at = (day, hhmm) => need.kitchen[(day * H.DAY + H.toMin(hhmm)) / H.SLOT];
  assert.strictEqual(at(0, '16:30'), 3);
  assert.strictEqual(at(0, '17:00'), 5);
  assert.strictEqual(at(4, '21:30'), 5);
  assert.strictEqual(at(4, '22:00'), 2);
  assert.strictEqual(at(1, '17:00'), 3, 'Tuesday is a normal day');
});

test('generated week breaks no hard rule', () => {
  const s = stateWithDemo();
  const t0 = Date.now();
  const { shifts, report } = H.generate(s, WEEK);
  const ms = Date.now() - t0;
  s.weeks[WEEK] = { shifts };
  const issues = H.weekIssues(s, WEEK);
  const blocks = issues.items.filter(i => i.kind === 'block');
  assert.deepStrictEqual(blocks.map(b => b.list.map(x => x.code)), []);
  const hours = shifts.reduce((t, x) => t + H.hours(x), 0);
  console.log(`  ${shifts.length} shifts, ${hours} h, ${report.regulars} regular, ${report.gaps.length} gaps, ${ms} ms`);
  assert.ok(ms < 3000, 'should be fast enough for a phone');
  assert.ok(report.regulars > 0);
});

test('nobody goes over their max hours, minors follow Québec rules', () => {
  const s = stateWithDemo();
  const { shifts } = H.generate(s, WEEK);
  for (const e of s.employees) {
    const h = H.weekHours(shifts, e.id);
    assert.ok(h <= e.maxHours, `${e.name} ${h}h > ${e.maxHours}h`);
    if (e.minor) {
      assert.ok(h <= 17);
      const weekday = shifts.filter(x => x.empId === e.id && x.day < 5).reduce((t, x) => t + H.hours(x), 0);
      assert.ok(weekday <= 10, `${e.name} weekday ${weekday}h`);
      for (const x of shifts.filter(x => x.empId === e.id)) assert.ok(x.end <= 23 * 60, 'minor after 23h');
    }
  }
});

test('vacation blocks the shift and the replacement list skips them', () => {
  const s = stateWithDemo();
  const emp = s.employees.find(e => e.availability[1].length && e.stations.includes('kitchen'));
  emp.timeOff.push({ id: 'v', from: '2026-10-20', to: '2026-10-22', note: 'Vacances' });
  const sh = { id: 'x', empId: emp.id, day: 1, start: 6 * 60, end: 14 * 60, station: 'kitchen' };
  const res = H.check(s, WEEK, sh);
  assert.ok(res.blocks.some(b => b.code === 'timeoff'));

  const { shifts } = H.generate(s, WEEK);
  assert.ok(!shifts.some(x => x.empId === emp.id && x.day >= 1 && x.day <= 3), 'no shifts while on vacation');

  s.weeks[WEEK] = { shifts: [{ ...sh, empId: s.employees[0].id }] };
  const list = H.replacements(s, WEEK, 'x');
  const vac = list.find(r => r.emp.id === emp.id);
  assert.ok(!vac || vac.blocks.length > 0, 'person on vacation is not offered');
  assert.ok(list.length && list[0].blocks.length === 0, 'first suggestion is valid');
});

test('availability: overnight range and unavailable day', () => {
  const s = H.defaultState();
  const e = H.normEmp({ id: 'n', name: 'Night', stations: ['front'], availability: [[{ start: 1260, end: 1860 }], [], [], [], [], [], []] });
  s.employees = [e];
  assert.strictEqual(H.check(s, WEEK, { id: 'a', empId: 'n', day: 0, start: 1320, end: 1800, station: 'front' }).blocks.length, 0);
  assert.ok(H.check(s, WEEK, { id: 'b', empId: 'n', day: 1, start: 360, end: 840, station: 'front' }).blocks.some(b => b.code === 'avail'));
});

test('all-day availability on consecutive days covers a night shift', () => {
  const s = H.defaultState();
  const all = [{ start: 0, end: 1440 }];
  s.employees = [H.normEmp({ id: 'f', name: 'Full', stations: ['kitchen'], availability: [all, all, all, all, all, all, all] })];
  assert.strictEqual(H.check(s, WEEK, { id: 'a', empId: 'f', day: 6, start: 1320, end: 1800, station: 'kitchen' }).blocks.length, 0);
});

test('copy week drops shifts that now break a rule', () => {
  const s = stateWithDemo();
  const prev = H.addDays(WEEK, -7);
  s.weeks[prev] = { shifts: H.generate(s, prev).shifts };
  const victim = s.weeks[prev].shifts[0];
  H.findEmp(s, victim.empId).timeOff.push({ id: 't', from: WEEK, to: H.addDays(WEEK, 6) });
  const { shifts, dropped } = H.copyWeek(s, prev, WEEK);
  assert.ok(dropped.some(d => d.shift.empId === victim.empId));
  assert.ok(!shifts.some(x => x.empId === victim.empId));
});
