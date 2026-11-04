# 单条回答下载、用户消息反斜杠修复，以及用 Tampermonkey MCP 更新脚本

日期：2026-11-04。接着 [2026-10-25 的 Markdown / HTML 导出修复](./2026-10-25-markdown-html-export-fixes.md)。

## 1. 做了什么

| # | 事项 | 结果 |
|---|---|---|
| 1 | 在每条回答底部操作栏加“下载此回答”按钮 | 紧跟“更多操作”（三个点）之后，可选 Markdown 或 HTML，只导出这一条回答 |
| 2 | 修复用户消息在 Markdown 导出里行尾带 `\` | 还原成输入时的换行，源码里没有反斜杠 |
| 3 | 把 Tampermonkey MCP 装进 Claude Code、Codex、OpenCode | 三个工具都已连接 |
| 4 | 通过 MCP 把最新脚本更新进 Tampermonkey | 用 `@require file://` 指向 `dist/chatgpt.user.js`，页面已加载最新版 |

## 2. 单条回答下载

### 2.1 页面结构（用 chrome-use 读了真实页面）

新版 ChatGPT 没有 `data-testid`，也没有 `data-message-author-role`。实际结构：

- 一个回合是 `[data-talvt-turn-state]`，里面每个作者一个消息块 `[data-chatgpt-search-message-ids]`，块里有 `[data-conversation-role]` 标题。
- **用户消息的操作栏在它自己的消息块里面**，回答的操作栏是回合的直接子元素，在消息块后面，类名含 `turn-action-controls`。
- 回答的按钮依次是：复制、评价回复、朗读、分享、添加到项目来源、重新生成回复、更多操作。“更多操作”是设计系统的 `Button`，其余是 Tailwind 类的按钮。

所以定位规则是：`[data-talvt-turn-state] .turn-action-controls`，并排除位于消息块内部的那一行（那是用户消息的）。块的 id 列表来自回答所在回合里角色为 assistant 的最外层消息块。代码在 `src/answerActions.ts`。

### 2.2 数据层

- 导出前 `mergeContinuationNodes` 会把相邻的助手回复合并成一个节点。页面上的消息 id 可能是被并入的那条，所以合并时记录 `mergedIds`。
- 新增 `selectAnswer(conversation, messageIds)`：按节点 id、消息 id、`mergedIds` 找出回答，并给出它在对话里的序号（只算会导出的助手消息）。找不到时弹出提示，不下载。

### 2.3 导出内容

- **Markdown**：只有回答本身，没有 `# 标题`，没有 `## ChatGPT:`，回答里的标题保持原级别（`headingOffset` 为 0），front matter 在最前面。
- **HTML**：沿用现有模板，只渲染这一条。
- **文件名**：沿用设置里的格式，标题后加 `-answer-N`。
- 点击时才读取文件名格式和元数据设置，所以改了设置不用刷新页面。

### 2.4 按钮

- 复制“更多操作”的类名和 `data-*` 设计系统属性（不复制 `data-state`、`id`、菜单相关属性），实测是 32×32，与“更多操作”同一行、紧贴其右，颜色一致。
- 点击弹出小菜单（Markdown / HTML）。菜单在按钮下方，放不下就放到上方，滚动、缩放、`Esc`、点击别处都会关闭。
- 挂载用 sentinel 加每秒一次的补扫，页面重绘丢掉按钮时会补回；回答的行消失后会卸载。
- 新增文案 `Download answer`、`The answer could not be found`，9 个语言文件都补了。

## 3. 用户消息里的反斜杠

