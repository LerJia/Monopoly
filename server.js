// 地产大亨 — 服务端
// 单一文件：Express + Socket.IO + 全部游戏状态机
// 公平性：所有随机数与状态变更都在服务端，前端只渲染。

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { randomInt } = require('crypto');

const PORT = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

// ============== 常量 ==============
const STARTING_MONEY = 8000;
const GO_BONUS = 2000;
const JAIL_FINE = 1000;
const JAIL_MAX_TURNS = 3;
const AUCTION_TIME_MS = 30000;
const AUCTION_MIN_INCREMENT = 50;
const DISCONNECT_GRACE_MS = 30000;
const SLOT_RECLAIM_MS = 120000;
const CHAT_MAX_LEN = 100;
const MAX_PLAYERS = 10;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============== 贷款系统常量 ==============
const LOAN_INITIAL_CAP = 2000;        // 初始贷款上限
const LOAN_ABSOLUTE_CAP = 12000;      // 绝对上限
const LOAN_CAP_INCREMENT = 1000;      // 每 N 回合增加额度
const LOAN_CAP_INTERVAL = 5;          // 每 5 回合增加一次
const LOAN_BASE_RATE = 0.08;          // 基础利率 8%
const LOAN_RATE_INCREMENT = 0.05;     // 连续不还款每回合递增
const LOAN_OVERDUE_RATE = 0.15;       // 逾期利率（>3回合未还）
const LOAN_OVERDUE_TURNS = 3;         // 触发逾期的回合数
const LOAN_GAP_TURNS = 2;             // 两次贷款之间间隔回合数
const LOAN_MIN_REPAY_RATIO = 0.25;    // 最低还款比例
const LOAN_AUTO_REPAY_RATIO = 0.10;   // 回合结束自动扣款比例
const LOAN_ALLOWED_AMOUNTS = [500, 1000, 2000, 3000];  // 贷款档位
const LOAN_CREDIT_BASE = 60;
const LOAN_CREDIT_REPAY_BONUS = 10;   // 每次还款加分
const LOAN_CREDIT_MISS_PENALTY = 20;  // 每次未还款扣分
const LOAN_CREDIT_LOAN_PENALTY = 5;   // 每次贷款扣分
const LOAN_CREDIT_ASSET_BONUS_1 = 15;
const LOAN_CREDIT_ASSET_BONUS_2 = 10;
const LOAN_CREDIT_ASSET_THRESHOLD_1 = 10000;
const LOAN_CREDIT_ASSET_THRESHOLD_2 = 5000;
const LOAN_CREDIT_NEGATIVE_PENALTY = 10; // 现金不足扣分
const LOAN_FORCED_CLOSE_RATIO = 1.5;  // 负债率 > 净资产 150% 强制破产

// 可配置的游戏设置默认值 + 预设白名单（防止恶意客户端塞入异常值）
const DEFAULT_SETTINGS = {
  startingMoney: 8000,
  goBonus: 2000,
  jailFine: 1000,
};
const SETTINGS_PRESETS = {
  startingMoney: [5000, 8000, 12000, 15000],
  goBonus:       [1500, 2000, 3000],
  jailFine:      [500, 1000, 2000],
};

