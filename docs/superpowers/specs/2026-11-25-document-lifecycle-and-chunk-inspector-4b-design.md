# Module 4B 设计文档：文档全生命周期管理与 Chunk Inspector

- **日期：** 2026-11-25
- **优先级：** P0（知识库可用性底线）
- **涉及范围：** `apps/web`（文档单篇删除 / 原位覆盖更新 / 失败重试 API + 批量上传 + 分块浏览器页面 + 引用深链），**无需数据库 Schema 迁移**

---

## 1. 背景与业务意图（Intent & Why）

目前知识库的文档管理停留在最小上传原型阶段（仅支持单文件 `POST` 与列表 `GET`），在真实企业日常运营中存在三处阻断级短板：

1. **脏文档无法清理：** 上传了错误文件或制度废止后，管理员无法删除单篇文档，只能将整个知识库连同所有正常文档和关联评测绑定一并删除。
2. **制度更新产生新旧冲突幻觉：** 企业制度更新（例如《2026 报销政策》调整了餐补标准）时，若重新上传新文件，系统中会同时存在新旧两份文档的分块，检索层会将相互矛盾的条款一并送入 LLM；而如果采用“删旧建新”，文档的 `documentId` 会改变，导致历史 `EvaluationCase.expectedSourceDocuments` 中的文档 ID 失效。
3. **切分黑盒不可调试：** 当遇到 `RETRIEVAL_MISS` 或表格/标题被切碎时，管理员无法查看文档实际生成的 `document_chunks` 内容、Contextual Header 与 Token 分布；遇到瞬时网络抖动导致的 `FAILED` 文档也无法一键重试。

本模块在不改动数据库表结构的前提下，利用现有的 `ON DELETE CASCADE` 与 Worker 幂等分块替换机制，补齐完整的文档生命周期与透明的 **Chunk Inspector（分块浏览器）**。

---

## 2. 目标与非目标（Goals & Non-Goals）

### 目标（Goals）
- **单篇文档删除（Delete Document）：** `ADMIN+` 可删除指定文档，级联清除其 `document_chunks` 与 `ingestion_jobs`，异步清理 `FileStorage` 中的原始文件，并记录 `document.delete` 审计日志。
- **原位版本覆盖更新（Replace Document In-Place）：** `ADMIN+` 可为已有文档上传新版本文件，**保持 `documents.id` 不变**，更新物理存储文件与 `source_metadata`（记录 `version` 递增计数），将状态置为 `PENDING` 并入队新的 `INGEST_DOCUMENT` 任务；由 Python Worker 的 `_replace_chunks` 在同一数据库事务中原子替换旧分块。
- **失败任务一键重试（Retry Failed Ingestion）：** 针对 `status === "FAILED"` 的文档提供一键重试接口，重置状态为 `PENDING` 并入队新的 `INGEST_DOCUMENT` 任务。
- **多文件队列上传与拖拽交互：** 升级 `DocumentsPanel.tsx` 支持一次选择或拖入多个文件顺序/并发上传，展示每个文件的上传进度与逐项错误提示。
- **独立可深链的 Chunk Inspector 页面：** 新增 `/[locale]/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]/documents/[documentId]`，展示文档元数据（文件大小、MIME、版本号、入库耗时/错误）及全部 `document_chunks` 卡片（高亮分离 `[Document: ... | Section: ...]` 上下文前缀与正文、显示 `chunkIndex`、`tokenCount`、`chunkId`），支持 `?q=` 关键词过滤与 `#chunk-{index}` 锚点高亮。
- **全链路引用深链打通：** 在 `/traces/[id]` 的召回分块列表与 `ChatPanel` 的引用来源卡片中，点击文档标题或分块编号可直接跳转到对应文档的 `#chunk-{index}` 锚点位置。

### 非目标（Non-Goals）
- 多历史版本文件快照回滚（本阶段采用“原位覆盖最新文件 + 保留 `version` 计数”，避免本地磁盘空间膨胀）。
- 在浏览器内直接手工改写单个 Chunk 文本并单独重算向量（手工改 Chunk 会在下次重传原文件时丢失，应引导用户修正源文档后执行“更新版本”）。

---

## 3. 核心方案权衡（Approaches Considered）

### 3.1 文档更新策略：原位更新（Keep `documentId`） vs 软删除旧行新建 `documentId`
- **方案 A（采纳）：原位更新同一 `documents` 行，复用 Worker 事务级 `_replace_chunks`。**
  - *理由：* 检视 `services/ai/app/rag/ingestion.py` 第 73 行可知，Worker 在完成文件解析、切分和全量 Embedding 计算**之后**，才在单个数据库事务中执行 `DELETE FROM document_chunks WHERE document_id = :id` + 批量 `INSERT` + `status = 'INGESTED'`。这意味着：
    1. 若新文件解析或 Embedding API 失败，事务回滚，旧分块完好保留（仅文档状态标为 `FAILED` 提醒管理员处理）；
    2. `documents.id` 保持恒定，`evaluation_cases.expected_source_documents` 中绑定的文档 ID 永远有效，无需人工重绑评测集！
