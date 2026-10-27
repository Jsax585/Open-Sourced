<a id="hooks"></a>
# 훅

이 문서는 `packages/coding-agent/src/extensibility/hooks/*`에 있는 **현재 훅 하위 시스템 코드**를 설명합니다.

<a id="current-status-in-runtime"></a>
## 현재 런타임 상태

기본 CLI 런타임은 **확장 실행기** 경로를 초기화합니다. 현재 시작 흐름은 다음과 같습니다.

- `--hook`은 `--extension`의 별칭으로 처리됩니다(CLI 경로는 `additionalExtensionPaths`에 병합).
- `hookCapability`로 검색한 JS/TS 훅 팩터리(예: `.omp/hooks/pre/*.ts`)는 확장 모듈로 불러오므로 `pi.on(...)` 핸들러가 런타임 이벤트 버스에 연결됩니다.
- 도구는 `HookToolWrapper`가 아니라 `ExtensionToolWrapper`로 감쌉니다.
- 컨텍스트 변환과 수명 주기 이벤트 발생은 `ExtensionRunner`를 거칩니다.

따라서 이 문서는 레거시 훅 하위 시스템 구현 자체(타입/로더/실행기/래퍼)와, 검색된 훅 경로를 확장 실행기로 불러올 때 여전히 허용되는 팩터리 형식을 설명합니다.

일반 세션에서 검색된 팩터리는 `HookAPI`/`HookContext` 인스턴스가 아니라
`ExtensionAPI`/`ExtensionContext`를 받습니다. 공통 `pi.on(...)` 핸들러는
동작하지만 레거시 전용 컨텍스트 이름을 호환 처리하지는 않습니다. 예를 들어
확장에서는 레거시 `ctx.hasQueuedMessages()` 대신 `ctx.hasPendingMessages()`를
사용하세요. 새로운 런타임 통합에는 [확장](./extensions.md)을 권장합니다.
별도로 명시하지 않는 한 아래 실행기/래퍼 동작은 레거시 라이브러리 경로에만
해당합니다.

<a id="key-files"></a>
## 주요 파일

- `packages/coding-agent/src/extensibility/hooks/types.ts` — 훅 컨텍스트, 이벤트 타입, 결과 계약
- `packages/coding-agent/src/extensibility/hooks/loader.ts` — 모듈 로딩과 훅 검색 연결
- `packages/coding-agent/src/extensibility/hooks/runner.ts` — 이벤트 디스패치, 명령 조회, 오류 알림
- `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts` — 도구 실행 전/후 가로채기 래퍼
- `packages/coding-agent/src/extensibility/hooks/index.ts` — 내보내기/다시 내보내기
- `packages/coding-agent/src/extensibility/shared-events.ts` — 공통 이벤트/결과 계약
- `packages/coding-agent/src/extensibility/extensions/loader.ts` — 현재 런타임 검색
- `packages/coding-agent/src/extensibility/extensions/wrapper.ts` — 현재 도구 래퍼와 승인 게이트

<a id="what-a-hook-module-is"></a>
## 훅 모듈이란

훅 모듈은 팩터리를 기본 내보내기로 제공해야 합니다.

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

팩터리는 다음 작업을 할 수 있습니다.

- `pi.on(...)`으로 이벤트 핸들러 등록
- `pi.sendMessage(...)`로 영구 저장되는 사용자 지정 메시지 전송
- `pi.appendEntry(...)`로 LLM에 전달하지 않는 상태 저장
- `pi.registerCommand(...)`로 슬래시 명령 등록
- `pi.registerMessageRenderer(...)`로 사용자 지정 메시지 렌더러 등록
- `pi.exec(...)`로 셸 명령 실행, `pi.logger`로 로그 기록
- 주입된 Zod 호환 빌더 `pi.zod`, omptype 네이티브 빌더 `pi.arktype`, 레거시 `pi.typebox`, `pi.pi`를 통한 패키지 내보내기 사용