// ============== 棋盘（40 格，11×11） ==============
// 每格：index, name, type, group?, price?, rentTable[6], houseCost?, key?
// rentTable 长度 6: [0房, 1房, 2房, 3房, 4房, 旅馆]
// key: 稳定的字符串 id（不依赖 index），用于卡牌 / 索引反查
// ============== 棋盘（40 格，11×11）数值平衡版 ==============
// 平衡调整说明：
// 1. 低端地块(brown/light_blue/pink/orange)小幅提升1-4房租金，前期收益提升
// 2. 中高端(red/yellow/green/dark_blue)大幅压低旅馆最高租金，削弱一击破产碾压
// 3. 4房→旅馆租金涨幅大幅收窄，平滑收益曲线，不会瞬间巨额扣费
// 4. 高端地块建房成本小幅下调，降低垄断门槛，但上限收益受控
// 5. 深蓝、绿色旅馆租金砍半级下调，避免单次踩地直接淘汰玩家
// 每格：index, name, type, group?, price?, rentTable[6], houseCost?, key?
// rentTable 长度 6: [0房, 1房, 2房, 3房, 4房, 旅馆]
// key: 稳定的字符串 id（不依赖 index），用于卡牌 / 索引反查
// ============== 棋盘（40格）二次平衡版｜削弱3/4房高额扣款 ==============
// 调整重点：大幅降低3房、4房租金，避免没盖旅馆前就把对手扣破产；旅馆为唯一高租金节点
// rentTable：[0房, 1房, 2房, 3房, 4房, 旅馆]
const BOARD = [
  { index: 0,  key: 'go',           name: 'GO 起点',     type: 'go',          group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  // 棕色组（最低档，小幅加强基础租金，3/4房涨幅收紧）
  { index: 1,  key: 'village_east', name: '城中村',     type: 'property',    group: 'brown',       price: 800,  rentTable: [40,130,320,580,900,2200],               houseCost: 400 },
  { index: 2,  key: 'fate_a',       name: '命运',        type: 'fate',        group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 3,  key: 'village_west', name: '老旧小区',   type: 'property',    group: 'brown',       price: 1000, rentTable: [60,200,450,780,1200,2800],               houseCost: 400 },
  { index: 4,  key: 'tax_income',   name: '所得税',      type: 'tax',         group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 5,  key: 'rail_north',   name: '北京站',     type: 'station',     group: 'station',     price: 2500, rentTable: [],                                       houseCost: 0 },
  // 浅蓝组
  { index: 6,  key: 'lb_satellite', name: '卫星城',     type: 'property',    group: 'light_blue',  price: 1200, rentTable: [70,240,550,980,1500,4200],              houseCost: 500 },
  { index: 7,  key: 'jail',         name: '监狱 / 探监', type: 'jail',        group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 8,  key: 'lb_newcity',   name: '新城',       type: 'property',    group: 'light_blue',  price: 1300, rentTable: [80,290,630,1100,1700,4700],              houseCost: 500 },
  { index: 9,  key: 'lb_riverside', name: '滨江花园',   type: 'property',    group: 'light_blue',  price: 1400, rentTable: [90,330,700,1220,1900,5200],            houseCost: 500 },
  { index: 10, key: 'event_cityhall', name: '市政厅',    type: 'event',       group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  // 粉色组
  { index: 11, key: 'pk_sunshine',  name: '阳光小区',   type: 'property',    group: 'pink',        price: 1700, rentTable: [90,340,740,1300,2000,5300],             houseCost: 700 },
  { index: 12, key: 'util_electric', name: '电力公司',  type: 'utility',     group: 'utility',     price: 2000, rentTable: [],                                       houseCost: 0 },
  { index: 13, key: 'pk_uni',       name: '大学城',     type: 'property',    group: 'pink',        price: 1800, rentTable: [100,390,830,1450,2200,5800],            houseCost: 700 },
  { index: 14, key: 'pk_luxury',    name: '滨江豪庭',   type: 'property',    group: 'pink',        price: 1900, rentTable: [110,440,920,1600,2400,6300],           houseCost: 700 },
  { index: 15, key: 'rail_east',    name: '上海虹桥',   type: 'station',     group: 'station',     price: 2500, rentTable: [],                                       houseCost: 0 },
  // 橙色组
  { index: 16, key: 'og_high',      name: '高新区',     type: 'property',    group: 'orange',      price: 2200, rentTable: [120,480,1000,1750,2600,6800],           houseCost: 900 },
  { index: 17, key: 'chance_a',     name: '机会',        type: 'chance',      group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 18, key: 'og_lujiazui',  name: '陆家嘴',     type: 'property',    group: 'orange',      price: 2300, rentTable: [130,530,1080,1900,2800,7300],           houseCost: 900 },
  { index: 19, key: 'og_center',    name: '市中心广场', type: 'property',    group: 'orange',      price: 2400, rentTable: [140,580,1160,2050,3000,7800],          houseCost: 900 },
  { index: 20, key: 'free_parking', name: '自由停车',   type: 'free_parking', group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  // 红色中端组：3/4房大幅下调，只有旅馆有高额租金
  { index: 21, key: 'rd_jinqiao',   name: '金桥',       type: 'property',    group: 'red',         price: 2800, rentTable: [160,620,1280,2200,3300,9000],           houseCost: 1100 },
  { index: 22, key: 'fate_c',       name: '命运',        type: 'fate',        group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 23, key: 'rd_commercial',name: '商业街',     type: 'property',    group: 'red',         price: 2900, rentTable: [170,670,1360,2350,3500,9500],          houseCost: 1100 },
  { index: 24, key: 'rd_jingan',    name: '静安寺',     type: 'property',    group: 'red',         price: 3000, rentTable: [180,720,1440,2500,3700,10000],          houseCost: 1100 },
  { index: 25, key: 'rail_south',   name: '广州站',     type: 'station',     group: 'station',     price: 2500, rentTable: [],                                       houseCost: 0 },
  // 黄色组
  { index: 26, key: 'yl_purple',    name: '紫金山',     type: 'property',    group: 'yellow',      price: 3200, rentTable: [200,760,1520,2650,3900,10800],           houseCost: 1300 },
  { index: 27, key: 'yl_xuanwu',    name: '玄武湖',     type: 'property',    group: 'yellow',      price: 3300, rentTable: [210,810,1600,2800,4100,11300],          houseCost: 1300 },
  { index: 28, key: 'util_water',   name: '自来水公司', type: 'utility',     group: 'utility',     price: 2000, rentTable: [],                                       houseCost: 0 },
  { index: 29, key: 'yl_xinjiekou', name: '新街口',     type: 'property',    group: 'yellow',      price: 3400, rentTable: [220,860,1680,2950,4300,11800],          houseCost: 1300 },
  { index: 30, key: 'go_to_jail',   name: '进监狱',     type: 'go_to_jail',  group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  // 绿色高端：3/4房砍半级下调，旅馆适度压低，杜绝中期碾压
  { index: 31, key: 'gn_mansion',   name: '滨江豪宅',   type: 'property',    group: 'green',       price: 3700, rentTable: [250,950,1850,3200,4600,13000],          houseCost: 1400 },
  { index: 32, key: 'gn_bund',      name: '外滩',       type: 'property',    group: 'green',       price: 3900, rentTable: [270,1040,2000,3400,4900,14200],         houseCost: 1400 },
  { index: 33, key: 'chance_b',     name: '机会',        type: 'chance',      group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 34, key: 'gn_pearl',     name: '东方明珠',   type: 'property',    group: 'green',       price: 4100, rentTable: [290,1130,2150,3600,5200,15400],         houseCost: 1400 },
  { index: 35, key: 'rail_west',    name: '深圳站',     type: 'station',     group: 'station',     price: 2500, rentTable: [],                                       houseCost: 0 },
  // 深蓝顶级地块：严格限制3/4房租金，旅馆上限大幅压缩
  { index: 36, key: 'db_changan',   name: '长安街',     type: 'property',    group: 'dark_blue',   price: 4800, rentTable: [360,1400,2600,4300,6000,18000],         houseCost: 1700 },
  { index: 37, key: 'event_surprise',name: '惊喜广场',  type: 'event',       group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 38, key: 'tax_lux',      name: '奢侈税',     type: 'tax',         group: null,         price: 0,    rentTable: [],                                       houseCost: 0 },
  { index: 39, key: 'db_tiananmen', name: '天安门',     type: 'property',    group: 'dark_blue',   price: 5300, rentTable: [420,1650,2900,4800,6600,20000],         houseCost: 1700 },
];

// 索引缓存：解决 7/14/21/27 等硬编码的"反查"
const BOARD_INDEX = {
  go: BOARD.findIndex(t => t.type === 'go'),
  jail: BOARD.findIndex(t => t.type === 'jail'),
  free_parking: BOARD.findIndex(t => t.type === 'free_parking'),
  go_to_jail: BOARD.findIndex(t => t.type === 'go_to_jail'),
  tax_income: BOARD.findIndex(t => t.type === 'tax' && t.key === 'tax_income'),
  tax_lux: BOARD.findIndex(t => t.type === 'tax' && t.key === 'tax_lux'),
};
// 通用 key → index
function indexOfKey(key) { return BOARD.findIndex(t => t.key === key); }

// 派生：色组包含哪些格
const GROUP_TILES = {};
for (const t of BOARD) {
  if (t.group) {
    if (!GROUP_TILES[t.group]) GROUP_TILES[t.group] = [];
    GROUP_TILES[t.group].push(t.index);
  }
}

// 工具：把 BOARD 拷贝为运行时 tile 状态
function freshTile(def, scale = 1) {
  const scaleNum = (n) => Math.max(1, Math.round(n * scale));
  return {
    index: def.index,
    key: def.key || null,           // 保留 key（用于 resolveTile 索引反查、卡牌 action）
    name: def.name,
    type: def.type,
    group: def.group,
    price: def.price ? scaleNum(def.price) : 0,
    houseCost: def.houseCost ? scaleNum(def.houseCost) : 0,
    rentTable: def.rentTable.map(r => scaleNum(r)),
    mortgageValue: def.price ? Math.floor(scaleNum(def.price) / 2) : 0,
    unmortgageCost: def.price ? Math.ceil(scaleNum(def.price) * 0.55) : 0,
    ownerId: null,
    mortgage: false,
    houses: 0,
  };
}

// ============== 卡牌（机会 12 + 命运 12） ==============
const CHANCE_CARDS = [
  { id: 'c1', text: '出发！前进到 GO 领取 2000 元', actionKey: 'advanceToGO' },
  { id: 'c2', text: '前进到最近的车站', actionKey: 'advanceToNearestStation' },
  { id: 'c3', text: '前进到最近的公用事业', actionKey: 'advanceToNearestUtility' },
  { id: 'c4', text: '银行派发股息，领取 1500 元', actionKey: 'gain1500' },
  { id: 'c5', text: '缴交罚单 500 元', actionKey: 'pay500' },
  { id: 'c6', text: '免费出狱卡（保留至使用）', actionKey: 'jailCard' },
  { id: 'c7', text: '后退 3 格', actionKey: 'back3' },
  { id: 'c8', text: '直接进监狱（不过 GO）', actionKey: 'goToJailNoPass' },
  { id: 'c9', text: '每位玩家给你 500 元', actionKey: 'collectFromEach500' },
  { id: 'c10', text: '前进到 长安街', actionKey: 'advanceTo27' },
  { id: 'c11', text: '房屋维修：每栋 500，酒店 2500', actionKey: 'repairChance' },
  { id: 'c12', text: '前进到 外滩', actionKey: 'advanceTo25' },
  { id: 'c13', text: '投资获利，领取 2000 元', actionKey: 'gain2000' },
  { id: 'c14', text: '生日礼物，每位玩家给你 200 元', actionKey: 'collectFromEach200' },
  { id: 'c15', text: '车辆维修费，缴纳 1000 元', actionKey: 'pay1000' },
  { id: 'c16', text: '抽奖中，随机获得 500-3000 元', actionKey: 'randomGain500_3000' },
];

const FATE_CARDS = [
  { id: 'f1', text: '出发！前进到 GO 领取 2000 元', actionKey: 'advanceToGO' },
  { id: 'f2', text: '直接进监狱', actionKey: 'goToJailNoPass' },
  { id: 'f3', text: '免费出狱卡', actionKey: 'jailCard' },
  { id: 'f4', text: '缴税 1000 元', actionKey: 'pay1000' },
  { id: 'f5', text: '银行贷款 2000 元', actionKey: 'gain2000' },
  { id: 'f6', text: '前进到 市中心广场', actionKey: 'advanceTo16' },
  { id: 'f7', text: '缴交学校费用 1500 元', actionKey: 'pay1500' },
  { id: 'f8', text: '前进到 紫金山', actionKey: 'advanceTo22' },
  { id: 'f9', text: '生日快乐！领取 1000 元', actionKey: 'gain1000' },
  { id: 'f10', text: '房屋维修：每栋 400，酒店 2000', actionKey: 'repairFate' },
  { id: 'f11', text: '前进到 大学城', actionKey: 'advanceTo12' },
  { id: 'f12', text: '超速罚单 500 元', actionKey: 'pay500' },
  { id: 'f13', text: '投资失败，损失 1500 元', actionKey: 'pay1500' },
  { id: 'f14', text: '节日礼金，领取 2000 元', actionKey: 'gain2000' },
  { id: 'f15', text: '慈善募捐，每位玩家给你 100 元', actionKey: 'collectFromEach100' },
  { id: 'f16', text: '错时罚款，缴纳 200 元', actionKey: 'pay200' },
];

// 事件格卡牌（独立于 chance/fate）
const EVENT_CARDS = [
  { id: 'e1',  text: '市政厅发红包，领取 500 元',         actionKey: 'gain500' },
  { id: 'e2',  text: '路桥建设费，缴纳 300 元',            actionKey: 'pay300' },
  { id: 'e3',  text: '拾金不昧，下回合过 GO 奖金翻倍',     actionKey: 'nextGoBonus2x' },
  { id: 'e4',  text: '每位玩家给你 200 元',                actionKey: 'collectFromEach200' },
  { id: 'e5',  text: '银行派息，领取 1500 元',             actionKey: 'gain1500' },
  { id: 'e6',  text: '直接进监狱（不过 GO）',              actionKey: 'goToJailNoPass' },
  { id: 'e7',  text: '车辆违章，缴纳 800 元',              actionKey: 'pay800' },
  { id: 'e8',  text: '股市小赚，领取 2000 元',             actionKey: 'gain2000' },
  { id: 'e9',  text: '免费出狱卡（保留至使用）',           actionKey: 'jailCard' },
  { id: 'e10', text: '酒店检查，下栋楼少 50%',            actionKey: 'nextBuildHalfPrice' },
  { id: 'e11', text: '慈善募捐，向每位玩家支付 300 元',     actionKey: 'payEach300' },
  { id: 'e12', text: '生日快乐，领取 1000 元',             actionKey: 'gain1000' },
];

// ============== 卡牌动作 ==============
// 签名：({room, player, io, log}) → 返回需要在 resolveTile 之后继续处理的标记
const CARD_ACTIONS = {
  advanceToGO({ room, player, log }) {
    movePlayerTo(room, player, 0, log, /*passGoBonus=*/true);
  },
  advanceToNearestStation({ room, player, log }) {
    // 动态从 BOARD 找所有 station，按 index 升序
    const stations = BOARD.filter(t => t.type === 'station').map(t => t.index).sort((a, b) => a - b);
    let target = stations.find(s => s > player.position);
    if (target === undefined) target = stations[0]; // wrap
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  advanceToNearestUtility({ room, player, log }) {
    const utils = BOARD.filter(t => t.type === 'utility').map(t => t.index).sort((a, b) => a - b);
    let target = utils.find(u => u > player.position);
    if (target === undefined) target = utils[0];
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  gain500({ room, player, log }) {
    const amt = Math.round(500 * (room.settings?.scale || 1));
    player.money += amt;
    log.push(`${player.name} 领取 ${amt} 元`);
  },
  gain1000({ room, player, log }) {
    const amt = Math.round(1000 * (room.settings?.scale || 1));
    player.money += amt;
    log.push(`${player.name} 祝福！领取 ${amt} 元`);
  },
  gain1500({ room, player, log }) {
    const amt = Math.round(1500 * (room.settings?.scale || 1));
    player.money += amt;
    log.push(`${player.name} 领取股息 ${amt} 元`);
  },
  gain2000({ room, player, log }) {
    const amt = Math.round(2000 * (room.settings?.scale || 1));
    player.money += amt;
    log.push(`${player.name} 领取 ${amt} 元`);
  },
  pay200({ room, player, log }) {
    const amt = Math.round(200 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '错时罚款', log);
  },
  pay300({ room, player, log }) {
    const amt = Math.round(300 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '路桥建设费', log);
  },
  pay500({ room, player, log }) {
    const amt = Math.round(500 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '罚单', log);
  },
  pay800({ room, player, log }) {
    const amt = Math.round(800 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '车辆违章', log);
  },
  pay1000({ room, player, log }) {
    const amt = Math.round(1000 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '缴税', log);
  },
  pay1500({ room, player, log }) {
    const amt = Math.round(1500 * (room.settings?.scale || 1));
    chargeMoney(room, player, amt, null, '学校费用', log);
  },
  back3({ room, player, log }) {
    const target = (player.position - 3 + BOARD.length) % BOARD.length;
    movePlayerTo(room, player, target, log, false);
  },
  goToJailNoPass({ room, player, log }) {
    sendToJail(room, player, log, /*passGo=*/false);
  },
  collectFromEach100({ room, player, log }) {
    const amt = Math.round(100 * (room.settings?.scale || 1));
    for (const p of room.players) {
      if (p.id === player.id || p.bankrupt || p.disconnected) continue;
      const ok = chargeMoney(room, p, amt, player.id, `付给 ${player.name}`, log);
      if (ok) player.money += amt;
    }
  },
  collectFromEach200({ room, player, log }) {
    const amt = Math.round(200 * (room.settings?.scale || 1));
    for (const p of room.players) {
      if (p.id === player.id || p.bankrupt || p.disconnected) continue;
      const ok = chargeMoney(room, p, amt, player.id, `付给 ${player.name}`, log);
      if (ok) player.money += amt;
    }
  },
  collectFromEach500({ room, player, log }) {
    const amt = Math.round(500 * (room.settings?.scale || 1));
    for (const p of room.players) {
      if (p.id === player.id || p.bankrupt || p.disconnected) continue;
      const ok = chargeMoney(room, p, amt, player.id, `付给 ${player.name}`, log);
      if (ok) player.money += amt;
    }
  },
  payEach300({ room, player, log }) {
    const amt = Math.round(300 * (room.settings?.scale || 1));
    for (const p of room.players) {
      if (p.id === player.id || p.bankrupt || p.disconnected) continue;
      const ok = chargeMoney(room, player, amt, p.id, `付给 ${p.name}`, log);
      if (!ok) break;  // 付款方破产，停止继续支付
      p.money += amt;
    }
  },
  randomGain500_3000({ room, player, log }) {
    const scale = room.settings?.scale || 1;
    const baseMin = Math.round(500 * scale);
    const baseMax = Math.round(3000 * scale);
    const amount = baseMin + randomInt(0, 26) * Math.max(1, Math.round(100 * scale));
    player.money += amount;
    log.push(`${player.name} 抽奖获得 ${amount} 元`);
  },
  // 临时 buff：下回合过 GO 奖金翻倍（实现见 startTurn 利息处）
  nextGoBonus2x({ player, log, room }) {
    player.nextGoBonus2x = true;
    log.push(`${player.name} 拾金不昧，下回合过 GO 奖金翻倍`);
  },
  nextBuildHalfPrice({ player, log }) {
    player.nextBuildHalfPrice = true;
    log.push(`${player.name} 酒店检查通过，下栋楼造价 50%`);
  },
  advanceTo27({ room, player, log }) {
    const target = indexOfKey('db_changan');
    if (target < 0) return;
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  advanceTo25({ room, player, log }) {
    const target = indexOfKey('gn_bund');
    if (target < 0) return;
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  advanceTo16({ room, player, log }) {
    const target = indexOfKey('og_center');
    if (target < 0) return;
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  advanceTo22({ room, player, log }) {
    const target = indexOfKey('yl_purple');
    if (target < 0) return;
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  advanceTo12({ room, player, log }) {
    const target = indexOfKey('pk_uni');
    if (target < 0) return;
    const passedGo = target <= player.position;
    movePlayerTo(room, player, target, log, passedGo);
  },
  repairChance({ room, player, log }) {
    const scale = room.settings?.scale || 1;
    let cost = 0;
    for (const t of room.board) {
      if (t.ownerId !== player.id) continue;
      if (t.houses === 5) cost += Math.round(2500 * scale);
      else cost += Math.round(500 * scale) * t.houses;
    }
    if (cost > 0) chargeMoney(room, player, cost, null, '房屋维修费', log);
    else log.push(`${player.name} 无房屋需要维修`);
  },
  repairFate({ room, player, log }) {
    const scale = room.settings?.scale || 1;
    let cost = 0;
    for (const t of room.board) {
      if (t.ownerId !== player.id) continue;
      if (t.houses === 5) cost += Math.round(2000 * scale);
      else cost += Math.round(400 * scale) * t.houses;
    }
    if (cost > 0) chargeMoney(room, player, cost, null, '房屋维修费', log);
    else log.push(`${player.name} 无房屋需要维修`);
  },
  jailCard({ room, player, log }) {
    player.jailCards += 1;
    log.push(`${player.name} 获得免费出狱卡`);
  },
};

// ============== 工具函数 ==============
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function rollDice() {
  const a = randomInt(1, 7);
  const b = randomInt(1, 7);
  return { a, b, total: a + b, doubles: a === b };
}
function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}
function getCurrentPlayer(room) {
  return room.players[room.turnIndex];
}
function activePlayers(room) {
  return room.players.filter(p => !p.bankrupt);
}
function ownsFullGroup(room, player, group) {
  if (!group) return false;
  const idxs = GROUP_TILES[group] || [];
  return idxs.length > 0 && idxs.every(i => room.board[i].ownerId === player.id);
}
function groupHasMortgage(room, group) {
  return (GROUP_TILES[group] || []).some(i => room.board[i].mortgage);
}
function getStationCount(room, player) {
  return room.board.filter(t => t.type === 'station' && t.ownerId === player.id).length;
}
function getUtilityCount(room, player) {
  return room.board.filter(t => t.type === 'utility' && t.ownerId === player.id).length;
}
// 计算净价值（抵押不计，房屋按建房原价计）
function netWorth(room, player) {
  let v = player.money;
  for (const t of room.board) {
    if (t.ownerId !== player.id) continue;
    if (t.mortgage) continue;
    v += t.price;
    if (t.houses > 0) v += t.houseCost * t.houses;
  }
  return v;
}
function getLoanCap(player, room) {
  const scale = room.settings?.scale || 1;
  const credit = player.loanCreditScore ?? LOAN_CREDIT_BASE;
  const currentLoan = player.loan || 0;
  const absMax = Math.round(LOAN_ABSOLUTE_CAP * scale);

  // 信用分 ≤0 时不能新贷款，但利息仍需能增长，所以上限直接给到绝对上限
  if (credit <= 0) {
    return Math.max(currentLoan, absMax);   // 保证 ≥ 当前欠款，可以继续涨利息
  }

  // 正常情况
  const baseCap = Math.round(
    (LOAN_INITIAL_CAP + Math.floor((room.turnCount || 0) / LOAN_CAP_INTERVAL) * LOAN_CAP_INCREMENT) * scale
  );
  const nw = netWorth(room, player);
  const nwCap = Math.round(nw * 0.5 * (credit / 100));
  const cap = Math.max(baseCap, nwCap, currentLoan);
  return Math.min(cap, absMax);
}
function updateCreditScore(player, room) {
  // 信用分 ≤ 0 是终局黑名单状态：永远不能再涨回去，必须主动还款加分（handleRepay）才能恢复
  if ((player.loanCreditScore ?? LOAN_CREDIT_BASE) <= 0) return 0;
  // 从当前分数开始，保留贷款扣分、还款加分等一次性修正
  let score = player.loanCreditScore ?? LOAN_CREDIT_BASE;
  const scale = room.settings?.scale || 1;
  // 总资产状态浮动调整
  const nw = netWorth(room, player);
  if (nw > LOAN_CREDIT_ASSET_THRESHOLD_1 * scale) score = Math.min(100, score + 3);
  else if (nw > LOAN_CREDIT_ASSET_THRESHOLD_2 * scale) score = Math.min(100, score + 2);
  // 现金不足扣分
  if (player.money < (room.settings?.startingMoney || 8000) * 0.2) score = Math.max(0, score - 3);
  return Math.max(0, Math.min(100, score));
}
function getRent(room, player, tile, diceTotal) {
  if (tile.ownerId === player.id) return 0;
  if (tile.mortgage) return 0;
  if (tile.type === 'property') {
    return tile.rentTable[Math.min(tile.houses, 5)];
  }
  if (tile.type === 'station') {
    return Math.round(500 * (room.settings?.scale || 1) * getStationCount(room, ownerOf(room, tile)));
  }
  if (tile.type === 'utility') {
    const n = getUtilityCount(room, ownerOf(room, tile));
    return Math.round(diceTotal * (n === 1 ? 6 : 12) * (room.settings?.scale || 1));
  }
  return 0;
}
function ownerOf(room, tile) {
  return room.players.find(p => p.id === tile.ownerId);
}
function pushLog(room, msg) {
  room.log.push({ ts: Date.now(), text: msg });
  if (room.log.length > 50) room.log.splice(0, room.log.length - 50);
}

// 统一发放 GO 奖金（处理 nextGoBonus2x 翻倍 buff）；log 为字符串数组
function awardGoBonus(room, player, log) {
  const bonus = room.settings.goBonus * (player.nextGoBonus2x ? 2 : 1);
  if (player.nextGoBonus2x) {
    player.nextGoBonus2x = false;
    log.push(`${player.name} 拾金不昧 buff 生效，GO 奖金翻倍！`);
  }
  player.money += bonus;
  log.push(`${player.name} 经过 GO，领取 ${bonus} 元`);
}

// 移动玩家到指定位置（不处理落格事件——只移动）
function movePlayerTo(room, player, target, log, passGo) {
  if (passGo) awardGoBonus(room, player, log);
  player.position = target;
}

// 发送玩家进监狱
function sendToJail(room, player, log, passGo) {
  if (passGo) awardGoBonus(room, player, log);
  player.position = BOARD_INDEX.jail;
  player.jailTurns = 0;
  player.jailing = true;
  player.rolledDoubles = false;
  player.jailDoubles = 0;  // 修复：确保进监狱时重置
  log.push(`${player.name} 被关进监狱`);
}

// 玩家尝试自动套现：卖房 → 抵押
function autoRaiseCash(room, player, need) {
  const log = [];
  // 1) 卖房（hotel→4→3→2→1，按均匀建造）
  let changed = true;
  while (player.money < need && changed) {
    changed = false;
    for (const t of room.board) {
      if (t.ownerId !== player.id) continue;
      if (t.houses === 0) continue;
      // 均匀建造：卖后该格仍可允许 (others.min + 1)
      const others = room.board.filter(x => x.group === t.group && x.index !== t.index);
      const othersMin = Math.min(...others.map(x => x.houses));
      if (t.houses - 1 < othersMin) continue; // 不能打破均匀
      player.money += Math.floor(t.houseCost / 2);
      t.houses -= 1;
      log.push(`自动卖房：${t.name}（+${Math.floor(t.houseCost / 2)}）`);
      changed = true;
      if (player.money >= need) break;
    }
  }
  // 2) 抵押（无房、未已抵押的，按地产价值从低到高）
  const candidates = room.board
    .filter(t => t.ownerId === player.id && t.houses === 0 && !t.mortgage && t.price > 0)
    .sort((a, b) => a.price - b.price);
  for (const t of candidates) {
    if (player.money >= need) break;
    player.money += t.mortgageValue;
    t.mortgage = true;
    log.push(`自动抵押：${t.name}（+${t.mortgageValue}）`);
  }
  // 关键：把字符串 log 转成对象（保持 room.log 格式统一，避免客户端 .text 显示 undefined）
  const now = Date.now();
  for (const t of log) room.log.push({ ts: now, text: t });
  return player.money >= need;
}

// 玩家破产：有债主 → 资产转移给债主（保留房屋/抵押）；无债主 → 资产变无主
function declareBankruptcy(room, player, creditorId) {
  player.bankrupt = true;
  player.bankruptToId = creditorId || null;
  pushLog(room, `${player.name} 破产出局！`);
  const creditor = creditorId ? room.players.find(p => p.id === creditorId && !p.bankrupt) : null;
  // 转移 / 清空 资产
  for (const t of room.board) {
    if (t.ownerId !== player.id) continue;
    if (creditor) {
      // 转移（含抵押、含房屋）：所有权换主、债主 propertiesOwned 加这条
      t.ownerId = creditor.id;
      creditor.propertiesOwned.push(t.index);
    } else {
      // 无债主（欠银行）：清空
      t.ownerId = null;
      t.mortgage = false;
      t.houses = 0;
    }
  }
  player.propertiesOwned = [];
  // 剩余现金归债主（负数不倒扣债主；无债主 → 销毁）
  if (creditor) creditor.money += Math.max(0, player.money);
  player.money = 0;
  // 出狱卡给债主
  if (creditor && player.jailCards > 0) creditor.jailCards += player.jailCards;
  player.jailCards = 0;
  pushLog(room, creditor ? `${player.name} 资产转移给 ${creditor.name}` : `${player.name} 资产清空`);
  // 出狱卡随玩家移除
  // 如果破产玩家是当前回合玩家，自动推进到下一个非破产玩家
  const cur = room.players[room.turnIndex];
  if (cur && cur.id === player.id) {
    const remaining = activePlayers(room);
    if (remaining.length >= 2) {
      nextTurn(room);
    }
    // 剩余 < 2 由 nextTurn 内部处理终局
  }
  // 检查胜出
  const remaining = activePlayers(room);
  if (remaining.length === 1 && room.state !== 'FINISHED') {
    room.state = 'FINISHED';
    room.winnerId = remaining[0].id;
    room.finishedAt = Date.now();
    pushLog(room, `🏆 ${remaining[0].name} 获胜！`);
    io.to(room.code).emit('room:ended', { winnerId: remaining[0].id });
  }
}

// 处理玩家欠款（租、税、卡）后扣款并检测破产
function chargeMoney(room, player, amount, creditorId, reason, log) {
  player.money -= amount;
  log.push(`${player.name} 支付 ${amount} 元（${reason}）`);
  if (player.money < 0) {
    // 阶段1：自动套现（卖房→抵押）
    autoRaiseCash(room, player, 0);
    // 阶段2：自动贷款应急（信用分归零的黑名单玩家不放贷）
    if (player.money < 0 && (player.loanCreditScore ?? LOAN_CREDIT_BASE) > 0) {
      const need = Math.abs(player.money);
      const cap = getLoanCap(player, room);
      const avail = cap - (player.loan || 0);
      if (avail > 0) {
        const scale = room.settings?.scale || 1;
        const allowed = LOAN_ALLOWED_AMOUNTS.map(a => Math.round(a * scale)).filter(a => a <= avail).sort((a, b) => a - b);
        const loanAmt = allowed.length > 0 ? (allowed.find(a => a >= need) || allowed.pop()) : 0;
        if (loanAmt > 0) {
          player.loan = (player.loan || 0) + loanAmt;
          player.money += loanAmt;
          log.push(`${player.name} 自动贷款 ${loanAmt} 元应急（欠款 ${player.loan}）`);
        }
      }
    }
    // 阶段3：仍不足则破产
    if (player.money < 0) {
      declareBankruptcy(room, player, creditorId);
      return false;
    }
  }
  return true;
}

// 决定当前回合玩家后，初始化 subState
function startTurn(io, room) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.bankrupt) {
    nextTurn(room);
    return;
  }
    // --- 贷款利息 + 强制还款 + 破产检查 ---
  // 先做数据清洗，防止 NaN / undefined 污染
  cur.loan = Number(cur.loan) || 0;
  cur.loanCreditScore = Number(cur.loanCreditScore ?? LOAN_CREDIT_BASE);
  cur.loanConsecutiveNonRepay = Number(cur.loanConsecutiveNonRepay) || 0;
  cur.loanActionsLeft = cur.loanActionsLeft || { loan: 1, repay: 1 };
  
  if (cur.loan > 0) {
    // 1) 计算利率
    const missed = cur.loanConsecutiveNonRepay;
    let rate = LOAN_BASE_RATE;
    if (missed >= LOAN_OVERDUE_TURNS) {
      rate = LOAN_OVERDUE_RATE;
    } else if (missed > 0) {
      rate = Math.min(LOAN_OVERDUE_RATE, LOAN_BASE_RATE + missed * LOAN_RATE_INCREMENT);
    }
    
    // 2) 计算利息（cap 已经保证 ≥ loan）
    const interest = Math.ceil(cur.loan * rate);
    const cap = getLoanCap(cur, room);   // 必定 ≥ cur.loan
    
    if (interest > 0) {
      // 利息不会让贷款突破 cap（cap ≥ loan，所以最多加到 cap）
      const roomLeft = cap - cur.loan;
      const actualInterest = Math.min(interest, roomLeft);
      cur.loan += actualInterest;
      if (actualInterest < interest) {
        pushLog(room, `${cur.name} 贷款已达上限，利息仅 +${actualInterest}（上限 ${cap}），欠款 ${cur.loan}`);
      } else {
        pushLog(room, `${cur.name} 贷款利息 +${actualInterest}（利率 ${Math.round(rate * 100)}%），欠款 ${cur.loan}`);
      }
    }
    
    // 3) 强制最低还款（仅逾期时）
    const minPay = Math.min(Math.ceil(cur.loan * LOAN_AUTO_REPAY_RATIO), cur.loan);
    if (cur.loanConsecutiveNonRepay > 0) {
      if (cur.money >= minPay && minPay > 0) {
        cur.money -= minPay;
        cur.loan -= minPay;
        pushLog(room, `${cur.name} 强制最低还款 ${minPay} 元（逾期），欠款余额 ${cur.loan}`);
        // 强制还款属于系统行为，不改变连续未还状态（仍算未主动履行义务）
      } else {
        cur.loanConsecutiveNonRepay += 1;
        pushLog(room, `${cur.name} 现金不足无法最低还款（需 ${minPay} 元），连续未还 ${cur.loanConsecutiveNonRepay} 次`);
      }
    } else {
      if (cur.loan > 0) {
        pushLog(room, `${cur.name} 当前欠款 ${cur.loan} 元，最低还款 ${minPay} 元（利率 ${Math.round(rate * 100)}%）`);
      }
    }
    
    // 4) 强制破产检查
    if (cur.loan > 0) {
      const nw = netWorth(room, cur);
      if (cur.loan > nw * LOAN_FORCED_CLOSE_RATIO) {
        pushLog(room, `${cur.name} 负债率过高（欠款 ${cur.loan}，净资 ${nw}），强制清盘！`);
        declareBankruptcy(room, cur, null);
        broadcastState(io, room);
        return;
      }
    }
  }
  // 更新信用评分
  cur.loanCreditScore = updateCreditScore(cur, room);

   // 👇 在这里添加（第1处）
  if (cur.loanCreditScore <= 0 && (cur._lastCreditWarned !== room.turnCount)) {
    pushLog(room, `${cur.name} 信誉分为0，和纯处生cd坐一桌`);
    cur._lastCreditWarned = room.turnCount;
  }

  // 初始化本回合贷款操作次数
  cur.loanActionsLeft = { loan: 1, repay: 1 };
  if (cur.jailing) {
    room.subState = 'JAIL_DECISION';
  } else {
    room.subState = 'ROLLING';
  }
  pushLog(room, `轮到 ${cur.name} 行动`);
  room.turnStartedAt = Date.now();
}

// 推进到下一位
function nextTurn(room) {
  room.turnCount = (room.turnCount || 0) + 1;
  if (activePlayers(room).length < 2) {
    // 检查终局
    const remaining = activePlayers(room);
    if (remaining.length === 1 && room.state !== 'FINISHED') {
      room.state = 'FINISHED';
      room.winnerId = remaining[0].id;
      room.finishedAt = Date.now();
      pushLog(room, `🏆 ${remaining[0].name} 获胜！`);
      io.to(room.code).emit('room:ended', { winnerId: remaining[0].id });
    }
    return;
  }
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (room.turnIndex + i) % n;
    const p = room.players[idx];
    if (!p.bankrupt) {
      room.turnIndex = idx;
      startTurn(io, room);
      return;
    }
  }
}

// ============== 房间存储 ==============
const rooms = new Map();         // code -> Room
const socketToRoom = new Map();  // socket.id -> code
const socketToPlayer = new Map();// socket.id -> playerId

// ============== 房间创建 ==============
function newRoom(hostSocket, name, avatar, pawnColor, settings) {
  const code = genRoomCode();
  // 验证 settings（白名单 + 范围检查）
  const safe = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const candidates = SETTINGS_PRESETS[k];
    const v = settings && settings[k];
    safe[k] = candidates.includes(v) ? v : DEFAULT_SETTINGS[k];
  }
  // 缩放因子：所有金钱按 startingMoney/8000 等比例缩放
  // 让"起始资金"选项真正影响地图上所有数字（格价、租金、卡牌金额、贷款 cap、GO 奖金、监狱费等）
  safe.scale = Math.round((safe.startingMoney / DEFAULT_SETTINGS.startingMoney) * 1000) / 1000;
  // GO 奖金、监狱费也按 scale 缩放
  safe.goBonus = Math.round(safe.goBonus * safe.scale);
  safe.jailFine = Math.round(safe.jailFine * safe.scale);
  const host = {
    id: hostSocket.id,
    name: name.slice(0, 16) || '玩家',
    avatar: avatar || '🙂',
    pawnColor: pawnColor || '#e84545',
    money: safe.startingMoney,
    position: 0,
    jailTurns: 0,
    jailing: false,
    jailCards: 0,
    bankrupt: false,
    bankruptToId: null,
    disconnected: false,
    propertiesOwned: [],
    isHost: true,
    loan: 0,                          // 欠款余额（融资机制）
    loanCreditScore: 60,              // 信用评分 0-100
    loanLastTurn: -99,                // 上次贷款回合（-99 允许开局即贷）
    loanConsecutiveNonRepay: 0,        // 连续未还款回合数
    loanActionsLeft: { loan: 1, repay: 1 },
    nextGoBonus2x: false,              // 临时 buff：下回合过 GO 奖金翻倍
    nextBuildHalfPrice: false,         // 临时 buff：下栋楼造价 50%
    rolledDoubles: false,              // 上一掷是否双数（决定结束回合是否再掷）
  };
  const room = {
    code,
    hostId: host.id,
    state: 'WAITING',
    players: [host],
    board: BOARD.map(t => freshTile(t, safe.scale)),
    decks: { chance: [], fate: [], event: [] },
    discard: { chance: [], fate: [], event: [] },
    turnIndex: 0,
    turnCount: 0,         // 全局回合计数（用于贷款上限增长等）
    subState: 'ROLLING',
    auction: null,
    pot: 0,               // 自由停车奖池（税款/监狱赎金进池,踩到自由停车全拿）
    log: [],
    chat: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    winnerId: null,
    lastDice: null, // {a,b,total,doubles,playerId} 用于公用事业租金
    settings: safe,  // 房主自定义：startingMoney / goBonus / jailFine
    turnStartedAt: null,    // 需求4：当前回合开始时间戳（用于超时）
    pendingTrade: null,      // 需求3：进行中的玩家间交易
  };
  rooms.set(code, room);
  return room;
}

// ============== sanitizeRoom 函数 - 保留 chat 字段 ==============
function sanitizeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      pawnColor: p.pawnColor,
      money: p.money,
      netWorth: netWorth(room, p),
      rolledDoubles: p.rolledDoubles || false,
      position: p.position,
      jailing: p.jailing || false,
      jailCards: p.jailCards,
      jailTurns: p.jailTurns,
      bankrupt: p.bankrupt,
      disconnected: p.disconnected,
      isHost: p.isHost,
      loan: p.loan || 0,
      loanCreditScore: p.loanCreditScore ?? LOAN_CREDIT_BASE,
      loanLastTurn: p.loanLastTurn ?? -99,
      loanConsecutiveNonRepay: p.loanConsecutiveNonRepay ?? 0,
      loanActionsLeft: p.loanActionsLeft || { loan: 1, repay: 1 },
      loanCap: getLoanCap(p, room),
      propertiesOwned: p.propertiesOwned.slice(),
    })),
    board: room.board.map(t => ({
      index: t.index,
      name: t.name,
      type: t.type,
      group: t.group,
      price: t.price,
      houseCost: t.houseCost,
      rentTable: t.rentTable.slice(),
      mortgageValue: t.mortgageValue,
      unmortgageCost: t.unmortgageCost,
      ownerId: t.ownerId,
      mortgage: t.mortgage,
      houses: t.houses,
    })),
    turnIndex: room.turnIndex,
    subState: room.subState,
    pot: room.pot || 0,
    auction: room.auction ? {
      tileIndex: room.auction.tileIndex,
      currentBid: room.auction.currentBid,
      currentBidderId: room.auction.currentBidderId,
      endsAt: room.auction.endsAt,
      activeBidders: room.auction.activeBidders.slice(),
    } : null,
    log: room.log.slice(-12),
    chat: room.chat.slice(-50),  // 保留 chat 字段
    winnerId: room.winnerId,
    lastDice: room.lastDice,
    settings: room.settings,
    groupTiles: GROUP_TILES,
    pendingTrade: room.pendingTrade ? {
      id: room.pendingTrade.id,
      fromId: room.pendingTrade.fromId,
      toId: room.pendingTrade.toId,
      offer: room.pendingTrade.offer,
      request: room.pendingTrade.request,
      createdAt: room.pendingTrade.createdAt,
    } : null,
    turnStartedAt: room.turnStartedAt,
    turnCount: room.turnCount || 0,
    constants: {
      GO_BONUS, STARTING_MONEY, JAIL_FINE, AUCTION_MIN_INCREMENT, JAIL_MAX_TURNS,
      LOAN_BASE_RATE, LOAN_INITIAL_CAP, LOAN_ABSOLUTE_CAP,
      LOAN_MIN_REPAY_RATIO, LOAN_GAP_TURNS, LOAN_OVERDUE_TURNS,
      LOAN_CREDIT_BASE, LOAN_ALLOWED_AMOUNTS,
      LOAN_CAP_INTERVAL, LOAN_CAP_INCREMENT,
      TURN_TIMEOUT_MS,
    },
  };
}



