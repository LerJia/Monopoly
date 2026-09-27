/* ==========================================================================
   地产大亨 — 客户端 v21(新粗野派对风布局)
   1) 大堂：昵称 / 头像 / 棋子 / 创建 / 加入 / 设置
   2) 等待大厅：房号 / 玩家列表 / 开始
   3) 游戏：40 格棋盘 + 骰子 + 玩家 chips 条 / 底部操作坞 / 日志聊天抽屉 / 模态
   4) 模态：玩家资产 / 地产管理 / 抵押 / 拍卖 / 贷款 / 交易
   5) 倒计时 + 重连 + 音效
   ========================================================================== */

(function () {
'use strict';

// ---------- 头像/棋子常量 ----------
const AVATARS = ['😀', '😎', '🤠', '🦄', '🐱', '🐶', '🦊', '🐼'];
const PAWN_COLORS = ['#e84545', '#ff8c00', '#ffd700', '#228b22', '#1e90ff', '#8b4513'];

// 与服务端 MAX_PLAYERS 保持一致
const DISPLAY_MAX_PLAYERS = 10;

// ---------- 工具函数 ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    if (k === 'class') e.className = props[k];
    else if (k === 'style') Object.assign(e.style, props[k]);
    else if (k.startsWith('on') && typeof props[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), props[k]);
    else e.setAttribute(k, props[k]);
  }
  for (const c of children || []) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else e.appendChild(c);
  }
  return e;
}
function getLS(k, d) { try { const v = localStorage.getItem('mp:profile'); return v ? JSON.parse(v)[k] : d; } catch { return d; } }
function setLS(o) {
  try {
    let old = {};
    try { old = JSON.parse(localStorage.getItem('mp:profile')) || {}; } catch {}
    localStorage.setItem('mp:profile', JSON.stringify({ ...old, ...o }));
  } catch {}
}
function money(n) { return '¥' + (n || 0).toLocaleString('zh-CN'); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// ---------- 全局状态 ----------
let socket = null;
let myId = null;
let myName = '';
let myAvatar = AVATARS[0];
let myPawn = PAWN_COLORS[0];
let myCode = null;
let room = null;
let pendingModal = null;     // 当前打开的弹窗
let chatSeenCount = null;    // 未读红点：上次已读聊天条数（null=尚未初始化）
let diceTicker = null;       // 骰子动画 setInterval id（供 showDice 清除）
// 交互特效状态
let prevMoney = {};          // playerId -> 上次金额（飘字用）
let prevOwners = null;       // tileIndex -> ownerId（购买特效用,null=首次快照）
let pawnEls = {};            // playerId -> 常驻 pawn 元素（逐格动画不重建）
let pawnAnims = {};          // playerId -> {timer, pos} 进行中的逐格动画
let tileTip = null;          // 悬停 tooltip 单例
let nwHistory = [];          // [{turn, worths: {playerId: netWorth}}] 净资产曲线采样
let lastSampledTurn = -1;    // 上次采样的 turnCount
let prevTurnPlayerId = null; // 上一次的当前回合玩家（「轮到你了」提示用）
let prevBankrupt = null;     // playerId -> bool（破产出局特效触发用,null=首次快照）
let elimQueue = [];          // 破产特效排队（同帧多人破产时依次播放）
let elimPlaying = false;
let soundMuted = false;      // 音效开关（localStorage 记忆）
try { soundMuted = localStorage.getItem('mp:muted') === '1'; } catch {}
let auctionTicker = null;    // 拍卖倒计时 setInterval id（供重新打开时清除）
let auctionMinimized = false; // 拍卖弹窗已最小化（避免被其他人出价自动重新弹出）
let auctionLog = [];         // 本场拍卖出价记录 [{bidderId, bid}]（客户端自行累积,服务端不存）
let auctionKey = null;       // 当前拍卖标识（tileIndex）,换场即清空记录

// ---------- 颜色（与服务器 BOARD group 对应,派对色板） ----------
// COLOR_BG:角格整格底色 | COLOR_BAND:普通格顶部色条
const COLOR_BG = {
  go: '#ffd400', jail: '#8ecdf5',
  free_parking: '#9dedc6', go_to_jail: '#ffa1a1',
};
const COLOR_BAND = {
  brown: '#c98a4b', light_blue: '#7cd6f7', pink: '#ff90e8',
  orange: '#ff7a2f', red: '#ff4d4d', yellow: '#ffd400',
  green: '#3ecf6e', dark_blue: '#7c5cff',
  station: '#a9b6c6', utility: '#5fd8cd',
  chance: '#ffb84d', fate: '#b79cff', event: '#ffa5c8', tax: '#c3cad6',
  go: '#ffd400', jail: '#8ecdf5', free_parking: '#9dedc6', go_to_jail: '#ffa1a1',
};
// 角格大 emoji
const CORNER_EMOJI = { go: '🏁', jail: '🔒', free_parking: '🅿️', go_to_jail: '🚔' };
// 非地产格类型小图标
const TYPE_ICON = { chance: '🎰', fate: '🔮', event: '🎪', tax: '💰', station: '🚉', utility: '⚡' };
const TILE_META = {
  go: { color: 'go' }, jail: { color: 'jail' }, free_parking: { color: 'free_parking' },
  go_to_jail: { color: 'go_to_jail' }, chance: { color: 'chance' }, fate: { color: 'fate' },
  event: { color: 'event' }, tax: { color: 'tax' }, property: { color: null },
  station: { color: 'station' }, utility: { color: 'utility' },
};

// ---------- 11×11 棋盘布局 ----------
const TILE_POS = (function () {
  const map = {};
  // 底行 col 11..1  pos 0..10
  for (let i = 0; i <= 10; i++) map[i] = { row: 11, col: 11 - i };
  // 左列 col 1, row 10..2  pos 11..19
  for (let i = 0; i < 9; i++) map[11 + i] = { row: 10 - i, col: 1 };
  // 顶行 col 1..11  pos 20..30（左→右，11 次含 2 角）
  for (let i = 0; i < 11; i++) map[20 + i] = { row: 1, col: 1 + i };
  // 右列 col 11, row 2..10  pos 31..39
  for (let i = 0; i < 9; i++) map[31 + i] = { row: 2 + i, col: 11 };
  return map;
})();

let tileElements = {};
let tileBuilt = false;

// ---------- 音效（Web Audio API 生成简单 tone） ----------
let audioCtx = null;
function playTone(freq, dur, type = 'sine', vol = 0.1) {
  if (soundMuted) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* 用户未交互，AudioContext 不可用 */ }
}
function playSound(kind) {
  switch (kind) {
    case 'roll':     playTone(220, 0.08); setTimeout(() => playTone(330, 0.08), 60); break;
    case 'doubles':  playTone(440, 0.12); setTimeout(() => playTone(660, 0.15), 100); break;
    case 'buy':      playTone(523, 0.15); setTimeout(() => playTone(659, 0.15), 100); break;
    case 'rent':     playTone(200, 0.18); break;
    case 'bankrupt': playTone(150, 0.4, 'sawtooth', 0.15); break;
    case 'win':      playTone(523, 0.15); setTimeout(() => playTone(659, 0.15), 150); setTimeout(() => playTone(783, 0.3), 300); break;
    case 'trade':    playTone(440, 0.1); setTimeout(() => playTone(550, 0.1), 80); setTimeout(() => playTone(660, 0.15), 160); break;
  }
}

// ---------- 大堂 UI ----------
function buildPicker(id, items, onPick, current, isCircle) {
  const root = $(id); root.innerHTML = '';
  items.forEach((v, i) => {
    const btn = el('button', {
      type: 'button',
      class: v === current ? 'selected' : '',
      onclick: () => { onPick(v); buildPicker(id, items, onPick, v, isCircle); },
    });
    if (isCircle) btn.style.background = v;
    else btn.textContent = v;
    root.appendChild(btn);
  });
}
function markPickerSelected(id, v) {
  $$('#' + id + ' button').forEach((b, i) => {
    b.classList.toggle('selected', b.textContent === v || b.style.background === v);
  });
}

function buildLobby() {
  // 头像/棋子
  myName = getLS('name', '');
  myAvatar = getLS('avatar', AVATARS[0]);
  myPawn = getLS('pawnColor', PAWN_COLORS[0]);
  $('#lobby-name').value = myName;
  buildPicker('#create-avatar', AVATARS, (v) => { myAvatar = v; }, myAvatar, false);
  buildPicker('#create-pawn', PAWN_COLORS, (v) => { myPawn = v; }, myPawn, true);

  // 恢复设置（白名单校验：localStorage 老值不匹配新版 radio 就忽略）
  const SETTINGS_VALID = {
    startingMoney: [5000, 8000, 12000, 15000],
    goBonus:       [1500, 2000, 3000],
    jailFine:      [500, 1000, 2000],
  };
  ['startingMoney', 'goBonus', 'jailFine'].forEach(k => {
    const v = getLS(k);
    if (!v) return;
    const n = parseInt(v);
    if (!SETTINGS_VALID[k].includes(n)) return;   // 老值不匹配 → 忽略
    const radio = document.querySelector(`input[name="${k}"][value="${n}"]`);
    if (radio) radio.checked = true;
  });

  // 创建
  $('#btn-create').addEventListener('click', () => {
    const name = $('#lobby-name').value.trim() || '玩家';
    // 防御：3 个 radio 至少要有一个选中（用 getLS fallback 兜底）
    const getChecked = (k, valid, def) => {
      const r = document.querySelector('input[name="' + k + '"]:checked');
      if (r) return parseInt(r.value);
      const v = getLS(k);
      if (v && valid.includes(parseInt(v))) return parseInt(v);
      return def;
    };
    const startingMoney = getChecked('startingMoney', [5000, 8000, 12000, 15000], 8000);
    const goBonus = getChecked('goBonus', [1500, 2000, 3000], 2000);
    const jailFine = getChecked('jailFine', [500, 1000, 2000], 1000);
    setLS({ name, avatar: myAvatar, pawnColor: myPawn, startingMoney, goBonus, jailFine });
    myName = name;
    ensureSocket();
    socket.emit('room:create', { name, avatar: myAvatar, pawnColor: myPawn, settings: { startingMoney, goBonus, jailFine } });
  });

  // 加入
  $('#btn-join').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code || code.length !== 5) { $('#lobby-status').textContent = '请输入 5 位房间号'; return; }
    const name = $('#lobby-name').value.trim() || '玩家';
    setLS({ name, avatar: myAvatar, pawnColor: myPawn });
    myName = name;
    ensureSocket();
    socket.emit('room:join', { code, name, avatar: myAvatar, pawnColor: myPawn });
  });

  // 游戏说明
  $('#btn-toggle-help').addEventListener('click', () => {
    alert([
      '🎲 玩法速览',
      '1. 房主创建房间，其他人凭 5 位房号加入，2 人即可开始',
      '2. 轮到你时掷骰子移动，落到无主地产可购买或放弃拍卖',
      '3. 集齐同色组可建房（须均匀建造），旅馆 = 4 房再升一级',
      '4. 落到他人地产付租金；现金不足自动卖房→抵押→贷款，仍不足则破产',
      '5. 机会/命运/事件格抽卡；进监狱可付钱/用卡/掷双出狱',
      '6. 缺钱可向银行贷款，注意利息与信用分；最后未破产者获胜',
    ].join('\n'));
  });
}

