# dsh-scribe

**DSH 的「书记官」：跨会话记忆 + 本地知识库。数据默认只存在你这台机器上，云端同步是可选项，数据迁移必须你点头。**

会话结束，它把这次定下的东西记下来；下次开会话，它替你翻出来；工作区里的文档，它顺手编成目录供检索。**记什么、存在哪、发给谁，全部由你决定。**

> Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — local-first by default, cloud optional, migration always user-approved.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-1.0.0-blue.svg)](package.json)
[![test](https://github.com/zcd0818/dsh-scribe/actions/workflows/test.yml/badge.svg)](https://github.com/zcd0818/dsh-scribe/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

---

## 它解决什么问题

AI 编程助手没有记忆：每个新会话都从零开始，你昨天定下的架构决策、踩过的坑、约定的代码规范，今天要重新讲一遍。

把记忆放在云端能解决这个问题，但代价是**你的对话内容会离开这台机器**——包括密钥路径、客户名、内部接口。很多托管方案还是默认开启的，你不一定意识到它在传。

这个插件的立场很简单：

- **默认不联网。** 记忆是 `~/.dsh/memory/memories.jsonl` 里的纯文本，零依赖、零服务端，拔网线也能用。
- **出网是你决定的。** 只有你配置了云端后端或嵌入端点，数据才会离开本机；每个出网动作都在下面「数据流向」里写清楚了。
- **迁移不自动。** 换存储后端不会偷偷搬数据，必须你在审批框里点同意，而且可回滚。

## 它做什么

| 时机 | 行为 | 预算 |
|---|---|---|
| 会话开始（`agent/created`） | 检索同项目 + 最近的记忆，注入 system prompt 的 `memory:context` section | 5 条 / ≤1200 字符 |
| 会话进行中 | 模型按需调用 `memory_search` / `memory_save` / `memory_list` / `memory_forget` | 按需 |
| 会话结束（`agent/disposed`） | 把这次会话压成一条记忆写回 | 1 条 |
| 知识库（可选） | 索引工作区 `kb/` 与全局资料（文本、代码、Word/Excel/PPT）；会话开始注入目录摘要，模型按需 `kb_search` / `kb_read` | 目录摘要 ≤1100 字符 |
| 你想换后端 | `memory_migrate` → 审批 → 写日志 → `memory_migrate_rollback` | 一次 |

会话结束时的压缩是有区分的：**少于 10 轮**的对话直接保留最后几段原文（便宜、不丢细节）；**更长的**对话交给会话本来就在用的模型，压成「项目在做什么、定了什么、为什么、还欠什么」的一段话。

注入量与会话长度无关，不会越用越贵。

### 30 秒看它长什么样

它没有自己的界面，记忆就是磁盘上的纯文本：

```bash
$ cat ~/.dsh/memory/memories.jsonl
{"id":"mem_mvqil36h_7c9ac9b6","content":"决定：默认本地 JSONL 存储，会话开始注入 5 条记忆到 system prompt，迁移必须经审批","createdAt":1793095200089,"source":"session-summary","tags":["project:dsh-memory","decision"],"schemaVersion":1}
```

查询和状态走斜杠命令或模型工具：

```
> /memory status
后端: local (local)
记忆条数: 1
可用性: 正常
嵌入: lexical fallback
自动注入: 开启
时间范围: 2026-10-27 至 2026-10-27
数据目录: /Users/you/.dsh/memory
```

模型在会话里也能自己翻：

```
memory_search("上次部署脚本怎么写的")
→ 1. [2026-10-25] (project:infra) 部署走 deploy.sh，先用 staging 验证再 promote…
```

## 左侧菜单栏入口（可选）

设置 → 记忆与知识库 → 概览里有一个开关：**在主页左侧菜单栏显示「记忆与知识库」**。

- 打开后，左下角菜单会多一行入口，点开是一个独立页面（和「插件」「任务看板」同级，容器、高亮、折叠都由外壳提供）；
- 关掉只是隐藏入口，记忆和知识库照常工作；
- **改完立即生效，不用重启** —— 同一个模块同时持有入口和页面，开关是就地挂载/卸载。

## 知识库：资料是资料，记忆是记忆

两件事分开存，因为它们的真相来源不同：

| | 记忆 | 知识库 |
|---|---|---|
| 谁写入 | 插件自动（会话结束） | **你自己维护的文档**，插件只读 |
| 形态 | 一段结论 | 按标题切块，带原文行号 |
| 回答什么 | 「上次定了什么」 | 「这条规则原文在哪」 |
| 同步 | 插件自己的后端 | **Git** —— 文档本来就该进版本控制 |

两个作用域，工作区优先：

- **工作区**：当前项目目录下的 `kb/`（默认 `kb`，可改）。沿用你在 `AGENTS.md` 里定的约定：`INDEX.md` 一行一条、排除 `原始/` 和 `inbox/`、引用写成 `kb/路径.md#L行号`。
- **全局**：`~/.dsh/memory/kb/global/`，跨项目共享的资料。往目录里放 `.md` 就会进索引。

两处目录都能换：

- 工作区行上的「更换目录」→ 选一个文件夹，只对那一个工作区生效（写进 `knowledgeBase.workspace.overrides`），可「恢复默认」；
- 全局卡片的「更换目录」→ 写进 `knowledgeBase.global.root`。

**上传文件**：知识库分页顶部是一块拖拽投放区（也可以点击选择文件），先选目标（全局或某个工作区），再把文件拖进去或点选。文件写进目录后会立刻重建索引。

**二进制文档会抽正文**：`.docx` `.xlsx` `.pptx` 是 Office Open XML（一个装满 XML 的 ZIP），插件用**内置解析器**读出正文再切块索引——零依赖、跨平台，不需要你机器上装 Word、LibreOffice 或任何命令行工具。`.pdf` 是唯一真正需要解析器的格式，作为**可选依赖** `pdfjs-dist` 处理：装了就用，没装就跳过并给出原因（不会偷偷索引空内容）。

直接索引的类型：`.md` `.markdown` `.mdx` `.txt` `.rst` `.csv` `.tsv` `.json` `.jsonl` `.yaml` `.yml` `.toml` `.ini` `.conf` `.sql` `.html` `.css` `.js` `.mjs` `.ts` `.tsx` `.jsx` `.vue` `.py` `.go` `.rs` `.java` `.kt` `.rb` `.php` `.sh`；需要抽正文的类型：`.docx` `.xlsx` `.pptx`（内置）、`.pdf`（可选依赖）。默认排除 `原始/`、`inbox/`、`node_modules/`、`dist/`、`build/` 以及各语言锁文件。

文件名会去掉路径部分，`../` 这类穿越会被削成纯文件名，且落点一定在该知识库目录内。

会话开始时注入的是**目录摘要**（优先读 `INDEX.md`，没有就退回文件列表），不是全文；模型需要细节时用 `kb_search`，拿到 `kb/设计规范.md#L12-L40` 这样的引用后，用 `kb_read` 读原文行号再引用。

索引是派生数据，放在 `~/.dsh/memory/kb/indexes/`，**不会改你的文档**；过期自动重建（默认 TTL 300 秒），也可以在设置页「知识库」分页手动重建。

只用 Markdown / 纯文本就能工作，**不需要任何额外服务**。Word / Excel / PowerPoint 的正文抽取也是内置的；只有 PDF 需要可选依赖 `pdfjs-dist`。

## 数据默认留在本机

这是本插件与其他记忆方案的核心差别。**默认配置下，没有任何数据离开这台机器**——下面是完整的出网清单，没有隐藏项：

| 动作 | 出网？ | 发到哪里 |
|---|---|---|
| 保存记忆（默认 `local`） | ❌ 否 | 仅 `~/.dsh/memory/memories.jsonl` |
| 会话开始注入 | ❌ 否 | 从本地文件读 |
| `memory_search`（未配嵌入端点） | ❌ 否 | 本机词法打分 |
| `memory_search`（配了 `embedding.endpoint`） | ⚠️ 是 | 只发送待检索的记忆文本，到你自己填的 `/v1/embeddings` 地址 |
| 检索重排（默认开） | ⚠️ 是 | 只把**查询 + 候选记忆摘要**发给当前会话模型，8 秒超时，失败退回原序 |
| 长对话摘要（默认开） | ⚠️ 是 | 把对话发给当前会话模型（本来就在用它，没有新增接收方） |
| 迁移到 `bailian` | ⚠️ 是 | 把选中的记忆发到阿里云百炼记忆库 |
| ChromaDB 引擎 | ⚠️ 是 | 发到你自建的 Chroma 服务地址 |

想彻底离线：把 `retrieval.llmRerank` 和 `summarization.shortTurns` 调成「不触发模型」，并不要配 `embedding.endpoint`。

## 安装

从 npm（1.0.0 起）：

```
dsh plugin --profile <profile> add dsh-scribe
```

本机已有 checkout 时（DSH 原生方式）：

```
plugin_manager · action: install_bundle · target: /绝对路径/dsh-scribe
```

返回 `application: applied` 即生效，无需重启页面（改的是 Host 行为）。卸载：

```
plugin_manager · action: remove_bundle · target: dsh-scribe
```

> **改名说明**：本插件原名 `dsh-memory-plugin`（行 id `dsh-memory`），现为 `dsh-scribe`（行 id `dsh-scribe`）。
> 数据目录 `~/.dsh/memory` 与记忆文件格式都没变，**已有记忆不需要迁移**；
> 但如果你之前装过旧名版本，请先 `remove_bundle` 掉旧的 `dsh-memory` 行再装新的，否则会挂载两次。

开发：本插件是纯 ESM、**零运行时依赖**，`node --test` 就能跑，不需要构建步骤。

## 配置页面（推荐）

安装后打开 DSH **设置**，左侧会多出 **记忆与知识库** 一页，四个分页：

| 分页 | 能做什么 |
|---|---|
| 概览 | 运行状态（后端、条数、时间范围、可用性、数据目录）、界面入口开关、数据边界说明 |
| 记忆 | 按关注点分五组：**记忆后端**（写入位置、注入开关与上限）、**本机存储**（目录、引擎）、**阿里云百炼记忆库**（凭据与隔离键）、**检索**（重排开关、检索策略、语义嵌入两个子组）、**会话摘要与留存**；底部统一保存与连通性测试 |
| 知识库 | **索引状态**（每个工作区与全局共用一张表：目录、文件数/块数、更新时间、重建/更换目录）、**上传文件**、**使用方式** |
| 数据迁移 | 目标后端 → 生成计划（条数/大小/时间范围/样例）→ 确认执行 → 进度 → 迁移记录与撤销 |

后端的无关字段不会出现：选 `local` 时不显示百炼凭据，选 `bailian` 时不显示本机目录——减少每页的干扰项。

页面写的是 profile 配置，保存后插件立即重新挂载，不必手改 YAML。几条它坚持的规则：

- **API Key 只写不读**：页面只显示「已保存」，输入框留空表示保持不变。
- **迁移必须先看计划再确认**：确认按钮用的是后端签发的一次性 token（5 分钟有效、用后作废），跳过页面直接调接口也绕不过去。
- **接口只认同源请求**：外来 `Origin` 或 `sec-fetch-site: cross-site` 一律 403。

页面走插件自己的本地接口（前缀 `/dsh-scribe/api`），不经过任何第三方。

## 配置（YAML）

不想用页面也可以直接写在 DSH profile 的 `cordis.patch.yml`（或本包的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-scribe
      name: 'dsh-scribe'
      config:
        defaultProvider: local          # 新记忆写到哪
        autoInject: true                # 会话开始是否注入
        autoSave: true                  # 会话结束是否写回
        injectLimit: 5
        injectMaxChars: 1200

        providers:
          local:
            type: local
            path: '~/.dsh/memory'
            engine: file                # file（默认，零依赖）| chromadb（需自建服务端）

          bailian:                      # 可选：阿里云百炼记忆库
            type: bailian
            apiKey: 'env:BAILIAN_API_KEY'
            workspaceId: 'llm-xxxxxxxxxxxx'
            userId: dsh
            planVersion: pro

          hybrid:                       # 可选：云端主 + 本地镜像
            type: hybrid
            primary: bailian
            mirror: local

        embedding:                      # 可选：配了才有语义检索
          endpoint: 'https://api.deepseek.com/v1'
          apiKey: 'env:EMBEDDING_API_KEY'
          model: text-embedding-v3

        retrieval:
          mode: hybrid                  # recent | lexical | vector | hybrid
          minScore: 0.18
          llmRerank: true

        summarization:
          shortTurns: 10                # 少于这么多轮 → 抽取式
          maxChars: 320

        retention:
          maxMemories: 5000
          ttlDays: 0                    # >0 时过期即删
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultProvider` | `local` | 新记忆写入的后端 |
| `autoInject` / `autoSave` | `true` / `true` | 两个自动化开关，可单独关 |
| `includeSubagents` | `false` | 子代理是否也注入/记录 |
| `dataDir` | `~/.dsh/memory` | 向量缓存与迁移日志所在目录 |
| `retrieval.mode` | `hybrid` | 无向量时自动等价于 `lexical` |
| `retrieval.llmRerank` | `true` | 候选多于结果数时用会话模型重排 |
| `retention.maxMemories` | `5000` | 超出按时间淘汰最旧 |
| `ui.sidebar` | `true` | 是否在左侧菜单栏放入口 |
| `knowledgeBase.enabled` | `true` | 知识库总开关 |
| `knowledgeBase.workspace.overrides` | `{}` | 按工作区路径覆盖知识库目录 |
| `knowledgeBase.workspace.root` | `kb` | 相对会话工作目录 |
| `knowledgeBase.workspace.include` | 30 种文本/代码扩展名 | 只索引 UTF-8 文本，二进制格式跳过 |
| `knowledgeBase.workspace.exclude` | `原始/`、`inbox/`、锁文件等 | 投放区与原始资料默认不进知识库 |
| `knowledgeBase.extract.enabled` | `true` | 是否抽取二进制文档正文 |
| `knowledgeBase.extract.documents` | `.docx .xlsx .pptx .pdf` | 需要抽取正文的扩展名 |
| `knowledgeBase.global.root` | `<dataDir>/kb/global` | 留空即默认位置 |
| `knowledgeBase.chunk.maxChars` | `1200` | 单块上限，超出按空行切分 |
| `knowledgeBase.refreshSeconds` | `300` | 索引 TTL，过期自动重建 |

`apiKey` 支持四种写法，避免把密钥写进仓库：字面量、`$VAR`、`${VAR}`、`env:VAR`。

## 使用

- **什么都不用做**：新会话自动带上记忆。
- **要改设置**：设置 → 记忆与知识库（见上）。
- **让它记住**：说「记住这个」，或 `/memory save 提交前必须跑 node --test`。
- **主动查**：`/memory search 部署脚本`，或直接问模型。
- **看状态**：`/memory status` / `list` / `providers`。
- **换后端**：

  ```
  /memory migrate bailian          # 只打印计划，不动数据
  /memory migrate bailian --yes    # 执行，写可回滚日志
  /memory rollback mig_xxxxxx      # 撤销这次迁移新增的记录
  ```

  模型自己调 `memory_migrate` 时会弹审批框；你拒绝 = 零写入。

## 后端选择

| 后端 | 数据在哪 | 需要什么 | 适合谁 |
|---|---|---|---|
| `local` + `file` | 本机 JSONL | 无 | 默认，绝大多数人 |
| `local` + `chromadb` | 本机 Chroma 服务 | 自建 Chroma + `chromadb` 包 | 已有向量基础设施 |
| `bailian` | 阿里云百炼记忆库 | 业务空间 ID + API Key | 要跨设备、信得过阿里云 |
| `hybrid` | 云端主 + 本地镜像 | 上面两者 | 要跨设备但怕断网丢上下文 |

换后端不需要改代码，也不需要重开会话。

## 数据迁移的安全设计

迁移是这个插件里唯一会「批量搬运你的数据」的操作，所以它被设计成四道闸：

1. **先看后动**：`memory_migrate` 第一步只生成计划（多少条、时间范围、目标现状），不写入。
2. **审批门**：真正执行前走 DSH 的 approval 服务弹框，**拒绝即零写入**；没有审批服务时直接失败（fail-closed，不会悄悄继续）。
3. **只增不删**：迁移只往目标端新增，源端一条不动。
4. **可回滚**：日志记下目标端真实写入的 id（百炼会自己生成 node id），`memory_migrate_rollback` 只删这些新增记录，不碰目标端原有数据。

## 隐私与权限

- 每条记忆就是一小段你可以直接读的文字，没有隐藏字段、没有埋点。
- 插件不收集任何遥测；不请求网络权限之外的系统权限。
- 记忆写回发生在会话销毁时，内容是「这次会话的结论」，不是整段聊天记录。
- 不内置任何托管记忆服务作为默认路径；要用云端，你得自己填凭据。

## 兼容性

**插件声明**

| 项目 | 要求 |
|---|---|
| DSH | 需要提供 `systemPrompt` 与 `tools` 两个服务（核心行，所有组合都有）；其余服务全部可选 |
| Node | ≥ 20（只用到 `node:` 内置模块；无原生模块、无构建步骤） |
| 平台 | macOS / Linux / Windows 保持一致行为：不调用任何系统命令，不探测本机安装 |

**可选服务与降级行为**

| 服务 | 缺失时 |
|---|---|
| `webServer` | 设置页没有数据接口；工具、注入、命令照常工作 |
| `configEditor` | 设置页只读（不能保存），仍可用 YAML 配置 |
| `workspaceRegistry` | 知识库分页只显示全局作用域；会话仍按自己的工作目录索引 |
| `approval` | `memory_migrate` **拒绝执行**（fail-closed），不会静默迁移 |
| `llm` | 长对话摘要退回抽取式；检索重排退回词法顺序 |
| `commands` | 没有 `/memory` 命令，工具仍可用 |
| `webServer` 的 `webServer.register` 迟到 | 路由等待服务出现再注册；页面刷新后可用 |

客户端侧只依赖 `slots`；`uiWorkspace` 缺失时「更换目录」退回手动输入路径。

## 已知限制

1. **首条消息的注入有竞态**：section 的文本提供者是同步的，为不让第一步等磁盘，注入靠 `agent/created` 时的异步预热。预热没赶在第一次 prompt 组装前完成，第一条消息就看不到记忆（第二条起正常），此时仍可用 `memory_search`。
2. **百炼适配器未用真实凭据联调**：按官方文档契约实现（`/add`、`/memory_nodes/search`、`GET /memory_nodes`、`DELETE /memory_nodes/{id}`），有 stub 单测覆盖，但真实环境的行为请以你的账号为准；`memory_status` 会显示可达性。
3. **ChromaDB 是可选依赖**：需要另装 `chromadb` 并自建服务端，本插件不捆绑；未安装时报错明确，不影响文件引擎。
4. **部分失败时日志只记条数**：后端只回报失败条数时，`failedIds` 可能为空（`failedCount` 仍准确）；已写入的 id 一定精确，所以回滚可靠。
5. **没有 schemastery 配置表单**：插件详情页不会自动生成表单（那样需要引入 `schemastery`）；所有配置在「记忆与知识库」页面里图形化编辑，或直接写 YAML。
6. **PDF 抽取需可选依赖**：`pdfjs-dist` 未安装时 PDF 会被跳过并在页面说明原因；`.docx`/`.xlsx`/`.pptx` 不受影响。
7. **界面文案是中文**：设置页与提示目前只有中文，没有走 Client 的 locale 服务；插件标题/描述有中英两份。英文界面欢迎 PR。
8. **首次索引有一次性成本**：工作区文件多时第一次索引需要几秒；之后按 mtime 增量，只有改动过的文件会重新切块。

## 开发

```bash
git clone https://github.com/zcd0818/dsh-scribe.git && cd dsh-scribe
node --test test/*.test.js        # 零依赖，无需 npm install
```

CI 在 GitHub Actions 上跑三个平台 × 两个 Node 版本（ubuntu / macos / windows × Node 20 / 22），矩阵配置见 `.github/workflows/test.yml`

114 个测试覆盖：配置校验、中文分词与词法打分、JSONL 持久化与墓碑删除、按 tag 过滤与分页、去重与检索、prompt 长度约束、迁移计划（只读）、执行与日志、回滚只删本次新增、两种摘要策略与降级、挂载冒烟、百炼 wire 契约（stub fetch）、本地接口（同源校验、计划 token、单次使用、回滚、延迟注册）、知识库（标题切块与行号、glob 排除、增量复用与删除、引用格式、作用域排序、按行读取、目录摘要、peek 不构建、全局目录自动创建、上传落盘与路径穿越削减、目录切换与恢复默认、默认支持的文件类型边界）、文档抽取（内置 ZIP 读取、docx 段落、xlsx 共享字符串、pdf 缺失依赖时跳过、kb_read 读抽取正文）、发布前不变量（无本机路径、无调试残留、导入可解析、样式类齐全、清单导出完整）、健壮性（缺服务可挂载、坏索引可重建、不可读/超大文件跳过、并发索引共享一次构建）、界面结构（列表栅格列数恒定、空态与超长路径不破版）、以及四个分页的无浏览器渲染冒烟。

```
index.js                  插件入口（apply：装配 config → service → 会话层/工具/命令）
src/config.js             配置解析与校验（~ 和 $ENV 展开）
src/memory-service.js     门面：去重、嵌入、保留、模型重排、prompt 渲染
src/store.js              JSONL 追加存储（墓碑删除、原子重写、写串行化）
src/embeddings.js         可选 /v1/embeddings 客户端 + 磁盘向量缓存
src/providers/            base（契约+统一排序）/ local / chroma / bailian / hybrid / factory
src/session/              lifecycle（注入与回写）/ summarize（两种摘要策略）
src/tools/                memory-tools（模型工具，含迁移审批）/ commands（/memory）
src/migration/            migrate（计划→执行→日志→回滚）
src/kb/                   chunk（按标题切块+引用）/ indexer（增量索引）/ service（双作用域检索）/ tools（kb_*）
src/web/                  api（设置页本地接口：同源校验 + 计划 token）/ config-store（读写 profile 配置）
client.js                 设置页（React，注入 settings.section，三个分页）
```

## 路线图

- [ ] 首次使用引导：检测到已有记忆时，交互式提示选择后端，而不是让你先改 YAML
- [ ] 记忆「为什么被记住」溯源：`memory_list` 里回链到来源会话
- [ ] 冲突解决：同一主题的新旧记忆并存时，标出可能过期的条目
- [ ] 记忆浏览：在设置页里直接看/搜/删单条记忆（目前只有 `memory_list` 工具与 `/memory list`）
- [ ] PDF 抽取开箱可用（目前需可选依赖 `pdfjs-dist`；Word/Excel/PPT 已内置）
- [ ] 知识库向量检索（当前是词法打分；嵌入端点复用记忆那套）
- [ ] 更多后端：自建 OpenAI 兼容向量库、本地 Ollama 嵌入

有需求或踩到坑，欢迎开 issue —— 尤其是**你所在环境的 DSH 版本**和 `memory_status` 的输出，那能省掉一半排查。

## 贡献

```bash
git clone https://github.com/zcd0818/dsh-scribe.git && cd dsh-scribe
node --test test/*.test.js        # 零依赖，无需 npm install
```

CI 在 GitHub Actions 上跑三个平台 × 两个 Node 版本（ubuntu / macos / windows × Node 20 / 22），矩阵配置见 `.github/workflows/test.yml`

改后端只需实现 `src/providers/base.js` 的方法并把 `type` 注册到 `src/providers/factory.js`；改动请带上对应的单测（现有测试里有 stub fetch 的写法可以直接抄）。

## License

[MIT](LICENSE)
