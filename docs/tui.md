# TUI integration for extensions and custom tools

This document covers the **current** TUI contract used by `packages/coding-agent` and `packages/tui` for extension UI, custom tool UI, and custom renderers.

## What this subsystem is

The runtime has two layers:

- **Rendering engine (`packages/tui`)**: differential terminal renderer, input dispatch, focus, overlays, cursor placement.
- **Integration layer (`packages/coding-agent`)**: mounts extension/custom-tool components, wires keybindings/theme, and restores editor state.

## Runtime behavior by mode

| Mode                | `ctx.ui.custom(...)` availability | Notes                                                                                                                          |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Interactive TUI     | Supported                         | Component is mounted in the editor area or overlay, focused, and must call `done(result)` to resolve.                          |
| Background/headless | Not interactive                   | UI context is no-op (`hasUI === false`).                                                                                       |
| RPC mode            | Not mounted                       | `custom()` is implemented as unsupported UI and returns `undefined as never`; do not depend on interactive UI in RPC handlers. |

If your extension/tool can run headless, guard with `ctx.hasUI` / `pi.hasUI`. RPC can expose `hasUI === true` for protocol-backed dialogs while still not supporting `custom()`; `hasUI` alone does not guarantee a component can be mounted.

## Project-local TUI debug tool

`.omp/tools/tui.ts` provides the repository's `tui` debug tool. `start` accepts
either a TypeScript/JavaScript `file` (run with Bun) or an executable `bin` with
separate `args`. Windows uses native ConPTY without requiring a POSIX shell;
macOS/Linux use Bun's PTY.
The debug connection uses a Windows named pipe or a POSIX Unix socket.
On Windows, `start` and `resize` use the native `normalizePtyDimensions(cols, rows)`
helper, which returns integer dimensions clamped to 20–400 columns and 5–200 rows.
The PTY, emulated screen, and reported size use the same effective dimensions.

`screen`, `send`, `resize`, and `stop` also work for programs without an
`OMP_TUI_DEBUG` server. Renderer queries (`info`, `tree`, `values`, and `frame`)
require an omp/pi-tui host.

`send` accepts literal text and `\e`, `\r`, `\n`, `\t`, and `\xNN` escapes.
On Windows, each payload must contain complete, valid UTF-8; invalid or truncated
sequences are rejected before any input is written. Arbitrary non-UTF-8 bytes
(such as `\x9b` 8-bit CSI) are not supported by the Windows PTY string API.
Use the UTF-8-compatible `\e[` CSI sequence instead. macOS/Linux preserve raw bytes.

Install the tool's dependencies with `bun install --cwd .omp/tools`.
Native PTY API changes require rebuilding the addon with
`bun --cwd=packages/natives run build` before running the tool.
Run its real-PTY regressions with `bun test ./.omp/tests/tui.test.ts`. CI runs
them on Linux only; the Windows-specific cases run only on a local Windows host.

## Core component contract (`@oh-my-pi/pi-tui`)

`packages/tui/src/tui.ts` defines:

```ts
export interface Component {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate?(): void;
  releaseRenderCaches?(): void;
  setIgnoreTight?(ignore: boolean): any;
  dispose?(): void;
}
```

Render results are component-owned and immutable to callers. An unchanged component may (and should) return the **same array reference** it returned last time; it must return a new array whenever content changes. Reference equality enables container memoization and stable-prefix work avoidance. A component that mutates a previously returned array in place must also implement `RenderStablePrefix` and report how many leading rows survived unchanged.

`releaseRenderCaches()` drops only derived rows, parsing, and formatting state. The next `render()` must reproduce the same rows from retained source state. Do not rebuild eagerly, invoke renderer callbacks, convert images, or replace or dispose children in this hook. The transcript calls it after retirement or replay batches are acknowledged, or immediately when replay has no rows to acknowledge. Semantic full renders and resized tails release committed caches after producing their rows. Tool cards can use `ToolCardOptions.onReleaseRenderCaches` to drop builder-owned memos, and `releaseRenderedStringCache()` clears a `RenderedStringCache` used for formatted strings.

