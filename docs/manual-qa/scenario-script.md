# Scenario script — NimbusDesk（云席）客服知识运营

**Workspace under test:** 用 OWNER 注册后得到的默认 workspace（记下 `workspaceSlug`）。  
**UI：** 主路径使用 `/zh/{workspaceSlug}/...`。  
**Browsers：** Profile A = OWNER；Profile B = ADMIN。

---

## 0. Preflight

1. 确认三进程与两边 health（见 `README.md`）。
2. OWNER 登录后上传 `fixtures/saas/00-smoke-ping.md` 到任意临时 KB 或稍后主 KB，确认 `INGESTED`。
3. 记录环境：

| Field | Value |
|-------|-------|
| Date | |
| Git SHA / branch | |
| workspaceSlug | |
| AI_PROVIDER / EMBEDDING_MODEL | openrouter / qwen3-embedding-8b（以 .env 为准） |
| LLM_PROVIDER / model | deepseek / deepseek-chat（以 .env 为准） |
| Locales tested | zh (main), en (sample) |

---

## 1. OWNER — 开通与语料

### 1.1 账号与 workspace

1. Profile A 打开 `http://localhost:3000/zh/sign-up`，注册 OWNER。
2. 确认进入 dashboard：`/zh/{workspaceSlug}`。
3. （可选）Settings 重命名 workspace，刷新后 slug/名称表现是否符合预期。

### 1.2 创建知识库

创建两个 KB（名称建议）：

| KB name | Purpose |
|---------|---------|
| `NimbusDesk 客服知识` | 主场景 |
| `内部制度（抽查）` | 跨 KB |
| `tmp-delete-me` | 仅用于删除抽查（可最后建） |

### 1.3 上传主 KB 语料

上传 `fixtures/saas/`（除 `00-smoke-ping.md` 可跳过若已冒烟）：

- [ ] `01-product-overview.md`
- [ ] `02-pricing.md`
- [ ] `03-refund-policy.md`
- [ ] `04-integrations-faq.md`
- [ ] `05-known-limits.txt`
- [ ] （可选）将任一 md 导出为 PDF 再上传，覆盖 PDF 路径

等待全部 `INGESTED`。任一 `FAILED` → 记 **P0**，看 worker 日志与 trace/job 错误。

### 1.4 上传制度 KB

上传 `fixtures/hr/`：

- [ ] `01-leave-policy.md`
- [ ] `02-expense-policy.md`
- [ ] `03-vpn-access.md`

全部 `INGESTED`。

### 1.5 临时 KB（删除用）

1. 建 `tmp-delete-me`，上传任意一篇短 md。
2. **先不删**；放到第 6 节再删。

---

## 2. 挂载 ADMIN

1. Profile B 注册第二个用户（会自带一个无关的默认 workspace，可忽略）。
2. 在 Postgres 执行（把邮箱与主 workspace slug 换成你的）：

```sql
-- Resolve IDs
SELECT id, email FROM "user" WHERE email = 'admin@example.com';
SELECT id, slug, name FROM workspaces WHERE slug = 'YOUR_WORKSPACE_SLUG';

-- Attach as ADMIN (skip if row already exists)
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES (
  (SELECT id FROM workspaces WHERE slug = 'YOUR_WORKSPACE_SLUG'),
  (SELECT id FROM "user" WHERE email = 'admin@example.com'),
  'ADMIN'
);
```

3. Profile B 登录后，用 Workspace switcher 切到**主测 workspace**。
4. 确认侧栏可见 Feedback / Evaluations / Audit 等运营入口；顶栏 role 显示 `ADMIN`。

---

## 3. ADMIN — Chat 主故事与边界抽样

以下均在 **Chat**，先选对 KB。

### 3.1 Happy path（主 KB）

