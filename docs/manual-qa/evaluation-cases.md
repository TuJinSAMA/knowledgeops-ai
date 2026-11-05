# Evaluation cases — NimbusDesk 客服回归

录入 **Evaluations → dataset → cases** 时使用本表。  
`expectedSourceDocuments`：入库后把对应文档的 **document id**（UI/详情里能看到的话）填进去；若 UI 只认文件名或不强制，可先留空，靠 `requiredFacts` / `expectedAnswer` 判。

建议 dataset 名称：`NimbusDesk 客服回归`  
绑定 / 运行时知识库：`NimbusDesk 客服知识`（以产品实际「run 选 KB」交互为准）。

Compare：同一 dataset 两次 run，仅改 `topK`（**4** vs **8**）。

---

## Case table

| ID | Question | expectedAnswer（要点） | requiredFacts（每行一条，录入时按 UI） | Tags | Notes |
|----|----------|------------------------|----------------------------------------|------|-------|
| EC-01 | 云席（NimbusDesk）是做什么的产品？ | 面向客服/成功团队的知识问答与工单辅助类 SaaS（按语料表述） | 云席；客服；知识库 | smoke, overview | Happy |
| EC-02 | Pro 套餐的月费是多少？包含几个座席？ | 月费 ¥899；含 5 个座席 | ¥899；5 个座席 | pricing | Happy |
| EC-03 | Free 套餐有什么限制？ | 仅 1 座席；知识库文档上限 20；无 Zendesk 集成 | 1 座席；20；无 Zendesk | pricing | Happy |
| EC-04 | 购买后多少天内可以全额退款？ | 购买后 7 天内可申请全额退款 | 7 天；全额退款 | refund | Happy |
| EC-05 | 如何申请退款？要发邮件到哪里？ | 需发邮件至 billing@nimbusdesk.example | billing@nimbusdesk.example | refund | Happy |
| EC-06 | 是否支持与 Zendesk 集成？怎么开启？ | 支持；在设置 → 集成中连接 Zendesk | Zendesk；设置；集成 | integrations | Happy |
| EC-07 | 单次回答大约会引用多少个知识片段？有上限吗？ | 默认检索 topK 相关；产品说明里写明单次上下文最多使用 8 个片段（按语料） | 8 个片段 | limits | Happy |
| EC-08 | 我们 500 人团队的企业定制年费是多少？ | 应无法从知识库得出具体报价；理想：拒答/资料不足，不编造数字 | （无） | refuse, gap | **应拒答**；若模型编造价格 → P1 |
| EC-09 | 年假有多少天？入职满一年吗？ | 主 KB 无制度内容；应拒答或不足，不应答「10 个工作日」等制度原文 | （无） | cross-kb, refuse | 对比 Chat D1；制度答案只在 HR KB |
| EC-10 | Starter 和 Pro 的差价是多少？谁含优先支持？ | Pro 比 Starter 贵 ¥600/月（899-299）；优先支持仅 Pro | ¥600；优先支持；Pro | pricing, confuse | 易混档位 |

---

## Optional extras (if time)

| ID | Question | Intent |
|----|----------|--------|
| EC-11 | 退款是否包含已经使用的座席费用？ | 命中退款政策中「已使用周期不退」类表述 |
| EC-12 | 支持 Slack 双向同步吗？ | 语料写「仅通知单向」——防过度承诺 |

---

## After runs — quick scorecard

| Run | topK | Status | Notes (hit rate / correctness / latency feel) |
|-----|------|--------|-----------------------------------------------|
| #1 (`6209b1e8`) | 4 | COMPLETED | Hit rate `100.0%`, Citation `85.4%`, Correctness `100.0%`, Groundedness `89.4%`, Avg latency `3,531 ms`, Cost `$0.003594` |
| #2 (`25522d5a`) | 8 | COMPLETED | Hit rate `100.0%`, Citation `85.4%`, Correctness `100.0%`, Groundedness `88.0%` (`-1.4%`), Avg latency `4,788 ms`, Cost `$0.003561` |
| Compare | — | Pass | 对于当前体量的客服知识库，`topK=4` 比 `topK=8` 更优（命中率已达 100%，且噪音更少、Groundedness 高 1.4%、延迟快约 1.25 秒） |