function broadcastState(io, room) {
  io.to(room.code).emit('room:state', sanitizeRoom(room));
}

function shuffleDecks(room) {
  room.decks.chance = shuffleInPlace(CHANCE_CARDS.map(c => ({ ...c })));
  room.decks.fate = shuffleInPlace(FATE_CARDS.map(c => ({ ...c })));
  room.decks.event = shuffleInPlace(EVENT_CARDS.map(c => ({ ...c })));
  room.discard.chance = [];
  room.discard.fate = [];
  room.discard.event = [];
}
function drawCard(room, which) {
  if (room.decks[which].length === 0) {
    // 重洗弃牌
    if (room.discard[which].length === 0) {
      shuffleDecks(room); // 双保险
    } else {
      room.decks[which] = shuffleInPlace(room.discard[which].map(c => ({ ...c })));
      room.discard[which] = [];
    }
  }
  const card = room.decks[which].shift();
  return card;
}
function discardCard(room, which, card) {
  room.discard[which].push(card);
}

// ============== 游戏开始 ==============
function startGame(io, room) {
  // 随机化顺序（房主身份保持不变，只影响行动次序）
  room.players = shuffleInPlace(room.players.slice());
  for (const p of room.players) p.isHost = (p.id === room.hostId);
  room.turnIndex = 0;
  room.state = 'IN_PROGRESS';
  room.startedAt = Date.now();
  shuffleDecks(room);
  pushLog(room, '🎲 游戏开始！');
  startTurn(io, room);
  broadcastState(io, room);
}

