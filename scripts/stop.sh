#!/usr/bin/env bash
# GHFast 停止脚本(standalone 运行时)
set -euo pipefail
cd "$(dirname "$0")"

if [ -f ghfast.pid ]; then
  PID=$(cat ghfast.pid)
  if kill "$PID" 2>/dev/null; then
    echo "GHFast 已停止 (pid $PID)"
  else
    echo "进程 $PID 不在运行"
  fi
  rm -f ghfast.pid
else
  # 兜底:按工作目录特征匹配
  pkill -f "node server.js" 2>/dev/null && echo "已停止 GHFast" || echo "未发现运行中的 GHFast"
fi
