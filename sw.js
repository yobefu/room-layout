/*
 * sw.js — サービスワーカー（アプリのファイルを端末に保存し、電波がなくても起動できるようにする）
 * アプリを更新したら CACHE_NAME の番号を上げる。
 */
var CACHE_NAME = "room-layout-v1";
var FILES = [
  "./",
  "index.html",
  "style.css",
  "logic.js",
  "import.js",
  "app.js",
  "sample-data.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png"
];

// 入れたとき：ファイルをまとめて保存
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE_NAME).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

// 有効になったとき：古い保存を消す
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 読み込み：保存した物をすぐ返し、裏で新しい物を取りに行って保存し直す
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && res.ok && new URL(e.request.url).origin === self.location.origin) cache.put(e.request, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