<a id="discovery-and-loading"></a>
## 검색과 불러오기

주변 경로 자동 검색을 활성화하면 세션은 `hookCapability`가 검색한 JS/TS 훅
팩터리를 확장 실행기를 통해 불러옵니다.
`discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds?, options?)`는 다음과 같이 동작합니다.

1. 네이티브 공급자에서만 확장 모듈을 불러옵니다.
2. 훅 기능 레지스트리에서 가져올 수 있는 `.ts`/`.js` 훅 팩터리를 불러옵니다(`includeAmbientHooks: false`가 아닌 경우).
3. 활성화된 플러그인의 확장 진입점을 추가합니다.
4. 명시적으로 구성한 파일/디렉터리 경로를 해석합니다.

경로는 절대 경로를 기준으로 중복을 제거합니다. `ambient: false`이면 네이티브/
설치된 항목 검색을 건너뛰지만, 구성된 패키지 루트에서 훅 팩터리가 제공될 수는
있습니다. 다른 도구의 사용자 소스는 `enabledProviders`로 명시적으로 허용해야
하며, 프로젝트 소스는 이 사용자 수준 제한의 영향을 받지 않습니다.

<a id="native-discovery-location"></a>
### 네이티브 검색 위치

네이티브 공급자는 각 구성 루트에서 두 하위 디렉터리만 검색합니다. `hooks/` **바로 아래**에 둔 팩터리는 검색되지 않습니다.

- 프로젝트: `<cwd>/.omp/hooks/pre/*.{ts,js}`와 `<cwd>/.omp/hooks/post/*.{ts,js}`
- 사용자: `<agentDir>/hooks/pre/*.{ts,js}`와 `<agentDir>/hooks/post/*.{ts,js}`(기본값 `~/.omp/agent/hooks/...`; 프로필과 `PI_CODING_AGENT_DIR` 반영)

`<cwd>/.omp/hooks/` 바로 아래의 팩터리는 주변 경로 네이티브 자동 검색으로
찾을 수 없습니다. `pre/`나 `post/`에 넣거나 경로를 명시적으로 지정하세요.
점으로 시작하는 항목과 파일이 아닌 항목은 건너뜁니다. 디렉터리와 파일의 기본
이름은 기능 메타데이터/중복 제거 키를 제공할 뿐 이벤트를 자동 등록하지는
않습니다. 팩터리에서 여전히 `pi.on(...)`을 호출해야 합니다. 이는
`.claude/hooks/pre|post/`와 같은 방식입니다. 훅 기능의 `.ts`/`.js` 팩터리만
확장 파이프라인에 추가됩니다. 명시적 확장 경로는 공통 모듈 해석기를 사용합니다.
불러오기 순서와 비활성화 제어는 [확장 불러오기](./extension-loading.md)를 참고하세요.

레거시 `discoverAndLoadHooks(configuredPaths, cwd)` 헬퍼도 여전히 존재하며 다음과 같이 동작합니다.

1. 기능 레지스트리에서 검색된 훅을 불러옵니다(`loadCapability("hooks")`).
2. 명시적으로 구성한 경로를 추가합니다(절대 경로로 중복 제거).
3. `loadHooks(allPaths, cwd)`를 호출합니다.

그런 다음 `loadHooks`는 각 경로를 가져오며 `default` 함수가 있어야 합니다.

<a id="path-resolution"></a>
### 경로 해석

`loader.ts`는 훅 경로를 다음과 같이 해석합니다.

- 절대 경로: 그대로 사용
- `~` 경로: 홈 디렉터리로 확장
- 상대 경로: `cwd`를 기준으로 해석

<a id="event-surfaces"></a>
## 이벤트 인터페이스

훅 이벤트는 `types.ts`에 강한 타입으로 정의되어 있습니다.

<a id="session-events"></a>
### 세션 이벤트

