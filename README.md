# ✈️ Flight Radar

实时全球航班追踪网站，数据来自多个免费 ADS-B 社区数据源。

**Live:** https://flightradar.graymammoth.com

---

## 功能

- 🌍 实时追踪 ~6000+ 架飞机
- 🗺️ WebGL 渲染（MapLibre GL），缩放拖拽 60fps 流畅
- 🎨 按飞行高度着色（灰/绿/青/紫/蓝）
- 📍 点击飞机查看详情（航班号/机型/注册号/高度/速度/航线等）
- 🛤️ 选中飞机显示历史航迹线（Redis 持久化，~20 分钟）
- 🔍 筛选功能（按航班号、航线、机型、注册号、航司）
- 🌐 多语言（English / 中文 / 日本語）
- 🌙 暗色/亮色主题切换
- 📶 WebSocket 实时推送 + 增量更新（delta）
- 📱 移动端适配
- ⚡ Service Worker 离线缓存地图瓦片

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Browser                           │
│  ┌──────────────┐  ┌─────────┐  ┌───────────────┐  │
│  │ MapLibre GL  │  │  i18n   │  │ Service Worker│  │
│  │  (WebGL)     │  │ EN/ZH/JA│  │ (tile cache)  │  │
│  └──────┬───────┘  └─────────┘  └───────────────┘  │
│         │ WebSocket / HTTP                          │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Nginx  │  (reverse proxy + SSL termination)        │
│  :80/:443 → 127.0.0.1:3001                         │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Node.js Backend (Express + WebSocket)              │
│         │                                           │
│  ┌──────┴──────┐   ┌──────────┐   ┌─────────────┐  │
│  │  server.js  │   │ cache.js │   │ trailStore  │  │
│  │ WS + REST   │   │ in-memory│   │   (Redis)   │  │
│  └──────┬──────┘   └──────────┘   └─────────────┘  │
│         │                                           │
│  ┌──────┴──────────────────────────────────┐        │
│  │         datasource.js                    │        │
│  │  ┌──────────┐ ┌────────┐ ┌───────────┐  │        │
│  │  │ adsb.lol │ │adsb.fi │ │    FR24   │  │        │
│  │  │ (Europe/ │ │ (Asia) │ │(Global+CN)│  │        │
│  │  │ Americas)│ │        │ │           │  │        │
│  │  └──────────┘ └────────┘ └───────────┘  │        │
│  │  + Circuit Breaker per source            │        │
│  └──────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Redis  │  (trail persistence, TTL 1h)              │
└─────────────────────────────────────────────────────┘
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | MapLibre GL JS (WebGL)、Vanilla JS、CSS |
| 后端 | Node.js 22、Express、ws (WebSocket) |
| 数据源 | adsb.lol + opendata.adsb.fi + FR24 public feed |
| 缓存 | Redis (trails)、内存 (aircraft state) |
| 反代 | Nginx + Cloudflare (Proxied) |
| 进程管理 | systemd |
| 压缩 | compression (gzip) |
| 离线 | Service Worker (tile cache) |

---

## 目录结构

```
/home/Flightradar/
├── frontend/
│   ├── index.html          # 主页面
│   ├── sw.js               # Service Worker
│   ├── css/
│   │   └── style.css       # 样式（含暗/亮主题）
│   └── js/
│       ├── app.js          # 主应用逻辑（地图/WS/交互）
│       └── i18n.js         # 多语言 + 主题切换
├── backend/
│   ├── package.json
│   ├── server.js           # Express + WebSocket 服务
│   ├── datasource.js       # 多数据源 + Circuit Breaker
│   ├── cache.js            # 内存缓存 + 去重
│   └── trailStore.js       # Redis 轨迹存储
├── nginx.conf              # Nginx 配置参考
└── README.md
```

---

## 数据源

| 数据源 | 类型 | 覆盖 | 说明 |
|--------|------|------|------|
| **adsb.lol** | 免费 API | 欧美强 | 无需 key，无频率限制 |
| **opendata.adsb.fi** | 免费 API | 亚洲（日本/港台/东南亚） | 有频率限制 |
| **FR24 public feed** | 非官方 | 全球（含中国大陆） | 灰色地带，含出发地/目的地/航司 |

