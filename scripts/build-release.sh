#!/usr/bin/env bash
# =============================================================================
#  GHFast 发布包构建脚本(隔离构建 → 组装 → 解压级冒烟)
#
#  用途:
#    bash scripts/build-release.sh [输出目录]
#
#  产物:
#    ghfast-standalone-linux-x64.tar.gz(顶层 pkg/,install.sh --strip-components=1 适配)
#
#  修复历史:v1.0.5 包内缺 db/custom.db,导致 install.sh 快速失败;
#            本脚本将「解压后冒烟」纳入强制步骤,防回归。
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_DIR/dist}"
SMOKE_PORT="${SMOKE_PORT:-4599}"

command -v rsync >/dev/null || { echo "缺少 rsync"; exit 1; }
command -v bun >/dev/null || { echo "缺少 bun"; exit 1; }

echo "[1/6] 隔离构建目录(不污染 dev 实例)..."
STAGE=$(mktemp -d /tmp/ghfast-build-XXXX)
rsync -a \
  --exclude .git --exclude node_modules --exclude .next \
  --exclude 'db/*.db' --exclude 'db/*.db-journal' \
  --exclude '.env' --exclude '.env.local' --exclude '.env*.local' \
  --exclude '*.log' --exclude worklog.md --exclude dist \
  "$REPO_DIR"/ "$STAGE/src/"
mkdir -p "$STAGE/src/db"
cd "$STAGE/src"

echo "[2/6] 安装依赖 + 生成全新数据库(仅 schema,不含用户数据)..."
bun install --frozen-lockfile >/dev/null
DATABASE_URL="file:$STAGE/src/db/custom.db" bunx prisma db push --accept-data-loss >/dev/null
[[ -f db/custom.db ]] || { echo "db push 未产出 custom.db"; exit 1; }

echo "[3/6] next build(standalone)..."
bun run build >/dev/null

echo "[4/6] 组装 pkg/..."
PKG="$STAGE/pkg"
mkdir -p "$PKG/db" "$PKG/prisma"
cp -a .next/standalone/. "$PKG/"
cp -a .next/static "$PKG/.next/static"
cp -a public "$PKG/public"
cp -a prisma/schema.prisma "$PKG/prisma/"
cp -a db/custom.db "$PKG/db/custom.db"
cp -a scripts/start.sh scripts/stop.sh "$PKG/"
cat > "$PKG/.env" <<'EOF'
DATABASE_URL="file:db/custom.db"
EOF
# 公网域名配置(db/ghfast.config.json)属部署环境私有,不入发布包(自托管走 env/.env)
rm -f "$PKG/db/ghfast.config.json"

echo "[5/6] 打包..."
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/ghfast-standalone-linux-x64.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" pkg

echo "[6/6] 解压级冒烟(全新目录 + 独立端口 $SMOKE_PORT)..."
SMOKE="$STAGE/smoke"
mkdir -p "$SMOKE"
tar -xzf "$TARBALL" -C "$SMOKE" --strip-components=1
( cd "$SMOKE" && PORT=$SMOKE_PORT nohup bash start.sh > smoke.log 2>&1 & echo $! > "$STAGE/smoke.pid" )
SMOKE_PID=$(cat "$STAGE/smoke.pid")
cleanup() { kill "$SMOKE_PID" 2>/dev/null || true; sleep 1; kill -9 "$SMOKE_PID" 2>/dev/null || true; }
trap cleanup EXIT

HEALTH_OK=0
for _ in $(seq 1 30); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$SMOKE_PORT/api/stats" || true)
  [[ "$CODE" == "200" ]] && { HEALTH_OK=1; break; }
done
[[ "$HEALTH_OK" == "1" ]] || { echo "冒烟失败:健康检查未过"; tail -30 "$SMOKE/smoke.log"; exit 1; }
echo "  ✓ /api/stats 200"

CH=$(curl -sSI "http://127.0.0.1:$SMOKE_PORT/v2/" | grep -i '^www-authenticate:' || true)
echo "  ✓ ping challenge: $CH"
echo "$CH" | grep -q "http://127.0.0.1:$SMOKE_PORT/v2/auth" || { echo "冒烟失败:realm 未指向本站"; exit 1; }

TOK=$(curl -sS "http://127.0.0.1:$SMOKE_PORT/v2/auth?realm=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("https://ghcr.io/token",safe=""))')&service=ghcr.io&scope=repository%3Aghcr.io%2Fastral-sh%2Fuv%3Apull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null || true)
[[ -n "$TOK" ]] || { echo "冒烟失败:GHCR token 舞步失败"; exit 1; }
echo "  ✓ GHCR token: ${TOK:0:16}..."
MCODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOK" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "http://127.0.0.1:$SMOKE_PORT/v2/ghcr.io/astral-sh/uv/manifests/latest")
[[ "$MCODE" == "200" ]] || { echo "冒烟失败:GHCR manifest $MCODE"; exit 1; }
echo "  ✓ GHCR manifest 200"

trap - EXIT
cleanup

echo
echo "════════════════════════════════════════════"
echo "🎉 发布包构建 + 冒烟通过"
echo "  包: $TARBALL"
echo "  大小: $(stat -c%s "$TARBALL") bytes"
echo "  sha256: $(sha256sum "$TARBALL" | cut -d' ' -f1)"
echo "════════════════════════════════════════════"