function showScreen(name) {
  $('#lobby').classList.toggle('active', name === 'lobby');
  $('#waiting').classList.toggle('active', name === 'waiting');
  $('#game').classList.toggle('active', name === 'game');
}

// ---------- Socket ----------
function ensureSocket() {
  if (socket) return;
  socket = io({ reconnection: true, reconnectionDelay: 1000 });
  socket.on('connect', () => {
    $('#reconnect-mask').classList.add('hidden');
    // 刷新后 myCode 是 undefined，要从 localStorage 读 lastCode
    const savedCode = myCode || getLS('lastCode');
    const savedPlayerId = getLS('lastPlayerId');
    if (savedCode && savedPlayerId) {
      myCode = savedCode;
      // 重连恢复身份
      socket.emit('room:join', { code: savedCode, name: myName, avatar: myAvatar, pawnColor: myPawn, asPlayerId: savedPlayerId });
    }
  });
  socket.on('disconnect', () => {
    $('#reconnect-mask').classList.remove('hidden');
  });
  socket.on('reconnect', () => {
    $('#reconnect-mask').classList.add('hidden');
    // 重连后再次尝试恢复身份
    const savedCode = myCode || getLS('lastCode');
    const savedPlayerId = getLS('lastPlayerId');
    if (savedCode && savedPlayerId) {
      socket.emit('room:join', { code: savedCode, name: myName, avatar: myAvatar, pawnColor: myPawn, asPlayerId: savedPlayerId });
    }
  });
  socket.on('room:state', onRoomState);
  // 快捷表情爆发:单条 emoji 聊天 → 发送者 chip 上方爆出大表情
  socket.on('chat:message', (m) => {
    if (!m || !room) return;
    if (!EMOTES.includes((m.text || '').trim())) return;
    const idx = room.players.findIndex(p => p.name === m.fromName);
    if (idx < 0) return;
    const chipEl = $('#player-chips').children[idx];
    spawnEmoteBurst(chipEl, m.text.trim());
  });
  socket.on('room:created', ({ code }) => {
    myCode = code;
    setLS({ lastCode: code });
  });
  socket.on('room:error', ({ message }) => {
    $('#lobby-status').textContent = message || '操作失败';
    showBanner(message, 'info');
  });
  socket.on('game:diceResult', (dice) => {
    if (dice.doubles) playSound('doubles'); else playSound('roll');
    showDice(dice);
  });
  socket.on('game:cardDrawn', (data) => {
    const isMe = data.playerName === (room?.players.find(p => p.id === myId)?.name || '');
    const emoji = data.type === 'chance' ? '🎴' : data.type === 'event' ? '🎪' : '🔮';
    showBanner(`${emoji} ${data.text}`, isMe ? 'card-you' : 'card');
  });
  socket.on('game:shame', (data) => {
    const isMe = data.playerName === (room?.players.find(p => p.id === myId)?.name || '');
    showBanner(`💀 ${data.playerName} 信誉分为 0，已是纯处生和CD一桌！🤡`, isMe ? 'shame-you' : 'shame');
  });
  socket.on('game:rentPaid', (data) => {
    const me = room && room.players.find(p => p.id === myId);
    if (!me) return;
    const kind = data.payerId === myId ? 'pay' : data.receiverId === myId ? 'receive' : null;
    if (kind) {
      playSound(kind === 'pay' ? 'rent' : 'rent');
      const title = kind === 'pay' ? '💸 支付租金' : '💰 收到租金';
      const text = kind === 'pay' ? `你向 ${data.receiverName} 支付了 ${money(data.amount)}` : `你收到 ${money(data.amount)} 租金`;
      showBanner(`${title} · ${text} · ${data.tileName}`, kind);
    }
  });
  socket.on('auction:update', (auction) => {
    if (!auction) return;
    // 出价历史累积:换场清空;有新的最高价且与上条不同则记一笔
    if (auctionKey !== auction.tileIndex) {
      auctionKey = auction.tileIndex;
      auctionLog = [];
    }
    const last = auctionLog[auctionLog.length - 1];
    if (auction.currentBid > 0 && auction.currentBidderId &&
        (!last || last.bid !== auction.currentBid || last.bidderId !== auction.currentBidderId)) {
      auctionLog.push({ bidderId: auction.currentBidderId, bid: auction.currentBid });
    }
    if (auctionMinimized) {
      // 已最小化：只更新角标，不重新弹出完整模态
      updateAuctionBadge(auction);
    } else {
      openAuctionModal(auction);
    }
  });
  socket.on('auction:end', (data) => {
    closeModal();
    const badge = $('#auction-badge');
    if (badge) badge.style.display = 'none';
    auctionMinimized = false;
    auctionLog = [];
    auctionKey = null;
    if (data.winnerId) showBanner(`🔨 拍卖结束：${data.winnerName || '?'} 以 ${money(data.price)} 拍得`, 'info');
    else showBanner('🔨 拍卖流拍', 'info');
  });
  // 需求3：交易事件
  socket.on('trade:proposed', (trade) => {
    const fromName = (room?.players.find(p => p.id === trade.fromId) || {}).name || '?';
    const isToMe = trade.toId === myId;
    openTradeAcceptModal({ ...trade, fromName, isToMe });
  });
  socket.on('trade:completed', () => {
    closeModal();
    showBanner('🤝 交易成功！', 'trade');
    playSound('trade');
  });
  socket.on('trade:failed', ({ reason }) => {
    closeModal();
    showBanner('🤝 交易失败：' + (reason || '原因不明'), 'info');
  });
  socket.on('trade:cancelled', () => {
    closeModal();
    showBanner('🤝 交易被取消', 'info');
  });
  socket.on('room:ended', ({ winnerId }) => {
    playSound('win');
    launchConfetti();
    // 彩带先飞一会儿,再弹结算屏
    setTimeout(() => openResultsModal(winnerId), 900);
  });
}

// ---------- 获胜彩带(全屏派对色纸屑,4s 自动清理) ----------
function launchConfetti() {
  const old = $('#confetti-root');
  if (old) old.remove();
  const rootEl = el('div', { id: 'confetti-root' });
  const colors = ['#ffd400', '#ff90e8', '#23a094', '#ff7a2f', '#ff4d4d', '#7c5cff', '#3ecf6e'];
  for (let i = 0; i < 80; i++) {
    const c = el('div', { class: 'confetti' });
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    c.style.animationDelay = (Math.random() * 0.8) + 's';
    c.style.width = (6 + Math.random() * 8) + 'px';
    c.style.height = (8 + Math.random() * 10) + 'px';
    rootEl.appendChild(c);
  }
  document.body.appendChild(rootEl);
  setTimeout(() => rootEl.remove(), 4600);
}

// ---------- 破产出局特效(头像居中→抖动开裂→像素粒子爆散消散) ----------
function queueEliminationFx(player) {
  elimQueue.push({ avatar: player.avatar || '💀', name: player.name, isMe: player.id === myId });
  if (!elimPlaying) playNextElimFx();
}

function playNextElimFx() {
  const job = elimQueue.shift();
  if (!job) { elimPlaying = false; return; }
  elimPlaying = true;
  playEliminationFx(job, () => playNextElimFx());
}

