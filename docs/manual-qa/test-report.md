# Test report — Enterprise scenario (manual)

> Fill during / after the half-day session. Do not commit secrets or real API keys.

## Meta

| Field | Value |
|-------|-------|
| Date | 2026-11-05 |
| Tester | AI QA Runner (Playwright dual-context OWNER + ADMIN) |
| Branch / SHA | `main` (`96b053d` + uncommitted i18n & manual-qa) |
| workspaceSlug | `nimbus-owner-s-workspace`（重命名为 `云席 NimbusDesk`） |
| OWNER email | `owner-063742@nimbusdesk.example` |
| ADMIN email | `admin-063742@nimbusdesk.example` |
| Providers | `openrouter` (`qwen/qwen3-embedding-8b`) + `deepseek` (`deepseek-chat`) |
| UI locales | `zh` (main) / `en` (sample) |

## Verdict

**Baseline loop:** Pass  

**Primary (enterprise credibility):** 基本可信但有摩擦（0 个 P0，3 个 P1，5 个 P2；底线闭环 100% 跑通）  

**One-paragraph summary**

在真实模型（OpenRouter `qwen/qwen3-embedding-8b` + DeepSeek `deepseek-chat`）与双账号（OWNER + ADMIN）隔离会话下，「开通工作区 → 创建双知识库 → 异步入库 → 带引用问答 → 查看 Trace → 提交并审核运营反馈 → 10 题回归评测集双配置（`topK=4` vs `topK=8`）运行与对比 → 用量/配额/审计日志」完整闭环一次性跑通，无任何 P0 阻断。最大亮点是**跨知识库严格隔离**、**政策内问答引用准确**、以及 **Trace 与 Evaluation 复用同一套 RAG 内核**带来的端到端一致性。当前主要风险（P1）集中在三处：① 多轮对话下的 Feedback 列表/详情把会话首问（`conversationTitle`）当成了当前被反馈的 `问题`；② 跨知识库无关问题（如在客服库问内部年假）因 `answer_min_score=0.2` 低于 Qwen3 Embedding 的中文基线余弦相似度（~0.35–0.55），未能触发检索层拒答，而是交由 LLM 用英文 System Prompt 拒答（输出英文并附带无关引用，且 `refused=False`）；③ 离线评测指标 `normalize_tokens` 仅匹配 `[a-z0-9]+` 忽略了中文字符，导致中文 `expectedAnswer` 词重叠与 `groundedness` 计算失真。

## Baseline checklist

| Step | Result | Notes |
|------|--------|-------|
| Sign-up + default workspace | Pass | OWNER 注册后自动创建并进入 `/zh/nimbus-owner-s-workspace`，可在设置中重命名为 `云席 NimbusDesk` |
| ADMIN membership via SQL | Pass | 第二账号注册后通过 `workspace_members` 挂载为 `ADMIN`，顶栏角色与权限控制生效 |
| Create SaaS + HR KBs | Pass | 成功创建 `NimbusDesk 客服知识`、`内部制度（抽查）` 与 `tmp-delete-me` |
| Ingest all primary fixtures → INGESTED | Pass | SaaS 6 篇（含 `.md` 与 `.txt`）+ HR 3 篇 + 临时 1 篇全部由 Worker 处理至 `INGESTED`（`已摄取`） |
| Chat + citations (happy path) | Pass | H1–H4 均给出准确的中文回答并附带 `[1]`/`[2]` 来源引用及余弦相似度分数 |
| Trace detail usable | Pass | 展示检索分块、分数、最终 Context、Prompt/Completion Tokens、阶段耗时（Retrieve/Generate）与成本估算 |
| Feedback submit + admin review | Pass | 支持点赞/点踩与问题报告（`WRONG_ANSWER`/`MISSING_KNOWLEDGE`），ADMIN 可更新审核状态并保存失败原因归类 |
| Evaluation run topK=4 completes | Pass | Run `6209b1e8` 10 个用例全部完成，汇总指标计算正常 |
| Evaluation run topK=8 completes | Pass | Run `25522d5a` 10 个用例全部完成，汇总指标计算正常 |
| Compare page usable | Pass | `/evaluations/{datasetId}/compare` 可直观对比 `topK=4` 与 `topK=8` 的指标与 `Δ (B − A)` |
| Dashboard / usage / audit open | Pass | 仪表盘卡片、Redis 日/月配额进度条、16 条审计日志及按动作筛选均正常 |
| tmp delete works | Pass | 删除 `tmp-delete-me` 弹窗确认、级联清理与 `已删除知识库` 审计记录均正常 |

