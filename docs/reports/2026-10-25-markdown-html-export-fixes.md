# Markdown / HTML 导出修复实现报告

日期：2026-10-25
范围：`src/exporter/markdown.ts`、`src/exporter/html.ts`、`src/template.html` 及它们依赖的 `utils/`、`api.ts`

## 1. 目标与对需求的理解

1. 修复 Markdown 和 HTML 导出里发现的 bug，并为每个修复补测试。
2. Markdown 导出不要外链的图片和图标。
3. 完成后写本报告。

第 2 条经用户澄清：**emoji 可以保留**，不要的是**外链的图片和图标**。据此实现为：

- Markdown 里不再出现任何从 URL 加载的图片：图片搜索结果、答案里写的 `![](https://…)`、`<img src="https://…">`、尚未解析成数据的 `sediment://` 指针。
- 用户上传和 AI 生成的图片仍按现有“图片”设置处理（内嵌 base64、存成 zip 里的文件、或用 `[image]` 占位），因为它们不是外链。
- `📎` 附件标记和答案里的 emoji 原样保留。

如果希望连内嵌的 base64 图片也不要，只需要让 `renderImage` 不输出图片，改动是一行。

## 2. 方法

分两轮，第二轮发现的问题比第一轮严重得多。

**第一轮：构造数据。** 用 Chrome Agent Bridge 在 Edge 里读取 ChatGPT 页面 DOM，弄清对话里有哪些格式；把真实的导出函数放进 vitest，喂构造的对话复现问题；用 js-yaml 校验 frontmatter；在 Edge 里实测 HTML 样式。

**第二轮：真实对话数据。** 经用户明确授权，在页面里用登录态对当前这一个对话发了**一次** `GET /backend-api/conversation/<id>`（和导出脚本发的是同一个请求）。token 只在页面内部使用，没有返回、打印或写入任何文件；对话 JSON 存在仓库外的临时目录，分析完成后已删除。仓库里的测试全部使用合成内容，没有复制用户的对话。然后用真实数据把导出代码从头跑到尾，再在 Edge 里渲染真实的 HTML 导出，与 ChatGPT 页面逐项对照。

## 3. 修复清单

### 3.1 会损坏内容或文档

| # | 问题 | 原因 | 修复 | 位置 |
|---|---|---|---|---|
| 1 | 答案里的 `–`、`—`、`−`、不换行空格、U+2060 被改成 `-` 或空格，**代码块里也一样** | 引用转换前对整段正文做了归一化，本意只是为了匹配 `matched_text` | 正文不再归一化，只去掉 U+E203/E204 高亮标记；匹配改用宽容的正则 | `utils/citations.ts` |
| 2 | Markdown 里用户消息原样写入：`# 标题` 变成真标题，没闭合的 ``` 吞掉后面所有轮次 | 只有助手消息经过处理 | 见 3.5：按消息的 `render_format` 区分。没有该标记的按纯文本中和（`plainTextToMarkdown`），是 Markdown 的则下移标题并保证围栏闭合 | `utils/markdown.ts`、`exporter/markdown.ts` |
| 3 | frontmatter 常常不是合法 YAML：`Foo: bar`、`[Draft] plan`、含换行的标题报错；`#1 idea` 被解析成 `null` | 值不加引号直接写入 | `formatFrontMatter`：只在 YAML 读回来不是同一个字符串时才加引号，日期和 URL 保持原样 | `exporter/meta.ts` |
| 4 | HTML 里 `<br>`、`<details>` 整块丢失，表格单元格里的换行消失 | `dropRawHtml` 丢弃全部原始 HTML | 改成白名单：保留无属性的 `br`、`details`、`summary`、`kbd`、`sub`、`sup`、`mark`、`u`；`script`、`style`、`iframe`、`svg` 等连内容一起丢弃（能跨行）；其余标签只去标签留文字 | `utils/markdown.ts` |
| 5 | `code` 和 `execution_output` 的围栏固定三个反引号，内容里有 ``` 时提前闭合 | 写死 | `codeFence` 取比内容里最长反引号更长的围栏 | `utils/markdown.ts` |
| 6 | 嵌套围栏里的代码被当成公式改写：`/\[(.+?)\]\((.+?)\)/g` 变成 `/$$(.+?)$$$(.+?)$/g` | `CodeRegex` 非贪婪，``` 和 ```` 的配对错位 | 按行扫描的 CommonMark 围栏识别（同字符、不短于开启围栏；支持 `~~~`、引用里的围栏、未闭合围栏；行内代码按相同长度的反引号配对） | `utils/code.ts`、`utils/latex.ts` |
| 7 | `价格 $5 到 $10 之间，另 $ 20 元` 里 `$10 之间，另 $` 被当成公式 | 闭合 `$` 前允许空格 | 和 pandoc 一样：闭合 `$` 前必须是非空白字符 | `utils/latex.ts` |

