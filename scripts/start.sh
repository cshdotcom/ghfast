#!/usr/bin/env bash
# GHFast 启动脚本(standalone 运行时)
# 优先级:环境变量 > .env 文件 > 内置默认值
set -euo pipefail
cd "$(dirname "$0")"

# 1) 先读取 .env 作为默认值来源
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# 2) 再应用环境变量覆盖(.env 之后,保证 PORT=xxx bash start.sh 可覆盖)
export PORT="${PORT:-${GHFAST_PORT:-3000}}"
export HOSTNAME="${HOSTNAME:-${GHFAST_HOST:-0.0.0.0}}"
export DATABASE_URL="${DATABASE_URL:-file:$(pwd)/db/custom.db}"
export NODE_ENV=production

# SQLite 必须用绝对路径(Prisma 相对路径依赖 schema 位置,打包后不可靠)
case "$DATABASE_URL" in
  file:/*) ;;                                  # 已是绝对路径
  file:*) DATABASE_URL="file:$(pwd)/${DATABASE_URL#file:}"; export DATABASE_URL ;;
esac

mkdir -p db

if command -v node >/dev/null 2>&1; then
  exec node server.js
else
  exec bun server.js
fi
