# Hameo KnowledgeOps AI

## 项目背景

Hameo KnowledgeOps AI 是 Hameo 个人产品矩阵中的一个产品。它不是实验室项目，也不是为了演示而做的玩具 Demo，而是一个以商业化、生产可用、企业部署为目标的 AI 应用产品。

这个产品的核心方向是：面向企业知识库的 AI 质量与运营平台。它帮助企业安全地把内部知识接入 AI 助手，并在上线后持续评估、调试、监控和优化 AI 回答质量。

这个项目来自真实的生产经验：我曾经在上一家公司参与过基于 RAG 的聊天机器人系统。那段经历说明，企业真正困难的地方并不是“让 AI 回答一次”，而是上线之后如何保证它答得准、可追溯、可控、可评估，并且能持续改进。

因此，这个项目不能只做成一个普通聊天机器人。它应该成为一个围绕企业 AI 知识助手的质量工程、运营闭环和生产治理平台。

## 语言使用原则

我是中文母语人士。这个项目的需求表达、产品思考、架构讨论、任务拆解和日常沟通，应该优先使用中文，确保我能够快速理解、判断和复盘。

同时，代码相关的部分应该使用英文，保持工程项目的专业性、可维护性和国际化习惯。

具体规则：

- 产品背景、需求说明、用户故事、设计思路、决策记录：使用中文。
- 日常沟通、问题分析、方案讨论、面试叙事：使用中文。
- 代码注释：默认使用英文，除非解释的是中文业务语境。
- 文件名、目录名、变量名、函数名、类名、数据库表名、字段名：使用英文。
- API path、event name、job name、queue name、enum value、config key：使用英文。
- Git commit message、PR title、PR description：优先使用英文，除非明确需要中文。
- 面向开发者的代码规范和命名约束：使用英文。
- 面向产品和需求的文档：可以使用中文，必要时保留英文术语。

英文术语可以直接保留，例如 `workspace`、`knowledge base`、`RAG trace`、`evaluation run`、`retrieval hit rate`、`reranker`、`embedding`、`tenant`、`quota`、`audit log`。

不要为了翻译而牺牲准确性。中文负责表达清楚问题和意图，英文负责保持代码和工程接口的一致性。

## 产品定位

产品定位：

> 面向企业的 AI 知识质量与运营平台，用于构建、评估和运营可信赖的 RAG 知识助手。

英文定位可以写作：

> An enterprise AI knowledge quality platform for building, evaluating, and operating trustworthy RAG-powered knowledge assistants.

这个项目应按照 B2B SaaS / 可私有化部署产品来设计，而不是按照单用户作品集 Demo 来设计。

它需要回答以下企业问题：

- AI 助手是否能基于公司知识准确回答？
- 用户是否能看到答案来自哪些资料？
- 当 AI 答错时，管理员能否判断问题出在知识缺失、检索失败、排序不佳、Prompt 不合适，还是模型幻觉？
- 团队能否用指标比较不同 RAG 配置的效果？
- 系统是否支持企业需要的 workspace、角色权限、知识库隔离、用量限制、审计日志和运营仪表盘？

## 目标用户

主要目标用户：

- 想部署内部知识助手或客户知识助手的 SaaS 公司。
- 客服、客户成功、IT、HR、法务、产品等拥有大量内部知识的团队。
- 已经做了 RAG 助手，但缺少质量评估、调试能力和运营视角的工程团队。

主要用户角色：

- Workspace owner：管理 workspace 设置、成员、用量和商业化相关配置。
- Admin / operator：上传文档、管理知识库、查看低质量回答、运行评估任务。
- End user：向 AI 助手提问，并反馈回答是否有帮助。
- Developer：通过 API key、widget 或内部系统集成 AI 助手。

## 要解决的问题

这个项目应该聚焦生产环境里的 AI 应用问题：

