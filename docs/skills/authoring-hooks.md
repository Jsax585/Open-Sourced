---
name: authoring-hooks
description: 새 omp 훅을 만들 때 사용합니다. HookAPI, 이벤트 목록, 도구 호출 차단/재정의, 컨텍스트 수정을 다룹니다.
---

<a id="authoring-hooks"></a>
# 훅 작성하기

훅은 에이전트 루프와 함께 실행되는 이벤트 기반 가로채기 기능입니다. 안전 정책, 비밀 정보 가리기, 컨텍스트 정리, 감사 로그 기록처럼 여러 기능에 걸친 공통 관심사에 적합합니다. 훅 모듈은 `pi.on(event, handler)`로 핸들러를 등록하며 도구 실행을 차단하거나 도구 출력을 재정의하거나 각 LLM 호출 전에 메시지 컨텍스트를 다시 작성할 수 있습니다.

> **확장과의 관계:** `HookAPI`와 독립형 `HookRunner`는 레거시 SDK API입니다. 일반 세션은 `hooks/pre/`와 `hooks/post/`의 팩터리를 포함해 JS/TS 훅 팩터리를 검색하고 `ExtensionAPI`를 사용하는 확장 실행기에 연결합니다. 새로 작성할 때는 `ExtensionAPI`를 사용하세요. 아래 레거시 계약은 사용자가 `HookRunner`를 명시적으로 사용할 때 적용됩니다. 공통 이벤트도 확장 실행기에서는 결과 연결 동작이 다를 수 있습니다.

<a id="factory-signature"></a>
## 팩터리 시그니처

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function myHook(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    // intercept every tool call
  });
}
```

기본 내보내기는 클래스가 아니라 함수여야 합니다. 이 함수는 `HookAPI` 인스턴스를 받고 팩터리 실행 중 핸들러를 등록해야 합니다. 로더는 반환된 프라미스를 기다리므로 비동기 초기화도 허용됩니다.

또는 다음과 같이 `ExtensionAPI`를 사용할 수 있습니다(권장).

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

<a id="event-catalog"></a>
## 이벤트 목록

<a id="tool-lifecycle"></a>
### 도구 수명 주기

| 이벤트 | 발생 시점 | 반환 가능한 값 |
|---|---|---|
| `tool_call` | 모든 도구 실행 전 | `{ block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string }` |
| `tool_result` | 모든 도구 실행 후 | `{ content?; details?; isError?: boolean; additionalContext?: string }` |

<a id="session-lifecycle"></a>
### 세션 수명 주기

| 이벤트 | 발생 시점 | 반환 가능한 값 |
|---|---|---|
| `session_start` | 세션을 처음 불러올 때 | — |
| `session_before_switch` | 세션 전환 전 | `{ cancel?: boolean }` |
| `session_switch` | 세션 전환 후 | — |
| `session_before_branch` | 세션 분기 전 | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_branch` | 세션 분기 후 | — |
| `session_before_compact` | 압축 전 | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session.compacting` | 압축 중(컨텍스트 주입) | `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` |
| `session_compact` | 압축 후 | — |
| `session_before_tree` | 트리 탐색 전 | `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` |
| `session_tree` | 트리 탐색 후 | — |
| `session_shutdown` | 세션 종료 시 | — |

<a id="agentturn-lifecycle"></a>
### 에이전트/턴 수명 주기

| 이벤트 | 발생 시점 | 반환 가능한 값 |
|---|---|---|
| `before_agent_start` | 에이전트가 턴을 시작하기 전 | `{ message?: { customType; content; display; details; attribution? } }` |
| `agent_start` | 에이전트 루프 시작 | — |
| `agent_end` | 에이전트 루프 종료(`willContinue`는 루프가 아직 완전히 끝나지 않았음을 나타내며, `awaitingAsyncWork`는 이미 예약된 자동 후속 실행이 아니라 백그라운드 작업을 기다리는 상태임을 나타냄) | — |
| `turn_start` | 루프 안에서 어시스턴트 응답/도구 결과 반복 단계 시작 | — |
| `turn_end` | 해당 반복 단계 종료. 메시지와 도구 결과 포함 | — |
| `context` | 각 LLM API 호출 전 | `{ messages?: Message[] }` |
| `auto_compaction_start` | 자동 압축 시작 | — |
| `auto_compaction_end` | 자동 압축 종료 | — |
| `auto_retry_start` | 자동 재시도 시작 | — |
| `auto_retry_end` | 자동 재시도 종료 | — |
| `ttsr_triggered` | TTSR(너무 짧은 응답) 발생 | — |
| `todo_reminder` | 할 일 알림 발생 | — |

`tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `input`, `user_bash`, `user_python` 같은 확장 전용 이벤트에는 `ExtensionAPI`가 필요합니다.

<a id="pre-tool-blocking-contract"></a>
## 도구 실행 전 차단 계약

실행을 막으려면 `tool_call` 핸들러에서 `{ block: true, reason: "..." }`를 반환하세요.

```ts
omp.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (/\brm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "Refusing rm -rf with an absolute-path target" };
    }
  }
});
```

계약:

- 핸들러 **하나라도** `{ block: true }`를 반환하면 실행은 즉시 중단됩니다.
- `reason`은 LLM에 표시되는 도구 오류 텍스트가 됩니다.
- 핸들러가 **예외를 던져도** 도구는 차단됩니다(안전 우선).
- 차단하지 않는 핸들러는 다음 공급자 요청에 사용할, 핸들러 작성자의 신뢰된 지침을 담은 `additionalContext`를 반환할 수 있습니다. 모든 핸들러의 서로 다른 비어 있지 않은 값은 등록 순서로 보존되며, 배치의 도구 결과 뒤에서 어시스턴트 호출 순서로 전달됩니다. 지원되는 경우 developer/system 우선순위를 갖습니다. 이어 붙인 컨텍스트가 같은 배치의 앞선 호출과 동일하면 한 번만 전달합니다. 호출이 실행되고 오류가 아닌 결과를 반환한 경우에만 전달됩니다. 이후의 차단, 승인 거절, 인터럽트로 인한 건너뛰기, 실행 실패가 발생하면 버립니다. 원시 도구 출력과 다른 신뢰할 수 없는 데이터는 도구 결과 안에 남겨야 합니다.
- 차단하지 않는 핸들러는 `input`을 반환하여 도구에 전달할 원시 인수를 대체할 수 있습니다. 마지막 대체 값이 우선하며 핸들러는 앞선 입력 수정을 보지 못합니다. `event.input`에서 파생된 게이트 전용 필드가 아니라 실제 도구 매개변수를 반환하세요. Computer 공급자 호출에는 수정을 적용하지 않습니다. 일반 확장 기반 에이전트 루프에서는 예약, 표시, 저장, 승인 전에 수정값의 스키마를 검증합니다. 반면 독립형 `HookToolWrapper`는 핸들러가 제공한 원시 대체 값을 실행에 직접 전달합니다.
- `browser.open(...)`, 직접 사용하는 `BrowserTab` 헬퍼, `tab.run(...)`, 직접 사용하는 `computer` 헬퍼, `computer.run(fnOrCode, options)` 같은 Eval 프렐류드 호출은 도구 호출이 아니며 이 훅들을 발생시키지 않습니다.

<a id="post-tool-override-contract"></a>
## 도구 실행 후 재정의 계약

LLM에 보이는 결과를 수정하거나 도구 출력 외부에 신뢰된 지침을 첨부하려면 `tool_result` 핸들러에서 `{ content, details, isError, additionalContext }`를 반환하세요.

```ts
omp.on("tool_result", async (event, ctx) => {
  if (event.toolName === "read" && !event.isError) {
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replace(/(?:sk|pk)-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]"),
      };
    });
    return {
      content: redacted,
      additionalContext: "Use the redacted result for subsequent reasoning.",
    };
  }
});
```

계약:

- 핸들러는 등록 순서로 실행됩니다. `HookAPI`에서 각 핸들러는 원래 도구 결과 이벤트를 받습니다. 반환된 `content`/`details`/`isError`는 필드별로 병합되므로 뒤의 핸들러가 정의한 필드가 우선하고, 설정하지 않은 필드는 앞선 재정의를 유지합니다(`details`, `isError`, `additionalContext`만 반환하는 핸들러가 앞선 `content`의 비밀 정보 가리기를 지우지는 않음).
- `content`는 LLM에 전달할 전체 콘텐츠 배열을 대체합니다.
- `details`는 구조화된 상세 정보 객체를 대체합니다.
- `additionalContext`는 도구 결과에 속하지 않습니다. 서로 다른 공백뿐이지 않은 값은 등록 순서로 보존되며(앞뒤 공백을 무시해 비교한 중복은 제거), 해당 호출의 `tool_call` 컨텍스트보다 먼저 전달됩니다. 이어 붙인 컨텍스트가 같은 배치의 앞선 호출과 동일하면 한 번만 전달됩니다.
- `isError`는 공통 결과 타입에 존재하지만 `HookToolWrapper`는 이 재정의를 무시합니다. 반환된 결과가 `isError: true`이면 content/details가 수정되어도 해당 플래그를 유지합니다. 도구 오류가 예외로 발생한 경우에는 핸들러가 완료된 후 다시 던집니다.
- 도구가 실패해도 `isError: true`로 `tool_result`가 발생하며, 반환된 `additionalContext`가 전달됩니다. 성공 전용 핸들러와 실패 전용 핸들러가 반대 결과에서 실행되지 않도록 `event.isError`로 필터링하세요.

<a id="context-modification-contract"></a>
## 컨텍스트 수정 계약

각 LLM API 호출 전에 메시지 목록을 다시 작성하려면 `context` 핸들러에서 `{ messages: [...] }`를 반환하세요. 이 예제처럼 사용자 지정 세션 메시지를 필터링할 때는 `ExtensionAPI`를 사용하세요.

```ts
pi.on("context", async (event, ctx) => {
  // Remove debug-only custom messages from LLM context
  const filtered = event.messages.filter(
    msg => !(msg.role === "custom" && msg.customType === "debug-only")
  );
  return { messages: filtered };
});
```

