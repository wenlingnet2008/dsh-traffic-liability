# dsh-traffic-liability 交通事故定责插件

DeepSeek Harness 的仓库外插件。把「知行」交通事故分析助手的六阶段流程搬进 Harness：模型通过七个工具完成登记、材料整理、关键事实补问、通行义务、行为分析、因果分析和责任建议，程序负责结构、引用、法条身份、S/C 评分规则和责任情景一致性的校验，法规库包含原项目已核验的通行规则，以及官方公开的事故处理程序规定。复核模块独立保存交警认定书和异议分析，并生成《道路交通事故认定复核申请书》。

结果是 AI 辅助分析和定责参考，不是事故认定书、处罚决定或赔偿比例。

## 目录

```text
traffic-liability-plugin/
  cordis.yml          开发期 overlay，绝对路径指向 src/index.ts
  cordis.patch.yml    bundle 层，dsh plugin add 安装后启用
  package.json        bundle 清单（dsh.bundle）
  src/index.ts        插件入口：Config、提示词段落、七个工具
  src/prompt.ts       模型可见的分析方法论
  src/schema.ts       六阶段结构契约与结构校验器
  src/engine.ts       案件存储与引用、一致性校验
  src/questions.ts    关键问题去重、回答历史、补问状态和证据草稿
  src/review-model.ts 复核资料、分析契约和资料补问
  src/review.ts       复核校验、保存和版本导出
  src/review-document.ts Word 与文字预览共用正文
  src/laws.ts         法规库：条号身份、候选检索、全文读取、原文哈希
  tests/smoke.ts      无需 API Key 的冒烟测试
  tests/questions.ts 补问与重分析集成测试
  tests/tools.ts     已注册工具与输出 schema 的源代码/构建产物测试
  data/laws/          法规数据（rules.json 必需，catalog.json、annotations.json 可选）
```

## 开发运行

插件新增运行依赖 `docx`（已锁定版本）。首次使用先在插件目录执行 `npm ci --workspaces=false --ignore-scripts`，再从 Harness 仓库根目录启动 Web 界面并挂载插件：

```sh
pnpm dsh web --patch ./traffic-liability-plugin/cordis.yml
```

启动会自动打开浏览器，加 `--no-open` 可以关闭。插件挂载成功的直接证据是 overlay 配置的案件目录 `.cases/` 在启动时被创建。

法规数据随插件放在 `data/laws/`：实施条例现行全文 115 条（另保留第十五条历史文本）、《道路交通安全法》第一条至第一百二十四条全文，共 240 条；加上《道路交通事故处理程序规定》全文 114 条，共 354 条。复核标注覆盖第七十一至七十九条及第一百一十二条。程序规定来源、版本及检索时点均保存在法规目录中。更新原项目法规时应合并，直接覆盖这些文件会丢失新增程序规定。

重新导入法规时，先保存官方网页 HTML，再执行 `python3 scripts/import-procedures.py /path/to/official.html` 或 `python3 scripts/import-safety-law.py /path/to/official.html`。导入器检查全文条号连续完整，失败时不写入法规库；安全法导入器保留已有要件说明并导入第一条至第一百二十四条。

## 工具与流程

| 工具 | 作用 |
| --- | --- |
| `traffic_case_read` | 读取案件概览、已采纳事实、有效上游结果、补问状态、证据草稿、阶段摘要和法规库摘要；省略 caseId 列出案件；传 stage 查询该阶段格式与业务约束，传 reviewSection 查询复核格式 |
| `traffic_case_save` | 校验并保存一个阶段的结果；首次保存 registration 不传 caseId 即新建案件 |
| `traffic_case_answer` | 保存用户补充回答或“不清楚”；明确回答及撤回会触发证据更新与下游重分析 |
| `traffic_rule_search` | 精确身份或关键词检索候选法条，返回候选卡；缺条返回 `not_in_library` |
| `traffic_rule_read` | 按 ruleId 读取完整原文、款项、版本、来源和原文哈希 |
| `traffic_review_save` | 保存复核资料 intake 或六方面分析 analysis；首次 intake 可独立新建案件 |
| `traffic_review_export` | 生成带占位符的草稿或资料齐备的待签版 Word，以及相同文字预览 |