- `session_start`
- `session_before_switch` → `{ cancel?: boolean }` 반환 가능
- `session_switch`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }` 반환 가능
- `session_branch`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }` 반환 가능
- `session.compacting` → `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` 반환 가능
- `session_compact`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` 반환 가능
- `session_tree`
- `session_shutdown`

`session_before_branch`와 `session_branch`에는 `reason`이 포함되며, 이 값이 `session_before_branch.entryId`의 의미를 결정합니다. `"branch"`(`branch(entryId)`, `/branch`)이면 되돌릴 사용자 메시지를 가리키며, 해당 메시지와 그 뒤의 모든 항목을 삭제합니다. `"fork"`(`AgentSession.fork(entryId)`, `entryId`가 있는 RPC `fork`)와 `"btw"`(`/btw` 승격)이면 새 세션에 보존할 마지막 항목을 가리킵니다.

<a id="agentcontext-events"></a>
### 에이전트/컨텍스트 이벤트

- `context` → `{ messages?: Message[] }` 반환 가능
- `before_agent_start` → `{ message?: { customType; content; display; details; attribution } }` 반환 가능
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

<a id="tool-events-prepost-model"></a>
### 도구 이벤트(실행 전/후 모델)

- `tool_call`(실행 전) → `{ block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string }` 반환 가능. 차단하지 않는 핸들러가 `input`을 반환하면 도구의 실행 인수를 대체합니다(정규화된 `event.input` 뷰가 아니라 원시 실행 입력). `block`이 true이면 무시됩니다. 차단하지 않는 모든 핸들러의 서로 다른 비어 있지 않은 `additionalContext` 값은 핸들러 작성자가 작성한 신뢰된 지침을 담습니다. 이 지침은 도구 결과 뒤, 다음 공급자 요청 전에 전달되며 전송 계층이 지원하면 developer/system 우선순위를 가집니다. 원시 도구 출력과 다른 신뢰할 수 없는 데이터는 도구 결과 안에 남겨야 합니다.
- `tool_result`(실행 후) → `{ content?; details?; isError?; additionalContext?: string }` 반환 가능. 성공과 실패 모두에서 컨텍스트는 도구 출력 외부로 전달됩니다. 지침이 한 결과에만 적용된다면 `event.isError`를 확인하세요. 재정의는 핸들러 간에 필드별로 병합되므로, 나중의 반환값이 필드를 생략해도(컨텍스트만 반환하는 경우 포함) 앞선 핸들러의 해당 필드 값이 지워지지 않습니다.

공급자 네이티브 `computer` 호출에는 반환된 `input`을 적용하지 않습니다.
이 호출의 이벤트 입력은 실행 매개변수가 아니라 합성된 뷰이기 때문입니다.
`edit` 이벤트 입력에도 파생된 `path`/`paths` 필드가 포함될 수 있습니다.
이는 정책 검사 용도이며, 유효한 실행 인수라는 보장은 없습니다.

일반 확장 실행기 경로에서 모델이 요청한 `tool_call`은 인수 준비 중에 실행되며,
예약, `tool_execution_start`, 승인보다 먼저 실행됩니다. 대체 입력은 다시
검증되며 표시/저장/실행되는 호출의 입력이 됩니다. 확장 래퍼는 루프가 처리하지
않은 중첩 호출이나 직접 디스패치에도 이벤트를 발생시키고, 승인은 수정된 입력을
평가합니다. 이는 아래에서 설명하는 독립형 `HookToolWrapper`와 다릅니다.

`browser.open(...)`, 직접 사용하는 `BrowserTab` 헬퍼, `tab.run(...)`,
직접 사용하는 `computer` 헬퍼, `computer.run(fnOrCode, options)` 같은 Eval
프렐류드 호출은 AgentTool 호출이 아니라 호스트 브리지 호출이므로
`tool_call`이나 `tool_result`를 발생시키지 않습니다.

```text
훅의 도구 가로채기 흐름

