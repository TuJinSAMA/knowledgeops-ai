# Hameo KnowledgeOps AI — MVP 分阶段实施计划

> 本文档是 MVP 阶段的**单一执行计划真相（single source of truth for execution）**。
> 它面向「多个 Agent、多轮 task」协作：每个 Agent 在动手前应先读本文件，确认自己负责的
> task、它的依赖、契约和验收标准，完成后回写状态。
>
> 产品愿景、定位、架构决策见 [`AGENTS.md`](../AGENTS.md)；本地启动与目录见 [`README.md`](../README.md)。
> 本文件只回答一个问题：**“为了交付 MVP，按什么顺序、做哪些事、做到什么程度算完成。”**

---

## 0. 当前骨架现状（已完成，勿重复造）

下列内容已在 `c5ad4d2` / `25dc0f0` 两个 commit 中落地，新 task 应在其之上扩展，不要重写：

- **Monorepo**：pnpm workspace（`apps/web`）+ uv（`services/ai`）；本地脚本 `db:setup` / `ai:dev` / `ai:worker`；可选 `docker-compose.yml`（Postgres+pgvector、Redis）。
- **DB schema**（`apps/web/src/db/schema.ts`，Drizzle 拥有 migrations）：
  - auth：`user` / `session` / `account` / `verification`（better-auth 默认形态）。
  - 业务：`workspaces`、`workspace_members`（含 `workspace_role` enum）、`knowledge_bases`、`documents`（含 `document_status` enum）、`document_chunks`（`vector(1536)` + HNSW cosine 索引）。
  - 队列：`ingestion_jobs`（含 `job_status` enum、`attempts` / `max_attempts` / `scheduled_at` / `locked_at`，poll 索引）。
- **Auth**：better-auth email+password，Redis `secondaryStorage` 缓存 session。
- **Redis**：`apps/web/src/lib/redis.ts` 单例；`middleware.ts` 固定窗口 rate limiting；`lib/quota.ts` 原子计数。Python 侧 `services/ai/app/cache.py`。两侧都按 AGENTS.md 要求做了 **Redis 不可达时降级放行**。
- **AI service**：FastAPI 骨架（`app/main.py`）、`/health`（校验 DB + pgvector）、`config.py`（`POSTGRES_*` 为真相、派生 `DATABASE_URL`、`sqlalchemy_url`）、`db.py`、`cache.py`。
- **Worker**：`app/worker/runner.py` 已实现 `SELECT … FOR UPDATE SKIP LOCKED` 领取、重试/失败标记、优雅停机。**但 `app/rag/ingestion.py` 仍是 `NotImplementedError` 桩**——这是 Phase 3 的起点。

> ✅ 队列契约已定：Next.js 向 `ingestion_jobs` 插行入队，Python worker 消费。后续所有后台任务沿用此模式。

---

## 1. MVP 完成定义（Definition of Done）

MVP 必须形成一个**窄但完整的闭环**。当下列端到端链路全部跑通，MVP 视为完成：

> 用户注册 → 创建/进入 workspace → 创建 knowledge base → 上传 Markdown/text/PDF →
> 后台 ingestion（chunk + embed）→ 在 chat 中提问 → 得到**带引用**的回答 →
> 每次回答生成一条可查的 **trace**（检索到的 chunks、最终 context、token、成本、延迟）→
> 用户对回答给出**反馈** → 运营人员创建 **evaluation dataset** → 跑一次 **batch evaluation run** →
> 在 **dashboard** 上看到基础质量与用量指标。

非目标（MVP 不做，见 AGENTS.md「未来商业化功能」/「非目标」）：第三方 connectors、embeddable widget、billing、SSO、LangGraph workflow、A/B testing、prompt/config versioning UI。

---

## 2. 协作约定（每个 Agent 必读）

### 2.1 Task 生命周期
1. 认领前：读本文件的「跨层契约」(§3) + 你所在 Phase 的所有 task 卡片 + 其**依赖** task 是否已 `DONE`。
2. 动手：只在 task 卡片声明的 scope/文件范围内改动；新增 DB 表/列必须走 Drizzle migration（见 §3.2）。
3. 完成：满足卡片「验收标准」全部条目，跑通 §2.4 质量门禁。
4. 回写：把卡片状态从 `TODO` 改为 `DONE`，并在卡片末尾「交付记录」追加一行（commit/PR + 简述 + 任何偏离计划的决策）。若做了影响其他 task 的契约变更，**同步更新 §3 契约表**。

状态标记：`TODO`（未开始）/ `WIP`（进行中，注明 Agent）/ `BLOCKED`（注明被谁阻塞）/ `DONE`。

### 2.2 边界纪律（最重要）
- **RAG 核心单一实现**：所有 retrieval / answer / evaluation 执行逻辑**只在 `services/ai` 实现一次**。实时 chat 与批量 evaluation 都复用它。Next.js **不得**重写检索逻辑。
- **schema 单一归属**：DB schema 只能由 `apps/web`（Drizzle）改并生成 migration。Python 侧只读写约定好的表，**不执行 migration**。
- **职责边界**：auth / multi-tenant / RBAC / CRUD / quota / audit / trace 存储 / chat 流式出口在 Web 层；chunk / embed / retrieve / rerank / answer / evaluate 在 Python 层。

### 2.3 命名规范
严格遵循 AGENTS.md「Engineering Naming Rules」：目录 kebab-case、DB 表 snake_case 复数、列 snake_case、enum 值大写 snake_case、API 路由 kebab-case、组件 PascalCase、函数/变量 camelCase。优先领域名（`evaluationRun` 而非 `job`，`retrievedChunk` 而非 `item`）。

### 2.4 质量门禁（每个 task 完成前自检）
- Web：`pnpm --filter @knowledgeops/web lint` 通过；`pnpm build:web` 不报类型错误；新增/改动的 migration 已 `pnpm db:generate` 且能 `pnpm db:migrate` 成功。
- AI：`uv run ruff check .` 通过；新增逻辑配 `pytest` 用例（见 §2.5）。
- 不破坏既有健康检查：`curl :3000/api/health`、`curl :8000/health` 仍 200。

### 2.5 测试策略（MVP 务实档）
- Python AI：核心纯函数（chunking、citation 解析、metric 计算）写单元测试；retrieval/answer 用一个最小 fixture 知识库做 1~2 个集成测试。
- Web：业务 API 的鉴权/租户隔离写关键路径测试（同 workspace 可见、跨 workspace 拒绝）。
- 不追求覆盖率数字，优先覆盖「租户隔离」「失败可恢复」「引用正确」这三类高风险逻辑。

---

## 3. 跨层契约（Contracts）

> 改动这里任意一条都属于「破坏性变更」，必须在对应 task 的交付记录里标注，并通知下游 task。

### 3.1 Web ↔ AI service HTTP 契约
- 传输：Next.js 通过内部 HTTP 调用 FastAPI（实时 chat、单条检索）。基址用环境变量 `AI_SERVICE_URL`（默认 `http://localhost:8000`）。
- 鉴权：MVP 用共享密钥头 `X-Internal-Token`（环境变量 `INTERNAL_API_TOKEN`，两侧一致）。AI service 校验该头，缺失/不符返回 401。
- 约定的 AI service 端点（随 Phase 落地，签名以对应 task 卡片为准）：
  - `POST /v1/retrieve`（Phase 4）：入参 `{ workspace_id, knowledge_base_id, query, top_k, config }`；出参检索结果（chunks + scores）。
  - `POST /v1/answer`（Phase 4，支持 SSE 流式）：入参 `{ workspace_id, knowledge_base_id, query, config, conversation_id? }`；出参流式 token + 末尾 citations + trace 摘要。
  - `POST /v1/evaluate`（Phase 7，可由 worker 内部直接调用核心函数，不一定走 HTTP）。
- 所有入参都必须带 `workspace_id`，AI service 据此做数据隔离查询（只查该 workspace 下的 chunks）。

### 3.2 DB schema 归属与新增表路线图
新增表全部由 `apps/web/src/db/schema.ts` 定义 + `pnpm db:generate`。下表为**规划中**的表，具体列以对应 Phase task 卡片为准：

| 表 | 引入 Phase | 用途 |
| --- | --- | --- |
| `ingestion_jobs`（已存在，将复用/泛化为通用 job） | 3 | ingestion + 后续 evaluation 任务队列 |
| `conversations` / `messages`（已落地 T4.3） | 4 | chat 会话与消息。`conversations`：`id, workspace_id(FK cascade), knowledge_base_id(FK cascade), user_id(FK cascade), title?, created_at, updated_at`（索引 workspace/kb）。`messages`：`id, conversation_id(FK cascade), role(message_role enum: USER/ASSISTANT), content, citations(jsonb，ASSISTANT 存富化引用：source_number/chunk_id/document_id/document_title/chunk_index/score/snippet), created_at` |
| `rag_traces`（已落地 T5.1） | 5 | 每次回答的可观测记录。实际列：`id, workspace_id(FK cascade), conversation_id(FK cascade), message_id(FK cascade, 可空), query, rewritten_query(可空), retrieval_config(jsonb), retrieved_chunks(jsonb: chunkId/documentId/chunkIndex/score/snippet), final_context(text), model, response(text), token_usage(jsonb), cost_estimate(numeric(12,6)), latency_ms(int), stage_latency_ms(jsonb), error, created_at`（索引 workspace/conversation/message）。Web 在 answer `done` 后落库（AI 回传摘要） |
| `answer_feedback`（已落地 T6.1） | 6 | helpful / not helpful / wrong answer / missing knowledge + review 状态。实际列：`id, workspace_id(FK workspaces cascade), message_id(FK messages cascade), trace_id(FK rag_traces set null, 可空), user_id(FK user cascade), rating(feedback_rating: HELPFUL/NOT_HELPFUL), report_type(feedback_report_type: WRONG_ANSWER/MISSING_KNOWLEDGE/OTHER, 可空), comment(可空), review_status(feedback_review_status: NEW/PENDING_REVIEW/RESOLVED, 默认 NEW), failure_reason(可空), created_at, updated_at`。唯一约束 `(workspace_id, message_id, user_id)`（一用户对一回答最多一条反馈，重复提交 upsert）；索引 workspace/message/review_status |
| `evaluation_datasets` / `evaluation_cases`（已落地 T7.1） | 7 | 评估数据集与 case。`evaluation_datasets`：`id, workspace_id(FK workspaces cascade), knowledge_base_id(FK knowledge_bases set null, 可空), name, description?, created_at, updated_at`（索引 workspace）。`evaluation_cases`：`id, dataset_id(FK evaluation_datasets cascade), question, expected_answer?, expected_source_documents(jsonb string[]), expected_chunks(jsonb string[]), required_facts(jsonb string[]), tags(jsonb string[]), created_at`（索引 dataset） |
| `evaluation_runs` / `evaluation_results`（已落地 T7.1） | 7 | 批量评估运行与逐 case 结果。`evaluation_runs`：`id, workspace_id(FK workspaces cascade), dataset_id(FK evaluation_datasets cascade), config(jsonb: chunk_size/top_k/embedding_model/reranker/prompt_version 等), status(evaluation_run_status enum: PENDING/RUNNING/COMPLETED/FAILED, 默认 PENDING), summary_metrics(jsonb), started_at?, finished_at?, created_at`（索引 workspace/dataset）。`evaluation_results`：`id, run_id(FK evaluation_runs cascade), case_id(FK evaluation_cases cascade), retrieval_hit(numeric(6,4)), citation_accuracy(numeric(6,4)), correctness(numeric(6,4)), groundedness(numeric(6,4)), latency_ms(int), cost_estimate(numeric(12,6)), raw(jsonb: 检索/回答快照), created_at`（索引 run/case）。指标列均可空（worker 计算前为 null）。**`RUN_EVALUATION` 入队契约**：Web 在 `evaluation_runs(status=PENDING)` 落行后，于同一事务插入 `ingestion_jobs(job_type='RUN_EVALUATION', payload={ evaluation_run_id: <evaluation_runs.id> }, document_id=NULL)`；T7.3 worker 按 `payload.evaluation_run_id` 加载 run → 读 `dataset_id`/`config`/`workspace_id` → 复用单一 RAG 核心评估每个 case → 写 `evaluation_results` 并回填 `evaluation_runs.summary_metrics`/`status`/`started_at`/`finished_at` |
| `audit_logs`（已落地 T8.2） | 8 | 关键操作审计。实际列：`id, workspace_id(FK workspaces cascade), actor_id(FK user set null，可空，审计需 outlive actor), action(text，稳定 dotted id 如 `knowledge-base.create`), target_type?(text), target_id?(text), metadata(jsonb)?, created_at`。索引 workspace、(workspace, created_at)。统一经 `lib/audit.ts` 的 `recordAudit` 写入；只读列表页 `/[workspaceSlug]/audit`（ADMIN+，可按 action 筛选） |
| `usage_records`（未做，见 T8.3） | 8 | 用量/成本看板的持久数据。**MVP 不落地**：实时用量走 Redis 计数（`getQuotaStatus`），累计 token/成本由 dashboard 聚合 `rag_traces` 得到，二者已满足看板需求，无需额外快照表与写入进程；规模化或需历史趋势时再引入 |

