---
kind: upgrade-guide
description: 阶段保存校验失败改为返回未保存结果，复核格式需要显式查询。
---

# 阶段校验与复核格式查询

## 变更

从插件 0.1.3 升级后，`traffic_case_save` 对不合法的 payload 返回 `{saved:false, code:"validation_failed", errors, totalErrors, omittedErrors, correction, stage}`，不再抛出异常。这类结果不会写入案件。程序及存储异常仍然抛出，成功保存的字段保持原样。阶段格式查询增加说明业务校验的 `rules`。

普通 `traffic_case_read` 不再包含 `reviewContract`。通过 `reviewSection:"intake"` 或 `reviewSection:"analysis"` 查询单个复核格式；此参数与 `stage` 互斥，无需案件 ID。已保存的案件无需迁移。

责任校验集中收集参与方、情景及排除说明中的独立错误。错误使用字段路径，`missingValues` 列出缺失 ID，`relatedPaths` 定位上游阻断。每个引用列表最多展示 20 项并列出省略数，响应仍最多返回 12 项错误。

因果结论增加 `undetermined`，表示作用未知且 `score:null`。`not_established` 现在要求已采纳的排除事实，且过错及相关缺项中没有影响该原因的未决条件。未知作用不能作为分责或主结论免责依据。证据阶段未更新时，删除过错条件或放宽因果调查要求、缺项与结论，须填写 `revisionBasis:{reason,factIds}` 并引用已采纳事实。允许用已有事实明确纠正原判断，未解决的上游事项仍约束结论。此检查记录修正依据，不能判断文字理由是否充分。

## 迁移

1. 调用方先检查 `saved`，再判断阶段是否完成。按返回的字段路径修正并重新提交；工具执行完成本身不代表 payload 已保存。
2. 将隐式获取 `reviewContract` 改为 `traffic_case_read({reviewSection:"intake"})` 或相应的 analysis 查询。
3. 重新构建并安装插件，完全重启 Harness 后新建会话。确认 `traffic_case_read({stage:"duties"})` 返回 `rules`，普通读案不含 `reviewContract`。
4. 依据不足时使用因果结论 `undetermined`，不要标为已排除。旧案重新计算因果与责任结果；原结论可读取，不会自动复核。未更新证据却放宽既有要求的纠正须填写 `revisionBasis`。
5. 一次修正责任校验报告的全部字段。事实不足以支持合理主情景时，保存 `recommendationType:undetermined`、各方“暂无法判断”、`primaryScenarioId:null`、空 scenarios/exclusions 和说明限制的 limitations；先完成受限分析再补问，不为取得等级改写上游要求。

本地验证在插件目录运行 `npm test`、`npm run build` 和 `node --import tsx tests/tools.ts --built`。
