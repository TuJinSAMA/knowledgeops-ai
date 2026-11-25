# Module 4A 设计文档：知识库线上 RAG 配置与「评测配置一键发布」闭环

- **日期：** 2026-11-25
- **优先级：** P0（闭环封口）
- **涉及范围：** `apps/web`（1 次轻量 Drizzle migration + 知识库配置面板 + 评测发布动作 + Chat 接线）与 `services/ai`（`system_prompt_addendum` 支持）

---

## 1. 背景与业务意图（Intent & Why）

在完成 Module 2A（Contextual Chunking、Hybrid RRF、Query Rewrite）与 Module 2B（Pluggable Reranker、LLM-as-a-Judge、Failure Attribution）后，平台已经具备强大的离线实验与配置对比能力。然而在真实的企业运营链路中，**最后一公里处于断裂状态**：

1. **评测结果无法发布上线：** 管理员在 `/evaluations/[datasetId]/compare` 验证某组配置（例如 `topK=6, retrievalMode="hybrid", reranker="heuristic", minScore=0.42`）比默认配置准确率高出 12%，但 `knowledge_bases` 表没有任何配置持久化字段，实时对话入口 `apps/web/src/lib/chat.ts` 始终向 AI 服务发送空对象 `const retrievalConfig = {}`。
2. **评测表单存在“幽灵参数”误导：** `TriggerEvaluationRunForm.tsx` 暴露了 `chunkSize`、`embeddingModel`、`promptVersion` 三个输入框，但 `services/ai/app/rag/answer.py` 的 `normalize_rag_config` 在查询期完全忽略它们（因为切分粒度与向量模型在入库期已固化），同时真正决定跨库无关问题拒答质量的 `minScore` 却未在 UI 暴露。

本模块旨在打通 **Evaluate → Compare → Promote to Production → Observe** 的完整闭环，让每个 `knowledgeBase` 拥有独立可控、可审计、可从评测 Run 一键发布的线上 RAG 配置。

---

## 2. 目标与非目标（Goals & Non-Goals）

### 目标（Goals）
- **知识库级持久化 `rag_config`：** 在 `knowledge_bases` 表新增可空的 `rag_config` JSONB 列，存储该知识库当前线上生效的检索与生成配置（`null` 或缺省字段自动回退至 `services/ai` 全局默认配置）。
- **实时对话自动加载线上配置：** `handleChat`（`apps/web/src/lib/chat.ts`）在调用 `POST /v1/answer` 时读取目标 `knowledgeBase.ragConfig`，将其传入 `config` 并完整快照到 `rag_traces.retrieval_config`。
- **安全的领域提示词追加（`systemPromptAddendum`）：** 在 `services/ai/app/rag/answer.py` 支持可选的 `system_prompt_addendum`（最长 1,000 字符），追加在内置 `_SYSTEM_PROMPT` 的引用与 `[REFUSED]` 硬性约束之后，允许企业定制语气、术语解释或拒答引导联系方式（例如“若无法回答请引导联系 IT 服务台”），同时不破坏引用解析与拒答检测协议。
- **知识库线上配置面板：** 在 `/[locale]/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]` 页面新增 `KnowledgeBaseRagConfigForm`（仅 `ADMIN` / `OWNER` 可编辑，`MEMBER` 只读查看），支持手动微调与一键恢复系统默认。
- **评测 Run 一键发布到知识库（Promote Config）：** 在 `/evaluations/[datasetId]/runs/[runId]` 与 `/evaluations/[datasetId]/compare` 页面，当数据集绑定了 `knowledgeBaseId` 且状态为 `COMPLETED` 时，提供 `PromoteRunConfigButton`；若某次 Run 的运行时配置与目标知识库当前线上配置完全一致，展示 `Live`（`线上生效中`）徽标。
- **重构评测触发配置表单：** 移除查询期无效的 `chunkSize`、`embeddingModel`、`promptVersion` 输入框；新增 `minScore`（`0`–`1`）与 `systemPromptAddendum`；当数据集绑定了知识库时，表单默认预填该知识库当前的线上 `ragConfig` 作为调优起点。
- **完整审计追踪：** 手动修改或从评测 Run 发布知识库配置时，统一写入 `audit_logs`（`knowledge-base.update-config`），记录变更前后的配置快照与可选的 `source_run_id`。