> 队列复用决策：MVP 不再为 evaluation 新建队列表，而是把 `ingestion_jobs` 泛化为通用 job（加 `job_type` 列，值如 `INGEST_DOCUMENT` / `RUN_EVALUATION`），worker 按 `job_type` 分发。该泛化在 **T3.1** 完成。

### 3.3 Embedding / 检索约定
- Embedding 维度固定 `1536`。Web schema 常量 `EMBEDDING_DIMENSIONS` 与 Python `settings.embedding_dimensions` 必须一致；任何修改两侧同步。
- **Embedding 模型**：`qwen/qwen3-embedding-8b`，经 **OpenRouter**（`https://openrouter.ai/api/v1`，OpenAI 兼容，用 `openai` SDK 配 `base_url`，key 走 `services/ai/.env` 的 `OPENROUTER_API_KEY`）调用。该模型原生维度 4096 且支持 MRL，项目按官方做法**截断到前 1536 维 + L2 归一化**，以匹配固定的 `vector(1536)` schema 与现有 HNSW cosine 索引（**不改 schema/索引**）。
- 相似度：cosine（`vector_cosine_ops`，已建 HNSW 索引）。
- **LLM 模型（answer 生成）**：`deepseek-chat`，经 **DeepSeek**（`https://api.deepseek.com`，OpenAI 兼容）调用，key 为 `DEEPSEEK_API_KEY`。
- Provider 抽象在 Python 侧，**embeddings 与 LLM 独立切换**：
  - Embeddings 开关沿用 `AI_PROVIDER`（`fake` 默认，离线确定性 `FakeEmbeddings`；接真实时为 `openrouter`）。
  - LLM 开关 `LLM_PROVIDER`（`fake` 默认 / `deepseek`）。
  - **离线/无 key 场景**：`FakeEmbeddings`/`FakeLLM`（确定性、本地）保证 ingestion/检索/评估在无网络时也能端到端测试。

### 3.4 配置约定
- 每个服务各自持有 `.env`；`POSTGRES_*` 为单一真相，`DATABASE_URL` 派生，可显式覆盖。
- 新增环境变量必须同时更新对应 `.env.example` 与（Web 侧）`src/env.ts` 校验。

---

## 4. 阶段总览（执行顺序与并行性）

```
Phase 1  租户与权限地基 ─┐
Phase 2  知识库与文档上传 ─┼─→ Phase 3  Ingestion 管线 ─→ Phase 4  RAG 检索与带引用回答
                          │                                      │
                          │                                      ├─→ Phase 5  Trace 与 Debug
                          │                                      ├─→ Phase 6  反馈闭环
                          │                                      └─→ Phase 7  Evaluation
                                                                          │
                                                                  Phase 8  Dashboard + 企业化收尾
```

- 关键主链路（必须顺序）：**1 → 2 → 3 → 4**。
- Phase 5 / 6 依赖 4；Phase 7 依赖 4（强烈建议 5 先行，evaluation 复用 trace 字段）。
- 可并行：Phase 1 与 Phase 2 的部分 schema/UI 可并行；Phase 5 与 6 可并行；Phase 8 贯穿但收尾。

每个 Phase 给出「目标 / 出口标准」与若干 **task 卡片**（`Tx.y`）。卡片是 Agent 的最小认领单位。

---

## Phase 1 — 租户与权限地基（Workspace & RBAC）

**目标**：在已有 auth 之上补齐「注册后能进入一个 workspace 并基于角色操作」的完整地基。
**出口标准**：新用户注册后自动拥有一个 workspace（OWNER）；能切换 workspace；所有业务 API 都经过「登录 + workspace 成员 + 角色」校验；跨 workspace 数据不可见。

### T1.1 — Auth 页面与会话接入 `DONE`
- **目标**：提供 sign-up / sign-in / sign-out 的可用 UI 与服务端 session 读取工具。
- **依赖**：无（auth 后端已就绪）。
- **范围**：`apps/web/src/app/(auth)/...`、`apps/web/src/lib/auth-client.ts`（已存在，按需补全）、一个 `getServerSession()`/`requireUser()` 帮助函数。
- **验收**：未登录访问受保护页面被重定向到登录；登录后可拿到 `user.id`；登出清除 session。
- **交付记录**：新增 `src/app/(auth)/{layout,sign-in/page,sign-up/page}.tsx` + 客户端表单 `components/auth/AuthForm.tsx`、`components/auth/SignOutButton.tsx`；新增 `src/lib/session.ts`（`getServerSession()` / `requireUser(callbackPath?)`，未登录重定向到 `/sign-in?callbackUrl=...`）；`auth-client.ts` 补注释。受保护页面（`/[workspaceSlug]`、`/workspaces/new`）经 `requireUser` 守卫。（未提交，留待 review。）

### T1.2 — Workspace schema 收尾与 onboarding `DONE`
- **目标**：注册后自动创建默认 workspace 并把用户设为 `OWNER`；提供创建/重命名 workspace。
- **依赖**：T1.1。
- **范围**：复用 `workspaces` / `workspace_members`；可加 better-auth `databaseHooks` 或 server action 在首次登录时建 workspace；onboarding 页。slug 唯一生成。
- **验收**：新用户登录后存在一条 `workspace_members(role=OWNER)`；重复登录不重复建；slug 冲突自动加后缀。
- **交付记录**：新增 `src/lib/workspace.ts`（`createWorkspaceForUser` 事务建 workspace+OWNER membership、`ensureWorkspaceForUser` 幂等、`slugify`/`resolveUniqueSlug` 唯一 slug 带数字后缀、保留 slug 黑名单）。注册时通过 better-auth `databaseHooks.user.create.after` 自动建默认 workspace；登录落地 `/`（server component）再调 `ensureWorkspaceForUser` 作幂等兜底（覆盖 hook 未触发/历史用户）。创建/重命名经 server actions（`src/lib/workspace-actions.ts`）+ `/workspaces/new` 页与 `/[workspaceSlug]/settings` 页。未改 schema（无 migration）。**偏离/决策**：双重保险（hook + login ensure）；并发重复登录建重复 workspace 的窗口极小（server 端单次导航），MVP 接受，未加分布式锁。

### T1.3 — Workspace 上下文与切换 `DONE`
- **目标**：建立「当前 workspace」上下文（URL 段 `/[workspaceSlug]/...` 或 cookie），供所有页面/ API 使用。
- **依赖**：T1.2。
- **范围**：路由结构 `apps/web/src/app/[workspaceSlug]/...`；workspace switcher 组件；解析并校验当前用户是该 workspace 成员。
- **验收**：访问非自己所属 workspace 的 slug 返回 403/404；切换后数据范围随之变化。
- **交付记录**：采用 URL 段方案 `src/app/[workspaceSlug]/{layout,page,settings/page}.tsx`。`layout.tsx` 经 `requireUser` + `getUserWorkspaceBySlug`（按成员关系解析），非成员/未知 slug 一律 `notFound()`（404，避免泄露 workspace 是否存在；spec 允许 403/404）。`components/workspace/WorkspaceSwitcher.tsx`（client，下拉切换 + 新建入口）；header 含 switcher、角色、设置、登出。保留 slug `workspaces` 等避免与静态路由冲突。**决策**：统一用 404 而非 403 以减少跨租户信息泄露。

### T1.4 — RBAC 与租户隔离帮助层 `DONE`
- **目标**：统一的服务端 guard：`requireWorkspaceMember(workspaceId, minRole)`，返回 `{ user, membership, role }` 或抛 403。
- **依赖**：T1.3。
- **范围**：`apps/web/src/lib/authz.ts`（新建）；定义角色层级 `OWNER > ADMIN > MEMBER` 与各操作所需最小角色。
- **验收**：所有后续业务 API 通过该 guard；单测覆盖「成员可访问 / 非成员拒绝 / 角色不足拒绝」。
- **交付记录**：新增 `src/lib/authz.ts`：`requireWorkspaceMember(workspaceId, minRole='MEMBER')` 与 slug 版 `requireWorkspaceMemberBySlug`，返回 `{ user, membership, role }`；`AuthzError`（401 未登录 / 403 非成员或角色不足）；纯函数 `hasMinRole` 与 `ROLE_RANK`（OWNER>ADMIN>MEMBER）。单测 `src/lib/authz.test.ts`（vitest，7 例：角色层级、未登录 401、非成员 403、成员放行、角色不足 403、高角色满足低要求）。Phase 2+ 业务 API 应统一走此 guard。

### T1.5 — Quota 接入 workspace `DONE`
- **目标**：把已有 `lib/quota.ts` 的 Redis 计数与 workspace 维度限额对接（每个 workspace 每日/每月 token 上限，来自配置默认值）。
- **依赖**：T1.4。
- **范围**：在 chat/answer 入口前做 quota 检查（与 Phase 4 对接，先留 `assertWithinQuota(workspaceId)` 接口）；超限返回 429。
- **验收**：模拟超限时被拒；Redis 不可达时按 §3 降级放行并告警。
- **交付记录**：扩展 `src/lib/quota.ts`：`assertWithinQuota(workspaceId)` 同时校验日/月上限（来自配置 `QUOTA_DAILY_TOKENS` / `QUOTA_MONTHLY_TOKENS`，0 表示禁用），超限抛 `QuotaExceededError`（status 429）；Redis 不可达（`getUsage` 返回 null）时降级放行并 `console.warn`，符合 §3。新增 `getQuotaStatus`（供 Phase 8 UI）。接口已就绪，待 Phase 4 chat 入口调用（chat 入口此阶段尚不存在）。**额外**：新增 `apps/web/.env.example`（覆盖 `src/env.ts` 全部变量）并在 `src/env.ts` 同步新增 `appUrl`/`internalApiToken`/`rateLimitApi`/`rateLimitAuth`/`quotaDailyTokens`/`quotaMonthlyTokens` 校验。

---

## Phase 2 — 知识库与文档上传（Knowledge Base & Upload）

**目标**：在 workspace 下做知识库 CRUD，并支持 Markdown / text / PDF 上传与原文件存储，落地 `documents` 行并入队 ingestion。
**出口标准**：用户能创建知识库、上传上述三类文件、看到文档列表与状态（`PENDING/PROCESSING/INGESTED/FAILED`），且上传后自动生成一条 `ingestion_jobs`。

