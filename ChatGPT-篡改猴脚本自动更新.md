# 篡改猴脚本自动更新

## You:
@网页搜索  我在我 Mac Mini 上安装了 Edge 浏览器上的篡改猴（Tampermonkey）扩展，我自己写了一个 JavaScript 脚本，但是我不想每次都手动复制进行更新。\
\
我想要写一个自动化脚本进行更新，或者让我的 Agent 进行自动更新。\
\
所以我想知道：\
1\. 导入到篡改猴（Tampermonkey）里的 JS 脚本是存储在哪里？\
2\. 应该以哪种方式自动化导入？


## ChatGPT:
根据 Tampermonkey 官方文档、GitHub Issue 和开发者社区的资料，你这个需求其实**不需要每次重新导入 JS，也不需要 Agent 操作 Edge 浏览器界面**。

对于你的 Mac Mini + Microsoft Edge + Tampermonkey，我推荐直接采用 **本地 JS 文件 + `@require` 引用** 的方式。

这样你可以让 Claude Code、Codex 或自己写的自动化程序直接修改磁盘上的 `.js` 文件，刷新网页即可加载更新后的代码。

#### 一、Tampermonkey 的 JS 脚本到底存在哪里？

##### 1\. Edge 在 macOS 上的存储位置

通常是：

```text
~/Library/Application Support/Microsoft Edge/
└── Default/
    ├── Extensions/
    │   └── <Tampermonkey扩展ID>/
    │
    └── Local Extension Settings/
        └── <Tampermonkey扩展ID>/
            ├── CURRENT
            ├── MANIFEST-xxxxxx
            ├── 000xxx.ldb
            └── 000xxx.log
```

需要区分两个目录：

| 目录                        | 用途                                                      |
| --------------------------- | --------------------------------------------------------- |
| `Extensions/`               | Tampermonkey 扩展自身的程序文件                           |
| `Local Extension Settings/` | Tampermonkey 保存的脚本、设置等扩展数据，通常使用 LevelDB |

**你导入的 JS 脚本通常不是以独立 `.js` 文件保存在磁盘上的，而是由 Tampermonkey 管理在扩展存储中。**

Tampermonkey 官方 GitHub 上也有开发者讨论如何从这个 LevelDB 存储中恢复脚本。

##### 2\. 找到你机器上的真实目录

Tampermonkey 有两个常见的扩展 ID：

| 安装来源                | 扩展 ID                            |
| ----------------------- | ---------------------------------- |
| Microsoft Edge 扩展商店 | `iikmkjmpaadaobahmlepeloendndfphd` |
| Chrome Web Store        | `dhdgffkkebhmkfjojejmpbldmpobfkfo` |

这两个 ID 都经过 Tampermonkey 官方确认。

你可以在 Mac Mini 的终端执行：

```bash
EDGE="$HOME/Library/Application Support/Microsoft Edge"

find "$EDGE" -type d \
  \( -name 'iikmkjmpaadaobahmlepeloendndfphd' \
  -o -name 'dhdgffkkebhmkfjojejmpbldmpobfkfo' \) \
  -print
```

另外，在 Edge 地址栏输入 `edge://version`，找到 **Profile Path（个人资料路径）**，这是定位实际目录最准确的方法之一。

注意：不建议 Agent 直接修改 `.ldb`、`.log` 等数据库文件。它们并不是普通 JS 源文件，直接写入可能造成数据损坏，而且浏览器运行期间还可能覆盖外部改动。

#### 二、最推荐：本地文件 + `@require` 自动加载

这是 Tampermonkey 官方 FAQ Q402 明确支持的开发方式。

Claude Code / Codex

修改 JS 文件

本地 main.js

唯一代码源

**Tampermonkey**

通过 \@require 读取本地 JS → 刷新网页运行新代码

##### 第一步：创建本地 JS 文件

在 Mac Mini 终端执行：

