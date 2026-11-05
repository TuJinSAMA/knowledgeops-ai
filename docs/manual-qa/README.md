# Manual QA — Enterprise scenario round

本目录是一轮**企业级使用场景手动测试**的输入与输出产物。目标不是替代单元测试，而是用真实模型走完「SaaS 客服知识助手」故事，并记录体验与缺口。

## Goals (priority)

1. **Primary — enterprise credibility**：故事是否站得住（开通 → 知识 → 问答引用 → 运营闭环）
2. **Baseline — MVP loop**：真实模型下闭环必须跑通
3. **Interleaved — UX**：摩擦点随手记（文案、跳转、中英文、信息架构）
4. **Sampled edges**：拒答 / 缺知识 / 错答反馈 / 跨 KB；非法上传顺手 1 次  
   **Out of scope this round**：配额打满、停 worker / 断 AI

## Scenario

| Item | Choice |
|------|--------|
| Main story | 虚构 SaaS「NimbusDesk（云席）」客服知识助手 |
| Secondary | 2–3 篇内部制度文档（跨 KB 抽查） |
| Doc language | 中文 |
| UI locale | 主路径 `/zh/...`；收尾约 10 分钟抽 `/en/...` |
| Models | Real：`AI_PROVIDER=openrouter` + `LLM_PROVIDER=deepseek` |
| Runtime | Local three processes（web / ai / worker） |
| Accounts | OWNER + ADMIN（第二账号 SQL 挂入同一 workspace） |
| Eval compare | Same dataset；`topK=4` vs `topK=8` |
| Destructive ops | Only on temporary `tmp-*` objects |

## Pass criteria

**Baseline (all must pass)**  
注册与双账号、建双 KB、入库至 `INGESTED`、问答+引用、打开 trace、提交并审反馈、evaluation 两次跑完并可 compare、dashboard / usage / audit 可打开。

**Primary (graded)**

- 可信
- 基本可信但有摩擦
- 尚不足对外讲

Suggested bar for「可信」：底线全过 + 无未解释 P0 + P1 ≤ 3（且有说法）。

**Severity**

| Level | Meaning |
|-------|---------|
| P0 | 阻断闭环 |
| P1 | 企业叙事受损 |
| P2 | 体验摩擦 |

Findings IDs：`F-001`, `F-002`, …  
P0 → 当场建 GitHub issue；P1/P2 → 先留在 `test-report.md`。

## Files in this folder

| Path | Role |
|------|------|
| `scenario-script.md` | 开测步骤（OWNER / ADMIN 分工） |
| `evaluation-cases.md` | 评估题库（录入 UI 用） |
| `fixtures/` | 上传语料 |
| `test-report.md` | 测完填写的报告模板 |

## Preflight checklist

Before the half-day session:

- [ ] `apps/web/.env` 与 `services/ai/.env`：真实 provider + key；`INTERNAL_API_TOKEN` 一致；`FILE_STORAGE_DIR` 为**同一绝对路径**
- [ ] Postgres + Redis 已起；`pnpm db:migrate` 已跑过
- [ ] 三终端：`pnpm dev:web` / `pnpm ai:dev` / `pnpm ai:worker`
- [ ] `curl http://localhost:3000/api/health` 与 `curl http://localhost:8000/health` 正常
- [ ] 用一篇最小 md 上传，确认能到 `INGESTED` 后再进主剧本
- [ ] 两个浏览器配置（或普通 + 隐身）准备好

## Suggested half-day timeline

| Block | Time | Focus |
|-------|------|--------|
| 0 | 15–20m | Preflight + 最小入库冒烟 |
| 1 | 30–40m | OWNER：双 KB + 上传语料 |
| 2 | 10m | 挂 ADMIN |
| 3 | 45–60m | ADMIN：chat 主故事 + A–D + E |
| 4 | 20–30m | Feedback review + trace 抽查 |
| 5 | 30–40m | Evaluation ×2 + compare |
| 6 | 15–20m | Dashboard / usage / audit；tmp 删除 |
| 7 | 10m | English UI sample |
| 8 | 20–30m | Fill `test-report.md` + file P0 issues |
