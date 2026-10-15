/*
 * sample-data.js — 見本データ（整理整頓の見本として使う部屋）
 * 家具の寸法：机A・机B・布団は確認済み。位置は手書き図から読んだ目安【仮定】。
 * 単位は cm。座標の原点は部屋の左上、x は右、y は下に向かって増える。
 */
var SAMPLE_DATA = {
  version: 1,
  room: { width: 380, depth: 320 },
  settings: { workMode: true },
  items: [
    { id: "shelf1", name: "棚1", type: "shelf", x: 80, y: 0, w: 100, h: 50, fixed: false, frontSide: "bottom" },
    { id: "deskA", name: "机A", type: "desk", x: 190, y: 0, w: 100, h: 60, fixed: false, frontSide: "bottom" },
    // 机B の正面は left【仮定：向きは要確認】
    { id: "deskB", name: "机B", type: "desk", x: 310, y: 0, w: 60, h: 90, fixed: false, frontSide: "left" },
    { id: "smallShelf", name: "小物棚", type: "shelf", x: 345, y: 100, w: 35, h: 50, fixed: false, frontSide: "left" },
    { id: "shelf2", name: "棚2", type: "shelf", x: 0, y: 170, w: 40, h: 150, fixed: false, frontSide: "right" },
    // 布団は敷いたままの想定【仮定】
    { id: "futon", name: "布団", type: "bed", x: 120, y: 220, w: 180, h: 100, fixed: false, frontSide: "top" },
    // 正面 top【仮定：左側は布団との隙間が10cmしかないため】
    { id: "printer", name: "プリンター棚", type: "shelf", x: 310, y: 230, w: 60, h: 80, fixed: false, frontSide: "top" },
    // 椅子の寸法と位置は【仮定】
    { id: "chair", name: "椅子", type: "chair", x: 215, y: 60, w: 50, h: 50, fixed: false, frontSide: "top" },
    // 直径60の丸を、60×60の四角として扱う
    { id: "cushion", name: "クッション", type: "cushion", x: 195, y: 130, w: 60, h: 60, fixed: false, frontSide: "top" }
  ],
  fixtures: [
    // 内開き、蝶番は上側【仮定】
    { id: "door", name: "ドア", type: "door", wall: "left", offset: 0, width: 75, swing: "inward", hinge: "top" },
    { id: "window", name: "窓", type: "window", wall: "right", offset: 0, width: 320 }
    // コンセントの位置は未確認のため入れていない
  ],
  stops: [
    { id: "entrance", name: "入口", attachedTo: "door" },
    { id: "seat", name: "机の席", attachedTo: "chair" },
    { id: "printerFront", name: "プリンター前", attachedTo: "printer" },
    { id: "cushionSpot", name: "クッション", attachedTo: "cushion" },
    { id: "futonSpot", name: "布団", attachedTo: "futon" }
  ],
  // 1日の回数は仮の値【仮定】
  routines: [
    { from: "entrance", to: "seat", timesPerDay: 2 },
    { from: "seat", to: "printerFront", timesPerDay: 3 },
    { from: "seat", to: "cushionSpot", timesPerDay: 3 },
    { from: "seat", to: "futonSpot", timesPerDay: 1 }
  ],
  // 毎日使う物。布団と机は「物」ではなく家具・地点として扱う
  things: [
    { name: "文房具", storedIn: "deskA", usedAt: ["seat", "cushionSpot"], frequency: "daily" },
    { name: "ノートPC", storedIn: "deskA", usedAt: ["seat", "cushionSpot"], frequency: "daily" }
  ],
  underlays: []
};

if (typeof module !== "undefined" && module.exports) module.exports = SAMPLE_DATA;
