/*
 * logic.test.js — 計算部分のテスト
 * 実行：node --test room-layout/test/
 * Node.js 標準の node:test と node:assert だけを使う。
 */
const test = require("node:test");
const assert = require("node:assert");
const L = require("../logic.js");
const SAMPLE = require("../sample-data.js");

// テスト用の部屋を作る（作業中モードはオフにしておく）
function room(width, depth, items, extra) {
  return L.normalizeData(Object.assign({
    room: { width: width, depth: depth },
    settings: { workMode: false },
    items: items || []
  }, extra || {}));
}
function wall(id, x, y, w, h) {
  return { id: id, name: id, type: "other", x: x, y: y, w: w, h: h, frontSide: "bottom" };
}
function routeLength(data, p, q) {
  return L.findRoute(L.buildGrid(data, []), p, q);
}

// ===== 指示文の必須テスト =====
test("何もない部屋で、端から端までの経路の長さが直線距離とほぼ同じになる", () => {
  const d = room(400, 300);
  const straight = routeLength(d, { x: 30, y: 150 }, { x: 370, y: 150 });
  assert.ok(straight.found);
  assert.ok(Math.abs(straight.length - 340) / 340 < 0.02, "横方向: " + straight.length);
  // 斜めは方眼の8方向移動なので少し長くなる（10%以内）
  const diag = routeLength(d, { x: 30, y: 30 }, { x: 370, y: 270 });
  const euclid = Math.hypot(340, 240);
  assert.ok(diag.found);
  assert.ok(diag.length >= euclid - 1 && (diag.length - euclid) / euclid < 0.10, "斜め: " + diag.length);
});

test("幅40cmの隙間は通れず、幅60cmの隙間は通れる", () => {
  // 部屋を横切る仕切りに隙間を1か所あける
  function withGap(gap) {
    const left = 150 - gap / 2, right = 150 + gap / 2;
    return room(300, 300, [wall("w1", 0, 140, left, 20), wall("w2", right, 140, 300 - right, 20)]);
  }
  const p = { x: 150, y: 40 }, q = { x: 150, y: 260 };
  assert.strictEqual(routeLength(withGap(40), p, q).found, false, "40cm は通れないはず");
  assert.strictEqual(routeLength(withGap(60), p, q).found, true, "60cm は通れるはず");
});

test("初期データで全ルートの経路が見つかり、移動距離が 0 より大きい", () => {
  const d = L.normalizeData(SAMPLE);
  const ev = L.evaluate(d);
  assert.strictEqual(ev.routes.length, 4);
  ev.routes.forEach(r => assert.ok(r.found, r.fromName + "→" + r.toName + " が見つからない"));
  assert.ok(ev.total > 0);
});

test("改善提案が少なくとも1件出て、提案後の配置が採用条件をすべて満たす", () => {
  const d = L.normalizeData(SAMPLE);
  const base = L.evaluate(d, { clutter: false });
  const list = L.suggest(d);
  assert.ok(list.length >= 1, "提案が0件");
  assert.ok(list.length <= L.CONFIG.SUGGEST_TOP);
  const pairs = L.pairChairs(d);
  list.forEach(s => {
    const it = d.items.find(o => o.id === s.candidate.itemId);
    assert.strictEqual(it.fixed, false, "固定の家具は動かさない");
    assert.ok(L.checkPlacement(s.data, s.candidate, pairs).ok, "重なり・ドア・正面の条件");
    const ev = L.evaluate(s.data, { clutter: false });
    assert.ok(ev.allFound, "すべてのルートで経路が見つかる");
    assert.ok(!ev.hasRed, "赤（60cm 未満）の区間がない");
    assert.ok(ev.total < base.total, "移動距離が減る");
  });
  // 減り幅の大きい順
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].gain >= list[i].gain);
});

// ===== 追加のテスト =====
test("90度回転で w と h が入れ替わり、正面が時計回りに回る", () => {
  const it = { id: "a", x: 100, y: 100, w: 100, h: 60, frontSide: "bottom" };
  const r = L.rotateItem(it, { width: 400, depth: 400 });
  assert.strictEqual(r.w, 60); assert.strictEqual(r.h, 100);
  assert.strictEqual(r.frontSide, "left");
  assert.strictEqual(L.rotateItem(r).frontSide, "top");
  // 中心はほぼ保たれる
  assert.ok(Math.abs((r.x + r.w / 2) - 150) <= 5 && Math.abs((r.y + r.h / 2) - 130) <= 5);
});