### 3.2 结构与语义

| # | 问题 | 修复 |
|---|---|---|
| 8 | 角色标题 `####` 比答案自己的 `#`、`##`、`###` 更低，答案标题会把角色段截断，大纲错乱 | 角色标题改为 `##`，答案里的标题整体下移 2 级（最深到 `######`） |
| 9 | 旧式脚注 `[^1]` 每条消息各自从 1 编号，全文冲突；同一标记重复出现会生成重复定义；定义里没有 URL | 全文统一编号，每条消息每个引用只定义一次，定义带链接，没有引用不追加空行 |
| 10 | 同一网站的多个来源标签都是 `GitHub`，分不出区别 | 标签在同一引用内重复时改用页面标题 |
| 11 | 来源标题里的 `\|`（如 `Docs \| Site`）劈开表格单元格 | 标签转义 `\|`，URL 里的 `\|` 编码成 `%7C` |
| 12 | `multimodal_text` 的各部分用单个 `\n` 连接，文字和图片挤在同一段 | 用空行分隔，空部分过滤掉 |
| 13 | `tether_quote` 多行内容只有第一行带 `>` | 每行都加 `>`（Markdown 和 HTML） |
| 14 | 批量导出没有统一换行符，和单个导出不一致 | 批量导出也经过 `standardizeLineBreaks` |
| 15 | 标题含换行会破坏 `# 标题` | 空白折叠成单个空格 |
| 16 | 思考块的 “Thought for N seconds” 写死英文 | 走 i18n，9 种语言都补了翻译 |

### 3.3 Markdown 不含外链图片和图标

- `toMarkdown` 新增 `dropRemoteImages`：删除 `image`、`imageReference` 节点，以及 `<img>` 里的外链图片；只剩被删图片的链接或段落整个删除。`data:` 和相对路径的图片保留。
- `transformContentReferences` 新增 `includeImages: false`：`image_group` 和 `image_v2` 引用及其 alt 文本一律不输出。
- `renderImage` 对非本地来源不输出；只含外链图片的工具消息不会再留下一个空的 `## ChatGPT:`。
- 图片设置 `omit` 仍然输出 `[image]` 占位。

### 3.4 HTML 导出

| # | 问题 | 修复 |
|---|---|---|
| 17 | 宽表格被 `overflow:hidden` 截断，列被挤成一字一行 | 表格包进 `.table-wrap`（横向滚动），单元格最小宽度 4rem |
| 18 | `* { font-size:16px }` 压掉表格字号、让 h4 与正文无法区分 | 去掉该规则；h4 改为 600 粗细；链接不再缩到 0.8rem |
| 19 | 引用块被套上弯引号，行高只有 1rem | 去掉引号规则，行高 1.6 |
| 20 | `.conversation-item:first-of-type` 永远不匹配，首条消息没有上边框 | 改为 `.conversation-header + .conversation-item` |
| 21 | 图片搜索结果以整列宽显示 | 链接里的图限制在 320×240 以内 |
| 22 | mermaid 只显示源码 | mermaid 块标记为 `pre.mermaid-source`，页面加载 mermaid 10.9.1 后渲染成 SVG；库加载失败或图不合法时保持源码，并清理 mermaid 留下的报错节点 |
| 23 | 页面没设置语言时 `<html lang="">` | `lang` 为空串时回退 `en`（原来的 `??` 不处理空串） |
| 24 | 图片 `src` 属性未转义 | `escapeHtml`，宽高强制转数字 |

