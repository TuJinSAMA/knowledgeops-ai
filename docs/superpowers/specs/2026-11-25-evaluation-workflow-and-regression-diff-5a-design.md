# Module 5A 设计文档：零门槛评测工作流与 Compare 逐题回归矩阵

- **日期：** 2026-11-25
- **优先级：** P1（打造差异化评测壁垒）
- **涉及范围：** `apps/web`（可视化文档多选器、用例在线编辑、Trace 一键转黄金用例、JSON 导入导出、Compare 页逐题回归 Diff 矩阵）

---

## 1. 背景与业务意图（Intent & Why）

Evaluation 是 Hameo KnowledgeOps AI 区别于普通聊天机器人的核心护城河。目前底层评测引擎（Module 2B）已经非常扎实，但在面向非工程背景的运营人员（客服主管、HR 运营、产品经理）日常使用时，仍存在三大体验阻力：

1. **反人类的 UUID 输入门槛：** 在 `CreateEvaluationCaseForm.tsx` 中，设置 `expectedSourceDocuments` 要求用户手动查询并粘贴 36 位数据库 UUID；列表也仅显示“期望文档: 1”，看不出具体对应哪篇制度文档。
2. **用例“只增不改”：** 用例创建后（尤其是通过 Module 3 从线上负向 Feedback 一键转入评测集后），运营人员无法在页面上编辑它来补充标准答案（`expectedAnswer`）、关键事实（`requiredFacts`）或期望引用文档，只能删掉重建（而删掉又会断开 `answer_feedback.promoted_case_id` 溯源外键）。
3. **对比视图“均值掩盖退化（Regression）”：** `/evaluations/[datasetId]/compare` 目前仅对比两次 Run 的汇总均分。在实际 RAG 调优中，总正确率从 85% 升至 89% 经常伴随着“修好了 4 道长尾题，却把 1 道核心退款政策题改错了”。没有逐题 Diff，团队不敢放心把新配置发布上线（衔接 Module 4A）。

本模块彻底消除评测集构建与回归分析的工程门槛，完成从线上 Trace 采样、可视化用例维护、批量导入导出到逐题回归拦截的完整评测工作台体验。

---

## 2. 目标与非目标（Goals & Non-Goals）

### 目标（Goals）
- **可视化期望来源文档多选器：** 当数据集绑定了 `knowledgeBaseId` 时，在新建与编辑用例表单中展示该知识库的文档标题复选/多选列表（底层仍存储 `documentId[]`），并在用例列表中直接渲染文档标题徽标（已删除文档优雅回退显示短 ID）。
- **评测用例在线编辑（Edit Evaluation Case）：** 支持原地展开编辑任意已有 `EvaluationCase`（修改 `question`、`expectedAnswer`、`expectedSourceDocuments`、`expectedChunks`、`requiredFacts`、`tags`），保持 `case.id` 与关联的 `answer_feedback.promoted_case_id` 不断裂。
- **从 Trace 一键沉淀黄金用例（Promote Trace to Case）：** 在 `/traces/[id]` 详情页为 `ADMIN+` 提供 `PromoteTraceToCaseForm`，可将一次代表性的线上问答（无论是回答极佳的 Golden Case 还是暴露缺陷的 Bad Case）直接加入现有或新建评测集，支持一键勾选“将本次回答作为参考答案”与“将本次引用的文档作为期望来源”。
- **数据集 JSON 导入与导出：** 支持将整个数据集的用例导出为结构化 `.json` 文件（纳入 Git 备份或跨环境迁移），并支持上传 JSON 批量追加用例（上限单次 200 条）。
- **Compare 页逐题回归对比矩阵（Per-Case Regression Diff）：** 在 `/evaluations/[datasetId]/compare` 汇总表下方新增逐题对比视图，自动计算每道题从 `Run A`（基线）到 `Run B`（候选）的跃迁分类：
  - `REGRESSED`（退化）：`Run A` 为 `PASS` 而 `Run B` 变为非 `PASS`，或任一核心得分（`correctness` / `groundedness` / `retrieval_hit`）下降 `>= 0.20`；默认置顶标红警示。
  - `IMPROVED`（改善）：`Run A` 为非 `PASS` 而 `Run B` 变为 `PASS`，或核心得分上升 `>= 0.20`；标绿展示。
  - `UNCHANGED`（持平）：其余用例。
  支持按分类 Tab 筛选，并点击展开左右双栏对比两侧的生成回答、诊断徽标、`judge_rationale` 与耗时变化。

### 非目标（Non-Goals）
- 基于文档自动调用 LLM 合成评测集（Synthetic Dataset Generation 留作后续高阶自动化特性，当前阶段聚焦人工校验的高信噪比真实用例）。