### 非目标（Non-Goals）
- 修改知识库入库期的 `chunkSize` 或切换 `embeddingModel` 触发全库重索引（入库索引级重建成本高，留待后续索引版本化模块处理）。
- 多套线上配置按流量百分比做实时 A/B 分流（企业 MVP 阶段以“离线评测对比 + 确定性一键发布”为主）。

---

## 3. 核心方案权衡（Approaches Considered）

### 3.1 配置存储模型：`knowledge_bases.rag_config` JSONB vs 独立 `rag_configs` 版本表
- **方案 A（采纳）：在 `knowledge_bases` 新增 `rag_config` JSONB 列 + `audit_logs` 记录变更历史 + `evaluation_runs.config` 天然充当历史版本库。**
  - *理由：* 每次实时对话只需在已有的 `getKnowledgeBase` 查询中多读一列，零额外 JOIN；历史跑过的每一次 `EvaluationRun` 本身已不可变地保存了 `config` 快照，随时可以从任意历史 Run 重新点击“设为线上配置”实现秒级回滚；变更轨迹由 `audit_logs` 完整记录。符合最小复杂度原则。
- **方案 B（放弃）：新建 `knowledge_base_config_versions` 表并通过外键 `active_config_version_id` 关联。**
  - *放弃原因：* 引入循环外键与额外的 CRUD 编排，却没有带来超出 `evaluation_runs` + `audit_logs` 的实际业务价值。

### 3.2 自定义提示词机制：全量替换 System Prompt vs 追加 `systemPromptAddendum`
- **方案 A（采纳）：保留核心 `_SYSTEM_PROMPT` 不可覆盖，仅追加 `systemPromptAddendum`。**
  - *理由：* 本产品的 Citation 解析依赖 `[1]` 格式、拒答识别依赖 `[REFUSED]` 前缀契约。若允许管理员完全覆盖 System Prompt，极易意外删掉引用或拒答指令，导致下游评测指标与 UI 徽标全部失灵。采用受控追加段落（`Additional workspace instructions`）兼顾定制灵活性与系统契约安全。
- **方案 B（放弃）：允许自由编辑完整 System Prompt 模板。**
  - *放弃原因：* 极易破坏 `[REFUSED]` 和 `[n]` 协议。

---

## 4. 详细技术设计（Detailed Component Changes）

### 4.1 数据库 Schema 与迁移（`apps/web/src/db/schema.ts`）

定义统一的运行时配置类型并在 `knowledgeBases` 表新增列：

```ts
export type KnowledgeBaseRagConfig = {
  topK?: number;
  retrievalMode?: "hybrid" | "vector" | "keyword";
  minScore?: number;
  queryRewrite?: boolean;
  reranker?: "none" | "heuristic" | "llm";
  systemPromptAddendum?: string;
};
```

在 `knowledgeBases` 表定义中增加：
- `ragConfig: jsonb("rag_config").$type<KnowledgeBaseRagConfig>()`（可空，默认 `null`）。
- 执行 `pnpm db:generate && pnpm db:migrate` 生成增量 SQL：`ALTER TABLE "knowledge_bases" ADD COLUMN "rag_config" jsonb;`。

### 4.2 配置清洗与等价比较工具（`apps/web/src/lib/rag-config.ts`）

新建纯函数模块 `apps/web/src/lib/rag-config.ts`，统一前后端对配置字段的校验、提取与对比：
- **常量约束：**
  - `TOP_K_MIN = 1`, `TOP_K_MAX = 20`
  - `MIN_SCORE_MIN = 0`, `MIN_SCORE_MAX = 1`
  - `SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH = 1000`
