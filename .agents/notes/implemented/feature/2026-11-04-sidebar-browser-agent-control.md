# Agent Note: Sidebar Browser agent control

Status: implemented

English | [中文](2026-11-04-sidebar-browser-agent-control.zh.md)

## Problem

Agent-facing tools need to read and operate the Desktop Sidebar Browser tabs of their own Session. The [Desktop Browser decision](2026-09-20-desktop-browser-webview.md) requires an authenticated, target-scoped broker for automation instead of access to every application target. No single process holds every fact that scoping needs: the Host knows which Session a tool call belongs to but holds no Electron objects, the main process owns guests but does not know Sessions, and only the renderer knows which Sidebar tabs belong to which Session.

## Decision

Control follows the processes that already own those facts: Host tool → Client renderer → `sidebarBrowserControl` Client service → the tab's `BrowserController` → `DesktopBrowserBridge.control(lease, command)` over one Electron IPC channel → the main process runs the operation on that lease's guest. There is no Host-to-main channel.

- **The Client enforces Session scope.** `sidebarBrowserControl` exists only in the Desktop renderer. Each call names a Session, reaches a tab only when the Sidebar layout records it with kind `browser` for that Session, and dispatches through that Session's own controllers. `open` creates a tab only in the on-screen Session.
- **The main process enforces target scope.** IPC passes `assertProductSender` first. `DesktopBrowserGuests.control` accepts a lease only from the window that acquired it while its guest is attached, and answers an unknown, released, unattached or foreign lease with the same `unavailable` value.
- **Operations are a closed command set**: `read`, `screenshot`, `navigate`, `click`, `type`, `key` and `scroll`. The main process parses them strictly; no caller-supplied script, CDP command or debugger attachment reaches a guest. `read` runs fixed code in an isolated world, so page scripts share the DOM but cannot replace the built-ins it calls, and the main process validates every returned field. Navigation keeps the guest's HTTP(S) and Casper-host policy.
- **Coordinates are CSS pixels.** Screenshots are scaled to the CSS viewport, `read` reports element rectangles in the same space, and the main process multiplies input coordinates by the guest zoom factor.
- **Each lease runs one operation at a time**, bounded at 15 seconds, or 30 seconds for navigation. A hung page fails with `timed-out` and the next queued command runs.
- **Failures are values with explicit outcomes.** `not-dispatched` means nothing reached the page; `unknown` means it may have. Input results report delivery, never the page's reaction, and nothing is retried. Observations that cross a navigation or a lease release are discarded.

## Alternatives considered

**Give the Host a channel to the main process.** The Host would need a Session-to-guest mapping that duplicates the renderer's Sidebar layout, plus a second authenticated channel into the main process. The renderer already owns that mapping.

**Expose the Chrome DevTools Protocol or a remote-debugging port.** CDP reaches every target of the process, including the Casper application document, and accepts arbitrary script. A fixed command set limits authority to one guest and to operations the main process can bound and validate.

**Evaluate the read script in the page's main world.** Page scripts could replace `innerText`, `getBoundingClientRect` or `querySelectorAll` and forge results. An isolated world shares only the DOM.

**Address tabs by lease in the Client service.** Leases are guest reservations that change whenever a guest is recreated; Sidebar tab ids last as long as the tab and are what Session scoping checks.

## Consequences

Agent tools can browse beside the conversation, and each operation stays inside one Session's tabs and one approved guest. Operated pages use the Workspace partition's site logins, and page content returned to a model is untrusted data. A tab can be opened only while its conversation is on screen; an off-screen Session can still control its retained live tabs.

`read` covers the main document only; iframe and shadow-root content is not listed. Keyboard input is sent without focusing the guest so that it does not take focus from the user. Unit tests with substituted Electron objects cover parsing, authorization, serialization, timeouts and Session scoping. Isolated-world evaluation, `capturePage` scaling on HiDPI displays, wheel direction and keyboard delivery to an unfocused guest have not been verified in a packaged build.
