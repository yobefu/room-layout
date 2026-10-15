/*
 * app.js — 画面の操作・描画・保存
 * 計算は logic.js（RoomLogic）、取り込みは import.js（Importer / Modal）に任せる。
 */
(function () {
  "use strict";
  var L = RoomLogic;

  // ===== 調整用の定数 =====
  var STORAGE_KEY = "roomLayout.v1";   // localStorage（ブラウザ内の保存場所）の名前
  var SAVE_DELAY_MS = 400;             // 変更してから保存するまでの待ち時間
  var STORAGE_WARN_BYTES = 4.5 * 1024 * 1024; // 保存容量の警告の目安（約5MBが上限のため）
  var PLAN_MARGIN = 30;                // 間取り図の周りの余白（cm）
  var SUGGEST_SLICE_MS = 30;           // 提案の計算を1回に続ける時間（画面が固まらないように）
  var DEFAULT_SIZES = { desk: [100, 60], chair: [50, 50], shelf: [80, 40], bed: [100, 200], cushion: [60, 60], other: [60, 60] };
  var ITEM_COLORS = { desk: "#d8b48c", chair: "#a9c8e6", shelf: "#c4bba9", bed: "#dccbea", cushion: "#f3c9b8", other: "#d4d4d4" };
  var WIDTH_COLORS = { green: "#2e9d5b", yellow: "#e0b100", red: "#d64541" };
  var SIDE_JA = { top: "上", right: "右", bottom: "下", left: "左" };
  var FREQ_JA = { daily: "毎日", weekly: "毎週", monthly: "毎月" };

  // ===== 状態 =====
  var state = {
    data: null,
    sel: null,          // 選んでいる物 { kind: "item"|"fixture"|"stop"|"underlay", id }
    tab: "layout",
    tool: null,         // "trace"（なぞって家具を追加） | "underlay"（下絵を動かす）
    result: null,       // 計算結果
    preview: null,      // プレビュー中の提案
    previewResult: null,
    suggester: null,
    suggestions: null,
    drag: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var svg = $("plan"), panel = $("panel");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var toastTimer = 0;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  function fmtM(cm) { return (cm / 100).toFixed(1) + "m"; }

  // ===== 保存 =====
  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return L.normalizeData(JSON.parse(raw));
    } catch (e) { /* 読めなければ無視 */ }
    return null;
  }
  var saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }
  function saveNow() {
    try {
      var s = JSON.stringify(state.data);
      localStorage.setItem(STORAGE_KEY, s);
      if (s.length * 2 > STORAGE_WARN_BYTES) toast("保存容量が上限に近づいています。下絵を減らすか、JSON に書き出してください");
    } catch (e) {
      toast("保存できませんでした（容量オーバーの可能性）。下絵を減らすか、JSON に書き出してください");
    }
  }
  function storageSize() {
    try { return JSON.stringify(state.data).length * 2; } catch (e) { return 0; }
  }

  // ===== 変更の反映 =====
  function recompute() { state.result = L.evaluate(state.data); }
  // データを変えたら呼ぶ：再計算・描画・保存
  function commit(opts) {
    opts = opts || {};
    state.preview = null;
    stopSuggest();
    state.suggestions = null;
    recompute();
    renderPlan();
    renderScore();
    if (opts.panel !== false) renderPanel(); else renderTabs();
    scheduleSave();
  }
  function setData(d, msg) {
    state.data = L.normalizeData(d);
    state.sel = null;
    setTool(null, true);
    $("workMode").checked = state.data.settings.workMode;
    commit();
    if (msg) toast(msg);
  }

  // ===== 間取り図の描画（SVG） =====
  function n1(v) { return Math.round(v * 10) / 10; }
  function renderPlan() {
    var d = state.preview ? state.preview.data : state.data;
    var res = state.preview ? state.previewResult : state.result;
    var W = d.room.width, D = d.room.depth, M = PLAN_MARGIN;
    svg.setAttribute("viewBox", [-M, -M, W + 2 * M, D + 2 * M].join(" "));
    svg.style.setProperty("--plan-ratio", ((W + 2 * M) / (D + 2 * M)).toFixed(3));
    var h = [];
    h.push('<defs>' +
      '<pattern id="gMinor" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#e9e6df" stroke-width="0.5"/></pattern>' +
      '<pattern id="gMajor" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#gMinor)"/><path d="M50 0H0V50" fill="none" stroke="#d9d4ca" stroke-width="0.8"/></pattern>' +
      '<pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#9a958c"/><line x1="0" y1="0" x2="0" y2="8" stroke="#77736b" stroke-width="3"/></pattern>' +
      '</defs>');
    // 床
    h.push('<rect x="0" y="0" width="' + W + '" height="' + D + '" fill="#fbfaf7"/>');
    // 下絵
    d.underlays.forEach(function (u) {
      if (!u.visible || !u.src) return;
      h.push('<image href="' + esc(u.src) + '" x="' + u.x + '" y="' + u.y + '" width="' + u.w + '" height="' + u.h +
        '" opacity="' + u.opacity + '" preserveAspectRatio="none"' +
        (state.sel && state.sel.kind === "underlay" && state.sel.id === u.id && state.tool === "underlay" ? ' style="outline:2px solid #2f6f6a"' : "") + "/>");
    });
    // 方眼
    h.push('<rect x="0" y="0" width="' + W + '" height="' + D + '" fill="url(#gMajor)" opacity="0.9" pointer-events="none"/>');
    // 作業中モードの「椅子を引いて座る範囲」
    (res ? res.zones : []).forEach(function (z) {
      h.push('<rect x="' + z.x + '" y="' + z.y + '" width="' + z.w + '" height="' + z.h +
        '" fill="rgba(224,140,40,0.12)" stroke="#e08c28" stroke-width="1" stroke-dasharray="4 3" pointer-events="none"/>');
      h.push('<text x="' + (z.x + z.w / 2) + '" y="' + (z.y + z.h - 4) + '" font-size="7" fill="#b86b14" text-anchor="middle" pointer-events="none">椅子の範囲</text>');
    });
    // 壁（部屋の外枠）
    h.push('<rect x="-3" y="-3" width="' + (W + 6) + '" height="' + (D + 6) + '" fill="none" stroke="#4a4a4a" stroke-width="6"/>');
    // 壁に付く設備・四角の設備
    d.fixtures.forEach(function (f) { h.push(fixtureSvg(f, d)); });
    // 家具
    d.items.forEach(function (it) { h.push(itemSvg(it)); });
    // プレビュー：元の位置を点線で
    if (state.preview) {
      state.data.items.forEach(function (o) {
        var n = d.items.filter(function (x) { return x.id === o.id; })[0];
        if (n && (n.x !== o.x || n.y !== o.y || n.w !== o.w || n.h !== o.h)) {
          h.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h +
            '" fill="none" stroke="#888" stroke-width="1.2" stroke-dasharray="4 3" pointer-events="none"/>');
        }
      });
    }
    // 経路
    if (res) res.routes.forEach(function (r) { h.push(routeSvg(r)); });
    // 地点
    d.stops.forEach(function (s) {
      var p = res && res.stopPos[s.id];
      if (!p) return;
      var free = !s.attachedTo, sel = isSel("stop", s.id);
      h.push('<g data-kind="stop" data-id="' + esc(s.id) + '"' + (free ? ' style="cursor:move"' : "") + ">" +
        '<circle cx="' + n1(p.x) + '" cy="' + n1(p.y) + '" r="' + (sel ? 7 : 5.5) + '" fill="#fff" stroke="#2f6f6a" stroke-width="' + (sel ? 3 : 2) + '"/>' +
        '<text x="' + n1(p.x) + '" y="' + n1(p.y - 9) + '" font-size="8" text-anchor="middle" fill="#1f4f4b" stroke="#fff" stroke-width="2.5" paint-order="stroke">' + esc(s.name) + "</text></g>");
    });
    // なぞり中の四角
    if (state.drag && state.drag.type === "trace" && state.drag.cur) {
      var t = traceRect(state.drag);
      h.push('<rect x="' + t.x + '" y="' + t.y + '" width="' + t.w + '" height="' + t.h +
        '" fill="rgba(47,111,106,0.15)" stroke="#2f6f6a" stroke-width="1.5" stroke-dasharray="5 3"/>' +
        '<text x="' + (t.x + t.w / 2) + '" y="' + (t.y + t.h / 2) + '" font-size="9" text-anchor="middle" fill="#1f4f4b">' + t.w + "×" + t.h + "</text>");
    }
    svg.innerHTML = h.join("");
    $("previewBar").hidden = !state.preview;
    if (state.preview) $("previewText").textContent = "プレビュー中：" + state.preview.text;
  }
  function isSel(kind, id) { return !!(state.sel && state.sel.kind === kind && state.sel.id === id); }

  function itemSvg(it) {
    var sel = isSel("item", it.id), moved = state.preview && state.preview.data.items.indexOf(it) >= 0 && isMovedInPreview(it);
    var s = '<g data-kind="item" data-id="' + esc(it.id) + '" style="cursor:move"' + (moved ? ' opacity="0.6"' : "") + ">";
    s += '<rect x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '" rx="' + (it.type === "cushion" ? Math.min(it.w, it.h) / 2 : 2) +
      '" fill="' + (ITEM_COLORS[it.type] || ITEM_COLORS.other) + '" stroke="' + (sel ? "#2f6f6a" : (moved ? "#b7791f" : "#6b6459")) +
      '" stroke-width="' + (sel ? 3 : 1) + '"' + (moved ? ' stroke-dasharray="5 3"' : "") + "/>";
    // 正面（使う側）を太線で示す
    if (it.type !== "cushion") {
      var f = frontLine(it);
      s += '<line x1="' + f[0] + '" y1="' + f[1] + '" x2="' + f[2] + '" y2="' + f[3] + '" stroke="#3b3326" stroke-width="3" stroke-linecap="round"/>';
    }
    var fs = Math.max(6, Math.min(10, it.w / 4, it.h / 2.2));
    s += '<text x="' + (it.x + it.w / 2) + '" y="' + (it.y + it.h / 2) + '" font-size="' + fs + '" text-anchor="middle" dominant-baseline="middle" fill="#2b2620">' + esc(it.name) + "</text>";
    if (it.fixed) s += '<text x="' + (it.x + 3) + '" y="' + (it.y + 10) + '" font-size="9">🔒</text>';
    return s + "</g>";
  }
  function isMovedInPreview(it) {
    var o = state.data.items.filter(function (x) { return x.id === it.id; })[0];
    return !!o && (o.x !== it.x || o.y !== it.y || o.w !== it.w || o.h !== it.h);
  }
  function frontLine(r) {
    var i = 1.5;
    switch (r.frontSide) {
      case "top": return [r.x + i, r.y + i, r.x + r.w - i, r.y + i];
      case "left": return [r.x + i, r.y + i, r.x + i, r.y + r.h - i];
      case "right": return [r.x + r.w - i, r.y + i, r.x + r.w - i, r.y + r.h - i];
      default: return [r.x + i, r.y + r.h - i, r.x + r.w - i, r.y + r.h - i];
    }
  }
  function fixtureSvg(f, d) {
    var sel = isSel("fixture", f.id), s = '<g data-kind="fixture" data-id="' + esc(f.id) + '">';
    if (L.isRectFixture(f)) {
      s += '<rect x="' + f.x + '" y="' + f.y + '" width="' + f.w + '" height="' + f.h + '" fill="url(#hatch)" stroke="' + (sel ? "#2f6f6a" : "#555") + '" stroke-width="' + (sel ? 3 : 1) + '"/>';
      s += '<text x="' + (f.x + f.w / 2) + '" y="' + (f.y + f.h / 2) + '" font-size="' + Math.max(6, Math.min(9, f.w / 4)) +
        '" text-anchor="middle" dominant-baseline="middle" fill="#fff" stroke="#555" stroke-width="2" paint-order="stroke">' + esc(f.name) + "</text>";
      if (f.locked) s += '<text x="' + (f.x + 2) + '" y="' + (f.y + 10) + '" font-size="9">🔒</text>';
      return s + "</g>";
    }
    if (!L.isWallFixture(f)) return "";
    var w = L.wallSegment(f, d.room), out = 3; // 壁の線の中心に描く
    var x1 = w.x1 - w.nx * out, y1 = w.y1 - w.ny * out, x2 = w.x2 - w.nx * out, y2 = w.y2 - w.ny * out;
    var hl = sel ? ' stroke-opacity="1"' : "";
    if (f.type === "door") {
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#fbfaf7" stroke-width="7"/>';
      var fan = L.doorFan(f, d.room);
      if (fan) {
        var pa = fan.vertical ? [fan.cx, fan.cy + fan.sy * fan.r] : [fan.cx + fan.sx * fan.r, fan.cy];
        var po = fan.vertical ? [fan.cx + fan.sx * fan.r, fan.cy] : [fan.cx, fan.cy + fan.sy * fan.r];
        var ax = pa[0] - fan.cx, ay = pa[1] - fan.cy, bx = po[0] - fan.cx, by = po[1] - fan.cy;
        var sweep = (ax * by - ay * bx) > 0 ? 1 : 0;
        s += '<path d="M' + fan.cx + " " + fan.cy + "L" + pa[0] + " " + pa[1] + "A" + fan.r + " " + fan.r + " 0 0 " + sweep + " " + po[0] + " " + po[1] +
          'Z" fill="rgba(47,111,106,0.08)" stroke="#2f6f6a" stroke-width="' + (sel ? 2 : 1) + '" stroke-dasharray="4 3"/>';
        s += '<line x1="' + fan.cx + '" y1="' + fan.cy + '" x2="' + po[0] + '" y2="' + po[1] + '" stroke="#2f6f6a" stroke-width="2.5"/>';
      } else {
        s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#2f6f6a" stroke-width="2" stroke-dasharray="3 3"/>';
      }
      // 選びやすくするための透明な太線
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="transparent" stroke-width="14"/>';
    } else if (f.type === "window") {
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#bfe0f5" stroke-width="7"' + hl + "/>";
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + (sel ? "#2f6f6a" : "#5aa0cc") + '" stroke-width="' + (sel ? 2.5 : 1.2) + '"/>';
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="transparent" stroke-width="14"/>';
    } else {
      var mx = (w.x1 + w.x2) / 2 + w.nx * 4, my = (w.y1 + w.y2) / 2 + w.ny * 4;
      s += '<rect x="' + (mx - 5) + '" y="' + (my - 5) + '" width="10" height="10" rx="2" fill="#f6b73c" stroke="' + (sel ? "#2f6f6a" : "#8a6516") + '" stroke-width="' + (sel ? 2.5 : 1) + '"/>';
      s += '<text x="' + mx + '" y="' + (my + 0.5) + '" font-size="7" text-anchor="middle" dominant-baseline="middle">⚡</text>';
    }
    return s + "</g>";
  }
  function routeSvg(r) {
    if (!r.from || !r.to) return "";
    if (!r.found) {
      var mx = (r.from.x + r.to.x) / 2, my = (r.from.y + r.to.y) / 2;
      return '<line x1="' + n1(r.from.x) + '" y1="' + n1(r.from.y) + '" x2="' + n1(r.to.x) + '" y2="' + n1(r.to.y) +
        '" stroke="#d64541" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>' +
        '<text x="' + n1(mx) + '" y="' + n1(my) + '" font-size="9" text-anchor="middle" fill="#d64541" stroke="#fff" stroke-width="3" paint-order="stroke" pointer-events="none">通れません</text>';
    }
    var s = '<g pointer-events="none" stroke-linecap="round">';
    var a = r.line[0], b = r.line[r.line.length - 1];
    if (r.connStart > 0) s += '<line x1="' + n1(r.from.x) + '" y1="' + n1(r.from.y) + '" x2="' + n1(a.x) + '" y2="' + n1(a.y) + '" stroke="#888" stroke-width="1.5" stroke-dasharray="3 3"/>';
    if (r.connEnd > 0) s += '<line x1="' + n1(b.x) + '" y1="' + n1(b.y) + '" x2="' + n1(r.to.x) + '" y2="' + n1(r.to.y) + '" stroke="#888" stroke-width="1.5" stroke-dasharray="3 3"/>';
    for (var i = 1; i < r.samples.length; i++) {
      var p = r.samples[i - 1], q = r.samples[i];
      // 区間の色は、両端のうち狭いほうに合わせる
      var cls = p.width < q.width ? p.cls : q.cls;
      s += '<line x1="' + n1(p.x) + '" y1="' + n1(p.y) + '" x2="' + n1(q.x) + '" y2="' + n1(q.y) + '" stroke="' + WIDTH_COLORS[cls] + '" stroke-width="3.5" opacity="0.85"/>';
    }
    return s + "</g>";
  }

  function renderScore() {
    var res = state.preview ? state.previewResult : state.result, el = $("score");
    if (!res) { el.textContent = "1日の移動距離 —"; return; }
    var txt = "1日の移動距離 " + fmtM(res.total);
    if (!res.allFound) txt += "（通れないルートあり）";
    if (state.preview) txt += "（" + "−" + fmtM(state.preview.gain) + "）";
    el.textContent = txt;
    el.style.color = res.allFound ? "" : "#c0392b";
  }

  // ===== 間取り図の操作（マウス・指・ペンをまとめて Pointer Events で扱う） =====
  function svgPoint(e) {
    var pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function traceRect(dr) {
    var a = dr.start, b = dr.cur;
    var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function snapIn(p) {
    var r = state.data.room;
    return { x: L.clamp(L.snap(p.x), 0, r.width), y: L.clamp(L.snap(p.y), 0, r.depth) };
  }
  // 指やマウスが図の外に出ても、ドラッグを続けられるようにする
  function capture(e) {
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても続ける */ }
  }
  var frame = 0;
  function scheduleFrame() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      recompute(); renderPlan(); renderScore();
    });
  }
  svg.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button > 0) return;
    if (state.preview) { toast("プレビュー中です。「採用」か「戻す」を選んでください"); return; }
    var p = svgPoint(e);
    if (state.tool === "trace") {
      state.drag = { type: "trace", start: snapIn(p), cur: null, pointerId: e.pointerId };
      capture(e);
      e.preventDefault();
      return;
    }
    if (state.tool === "underlay") {
      var u = selectedUnderlay();
      if (u) {
        state.drag = { type: "underlay", obj: u, sx: p.x, sy: p.y, ox: u.x, oy: u.y, moved: false };
        capture(e);
      }
      e.preventDefault();
      return;
    }
    var g = e.target.closest ? e.target.closest("[data-kind]") : null;
    if (!g) { select(null); return; }
    var kind = g.getAttribute("data-kind"), id = g.getAttribute("data-id"), obj = null;
    select({ kind: kind, id: id });
    if (kind === "item") obj = findIn(state.data.items, id);
    else if (kind === "fixture") {
      var f = findIn(state.data.fixtures, id);
      if (f && L.isRectFixture(f)) {
        if (f.locked) toast("「" + f.name + "」はロック中です。設備タブで「ロック解除」すると動かせます");
        else obj = f;
      } else if (f) toast("壁の設備は、設備タブの数値で位置を変えます");
    } else if (kind === "stop") {
      var s = findIn(state.data.stops, id);
      if (s && !s.attachedTo) obj = s;
    }
    if (obj) {
      state.drag = { type: kind, obj: obj, sx: p.x, sy: p.y, ox: obj.x, oy: obj.y, moved: false };
      capture(e);
    }
    e.preventDefault();
  });
  svg.addEventListener("pointermove", function (e) {
    var dr = state.drag;
    if (!dr) return;
    var p = svgPoint(e), room = state.data.room;
    if (dr.type === "trace") { dr.cur = snapIn(p); scheduleFrame(); return; }
    var nx = dr.ox + (p.x - dr.sx), ny = dr.oy + (p.y - dr.sy);
    if (dr.type !== "underlay") { nx = L.snap(nx); ny = L.snap(ny); }
    if (dr.type === "item" || dr.type === "fixture") {
      nx = L.clamp(nx, 0, Math.max(0, room.width - dr.obj.w));
      ny = L.clamp(ny, 0, Math.max(0, room.depth - dr.obj.h));
    } else if (dr.type === "stop") {
      nx = L.clamp(nx, 0, room.width); ny = L.clamp(ny, 0, room.depth);
    }
    if (nx !== dr.obj.x || ny !== dr.obj.y) {
      dr.obj.x = nx; dr.obj.y = ny; dr.moved = true;
      if (state.suggestions || state.suggester) { stopSuggest(); state.suggestions = null; }
      scheduleFrame();
    }
  });
  function endDrag() {
    var dr = state.drag;
    if (!dr) return;
    state.drag = null;
    if (dr.type === "trace") {
      var t = dr.cur ? traceRect(dr) : null;
      renderPlan();
      if (t && t.w >= 10 && t.h >= 10) openTraceDialog(t);
      return;
    }
    if (dr.moved) commit();
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  function findIn(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function selectedUnderlay() {
    var u = state.sel && state.sel.kind === "underlay" ? findIn(state.data.underlays, state.sel.id) : null;
    if (!u) u = state.data.underlays.filter(function (x) { return x.visible; })[0] || null;
    return u;
  }
  // 選んだ物に合わせて、タブも切り替える
  function select(sel) {
    state.sel = sel;
    if (sel) {
      var tabFor = { item: "layout", fixture: "fixtures", stop: "stops", underlay: "import" }[sel.kind];
      if (tabFor && state.tab !== tabFor && state.tab !== "result") state.tab = tabFor;
    }
    renderPlan();
    renderPanel();
  }

  // ===== なぞって家具を追加 =====
  function setTool(tool, silent) {
    state.tool = tool;
    var bar = $("toolBar");
    bar.hidden = !tool;
    if (tool === "trace") $("toolText").textContent = "なぞって家具を追加：下絵の家具の足元を、ドラッグで四角に囲んでください";
    else if (tool === "underlay") $("toolText").textContent = "下絵を動かす：間取り図の上をドラッグすると、選んだ下絵が動きます";
    if (!silent) { renderPlan(); renderPanel(); }
  }
  function openTraceDialog(t) {
    var box = Modal.open(
      "<h2>家具を追加</h2>" +
      '<div class="row">名前 <input type="text" id="trName" value="家具"></div>' +
      '<div class="row">種類 <select id="trType">' + L.ITEM_TYPES.map(function (k) {
        return '<option value="' + k + '"' + (k === "other" ? " selected" : "") + ">" + L.TYPE_JA[k] + "</option>";
      }).join("") + "</select></div>" +
      '<div class="row">正面（使う側） ' + sideSelect("trFront", "bottom") + "</div>" +
      '<p class="help">大きさ：' + t.w + " × " + t.h + " cm、位置：x=" + t.x + " y=" + t.y + "</p>" +
      '<div class="buttons"><button type="button" data-tr="cancel">やめる</button><button type="button" class="primary" data-tr="ok">追加</button></div>',
      { narrow: true });
    var nameEl = box.querySelector("#trName"), typeEl = box.querySelector("#trType");
    typeEl.addEventListener("change", function () {
      if (nameEl.value === "家具" || L.ITEM_TYPES.some(function (k) { return L.TYPE_JA[k] === nameEl.value; })) nameEl.value = L.TYPE_JA[typeEl.value];
    });
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tr]");
      if (!b) return;
      if (b.dataset.tr === "ok") {
        var it = { id: L.makeId(state.data, "item"), name: nameEl.value || "家具", type: typeEl.value,
          x: t.x, y: t.y, w: t.w, h: t.h, fixed: false, frontSide: box.querySelector("#trFront").value };
        state.data.items.push(it);
        state.sel = { kind: "item", id: it.id };
        Modal.close();
        commit();
        toast("「" + it.name + "」を追加しました。続けてなぞれます");
      } else Modal.close();
    });
    nameEl.focus();
    nameEl.select();
  }
  function sideSelect(id, val, spec) {
    return '<select ' + (id ? 'id="' + id + '" ' : "") + (spec ? 'data-f="' + spec + '"' : "") + ">" + L.SIDES.map(function (s) {
      return '<option value="' + s + '"' + (s === val ? " selected" : "") + ">" + SIDE_JA[s] + "</option>";
    }).join("") + "</select>";
  }

  // ===== 右側のタブ =====
  var TABS = ["import", "layout", "fixtures", "stops", "things", "result", "suggest"];
  function renderTabs() {
    var clutter = state.result ? state.result.clutter.length : 0;
    var bad = state.result ? state.result.routes.filter(function (r) { return !r.found; }).length : 0;
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) {
      b.classList.toggle("active", b.dataset.tab === state.tab);
      var old = b.querySelector(".badge");
      if (old) old.remove();
      var n = b.dataset.tab === "result" ? clutter + bad : 0;
      if (n) b.insertAdjacentHTML("beforeend", '<span class="badge">' + n + "</span>");
    });
  }
  function renderPanel() {
    renderTabs();
    var f = { import: panelImport, layout: panelLayout, fixtures: panelFixtures, stops: panelStops, things: panelThings, result: panelResult, suggest: panelSuggest }[state.tab];
    panel.innerHTML = f();
  }
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (!b) return;
    state.tab = b.dataset.tab;
    renderPanel();
  });

  // 入力欄の書き方： data-f="対象|id|項目|型"
  function num(spec, val, attrs) {
    return '<input type="number" data-f="' + spec + '|num" value="' + esc(val) + '" ' + (attrs || "") + ">";
  }
  function text(spec, val, attrs) {
    return '<input type="text" data-f="' + spec + '|text" value="' + esc(val) + '" ' + (attrs || "") + ">";
  }
  function options(list, val) {
    return list.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("");
  }

  // --- 取り込み ---
  function panelImport() {
    var h = "";
    h += '<div class="card main"><div class="title">📷 写真から取り込む（メイン）</div>' +
      '<p class="help">床の上の四角形（部屋の4隅、ラグ、メジャーで測った範囲など）の<b>4つの角</b>が写るように、少し高い位置から撮ってください。' +
      '4つの角を押して大きさを入力すると、真上から見た図に直して下絵にします。</p>' +
      '<div class="row"><button type="button" class="primary big" data-act="img-file" data-kind="photo">写真を選ぶ</button>' +
      '<button type="button" class="big" data-act="img-camera" data-kind="photo">カメラで撮影</button></div></div>';
    h += '<div class="card sub"><div class="title">✏️ 手書き図から取り込む（補助）</div>' +
      '<p class="help">手書きの間取り図の画像を下絵にします。部屋の4隅を押すと、部屋の寸法に合わせて縮尺・傾き・向きをそろえます。</p>' +
      '<div class="row"><button type="button" data-act="img-file" data-kind="sketch">画像を選ぶ</button>' +
      '<button type="button" data-act="img-camera" data-kind="sketch">カメラで撮影</button></div></div>';
    h += "<h3>下絵の一覧</h3>";
    if (!state.data.underlays.length) h += '<p class="help">まだ下絵はありません。</p>';
    else {
      h += '<div class="row"><button type="button" data-act="tool-trace" aria-pressed="' + (state.tool === "trace") + '">なぞって家具を追加</button>' +
        '<button type="button" data-act="tool-underlay" aria-pressed="' + (state.tool === "underlay") + '">下絵をドラッグで動かす</button></div>';
      h += '<ul class="list">';
      state.data.underlays.forEach(function (u) {
        var spec = "underlay|" + u.id;
        h += '<li class="' + (isSel("underlay", u.id) ? "selected" : "") + '">' +
          '<span class="name" data-act="select" data-kind="underlay" data-id="' + esc(u.id) + '">' + esc(u.name) + "（" + (u.kind === "sketch" ? "手書き図" : "写真") + "）</span>" +
          '<label><input type="checkbox" data-f="' + spec + '|visible|bool"' + (u.visible ? " checked" : "") + "> 表示</label>" +
          '<label>濃さ <input type="range" min="0.1" max="1" step="0.05" data-f="' + spec + '|opacity|num" value="' + u.opacity + '"></label>' +
          '<div class="row">x ' + num(spec + "|x", Math.round(u.x)) + " y " + num(spec + "|y", Math.round(u.y)) +
          " 幅 " + num(spec + "|w", Math.round(u.w)) + " 奥行 " + num(spec + "|h", Math.round(u.h)) + "</div>" +
          '<button type="button" class="danger" data-act="del-underlay" data-id="' + esc(u.id) + '">削除</button></li>';
      });
      h += "</ul>";
    }
    var mb = storageSize() / 1024 / 1024;
    h += '<p class="help">保存容量の目安：' + mb.toFixed(1) + " MB ／ 約 5 MB（下絵の画像が容量の大半を使います）</p>";
    return h;
  }

  // --- 間取り ---
  function panelLayout() {
    var d = state.data, h = "";
    h += "<h3>部屋の寸法</h3>";
    h += '<div class="row">幅 ' + num("room||width", d.room.width, 'min="50"') + " cm × 奥行 " + num("room||depth", d.room.depth, 'min="50"') + " cm</div>";
    h += "<h3>家具</h3>";
    h += '<div class="row"><select id="newItemType">' + options(L.ITEM_TYPES.map(function (k) { return [k, L.TYPE_JA[k]]; }), "desk") + "</select>" +
      '<button type="button" data-act="add-item">追加</button>' +
      '<button type="button" data-act="tool-trace" aria-pressed="' + (state.tool === "trace") + '">なぞって追加</button></div>';
    var it = state.sel && state.sel.kind === "item" ? findIn(d.items, state.sel.id) : null;
    if (it) {
      var sp = "item|" + it.id;
      h += '<div class="editor"><div class="row"><b>選択中：</b>' + text(sp + "|name", it.name, 'style="flex:1"') + "</div>" +
        '<div class="row">種類 <select data-f="' + sp + '|type|text">' + options(L.ITEM_TYPES.map(function (k) { return [k, L.TYPE_JA[k]]; }), it.type) + "</select>" +
        " 正面 " + sideSelect(null, it.frontSide, sp + "|frontSide|text") + "</div>" +
        '<div class="row">幅 ' + num(sp + "|w", it.w, 'min="10"') + " 奥行 " + num(sp + "|h", it.h, 'min="10"') + " cm</div>" +
        '<div class="row">x ' + num(sp + "|x", it.x) + " y " + num(sp + "|y", it.y) + " cm</div>" +
        '<div class="row"><label><input type="checkbox" data-f="' + sp + '|fixed|bool"' + (it.fixed ? " checked" : "") + "> 🔒 ここに置いておきたい（固定）</label></div>" +
        '<p class="help">固定の家具は、改善提案で動かしません。自分ではドラッグで動かせます。</p>' +
        '<div class="row"><button type="button" data-act="rotate-item" data-id="' + esc(it.id) + '">90度回転</button>' +
        '<button type="button" class="danger" data-act="del-item" data-id="' + esc(it.id) + '">削除</button></div></div>';
    }
    h += '<ul class="list">';
    d.items.forEach(function (o) {
      h += '<li class="' + (isSel("item", o.id) ? "selected" : "") + '"><span class="name" data-act="select" data-kind="item" data-id="' + esc(o.id) + '">' +
        (o.fixed ? "🔒 " : "") + esc(o.name) + ' <span class="muted">' + L.TYPE_JA[o.type] + " " + o.w + "×" + o.h + "</span></span></li>";
    });
    h += "</ul>";
    if (!d.items.length) h += '<p class="help">家具はまだありません。「追加」か「なぞって追加」で置いてください。</p>';
    return h;
  }

  // --- 設備 ---
  function panelFixtures() {
    var d = state.data, h = "";
    h += '<p class="help">作り付けの設備（動かせない物）です。ドア・窓・コンセントは壁に、作り付け収納・柱は四角で置きます。' +
      "収納と柱はロックされ、「ロック解除」したときだけドラッグで動かせます。</p>";
    h += '<div class="row">' + L.FIXTURE_TYPES.map(function (t) {
      return '<button type="button" data-act="add-fixture" data-type="' + t + '">＋' + L.FIXTURE_JA[t] + "</button>";
    }).join("") + "</div>";
    var f = state.sel && state.sel.kind === "fixture" ? findIn(d.fixtures, state.sel.id) : null;
    if (f && L.FIXTURE_TYPES.indexOf(f.type) >= 0) {
      var sp = "fixture|" + f.id;
      h += '<div class="editor"><div class="row"><b>選択中：</b>' + text(sp + "|name", f.name, 'style="flex:1"') + "</div>";
      if (L.isWallFixture(f)) {
        var vertical = f.wall === "left" || f.wall === "right";
        h += '<div class="row">壁 <select data-f="' + sp + '|wall|text">' + options(L.SIDES.map(function (s) { return [s, SIDE_JA[s] + "の壁"]; }), f.wall) + "</select></div>" +
          '<div class="row">' + (vertical ? "上" : "左") + "の端から " + num(sp + "|offset", f.offset, 'min="0"') + " cm" +
          (f.type !== "outlet" ? "　幅 " + num(sp + "|width", f.width, 'min="1"') + " cm" : "") + "</div>";
        if (f.type === "door") {
          h += '<div class="row">開き方 <select data-f="' + sp + '|swing|text">' + options([["inward", "内開き"], ["outward", "外開き"]], f.swing) + "</select>" +
            " 蝶番 <select data-f=\"" + sp + '|hinge|text">' + options(vertical ? [["top", "上側"], ["bottom", "下側"]] : [["left", "左側"], ["right", "右側"]], f.hinge) + "</select></div>";
        }
      } else {
        var lock = f.locked ? " disabled" : "";
        h += '<div class="row">x ' + num(sp + "|x", f.x, lock) + " y " + num(sp + "|y", f.y, lock) + " cm</div>" +
          '<div class="row">幅 ' + num(sp + "|w", f.w, 'min="10"' + lock) + " 奥行 " + num(sp + "|h", f.h, 'min="10"' + lock) + " cm</div>" +
          '<div class="row"><button type="button" data-act="toggle-lock" data-id="' + esc(f.id) + '">' + (f.locked ? "🔓 ロック解除" : "🔒 ロックする") + "</button>" +
          '<span class="muted">' + (f.locked ? "ロック中（動きません）" : "ロック解除中（ドラッグで動かせます）") + "</span></div>";
      }
      h += '<div class="row"><button type="button" class="danger" data-act="del-fixture" data-id="' + esc(f.id) + '">削除</button></div></div>';
    }
    h += '<ul class="list">';
    d.fixtures.forEach(function (o) {
      if (L.FIXTURE_TYPES.indexOf(o.type) < 0) return;
      var where = L.isWallFixture(o) ? SIDE_JA[o.wall] + "の壁" : o.w + "×" + o.h;
      h += '<li class="' + (isSel("fixture", o.id) ? "selected" : "") + '"><span class="name" data-act="select" data-kind="fixture" data-id="' + esc(o.id) + '">' +
        (L.isRectFixture(o) && o.locked ? "🔒 " : "") + esc(o.name) + ' <span class="muted">' + L.FIXTURE_JA[o.type] + "・" + where + "</span></span></li>";
    });
    h += "</ul>";
    return h;
  }

  // --- 地点・動き ---
  function attachOptions(val) {
    var d = state.data, list = [["", "なし（自由な位置）"]];
    d.items.forEach(function (o) { list.push([o.id, "家具：" + o.name]); });
    d.fixtures.forEach(function (o) { if (L.FIXTURE_TYPES.indexOf(o.type) >= 0) list.push([o.id, "設備：" + o.name]); });
    return options(list, val || "");
  }
  function stopOptions(val) {
    return options(state.data.stops.map(function (s) { return [s.id, s.name]; }), val);
  }
  function panelStops() {
    var d = state.data, h = "";
    h += "<h3>立ち寄り地点</h3>";
    h += '<p class="help">地点は家具・設備に紐づけると、その物の正面の 40cm 手前（椅子・クッション・布団は中心）に置かれ、物と一緒に動きます。' +
      "「なし」にすると、間取り図の上でドラッグして自由に置けます。</p>";
    h += '<ul class="list">';
    d.stops.forEach(function (s) {
      var sp = "stop|" + s.id;
      h += '<li class="' + (isSel("stop", s.id) ? "selected" : "") + '">' + text(sp + "|name", s.name, 'style="width:8em"') +
        '<select data-f="' + sp + '|attachedTo|ref">' + attachOptions(s.attachedTo) + "</select>" +
        '<button type="button" class="danger" data-act="del-stop" data-id="' + esc(s.id) + '">削除</button></li>';
    });
    h += "</ul>";
    h += '<div class="row"><button type="button" data-act="add-stop">＋地点を追加</button></div>';
    h += "<h3>1日の動き</h3>";
    if (d.stops.length < 2) h += '<p class="help">地点を2つ以上作ると登録できます。</p>';
    else {
      h += '<ul class="list">';
      d.routines.forEach(function (r, i) {
        var sp = "routine|" + i, rr = state.result && state.result.routes[i];
        h += "<li>" + '<select data-f="' + sp + '|from|text">' + stopOptions(r.from) + "</select>→" +
          '<select data-f="' + sp + '|to|text">' + stopOptions(r.to) + "</select>" +
          num(sp + "|timesPerDay", r.timesPerDay, 'min="0" step="1" style="width:4em"') + "回/日" +
          ' <span class="' + (rr && rr.found ? "muted" : "ng") + '">' + (rr ? (rr.found ? fmtM(rr.length) : "通れません") : "") + "</span>" +
          '<button type="button" class="danger" data-act="del-routine" data-index="' + i + '">削除</button></li>';
      });
      h += "</ul>";
      h += '<div class="row"><button type="button" data-act="add-routine">＋動きを追加</button></div>';
    }
    return h;
  }

  // --- 物 ---
  function panelThings() {
    var d = state.data, h = "";
    h += '<p class="help">物の「しまう場所」と「使う場所」を登録します。毎日使う物が、しまう場所から使う場所まで ' +
      (L.CONFIG.CLUTTER_WARN / 100).toFixed(1) + "m 以上離れていると、片付けの警告を出します。布団や机などの家具は、ここではなく家具・地点として扱います。</p>";
    var places = [["", "（未設定）"]];
    d.items.forEach(function (o) { places.push([o.id, o.name]); });
    d.fixtures.forEach(function (o) { if (L.isRectFixture(o)) places.push([o.id, o.name]); });
    h += '<ul class="list">';
    d.things.forEach(function (t, i) {
      var sp = "thing|" + i;
      h += '<li><div class="row" style="width:100%">' + text(sp + "|name", t.name, 'style="width:8em"') +
        '<select data-f="' + sp + '|frequency|text">' + options(L.FREQUENCIES.map(function (k) { return [k, FREQ_JA[k]]; }), t.frequency) + "</select>" +
        '<button type="button" class="danger" data-act="del-thing" data-index="' + i + '">削除</button></div>' +
        '<div class="row">しまう場所 <select data-f="' + sp + '|storedIn|text">' + options(places, t.storedIn || "") + "</select></div>" +
        '<div class="row">使う場所 ' + (d.stops.length ? d.stops.map(function (s) {
          return '<label><input type="checkbox" data-f="' + sp + "|usedAt|toggle\" value=\"" + esc(s.id) + '"' + (t.usedAt.indexOf(s.id) >= 0 ? " checked" : "") + "> " + esc(s.name) + "</label>";
        }).join(" ") : '<span class="muted">（地点がありません）</span>') + "</div></li>";
    });
    h += "</ul>";
    h += '<div class="row"><button type="button" data-act="add-thing">＋物を追加</button></div>';
    return h;
  }

  // --- 結果 ---
  function panelResult() {
    var res = state.result, h = "";
    if (!res) return "";
    h += "<h3>1日の移動距離：" + fmtM(res.total) + "</h3>";
    h += '<p class="help">作業中モード：' + (state.data.settings.workMode ? "オン（机の前 " + L.CONFIG.WORK_ZONE_DEPTH + "cm を椅子の範囲として通れない扱い）" : "オフ") + "</p>";
    if (!res.routes.length) h += '<p class="help">「地点・動き」タブで、1日の動きを登録してください。</p>';
    else {
      h += '<table class="result"><tr><th>区間</th><th>回数</th><th>1回</th><th>1日</th><th>最も狭い所</th></tr>';
      res.routes.forEach(function (r) {
        var name = (r.fromName || "?") + "→" + (r.toName || "?");
        if (!r.found) {
          h += "<tr><td>" + esc(name) + '</td><td class="num">' + r.times + '</td><td colspan="3" class="ng">' + esc(r.error || "通れません") + "</td></tr>";
        } else {
          var mw = isFinite(r.minWidth) ? Math.round(r.minWidth) + "cm" : "—";
          var cls = r.minWidth < L.CONFIG.WIDTH_YELLOW ? "ng" : (r.minWidth < L.CONFIG.WIDTH_GREEN ? "" : "ok");
          h += "<tr><td>" + esc(name) + '</td><td class="num">' + r.times + '</td><td class="num">' + fmtM(r.length) +
            '</td><td class="num">' + fmtM(r.length * r.times) + '</td><td class="num ' + cls + '">' + mw + "</td></tr>";
        }
      });
      h += "</table>";
    }
    h += "<h3>片付けチェック</h3>";
    if (!res.clutter.length) h += '<p class="ok">毎日使う物は、使う場所の近くにしまえています。</p>';
    else res.clutter.forEach(function (w) {
      h += '<div class="warnbox">⚠ <b>' + esc(w.thing) + "</b>：" + esc(w.reason) + "</div>";
    });
    return h;
  }

  // --- 提案 ---
  function panelSuggest() {
    var h = "";
    h += '<p class="help">固定でない家具を1つずつ壁沿いの位置（' + L.CONFIG.SUGGEST_STEP + "cm 刻み、0度と90度）に動かして試し、1日の移動距離が減る案を探します。" +
      "採用できる条件：ほかの家具や部屋の外にはみ出さない、ドアの開く範囲に入らない、正面の前に " + L.CONFIG.FRONT_CLEAR +
      "cm 以上の空きがある、すべてのルートが通れて赤（60cm 未満）の区間がない。机を動かすときは、前の椅子も一緒に動かします。</p>";
    h += '<div class="row"><button type="button" class="primary" data-act="suggest"' + (state.suggester ? " disabled" : "") + ">提案を計算する</button></div>";
    if (state.suggester) {
      h += '<p>計算中…</p><div class="progress"><i id="suggestBar" style="width:' + Math.round(state.suggester.position / Math.max(1, state.suggester.total) * 100) + '%"></i></div>';
    } else if (state.suggestions) {
      if (!state.suggestions.length) h += "<p>今の配置より良い案はありません。</p>";
      else {
        h += '<p class="help">案を押すとプレビューします（動かす家具は半透明、元の位置は点線）。</p>';
        state.suggestions.forEach(function (s, i) {
          h += '<button type="button" class="suggestion' + (state.preview === s ? " active" : "") + '" data-act="preview" data-index="' + i + '">' +
            "<b>案" + (i + 1) + "</b>　" + esc(s.text) + "</button>";
        });
        if (state.preview) {
          h += '<div class="row"><button type="button" class="primary" data-act="adopt">採用</button><button type="button" data-act="revert">戻す</button></div>';
        }
      }
    }
    return h;
  }

  // ===== 提案の計算（少しずつ） =====
  function startSuggest() {
    stopSuggest();
    state.preview = null;
    state.suggestions = null;
    var s = L.createSuggester(L.clone(state.data));
    state.suggester = s;
    renderPanel(); renderPlan(); renderScore();
    (function tick() {
      if (state.suggester !== s) return; // 途中で取り消された
      var t0 = performance.now();
      while (!s.done && performance.now() - t0 < SUGGEST_SLICE_MS) s.step(4);
      var bar = $("suggestBar");
      if (bar) bar.style.width = Math.round(s.position / Math.max(1, s.total) * 100) + "%";
      if (s.done) {
        state.suggester = null;
        state.suggestions = s.results();
        renderPanel();
      } else setTimeout(tick, 0);
    })();
  }
  function stopSuggest() { state.suggester = null; }
  function previewSuggestion(s) {
    state.preview = s;
    state.previewResult = L.evaluate(s.data);
    renderPlan(); renderScore(); renderPanel();
  }

  // ===== ボタン（パネル・上部バー・プレビュー） =====
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b || b.closest("#modal")) return;
    var a = b.dataset.act, d = state.data, id = b.dataset.id;
    switch (a) {
      case "new": openStartDialog(true); break;
      case "sample":
        if (d.items.length && !confirm("今の配置を見本で置き換えます。よろしいですか？（必要なら先に JSON 書き出しをしてください）")) return;
        setData(SAMPLE_DATA, "見本を読み込みました");
        break;
      case "export": exportJson(); break;
      case "import-json": $("fileJson").click(); break;
      case "select": select({ kind: b.dataset.kind, id: id }); break;
      case "tool-trace": setTool(state.tool === "trace" ? null : "trace"); break;
      case "tool-underlay": setTool(state.tool === "underlay" ? null : "underlay"); break;
      case "tool-off": setTool(null); break;
      case "img-file": Importer.pickFile(b.dataset.kind, importCtx()); break;
      case "img-camera": Importer.camera(b.dataset.kind, importCtx()); break;
      case "del-underlay":
        d.underlays = d.underlays.filter(function (u) { return u.id !== id; });
        if (!d.underlays.length && state.tool === "underlay") setTool(null, true);
        commit();
        break;
      case "add-item": addItem($("newItemType").value); break;
      case "rotate-item": {
        var it = findIn(d.items, id);
        var r = L.rotateItem(it, d.room);
        it.x = r.x; it.y = r.y; it.w = r.w; it.h = r.h; it.frontSide = r.frontSide;
        commit();
        break;
      }
      case "del-item": deleteEntity(id, "items"); break;
      case "add-fixture": addFixture(b.dataset.type); break;
      case "toggle-lock": { var f = findIn(d.fixtures, id); f.locked = !f.locked; commit(); break; }
      case "del-fixture": deleteEntity(id, "fixtures"); break;
      case "add-stop": {
        var s = { id: L.makeId(d, "stop"), name: "地点" + (d.stops.length + 1), attachedTo: null, x: L.snap(d.room.width / 2), y: L.snap(d.room.depth / 2) };
        d.stops.push(s);
        state.sel = { kind: "stop", id: s.id };
        commit();
        break;
      }
      case "del-stop":
        d.stops = d.stops.filter(function (s) { return s.id !== id; });
        d.routines = d.routines.filter(function (r) { return r.from !== id && r.to !== id; });
        d.things.forEach(function (t) { t.usedAt = t.usedAt.filter(function (u) { return u !== id; }); });
        commit();
        break;
      case "add-routine":
        d.routines.push({ from: d.stops[0].id, to: d.stops[1].id, timesPerDay: 1 });
        commit();
        break;
      case "del-routine": d.routines.splice(Number(b.dataset.index), 1); commit(); break;
      case "add-thing":
        d.things.push({ name: "物" + (d.things.length + 1), storedIn: d.items[0] ? d.items[0].id : "", usedAt: [], frequency: "daily" });
        commit();
        break;
      case "del-thing": d.things.splice(Number(b.dataset.index), 1); commit(); break;
      case "suggest": startSuggest(); break;
      case "preview": previewSuggestion(state.suggestions[Number(b.dataset.index)]); break;
      case "adopt":
        if (!state.preview) return;
        var text = state.preview.text;
        state.data = L.clone(state.preview.data);
        state.sel = null;
        commit();
        toast("採用しました：" + text);
        break;
      case "revert":
        state.preview = null;
        renderPlan(); renderScore(); renderPanel();
        break;
    }
  });

  // 入力欄の変更
  function onField(e) {
    var el = e.target, spec = el.getAttribute("data-f");
    if (!spec) return;
    var parts = spec.split("|"), target = parts[0], id = parts[1], key = parts[2], type = parts[3];
    var d = state.data, obj = null;
    if (target === "room") obj = d.room;
    else if (target === "item") obj = findIn(d.items, id);
    else if (target === "fixture") obj = findIn(d.fixtures, id);
    else if (target === "stop") obj = findIn(d.stops, id);
    else if (target === "underlay") obj = findIn(d.underlays, id);
    else if (target === "routine") obj = d.routines[Number(id)];
    else if (target === "thing") obj = d.things[Number(id)];
    if (!obj) return;
    var v;
    if (type === "num") {
      v = Number(el.value);
      if (el.value === "" || !isFinite(v)) { el.value = obj[key]; return; }
    } else if (type === "bool") v = el.checked;
    else if (type === "toggle") {
      var arr = obj[key] || [];
      arr = arr.filter(function (x) { return x !== el.value; });
      if (el.checked) arr.push(el.value);
      v = arr;
    } else if (type === "ref") v = el.value || null;
    else v = el.value;

    // 項目ごとの調整
    if (target === "room") v = Math.max(50, v);
    if ((target === "item" || target === "fixture") && (key === "w" || key === "h")) v = Math.max(10, v);
    if (target === "routine" && key === "timesPerDay") v = Math.max(0, v);
    if (target === "stop" && key === "attachedTo" && !v && obj.attachedTo) {
      // 紐づけを外すときは、今の位置にそのまま残す
      var p = state.result && state.result.stopPos[obj.id];
      if (p) { obj.x = L.snap(p.x); obj.y = L.snap(p.y); }
    }
    obj[key] = v;
    if (target === "fixture" && key === "wall" && obj.type === "door") {
      var vertical = v === "left" || v === "right";
      obj.hinge = vertical ? "top" : "left";
    }
    if (target === "item" || (target === "fixture" && L.isRectFixture(obj))) L.clampToRoom(obj, d.room);
    if (target === "room") d.items.forEach(function (it) { L.clampToRoom(it, d.room); });
    // 数値は、補正された値を入力欄に戻す
    if (type === "num" && typeof obj[key] === "number" && el.type !== "range") el.value = obj[key];
    var light = (type === "num" || key === "name" || target === "underlay");
    if (e.type === "input") { // 濃さのスライダーは動かしている間も反映
      renderPlan(); scheduleSave();
      return;
    }
    commit({ panel: !light });
  }
  panel.addEventListener("change", onField);
  panel.addEventListener("input", function (e) { if (e.target.type === "range") onField(e); });

  $("workMode").addEventListener("change", function (e) {
    state.data.settings.workMode = e.target.checked;
    commit();
  });

  // ===== 追加・削除 =====
  function findFreeSpot(w, h) {
    var d = state.data, step = 10;
    var obs = d.items.concat(d.fixtures.filter(L.isRectFixture)), fans = L.doorFans(d);
    for (var y = 0; y <= d.room.depth - h; y += step) {
      for (var x = 0; x <= d.room.width - w; x += step) {
        var r = { x: x, y: y, w: w, h: h };
        if (!obs.some(function (o) { return L.rectsOverlap(r, o); }) &&
          !fans.some(function (f) { return L.rectHitsFan(r, f); })) return r;
      }
    }
    return { x: L.snap(Math.max(0, (d.room.width - w) / 2)), y: L.snap(Math.max(0, (d.room.depth - h) / 2)) };
  }
  function addItem(type) {
    var sz = DEFAULT_SIZES[type] || DEFAULT_SIZES.other, d = state.data;
    var w = Math.min(sz[0], d.room.width), h = Math.min(sz[1], d.room.depth), p = findFreeSpot(w, h);
    var it = { id: L.makeId(d, "item"), name: L.TYPE_JA[type], type: type, x: p.x, y: p.y, w: w, h: h, fixed: false, frontSide: "bottom" };
    d.items.push(it);
    state.sel = { kind: "item", id: it.id };
    commit();
  }
  function addFixture(type) {
    var d = state.data, f = { id: L.makeId(d, type), name: L.FIXTURE_JA[type], type: type };
    if (L.WALL_FIXTURE_TYPES.indexOf(type) >= 0) {
      f.wall = "top"; f.offset = 0;
      f.width = type === "door" ? 75 : (type === "window" ? 90 : 10);
      if (type === "door") { f.swing = "inward"; f.hinge = "left"; }
    } else {
      var w = type === "pillar" ? 30 : 90, h = type === "pillar" ? 30 : 60, p = findFreeSpot(w, h);
      f.x = p.x; f.y = p.y; f.w = w; f.h = h; f.locked = true;
    }
    d.fixtures.push(f);
    state.sel = { kind: "fixture", id: f.id };
    commit();
  }
  function deleteEntity(id, key) {
    var d = state.data;
    // 紐づいていた地点は、今の位置のまま自由な地点にする
    d.stops.forEach(function (s) {
      if (s.attachedTo !== id) return;
      var p = state.result && state.result.stopPos[s.id];
      s.attachedTo = null;
      if (p) { s.x = L.snap(p.x); s.y = L.snap(p.y); }
    });
    d[key] = d[key].filter(function (o) { return o.id !== id; });
    state.sel = null;
    commit();
  }

  // ===== 取り込みとの受け渡し =====
  function importCtx() {
    return {
      room: { width: state.data.room.width, depth: state.data.room.depth },
      toast: toast,
      done: function (r) {
        var d = state.data;
        if (r.roomSize) {
          d.room.width = Math.round(r.roomSize.width);
          d.room.depth = Math.round(r.roomSize.depth);
          d.items.forEach(function (it) { L.clampToRoom(it, d.room); });
        }
        var u = r.underlay;
        u.id = L.makeId(d, "underlay");
        u.name = u.name + (d.underlays.filter(function (x) { return x.kind === u.kind; }).length + 1);
        d.underlays.push(u);
        state.sel = { kind: "underlay", id: u.id };
        state.tab = "import";
        commit();
        setTool("trace");
        toast("下絵を追加しました。家具の足元をドラッグでなぞると、家具として登録できます");
      }
    };
  }

  // ===== JSON の書き出し・読み込み =====
  function exportJson() {
    var d = L.clone(state.data);
    if (d.underlays.length && !confirm("下絵の画像も含めますか？\n「OK」：含める（ファイルが大きくなります）\n「キャンセル」：含めない")) {
      d.underlays = [];
    }
    var now = new Date(), pad = function (v) { return ("0" + v).slice(-2); };
    var name = "room-layout-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()) + ".json";
    var blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    // iPhone・iPad では共有シート（AirDrop・ファイルに保存など）を使う
    if (Importer.isMobile() && window.File && navigator.canShare) {
      var file = new File([blob], name, { type: "application/json" });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(function () { /* 取り消しは無視 */ });
        return;
      }
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("書き出しました：" + name);
  }
  $("fileJson").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(reader.result);
        if (!raw || typeof raw !== "object" || !raw.room) throw new Error("形式");
        setData(raw, "読み込みました：" + file.name);
      } catch (err) {
        toast("読み込めませんでした。このアプリで書き出した JSON ファイルを選んでください");
      }
    };
    reader.readAsText(file);
  });

  // ===== はじめ方の選択 =====
  function openStartDialog(canCancel) {
    var r = state.data ? state.data.room : { width: 360, depth: 270 };
    var box = Modal.open(
      "<h2>はじめ方を選ぶ</h2>" +
      '<p class="help">どんな部屋でも使えます。まず部屋の寸法を入れてください（あとで変えられます。手書き図の取り込みでも入力できます）。</p>' +
      '<div class="row">部屋の幅 <input type="number" id="stW" value="' + r.width + '" min="50"> cm × 奥行 <input type="number" id="stD" value="' + r.depth + '" min="50"> cm</div>' +
      '<div class="start-choices">' +
      '<button type="button" class="main" data-start="photo"><b>📷 写真から（おすすめ）</b>床の写真を下絵にして、上からなぞって家具を置きます</button>' +
      '<button type="button" data-start="sketch"><b>✏️ 手書き図から</b>手書きの間取り図を下絵にします（写真の補助に）</button>' +
      '<button type="button" data-start="manual"><b>⌨️ 空の部屋から手入力</b>家具を1つずつ追加します</button>' +
      '<button type="button" data-start="sample"><b>📘 見本を見る</b>整理整頓の見本の部屋を読み込みます</button>' +
      "</div>" +
      (canCancel ? '<div class="buttons"><button type="button" data-start="cancel">閉じる</button></div>' : ""),
      { narrow: true });
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-start]");
      if (!b) return;
      var k = b.dataset.start;
      if (k === "cancel") { Modal.close(); return; }
      if (canCancel && state.data && state.data.items.length && k !== "sample" &&
        !confirm("今の配置を消して、新しく始めます。よろしいですか？（必要なら先に JSON 書き出しをしてください）")) return;
      Modal.close();
      if (k === "sample") { state.tab = "layout"; setData(SAMPLE_DATA, "見本を読み込みました"); return; }
      var w = Math.max(50, Number(box.querySelector("#stW").value) || 360);
      var dd = Math.max(50, Number(box.querySelector("#stD").value) || 270);
      state.tab = k === "manual" ? "layout" : "import";
      setData(L.newEmptyData(w, dd));
      if (k === "photo") toast("「写真を選ぶ」か「カメラで撮影」を押してください");
      if (k === "sketch") toast("手書き図の「画像を選ぶ」か「カメラで撮影」を押してください");
    });
  }

  // ===== PWA（ホーム画面に追加・オフライン起動） =====
  // index.html をダブルクリックで開いたとき（file:）は働かないので、http(s) のときだけ有効にする
  if (/^https?:$/.test(location.protocol)) {
    var link = document.createElement("link");
    link.rel = "manifest"; link.href = "manifest.json";
    document.head.appendChild(link);
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () { /* 失敗しても通常どおり動く */ });
      });
    }
  }

  // Esc キーで窓を閉じる
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && Modal.isOpen) Modal.close();
  });

  // ===== 起動 =====
  var saved = loadSaved();
  if (saved) {
    state.data = saved;
    $("workMode").checked = saved.settings.workMode;
    commit({});
  } else {
    state.data = L.newEmptyData(360, 270);
    $("workMode").checked = true;
    state.tab = "import";
    recompute(); renderPlan(); renderScore(); renderPanel();
    openStartDialog(false);
  }

  // 動作確認用（開発者ツールから状態を見られるように）
  window.__app = { state: state, commit: commit, setData: setData };
})();