### T2.1 — 文件存储抽象 `DONE`
- **目标**：定义文件存储接口，MVP 用本地磁盘实现（私有化友好），预留 S3 兼容实现位。
- **依赖**：无（可与 Phase 1 并行）。
- **范围**：`apps/web/src/lib/storage.ts`：`put(workspaceId, documentId, bytes)` / `get()` / 路径约定；本地根目录走环境变量 `FILE_STORAGE_DIR`。Python 侧 ingestion 需能按同样约定读到文件（共享路径或经由 AI service 拉取）。**决策点**：MVP 选「共享本地目录」，写入 `documents.source_metadata.storage_path`。
- **验收**：能写入并按 `storage_path` 读回；路径含 workspace 隔离前缀。
- **交付记录**：新建 `src/lib/storage.ts`：`FileStorage` 接口（`put`/`get`/`delete`）+ `LocalFileStorage` 本地磁盘实现（私有化友好），`getFileStorage()` 单例工厂，预留 S3 兼容实现位（同接口可替换）。路径约定 `buildStoragePath(workspaceId, documentId)` = `workspaces/<workspaceId>/documents/<documentId>`，**含 workspace 隔离前缀**；存储的是**相对路径**写入 `documents.source_metadata.storage_path`，Python ingestion 侧 `FILE_STORAGE_DIR` + 相对路径定位文件（与 `services/ai` 既有约定一致，已核对 `app/rag/ingestion.py`）。`encodeSegment` 拒绝含 `/`/`\`/`..`/空 的 segment，`resolveWithinRoot` 防 path-traversal 逃逸根目录（与 worker 侧防护对称）。根目录走新增环境变量 `FILE_STORAGE_DIR`（默认 `./data/uploads`，与 AI service `file_storage_dir` 默认一致）。`src/env.ts` 新增 `fileStorageDir` 校验、`apps/web/.env.example` 补默认值。单测 `src/lib/storage.test.ts`（隔离前缀、traversal segment 拒绝）。**决策/注意**：web 与 worker 用相对默认 `./data/uploads` 时按各自 CWD 解析到不同目录；跨进程共享需在两侧配置**同一绝对路径**（已在 `.env.example` 注释说明）。

### T2.2 — Knowledge base CRUD `DONE`
- **目标**：知识库的增删改查 API + 列表/详情页。
- **依赖**：T1.4。
- **范围**：API `/[workspaceSlug]/api/knowledge-bases`（route handlers 或 server actions）；复用 `knowledge_bases` 表；所有查询带 `workspace_id` 过滤并经 RBAC guard（创建/删除需 ADMIN+）。
- **验收**：CRUD 全通；跨 workspace 不可见；删除级联文档（schema 已 `onDelete cascade`）。
- **交付记录**：新建数据访问层 `src/lib/knowledge-base.ts`（`listKnowledgeBases`/`getKnowledgeBase`/`createKnowledgeBase`/`deleteKnowledgeBase`/`listDocuments`，**所有读写均带 `workspace_id` 过滤**，含 document/chunk 计数聚合）。CRUD 走 **server actions**（与既有 workspace-actions 模式一致）：`src/lib/knowledge-base-actions.ts` 的 `createKnowledgeBaseAction`/`deleteKnowledgeBaseAction`，**经 `requireWorkspaceMemberBySlug(slug, 'ADMIN')` guard**（创建/删除需 ADMIN+），读取页面经 `getUserWorkspaceBySlug`（MEMBER+）。页面挂在 `/[workspaceSlug]/knowledge-bases`（列表+创建表单，ADMIN 可见）与 `/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]`（详情+删除 danger zone，ADMIN 可见）。组件 `components/knowledge-base/{CreateKnowledgeBaseForm,DeleteKnowledgeBaseButton}.tsx`。workspace dashboard 的 Knowledge bases 卡片改为入口链接。删除经 schema `onDelete cascade` 级联 documents/chunks。单测 `src/lib/knowledge-base-actions.test.ts`（7 例）：同 workspace ADMIN 成员可创建/删除（scoped 到 guard 解析的 workspaceId）、角色不足（< ADMIN）拒绝且不写、非成员（跨 workspace）拒绝且不写、name 校验、KB 不存在返回错误。

### T2.3 — 文档上传与解析入口 `DONE`
- **目标**：上传 Markdown/text/PDF，校验 MIME 与大小，存原文件，建 `documents` 行（`status=PENDING`），入队 ingestion job。
- **依赖**：T2.1、T2.2、T3.1（job 泛化；可先按 `INGEST_DOCUMENT` 约定入队，待 T3.1 落地后对齐）。
- **范围**：上传 API（multipart）；MIME 白名单（`text/markdown`、`text/plain`、`application/pdf`）；大小上限走配置；插入 `documents` + `ingestion_jobs(job_type=INGEST_DOCUMENT, payload={document_id})`。
- **验收**：三类文件均能上传成功并生成 job；非法类型/超限被拒；上传后文档列表显示 `PENDING`。
- **交付记录**：multipart 上传 route handler `POST /[workspaceSlug]/api/knowledge-bases/[knowledgeBaseId]/documents`（同文件含 `GET` 供轮询列表），经 `requireWorkspaceMemberBySlug(slug, 'ADMIN')` + `getKnowledgeBase(workspaceId, kbId)` 双重租户/KB 归属校验。共享上传逻辑 `src/lib/document-upload.ts`：`resolveMimeType`（白名单 `text/markdown`/`text/plain`/`application/pdf`，浏览器 type 为空/`application/octet-stream` 时回退按扩展名 `.md/.markdown/.txt/.pdf` 推断）；大小上限走新增配置 `MAX_UPLOAD_BYTES`（默认 20 MiB，读前/读后双检）；空文件拒绝。流程：先生成 UUID → 经 T2.1 storage `put` 存原文件 → 事务内插入 `documents`(`status=PENDING`、`source_metadata={storage_path, original_filename, byte_size}`) + `ingestion_jobs(job_type='INGEST_DOCUMENT', payload={document_id})`；DB 插入失败回滚并清理已落盘文件（避免孤儿文件）。非法类型→400、超限→413、缺 file 字段→400、跨租户/KB→404。单测 `src/lib/document-upload.test.ts`（MIME 白名单/参数剥离/扩展名回退/拒绝非法）。

### T2.4 — 文档列表与状态 UI `DONE`
- **目标**：知识库详情页展示文档列表、状态、chunk 数、错误信息（失败时）。
- **依赖**：T2.3。
- **范围**：详情页组件；轮询或 revalidate 状态；失败文档显示 `documents`/job 的 `last_error`。
- **验收**：状态随 ingestion 推进而更新；失败时可见原因。
- **交付记录**：client 组件 `components/knowledge-base/DocumentsPanel.tsx`（上传入口 + 文档列表合一，复用同一刷新）。展示每个文档的标题、MIME、状态徽章（`PENDING/PROCESSING/INGESTED/FAILED` 配色）、`INGESTED` 时显示 chunk 数；`FAILED` 时展示 `last_error`（来源：`listDocuments` 取该文档**最新 `INGEST_DOCUMENT` job 的 `last_error`**，因 `documents` 表无 last_error 列，由 job 队列承载）。**轮询**：当存在 `PENDING`/`PROCESSING` 文档时每 3s 调 `GET .../documents` 刷新，全部终态后自动停；含手动 Refresh 按钮。详情页 server component 预取首屏列表并把日期序列化为字符串交给 client 组件。

---

## Phase 3 — Ingestion 管线（Python，单一实现）

**目标**：把 `ingestion.py` 桩替换为真实管线：加载 → 切分 → embed → 写 `document_chunks` → 更新 `documents.status`。复用同一份代码供 worker 调用。
**出口标准**：上传文档后，worker 自动处理，`document_chunks` 出现带 embedding 的行，`documents.status=INGESTED`；失败可重试且 `last_error` 可见。

### T3.1 — Job 泛化为通用任务队列 `DONE`
- **目标**：给 `ingestion_jobs` 加 `job_type`（enum：`INGEST_DOCUMENT` / `RUN_EVALUATION`），worker 按类型分发。
- **依赖**：无（schema 改动，Web 侧）。
- **范围**：Drizzle schema + migration；worker `runner.py` 改为读 `job_type` 并 dispatch 到对应 handler；保留既有领取/重试逻辑。`document_id` 可空（评估任务不绑定文档），改用 `payload` 承载类型相关参数。
- **验收**：旧 ingestion 路径仍工作；新增 `job_type` 后 worker 能正确分发；migration 可前向应用。
- **备注**：可考虑表更名为更中性的 `jobs`，但更名成本与 cascade 需评估；MVP 可保留表名仅加列，命名偏差在交付记录注明。
- **交付记录**：
  - **Web schema**（`apps/web/src/db/schema.ts`）：新增 `jobType` enum `job_type`（值 `INGEST_DOCUMENT` / `RUN_EVALUATION`）；`ingestion_jobs` 加 `job_type` 列（`NOT NULL DEFAULT 'INGEST_DOCUMENT'`，既有行前向迁移）；`document_id` 改为可空（评估任务不绑定文档，参数走 `payload`）。
  - **Migration**：`pnpm db:generate` 生成 `drizzle/0001_romantic_omega_flight.sql`（`CREATE TYPE job_type` + `ALTER ... DROP NOT NULL` + `ADD COLUMN job_type`），`pnpm db:migrate` 应用成功。纯加列/放松约束，前向兼容，旧 ingestion 行/路径不受影响。
  - **Worker 分发**：新增 `services/ai/app/worker/dispatch.py`（handler 注册表 `JOB_HANDLERS` + `dispatch_job(session, job)`：`INGEST_DOCUMENT`→现有 `process_ingestion_job`；`RUN_EVALUATION`→占位 handler，抛 `NotImplementedError` 并标 TODO(Phase 7/T7.3)；未知类型抛 `UnknownJobTypeError`）。`runner.py` 领取 SQL `RETURNING` 增加 `job_type`，改调 `dispatch_job`，日志带 job 类型；既有领取/重试/失败标记/优雅停机逻辑全部保留。
  - **测试**：新增 `tests/test_dispatch.py`（4 例，无需 DB：INGEST 路由、缺失 job_type 回退、RUN_EVALUATION 抛 NotImplementedError、未知类型抛错）。`uv run pytest` 共 29 例通过（既有 25 + 新增 4），ingestion 集成测试不受影响。
  - **质量门禁**：`pnpm --filter @knowledgeops/web lint` ✅；`pnpm build:web` ✅；`pnpm db:generate` + `pnpm db:migrate` ✅；`uv run ruff check .` ✅；`uv run pytest` 29 passed ✅。
  - **命名/契约偏差**：按备注，**MVP 保留表名 `ingestion_jobs` 仅加列**，不更名为中性的 `jobs`（更名会 cascade 到既有 migration、worker SQL、集成测试与入队代码，成本高、收益小）。`job_type` 通过列泛化语义；表名遗留，待规模化或后续重构再评估更名。下游入队方（T2.3）按约定写 `job_type=INGEST_DOCUMENT, payload={document_id}`。

### T3.2 — Document loaders（md/text/pdf）`DONE`
- **目标**：按 MIME 读取文件并抽取纯文本。
- **依赖**：T2.1（存储约定）、T3.1。
- **范围**：`services/ai/app/rag/loaders.py`；PDF 用合适库（如 `pypdf`，加入 pyproject）；保留页码/位置等可放入 chunk metadata。
- **验收**：三类文件都能抽取文本；空文件/损坏文件抛可分类错误（供 job 标记失败）。
- **交付记录**：新建 `services/ai/app/rag/loaders.py`，支持 `text/markdown`/`text/plain`/`application/pdf`（PDF 用 `pypdf`，已加入 pyproject）。定义可分类错误层级 `DocumentLoadError`（带稳定 `reason` 码）+ 子类 `DocumentNotFoundError`/`UnsupportedMimeTypeError`/`EmptyDocumentError`/`CorruptDocumentError`，供 job 标记失败。PDF 抽取保留页码字符偏移（`PageSpan`）于 `LoadedDocument.pages`。**偏离/限制**：`document_chunks` 当前无 per-chunk metadata 列，故页码信息暂不持久化，仅保留在内存对象供后续（schema 扩展后）使用。单测见 `tests/test_loaders.py`（含手工构造的最小合法 PDF）。

### T3.3 — Chunking 策略 `DONE`
- **目标**：可配置的切分（chunk size / overlap），输出 chunk 文本 + 顺序 index + token 估算。
- **依赖**：T3.2。
- **范围**：`services/ai/app/rag/chunking.py`；默认参数走配置，便于 Phase 7 评估不同 chunk size。
- **验收**：切分确定可复现；token 估算合理；纯函数单测覆盖边界（超短/超长文本）。
- **交付记录**：新建 `services/ai/app/rag/chunking.py`，纯函数 `chunk_text(text, chunk_size, chunk_overlap)` 输出 `TextChunk(content, index, token_count)`。**自研轻量递归字符切分器**（按 `\n\n`/`\n`/`. `/空格/硬切 递归），不引入 langchain-text-splitters，保持核心由项目掌控。默认 `chunk_size=1000` / `chunk_overlap=200`（字符，走 config，Phase 7 可调）。token 估算用 ~4 字符/token 启发式（`estimate_tokens`，避免 tiktoken 重依赖）。确定可复现、纯函数。单测见 `tests/test_chunking.py`（覆盖空/超短/超长/重叠/确定性）。**偏离**：chunk size 单位选「字符」而非「token」，并以启发式估 token，便于离线确定性与免重依赖。

### T3.4 — Embeddings provider 抽象 + Fake `DONE`
- **目标**：embedding 接口，真实 provider（OpenAI）+ 确定性 `FakeEmbeddings`（`AI_PROVIDER=fake`）。
- **依赖**：无（可与 T3.2/3.3 并行）。
- **范围**：`services/ai/app/rag/embeddings.py`；批量 embed；维度断言 == 1536。litellm 或官方 SDK。
- **验收**：fake 模式下离线可跑且确定；真实模式下维度正确；批量调用有重试/退避。
- **交付记录**：新建 `services/ai/app/rag/embeddings.py`。抽象基类 `EmbeddingProvider.embed_texts()` + 工厂 `get_embedding_provider(settings)`，按 `settings.ai_provider` 选择。`FakeEmbeddings`：以 `sha256(text)` 播种 `random.Random` 生成单位归一化向量，**离线、跨机确定**（cosine 友好）。`OpenAIEmbeddings`：用 openai 官方 SDK（已加入 pyproject），按 `embedding_batch_size` 批量，指数退避重试（默认 4 次）。两者均断言维度 == `settings.embedding_dimensions(1536)`。config 新增 `ai_provider`(默认 `fake`)/`embedding_model`(默认 `text-embedding-3-small`)/`embedding_batch_size`，同步 `.env.example`。单测见 `tests/test_embeddings.py`。**偏离**：选 openai 官方 SDK 而非 litellm（更轻、MVP 仅需 embedding）。

### T3.5 — Ingestion 管线串联与持久化 `DONE`
- **目标**：实现 `process_ingestion_job`：load → chunk → embed → 批量写 `document_chunks` → 置 `documents.status=INGESTED`；幂等（重跑先清旧 chunks）。
- **依赖**：T3.2、T3.3、T3.4。
- **范围**：替换 `app/rag/ingestion.py` 桩；写 chunks 用 pgvector 绑定；状态机：`PENDING→PROCESSING→INGESTED|FAILED`（与 job 状态联动）。
- **验收**：端到端：上传 → worker 处理 → chunks 落库（带 embedding）→ 状态 INGESTED；失败重试不产生重复 chunks；至少 1 个集成测试（fake provider）。
- **交付记录**：实现 `process_ingestion_job(session, job)`。从 `payload.document_id`（回退到 `document_id` 列）取文档 → 按 `documents.source_metadata.storage_path` + `FILE_STORAGE_DIR`（config 新增，默认 `./data/uploads`，含 path-traversal 防护）定位文件 → load → chunk → embed → 删旧 chunks 后批量插入 `document_chunks` → 置 `INGESTED`。状态机：先单独提交 `PROCESSING`，成功提交 `INGESTED`，失败 `rollback` 后置 `FAILED` 并重抛（worker 据其重试/失败策略）。**幂等**：持久化前不写任何 chunk，写入时先 `DELETE ... WHERE document_id` 再插入，重跑不产生重复。pgvector 写入用 `CAST(:embedding AS vector)` 文本字面量绑定（稳定、免适配器注册）。集成测试 `tests/test_ingestion_integration.py`（fake provider，离线）：构造 workspace→kb→document+本地文件+job，跑管线，断言 chunks 落库（`vector_dims==1536`）、`status=INGESTED`、重跑 chunk 数不变；另含失败标记用例。**前提**：集成测试需本地 Postgres+pgvector 且已 `pnpm db:migrate`，否则自动 skip（本次运行 DB 可达，已全部通过）。

---

## Phase 4 — RAG 检索与带引用回答（核心价值）

**目标**：在 Python AI service 实现唯一的 retrieve + answer，Web 侧提供 chat UI 与流式出口，回答必须带引用、证据、低置信时拒答。
**出口标准**：在某知识库下提问，得到带 citation 的流式回答；引用能点回到对应 document/chunk；无相关知识时明确拒答。

### T4.1 — Retrieval 核心 `DONE`
- **目标**：`POST /v1/retrieve`：对 query embed → pgvector cosine top-k（按 `workspace_id` + `knowledge_base_id` 过滤）→ 返回 chunks + scores。
- **依赖**：Phase 3、§3.1 内部鉴权。
- **范围**：`services/ai/app/rag/retrieval.py` + `app/api/`路由；config 含 `top_k`、可选 score 阈值。
- **验收**：只返回目标 workspace/kb 的 chunks；top-k 与分数正确；跨租户查询为空。
- **交付记录**：新建 `services/ai/app/rag/retrieval.py`：纯 `retrieve(session, *, workspace_id, knowledge_base_id, query, top_k, score_threshold, settings)` 返回 `list[RetrievedChunk]`（chunk_id/document_id/chunk_index/content/token_count/score）。复用现有 `embeddings` 模块 embed query（不重写）。**租户/kb 隔离在 SQL 强制**：`document_chunks JOIN documents JOIN knowledge_bases`，`WHERE kb.workspace_id=:ws AND kb.id=:kb`，跨 workspace/跨 kb 必为空。相似度用 pgvector cosine 距离算子 `<=>`，`score = 1 - distance`（降序），`ORDER BY ... LIMIT top_k`；可选 `score_threshold` 过滤。embedding 以文本字面量 `CAST(:e AS vector)` 绑定（与 ingestion 一致）。config 新增 `retrieval_top_k`（默认 5）。新建 `POST /v1/retrieve`（`app/api/v1/retrieve.py` + `schemas.py`），入参遵循 §3.1 `{workspace_id, knowledge_base_id, query, top_k, config}`，`config.score_threshold` 可选；统一经 `X-Internal-Token` 鉴权（见下）。集成测试 `tests/test_retrieval.py`（fake embeddings，离线）：跨 workspace/跨 kb 返回空、exact-match 分数≈1.0 且降序、top-k 限制、阈值过滤。**单一实现**：实时 answer 与未来 evaluation 均复用此函数。

### T4.2 — Answer 生成（带引用、可拒答）`DONE`
- **目标**：`POST /v1/answer`（SSE 流式）：retrieve → 组装 context（带来源标记）→ LLM 生成 → 解析/附带 citations → 低相关时拒答。
- **依赖**：T4.1、T3.4（LLM provider，含 FakeLLM）。
- **范围**：`services/ai/app/rag/answer.py`；prompt 模板要求模型按来源编号引用；返回结构含 `answer`、`citations[]`（指向 chunk/document）、`usage`（token）、检索快照（供 Phase 5 trace）。
- **验收**：回答含可核对的 citations；context 不足时返回明确拒答而非编造；fake 模式可端到端测。
- **交付记录**：新建 `services/ai/app/rag/answer.py`（**单一 RAG answer 实现**，供实时 chat 与未来 evaluation 复用）：`generate_answer(...)` 非流式返回 `AnswerResult`（answer/citations/usage/refused/model + trace 快照：retrieved_chunks+scores、final_context、model、各阶段 latency、token_usage，供 Phase 5）；`stream_answer_events(...)` 产出 `(token|done|error)` 事件供 SSE。流程：retrieve → 过滤 `score >= answer_min_score`（config 新增，默认 0.2）→ 有证据则组装**编号来源** context（`[1] (document ...) ...`）+ system/user prompt（要求按编号引用、证据不足须拒答）→ LLM → `parse_citations` 用正则 `\[(\d+)\]` 解析、映射回 chunk_id/document_id（越界/重复忽略）；**无证据/全部低于阈值/跨租户为空 → 返回确定性拒答 `REFUSAL_MESSAGE`，不调用 LLM、不编造**。新建 `app/rag/llm.py`：**独立于 embeddings 的 LLM provider 开关 `LLM_PROVIDER`（`fake`|`deepseek`，默认 `fake`）**；`FakeLLM` 确定性离线（引用 `[1]`、估算 token usage）；`DeepSeekLLM` 走 OpenAI 兼容 API（复用已装 `openai` SDK + `base_url=https://api.deepseek.com`，含 timeout + 指数退避重试，流式用 `stream_options.include_usage` 取真实 usage）。新建 `POST /v1/answer`（`app/api/v1/answer.py`，`StreamingResponse` + `text/event-stream`，DB session 跨整个流保持打开），经 `X-Internal-Token` 鉴权。config 新增 `llm_provider`/`answer_min_score`/`deepseek_*`/`llm_temperature|max_tokens|timeout_seconds|max_retries`，同步 `.env.example`（DeepSeek 项为占位/注释，无真实 key）。测试：`tests/test_answer_unit.py`（FakeLLM 确定性+引用、stream 拼接==complete、citation 解析越界/空、context 编号）+ `tests/test_answer_integration.py`（有证据→可核对 citations + trace 快照；无证据→明确拒答；跨租户空→拒答；SSE token→done 拼接一致）。

