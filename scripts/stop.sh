#!/usr/bin/env bash
# GHFast 停止脚本(standalone 运行时)
#
# 安全策略(v1.0.1):
#   全程不使用 pkill / killall / 宽泛模式匹配,绝不影响同机其他进程。
#   仅按以下两条精准路径停止:
#     1. ghfast.pid 记录的精确 PID(且必须经工作目录校验确认是本实例);
#     2. 兜底:按端口定位唯一监听进程,/proc/<PID>/cwd 必须等于本目录,
#        校验不过一律拒绝操作并退出码 1。

set -euo pipefail
cd "$(dirname "$0")"
GHFAST_DIR="$(pwd -P)"

say() { printf '%s\n' "$*"; }

# ---------- 端口解析:环境变量 GHFAST_PORT > .env 中的 GHFAST_PORT > 默认 3000 ----------
read_env_port() {
  local raw="" val=""
  if [ -f .env ]; then
    raw="$(grep -hE '^[[:space:]]*(export[[:space:]]+)?GHFAST_PORT[[:space:]]*=' .env 2>/dev/null | tail -n 1 || true)"
    if [ -n "$raw" ]; then
      val="${raw#*=}"
      val="${val%\"}"; val="${val#\"}"
      val="${val%\'}"; val="${val#\'}"
      val="${val%$'\r'}"
      val="${val// /}"
      val="${val//$'\t'/}"
    fi
  fi
  echo "$val"
}

PORT="${GHFAST_PORT:-$(read_env_port)}"
case "$PORT" in ''|*[!0-9]*) PORT=3000 ;; esac

# ---------- 工具函数 ----------
# 校验 PID 工作目录必须是本实例目录(成功=通过)
check_cwd() {
  local pid="$1" cwd=""
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [ -n "$cwd" ] && [ "$cwd" = "$GHFAST_DIR" ]
}

get_cwd() {
  readlink "/proc/$1/cwd" 2>/dev/null || echo "(无法读取)"
}

# 优雅等待进程退出:最多 5 秒;仍存活则 SIGKILL
terminate() {
  local pid="$1" i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    say "SIGTERM 后仍存活,发送 SIGKILL 至 pid $pid(已经工作目录校验属本实例)"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
    ! kill -0 "$pid" 2>/dev/null
  else
    return 0
  fi
}

stop_pid_checked() {
  local pid="$1"
  kill "$pid"
  if terminate "$pid"; then
    say "GHFast 已停止 (pid $pid)"
    return 0
  fi
  say "进程 pid $pid 未能在宽限期内退出,请人工检查"
  return 1
}

# 按端口查找监听进程 PID(本用户进程无需 root)
find_port_pid() {
  local port="$1" pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -nE 's/.*pid=([0-9]+).*/\1/p' | head -n 1 || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pid="$(fuser "$port/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' | head -n 1 || true)"
  fi
  echo "$pid"
}

# ---------- 路径 1:PID 文件 ----------
if [ -f ghfast.pid ]; then
  PID="$(cat ghfast.pid 2>/dev/null || true)"
  case "$PID" in
    ''|*[!0-9]*)
      say "ghfast.pid 内容无效,忽略并转入端口检测"
      rm -f ghfast.pid
      ;;
    *)
      if kill -0 "$PID" 2>/dev/null; then
        if check_cwd "$PID"; then
          stop_pid_checked "$PID" || exit 1
        else
          say "ghfast.pid 中的 PID $PID 当前工作目录为 $(get_cwd "$PID"),并非本实例目录($GHFAST_DIR),可能已被其他进程复用,拒绝停止"
          exit 1
        fi
      else
        say "ghfast.pid 记录的进程 (pid $PID) 已不在运行"
      fi
      rm -f ghfast.pid
      exit 0
      ;;
  esac
fi

# ---------- 路径 2(兜底):按端口定位 + cwd 校验 ----------
PID="$(find_port_pid "$PORT")"

if [ -z "$PID" ]; then
  say "未发现运行中的 GHFast (端口 $PORT 无监听进程)"
  exit 0
fi

if check_cwd "$PID"; then
  stop_pid_checked "$PID" || exit 1
  rm -f ghfast.pid   # 防御性清理孤儿 pid 文件
  exit 0
else
  say "发现端口 $PORT 被占用 (pid $PID, 工作目录: $(get_cwd "$PID")),但并非本 GHFast 实例,拒绝停止"
  exit 1
fi