### 3.5 用真实对话数据发现的问题

这一节的问题只有拿到真实的 API 数据才看得见。

**A. 交互式回答被截断，丢掉约 70% 的内容（最严重）。**
你的第二条回答，`model_dil_v2.fallbackMarkdown` 只有 3,692 字符，停在“其游戏预览却是这样启动的：”这句话中间，而 `parts` 里有完整的 13,471 字符。原因：模型写了两个 `<CodeBlock>` 却只闭合了一个（第二个用普通的 ``` 收尾），ChatGPT 自己把标记转成 Markdown 时报 `recoveryDiagnostics: unclosed_block` 并截断。导出代码在有 `fallbackMarkdown` 时用它替换整段正文，所以导出丢了第三节后半到第八节，共 14 个标题。

修复：新增 `utils/dil.ts` 的 `dilToMarkdown`，把 `parts` 里的 JSX 标签转成 Markdown：`<Link>` 变链接，`<Entity>` 取名字，`<Cite>`、`<AsyncImage>`、`<icon>` 去掉，`<box>`/`<row>`/`<grid>`/`<text>`/`<caption>` 等布局标签展开成段落并去掉缩进，`<badge>`、`<button>`、`<title>`、`<radio>`、`<segmented-control>`、`<select>`、`<divider>` 转成文字，`<CodeBlock>` 转成围栏（内容里有 ``` 时用更长的围栏；缺闭合标签时在单独一行的 ``` 或文末结束）。看起来像标签的普通文字（如 `<game-slug>`、代码里的标签）不动。`api.ts` 的 `getInteractiveFallbackParts`：`fallbackMarkdown` 完整时照旧使用；缺失、为空、或带 `recoveryDiagnostics` 时改用转换后的 `parts`。

**B. `fallbackMarkdown` 里的三种标记泄漏进导出。**
真实数据里 ChatGPT 的 Markdown 版本含 `url标题地址`（16 个链接）、`entity["software","名字","说明"]`（4 个）、`image_group{…搜索词…}`（6 个图片轮播）。导出代码只认 `cite`，其余 94 个私有区字符全部留在输出里，肉眼看是 `urlTencent GCAhttps://…` 这样的乱码，而且 Markdown 往返时 `https://…` 被自动链接吞进了结尾的标记字符，输出被破坏成 `<https://…>`。

修复：`transformContentReferences` 在引用替换后处理剩下的标记：`url` 变 Markdown 链接，`entity` 取名字，`image_group`、`cite` 和任何未知标记一律去掉。

**C. 我自己引入的一个回归，被真实数据抓到。**
第一轮我假设“用户消息是纯文本”，对它们做了转义。但真实的用户消息带 `serialization_metadata.render_format: "markdown"`：换行存成 `\` 加换行，前导空格存成 `&#x20;`。转义后 `\` 变成字面反斜杠，HTML 导出里还会直接显示出来。修复：有这个标记的用户消息按 Markdown 处理（保持原样，下移标题，围栏未闭合时自动闭合，HTML 里渲染而不是转义，原始 HTML 仍被过滤）；没有标记的才按纯文本中和。

**D. 回答下方的“查看来源”列表没有导出。**
用户指出 ChatGPT 每个回答下有“查看来源”，点开后侧边栏列出来源网址。数据里对应的是 `metadata.search_result_groups`（每条含 `url`、`title`、`ref_id`），而回答里的 `<Cite refs={["turn7view1"]}/>` 通过 `ref_id`（`turn` + `turn_index` + `ref_type` + `ref_index`）指向它。有两个原因导致导出没用上：搜索是在前面的 `web.run` 工具消息里跑的，不在回答这条消息上；导出代码只读同一条消息上的 `sources_footnote`，而这个对话里它是空的。