test("地点の位置：家具は正面の中央から40cm手前、椅子・クッション・布団は中心、家具と一緒に動く", () => {
  const d = L.normalizeData(SAMPLE);
  const pos = id => L.stopPosition(d.stops.find(s => s.id === id), d);
  assert.deepStrictEqual(pos("printerFront"), { x: 340, y: 190 }); // プリンター棚の正面 top の 40cm 手前
  assert.deepStrictEqual(pos("seat"), { x: 240, y: 85 });          // 椅子の中心
  assert.deepStrictEqual(pos("futonSpot"), { x: 210, y: 270 });    // 布団の中心
  assert.deepStrictEqual(pos("entrance"), { x: 40, y: 37.5 });     // ドアの中央から 40cm 内側
  d.items.find(o => o.id === "printer").y = 200;
  assert.deepStrictEqual(pos("printerFront"), { x: 340, y: 160 });
  // どこにも紐づけない地点は x, y をそのまま使う
  assert.deepStrictEqual(L.stopPosition({ id: "f", attachedTo: null, x: 50, y: 60 }, d), { x: 50, y: 60 });
});

test("作業中モード：机の前75cmが障害物になり、机の席からの経路だけは出入りできる", () => {
  const desk = { id: "desk", name: "机", type: "desk", x: 100, y: 0, w: 100, h: 60, frontSide: "bottom" };
  const base = {
    stops: [
      { id: "seat", name: "席", attachedTo: "desk" },
      { id: "L", name: "左", x: 30, y: 85 },
      { id: "R", name: "右", x: 270, y: 85 }
    ],
    routines: [{ from: "L", to: "R", timesPerDay: 1 }, { from: "seat", to: "R", timesPerDay: 1 }]
  };
  const off = L.normalizeData(Object.assign({ room: { width: 300, depth: 300 }, settings: { workMode: false }, items: [desk] }, base));
  const on = L.normalizeData(Object.assign({ room: { width: 300, depth: 300 }, settings: { workMode: true }, items: [desk] }, base));
  const evOff = L.evaluate(off), evOn = L.evaluate(on);
  assert.strictEqual(evOn.zones.length, 1);
  assert.deepStrictEqual([evOn.zones[0].y, evOn.zones[0].h], [60, 75]);
  // 左→右：机の前を通れなくなり、遠回りになる
  assert.ok(evOn.routes[0].found && evOn.routes[0].length > evOff.routes[0].length + 20);
  // 席→右：席は机の範囲の中にあるが、出入りできる
  assert.ok(evOn.routes[1].found);
  // 椅子に紐づいた席でも同じ（椅子は机の前にあるので、その机と組になる）
  const withChair = L.normalizeData(Object.assign({}, on, {
    items: [desk, { id: "ch", name: "椅子", type: "chair", x: 125, y: 60, w: 50, h: 50, frontSide: "top" }],
    stops: [{ id: "seat", name: "席", attachedTo: "ch" }, { id: "R", name: "右", x: 270, y: 200 }],
    routines: [{ from: "seat", to: "R", timesPerDay: 1 }]
  }));
  assert.deepStrictEqual(L.pairChairs(withChair), { ch: "desk" });
  assert.ok(L.evaluate(withChair).routes[0].found);
});

test("固定の家具は改善提案で動かされない", () => {
  const d = L.normalizeData(SAMPLE);
  d.items.forEach(it => { if (it.id === "deskA" || it.id === "printer") it.fixed = true; });
  const cands = L.makeCandidates(d);
  assert.ok(cands.every(c => c.itemId !== "deskA" && c.itemId !== "printer"));
  L.suggest(d).forEach(s => assert.ok(s.candidate.itemId !== "deskA" && s.candidate.itemId !== "printer"));
  // 全部固定なら候補なし
  d.items.forEach(it => { it.fixed = true; });
  assert.strictEqual(L.makeCandidates(d).length, 0);
  assert.strictEqual(L.suggest(d).length, 0);
});

test("作り付け収納・柱は障害物になり、経路を遮る", () => {
  const d = room(300, 300, [], {
    fixtures: [{ id: "closet", type: "storage", x: 0, y: 140, w: 300, h: 20 }]
  });
  assert.strictEqual(d.fixtures[0].locked, true, "作り付け収納は初期でロックされる");
  assert.strictEqual(routeLength(d, { x: 150, y: 40 }, { x: 150, y: 260 }).found, false);
  const d2 = room(300, 300, [], { fixtures: [{ id: "pillar", type: "pillar", x: 130, y: 130, w: 40, h: 40 }] });
  const r = routeLength(d2, { x: 150, y: 40 }, { x: 150, y: 260 });
  assert.ok(r.found && r.length > 220, "柱を避けて遠回りする");
});

