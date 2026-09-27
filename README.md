# 地产大亨 — 局域网联机版 🏘️

一款用 Node.js + Express + Socket.IO + 纯 HTML/CSS/JS 实现的局域网大富翁网页游戏，2–6 人同台竞技。

## 特性

- 🎲 经典大富翁规则：掷骰、买地、收租、建房、抵押、拍卖、机会命运卡、进监狱、破产与胜出
- 🌐 局域网联机：一名玩家创建房间，其他人通过房号或 LAN IP 加入
- 📱 响应式界面：电脑 / 平板 / 手机均可玩
- 🎨 派对向视觉风格：浅色渐变背景 + 鲜艳色组 + 圆角阴影
- 🔒 服务端权威：所有游戏逻辑与随机数都在服务端，杜绝前端作弊

## 一键启动

```bash
cd c:\Users\86184\Desktop\game
npm install
npm start
```

启动后控制台会打印：

```
  地产大亨 server listening on port 3000

  Open from this machine:  http://localhost:3000
  Open from same LAN:
     http://192.168.x.x:3000   (Wi-Fi)
     http://10.0.0.x:3000      (Ethernet)
```

- **本机玩家**：浏览器打开 `http://localhost:3000`
- **同 Wi-Fi 玩家（手机/平板/其他电脑）**：复制控制台里的 LAN 地址，在浏览器打开

> Windows 首次运行可能会弹出"是否允许 Node.js 通过防火墙"的提示，请点"允许"。

## 玩法

1. 进入主页，输入昵称、选择头像与棋子色
2. **房主**点「创建房间」，记住房号（如 `A7K2P`）
3. 其他玩家点「加入房间」，输入相同房号
4. 2 人以上即可开始，房主点「开始游戏」，系统随机决定先后手
5. 轮到你的回合时，按钮亮起，点「🎲 掷骰子」
6. 落到无主地产可选择「💰 购买」或「🏷 放弃→拍卖」
7. 操作面板还有「🏠 建造 / 卖房」「💰 抵押 / 赎回」「⏭ 结束回合」等按钮
8. 进入监狱时显示三选一：付 1000 / 用出狱卡 / 尝试掷双
9. 聊天窗口可与同房间玩家实时对话
10. 最后一名未破产玩家获胜

## 规则速览

- **起始资金**：默认 8000 元（可选 5000/12000/15000，地图价格按比例缩放）；**经过 GO**：+2000 元
- **建房价**：见棋盘各色组顶部；**酒店** = 5 × 建房单价
- **抵押**：得到 1/2 买价；**赎回**：付 0.55 × 买价
- **车站**：租金 = 500 × 拥有数（4 站最多）
- **公用事业**：租金 = 骰子 × 6（1 个）/ × 12（2 个）
- **监狱**：进监后有 3 次掷双机会；满 3 次强制付出狱费
- **破产**：现金为负时自动卖房→抵押→应急贷款，仍不足则破产出局
- **均匀建造**：同色组所有地必须保持房子数差距 ≤ 1

## 项目结构

```
game/
├── package.json          # 依赖与启动脚本
├── server.js             # Express + Socket.IO + 全部游戏状态机
├── public/
│   ├── index.html        # 单页 DOM（大堂 + 等待 + 游戏 + 弹窗）
│   ├── style.css         # 渐变风格 + 棋盘网格 + 响应式
│   └── game.js           # Socket 客户端 + UI 派生渲染
└── README.md
```

## 技术栈

- **后端**：Node.js 18+，Express 4.19，Socket.IO 4.7
- **前端**：原生 HTML + CSS + JavaScript（无任何框架 / 构建工具）
- **随机性**：`crypto.randomInt`（密码学安全）用于掷骰与洗牌

## 端口

默认 `3000`。可通过环境变量覆盖：

```bash
PORT=8080 npm start
```

## API 一览

| 端点 | 用途 |
|------|------|
| `GET /` | 主页（静态 HTML） |
| `GET /health` | 健康检查 |
| `GET /api/rooms/:code` | 查询房间状态 |

## Socket 事件

客户端 → 服务端：`room:create` / `room:join` / `room:leave` / `game:start` / `game:rollDice` / `game:buy` / `game:declineBuy` / `game:build` / `game:sellHouse` / `game:mortgage` / `game:unmortgage` / `game:jailChoice` / `game:endTurn` / `auction:bid` / `auction:pass` / `chat:message`

服务端 → 客户端：`room:created` / `room:joined` / `room:state` / `room:error` / `game:diceResult` / `auction:update` / `auction:end` / `chat:message`

## 浏览器兼容

- Chrome / Edge / Firefox / Safari 最近 2 年版本
- iOS Safari 14+，Android Chrome 90+
- 桌面 / 平板 / 手机自适应

## 开发者调试

在非生产环境（`NODE_ENV !== 'production'`），游戏内可触发以下开发者命令（仅在浏览器 DevTools Console 里使用）：

```js
// 强制扣款让玩家破产（测试自动套现 + 破产流程）
socket.emit('game:debug', { action: 'drain', playerId: '<id>', amount: 99999 });

// 传送玩家到指定格（落格事件会立即触发）
socket.emit('game:debug', { action: 'forcePosition', playerId: '<id>', position: 7 });

// 拉取最新状态
socket.emit('game:debug', { action: 'state' });
```

## 许可

MIT
