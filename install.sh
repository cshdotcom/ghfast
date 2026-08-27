#!/usr/bin/env bash
# =============================================================================
#  GHFast · GitHub 加速下载服务器 —— 一键安装部署脚本
#
#  用途(人类或 AI Agent 均可执行):
#    curl -fsSL https://raw.githubusercontent.com/cshdotcom/ghfast/main/install.sh -o install.sh
#    bash install.sh                      # 安装到 ./ghfast 并以 3000 端口启动
#    bash install.sh --port 8080          # 指定端口
#    bash install.sh --dir /opt/ghfast    # 指定安装目录
#    bash install.sh --no-start           # 只下载解压,不启动
#
#  环境要求: Linux x86_64(或其他架构时回退源码构建)· curl · node>=20 或 bun
#  幂等安全: 可重复执行,重复运行=更新升级
# =============================================================================
set -euo pipefail

GHFAST_REPO="cshdotcom/ghfast"
GHFAST_VERSION="${GHFAST_VERSION:-latest}"
INSTALL_DIR="${GHFAST_DIR:-$PWD/ghfast}"
PORT="${GHFAST_PORT:-3000}"
NO_START=0

# ----------------------------- 参数解析 -----------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    --version) GHFAST_VERSION="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^#//;s/^ //'; exit 0 ;;
    *)
      echo "[GHFast] 未知参数: $1(--help 查看用法)"; exit 64 ;;
  esac
done

log()  { echo "[GHFast] $*"; }
fail() { echo "[GHFast] ❌ 错误: $*" >&2; echo "GHFAST_READY=0" >&2; exit 1; }

# ----------------------------- 环境检查 -----------------------------
command -v curl >/dev/null 2>&1 || fail "缺少 curl,请先安装(curl 或 apt install curl)"

RUNTIME=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    RUNTIME="node"
  else
    log "⚠ Node 版本 $(node -v) 过低(需 >= 20),尝试寻找 bun..."
  fi
fi
if [[ -z "$RUNTIME" ]]; then
  command -v bun >/dev/null 2>&1 && RUNTIME="bun" || fail "未找到 Node.js(>=20)或 Bun 运行时"
fi
log "运行时: $RUNTIME ($(command -v $RUNTIME))"

ARCH=$(uname -m)
OS=$(uname -s)
[[ "$OS" == "Linux" ]] || log "⚠ 当前系统为 $OS,未在非 Linux 环境充分测试"

# ----------------------------- 解析下载地址 -----------------------------
# 资产使用无版本固定文件名,GitHub latest/download 重定向永远指向最新版,
# 无需调用 GitHub API(规避匿名限流 403)
resolve_asset_url() {
  local ver tag asset="ghfast-standalone-linux-x64.tar.gz"
  if [[ "$GHFAST_VERSION" == "latest" ]]; then
    tag="latest/download"
  else
    tag="download/v${GHFAST_VERSION#v}"
  fi
  echo "https://github.com/${GHFAST_REPO}/releases/${tag}/${asset}"
}

ASSET_URL=$(resolve_asset_url)
if [[ "$ARCH" != "x86_64" ]]; then
  # 非 x64 回退:源码构建(AI Agent 可按提示继续)
  log "❌ 暂无 ${ARCH} 预编译包,回退为源码构建方案:"
  log "  1. git clone https://github.com/${GHFAST_REPO}.git ${INSTALL_DIR}-src"
  log "  2. cd ${INSTALL_DIR}-src && bun install 或 npm install"
  log "  3. echo 'DATABASE_URL=\"file:../db/custom.db\"' > .env && mkdir -p db && bun run db:push"
  log "  4. bun run build && bun run start"
  echo "GHFAST_READY=0 GHFAST_FALLBACK=source-build"
  exit 2
fi

log "版本: ${GHFAST_VERSION}"
log "下载: ${ASSET_URL}"
TMP_TGZ=$(mktemp /tmp/ghfast-XXXX.tar.gz)
curl -fL --progress-bar -o "$TMP_TGZ" "$ASSET_URL" || fail "下载失败"

mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_TGZ" -C "$INSTALL_DIR" --strip-components=1 || fail "解压失败"
rm -f "$TMP_TGZ"
cd "$INSTALL_DIR"
chmod +x start.sh stop.sh 2>/dev/null || true
mkdir -p db
[[ -f db/custom.db ]] || fail "包内缺少初始数据库 db/custom.db"

# ----------------------------- 写入环境配置 -----------------------------
ABS_DIR=$(pwd)
cat > .env <<EOF
# GHFast 运行配置(由 install.sh 生成)
DATABASE_URL="file:${ABS_DIR}/db/custom.db"
GHFAST_PORT=${PORT}
EOF
log "已写入 ${ABS_DIR}/.env(DATABASE_URL 使用绝对路径,迁移目录后仍有效)"

if [[ "$NO_START" == "1" ]]; then
  log "✔ 安装完成(--no-start 未启动)。启动命令: bash ${ABS_DIR}/start.sh"
  echo "GHFAST_READY=1"
  echo "GHFAST_DIR=${ABS_DIR}"
  exit 0
fi

# ----------------------------- 端口占用检查 -----------------------------
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  fail "端口 ${PORT} 已被占用,换一个端口: bash install.sh --port 其他端口"
fi

# ----------------------------- 启动与健康检查 -----------------------------
log "启动 GHFast(端口 ${PORT})..."
nohup bash start.sh > ghfast.log 2>&1 &
echo $! > ghfast.pid
log "进程 PID: $(cat ghfast.pid)"

HEALTH_OK=0
for i in $(seq 1 30); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/stats" || true)
  if [[ "$CODE" == "200" ]]; then HEALTH_OK=1; break; fi
done

if [[ "$HEALTH_OK" != "1" ]]; then
  echo "---- ghfast.log 最近 20 行 ----" >&2
  tail -20 ghfast.log >&2 || true
  fail "健康检查未通过(30 秒),请查看 ${ABS_DIR}/ghfast.log"
fi

# ----------------------------- 完成输出(AI 可解析) -----------------------------
log "════════════════════════════════════════════"
log "🎉 GHFast 部署成功!"
log "  访问地址 : http://localhost:${PORT}"
log "  安装目录 : ${ABS_DIR}"
log "  运行日志 : ${ABS_DIR}/ghfast.log"
log "  停止服务 : bash ${ABS_DIR}/stop.sh"
log "  重新启动 : nohup bash ${ABS_DIR}/start.sh > ${ABS_DIR}/ghfast.log 2>&1 &"
log "  使用方法 : 粘贴 GitHub 链接加速下载,或拼接直链:"
log "             http://localhost:${PORT}/gh/https/github.com/owner/repo/releases/download/..."
log "════════════════════════════════════════════"
echo "GHFAST_READY=1"
echo "GHFAST_URL=http://localhost:${PORT}"
echo "GHFAST_DIR=${ABS_DIR}"