tool_call 핸들러
   │
   ├─ { block: true }가 있는가? ── 예 ──> 예외 발생(도구 차단)
   │
   └─ 아니요
      │
      ▼
   실제 도구 실행
      │
      ├─ 성공 ──> tool_result 핸들러가 { content, details } 재정의 가능
      │                    수동 컨텍스트 additionalContext도 첨부 가능
      │
      └─ 오류 ──> tool_result(isError=true) 발생, 반환된
                     additionalContext 전달 후 원래 오류 다시 던지기
```

<a id="execution-model-and-mutation-semantics"></a>
## 실행 모델과 변경 의미

<a id="1-pre-execution-tool_call"></a>
### 1) 실행 전: `tool_call`

`HookToolWrapper.execute()`는 도구 실행 전에 `tool_call`을 발생시킵니다.

- 핸들러 하나라도 `{ block: true }`를 반환하면 실행이 중단되고 해당 호출에서 이미 수집한 컨텍스트는 버립니다.
- 핸들러가 예외를 던지면 래퍼는 안전을 위해 실행을 차단하고 수집한 컨텍스트를 버립니다.
- 수집한 컨텍스트는 도구가 오류가 아닌 결과를 반환한 뒤에만 전달합니다. 예외를 던지거나 `isError` 결과를 반환하면 버립니다.
- 반환된 `reason`은 발생하는 오류의 텍스트가 됩니다.

<a id="2-tool-execution"></a>
### 2) 도구 실행

차단되지 않으면 실제 도구가 정상적으로 실행됩니다.

<a id="3-post-execution-tool_result"></a>
### 3) 실행 후: `tool_result`

도구가 결과를 반환하면(오류 결과 반환 포함) 래퍼는 다음 값을 담아
`tool_result`를 발생시킵니다.

- `toolName`, `toolCallId`, 실제 실행 인수에 맞게 정규화된 `input`
- `content`
- `details`
- `isError: result.isError === true`

핸들러가 재정의 값을 반환하면 다음과 같이 처리합니다.

- `content`는 결과 내용을 대체할 수 있습니다.
- `details`는 결과 상세 정보를 대체할 수 있습니다.
- `additionalContext`는 도구 결과 외부에 신뢰된 지침을 담습니다. 각 핸들러의 서로 다른 비어 있지 않은 값은 등록 순서로 이어 붙이며(앞뒤 공백을 무시해 비교한 중복은 제거), 해당 호출의 `tool_call` 컨텍스트보다 먼저 전달합니다. 이어 붙인 컨텍스트가 같은 배치의 앞선 호출과 동일하면 한 번만 전달합니다.

실행 중 예외가 발생하면 래퍼는 `isError: true`와 오류 텍스트 내용을 담아
`tool_result`를 발생시키고, 반환된 `additionalContext`를 전달한 뒤 원래 오류를
다시 던집니다. 반환된 content/details 수정으로 이 예외를 대체할 수는 없습니다.
반대로 도구가 `isError: true` 결과를 반환하면 content/details 수정은 적용되지만
오류 플래그는 true로 유지됩니다. 실패한 뒤에만 실행해야 하는 핸들러는
`event.isError`를 확인해야 하며, `PostToolUse`에 해당하는 핸들러는 오류 결과를 제외해야 합니다.

<a id="what-hooks-can-mutate"></a>
### 훅이 변경할 수 있는 것

- `context`를 통한 단일 호출의 LLM 컨텍스트(`messages` 대체 체인)
- `tool_call` 또는 `tool_result`의 `additionalContext`를 통한 다음 공급자 요청의 수동 컨텍스트
- `tool_call`에서 `input`을 반환하여 원시 도구 실행 인수 변경
- 오류 결과를 포함해 반환된 결과의 도구 출력 내용/상세 정보(`tool_result` 경로)
- `before_agent_start`를 통한 에이전트 시작 전 메시지 주입
- `session_before_*`와 `session.compacting`을 통한 취소/사용자 지정 압축/트리 동작

<a id="what-hooks-cannot-mutate-in-this-implementation"></a>
### 이 구현에서 훅이 변경할 수 없는 것

- 도구 오류가 예외로 발생한 뒤의 실행 지속 여부(오류 경로에서 다시 던짐)
- 래퍼 동작의 최종 성공/오류 상태(반환된 `isError`는 타입에 있지만 `HookToolWrapper`가 적용하지 않음)

이러한 제한은 현재 확장 래퍼의 계약에는 해당하지 않습니다.
`ExtensionToolWrapper`는 실행 오류를 변환한 결과를 포함해 `tool_result`의
content/details/`isError` 수정을 적용합니다. 해당 경로는 확장 문서를 참고하세요.

<a id="ordering-and-conflict-behavior"></a>
## 순서와 충돌 동작

<a id="discovery-level-ordering"></a>
### 검색 단계의 순서

기능 공급자는 우선순위가 높은 순으로 정렬됩니다. 기능 키로 중복을 제거하며 먼저 나온 항목이 우선합니다.

`hooks`의 기능 키는 `${type}:${tool}:${name}`입니다. 우선순위가 낮은 공급자에서 나온 중복 항목은 가려진 것으로 표시되고 실제 검색 목록에서 제외됩니다.

<a id="load-order"></a>
### 불러오기 순서

`discoverAndLoadHooks`는 해석된 절대 경로를 기준으로 중복을 제거한 평면 `allPaths` 목록을 만들고, `loadHooks`가 이 순서로 순회합니다.
검색된 각 디렉터리 내부의 파일 순서는 `readdir` 출력에 따라 달라지며, 훅 로더는 별도로 정렬하지 않습니다.

<a id="runtime-handler-order"></a>
### 런타임 핸들러 순서

`HookRunner` 내부 순서는 등록 순서에 따라 결정됩니다.

1. hooks 배열의 순서
2. 훅/이벤트별 핸들러 등록 순서

이벤트 타입별 충돌 동작은 다음과 같습니다.

- `tool_call`: 서로 다른 비어 있지 않은 `additionalContext`를 모두 핸들러 순서로 보존합니다(같은 호출에서 앞선 핸들러와 동일한 값, 같은 배치에서 앞선 호출과 이어 붙인 컨텍스트가 동일한 호출은 제거). `input`은 마지막 값이 우선합니다. 처음 차단되는 즉시 처리를 중단하고 해당 호출에서 수집한 컨텍스트를 버립니다. 핸들러는 다른 핸들러가 수정한 입력을 보지 못합니다.
- `tool_result`: `content`/`details`/`isError` 재정의는 핸들러 간에 필드별로 병합됩니다(조기 중단 없음). 뒤의 핸들러가 정의한 필드가 우선하며, 설정하지 않은 필드는 앞선 핸들러 값을 유지합니다. 따라서 details만, isError만, 컨텍스트만 반환해도 앞선 비밀 정보 가리기를 지우지 않습니다. 서로 다른 비어 있지 않은 `additionalContext`는 모두 핸들러 순서로 보존하며, 중복은 `tool_call`과 같은 방식으로 제거합니다.
- `context`: 연결 방식입니다. 각 핸들러는 앞선 핸들러가 출력한 메시지를 받습니다.
- `before_agent_start`: 처음 반환된 메시지만 유지하고 이후 메시지는 무시합니다.
- `session_before_*`: 마지막 반환 결과를 추적하며, `cancel: true`이면 즉시 처리를 중단합니다.
- `session.compacting`: 마지막 반환 결과가 우선합니다.

명령/렌더러 충돌은 다음과 같이 처리합니다.

- `getCommand(name)`은 훅 전체에서 처음 일치하는 항목을 반환합니다(먼저 불러온 항목 우선).
- `getMessageRenderer(customType)`은 처음 일치하는 항목을 반환합니다.
- `getRegisteredCommands()`는 모든 명령을 반환합니다(중복 제거 없음).

<a id="ui-interactions-hookcontextui"></a>
## UI 상호작용(`HookContext.ui`)

`HookUIContext`에는 다음이 포함됩니다.

- `select`, `confirm`, `input`, `editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`, `getEditorText`
- `theme` 게터

`ctx`에는 `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, 현재 `model`, `isIdle()`, `abort()`, `hasQueuedMessages()`가 포함됩니다.

