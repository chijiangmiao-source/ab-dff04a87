#!/usr/bin/env bash
# 单次服务验收 verify：
#   1) 代码测试（pytest：精确算法 / 差分交叉验证 / API / 持久化）
#   2) 浏览器页面 JS 语法检查（node --check）
#   3) Docker 镜像构建（docker compose build）
#   4) Compose 启动并等待健康检查
#   5) HTTP 冒烟：针对一条“含 ε 迁移的双输出反例”走真实 API
# 退出码：0 全部通过；非零表示验收失败（失败时打印容器日志）。
#
# 可配置环境变量：
#   HOST_PORT（宿主机映射端口，默认 18080，避免与本机服务冲突）
#   HOST_BIND（宿主机绑定地址，默认 127.0.0.1）
#   LEAVE_RUNNING=1 验收成功后保留容器运行（默认结束后清理）
#   MODE=local      无 Docker 环境下以本地 uvicorn 代替镜像/Compose 步骤
set -u -o pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
HOST_PORT="${HOST_PORT:-18080}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
BASE_URL="http://${HOST_BIND}:${HOST_PORT}"
MODE="${MODE:-compose}"
VENV="${VENV:-$ROOT/.venv}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

fail=0
trap 'if [ "$fail" != "0" ]; then red "VERIFY FAILED (exit $fail)"; fi' EXIT

# ---------------------------------------------------------------- 1. 单元/集成测试
step "1/5 代码测试（pytest）"
if [ ! -x "$VENV/bin/python" ]; then
  echo "创建虚拟环境 $VENV ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r requirements.txt pytest httpx
fi
TRANSDUCER_DB="$ROOT/tests/_verify_tmp.db" \
  "$VENV/bin/python" -m pytest tests/ -q || { fail=1; exit $fail; }
rm -f "$ROOT/tests/_verify_tmp.db"*

# ---------------------------------------------------------------- 2. 页面 JS 语法
step "2/5 浏览器页面 JavaScript 语法检查"
if command -v node >/dev/null 2>&1; then
  "$VENV/bin/python" - <<'PY'
import pathlib, re, subprocess, sys, tempfile
html = pathlib.Path("app/static/index.html").read_text(encoding="utf-8")
m = re.search(r"<script>(.*)</script>", html, re.S)
assert m, "页面缺少 <script> 块"
with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
    f.write(m.group(1)); js = f.name
r = subprocess.run(["node", "--check", js], capture_output=True, text=True)
sys.exit(r.returncode)
PY
  grn "页面 JS 语法 OK"
else
  echo "（未安装 node，跳过 JS 语法检查）"
fi

# --------------------------------------------------- 3/4. 镜像构建与 Compose
if [ "$MODE" = "local" ]; then
  step "3/5 MODE=local：以本地 uvicorn 代替镜像构建"
  LOCAL_DB="$(mktemp -t transducer-verify-XXXXXX.db)"
  TRANSDUCER_DB="$LOCAL_DB" HOST_PORT="$HOST_PORT" "$VENV/bin/python" -m uvicorn app.main:app \
    --host "$HOST_BIND" --port "$HOST_PORT" \
    >/tmp/transducer-verify.log 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -f "$LOCAL_DB"*' EXIT
else
  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then DC="docker compose";
    elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";
    else red "未找到 docker compose；或设 MODE=local 做本地验收"; fail=1; exit $fail; fi
  else
    red "未找到 docker；或设 MODE=local 做本地验收"; fail=1; exit $fail
  fi

  step "3/5 构建镜像（$DC build）"
  HOST_PORT="$HOST_PORT" HOST_BIND="$HOST_BIND" $DC build || { fail=1; exit $fail; }

  step "4/5 Compose 启动并等待健康检查"
  HOST_PORT="$HOST_PORT" HOST_BIND="$HOST_BIND" $DC up -d
  cleanup() {
    if [ "${LEAVE_RUNNING:-0}" != "1" ]; then
      HOST_PORT="$HOST_PORT" HOST_BIND="$HOST_BIND" $DC down >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT
fi

step "4/5 等待 $BASE_URL/health 就绪"
ready=""
for i in $(seq 1 60); do
  if "$VENV/bin/python" - "$BASE_URL" <<'PY' 2>/dev/null
import json, sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1] + "/health", timeout=2) as r:
        sys.exit(0 if json.load(r)["status"] == "ok" else 1)
except Exception:
    sys.exit(1)
PY
  then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  red "服务未在 60 秒内通过健康检查"
  if [ "$MODE" != "local" ]; then $DC logs --tail 100 || true; fi
  fail=1; exit $fail
fi
grn "服务健康"

# ---------------------------------------------------------------- 5. HTTP 冒烟
step "5/5 HTTP 冒烟：含 ε 迁移的双输出反例"
if "$VENV/bin/python" scripts/smoke.py "$BASE_URL"; then
  grn "SMOKE PASSED"
else
  red "SMOKE FAILED"
  if [ "$MODE" != "local" ]; then $DC logs --tail 100 || true; fi
  fail=1; exit $fail
fi

if [ "${LEAVE_RUNNING:-0}" = "1" ]; then
  echo "LEAVE_RUNNING=1：服务继续在 $BASE_URL 提供。"
fi
grn "VERIFY PASSED：代码测试、镜像构建、HTTP 冒烟全部通过。"
