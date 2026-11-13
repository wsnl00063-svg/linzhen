'use strict';
// Regression: 出征的首选英雄不能塌缩成不死鸟/霓虹。
// 页面仍是单文件离线 HTML；本测试只读取它，不联网。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const test = require('node:test');

function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'valorant_linzhen.html'), 'utf8');
  function grab(id) {
    const m = html.match(new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</script>'));
    if (!m) throw new Error('missing script ' + id);
    return m[1];
  }
  const sandbox = { console, crypto: require('crypto').webcrypto };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  ['liuyao-core', 'liuyao-zs', 'linzhen-db', 'linzhen-engine'].forEach(function (id) {
    vm.runInContext(grab(id), sandbox, { filename: id + '.js' });
  });
  const DB = sandbox.TACTICS_DB;
  DB.callouts = JSON.parse(grab('linzhen-callouts'));
  DB.agentAbil = JSON.parse(grab('linzhen-abil'));
  const C = sandbox.LiuyaoCoreFactory(JSON.parse(grab('liuyao-data')));
  const Z = sandbox.LiuyaoZSFactory(C);
  const L = sandbox.LinzhenFactory(C, Z, DB);
  return { L, DB };
}

function rndFrom(seed) {
  let s = seed >>> 0 || 1;
  return function (n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out.push((s >>> 16) & 255);
    }
    return out;
  };
}

const { L, DB } = load();
const heroes = DB.heroes.map(function (h) { return h.id; });
const roleOf = {};
DB.heroes.forEach(function (h) { roleOf[h.id] = h.role; });
const prof = ['Neon', 'Yoru', 'Reyna'].concat(heroes.filter(function (h) { return ['Neon', 'Yoru', 'Reyna'].indexOf(h) < 0; }));

test('fixed coin sequence still builds the same hexagrams', function () {
  const now = function () { return new Date(Date.UTC(2026, 4, 2, 9, 15, 0)); };
  const d = L.deploy(null, { map: 'Haven', heroes: heroes.slice(), prof: prof, pref: '', habits: [] }, { rnd: rndFrom(123456), now: now });
  // 数值来自页面里的 vm，和测试域不是同一个 Array，先收成普通数字再比。
  const values = JSON.parse(JSON.stringify(d.casts.map(function (c) { return c.values; })));
  assert.deepStrictEqual(values, [
    [7, 7, 8, 8, 9, 7],
    [9, 8, 7, 8, 8, 7],
    [8, 8, 8, 7, 6, 7],
    [8, 8, 8, 8, 8, 8]
  ]);
  assert.strictEqual(JSON.parse(JSON.stringify(d.casts.map(function (c) { return c.chart.ben; }))).join(','), ['中孚', '賁', '晉', '坤'].join(','));
  assert.strictEqual(d.pick.atk.mode, 'reality');
  assert.strictEqual(d.pick.def.mode, 'reality');
  assert.notStrictEqual(d.hero, 'Phoenix');
  assert.notStrictEqual(d.hero, 'Neon');
});

test('same seed is stable, and proficiency does not pick the hero', function () {
  const now = function () { return new Date(Date.UTC(2026, 4, 2, 9, 15, 0)); };
  const inp = { map: 'Haven', heroes: heroes.slice(), prof: prof, pref: '', habits: [] };
  const a = L.deploy(null, inp, { rnd: rndFrom(123456), now: now });
  const b = L.deploy(null, inp, { rnd: rndFrom(123456), now: now });
  assert.strictEqual(a.hero, b.hero);
  assert.strictEqual(a.altHero, b.altHero);
  assert.deepStrictEqual(a.casts.map(function (c) { return c.values.join(''); }), b.casts.map(function (c) { return c.values.join(''); }));
  const rev = prof.slice().reverse();
  const ranked = L.matchHeroes(heroes, rev, L.allCandidates(L.MAPX('Haven')).atk.find(function (t) { return t.arch === 'clear'; }), L.allCandidates(L.MAPX('Haven')).def.find(function (t) { return t.arch === 'anchor'; }));
  const normal = L.matchHeroes(heroes, prof, L.allCandidates(L.MAPX('Haven')).atk.find(function (t) { return t.arch === 'clear'; }), L.allCandidates(L.MAPX('Haven')).def.find(function (t) { return t.arch === 'anchor'; }));
  assert.strictEqual(normal[0].id, ranked[0].id);
  assert.notStrictEqual(normal[0].id, 'Phoenix');
  assert.notStrictEqual(normal[0].id, 'Neon');
  assert.ok(normal[0].canAtk && normal[0].canDef);
  assert.ok(normal[0].posBoth > 0);
});