// ============== 再来一局（FINISHED → 重置回 WAITING,保留玩家与设置） ==============
function resetRoomForRematch(io, room) {
  // 已断线玩家无法确认再来一局,移除
  room.players = room.players.filter(p => !p.disconnected);
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  // 房主若已不在,迁移给第一个玩家
  if (!room.players.some(p => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }
  const scale = room.settings?.scale || 1;
  for (const p of room.players) {
    p.isHost = (p.id === room.hostId);
    p.money = room.settings.startingMoney;
    p.position = 0;
    p.jailing = false;
    p.jailTurns = 0;
    p.jailCards = 0;
    p.bankrupt = false;
    p.bankruptToId = null;
    p.propertiesOwned = [];
    p.loan = 0;
    p.loanCreditScore = 60;
    p.loanLastTurn = -99;
    p.loanConsecutiveNonRepay = 0;
    p.loanActionsLeft = { loan: 1, repay: 1 };
    p.nextGoBonus2x = false;
    p.nextBuildHalfPrice = false;
    p.rolledDoubles = false;
    delete p._lastZeroWarn;
  }
  room.board = BOARD.map(t => freshTile(t, scale));
  room.decks = { chance: [], fate: [], event: [] };
  room.discard = { chance: [], fate: [], event: [] };
  room.turnIndex = 0;
  room.turnCount = 0;
  room.subState = 'ROLLING';
  room.auction = null;
  room.pot = 0;
  room.pendingTrade = null;
  room.lastDice = null;
  room.winnerId = null;
  room.startedAt = null;
  room.finishedAt = null;
  room.turnStartedAt = null;
  room.allDisconnectedAt = null;
  room.log = [];
  room.state = 'WAITING';
  pushLog(room, '🔄 再来一局！等待房主开始…');
  broadcastState(io, room);
}

// ============== 落格事件 ==============
function resolveTile(io, room, player) {
  const tile = room.board[player.position];
  const log = [];
  switch (tile.type) {
    case 'go':
      // 起点不会因为"落格"再给钱（已经在 movePlayerTo 处理了经过）
      if (!player.bankrupt) room.subState = 'ACTING';  // 关键：之前漏设，玩家落到 GO 后永远卡 MOVING
      break;
    case 'property':
    case 'station':
    case 'utility': {
      if (!tile.ownerId) {
        if (!player.bankrupt) room.subState = 'ACTING';
        log.push(`${player.name} 到达 ${tile.name}（无主）`);
      } else if (tile.ownerId === player.id) {
        if (!player.bankrupt) room.subState = 'ACTING';
        log.push(`${player.name} 到达自己拥有的 ${tile.name}`);
      } else {
        const owner = ownerOf(room, tile);
        const diceTotal = room.lastDice?.total || 0;
        const rent = getRent(room, player, tile, diceTotal);
        if (rent > 0) {
          const ok = chargeMoney(room, player, rent, owner.id, `${tile.name} 租金`, log);
          if (ok) {
            owner.money += rent;
            log.push(`${owner.name} 收到租金 ${rent} 元`);
            // 醒目提示：广播 rentPaid 事件（前端按身份区分横幅颜色）
            io.to(room.code).emit('game:rentPaid', {
              payerId: player.id,
              payerName: player.name,
              receiverId: owner.id,
              receiverName: owner.name,
              amount: rent,
              tileIndex: tile.index,
              tileName: tile.name,
            });
          } else {
            // 玩家破产：把 rent 视作已支付给 owner（已 transfer）
          }
        } else {
          log.push(`${tile.name} 已抵押，无租金`);
        }
        if (!player.bankrupt) room.subState = 'ACTING';
      }
      break;
    }
    case 'chance':
    case 'fate': {
      const which = tile.type === 'chance' ? 'chance' : 'fate';
      const card = drawCard(room, which);
      log.push(`${player.name} 抽到【${which === 'chance' ? '机会' : '命运'}】：${card.text}`);
      // 广播卡牌事件（前端显示弹窗）
      io.to(room.code).emit('game:cardDrawn', {
        type: which,
        text: card.text,
        playerName: player.name,
        actionKey: card.actionKey,
        cardId: card.id,
      });
      const fn = CARD_ACTIONS[card.actionKey];
      if (fn) {
        fn({ io, room, player, log });
      }
      // 消费卡牌（所有卡牌抽完后放回弃牌堆）
      discardCard(room, which, card);
      // 修：只要位置变了就重新 resolve（链式抽卡 / 卡牌移动到新格）
      if (player.position !== tile.index) {
        resolveTile(io, room, player);
      }
      // 兜底：进监狱则走 JAIL_DECISION，其他走 ACTING
      if (!player.bankrupt) {
        if (player.jailing) {
          room.subState = 'JAIL_DECISION';
        } else {
          if (!player.bankrupt) room.subState = 'ACTING';
        }
      }
      break;
    }
    case 'tax': {
      if (tile.key === 'tax_income') {
        // 所得税（1,800×scale 或 10% 净资产，取大值）→ 进自由停车奖池
        const flat = Math.round(1800 * (room.settings?.scale || 1));
        const percent = Math.floor(netWorth(room, player) * 0.1);
        const due = Math.max(flat, percent);
        log.push(`${player.name} 缴所得税 ${due} 元（净资 ${netWorth(room, player)}）`);
        const ok = chargeMoney(room, player, due, null, '所得税', log);
        if (ok) {
          room.pot = (room.pot || 0) + due;
          log.push(`🎁 奖池累积至 ${room.pot} 元`);
        }
      } else if (tile.key === 'tax_lux') {
        const luxAmt = Math.round(1500 * (room.settings?.scale || 1));
        log.push(`${player.name} 缴奢侈税 ${luxAmt} 元`);
        const ok = chargeMoney(room, player, luxAmt, null, '奢侈税', log);
        if (ok) {
          room.pot = (room.pot || 0) + luxAmt;
          log.push(`🎁 奖池累积至 ${room.pot} 元`);
        }
      }
      if (!player.bankrupt) room.subState = 'ACTING';
      break;
    }
    case 'event': {
      // 事件格：抽独立事件卡
      const card = drawCard(room, 'event');
      log.push(`${player.name} 踩到【${tile.name}】抽事件：${card.text}`);
      // 广播卡牌事件（前端显示弹窗）
      io.to(room.code).emit('game:cardDrawn', {
        type: 'event',
        text: card.text,
        playerName: player.name,
        actionKey: card.actionKey,
        cardId: card.id,
      });
      const fn = CARD_ACTIONS[card.actionKey];
      if (fn) fn({ io, room, player, log });
      discardCard(room, 'event', card);
      // 卡牌可能让位置变了，重新 resolve
      if (player.position !== tile.index && !player.bankrupt) {
        resolveTile(io, room, player);
        return;
      }
      if (player.jailing) {
        room.subState = 'JAIL_DECISION';
      } else {
        if (!player.bankrupt) room.subState = 'ACTING';
      }
      break;
    }
    case 'free_parking':
      if ((room.pot || 0) > 0) {
        // 奖池房规：踩到自由停车全额抱走
        player.money += room.pot;
        log.push(`🎁 ${player.name} 抱走自由停车奖池 ${room.pot} 元！`);
        room.pot = 0;
      } else {
        log.push(`${player.name} 在自由停车休息`);
      }
      if (!player.bankrupt) room.subState = 'ACTING';
      break;
    case 'jail':
      // 探监
      log.push(`${player.name} 探监`);
      if (!player.bankrupt) room.subState = 'ACTING';
      break;
    case 'go_to_jail': {
      sendToJail(room, player, log, false);
      room.subState = 'JAIL_DECISION';
      break;
    }
  }
  // 关键：resolveTile 的局部 log 是字符串数组，要转为 {ts, text} 对象才能与 pushLog 保持一致
  const now = Date.now();
  for (const text of log) {
    room.log.push({ ts: now, text });
  }
  if (room.log.length > 50) room.log.splice(0, room.log.length - 50);
}

// ============== 掷骰流程（含动画分步） ==============
// 简化：直接跳到目标位置（前端可自行加动画）
// ============== 修改 handleRollDice 函数 ==============
function handleRollDice(io, room, playerId) {
  if (room.state !== 'IN_PROGRESS') return;
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  // 移动期间拒绝重复掷骰请求，防止并发污染 room.lastDice 导致掷双误判
  if (room.subState === 'MOVING') return;
  if (room.subState !== 'ROLLING' && room.subState !== 'JAIL_DECISION') return;
  
  // 监狱掷双的情况
  if (room.subState === 'JAIL_DECISION' && cur.jailing) {
    const dice = rollDice();
    room.lastDice = { ...dice, playerId };
    io.to(room.code).emit('game:diceResult', dice);
    if (dice.doubles) {
      cur.jailing = false;
      cur.jailTurns = 0;
      cur.jailDoubles = 0;  // 修复：重置监狱双数计数
      pushLog(room, `${cur.name} 掷出双数 ${dice.a}+${dice.b}，成功出狱！`);
      // 用本次骰子移动（标准规则：掷双出狱移动后回合结束，不再掷）
      moveBySteps(io, room, cur, dice.total, /*fromJail=*/true, /*isDoubles=*/false);
    } else {
      cur.jailTurns += 1;
      pushLog(room, `${cur.name} 掷 ${dice.a}+${dice.b}，未出狱（第 ${cur.jailTurns} 次）`);
      if (cur.jailTurns >= JAIL_MAX_TURNS) {
        // 强制付钱出狱
        const log = [];
        chargeMoney(room, cur, room.settings.jailFine, null, '强制出狱费', log);
        const now = Date.now();
        for (const t of log) room.log.push({ ts: now, text: t });
        if (cur.bankrupt) {
          broadcastState(io, room);
          return;
        }
        cur.jailing = false;
        cur.jailTurns = 0;
        cur.jailDoubles = 0;  // 修复：重置监狱双数计数
        moveBySteps(io, room, cur, dice.total, true, /*isDoubles=*/false);
      } else {
        // 出狱失败，轮次结束（延迟 500ms 切回合，让前端看到"未出狱"状态）
        pushLog(room, `${cur.name} 本回合出狱失败，轮次结束`);
        broadcastState(io, room);
        setTimeout(() => {
          nextTurn(room);
          broadcastState(io, room);
        }, 500);
      }
    }
    return;
  }
  
  // 正常掷骰
  if (room.subState !== 'ROLLING') return;
  const dice = rollDice();
  room.lastDice = { ...dice, playerId };
  io.to(room.code).emit('game:diceResult', dice);
  
  // 3 连续双数：进监狱
  if (dice.doubles) {
    cur.jailDoubles = (cur.jailDoubles || 0) + 1;
    if (cur.jailDoubles >= 3) {
      pushLog(room, `${cur.name} 连续 3 次双数，进监狱！`);
      sendToJail(room, cur, [], false);
      cur.jailing = true;
      cur.jailDoubles = 0;
      cur.rolledDoubles = false;
      room.subState = 'JAIL_DECISION';
      broadcastState(io, room);
      return;
    }
  } else {
    cur.jailDoubles = 0;
  }
  
  // 标记本次是否双数
  cur.rolledDoubles = dice.doubles;
  moveBySteps(io, room, cur, dice.total, false, dice.doubles);
}

// ============== 修改 moveBySteps 函数 ==============
function moveBySteps(io, room, player, steps, fromJail, isDoubles) {
  const startPos = player.position;
  const total = steps;
  let step = 0;
  // 立即进入 MOVING 状态，防止玩家在移动期间再次点掷骰
  room.subState = 'MOVING';
  broadcastState(io, room);
  
  const doStep = () => {
    if (player.bankrupt) {
      room.subState = 'ENDING';
      broadcastState(io, room);
      return;
    }
    if (step >= total) {
      // 落格处理
      broadcastState(io, room);
      setTimeout(() => {
        if (player.bankrupt) {
          room.subState = 'ENDING';
          broadcastState(io, room);
          return;
        }

        // 调用 resolveTile（它可能会修改 room.subState）
        resolveTile(io, room, player);

        // 双数标记保留到 ACTING 阶段结束：玩家先在落格处行动（买地等），
        // 点「结束回合」时由 handleEndTurn 检测 rolledDoubles → 回到 ROLLING 再掷。
        // 进监狱 / 破产则清除标记，不再掷。
        if (player.bankrupt || player.jailing) {
          player.rolledDoubles = false;
        } else {
          player.rolledDoubles = isDoubles;
        }
        // 落格后刷新回合计时，保证玩家有完整的操作时间
        room.turnStartedAt = Date.now();

        broadcastState(io, room);
      }, 350);
      return;
    }
    
    player.position = (player.position + 1) % BOARD.length;
    if (player.position === 0) {
      const goLog = [];
      awardGoBonus(room, player, goLog);
      for (const t of goLog) pushLog(room, t);
    }
    step += 1;
    broadcastState(io, room);
    setTimeout(doStep, 180);
  };
  doStep();
}

// ============== 玩家动作处理器 ==============
function handleBuy(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) {
    io.to(room.code).emit('room:error', { message: '不是你的回合' });
    return;
  }
  if (cur.bankrupt) {
    io.to(room.code).emit('room:error', { message: '已破产，无法购买' });
    return;
  }
  if (room.subState !== 'ACTING') {
    io.to(room.code).emit('room:error', { message: '当前不在购买阶段' });
    return;
  }
  const t = room.board[tileIndex];
  if (!t || t.type === 'go' || t.type === 'chance' || t.type === 'fate' || t.type === 'tax' ||
      t.type === 'jail' || t.type === 'free_parking' || t.type === 'go_to_jail') {
    io.to(room.code).emit('room:error', { message: '该格不可购买' });
    return;
  }
  // 关键：必须在当前位置买（防止 stale / DevTools / 重连错位买别处）
  if (tileIndex !== cur.position) {
    io.to(room.code).emit('room:error', { message: '必须在当前位置购买' });
    return;
  }
  if (t.ownerId) {
    io.to(room.code).emit('room:error', { message: '该地产已有主人' });
    return;
  }
  if (cur.money < t.price) {
    io.to(room.code).emit('room:error', { message: '现金不足，无法购买' });
    return;
  }
  cur.money -= t.price;
  t.ownerId = cur.id;
  cur.propertiesOwned.push(t.index);
  pushLog(room, `${cur.name} 购买 ${t.name}（-${t.price}）`);
  // 检查是否集齐色组
  if (t.group && ownsFullGroup(room, cur, t.group)) {
    pushLog(room, `${cur.name} 集齐 ${groupLabel(t.group)} 全部地产！`);
  }
  broadcastState(io, room);
}