UI 없이 실행할 때 기본 무동작 컨텍스트는 다음과 같이 동작합니다.

- `select/input/editor/custom`은 `undefined`를 반환합니다.
- `confirm`은 `false`를 반환합니다.
- `notify`, `setStatus`, `setEditorText`는 아무 작업도 하지 않습니다.
- `getEditorText`는 `""`를 반환합니다.

<a id="status-line-behavior"></a>
### 상태 줄 동작

`ctx.ui.setStatus(key, text)`로 설정한 훅 상태 텍스트는 다음과 같이 처리됩니다.

- 키별로 저장
- 키 이름순으로 정렬
- 정제 처리(ANSI/VT 이스케이프 시퀀스 제거, 제어 문자를 공백으로 변환, 연속 공백 합치기, 앞뒤 공백 제거)
- 이어 붙인 뒤 표시 폭에 맞게 잘라서 표시

<a id="error-propagation-and-fallback"></a>
## 오류 전파와 대체 동작

<a id="load-time"></a>
### 불러올 때

- 유효하지 않은 모듈 또는 기본 내보내기 누락 → `LoadHooksResult.errors`에 기록
- 다른 훅은 계속 불러옴

<a id="event-time"></a>
### 이벤트 처리 시

`HookRunner.emit(...)`은 대부분의 이벤트에서 핸들러 오류를 잡아 리스너에 `HookError`(`hookPath`, `event`, `error`)를 전달한 뒤 처리를 계속합니다.