修复（`api.ts`、`utils/citations.ts`）：`copyNode` 在替换成 Markdown 之前，先从原始文本里记下回答引用的 id（`<Cite>` 标签和 `cite` 标记两种写法都认）；`processConversation` 在合并连续消息后，沿整条分支建立 `ref_id` 到页面的索引，把每条回答引用到的页面按首次出现的顺序、按网址去重、去掉 `utm_source=chatgpt.com` 之后放进 `metadata.cited_sources`；`transformContentReferences` 在回答自己没有 `sources_footnote` 时，把它们作为“来源”列表追加在回答末尾。原来就有来源列表的回答不受影响，“导出来源”开关照常控制。原始对话数据不会被改动。

真实数据核对：第一条回答引用 16 个不同网址，第二条 13 个，导出的列表与数据一一对应，顺序与 ChatGPT 侧边栏一致（Vite 的两篇文档、ohmygame、ohmygame-examples……）；没有标题的条目（`raw.githubusercontent.com/…`）写成 `<网址>`，与侧边栏里只显示域名一致。

**E. 对 API 数据做一次完整盘点后，又发现的内容丢失。**
前面几轮我是“看到什么修什么”，没有把数据里的字段完整列过一遍。用户指出后，我把对话 JSON 的每个字段盘点出来，并增加了两项可以量化的检查：把回答里的每一行文字、每个代码块原文，与导出结果逐一比对（639 行文字，15 个代码块）。结果：

