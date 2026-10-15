/*
 * import.js — 写真・手書き図の取り込み
 *  - 画像ファイルの読み込み、カメラ撮影（スマホは標準のカメラ画面、PC はブラウザのカメラ機能）
 *  - 4つの角を指定する画面
 *  - 射影変換で「真上から見た図」に直して、下絵（underlay）を作る
 * 計算は logic.js の RoomLogic.computeHomography を使う。
 */

// ===== 画面の上に重ねる窓（はじめ方の選択・取り込み・カメラで共用） =====
var Modal = (function () {
  "use strict";
  var el = document.getElementById("modal");
  var onClose = null;
  function open(html, opts) {
    opts = opts || {};
    el.innerHTML = '<div class="box' + (opts.narrow ? " narrow" : "") + '">' + html + "</div>";
    el.hidden = false;
    onClose = opts.onClose || null;
    return el.firstChild;
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    el.innerHTML = "";
    var f = onClose; onClose = null;
    if (f) f();
  }
  return { open: open, close: close, get isOpen() { return !el.hidden; } };
})();

var Importer = (function () {
  "use strict";
  var L = RoomLogic;

  // ===== 調整用の定数 =====
  var MAX_SOURCE_PX = 2000;  // 読み込んだ画像の長い辺をこの大きさまで縮める（px）
  var OUT_MAX_PX = 1200;     // 下絵の画像の長い辺の最大（px）
  var OUT_PX_PER_CM = 3;     // 下絵の細かさ（1cm あたりの px）
  var JPEG_QUALITY = 0.82;   // 下絵の画質（0〜1）
  var HANDLE_HIT_PX = 24;    // 角の点をつかめる範囲（画面上の px）

  var KIND_JA = { photo: "写真", sketch: "手書き図" };

  function isMobile() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 画像・映像を canvas に写す（大きすぎる画像は縮める）
  function toCanvas(src, sw, sh) {
    var s = Math.min(1, MAX_SOURCE_PX / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function loadFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var c = toCanvas(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした（HEIC 形式などは、JPEG に変換してから選んでください）"));
      };
      img.src = url;
    });
  }
  // 90度回転（時計回り）
  function rotateCanvas(c) {
    var r = document.createElement("canvas");
    r.width = c.height; r.height = c.width;
    var ctx = r.getContext("2d");
    ctx.translate(r.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(c, 0, 0);
    return r;
  }

  // ===== 入口：ファイルから / カメラから =====
  var pending = null; // { kind, ctx }
  var fileImage = document.getElementById("fileImage");
  var fileCamera = document.getElementById("fileCamera");
  function onFileChosen(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ""; // 同じファイルをもう一度選べるようにする
    if (!file || !pending) return;
    var p = pending;
    loadFile(file).then(function (canvas) { openCornerEditor(canvas, p.kind, p.ctx); })
      .catch(function (err) { p.ctx.toast(err.message); });
  }
  fileImage.addEventListener("change", onFileChosen);
  fileCamera.addEventListener("change", onFileChosen);

  // ctx: { room: {width, depth}, toast(msg), done(result) }
  function pickFile(kind, ctx) {
    pending = { kind: kind, ctx: ctx };
    fileImage.click();
  }
  function camera(kind, ctx) {
    pending = { kind: kind, ctx: ctx };
    if (isMobile() || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      fileCamera.click(); // スマホ・タブレットは標準のカメラ画面を使う
    } else {
      openCamera(kind, ctx);
    }
  }

  // ===== PC のカメラで撮影 =====
  function openCamera(kind, ctx) {
    var stream = null, still = null;
    var box = Modal.open(
      '<h2>カメラで撮影（' + KIND_JA[kind] + '）</h2>' +
      '<p class="help">' + (kind === "sketch"
        ? "手書き図をカメラに向けて、紙全体が写るようにしてください。"
        : "床の四角形（部屋の隅、ラグなど）の4つの角が写るようにしてください。") + "</p>" +
      '<div class="row"><select id="camSelect" aria-label="カメラの選択"></select>' +
      '<label><input type="checkbox" id="camMirror" checked> 画面を左右反転して表示（保存する写真は反転しません）</label></div>' +
      '<div class="stage" id="camStage"><video id="camVideo" class="mirror" autoplay playsinline muted></video></div>' +
      '<div class="buttons">' +
      '<button type="button" data-cam="cancel">やめる</button>' +
      '<button type="button" data-cam="retake" hidden>撮り直す</button>' +
      '<button type="button" class="primary" data-cam="shoot">撮影</button>' +
      '<button type="button" class="primary" data-cam="use" hidden>この写真を使う</button></div>',
      { onClose: stop });
    var video = box.querySelector("#camVideo"), sel = box.querySelector("#camSelect");
    var stage = box.querySelector("#camStage");
    function stop() {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    function start(deviceId) {
      stop();
      var c = { video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
      return navigator.mediaDevices.getUserMedia(c).then(function (s) {
        stream = s;
        video.srcObject = s;
        return navigator.mediaDevices.enumerateDevices();
      }).then(function (list) {
        var cams = list.filter(function (d) { return d.kind === "videoinput"; });
        var cur = stream && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings().deviceId;
        sel.innerHTML = cams.map(function (d, i) {
          return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? " selected" : "") + ">" +
            esc(d.label || "カメラ " + (i + 1)) + "</option>";
        }).join("");
        sel.hidden = cams.length < 2;
      }).catch(function (err) {
        var msg = "カメラを起動できませんでした";
        if (err && err.name === "NotAllowedError") msg = "カメラの使用が許可されませんでした。ブラウザのアドレスバーの設定から許可してください";
        else if (err && err.name === "NotFoundError") msg = "カメラが見つかりません";
        else if (!window.isSecureContext) msg = "この開き方ではカメラを使えません。https で公開した URL から開いてください";
        Modal.close();
        ctx.toast(msg);
      });
    }
    sel.addEventListener("change", function () { start(sel.value); });
    box.querySelector("#camMirror").addEventListener("change", function (e) {
      video.classList.toggle("mirror", e.target.checked);
    });
    function show(btn, on) { box.querySelector('[data-cam="' + btn + '"]').hidden = !on; }
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cam]");
      if (!b) return;
      var a = b.dataset.cam;
      if (a === "cancel") Modal.close();
      else if (a === "shoot") {
        if (!video.videoWidth) return;
        still = toCanvas(video, video.videoWidth, video.videoHeight); // 反転せずに保存
        video.hidden = true;
        still.style.maxHeight = "60vh";
        stage.appendChild(still);
        show("shoot", false); show("retake", true); show("use", true);
      } else if (a === "retake") {
        if (still) still.remove();
        still = null; video.hidden = false;
        show("shoot", true); show("retake", false); show("use", false);
      } else if (a === "use" && still) {
        var c = still;
        Modal.close();
        openCornerEditor(c, kind, ctx);
      }
    });
    start();
  }

  // ===== 4つの角を指定する画面 =====
  function openCornerEditor(source, kind, ctx) {
    var room = ctx.room;
    var pts = [];        // 画像上の4点（画像の px）
    var dragIdx = -1;
    var isSketch = kind === "sketch";
    var box = Modal.open(
      "<h2>" + KIND_JA[kind] + "の4つの角を指定</h2>" +
      '<p class="help">' + (isSketch
        ? "手書き図の<b>部屋の4隅</b>を押してください。"
        : "床の上の<b>大きさが分かっている四角形</b>（部屋の4隅、ラグ、メジャーで測った範囲など）の角を押してください。背の高い家具は傾いて写るので、角は<b>床に接している所</b>を選びます。") +
      "<br>順番は <b>1 左上 → 2 右上 → 3 右下 → 4 左下</b>（アプリの間取り図で見たときの向き）。押した後はドラッグで直せます。</p>" +
      '<div class="row"><button type="button" data-imp="rotate">画像を90度回転</button>' +
      '<button type="button" data-imp="reset">点をやり直す</button><span id="impCount" class="muted"></span></div>' +
      '<div class="stage"><canvas id="impCanvas"></canvas></div>' +
      '<div class="row"><label><input type="checkbox" id="impIsRoom"' + (isSketch ? " checked" : "") + "> 4点は部屋の4隅</label></div>" +
      '<div class="row">四角形の大きさ：幅 <input type="number" id="impW" min="10" step="1"> cm × 奥行 <input type="number" id="impD" min="10" step="1"> cm</div>' +
      '<div class="row" id="impPosRow">部屋の中での位置（四角形の左上）：x <input type="number" id="impX" step="1" value="0"> cm　y <input type="number" id="impY" step="1" value="0"> cm</div>' +
      '<p class="help" id="impNote"></p>' +
      '<div class="buttons"><button type="button" data-imp="cancel">やめる</button>' +
      '<button type="button" class="primary" data-imp="ok">下絵にする</button></div>');
    var canvas = box.querySelector("#impCanvas"), g = canvas.getContext("2d");
    var isRoomEl = box.querySelector("#impIsRoom"), wEl = box.querySelector("#impW"), dEl = box.querySelector("#impD");
    var posRow = box.querySelector("#impPosRow"), note = box.querySelector("#impNote"), countEl = box.querySelector("#impCount");
    var lastRect = { w: 100, h: 100 };
    function syncRoomMode() {
      var r = isRoomEl.checked;
      if (r) { wEl.value = room.width; dEl.value = room.depth; }
      else { wEl.value = lastRect.w; dEl.value = lastRect.h; }
      posRow.hidden = r;
      note.textContent = r ? "部屋の寸法も、この大きさに合わせて変わります。" : "部屋の寸法は変わりません。下絵は部屋全体の範囲で作ります。";
    }
    isRoomEl.addEventListener("change", syncRoomMode);
    syncRoomMode();

    // 表示の大きさを決める
    var view = { s: 1 };
    function layout() {
      var maxW = Math.min(box.clientWidth - 28, 940), maxH = Math.max(240, window.innerHeight * 0.55);
      view.s = Math.min(maxW / source.width, maxH / source.height);
      var dpr = window.devicePixelRatio || 1;
      canvas.style.width = Math.round(source.width * view.s) + "px";
      canvas.style.height = Math.round(source.height * view.s) + "px";
      canvas.width = Math.round(source.width * view.s * dpr);
      canvas.height = Math.round(source.height * view.s * dpr);
      draw();
    }
    function draw() {
      var k = canvas.width / source.width;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(source, 0, 0, canvas.width, canvas.height);
      g.setTransform(k, 0, 0, k, 0, 0);
      var lw = 2 / k * (window.devicePixelRatio || 1);
      if (pts.length > 1) {
        g.beginPath();
        pts.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); });
        if (pts.length === 4) g.closePath();
        g.strokeStyle = "#ffd400"; g.lineWidth = lw * 1.5; g.stroke();
        if (pts.length === 4) { g.fillStyle = "rgba(255,212,0,0.15)"; g.fill(); }
      }
      var r = 9 / k * (window.devicePixelRatio || 1);
      pts.forEach(function (p, i) {
        g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.fillStyle = "rgba(47,111,106,0.9)"; g.fill();
        g.lineWidth = lw; g.strokeStyle = "#fff"; g.stroke();
        g.fillStyle = "#fff"; g.font = "bold " + (r * 1.3) + "px sans-serif";
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String(i + 1), p.x, p.y + r * 0.05);
      });
      var names = ["左上", "右上", "右下", "左下"];
      countEl.textContent = pts.length < 4 ? "次は " + (pts.length + 1) + "（" + names[pts.length] + "）を押してください" : "4点を指定しました";
    }
    function toImage(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / rect.width * source.width, y: (e.clientY - rect.top) / rect.height * source.height };
    }
    canvas.addEventListener("pointerdown", function (e) {
      var p = toImage(e), hit = HANDLE_HIT_PX / view.s;
      dragIdx = -1;
      for (var i = 0; i < pts.length; i++) if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) < hit) { dragIdx = i; break; }
      if (dragIdx < 0 && pts.length < 4) { pts.push(p); dragIdx = pts.length - 1; }
      if (dragIdx >= 0) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても続ける */ } }
      draw();
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (dragIdx < 0) return;
      var p = toImage(e);
      pts[dragIdx] = { x: L.clamp(p.x, 0, source.width), y: L.clamp(p.y, 0, source.height) };
      draw();
    });
    function up() { dragIdx = -1; }
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-imp]");
      if (!b) return;
      var a = b.dataset.imp;
      if (a === "cancel") Modal.close();
      else if (a === "reset") { pts = []; draw(); }
      else if (a === "rotate") { source = rotateCanvas(source); pts = []; layout(); }
      else if (a === "ok") finish();
    });
    function finish() {
      if (pts.length < 4) { ctx.toast("4つの角をすべて指定してください"); return; }
      var w = Number(wEl.value), d = Number(dEl.value);
      if (!(w >= 10 && d >= 10)) { ctx.toast("四角形の大きさを 10cm 以上で入力してください"); return; }
      var isRoom = isRoomEl.checked;
      var rx = isRoom ? 0 : Number(box.querySelector("#impX").value) || 0;
      var ry = isRoom ? 0 : Number(box.querySelector("#impY").value) || 0;
      if (!isRoom) lastRect = { w: w, h: d };
      var newRoom = isRoom ? { width: w, depth: d } : room;
      // 下絵にする範囲：部屋全体（と、はみ出した四角形）を含む範囲
      var region = isRoom ? { x: 0, y: 0, w: w, h: d } : {
        x: Math.min(0, rx), y: Math.min(0, ry),
        w: Math.max(newRoom.width, rx + w) - Math.min(0, rx), h: Math.max(newRoom.depth, ry + d) - Math.min(0, ry)
      };
      var roomPts = [{ x: rx, y: ry }, { x: rx + w, y: ry }, { x: rx + w, y: ry + d }, { x: rx, y: ry + d }];
      var H = L.computeHomography(roomPts, pts); // 部屋の座標 → 画像の座標
      if (!H) { ctx.toast("4点の位置を見直してください（一直線に並んでいます）"); return; }
      var src = warp(source, H, region);
      Modal.close();
      ctx.done({
        roomSize: isRoom ? newRoom : null,
        underlay: { kind: kind, name: KIND_JA[kind], src: src, x: region.x, y: region.y, w: region.w, h: region.h, opacity: 0.5, visible: true }
      });
    }
    layout();
  }

  // 射影変換で「真上から見た図」を作る（画像の外は白）
  function warp(source, H, region) {
    var s = Math.min(OUT_PX_PER_CM, OUT_MAX_PX / Math.max(region.w, region.h));
    var ow = Math.max(1, Math.round(region.w * s)), oh = Math.max(1, Math.round(region.h * s));
    var sw = source.width, sh = source.height;
    var sData = source.getContext("2d").getImageData(0, 0, sw, sh).data;
    var out = document.createElement("canvas");
    out.width = ow; out.height = oh;
    var octx = out.getContext("2d"), img = octx.createImageData(ow, oh), o = img.data;
    for (var v = 0; v < oh; v++) {
      var Y = region.y + (v + 0.5) / s;
      for (var u = 0; u < ow; u++) {
        var X = region.x + (u + 0.5) / s;
        var wv = H[6] * X + H[7] * Y + H[8], k = (v * ow + u) * 4;
        var x = -1, y = -1;
        if (wv > 1e-9) { x = (H[0] * X + H[1] * Y + H[2]) / wv; y = (H[3] * X + H[4] * Y + H[5]) / wv; }
        if (x >= 0 && y >= 0 && x < sw && y < sh) {
          var si = ((y | 0) * sw + (x | 0)) * 4;
          o[k] = sData[si]; o[k + 1] = sData[si + 1]; o[k + 2] = sData[si + 2];
        } else { o[k] = o[k + 1] = o[k + 2] = 255; }
        o[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  return { pickFile: pickFile, camera: camera, isMobile: isMobile };
})();
