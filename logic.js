/*
 * logic.js — 計算部分（画面の操作は含めない）
 *  - 方眼化（部屋を 10cm のマスに区切る）
 *  - A*（エースター：最短経路を効率よく探す方法）
 *  - 通路幅・スコア（1日の移動距離）・片付けチェック・改善提案
 *  - 射影変換（写真や手書き図の歪みを直す計算）
 * ブラウザでは window.RoomLogic、Node.js では require() で使える。
 */
var RoomLogic = (function () {
  "use strict";

  // ===== 調整用の定数（ここを変えると動きが変わる） =====
  var CONFIG = {
    GRID: 10,              // 方眼の1マスの大きさ（cm）
    SNAP: 10,              // 配置を吸着させる間隔（cm）
    MIN_CLEARANCE: 25,     // 通れるマス：障害物・壁まで この距離以上（= 通路幅 50cm 相当）
    WIDTH_GREEN: 90,       // 通路幅 この値以上は緑（cm）
    WIDTH_YELLOW: 60,      // 通路幅 この値以上は黄、未満は赤（cm）
    // 通路幅の測り方："cross" = 進行方向に直角な幅（左右の障害物までの距離の合計）
    //                  "nearest" = 最寄りの障害物までの距離 × 2（指示文どおりの式）
    WIDTH_METHOD: "cross",
    WIDTH_RAY_MAX: 300,    // 通路幅を測るときの最大距離（cm）
    STOP_OFFSET: 40,       // 地点の位置：正面の中央から この距離だけ手前（cm）
    CONNECT_MAX: 150,      // 地点から最寄りの通れるマスまで、直線でつなぐ最大距離（cm）
    WORK_ZONE_DEPTH: 75,   // 作業中モード：机の正面の前の「椅子を引いて座る範囲」（cm）
    FRONT_CLEAR: 50,       // 改善提案：家具の正面の前に必要な空き（cm）
    CLUTTER_WARN: 150,     // 片付けの警告：しまう場所から使う場所まで この距離以上（cm）
    SUGGEST_STEP: 10,      // 改善提案：候補位置の刻み（cm）
    SUGGEST_MIN_GAIN: 10,  // 改善提案：1日の移動距離が この値以上減る案だけ出す（cm）
    SUGGEST_TOP: 3         // 改善提案：出す案の数
  };

  var SIDES = ["top", "right", "bottom", "left"];
  var ROTATE_NEXT = { top: "right", right: "bottom", bottom: "left", left: "top" }; // 時計回り
  var OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };
  var ITEM_TYPES = ["desk", "chair", "shelf", "bed", "cushion", "other"];
  var CENTER_STOP_TYPES = ["chair", "cushion", "bed"];   // 地点を物の中心にする種類
  var NO_FRONT_CHECK_TYPES = ["chair", "cushion"];       // 正面の空きを問わない種類
  var WALL_FIXTURE_TYPES = ["door", "window", "outlet"]; // 壁に付く設備
  var RECT_FIXTURE_TYPES = ["storage", "pillar"];        // 四角の設備（障害物になる）
  var FIXTURE_TYPES = WALL_FIXTURE_TYPES.concat(RECT_FIXTURE_TYPES);
  var FREQUENCIES = ["daily", "weekly", "monthly"];
  var WALL_JA = { top: "上", right: "右", bottom: "下", left: "左" };
  var TYPE_JA = { desk: "机", chair: "椅子", shelf: "棚", bed: "ベッド・布団", cushion: "クッション", other: "その他" };
  var FIXTURE_JA = { door: "ドア", window: "窓", outlet: "コンセント", storage: "作り付け収納", pillar: "柱" };
  var SQRT2 = Math.SQRT2;

  // ===== 小さな道具 =====
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function snap(v, step) { step = step || CONFIG.SNAP; return Math.round(v / step) * step; }
  function has(arr, v) { return arr.indexOf(v) >= 0; }

  // 2つの四角が重なるか（辺が接するだけなら重ならない扱い）
  function rectsOverlap(a, b) {
    var e = 1e-6;
    return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
  }
  function pointInRect(p, r) {
    return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  }
  // 点から四角までの最短距離（中にあれば 0）
  function pointRectDist(px, py, r) {
    var dx = Math.max(r.x - px, 0, px - (r.x + r.w));
    var dy = Math.max(r.y - py, 0, py - (r.y + r.h));
    return Math.sqrt(dx * dx + dy * dy);
  }
  // 四角を部屋の中に切り取る（はみ出しが全部なら null）
  function clipRect(r, room) {
    var x1 = Math.max(r.x, 0), y1 = Math.max(r.y, 0);
    var x2 = Math.min(r.x + r.w, room.width), y2 = Math.min(r.y + r.h, room.depth);
    if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function insideRoom(r, room) {
    var e = 1e-6;
    return r.x >= -e && r.y >= -e && r.x + r.w <= room.width + e && r.y + r.h <= room.depth + e;
  }
  // 線分が四角の内側を通るか（Liang-Barsky 法。辺をかすめるだけなら通らない扱い）
  function segmentHitsRect(p, q, r) {
    var s = 0.01; // 辺ぎりぎりは除くため、少し小さくして判定
    var xmin = r.x + s, xmax = r.x + r.w - s, ymin = r.y + s, ymax = r.y + r.h - s;
    if (xmin >= xmax || ymin >= ymax) return false;
    var dx = q.x - p.x, dy = q.y - p.y, t0 = 0, t1 = 1;
    var ps = [-dx, dx, -dy, dy], qs = [p.x - xmin, xmax - p.x, p.y - ymin, ymax - p.y];
    for (var i = 0; i < 4; i++) {
      if (ps[i] === 0) { if (qs[i] < 0) return false; continue; }
      var t = qs[i] / ps[i];
      if (ps[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 < t1;
  }

  // ===== データの整え =====
  // 足りない項目を補う。知らない項目（後のフェーズ用など）は消さずに残す。
  function normalizeData(raw) {
    var d = raw && typeof raw === "object" ? clone(raw) : {};
    d.version = d.version || 1;
    d.room = d.room && typeof d.room === "object" ? d.room : {};
    d.room.width = Math.max(50, num(d.room.width, 360));
    d.room.depth = Math.max(50, num(d.room.depth, 270));
    d.settings = d.settings && typeof d.settings === "object" ? d.settings : {};
    if (typeof d.settings.workMode !== "boolean") d.settings.workMode = true;
    ["items", "fixtures", "stops", "routines", "things", "underlays"].forEach(function (k) {
      if (!Array.isArray(d[k])) d[k] = [];
    });
    var used = {};
    function uniqueId(id, prefix) {
      id = id ? String(id) : prefix;
      var base = id, n = 2;
      while (used[id]) id = base + "_" + (n++);
      used[id] = true;
      return id;
    }
    d.items.forEach(function (it) {
      it.id = uniqueId(it.id, "item");
      if (!has(ITEM_TYPES, it.type)) it.type = "other";
      it.name = it.name || TYPE_JA[it.type];
      it.x = num(it.x, 0); it.y = num(it.y, 0);
      it.w = Math.max(10, num(it.w, 60)); it.h = Math.max(10, num(it.h, 60));
      it.fixed = !!it.fixed;
      if (!has(SIDES, it.frontSide)) it.frontSide = "bottom";
    });
    d.fixtures.forEach(function (f) {
      f.id = uniqueId(f.id, f.type || "fixture");
      if (!has(FIXTURE_TYPES, f.type)) return; // 知らない種類はそのまま残す（計算では無視）
      f.name = f.name || FIXTURE_JA[f.type];
      if (has(WALL_FIXTURE_TYPES, f.type)) {
        if (!has(SIDES, f.wall)) f.wall = "top";
        f.offset = num(f.offset, 0);
        f.width = Math.max(0, num(f.width, f.type === "door" ? 75 : (f.type === "window" ? 90 : 10)));
        if (f.type === "door") {
          if (f.swing !== "outward") f.swing = "inward";
          var vertical = f.wall === "left" || f.wall === "right";
          var okHinge = vertical ? ["top", "bottom"] : ["left", "right"];
          if (!has(okHinge, f.hinge)) f.hinge = okHinge[0];
        }
      } else {
        f.x = num(f.x, 0); f.y = num(f.y, 0);
        f.w = Math.max(10, num(f.w, f.type === "pillar" ? 30 : 90));
        f.h = Math.max(10, num(f.h, f.type === "pillar" ? 30 : 60));
        if (typeof f.locked !== "boolean") f.locked = true;
      }
    });
    d.stops.forEach(function (s) {
      s.id = uniqueId(s.id, "stop");
      s.name = s.name || "地点";
      if (!s.attachedTo) s.attachedTo = null;
    });
    d.routines.forEach(function (r) {
      r.timesPerDay = Math.max(0, num(r.timesPerDay, 1));
    });
    d.things.forEach(function (t) {
      t.name = t.name || "物";
      if (!Array.isArray(t.usedAt)) t.usedAt = t.usedAt ? [String(t.usedAt)] : [];
      if (!has(FREQUENCIES, t.frequency)) t.frequency = "daily";
    });
    d.underlays.forEach(function (u) {
      u.id = uniqueId(u.id, "underlay");
      if (u.kind !== "sketch") u.kind = "photo";
      u.x = num(u.x, 0); u.y = num(u.y, 0);
      u.w = Math.max(1, num(u.w, d.room.width)); u.h = Math.max(1, num(u.h, d.room.depth));
      u.opacity = clamp(num(u.opacity, 0.5), 0, 1);
      if (typeof u.visible !== "boolean") u.visible = true;
    });
    return d;
  }

  // 空の部屋のデータ
  function newEmptyData(width, depth) {
    return normalizeData({ room: { width: width, depth: depth } });
  }

  // 重ならない id を作る
  function makeId(data, prefix) {
    var ids = {};
    ["items", "fixtures", "stops", "underlays"].forEach(function (k) {
      (data[k] || []).forEach(function (o) { ids[o.id] = true; });
    });
    var n = 1;
    while (ids[prefix + n]) n++;
    return prefix + n;
  }

  // ===== 家具・設備の形 =====
  function findEntity(data, id) {
    if (!id) return null;
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return { kind: "item", obj: data.items[i] };
    for (var j = 0; j < data.fixtures.length; j++) if (data.fixtures[j].id === id) return { kind: "fixture", obj: data.fixtures[j] };
    return null;
  }
  function isRectFixture(f) { return has(RECT_FIXTURE_TYPES, f.type); }
  function isWallFixture(f) { return has(WALL_FIXTURE_TYPES, f.type); }

  // 90度回転（中心を保ったまま w と h を入れ替え、正面も時計回りに回す）
  function rotateItem(item, room) {
    var it = clone(item);
    var cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    var w = it.h, h = it.w;
    it.w = w; it.h = h;
    it.x = snap(cx - w / 2); it.y = snap(cy - h / 2);
    it.frontSide = ROTATE_NEXT[it.frontSide] || "bottom";
    if (room) clampToRoom(it, room);
    return it;
  }
  function clampToRoom(o, room) {
    o.x = clamp(o.x, 0, Math.max(0, room.width - o.w));
    o.y = clamp(o.y, 0, Math.max(0, room.depth - o.h));
    return o;
  }
  // 正面の辺の中央から offset だけ手前の点
  function frontPoint(r, side, offset) {
    switch (side) {
      case "top": return { x: r.x + r.w / 2, y: r.y - offset };
      case "left": return { x: r.x - offset, y: r.y + r.h / 2 };
      case "right": return { x: r.x + r.w + offset, y: r.y + r.h / 2 };
      default: return { x: r.x + r.w / 2, y: r.y + r.h + offset };
    }
  }
  // 正面の前の帯（奥行 depth）
  function frontZone(r, side, depth) {
    switch (side) {
      case "top": return { x: r.x, y: r.y - depth, w: r.w, h: depth };
      case "left": return { x: r.x - depth, y: r.y, w: depth, h: r.h };
      case "right": return { x: r.x + r.w, y: r.y, w: depth, h: r.h };
      default: return { x: r.x, y: r.y + r.h, w: r.w, h: depth };
    }
  }
  // 壁に付く設備の線分と、部屋の内側を向く向き（nx, ny）
  function wallSegment(f, room) {
    var W = room.width, D = room.depth, o = num(f.offset, 0), len = num(f.width, 0);
    switch (f.wall) {
      case "left": return { x1: 0, y1: o, x2: 0, y2: o + len, nx: 1, ny: 0 };
      case "right": return { x1: W, y1: o, x2: W, y2: o + len, nx: -1, ny: 0 };
      case "bottom": return { x1: o, y1: D, x2: o + len, y2: D, nx: 0, ny: -1 };
      default: return { x1: o, y1: 0, x2: o + len, y2: 0, nx: 0, ny: 1 };
    }
  }
  // ドアの開く範囲（扇形）。cx,cy=蝶番、r=半径、sx,sy=扇の広がる向き
  function doorFan(f, room) {
    if (f.type !== "door" || f.swing === "outward") return null;
    var s = wallSegment(f, room), r = num(f.width, 0);
    if (r <= 0) return null;
    var vertical = f.wall === "left" || f.wall === "right";
    var cx, cy, sx, sy;
    if (vertical) {
      cx = s.x1; sx = s.nx;
      if (f.hinge === "bottom") { cy = s.y2; sy = -1; } else { cy = s.y1; sy = 1; }
    } else {
      cy = s.y1; sy = s.ny;
      if (f.hinge === "right") { cx = s.x2; sx = -1; } else { cx = s.x1; sx = 1; }
    }
    return { cx: cx, cy: cy, r: r, sx: sx, sy: sy, vertical: vertical };
  }
  // 四角がドアの開く範囲に入るか
  function rectHitsFan(rect, fan) {
    var bx1 = Math.min(fan.cx, fan.cx + fan.sx * fan.r), bx2 = Math.max(fan.cx, fan.cx + fan.sx * fan.r);
    var by1 = Math.min(fan.cy, fan.cy + fan.sy * fan.r), by2 = Math.max(fan.cy, fan.cy + fan.sy * fan.r);
    var ix1 = Math.max(rect.x, bx1), ix2 = Math.min(rect.x + rect.w, bx2);
    var iy1 = Math.max(rect.y, by1), iy2 = Math.min(rect.y + rect.h, by2);
    if (ix2 - ix1 <= 1e-6 || iy2 - iy1 <= 1e-6) return false;
    var nx = clamp(fan.cx, ix1, ix2), ny = clamp(fan.cy, iy1, iy2);
    return Math.hypot(nx - fan.cx, ny - fan.cy) < fan.r - 1e-6;
  }
  function doorFans(data) {
    return data.fixtures.map(function (f) { return doorFan(f, data.room); }).filter(Boolean);
  }

  // 四角の設備の「正面」：部屋の中心を向く辺とする【仮定】
  function rectFixtureSide(f, room) {
    var dx = room.width / 2 - (f.x + f.w / 2), dy = room.depth / 2 - (f.y + f.h / 2);
    if (Math.abs(dx) / room.width > Math.abs(dy) / room.depth) return dx > 0 ? "right" : "left";
    return dy > 0 ? "bottom" : "top";
  }

  // 家具・設備に紐づけたときの地点の位置
  function entityPoint(ent, data) {
    var o = ent.obj, p;
    if (ent.kind === "item") {
      if (has(CENTER_STOP_TYPES, o.type)) p = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      else p = frontPoint(o, o.frontSide, CONFIG.STOP_OFFSET);
    } else if (isWallFixture(o)) {
      var s = wallSegment(o, data.room);
      p = { x: (s.x1 + s.x2) / 2 + s.nx * CONFIG.STOP_OFFSET, y: (s.y1 + s.y2) / 2 + s.ny * CONFIG.STOP_OFFSET };
    } else if (isRectFixture(o)) {
      p = frontPoint(o, rectFixtureSide(o, data.room), CONFIG.STOP_OFFSET);
    } else return null;
    // 部屋の外に出ないようにする
    return { x: clamp(p.x, 1, data.room.width - 1), y: clamp(p.y, 1, data.room.depth - 1) };
  }
  function stopPosition(stop, data) {
    if (stop.attachedTo) {
      var ent = findEntity(data, stop.attachedTo);
      if (ent) return entityPoint(ent, data);
    }
    if (isFinite(stop.x) && isFinite(stop.y) && stop.x !== null && stop.y !== null) {
      return { x: clamp(Number(stop.x), 1, data.room.width - 1), y: clamp(Number(stop.y), 1, data.room.depth - 1) };
    }
    return null;
  }

  // ===== 作業中モード =====
  // 椅子ごとに「前にある机」を決める（机の正面の範囲と最も多く重なる机）
  function pairChairs(data) {
    var pairs = {};
    data.items.forEach(function (ch) {
      if (ch.type !== "chair") return;
      var best = null, bestArea = 0;
      data.items.forEach(function (dk) {
        if (dk.type !== "desk") return;
        var z = frontZone(dk, dk.frontSide, CONFIG.WORK_ZONE_DEPTH);
        var w = Math.min(z.x + z.w, ch.x + ch.w) - Math.max(z.x, ch.x);
        var h = Math.min(z.y + z.h, ch.y + ch.h) - Math.max(z.y, ch.y);
        if (w > 0 && h > 0 && w * h > bestArea) { bestArea = w * h; best = dk.id; }
      });
      if (best) pairs[ch.id] = best;
    });
    return pairs;
  }
  // 机の前の「椅子を引いて座る範囲」
  function workZones(data) {
    if (!data.settings || !data.settings.workMode) return [];
    var out = [];
    data.items.forEach(function (it) {
      if (it.type !== "desk") return;
      var z = clipRect(frontZone(it, it.frontSide, CONFIG.WORK_ZONE_DEPTH), data.room);
      if (z) { z.deskId = it.id; out.push(z); }
    });
    return out;
  }
  // この物に紐づく地点なら、どの机の範囲に出入りしてよいか
  function desksForEntity(data, id, pairs) {
    var ent = findEntity(data, id);
    if (!ent || ent.kind !== "item") return [];
    if (ent.obj.type === "desk") return [ent.obj.id];
    if (ent.obj.type === "chair" && pairs[ent.obj.id]) return [pairs[ent.obj.id]];
    return [];
  }

  // ===== 方眼化 =====
  function baseObstacles(data) {
    var obs = [];
    data.items.forEach(function (it) { obs.push({ x: it.x, y: it.y, w: it.w, h: it.h, id: it.id }); });
    data.fixtures.forEach(function (f) { if (isRectFixture(f)) obs.push({ x: f.x, y: f.y, w: f.w, h: f.h, id: f.id }); });
    return obs;
  }
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // 部屋を方眼にして、各マスの「最寄りの障害物・壁までの距離」と「通れるか」を求める
  // excludeDesks：作業中モードで、範囲に出入りしてよい机の id
  function buildGrid(data, excludeDesks) {
    excludeDesks = excludeDesks || [];
    var room = data.room, G = CONFIG.GRID;
    var cols = Math.max(1, Math.ceil(room.width / G)), rows = Math.max(1, Math.ceil(room.depth / G));
    var zones = workZones(data).filter(function (z) { return !has(excludeDesks, z.deskId); });
    var obs = baseObstacles(data).concat(zones);
    var n = cols * rows, clear = new Float32Array(n), pass = new Uint8Array(n);
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var cx = i * G + G / 2, cy = j * G + G / 2;
        var d = Math.min(cx, room.width - cx, cy, room.depth - cy);
        if (d < 0) d = 0;
        for (var k = 0; k < obs.length && d > 0; k++) {
          var od = pointRectDist(cx, cy, obs[k]);
          if (od < d) d = od;
        }
        clear[j * cols + i] = d;
        pass[j * cols + i] = d >= CONFIG.MIN_CLEARANCE - 1e-6 ? 1 : 0;
      }
    }
    var grid = { cols: cols, rows: rows, G: G, clear: clear, pass: pass, obstacles: obs, room: room };
    grid.comp = labelComponents(grid);
    return grid;
  }
  // 斜めに進むときは、角をすり抜けないよう左右のマスも通れることを条件にする
  function canStep(grid, i, j, dx, dy) {
    var ni = i + dx, nj = j + dy, c = grid.cols;
    if (ni < 0 || nj < 0 || ni >= c || nj >= grid.rows) return false;
    if (!grid.pass[nj * c + ni]) return false;
    if (dx !== 0 && dy !== 0) {
      if (!grid.pass[j * c + ni] || !grid.pass[nj * c + i]) return false;
    }
    return true;
  }
  // つながっている通れるマスに、同じ番号を付ける
  function labelComponents(grid) {
    var n = grid.cols * grid.rows, comp = new Int32Array(n).fill(-1), label = 0, queue = new Int32Array(n);
    for (var s = 0; s < n; s++) {
      if (!grid.pass[s] || comp[s] >= 0) continue;
      var head = 0, tail = 0;
      queue[tail++] = s; comp[s] = label;
      while (head < tail) {
        var cur = queue[head++], i = cur % grid.cols, j = (cur / grid.cols) | 0;
        for (var d = 0; d < 8; d++) {
          var dx = DIRS[d][0], dy = DIRS[d][1];
          if (!canStep(grid, i, j, dx, dy)) continue;
          var nb = (j + dy) * grid.cols + (i + dx);
          if (comp[nb] < 0) { comp[nb] = label; queue[tail++] = nb; }
        }
      }
      label++;
    }
    return comp;
  }
  function cellCenter(grid, idx) {
    return { x: (idx % grid.cols) * grid.G + grid.G / 2, y: ((idx / grid.cols) | 0) * grid.G + grid.G / 2 };
  }
  // 点が入っているマスの番号（部屋の外なら -1）
  function cellIndexAt(grid, p) {
    var i = Math.floor(p.x / grid.G), j = Math.floor(p.y / grid.G);
    if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return -1;
    return j * grid.cols + i;
  }
  // 2点を結ぶ直線が、通れるマスだけを通るか（見通せるか）
  function visible(grid, a, b) {
    var L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / (grid.G / 4)));
    for (var k = 0; k <= n; k++) {
      var idx = cellIndexAt(grid, { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
      if (idx < 0 || !grid.pass[idx]) return false;
    }
    return true;
  }
  // 方眼の折れ線を、見通せる区間はまっすぐ結んで短くする
  function smoothPath(grid, pts) {
    if (pts.length <= 2) return pts.slice();
    var out = [pts[0]], i = 0, last = pts.length - 1;
    while (i < last) {
      var j = i + 1;
      while (j + 1 <= last && visible(grid, pts[i], pts[j + 1])) j++;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  // ===== A* =====
  function astar(grid, start, goal) {
    var n = grid.cols * grid.rows, c = grid.cols, G = grid.G;
    var g = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    var gi = goal % c, gj = (goal / c) | 0;
    function h(idx) { // 斜め移動ありの距離の見積もり
      var dx = Math.abs(idx % c - gi), dy = Math.abs(((idx / c) | 0) - gj);
      return G * (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy));
    }
    // 優先度付きキュー（小さい順に取り出せる入れ物）
    var heapF = [], heapI = [];
    function push(f, idx) {
      heapF.push(f); heapI.push(idx);
      var k = heapF.length - 1;
      while (k > 0) {
        var p = (k - 1) >> 1;
        if (heapF[p] <= heapF[k]) break;
        var tf = heapF[p]; heapF[p] = heapF[k]; heapF[k] = tf;
        var ti = heapI[p]; heapI[p] = heapI[k]; heapI[k] = ti;
        k = p;
      }
    }
    function pop() {
      var top = heapI[0], lf = heapF.pop(), li = heapI.pop();
      if (heapF.length) {
        heapF[0] = lf; heapI[0] = li;
        var k = 0, len = heapF.length;
        for (;;) {
          var l = 2 * k + 1, r = l + 1, m = k;
          if (l < len && heapF[l] < heapF[m]) m = l;
          if (r < len && heapF[r] < heapF[m]) m = r;
          if (m === k) break;
          var tf = heapF[m]; heapF[m] = heapF[k]; heapF[k] = tf;
          var ti = heapI[m]; heapI[m] = heapI[k]; heapI[k] = ti;
          k = m;
        }
      }
      return top;
    }
    g[start] = 0; push(h(start), start);
    while (heapF.length) {
      var cur = pop();
      if (closed[cur]) continue;
      if (cur === goal) break;
      closed[cur] = 1;
      var i = cur % c, j = (cur / c) | 0;
      for (var d = 0; d < 8; d++) {
        var dx = DIRS[d][0], dy = DIRS[d][1];
        if (!canStep(grid, i, j, dx, dy)) continue;
        var nb = (j + dy) * c + (i + dx);
        if (closed[nb]) continue;
        var ng = g[cur] + (dx !== 0 && dy !== 0 ? G * SQRT2 : G);
        if (ng < g[nb] - 1e-9) { g[nb] = ng; came[nb] = cur; push(ng + h(nb), nb); }
      }
    }
    if (g[goal] === Infinity) return null;
    var path = [goal];
    while (path[path.length - 1] !== start) path.push(came[path[path.length - 1]]);
    path.reverse();
    return { cells: path, length: g[goal] };
  }

  // 地点から直線でつなげる「通れるマス」を、つながりの番号ごとに最寄り1つずつ探す
  // 直線は、地点を含まない障害物を突き抜けてはいけない
  function connectCandidates(grid, p) {
    var G = grid.G, R = CONFIG.CONNECT_MAX, c = grid.cols;
    // 地点が通れるマスの中にあれば、そのマスから出発する（隙間を飛び越えないように）
    var own = cellIndexAt(grid, p);
    if (own >= 0 && grid.pass[own]) {
      var oc = {};
      oc[grid.comp[own]] = { idx: own, dist: 0, inside: true };
      return oc;
    }
    var blockers = grid.obstacles.filter(function (r) { return !pointInRect(p, r); });
    var i0 = Math.max(0, Math.floor((p.x - R) / G)), i1 = Math.min(c - 1, Math.floor((p.x + R) / G));
    var j0 = Math.max(0, Math.floor((p.y - R) / G)), j1 = Math.min(grid.rows - 1, Math.floor((p.y + R) / G));
    var list = [];
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var idx = j * c + i;
      if (!grid.pass[idx]) continue;
      var d = Math.hypot(i * G + G / 2 - p.x, j * G + G / 2 - p.y);
      if (d <= R) list.push([d, idx]);
    }
    list.sort(function (a, b) { return a[0] - b[0]; });
    var byComp = {};
    for (var k = 0; k < list.length; k++) {
      var comp = grid.comp[list[k][1]];
      if (byComp[comp]) continue;
      var cc = cellCenter(grid, list[k][1]), blocked = false;
      for (var b = 0; b < blockers.length; b++) if (segmentHitsRect(p, cc, blockers[b])) { blocked = true; break; }
      if (!blocked) byComp[comp] = { idx: list[k][1], dist: list[k][0] };
    }
    return byComp;
  }

  // 半直線（光線）が障害物・壁に当たるまでの距離
  function rayDist(grid, ox, oy, dx, dy) {
    var t = CONFIG.WIDTH_RAY_MAX, room = grid.room;
    if (dx > 1e-9) t = Math.min(t, (room.width - ox) / dx);
    if (dx < -1e-9) t = Math.min(t, -ox / dx);
    if (dy > 1e-9) t = Math.min(t, (room.depth - oy) / dy);
    if (dy < -1e-9) t = Math.min(t, -oy / dy);
    for (var k = 0; k < grid.obstacles.length; k++) {
      var r = grid.obstacles[k], tmin = 0, tmax = t, ok = true;
      var o = [ox, oy], dd = [dx, dy], lo = [r.x, r.y], hi = [r.x + r.w, r.y + r.h];
      for (var a = 0; a < 2 && ok; a++) {
        if (Math.abs(dd[a]) < 1e-9) { if (o[a] <= lo[a] || o[a] >= hi[a]) ok = false; }
        else {
          var t1 = (lo[a] - o[a]) / dd[a], t2 = (hi[a] - o[a]) / dd[a];
          if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) ok = false;
        }
      }
      if (ok && tmin < t) t = tmin;
    }
    return Math.max(0, t);
  }
  function widthClass(w) {
    if (w >= CONFIG.WIDTH_GREEN) return "green";
    if (w >= CONFIG.WIDTH_YELLOW) return "yellow";
    return "red";
  }

  // 2点間の経路を求める
  function findRoute(grid, p, q) {
    var A = connectCandidates(grid, p), B = connectCandidates(grid, q), best = null;
    Object.keys(A).forEach(function (comp) {
      if (!B[comp]) return;
      var res = astar(grid, A[comp].idx, B[comp].idx);
      if (!res) return;
      var len = A[comp].dist + res.length + B[comp].dist;
      if (!best || len < best.length) best = { length: len, cells: res.cells, connStart: A[comp].dist, connEnd: B[comp].dist };
    });
    if (!best) return { found: false, from: p, to: q, length: 0 };
    // 方眼の折れ線（地点が通れるマスにあるときは、地点そのものを端にする）
    var pts = best.cells.map(function (idx) { return cellCenter(grid, idx); });
    var sIn = best.connStart === 0, eIn = best.connEnd === 0;
    if (sIn) pts[0] = { x: p.x, y: p.y };
    if (eIn) { if (pts.length === 1 && sIn) pts.push({ x: q.x, y: q.y }); else pts[pts.length - 1] = { x: q.x, y: q.y }; }
    var line = smoothPath(grid, pts);
    var len = 0;
    for (var k = 1; k < line.length; k++) len += Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y);
    var connStart = sIn ? 0 : Math.hypot(line[0].x - p.x, line[0].y - p.y);
    var connEnd = eIn ? 0 : Math.hypot(line[line.length - 1].x - q.x, line[line.length - 1].y - q.y);
    // 通路幅：折れ線の上を 1マスごとに測る（地点とつなぐ直線部分は測らない）
    var samples = [];
    for (var s = 1; s < line.length; s++) {
      var a = line[s - 1], b = line[s], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      var n = Math.max(1, Math.round(L / grid.G));
      for (var t = (s === 1 ? 0 : 1); t <= n; t++) {
        var x = a.x + dx * t / n, y = a.y + dy * t / n, w;
        if (CONFIG.WIDTH_METHOD === "nearest") {
          var ci = cellIndexAt(grid, { x: x, y: y });
          w = ci >= 0 ? grid.clear[ci] * 2 : 0;
        } else {
          var px = -dy / L, py = dx / L; // 進行方向に直角な向き
          w = rayDist(grid, x, y, px, py) + rayDist(grid, x, y, -px, -py);
        }
        samples.push({ x: x, y: y, width: w, cls: widthClass(w) });
      }
    }
    if (!samples.length) samples.push({ x: line[0].x, y: line[0].y, width: Infinity, cls: "green" });
    var minW = Infinity;
    samples.forEach(function (c) { if (c.width < minW) minW = c.width; });
    return {
      found: true, from: p, to: q, length: connStart + len + connEnd,
      line: line, samples: samples, connStart: connStart, connEnd: connEnd,
      minWidth: minW, red: minW < CONFIG.WIDTH_YELLOW
    };
  }

  // ===== 全体の計算 =====
  function createContext(data) {
    var pairs = pairChairs(data), cache = {}, stopPos = {};
    data.stops.forEach(function (s) { stopPos[s.id] = stopPosition(s, data); });
    return {
      data: data, pairs: pairs, stopPos: stopPos,
      grid: function (excl) {
        var key = (data.settings.workMode ? excl.slice().sort().join(",") : "");
        if (!cache[key]) cache[key] = buildGrid(data, data.settings.workMode ? excl : []);
        return cache[key];
      }
    };
  }
  function stopById(data, id) {
    for (var i = 0; i < data.stops.length; i++) if (data.stops[i].id === id) return data.stops[i];
    return null;
  }
  function desksForStop(ctx, stop) {
    return stop && stop.attachedTo ? desksForEntity(ctx.data, stop.attachedTo, ctx.pairs) : [];
  }
  function routeBetween(ctx, p, q, desks) {
    return findRoute(ctx.grid(desks), p, q);
  }

  // しまう場所の位置：その物に紐づいた地点、なければ正面の中央から手前【仮定】
  function storagePoint(ctx, entId) {
    var data = ctx.data;
    for (var i = 0; i < data.stops.length; i++) {
      var s = data.stops[i];
      if (s.attachedTo === entId && ctx.stopPos[s.id]) return { p: ctx.stopPos[s.id], desks: desksForStop(ctx, s) };
    }
    var ent = findEntity(data, entId);
    if (!ent) return null;
    var p = entityPoint(ent, data);
    return p ? { p: p, desks: desksForEntity(data, entId, ctx.pairs) } : null;
  }

  // 片付けチェック
  function clutterCheck(ctx) {
    var data = ctx.data, warnings = [];
    data.things.forEach(function (t, ti) {
      if (t.frequency !== "daily") return;
      var sp = storagePoint(ctx, t.storedIn);
      if (!sp) { warnings.push({ index: ti, thing: t.name, reason: "しまう場所が見つかりません" }); return; }
      var best = null;
      (t.usedAt || []).forEach(function (sid) {
        var st = stopById(data, sid), q = ctx.stopPos[sid];
        if (!st || !q) return;
        var r = routeBetween(ctx, sp.p, q, sp.desks.concat(desksForStop(ctx, st)));
        if (r.found && (!best || r.length < best.length)) best = { length: r.length, stop: st.name };
      });
      if (!best) warnings.push({ index: ti, thing: t.name, reason: "使う場所まで通れません" });
      else if (best.length >= CONFIG.CLUTTER_WARN) {
        warnings.push({ index: ti, thing: t.name, distance: best.length, stop: best.stop,
          reason: "使う場所（" + best.stop + "）まで " + (best.length / 100).toFixed(1) + "m あります" });
      }
    });
    return warnings;
  }

  // 1日の動きをすべて計算する
  function evaluate(data, opts) {
    opts = opts || {};
    var ctx = createContext(data);
    var routes = data.routines.map(function (r, i) {
      var a = stopById(data, r.from), b = stopById(data, r.to);
      var p = a && ctx.stopPos[a.id], q = b && ctx.stopPos[b.id];
      if (!p || !q) return { index: i, found: false, length: 0, times: r.timesPerDay, error: "地点が見つかりません", from: p, to: q };
      var res = routeBetween(ctx, p, q, desksForStop(ctx, a).concat(desksForStop(ctx, b)));
      res.index = i; res.times = r.timesPerDay;
      res.fromName = a.name; res.toName = b.name;
      return res;
    });
    var total = 0, allFound = true, hasRed = false;
    routes.forEach(function (r) {
      if (r.found) total += r.length * r.times;
      else allFound = false;
      if (r.found && r.red) hasRed = true;
    });
    return {
      routes: routes, total: total, allFound: allFound, hasRed: hasRed,
      stopPos: ctx.stopPos, zones: workZones(data), pairs: ctx.pairs,
      clutter: opts.clutter === false ? [] : clutterCheck(ctx)
    };
  }

  // ===== 改善提案 =====
  function pairedChairOf(pairs, deskId) {
    var ids = Object.keys(pairs);
    for (var i = 0; i < ids.length; i++) if (pairs[ids[i]] === deskId) return ids[i];
    return null;
  }
  function positions(max, step) {
    var out = [];
    if (max < 0) return out;
    for (var v = 0; v <= max + 1e-9; v += step) out.push(v);
    if (out[out.length - 1] !== max) out.push(max);
    return out;
  }
  // 固定でない家具を、壁沿いの候補位置（0度・90度）に置いた案を作る
  function makeCandidates(data) {
    var W = data.room.width, D = data.room.depth, step = CONFIG.SUGGEST_STEP, out = [];
    data.items.forEach(function (it) {
      if (it.fixed || it.type === "chair") return; // 椅子は机と一緒に動かす
      var dims = [[it.w, it.h]];
      if (it.w !== it.h) dims.push([it.h, it.w]);
      dims.forEach(function (wh) {
        var w = wh[0], h = wh[1], rotated = w !== it.w;
        function add(x, y, front, wall) {
          if (x === it.x && y === it.y && w === it.w && h === it.h && front === it.frontSide) return;
          out.push({ itemId: it.id, x: x, y: y, w: w, h: h, frontSide: front, wall: wall, rotated: rotated });
        }
        positions(W - w, step).forEach(function (x) { add(x, 0, "bottom", "top"); add(x, D - h, "top", "bottom"); });
        positions(D - h, step).forEach(function (y) { add(0, y, "right", "left"); add(W - w, y, "left", "right"); });
      });
    });
    return out;
  }
  // 案どおりに動かしたデータを作る（机の前の椅子も一緒に動かす）
  function applyCandidate(data, cand, pairs) {
    pairs = pairs || pairChairs(data);
    var nd = clone(data);
    var it = nd.items.filter(function (o) { return o.id === cand.itemId; })[0];
    if (!it) return nd;
    it.x = cand.x; it.y = cand.y; it.w = cand.w; it.h = cand.h; it.frontSide = cand.frontSide;
    var chairId = it.type === "desk" ? pairedChairOf(pairs, it.id) : null;
    if (chairId) {
      var ch = nd.items.filter(function (o) { return o.id === chairId; })[0];
      switch (it.frontSide) {
        case "top": ch.x = snap(it.x + it.w / 2 - ch.w / 2); ch.y = it.y - ch.h; break;
        case "left": ch.x = it.x - ch.w; ch.y = snap(it.y + it.h / 2 - ch.h / 2); break;
        case "right": ch.x = it.x + it.w; ch.y = snap(it.y + it.h / 2 - ch.h / 2); break;
        default: ch.x = snap(it.x + it.w / 2 - ch.w / 2); ch.y = it.y + it.h;
      }
      ch.frontSide = OPPOSITE[it.frontSide];
    }
    return nd;
  }
  // 採用できる置き方か（重なり・ドア・正面の空き）。経路の条件は evaluate で見る
  function checkPlacement(nd, cand, pairs) {
    pairs = pairs || {};
    var it = nd.items.filter(function (o) { return o.id === cand.itemId; })[0];
    var moved = [it];
    var chairId = it.type === "desk" ? pairedChairOf(pairs, it.id) : null;
    if (chairId) moved.push(nd.items.filter(function (o) { return o.id === chairId; })[0]);
    var movedIds = moved.map(function (m) { return m.id; });
    var others = nd.items.filter(function (o) { return !has(movedIds, o.id); });
    var rectFix = nd.fixtures.filter(isRectFixture);
    var fans = doorFans(nd);
    for (var i = 0; i < moved.length; i++) {
      var m = moved[i];
      if (!insideRoom(m, nd.room)) return { ok: false, reason: "部屋の外にはみ出します" };
      for (var k = 0; k < others.length; k++) if (rectsOverlap(m, others[k])) return { ok: false, reason: "ほかの家具と重なります" };
      for (var f = 0; f < rectFix.length; f++) if (rectsOverlap(m, rectFix[f])) return { ok: false, reason: "設備と重なります" };
      for (var d = 0; d < fans.length; d++) if (rectHitsFan(m, fans[d])) return { ok: false, reason: "ドアの開く範囲に入ります" };
    }
    if (!has(NO_FRONT_CHECK_TYPES, it.type)) {
      var fz = frontZone(it, it.frontSide, CONFIG.FRONT_CLEAR);
      if (!insideRoom(fz, nd.room)) return { ok: false, reason: "正面の前の空きが足りません（壁を向いています）" };
      for (var o = 0; o < others.length; o++) if (rectsOverlap(fz, others[o])) return { ok: false, reason: "正面の前に家具があります" };
      for (var g = 0; g < rectFix.length; g++) if (rectsOverlap(fz, rectFix[g])) return { ok: false, reason: "正面の前に設備があります" };
    }
    return { ok: true };
  }
  function describeCandidate(data, cand, gain) {
    var it = data.items.filter(function (o) { return o.id === cand.itemId; })[0];
    var where = (cand.wall === "top" || cand.wall === "bottom") ? "x=" + cand.x : "y=" + cand.y;
    return it.name + "を" + WALL_JA[cand.wall] + "の壁 " + where + " へ" + (cand.rotated ? "（90度回転）" : "") +
      " → 1日 −" + (gain / 100).toFixed(1) + "m";
  }
  // 少しずつ計算できる提案の作り手（画面が固まらないように）
  function createSuggester(data) {
    var base = evaluate(data, { clutter: false });
    var pairs = pairChairs(data);
    var cands = makeCandidates(data), pos = 0, best = {};
    return {
      base: base,
      total: cands.length,
      get position() { return pos; },
      get done() { return pos >= cands.length; },
      step: function (n) {
        var end = Math.min(cands.length, pos + n);
        for (; pos < end; pos++) {
          var c = cands[pos];
          var nd = applyCandidate(data, c, pairs);
          if (!checkPlacement(nd, c, pairs).ok) continue;
          var ev = evaluate(nd, { clutter: false });
          if (!ev.allFound || ev.hasRed) continue;
          var gain = base.total - ev.total;
          if (gain < CONFIG.SUGGEST_MIN_GAIN) continue;
          if (!best[c.itemId] || gain > best[c.itemId].gain) {
            best[c.itemId] = { candidate: c, gain: gain, total: ev.total, data: nd, text: describeCandidate(data, c, gain) };
          }
        }
        return pos;
      },
      results: function () {
        return Object.keys(best).map(function (k) { return best[k]; })
          .sort(function (a, b) { return b.gain - a.gain; })
          .slice(0, CONFIG.SUGGEST_TOP);
      }
    };
  }
  function suggest(data) {
    var s = createSuggester(data);
    s.step(Infinity);
    return s.results();
  }

  // ===== 射影変換（4点の対応から画像の歪みを直す） =====
  // src の4点を dst の4点へ移す 3×3 行列（9個の数）を求める
  function computeHomography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var h = solveLinear(A, b);
    if (!h) return null;
    h.push(1);
    return h;
  }
  // 連立一次方程式を解く（ガウスの消去法）
  function solveLinear(A, b) {
    var n = b.length, M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null; // 4点が一直線などで解けない
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c) continue;
        var f = M[r2][c] / M[c][c];
        if (f === 0) continue;
        for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
      }
    }
    return M.map(function (row, i) { return row[n] / row[i]; });
  }
  function applyHomography(H, p) {
    var w = H[6] * p.x + H[7] * p.y + H[8];
    return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w, w: w };
  }

  return {
    CONFIG: CONFIG, SIDES: SIDES, ITEM_TYPES: ITEM_TYPES, FIXTURE_TYPES: FIXTURE_TYPES,
    WALL_FIXTURE_TYPES: WALL_FIXTURE_TYPES, RECT_FIXTURE_TYPES: RECT_FIXTURE_TYPES, FREQUENCIES: FREQUENCIES,
    WALL_JA: WALL_JA, TYPE_JA: TYPE_JA, FIXTURE_JA: FIXTURE_JA,
    clone: clone, snap: snap, clamp: clamp, rectsOverlap: rectsOverlap,
    normalizeData: normalizeData, newEmptyData: newEmptyData, makeId: makeId,
    findEntity: findEntity, isRectFixture: isRectFixture, isWallFixture: isWallFixture,
    rotateItem: rotateItem, clampToRoom: clampToRoom, frontPoint: frontPoint, frontZone: frontZone,
    wallSegment: wallSegment, doorFan: doorFan, doorFans: doorFans, rectHitsFan: rectHitsFan,
    stopPosition: stopPosition, pairChairs: pairChairs, workZones: workZones,
    buildGrid: buildGrid, astar: astar, findRoute: findRoute, evaluate: evaluate,
    makeCandidates: makeCandidates, applyCandidate: applyCandidate, checkPlacement: checkPlacement,
    createSuggester: createSuggester, suggest: suggest,
    computeHomography: computeHomography, applyHomography: applyHomography
  };
})();

// Node.js（テスト）から読めるように書き出す
if (typeof module !== "undefined" && module.exports) module.exports = RoomLogic;