function handleDeclineBuy(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) {
    io.to(room.code).emit('room:error', { message: '不是你的回合' });
    return;
  }
  if (cur.bankrupt) {
    io.to(room.code).emit('room:error', { message: '已破产，无法放弃' });
    return;
  }
  if (room.subState !== 'ACTING') {
    io.to(room.code).emit('room:error', { message: '当前不在购买阶段' });
    return;
  }
  // 关键：必须在当前位置放弃
  if (tileIndex !== cur.position) {
    io.to(room.code).emit('room:error', { message: '必须在当前位置放弃' });
    return;
  }
  startAuction(io, room, cur, tileIndex);
}

function startAuction(io, room, decliner, tileIndex) {
  // 所有连接的、未破产的、可以出价（有钱）的玩家（>=1 元）
  const order = [];
  const n = room.players.length;
  const startIdx = room.players.findIndex(p => p.id === decliner.id);
  for (let i = 1; i <= n; i++) {
    const p = room.players[(startIdx + i) % n];
    if (p.bankrupt) continue;
    if (p.money < 1) continue;
    order.push(p.id);
  }
  if (order.length === 0) {
    pushLog(room, '无人有资格出价，拍卖取消');
    room.subState = 'ACTING';
    broadcastState(io, room);
    return;
  }
  room.auction = {
    tileIndex,
    currentBid: 0,
    currentBidderId: null,
    endsAt: Date.now() + AUCTION_TIME_MS,
    activeBidders: order,
    declinedBy: decliner.id,
    turnIdx: 0,
    timer: null,
  };
  room.subState = 'AUCTION';
  pushLog(room, `开始拍卖 ${room.board[tileIndex].name}`);
  // 安排到期
  room.auction.timer = setTimeout(() => endAuction(io, room, 'timeout'), AUCTION_TIME_MS);
  // 不立即广播等待：让前端打开模态
  io.to(room.code).emit('auction:update', sanitizeRoom(room).auction);
  broadcastState(io, room);
}

function handleAuctionBid(io, room, playerId, amount) {
  if (!room.auction) return;
  const a = room.auction;
  const p = room.players.find(x => x.id === playerId);
  if (!p || p.bankrupt) return;
  if (!a.activeBidders.includes(playerId)) {
    io.to(room.code).emit('room:error', { message: '你已退出拍卖' });
    return;
  }
  if (typeof amount !== 'number' || amount < 1) return;
  if (amount > p.money) {
    io.to(room.code).emit('room:error', { message: '现金不足' });
    return;
  }
  const minReq = a.currentBid === 0 ? 1 : a.currentBid + AUCTION_MIN_INCREMENT;
  if (amount < minReq) {
    io.to(room.code).emit('room:error', { message: `出价至少 ${minReq} 元` });
    return;
  }
  a.currentBid = amount;
  a.currentBidderId = playerId;
  // 重置计时器
  clearTimeout(a.timer);
  a.endsAt = Date.now() + AUCTION_TIME_MS;
  a.timer = setTimeout(() => endAuction(io, room, 'timeout'), AUCTION_TIME_MS);
  io.to(room.code).emit('auction:update', sanitizeRoom(room).auction);
  broadcastState(io, room);
}

function handleAuctionPass(io, room, playerId) {
  if (!room.auction) return;
  const a = room.auction;
  // 出价不可撤回：当前最高出价者不能退出（否则流局时仍按其出价成交）
  if (a.currentBidderId === playerId) {
    io.to(room.code).emit('room:error', { message: '你是当前最高出价者，不能退出' });
    return;
  }
  a.activeBidders = a.activeBidders.filter(id => id !== playerId);
  // 如果只剩 0/1 人，立即结束
  if (a.activeBidders.length <= 1) {
    endAuction(io, room, 'last');
    return;
  }
  // 移动到下一位
  io.to(room.code).emit('auction:update', sanitizeRoom(room).auction);
  broadcastState(io, room);
}

