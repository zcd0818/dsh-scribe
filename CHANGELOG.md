# 更新记录

本文件记录 dsh-scribe 的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-27

首个公开发布版本：跨会话记忆 + 本地知识库，数据默认只存本机。

已发布到 npm：`npm install dsh-scribe`（<https://www.npmjs.com/package/dsh-scribe>），首发版本 1.0.0。

### 新增

- **跨会话记忆**：会话开始（`agent/created`）检索同项目 + 最近的记忆，注入 system prompt 的
  `memory:context` section（5 条 / ≤1200 字符）；会话结束（`agent/disposed`）把这次会话压成一条记忆写回
  ——少于 10 轮直接保留原文片段，更长的交给会话本来就在用的模型摘要。
- **模型工具**：`memory_search` / `memory_save` / `memory_list` / `memory_forget`。
  **斜杠命令**：`/memory status|list|search|save|providers|migrate|rollback`。
- **本地知识库**：索引工作区 `kb/` 与一个全局目录（文本、代码、Word/Excel/PPT；PDF 需可选依赖
  `pdfjs-dist`），会话开始注入目录摘要（≤1100 字符），模型按需 `kb_search` / `kb_read`，
  引用带 `kb/路径.md#L行号`。
- **四种后端**：`local`（默认 JSONL 文件）/ `local` + ChromaDB / 阿里云百炼 / `hybrid`（云端主 + 本地镜像）。
  换后端不改代码、不重开会话。
- **迁移四道闸**：先出计划（条数/时间范围/目标现状）→ 审批框（无审批服务则 fail-closed）→ 只增不删 →
  可回滚（只删目标端真实写入的 id）。
- **设置页四个分页**：概览 / 记忆 / 知识库 / 数据迁移。API Key 只写不读；接口只认同源请求
  （外来 `Origin` 或 `sec-fetch-site: cross-site` 一律 403）；迁移确认用后端签发的一次性 token
  （5 分钟有效、用后作废）。

### 变更

- 包名 `dsh-memory-plugin` → `dsh-scribe`，插件行 id `dsh-memory` → `dsh-scribe`，
  本地接口前缀 `/dsh-scribe/api`。**数据目录 `~/.dsh/memory` 与记忆文件格式不变，已有记忆不需要迁移**；
  但旧行需先 `remove_bundle`，否则会挂载两次。

### 修复

- 测试套件在 Windows 上的两处平台假设：
  - `URL#pathname` 拼出的 `/D:/a/...` 再 `join` 变成 `D:\D:\a\...`，`windows-latest` 直接 `ENOENT`；
    改用 `fileURLToPath` / `pathToFileURL`。
  - `/src/log.js` 的豁免用 `/` 比较，在 Windows 上永不成立，且会把测试文件自身扫进“调试残留”；
    改为 root 相对的 POSIX 路径比较。
  - `units` 里默认数据目录的 `startsWith('/')` 断言改为 `isAbsolute()`。

### 质量

- 115 个测试，`node --test test/*.test.js` 直接跑，**零运行时依赖、无构建步骤、无需 `npm install`**。
- CI：`node 20 / 22` × `ubuntu / macos / windows` 六个 job 全绿。

### 已知限制

见 README「已知限制」一节：首条消息注入的预热竞态、百炼适配器未用真实凭据联调、ChromaDB 与
`pdfjs-dist` 为可选依赖、界面文案目前只有中文。
