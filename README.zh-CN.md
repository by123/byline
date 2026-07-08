# Byline

[English](README.md) | **简体中文**

**一个能看见 AI 工作状态的 macOS 终端。**

把 `claude`、`codex`、`cursor-agent` —— 或任何终端 AI agent —— 各自跑在一个标签页里，
Byline 让你一眼看清：哪个正在**思考**、哪个在**等你确认**、哪个已经**完成**。
不用再盯着终端伺候 agent：并行驱动多个，只在真正需要你的时候切过去。

Byline 底层是一个*真正的*终端，不是包装出来的 UI：[xterm.js](https://xtermjs.org/) +
真实 PTY（[node-pty](https://github.com/microsoft/node-pty)），跑的是你自己的交互式
login `zsh`。原生补全、颜色、`vim`、`ssh`、你的 `.zshrc` 和 Powerlevel10k 提示符 ——
一切照常工作。

> 早期版本（`v0.7.0`）· macOS · Apple Silicon (arm64) · 未签名本地构建

---

## 为什么做这个

终端 AI agent 是交互式的：输出流几分钟后，突然停在一个你没看见的 `y/n` 确认上。
开三个 agent 三个标签页，你要么不停轮巡，要么一小时后才发现全都卡在权限确认上。

Byline 把这件事反过来：每个会话都有实时状态 —— 每个标签一盏红绿灯，同时显示在
标签栏和会话侧栏里：

- 🫧 **思考中** —— agent 正在工作，状态点以红绿灯色呼吸闪烁
- 🟡 **需要确认** —— 它停下来等你了（`y/n`、`proceed?`、权限请求）。后台标签会亮起
  角标，绝不会错过。
- 🟢 **完成** —— 本轮结束，输出等你审阅
- 🔴 **无活动** —— 停在 shell 提示符，空闲可派活

侧栏还有整体统计（`3 个会话 · 1 需要确认 · 1 完成`），整个 agent 编队一眼扫完。

## 状态检测是怎么工作的

三层机制，权威优先，逐级降级：

1. **Agent hooks（权威）** —— 支持生命周期 hooks 的 agent（如 Claude Code）通过一个
   极简的文件协议上报状态：把一个词（`think` / `confirm` / `done` / …）写进
   `/tmp/byline_sessions/$BYLINE_SID`。精确、即时、按标签页隔离。仓库自带 hook 脚本和
   Claude Code 一键安装器，见 [`hooks/`](hooks/) 与 [hooks/README.md](hooks/README.md)。
2. **Shell 集成（精确的命令生命周期）** —— Byline 通过 `ZDOTDIR` 先加载你真实的
   z 文件，再注入 OSC 133 标记：`preexec` = 命令开始，`precmd` = 回到提示符。对*任何*
   程序（不只是 agent）都能给出精确的**运行中 / 空闲**信号。
3. **输出启发式（兜底）** —— 命令运行期间，持续输出 = *思考中*；输出安静下来且结尾
   像确认提示（`y/n`、`proceed?`、`❯` 菜单…）= *需要确认*。模式在
   `renderer/index.html`（`WAIT_RE`）里，容易调整。

有 hook 状态的会话完全忽略启发式；agent 进程退出后，自动交还给 shell 集成层。

### 给 Claude Code 启用权威状态

```bash
cd hooks
./install.sh     # 把 byline-status hook 注册进 ~/.claude/settings.json
```

这个 hook 在 Byline 之外是空操作，几乎零延迟（异步、零依赖 POSIX sh），
`./install.sh --uninstall` 可干净卸载。任何能在生命周期事件上执行命令的 agent
都能复用同一个脚本 —— 协议与 agent 无关。

## 一个真正的终端

- **node-pty** —— 每个标签页都是货真价实的交互式 login `zsh`；`vim`、`ssh`、`tmux`、
  补全和你的提示符表现与 Terminal.app 完全一致
- **xterm.js + WebGL 渲染** —— 跟得上 agent 刷屏的渲染速度，任意行高下制表符
  边框（Claude Code 的 `╭─╮` 框）都能绘制饱满
- **流控** —— PTY 输出按帧合并并带背压，`cat` 一个巨型文件也不会卡死界面
- **文件 → 路径** —— Finder 里 ⌘C 复制文件后在终端 ⌘V，或直接把文件拖进窗口，
  自动插入 shell 转义好的完整路径（和 Terminal.app 一样）
- **链接与剪贴板** —— 纯文本 URL 和 OSC 8 超链接可点击（默认浏览器打开），
  OSC 52 让 `tmux`/`nvim`/`ssh` 里的复制直达系统剪贴板
- **搜索**（`⌘F`）、Unicode 11 宽度处理、8000 行回滚、浅色/深色主题

## 多会话工作流

- **快捷启动命令** —— 可配置的名称 + 命令 + 快捷键（默认：`⌘N` Claude、`⌘M` Codex），
  同时出现在应用菜单和命令面板里
- **命令面板**（`⌘K`）—— 所有操作与快捷启动，模糊过滤
- **会话快捷指令** —— 右键侧栏中的会话，把保存好的提示词（"继续"、"提交改动"…）
  直接发进那个会话，无需切换标签
- **Chrome 风格标签页** —— 拖动排序、双击重命名、右键关闭其他/右侧标签
- **快捷键全部可配** —— 每个操作和快捷命令都能在偏好设置（`⌘,`）里重新绑定

### 键盘

| 快捷键 | 操作 | 快捷键 | 操作 |
| --- | --- | --- | --- |
| `⌘T` | 新建标签 | `⌘B` | 显示/隐藏侧栏 |
| `⌘W` | 关闭标签 | `⌘K` | 命令面板 |
| `⌘N` / `⌘M` | 新建 Claude / Codex | `⌘F` | 搜索回滚 |
| `⌘1…9` | 切换标签（按视觉顺序） | `⌘+ / ⌘- / ⌘0` | 字号 |
| `⌘R` | 重命名标签 | `⌘,` | 偏好设置 |

其余按键全部直通 shell。

---

## 安装

目前从源码构建（签名版本在规划中）：

```bash
git clone https://github.com/by123/byline.git
cd byline/byline-app
npm install       # 仅首次
npm run rebuild   # 仅首次：按 Electron ABI 编译 node-pty
npm start         # 开发模式运行
```

构建并安装真正的 `Byline.app`：

```bash
npm run package   # -> dist/Byline-darwin-arm64/Byline.app
npm run deploy    # 打包 + 安装到 /Applications（自动移除隔离属性）
```

构建未签名；如果 Gatekeeper 拦截双击，右键 → **打开** 一次即可，或执行
`xattr -dr com.apple.quarantine dist/Byline-darwin-arm64/Byline.app`。

环境要求：Apple Silicon 的 macOS、Node.js ≥ 20、Xcode Command Line Tools
（编译 node-pty 用）。

## 仓库结构

```
byline-app/            Electron 应用本体
├── main.js            主进程：PTY 会话、状态文件监听、应用菜单
├── preload.js         沙箱化、上下文隔离的 window.byline 桥
├── renderer/
│   ├── index.html     xterm.js 界面：标签、侧栏、状态机、命令面板
│   └── vendor/        本地内置的 xterm.js 及插件（运行时不走 CDN）
├── shell/             ZDOTDIR z 文件：加载用户配置 + OSC 133 标记
└── build/             应用图标

hooks/                 状态协议 + agent hooks（见 hooks/README.md）
├── byline-status      零依赖 POSIX sh hook：一个词 -> 一个状态文件
└── install.sh         Claude Code 一键安装/卸载

byline-terminal/       早期单文件 HTML 设计原型（仅存档）
```

## 规划

- 界面 i18n（英文界面）
- 内置更多 agent 的 hook 适配
- 分屏；会话跨启动持久化
- 签名、公证的 `.app` / `.dmg` 发布；Intel (x64) 构建
- 根据真实使用调优各 agent 的"需要确认"识别模式

## 参与

欢迎 Issue 和 PR。代码库刻意保持小巧 —— 三个应用代码文件、零框架 —— 大多数改动是
一下午的事，不是一场架构工程。如果某个 agent 的状态识别不准，开 Issue 附上终端
输出结尾一段即可，方便调模式。

## 许可证

[MIT](LICENSE)