## Scenario notes

### Happy path (H1–H4)

- **H1（云席是做什么的？主要给谁用？）**：准确概括面向客服与客户成功团队的 SaaS 定位、核心能力与目标用户，引用 `[1] 01-product-overview.md`。
- **H2（Pro 版每月多少钱？包含多少座席？）**：精准回答“Pro 版每月 ¥899，包含 5 个座席。[1]”，引用 `02-pricing.md`。
- **H3（订阅后多久可以退款？怎么申请？）**：完整列出“成功付款之日起 7 天内”、“发送邮件至 `billing@nimbusdesk.example`”及不适用情形，引用 `03-refund-policy.md`。
- **H4（支持跟 Zendesk 集成吗？）**：准确区分“Pro 与 Starter 支持，Free 不支持”并给出“设置 → 集成 → 连接 Zendesk”路径，同时引用 `04-integrations-faq.md` 与 `02-pricing.md`。
- **流式与 Trace 体验**：流式输出顺滑；点击 `查看追踪` 可见单次问答耗时约 2.5s–6.0s（其中 OpenRouter Embedding `retrieve` 约 1.5s–2.1s，DeepSeek `generate` 约 1.3s–3.5s），单次成本约 `$0.0003–$0.0005`。

### Edges

| ID | Result | Notes |
|----|--------|-------|
| A1 refuse custom quote | Pass | 未编造 500 人报价，明确引用定价与产品说明指出“不包含企业定制报价，请联系 `sales@nimbusdesk.example`” |
| B1 missing knowledge feedback | Pass | 成功提交 `MISSING_KNOWLEDGE` 报告并在 Feedback 后台可见 |
| C1 wrong / not helpful | Pass | 成功提交 `WRONG_ANSWER` / `NOT_HELPFUL` 报告及补充说明 |
| D1–D3 cross-KB | Partial | **数据隔离完全生效**（客服库绝不泄露 HR 年假，HR 库绝不泄露 Pro 价格；在 HR 库问年假精准回答“10 个工作日”）。但跨库无关提问时，因检索得分（~0.38）高于默认 `answer_min_score=0.2`，未触发检索层 `refused=True` 徽标，而是由 DeepSeek 用英文拒答并附带了无关分块引用（见 `F-002`） |
| E unsupported upload | Pass | 上传 `.exe` 与空 `.md` 均被服务端 HTTP 400 拦截（未产生脏数据或卡死 Worker），但报错文案为未本地化的英文（见 `F-005`） |

### Evaluation compare

| | topK=4 (`6209b1e8`) | topK=8 (`25522d5a`) |
|--|--------|--------|
| Overall feel | 检索命中率 `100.0%`，引用准确度 `85.4%`，正确性 `100.0%`，有据性 `89.4%`，平均耗时 `3,531 ms`，总成本 `$0.003594` | 检索命中率 `100.0%`，引用准确度 `85.4%`，正确性 `100.0%`，有据性 `88.0%`，平均耗时 `4,788 ms`，总成本 `$0.003561` |
| Notable metric deltas | 基线（4 个召回片段已覆盖小型知识库所需证据） | `topK=8` 把全部 6 篇文档塞入上下文，导致有据性（Groundedness）微降 `-1.4%`，平均延迟上升约 `+1.25s` |
| Failed cases to investigate | **EC-03 / EC-06**：`citation_accuracy` 为 `0.3333` / `0.5000`，因 `02-pricing.md` 与 `04-integrations-faq.md` 均包含“Free 不支持 Zendesk”，模型合理引用了多篇文档，但用例仅填了 1 个 `expectedSourceDocument`。<br>**EC-09（跨库年假）**：`refused_count=0` 且 `groundedness=0.2000`，因模型用英文拒答且未触发检索层 `refused=True`（见 `F-002`、`F-003`）。 | 与 `topK=4` 表现一致 |

### UX / i18n

- `/zh/...` 主路径与 `/en/...` 抽样页面整体翻译完整，无死链或白屏。
- 发现若干路由与文案摩擦（详见 `F-004` 至 `F-008`）：Server Action `redirect()` 跳转后地址栏丢失 `/zh` 前缀（依赖 Cookie 维持中文渲染）、顶栏缺少 `知识库` 与 `助手` 常驻导航入口、API 错误消息未国际化、仪表盘底部中文句子末尾残留英文句号 `.`、预估成本因保留 2 位小数在低单价模型下显示为 `US$0.00`。

## Findings