---

## 3. 核心方案权衡（Approaches Considered）

### 3.1 Trace 转用例的关联方式：轻量审计 vs 在 `rag_traces` 新增外键列
- **方案 A（采纳）：在 `rag_traces` 新增可空 `promoted_case_id UUID REFERENCES evaluation_cases(id) ON DELETE SET NULL`（与 `answer_feedback.promoted_case_id` 完全对称）。**
  - *理由：* 延续 Module 3 已验证的成熟模式：刷新 Trace 详情页即可准确识别该 Trace 是否已沉淀为用例并直跳数据集，防止多人协作时重复添加同一条 Trace，且在评测集用例列表可展示 `来自追踪 →` 溯源链接。
- **方案 B（放弃）：无外键纯插入。**
  - *放弃原因：* 无法防重，也丢失了从回归用例回溯原始线上上下文（Trace）的调试链路。

### 3.2 导入导出格式：结构化 JSON vs CSV
- **方案 A（采纳）：以结构化 JSON 为主格式（单文件包含 `dataset` 元信息与 `cases` 数组）。**
  - *理由：* `EvaluationCase` 包含 4 个数组字段（`expectedSourceDocuments`, `expectedChunks`, `requiredFacts`, `tags`）及多行文本（`question`, `expectedAnswer`）。CSV 在表达嵌套字符串数组和多行换行时极易因转义方言差异损坏数据，而 JSON 天然无损映射领域模型。

---

## 4. 详细技术设计（Detailed Component Changes）

### 4.1 数据库 Schema 演进（`apps/web/src/db/schema.ts`）

1. **`evaluationCases` 表：**
   - 新增 `updatedAt: timestamp("updated_at").defaultNow().notNull()`。
2. **`ragTraces` 表：**
   - 新增 `promotedCaseId: uuid("promoted_case_id").references((): AnyPgColumn => evaluationCases.id, { onDelete: "set null" })` 及索引 `rag_traces_promoted_case_idx`。
3. 生成并执行 Drizzle 迁移。

### 4.2 领域层与回归计算逻辑（`apps/web/src/lib/evaluation.ts` & `trace.ts`）

1. **用例更新与批量导入（`apps/web/src/lib/evaluation.ts`）：**
   - `updateEvaluationCase(workspaceId, datasetId, caseId, params): Promise<EvaluationCaseRecord | null>`：校验 `dataset` 属于 `workspaceId` 且 `caseId` 属于 `datasetId`，更新字段并同步刷新 `evaluationCases.updatedAt` 与 `evaluationDatasets.updatedAt`。
   - `importEvaluationCases(workspaceId, datasetId, casesInput[]): Promise<{ importedCount: number }>`：校验单次不超过 `200` 条、每条 `question` 非空，在单个数据库事务中批量写入。
   - `listEvaluationCases` 扩展：同时 `LEFT JOIN rag_traces ON rag_traces.promoted_case_id = evaluation_cases.id`，在 `EvaluationCaseRecord` 中返回 `sourceTraceId: string | null`。
2. **Trace 沉淀用例（`apps/web/src/lib/trace.ts`）：**
   - `promoteTraceToCase(workspaceId, traceId, params)`：事务内校验租户归属与未重复提升 → 可选内联新建绑定同一 `knowledgeBaseId`（通过 `conversations.knowledge_base_id` 解析）的数据集 → 插入 `evaluation_cases` → 更新 `rag_traces.promoted_case_id`。
   - 在 `audit.ts` 新增 `AUDIT_ACTIONS.EVALUATION_CASE_UPDATE = "evaluation-case.update"`、`AUDIT_ACTIONS.EVALUATION_CASE_IMPORT = "evaluation-case.import"`、`AUDIT_ACTIONS.TRACE_PROMOTE_CASE = "trace.promote-case"`。
3. **逐题回归对比纯函数（`apps/web/src/lib/evaluation-compare.ts`）：**
   - 定义 `CaseDiffStatus = "REGRESSED" | "IMPROVED" | "UNCHANGED" | "ONLY_IN_A" | "ONLY_IN_B"`。
   - 实现 `buildCaseComparisonRows(resultsA: EvaluationResultRecord[], resultsB: EvaluationResultRecord[]): CaseComparisonRow[]`：
     - 按 `caseId` 对齐两侧结果。
     - 提取两侧 `raw.failure_category`、`raw.answer`、`raw.judge_rationale` 及四项数值指标。
     - 判定规则：
       - 若 `catA === "PASS"` 且 `catB && catB !== "PASS"` → `"REGRESSED"`；
       - 若 `catA && catA !== "PASS"` 且 `catB === "PASS"` → `"IMPROVED"`；
       - 否则比较 `(correctness, groundedness, retrievalHit, citationAccuracy)` 中两侧均非空的指标差值 `delta = scoreB - scoreA`：若最小 `delta <= -0.20` 判为 `"REGRESSED"`，若最大 `delta >= 0.20` 且无任何指标 `<= -0.10` 判为 `"IMPROVED"`，其余为 `"UNCHANGED"`。
     - 排序优先级：`REGRESSED` → `IMPROVED` → `ONLY_IN_B` / `ONLY_IN_A` → `UNCHANGED`。

