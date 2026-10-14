# dsh-traffic-liability 交通事故定责插件

DeepSeek Harness 的仓库外插件。把「知行」交通事故分析助手的六阶段流程搬进 Harness：模型通过四个工具完成登记、材料整理、通行义务、行为分析、因果分析和责任建议，程序负责结构、引用、法条身份、S/C 评分规则和责任情景一致性的校验，法规库复用原项目已核验的官方原文。

结果是 AI 辅助分析和定责参考，不是事故认定书、处罚决定或赔偿比例。

## 目录

```text
traffic-liability-plugin/
  cordis.yml          开发期 overlay，绝对路径指向 src/index.ts
  cordis.patch.yml    bundle 层，dsh plugin add 安装后启用
  package.json        bundle 清单（dsh.bundle）
  src/index.ts        插件入口：Config、提示词段落、四个工具
  src/prompt.ts       模型可见的分析方法论
  src/schema.ts       六阶段结构契约与结构校验器
  src/engine.ts       案件存储与引用、一致性校验
  src/laws.ts         法规库：条号身份、候选检索、全文读取、原文哈希
  tests/smoke.ts      无需 API Key 的冒烟测试
  data/laws/          法规数据（rules.json 必需，catalog.json、annotations.json 可选）
```

## 开发运行

从仓库根目录启动 Web 界面并挂载插件：

```sh
pnpm dsh web --patch ./traffic-liability-plugin/cordis.yml
```

启动会自动打开浏览器，加 `--no-open` 可以关闭。插件挂载成功的直接证据是 overlay 配置的案件目录 `.cases/` 在启动时被创建。

法规数据随插件放在 `data/laws/`，复制自原项目已核验的文件：实施条例全文和安全法第四十四条、第五十六条，共 118 条。原项目更新法规后重新复制一次即可：

```sh
cp /Users/wilsonxu/NewTrafficAgent/data/laws/{rules,catalog,annotations}.json traffic-liability-plugin/data/laws/
```

## 工具与流程

| 工具 | 作用 |
| --- | --- |
| `traffic_case_read` | 读取案件概览、已采纳事实、有效上游结果、各阶段必填字段和法规库摘要；省略 caseId 列出案件 |
| `traffic_case_save` | 校验并保存一个阶段的结果；首次保存 registration 不传 caseId 即新建案件 |
| `traffic_rule_search` | 精确身份或关键词检索候选法条，返回候选卡；缺条返回 `not_in_library` |
| `traffic_rule_read` | 按 ruleId 读取完整原文、款项、版本、来源和原文哈希 |

阶段顺序固定：registration、evidence、duties、faults、causation、liability。保存成功后下游已有结果标为 stale。有 blocking 待查事项的阶段状态为 `needs_investigation`，责任建议中受影响的一方必须保持“暂无法判断”。

校验失败以错误返回给模型并说明修正方向，例如引用不存在的事实、把许可条款写成已违反、引用法条库中不存在的原文片段、未知作用分写成 0。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `lawDataDir` | 包内 `data/laws` | 法规数据目录，缺少 rules.json 时加载失败 |
| `caseDir` | 当前目录 `.traffic-liability` | 案件 JSON 文件目录 |
| `promptOrder` | `6000` | 方法论段落在系统提示词中的顺序 |

## 打包分发

```sh
pnpm -C traffic-liability-plugin run build                        # tsdown 打包到 lib/index.js
pnpm dsh --profile <name> --from-default-profile web              # 可选：从 web 模板新建 profile
pnpm dsh plugin --profile <name> add ./traffic-liability-plugin
pnpm dsh --profile <name> --dump-config | grep -A2 traffic-liability
pnpm dsh --profile <name> --no-open --port 0                      # 验证加载，--port 0 由系统选空闲端口
pnpm dsh plugin --profile <name> remove dsh-traffic-liability     # 卸载
```

安装是 link 到本仓库 checkout，宿主包仍按源码方式解析，所以要在源码启动方式下使用。bundle 读取包内 `data/laws`，案件默认写到当前目录的 `.traffic-liability`。

注意两种运行方式读取的代码不同：安装模式加载的是构建产物 `lib/index.js`，改完 `src/` 必须重新执行上面的 build 并重启 `dsh web` 才会生效；开发期 overlay（`--patch`）直接读 `src/`，改完只需重启。

## 验证

```sh
node --import tsx traffic-liability-plugin/tests/smoke.ts
npx tsc -p traffic-liability-plugin/tsconfig.json 2>&1 | grep '^traffic-liability-plugin/'
```

冒烟测试覆盖：条例第七十条的精确身份检索、缺条返回 `not_in_library`、关键词检索、全文读取、登记与材料阶段的结构和引用校验、伪造原文片段被拒绝、许可条款写成违反被拒绝、重存上游后下游标 stale。它不调用模型。

类型检查通过路径映射把宿主包的源码一起编入；vendor 目录的源码在本插件的编译选项下会报与插件无关的错误，所以只看 `traffic-liability-plugin/` 开头的行，没有输出即通过。

## 与原项目的差异

- 材料不由插件解析。模型用宿主的文件读取工具读取材料，在 evidence 的 `materials` 和 `observations` 中登记来源与位置。
- 没有补问状态机。模型在回复中直接向用户提问，evidence 的 `openQuestions` 只记录事项。
- 没有报告导出和历史快照。案件文件只保留当前版本，下游失效用 stale 标记。
- 原项目按规则 ID 硬编码的借道校验改为按法律与条号判断。
- 事发日期未知不再阻断责任等级：跳过法条效力核对，保存结果会提示在 limitations 中注明未核对版本。原项目在缺日期时拒绝给等级。

## 当前限制

- 只验证了冒烟测试覆盖的路径，尚未在真实模型下走通完整六阶段。
- 安装进 profile 的是指向本仓库 checkout 的 link，宿主包按源码方式解析；发布到 npm 或打包 tarball 前还需验证脱离仓库的安装。



## TODO

增加内容提示补充，对责任定责起到重要关系的，没有明确，给问题让用户来补充

增加复核责任的功能，并且给出复核书，找一下复核书的模板