`emitToolCall(...)`은 더 엄격합니다. 핸들러 오류를 삼키지 않고 호출자에게 전파합니다. `HookToolWrapper`에서는 이로 인해 도구 호출이 차단됩니다(안전 우선).

레거시 실행기는 `tool_call`에 시간 제한을 두지 않으므로 UI 입력을 기다릴 수 있습니다.
확장 실행기는 별도의 핸들러 시간 제한과 취소 동작을 갖습니다.

<a id="realistic-api-examples"></a>
## 실용적인 API 예제

<a id="block-unsafe-bash-commands"></a>
### 안전하지 않은 bash 명령 차단

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

<a id="redact-tool-output-on-post-execution"></a>
### 실행 후 도구 출력의 비밀 정보 가리기

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

<a id="modify-model-context-per-llm-call"></a>
### LLM 호출마다 모델 컨텍스트 수정

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

<a id="register-slash-command-with-command-safe-context-methods"></a>
### 명령에서 안전하게 사용할 수 있는 컨텍스트 메서드로 슬래시 명령 등록

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

<a id="export-surface"></a>
## 내보내기 인터페이스

`packages/coding-agent/src/extensibility/hooks/index.ts`와 패키지 하위 경로 `@oh-my-pi/pi-coding-agent/extensibility/hooks`는 다음을 내보냅니다.

- 불러오기 API(`discoverAndLoadHooks`, `loadHooks`)
- 실행기와 래퍼(`HookRunner`, `HookToolWrapper`)
- 모든 훅 타입
- `execCommand` 다시 내보내기

패키지 루트(`@oh-my-pi/pi-coding-agent`)는 `HookAPI`를 다시 내보내지 않습니다. 레거시 훅 타입은 hooks 하위 경로에서 가져오세요.