- AI 回答看起来很流畅，但不一定有企业知识支撑。
- 用户反馈“答错了”，但团队不知道具体是哪一层失败。
- 不同 chunking、embedding、reranking、prompt 策略很难客观比较。
- 企业知识有权限、版本、归属和审计要求。
- AI 调用有成本、延迟、配额、错误重试和稳定性问题。
- 知识库缺口通常只有在用户投诉后才被发现。

不要把聊天界面当成产品的主要价值。聊天只是入口，真正的价值是围绕企业知识助手的质量、调试、评估、反馈和运营闭环。

## 核心产品支柱

### Knowledge Management

支持企业知识的接入、解析、切分、向量化、元数据管理和版本化管理。

核心概念命名使用英文：

- `workspace`
- `knowledgeBase`
- `document`
- `documentChunk`
- `sourceMetadata`
- `accessScope`
- `ingestionJob`

### AI Assistant

提供一个真实可用的企业知识问答体验。

回答需要包含：

- 引用来源
- 检索到的证据
- 置信度或相关性提示
- 当资料不足时明确拒答
- 用户反馈入口

### RAG Observability

每一次 AI 回答都应该可追踪。

需要记录：

- 原始问题
- query rewrite 结果，如果启用
- retrieval configuration
- retrieved chunks
- retrieval scores
- reranked results
- final context sent to the model
- model response
- token usage
- cost estimate
- latency
- errors and retries

这些数据应该支撑一个 debug panel，让工程师和运营人员能定位问题。

### Evaluation

平台应该支持 evaluation dataset 和 batch evaluation run。

一个 evaluation case 可以包含：

- question
- expectedAnswer
- expectedSourceDocuments
- expectedChunks
- requiredFacts
- tags

Evaluation result 应该跟踪：

- retrieval hit rate
- citation accuracy
- answer correctness
- groundedness / hallucination risk
- latency
- cost
- configuration used for the run

系统应该可以比较不同配置，例如 chunk size、top-k、embedding model、reranker、prompt version。

### Feedback Loop

用户反馈应该成为运营数据，而不是简单存一条点赞记录。

需要支持：

- helpful / not helpful
- wrong answer report
- missing knowledge report
- admin review status
- failure reason classification
- suggested improvement actions

产品要帮助团队完成从“AI 答得不好”到“我们知道哪里失败，以及下一步如何改进”的闭环。

### Enterprise Readiness

这个项目要按照真实企业产品来设计。

优先考虑：

- multi-tenant workspaces
- role-based access control
- knowledge base permissions
- API keys
- usage quotas
- audit logs
- rate limits
- background jobs for ingestion and evaluation
- error handling and retryability
- deployment-friendly configuration

## MVP 范围

第一版商业化 MVP 应该先做窄，但要形成完整闭环。

必须包含：

- workspace and authentication foundation
- knowledge base creation
- Markdown、text、PDF document upload
- background ingestion with chunking and embeddings
- RAG assistant with citations
- run trace recording
- debug view for retrieved chunks and model context
- user feedback on answers
- manual evaluation dataset creation
- batch evaluation run
- basic metrics dashboard

不要在核心质量闭环稳定前过早做大量第三方集成。

## 未来商业化功能

后续可以扩展：

- embeddable chat widget
- public API for external apps
- Slack、Notion、Confluence、Google Drive、Zendesk、GitHub、Linear connectors
- team-level permissions synced from identity providers
- private deployment mode
- billing and subscription plans
- automated knowledge gap reports
- LangGraph-based evaluation and review workflows
- human-in-the-loop approval for risky AI suggestions
- prompt and retrieval configuration versioning
- A/B testing for RAG configurations

## 技术方向

优先采用务实、可交付、招聘市场认可的架构。选型同时要服务两个硬约束：**可私有化部署**和**多租户隔离**。任何与这两个约束冲突的技术，即使开发体验更好，也不优先采用。

### 整体架构：TS Web 层 + Python AI 层

采用混合架构。Web/业务层用 TypeScript（Next.js），AI/RAG 核心用 Python，两层通过 Postgres 和内部接口解耦：