| ID | Sev | Area | Summary | Issue URL (P0) |
|----|-----|------|---------|----------------|
| F-001 | P1 | Feedback | **多轮对话下 Feedback 显示的“问题”错误绑定为会话标题（首问）**：`listFeedback` 与 `getFeedback` 读取的是 `conversations.title` 而非该条回答对应的 `ragTraces.query` 或上一条 `USER` 消息，导致多轮对话第 N 轮的反馈在后台全部显示为第 1 轮的问题。 | — |
| F-002 | P1 | RAG / Refusal | **跨知识库无关问题未触发 `refused=True` 徽标且模型用英文拒答**：`qwen3-embedding-8b` 对任意中文文本的余弦相似度普遍在 `0.35–0.55`，高于默认 `answer_min_score=0.2`；无关问题进入 LLM 后，因 `answer.py` 的 System Prompt 为英文，DeepSeek 输出英文 `"I don't have enough information..."` 并引用了 `[1]..[5]`，且 `refused` 仍为 `False`。 | — |
| F-003 | P1 | Evaluation Metrics | **评测分词正则 `[a-z0-9]+` 忽略中文字符**：`services/ai/app/evaluation/metrics.py` 的 `normalize_tokens` 仅提取英文与数字，导致纯中文文本在计算 `expectedAnswer` 词重叠与 `groundedness` 时丢失全部中文词元（仅靠英文术语/数字计算）。 | — |
| F-004 | P2 | i18n / Routing | **Server Action 重定向后浏览器 URL 丢失 `/{locale}` 前缀**：`createKnowledgeBaseAction`、`createEvaluationDatasetAction`、`triggerEvaluationRunAction` 调用 `next/navigation` 的 `redirect("/...")` 未带 locale，虽有 `NEXT_LOCALE` Cookie 保持中文渲染，但 URL 栏变成了无 `/zh` 前缀路径。 | — |
| F-005 | P2 | i18n / API Errors | **上传与对话 API 路由返回的错误文案仍为英文硬编码**：例如上传 `.exe` 返回 `"Unsupported file type..."`，上传空文件返回 `"File is empty"`，直接展示在中文 UI 中。 | — |
| F-006 | P2 | UX / Navigation | **顶栏导航缺少“知识库”与“助手（Chat）”常驻入口**：顶栏仅有 `追踪 / 反馈 / 评估 / 用量 / 审计 / 设置`，从子页面想去 `知识库` 或 `Chat` 必须先点左上角回工作区首页。 | — |
| F-007 | P2 | UX / Cost Display | **Dashboard 与 Usage 页面的预估成本固定 `maximumFractionDigits: 2`**：DeepSeek 单次问答成本约 `$0.0004`，累计 8 次问答（`$0.0035`）在仪表盘和用量页被四舍五入显示为 `US$0.00`，与 Trace 页的 `$0.000468`（6 位小数）产生割裂。 | — |
| F-008 | P2 | UX / Minor Polish | **细微交互与文案瑕疵**：① 默认工作区名称固定为英文 `"{Name}'s Workspace"`；② 仪表盘底部 `打开审计日志.` 末尾硬编码了英文句号；③ 设置页修改工作区名称点击“保存更改”后缺少“已保存”状态提示。 | — |

## Known gaps observed (expected)

- [x] No invite / role UI（本轮通过 SQL 挂载 ADMIN）
- [x] 单篇文档删除按钮尚未在 UI 暴露（仅支持整库删除）

## Follow-ups

1. **修复 P1 核心体验与算法问题**：
   - 将 Feedback 列表与详情的“问题”字段改为关联 `rag_traces.query`（或前序 `USER` 消息），修复多轮会话反馈错位（`F-001`）。
   - 优化 `services/ai/app/rag/answer.py` 与检索阈值：支持中英文自适应拒答 Prompt、识别模型拒答语义并标记 `refused=True`（拒答时清空无关 citations），同时调优或开放 `answer_min_score` 配置（`F-002`）。
   - 升级 `services/ai/app/evaluation/metrics.py` 与 `chunking.py` 的中文分词/Token 估算能力，并引入可选的 LLM-as-a-Judge（`F-003`）。
2. **修复 P2 国际化与导航摩擦**：
   - 在顶栏导航补齐 `助手` 与 `知识库` 入口（`F-006`），修复 Server Action 重定向 locale 前缀（`F-004`）、API 错误码国际化（`F-005`）及成本小数位展示（`F-007`）。
3. **推进下一阶段架构演进**：
   - 引入 Hybrid Search（向量 + 全文检索 RRF）与 Reranker，打通“负向 Feedback 一键转 Evaluation Case”的运营闭环。