function playEliminationFx(job, onDone) {
  playSound('bankrupt');
  const overlay = el('div', { class: 'elim-overlay' });
  const stage = el('div', { class: 'elim-stage' });
  const canvas = el('canvas', { class: 'elim-canvas', width: 480, height: 480 });
  stage.appendChild(canvas);
  stage.appendChild(el('div', { class: 'elim-label' }, `💥 ${job.name} 破产出局！${job.isMe ? '（是你…）' : ''}`));
  overlay.appendChild(stage);
  document.body.appendChild(overlay);

  const ctx = canvas.getContext('2d');
  const W = 480, H = 480, CX = W / 2, CY = H / 2;
  const start = performance.now();
  const SHAKE_MS = 900;    // 阶段1:抖动 + 裂纹
  const BURST_MS = 1500;   // 阶段2:粒子爆散
  const cracks = [];       // 预生成裂纹折线(每帧重画,避免闪烁)
  let particles = null;
  let finished = false;

  const drawAvatar = (dx, dy) => {
    ctx.clearRect(0, 0, W, H);
    ctx.font = '150px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(job.avatar, CX + dx, CY + dy);
  };

  const addCrack = () => {
    // 从中心附近向外辐射的一条随机折线
    const pts = [];
    let x = CX + (Math.random() - 0.5) * 30;
    let y = CY + (Math.random() - 0.5) * 30;
    const ang = Math.random() * Math.PI * 2;
    const segs = 3 + Math.floor(Math.random() * 3);
    pts.push([x, y]);
    for (let i = 0; i < segs; i++) {
      const a = ang + (Math.random() - 0.5) * 0.9;
      const len = 22 + Math.random() * 30;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      pts.push([x, y]);
    }
    cracks.push(pts);
    playTone(180 - cracks.length * 20, 0.06, 'square', 0.06);
  };

  const spawnParticles = () => {
    // 采样头像像素 → 真粒子
    drawAvatar(0, 0);
    const img = ctx.getImageData(0, 0, W, H).data;
    particles = [];
    const STEP = 6;
    for (let py = 0; py < H; py += STEP) {
      for (let px = 0; px < W; px += STEP) {
        const i = (py * W + px) * 4;
        if (img[i + 3] < 60) continue; // 透明处跳过
        const dx0 = px - CX, dy0 = py - CY;
        const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
        const speed = 1.2 + Math.random() * 2.6;
        particles.push({
          x: px, y: py,
          vx: (dx0 / dist) * speed + (Math.random() - 0.5) * 1.4,
          vy: (dy0 / dist) * speed + (Math.random() - 0.5) * 1.4 - 0.8,
          r: 2 + Math.random() * 2.5,
          color: `rgba(${img[i]},${img[i + 1]},${img[i + 2]},`,
          life: 1,
        });
      }
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    overlay.classList.add('out');
    setTimeout(() => { overlay.remove(); onDone(); }, 350);
  };

  const frame = (now) => {
    if (finished) return;
    const t = now - start;
    if (t < SHAKE_MS) {
      // 阶段1:抖动越来越剧烈 + 逐条加裂纹
      const k = t / SHAKE_MS;
      drawAvatar((Math.random() - 0.5) * 10 * k, (Math.random() - 0.5) * 10 * k);
      const want = Math.floor(k * 5);
      while (cracks.length < want) addCrack();
      ctx.strokeStyle = 'rgba(17,17,17,0.85)';
      ctx.lineWidth = 2.5;
      cracks.forEach(pts => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      });
    } else {
      if (!particles) {
        spawnParticles();
        playTone(90, 0.35, 'sawtooth', 0.14);
      }
      // 阶段2:粒子飞散 + 重力 + 渐隐
      const k = (t - SHAKE_MS) / BURST_MS;
      if (k >= 1) return finish();
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
        p.life = 1 - k;
        ctx.fillStyle = p.color + (p.life * 0.95) + ')';
        ctx.fillRect(p.x, p.y, p.r * p.life + 0.5, p.r * p.life + 0.5);
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // 兜底:页面隐藏时 rAF 停摆,4s 后强制清理
  setTimeout(finish, SHAKE_MS + BURST_MS + 1600);
}

// ---------- 终局结算屏(冠军卡+排名+净资产曲线+再来一局) ----------
function openResultsModal(winnerId) {
  if (!room) return;
  const winner = room.players.find(p => p.id === winnerId);
  const content = el('div', { class: 'results' });
  // 冠军大卡
  if (winner) {
    const champ = el('div', { class: 'champ-card' });
    champ.appendChild(el('div', { class: 'champ-crown' }, '👑'));
    champ.appendChild(el('div', { class: 'champ-avatar' }, winner.avatar || '?'));
    champ.appendChild(el('div', { class: 'champ-name' }, winner.name + ' 获胜！'));
    content.appendChild(champ);
  }
  // 排名(按净资产,破产者垫底)
  const ranked = room.players.slice().sort((a, b) => {
    if (a.bankrupt !== b.bankrupt) return a.bankrupt ? 1 : -1;
    return (b.netWorth ?? b.money) - (a.netWorth ?? a.money);
  });
  const medals = ['🥇', '🥈', '🥉'];
  const list = el('div', { class: 'rank-list' });
  ranked.forEach((p, i) => {
    const row = el('div', { class: 'rank-row' + (p.id === myId ? ' me' : '') + (p.bankrupt ? ' out' : '') });
    row.appendChild(el('span', { class: 'rank-no' }, p.bankrupt ? '💀' : (medals[i] || `${i + 1}.`)));
    row.appendChild(el('span', { class: 'rank-avatar' }, p.avatar || '?'));
    row.appendChild(el('span', { class: 'rank-name' }, p.name));
    const stats = el('span', { class: 'rank-stats' });
    stats.appendChild(el('b', {}, '净资 ' + money(p.netWorth ?? p.money)));
    stats.appendChild(el('span', {}, ` · 现金 ${money(p.money)} · 🏠×${(p.propertiesOwned || []).length}`));
    row.appendChild(stats);
    list.appendChild(row);
  });
  content.appendChild(list);
  // 净资产走势曲线
  if (nwHistory.length >= 2) {
    content.appendChild(el('h4', { class: 'chart-title' }, '📈 净资产走势'));
    const canvas = el('canvas', { class: 'nw-chart', width: 560, height: 220 });
    content.appendChild(canvas);
    // 图例
    const legend = el('div', { class: 'chart-legend' });
    room.players.forEach(p => {
      const item = el('span', { class: 'legend-item' });
      item.appendChild(el('span', { class: 'legend-swatch', style: { background: p.pawnColor } }));
      item.appendChild(document.createTextNode(p.name));
      legend.appendChild(item);
    });
    content.appendChild(legend);
    // 模态挂载后再画(canvas 需在 DOM 中)
    setTimeout(() => drawNetWorthChart(canvas), 0);
  }
  // 操作行:房主可再来一局
  const actions = el('div', { class: 'modal-actions results-actions' });
  const me = room.players.find(p => p.id === myId);
  if (me && me.isHost) {
    actions.appendChild(el('button', {
      class: 'btn btn-primary btn-lg',
      onclick: () => socket.emit('room:rematch'),
    }, '🔄 再来一局'));
  } else {
    actions.appendChild(el('div', { class: 'hint' }, '等待房主发起再来一局…'));
  }
  actions.appendChild(el('button', { class: 'btn btn-ghost', onclick: closeModal }, '看看棋盘'));
  content.appendChild(actions);
  openModal(content, { kind: 'results' });
}

// 原生 canvas 2D 折线图:x=采样序,y=净资产,线色=棋子色
function drawNetWorthChart(canvas) {
  if (!canvas || !canvas.getContext || !room || nwHistory.length < 2) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD = { l: 46, r: 10, t: 10, b: 22 };
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  let maxV = 0;
  nwHistory.forEach(s => Object.values(s.worths).forEach(v => { if (v > maxV) maxV = v; }));
  if (maxV <= 0) maxV = 1;
  maxV *= 1.08; // 顶部留白
  const n = nwHistory.length;
  const x = (i) => PAD.l + (n === 1 ? 0 : (i / (n - 1)) * pw);
  const y = (v) => PAD.t + ph - (v / maxV) * ph;
  ctx.clearRect(0, 0, W, H);
  // 网格 + y 轴标签
  ctx.strokeStyle = 'rgba(17,17,17,0.12)';
  ctx.fillStyle = '#6b6b6b';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = (maxV / 4) * g;
    const gy = y(v);
    ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(W - PAD.r, gy); ctx.stroke();
    ctx.fillText(v >= 10000 ? (v / 10000).toFixed(1) + 'w' : Math.round(v), PAD.l - 5, gy + 3);
  }
  // x 轴标签(回合)
  ctx.textAlign = 'center';
  ctx.fillText('回合 →', PAD.l + pw / 2, H - 6);
  // 每个玩家一条折线
  room.players.forEach(p => {
    ctx.strokeStyle = p.pawnColor || '#111';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    nwHistory.forEach((s, i) => {
      const v = s.worths[p.id];
      if (v === undefined) return;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();
  });
  // 外框
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;
  ctx.strokeRect(PAD.l, PAD.t, pw, ph);
}

function showBanner(text, kind) {
  const root = $('#banner-root');
  const b = el('div', { class: 'banner ' + (kind || 'info') }, text);
  root.appendChild(b);
  setTimeout(() => {
    b.style.opacity = '0';
    b.style.transition = 'opacity 0.4s';
    setTimeout(() => b.remove(), 400);
  }, 3500);
}

// ---------- 等待大厅 ----------
function renderWaiting() {
  if (!room) return;
  $('#wait-code').textContent = room.code;
  $('#wait-count').textContent = `${room.players.length}/${DISPLAY_MAX_PLAYERS}`;
  const list = $('#wait-players'); list.innerHTML = '';
  room.players.forEach(p => {
    const li = el('li', { class: p.id === myId ? 'you' : '' });
    li.appendChild(el('div', { class: 'player-avatar' }, p.avatar));
    const info = el('div', {});
    const name = el('div', { class: 'name' });
    name.appendChild(document.createTextNode(p.name));
    if (p.isHost) name.appendChild(el('span', { class: 'badge host' }, '房主'));
    if (p.id === myId) name.appendChild(el('span', { class: 'you-tag' }, '你'));
    info.appendChild(name);
    li.appendChild(info);
    list.appendChild(li);
  });
  // 设置提示
  const s = room.settings || {};
  const sScale = (s.startingMoney / 8000).toFixed(2);
  $('#wait-rules').innerHTML = `本局规则：💰 初始 <b>${s.startingMoney.toLocaleString()}</b> 元 (×${sScale}) · 🏁 GO <b>${s.goBonus.toLocaleString()}</b> 元 · 🔒 出狱 <b>${s.jailFine.toLocaleString()}</b> 元`;
  // 房主按钮
  const me = room.players.find(p => p.id === myId);
  if (me && me.isHost && room.players.length >= 2) {
    $('#btn-start').classList.remove('hidden');
    $('#btn-start').onclick = () => socket.emit('game:start');
  } else {
    $('#btn-start').classList.add('hidden');
  }
}
$('#btn-copy-code').onclick = () => copyText($('#wait-code').textContent);
$('#btn-copy-code2').onclick = () => copyText($('#game-code').textContent);
$('#btn-leave-wait').onclick = () => { socket.emit('room:leave'); showScreen('lobby'); };

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showBanner('已复制：' + text, 'info'));
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
}

// ---------- 棋盘构建 ----------
function buildBoardOnce() {
  if (tileBuilt) return;
  const board = $('#board'); board.innerHTML = '';
  tileElements = {};
  const canHover = window.matchMedia('(hover: hover)').matches;
  for (let pos = 0; pos < 40; pos++) {
    const isCorner = pos % 10 === 0;
    const t = el('div', {
      class: 'tile' + (isCorner ? ' corner' : ''), 'data-pos': pos,
      style: { gridRow: TILE_POS[pos].row, gridColumn: TILE_POS[pos].col },
    });
    t.appendChild(el('div', { class: 'color-band' }));
    if (isCorner) t.appendChild(el('div', { class: 'corner-emoji' }));
    else t.appendChild(el('div', { class: 'tile-icon' }));
    t.appendChild(el('div', { class: 'tile-name' }, (room?.board[pos] || {}).name || ''));
    t.appendChild(el('div', { class: 'house-mark' }));
    t.addEventListener('click', () => showTileInfo(pos));
    if (canHover) {
      t.addEventListener('mouseenter', () => showTileTip(pos, t));
      t.addEventListener('mouseleave', hideTileTip);
    }
    board.appendChild(t);
    tileElements[pos] = t;
  }
  tileBuilt = true;
}

function setColor(elTile, t) {
  const colorKey = TILE_META[t.type] ? TILE_META[t.type].color : null;
  const key = colorKey || t.group || 'tax';
  if (elTile.classList.contains('corner')) {
    // 角格：整格亮色 + 大 emoji（色带由 CSS 隐藏）
    const bg = COLOR_BG[key];
    if (bg) elTile.style.backgroundColor = bg;
    const em = elTile.querySelector('.corner-emoji');
    if (em) em.textContent = CORNER_EMOJI[t.type] || '';
  } else {
    // 普通格：色组浅底 + 顶部色条（高度/边线由 CSS 控制）
    const bandColor = COLOR_BAND[key] || '#c3cad6';
    const band = elTile.querySelector('.color-band');
    if (band) band.style.backgroundColor = bandColor;
    elTile.style.backgroundColor = bandColor + '1f'; // 8 位 hex,~12% 透明浅底
    // 非地产格类型小图标
    const icon = elTile.querySelector('.tile-icon');
    if (icon) icon.textContent = TYPE_ICON[t.type] || '';
  }
}

// ============== 修改 refreshBoard 函数 ==============
function refreshBoard() {
  if (!room) return;
  buildBoardOnce();
  for (let pos = 0; pos < 40; pos++) {
    const t = room.board[pos];
    const elTile = tileElements[pos];
    elTile.querySelector('.tile-name').textContent = t.name;
    setColor(elTile, t);
    // meta
    let meta = elTile.querySelector('.tile-meta');
    if (!meta) { meta = el('div', { class: 'tile-meta' }); elTile.appendChild(meta); }
    if (t.type === 'property' || t.type === 'station' || t.type === 'utility') {
      meta.textContent = money(t.price);
    } else if (t.type === 'go') {
      meta.textContent = '+' + (room.settings?.goBonus || 2000);
    } else if (t.type === 'jail') meta.textContent = '探监';
    else if (t.type === 'free_parking') meta.textContent = '休息';
    else if (t.type === 'go_to_jail') meta.textContent = '进监';
    else if (t.type === 'chance') meta.textContent = '机会';
    else if (t.type === 'fate') meta.textContent = '命运';
    else if (t.type === 'event') meta.textContent = '事件';
    else if (t.type === 'tax') meta.textContent = t.key === 'tax_lux' ? '奢侈税' : '所得税';
    // 抵押遮罩
    elTile.classList.toggle('mortgaged', !!t.mortgage);
    // 房屋/旅馆
    const hm = elTile.querySelector('.house-mark');
    if (t.type === 'property' && t.houses > 0) {
      hm.textContent = t.houses === 5 ? '🏨' : ('🏠' + t.houses);
    } else hm.textContent = '';

    // 业主标记：整格内描边(玩家棋子色,经 CSS 变量与 hover 阴影叠加)
    const owner = t.ownerId ? room.players.find(p => p.id === t.ownerId) : null;
    if (owner) elTile.style.setProperty('--owner-ring', owner.pawnColor);
    else elTile.style.removeProperty('--owner-ring');

    // 购买特效：ownerId 从无到有 → 弹跳闪光(首次快照/重连不触发)
    if (prevOwners && !prevOwners[pos] && t.ownerId) {
      elTile.classList.remove('just-bought');
      void elTile.offsetWidth;
      elTile.classList.add('just-bought');
      setTimeout(() => elTile.classList.remove('just-bought'), 900);
      if (t.ownerId === myId) playSound('buy');
    }
  }
  // 快照本次业主表
  prevOwners = {};
  for (let pos = 0; pos < 40; pos++) prevOwners[pos] = room.board[pos].ownerId || null;
  // 自由停车奖池角标
  const potBadge = $('#pot-badge');
  if (potBadge) {
    if (room.pot > 0) {
      potBadge.textContent = `🎁 奖池 ${money(room.pot)}`;
      potBadge.classList.remove('hidden');
    } else {
      potBadge.classList.add('hidden');
    }
  }
}

// ---------- 地块详情卡(点击) + 悬停 tooltip ----------
const TYPE_LABEL = {
  property: '地产', station: '车站', utility: '公用事业', chance: '机会', fate: '命运',
  event: '事件', tax: '税', go: '起点', jail: '监狱', free_parking: '自由停车', go_to_jail: '进监狱',
};

function tileColorOf(t) {
  const colorKey = TILE_META[t.type] ? TILE_META[t.type].color : null;
  const key = colorKey || t.group || 'tax';
  return COLOR_BAND[key] || '#c3cad6';
}

// 当前档租金(悬停摘要用,车站/公用为估算)
function currentRentOf(t) {
  if (t.type === 'property' && t.rentTable && t.rentTable.length) return t.rentTable[t.houses || 0];
  const scale = (room.settings || {}).scale || 1;
  if (t.type === 'station' && t.ownerId) {
    const n = room.board.filter(x => x.type === 'station' && x.ownerId === t.ownerId).length;
    return Math.round(500 * scale) * n;
  }
  return null;
}

function showTileInfo(pos) {
  if (!room) return;
  hideTileTip();
  const t = room.board[pos];
  const owner = room.players.find(p => p.id === t.ownerId);
  const s = room.settings || {};
  const scale = s.scale || 1;
  const content = el('div', { class: 'tile-detail' });
  // 顶部色带条
  content.appendChild(el('div', { class: 'detail-band', style: { background: tileColorOf(t) } },
    [el('span', { class: 'detail-type' }, TYPE_LABEL[t.type] || t.type)]));
  content.appendChild(el('h3', {}, t.name));
  // 价格/抵押行
  if (t.price) {
    const rows = el('div', { class: 'detail-rows' });
    rows.appendChild(el('div', { class: 'detail-row' }, [el('span', {}, '价格'), el('b', {}, money(t.price))]));
    rows.appendChild(el('div', { class: 'detail-row' }, [el('span', {}, '抵押 / 赎回'), el('b', {}, `${money(t.mortgageValue)} / ${money(t.unmortgageCost)}`)]));
    if (t.type === 'property' && t.houseCost) {
      rows.appendChild(el('div', { class: 'detail-row' }, [el('span', {}, '建房费'), el('b', {}, money(t.houseCost))]));
    }
    content.appendChild(rows);
    // 业主行
    const ownerRow = el('div', { class: 'detail-owner' });
    if (owner) {
      ownerRow.appendChild(el('span', { class: 'owner-swatch', style: { background: owner.pawnColor } }));
      ownerRow.appendChild(el('span', {}, `${owner.avatar} ${owner.name}${t.mortgage ? '（已抵押 🔒）' : ''}`));
    } else {
      ownerRow.appendChild(el('span', { class: 'no-owner' }, '🏷 无主 — 落上可购买'));
    }
    content.appendChild(ownerRow);
  }
  // 租金表 / 规则说明
  if (t.type === 'property' && t.rentTable && t.rentTable.length) {
    const labels = ['空地', '1房', '2房', '3房', '4房', '🏨旅馆'];
    const table = el('div', { class: 'rent-table' });
    t.rentTable.forEach((r, i) => {
      const isCur = (t.houses || 0) === i && !!t.ownerId;
      table.appendChild(el('div', { class: 'rent-row' + (isCur ? ' current' : '') }, [
        el('span', {}, (isCur ? '👉 ' : '') + labels[i]),
        el('b', {}, money(r)),
      ]));
    });
    content.appendChild(table);
  } else if (t.type === 'station') {
    content.appendChild(el('div', { class: 'hint' }, `车站租金：拥有 n 站 = ${money(Math.round(500 * scale))} × n（4 站 ${money(Math.round(2000 * scale))}）`));
  } else if (t.type === 'utility') {
    content.appendChild(el('div', { class: 'hint' }, `公用租金：1 家 = 骰子 ×${Math.round(6 * scale)}，2 家 = 骰子 ×${Math.round(12 * scale)}`));
  } else if (t.type === 'tax') {
    content.appendChild(el('div', { class: 'hint' }, t.key === 'tax_lux' ? `缴 ${money(Math.round(1500 * scale))}` : `缴 ${money(Math.round(1800 * scale))} 或总资产 10%（取大）`));
  } else if (t.type === 'go') {
    content.appendChild(el('div', { class: 'hint' }, `经过或停留 +${money(s.goBonus || 2000)}`));
  } else if (t.type === 'jail') {
    content.appendChild(el('div', { class: 'hint' }, '路过探监,安全格；被抓才关进来'));
  } else if (t.type === 'free_parking') {
    content.appendChild(el('div', { class: 'hint' }, '免费休息一回合,什么都不会发生'));
  } else if (t.type === 'go_to_jail') {
    content.appendChild(el('div', { class: 'hint' }, `踩到立刻进监狱！出狱费 ${money(s.jailFine || 1000)}`));
  } else if (t.type === 'chance' || t.type === 'fate' || t.type === 'event') {
    content.appendChild(el('div', { class: 'hint' }, '停留抽一张卡,好坏全凭运气 🎲'));
  }
  openModal(content, { kind: 'tile-detail' });
}

function ensureTileTip() {
  if (!tileTip) {
    tileTip = el('div', { id: 'tile-tip', class: 'tile-tip hidden' });
    document.body.appendChild(tileTip);
  }
  return tileTip;
}

function showTileTip(pos, tileEl) {
  if (!room) return;
  const t = room.board[pos];
  const tip = ensureTileTip();
  tip.innerHTML = '';
  tip.appendChild(el('div', { class: 'tip-band', style: { background: tileColorOf(t) } }));
  tip.appendChild(el('div', { class: 'tip-name' }, t.name));
  const lines = [];
  if (t.price) lines.push(`价格 ${money(t.price)}`);
  const rent = currentRentOf(t);
  if (rent != null && t.ownerId) lines.push(`当前租金 ${money(rent)}`);
  const owner = room.players.find(p => p.id === t.ownerId);
  if (owner) lines.push(`业主 ${owner.avatar} ${owner.name}${t.mortgage ? ' 🔒' : ''}`);
  else if (t.price) lines.push('无主可购买');
  if (!lines.length) lines.push(TYPE_LABEL[t.type] || '');
  lines.forEach(s => tip.appendChild(el('div', { class: 'tip-line' }, s)));
  // 定位:格子上方,越界翻到下方
  const r = tileEl.getBoundingClientRect();
  tip.classList.remove('hidden');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = clamp(r.left + r.width / 2 - tw / 2, 6, window.innerWidth - tw - 6);
  let y = r.top - th - 10;
  if (y < 6) y = r.bottom + 10;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideTileTip() {
  if (tileTip) tileTip.classList.add('hidden');
}

// ---------- 玩家 chips 条 / 棋子渲染 ----------
function refreshPlayers() {
  if (!room) return;
  const wrap = $('#player-chips'); wrap.innerHTML = '';
  const cur = room.players[room.turnIndex];
  // 按座位顺序渲染（chip 条即行动顺序，位置固定不跳动）
  room.players.forEach(p => {
    const chip = el('div', {
      class: ['player-chip', p.id === myId ? 'you' : '', p.bankrupt ? 'bankrupt' : '', p.id === cur?.id && !p.bankrupt ? 'turn' : ''].filter(Boolean).join(' '),
      onclick: () => openPlayerAssetsModal(p.id),
    });
    chip.appendChild(el('div', { class: 'chip-avatar' }, p.avatar || '?'));
    const info = el('div', { class: 'chip-info' });
    const name = el('div', { class: 'chip-name' });
    name.appendChild(document.createTextNode(p.name));
    if (p.id === myId) name.appendChild(el('span', { class: 'you-tag' }, '你'));
    if (p.isHost) name.appendChild(el('span', { class: 'badge host' }, '房主'));
    info.appendChild(name);
    info.appendChild(el('div', { class: 'chip-money' }, money(p.money)));
    const meta = el('div', { class: 'chip-meta' });
    const propCount = (p.propertiesOwned || []).length;
    if (propCount) meta.appendChild(el('span', {}, `🏠×${propCount}`));
    if (p.jailing) meta.appendChild(el('span', {}, '🔒'));
    if (p.jailCards) meta.appendChild(el('span', {}, `🃏${p.jailCards}`));
    if (p.loan > 0) meta.appendChild(el('span', { class: 'debt' }, `🏦${p.loan}`));
    if (meta.children.length) info.appendChild(meta);
    chip.appendChild(info);
    wrap.appendChild(chip);
  });
  // 金额飘字:与上次对比,变化的 chip 上方飘 +/-
  room.players.forEach((p, i) => {
    const prev = prevMoney[p.id];
    if (prev !== undefined && p.money !== prev && !p.bankrupt) {
      spawnMoneyFloat(wrap.children[i], p.money - prev);
    }
    prevMoney[p.id] = p.money;
  });
}

// 在 chip 视口位置飘出 +¥/-¥(挂 body,不受 chip 重渲染影响)
function spawnMoneyFloat(chipEl, delta) {
  if (!chipEl) return;
  const r = chipEl.getBoundingClientRect();
  if (!r.width) return; // 屏幕未显示时跳过
  const f = el('div', { class: 'money-float ' + (delta > 0 ? 'gain' : 'loss') },
    (delta > 0 ? '+' : '−') + money(Math.abs(delta)));
  f.style.left = (r.left + r.width / 2) + 'px';
  f.style.top = (r.top - 4) + 'px';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1300);
}

// 点 chip → 该玩家资产清单模态（交易入口也在这里）
function openPlayerAssetsModal(playerId) {
  if (!room) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  const cur = room.players[room.turnIndex];
  const content = el('div', {});
  content.appendChild(el('h3', {}, `${p.avatar || '?'} ${p.name}${p.bankrupt ? '（已破产）' : ''}`));
  // 概览行
  const stats = el('div', { class: 'asset-stats' });
  stats.appendChild(el('span', { class: 'asset-stat' }, '💰 ' + money(p.money)));
  if (p.netWorth !== undefined) stats.appendChild(el('span', { class: 'asset-stat' }, '📊 净资 ' + money(p.netWorth)));
  if (p.loan > 0) stats.appendChild(el('span', { class: 'asset-stat debt' }, '🏦 欠 ' + money(p.loan)));
  if (p.loanCreditScore !== undefined) stats.appendChild(el('span', { class: 'asset-stat' }, '信用 ' + p.loanCreditScore));
  if (p.jailing) stats.appendChild(el('span', { class: 'asset-stat' }, '🔒 监狱中'));
  if (p.jailCards) stats.appendChild(el('span', { class: 'asset-stat' }, `🃏 出狱卡×${p.jailCards}`));
  content.appendChild(stats);
  // 地产清单
  const tiles = room.board.filter(t => t.ownerId === playerId && t.price > 0);
  if (tiles.length === 0) {
    content.appendChild(el('div', { class: 'hint' }, '暂无地产'));
  } else {
    const list = el('div', { class: 'asset-list' });
    tiles.forEach(t => {
      const row = el('div', { class: 'prop-mgmt-row' });
      row.appendChild(el('div', { class: 'prop-name' }, t.name + (t.houses === 5 ? ' 🏨' : t.houses ? ` 🏠×${t.houses}` : '')));
      row.appendChild(el('div', { class: 'prop-info' }, t.mortgage ? '🔒 已抵押' : money(t.price)));
      list.appendChild(row);
    });
    content.appendChild(list);
  }
  // 轮到我 & 对方是别人且未破产 → 发起交易
  if (p.id !== myId && !p.bankrupt && cur && cur.id === myId) {
    const actions = el('div', { class: 'modal-actions' });
    actions.appendChild(el('button', { class: 'btn btn-primary', onclick: () => openTradeProposeModal(p.id) }, '🤝 发起交易'));
    content.appendChild(actions);
  }
  openModal(content, { kind: 'player-assets' });
}

// ---------- 棋子渲染(常驻元素 + 逐格移动动画) ----------
function refreshPawns() {
  if (!room) return;
  const alive = new Set();
  room.players.forEach(p => {
    if (p.bankrupt) {
      // 破产:移除棋子
      if (pawnEls[p.id]) { pawnEls[p.id].remove(); delete pawnEls[p.id]; }
      if (pawnAnims[p.id]) { clearTimeout(pawnAnims[p.id].timer); delete pawnAnims[p.id]; }
      return;
    }
    alive.add(p.id);
    let pawn = pawnEls[p.id];
    if (!pawn) {
      // 首次出现:直接落位
      pawn = el('div', { class: 'pawn', style: { background: p.pawnColor } }, p.avatar);
      pawnEls[p.id] = pawn;
      pawnAnims[p.id] = { timer: null, pos: p.position };
      placePawnAt(p.id, p.position);
    } else {
      const anim = pawnAnims[p.id];
      if (anim.timer) { clearTimeout(anim.timer); anim.timer = null; } // 打断进行中的动画
      if (anim.pos !== p.position) {
        const steps = (p.position - anim.pos + 40) % 40;
        if (steps >= 1 && steps <= 16) animatePawnSteps(p.id, p.position);
        else placePawnAt(p.id, p.position); // 传送(进监狱/远跳)直接落位
      }
    }
    pawn.classList.toggle('is-current', room.players[room.turnIndex]?.id === p.id);
  });
  // 离开房间的玩家:清理棋子
  Object.keys(pawnEls).forEach(id => {
    if (!alive.has(id)) {
      pawnEls[id].remove(); delete pawnEls[id];
      if (pawnAnims[id]) { clearTimeout(pawnAnims[id].timer); delete pawnAnims[id]; }
    }
  });
  refreshHereTile();
}

// 把棋子挂到指定格,并重排该格(及原格)内的多枚棋子
function placePawnAt(playerId, pos) {
  const pawn = pawnEls[playerId];
  const tile = tileElements[pos];
  if (!pawn || !tile) return;
  const fromTile = pawn.parentElement;
  tile.appendChild(pawn);
  pawnAnims[playerId].pos = pos;
  layoutTilePawns(tile);
  if (fromTile && fromTile !== tile) layoutTilePawns(fromTile);
}

function layoutTilePawns(tile) {
  const pawns = tile.querySelectorAll('.pawn');
  pawns.forEach((pw, i) => {
    pw.style.left = (4 + i * 18) + 'px';
    pw.style.top = '50%';
  });
}

// 逐格顺时针跳到目标格(~90ms/步 + tick 音);中途新状态到达会被 refreshPawns 打断
function animatePawnSteps(playerId, targetPos) {
  const anim = pawnAnims[playerId];
  const step = () => {
    const next = (anim.pos + 1) % 40;
    placePawnAt(playerId, next);
    const pawn = pawnEls[playerId];
    if (pawn) {
      pawn.classList.remove('hop');
      void pawn.offsetWidth;
      pawn.classList.add('hop');
    }
    playTone(500 + next * 6, 0.045, 'square', 0.04);
    if (anim.pos !== targetPos) anim.timer = setTimeout(step, 90);
    else { anim.timer = null; refreshHereTile(); }
  };
  anim.timer = setTimeout(step, 60);
}

// 当前回合玩家所站格:黄色脉冲高亮
function refreshHereTile() {
  $$('.tile.here').forEach(t => t.classList.remove('here'));
  if (!room || room.state !== 'IN_PROGRESS') return;
  const cur = room.players[room.turnIndex];
  if (!cur || cur.bankrupt) return;
  const tile = tileElements[cur.position];
  if (tile) tile.classList.add('here');
}

// ---------- 骰子动画 ----------
function showDice(dice) {
  // 清除动画 ticker，防止 setInterval 后续覆盖服务器返回的真实骰子值
  if (diceTicker) {
    clearInterval(diceTicker);
    diceTicker = null;
  }
  const d1 = $('#die1'), d2 = $('#die2');
  d1.textContent = dice.a; d2.textContent = dice.b;
  d1.classList.remove('cycle'); d2.classList.remove('cycle');
  void d1.offsetWidth;
  d1.classList.add('cycle'); d2.classList.add('cycle');
  setTimeout(() => {
    d1.classList.remove('cycle'); d2.classList.remove('cycle');
    d1.classList.add('settle'); d2.classList.add('settle');
    setTimeout(() => { d1.classList.remove('settle'); d2.classList.remove('settle'); }, 550);
    if (dice.doubles) { d1.classList.add('doubles'); d2.classList.add('doubles'); }
    else { d1.classList.remove('doubles'); d2.classList.remove('doubles'); }
    const totalEl = $('#dice-total');
    totalEl.textContent = '合计 ' + dice.total;
    $('#dice-info').classList.remove('hidden');
    // ✨双！标记按是否双数显隐
    const bonus = $('#dice-bonus');
    if (bonus) bonus.classList.toggle('hidden', !dice.doubles);
  }, 720);
}

// ---------- 底部操作坞 ----------
function refreshActions() {
  if (!room) return;
  const root = $('#action-dock'); root.innerHTML = '';
  if (room.state === 'FINISHED') { root.appendChild(el('div', { class: 'hint' }, '🏆 游戏结束')); return; }
  const cur = room.players[room.turnIndex];
  const me = room.players.find(p => p.id === myId);
  if (!cur || !me || me.id !== cur.id) {
    root.appendChild(el('div', { class: 'hint' }, cur ? `等待 ${cur.name} 行动…` : '等待开始'));
    return;
  }
  if (me.bankrupt) { root.appendChild(el('div', { class: 'hint' }, '💀 你已破产')); return; }
  const sub = room.subState;
  if (sub === 'ROLLING') {
    root.appendChild(el('button', { class: 'btn btn-primary btn-lg', 'data-hotkey': 'space', onclick: () => { socket.emit('game:rollDice'); showDiceAnimation(); } }, '🎲 掷骰子'));
    root.appendChild(el('button', { class: 'btn', 'data-hotkey': 'b', onclick: openPropertyManager }, '🏠 建造 / 卖房'));
    root.appendChild(el('button', { class: 'btn', 'data-hotkey': 'm', onclick: openMortgageManager }, '💰 抵押 / 赎回'));
    appendLoanButtons(root, me);
    root.appendChild(el('button', { class: 'btn btn-ghost', 'data-hotkey': 'e', onclick: () => socket.emit('game:endTurn') }, cur.rolledDoubles ? '🎲 再掷!' : '⏭ 结束回合'));
  } else if (sub === 'MOVING') {
    root.appendChild(el('div', { class: 'hint' }, '棋子移动中…'));
  } else if (sub === 'ACTING') {
    const tile = room.board[me.position];
    if (tile && !tile.ownerId && tile.price && ['property', 'station', 'utility'].includes(tile.type) && me.money >= tile.price) {
      root.appendChild(el('button', { class: 'btn btn-success', onclick: () => socket.emit('game:buy', { tileIndex: tile.index }) }, `💰 购买 ${tile.name}（${money(tile.price)}）`));
      root.appendChild(el('button', { class: 'btn btn-warn', onclick: () => socket.emit('game:declineBuy', { tileIndex: tile.index }) }, '🏷 放弃→拍卖'));
    } else if (tile && !tile.ownerId && tile.price) {
      root.appendChild(el('div', { class: 'hint' }, '现金不足，可放弃拍卖'));
      root.appendChild(el('button', { class: 'btn btn-warn', onclick: () => socket.emit('game:declineBuy', { tileIndex: tile.index }) }, '🏷 放弃→拍卖'));
    }
    root.appendChild(el('button', { class: 'btn', 'data-hotkey': 'b', onclick: openPropertyManager }, '🏠 建造 / 卖房'));
    root.appendChild(el('button', { class: 'btn', 'data-hotkey': 'm', onclick: openMortgageManager }, '💰 抵押 / 赎回'));
    appendLoanButtons(root, me);
    root.appendChild(el('button', { class: 'btn btn-primary', 'data-hotkey': 'space', onclick: () => socket.emit('game:endTurn') }, cur.rolledDoubles ? '🎲 再掷!' : '⏭ 结束回合'));
  } else if (sub === 'JAIL_DECISION') {
    root.appendChild(el('div', { class: 'hint' }, '你在监狱中：'));
    root.appendChild(el('button', { class: 'btn', onclick: () => socket.emit('game:jailChoice', { choice: 'pay' }) }, '💎 付钱出狱'));
    if (me.jailCards > 0) {
      root.appendChild(el('button', { class: 'btn btn-success', onclick: () => socket.emit('game:jailChoice', { choice: 'card' }) }, '🃏 用出狱卡'));
    }
    root.appendChild(el('button', { class: 'btn btn-primary', onclick: () => socket.emit('game:jailChoice', { choice: 'roll' }) }, '🎲 掷双出狱'));
  } else if (sub === 'AUCTION') {
    root.appendChild(el('div', { class: 'hint' }, '拍卖中，请在弹窗操作'));
  } else {
    root.appendChild(el('div', { class: 'hint' }, '回合收尾中…'));
  }
}

function showDiceAnimation() {
  const d1 = $('#die1'), d2 = $('#die2');
  d1.classList.remove('cycle', 'settle', 'doubles'); d2.classList.remove('cycle', 'settle', 'doubles');
  d1.classList.add('cycle'); d2.classList.add('cycle');
  const start = Date.now();
  diceTicker = setInterval(() => {
    if (Date.now() - start >= 720) {
      clearInterval(diceTicker);
      diceTicker = null;
      d1.classList.remove('cycle'); d2.classList.remove('cycle');
      $('#dice-info').classList.add('hidden');
      return;
    }
    d1.textContent = 1 + Math.floor(Math.random() * 6);
    d2.textContent = 1 + Math.floor(Math.random() * 6);
  }, 60);
}

// ---------- 模态通用 ----------
function openModal(content, opts) {
  closeModal();
  opts = opts || {};
  const mask = el('div', { class: 'modal-mask' });
  const card = el('div', { class: 'modal-card', style: { position: 'relative' } });
  if (opts.title) card.appendChild(el('h3', {}, opts.title));
  if (content) card.appendChild(content);
  const close = el('button', { class: 'modal-close', onclick: closeModal }, '×');
  card.appendChild(close);
  mask.appendChild(card);
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  $('#modal-root').appendChild(mask);
  pendingModal = { kind: opts.kind, mask };
}
function closeModal() {
  $$('.modal-mask').forEach(m => m.remove());
  pendingModal = null;
}

// ---------- 抵押 / 赎回管理 ----------
function openMortgageManager() {
  const me = room && room.players.find(p => p.id === myId);
  if (!me) return;
  const content = el('div', {});
  content.appendChild(el('h3', {}, '💰 抵押 / 赎回'));
  const myTiles = room.board.filter(t => t.ownerId === myId && t.price > 0);
  if (myTiles.length === 0) { content.appendChild(el('div', { class: 'hint' }, '暂无可抵押的地产')); openModal(content, { kind: 'mm' }); return; }
  myTiles.forEach(t => {
    const row = el('div', { class: 'prop-mgmt-row' });
    row.appendChild(el('div', { class: 'prop-name' }, t.name));
    row.appendChild(el('div', { class: 'prop-info' }, t.mortgage ? '已抵押' : `抵押 ${money(t.mortgageValue)} / 赎回 ${money(t.unmortgageCost)}`));
    const acts = el('div', { class: 'actions' });
    if (t.mortgage) {
      const btn = el('button', { class: 'btn btn-tiny', onclick: () => emitWithPending(btn, 'game:unmortgage', { tileIndex: t.index }, 'mm') }, '赎回');
      acts.appendChild(btn);
    } else if (t.houses === 0) {
      const btn = el('button', { class: 'btn btn-tiny btn-warn', onclick: () => emitWithPending(btn, 'game:mortgage', { tileIndex: t.index }, 'mm') }, '抵押');
      acts.appendChild(btn);
    }
    row.appendChild(acts);
    content.appendChild(row);
  });
  // 一键抵押 / 一键赎回
  const all = el('div', { class: 'prop-mgmt-actions' });
  const canMortgageAll = myTiles.some(t => !t.mortgage && t.houses === 0);
  if (canMortgageAll) {
    const btn1 = el('button', { class: 'btn btn-warn', onclick: () => myTiles.forEach(t => { if (!t.mortgage && t.houses === 0) socket.emit('game:mortgage', { tileIndex: t.index }); }) }, '一键抵押所有');
    all.appendChild(btn1);
  }
  const canUnmortgageAll = myTiles.some(t => t.mortgage);
  if (canUnmortgageAll) {
    const btn2 = el('button', { class: 'btn', onclick: () => myTiles.forEach(t => { if (t.mortgage) socket.emit('game:unmortgage', { tileIndex: t.index }); }) }, '一键赎回所有');
    all.appendChild(btn2);
  }
  content.appendChild(all);
  openModal(content, { kind: 'mm' });
}

// ---------- 建造 / 卖房管理 ----------
function openPropertyManager() {
  const me = room && room.players.find(p => p.id === myId);
  if (!me) return;
  const content = el('div', {});
  content.appendChild(el('h3', {}, '🏠 建造 / 卖房'));
  const myTiles = room.board.filter(t => t.ownerId === myId && t.type === 'property' && t.houses < 5);
  if (myTiles.length === 0) { content.appendChild(el('div', { class: 'hint' }, '暂无可建/卖地产')); openModal(content, { kind: 'pm' }); return; }
  myTiles.forEach(t => {
    const row = el('div', { class: 'prop-mgmt-row' });
    const houseInfo = t.houses === 0 ? '空地' : (t.houses === 5 ? '旅馆' : `${t.houses}房`);
    row.appendChild(el('div', { class: 'prop-name' }, `${t.name}（${houseInfo}）`));
    row.appendChild(el('div', { class: 'prop-info' }, t.houses === 5 ? '已是旅馆' : `建费 ${money(t.houseCost)}`));
    const acts = el('div', { class: 'actions' });
    if (t.houses < 5) {
      const btn = el('button', { class: 'btn btn-tiny btn-success', onclick: () => emitWithPending(btn, 'game:build', { tileIndex: t.index }, 'pm') }, '🏠 建造');
      acts.appendChild(btn);
    }
    if (t.houses > 0) {
      const btn = el('button', { class: 'btn btn-tiny btn-warn', onclick: () => emitWithPending(btn, 'game:sellHouse', { tileIndex: t.index }, 'pm') }, '卖一栋');
      acts.appendChild(btn);
    }
    if (t.houses >= 2) {
      const btn = el('button', { class: 'btn btn-tiny btn-warn', onclick: () => emitWithPending(btn, 'game:sellAllHouses', { tileIndex: t.index }, 'pm') }, '卖光');
      acts.appendChild(btn);
    }
    row.appendChild(acts);
    content.appendChild(row);
  });
  openModal(content, { kind: 'pm' });
}

function emitWithPending(btn, evt, payload, modalKind) {
  btn.disabled = true; btn.textContent = '...';
  socket.emit(evt, payload);
  setTimeout(() => { if (pendingModal && pendingModal.kind === modalKind) closeModal(); }, 300);
}

// ---------- 贷款按钮 ----------
function appendLoanButtons(root, me) {
  const s = room.settings || {};
  const scale = s.scale || 1;
  const c = room.constants || {};
  const actions = me.loanActionsLeft || { loan: 0, repay: 0 };
  const cur_loan = me.loan || 0;

  // 前端简化版贷款上限计算
  const baseCap = Math.round(((c.LOAN_INITIAL_CAP || 2000) + Math.floor((room.turnCount || 0) / (c.LOAN_CAP_INTERVAL || 5)) * (c.LOAN_CAP_INCREMENT || 1000)) * scale);
  const nw = me.netWorth || 0;
  const creditFactor = (me.loanCreditScore || 60) / 100;
  const nwCap = Math.round(nw * 0.5 * creditFactor);
  const cap = Math.min(Math.max(baseCap, nwCap), Math.round((c.LOAN_ABSOLUTE_CAP || 12000) * scale));

  // 贷款按钮行
  const allowedLoan = (c.LOAN_ALLOWED_AMOUNTS || [500, 1000, 2000, 3000]).map(a => Math.round(a * scale));
  if (actions.loan > 0 && cur_loan < cap) {
    const row = el('div', { class: 'loan-row', style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' } });
    row.appendChild(el('span', { style: { fontSize: '11px', alignSelf: 'center', color: 'var(--muted)' } }, `💰 贷款（上限${cap} 信${me.loanCreditScore||60}）：`));
    allowedLoan.forEach(amt => {
      if (cur_loan + amt > cap) return;
      const btn = el('button', { class: 'btn btn-tiny', style: { fontSize: '11px' }, onclick: () => { btn.disabled = true; socket.emit('game:loan', { amount: amt }); } }, '+' + amt);
      row.appendChild(btn);
    });
    root.appendChild(row);
  }
  // 还款按钮行
  if (actions.repay > 0 && cur_loan > 0) {
    const minRepay = Math.ceil(cur_loan * (c.LOAN_MIN_REPAY_RATIO || 0.25));
    const row = el('div', { class: 'loan-row', style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' } });
    row.appendChild(el('span', { style: { fontSize: '11px', alignSelf: 'center', color: 'var(--muted)' } }, `💸 欠${cur_loan}（最低${minRepay}）：`));
    // 推荐还款档位：最低还款、一半、全额
    [minRepay, Math.ceil(cur_loan / 2), cur_loan].forEach(amt => {
      if (amt > me.money || amt <= 0) return;
      if (amt > cur_loan) return;
      const btn = el('button', { class: 'btn btn-tiny', style: { fontSize: '11px' }, onclick: () => { btn.disabled = true; socket.emit('game:repay', { amount: amt }); } }, '-' + amt);
      row.appendChild(btn);
    });
    root.appendChild(row);
  }
}

// ---------- 拍卖模态 ----------
function openAuctionModal(auction) {
  const me = room && room.players.find(p => p.id === myId);
  if (!me) return;
  // 重建前保留正在输入的出价(否则别人每出一次价,你输的数字就被清掉)
  const prevInput = $('#auction-bid-input');
  const typedVal = prevInput ? parseInt(prevInput.value) : NaN;
  const canBid = auction.activeBidders && auction.activeBidders.includes(myId);
  const content = el('div', {});
  const tile = room.board[auction.tileIndex];
  content.appendChild(el('h3', {}, `🔨 拍卖：${tile.name}`));

  // 状态横条(三态):我最高 / 别人最高 / 无人出价
  const leader = auction.currentBidderId ? room.players.find(p => p.id === auction.currentBidderId) : null;
  let statusBar;
  if (leader && leader.id === myId) {
    statusBar = el('div', { class: 'auction-status mine' }, `✋ 你是最高出价者 ${money(auction.currentBid)}`);
  } else if (leader) {
    statusBar = el('div', { class: 'auction-status other' }, `${leader.avatar || ''} ${leader.name} 领先 ${money(auction.currentBid)}`);
  } else {
    statusBar = el('div', { class: 'auction-status none' }, '尚无人出价，¥1 起拍');
  }
  content.appendChild(statusBar);

  // 我的信息行:现金 + 我最近一次出价
  const myLast = auctionLog.filter(b => b.bidderId === myId).pop();
  content.appendChild(el('div', { class: 'auction-mybid' },
    `💰 现金 ${money(me.money)} · ${myLast ? '你的出价 ' + money(myLast.bid) : '你尚未出价'}`));

  // 出价记录(最近 5 条,新的在上,我的高亮)
  if (auctionLog.length) {
    const hist = el('div', { class: 'bid-history' });
    auctionLog.slice(-5).reverse().forEach(b => {
      const bp = room.players.find(p => p.id === b.bidderId);
      hist.appendChild(el('div', { class: 'bid-row' + (b.bidderId === myId ? ' mine' : '') }, [
        el('span', {}, `${bp?.avatar || ''} ${bp?.name || '?'}${b.bidderId === myId ? '（你）' : ''}`),
        el('b', {}, money(b.bid)),
      ]));
    });
    content.appendChild(hist);
  }

  if (!canBid) {
    content.appendChild(el('div', { style: { color: '#e84545', margin: '8px 0', fontSize: '13px', fontWeight: '800' } }, '你已退出本次拍卖'));
  }
  // 倒计时进度条
  const timer = el('div', { class: 'turn-timer', style: { width: '100%', margin: '8px 0' } });
  const bar = el('div', { class: 'turn-timer-bar', id: 'auction-bar' });
  timer.appendChild(bar);
  content.appendChild(timer);
  // 清除旧倒计时，创建新倒计时
  if (auctionTicker) clearInterval(auctionTicker);
  auctionTicker = setInterval(() => {
    const left = Math.max(0, auction.endsAt - Date.now());
    bar.style.width = (left / 30000 * 100) + '%';
    if (left < 10000) bar.classList.add('urgent');
    if (left <= 0) { clearInterval(auctionTicker); auctionTicker = null; }
  }, 100);
  // 操作按钮（仅活跃竞拍者显示）
  if (canBid) {
    // 与服务端同款规则:无人出价 ¥1 起,否则当前价 +50
    const inc = (room.constants && room.constants.AUCTION_MIN_INCREMENT) || 50;
    const minNext = auction.currentBid === 0 ? 1 : auction.currentBid + inc;
    // 保留输入:之前输的数字仍然有效(≥ minNext)就不覆盖
    const initVal = (!isNaN(typedVal) && typedVal >= minNext) ? typedVal : minNext;
    const inp = el('input', { type: 'number', id: 'auction-bid-input', value: initVal, min: minNext });
    content.appendChild(el('div', { class: 'modal-row' }, [
      el('label', {}, '出价'),
      inp,
    ]));
    const btns = el('div', { style: { display: 'flex', gap: '4px' } });
    [50, 100, 500].forEach(d => {
      const b = el('button', { class: 'btn btn-tiny', onclick: () => inp.value = (parseInt(inp.value) || 0) + d }, '+' + d);
      btns.appendChild(b);
    });
    content.appendChild(btns);
    const actions = el('div', { class: 'modal-actions' });
    const bidBtn = el('button', { class: 'btn btn-success', onclick: () => {
      const v = parseInt(inp.value) || 0;
      if (v < minNext) { alert(`出价至少 ${money(minNext)}`); return; }
      if (v > me.money) { alert('现金不足'); return; }
      socket.emit('auction:bid', { amount: v });
    } }, '确认出价');
    actions.appendChild(bidBtn);
    const passBtn = el('button', { class: 'btn btn-ghost', onclick: () => socket.emit('auction:pass') }, '退出拍卖');
    actions.appendChild(passBtn);
    const minBtn = el('button', { class: 'btn btn-tiny', onclick: () => minimizeAuction() }, '🗕 最小化');
    actions.appendChild(minBtn);
    content.appendChild(actions);
  }
  openModal(content, { kind: 'auction' });
}

function minimizeAuction() {
  auctionMinimized = true;
  closeModal();
  // 显示角标
  updateAuctionBadge();
  showBanner('拍卖已最小化到角标，其他人出价不再自动弹窗', 'info');
}

function updateAuctionBadge(auction) {
  let badge = $('#auction-badge');
  if (!badge) {
    badge = el('div', { id: 'auction-badge', class: 'auction-badge' });
    badge.addEventListener('click', () => restoreAuction());
    document.body.appendChild(badge);
  }
  const data = auction || (room && room.auction);
  if (!data) { badge.style.display = 'none'; return; }
  const mine = data.currentBidderId === myId ? '（你）' : '';
  badge.textContent = `🔨 拍卖 ${money(data.currentBid || 0)}${mine}`;
  badge.style.display = 'block';
}

function restoreAuction() {
  auctionMinimized = false;
  const badge = $('#auction-badge');
  if (badge) badge.style.display = 'none';
  if (room && room.auction) openAuctionModal(room.auction);
}

// ---------- 交易模态：发起方 ----------
function openTradeProposeModal(targetId) {
  const me = room && room.players.find(p => p.id === myId);
  const target = room && room.players.find(p => p.id === targetId);
  if (!me || !target) return;
  const offer = { money: 0, properties: [], jailCards: 0 };
  const request = { money: 0, properties: [], jailCards: 0 };
  const buildSide = (title, side, owner) => {
    const div = el('div', { class: 'trade-side' });
    div.appendChild(el('h4', {}, title + '（' + owner.name + '）'));
    const m = el('div', { class: 'field' });
    m.appendChild(el('label', {}, '现金'));
    const moneyInput = el('input', { type: 'number', min: 0, value: 0 });
    m.appendChild(moneyInput);
    div.appendChild(m);
    const c = el('div', { class: 'field' });
    c.appendChild(el('label', {}, '出狱卡'));
    const cardInput = el('input', { type: 'number', min: 0, value: 0 });
    c.appendChild(cardInput);
    div.appendChild(c);
    // 地产（自己未抵押 + houses=0）
    const pl = el('div', { class: 'props-list' });
    room.board.forEach((t, idx) => {
      if (t.ownerId !== owner.id) return;
      if (t.type !== 'property' && t.type !== 'station' && t.type !== 'utility') return;
      if (t.mortgage || t.houses > 0) return;
      const cb = el('input', { type: 'checkbox', value: idx });
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!side.properties.includes(idx)) side.properties.push(idx); }
        else { side.properties = side.properties.filter(i => i !== idx); }
      });
      pl.appendChild(el('label', {}, [cb, t.name]));
    });
    if (pl.children.length === 0) pl.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, '无地产可交易'));
    div.appendChild(pl);
    moneyInput.addEventListener('change', () => side.money = parseInt(moneyInput.value) || 0);
    cardInput.addEventListener('change', () => side.jailCards = parseInt(cardInput.value) || 0);
    return div;
  };
  const content = el('div', {});
  content.appendChild(el('h3', {}, `🤝 发起交易：${me.name} ⇄ ${target.name}`));
  const grid = el('div', { class: 'trade-grid' });
  grid.appendChild(buildSide('你出', offer, me));
  grid.appendChild(buildSide('你得', request, target));
  content.appendChild(grid);
  const actions = el('div', { class: 'modal-actions' });
  actions.appendChild(el('button', { class: 'btn btn-primary', onclick: () => {
    socket.emit('trade:propose', { toId: target.id, offer, request });
    closeModal();
  } }, '发起交易'));
  actions.appendChild(el('button', { class: 'btn btn-ghost', onclick: closeModal }, '取消'));
  content.appendChild(actions);
  openModal(content, { kind: 'trade' });
}