数据每 ~10 秒更新一次，三源并行拉取，通过 Circuit Breaker 独立熔断。

---

## API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/flights` | GET | 所有在追踪的航班（支持 ETag） |
| `/api/trail/:icao24` | GET | 某架飞机的历史轨迹 |
| `/api/health` | GET | 服务状态（数据源/Redis/WS 客户端数） |
| `/ws` | WebSocket | 实时推送（full + delta 增量） |

### WebSocket 协议

**连接后收到：**
```json
{ "type": "full", "aircraft": [...], "count": 6000, "timestamp": 1234567890 }
```

**后续增量更新：**
```json
{ "type": "delta", "changed": [...], "removed": ["icao1", "icao2"], "count": 6000, "timestamp": 1234567890 }
```

**客户端可发送视口信息：**
```json
{ "type": "viewport", "lat": 30, "lon": 110, "dist": 250 }
```

---

## 部署

### 前置条件

- Node.js 18+
- Nginx
- Redis
- 域名 + DNS（可选 Cloudflare）

### 1. 克隆/上传项目

```bash
# 项目目录
/home/Flightradar/
```

### 2. 安装依赖

```bash
cd /home/Flightradar/backend
npm install
```

### 3. 安装 Redis

```bash
sudo apt install redis-server -y
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### 4. 创建 systemd 服务

```bash
sudo tee /etc/systemd/system/flight-radar.service << 'EOF'
[Unit]
Description=Flight Radar Server
After=network.target redis-server.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/Flightradar/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3001
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable flight-radar
sudo systemctl start flight-radar
```

### 5. 配置 Nginx

```bash
sudo tee /etc/nginx/sites-available/flight-radar << 'EOF'
server {
    listen 80;
    listen 443 ssl;
    server_name flightradar.yourdomain.com;

    ssl_certificate /etc/nginx/ssl/flightradar.crt;
    ssl_certificate_key /etc/nginx/ssl/flightradar.key;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/flight-radar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. DNS

将子域名指向服务器 IP：

- **Cloudflare Proxied**：自动 HTTPS，需在 origin 配自签证书监听 443
- **DNS Only**：需用 certbot 签 Let's Encrypt 证书

---

## 运维

```bash
# 服务状态
sudo systemctl status flight-radar

# 实时日志
sudo journalctl -u flight-radar -f

# 重启
sudo systemctl restart flight-radar

# 健康检查
curl http://127.0.0.1:3001/api/health

# Redis 状态
redis-cli INFO keyspace
redis-cli DBSIZE
```

---

## 性能数据

| 指标 | 数据 |
|------|------|
| 飞机数量 | ~6000 架 |
| 数据更新频率 | ~10 秒 |
| API 响应大小（gzip） | ~250 KB |
| WS 增量消息大小 | ~30-80 KB |
| 内存占用 | ~180 MB |
| Redis 键数 | ~6000（trail:*） |
| 首次加载 | ~2s |
| 二次加载（SW 缓存） | <1s |

---

## 自定义

### 修改数据区域

编辑 `backend/datasource.js` 中的 `REGIONS` 对象：

```js
const REGIONS = {
  lol: [
    { lat: 50, lon: 10, dist: 250, label: 'Europe Central' },
    // 添加更多区域...
  ],
  fi: [...],
  fr24: [
    { south: 20, north: 35, west: 100, east: 125, label: 'China South' },
    // 添加更多区域...
  ]
};
```

### 添加新语言

编辑 `frontend/js/i18n.js`，在 `LANG` 对象中添加新语言 key。

### 修改高度着色

编辑 `frontend/js/app.js` 中的 `PLANE_COLORS` 和 `getPlaneImageName`。

---

## 注意事项

- **FR24 公开 feed** 是非官方 API，可能随时被限制或封禁
- **adsb.fi** 有频率限制（连续请求太快会 429），backend 已内置 800ms 间隔
- ADS-B 社区数据覆盖取决于地面接收站分布，中国内陆覆盖较弱
- Service Worker 会缓存静态资源，发布新版本后用户需强刷或等 SW 更新

---

## License

Personal project. Data sources have their own terms of use.
