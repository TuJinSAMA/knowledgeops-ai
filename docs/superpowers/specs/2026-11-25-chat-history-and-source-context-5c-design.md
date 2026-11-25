# Module 5C 设计文档：AI 助手多会话历史恢复与引用原文上下文侧栏

- **日期：** 2026-11-25
- **优先级：** P1（终端用户日常问答工作台体验）
- **涉及范围：** `apps/web`（个人历史会话列表 / URL 恢复 / 重命名与删除 API + 引用分块前后文读取 API + `ChatPanel` 三栏自适应工作台）

---

## 1. 背景与业务意图（Intent & Why）

在企业内部上线知识助手后，终端员工（End User）和运营人员每天高频接触的入口是 `/[locale]/[workspaceSlug]/chat`。目前后端数据库已经完整持久化了 `conversations` 与 `messages`，但前端 `ChatPanel.tsx` 仍存在两个严重影响日常留存的体验断层：

1. **刷新即失忆：** `conversationId` 与 `messages` 仅保存在 React 内存状态中。用户一旦刷新浏览器、点击“查看追踪”再返回、或第二天想接着昨天的采购流程继续追问，之前的对话就彻底从界面消失了。
2. **引用核验缺乏上下文：** 当前回答下方的引用卡片仅展示最多 800 字符的单个截断 `snippet`。在面对跨段表格、前置条件在上一分块或例外条款在下一分块的制度文档时，用户无法判断 AI 是否“断章取义”，必须切出聊天页去翻找原始文档。

本模块将数据库中沉睡的会话资产激活为标准的多会话工作台，并引入**引用原文上下文侧栏（Source Context Drawer）**，实现“边问边核验前后文”的可信企业问答体验。

---

## 2. 目标与非目标（Goals & Non-Goals）

### 目标（Goals）
- **严格的个人会话隐私与租户双重隔离：** 每位工作区成员在 Chat 历史栏仅能列出、恢复、重命名和删除**属于当前 `workspaceId` 且 `userId === currentUser.id`** 的个人会话（管理员排查全工作区问答统一走 `/traces` 与 `/feedback`，避免个人对话列表互相干扰与越权读写）。
- **URL 驱动的会话持久化与无损恢复：** 支持通过 `/{locale}/{workspaceSlug}/chat?c={conversationId}` 直接打开或刷新恢复任意历史会话；恢复的历史助手消息**完整保留 Citations、`refused` 徽标、`traceId`（查看追踪链接）及当前用户已提交的 Feedback 状态**，体验与刚生成的消息完全一致。
- **会话列表管理：** 左侧可折叠侧栏支持新建对话、按知识库过滤会话、按最近活跃时间（`updatedAt DESC`）排序、重命名会话标题与删除会话。
- **行内引用角标交互与 Source Context Drawer：** 将助手回答正文中的 `[1]`、`[2]` 文本角标渲染为可点击胶囊按钮；点击角标或来源卡片时，在右侧展开上下文侧栏，加载目标文档中该分块及其前后相邻分块（`chunkIndex - 1`、`chunkIndex`、`chunkIndex + 1`），高亮当前被引用的分块并提供一键跳转到 Chunk Inspector 全文页（衔接 Module 4B）。

### 非目标（Non-Goals）
- 会话分享给其他同事或多人协同编辑同一会话。
- 对历史某条消息原地分叉（Branching / Edit & Regenerate prior turn）。

---

## 3. 核心方案权衡（Approaches Considered）

### 3.1 历史消息恢复时如何拿回 `traceId`、`refused` 与用户已提交的反馈？
- **现状分析：** `messages` 表存储了 `id, conversationId, role, content, citations`，但没有直接存储 `traceId` 和 `refused`；这两个信号存放在 `rag_traces`（通过 `rag_traces.message_id` 关联，Module 5B 已补齐 `rag_traces.refused`），而当前用户的点赞/点踩记录存放在 `answer_feedback`（通过 `(workspace_id, message_id, user_id)` 唯一索引关联）。
- **方案 A（采纳）：在 `listConversationMessagesForUser` 中通过单次 SQL `LEFT JOIN rag_traces` 与 `LEFT JOIN answer_feedback` 组装完整视图模型。**
  - *理由：* 单次会话通常在 2–50 条消息以内，单条 SQL 即可一次性带回 `traceId`、`refused` 与 `userRating`（`HELPFUL` / `NOT_HELPFUL`），无需修改 `messages` 表结构冗余字段，保证单一数据真相。
