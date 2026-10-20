---
kind: upgrade-guide
description: 阶段保存校验失败改为返回未保存结果，复核格式需要显式查询。
---

# 阶段校验与复核格式查询

## 变更

从插件 0.1.3 升级后，`traffic_case_save` 对不合法的 payload 返回 `{saved:false, code:"validation_failed", errors, totalErrors, omittedErrors, correction, stage}`，不再抛出异常。这类结果不会写入案件。程序及存储异常仍然抛出，成功保存的字段保持原样。阶段格式查询增加说明业务校验的 `rules`。

普通 `traffic_case_read` 不再包含 `reviewContract`。通过 `reviewSection:"intake"` 或 `reviewSection:"analysis"` 查询单个复核格式；此参数与 `stage` 互斥，无需案件 ID。已保存的案件无需迁移。

## 迁移

1. 调用方先检查 `saved`，再判断阶段是否完成。按返回的字段路径修正并重新提交；工具执行完成本身不代表 payload 已保存。
2. 将隐式获取 `reviewContract` 改为 `traffic_case_read({reviewSection:"intake"})` 或相应的 analysis 查询。
3. 重新构建并安装插件，完全重启 Harness 后新建会话。确认 `traffic_case_read({stage:"duties"})` 返回 `rules`，普通读案不含 `reviewContract`。

本地验证在插件目录运行 `npm test`、`npm run build` 和 `node --import tsx tests/tools.ts --built`。