```
Next.js (TS)：UI + 业务 API（auth / multi-tenant / RBAC / CRUD / quota / audit）+ trace 存储 + chat 流式出口
     │  实时：内部 HTTP 调 ─────────────────┐
     │  离线：写 job 表 ──────────┐          │
     ▼                           ▼          ▼
Postgres + pgvector ◀──── Python worker   Python AI service (FastAPI)
（单一数据真相 + job 队列）      └── 二者复用同一份 RAG / evaluation 核心代码 ──┘
```

职责边界：

- **Next.js（TS）**：前端 UI、业务 API、认证、多租户与权限、配额、审计日志、trace 数据存储、实时 chat 的流式出口。不实现 RAG 检索逻辑。
- **Python AI service（FastAPI）**：承载**唯一**的 RAG / retrieval / answer 实现与 evaluation 执行逻辑。职责收窄到 AI，不碰 CRUD / auth / 业务编排。既被 Next.js 实时调用（chat），也被 worker 复用（批量任务）。
- **Python worker**：独立进程，跑 ingestion 与 batch evaluation 等长任务，复用 AI service 的核心代码。
- **Postgres + pgvector**：单一数据真相，同时承载跨语言的 job 队列表。

MVP 阶段，Python AI service 与 worker 可以是**同一代码库的两个入口**（一个 FastAPI 进程 + 一个 worker 循环），减少部署组件；待规模上来再拆分独立扩缩容。

建议技术栈：

- Frontend: Next.js, React, Tailwind, shadcn/ui
- Web/business backend: Next.js API routes / server actions
- AI service: Python + FastAPI
- Background worker: 独立 Python 进程，不跑在 Web 请求进程里
- Database: Postgres
- Vector search: pgvector（MVP 阶段足够；规模化后再评估是否引入专用向量库，不在早期提前优化）
- DB access: Web 侧用 Drizzle ORM；Python 侧用 SQLAlchemy / SQLModel
- Queue: 基于 Postgres 的 job 表 + `SELECT ... FOR UPDATE SKIP LOCKED`
- Auth: Auth.js (NextAuth) 或 better-auth
- AI providers: Python 侧用 litellm 或各家官方 SDK 做 provider 抽象；Next.js 侧若需要直接流式回答，用 Vercel AI SDK
- Observability: 先用自建 trace 表，Langfuse 等工具后续按需引入

选型理由与约束：

- **RAG 核心必须单一实现（最重要的约束）。** evaluation 的价值在于真实反映线上配置，如果实时 chat 和 evaluation 各用一套检索实现，评估结果就对不上线上，整个 evaluation 闭环失去意义。因此 retrieval / answer 逻辑只在 Python AI service 中实现一次，实时与批量都复用它。
- **为什么 Web 层用 TS、AI 层用 Python。** auth、multi-tenant、RBAC、CRUD、配额、审计这类业务编排用 Python 没有收益，反而失去端到端类型；而 chunking、embedding、retrieval、reranking、evaluation 以及 LangChain / LangGraph 生态在 Python 明显更强。按这条边界分工，两个生态的优势都能拿到。
- **数据库 schema 单一归属。** 为避免双写 schema 混乱，migrations 由 Web 侧（Drizzle）统一拥有，作为 schema 的单一真相；Python 侧只读写约定的表，不执行 migration。
- **Auth：选 Auth.js / better-auth，不优先 Clerk。** 产品目标包含私有化部署、multi-tenant workspace、RBAC 和从 IdP 同步权限，而 Clerk 是托管 SaaS，自托管能力弱，与私有化部署直接冲突。`workspace`、`member`、`role` 等核心身份模型必须由本项目掌控并存放在自己的 Postgres 中，这也符合"核心逻辑不外包给框架"的原则。Clerk 仅在需要快速验证纯云版 MVP 时作为可选项，不作为默认。
- **ORM：Web 侧选 Drizzle，不选 Prisma。** RAG 的核心是向量检索与复杂 SQL，而 Prisma 原生不支持 `vector` 类型，需要用 `Unsupported` + raw SQL 绕开，体验割裂。Drizzle 对 pgvector、原生 SQL 和复杂检索查询控制力更强、更轻量、迁移透明。
- **Queue：选基于 Postgres 的 job 表，不引入额外队列中间件。** ingestion 和 batch evaluation 是本产品的核心能力。用 Postgres job 表 + `SKIP LOCKED` 既能跨语言（Next.js 入队、Python worker 消费），又天然契合已有的 `ingestionJob` / `evaluationRun` 领域模型和"job 数据显式存储"的原则，且零额外基础设施、利于私有化部署。只有当吞吐或并发要求显著上升时，才升级到 Redis + 队列方案。worker 必须是独立进程，保证 retryability 与故障隔离。

