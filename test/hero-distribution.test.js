'use strict';
// 出征不再推荐英雄；攻守都按队伍叫点给分支，并带变招。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const test = require('node:test');

function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'valorant_linzhen.html'), 'utf8');
  function grab(id) {
    const m = html.match(new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</script>'));
    if (!m) throw new Error('missing ' + id);
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
  return { L: sandbox.LinzhenFactory(C, Z, DB), DB: DB };
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
const BANNED = ['首选', '备选', '【玩谁】', '择将', '推荐你用'];

function deploy(map, seed, me) {
  const now = function () { return new Date(Date.UTC(2026, 4, 2, 9, 15, 0)); };
  return L.deploy(null, { map: map, me: me || '', pref: '', habits: [] }, { rnd: rndFrom(seed), now: now });
}

test('coin toss for a fixed seed is unchanged', function () {
  const d = deploy('Haven', 123456);
  const values = JSON.parse(JSON.stringify(d.casts.map(function (c) { return c.values; })));
  assert.deepStrictEqual(values, [
    [7, 7, 8, 8, 9, 7],
    [9, 8, 7, 8, 8, 7],
    [8, 8, 8, 7, 6, 7],
    [8, 8, 8, 8, 8, 8]
  ]);
});

test('output recommends no hero', function () {
  DB.pool.forEach(function (map) {
    const d = deploy(map, 42);
    const text = L.copyText({ prep: null, deploy: d });
    BANNED.forEach(function (w) { assert.ok(text.indexOf(w) < 0, map + ' contains ' + w); });
    assert.ok(!d.hero && !d.altHero && !d.heroes, map + ' still has a hero pick');
    assert.strictEqual(d.me, '');
    assert.ok(text.indexOf('不推荐英雄') >= 0 || text.indexOf('未选英雄') >= 0);
  });
  const named = deploy('Bind', 7, 'Sage');
  const namedText = L.copyText({ prep: null, deploy: named });
  assert.ok(namedText.indexOf('你选了贤者') >= 0 || namedText.indexOf('你选的英雄') >= 0);
  assert.ok(namedText.indexOf('首选') < 0);
  BANNED.forEach(function (w) { assert.ok(namedText.indexOf(w) < 0, 'named output has ' + w); });
});

test('every map and both sides list each team call and two triggered variations', function () {
  const blobs = {};
  DB.pool.forEach(function (map) {
    const mx = L.MAPX(map);
    const d = deploy(map, 99);
    ['atk', 'def'].forEach(function (side) {
      const sh = d.play[side];
      const calls = sh.branches.map(function (b) { return b.call; });
      mx.sites.forEach(function (site) {
        assert.ok(calls.indexOf(site) >= 0, map + ' ' + side + ' missing ' + site);
      });
      assert.ok(calls.indexOf('spread') >= 0, map + ' ' + side + ' missing spread');
      assert.ok(sh.alts.length >= 2, map + ' ' + side + ' alts');
      sh.alts.forEach(function (a) {
        assert.ok(/何时/.test(a.when), a.when);
        assert.ok(/变招/.test(a.text), a.text);
      });
      sh.branches.forEach(function (b) { assert.ok(/何时用/.test(b.when)); });
    });
    blobs[map] = JSON.stringify(d.play);
  });
  assert.notStrictEqual(blobs.Haven, blobs.Bind);
  assert.notStrictEqual(blobs.Abyss, blobs.Sunset);
  assert.notStrictEqual(blobs.Lotus, blobs.Summit);
});

test('different casts can lean different approaches on the same map', function () {
  let sawDiff = false;
  DB.pool.forEach(function (map) {
    const leans = {};
    for (let i = 0; i < 28; i++) {
      const d = deploy(map, 1000 + i * 17);
      const key = d.play.atk.arch + '/' + d.play.def.arch;
      leans[key] = (leans[key] || 0) + 1;
    }
    if (Object.keys(leans).length > 1) sawDiff = true;
    console.log(map, JSON.stringify(leans));
  });
  assert.ok(sawDiff, 'no map changed approach across casts');
});

test('same seed is stable and refresh would reread the stored sheet', function () {
  const a = deploy('Sunset', 555);
  const b = deploy('Sunset', 555);
  assert.strictEqual(JSON.stringify(a.play), JSON.stringify(b.play));
  assert.strictEqual(a.casts.map(function (c) { return c.values.join(''); }).join('|'), b.casts.map(function (c) { return c.values.join(''); }).join('|'));
});
