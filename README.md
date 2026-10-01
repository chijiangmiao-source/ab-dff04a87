# 星载指令转码器 · 功能一致性审计

判定有限状态换能器（FST）是否**功能一致（functional / single-valued）**：
即是否存在某条输入串，能沿两条可接受路径产生不同的下行字节串。
判定是**精确**的：不限制输入长度、不使用随机样本、不枚举有限路径。

## 问题与精确算法

输入：输入字母表、初态、接受集、至多 10 个状态、至多 30 条迁移；
迁移消费一个输入符号或 ε，并追加 0–2 个大写 ASCII 输出字符。

在两份换能器拷贝的笛卡尔积（同步积）上搜索：

- 合法走法：左侧单独走 ε、右侧单独走 ε、或两侧同步消费同一输入符号
  （ε 可任意穿插，覆盖所有交错顺序）。
- 维护两条路径的输出**滞后差** `(u, v)`：输出去掉最长公共前缀后的剩余，
  至多一侧非空。
- **滞后引理**：功能一致的换能器中，对任一“既可达又共达接受态对”的状态
  对 `(p,q)`，可达滞后至多一个——否则两个不同滞后配上同一条公共续接，
  必有一对完整路径输出不同。因此每个状态对只保留一个滞后：
  - 滞后两侧首字符不同（永久分叉）：立即用字典序最短公共续接构造反例；
  - 同一状态对出现第二个不同滞后：立即用最短公共续接构造反例；
  - 在接受态对残留单侧滞后：输出长度不同，本身即反例。
- 反向 Dijkstra 预计算每个状态对到 `F×F` 的字典序最短公共续接；
  前向 Dijkstra 按
  **(输入串长度, 输入串 ASCII 序, 左路径迁移标识序列, 右路径迁移标识序列)**
  做单调字典序最短路，保证证人裁决完全稳定、可复现。

每个状态对至多保留一个滞后，配置数 O(|Q|²)，搜索多项式终止。

非法输入（重复状态/迁移标识、悬空端点、非法 ε、未知输入符号、空接受集、
超规模、非法输出字符等）一次性全部指出。非法提交不持久化，修正后可沿用
同一标识重新提交。

## API

- `POST /api/audits`：提交审计。同一 `audit_id` + 同载荷（集合/迁移顺序
  无关的语义规范化摘要）重放时返回冻结结论（`replayed: true`）；同标识
  换载荷返回 `409 AUDIT_ID_CONFLICT`，拒绝覆盖。
- `GET /api/audits/{audit_id}`：按稳定标识重开历史审计（结论持久化于
  SQLite）。
- `GET /health`：健康检查，返回服务版本与已持久化审计数量。
- `GET /`：浏览器页面（真实 fetch 调上述 API）。

不一致时响应中 `evidence` 给出输入串、两条**逐迁移路径**及各自输出。

## 运行

```bash
# 可选：宿主机端口 / 绑定地址
export HOST_PORT=8080 HOST_BIND=127.0.0.1

docker compose up -d --build
# 浏览器打开 http://127.0.0.1:8080
```

数据持久化于命名卷 `audit-data`（容器内 `/srv/data/audits.db`）。

## 单次服务验收 verify

`scripts/verify.sh` 依次完成：代码测试（pytest：精确算法、400 组随机
差分交叉验证、API、持久化）、页面 JS 语法检查、**镜像构建**、Compose
启动并等待健康检查、针对一条**含 ε 迁移的双输出反例**的 HTTP 冒烟；
以退出码报告验收结果（0 通过）。

```bash
HOST_PORT=18080 ./scripts/verify.sh         # 完整 Compose 流程
MODE=local ./scripts/verify.sh              # 无 Docker 时本地等价验收
```

冒烟（`scripts/smoke.py`，仅用标准库）也可单独运行：

```bash
python scripts/smoke.py http://127.0.0.1:8080
```

## 本地开发

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest httpx
.venv/bin/python -m pytest -q
TRANSDUCER_DB=./data/audits.db \
  .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8080
```