function endAuction(io, room, reason) {
  const a = room.auction;
  if (!a) return;
  clearTimeout(a.timer);
  const tile = room.board[a.tileIndex];
  if (a.currentBidderId && a.currentBid > 0) {
    const winner = room.players.find(p => p.id === a.currentBidderId);
    if (winner && !winner.bankrupt && winner.money >= a.currentBid) {
      winner.money -= a.currentBid;
      tile.ownerId = winner.id;
      winner.propertiesOwned.push(tile.index);
      pushLog(room, `${winner.name} 以 ${a.currentBid} 元拍得 ${tile.name}`);
      if (tile.group && ownsFullGroup(room, winner, tile.group)) {
        pushLog(room, `${winner.name} 集齐 ${groupLabel(tile.group)} 全部地产！`);
      }
      io.to(room.code).emit('auction:end', { tileIndex: tile.index, winnerId: winner.id, winnerName: winner.name, price: a.currentBid });
    } else {
      pushLog(room, `拍卖流拍（无人有足够现金）`);
      io.to(room.code).emit('auction:end', { tileIndex: tile.index, winnerId: null, price: 0 });
    }
  } else {
    pushLog(room, `拍卖流拍`);
    io.to(room.code).emit('auction:end', { tileIndex: tile.index, winnerId: null, price: 0 });
  }
  room.auction = null;
  room.subState = 'ACTING';
  room.turnStartedAt = Date.now();  // 拍卖耗时不占用回合操作时间
  broadcastState(io, room);
}

function handleBuild(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) {
    io.to(room.code).emit('room:error', { message: '不是你的回合' });
    return;
  }
  if (cur.bankrupt) return;
  if (room.subState !== 'ACTING' && room.subState !== 'ROLLING') {
    io.to(room.code).emit('room:error', { message: '当前不在行动阶段' });
    return;
  }
  const t = room.board[tileIndex];
  if (!t || t.type !== 'property') {
    io.to(room.code).emit('room:error', { message: '无法在该格上建造' });
    return;
  }
  if (t.ownerId !== cur.id) {
    io.to(room.code).emit('room:error', { message: '该地产不属于你' });
    return;
  }
  if (!ownsFullGroup(room, cur, t.group)) {
    io.to(room.code).emit('room:error', { message: '需拥有同色组全部地产' });
    return;
  }
  if (groupHasMortgage(room, t.group)) {
    io.to(room.code).emit('room:error', { message: '同组有已抵押地产' });
    return;
  }
  if (t.houses >= 5) {
    io.to(room.code).emit('room:error', { message: '已是旅馆' });
    return;
  }
  if (t.houses === 4) {
    // 升级为旅馆：5 × houseCost（半价 buff 生效）
    let cost = t.houseCost * 5;
    if (cur.nextBuildHalfPrice) cost = Math.floor(cost / 2);
    if (cur.money < cost) {
      io.to(room.code).emit('room:error', { message: '现金不足以建旅馆' });
      return;
    }
    // 均匀建造：必须同组其他都 >= 4
    const others = room.board.filter(x => x.group === t.group && x.index !== t.index);
    if (!others.every(x => x.houses >= 4)) {
      io.to(room.code).emit('room:error', { message: '需先把同组其他格建到 4 房' });
      return;
    }
    if (cur.nextBuildHalfPrice) {
      cur.nextBuildHalfPrice = false;
      pushLog(room, `${cur.name} 半价建造优惠生效！`);
    }
    cur.money -= cost;
    t.houses = 5;
    pushLog(room, `${cur.name} 在 ${t.name} 建旅馆（-${cost}）`);
  } else {
    // 均匀建造：本格 ≤ min(其他) + 1
    const others = room.board.filter(x => x.group === t.group && x.index !== t.index);
    const minH = Math.min(...others.map(x => x.houses));
    if (t.houses > minH) {
      io.to(room.code).emit('room:error', { message: '需均匀建造' });
      return;
    }
    let cost = t.houseCost;
    if (cur.nextBuildHalfPrice) cost = Math.floor(cost / 2);
    if (cur.money < cost) {
      io.to(room.code).emit('room:error', { message: '现金不足' });
      return;
    }
    if (cur.nextBuildHalfPrice) {
      cur.nextBuildHalfPrice = false;
      pushLog(room, `${cur.name} 半价建造优惠生效！`);
    }
    cur.money -= cost;
    t.houses += 1;
    pushLog(room, `${cur.name} 在 ${t.name} 建造（${t.houses} 房，-${cost}）`);
  }
  broadcastState(io, room);
}

function handleSellHouse(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  const t = room.board[tileIndex];
  if (!t || t.type !== 'property') return;
  if (t.ownerId !== cur.id) return;
  if (t.houses === 0) return;
  // 均匀建造（向下）：同组其他格都 >= 本格 - 1
  const others = room.board.filter(x => x.group === t.group && x.index !== t.index);
  const minH = Math.min(...others.map(x => x.houses));
  if (t.houses - 1 < minH) {
    io.to(room.code).emit('room:error', { message: '需均匀卖房' });
    return;
  }
  const refund = Math.floor(t.houseCost / 2);
  cur.money += refund;
  t.houses -= 1;
  pushLog(room, `${cur.name} 卖房 ${t.name}（+${refund}）`);
  broadcastState(io, room);
}

// 需求6：一键卖光房屋（传 tileIndex 只卖该格，不传卖所有地产；均遵守均匀建造规则）
function handleSellAllHouses(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  const onlyTile = (tileIndex != null) ? room.board[tileIndex] : null;
  if (tileIndex != null && (!onlyTile || onlyTile.ownerId !== cur.id || onlyTile.type !== 'property')) return;
  let total = 0, changed = true;
  while (changed) {
    changed = false;
    for (const t of room.board) {
      if (onlyTile && t.index !== onlyTile.index) continue;
      if (t.ownerId !== cur.id || t.type !== 'property' || t.houses === 0) continue;
      const others = room.board.filter(x => x.group === t.group && x.index !== t.index);
      if (t.houses - 1 < Math.min(...others.map(x => x.houses))) continue;
      const refund = Math.floor(t.houseCost / 2);
      cur.money += refund;
      total += refund;
      t.houses -= 1;
      changed = true;
    }
  }
  if (total > 0) pushLog(room, `${cur.name} 一键卖光${onlyTile ? ` ${onlyTile.name} 的` : ''}房屋（+${total}）`);
  broadcastState(io, room);
}

function handleMortgage(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  const t = room.board[tileIndex];
  if (!t || !t.price) return;
  if (t.ownerId !== cur.id) return;
  if (t.houses > 0) {
    io.to(room.code).emit('room:error', { message: '需先卖完该地所有房屋' });
    return;
  }
  if (t.mortgage) return;
  cur.money += t.mortgageValue;
  t.mortgage = true;
  pushLog(room, `${cur.name} 抵押 ${t.name}（+${t.mortgageValue}）`);
  broadcastState(io, room);
}

function handleUnmortgage(io, room, playerId, tileIndex) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  const t = room.board[tileIndex];
  if (!t || !t.price) return;
  if (t.ownerId !== cur.id) return;
  if (!t.mortgage) return;
  if (cur.money < t.unmortgageCost) {
    io.to(room.code).emit('room:error', { message: '现金不足' });
    return;
  }
  cur.money -= t.unmortgageCost;
  t.mortgage = false;
  pushLog(room, `${cur.name} 赎回 ${t.name}（-${t.unmortgageCost}）`);
  broadcastState(io, room);
}

function handleLoan(io, room, playerId, amount) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  if (room.subState !== 'ACTING' && room.subState !== 'ROLLING') {
    io.to(room.code).emit('room:error', { message: '当前不能贷款' });
    return;
  }
  if (room.players[room.turnIndex]?.id !== playerId) {
    io.to(room.code).emit('room:error', { message: '非当前回合玩家' });
    return;
  }
  const scale = room.settings?.scale || 1;
  const allowed = LOAN_ALLOWED_AMOUNTS.map(a => Math.round(a * scale));
  if (!allowed.includes(amount)) {
    io.to(room.code).emit('room:error', { message: `贷款金额必须为 ${LOAN_ALLOWED_AMOUNTS.join('/')}（按地图规模）` });
    return;
  }
  if (!cur.loanActionsLeft || cur.loanActionsLeft.loan <= 0) {
    io.to(room.code).emit('room:error', { message: '本回合已贷过款' });
    return;
  }
  // 信用评分检查
  if ((cur.loanCreditScore ?? LOAN_CREDIT_BASE) <= 0) {
    io.to(room.code).emit('room:error', { message: `${cur.name} 信誉分为 0，已是纯处生和CD 一桌！` });
    return;
  }
  if ((cur.loanCreditScore ?? LOAN_CREDIT_BASE) < LOAN_CREDIT_BASE) {
    io.to(room.code).emit('room:error', { message: `信用评分低于 ${LOAN_CREDIT_BASE}，无法贷款` });
    return;
  }
  // 贷款间隔检查
  if (room.turnCount - (cur.loanLastTurn ?? -99) < LOAN_GAP_TURNS) {
    io.to(room.code).emit('room:error', { message: `两次贷款之间需间隔 ${LOAN_GAP_TURNS} 回合` });
    return;
  }
  const cap = getLoanCap(cur, room);
  if (cur.loan + amount > cap) {
    io.to(room.code).emit('room:error', { message: `累计欠款不能超过 ${cap} 元` });
    return;
  }
  cur.loan = (cur.loan || 0) + amount;
  cur.money += amount;
  cur.loanLastTurn = room.turnCount;
  cur.loanActionsLeft.loan -= 1;
  cur.loanCreditScore = Math.max(0, (cur.loanCreditScore || LOAN_CREDIT_BASE) - LOAN_CREDIT_LOAN_PENALTY);
  pushLog(room, `${cur.name} 向银行贷款 ${amount} 元（欠款余额 ${cur.loan}，信用 ${cur.loanCreditScore}）`);
  broadcastState(io, room);
}

function handleRepay(io, room, playerId, amount) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  if (room.subState !== 'ACTING' && room.subState !== 'ROLLING') {
    io.to(room.code).emit('room:error', { message: '当前不能还款' });
    return;
  }
  if (room.players[room.turnIndex]?.id !== playerId) {
    io.to(room.code).emit('room:error', { message: '非当前回合玩家' });
    return;
  }
  if (!cur.loanActionsLeft || cur.loanActionsLeft.repay <= 0) {
    io.to(room.code).emit('room:error', { message: '本回合已还过款' });
    return;
  }
  const cur_loan = cur.loan || 0;
  if (cur_loan <= 0) {
    io.to(room.code).emit('room:error', { message: '当前无欠款' });
    return;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    io.to(room.code).emit('room:error', { message: '还款金额必须为正整数' });
    return;
  }
  if (amount > cur_loan) {
    io.to(room.code).emit('room:error', { message: '还款金额超过欠款' });
    return;
  }
  if (cur.money < amount) {
    io.to(room.code).emit('room:error', { message: '现金不足' });
    return;
  }
  // 最低还款检查（必须 >= 欠款的 25%，除非全额还清）
  const minRepay = Math.ceil(cur_loan * LOAN_MIN_REPAY_RATIO);
  if (amount < minRepay && amount < cur_loan) {
    io.to(room.code).emit('room:error', { message: `最低还款 ${minRepay} 元（欠款的 ${Math.round(LOAN_MIN_REPAY_RATIO * 100)}%）` });
    return;
  }
  cur.money -= amount;
  cur.loan -= amount;
  cur.loanActionsLeft.repay -= 1;
  cur.loanConsecutiveNonRepay = 0;
  cur.loanCreditScore = Math.min(100, (cur.loanCreditScore || LOAN_CREDIT_BASE) + LOAN_CREDIT_REPAY_BONUS);
  pushLog(room, `${cur.name} 还款 ${amount} 元（欠款余额 ${cur.loan}，信用 ${cur.loanCreditScore}）`);
  broadcastState(io, room);
}

function handleJailChoice(io, room, playerId, choice) {
  if (room.subState !== 'JAIL_DECISION') return;
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (!cur.jailing) {
    // 不是真监狱（探监），忽略
    return;
  }
  if (choice === 'pay') {
    const log = [];
    const ok = chargeMoney(room, cur, room.settings.jailFine, null, '出狱费', log);
    // 关键：把 chargeMoney 推的字符串转成对象（保持 room.log 格式统一）
    const now = Date.now();
    for (const t of log) room.log.push({ ts: now, text: t });
    if (cur.bankrupt) {
      broadcastState(io, room);
      return;
    }
    // 赎金进自由停车奖池
    room.pot = (room.pot || 0) + room.settings.jailFine;
    cur.jailing = false;
    cur.jailTurns = 0;
    room.subState = 'ROLLING';
    room.turnStartedAt = Date.now();
    pushLog(room, `${cur.name} 支付 ${room.settings.jailFine} 元出狱（🎁 奖池累积至 ${room.pot} 元）`);
    broadcastState(io, room);
  } else if (choice === 'card') {
    if (cur.jailCards <= 0) {
      io.to(room.code).emit('room:error', { message: '没有出狱卡' });
      return;
    }
    cur.jailCards -= 1;
    cur.jailing = false;
    cur.jailTurns = 0;
    room.subState = 'ROLLING';
    room.turnStartedAt = Date.now();
    pushLog(room, `${cur.name} 使用出狱卡`);
    broadcastState(io, room);
  } else if (choice === 'roll') {
    // 委托给 handleRollDice
    handleRollDice(io, room, playerId);
  }
}