- **方案 B（放弃）：在 `messages` 表冗余 `trace_id` 与 `refused` 列。**
  - *放弃原因：* 造成 `messages` 与 `rag_traces` 双向外键耦合，且存量历史消息无法自动受益。

### 3.2 引用上下文窗口大小：拉取整篇文档全部分块 vs 滑动窗口（前后各 `N` 块）
- **方案 A（采纳）：按 `chunkIndex` 拉取 `[chunkIndex - 1, chunkIndex + 1]`（共最多 3 个相邻分块），并在侧栏底部提供「加载前后更多分块」或「打开完整文档分块视图」。**
  - *理由：* 兼顾百页大型 PDF（可能有数百个分块）的网络传输瞬时响应与阅读聚焦度，同时 3 个连续分块（约 2,500–3,000 字符）足以覆盖绝大多数制度条款的前置条件与例外说明。

---

## 4. 详细技术设计（Detailed Component Changes）

### 4.1 数据库索引优化（`apps/web/src/db/schema.ts`）

在 `conversations` 表新增复合索引以加速个人会话侧栏按最近活跃排序：
- `index("conversations_workspace_user_updated_idx").on(table.workspaceId, table.userId, table.updatedAt)`
- 执行 `pnpm db:generate && pnpm db:migrate`。

### 4.2 领域层扩展（`apps/web/src/lib/conversation.ts`）

1. **`listUserConversations(workspaceId: string, userId: string, filters?: { knowledgeBaseId?: string; limit?: number }): Promise<ConversationSummary[]>`**
   - `INNER JOIN knowledge_bases ON knowledge_bases.id = conversations.knowledge_base_id`
   - 过滤 `conversations.workspaceId = workspaceId AND conversations.userId = userId`（可选叠加 `knowledgeBaseId`），按 `conversations.updatedAt DESC` 排序，默认返回最近 `50` 条。
   - 返回 `{ id, title, knowledgeBaseId, knowledgeBaseName, updatedAt, createdAt }`。
2. **`getUserConversationDetail(workspaceId: string, userId: string, conversationId: string)`**
   - 严格校验 `workspaceId` + `userId` + `conversationId` 三重匹配（防止任何成员通过猜测 UUID 读取他人会话）。
   - 查询消息列表：`messages` `LEFT JOIN rag_traces ON rag_traces.message_id = messages.id` `LEFT JOIN answer_feedback ON (answer_feedback.message_id = messages.id AND answer_feedback.user_id = userId AND answer_feedback.workspace_id = workspaceId)`，按 `messages.createdAt ASC` 返回：
     ```ts
     export type HydratedChatMessage = {
       id: string;
       role: "USER" | "ASSISTANT";
       content: string;
       citations: EnrichedCitation[];
       refused: boolean;
       traceId: string | null;
       initialFeedbackRating: "HELPFUL" | "NOT_HELPFUL" | null;
       createdAt: string;
     };
     ```
3. **`renameUserConversation(workspaceId, userId, conversationId, title)` & `deleteUserConversation(workspaceId, userId, conversationId)`：**
   - 校验 `(id, workspaceId, userId)` 后更新 `title`（限制 1–120 字符）或删除会话（注意：`conversations` 删除将级联删除其 `messages`；为保留生产可观测性审计闭环，建议先检查或评估级联策略——若需保留历史 Trace 统计，可在 schema 将 `rag_traces.conversation_id` 设为可空 `onDelete: "set null"`，避免员工清理个人聊天记录时抹除工作区的 Token/成本账单！这一点作为本模块的迁移守卫一并落地）。
4. **`getCitationContextWindow(workspaceId: string, documentId: string, centerChunkIndex: number, radius = 1)`：**
   - 通过 `documents` `INNER JOIN knowledge_bases` 校验 `workspaceId` 归属。
   - 查询 `document_chunks` 中 `document_id = documentId AND chunk_index BETWEEN (centerChunkIndex - radius) AND (centerChunkIndex + radius)`，按 `chunkIndex ASC` 返回 `{ documentId, documentTitle, knowledgeBaseId, chunks: Array<{ id, chunkIndex, content, tokenCount, isTarget: boolean }> }`。

### 4.3 API 路由设计