```bash
mkdir -p ~/dev/tampermonkey
touch ~/dev/tampermonkey/main.js
```

把你现在 Tampermonkey 中原来的 JavaScript 逻辑保存到 `main.js`。

##### 第二步：修改 Tampermonkey 中的原脚本

保留脚本的元数据头，删掉原来的实现代码，增加 `@require`：

```javascript
// ==UserScript==
// @name         My Custom Script
// @namespace    local.my-scripts
// @version      1.0.0
// @match        https://example.com/*
// @grant        none
// @require      file:///Users/你的Mac用户名/dev/tampermonkey/main.js
// ==/UserScript==
```

其中：

- `@match` 改为你实际操作的网站，最好直接保留原值。
- `@grant`、`@run-at`、`@connect` 等沿用原脚本需要的权限和配置，不要盲目改成 `none`。
- `@require` 必须填写真实绝对路径，不能直接使用 `~`。

##### 第三步：开启 Edge 文件访问权限

在 Edge 中：

1. 打开 `edge://extensions`。
2. 找到 Tampermonkey，点击「详细信息」。
3. 开启「允许访问文件网址」（Allow access to file URLs）。
4. 如果仍然无法加载，检查「网站访问权限」（Site access）。官方说明部分环境下需要设为「在所有网站上」。

这项授权会扩大扩展的本地文件读取权限，因此仅对可信扩展启用。

完成后，你的 Agent 只需要编辑：

`~/dev/tampermonkey/main.js`

保存代码、刷新目标网页，就可以测试新逻辑，而无需重新导入。

需要注意：`@require` 引用的 JS 负责代码实现；以后如果要修改 `@match`、`@grant` 等 Tampermonkey 元数据，仍然需要修改浏览器中那个包装脚本。

---

#### 三、2026 年新增方案：直接跟踪本地文件

这是本次搜索发现的一个重要新功能。

Tampermonkey 在 **2026 年 5 月发布的 5.5.0** 中，为 Edge 增加了：

**Follow file on disk（跟踪磁盘文件）**

在支持此功能的版本里，你可以打开 Tampermonkey 脚本编辑器，使用：

`File → Follow file on disk`

然后选择本地的 `.user.js` 文件。

Tampermonkey 会跟踪文件的变化并同步到内部脚本，而不是只通过 `@require` 加载代码。

这意味着它也更适合你需要同步修改元数据头的情况。

但有一个值得注意的问题：2026 年 9 月的 GitHub Issue \#2883 报告，5.5.0 的文件跟踪运行一段时间后可能停止同步。该 Issue 已标为 `fixed at beta`，尚不能据此确认所有 Edge 稳定版都已修复。

因此目前我仍然更倾向于把 `@require` 作为稳定的本地开发方案。

---

#### 四、如果要让 Agent 直接更新 Tampermonkey：官方 MCP

