# Module 5B 设计文档：主动式知识缺口洞察、Trace 多维筛选与 Redis Embedding 缓存激活

- **日期：** 2026-11-25
- **优先级：** P1（主动可观测性与性能治理）
- **涉及范围：** `apps/web`（`rag_traces.refused` 迁移、Dashboard 知识缺口聚合面板、`/traces` 多维过滤分页）与 `services/ai`（同步安全的批量 Redis Embedding 缓存接线）

---

## 1. 背景与业务意图（Intent & Why）

在 `AGENTS.md` 定义的企业痛点中，有两条直接决定上线后的日常运营效率与调用成本：
> - “知识库缺口通常只有在用户投诉后才被发现。”
> - “AI 调用有成本、延迟、配额、错误重试和稳定性问题。”

审视当前代码实现，数据底座与缓存基础设施其实已经完成了 80%，但尚未打通最后一步：
1. **拒答信号未持久化到 `rag_traces`：** `services/ai` 已经能精准判定检索层与生成层拒答（`refused=True`），`chat.ts` 也将其透传给了前端气泡，但写入 `rag_traces` 表时丢弃了 `refused` 布尔值，导致后台既无法在 `/traces` 一键筛出所有“答不上来的问题”，也无法在 Dashboard 聚合展示高频知识盲区。
2. **`/traces` 列表缺乏过滤与检索：** 当前 `/traces` 页面仅无条件拉取最近 50 条记录，不支持按知识库、拒答/报错状态、慢查询耗时或关键词检索，线上积累数百条对话后排障效率急剧下降。
3. **Redis Embedding 缓存悬空未接线：** `services/ai/app/cache.py` 已经定义了 Redis 连接与键哈希规则，但由于 `cache.py` 使用的是异步 `redis.asyncio`，而 `embeddings.py`、`retrieval.py` 与独立 `worker` 进程均为同步调用链，缓存从未接入真实检索与评测路径。在 QA 实测中，单次外部 Embedding 请求耗时达 `1.5s–2.1s`，批量回归评测重复对相同测试题计算向量的时间和费用完全可以通过缓存消除。

本模块一次性补齐**主动知识缺口发现**、**Trace 生产级排障过滤**与**同步安全的批量 Embedding 缓存**。

---

## 2. 目标与非目标（Goals & Non-Goals）

### 目标（Goals）
- **`rag_traces.refused` 显式持久化：** 在 `rag_traces` 表增加 `refused: boolean` 列与复合索引，`chat.ts` 在落盘 Trace 时精确记录该轮回答是否拒答。
- **Dashboard「待补齐知识盲区（Knowledge Gaps）」洞察卡片：** 自动聚合工作区近 30 天内的两类高信号盲区：① 线上触发 `refused = true` 的高频问题（按归一化文本归并计数，附所属知识库与最近一条 `traceId`）；② 用户提交 `report_type = 'MISSING_KNOWLEDGE'` 且尚未 `RESOLVED` 的反馈。提供直达「去知识库补传文档」与「查看追踪/反馈」的快捷动作。
- **`/traces` 多维筛选与分页：** 支持按 `knowledgeBaseId`、状态（`ALL` | `OK` | `REFUSED` | `ERROR`）、最低耗时（`minLatencyMs`，如 `>= 3000ms`）及关键词 `q`（匹配 `query` 或 `rewritten_query`）组合过滤，并在表格中直观展示所属知识库名称、`已拒答` 与 `错误` 状态徽标及缓存命中标识。
- **同步安全的批量 Redis Embedding 缓存接线：** 在 `services/ai` 为同步 `EmbeddingProvider` 引入透明的 Redis 缓存装饰/复用层（支持批量输入的部分命中 Partial-Batch Hit：仅对未命中缓存的文本切片请求上游 OpenRouter API，再按原顺序拼回），同时兼容 FastAPI 路由线程池与独立 `worker` 进程，Redis 不可达或离线测试未启动 Redis 时 100% 静默降级不报错。

### 非目标（Non-Goals）
- 基于向量聚类（K-Means / HDBSCAN）的复杂语义话题发现（MVP+ 阶段采用确定性的大小写/标点归一化文本归并，零额外计算开销、结果可解释且完全幂等）。
- 启用生成式回答（LLM Response）强缓存（在知识库文档频繁增删改的场景下，整段回答缓存极易返回过期内容；优先缓存纯函数性质的 `(model, text) -> embedding`，安全性 100% 且无脏数据失效负担）。

---

## 3. 核心方案权衡（Approaches Considered）