- **`sanitizeRagConfig(input: Record<string, unknown> | null | undefined): KnowledgeBaseRagConfig`**：
  - 仅保留上述 6 个运行时有效键（自动剔除 `useLlmJudge`、历史遗留的 `chunkSize` / `embeddingModel` / `promptVersion` 等非线上运行时键）。
  - 校验数值区间与枚举合法性；空字符串或默认值 `"none"` 规范化处理，若清洗后无任何显式覆盖字段则返回 `{}`。
- **`areRagConfigsEqual(a, b): boolean`**：对两侧执行 `sanitizeRagConfig` 后按稳定键序比较，用于在评测页面判断某次 `EvaluationRun` 是否与当前线上配置一致。

### 4.3 Python AI 服务支持（`services/ai/app/rag/answer.py`）

1. **`normalize_rag_config(config)` 扩展：**
   - 读取 `system_prompt_addendum` 或 `systemPromptAddendum`，去首尾空白并截断至最多 `1000` 字符（为空时记为 `None`）。
   - 在 `recorded_config` 中仅当 `system_prompt_addendum` 非空时记录该字段（或记录布尔/摘要长度与原文），使 `rag_traces.retrieval_config` 可完整复现。
2. **`build_messages(query, context, *, system_prompt_addendum: str | None = None)` 扩展：**
   - 当 `system_prompt_addendum` 非空时，构造系统消息：
     ```python
     system_content = (
         f"{_SYSTEM_PROMPT}\n\n"
         "Additional instructions for this knowledge base (must NOT override "
         "the source-grounding, [n] citation, or [REFUSED] rules above):\n"
         f"{system_prompt_addendum}"
     )
     ```
   - `generate_answer` 与 `stream_answer_events` 共享 `_plan_answer`，因此实时对话与批量评测自动获得完全一致的行为。

### 4.4 Web 领域层、审计与实时对话接线

1. **审计动作扩展（`apps/web/src/lib/audit.ts`）：**
   - 新增 `KNOWLEDGE_BASE_UPDATE_CONFIG: "knowledge-base.update-config"`。
2. **错误码扩展（`apps/web/src/lib/action-errors.ts`）：**
   - 新增 `"RAG_CONFIG_INVALID"`、`"EVALUATION_RUN_NOT_FOUND"`、`"DATASET_NO_KNOWLEDGE_BASE"`。
3. **知识库读写层（`apps/web/src/lib/knowledge-base.ts`）：**
   - `KnowledgeBaseSummary` 增加 `ragConfig: KnowledgeBaseRagConfig | null`，在 `listKnowledgeBases` 与 `getKnowledgeBase` 中选出 `knowledgeBases.ragConfig`。
   - 新增 `updateKnowledgeBaseRagConfig(workspaceId: string, knowledgeBaseId: string, ragConfig: KnowledgeBaseRagConfig | null): Promise<boolean>`，按 `(id, workspaceId)` 过滤更新 `rag_config` 与 `updated_at`。
4. **Server Actions（`apps/web/src/lib/knowledge-base-actions.ts` & `evaluation-actions.ts`）：**
   - `updateKnowledgeBaseRagConfigAction(workspaceSlug, knowledgeBaseId, _prev, formData)`：校验 `ADMIN+` 角色，解析表单或“恢复默认”意图，读取旧配置快照，调用 `updateKnowledgeBaseRagConfig`，写入 `audit_logs`（`metadata: { previous_config, next_config, source: "manual" }`），`revalidatePath` 知识库详情页。
   - `promoteEvaluationRunConfigAction(workspaceSlug, datasetId, runId, _prev, formData)`：校验 `ADMIN+` 角色，验证 `dataset` 与 `run` 均属于当前 `workspace` 且 `dataset.knowledgeBaseId` 非空，调用 `sanitizeRagConfig(run.config)` 提取线上可运行参数写入目标知识库，写入 `audit_logs`（`metadata: { previous_config, next_config, source: "evaluation_run", run_id: runId, dataset_id: datasetId }`），`revalidatePath` 评测页与知识库页。