### 内部鉴权（T4.1/T4.2 共用，落地 §3.1）
- 新建 `app/api/internal_auth.py`：`require_internal_token` 依赖校验 `X-Internal-Token` 头 == `settings.internal_api_token`（环境变量 `INTERNAL_API_TOKEN`），缺失/不符返回 401；token 未配置时跳过（仅供本地/离线测试）。`/v1/retrieve`、`/v1/answer` 均挂该依赖。config 新增 `internal_api_token`，同步 `.env.example`。测试 `tests/test_internal_auth.py`：缺/错 token → 401（鉴权先于 handler，故无需 DB）。

### T4.3 — Web chat API 与流式出口 `DONE`
- **目标**：Next.js chat 路由代理到 AI service 的 SSE，做鉴权/租户/quota 检查，并落 `conversations`/`messages`。
- **依赖**：T4.2、T1.5（quota）、§3.2（conversations/messages schema）。
- **范围**：schema：`conversations`(workspace/kb/user)、`messages`(role/content/citations jsonb)；Web API `/[workspaceSlug]/api/chat`；调用前 `requireWorkspaceMember` + `assertWithinQuota`，调用后 `incrementUsage`。
- **验收**：流式 token 透传到前端；会话与消息持久化；quota/权限拦截生效。
- **交付记录**：
  - **Schema**（`apps/web/src/db/schema.ts`）：新增 `message_role` enum（`USER`/`ASSISTANT`）+ `conversations`、`messages` 两表（列见 §3.2，FK 均 `onDelete cascade`，workspace/kb/conversation 索引）。Migration `drizzle/0002_clean_wildside.sql`，`pnpm db:generate` + `pnpm db:migrate` 成功（前向应用）。
  - **数据访问层** `src/lib/conversation.ts`：`createConversation`/`getConversation`（按 workspace 隔离）/`addMessage`（同时 bump 会话 `updated_at`）/`listMessages`/`getDocumentTitles`（经 `knowledge_bases` join 强制租户隔离）。
  - **Chat 核心** `src/lib/chat.ts` 的 `handleChat(workspaceSlug, body)`：`requireWorkspaceMemberBySlug(MEMBER+)` → 校验 query → `assertWithinQuota`（超限 429，且**在建会话前**，避免遗留空会话）→ 新建/复用 `conversations`（复用时以会话自身 kb 为准）→ 落 USER `messages` → 用 `X-Internal-Token` + `env.aiServiceUrl` 调 AI `POST /v1/answer` → **SSE 透传**：`token`/`error` 事件逐块原样转发，**拦截末尾 `done`** 做引用富化（join 文档标题 + retrieved_chunks 的 snippet/score）→ 落 ASSISTANT `messages`（含富化 citations）→ 按 `usage.total_tokens` `incrementUsage`（daily+monthly）→ 向前端发富化后的 `done`。失败映射：401/403（AuthzError）、400（缺 query / 非法 JSON）、404（KB/会话不属本 workspace）、429（quota）、502（AI 不可达/非 200）。响应头含 `X-Conversation-Id`。
  - **Route** `src/app/[workspaceSlug]/api/chat/route.ts`：thin POST，解析 JSON 后委派 `handleChat`，返回 `text/event-stream` 流。
  - **测试** `src/lib/chat.test.ts`（9 例，AI service 用 mock fetch、不联网）：未登录 401、非成员 403、KB 跨租户 404、空 query 400、quota 超限 429（不建会话/不调 AI）、happy path（token 透传 + done 富化 + USER/ASSISTANT 持久化顺序 + usage daily/monthly + 内部 token 头）、AI 非 200→502、复用会话沿用其 kb、复用跨租户会话 404。
  - **偏离/决策**：`done` 事件**非纯透传**而是富化（join 文档标题 + chunk snippet/score）后再下发，以支撑引用展开 UI；`token`/`error` 严格透传保证流式体验。未新增环境变量（复用既有 `AI_SERVICE_URL`/`INTERNAL_API_TOKEN`），仅在 `.env.example` 强化「两侧 token 必须一致」注释。会话历史列表 UI 暂不做（超出 MVP 窄闭环），持久化已就位待 Phase 5/6 复用。