### 3.1 Python Embedding 缓存的客户端选型：`redis.Redis` 同步客户端 vs 将整条 RAG 链路改为 `async`
- **方案 A（采纳）：在 `services/ai/app/cache.py` 新增懒加载的同步 `redis.Redis` 客户端与批量 `mget` / `pipeline` 读写函数，包裹 `OpenRouterEmbeddings`。**
  - *理由：* 当前 `services/ai` 的 SQLAlchemy `Session`、`retrieve()`、`generate_answer()`、`stream_answer_events()` 与 `worker/runner.py` 全部建立在清晰的同步模型之上（FastAPI 自动在线程池执行同步依赖）。引入轻量同步 `redis.Redis` 连接池（`socket_connect_timeout=1.0, socket_timeout=1.0`），用一次 `MGET` 查出整批文本的命中向量、仅将未命中子集发往 OpenRouter、再用一次 `pipeline.setex` 回写，改动极小、FastAPI 与 Worker 双进程通用，且绝不阻塞事件循环。
- **方案 B（放弃）：将 `embeddings.py`、`retrieval.py`、`answer.py`、`ingestion.py`、`evaluation/run.py` 全部重写为 `async def` + `AsyncSession`。**
  - *放弃原因：* 横跨全部 Python 文件与测试套件的大规模侵入式重构，风险高且对吞吐无实质增益。

### 3.2 知识缺口归并方式：SQL 归一化聚合 vs 后台定时聚类任务
- **方案 A（采纳）：实时 SQL 归一化聚合（`lower(trim(regexp_replace(query, '[[:punct:]？。！，、\s]+', ' ', 'g')))`）。**
  - *理由：* 单租户近 30 天的拒答 Trace 通常在数十至数千行规模，带 `(workspace_id, refused, created_at)` 索引的分组聚合耗时 `< 10ms`，无需新增定时任务表或状态同步逻辑，运营人员补传文档或解决反馈后立即可见变化。

---

## 4. 详细技术设计（Detailed Component Changes）

### 4.1 数据库 Schema 演进（`apps/web/src/db/schema.ts`）

在 `ragTraces` 表定义中新增：
- `refused: boolean("refused").notNull().default(false)`
- 复合索引：`index("rag_traces_workspace_refused_created_idx").on(table.workspaceId, table.refused, table.createdAt)`
- 执行 `pnpm db:generate && pnpm db:migrate`（存量行默认 `false`，零停机兼容）。

在 `apps/web/src/lib/chat.ts` 的 `finalizeDone` 中：
- 调用 `createTrace` 时传入 `refused: Boolean(captured.refused)`。

### 4.2 知识缺口查询与 Dashboard 展示（`apps/web/src/lib/dashboard.ts`）

新增类型与查询函数 `getKnowledgeGaps(workspaceId: string, options?: { days?: number; limit?: number }): Promise<KnowledgeGapSummary>`：

```ts
export type RefusedQueryCluster = {
  normalizedQuery: string;
  sampleQuery: string;
  count: number;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  latestTraceId: string;
  lastSeenAt: Date;
};

export type KnowledgeGapSummary = {
  windowDays: number;
  totalRefusedCount: number;
  unresolvedMissingKnowledgeCount: number;
  topRefusedQueries: RefusedQueryCluster[];
};
```

- **SQL 逻辑：**
  1. `rag_traces` `INNER JOIN conversations ON conversations.id = rag_traces.conversation_id` `INNER JOIN knowledge_bases ON knowledge_bases.id = conversations.knowledge_base_id`
  2. 过滤 `rag_traces.workspace_id = :workspaceId AND rag_traces.refused = true AND rag_traces.created_at >= :since`
  3. 按 `(normalized_query, knowledge_bases.id, knowledge_bases.name)` 分组，统计 `count(*)`、`max(rag_traces.created_at)` 及最新一条 `query` 与 `trace_id`，按 `count DESC, last_seen_at DESC` 取前 `limit`（默认 8 条）。
  4. 并行统计 `answer_feedback` 中 `workspace_id = :workspaceId AND report_type = 'MISSING_KNOWLEDGE' AND review_status != 'RESOLVED'` 的待处理数量。
- **Dashboard UI（`apps/web/src/app/[locale]/[workspaceSlug]/page.tsx`）：**
  - 在「回答反馈 / Token 用量」下方、「最近评估运行」上方新增 **「知识缺口洞察（近 30 天）」** 区块：
    - 顶部徽标显示近 30 天累计拒答次数与待处理“缺少相关资料”反馈数（点击直跳 `/feedback?status=NEW`）。
    - 列表展示高频未命中问题、被问次数、所属知识库名称，右侧提供 `查看追踪` 与 `补充文档`（直跳对应 `/knowledge-bases/[kbId]`）快捷链接。

### 4.3 Trace 多维检索与分页（`apps/web/src/lib/trace.ts` & `traces/page.tsx`）