- **方案 B（放弃）：删除旧文档行并插入新 UUID。**
  - *放弃原因：* 每次修订错别字都会打断评测集的 `expectedSourceDocuments` 引用基准。

### 3.2 Chunk Inspector 承载形态：独立子路由页面 vs 纯客户端 Modal 弹窗
- **方案 A（采纳）：App Router 独立页面 `/knowledge-bases/[knowledgeBaseId]/documents/[documentId]`（配合 URL searchParams `?q=` 与 hash `#chunk-N`）。**
  - *理由：* 天然支持从 `/traces/[id]`、`/chat`、`/evaluations/.../runs/[runId]` 直接通过标准 `<Link>` 跨页深链定位到具体分块，无需跨路由同步复杂的客户端弹窗状态，且服务端分页/过滤直查数据库更轻量。
- **方案 B（放弃）：仅在 `DocumentsPanel` 内做客户端 Modal。**
  - *放弃原因：* 无法从 Trace 详情页直接深链跳转定位某个问题分块。

---

## 4. 详细技术设计（Detailed Component Changes）

### 4.1 审计动作与错误码扩展

1. **`apps/web/src/lib/audit.ts`：**
   - 启用已预定义的 `DOCUMENT_DELETE: "document.delete"`。
   - 新增 `DOCUMENT_REPLACE: "document.replace"`、`DOCUMENT_RETRY_INGEST: "document.retry-ingest"`。
2. **`apps/web/src/lib/action-errors.ts`：**
   - 新增 `"DOCUMENT_NOT_FOUND"`、`"DOCUMENT_BUSY_PROCESSING"`、`"DOCUMENT_RETRY_NOT_ALLOWED"`。

### 4.2 领域数据层扩展（`apps/web/src/lib/knowledge-base.ts` & `document-upload.ts`）

1. **`getDocumentDetail(workspaceId, knowledgeBaseId, documentId)`：**
   - 通过 `documents` `INNER JOIN knowledge_bases` 校验 `(workspaceId, knowledgeBaseId, documentId)` 三重归属。
   - 返回文档详情（`id`, `title`, `mimeType`, `status`, `sourceMetadata`, `chunkCount`, `totalTokens`, `lastError`, `createdAt`, `updatedAt`）。
2. **`listDocumentChunks(workspaceId, knowledgeBaseId, documentId, options?: { query?: string })`：**
   - 先校验 `getDocumentDetail` 归属，再按 `chunkIndex ASC` 查询 `document_chunks`（选出 `id`, `chunkIndex`, `content`, `tokenCount`, `createdAt`，**不读取体积庞大的 1536 维 `embedding` 列**以保证毫秒级响应）。
   - 当 `options.query` 非空时，使用大小写不敏感匹配过滤 `content`。
3. **`deleteDocument({ workspaceId, knowledgeBaseId, documentId })`：**
   - 校验归属并取出 `sourceMetadata.storage_path`。
   - 若当前 `status === "PROCESSING"`，拒绝删除并返回 `DOCUMENT_BUSY_PROCESSING`（防止与正在写入的 Worker 争用）。
   - 删除 `documents` 行（级联清理 `document_chunks` 与 `ingestion_jobs`），随后调用 `getFileStorage().delete(storagePath)`（捕获并记录异常，不回滚已提交的 DB 删除）。
4. **`replaceDocumentFile({ workspaceId, knowledgeBaseId, documentId, file })`：**
   - 校验文件 MIME 与大小（复用 `resolveMimeType` 与 `maxUploadBytes` 校验）。
   - 若目标文档处于 `PROCESSING`，返回 409 `DOCUMENT_BUSY_PROCESSING`。
   - 调用 `storage.put(workspaceId, documentId, bytes)` 覆盖存储对象。
   - 在数据库事务中更新 `documents`（`title: file.name`, `mimeType`, `status: "PENDING"`, `updatedAt: new Date()`, `sourceMetadata: { ...prev, storage_path, original_filename: file.name, byte_size: bytes.byteLength, version: prevVersion + 1 }`），并向 `ingestion_jobs` 插入新的 `INGEST_DOCUMENT` 任务。
5. **`retryDocumentIngestion({ workspaceId, knowledgeBaseId, documentId })`：**
   - 仅当文档属于当前租户知识库且 `status === "FAILED"` 时允许执行。
   - 在单事务中将 `documents.status` 更新为 `"PENDING"`，并向 `ingestion_jobs` 插入新的 `INGEST_DOCUMENT` 行。