계약:

- `event.messages`는 현재까지 누적된 목록입니다.
- 핸들러는 순서대로 실행되며 각 핸들러는 앞선 핸들러의 출력을 받습니다.
- 메시지를 수정하지 않고 그대로 전달하려면 `undefined`를 반환하거나 아무것도 반환하지 마세요.

<a id="three-complete-examples"></a>
## 완전한 예제 세 가지

<a id="1-rm-rf-blocker"></a>
### 1. rm-rf 차단기

이 제한적인 정규식은 `/tmp/example`을 포함해 `rm -rf` 뒤에 절대 경로가 오는 경우에 일치합니다. 셸 파서나 완전한 안전 정책은 아닙니다.

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function rmRfBlocker(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = String(event.input.command ?? "");
    if (!/\brm\s+-rf\s+\//.test(cmd)) return;

    // Allow if user explicitly confirms (interactive mode only)
    if (ctx.hasUI) {
      const allow = await ctx.ui.confirm(
        "Dangerous command",
        `This command recursively deletes an absolute-path target:\n${cmd}\n\nProceed?`
      );
      if (allow) return;
    }

    return { block: true, reason: "rm -rf with an absolute-path target blocked by safety policy" };
  });
}
```

<a id="2-api-key-redactor"></a>
### 2. API 키 가리기

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Common API-key shapes. Not exhaustive — providers using bespoke formats
// (Anthropic `sk-ant-…`, JWT-style bearers, gateway-specific prefixes, etc.)
// need their own entries.
const SECRET_PATTERNS = [
  /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bghp_[a-zA-Z0-9]{36}\b/g,
  // Zhipu / GLM Coding Plan: `<id>.<secret>` (no `sk-` prefix).
  /\b[a-zA-Z0-9]{16,}\.[a-zA-Z0-9]{16,}\b/g,
  /\b[a-zA-Z0-9_-]{20,}\s*=\s*["']?[a-zA-Z0-9._/+=-]{20,}["']?/g,
];

export default function apiKeyRedactor(omp: HookAPI): void {
  omp.on("tool_result", async (event) => {
    if (event.isError) return;

    let changed = false;
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      let text = chunk.text;
      for (const pattern of SECRET_PATTERNS) {
        const next = text.replace(pattern, "[REDACTED]");
        if (next !== text) { changed = true; text = next; }
      }
      return { ...chunk, text };
    });

    if (changed) return { content: redacted };
  });
}
```

<a id="3-context-filter"></a>
### 3. 컨텍스트 필터

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function contextFilter(omp: HookAPI): void {
  omp.on("context", async (event) => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;

    const trimmed = event.messages.map(msg => {
      // Truncate very large tool results to keep context manageable
      if (msg.role !== "toolResult") return msg;
      const content = msg.content.map(chunk => {
        if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
        return {
          ...chunk,
          text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated by context-filter hook]",
        };
      });
      return { ...msg, content };
    });

    return { messages: trimmed };
  });
}
```

<a id="ui-methods-in-hook-context"></a>
## 훅 컨텍스트의 UI 메서드

`ctx.ui`는 `HookUIContext`입니다. 다음 메서드를 사용할 수 있습니다.

| 메서드 | 설명 |
|---|---|
| `notify(message, type?)` | 앱 내 알림 표시 |
| `setStatus(key, text)` | 하단 상태 텍스트 설정(키별 저장, 키순 정렬) |
| `select(title, options)` | 선택 대화 상자 표시 |
| `confirm(title, message)` | 예/아니요 대화 상자 표시 |
| `input(title, placeholder?)` | 텍스트 입력 대화 상자 표시 |
| `editor(title, prefill?, { signal }?, { promptStyle }?)` | 여러 줄 편집기 표시 |
| `setEditorText(text)` | 입력 편집기 내용 설정 |
| `getEditorText()` | 현재 입력 편집기 내용 가져오기 |
| `custom(factory)` | 사용자 지정 TUI 컴포넌트 렌더링 |
| `theme` | 현재 테마 객체 |

Enter로 제출하고 Shift+Enter로 줄을 바꾸려면 네 번째 인수로 `{ promptStyle: true }`를 전달하세요. 기본 훅 편집기는 Enter로 줄을 바꾸고 `app.message.followUp` 단축키(`Ctrl+Q` 또는 `Ctrl+Enter`)로 제출합니다.

대화형 호출은 `ctx.hasUI`로 보호하세요. 출력 모드와 일반적인 헤드리스/하위 에이전트 세션에는 대화형 UI가 없습니다. RPC는 확장 컨텍스트에 자체 UI 브리지를 제공할 수 있습니다. 사용자 지정 TUI 컴포넌트처럼 터미널 전용 확장 UI에는 `ctx.mode === "tui"`를 사용하세요.

<a id="further-reading"></a>
## 더 읽어보기

- `docs/hooks.md` — 훅 하위 시스템 내부 구조, 순서 규칙, 오류 전파
- `docs/extensions.md` — `ExtensionAPI`(`HookAPI`의 상위 집합)
- `docs/skills/examples/safety-hook/` — 완전히 작동하는 예제
