# Agent Note: Sidebar Browser agent 控制

Status: implemented

[English](2026-11-04-sidebar-browser-agent-control.md) | 中文

## Problem

面向 agent 的工具需要读取并操作其所属 Session 的 Desktop Sidebar Browser tab。[Desktop Browser 决策](2026-09-20-desktop-browser-webview.zh.md)要求自动化经过认证、限定 target 的 broker，而不是访问全部应用 target。限定范围所需的事实不在同一个进程中：Host 知道工具调用属于哪个 Session，但不持有 Electron 对象；主进程拥有 guest，但不知道 Session；只有渲染进程知道哪些 Sidebar tab 属于哪个 Session。

## Decision

控制沿着已经拥有这些事实的进程传递：Host 工具 → Client 渲染进程 → `sidebarBrowserControl` Client 服务 → 该 tab 的 `BrowserController` → 经由一条 Electron IPC 通道的 `DesktopBrowserBridge.control(lease, command)` → 主进程在该租约的 guest 上执行操作。不存在 Host 到主进程的通道。

- **Client 负责 Session 范围。** `sidebarBrowserControl` 只存在于 Desktop 渲染进程中。每次调用指定一个 Session，只有当 Sidebar 布局把某个 tab 以 `browser` 类型记录在该 Session 下时才能触达它，并通过该 Session 自己的 controller 分发。`open` 只在显示于屏幕上的 Session 中创建 tab。
- **主进程负责 target 范围。** IPC 先经过 `assertProductSender`。`DesktopBrowserGuests.control` 只接受由获取该租约的窗口发来、且 guest 已挂载的租约；对未知、已释放、未挂载或属于其他窗口的租约，统一返回相同的 `unavailable` 值。
- **操作是封闭的命令集合**：`read`、`screenshot`、`navigate`、`click`、`type`、`key` 和 `scroll`。主进程严格解析这些命令；调用方提供的脚本、CDP 命令或调试器挂载都不会到达 guest。`read` 在 isolated world 中运行固定代码，页面脚本与它共享 DOM，却无法替换它调用的内置函数；主进程会校验返回的每个字段。导航沿用 guest 的 HTTP(S) 与 Casper 主机策略。
- **坐标使用 CSS 像素。** 截图缩放到 CSS 视口，`read` 在同一坐标空间中报告元素矩形，主进程把输入坐标乘以 guest 的缩放系数。
- **每个租约一次只运行一个操作**，时限为 15 秒，导航为 30 秒。挂起的页面以 `timed-out` 失败，队列中的下一条命令随即运行。
- **失败以带有明确结果的值返回。** `not-dispatched` 表示没有任何内容到达页面；`unknown` 表示可能已经到达。输入结果只报告投递，从不报告页面的反应，也不会重试。跨越导航或租约释放的观察结果会被丢弃。

## Alternatives considered

**为 Host 提供到主进程的通道。** Host 需要一份与渲染进程 Sidebar 布局重复的 Session 到 guest 的映射，还需要第二条进入主进程的认证通道。渲染进程已经拥有这份映射。

**暴露 Chrome DevTools Protocol 或远程调试端口。** CDP 能触达进程中的全部 target，包括 Casper 应用文档，并接受任意脚本。固定命令集合把权限限制在一个 guest 以及主进程能够限时和校验的操作上。

**在页面的 main world 中执行读取脚本。** 页面脚本可以替换 `innerText`、`getBoundingClientRect` 或 `querySelectorAll` 并伪造结果。isolated world 只共享 DOM。

**在 Client 服务中按租约寻址 tab。** 租约是 guest 预留，每次重建 guest 都会改变；Sidebar tab id 与 tab 同生命周期，也正是 Session 范围检查所用的标识。

## Consequences

Agent 工具可以在对话旁浏览网页，每个操作都限定在一个 Session 的 tab 和一个已批准的 guest 内。被操作的页面使用该工作区分区的站点登录状态，返回给模型的页面内容是不可信数据。只有对话显示在屏幕上时才能打开 tab；不在屏幕上的 Session 仍可控制其保留的 live tab。

`read` 只覆盖主文档，不列出 iframe 与 shadow root 中的内容。键盘输入发送时不会让 guest 获得焦点，以免夺走用户的焦点。使用替身 Electron 对象的单元测试覆盖了解析、授权、串行化、超时与 Session 范围。isolated world 执行、HiDPI 显示器上的 `capturePage` 缩放、滚轮方向以及向未获焦 guest 投递键盘输入，尚未在打包构建中验证。
