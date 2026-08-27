# ⚡ GHFast — GitHub 加速下载服务器

> 一个自托管的 GitHub 加速下载(反向代理)服务器。粘贴任意 GitHub 链接,即时获得加速直链,支持 Releases、仓库压缩包、Raw 文件、Gist 与 `git clone` 全场景。

在线体验地址由你部署后自行填写,部署方式见下文,开箱即用。

## ✨ 功能特性

- **🚀 流式转发,大文件零压力** — 边收边发不落盘,服务器内存占用恒定,GB 级文件无忧
- **📦 全链接类型支持**
  - Release 资产:`github.com/o/r/releases/download/...`
  - 仓库压缩包:`github.com/o/r/archive/...`
  - Raw 文件:`raw.githubusercontent.com/...`
  - Gist 片段:`gist.githubusercontent.com/...`
  - Codeload 快照:`codeload.github.com/...`
  - Git Clone:智能 HTTP 协议(GET/POST/HEAD)完整透传
- **🌐 整页代理浏览** — 直接打开代理地址即可浏览 GitHub 页面,页内链接/资源自动改写留在代理内,根相对路径由兜底路由无缝接管
- **⏯️ 断点续传** — 透明转发 `Range` 请求头,`wget -c` / 下载工具分段拉取无感配合
- **🔗 加速直链可分享** — 解析后生成 `/gh/https/<原始地址>` 形式的直链,可直接用于脚本、CI、下载工具
- **🧰 命令行片段** — 一键复制 `wget` / `curl` / `git clone` 命令
- **🛡️ 安全白名单** — 仅代理 GitHub 系域名(SSRF 防护),逐跳请求头过滤、响应头防注入
- **📊 数据看板** — 请求量、传输总量、覆盖仓库数统计,最近下载记录一览
- **🌙 深色主题** — Emerald 配色,桌面 / 移动端全响应式

## 🏗️ 技术架构

| 层 | 技术 |
|---|---|
| 框架 | Next.js 16(App Router)· TypeScript 5 |
| UI | Tailwind CSS 4 · shadcn/ui · Lucide Icons |
| 数据库 | Prisma ORM · SQLite |
| 代理核心 | Node.js 原生 `fetch` 流式 body 转发 |

### 代理路径设计

代理采用**无双斜杠**路径形式,规避了多数 Web 服务器将 `://` 折叠为 `:/` 触发 308 重定向的问题(重定向会破坏 `curl`、`git` 等不跟随重定向的客户端):

```text
原始:  https://github.com/o/r/releases/download/v1/a.zip
加速:  <你的域名>/gh/https/github.com/o/r/releases/download/v1/a.zip
```

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20(或 Bun ≥ 1.1)
- 能正常访问 GitHub 的网络出口

### 本地运行

```bash
# 1. 安装依赖
bun install        # 或 npm install

# 2. 配置环境变量
echo 'DATABASE_URL="file:../db/custom.db"' > .env

# 3. 初始化数据库
bun run db:push

# 4. 启动开发服务器
bun run dev
```

访问 `http://localhost:3000` 即可使用。

### 生产部署

```bash
bun run build
bun run start
```

建议使用 Nginx / Caddy 反向代理并配置 HTTPS。**注意**:反代配置中请勿开启会折叠 `//` 的路径规范化(默认行为通常安全)。

### 使用方式

```bash
# 网页:粘贴链接 → 解析 → 点击下载

# 或直接使用加速直链:
wget -O file.zip "https://你的域名/gh/https/github.com/o/r/releases/download/v1/file.zip"

# git clone 加速:
git clone "https://你的域名/gh/https/github.com/octocat/Hello-World"

# 整页代理浏览(浏览器直接打开):
https://你的域名/gh/https/github.com/torvalds/linux
```

### 页面代理浏览说明

- 页内 `href/src/action/srcset` 及 CSS `url()`、内嵌脚本中的白名单域链接会自动改写为代理路径
- 未匹配本站路由的根相对路径(如 `/features`)由兜底路由 308 接回代理
- 已知限制:登录态受 Cookie 域限制无法完整保持;少数硬编码绝对地址的 JS 请求仍直连原站

## 📁 项目结构

```text
src/
├── app/
│   ├── gh/[scheme]/[...rest]/route.ts   # 核心流式反向代理 + HTML/CSS 改写
│   ├── [...path]/route.ts               # 兜底 308 → 页面代理浏览不跳出
│   ├── api/
│   │   ├── analyze/route.ts             # 链接解析 + HEAD 元信息探测
│   │   ├── history/route.ts             # 下载历史
│   │   └── stats/route.ts               # 站点统计
│   ├── page.tsx                         # 前端单页
│   └── layout.tsx
├── lib/
│   ├── github-proxy.ts                  # URL 解析 / 白名单 / 类型识别
│   └── db.ts                            # Prisma 客户端
prisma/schema.prisma                     # DownloadRecord 模型
```

## ⚠️ 使用须知

- 本项目仅代理 GitHub 域名白名单内的内容,请勿用于其他用途
- 自建实例请遵守所在地区法律法规及 GitHub 服务条款,勿用于大额商业持续负载
- 私有仓库文件需要认证,本代理默认**不支持**拉取私有资源

## 📄 License

MIT