| # | Question (ask in Chinese) | Expect |
|---|---------------------------|--------|
| H1 | 云席是做什么的？主要给谁用？ | 有依据的概述 + citations |
| H2 | Pro 版每月多少钱？包含多少座席？ | 命中定价文档 |
| H3 | 订阅后多久可以退款？怎么申请？ | 命中退订/退款政策 |
| H4 | 支持跟 Zendesk 集成吗？ | 命中集成 FAQ |

对 H1 或 H2：点 **View trace**，检查 retrieved chunks / scores / context / tokens / latency。

### 3.2 Edge A — 应拒答

| # | Question | Expect |
|---|----------|--------|
| A1 | 我们公司 500 人，企业定制报价是多少？ | 拒答或明确资料不足，**不应编造报价** |

### 3.3 Edge B / C — 反馈

| # | Action | Expect |
|---|--------|--------|
| B1 | 问一个文档没有的制度细节（在主 KB 下问请假天数）→ 标 **missing knowledge** | 可提交 |
| C1 | 对一条不够好的回答标 **not helpful** 或 **wrong answer**（可附简短说明） | 可提交 |

### 3.4 Edge D — 跨 KB

| # | Setup | Question | Expect |
|---|-------|----------|--------|
| D1 | KB = 客服知识 | 年假有多少天？ | 不应拿客服文档编造；宜拒答/不足 |
| D2 | KB = 内部制度 | 同样问年假 | 应命中请假制度 + 引用 |
| D3 | KB = 内部制度 | Pro 版价格？ | 不应从制度库编造定价 |

### 3.5 Edge E — 非法上传（顺手 1 次）

OWNER 或 ADMIN（需 ADMIN+）在任一 KB 尝试上传：空文件、或 `.exe` / 无扩展名等不支持类型。

记录：前端是否拦截、是否出现混乱 `FAILED`、文案是否可理解。→ 多为 P2；若导致 worker 挂起则升 P0/P1。

---

## 4. ADMIN — Feedback 运营

1. 打开 **Feedback** 列表，应能看到 B1/C1（及你点的 helpful）。
2. 进入详情：更新 review status + failure reason（按 UI 可选值）。
3. 体验记录：信息是否够判断「下一步改知识还是改检索」。

---

## 5. ADMIN — Evaluation + compare

1. 建 dataset，例如：`NimbusDesk 客服回归`。
2. 按 `evaluation-cases.md` 录入 **EC-01 … EC-10**（至少 8 条；建议 10）。
3. 触发 run #1：`topK = 4`，等到完成。
4. 触发 run #2：`topK = 8`，等到完成。
5. 打开 **Compare**，记录指标差异与页面可读性。
6. 抽 1–2 个失败/低分 case，对照 Chat/Trace 看是否同因。

---

## 6. Dashboard / Usage / Audit + 临时删除

1. Dashboard：指标是否更新、是否空洞。
2. Usage：token/配额展示是否可理解。
3. Audit（ADMIN）：筛选与上传/建 KB/触发 eval 等相关记录是否存在。
4. 删除 `tmp-delete-me` KB（或临时 case）：确认成功；audit 是否有对应记录（无则记缺口，非必 P0）。

---

## 7. English UI sample（~10 min）

将同一 workspace 关键路径切到 `/en/{workspaceSlug}/...`，快速点：

- [ ] Chat
- [ ] Knowledge bases
- [ ] Traces
- [ ] Feedback
- [ ] Evaluations / compare
- [ ] Audit

记录：明显未翻译、locale 丢失、死链、中英文混杂是否影响理解。

---

## 8. Wrap-up

1. 填写 `test-report.md`。
2. 每个 **P0** 建 GitHub issue，正文引用 `F-xxx`。
3. 给出主目标三档结论之一。

---

## Known gaps (do not treat as surprises)

- 无成员邀请 / 改角色 UI（本轮用 SQL）
- 无 SSO、API keys、计费、第三方 connector
- 删除文档能力可能未提供（以 UI 为准）
- Reranker / query rewrite / LLM-as-judge 非本轮焦点