ChatGPT 存用户输入时，每个换行写成 `\` 加换行，空行是只有一个 `\` 的行（`render_format: "markdown"`）。上一版把它当成合法的 Markdown 硬换行原样保留，渲染没问题，但源码里全是反斜杠，列表后面的内容还被缩进进了列表。

新增 `decodeTypedLineBreaks`（`src/utils/text.ts`）：

- 只有 `\` 的行变成空行；
- 行尾的 `\` 换成两个空格（不可见的硬换行）；
- 围栏代码和行内代码里的反斜杠不动，例如 `C:\dir\`。

Markdown 和 HTML 导出共用。排查中遇到一个坑：`toMarkdown` 按解析树的位置从“源文本”里取字，所以传给它的源文本必须是解码后的文本，否则内容会错位（“Why?” 变成 “hy?”）。

测试：`tests/export-markdown-html.test.ts` 里原来要求保留反斜杠的断言已改成要求不出现，并新增空行和代码两个用例。

## 4. 测试结果

- `tsc --noEmit`、`eslint src tests` 无报错。
- vitest：28 个文件、288 个测试全部通过。新增 `tests/answer-actions.test.ts`（8 个，DOM 结构）、`tests/answer-export.test.ts`（10 个，选择与导出）。
- 构建：`npx vite build` → `dist/chatgpt.user.js`（约 588 KB）。
- 环境：仓库里新建了 `node_modules`（已被 `.gitignore` 忽略）。锁文件里没有 macOS 的 rolldown 原生绑定，手动放了 `@rolldown/binding-darwin-arm64@1.2.9`，没有改 `package.json` 的依赖。

## 5. Tampermonkey MCP

### 5.1 来源核对

文档（`ChatGPT-篡改猴脚本自动更新.md`）推荐官方 `tampermonkey-mcp`。装之前核对了：npm 包 `tampermonkey-mcp@0.0.5`，维护者 `npm@tampermonkey.net`，仓库在 `Tampermonkey/tampermonkey-mcp`。

### 5.2 三个工具的安装命令

| 工具 | 命令 | 写入位置 |
|---|---|---|
| Claude Code | `claude mcp add --transport stdio --scope user tampermonkey -- npx -y tampermonkey-mcp@latest` | `~/.claude.json` |
| Codex | `codex mcp add tampermonkey -- npx -y tampermonkey-mcp@latest` | `~/.codex/config.toml` |
| OpenCode | `opencode mcp add --global tampermonkey -- npx -y tampermonkey-mcp@latest` | `~/.config/opencode/opencode.json` |

- OpenCode 不加 `--global` 会写进当前项目的配置。
- 改 Codex 和 OpenCode 配置前各备份了一份。
- MCP 要重启工具后才会加载。

### 5.3 连接

1. 在 Edge 装 Tampermonkey Editors 扩展。
2. 调 `tampermonkey_get_connection_code`，在扩展里输入连接码。连接码绑定在当前 MCP 进程上，进程重启即失效；多个工具各有自己的 MCP 进程，要分别连接。
3. 连接成功后 `tampermonkey_list` 返回脚本。列表里有两个：原版 `ChatGPT Exporter` 和 `Super ChatGPT Exporter`，只改后者。

## 6. 更新脚本

### 6.1 为什么不直接 patch

`tampermonkey_patch` 要把完整脚本当参数传入。脚本有 570 KB 以上，要逐字写出，既不现实也容易出错。

### 6.2 做法

1. 用 `tampermonkey_get` 读出旧脚本，备份到 `~/Desktop/Super-ChatGPT-Exporter.installed-backup.user.js`。
2. 用 `tampermonkey_patch` 把脚本换成**只有头部**的壳：头部沿用 `dist/chatgpt.user.js` 的 `@match`、`@grant`、`@require` 等，再在两个 CDN 依赖之后加一行：

   ```
   // @require  file:///Volumes/zhitai-7100/chatgpt-exporter/dist/chatgpt.user.js
   ```

   `file://` 依赖放在 jszip、snapdom 之后，保证运行时这两个全局已经存在。
3. 以后重新编译 `dist/`，刷新页面即可，不用再更新 Tampermonkey。

### 6.3 遇到的问题

写入后读 `file://` 资源返回 404，因为 Edge 没给 Tampermonkey“允许访问文件网址”。在 `edge://extensions` 打开该权限后，页面加载了最新版脚本。

### 6.4 限制

- 脚本依赖外置盘 `/Volumes/zhitai-7100/` 上的文件，盘没挂载时脚本不生效。
- Tampermonkey 里的头部（`@match`、`@grant`、`@version` 等）改了仍要手动同步到壳里。
- 同时启用原版 `ChatGPT Exporter` 和 Super 版，页面里可能出现两个菜单、两份按钮。
- 退回旧版只能在 Tampermonkey 编辑器里手动粘贴备份。
- 点击“下载此回答”真正下载文件这一步，我没有在页面里点过，只测了结构、样式和导出逻辑。

## 7. 本地环境的其他改动

应你的要求关闭了三个工具里的 Open Design MCP，没有删除配置：

- Claude Code：用户配置里没有单独的禁用开关，已移除，原配置导出在 `~/.claude/open-design-mcp.restore.json`。
- Codex：`config.toml` 里 `enabled = false`。
- OpenCode：`opencode.json` 里 `"disabled": true`（字段名是 `disabled`，不是 `enabled`）。它的后台服务 `opencode serve --service` 要重启后才生效。

改动前各备份了 `.bak-od-off-时间戳`。