// ============== 修改 handleEndTurn 函数 ==============
function handleEndTurn(io, room, playerId) {
  const cur = getCurrentPlayer(room);
  if (!cur || cur.id !== playerId) return;
  if (cur.bankrupt) return;
  if (room.subState === 'AUCTION') return;
  if (room.subState === 'JAIL_DECISION') return;
  if (room.subState === 'MOVING') return;

  // 掷双后落格行动完毕：再掷一次而不是结束回合
  if (cur.rolledDoubles) {
    cur.rolledDoubles = false;
    room.subState = 'ROLLING';
    room.turnStartedAt = Date.now();
    pushLog(room, `${cur.name} 掷出双数，再掷一次！`);
    broadcastState(io, room);
    return;
  }
  
  // 回合结束欠款管理：有欠款且本回合主动操作了贷款/还款按钮才清零连续未还
  // 否则（无论系统是否强制扣款）都视为玩家未主动处理，连续未还 +1
  if (cur.loan > 0) {
    const actions = cur.loanActionsLeft || { loan: 1, repay: 1 };
    if (actions.loan === 1 && actions.repay === 1) {
      // 本回合既没贷款也没还款 → 视为未履行还款义务
      cur.loanConsecutiveNonRepay = (cur.loanConsecutiveNonRepay || 0) + 1;
      // 扣信用分，但保底 0
      cur.loanCreditScore = Math.max(0, (cur.loanCreditScore ?? LOAN_CREDIT_BASE) - LOAN_CREDIT_MISS_PENALTY);
      pushLog(room, `${cur.name} 本回合未主动还款，连续未还 ${cur.loanConsecutiveNonRepay} 次（信用 ${cur.loanCreditScore}）`);
      // 信用分降到 0：触发全桌嘲讽（只本回合一次）
      if (cur.loanCreditScore <= 0 && cur._lastZeroWarn !== room.turnCount) {
        pushLog(room, `${cur.name} 信誉分为 0，已是纯处生和CD 一桌！`);
        io.to(room.code).emit('game:shame', { playerName: cur.name });
        cur._lastZeroWarn = room.turnCount;
      }
    }
  }
  // 重置状态并进入下一位
  cur.rolledDoubles = false;
  cur.jailDoubles = 0;
  nextTurn(room);
  broadcastState(io, room);
}

// 玩家间交易：4 个 handler（propose / accept / reject / cancel）+ 1 个 helper
function tradeValidate(room, playerId, side, owner) {
  // side 是 { money, properties:[idx], jailCards }，owner 是发起方
  if (!side || typeof side !== 'object') return '出价格式错误';
  if ((side.money || 0) < 0) return '金额不能为负';
  if ((side.money || 0) > owner.money) return '现金不足';
  if ((side.jailCards || 0) < 0) return '出狱卡数不能为负';
  if ((side.jailCards || 0) > owner.jailCards) return '出狱卡不足';
  if (!Array.isArray(side.properties)) return '地产列表格式错误';
  for (const idx of side.properties) {
    const t = room.board[idx];
    if (!t || t.type !== 'property' && t.type !== 'station' && t.type !== 'utility') return '无效的地产';
    if (t.ownerId !== owner.id) return '地产不属于你';
    if (t.mortgage) return '抵押地产不可交易';
    if (t.houses > 0) return '有房屋的地产不可交易（请先卖光）';
  }
  return null;  // 校验通过
}
function applyTradeSide(room, giver, taker, side) {
  giver.money -= (side.money || 0);
  taker.money += (side.money || 0);
  giver.jailCards -= (side.jailCards || 0);
  taker.jailCards += (side.jailCards || 0);
  for (const idx of (side.properties || [])) {
    const t = room.board[idx];
    t.ownerId = taker.id;
    giver.propertiesOwned = giver.propertiesOwned.filter(i => i !== idx);
    if (!taker.propertiesOwned.includes(idx)) taker.propertiesOwned.push(idx);
  }
}
function handleTradePropose(io, room, fromId, { toId, offer, request }) {
  if (room.state !== 'IN_PROGRESS') return io.to(room.code).emit('room:error', { message: '游戏未进行中' });
  if (room.pendingTrade) return io.to(room.code).emit('room:error', { message: '已有待处理交易' });
  if (fromId === toId) return io.to(room.code).emit('room:error', { message: '不能与自己交易' });
  const from = room.players.find(p => p.id === fromId);
  const to = room.players.find(p => p.id === toId);
  if (!from || !to || from.bankrupt || to.bankrupt) return io.to(room.code).emit('room:error', { message: '玩家不存在或已破产' });
  // 校验发起方
  let err = tradeValidate(room, fromId, offer, from);
  if (err) return io.to(room.code).emit('room:error', { message: '你的出价: ' + err });
  // 校验接收方
  err = tradeValidate(room, toId, request, to);
  if (err) return io.to(room.code).emit('room:error', { message: '对方出价: ' + err });
  const trade = {
    id: `${Date.now()}-${fromId.slice(-4)}`,
    fromId, toId, offer, request,
    createdAt: Date.now(),
  };
  trade.timer = setTimeout(() => {
    if (room.pendingTrade && room.pendingTrade.id === trade.id) {
      room.pendingTrade = null;
      pushLog(room, `${from.name} 提出的交易超时未响应`);
      io.to(room.code).emit('trade:failed', { tradeId: trade.id, reason: 'timeout' });
      broadcastState(io, room);
    }
  }, 60000);
  room.pendingTrade = trade;
  pushLog(room, `${from.name} 向 ${to.name} 发起交易`);
  io.to(room.code).emit('trade:proposed', { id: trade.id, fromId, toId, offer, request, createdAt: trade.createdAt });
  broadcastState(io, room);
}
function handleTradeAccept(io, room, playerId) {
  if (!room.pendingTrade) return io.to(room.code).emit('room:error', { message: '没有待处理交易' });
  const trade = room.pendingTrade;
  if (playerId !== trade.toId) return io.to(room.code).emit('room:error', { message: '只有接收方能接受' });
  const from = room.players.find(p => p.id === trade.fromId);
  const to = room.players.find(p => p.id === trade.toId);
  if (!from || !to || from.bankrupt || to.bankrupt) {
    clearTimeout(trade.timer);
    room.pendingTrade = null;
    io.to(room.code).emit('trade:failed', { tradeId: trade.id, reason: 'player_bankrupt' });
    broadcastState(io, room);
    return;
  }
  // 重跑校验（防中间状态变化）
  let err = tradeValidate(room, trade.fromId, trade.offer, from);
  if (err) {
    clearTimeout(trade.timer);
    room.pendingTrade = null;
    pushLog(room, `交易失败：${err}`);
    io.to(room.code).emit('trade:failed', { tradeId: trade.id, reason: err });
    broadcastState(io, room);
    return;
  }
  err = tradeValidate(room, trade.toId, trade.request, to);
  if (err) {
    clearTimeout(trade.timer);
    room.pendingTrade = null;
    pushLog(room, `交易失败：${err}`);
    io.to(room.code).emit('trade:failed', { tradeId: trade.id, reason: err });
    broadcastState(io, room);
    return;
  }
  // 双方互换
  applyTradeSide(room, from, to, trade.offer);
  applyTradeSide(room, to, from, trade.request);
  clearTimeout(trade.timer);
  room.pendingTrade = null;
  pushLog(room, `${from.name} 与 ${to.name} 交易成功！`);
  io.to(room.code).emit('trade:completed', { tradeId: trade.id });
  broadcastState(io, room);
}
function handleTradeReject(io, room, playerId) {
  if (!room.pendingTrade) return;
  const trade = room.pendingTrade;
  if (playerId !== trade.toId) return io.to(room.code).emit('room:error', { message: '只有接收方能拒绝' });
  clearTimeout(trade.timer);
  room.pendingTrade = null;
  pushLog(room, `交易被拒绝`);
  io.to(room.code).emit('trade:failed', { tradeId: trade.id, reason: 'rejected' });
  broadcastState(io, room);
}
function handleTradeCancel(io, room, playerId) {
  if (!room.pendingTrade) return;
  const trade = room.pendingTrade;
  if (playerId !== trade.fromId) return io.to(room.code).emit('room:error', { message: '只有发起方能取消' });
  clearTimeout(trade.timer);
  room.pendingTrade = null;
  pushLog(room, `交易被发起方取消`);
  io.to(room.code).emit('trade:cancelled', { tradeId: trade.id });
  broadcastState(io, room);
}

function groupLabel(g) {
  return {
    brown: '棕色', light_blue: '浅蓝', pink: '粉色', orange: '橙色',
    red: '红色', yellow: '黄色', green: '绿色', dark_blue: '深蓝',
    station: '车站', utility: '公用事业',
  }[g] || g;
}

// ============== handleChat 函数 - 立即发送事件 + 触发状态更新 ==============
function handleChat(io, room, playerId, text) {
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  if (typeof text !== 'string') return;
  const t = text.trim().slice(0, CHAT_MAX_LEN);
  if (!t) return;
  const entry = { 
    id: p.id, 
    fromName: p.name, 
    avatar: p.avatar,
    text: t, 
    ts: Date.now() 
  };
  
  // 存储消息历史
  room.chat.push(entry);
  if (room.chat.length > 50) room.chat.splice(0, room.chat.length - 50);
  
  // 立即发送聊天事件（前端应该优先使用这个事件）
  io.to(room.code).emit('chat:message', entry);
  
  // 同时更新状态，确保聊天在状态中也能看到
  broadcastState(io, room);
}

// ============== Express + Socket.IO ==============
const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0'),
}));
app.get('/health', (req, res) => res.json({ ok: true }));