### 4.3 API 路由与 Server Actions

1. **Server Actions（`apps/web/src/lib/evaluation-actions.ts` & `trace-actions.ts`）：**
   - `updateEvaluationCaseAction(workspaceSlug, datasetId, caseId, _prev, formData)`
   - `promoteTraceToCaseAction(workspaceSlug, traceId, _prev, formData)`
2. **JSON 导入导出路由（`/[locale]/[workspaceSlug]/api/evaluations/[datasetId]/export/route.ts` & `import/route.ts`）：**
   - `GET .../export`（要求 `MEMBER+`）：返回 `Content-Disposition: attachment; filename="<dataset-slug>-cases.json"`，结构为 `{ version: 1, datasetName, exportedAt, cases: [...] }`。
   - `POST .../import`（要求 `ADMIN+`）：解析校验 JSON Schema（拒绝超长或格式错误载荷，返回明确 `errorCode`），调用 `importEvaluationCases` 并记录审计。

### 4.4 前端组件与交互设计

1. **统一用例表单 `EvaluationCaseForm.tsx`（替代仅支持新建的旧组件并支持编辑态）：**
   - 接收 `availableDocuments: Array<{ id: string; title: string }>`（由服务端通过 `dataset.knowledgeBaseId` 查询 `listDocuments` 传入）。
   - 当 `availableDocuments.length > 0` 时，渲染可勾选的文档选择器（多选复选列表 + 快速过滤），并在折叠的“高级选项”中保留附加文档 UUID / `expectedChunks` 输入框以向后兼容。
2. **数据集详情页（`/evaluations/[datasetId]/page.tsx`）：**
   - 顶部操作栏增加 `导出 JSON` 与 `导入 JSON` 按钮。
   - 用例列表每行将 `expectedSourceDocuments` 解析为具体文档标题标签（如 `03-refund-policy.md`），右侧增加 `编辑` 切换按钮，原位展开 `EvaluationCaseForm`。
   - 同时展示 `来自反馈 →` 与 `来自追踪 →` 溯源徽标。
3. **Trace 详情页（`/traces/[id]/page.tsx`）：**
   - 底部新增“沉淀为回归评测用例”区块（与 Feedback 详情页体验一致），从 `trace.retrievedChunks` / 关联 `messages.citations` 中提取文档 ID 供一键勾选预填。
4. **Compare 页升级（`/evaluations/[datasetId]/compare/page.tsx`）：**
   - 并行加载 `listEvaluationResults(workspace.id, validA.id)` 与 `listEvaluationResults(workspace.id, validB.id)`。
   - 在汇总指标对比表下方渲染 `CaseComparisonTable.tsx`（客户端可筛选组件）：顶部显示 `全部 (N)` / `退化 Regressed (X)` / `改善 Improved (Y)` / `持平 (Z)` 计数标签；点击任一行展开 Run A 与 Run B 的并排回答文本、诊断原因与耗时对比。

---

## 5. 测试与验收标准（Verification Criteria）

1. **纯函数与单元测试：**
   - `evaluation-compare.test.ts`：覆盖 `PASS -> RETRIEVAL_MISS`（判为 `REGRESSED` 并排在首位）、`HALLUCINATION_RISK -> PASS`（判为 `IMPROVED`）、分数大幅下跌 `>= 0.2`、新增/删除用例导致单侧缺失等全部边界。
   - `evaluation-actions.test.ts`：验证编辑用例保留原 `id` 与 `promoted_case_id` 关联、跨租户越权修改被拦截、批量导入超过 200 条或空问题报错。
   - `trace-actions.test.ts`：验证从 Trace 提升用例的幂等防重与审计记录写入。
2. **端到端交互验证：**
   - 在绑定了知识库的数据集中，直接勾选文档标题创建用例 → 编辑该用例补充 `requiredFacts` → 导出 JSON 并在新数据集导入成功 → 打开两次 Run 的 Compare 页面，验证退化用例红色置顶且可展开并排对比回答差异。