### T4.4 — Chat UI `DONE`
- **目标**：可用的对话界面：提问、流式显示、引用展示（可展开来源）、拒答提示、反馈入口占位（Phase 6 接）。
- **依赖**：T4.3。
- **范围**：`apps/web/src/app/[workspaceSlug]/.../chat` 页面与组件；选择 knowledge base；展示 citations。
- **验收**：端到端对话流畅；引用可点开看到原文 chunk；移动端基本可用。
- **交付记录**：页面 `src/app/[workspaceSlug]/chat/page.tsx`（server component，`requireUser` + `getUserWorkspaceBySlug`，无 KB 时引导去 knowledge-bases）。client 组件 `src/components/chat/ChatPanel.tsx`：knowledge base 下拉选择（开始对话后锁定，提供「New conversation」重置）、用户/助手气泡、**`fetch` + ReadableStream 读 SSE 流式拼接 token**、末尾 `done` 渲染引用（`<details>` 展开：`[n]` 文档标题、score、snippet）、`refused` 显示「Low confidence · refused to guess」徽章、**反馈入口占位**（Helpful/Not helpful 禁用按钮，title 标注 Phase 6）。移动端响应式（max-w、flex、85% 气泡宽度、Enter 发送 / Shift+Enter 换行）。workspace dashboard 的 Assistant 卡片改为指向 `/[slug]/chat` 的链接。

---

## Phase 5 — Trace 与 Debug 面板（可观测性）

**目标**：每次回答落一条结构化 trace，运营/工程能定位失败发生在哪一层。
**出口标准**：每个 answer 有 trace 记录，debug 面板能看到 query、检索 chunks 与分数、最终 context、token、成本估算、延迟、错误。

### T5.1 — Trace schema 与写入 `DONE`
- **目标**：定义 `rag_traces` 并在 answer 链路写入。
- **依赖**：T4.2/T4.3。
- **范围**：schema 字段建议：`id, workspace_id, conversation_id, message_id, query, rewritten_query?, retrieval_config(jsonb), retrieved_chunks(jsonb: chunk_id/score/snippet), final_context(text), model, response, token_usage(jsonb), cost_estimate, latency_ms, error, created_at`。由 Web 在 answer 完成后写（AI service 在响应里回传 trace 摘要，Web 落库，保持 schema 单一归属）。
- **验收**：每次回答一条 trace；字段完整；跨租户隔离。
- **交付记录**：
  - **Schema**（`apps/web/src/db/schema.ts`）：新增 `rag_traces` 表，列与计划一致：`id, workspace_id(FK workspaces cascade), conversation_id(FK conversations cascade), message_id(FK messages cascade, 可空), query, rewritten_query(可空,MVP 未产出), retrieval_config(jsonb), retrieved_chunks(jsonb: chunkId/documentId/chunkIndex/score/snippet), final_context(text), model, response(text), token_usage(jsonb), cost_estimate(numeric(12,6)), latency_ms(int), stage_latency_ms(jsonb, 额外:AI 各阶段耗时), error, created_at`。索引 workspace/conversation/message。Migration `drizzle/0003_modern_vulcan.sql`，`pnpm db:generate` + `pnpm db:migrate` 成功（前向应用）。`message_id` 可空：失败回合可能没有 assistant message 仍要落 trace。
  - **数据访问层** `src/lib/trace.ts`：`createTrace`（numeric 以字符串写入,`toFixed(6)`）/`getTrace(workspaceId, id)`（**SQL 强制 workspace 隔离**,跨租户返回 null）/`listTraces(workspaceId)`（按 `created_at` 降序,debug 索引用）。
  - **写入挂载点** `src/lib/chat.ts` 的 `buildProxyStream`：拦截 AI SSE 末尾 `done` 后,除既有「富化引用 + 落 assistant message + incrementUsage」外,**落一条 `rag_traces`**（messageId=assistant message id、retrievedChunks/finalContext/model/usage/stageLatencyMs 来自 AI trace 摘要、latencyMs 为 Web 端到端测得、costEstimate 经 price map 估算）；并在 `done` 客户端载荷里回传 `traceId` 供 UI 深链。**error/中断分支**：捕获 AI `error` 事件或流中断时,落一条 `error` trace（无 assistant message,trace 失败不影响响应）。保持「AI 回传摘要、Web 落库」契约。
  - **测试** `src/lib/chat.test.ts`（新增 2 例 + 富化原 happy path）：每次成功回答恰好写一条 trace（workspaceId/conversationId/messageId/model/usage/cost/latency/retrievedChunks/finalContext/stageLatencyMs 断言）；AI 流 error 时仍写 trace（带 error、无 message,仅 USER 持久化）。AI 调用全程 mock fetch、不联网。

### T5.2 — 成本与延迟计算 `DONE`
- **目标**：按 provider/model 的单价表估算成本；记录端到端与各阶段延迟。
- **依赖**：T5.1。
- **范围**：Python 侧返回 token usage + 阶段耗时；Web 侧或 Python 侧维护 price map（放配置）。
- **验收**：成本/延迟数值合理且出现在 trace。
- **交付记录**：
  - **Price map**（`apps/web/src/lib/pricing.ts`，Web 侧配置）：`PRICE_MAP` 按 model 维护 `inputPer1M`/`outputPer1M`（USD/1M tokens）。覆盖 `deepseek-chat`（input $0.27、output $1.10，来源 DeepSeek 官方定价，注释标注出处）与 `fake-llm`（0）。纯函数 `estimateCost(model, usage)`：未知 model / 缺 usage → 返回 `null`（**不臆造成本**）；缺字段按 0 计；负/NaN 防护。
  - **成本接入 trace**：`chat.ts` 用 `estimateCost(model, usage)` 估 `cost_estimate` 写入 trace（fake 模式 model=`fake-llm` → 0）。
  - **延迟**：端到端 `latency_ms` 由 Web 在调用 AI 前后用 `Date.now()` 测得；**各阶段耗时**（retrieve / generate）直接取 AI service `done` 摘要里已有的 `stage_latency_ms`（无需改 Python）写入 `stage_latency_ms` 列。
  - **测试** `src/lib/pricing.test.ts`（6 例，纯函数）：deepseek 单价计算（线性、小额）、fake=0、未知 model=null、缺 model/usage=null、缺字段按 0。
  - **决策**：price map 选「Web 侧代码常量」而非 env（计划允许「放配置」，无需新增环境变量；`src/env.ts`/`.env.example` 未改）。未动 `services/ai`，因其 `done` 摘要已含 `stage_latency_ms` 与 `final_context`。

### T5.3 — Debug 面板 UI `DONE`
- **目标**：针对单条回答的 debug 视图：检索命中、分数、最终 context、token/cost/latency、错误。
- **依赖**：T5.1、T5.2。
- **范围**：`/[workspaceSlug]/.../traces/[id]` 或 chat 内联展开；面向工程/运营，信息清晰。
- **验收**：能从一条回答跳到其 trace 并看全链路信息。
- **交付记录**：
  - **详情页** `src/app/[workspaceSlug]/traces/[id]/page.tsx`（server component，`requireUser` + `getUserWorkspaceBySlug` + `getTrace(workspace.id, id)`，**租户隔离**，找不到/跨租户 `notFound()`）：展示问题、model / latency / total tokens / est. cost 统计卡、prompt/completion tokens 与各阶段耗时、**检索命中列表**（编号 + documentId + chunkIndex + score + snippet）、**最终 context**（`<pre>` 可滚动）、model response、error（高亮）。
  - **列表页** `src/app/[workspaceSlug]/traces/page.tsx`：workspace 内最近 trace 表（query/model/latency/cost/时间 + error 徽章），行链到详情。
  - **从回答跳转**：`chat.ts` 在客户端 `done` 载荷加 `traceId`；`ChatPanel` 接收并在助手气泡底部渲染「View trace」深链（新增 `traceBasePath` prop，chat 页传 `/[slug]/traces`）。workspace header 增「Traces」导航入口。
  - 面向工程/运营，信息分区清晰；移动端响应式（grid/卡片）。

---

## Phase 6 — 反馈闭环（Feedback Loop）

**目标**：把用户反馈变成运营数据（不只点赞），支持失败分类与 review 状态。
**出口标准**：用户能对回答标记 helpful/not helpful、报告 wrong answer / missing knowledge；运营能看到反馈列表与 review 状态。