阶段顺序固定：registration、evidence、duties、faults、causation、liability。保存成功后下游已有结果标为 stale。有 blocking 待查事项的阶段状态为 `needs_investigation`，责任建议中受影响的一方必须保持“暂无法判断”。

`traffic_case_save` 的输入校验失败返回 `saved:false`、`code:validation_failed`、`errors`，不写入案件、不更新 revision、不使下游失效，首次登记失败也不会留下空案件。每项错误有 `path`、`message`，引用错误另含错误 ID、允许的引用集合或来源；`missingValues` 列出缺失 ID，`relatedPaths` 定位上游原因。最多返回 12 项错误、每项引用列表最多展示 20 项，省略数单独列出。结构合法后，证据记录、法律匹配、过错评价、因果分析、责任卡片、情景、排除说明与待查事项中的独立错误集中收集；依赖无效引用的检查停止，避免误报。存储损坏、读写失败和程序异常仍抛出错误，不能视为普通输入问题。

首次处理阶段前，调用 `traffic_case_read({stage:"registration"})`（替换为当前阶段）读取 `stageContract[stage]`；无需先建案，传入 stage 时仅查询格式并忽略 caseId。结果含 `requiredFields`、紧凑的 `schema`、`notes` 及当前阶段的业务约束 `rules`：`key?: type` 为可选字段、`a | b` 为枚举、`type | null` 为可空、`type[]` 为数组、`{...}` 为嵌套对象；联合类型的数组元素用括号分组。方括号注明 minLength/maxLength、pattern、min/max、minItems/maxItems；对象禁止额外字段，minLength 按去除首尾空白后的长度校验，maxLength 按原文长度校验。普通列表和读案只含六阶段字段摘要，不重复加载完整阶段或复核格式。

保存前按 schema 和 rules 构造完整 payload，不用空对象试探。例如 duties 的 `issues[].affectedIds` 只能引用当前 `duties[].id`，不是 legalMatches 或 relations 的 ID；要件 unknown 必须引用未知或争议事实，全部要件满足后才能用 applicable。校验失败时集中修正 errors 后重新提交，并检查 saved；工具结果已给出修正依据，不要求模型搜索插件源码。可空对象缺字段时，错误信息列出缺失字段并注明“也可以为 null”。不能通过编造事实、删除必要分析或改为 null 绕过业务约束。

因果作用无法判断用 `conclusion:undetermined` 和 `contribution.score:null`；该状态形成调查阻断，不能作为分责或主结论免责依据。`not_established` 表示已有 `exclusionFactIds` 的已采纳事实排除该原因，不能仍有影响该原因的上游待查条件或非 supplementary 缺项。减速、停车、未变道或横向接触本身都不能直接排除观察、反应迟延或速度的事故作用。不能形成合理主情景时，可保存 `recommendationType:undetermined`、各方“暂无法判断”、`primaryScenarioId:null`、空 `scenarios/exclusions` 和说明限制的 `limitations`，先完成受限分析再补问。

证据阶段未更新，却在 faults 删除过错或待查条件，或在 causation 取消必要时间、参数、专业审核、降低缺项等级或改成确定结论时，须填写可选字段 `revisionBasis:{reason,factIds}`。程序检查理由非空、事实均已采纳；正常纠正可以沿用已有事实，未解决的上游缺项仍约束下游。此检查保留可追溯的修正依据，不能自动判断文字理由或物理推断是否充分。旧案可继续读取，但既有结论不会自动复核；重新提交时适用当前规则。

自定义工具调用方须检查 `saved`，复核格式改用显式查询；从 0.1.3 更新的步骤见[升级说明](docs/upgrade-guide/v0.1.3/stage-validation/guide.zh.md)。

用户对视频或照片的文字描述仍是当事人陈述，materials 与 observations 均保留 statement 及 speaker；只有实际读取原始影像才能登记 video/photo 和客观观察，最终回答也须保留来源区别。程序可检查已登记材料及引用的一致性，不能独立证明模型确实读取过原件。

## 关键事实补问