5. **实时对话接线（`apps/web/src/lib/chat.ts`）：**
   - 在 `handleChat` 中，无论是新建会话还是复用已有会话，均通过 `getKnowledgeBase(workspaceId, knowledgeBaseId)` 获取 `kb.ragConfig`：
     ```ts
     const retrievalConfig: Record<string, unknown> = {
       ...(kb.ragConfig ?? {}),
     };
     ```
   - 将 `retrievalConfig` 传给 `POST ${env.aiServiceUrl}/v1/answer` 的 `config` 字段。

### 4.5 前端页面与交互组件

1. **知识库详情页（`/knowledge-bases/[knowledgeBaseId]/page.tsx`）：**
   - 在标题下方、文档列表上方新增折叠或卡片区块 `KnowledgeBaseRagConfigForm.tsx`，展示并编辑 `topK`、`retrievalMode`、`minScore`、`queryRewrite`、`reranker`、`systemPromptAddendum`，保存成功后显示本地化“已保存”状态提示，并提供“重置为系统默认”按钮。
2. **评测触发器（`TriggerEvaluationRunForm.tsx`）：**
   - 接收可选 `initialConfig?: KnowledgeBaseRagConfig | null`。
   - 移除 `chunkSize`、`embeddingModel`、`promptVersion` 输入框；新增 `minScore`（`type="number" step="0.05" min="0" max="1"`）与 `systemPromptAddendum`（`textarea`）。
   - 默认值优先回填绑定的知识库当前线上配置，让运营人员直观基于线上现状做单变量实验。
3. **评测详情页与对比页（`runs/[runId]/page.tsx` & `compare/page.tsx`）：**
   - 查询所绑定知识库当前的 `ragConfig`。
   - 若 `areRagConfigsEqual(run.config, kb.ragConfig)` 为真，渲染绿色徽标 `线上生效中`（`Live on KB`）；否则为 `ADMIN+` 渲染 `PromoteRunConfigButton`（「发布为知识库线上配置」）。
4. **国际化文案（`apps/web/messages/zh.json` & `en.json`）：**
   - 补齐 `knowledgeBases.ragConfig.*`、`evaluations.promoteConfig.*`、`audit.actionLabels.knowledge-base.update-config` 及对应错误提示。

---

## 5. 测试与验收标准（Verification Criteria）

1. **Python 单元测试（`services/ai/tests/test_answer_unit.py`）：**
   - 验证 `normalize_rag_config` 正确提取并截断 `systemPromptAddendum` / `system_prompt_addendum`。
   - 验证传入 `systemPromptAddendum` 时，`build_messages` 包含附加指令且保留原始 `_SYSTEM_PROMPT` 的 `[REFUSED]` 与 `[n]` 规则。
2. **Web 单元与动作测试（`apps/web/src/lib/`）：**
   - `rag-config.test.ts`：验证清洗非法数值、剥离 `useLlmJudge` / `chunkSize`、等价性判断。
   - `chat.test.ts`：验证当知识库配置了 `ragConfig: { topK: 6, reranker: "heuristic", minScore: 0.4 }` 时，`handleChat` 向 `/v1/answer` 发送的请求体 `config` 精确携带该对象。
   - `evaluation-actions.test.ts`：验证 `promoteEvaluationRunConfigAction` 校验租户隔离、剥离 `useLlmJudge`、更新目标知识库并写入 `knowledge-base.update-config` 审计记录。
3. **端到端闭环验收：**
   - 在评测集跑出 `topK=6, reranker="heuristic"` 的 Run → 点击「发布为知识库线上配置」→ 前往 Chat 提问 → 打开生成的 Trace 详情页，确认 `retrievalConfig` 显示 `top_k=6, reranker="heuristic"`，且 `/audit` 页出现对应记录。