### T6.1 — Feedback schema 与提交 API `DONE`
- **目标**：`answer_feedback` 表 + 提交接口。
- **依赖**：T4.3（message 存在）、T5.1（可关联 trace）。
- **范围**：字段建议：`id, workspace_id, message_id, trace_id?, user_id, rating(HELPFUL/NOT_HELPFUL), report_type(WRONG_ANSWER/MISSING_KNOWLEDGE/OTHER)?, comment?, review_status(NEW/PENDING_REVIEW/RESOLVED), failure_reason?, created_at`。enum 值大写 snake_case。
- **验收**：提交成功并租户隔离；同一 message 可更新反馈。
- **交付记录**：
  - **Schema**（`apps/web/src/db/schema.ts`）：新增 3 个 enum（`feedback_rating` HELPFUL/NOT_HELPFUL、`feedback_report_type` WRONG_ANSWER/MISSING_KNOWLEDGE/OTHER、`feedback_review_status` NEW/PENDING_REVIEW/RESOLVED）+ `answer_feedback` 表（列见 §3.2）。FK：workspace/message/user 均 cascade，`trace_id` 为 `ON DELETE set null`（trace 删除不连带删反馈）。**唯一约束** `answer_feedback_workspace_message_user_idx`(`workspace_id, message_id, user_id`)，外加 workspace/message/review_status 索引。Migration `drizzle/0004_noisy_random.sql`，`pnpm db:generate` + `pnpm db:migrate` 成功（前向应用）。
  - **数据访问层** `src/lib/feedback.ts`：`getMessageFeedbackContext(workspaceId, messageId)`（join messages→conversations 强制租户隔离，并 left join `rag_traces` 服务端解析 trace_id，不信任客户端传入）；`upsertFeedback`（**onConflictDoUpdate on (workspace_id, message_id, user_id)**，更新时**不触碰** review_status/failure_reason 这两个运营字段）；`listFeedback(workspaceId, {knowledgeBaseId?, reviewStatus?})`（join 链到 knowledge_bases 做租户隔离 + 筛选）；`getFeedback`/`getFeedbackReviewCounts`/`updateFeedbackReview`（均按 workspace_id scoped）。
  - **提交/审核入口** `src/lib/feedback-actions.ts`（server actions）：`submitFeedbackAction`（MEMBER+，校验 rating/report_type/comment 长度→guard→**二次租户校验** message 属本 workspace→upsert）；`updateFeedbackReviewAction`（ADMIN+，更新 review_status/failure_reason）。
  - **chat 链路**：`src/lib/chat.ts` 的 `done` 客户端载荷新增 `messageId`（持久化的 assistant message id，供前端附加反馈）。
  - **测试** `src/lib/feedback-actions.test.ts`（9 例，mock authz + 数据层、不联网）：成员可提交（scoped 到 guard 解析的 workspaceId/userId、trace 服务端解析）、同 message 重复提交走 upsert、跨 workspace 非成员 403 不写、message 属他 workspace 时拒绝（`getMessageFeedbackContext` 返回 null）、rating 校验先于 guard；review 操作需 ADMIN+（角色不足/非法 status/不存在均拒绝）。chat.test.ts 增 1 断言（done 带 `messageId`）。
  - **决策**：提交入口选 **server action** 而非 route handler（ChatPanel 直接 import 调用，省一个 API 路由，与 knowledge-base-actions 模式一致）；trace_id **服务端解析**而非信任客户端。

### T6.2 — Chat 内反馈入口 `DONE`
- **目标**：在 T4.4 的占位处接入实际反馈控件。
- **依赖**：T6.1。
- **范围**：回答下方 helpful/not helpful + 详细报告弹窗。
- **验收**：交互顺畅，提交后状态可见。
- **交付记录**：新增 client 组件 `src/components/chat/FeedbackControls.tsx`：回答下方 Helpful / Not helpful 按钮（高亮当前选择、可改），「Report issue」展开详细报告（report type 下拉 WRONG_ANSWER/MISSING_KNOWLEDGE/OTHER + 可选 comment）→ `useTransition` 调 `submitFeedbackAction`，提交后显示「Thanks for the feedback」，错误内联展示。`ChatPanel.tsx`：**移除 Phase 6 禁用占位按钮**，`ChatMessage` 与 `done` 载荷新增 `messageId`，仅当存在持久化 `messageId` 且非 streaming、无 error 时渲染反馈控件（refused 答案也已持久化故可反馈；error 回合无 assistant message 故不显示）；`MessageBubble`/`ChatPanel` 新增 `workspaceSlug` prop，chat 页 `chat/page.tsx` 透传。「View trace」深链保留。

### T6.3 — 运营反馈列表与 review `DONE`
- **目标**：运营页：按知识库/状态筛选反馈，更新 review_status / failure_reason。
- **依赖**：T6.1。
- **范围**：`/[workspaceSlug]/.../feedback` 列表 + 详情；可从反馈跳到对应 trace（Phase 5）。
- **验收**：能完成「答得不好 → 看 trace 定位 → 标记失败原因」的闭环。
- **交付记录**：
  - **列表页** `src/app/[workspaceSlug]/feedback/page.tsx`（server component，MEMBER+ via `getUserWorkspaceBySlug`，租户隔离）：顶部按 review_status 统计徽章；GET 表单按**知识库 / review_status 筛选**（searchParams `kb`/`status`，非法 status 忽略）；表格列 question(会话标题)/知识库/rating/report/status/时间，行链到详情。
  - **详情页** `src/app/[workspaceSlug]/feedback/[id]/page.tsx`（`getFeedback` 租户隔离，找不到/跨租户 `notFound()`）：展示 rating/report/status/知识库、问题、回答、用户 comment、**「View answer trace →」深链**（复用 Phase 5 trace 详情页，trace_id 存在时）；运营 review 区——ADMIN+ 渲染 `components/feedback/FeedbackReviewForm.tsx`（client，`useActionState` 调 `updateFeedbackReviewAction` 更新 review_status + failure_reason 分类），非 ADMIN 只读展示 failure_reason。
  - **导航**：`[workspaceSlug]/layout.tsx` header 在 Traces 旁新增 **Feedback** 入口。
  - **闭环**：列表筛 NOT_HELPFUL/NEW → 进详情 → View answer trace 看检索/context 定位失败层 → 回详情标 review_status=RESOLVED + failure_reason。

---

## Phase 7 — Evaluation（评估数据集与批量运行）

**目标**：支持手工创建 evaluation dataset 与 batch evaluation run，复用同一 RAG 核心，产出可比较的质量指标。
**出口标准**：能建数据集与 case、对某配置跑一次批量评估、看到逐 case 与汇总指标（retrieval hit rate、citation accuracy、answer correctness/groundedness 的可得近似、latency、cost）。

### T7.1 — Evaluation schema `DONE`
- **目标**：`evaluation_datasets` / `evaluation_cases` / `evaluation_runs` / `evaluation_results`。
- **依赖**：Phase 4。
- **范围**：case 字段：`question, expected_answer?, expected_source_documents(jsonb)?, expected_chunks(jsonb)?, required_facts(jsonb)?, tags(jsonb)?`。run 字段：`config(jsonb: chunk size/top_k/embedding model/reranker/prompt version)、status、汇总指标、started_at/finished_at`。result 字段：逐 case 的 retrieval hit、citation accuracy、correctness、groundedness、latency、cost。
- **验收**：schema 落地、租户隔离、migration 通过。
- **交付记录**：
  - **Schema**（`apps/web/src/db/schema.ts`）：新增 `evaluation_run_status` enum（`PENDING`/`RUNNING`/`COMPLETED`/`FAILED`，区别于 `job_status` 的 PROCESSING）+ 4 表，列与 §3.2 一致：`evaluation_datasets`（workspace cascade、`knowledge_base_id` 用 `set null` 让 KB 删除不连带删数据集）、`evaluation_cases`（jsonb 列以 `string[]` 类型化）、`evaluation_runs`（`config`/`summary_metrics` jsonb、`status` 默认 `PENDING`）、`evaluation_results`（指标列 `numeric` 可空、`raw` jsonb 存检索/回答快照）。全部 workspace 隔离 + 合理级联（删 dataset 级联 cases/runs/results）。
  - **Migration**：`pnpm db:generate` 生成 `drizzle/0005_absent_wind_dancer.sql`（`CREATE TYPE evaluation_run_status` + 4 `CREATE TABLE` + FK/索引），`pnpm db:migrate` 前向应用成功。纯新增表，不影响既有表。
  - **数据访问层** `src/lib/evaluation.ts`：datasets/cases/runs/results 的读写函数，**所有读写均按 `workspace_id` 过滤**或先验证 dataset/run 归属本 workspace（cases/results 经 dataset/run 间接隔离）；含 `createEvaluationRun`（事务内建 run + 入队 `RUN_EVALUATION` job，契约见 §3.2）。
  - **质量门禁**：`pnpm --filter @knowledgeops/web lint` ✅；`pnpm build:web` ✅；`pnpm db:generate` + `pnpm db:migrate` ✅。
  - **决策**：run 状态新建独立 enum（PENDING/RUNNING/COMPLETED/FAILED）而非复用 `job_status`，因 evaluation 语义用 `RUNNING` 比 `PROCESSING` 更贴切；`evaluation_datasets.knowledge_base_id` 用 `set null` 而非 cascade，保留历史数据集。

### T7.2 — 数据集与 case 管理 UI/API `DONE`
- **目标**：建/改数据集，手工录入 case。
- **依赖**：T7.1。
- **范围**：CRUD API + 页面；可从历史问答/反馈一键转为 case（加分项）。
- **验收**：能完整维护一个数据集。
- **交付记录**：
  - **Server actions** `src/lib/evaluation-actions.ts`（与既有 knowledge-base/feedback actions 模式一致）：`createEvaluationDatasetAction`/`deleteEvaluationDatasetAction`/`createEvaluationCaseAction`/`deleteEvaluationCaseAction`/`triggerEvaluationRunAction`，**全部经 `requireWorkspaceMemberBySlug(slug, 'ADMIN')` guard**（创建/删除/触发需 ADMIN+），读取页面经 `getUserWorkspaceBySlug`（MEMBER+）。jsonb 列（expected docs/chunks/facts/tags）由换行/逗号分隔文本解析为 `string[]`。
  - **页面**：`/[workspaceSlug]/evaluations`（数据集列表 + 创建表单，ADMIN 可见）、`/[workspaceSlug]/evaluations/[datasetId]`（数据集详情：case 列表/手工录入/删除 + runs 列表 + 触发 run 表单 + danger zone 删除数据集）。组件 `components/evaluation/{CreateEvaluationDatasetForm,DeleteEvaluationDatasetButton,CreateEvaluationCaseForm,DeleteEvaluationCaseButton,TriggerEvaluationRunForm}.tsx`。workspace header 新增 **Evaluations** 导航入口。
  - **触发 run 入队入口**：`triggerEvaluationRunAction` → `createEvaluationRun`（事务建 `evaluation_runs(status=PENDING)` + 入队 `ingestion_jobs(job_type='RUN_EVALUATION', payload={evaluation_run_id})`），契约见 §3.2，供 T7.3 worker 消费。无 case 时触发按钮禁用。
  - **测试** `src/lib/evaluation-actions.test.ts`（15 例，mock authz + 数据层、不联网）：dataset/case CRUD + run 触发的 ADMIN+ 鉴权、跨 workspace 非成员拒绝且不写、角色不足拒绝、参数校验先于 guard、dataset/case/run 缺失返回错误、config 解析、jsonb 列解析。
  - **加分项（未做）**：「从历史问答/反馈一键转 case」未实现（可选，超出本波最小闭环）。