**[Tampermonkey/tampermonkey-mcp](https://github.com/Tampermonkey/tampermonkey-mcp)**

Tampermonkey 官方 GitHub 组织维护的 MCP Server

这可能是最符合你使用 Claude Code / Codex 管理脚本需求的方案。

官方 MCP 支持以下操作：

| MCP 工具              | 功能             |
| --------------------- | ---------------- |
| `tampermonkey_list`   | 获取已安装的脚本 |
| `tampermonkey_get`    | 读取脚本源代码   |
| `tampermonkey_patch`  | 修改现有脚本     |
| `tampermonkey_put`    | 创建新脚本       |
| `tampermonkey_delete` | 删除脚本         |

其中创建和删除要求 Tampermonkey 5.6+ 及 Tampermonkey Editors 1.0.6+；读取和更新现有脚本的功能可在较早的支持版本使用。

##### 安装和连接

首先在 Edge 中安装 [Tampermonkey Editors 扩展](https://chromewebstore.google.com/detail/lieodnapokbjkkdkhdljlllmgkmdokcm)，与已经安装的 Tampermonkey 搭配使用。

然后在 Mac Mini 上为 Agent 配置 MCP。

Claude Code

```bash
claude mcp add --transport stdio --scope user \
  tampermonkey -- npx -y tampermonkey-mcp@latest
```

Codex CLI

```bash
codex mcp add tampermonkey \
  -- npx -y tampermonkey-mcp@latest
```

MCP 启动后，Agent 首先调用 `tampermonkey_get_connection_code`，生成连接码。你需要在 Edge 的 Tampermonkey Editors 中输入连接码，授权连接。

连接成功后，Agent 就能通过 MCP 直接读取或修改 Tampermonkey 中的 JS，而不用先修改本地文件，也不必操作浏览器编辑器。

**注意：** 这是本地 Agent 与浏览器扩展之间的连接。若你的 Agent 跑在另一台服务器上，需要另行处理连接可达性；不能默认远程 Agent 就能访问 Mac Mini 的 Tampermonkey。

---

#### 五、还有一种 GitHub 自动更新方式

如果你想让多台电脑上的 Tampermonkey 脚本同步升级，可以使用 GitHub Raw URL：

```javascript
// ==UserScript==
// @name         My Custom Script
// @namespace    my-scripts
// @version      1.0.0
// @match        https://example.com/*
// @updateURL    https://raw.githubusercontent.com/USERNAME/REPO/main/dist/my-script.user.js
// @downloadURL  https://raw.githubusercontent.com/USERNAME/REPO/main/dist/my-script.user.js
// @grant        none
// ==/UserScript==
```

把该脚本托管在可直接访问的 GitHub 仓库中，通过 Tampermonkey 安装一次。

之后 Agent 负责修改、提交并推送脚本，同时提升 `@version`。Tampermonkey 根据自己的更新检查和自动安装设置拉取新版本，而不是每次修改立即更新。官方文档明确要求通过 `@version` 识别更新。

不建议把包含敏感信息的脚本发布到公开仓库。

---

#### 六、我建议你怎样选？

| 方案                | 自动更新能力                | 适用场景                 |
| ------------------- | --------------------------- | ------------------------ |
| 本地 `@require`     | 保存 JS，刷新网页           | 单机开发，最简便         |
| Follow file on disk | 监视磁盘文件变化            | 同步整个脚本，包括元数据 |
| 官方 MCP            | Agent 直接读写 Tampermonkey | AI Agent 自动维护        |
| GitHub + 更新 URL   | 定期拉取已发布版本          | 多设备同步、版本发布     |

我的建议是：

**如果只是解决重复复制 JS 的麻烦，使用 `@require` 就足够。**

**如果你希望 Agent 能够查看现有脚本、修改代码、更新元数据，甚至创建新脚本，我更推荐 Tampermonkey 官方 MCP。**

你还可以把两种方式组合起来：用 Git 管理本地源码，通过 `@require` 快速测试；需要改动 Tampermonkey 元数据时，再使用 MCP。这样既保留 Git 版本历史，也避免直接操作浏览器的 LevelDB 数据库。

**来源:**

- [Retrieve userscripts from chrome backups · Issue #872 · Tampermonkey/tampermonkey · GitHub](https://github.com/Tampermonkey/tampermonkey/issues/872)
- [javascript - Where are Chrome/Tampermonkey userscripts stored on the filesystem? - Stack Overflow](https://stackoverflow.com/questions/11850460/where-are-chrome-tampermonkey-userscripts-stored-on-the-filesystem/11860530)
- [Where is extension state stored in Chrome? - Super User](https://superuser.com/questions/1869574/where-is-extension-state-stored-in-chrome)
- [Documentation \| Tampermonkey](https://www.tampermonkey.net/documentation.php?locale=en\&q=update_url)
- [Documentation \| Tampermonkey](https://www.tampermonkey.net/documentation.php?locale=en\&q=version)