LangChain 可以用于 document loaders、text splitters、model wrappers、provider integrations，但项目不能变成一个薄薄的 LangChain Demo。核心的数据模型、trace system、evaluation logic 和 product workflow 必须由本项目自己清晰定义和掌控。

LangGraph 适合后续用于 evaluation workflow、failure analysis workflow、agentic retrieval 和 human-in-the-loop review。不要在 MVP 早期为了展示技术而过早引入。

## Engineering Naming Rules

Use English for all code-facing names.

Required naming conventions:

- Directories: kebab-case, for example `knowledge-bases`, `evaluation-runs`.
- React components: PascalCase, for example `KnowledgeBaseList`.
- Hooks: camelCase with `use` prefix, for example `useEvaluationRun`.
- Functions and variables: camelCase, for example `createKnowledgeBase`.
- Types and interfaces: PascalCase, for example `EvaluationRun`.
- Database tables: snake_case plural, for example `knowledge_bases`.
- Database columns: snake_case, for example `workspace_id`.
- Enum values: uppercase snake_case, for example `PENDING_REVIEW`.
- API routes: kebab-case nouns where possible, for example `/api/evaluation-runs`.
- Background jobs: kebab-case action names, for example `ingest-document`.

Prefer domain-specific names over generic names. For example, use `evaluationRun` instead of `job`, `retrievedChunk` instead of `item`, and `knowledgeBase` instead of `collection` when the product concept is specifically a knowledge base.

## 工程原则

- 按真实产品来构建，不按一次性 Demo 来构建。
- 第一版范围要窄，但必须形成完整闭环。
- AI 质量要可衡量，不要只凭感觉判断。
- trace 和 evaluation 数据必须显式存储。
- 优先清晰的领域模型，不要把核心逻辑藏在框架魔法里。
- 权限、成本、延迟、审计、错误恢复都属于产品需求，不是后期优化。
- 失败必须可检查、可分类、可恢复。
- 面向非工程运营人员的页面要尽量清楚。
- 重要产品和架构决策要持续文档化。

## 面试叙事

这个项目应该支撑以下故事：

> 我之前在真实公司环境中参与过基于 RAG 的 AI 聊天机器人。那段经历让我意识到，企业 AI 应用最难的不是让模型回答一次，而是上线之后如何持续保证质量。Hameo KnowledgeOps AI 是我把这段经验产品化的一次尝试，它重点解决企业知识助手的评估、可观测性、调试、反馈闭环、权限和生产运营质量问题。

展示项目时要强调：

- 它是一个完整产品，不是单个聊天页面。
- 它解决的是企业 AI 应用上线后的真实问题。
- 它展示了全栈产品工程和 AI 应用工程能力。
- 它包含 multi-tenancy、background jobs、traceability、evaluation、cost tracking、access control 等生产关注点。
- 它体现了对 AI 框架的判断：该用框架的地方用框架，该由产品自己掌控的核心逻辑不外包给框架。

## 非目标

早期阶段避免：

- 做成一个没有 evaluation 和 operations layer 的普通聊天机器人。
- 在 ingestion、trace、evaluation 闭环稳定前添加大量第三方集成。
- 在没有评估指标前过度优化 prompt。
- 把重要行为隐藏在框架抽象里。
- 为了演示好看而加入没有产品价值的功能。

这个项目应始终聚焦于：在 Hameo 品牌下，打造一个可信、可运行、可商业化的企业 AI 知识运营产品。