1. **`TraceFilters` 与返回结构升级：**
   ```ts
   export type TraceStatusFilter = "ALL" | "OK" | "REFUSED" | "ERROR";

   export type TraceListFilters = {
     knowledgeBaseId?: string | null;
     status?: TraceStatusFilter;
     minLatencyMs?: number | null;
     query?: string | null;
     limit?: number;
     offset?: number;
   };
   ```
   - `listTraces` 关联 `conversations` 与 `knowledge_bases`，返回每行的 `knowledgeBaseId`、`knowledgeBaseName`、`refused`、`rewrittenQuery`、`error`、`latencyMs`、`costEstimate`、`createdAt`，并同时返回总匹配条数 `total`（供上一页/下一页分页）。
   - 状态过滤映射：
     - `"ERROR"`：`isNotNull(ragTraces.error)`
     - `"REFUSED"`：`and(isNull(ragTraces.error), eq(ragTraces.refused, true))`
     - `"OK"`：`and(isNull(ragTraces.error), eq(ragTraces.refused, false))`
2. **`/traces/page.tsx` 与 `/traces/[id]/page.tsx` 升级：**
   - 列表页顶部新增 `GET` 筛选表单（知识库下拉、状态下拉、耗时筛选 `全部 / >=1s / >=3s / >=5s`、关键词搜索框、重置链接），底部增加简洁分页导航。
   - 列表与详情页均新增所属知识库链接与 `已拒答（资料不足）` 琥珀色状态标签。

### 4.4 Python 批量同步 Embedding 缓存（`services/ai/app/cache.py` & `embeddings.py`）

1. **`services/ai/app/cache.py` 扩展同步批量辅助函数：**
   - 新增懒初始化 `_sync_redis_client: redis.Redis | None`，通过 `get_sync_redis(url)` 按需连接（设短超时 `socket_connect_timeout=1.0, socket_timeout=1.0`），连接失败时记录 `warning` 并返回 `None`。
   - 新增 `get_cached_embeddings_batch(texts: list[str], model: str, dimensions: int, url: str) -> dict[int, list[float]]`：
     - 使用 `client.mget(keys)` 一次性拉取全部输入文本对应的缓存项（键格式：`knowledgeops:embedding:{model}:{dimensions}:{sha256_text}`，将 `dimensions` 纳入键名确保未来维度演进绝对安全）。
     - 校验反序列化后的向量长度严格等于 `dimensions`，返回命中下标到向量的字典；任何 Redis 异常返回 `{}`。
   - 新增 `set_cached_embeddings_batch(items: list[tuple[str, list[float]]], model: str, dimensions: int, url: str, ttl: int = TTL_EMBEDDING) -> None`：
     - 使用 `pipeline.setex` 批量写入新计算的向量，异常静默记录日志。
2. **`CachedEmbeddingProvider` 包装器（`services/ai/app/rag/embeddings.py`）：**
   - 在 `Settings`（`services/ai/app/config.py`）增加布尔开关 `embedding_cache_enabled: bool = True`（默认开启，可通过环境变量 `EMBEDDING_CACHE_ENABLED=false` 关闭）。
   - 当 `provider == "openrouter"` 且 `settings.embedding_cache_enabled` 为真时，`get_embedding_provider` 返回包裹了 `OpenRouterEmbeddings` 的缓存增强实例（`FakeEmbeddings` 本身为纯内存微秒级哈希，无需走 Redis）：
     - 输入 `texts` → 批量查 Redis → 若全部命中则零网络请求直接返回；
     - 若部分未命中（含同一批次内重复文本去重），仅对唯一未命中文本调用底层 `_inner.embed_texts(missing_unique_texts)` → 批量回写 Redis → 按原输入下标顺序组装返回。

---

## 5. 测试与验收标准（Verification Criteria）

1. **Python 单元测试（`services/ai/tests/test_embeddings.py`）：**
   - 使用内存假缓存 / monkeypatch 验证批量 3 条文本中命中 1 条、重复 2 条未命中时，底层 OpenRouter 客户端仅被调用 1 次且只发送 1 条文本，返回结果顺序与维度完全正确。
   - 验证 Redis 抛出 `ConnectionError` 时自动穿透调用底层 Provider，不中断检索或入库。
2. **Web 单元测试（`apps/web/src/lib/`）：**
   - `dashboard.test.ts`：验证 `getKnowledgeGaps` 严格按 `workspaceId` 隔离、正确归并大小写/标点变体的重复拒答问题，且不混入 `refused = false` 的正常回答。
   - `trace.test.ts` / `chat.test.ts`：验证 `handleChat` 将 `refused: true` 写入 `createTrace`，以及 `listTraces` 的四类过滤条件准确生效。
3. **端到端性能与功能验证：**
   - 在真实模型模式下连续两次提问同一问题（或对同一评测集连续触发两次不同 `topK` 的 Run），观察第二次请求的 `retrieve` 阶段耗时从 `~1,800ms` 降至 `< 30ms`。
   - 提问一个知识库外的无关问题触发拒答 → 在 Dashboard「知识缺口洞察」看到该问题上榜 → 在 `/traces?status=REFUSED` 中精准过滤出该记录。