// ---------- 交易模态：接收方 ----------
function openTradeAcceptModal(trade) {
  if (!trade.isToMe) return; // 发起方自己也可能收到（用于显示 trade 状态）
  const fromName = trade.fromName;
  const content = el('div', {});
  content.appendChild(el('h3', {}, `🤝 ${fromName} 向你发起交易`));
  const remaining = Math.max(0, 60000 - (Date.now() - trade.createdAt));
  content.appendChild(el('div', { class: 'trade-timer', id: 'trade-timer' }, `⏱ 倒计时 ${Math.ceil(remaining / 1000)}s`));
  // 进度条
  const bar = el('div', { class: 'turn-timer', style: { width: '100%', margin: '8px 0' } });
  const barInner = el('div', { class: 'turn-timer-bar' });
  bar.appendChild(barInner);
  content.appendChild(bar);
  const tick = setInterval(() => {
    const r = Math.max(0, 60000 - (Date.now() - trade.createdAt));
    const t = $('#trade-timer');
    if (t) t.textContent = '⏱ 倒计时 ' + Math.ceil(r / 1000) + 's';
    barInner.style.width = (r / 60000 * 100) + '%';
    if (r < 15000) barInner.classList.add('urgent');
    if (r <= 0) clearInterval(tick);
  }, 100);
  // 详情
  const grid = el('div', { class: 'trade-grid' });
  const renderSide = (title, side) => {
    const div = el('div', { class: 'trade-side' });
    div.appendChild(el('h4', {}, title));
    if (side.money) div.appendChild(el('div', {}, '💰 ' + money(side.money)));
    if (side.jailCards) div.appendChild(el('div', {}, '🃏 ×' + side.jailCards));
    if (side.properties && side.properties.length) {
      const names = side.properties.map(idx => room.board[idx]?.name).filter(Boolean);
      div.appendChild(el('div', {}, '🏠 ' + names.join('、')));
    }
    return div;
  };
  grid.appendChild(renderSide('对方出', trade.offer));
  grid.appendChild(renderSide('你出', trade.request));
  content.appendChild(grid);
  const actions = el('div', { class: 'modal-actions' });
  actions.appendChild(el('button', { class: 'btn btn-success', onclick: () => { clearInterval(tick); socket.emit('trade:accept'); } }, '✅ 接受'));
  actions.appendChild(el('button', { class: 'btn btn-warn', onclick: () => { clearInterval(tick); socket.emit('trade:reject'); } }, '❌ 拒绝'));
  content.appendChild(actions);
  openModal(content, { kind: 'trade-accept' });
}