### T7.3 — Batch evaluation 执行（worker）`DONE`
- **目标**：入队 `RUN_EVALUATION` job，worker 对每个 case 复用 retrieve+answer 核心，计算并写 `evaluation_results`，汇总到 `evaluation_runs`。
- **依赖**：T7.1、T3.1（job 泛化）、Phase 4 核心。
- **范围**：`services/ai/app/evaluation/`：metric 计算（retrieval hit rate = 命中 expected_chunks/docs 比例；citation accuracy；correctness/groundedness 用 fake 模式下确定性近似或 LLM-as-judge 可选）；worker handler。
- **验收**：跑完后每 case 有结果、run 有汇总；fake 模式可端到端；可重跑。
- **交付记录**：
  - **新增包** `services/ai/app/evaluation/`（`__init__.py` / `metrics.py` / `run.py`），**只改 `services/ai`**，不动 schema、不跑 migration。
  - **指标实现**（`metrics.py`，全部确定性纯函数，`None` 表示「该 case 无对应 ground truth、不计入聚合」而非 0）：
    - `retrieval_hit_rate`：把 `expected_chunks` 与 `expected_source_documents` 合并为期望集合，命中数 / 期望总数；无任何期望→`None`。
    - `citation_accuracy`：回答 citations 指向的 document 中命中期望来源的比例（citation precision）；无 `expected_source_documents`→`None`；有期望但无 citation→`0.0`。
    - `correctness_approx`（**确定性近似口径**）：取 case 提供的信号求平均——(a) `required_facts` 覆盖率（每条 fact 是否以大小写不敏感子串出现在回答）；(b) 与 `expected_answer` 的内容词 token 重叠召回（去停用词）。两者都缺→`None`。
    - `groundedness_approx`（**确定性近似口径**）：回答内容词中被 `final_context` 覆盖（出现）的比例，作为 hallucination-risk 代理；无 context（如拒答）或无内容词→`None`。
    - **可选 LLM-as-judge**：config 新增 `evaluation_use_llm_judge`（默认 `False`）。开启且回答非拒答时，用 LLM provider 评 correctness/groundedness 覆盖确定性值；解析/调用失败回退确定性值。**默认关，fake 模式完全离线确定性可端到端**。
    - `estimate_cost`：Python 侧轻量 price map（`deepseek-chat` 与 web `lib/pricing.ts` 同价、`fake-llm`=0），未知 model→`None`（不臆造）；缺 token 计 0。`latency_ms`=回答链路 `stage_latency_ms`（retrieve+generate）求和取整。
    - `summarize_results`：对 4 项指标按「非 None 的 case」求均值聚合（snake_case 键 `retrieval_hit`/`citation_accuracy`/`correctness`/`groundedness`，与 T7.4 `evaluation-format.ts` 的查找口径一致），并产出 `avg_latency_ms`/`total_cost`/`case_count`/`refused_count`。
  - **run handler**（`run.py` 的 `run_evaluation_job(session, job)`）：按 `payload.evaluation_run_id` 加载 run → 置 `RUNNING`+`started_at`（同一提交内清空旧结果，见幂等）→ 读 `dataset_id`/`config`/`workspace_id`，KB 取 `config.knowledge_base_id` 回退 `evaluation_datasets.knowledge_base_id`（都缺则 run 失败）→ 逐 case **复用单一 RAG 核心 `generate_answer`**（按 run `config` 传 top_k 等）→ 算指标 → 写 `evaluation_results` → 聚合写回 `evaluation_runs.summary_metrics` + 置 `COMPLETED`+`finished_at`；异常 `rollback` 后置 `FAILED`+`finished_at` 并重抛（交还 worker 重试/失败策略）。
  - **幂等/可重跑**：`_begin_run` 在置 `RUNNING` 的同一事务里 `DELETE FROM evaluation_results WHERE run_id = :id` 并清空 `summary_metrics`/`finished_at`，因此重跑先清旧结果，不产生重复行（集成测试断言重跑后结果数仍为 case 数）。
  - **dispatch 接线**：`worker/dispatch.py` 的 `RUN_EVALUATION` 占位替换为导入 `run_evaluation_job`，worker 既有领取/重试/失败/停机逻辑不变。
  - **测试**：`tests/test_evaluation_metrics.py`（19 例纯函数单测，覆盖 hit rate / citation accuracy / correctness / groundedness 近似 + cost + summarize 的边界与 None 语义）；`tests/test_evaluation_integration.py`（fake 模式端到端：seed dataset+2 cases(命中+拒答)+run+`RUN_EVALUATION` job → 跑 handler → 断言每 case 有 `evaluation_results`、run 有 `summary_metrics` 且 `status=COMPLETED`、命中 case `retrieval_hit/citation_accuracy=1.0`、拒答 case `refused`、**重跑不产生重复结果**）。`tests/test_dispatch.py` 的 RUN_EVALUATION 用例改为断言路由到 handler。
  - **质量门禁**：`uv run ruff check .` ✅；`uv run pytest` 73 passed ✅（含集成测试对本地 Postgres+pgvector 实跑通过）。
  - **决策/偏离**：correctness/groundedness 采用确定性近似为主、LLM-as-judge 为可选开关（默认关），口径如上；cost price map 放 Python 模块常量（与 web 侧同价），未新增 env（仅 `evaluation_use_llm_judge` 一个布尔配置）。

### T7.4 — Evaluation 结果与配置对比 UI `DONE`
- **目标**：展示单次 run 的逐 case 与汇总；至少支持两次 run（不同配置）并排对比。
- **依赖**：T7.3。
- **范围**：run 详情页 + 对比视图。
- **验收**：能直观比较不同配置（如 top_k、chunk size）的指标差异。
- **交付记录**：
  - **Run 详情页** `/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]`：status 徽章、config 摘要、created/started/finished 时间、汇总指标卡（retrieval hit/citation accuracy/correctness/groundedness）、逐 case 结果表（各指标 + latency + cost）。结构对齐 `evaluation_results`/`evaluation_runs.summary_metrics` 字段。
  - **对比视图** `/[workspaceSlug]/evaluations/[datasetId]/compare?a=<runId>&b=<runId>`：两个下拉选 run（GET 表单）+ 并排指标表，含 config/status 行与每个指标的 **Δ(B−A)** 着色差异（绿升红降）。数据集详情页 runs ≥ 2 时显示「Compare runs →」入口（默认取最近两次 run）。
  - **空/未完成态**：T7.3 worker 尚未产出结果时，run 详情按 status 渲染「无结果/未完成」提示，对比页 run < 2 时提示需更多 run；UI 用空数据也能正确渲染（不依赖 T7.3）。
  - **共享格式化** `src/lib/evaluation-format.ts`（纯函数，无 DB）：`formatScore`（0..1→百分比）/`formatCost`/`formatLatency`/`formatConfig`/`summaryMetric`（兼容 camelCase/snake_case 的汇总键查找），供 run 详情与对比页复用。
  - **租户隔离**：run 经 `getEvaluationRun(workspace.id, ...)` 解析并校验 `datasetId` 匹配，跨租户/跨数据集 `notFound()`。
  - **质量门禁**：`pnpm --filter @knowledgeops/web lint` ✅；`pnpm build:web` ✅（所有 evaluation 路由编译）；`pnpm --filter @knowledgeops/web test` 61 passed（含新增 15 例）✅。

---

## Phase 8 — Dashboard 与企业化收尾

**目标**：基础指标看板 + 补齐审计与用量，使产品具备「运营视角」与基本企业就绪度。
**出口标准**：workspace 级 dashboard 展示用量/成本/反馈/评估概览；关键操作进审计日志；quota 在 UI 可见。

### T8.1 — Metrics dashboard `DONE`
- **目标**：workspace 首页/仪表盘：文档数、chunk 数、问答量、平均延迟、累计 token/成本、反馈分布、最近 evaluation 概览。
- **依赖**：Phase 5/6/7。
- **范围**：聚合查询（trace/feedback/evaluation）；图表用轻量方案；避免 markdown 表式堆砌。
- **验收**：数据准确、随活动更新、租户隔离。
- **交付记录**：
  - **聚合数据层** `src/lib/dashboard.ts`：`getKnowledgeStats`（documents/chunks 计数，经 `knowledge_bases` join 强制 workspace 隔离）、`getTraceStats`（answer 数、平均端到端 latency、累计 `total_tokens`、累计 `cost_estimate`，聚合 `rag_traces` where workspace）、`getMessageCount`（messages→conversations join，问答量）、`getFeedbackDistribution`（`answer_feedback` 按 rating 分组）、`getRecentEvaluationRuns`（最近 5 条 `evaluation_runs`），由 `getDashboardMetrics` 并行组合。**每个查询都按 `workspace_id` 过滤（直接列或经 join），租户隔离**。
  - **UI**：增强 workspace 首页 `src/app/[workspaceSlug]/page.tsx`（server component）为运营仪表盘：顶部 stat 卡（文档/chunk/answer/message/avg latency/total tokens/est. cost）、反馈分布**轻量 CSS 条形**（helpful vs not helpful，绿/红比例 + 百分比）、token usage 卡（复用 `QuotaMeter`）、最近 evaluation runs 列表（status 徽章 + 深链 run 详情），以及到 chat/knowledge-bases/feedback/usage/audit 的入口。**避免 markdown 表式堆砌**，运营人员可读。
  - **测试** `src/lib/dashboard.test.ts`（6 例，mock `@/db` + `drizzle-orm`，不联网）：`getDashboardMetrics` 各聚合映射正确；**每个聚合查询的 `where` 均含本 workspaceId、且不含他 workspace（租户隔离）**；`getTraceStats` 无 trace 时 avg latency 为 null；`getKnowledgeStats` 两个计数均经 workspace join 隔离；`getFeedbackDistribution` 正确分桶。
  - **决策**：图表用内联 SVG/CSS（条形/进度条），不引图表库，保持轻量；问答量以 `rag_traces` answer 数 + messages 数双指标呈现。

### T8.2 — Audit log `DONE`
- **目标**：`audit_logs` 表 + 在关键写操作（建/删 kb、上传、删除文档、改成员/角色、跑评估）记录。
- **依赖**：相关各 Phase。
- **范围**：统一 `recordAudit({workspaceId, actorId, action, target, metadata})`；只读列表页。
- **验收**：关键操作均有记录；可按 workspace 查看。
- **交付记录**：
  - **Schema**（`apps/web/src/db/schema.ts`）：新增 `audit_logs` 表（列见 §3.2，append-only）。`workspace_id` cascade、`actor_id` 用 `set null`（审计行需 outlive 被删用户）。索引 workspace + (workspace, created_at)。Migration `drizzle/0006_cloudy_lady_ursula.sql`，`pnpm db:generate` + `pnpm db:migrate` 前向应用成功（纯新增表，不影响既有表）。**本波唯一 migration**。
  - **统一写入** `src/lib/audit.ts`：`recordAudit({ workspaceId, actorId, action, target, metadata })`（best-effort，**写入失败仅 `console.error` 不抛**，审计是可观测性不是事务不变量）；`AUDIT_ACTIONS` 常量（dotted id：`knowledge-base.create/delete`、`document.upload/delete`、`member.role-update/remove`、`evaluation-run.trigger`）；`listAuditLogs(workspaceId, {action?})`（left join `user` 取 actor 名/邮箱，按 created_at 降序，**workspace 隔离**）；`listAuditActions(workspaceId)`（筛选下拉用 distinct）。
  - **接入挂载点**（现有写操作）：建/删 knowledge base（`knowledge-base-actions.ts`）、上传文档（documents route handler `POST`）、触发 evaluation run（`evaluation-actions.ts`）。**未接入「删除文档」「改成员/角色」**——这两个功能 MVP 尚未实现（无对应 action/route），`AUDIT_ACTIONS` 已预留常量待功能落地后接入。
  - **只读列表页** `/[workspaceSlug]/audit`（server component，**ADMIN+ 可见**，非 ADMIN 渲染提示而不暴露数据）：action 筛选（GET 表单）+ 表格（action/target/actor/when），action 有人类可读标签映射。workspace header 对 ADMIN+ 显示 **Audit** 入口。
  - **测试** `src/lib/audit.test.ts`（7 例，mock `@/db` + `drizzle-orm`，不联网）：`recordAudit` 写入 workspace-scoped 行（actor/action/target/metadata 字段正确、可选字段 null、insert 失败不抛）；`listAuditLogs`/`listAuditActions` 的 `where` 含本 workspaceId 且不含他 workspace（**workspace 隔离**）、action 筛选叠加。另：`knowledge-base-actions.test.ts`/`evaluation-actions.test.ts` 增补 audit mock 与「审计被调用」断言。