test('backup hero stays switchable and is a different executable agent', function () {
  DB.pool.forEach(function (map) {
    const now = function () { return new Date(Date.UTC(2026, 7, 8, 11, 0, 0)); };
    const d = L.deploy(null, { map: map, heroes: heroes.slice(), prof: prof, pref: '', habits: [] }, { rnd: rndFrom(9000 + map.length * 17), now: now });
    assert.ok(d.altHero, map + ' has a backup');
    assert.notStrictEqual(d.altHero, d.hero);
    assert.ok(d.views[d.hero] && d.views[d.altHero], map + ' views');
    const top = d.heroes[0], alt = d.heroes[1];
    assert.strictEqual(top.id, d.hero);
    assert.strictEqual(alt.id, d.altHero);
    assert.ok(top.tier >= alt.tier);
    if (top.tier === 2) assert.ok(top.canAtk && top.canDef);
  });
});

test('every full-map tactic pair recommends someone who can execute it, across all four roles', function () {
  const roles = {};
  const winners = {};
  ['Abyss', 'Bind', 'Haven', 'Sunset'].forEach(function (map) {
    const all = L.allCandidates(L.MAPX(map));
    all.atk.forEach(function (a) {
      all.def.forEach(function (df) {
        const rows = L.matchHeroes(heroes, prof, a, df);
        const top = rows[0];
        assert.strictEqual(top.tier, 2, map + ' ' + a.arch + '+' + df.arch + ' ' + top.id);
        assert.ok(top.canAtk && top.canDef, map + ' ' + a.arch + '+' + df.arch);
        roles[roleOf[top.id]] = (roles[roleOf[top.id]] || 0) + 1;
        winners[top.id] = (winners[top.id] || 0) + 1;
      });
    });
  });
  ['决斗', '先锋', '控场', '哨卫'].forEach(function (role) {
    assert.ok(roles[role] > 0, 'missing role ' + role + ' ' + JSON.stringify(roles));
  });
  const phx = (winners.Phoenix || 0) + (winners.Neon || 0);
  const n = Object.values(winners).reduce(function (s, x) { return s + x; }, 0);
  assert.ok(phx / n < 0.35, 'Phoenix/Neon share on tactic pairs ' + phx + '/' + n);
});

test('many casts across every map are not dominated by Phoenix or Neon', function () {
  const counts = {};
  const roles = {};
  const byMap = {};
  const N = 16;
  let total = 0;
  DB.pool.forEach(function (map) {
    byMap[map] = {};
    for (let i = 0; i < N; i++) {
      const seed = (map.charCodeAt(0) * 50000 + i * 131 + 7) >>> 0;
      const now = function () { return new Date(Date.UTC(2026, 4, 2, 9, 15, 0)); };
      const d = L.deploy(null, { map: map, heroes: heroes.slice(), prof: prof, pref: '', habits: [] }, { rnd: rndFrom(seed), now: now });
      assert.ok(heroes.indexOf(d.hero) >= 0);
      assert.strictEqual(d.heroes[0].id, d.hero);
      if (d.heroes[0].tier === 2) assert.ok(d.heroes[0].canAtk && d.heroes[0].canDef);
      counts[d.hero] = (counts[d.hero] || 0) + 1;
      roles[roleOf[d.hero]] = (roles[roleOf[d.hero]] || 0) + 1;
      byMap[map][d.hero] = (byMap[map][d.hero] || 0) + 1;
      total++;
    }
  });
  const pn = (counts.Phoenix || 0) + (counts.Neon || 0);
  const roleN = Object.keys(roles).length;
  const heroN = Object.keys(counts).length;
  const top = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; })[0];
  const modes = {};
  DB.pool.forEach(function (map) {
    const win = Object.entries(byMap[map]).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    modes[win] = (modes[win] || 0) + 1;
  });
  console.log('DISTRIBUTION total=' + total + ' phoenix+neon=' + pn + ' (' + (100 * pn / total).toFixed(1) + '%)');
  console.log('ROLES ' + JSON.stringify(roles));
  console.log('HEROES ' + Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; }).map(function (x) { return x[0] + ':' + x[1]; }).join(' '));
  console.log('BY MAP ' + DB.pool.map(function (m) { return m + '=' + Object.entries(byMap[m]).sort(function (a, b) { return b[1] - a[1]; }).map(function (x) { return x[0] + x[1]; }).join('/'); }).join(' | '));
  assert.ok(roleN >= 3, 'roles ' + JSON.stringify(roles));
  assert.ok(heroN >= 6, 'heroes ' + heroN);
  assert.ok(pn / total < 0.25, 'Phoenix/Neon ' + pn + '/' + total);
  assert.ok(top[1] / total < 0.5, 'top hero ' + top[0] + ' ' + top[1]);
  assert.ok(Object.keys(modes).length >= 4, 'map modes ' + JSON.stringify(modes));
});