- **九个阶段的整块内容丢失。** 第一条回答里有一个 `{#each [...] as item,i} … {#if i===0 …}{:else}…{/if} … {/each}` 模板循环，生成“01 需求澄清 / 02 概念与美术设计 / … / 09 用户验收与发布”九个阶段，每个阶段有名称和说明。ChatGPT 自己的 `fallbackMarkdown` 把它整个丢了，导出里只剩后面一句“右侧人形图标表示……”。更糟的是，这条回答的 `fallbackMarkdown` **没有** `recoveryDiagnostics`，我原来“没有诊断信息就代表完整”的判断是错的。
- **文件树丢失。** `<text preserveWhitespace>{`├── index.html …`}</text>` 是 JSX 的模板字符串，我前一轮的语法普查用的正则不允许跨行，漏掉了它。
- **代码块那一项是校验脚本的误判，不是导出错误。** ChatGPT 给“Web Game Engineering Policy”那个块存的内容把回答末尾也吞进了代码块（因为模型漏写了 `</CodeBlock>`）。这正是页面上那个代码块里能看到 `<Link url=…` 的原因，是 ChatGPT 自己的渲染问题。导出在单独的 ``` 行处结束它，更接近作者本意。

修复（`utils/dil.ts`、`api.ts`）：`dilToMarkdown` 支持 `{#each [JSON数组] as item,i}`（`{item[0]}`、`{item.key}`、`{i}`）和 `{#if a===b || …}{:else}…{/if}`，不读取代码块里的同名文字，数组读不出来时丢弃整个循环而不是打印源码；支持 `<text preserveWhitespace>{`…`}</text>`（输出成围栏代码块）。选择来源的规则改为：标记里含有需要运行时求值的模板（`{#each}`、`{#if}`、`{`…`}`）时，不使用 `fallbackMarkdown`，直接从标记转换。

重新跑真实数据：九个阶段 9/9，文件树完整，Markdown 和 HTML 都是；残留的 `{#`、`{:`、`{/`、`{@`、`{`` 为 0。

### 3.6 API 数据逐字段盘点

对话 JSON 共 32 个节点（当前分支 32 个，没有分叉），消息元数据共 50 种字段。结论如下。

| 字段 | 内容 | 处理 |
|---|---|---|
| `content.parts`、`content_references`、`citations`、`model_dil_v2` | 正文、引用、交互标记 | 已处理（3.5 A、B、E） |
| `search_result_groups` | 每次搜索的结果：`url`、`title`、`snippet`、`pub_date`、`attribution`、`ref_id` | 引用到的页面已导出成来源列表（3.5 D）。**`snippet`、`pub_date` 没有导出**；**没有被引用的搜索结果（第一条回答 73 条，引用了 16 条）没有导出** |
| `serialization_metadata`、`system_hints` | 用户消息的存储格式、`@网页搜索` 芯片 | 已处理（3.5 C）；芯片作为文字 `@网页搜索` 保留 |
| `content.thoughts`、`reasoning_titles`、`reasoning_recap`、`finished_duration_sec` | 思考摘要、标题、用时 | 由“导出思考”开关控制，已验证开启后可用。标签是 “Thought for 223 seconds”，ChatGPT 页面显示 “思考了 3m 43s”，格式不同 |
| `status`、`end_turn` | 消息状态 | 全部 `finished_successfully`，没有半截消息 |
| `model_slug`、`resolved_model_slug` | 模型 | `gpt-6-thinking`，识别为 “GPT-6”，正确 |
| 顶层 `gizmo_id`、`gizmo_type` | 所属项目（`g-p-…`） | **导出元数据里没有项目这一项**，单个导出也不取项目名 |
| `conversation_context_citation_metadata`、`personal_sources`、`<MemoryCite />` | 回答用到了哪些旧对话和文件（共 7 条，含 3 个旧对话链接、4 个 `my_files` 文件） | **没有导出**。`<MemoryCite />` 没有任何引用 id，无法对应到具体句子 |
| `code_blocks`、`view_state`、`tool_icons`、`inline_cot_expandable_content`、`finish_details`、`classifier_response`、`hide_inline_actions`、`disable_turn_actions`、`thinking_effort`、`cot_version`、`summary_type`、`tool_summary_type`、`message_source`、`conversation_followup_suggestions_eligible`、`request_id` 等 | 界面状态、编辑器状态、内部标识 | 不需要导出 |
| `safe_urls` | 该回答涉及的全部网址（101 和 58 个） | 不导出，来源列表已覆盖被引用的部分 |
| `moderation_results`、`is_starred`、`pinned_time`、`memory_scope`、`owner` 等顶层字段 | 账号与对话属性 | 不属于对话内容，不导出 |
| 隐藏的 `final` 消息 | `is_visually_hidden_from_conversation: true`，内容与可见回答重复 | 按原有规则跳过，正确 |

## 4. 行为变化（需要知道）

1. **角色标题 `#### You:` 改成了 `## You:`**，答案标题下移 2 级。依赖旧格式解析导出文件的脚本需要跟着改。
2. **Markdown 不再包含外链图片**，包括图片搜索结果。
3. **交互式回答的导出来源变了**：`fallbackMarkdown` 被截断、缺失，或标记里含循环/条件/模板字符串时，改从 `parts` 转换，内容比以前完整；引用了搜索结果的回答，末尾多出一个“来源”列表。
4. **没有 `render_format` 标记的用户消息**在 Markdown 里按纯文本显示：行首的 `#` 变成 `\#`，每个换行带两个行尾空格。已闭合的围栏代码块不变。
5. **引用标签的文字可能变长**：同站多个来源时，用页面标题替代站点名。
6. **HTML 多加载一个 CDN 脚本**（mermaid）。原来就依赖 cdnjs 的 highlight.js 和 KaTeX。
7. 脚注编号变成全文连续，不再每条消息从 1 开始。

## 5. 验证

- 命令：`tsc --noEmit`、`vitest run`、`eslint src tests`、`vite build`（输出到临时目录）。
- 结果：类型检查通过；**26 个测试文件、258 个测试全部通过**（改动前 24 个文件、144 个测试，新增 114 个）；ESLint 无报错；构建成功，没有改动被跟踪的 `dist/`。
- 反向验证：把 `src` 暂存回原始版本再跑整套测试，旧代码上有大量失败（最后一轮核对为 84 个），新代码上全部通过。
- **真实对话的前后对比**（同一份数据）：

  | | 修复前 | 修复后 |
  |---|---|---|
  | 第二条回答的标题数 | 8，缺第八节“最终建议” | 22，完整 |
  | 泄漏的私有区字符 | 94 | 0 |
  | `image_group` 残留 | 6 | 0 |
  | 导出长度 | 22,772 字符 | 28,329 字符 |

- **真实 HTML 导出在 Edge 里的渲染**，与 ChatGPT 页面逐项对照：表格 12 对 12，代码块 14 对 14，mermaid 流程图 1 对 1（14 个节点，已渲染成 SVG），第二条回答一到八节全在，用户消息里没有反斜杠，没有任何泄漏标记。
- 测试分布：`tests/export-markdown-html.test.ts`（新，端到端，用真实的导出函数）、`tests/dil.test.ts`（新，转换器）、`tests/latex.test.ts`、`tests/citations.test.ts`、`tests/meta.test.ts`、`tests/markdown-format.test.ts`、`tests/process-conversation.test.ts`（截断/缺失/完整三种 `fallbackMarkdown`）。更新了 3 个旧测试里与新行为相关的断言。

## 6. 没有修复或没法解决的部分

1. **`<AsyncImage>` 的图片无法导出**：数据里只有搜索词（如 `query="… screenshot"`），没有图片 URL，图片是 ChatGPT 页面运行时现搜的。所以实体卡片、示例截图在 HTML 里也不会出现。
2. **实体链接拿不到**：你页面里 17 个指向 github.com 的实体 pill，数据里只有名字（`Entity value="Tool A"`、`entity["software","名字","说明"]`），没有 URL，链接同样是运行时解析的。导出保留名字，不保留链接。显式写了 `<Link>` 的地方（如表格里的仓库链接）链接是完整保留的。
3. **正文里的行内来源标签（`GitHub +5` 那种）仍然去掉**，来源改为在回答末尾集中列出（见 3.5 D），没有把每个标签对应到具体句子。
4. **ChatGPT 自己的 `fallbackMarkdown` 里有垃圾文字**：表单里的下拉控件被它转成 “当前所选项不可用。”（你的第一条回答里出现 3 次）。这是它生成的本地化文案，无法可靠地去掉，所以保留。
5. **连续助手消息拼接不加分隔**（`api.ts` 的 `mergeContinuationNodes`）：这是“继续生成”的设计，**没有改**。
6. **用户头像**只认 `cdn.auth0.com/avatars/`：放宽匹配会误取内容图片，所以没改，需要真实的头像元素才能安全判断。
7. **HTML 仍然依赖外网**：highlight.js、KaTeX、mermaid 都来自 cdnjs，离线打开时代码不高亮、公式停在 `\(…\)` 原文、mermaid 显示源码（设计内的降级）。
8. **mermaid 在 HTML 里不随主题切换重绘**：渲染时按页面当时的主题选配色，之后点击明暗切换，已画的图不变。
9. 行内的 `<script>…</script>` 里的文字（不在块级里时）仍会作为可见文字出现，但不会执行；块级的 `script`、`style` 内容整块丢弃。
10. Markdown 里的时间戳仍是 `<time>` 标签，在纯文本查看器里是标签原文。这是已有设计，没有改。
11. 答案里**指向外链的普通超链接**（`[文字](https://…)`）按需求保留，只有图片被去掉。

## 7. 改动文件

源码：`src/api.ts`、`src/exporter/markdown.ts`、`src/exporter/html.ts`、`src/exporter/meta.ts`、`src/template.html`、`src/utils/citations.ts`、`src/utils/latex.ts`、`src/utils/markdown.ts`、`src/utils/code.ts`（新，代码区域扫描，从 `latex.ts` 抽出）、`src/utils/dil.ts`（新，交互式回答转换，含循环、条件和模板字符串）、`src/locales/*.json`（9 个，新增两个键）。

测试：`tests/export-markdown-html.test.ts`（新）、`tests/dil.test.ts`（新）、`tests/latex.test.ts`、`tests/citations.test.ts`、`tests/meta.test.ts`、`tests/markdown-format.test.ts`、`tests/process-conversation.test.ts`、`tests/export-content.test.ts`、`tests/image-modes.test.ts`。

没有提交，改动都在工作区里。