`Focusable` is separate:

```ts
export interface Focusable {
  focused: boolean;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
}
```

Cursor behavior uses `CURSOR_MARKER` (not `getCursorPosition`). Focused components emit the marker in rendered text; `TUI` extracts it and positions the hardware cursor.

Fullscreen overlays opt into the shared hardware cursor only when the user's hardware-cursor preference is enabled and the focused component implements `setUseTerminalCursor`. The focus target must be the top overlay itself or a child it owns via `OverlayFocusOwner.ownsOverlayFocusTarget`; wrappers must forward focus and cursor mode to their input. Emit `CURSOR_MARKER` at the caret without replacing the underlying glyph. With the preference disabled, keep the software cursor; losing focus or removing the marker hides the hardware cursor.

## Rendering constraints (terminal safety)

Your `render(width)` output must be terminal-safe:

1. **Do not intentionally exceed `width` on any line**. The renderer truncates overwide non-image lines as a last-resort guard, but components should still return width-safe output.
2. **Measure visual width**, not string length: use `visibleWidth()`.
3. **Truncate/wrap ANSI-aware text** with `truncateToWidth()` / `wrapTextWithAnsi()`.
4. **Sanitize tabs/content** from external sources using `replaceTabs()` (and higher-level sanitizers in coding-agent render paths).

Minimal pattern:

```ts
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

render(width: number): readonly string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## Input handling and keybindings

### Raw key matching

Use `matchesKey(data, "...")` for navigation keys and combos.

### Match app keybinding actions

Extension UI factories receive a `KeybindingsManager` (interactive mode; an in-memory instance carrying the default bindings, not the user's `keybindings.yml`) so you can match action ids instead of hardcoding keys:

```ts
if (keybindings.matches(data, "app.interrupt")) {
  done(undefined);
  return;
}
```

### Key release/repeat events

Key release events are filtered unless your component sets:

```ts
wantsKeyRelease = true;
```

Then use `isKeyRelease()` / `isKeyRepeat()` if needed.

## Focus, overlays, and cursor

- `TUI.setFocus(component)` routes input to that component.
- Overlay APIs exist in `TUI` (`showOverlay`, `OverlayHandle`). In interactive extension/custom UI, `custom(..., { overlay: true })` mounts your component through `TUI.showOverlay(...)`; without `overlay`, it replaces the editor component area directly.
- By default, overlay custom UI is anchored at `bottom-center` with full terminal width/max height. `overlayOptions` can override positioning and sizing; `onHandle` receives the `OverlayHandle`. The overlay is removed when `done(...)` closes the flow.

### Built-in full-screen surfaces

The coding-agent integration also mounts built-in full-screen surfaces outside `ctx.ui.custom(...)`. [Agent Hub](./agent-hub.md) is the live roster and control surface for subagents. Its file-backed transcript viewer borrows the alternate screen while it is open, then restores the Hub beneath it on close.

### Mermaid figures and inspection

With `tui.renderMermaid` enabled, completed top-level Mermaid fences in assistant replies can become static, bounded figures in the interactive row-rendered transcript. This uses the existing SVG/image pipeline and image budget when images are enabled and a terminal image protocol is available; it does not require `tui.renderSvg`. A large preview shows overall structure, not necessarily readable labels. Detailed inspection uses the full diagram derived from the original Mermaid, not an enlarged preview PNG. Tool file/fence previews retain their existing ASCII Mermaid behavior.

Figures use one built-in theme derived from OMP's active light/dark palette, with distinct group and node surfaces and restrained flowchart shape accents. Explicit Mermaid `classDef` and `style` paint overrides the defaults. Styling changes colors only: fonts, node geometry, source, and layout are preserved. Theme changes repaint the cached diagram rather than laying it out again. The same styling applies in chat and inspection; authored SVGs and numeric table charts keep their existing appearance. There is no separate Mermaid theme picker or custom-CSS setting.

The default assistant instructions favor horizontal Mermaid layouts where supported, using `flowchart LR` for flowcharts unless another direction is specified. This is an authoring preference: rendering preserves the direction in the original source and does not rotate existing diagrams.

When file hyperlinks are enabled and the host's blob store is available, previews include **Open image** and **Open SVG** caption links. OMP creates the files for these captions from the full themed diagram, not the fitted preview; the agent does not author file paths or links. Natural-size or 2× PNG exports stay within the existing 4096-pixel raster edge limit. A larger diagram keeps its complete SVG caption link instead of receiving a reduced or cropped PNG export. Files open through the terminal's configured file handler, which may be an image viewer, editor, or browser; nothing launches automatically. The files live on the machine running OMP, so SSH/container users may need a transfer or shared mount. The same-terminal reader does not depend on external file access.

File captions keep their reserved rows and links when the image budget hides a preview. As with other images, a generic `[Image: …]` placeholder can separately link to the fitted preview; use **Open image**/**Open SVG** for full exports or `/copy` for source-backed inspection. A completed reply is not retired into terminal history until its current caption-file exports have settled, so scrollback keeps the same full-file access as the live transcript.

The existing `/copy` reader provides same-terminal, read-only graphical inspection:

1. Select a reply and press **o** to expand its only Mermaid diagram directly. If it contains several diagrams, **o** enters the existing block selector with the first Mermaid block selected; choose a diagram and press **o** again. **Right** still enters blocks manually. **Enter** keeps copying the selected whole reply or block, including the original Mermaid source.

   Inspection and block copying recognize the same backtick and tilde fences, including longer delimiters, up to three leading spaces, and LF, CRLF, or CR separators. The preview and reader share one layout; copying still preserves the authored body, including its internal separators and blank lines.

2. In the diagram view, use **arrows** or **h/j/k/l** to pan, **+/-** to zoom, **0** to fit the whole diagram, **1** for natural size, and **s** to toggle the original source.
3. **Esc** returns to the prior reply or block selection. Closing `/copy` restores chat and the composer draft. Rewind has no diagram inspection action.

Annotation message pickers use the same inspection controls through their shared reader.

Same-terminal Mermaid inspection is keyboard-only: the diagram image has no click targets, hover bands, or wheel controls. The separate file links use terminal-native hyperlink activation and do not enable normal-chat mouse capture. Keep the existing default `tui.mouse: false` for ordinary terminal history scrolling. Use `/copy` to inspect older diagrams, including ones whose preview pixels have been demoted by the image budget. Existing OMP mouse controls for other components are unchanged.

The reader crops a bounded viewport of the full diagram at the chosen scale. It does not split the transcript into image bands, raise the image budget, launch a browser, or turn model-authored diagram nodes into controls. Source remains canonical for copying, persistence, replay, search, and export. Rasterized labels are not terminal-selectable or searchable; use the source view for text access.

Compatibility and fallbacks:

- `tui.renderMermaid` off keeps the source fence. With it on, unavailable/disabled graphics or unsupported, invalid, or over-limit diagrams use the existing ASCII rendering where possible, otherwise the original source. Source remains accessible if graphical inspection cannot render.
- Graphical limits use encoded UTF-8 bytes: 64 KiB for Mermaid source and 1 MiB for the resolved SVG. Over-limit diagrams keep the fallback and original source instead of bypassing the limits with multibyte labels.
- iTerm2, Kitty, and SIXEL use the existing capability detection and image transport. tmux, SSH, and containers still depend on those capabilities and passthrough; no protocol is forced and no local file opener is required.
- Native Tern/TSP retains its Mermaid/source description path; graphical inspection is a row-mode surface. Print, headless, RPC, SDK, and existing export paths retain source rather than acquiring an interactive viewer.

## Mount points and return contracts

## 1) Extension UI (`ExtensionUIContext`)

Current signature (`extensibility/extensions/types.ts`):

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: ExtensionCustomOptions,
): Promise<T>
```