// ---------- 状态切换主入口 ----------
function onRoomState(r) {
  const prevState = room?.state;
  room = r;
  myId = socket.id;
  setLS({ lastCode: r.code, lastPlayerId: socket.id });
  if (r.state === 'WAITING') {
    // 再来一局/回到等待厅:清掉上一局的特效基线与结算屏
    if (prevState === 'FINISHED' || prevState === 'IN_PROGRESS') {
      closeModal();
      nwHistory = [];
      lastSampledTurn = -1;
      prevMoney = {};
      prevOwners = null;
      prevTurnPlayerId = null;
      prevBankrupt = null;
      elimQueue = [];
      chatSeenCount = null;
    }
    showScreen('waiting'); renderWaiting();
  } else if (r.state === 'IN_PROGRESS' || r.state === 'FINISHED') {
    showScreen('game');
    refreshBoard();
    refreshPlayers();
    refreshPawns();
    refreshActions();
    refreshLog();
    refreshChat();
    refreshStatus();
    startTurnTimer();
    // 净资产曲线采样(每个 turnCount 采一次,避免逐步移动的连播采爆)
    if (r.state === 'IN_PROGRESS' && r.turnCount !== lastSampledTurn) {
      lastSampledTurn = r.turnCount;
      const worths = {};
      r.players.forEach(p => { worths[p.id] = p.bankrupt ? 0 : (p.netWorth ?? p.money); });
      nwHistory.push({ turn: r.turnCount, worths });
      if (nwHistory.length > 400) nwHistory.shift();
    }
    // 「轮到你了」大提示(仅在回合切到我的瞬间触发一次)
    const curP = r.players[r.turnIndex];
    const curId = curP && !curP.bankrupt ? curP.id : null;
    if (r.state === 'IN_PROGRESS' && curId === myId && prevTurnPlayerId !== null && prevTurnPlayerId !== myId) {
      showBanner('🎲 轮到你了！', 'your-turn');
      playTone(660, 0.12); setTimeout(() => playTone(880, 0.18), 120);
    }
    prevTurnPlayerId = curId;
    // 破产出局特效:bankrupt false→true 的瞬间(首次快照/重连不触发)
    if (prevBankrupt) {
      r.players.forEach(p => {
        if (p.bankrupt && prevBankrupt[p.id] === false) queueEliminationFx(p);
      });
    }
    prevBankrupt = {};
    r.players.forEach(p => { prevBankrupt[p.id] = !!p.bankrupt; });
  }
}
function refreshLog() {
  if (!room) return;
  const ul = $('#log');
  if (!ul) return;
  ul.innerHTML = '';
  (room.log || []).slice(-30).reverse().forEach(e => {
    const li = el('li', {});
    const d = new Date(e.ts || Date.now());
    li.appendChild(el('span', { class: 'log-ts' }, `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`));
    li.appendChild(document.createTextNode(e.text || ''));
    ul.appendChild(li);
  });
  ul.scrollTop = 0;
}
function refreshChat() {
  if (!room) return;
  const ul = $('#chat'); ul.innerHTML = '';
  (room.chat || []).forEach(m => {
    const li = el('li', { class: m.id === 'system' ? 'sys-msg' : '' });
    if (m.id !== 'system') li.appendChild(el('span', { class: 'from' }, (m.fromName || '?') + ':'));
    li.appendChild(document.createTextNode(m.text));
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
  // 未读红点：抽屉关着且有新消息才亮（首次进入只记基线，不把历史算成未读）
  const count = (room.chat || []).length;
  const drawerOpen = $('#drawer-chat').classList.contains('open');
  if (chatSeenCount === null || drawerOpen) {
    chatSeenCount = count;
    $('#chat-unread').classList.add('hidden');
  } else if (count > chatSeenCount) {
    $('#chat-unread').classList.remove('hidden');
  }
}
function refreshStatus() {
  if (!room) return;
  const cur = room.players[room.turnIndex];
  $('#status').textContent = cur ? (cur.bankrupt ? `${cur.name} 已破产` : `轮到 ${cur.name} 行动`) : '等待开始';
  $('#game-code').textContent = room.code;
}
$('#btn-chat').onclick = () => sendChat();
$('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const t = $('#chat-input').value.trim();
  if (!t || !socket) return;
  socket.emit('chat:message', { text: t });
  $('#chat-input').value = '';
}

// ---------- 快捷表情 ----------
const EMOTES = ['👍', '😂', '😡', '💰', '🙏', '🎉'];
(function buildEmoteRow() {
  const row = $('#emote-row');
  if (!row) return;
  EMOTES.forEach(e => {
    row.appendChild(el('button', {
      class: 'emote-btn', type: 'button',
      onclick: () => { if (socket) socket.emit('chat:message', { text: e }); },
    }, e));
  });
})();

// chip 上方爆出大表情(挂 body,不受 chip 重渲染影响)
function spawnEmoteBurst(chipEl, emoji) {
  const r = chipEl ? chipEl.getBoundingClientRect() : null;
  const x = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
  const y = r && r.width ? r.top : 80;
  const b = el('div', { class: 'emote-burst' }, emoji);
  b.style.left = x + 'px';
  b.style.top = y + 'px';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 1500);
}

// ---------- 音效开关 ----------
(function initSoundToggle() {
  const btn = $('#btn-sound');
  if (!btn) return;
  const render = () => { btn.textContent = soundMuted ? '🔇' : '🔊'; };
  render();
  btn.onclick = () => {
    soundMuted = !soundMuted;
    try { localStorage.setItem('mp:muted', soundMuted ? '1' : '0'); } catch {}
    render();
    if (!soundMuted) playTone(660, 0.1);
  };
})();

// ---------- 键盘快捷键(桌面) ----------
// 空格=主行动(掷骰/结束回合) E=结束回合 B=建造 M=抵押
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (!$('#game').classList.contains('active')) return;
  if (pendingModal) return; // 模态打开时不响应,防止误触拍卖/交易
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  const btn = $(`#action-dock [data-hotkey="${key}"]`);
  if (btn && !btn.disabled) {
    e.preventDefault();
    btn.click();
  }
});
// ---------- 抽屉（日志/聊天）：开关浮钮 + 关闭按钮,同时只开一个 ----------
function toggleDrawer(id) {
  const target = $('#' + id);
  const willOpen = !target.classList.contains('open');
  $$('.drawer').forEach(d => d.classList.remove('open'));
  if (willOpen) target.classList.add('open');
  if (id === 'drawer-chat' && willOpen) {
    // 打开聊天抽屉 → 清未读
    chatSeenCount = (room && room.chat || []).length;
    $('#chat-unread').classList.add('hidden');
    const ul = $('#chat'); ul.scrollTop = ul.scrollHeight;
  }
}
$('#btn-drawer-log').onclick = () => toggleDrawer('drawer-log');
$('#btn-drawer-chat').onclick = () => toggleDrawer('drawer-chat');
$$('.drawer-close').forEach(btn => {
  btn.addEventListener('click', () => $('#' + btn.dataset.close).classList.remove('open'));
});

// 需求4：倒计时进度条（时长读服务端 TURN_TIMEOUT_MS，与自动操作同步）
let turnTimerInterval = null;
function startTurnTimer() {
  clearInterval(turnTimerInterval);
  turnTimerInterval = setInterval(() => {
    if (!room || !room.turnStartedAt || room.subState === 'AUCTION' || room.subState === 'MOVING' || room.state !== 'IN_PROGRESS') {
      $('#turn-timer-bar').style.width = '100%';
      $('#turn-timer-bar').classList.remove('urgent');
      return;
    }
    const timeout = (room.constants && room.constants.TURN_TIMEOUT_MS) || 15000;
    const elapsed = Date.now() - room.turnStartedAt;
    const left = Math.max(0, timeout - elapsed);
    $('#turn-timer-bar').style.width = (left / timeout * 100) + '%';
    if (left < timeout / 3) $('#turn-timer-bar').classList.add('urgent');
    else $('#turn-timer-bar').classList.remove('urgent');
  }, 500);
}

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', () => {
  buildLobby();
  showScreen('lobby');
  // 立刻创建 socket 连接——如果有保存的游戏，自动触发重连
  ensureSocket();
});

})();