test("毎日使う物の置き場所が遠いと、片付けの警告が出る", () => {
  const base = {
    room: { width: 400, depth: 300 }, settings: { workMode: false },
    items: [
      { id: "near", name: "近い棚", type: "shelf", x: 0, y: 0, w: 60, h: 40, frontSide: "bottom" },
      { id: "far", name: "遠い棚", type: "shelf", x: 340, y: 260, w: 60, h: 40, frontSide: "top" }
    ],
    stops: [{ id: "use", name: "使う場所", x: 30, y: 100 }]
  };
  const near = L.normalizeData(Object.assign({}, base, { things: [{ name: "ペン", storedIn: "near", usedAt: ["use"], frequency: "daily" }] }));
  const far = L.normalizeData(Object.assign({}, base, { things: [{ name: "ペン", storedIn: "far", usedAt: ["use"], frequency: "daily" }] }));
  const weekly = L.normalizeData(Object.assign({}, base, { things: [{ name: "ペン", storedIn: "far", usedAt: ["use"], frequency: "weekly" }] }));
  assert.strictEqual(L.evaluate(near).clutter.length, 0);
  assert.strictEqual(L.evaluate(far).clutter.length, 1);
  assert.strictEqual(L.evaluate(weekly).clutter.length, 0, "毎日使う物だけが対象");
});

test("ドアの開く範囲に入る家具を判定できる", () => {
  const d = L.normalizeData(SAMPLE);
  const fan = L.doorFan(d.fixtures.find(f => f.id === "door"), d.room);
  assert.deepStrictEqual([fan.cx, fan.cy, fan.r], [0, 0, 75]);
  assert.ok(L.rectHitsFan({ x: 10, y: 10, w: 30, h: 30 }, fan));
  assert.ok(!L.rectHitsFan({ x: 60, y: 60, w: 30, h: 30 }, fan), "扇の外（角の先）");
  assert.ok(!L.rectHitsFan({ x: 80, y: 0, w: 30, h: 30 }, fan));
});

test("射影変換：4点が正しく対応し、平行四辺形の中心は中心に移る", () => {
  const src = [{ x: 10, y: 20 }, { x: 210, y: 40 }, { x: 230, y: 160 }, { x: 30, y: 140 }];
  const dst = [{ x: 0, y: 0 }, { x: 380, y: 0 }, { x: 380, y: 320 }, { x: 0, y: 320 }];
  const H = L.computeHomography(src, dst);
  src.forEach((p, i) => {
    const q = L.applyHomography(H, p);
    assert.ok(Math.abs(q.x - dst[i].x) < 1e-6 && Math.abs(q.y - dst[i].y) < 1e-6);
  });
  const c = L.applyHomography(H, { x: 120, y: 90 });
  assert.ok(Math.abs(c.x - 190) < 1e-6 && Math.abs(c.y - 160) < 1e-6);
});

test("射影変換：斜めから撮った台形を、真上から見た長方形に直せる", () => {
  // 遠くが狭く写った床の台形 → 部屋の4隅
  const photo = [{ x: 300, y: 200 }, { x: 700, y: 200 }, { x: 950, y: 700 }, { x: 50, y: 700 }];
  const roomRect = [{ x: 0, y: 0 }, { x: 380, y: 0 }, { x: 380, y: 320 }, { x: 0, y: 320 }];
  const H = L.computeHomography(roomRect, photo); // 部屋の座標 → 写真の座標
  roomRect.forEach((p, i) => {
    const q = L.applyHomography(H, p);
    assert.ok(Math.abs(q.x - photo[i].x) < 1e-6 && Math.abs(q.y - photo[i].y) < 1e-6);
  });
  // 部屋の中央は、写真では台形の中央より奥（上）に写る（遠近の効果）
  const mid = L.applyHomography(H, { x: 190, y: 160 });
  assert.ok(mid.y < 450 && mid.w > 0);
  // 一直線の4点は解けない
  assert.strictEqual(L.computeHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], roomRect), null);
});

test("データの読み込み：足りない項目を補い、知らない項目は残す", () => {
  const d = L.normalizeData({
    room: { width: 300, depth: 250 },
    items: [{ id: "a", type: "desk", x: 0, y: 0, w: 100, h: 60 }, { id: "a", type: "xxx" }],
    fixtures: [{ id: "c", type: "storage", x: 0, y: 0, w: 50, h: 50 }],
    things: [{ name: "本", storedIn: "a", usedAt: "s" }],
    photos: [{ wall: "top", id: "p1" }]
  });
  assert.strictEqual(d.settings.workMode, true);
  assert.notStrictEqual(d.items[0].id, d.items[1].id, "id の重複を直す");
  assert.strictEqual(d.items[1].type, "other");
  assert.strictEqual(d.fixtures[0].locked, true);
  assert.deepStrictEqual(d.things[0].usedAt, ["s"]);
  assert.deepStrictEqual(d.photos, [{ wall: "top", id: "p1" }], "後のフェーズ用の項目を残す");
  assert.deepStrictEqual(d.underlays, []);
});