当某项未明确的事实可能改变通行义务、过错或因果作用时，模型将其记录为未知事实及问题。`evidence.openQuestions` 每项包含 `itemId`、`partyId`、`prompt`、`impact`、`factIds`；旧案件未填写 `factIds` 的问题仍可读取。程序也会从行为框架的 `unknownFactIds`、法律要件和过错评价中的未知事实生成问题候选，合并不同阶段引用的同一事实，优先处理 blocking 问题。普通细节、法条缺失和专业鉴定不作为用户补问。

例如：“乙的原车道是否被停放车辆占用到不能通行？”同时解释：“无法通行时需核对受阻借道许可和机动车减速让行义务；仍可通行时该许可条件可能不成立。”模型先保存现有可形成的六阶段结果，再每次最多提出三个后续问题，允许回答“不清楚”，不要求答完全部问题才查看分析。

读取或保存案件返回 `clarification`：

| 状态 | 下一步 |
| --- | --- |
| `needs_answers` | 存在未答的 blocking 事故事实，受影响部分保持暂无法判断；先保存可形成的分析，再展示后续问题 |
| `needs_reanalysis` | 使用 `evidenceForUpdate` 更新事实并保存 evidence，再按阶段顺序重新分析 |
| `limited` | 存在未答的条件性事实、申请资料或已答但未解决的事项；允许先给出附条件建议或“暂无法判断”，不重复追问“不清楚” |
| `complete` | 当前记录没有未解决的补问事项，继续分析；该状态不代表责任已经确定 |

收到用户回答后，调用 `traffic_case_answer`。以下是参数示例，实际内容必须来自用户：

```json
{
  "caseId": "案件ID",
  "answers": [
    {
      "itemId": "road.nonmotor_passable",
      "status": "answered",
      "answer": "非机动车道被停放的小汽车完全堵住，无法从原车道通过。",
      "speaker": "甲"
    }
  ]
}
```

每次提交 1 至 3 项，用户只回答一题时只保存该题，其余保持待回答。`partyId` 是问题涉及的一方，`speaker` 是实际回答者。回答为“不清楚”时用 `status: "unknown"`，事实保持未知且以后不再重复询问；用户后来主动补充或更正可再次提交，旧回答保留在 `answerHistory` 中。重复提交同一回答不会重复保存或使阶段再次失效。

明确回答不会直接变成确定事实或责任结论。程序保存原话和回答者，将 evidence 及所有已保存的下游阶段标为 stale，并提供带新增陈述材料和观察记录的 `evidenceForUpdate` 草稿。模型须将回答引用到原关联事实，按影像对照与事实采纳规则更新事实及行为框架；程序拒绝遗漏回答、改写原话或丢失关联事实的 evidence。存在相反证据时保留 disputed，不能仅凭补充回答覆盖影像。将明确回答撤回为“不清楚”也会触发重新分析。

`pendingCount` 统计全部未答事项；`pendingFactCount`、`pendingBlockingCount`、`pendingConditionalCount`、`pendingIntakeCount` 分别统计事故事实、其中的关键阻断、条件性事实和申请资料。仍有未答或未解决的事故事实时，程序拒绝无条件的确定建议，但允许通过情景及因果校验的条件性建议或“暂无法判断”，并要求 limitations 说明限制。申请资料不限制事故分析或复核意见，仍由申请书待签版检查完整性。既有 blocking 与因果校验继续限制受影响的一方。案件 JSON 中的回答历史可在重启后恢复，旧案件没有回答字段时按现有阶段资料生成问题。

## 官方事故认定书复核

复核对象是交警出具的事故认定书，文书输出为当事人的《道路交通事故认定复核申请书》。它与公安机关出具的复核结论书不同；申请人自行签署并提交。

推荐流程：先用宿主工具读取认定书全文，再调用 `traffic_case_read({reviewSection:"intake"})` 获取 `reviewContract.intake`，按格式保存 `traffic_review_save(section=intake)`；分析格式用 `reviewSection:"analysis"` 获取。格式查询无需 caseId，传入时忽略，reviewSection 与 stage 互斥。首次 intake 可省略 caseId 独立建案，随后分析、回答、导出均使用同一 caseId。生成草稿无需先完成六阶段；重新评价因果作用或责任等级时须有有效六阶段分析。

`intake` 的字段如下，所有字段均须传入，未知字符串用 `null`，数组可为空（原文结论至少一项）：