全部路由通过 `requireWorkspaceMemberBySlug(workspaceSlug, "MEMBER")` 鉴权：
1. **`/[locale]/[workspaceSlug]/api/conversations/route.ts`：**
   - `GET`：查询当前用户的会话列表（支持 `?kb=<knowledgeBaseId>`）。
2. **`/[locale]/[workspaceSlug]/api/conversations/[conversationId]/route.ts`：**
   - `GET`：加载单个会话元信息及 `HydratedChatMessage[]`。
   - `PATCH`：更新会话标题 `{ title: string }`。
   - `DELETE`：删除个人会话。
3. **`/[locale]/[workspaceSlug]/api/documents/[documentId]/context/route.ts`：**
   - `GET`（参数 `?chunkIndex=N&radius=1`）：返回 `getCitationContextWindow` 结果供右侧原文侧栏渲染（若原文档已被删除，返回 `404` 并在侧栏优雅回退展示消息内快照的 `citation.snippet`）。

### 4.4 前端工作台交互设计（`chat/page.tsx` & `ChatPanel.tsx`）

1. **服务端首屏预水合（`apps/web/src/app/[locale]/[workspaceSlug]/chat/page.tsx`）：**
   - 读取 `searchParams.c`（可选初始 `conversationId`）与 `searchParams.kb`（可选初始 `knowledgeBaseId`）。
   - 并行加载 `knowledgeBases`、`initialConversations` 及（当 `?c=` 存在且归属合法时）`initialActiveConversation`，首屏直出无闪烁。
2. **`ChatPanel.tsx` 布局升级：**
   - **左侧：会话历史侧栏（`ConversationSidebar.tsx`）：**
     - 顶部「+ 新对话」按钮、按知识库筛选下拉。
     - 会话列表项：点击切换会话并同步更新浏览器地址栏 `?c=<id>`；悬停显示行内重命名与删除图标。
     - 当新对话首轮收到 `X-Conversation-Id` 响应头时，自动插入侧栏顶部并同步 URL。
   - **中间：对话主面板与可交互角标渲染：**
     - 新增轻量纯文本分段解析函数 `renderAnswerWithCitations(content, citations, onSelectCitation)`（不使用 `dangerouslySetInnerHTML`，确保 100% XSS 安全）：将匹配的 `[n]` 渲染为紧凑上标按钮，点击即打开右侧上下文侧栏并聚焦对应引用。
     - `FeedbackControls` 接收可选 `initialRating` 属性，使刷新后的历史回答正确高亮用户此前点过的赞/踩。
   - **右侧：原文上下文侧栏（`SourceContextDrawer.tsx`，按需展开）：**
     - 展示文档标题、匹配得分，以及 `[chunkIndex - 1, chunkIndex, chunkIndex + 1]` 连续分块流。
     - 目标分块以高对比度边框与 `当前引用来源 [n]` 标签突出显示，相邻分块以次级视觉层级提供上下文参照。
     - 若原文档在后续运营中已被删除，自动降级渲染消息持久化快照中的 `citation.snippet` 并提示“原文档已移除，当前展示回答生成时的快照片段”。

---

## 5. 测试与验收标准（Verification Criteria）

1. **租户与用户隔离测试（`apps/web/src/lib/conversation.test.ts`）：**
   - 验证同一工作区内的用户 A 无法列出、读取、重命名或删除用户 B 的会话；跨工作区访问一律返回 `null` / `404`。
   - 验证删除个人会话后，`rag_traces` 中的历史 Token 与成本记录因 `conversation_id ON DELETE SET NULL` 完整保留，工作区账单与配额统计不受篡改。
   - 验证 `getCitationContextWindow` 准确返回相邻分块并拦截跨租户 `documentId`。
2. **前端纯函数测试：**
   - 验证 `renderAnswerWithCitations` 正确拆分形如 `"Pro 版每月 ¥899 [1]，支持 Zendesk [2]。"` 的文本节点与角标按钮，忽略越界编号如 `[99]`。
3. **端到端交互验证：**
   - 发起两轮对话并对回答点赞 → 刷新浏览器页面 → 确认会话内容、引用角标、点赞高亮与「查看追踪」链接 100% 原样恢复 → 点击回答中的 `[1]` 角标，右侧滑出原文前后分块上下文 → 删除该会话后验证 Dashboard 的累计 Token 账单未减少。