// 自检端点：返回服务身份 + 静态文件指纹 + 完整 BOARD
// 帮用户验证「我看到的棋盘就是当前 server 渲染的」，定位缓存/截错图问题
const crypto = require('crypto');
function fileFingerprint(absPath) {
  try {
    const st = require('fs').statSync(absPath);
    const buf = require('fs').readFileSync(absPath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    return { path: absPath.replace(__dirname, '.'), size: st.size, mtime: st.mtime.toISOString(), sha };
  } catch (e) { return { path: absPath, error: e.message }; }
}
app.get('/__diag', (req, res) => {
  const publicDir = path.join(__dirname, 'public');
  res.json({
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    uptimeSec: Math.round(process.uptime()),
    serverMtime: require('fs').statSync(__filename).mtime.toISOString(),
    files: {
      'server.js': fileFingerprint(__filename),
      'public/index.html': fileFingerprint(path.join(publicDir, 'index.html')),
      'public/game.js': fileFingerprint(path.join(publicDir, 'game.js')),
      'public/style.css': fileFingerprint(path.join(publicDir, 'style.css')),
    },
    board: BOARD.map(t => ({ index: t.index, key: t.key, name: t.name, type: t.type, group: t.group })),
    request: {
      ip: req.ip,
      ua: req.get('user-agent') || null,
    },
  });
});
app.get('/api/rooms/:code', (req, res) => {
  const r = rooms.get(req.params.code.toUpperCase());
  if (!r) return res.json({ exists: false });
  res.json({
    exists: true,
    state: r.state,
    playerCount: r.players.length,
    canJoin: r.state === 'WAITING' && r.players.length < MAX_PLAYERS,
  });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  let myCode = null;
  let myPlayerId = socket.id;

  // 尝试根据旧 socket id 重连到同一玩家槽（由客户端 localStorage 触发）
  socket.on('room:create', ({ name, avatar, pawnColor, settings }) => {
    if (myCode) return;
    const room = newRoom(socket, name, avatar, pawnColor, settings);
    myCode = room.code;
    socketToRoom.set(socket.id, room.code);
    socketToPlayer.set(socket.id, socket.id);
    socket.join(room.code);
    socket.emit('room:created', { code: room.code });
    broadcastState(io, room);
  });

  socket.on('room:join', ({ code, name, avatar, pawnColor, asPlayerId }) => {
    if (myCode) return;
    const c = (code || '').toUpperCase();
    const room = rooms.get(c);
    if (!room) {
      socket.emit('room:error', { message: '房间不存在' });
      return;
    }

    // 断线重连：客户端传 asPlayerId 时，按 playerId 找回原 slot 并绑回新 socket
    if (asPlayerId) {
      const existing = room.players.find(p => p.id === asPlayerId);
      if (existing) {
        if (existing.bankrupt) {
          socket.emit('room:error', { message: '该玩家已破产，无法重连' });
          return;
        }
        if (!existing.disconnected) {
          // 该 slot 已被另一连接占用：拒绝（避免双登录）
          socket.emit('room:error', { message: '该玩家当前已在线' });
          return;
        }
        // 重新绑定
        const oldSocketId = existing.id;
        existing.id = socket.id;       // 关键：玩家 id 改为新 socket.id
        existing.disconnected = false;
        // 同步映射
        socketToRoom.delete(oldSocketId);
        socketToPlayer.delete(oldSocketId);
        myCode = room.code;
        myPlayerId = socket.id;
        socketToRoom.set(socket.id, room.code);
        socketToPlayer.set(socket.id, socket.id);
        socket.join(room.code);
        // 同步更新所有引用旧 id 的地方：board、auction、hostId、交易、破产债主、骰子
        for (const t of room.board) {
          if (t.ownerId === oldSocketId) t.ownerId = socket.id;
        }
        if (room.auction && room.auction.currentBidderId === oldSocketId) {
          room.auction.currentBidderId = socket.id;
        }
        if (room.auction && Array.isArray(room.auction.activeBidders)) {
          room.auction.activeBidders = room.auction.activeBidders.map(id => id === oldSocketId ? socket.id : id);
        }
        if (room.hostId === oldSocketId) room.hostId = socket.id;
        if (room.pendingTrade) {
          if (room.pendingTrade.fromId === oldSocketId) room.pendingTrade.fromId = socket.id;
          if (room.pendingTrade.toId === oldSocketId) room.pendingTrade.toId = socket.id;
        }
        for (const pp of room.players) {
          if (pp.bankruptToId === oldSocketId) pp.bankruptToId = socket.id;
        }
        if (room.lastDice && room.lastDice.playerId === oldSocketId) room.lastDice.playerId = socket.id;
        if (room.winnerId === oldSocketId) room.winnerId = socket.id;
        // 通知该 socket
        socket.emit('room:joined', { code: room.code });
        pushLog(room, `${existing.name} 重新连接`);
        broadcastState(io, room);
        return;
      }
      // asPlayerId 给的 id 在该房间找不到 → 落到下面的"游戏已开始"分支
    }

    if (room.state !== 'WAITING') {
      socket.emit('room:error', { message: '游戏已开始，无法加入' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('room:error', { message: '房间已满' });
      return;
    }
    // 简单防止同昵称
    if (room.players.some(p => !p.bankrupt && p.name === (name || '').slice(0, 16))) {
      socket.emit('room:error', { message: '昵称已被占用' });
      return;
    }
    // 占位新玩家（用新 socket.id 作为玩家 id）
    const player = {
      id: socket.id,
      name: (name || '玩家').slice(0, 16),
      avatar: avatar || '🙂',
      pawnColor: pawnColor || pickColor(room.players.length),
      money: room.settings.startingMoney,
      position: 0,
      jailTurns: 0,
      jailing: false,
      jailCards: 0,
      bankrupt: false,
      bankruptToId: null,
      disconnected: false,
      propertiesOwned: [],
      isHost: false,
      loan: 0,
      loanActionsLeft: { loan: 1, repay: 1 },
      nextGoBonus2x: false,
      nextBuildHalfPrice: false,
      rolledDoubles: false,
    };
    room.players.push(player);
    myCode = room.code;
    socketToRoom.set(socket.id, room.code);
    socketToPlayer.set(socket.id, socket.id);
    socket.join(room.code);
    socket.emit('room:joined', { code: room.code });
    pushLog(room, `${player.name} 加入了房间`);
    broadcastState(io, room);
  });

  socket.on('room:leave', () => {
    if (!myCode) return;
    handlePlayerLeave(io, socket, myCode, myPlayerId);
    myCode = null;
  });

  socket.on('game:start', () => {
    if (!myCode) return;
    const room = rooms.get(myCode);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('room:error', { message: '只有房主可以开始游戏' });
      return;
    }
    if (room.players.length < 2) {
      socket.emit('room:error', { message: '至少需要 2 名玩家' });
      return;
    }
    if (room.state !== 'WAITING') return;
    startGame(io, room);
  });

  // 再来一局：仅 FINISHED 状态、仅房主可发起
  socket.on('room:rematch', () => {
    if (!myCode) return;
    const room = rooms.get(myCode);
    if (!room) return;
    if (room.state !== 'FINISHED') return;
    if (room.hostId !== socket.id) {
      socket.emit('room:error', { message: '只有房主可以发起再来一局' });
      return;
    }
    resetRoomForRematch(io, room);
  });

  // 统一取房间。requireInProgress=true 时,非进行中状态(WAITING/FINISHED)的游戏动作一律忽略
  // (修复:原实现 FINISHED 后 buy/build/loan 等 handler 无状态守卫仍可触发)
  const gameRoom = (requireInProgress = true) => {
    if (!myCode) return null;
    const room = rooms.get(myCode);
    if (!room) return null;
    if (requireInProgress && room.state !== 'IN_PROGRESS') return null;
    return room;
  };

  socket.on('game:rollDice', () => {
    const room = gameRoom(); if (!room) return;
    handleRollDice(io, room, socket.id);
  });

  socket.on('game:buy', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleBuy(io, room, socket.id, tileIndex);
  });

  socket.on('game:declineBuy', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleDeclineBuy(io, room, socket.id, tileIndex);
  });

  socket.on('game:build', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleBuild(io, room, socket.id, tileIndex);
  });

  socket.on('game:sellHouse', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleSellHouse(io, room, socket.id, tileIndex);
  });

  socket.on('game:mortgage', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleMortgage(io, room, socket.id, tileIndex);
  });

  socket.on('game:unmortgage', ({ tileIndex }) => {
    const room = gameRoom(); if (!room) return;
    handleUnmortgage(io, room, socket.id, tileIndex);
  });

  socket.on('game:loan', ({ amount }) => {
    const room = gameRoom(); if (!room) return;
    handleLoan(io, room, socket.id, amount);
  });

  socket.on('game:repay', ({ amount }) => {
    const room = gameRoom(); if (!room) return;
    handleRepay(io, room, socket.id, amount);
  });

  socket.on('game:jailChoice', ({ choice }) => {
    const room = gameRoom(); if (!room) return;
    handleJailChoice(io, room, socket.id, choice);
  });

  socket.on('game:endTurn', () => {
    const room = gameRoom(); if (!room) return;
    handleEndTurn(io, room, socket.id);
  });

  socket.on('auction:bid', ({ amount }) => {
    const room = gameRoom(); if (!room) return;
    handleAuctionBid(io, room, socket.id, amount);
  });

  socket.on('auction:pass', () => {
    const room = gameRoom(); if (!room) return;
    handleAuctionPass(io, room, socket.id);
  });

  socket.on('chat:message', ({ text }) => {
    const room = gameRoom(false); if (!room) return; // 聊天任何状态可用
    handleChat(io, room, socket.id, text);
  });

  // 需求3：交易系统 4 个 socket 事件
  socket.on('trade:propose', ({ toId, offer, request }) => {
    const room = gameRoom(); if (!room) return;
    handleTradePropose(io, room, socket.id, { toId, offer, request });
  });
  socket.on('trade:accept', () => {
    const room = gameRoom(); if (!room) return;
    handleTradeAccept(io, room, socket.id);
  });
  socket.on('trade:reject', () => {
    const room = gameRoom(); if (!room) return;
    handleTradeReject(io, room, socket.id);
  });
  socket.on('trade:cancel', () => {
    const room = gameRoom(); if (!room) return;
    handleTradeCancel(io, room, socket.id);
  });

  // 需求6：一键卖光房屋（可带 tileIndex 只卖单格）
  socket.on('game:sellAllHouses', (payload) => {
    const room = gameRoom(); if (!room) return;
    handleSellAllHouses(io, room, socket.id, payload && payload.tileIndex);
  });

  // 调试：开发者控制台触发破产测试
  if (IS_DEV) {
    socket.on('game:debug', (payload) => {
      if (!myCode) return;
      const room = rooms.get(myCode);
      if (!room) return;
      if (payload && payload.action === 'drain' && payload.playerId) {
        const target = room.players.find(p => p.id === payload.playerId);
        if (target) {
          target.money -= (payload.amount || 99999);
          pushLog(room, `[DEV] 强制扣款 ${target.name}`);
          // 触发自动套现与破产
          if (target.money < 0) {
            autoRaiseCash(room, target, 0);
            if (target.money < 0) declareBankruptcy(room, target, null);
          }
          broadcastState(io, room);
        }
      } else if (payload && payload.action === 'forcePosition' && payload.playerId != null) {
        const target = room.players.find(p => p.id === payload.playerId);
        if (target) {
          target.position = payload.position || 0;
          pushLog(room, `[DEV] 传送 ${target.name} 到 pos ${target.position}`);
          resolveTile(io, room, target);
          broadcastState(io, room);
        }
      } else if (payload && payload.action === 'state') {
        socket.emit('room:state', sanitizeRoom(room));
      }
    });
  }

  socket.on('disconnect', () => {
    if (!myCode) return;
    handlePlayerLeave(io, socket, myCode, myPlayerId, /*isDisconnect=*/true);
  });
});

function pickColor(i) {
  const colors = ['#e84545', '#f9a826', '#5fcf80', '#6c5ce7', '#ff7eb3', '#3656c4', '#16a085', '#d35400', '#8e44ad', '#2c3e50'];
  return colors[i % colors.length];
}

function handlePlayerLeave(io, socket, code, playerId, isDisconnect = false) {
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  if (isDisconnect) {
    socketToRoom.delete(socket.id);
    socketToPlayer.delete(socket.id);
    // WAITING 阶段断线：直接移除（否则留下幽灵占位，占人数名额）
    if (room.state === 'WAITING') {
      pushLog(room, `${p.name} 断开连接，已移出房间`);
      room.players = room.players.filter(x => x.id !== playerId);
      if (room.players.length === 0) {
        rooms.delete(code);
        return;
      }
      // 房主迁移
      if (room.hostId === playerId) {
        for (const x of room.players) x.isHost = false;
        room.players[0].isHost = true;
        room.hostId = room.players[0].id;
        pushLog(room, `${room.players[0].name} 成为新房主`);
      }
      broadcastState(io, room);
      return;
    }
    p.disconnected = true;
    pushLog(room, `${p.name} 断开连接`);
    // 30 秒后如果还断着，给一次"自动跳过"或保留格子
    setTimeout(() => {
      const cur = room.players.find(x => x.id === playerId);
      if (!cur) return;
      if (!cur.disconnected) return; // 已重连
      // 如果当前回合属于该玩家，跳过
      const cp = getCurrentPlayer(room);
      if (cp && cp.id === playerId) {
        pushLog(room, `${p.name} 断线超时，自动跳过回合`);
        cur.jailDoubles = 0;
        nextTurn(room);
        broadcastState(io, room);
      }
    }, DISCONNECT_GRACE_MS);
  } else {
    // 主动离开
    pushLog(room, `${p.name} 离开了房间`);
    // 房主迁移
    let newHost = null;
    if (room.hostId === playerId) {
      const remaining = room.players.filter(x => x.id !== playerId && !x.bankrupt && !x.disconnected);
      if (remaining.length > 0) {
        newHost = remaining[0];
        newHost.isHost = true;
        room.hostId = newHost.id;
        pushLog(room, `${newHost.name} 成为新房主`);
      }
    }
    // 如果在 WAITING，移除玩家；否则按破产结算(释放资产+推进回合+判胜)
    if (room.state === 'WAITING') {
      room.players = room.players.filter(x => x.id !== playerId);
      // 重新分配 isHost
      if (room.players.length > 0) {
        room.players[0].isHost = true;
        room.hostId = room.players[0].id;
      } else {
        // 房间空了，清理
        rooms.delete(code);
        return;
      }
    } else {
      p.disconnected = true;
      // 修复:主动退出视为向银行破产 — declareBankruptcy 内部处理资产释放、
      // 回合推进和胜负判定(原实现只标记 disconnected,2 人局对方永远等不到获胜)
      if (room.state === 'IN_PROGRESS' && !p.bankrupt) {
        declareBankruptcy(room, p, null);
      }
    }
    socket.leave(code);
  }
  broadcastState(io, room);
}

// 启动
// 需求4：每 1 秒扫所有房间，超时未操作（15秒）自动处理
// - ROLLING 阶段（未掷骰）：自动掷骰
// - ACTING 阶段（未操作）：自动结束回合
// - JAIL_DECISION / AUCTION 阶段：跳过
const TURN_TIMEOUT_MS = 15 * 1000;
const TURN_TIMEOUT_CHECK_MS = 1 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 房间回收：FINISHED 超 2 分钟，或全员断线超 SLOT_RECLAIM_MS
    if (room.state === 'FINISHED') {
      if (!room.finishedAt) room.finishedAt = now;
      if (now - room.finishedAt > 2 * 60 * 1000) { rooms.delete(room.code); continue; }
    }
    if (room.players.length > 0 && room.players.every(p => p.disconnected || p.bankrupt)) {
      if (!room.allDisconnectedAt) room.allDisconnectedAt = now;
      if (now - room.allDisconnectedAt > SLOT_RECLAIM_MS) { rooms.delete(room.code); continue; }
    } else {
      room.allDisconnectedAt = null;
    }
    if (room.state !== 'IN_PROGRESS') continue;
    if (room.subState === 'AUCTION' || room.subState === 'MOVING') continue;
    if (!room.turnStartedAt) continue;
    if (now - room.turnStartedAt < TURN_TIMEOUT_MS) continue;
    const cur = getCurrentPlayer(room);
    if (!cur || cur.bankrupt) continue;
    // 先重置计时,防止 handler 内部的异步延迟(如监狱失败 500ms 后才切回合)期间重复触发
    room.turnStartedAt = now;
    if (room.subState === 'ROLLING') {
      pushLog(room, `${cur.name} 15秒未操作，自动掷骰`);
      handleRollDice(io, room, cur.id);
    } else if (room.subState === 'JAIL_DECISION') {
      // 修复:断线/挂机玩家轮到监狱决策时不再卡死整局 — 自动掷双出狱
      pushLog(room, `${cur.name} 15秒未选择，自动掷骰碰运气出狱`);
      handleJailChoice(io, room, cur.id, 'roll');
    } else {
      pushLog(room, `${cur.name} 15秒未操作，自动结束回合`);
      handleEndTurn(io, room, cur.id);
    }
  }
}, TURN_TIMEOUT_CHECK_MS);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  地产大亨 server listening on port ${PORT}\n`);
  console.log('  Open from this machine:  http://localhost:' + PORT);
  const ifs = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) {
        urls.push({ name, address: i.address });
      }
    }
  }
  if (urls.length === 0) {
    console.log('  No LAN IPv4 found.\n');
  } else {
    console.log('  Open from same LAN:');
    for (const u of urls) {
      console.log(`     http://${u.address}:${PORT}   (${u.name})`);
    }
    console.log('');
  }
});