| 字段 | 内容 |
| --- | --- |
| `applicant` | kind（individual/organization）、name、identityNumber、address、phone、details、representative；最后六项允许 null，组织完整文书要求代表人 |
| `original` | number、authority、issuedOn、servedOn（允许 null）；source、text（原文）；conclusions（id、locator、quote、responsibility） |
| `accidentSummary`、`userRequest` | 事故基本经过及用户明确的具体请求，未知为 null |
| `receivingAuthority`、`applicationDate` | 上一级公安机关交通管理部门名称、拟申请日期，未知为 null |
| `priorReview` | none（未申请）、submitted（已提交）、concluded（已有结论）或 unknown |
| `evidence` | id、title、source、locator、quote、availability（available/to_obtain） |

所有日期使用有效的 YYYY-MM-DD，原文引文须确实存在于 `original.text`。原认定结论独立保存，不自动采纳为事故事实。证据摘录及位置由模型读取用户材料后登记，程序不独立解析或鉴真。

`analysis` 包含 `summary`、`assessments` 和 `questions`。每个审查方面 facts、evidence、law、causation、liability、procedure 至少一项。意见包含 id、category、status、originalConclusionIds、evidenceIds、factIds、legalRefs（ruleId、quote、sourceUrl）、reasoning、applicationText。supported 表示有来源的异议理由，pending 表示待核实，insufficient 表示依据不足；只有 supported 填写申请书理由正文，其余 applicationText 必须为 null。引用的事实须有效，确定意见不能依赖争议事实、未知事实或未取得证据；法条引文及来源须与法规库匹配。因果或责任等级的确定复核意见还须对应有效六阶段结果。questions 每项含 itemId、question、impact、factIds。

补问优先核对送达日期和既往复核情况，每批最多三题，沿用 `traffic_case_answer` 保留回答者及原话。`target=review_intake` 的回答仅更新文书资料并使复核分析及旧文书过期；`target=fact` 的回答进入原有证据核对流程并使相关阶段及复核失效。用户“不清楚”仍保留未知，停止重复追问；更正答案或资料后可重新分析。

资料不足时调用 `traffic_review_export({caseId, mode:"draft"})`，得到 Word、文字预览及缺项；补齐后使用 `mode:"complete"` 生成待签版。完整模式要求有效复核分析、有依据理由、可提交主要证据、必要申请资料，且不存在待核实意见或待重审事实。已申请复核或状态未知只允许草稿；具体责任等级请求还需有依据的责任分析。complete 表示文书资料齐备，不表示已经确认受理或按时提交。

`review` 保存 intake、analysis、状态及 exports；上游资料变动后旧分析和已有文书标为 stale。文件位于 `<caseDir>/exports/<caseId>/`，名称包含草稿/待签版、来源版本和唯一 ID；每次导出不覆盖旧文件。生成后模型应调用宿主 `present` 展示 Word。当前使用宿主可访问的本地文件路径，需要启用宿主的 tool-present；该工具未提供时仍返回路径和文字预览。