### 4.3 API 路由设计

新增以下 App Router 接口（统一通过 `requireWorkspaceMemberBySlug` 执行 RBAC 校验：读操作要求 `MEMBER+`，写操作要求 `ADMIN+`）：

1. **`/[locale]/[workspaceSlug]/api/knowledge-bases/[knowledgeBaseId]/documents/[documentId]/route.ts`：**
   - `DELETE`：调用 `deleteDocument` → 记录 `AUDIT_ACTIONS.DOCUMENT_DELETE` → 返回 `{ deleted: true }`。
   - `PUT`（`multipart/form-data` 携带 `file`）：调用 `replaceDocumentFile` → 记录 `AUDIT_ACTIONS.DOCUMENT_REPLACE`（附 `version` 与 `title`）→ 返回 `{ document }`。
2. **`/[locale]/[workspaceSlug]/api/knowledge-bases/[knowledgeBaseId]/documents/[documentId]/retry/route.ts`：**
   - `POST`：调用 `retryDocumentIngestion` → 记录 `AUDIT_ACTIONS.DOCUMENT_RETRY_INGEST` → 返回 `{ status: "PENDING" }`。

### 4.4 前端组件与 Chunk Inspector 页面

1. **升级 `DocumentsPanel.tsx`：**
   - 文件输入框增加 `multiple` 属性并外包拖拽高亮区域（Drag & Drop Zone），按队列依次上传并在面板内展示 `正在上传 (2/5)...`。
   - 文档列表每行展示版本号徽标（如 `v2`，当 `sourceMetadata.version > 1` 时）与文件大小。
   - 操作区：
     - 所有已入库文档标题变为可点击链接，指向 `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents/${doc.id}`（附「查看分块」入口）。
     - `ADMIN+` 操作按钮：`更新版本`（触发隐藏的替换文件选择器，仅当非 `PROCESSING` 时可用）、`重试`（仅 `FAILED` 状态显示）、`删除`（带二次确认，防止误删）。
2. **新建 Chunk Inspector 页面（`apps/web/src/app/[locale]/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]/documents/[documentId]/page.tsx`）：**
   - 顶部面包屑：`知识库列表 / {kb.name} / {doc.title}`。
   - 摘要指标条：状态、MIME 类型、版本号、总分块数、估算总 Token 数、最近更新时间。
   - 过滤栏：`GET` 表单按关键词搜索分块正文，匹配词在结果中高亮提示。
   - 分块卡片列表：每张卡片挂载 `id={`chunk-${chunk.chunkIndex}`}`（配合 CSS `scroll-mt-24 target:ring-2` 实现锚点跳转自动高亮！）；解析头部 `[Document: ... | Section: ...]` 为独立面包屑标签，正文等宽/清晰排版展示，右上角提供复制 `chunkId` 按钮。
3. **Trace 与 Chat 引用深链：**
   - 在 `traces/[id]/page.tsx`（需要先关联 `conversations.knowledge_base_id` 拿到 `knowledgeBaseId`）和 `ChatPanel.tsx` 的 Citation 卡片中，将文档名与分块号渲染为指向 `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents/${c.documentId}#chunk-${c.chunkIndex}` 的跳转链接。

---

## 5. 测试与验收标准（Verification Criteria）

1. **单元与集成测试（`apps/web/src/lib/`）：**
   - `document-upload.test.ts` / `knowledge-base.test.ts`：
     - 验证 `deleteDocument` 拒绝跨租户/跨知识库 ID、拒绝 `PROCESSING` 状态文档、成功删除后清理存储并记录审计。
     - 验证 `replaceDocumentFile` 保持 `documentId` 不变、`sourceMetadata.version` 自增为 `2`、状态置为 `PENDING` 并新增一条 `INGEST_DOCUMENT` job。
     - 验证 `retryDocumentIngestion` 仅允许 `FAILED` 文档触发重试。
     - 验证 `listDocumentChunks` 遵守租户隔离且支持关键词过滤。
2. **Python Worker 回归验证（`services/ai/tests/test_ingestion_integration.py`）：**
   - 验证同一 `document_id` 二次执行 `process_ingestion_job` 时，旧分块被完全清除且新分块索引从 `0` 连续生成，无残留孤儿分块。
3. **端到端交互验证：**
   - 上传 3 篇文档 → 点击进入某篇文档查看分块结构 → 上传修订版覆盖该文档，观察版本号变为 `v2` 且分块内容刷新 → 在 Chat 提问并点击引用链接，直接定位并高亮目标文档的对应 `#chunk-N`。