### T8.3 — Quota / 用量可视与收尾 `DONE`
- **目标**：把 Redis quota 计数与（可选）持久化 `usage_records` 暴露到 UI；超限提示；degraded mode 行为文档化。
- **依赖**：T1.5、T8.1。
- **范围**：用量页/卡片；快照写入策略。
- **验收**：用量可见、超限有提示、Redis 故障降级符合 §3。
- **交付记录**：
  - **可视组件** `src/components/dashboard/QuotaMeter.tsx`（presentational）：渲染 daily/monthly 用量进度条（绿/琥珀/红按 <80%/≥80%/超限着色），超限显示「Quota exceeded — new answers are blocked」、临近显示「Approaching the limit」，limit≤0 显示 unlimited；**当 daily+monthly 均为 null（Redis 不可达）显式渲染 degraded-mode 提示**（请求放行且不计数，符合 §3）。
  - **用量页** `/[workspaceSlug]/usage`（MEMBER+）：quota windows（复用 `QuotaMeter`，读 `getQuotaStatus`）+ 累计 answers/total tokens/est. cost（读 `getTraceStats` 聚合 `rag_traces`）+ **degraded mode 行为说明区块**（Redis 故障 fail-open 文档化）。dashboard token usage 卡也复用 `QuotaMeter`，并链到本页。workspace header 新增 **Usage** 入口。
  - **`usage_records`：未做**（可选项）。决策见 §3.2：实时用量走 Redis（`getQuotaStatus`），累计 token/成本由 dashboard 聚合 `rag_traces`，已满足看板与超限提示需求，无需额外快照表/写入进程；规模化或需历史趋势时再引入。**未新增环境变量**（`src/env.ts`/`.env.example` 未改，复用既有 `QUOTA_DAILY_TOKENS`/`QUOTA_MONTHLY_TOKENS`）。
  - **测试** `src/lib/quota.test.ts`（7 例，mock `@/env` + `./redis`，不联网）：`getQuotaStatus` 返回 used/limit/remaining、Redis 不可达时返回 null（degraded）、缺计数视为 null window；`getUsage` 解析计数；`assertWithinQuota` 低于上限放行、超限抛 429、Redis 故障 fail-open。

### T8.4 — 文档与可部署性收尾 `DONE`
- **目标**：更新 `README.md` 运行链路、补 `.env.example`、确保 `docker compose up` 全栈可起（web+ai+worker+pg+redis）。
- **依赖**：全部。
- **范围**：compose 补 web/ai/worker service（如适用）；端到端 smoke 步骤文档化。
- **验收**：按 README 从零可拉起并跑通 §1 的闭环。
- **交付记录**：
  - **Docker 全栈** `docker-compose.yml`：在既有 `postgres`/`redis` 上新增 `migrate`（一次性 Drizzle 迁移，`service_completed_successfully` 后才放行 web/worker）、`ai`（FastAPI）、`worker`（复用 ai 镜像、入口 `python -m app.worker.runner`）、`web`（Next.js）。依赖顺序：`postgres`/`redis` healthy → `migrate` 完成 + `ai` healthy → `web`。健康检查：`ai` 用 python urllib 探 `/health`、`web` 用 node http 探 `/api/health`（均要求 200）、`postgres` `pg_isready`、`redis` `redis-cli ping`。用 YAML 锚点（`x-postgres-env`/`x-ai-env`）集中注入跨服务环境变量。
  - **Dockerfile**：`apps/web/Dockerfile`（多阶段，build context = repo 根；`deps` 装 pnpm workspace 依赖 → `builder` 跑 `next build` 出 standalone → `migrate` 目标带 drizzle-kit 跑 `pnpm db:migrate` → `runner` 仅含 `.next/standalone` 跑 `node apps/web/server.js`）；`services/ai/Dockerfile`（context = `services/ai`，`uv sync --frozen --no-dev` 装锁定依赖 → runtime 默认 `uvicorn app.main:app`，worker 在 compose 覆盖 command）。新增 `.dockerignore`（根 + `services/ai`）。
  - **配置对齐**：`FILE_STORAGE_DIR=/data/uploads` 在 web+worker 挂同一具名 volume `uploads`，跨进程共享上传文件；`INTERNAL_API_TOKEN` 用同一 `${INTERNAL_API_TOKEN:-dev-internal-token}` 插值注入 web+ai，天然一致（不一致会 401）；`AI_SERVICE_URL=http://ai:8000`、`REDIS_URL=redis://redis:6379`、`POSTGRES_HOST=postgres` 均指向 compose 服务名。默认 `AI_PROVIDER=fake`/`LLM_PROVIDER=fake`，**无任何外部 key 即可开箱跑通 §1 闭环**；接真实模型经根 `.env` 配 `OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`（compose 与 .env.example 均不含真实 key）。
  - **`.env.example` 完整性**：两侧已覆盖各自 `env.ts`/`config.py` 全部变量（本波核对无缺失），仅补 Docker 注入说明注释。
  - **README**：新增「Docker 全栈一键起（fake 默认、无 key）」「本地非容器开发」两条链路 + §1 的 10 步端到端 smoke walkthrough（注册→建 KB→上传→等 ingestion→带引用回答→看 trace→反馈→建 dataset→触发 run→看 dashboard）。
  - **可部署性最小代码改动**：`apps/web/next.config.ts` 加 `output: "standalone"` + `outputFileTracingRoot`（仅为产出可部署的精简运行镜像，不改业务逻辑）。
  - **质量门禁/验证**：`docker compose config` 无法在本环境执行（**该机器未安装 Docker daemon**），改用 PyYAML 校验 compose 语法 + 锚点/merge 展开通过（6 services、env 合并、depends_on 正确）；`pnpm --filter @knowledgeops/web lint` ✅、`pnpm build:web` ✅（确认 standalone 产物 `apps/web/.next/standalone/apps/web/server.js` 与 Dockerfile COPY 路径一致）、`uv run ruff check .` ✅、`uv run pytest` 73 passed ✅。**实际验证到「compose 语法/变量解析 + 各服务镜像构建所依赖的本地构建（next build / uv 依赖锁）可用」一级；未能执行 `docker compose build`/`up`（无 Docker daemon）**，完整 smoke 步骤已文档化于 README。
  - **阻塞点**：本环境无 Docker，无法实跑 `docker compose build`/`up` 做容器级 smoke——需在装有 Docker 的机器上执行 `docker compose up --build` 验证（fake 模式无需任何外部 key）。

---

## 5. 风险与决策记录（持续更新）

| 主题 | 决策 | 状态 |
| --- | --- | --- |
| 文件存储 | MVP 用共享本地目录 + `storage_path`，预留 S3 接口 | 已落地（T2.1）：`src/lib/storage.ts` `FileStorage` 接口 + `LocalFileStorage`（本地磁盘，根目录 `FILE_STORAGE_DIR` 默认 `./data/uploads`），相对 `storage_path` = `workspaces/<workspaceId>/documents/<documentId>`（含 workspace 隔离前缀 + traversal 防护），写入 `documents.source_metadata.storage_path`，与 `services/ai` ingestion 读取约定一致；S3 兼容实现可同接口替换。**注意**：跨进程共享需 web/worker 配同一绝对路径 |
| 队列 | 复用 `ingestion_jobs` 泛化为通用 job（加 `job_type`），不新建表 | 已落地（T3.1）：加 `job_type` enum（`INGEST_DOCUMENT`/`RUN_EVALUATION`）+ `document_id` 可空，worker 按类型 dispatch；**保留表名 `ingestion_jobs` 不更名**（更名 cascade 成本高） |
| Provider 离线 | 提供 `AI_PROVIDER=fake` 确定性实现，保证无网络可端到端测试 | 已落地（T3.4）：`AI_PROVIDER` 默认 `fake`（sha256 播种、单位归一化）；真实 provider 用 openai 官方 SDK（非 litellm） |
| Embeddings 模型/provider | embeddings 用 `qwen/qwen3-embedding-8b` 经 OpenRouter（OpenAI 兼容，`openai` SDK + `base_url`），原生 4096 维→**截断前 1536 维 + L2 归一化**以保留 `vector(1536)` schema 与 HNSW 索引（不改 schema） | 已落地：`app/rag/embeddings.py` 新增 `OpenRouterEmbeddings`（`openai` SDK + `base_url`、超时+指数退避）+ `truncate_and_normalize`（4096→1536 截断 + L2 归一化），`AI_PROVIDER` 默认仍 `fake`、配 `OPENROUTER_API_KEY` 且 `AI_PROVIDER=openrouter` 才走真实；维度断言 1536，不改 schema |
| Chunking 单位/库 | chunk size 以「字符」计、token 用 ~4 字符启发式；自研轻量递归切分器，不引入 langchain-text-splitters | 已落地（T3.3） |
| Chunk 页码元数据 | loader 抽取 PDF 页码偏移，但 `document_chunks` 无 metadata 列，MVP 暂不持久化 | 已落地（T3.2），待后续 schema 扩展 |
| LLM provider（answer） | embeddings 维持 `FakeEmbeddings`（DeepSeek 无 embedding 接口、schema 固定 1536）；LLM 独立开关 `LLM_PROVIDER`（`fake` 默认 / `deepseek`），DeepSeek 走 OpenAI 兼容 API（复用 `openai` SDK + `base_url`），含超时与退避重试；`fake` 保证离线端到端可测 | 已落地（T4.2） |
| Trace 写入方 | AI service 回传摘要，Web 落库，保持 schema 单一归属 | 已落地（T5.1）：AI service `done` 事件回传 trace 摘要（retrieved_chunks/final_context/model/token_usage/stage_latency_ms），Web `chat.ts` 在 `done`/error 分支落 `rag_traces`；成本经 Web 侧 price map（`lib/pricing.ts`）估算、端到端 latency 由 Web 测得；**未改 Python**（其摘要已含阶段耗时）。schema 仍由 Web/Drizzle 单一归属 |
| correctness/groundedness 指标 | MVP 用确定性近似 + 可选 LLM-as-judge | 已落地（T7.3）：`services/ai/app/evaluation/metrics.py`。**correctness** = `required_facts` 子串覆盖率与 `expected_answer` 内容词 token 重叠召回的平均（信号缺失则该项不计）；**groundedness** = 回答内容词被 `final_context` 覆盖的比例（无 context/拒答→None）。LLM-as-judge 由 `evaluation_use_llm_judge`（默认 `False`）开关，开启时覆盖确定性值、失败回退；fake 模式完全离线确定性可端到端 |
| 全栈部署 | Docker compose 全栈（pg/redis/migrate/ai/worker/web），fake provider 默认开箱即跑，无外部 key | 已落地（T8.4）：web 用 Next.js standalone 镜像（`output: "standalone"`）、ai/worker 共用 uv 镜像（worker 覆盖 command）；迁移走一次性 `migrate` service（web/worker 依赖其 `service_completed_successfully`）；`FILE_STORAGE_DIR=/data/uploads` 经共享 volume、`INTERNAL_API_TOKEN` 同插值注入 web+ai 保持一致、`AI_SERVICE_URL=http://ai:8000`。**注意**：compose 实跑 smoke 需在装 Docker 的机器执行（本开发环境无 Docker daemon，仅校验了 YAML/锚点 + 各镜像所需本地构建） |

> 任何 Agent 在执行中做出偏离本计划的架构/契约决策，必须在此表追加一行，并在对应 task 卡片「交付记录」注明。

---

## 6. 快速索引（task 一览）

- Phase 1：T1.1 auth UI / T1.2 workspace onboarding / T1.3 workspace 上下文 / T1.4 RBAC guard / T1.5 quota 接入
- Phase 2：T2.1 存储抽象 / T2.2 KB CRUD / T2.3 文档上传 / T2.4 文档列表 UI
- Phase 3：T3.1 job 泛化 / T3.2 loaders / T3.3 chunking / T3.4 embeddings+fake / T3.5 管线串联
- Phase 4：T4.1 retrieval / T4.2 answer+引用 / T4.3 chat API+流式 / T4.4 chat UI
- Phase 5：T5.1 trace schema / T5.2 成本延迟 / T5.3 debug 面板
- Phase 6：T6.1 feedback schema / T6.2 反馈入口 / T6.3 运营 review
- Phase 7：T7.1 eval schema / T7.2 数据集管理 / T7.3 批量执行 / T7.4 结果对比
- Phase 8：T8.1 dashboard / T8.2 audit / T8.3 quota 可视 / T8.4 部署收尾