Behavior in interactive mode (`extension-ui-controller.ts`):

- Saves editor text.
- Without `options.overlay`, replaces the editor component with your component.
- With `options.overlay`, mounts your component as an overlay instead of replacing the editor; `overlayOptions` accepts static options or a function evaluated when mounting.
- `options.onHandle` receives the mounted overlay handle.
- `options.signal` aborts the flow and rejects its promise with the signal's reason (or `AbortError`); a component returned after cancellation is disposed rather than mounted.
- Focuses your component.
- On `done(result)`: calls `component.dispose?.()`, hides the overlay if present, restores editor + text for non-overlay flows, focuses editor, resolves promise.
  Call `done(...)` to complete successfully; factory failures and signal cancellation reject the promise.

## 2) Hook/custom-tool UI context (`HookUIContext`)

Current signature (`extensibility/hooks/types.ts`) matches the interactive
controller and `ExtensionUIContext.custom`:

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
): Promise<T>
```

Use the fourth argument as `done`. The third argument is a `KeybindingsManager`
(interactive mode uses an in-memory instance with the default bindings). Guard
terminal-only UI with `pi.hasUI` when the hook may also run headless.

## 3) Custom tool call/result renderers

Custom tools and extension tools can return components from:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

`options` currently includes:

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

For `renderCall`, the `options` argument also answers the `Theme` API (`fg`,
`bold`, `symbol`, …), so renderers ported from upstream pi — declared
`renderCall(args, theme, context)` — keep working unchanged.

These renderers are mounted by `ToolExecutionComponent`.

On Tern Surface Protocol terminals, tools may additionally supply `describeCall(args, options)` and `describeResult(result, options, args?)`, returning a semantic `NativeToolView` or `undefined`. Custom components can implement `describe(cx)` and `handleNativeEvent(event)`; otherwise the native backend falls back to their rendered rows. See [the core renderer contract](./tui-core-renderer.md#native-rendering-tern-surface-protocol).

## Lifecycle and cancellation

- `dispose()` is optional at type level but should be implemented when you own timers, subprocesses, watchers, sockets, or overlays. It must be idempotent: containers propagate disposal, and reset/removal paths may converge.
- `done(...)` should be called exactly once from your component flow.
- For cancellable long-running UI, pair `CancellableLoader` with `AbortSignal` and call `done(...)` from `onAbort`.

Example cancellation pattern:

```ts
const loader = new CancellableLoader(
  tui,
  text => theme.fg("accent", text),
  text => theme.fg("muted", text),
  "Working...",
);
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then(result => {
  if (!loader.aborted) done(result);
});
return loader;
```

## Realistic custom component example (extension command)

```ts
import type { Component } from "@oh-my-pi/pi-tui";
import {
  SelectList,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import {
  getSelectListTheme,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): readonly string[] {
    return this.list
      .render(width)
      .map((line) => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          const items = [
            { value: "fast", label: theme.fg("accent", "Fast") },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Quality" },
          ];
          return new Picker(items, keybindings, done);
        },
      );

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## Key implementation files

- `packages/tui/src/tui.ts` — `Component`, `Focusable`, cursor marker, focus, overlay, input dispatch.
- `packages/tui/src/utils.ts` — width/truncation/sanitization primitives.
- `packages/tui/src/keys.ts` / `keybindings.ts` — key parsing and base TUI action mapping; `app-keybindings.ts` adds coding-agent actions and disk loading.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — interactive mounting/unmounting for extension/hook/custom-tool UI.
- `packages/coding-agent/src/extensibility/extensions/types.ts` — extension UI and renderer contracts.
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI contract.
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — custom tool execute/render contracts.
- `packages/tui/src/chat/tool-execution.ts` — mounting `renderCall`/`renderResult` components and partial-state options.
- `packages/coding-agent/src/tools/context.ts` — tool UI context propagation (`hasUI`, `ui`).
