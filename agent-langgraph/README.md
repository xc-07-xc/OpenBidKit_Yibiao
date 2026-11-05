# 易标投标工具箱 · LangGraph 编排服务

在 Electron + React/TS 桌面工具之外，新增一条 **LangGraph（Python）** 多 Agent 编排链路。
业务执行（各阶段 Runner、知识库检索、联网法规检索、Word 导出）仍由 Electron Node 侧复用；
LangGraph 只负责图编排：节点、依赖边、并行扇出、质检条件回退、人工闸门中断。

## 目录结构

```
agent-langgraph/
├─ .venv/                      # Python 3.12 虚拟环境（本地生成，不入库）
├─ requirements.txt            # langgraph / fastapi / uvicorn / httpx / pydantic
├─ launcher.py                 # sidecar 入口（PyInstaller 打包时使用）
├─ smoke_graph.py              # 离线图冒烟（直接构建图，不经过 HTTP）
├─ smoke_server.py             # 离线服务冒烟（mock 节点执行器 + ASGI 客户端）
└─ app/
   ├─ state.py                 # 图状态（dict 合并、logs 追加 reducer）
   ├─ config.py                # 阶段契约镜像、端口、回退上限
   ├─ classify.py              # 质检问题分类（一致性 / 材料缺失）
   ├─ nodes.py                 # 图节点：回调 Node 执行器、写回状态、闸门 interrupt
   ├─ node_client.py           # httpx 回调 Node 内部执行端点（单阶段 15 分钟超时）
   ├─ graph.py                 # StateGraph 拓扑、并行扇出、质检条件边
   └─ server.py                # FastAPI：run_id 隔离、异步启动、快照与闸门决议
```

## 本地启动

```powershell
cd agent-langgraph
.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8765
```

健康检查：`GET http://127.0.0.1:8765/health` → `{"status":"ok"}`

Electron 启动时会自动探测并拉起本服务：优先使用安装包内的 sidecar 可执行文件，
开发态使用仓库里的 `.venv`；两者都不存在时回退内置编排器，并在流水线页头显示“内置编排”。

## 接口约定（已改为异步执行）

| 端点 | 说明 |
| --- | --- |
| `POST /graph/start` | `{ run_id, context }`，**立即返回**当前快照，图在后台执行 |
| `GET /graph/state?run_id=` | 当前图状态、产物、日志、返工轮次、待处理闸门、错误 |
| `POST /graph/approve` | `{ run_id, stage_key, note }`，恢复挂起的闸门 |
| `POST /graph/reject` | 同上，打回并重跑本阶段 |
| `GET /health` | 健康检查 |

每次 `start` 使用独立 `run_id` 作为 LangGraph `thread_id`，不同运行互不覆盖；
`/graph/state` 在运行中可反复读取（Electron 每 2 秒轮询一次并投影回 SQLite 黑板）。
后台任务异常会写入快照 `error` 字段，Electron 侧将对应阶段置为失败并转人工。

## 编排拓扑

每个闸门阶段拆 `<stage>_run`（执行节点，回调 Node 复用 Runner）+ `<stage>_gate`（审批节点，`interrupt()` 挂起）；technical 与 consistency 无人工闸门。

```
START → parse_run → parse_gate → qualification_run → qualification_gate
        ├→ technical_run ───────────────────────┐
        └→ legal_run → legal_gate ──────────────┼→ generate_run → generate_gate
                                                ↓
                                        consistency_run（自动质检）
                                                ↓
              质检条件边：一致性 high 且未超 2 轮 → 回退 generate_run；否则结束
```

- 并行：technical 与 legal 由 qualification 闸门扇出并行，汇合到 generate。
- 人工闸门：parse / qualification / legal / generate 产出后 `interrupt()`，等人工 approve/reject 恢复；reject 清空本阶段产物并自环回到 `<stage>_run` 重跑。
- 回退：consistency 检出可自纠的 high 一致性问题，累加 `rework_count`，把问题清单写成 `feedbackNotes` 回传并清空旧成稿，回到 generate 重跑；上限 `MAX_REWORK_ROUNDS=2`，超限结束（转人工复核）。
- 材料缺失类（缺报价/资质/业绩/人员/证书等）只标记，不自动回退。

## 对接契约

### Python 节点 → Node 内部执行器

Node 侧 `pipelineStageExecutor.cjs` 监听 `127.0.0.1:8788`：

- `POST /internal/run-stage`
  - 请求体：`{ "stage_key": "parse|qualification|technical|legal|generate|consistency", "context": {...}, "upstream": {...} }`
  - 响应体：`{ "outputs": {...}, "logs": [{ "stage": "...", "message": "..." }] }`

### 阶段工具白名单

每个阶段调用 Agent 时显式传 `active_tools`（`pipelineStageTasks.cjs` 的 `STAGE_ACTIVE_TOOLS`）：

| 阶段 | 自定义工具 |
| --- | --- |
| parse / qualification / technical / generate / consistency | `json-validation`、`report-failure` |
| legal | 上述 + `parallel-web-search`、`parallel-web-fetch` |

原生工具（read / write / edit / bash / grep / find / ls）由 Pi 运行时保留，
自动流水线禁用 `ask-user`，避免阶段停在交互问答上。

## 打包 sidecar

```powershell
cd client
npm run prepare-langgraph-sidecar          # 有 PyInstaller 就构建，没有则告警跳过
npm run prepare-langgraph-sidecar -- --check   # 只检查环境
```

- 需要 `agent-langgraph/.venv` 内安装 PyInstaller：`.venv\Scripts\python.exe -m pip install pyinstaller`。
- 产物：`client/vendor/langgraph-sidecar/<platform>-<arch>/yibiao-langgraph[.exe]`。
- `package.json` 已通过 `extraResources` 把它放到安装包 `resources/langgraph-sidecar`，
  `pythonService.cjs` 运行时会优先探测该路径；未构建时安装包照常可用，只是回退内置编排器。

## 离线冒烟

```powershell
.venv\Scripts\python.exe smoke_graph.py    # 图拓扑：顺序、并行、两轮回退、闸门恢复
.venv\Scripts\python.exe smoke_server.py   # HTTP：异步启动、run_id 隔离、轮询、404/409
.venv\Scripts\python.exe smoke_sidecar.py  # 打包产物：真实 exe + mock 执行器的端到端闭环
```

前两个脚本都不依赖 Electron 与模型调用；`smoke_sidecar.py` 需要先构建 sidecar，
默认读取 `client/vendor/langgraph-sidecar/win32-x64/yibiao-langgraph.exe`，可用 `--exe` 指定。

## 现状与边界

- 已就绪：图编译、节点/边/并行/条件回退/中断恢复、run_id 隔离、异步启动与轮询、
  Node 内部执行器复用现有 Runner、快照投影回 SQLite 黑板、sidecar 打包脚本、阶段工具白名单。
- 简化保留：知识库为关键词检索；并行段人工打回整段重跑；失败重试一次后转人工；
  自动回退上限 2 轮；checkpoint 仍在内存（Python 重启后运行中断，前端会提示重跑）。
- 发布注意：正式发版前需在目标平台构建 sidecar（`npm run prepare-langgraph-sidecar`，
  发版机缺 PyInstaller 时用 `--require` 让构建直接失败，避免静默回退）。