程序依据：[官方公开的《道路交通事故处理程序规定》](https://szjj.sz.gov.cn/ZWGK/ZCFG/ZCFKS/JTSGYW/content/post_4458457.html)。申请期限为送达之日起三个工作日，同一事故复核一次；可经原机关或直接向上一级公安机关交通管理部门提出。程序条文按申请日期检索（`asOf` 优先于事发日期；指明程序法规并传 caseId 时默认使用拟申请日期）；通行规则按事故日期核对。未知日期不会补造，工具不自动计算节假日调休后的截止日期。

模板结构参考：[律师教你怎么做的公开范本](https://wjorg.com/template/jiaotong-fuhe-shenqing)，仅供参考，不构成正式法律意见，不是全国统一官方表格。插件根据法定要求独立撰写措辞；默认请求依法审查并责令原办案单位重新调查、认定，不虚构有利责任等级或声称申请已按时提交。可编辑空白模板和来源说明见 [data/templates](data/templates/README.md)。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `lawDataDir` | 包内 `data/laws` | 法规数据目录，缺少 rules.json 时加载失败 |
| `caseDir` | 当前目录 `.traffic-liability` | 案件 JSON 文件目录 |
| `promptOrder` | `6000` | 方法论段落在系统提示词中的顺序 |

## 打包分发

### GitHub 安装

```sh
dsh plugin --profile desktop add github:wenlingnet2008/dsh-traffic-liability
```

GitHub 安装会执行 `prepack` 构建脚本。若 pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，将错误输出中的完整包键加入 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 的 `allowBuilds`，然后重试；使用其他 profile 或自定义 `DSH_HOME` 时修改对应文件。例如，pnpm 11.28.5 对提交 `26867af0d5f8a4aa1d767727a492fc99cbb77027` 给出的配置为：

```yaml
allowBuilds:
  "dsh-traffic-liability@https://codeload.github.com/wenlingnet2008/dsh-traffic-liability/tar.gz/26867af0d5f8a4aa1d767727a492fc99cbb77027": true
```

保留文件中的原有设置；已有 `allowBuilds` 时在其下合并条目。授权键格式随 pnpm 版本变化，应以实际错误输出为准；URL 中的提交改变后需要重新授权。不要全局放开依赖构建脚本。

旧提交 `26867af` 未声明构建依赖 `tsdown`，仅授权仍会出现 `tsdown: command not found`；`abd0b1d` 的 `tsconfig: false` 仍会触发底层构建工具自动寻找开发配置，在独立安装时报 `Tsconfig not found`。需安装包含构建修复的新提交，或使用下面的预构建 tarball。当前源码声明独立构建所需的 `tsdown`，并显式使用 `tsconfig.build.json`，打包时不读取相邻 Harness 的 tsconfig。

### 预构建 tarball

在插件目录执行以下命令，生成可直接交付的 npm tarball 和 SHA-256 校验文件：

```sh
npm ci --workspaces=false --ignore-scripts
npm run pack:tarball
# dist/dsh-traffic-liability-0.1.3.tgz
# dist/dsh-traffic-liability-0.1.3.tgz.sha256
```

`prepack` 会自动重新构建 `lib/index.js`，直接执行 `npm pack` 或 `pnpm pack` 也会先构建。`pack:tarball` 额外检查分发文件清单并写入校验文件，可传目录参数：`npm run pack:tarball -- /path/to/output`。打包使用当前源码，包括尚未提交的修改。

包内包含 JavaScript 运行代码、法规数据、可编辑 Word/文字模板、bundle patch、说明与升级指南；不包含案件、上传材料、测试样例或源码。`docx` 为普通运行依赖，安装时由包管理器下载，因此该 tarball 不是完全离线安装包。`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery` 声明为可选 peer，由运行中的 Harness 共享提供，避免安装另一份宿主服务。

兼容范围为 `^0.1.5-rc.2 || ^0.2.0-rc.2`，已通过 `0.1.5-rc.2` 和 `0.2.0-rc.2` 的实际安装及工具测试。Harness 0.2 会按宿主 peer 范围跳过不兼容插件，本版已更新声明。正式版 `0.2.0` 包含在声明范围内；截至 2026-10-15 尚未公开发布，运行验证使用公开的 `0.2.0-rc.2`。

接收方需要已安装的 DeepSeek Harness、Node.js 22.19+ 的 22.x 或 24+、pnpm。无需插件源码、TypeScript 或构建工具。在 tarball 所在目录安装到已有的 Web profile（以下用 `web`）：

```sh
# macOS / Linux，可选：核对校验文件
shasum -a 256 -c dsh-traffic-liability-0.1.3.tgz.sha256
dsh plugin --profile web add ./dsh-traffic-liability-0.1.3.tgz
dsh --profile web --dump-config
dsh --profile web
```

`--dump-config` 应包含 `id: traffic-liability` 和 `name: dsh-traffic-liability`。安装时自动启用 bundle 层；正在运行的 Harness 需重启。Windows 也可使用相同的 `dsh` 安装命令，校验可用 `Get-FileHash .\dsh-traffic-liability-0.1.3.tgz -Algorithm SHA256`。升级时安装新版本 tarball；卸载执行 `dsh plugin --profile web remove dsh-traffic-liability`，案件文件仍由 `caseDir` 保存。

tarball 安装会复制包内构建产物，不链接源码目录。法规默认读取包内 `data/laws`，案件默认写到启动时当前目录的 `.traffic-liability`。为保留历史案件，重启和升级时应沿用原工作目录或显式配置原 `caseDir`。

维护者可在仓库外临时 profile 验证真实安装、卸载、七个工具、法规及 Word 导出：

```sh
npm run test:tarball
# 另一个已构建或已安装的 Harness：第二个参数是其 @deepseek-ai/dsh 包目录
npm run test:tarball -- ./dist/dsh-traffic-liability-0.1.3.tgz /path/to/dsh-package
```

验证使用临时 `DSH_HOME`，通过已构建的 `dsh` CLI 安装并加载 tarball，结束后清理；默认使用相邻 Harness 的 `apps/cli/lib/bin.js`。测试安装禁用生命周期脚本，确保接收方不需要安装时构建。测试使用各版本宿主的公开接口共享依赖：0.1 使用模块回退，0.2 使用 `createRuntimeResolution` 和 `PluginPackages` 服务；同时检查 0.2 的 bundle 兼容性判定，验证全部七个工具、补问后重分析、法规及 Word 导出。

源码开发仍可从 Harness 根目录执行 `pnpm dsh plugin --profile web add ./traffic-liability-plugin`，此形式会 link 到 checkout；从源码运行 Harness 时把上面的 `dsh` 命令改为 `pnpm dsh`。

安装模式加载构建产物 `lib/index.js`：修改 `src/` 后需重新打包、安装并重启；checkout link 模式需重新 build 并重启。开发期 overlay（`--patch`）直接读 `src/`，改完只需重启。

## 验证

```sh
pnpm -C traffic-liability-plugin test
pnpm -C traffic-liability-plugin run build
node --import tsx traffic-liability-plugin/tests/tools.ts --built
npx tsc -p traffic-liability-plugin/tsconfig.json 2>&1 | grep '^traffic-liability-plugin/'
```

冒烟测试覆盖：条例第七十条的精确身份检索、缺条返回 `not_in_library`、关键词检索、全文读取、登记与材料阶段的结构和引用校验、伪造原文片段被拒绝、许可条款写成违反被拒绝、重存上游后下游标 stale。它不调用模型。

补问测试覆盖：优先级与跨阶段去重、最多三题、部分回答与不清楚、回答批次失败不产生部分写入、保留原话和陈述主体、影像对照、下游失效与重分析、回答更正及撤回、定责前的补问限制和旧案件读取。工具测试通过实际注册的工具运行补问闭环，并校验返回值符合输出 schema；`--built` 验证安装模式加载的构建产物。复核测试覆盖独立导入、原文及法规引用、六方面契约、资料回答与事实回答分流、旧结果失效、重复申请限制、缺项草稿、完整导出和 Word/预览正文一致。所有测试不调用真实模型。

类型检查通过路径映射把宿主包的源码一起编入；vendor 目录的源码在本插件的编译选项下会报与插件无关的错误，所以只看 `traffic-liability-plugin/` 开头的行，没有输出即通过。

## 与原项目的差异

- 材料不由插件解析。模型用宿主的文件读取工具读取材料，在 evidence 的 `materials` 和 `observations` 中登记来源与位置。
- 补问状态由案件中的分析缺项与持久化回答共同生成；模型在对话中展示问题和记录答案，不依赖专用问卷页面。
- 复核申请书支持 Word 导出，每次生成独立版本并记录是否过期；六阶段分析仍保留当前版本，尚无完整案件快照。
- 原项目按规则 ID 硬编码的借道校验改为按法律与条号判断。
- 事发日期未知不再阻断责任等级：跳过法条效力核对，保存结果会提示在 limitations 中注明未核对版本。原项目在缺日期时拒绝给等级。

## 当前限制

- 自动化验证覆盖程序校验和工具补问闭环；真实会话已走通六阶段，但减少校验重试的效果仍须在安装更新并重启后用新会话验证。文书必要字段由程序生成补问，但未被模型记录为关键未知事故事实的缺项无法由程序独立识别；自然语言提问及回答对应关系仍依赖模型。
- tarball 支持脱离插件 checkout 安装，仍依赖兼容的 Harness 提供宿主服务；尚未验证所有 Harness 版本及打包可执行程序的组合。
