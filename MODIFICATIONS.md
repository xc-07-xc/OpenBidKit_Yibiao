# 修改说明（MODIFICATIONS）

本项目是 [FB208/OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao) 的**二次开发版本**。
依据 GNU AGPL-3.0 第 5(a) 条，在此显著声明对上游代码的修改内容与修改时间。

| 项目 | 内容 |
| --- | --- |
| 上游原仓库 | https://github.com/FB208/OpenBidKit_Yibiao |
| 上游原作者 | mark / yibiaoai（Copyright 2025-2026） |
| 本分支基于的上游提交 | `7591849`（Merge PR #230 "word编辑方式改造"，2026-11-04） |
| 本仓库 | https://github.com/xc-07-xc/OpenBidKit_Yibiao |
| 维护者 | xc-07-xc |
| 修改时间 | 2026-11-06 至 2026-11-10 |
| 改动规模 | **62 个文件，+8023 / −12 行** |
| 改动性质 | **以新增功能为主**，对上游既有文件仅作接入性小改动，未删改上游已有功能 |
| 许可证 | GNU AGPL-3.0 only（与上游一致，未添加任何额外限制） |

> **关于上游更新的说明**：本分支从 `7591849` 分出后，上游在 2026-11-04 至 2026-11-10 之间又合入了若干提交（当前为 `9f3b11f`），其中包括"内置广告位""图片公告""诊断 agent""知识库交互优化"等。这些功能**本仓库暂不包含**，并非被移除；后续合并上游时会逐步引入。因此在本仓库中看不到上述模块属于预期情况。

---

## 一、新增：多 Agent 标书编写流水线（主体改动）

这部分几乎全部是新增文件，共 9 个提交。

### 1. `agent-langgraph/` — Python 侧 LangGraph 编排服务（16 个新文件）

独立的 Python 运行时，作为 Electron 客户端的本地 sidecar 进程启动：

| 文件 | 作用 |
| --- | --- |
| `app/graph.py` | LangGraph 图结构定义（阶段流转、条件边） |
| `app/state.py` | 图状态模型与累计字段 |
| `app/nodes.py` | 各阶段节点实现（生成、评审、返工） |
| `app/classify.py` | 章节/任务分类 |
| `app/config.py` | 运行配置 |
| `app/server.py` | HTTP 服务入口，供 Node 侧调用 |
| `app/node_client.py` | 反向回调 Node 侧的客户端 |
| `app/outputs.py` | 产物汇总与导出 |
| `launcher.py` | 进程启动器 |
| `requirements.txt` | Python 依赖 |
| `smoke_*.py` | 4 个冒烟/端到端验证脚本 |

另含 `agent-langgraph/README.md` 使用说明。

### 2. `client/electron/services/pipeline/` — Node 侧流水线编排（10 个新文件）

| 文件 | 作用 |
| --- | --- |
| `orchestrator.cjs` | 流水线总编排 |
| `langgraphOrchestrator.cjs` | 与 Python 图编排的对接层 |
| `langgraphOrchestrator.test.cjs` | 编排器单元测试 |
| `pipelineStageExecutor.cjs` | 阶段执行器 |
| `pipelineStageTasks.cjs` | 各阶段具体任务（改动量最大，627 行） |
| `pipelineRunners.cjs` | 执行后端封装 |
| `pipelineReview.cjs` | 终审闸门与打回判定 |
| `consistencyAudit.cjs` | 全文一致性质检 |
| `pipelineArtifacts.cjs` | 产物收集 |
| `pipelineStore.cjs` | 运行状态持久化 |
| `pipelineAgentConfig.cjs` | 各阶段 Agent 配置 |

### 3. `client/electron/services/langgraph/` — Python 进程桥接（2 个新文件）

- `pythonService.cjs` — sidecar 进程生命周期管理（启动、健康检查、退出清理）
- `langgraphBridge.cjs` — Node ↔ Python 的请求/回调桥

### 4. `client/src/features/pipeline/` — 界面（3 个新文件）

- `pages/PipelineHome.tsx` — 流水线主界面（阶段进度、评分轨迹、返工记录、导出入口，683 行）
- `types.ts` — 前端类型定义
- `client/src/styles/feature-pipeline.css` — 配套样式

### 5. 其他新增

- `client/electron/ipc/pipelineIpc.cjs` — 流水线 IPC 通道
- `client/electron/services/legalResearchTask.cjs` — 法规检索任务
- `client/scripts/prepare-langgraph-sidecar.cjs` — 打包时准备 Python sidecar
- `client/scripts/inspect-pipeline-run.cjs` — 运行结果诊断脚本
- `client/.npmrc` — 客户端 npm 配置
- `docs/competition/技术方案.md`、`docs/competition/演示脚本.md` — 比赛技术方案与现场演示脚本
- `使用说明/使用/13-多Agent流水线.md` — 使用说明

## 二、对上游既有文件的接入性修改（12 个文件，合计约 14 行变更的核心逻辑）

这些改动都是为了让新模块接入现有架构，不改变上游原有功能：

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `client/electron/ipc/index.cjs` | +83 | 注册流水线 IPC 处理器 |
| `client/electron/preload.cjs` | +16 | 暴露流水线 API 到渲染进程 |
| `client/src/shared/types/ipc.ts` | +117 | 补充 IPC 类型定义 |
| `client/electron/services/knowledgeBaseStore.cjs` | +48 | 为流水线提供知识库读取接口 |
| `client/electron/services/sqliteDatabase.cjs` | +26 | 新增流水线表结构初始化 |
| `sql/workspace_schema.sql` | +16 | 工作区数据库新增流水线表 |
| `client/package.json` | +24 | 版本号 2.32.0、打包链路加入 sidecar 准备步骤 |
| `client/electron/utils/paths.cjs` | +6 | 新增 sidecar 目录解析 |
| `client/src/components/Sidebar.tsx` | +13 | 侧边栏新增流水线入口 |
| `client/src/app/menuConfig.ts` | +5 | 菜单项注册 |
| `client/src/app/AppRouter.tsx` | +3 | 路由注册 |
| `client/src/shared/types/index.ts` / `navigation.ts` / `styles.css` | +5 | 类型与样式挂载 |
| `.gitignore` | +4 | 忽略 sidecar 构建产物 |
| `AGENTS.md` | +3 | 开发约束补充 |
| `README.md` / `README.en.md` | +33 | 顶部二次开发声明（本次新增） |
| `analytics/dashboard/public/src/pages/traffic.js` | +1 | 统计页接入 |

## 三、许可证与署名（未做任何修改的部分）

以下文件**保持上游原样**：

- `LICENSE` — 仍为 GNU AGPL-3.0 全文
- `NOTICE` — 保留原作者 mark / yibiaoai 的署名与联系方式，按 AGPL-3.0 第 7(b) 条要求随分发保留

本次新增的声明文件：

- 本文件 `MODIFICATIONS.md`
- `README.md` / `README.en.md` 顶部的二次开发声明块

## 四、来源可追溯性

本仓库通过 GitHub Fork 关系派生自上游，完整保留了上游从初始到 `7591849` 的全部提交历史，随后接续本分支的 9 个功能提交。每一处改动都可通过 git 历史追溯来源，符合 AGPL-3.0 对源码完整性的要求。

本仓库与原作者 mark / yibiaoai 无隶属关系，不代表官方立场。README 中出现的官网、赞助商、爱发电、Star History 等内容均为上游原有信息，相关权益归原作者所有。
