# 확장 기능

`packages/coding-agent`에서 런타임 확장 기능을 작성하기 위한 기본 안내서입니다.

이 문서는 다음 파일에 구현된 현재 확장 기능 런타임을 설명합니다.

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`

검색 경로와 파일시스템 로딩 규칙은 [`extension-loading.md`](./extension-loading.md)를 참고하세요.

패키지로 제공되는 사용자용 확장 기능 CLI와 기능은 [`user-facing-packages.md`](./user-facing-packages.md)를 참고하세요.

## 확장 기능이란

확장 기능은 기본 팩터리를 내보내는 TS/JS 모듈입니다. 팩터리는 동기적으로 초기화하거나 Promise를 반환할 수 있습니다.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

확장 기능은 하나의 모듈에서 다음 요소를 모두 조합할 수 있습니다.

- 이벤트 핸들러 (`pi.on(...)`)
- LLM이 호출할 수 있는 도구 (`pi.registerTool(...)`)
- 슬래시 명령 (`pi.registerCommand(...)`)
- 키보드 단축키와 플래그
- 사용자 정의 메시지 렌더링
- 세션/메시지 주입 API (`sendMessage`, `sendUserMessage`, `appendEntry`)

## 런타임 모델

1. 확장 기능 모듈을 동시에 가져온 다음, 경로 순서대로 팩터리 함수를 차례로 실행합니다.
2. 이 로딩 단계에서는 등록 메서드를 사용할 수 있지만, 세션 동작 메서드는 아직 초기화되지 않습니다.
3. `ExtensionRunner.initialize(...)`가 활성 모드에 맞게 실제 동작과 컨텍스트를 연결합니다.
4. 세션/에이전트/도구 수명 주기 이벤트가 핸들러에 전달됩니다.
5. 레지스트리 도구는 확장 기능의 가로채기(`tool_call` / `tool_result`)를 위해 래핑됩니다.

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import modules + bind factories (no session actions)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

`loader.ts`에서 정하는 중요한 제약 사항:

- 확장 기능을 로드하는 동안 `pi.sendMessage()` 같은 동작 메서드를 호출하면 `ExtensionRuntimeNotInitializedError`가 발생합니다.
- 먼저 등록하고, 런타임 동작은 이벤트/명령/도구에서 수행하세요.
- 로딩 중에도 `pi.exec()`는 바로 사용할 수 있습니다. 제공업체 등록은 세션 설정까지 대기열에 보관됩니다.
- 자식 세션은 가져온 팩터리를 재사용하지만 새로운 API와 확장 기능 등록을 바인딩합니다. 모듈 수준 변수는 이러한 세션 사이에서 계속 공유됩니다.

## 빠른 시작

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    const command = event.input.command;
    if (event.toolName === "bash" && typeof command === "string" && command.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: z.object({ name: z.string() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## 확장 기능 API 구성

## 1) 등록과 동작 (`ExtensionAPI`)

핵심 메서드:

- `on(event, handler)`
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`
- `registerMessageRenderer`, `registerAssistantThinkingRenderer`
- `registerComposerShape`
- `setLabel`, `getFlag`
- `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`
- `getActiveTools`, `getAllTools`, `setActiveTools`
- `getCommands`
- `getSessionName`, `setSessionName`
- `setModel`, `getThinkingLevel`, `setThinkingLevel`
- `getServiceTiers`, `setServiceTier`
- `registerProvider`, `unregisterProvider`
- `registerFileWriteFallback`, `registerFileDeleteFallback`
- `events` (공유 이벤트 버스)

`ExtensionAPI` 메서드는 구조 분해하거나 콜백으로 전달해도 원래 확장 기능의 바인딩을 유지합니다.

`setLabel(label)`은 확장 기능의 표시 이름을 설정합니다. 세션 항목에 이름을 붙이는
동작이 아닙니다. `getAllTools()`는 도구 스키마와 출처 메타데이터를 반환하고,
`getActiveTools()`는 활성화된 이름을 반환합니다.

`getServiceTiers()`는 세션의 현재 제품군별 등급 맵을 독립된 스냅샷으로 반환합니다. `setServiceTier(family, tier)`는 이후 요청에 사용할 한 제품군의 등급을 변경합니다. 해당 세션 재정의를 지우려면 `undefined`를 전달하세요. OpenAI는 `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`를, Anthropic은 `priority`를, Google은 `flex` 또는 `priority`를 허용합니다. 응답 스트리밍 중 변경해도 이미 진행 중인 요청에는 영향을 주지 않습니다.

### 제공업체 등록

제공업체의 `models` 항목과 `fetchDynamicModels`가 반환하는 행은 `models.yml`과 동일한 `api`/`kind` 쌍을 허용합니다([모델](./models.md) 참고). `openai-images` 같은 실행기 API에는 종류가 내포되어 있으므로 해당 모델은 채팅으로 등록되지 않고 `image` 역할과 `generate_image`에 연결됩니다. 정적 `models` 항목의 `kind`를 해당 api가 처리할 수 없으면 `registerProvider`가 실패합니다. `fetchDynamicModels`의 이런 행은 경고를 로그에 남기고 제외됩니다.

```ts
pi.registerProvider("my-gateway", {
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "GATEWAY_API_KEY",
  models: [{
    id: "gpt-image-2",
    name: "GPT Image 2",
    api: "openai-images", // kind: "image" implied
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }],
});
```

`pi.registerProvider(name, config)`에는 `@oh-my-pi/pi-ai`에서 가져온
`UsageProvider`를 담는 선택적 `usage` 필드를 포함할 수 있습니다. `fetchUsage` 구현은
정규화된 자격 증명을 받아 정규화된 `UsageReport`를 반환합니다. 반환 결과는 호스트의
AuthStorage 캐시, 이력, 사용량 표시에서 기본 제공업체의 사용량과 동일하게
처리됩니다.

```ts
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com/v1",
  api: "openai-completions",
  usage: {
    id: "my-provider",
    async fetchUsage(params, { fetch }) {
      const response = await fetch("https://api.example.com/usage", {
        headers: { Authorization: `Bearer ${params.credential.apiKey}` },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        used: number;
        limit: number;
      };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: {
              used: payload.used,
              limit: payload.limit,
              unit: "requests",
            },
          },
        ],
      };
    },
  },
});
```

확장 기능의 사용량 제공업체는 해당 확장 기능 등록이 활성화된 동안
같은 이름의 기본 제공업체를 재정의합니다. `pi.unregisterProvider(name)`와
확장 기능 소스 정리는 런타임 재정의만 제거하여 기본 제공 또는 설정된
사용량 리졸버를 복원합니다.

캐시된 사용량 보고서는 공유 `agent.db`에 저장되며, 제공업체 이름,
사용량 제공업체의 `cacheVersion`, 정규화된 기본 URL, 자격 증명 식별자가 키로 사용됩니다. 기본 제공업체를 재정의할 때는 기본 제공업체와
다른 `cacheVersion`을 설정하세요. 그래야 확장 기능이 없는 프로세스(이전 세션,
`--no-extensions` 실행, SDK 스크립트)가 서로의 보고서를 잘못 사용하지 않습니다.

확장 기능으로 등록한 제공업체(`registerProvider`)는 런타임 모델 검색을 위해 `fetchDynamicModels`를 제공할 수 있습니다. 이 가져오기에는 15초의 엄격한 제한 시간(`model-provider-discovery.ts`의 `RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`)이 적용되므로 응답하지 않는 엔드포인트가 검색을 멈추게 할 수 없습니다.

제공업체의 `apiKey`(키 리터럴 또는 환경 변수 이름)는 일반적으로 해당 제공업체에 저장된 OAuth 또는 `/login` 자격 증명보다 우선합니다. 등록에 `oauth`도 제공하면 `apiKey`는 대체 수단이 됩니다. 사용자가 `/login`으로 저장한 키가 우선하고 저장된 로그인 자격 증명이 없을 때만 `apiKey`가 사용됩니다. 덕분에 설정되지 않은 환경 변수 이름이 키 리터럴로 전송되지 않습니다. 따라서 기본 제공업체 id를 `oauth`와 게이트웨이 `apiKey`로 함께 등록하면 저장된 업스트림 자격 증명이 게이트웨이 키보다 우선합니다.

제공업체 로그인 콜백은
`callbacks.onPrompt({ message: "Consumer key", secret: true })`로 입력 마스킹을 요청할 수 있습니다. 기본 `/login`과
첫 실행 설정은 제출된 값을 그대로 보존하면서 입력 필드,
보관된 답변, 입력 진단 미리보기에서는 숨깁니다. 로그인 프롬프트는
실행 취소나 kill/yank 이력을 공유하지 않습니다. 일반 프롬프트는 마스킹하지 않습니다.

RPC는 비밀 입력 프롬프트를 일반 입력으로 전달하지 않고 거부합니다.
`onPrompt`를 구현하는 SDK 호스트는 `secret`을 준수하거나 프롬프트를 거부해야 합니다. 마스킹은
암호화, 메모리 삭제, 일반적인 로그 비식별화를 제공하지 않습니다.

### 명령 기반 제공업체

`registerProvider`는 전송 계층을 확장 기능 자체에서 구현하는 제공업체도
지원합니다. `api` 값은 확장 기능이 소유한 문자열이며(기본 제공 API
이름은 예약됨), `streamSimple`은 표준
`AssistantMessageEventStream`을 반환합니다. HTTP 엔드포인트일 필요는 없습니다.

```ts
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("local-command", {
    // Required model metadata; the custom stream does not use this URL.
    baseUrl: "https://command-provider.invalid/",
    apiKey: "unused-by-extension",
    api: "local-command-api",
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      // Spawn the command, translate its output, and push canonical OMP events.
      // The implementation owns process cleanup, cancellation, and errors; the
      // helper needs `context` for the conversation and `options` for `signal`,
      // `cwd`, and the stable `sessionId`.
      void runCommandAndPushEvents(stream, model, context, options);
      return stream;
    },
    models: [{
      id: "local-command-model",
      name: "Local command",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16000,
    }],
  });
}
```

이 방식은 로컬 CLI, stdio 서비스, JSONL 프로세스에 유용합니다. 제공업체가 CLI로만 제공하는 요금제를 이용하는 방법이기도 합니다. 하위 프로세스는 자체 구독 자격 증명으로 인증합니다. 반면 같은 모델을 API 키로 이용하면 이미 요금제에 가입한 계정도 토큰별로 요금이 부과됩니다. 도구의 소유권을 하위 프로세스에 유지해야 한다면 명령 기반 제공업체는 자체 도구 루프를 하위 프로세스 안에서 실행하고 그 결과인 어시스턴트 이벤트만 내보내야 합니다. 완전한 하위 프로세스 어댑터는 상속하면 안 되는 자격 증명을 제거하고, `options.signal`을 준수하며, `options.cwd`를 사용하고, 하나의 안정적인 세션 ID를 하나의 하위 대화에 매핑하며, 0이 아닌 종료 코드를 스트림 오류로 변환해야 합니다. `models.yml`은 계속 HTTP/설정 전용입니다. HTTP가 아닌 전송 계층에는 확장 기능이 공식적인 우회 수단입니다.

대화형 모드에서 `input` 핸들러는 기본 제공 첫 메시지 자동 제목 검사보다 먼저 실행됩니다. `input`에서 `await pi.setSessionName(...)`을 호출하는 확장 기능은 저장되는 세션 이름을 지정하여 해당 세션의 기본 자동 제목 생성을 막을 수 있습니다.

다음 항목도 제공됩니다.

- `pi.logger`
- `pi.arktype` (omptype `type(...)` 스키마 빌더)
- `pi.zod` (omptype 기반 Zod 호환 빌더)
- `pi.typebox` (레거시 TypeBox 호환 계층)
- `pi.pi` (패키지 내보내기)

### 런타임 설정 재정의

설정에는 타입이 지정된 레지스트리 핸들로 접근합니다([config-usage.md](./config-usage.md#definitions-srcconfigregistryts)의 정의 항목 참고). 문자열 경로 방식의 `settings.get`/`set`/`override` 메서드는 18.3에서 제거되었습니다. 확장 기능은 `@oh-my-pi/pi-coding-agent/config/registry` 하위 경로의 `lookup(id)`로 ID에 해당하는 핸들을 찾고(`all()`로 열거 가능), 범위로 `pi.pi.settings`를 전달합니다.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export default function (pi: ExtensionAPI) {
  const recap = lookup("recap.enabled");
  // Defer to the user: pin a default only when no env var or settings layer configures it.
  if (recap && !recap.isConfigured(pi.pi.settings)) recap.override(pi.pi.settings, false);
}
```

- `override(scope, value)`는 메모리의 런타임 계층에 씁니다. 저장되지 않으며 프로젝트, 전역, `--config` 계층보다 우선합니다. 보통 설정의 환경 변수 바인딩이 우선하지만 `envFallback`을 사용하는 정의는 설정된 값을 우선합니다. 정의가 거부하는 값은 예외를 발생시킵니다(예: `Invalid value for recap.enabled: "nope" (expected a boolean)`).
- `clearOverride(scope)`는 재정의를 해제하여 저장된 값/기본값을 복원합니다.
- `isConfigured(scope)` / `provenance(scope)`는 사용자가 설정한 값과 기본값을 구분합니다(`"env" | "runtime" | "overlay" | "project" | "global" | "default"`).
- `get(scope)`는 실제 적용값을 읽고 `listen(scope, cb)`는 변경을 관찰합니다. 쓰기는 설정 저장소를 거치므로 변경 리스너와 실시간 효과가 실행됩니다.
- 알 수 없는 ID에 대해 `lookup`은 `undefined`를 반환합니다.

### 메시지 전달 의미

`pi.sendMessage(message, options)`는 다음을 지원합니다.

- `deliverAs: "steer"` (스트리밍 중 기본값) — 현재 실행에 개입합니다.
- `deliverAs: "followUp"` — 스트리밍 중 현재 실행 뒤에 대기시킵니다.
- `deliverAs: "nextTurn"` — 편집 가능한 대기 메시지 UI에 표시하지 않습니다. 스트리밍 중에는 다음 턴을 기다리며, 유휴 상태에서 `triggerTurn`이 없으면 턴을 시작하지 않고 컨텍스트/기록에 추가합니다.
- `deliverAs: "aside"` — 현재 도구 묶음을 중단하지 않고 다음 에이전트 단계 경계에 주입합니다. 단, 실행 중인 중단 가능한 `wait`는 끝냅니다(wait는 "Wait interrupted by message."를 반환하며 작업은 계속 실행). 유휴 상태에서는 보통 `triggerTurn`과 관계없이 턴을 시작합니다. 계획 모드이거나 사용자 중단에 따른 자동 재개가 억제된 경우에는 컨텍스트에 합칩니다.
- `triggerTurn: true` — 유휴 상태에서 턴을 시작합니다(`deliverAs: "nextTurn"`에도 적용: 유휴 상태에서는 즉시 프롬프트를 실행하고 스트리밍 중에는 대기 메시지가 내부 연속 실행을 예약).

유휴 상태에서 `triggerTurn`이 없으면 일반 `sendMessage` 전달은 턴을 시작하지 않고 메시지만 추가합니다. `display: true` 메시지는 즉시 렌더링됩니다. `"nextTurn"` 전달은 이 즉시 표시 이벤트를 발생시키지 않습니다. ACP 클라이언트는 에이전트가 시작하는 턴을 연기할 수 있으며, 이 경우 턴을 시작했을 요청은 숨겨진 다음 턴 메시지로 유지됩니다.

`pi.sendUserMessage(content, { deliverAs })`는 슬래시 명령이나 프롬프트 템플릿 확장 없이 텍스트/이미지를 제출합니다. 유휴 상태에서 프롬프트를 시작하려면 `deliverAs`를 생략하세요. 스트리밍 중 생략하면 개입 메시지를 대기시킵니다. 명시적인 `"steer"` 또는 `"followUp"`은 유휴 상태에서도 턴을 바로 시작하지 않고 프롬프트를 대기시킵니다. `"aside"`는 실행 중이면 다음 단계 경계에 주입하고 유휴 상태이면 턴을 시작합니다. `attribution: "agent"`를 전달하지 않으면 메시지는 `attribution: "user"`로 기록됩니다. 확장 기능이 생성했거나 다른 에이전트에서 중계한 텍스트에는 `"agent"`를 사용하세요.

`pi.sendMessage`에 전달된 페이로드는 전달 전에 정규화됩니다(`packages/tui/src/chat/messages.ts`의 `normalizeCustomMessagePayload`, `session/messages.ts`에서 다시 내보냄). 객체가 아닌 페이로드는 기본 사용자 지정 타입의 문자열 콘텐츠로 변환하고, 누락된 `customType`/`attribution` 필드는 기본값으로 채우며, 잘못된 콘텐츠는 빈 문자열로 바꿉니다.

## 2) 핸들러 컨텍스트 (`ExtensionContext`)

핸들러와 도구 `execute`는 다음을 포함하는 `ctx`를 받습니다.

- `ui`
- `mode`: `"tui" | "rpc" | "json" | "print"`; ACP는 `"rpc"`를 사용합니다. 터미널 전용 컴포넌트를 사용하기 전에 `"tui"`인지 확인하세요.
- `hasUI`: 모든 UI 메서드를 지원하는지가 아니라 이 실행기에 실제 동작하는 UI 컨텍스트가 있는지를 나타냅니다.
- `cwd`
- `sessionManager` (읽기 전용)
- `modelRegistry`, `model`
- `models` (읽기 전용 모델 조회 — 아래 참고)
- `localProtocolOptions` (외부 도구 브리지를 위한 선택적 호출 세션 `local://` 루트 매핑)
- `getContextUsage()`
- `getAsyncJobSnapshot()`은 현재 세션의 읽기 전용 비동기 작업 스냅샷을 반환합니다. 컨텍스트를 소유한 세션이 없으면 `null`입니다.
- `compact(instructionsOrOptions?)`: 요약 중점 텍스트 또는 `CompactOptions`를 받습니다. 일회성 `mode: "soft" | "remote" | "snapcompact"`, `onComplete`, `onError`, `suppressContinuation`을 포함합니다.
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `resolvePlanReview(reviewId, choice, input?)`: 열린 대화형 계획 검토에 답합니다. 검토나 선택지를 사용할 수 없으면 `false`를 반환합니다. `refine`에는 비어 있지 않은 `input.feedback`이 필요하며 승인(`execute`, `compact`, `keep`)에서는 `input.role`에 이벤트의 `tiers` 중 계층을 지정하여 실행 모델을 선택할 수 있습니다(알 수 없는 역할이거나 다른 선택지에 `role`을 지정하면 `false` 반환).
- `getPendingPlanReview()`: 아직 응답을 기다리는 대화형 계획 검토를 `plan_review_requested` 형태로 반환하며 없으면 `undefined`입니다. 확장 기능이 로드되거나 다시 연결되기 전에 열린 검토에 답할 때 사용하세요.
- `openPlanReview()`: `/plan-review`처럼 최신 계획 파일에 대한 대화형 계획 검토를 엽니다. 선택을 기다리지 않고 검토가 응답 대기 상태가 되면 `true`로 완료됩니다. 이미 열린 검토는 교체하지 않고 유지합니다. `/plan-review`와 달리 작업을 중단하지 않습니다. 에이전트가 스트리밍 또는 컨텍스트 압축 중이거나 계획 모드가 꺼져 있거나 비어 있지 않은 계획 파일이 없으면 알림 없이 `false`로 완료됩니다.
- `getSystemPrompt()`
- `isProjectTrusted()` — 항상 `true`입니다. OMP는 프로젝트 입력을 불러오기 전에 디렉터리별 신뢰 여부를 묻지 않습니다.
- `agent` — 이 세션을 실행하는 에이전트: `{ kind: "main" | "sub", id, name, depth, parentId? }`. 팩터리는 모든 하위 에이전트 세션(task 도구, eval `agent()`, `/tan` 복제본)에 다시 연결됩니다. 따라서 핸들러는 `ctx.agent.kind === "sub"` 또는 소문자로 변환된 에이전트 정의 `name`(예: `"explore"`)으로 하위 에이전트에서만 동작하도록 할 수 있습니다. `depth` 대신 `kind`를 사용하세요. `depth`는 `task` 중첩만 세므로 `/tan` 복제본은 깊이 0인 하위 에이전트이며 `name: "sub"`로 보고합니다. 조언자 자체의 도구 호출은 `{ kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId }`로 세션의 `tool_call`/`tool_result` 핸들러에 전달되므로 `kind === "main"`은 조언자 활동도 제외합니다.
- `runEphemeralTurn(...)` (선택 사항, 아래 참고)
- `memory` (선택적 구조화 메모리 런타임 — 설정된 백엔드의 상태/검색/저장)
- `annotations`: 보드와 원격 클라이언트를 위한 `/annotate` API입니다. `submit({ source, notes, deliver?, review?, focus? })`은 `/annotate`와 같은 피드백을 구성하여 UI 없이 전달합니다. `open({ source, deliver?, focus? })`은 소스에 주석 오버레이를 열고 운영자의 메모로 완료됩니다(닫으면 `undefined`, `mode === "tui"`에서만 가능). 텍스트 소스는 `{ kind: "text", text, label? }`, `{ kind: "file", path }`(현재 세션 cwd 기준으로 확인), `{ kind: "last" }`입니다. diff 소스는 `{ kind: "diff", diff, label? }`, `{ kind: "uncommitted" }`, `{ kind: "pr", ref }`이며 `ref`는 GitHub PR 또는 GitLab MR URL, `pr://owner/repo/N`, `mr://<host>/<group>/<project>/N/diff`입니다. `review`/`focus`는 diff 소스에만 적용됩니다(텍스트 소스에서는 타입 오류). 텍스트 메모는 `{ note, line?, quote? }`입니다(줄 번호는 1부터 시작하며 생략하면 전체 소스에 적용하고 인용 줄은 자동으로 채움). diff 메모는 `{ path, note, line?, side?, occurrence?, rawLine? }`입니다(`side` 기본값은 `"new"`, `rawLine`은 `+`/`-`/공백 접두사를 포함하는 diff 행). 소스와 일치하지 않는 메모는 버리지 않고 거부합니다. `text`와 `diff` 소스는 전달한 값의 고정 스냅샷입니다. `file`, `last`, `uncommitted`, `pr`은 호출 시 다시 읽으며 줄 번호를 현재 내용과 대조하므로, 내용 변경 시 메모 이름을 밝히며 거부하도록 `quote`/`rawLine`을 전달하세요. `deliver` 기본값은 `"auto"`입니다. 대화형 TUI 편집기가 있으면 붙여넣기 가능한 메모를 입력창에 넣고, 그렇지 않으면 전송합니다. LLM 검토 요청(diff의 `review: true`)은 항상 전송합니다. 전송은 `pi.sendUserMessage`를 사용하며 에이전트가 스트리밍 중이면 후속 메시지로 대기시킵니다. `"paste"`/`"send"`는 채널을 강제하고 `"none"`은 `text`만 반환합니다. 결과는 `kind`로 구분합니다. `"text"`는 `TextReviewAnnotation[]`를 포함하며, `open` 이후 운영자가 외부 편집기에서 소스를 바꿨다면 `editedText`도 포함합니다(피드백은 바뀐 텍스트를 참조). `"diff"`는 `CodeReviewAnnotation[]`와 `review`(`text`가 LLM 검토 요청인지)를 포함합니다. 둘 다 렌더링된 `text`와 `delivered` 채널을 포함합니다.
  명시적 붙여넣기에는 `ctx.ui.supportsEditor === true`가 필요합니다. TUI와 비헤드리스 RPC는 입력창을 제공하지만 ACP와 비동작 UI 컨텍스트는 제공하지 않습니다. LLM 검토용 diff는 50,000자 또는 검토 가능한 파일 20개를 넘으면 전달 전에 거부하며 `open`은 오버레이를 열기 전에 해당 패치를 거부합니다. 큰 패치는 작은 요청으로 나누세요. 메모만 제출할 때는 이 검토 프롬프트 제한이 없습니다.
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — 관리형 타이머(아래 참고)

### 임시 보조 턴 (`ctx.runEphemeralTurn`)

현재 모델과 대화 컨텍스트로 `/btw`와 같은 보조 턴 파이프라인을 실행합니다. 질문과 응답은 세션 기록에 추가되지 않으며 주 턴이 활성화된 상태에서도 요청을 실행할 수 있습니다. 스냅샷에는 작성 중인 어시스턴트 텍스트가 포함될 수 있습니다.

```ts
if (!ctx.runEphemeralTurn) {
  throw new Error("This host does not support ephemeral turns");
}
await requireConsultationConsent(remoteCaller);
await auditConsultationRequest(remoteCaller, remoteQuestion);
const { replyText } = await ctx.runEphemeralTurn({
  promptText: remoteQuestion,
  tools: false,
  maxTokens: 4096,
  maxContextBytes: 1_048_576,
  onTextDelta: delta => sendRemoteChunk(delta),
  signal: requestAbortController.signal,
});
```

예를 들어 Synadia/NATS 브리지는 실시간 사용자 메시지를 주입하지 않고 로컬 컨텍스트로 다른 에이전트의 질문에 답하고 응답을 스트리밍할 수 있습니다. **보조 턴은 현재 대화 스냅샷을 설정된 모델 제공업체에 전송하고 답변을 호출한 확장 기능에 반환합니다.** 브리지 확장 기능은 이 API를 사용하기 전에 적절한 사용자 동의를 받고, 호출자를 인증하고 권한을 확인하며, 모든 원격 요청을 감사해야 합니다. 에이전트 간 상담 확장 기능은 추론 전에 `maxTokens`와 직렬화된 변환 후 `maxContextBytes` 제한(비밀정보 난독화 이후 측정)을 설정할 수 있습니다. Codex Responses, Cursor, GitLab Duo Workflow, Ollama Cloud 검색 모델, Antigravity처럼 호출자의 출력 토큰 제한을 생략하거나 덮어쓰는 전송 계층은 제한 없는 요청을 조용히 시작하지 않고 추론 전에 `maxTokens`를 거부합니다. Antigravity는 추론 강도 라우팅이 고정 출력 제한의 전송 프로필을 선택할 수 있으므로 전송 계층 전체에서 요청한 제한을 보수적으로 거부합니다. 제한을 요청하면 선택적 예산 기반 추론을 비활성화합니다. 그렇지 않으면 해당 전송 계층이 추론 예산을 맞추기 위해 전송 제한을 높일 수 있기 때문입니다. 예산 기반 추론이 필수인 모델은 제한을 거부합니다. Cursor는 전달된 도구 목록과 별개로 전송 계층이 네이티브 도구를 노출하므로 `tools: false`도 추론 전에 거부합니다. 두 제한은 모두 양의 안전한 정수여야 합니다. 제한 없는 턴을 허용할 때만 `maxTokens`를 생략하거나 출력 제한을 지원하는 API를 선택하세요. 확장 기능이 전송, 접근 제어, 요청 제한, 취소(종료 포함)를 책임지며 이 API는 네트워크 의존성을 추가하지 않습니다. `onTextDelta`는 Promise를 반환할 수 있습니다. 마지막 버퍼 전송까지 순서대로 전달 완료를 기다리며, 전달 오류가 나면 스트리밍을 방치하지 않고 보조 턴을 거부하고 제공업체 요청을 중단합니다.

훅은 지연된 콜백에서도 보조 턴을 시작할 수 있습니다. 실행 중인 보조 턴 *내부*에서 도달한 `context`, `before_provider_request`, `after_provider_response` 훅만 중첩 `runEphemeralTurn` 호출을 거부하여 재귀를 제한합니다. 호출자의 `onTextDelta`는 이 보호 범위 밖에서 실행됩니다. 보조 턴은 활성 이벤트 핸들러의 신호(해당 핸들러가 실행 중인 동안만)와 등록된 도구의 호출 중단 신호를 상속합니다. 명시적 `options.signal`은 이 신호들을 대체하지 않고 결합합니다. `maxContextBytes`는 `before_provider_request` 훅 실행 전에 검사하며 페이로드를 교체하는 훅 이후에는 다시 측정하지 않습니다.

도구 호출은 실행하지 않고 항상 버립니다. `tools: false`를 전달하면 컨텍스트 변환 후 도구 정의를 제거하고 제공업체 경계에서 `toolChoice: "none"`을 설정합니다. 생략하면 프롬프트 캐시 재사용을 위해 `/btw`의 도구 목록을 유지하며 비활성화하면 캐시 적중률이 낮아질 수 있습니다. Bedrock Converse는 변환된 기록에 도구 호출이나 결과가 남아 있으면 도구 제외를 거부합니다. 기존 컨텍스트/제공업체 훅은 계속 실행됩니다. 이는 샌드박스가 아니며 임의의 확장 기능 훅에 부작용이 없음을 보장하지 않습니다. 모델 추론은 설정된 제공업체의 자원을 사용합니다. `dedupeReply` 기본값은 `true`이며 동일한 줄이 세 번 넘게 연속되면 줄이고 반환 응답을 4 KiB로 제한합니다. 이 변환을 끄려면 `false`로 설정하세요. 그래도 `replyText`의 앞뒤 공백은 제거됩니다. 호출자는 최종 결과로 `replyText`를 사용해야 합니다.

`history`는 분리된 이전 보조 턴 메시지에만 사용하세요. `structuredClone`으로 복제하므로 복제 가능한 메시지 데이터를 전달해야 합니다. `conversationKey`는 관련된 보조 턴을 하나의 제공업체 계보로 유지합니다. 취소 또는 실패 후 재시도하기 전에 키를 바꾸세요. 보조 턴은 디스패치 전에 세션이나 정확한 모델 인스턴스가 바뀌어도 재시도 가능한 오류로 거부됩니다. 호출자는 이전 스냅샷을 재사용하지 말고 새로운 현재 컨텍스트 스냅샷으로 재시도해야 합니다.

<a id="background-work-ctxsetinterval--ctxsettimeout"></a>
### 백그라운드 작업 (`ctx.setInterval` / `ctx.setTimeout`)

확장 기능은 **격리 없이 같은 프로세스에서 실행**됩니다. 원시 `setInterval`/`setTimeout`/분리된 Promise 콜백이 예외를 던지면 핸들러 디스패치의 try/catch 밖에서 실행되므로 프로세스 수준 `uncaughtException`으로 나타납니다. 전역 사후 분석 핸들러는 이를 치명적 오류로 취급하므로 문제의 확장 기능만이 아니라 **세션 전체가 종료됩니다**.

주기적 또는 지연된 백그라운드 작업에는 `ctx.setInterval` / `ctx.setTimeout`을 사용하세요. 플랫폼 시그니처와 같지만 다음 차이가 있습니다.

- 핸들러 디스패치와 동일한 오류 격리로 콜백을 실행합니다. 동기 예외나 거부된 Promise는 로그와 확장 기능 오류 채널로 보고하고 세션은 계속 실행합니다.
- `ctx.clearTimer(handle)`에 전달할 수 있는 핸들을 반환합니다.
- `unref` 처리되어 자체적으로 프로세스를 유지하지 않으며 `session_shutdown` 시 자동으로 해제됩니다.

```ts
pi.on("session_start", async (_event, ctx) => {
  const timer = ctx.setInterval(() => {
    // A throw here is contained — it will not crash the session.
    ctx.ui.notify("tick", "info");
  }, 60_000);
  // Optional: clear it yourself; otherwise it is cleared on shutdown.
  pi.on("session_shutdown", () => ctx.clearTimer(timer));
});
```

원시 `setInterval`/`setTimeout`이나 분리된 Promise를 대신 사용하면 격리를 직접 책임져야 합니다. 콜백 본문을 자체 `try/catch`로 감싸고(처리하지 않은 예외는 세션을 종료) `session_shutdown`에서 타이머를 해제하세요.

### 모델 선택 (`ctx.models`)

`ctx.models`는 코어와 같은 방식으로 모델을 선택하고 비교하는 읽기 전용 인터페이스입니다.

- `list()` — 이 세션에서 사용 가능한 인증된 모델입니다.
- `current()` — 현재 세션 모델입니다(지연 조회하므로 `/model` 전환 반영).
- `resolve(spec)` — 모델 문자열(`provider/id`, ID만) 또는 역할 별칭(`@slow`, 설정된 역할)을 `Model`로 확인합니다. `--model`과 동일한 설정 기반 별칭 및 일치 우선순위를 따릅니다. 일치 항목이 없으면 `undefined`를 반환합니다.
- `family(model)` — “같은 계열인가?”를 비교하는 불투명 계보 토큰입니다(Claude 세부 버전들은 토큰을 공유하고 Claude와 GPT는 다름). 비교에만 사용하고 저장하지 마세요(새 릴리스에 따라 토큰 체계가 바뀜).

```ts
// Pick a model from a different family than the current one (e.g. a cross-family reviewer).
const current = ctx.models.current();
const contrasting = ctx.models
  .list()
  .find((m) => current && ctx.models.family(m) !== ctx.models.family(current));
```

## 3) 명령 컨텍스트 (`ExtensionCommandContext`)

명령 핸들러에는 다음 항목도 제공됩니다.

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

세션 제어 흐름에는 명령 컨텍스트를 사용하세요. 이 메서드들은 의도적으로 일반 이벤트 핸들러와 분리되어 있습니다.

## 이벤트 목록(현재 이름과 동작)

표준 이벤트 유니온과 페이로드 타입은 `types.ts`에 있습니다.

### 세션 수명 주기

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

대화형 TUI에서는 팩터리가 제공업체, 단축키, 입력창 모양, 파일 대체 처리를 등록하지 않는 확장 기능을 입력창이 입력을 받기 시작한 뒤 로드합니다. 이전 실행에서 현재 소스에 대한 해당 특성이 기록된 경우에만 적용됩니다. `session_start`는 확장 기능이 연결될 때 전달되므로 계속 실행됩니다. 첫 제출 메시지와 모든 모델 턴은 로드 완료를 기다리므로 첫 요청부터 도구, 명령, `input`/`before_agent_start` 훅이 적용됩니다. 연결 전에 발생한 이벤트는 재생하지 않습니다. 재개한 세션, `--tools` 사용, omp가 인식하지 못하는 플래그가 있는 실행에서는 세션 시작 전에 모든 확장 기능을 로드합니다.

`session.compacting`은 `{ sessionId, messages }`를 받고 `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`를 반환하여 요약 컨텍스트, 요약기 프롬프트, 저장되는 컨텍스트 압축 데이터를 사용자 지정할 수 있습니다. `session_before_compact`가 이미 대체 압축 결과를 제공했으면 건너뜁니다.

취소 가능한 사전 이벤트:

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

`session_before_branch`와 `session_branch`는 `reason`을 포함하며 이 값이 `session_before_branch.entryId`의 의미를 결정합니다. `"branch"`(`branch(entryId)`, `/branch`)에서는 되감는 사용자 메시지이며 해당 메시지와 그 이후의 모든 항목을 제거합니다. `"fork"`(`AgentSession.fork(entryId)`, `entryId`가 있는 RPC `fork`)와 `"btw"`(`/btw` 승격)에서는 새 세션에 남기는 마지막 항목입니다.

### 프롬프트와 턴 수명 주기

- `input`
- `before_agent_start`
- `before_provider_request` — `{ payload }`를 받습니다. `{ payload }`가 아니라 대체 페이로드 자체를 반환하세요. 핸들러는 연쇄 실행됩니다. 제공업체 전송 계층은 `onPayload`를 호출해야 하지만 `devin-agent`는 호출하지 않습니다.
- `after_provider_response` — 응답 본문을 소비하기 전 알림: `{ status, headers, requestId?, metadata? }`. 제공업체 요청/응답 핸들러는 `ctx.model`에서 해당 요청에 사용한 모델을 받습니다.
- `context` — 대화 메시지를 받고 `{ messages }`를 반환할 수 있습니다. 대체는 저장된 기록을 바꾸지 않고 연쇄 적용됩니다.
- `agent_start` / `agent_end` — 에이전트 루프 수명 주기 알림입니다. `agent_end`는 알림 전용입니다.
- `session_stop` — 주 세션의 중지 훅이며 실행 정리 전에 완료를 기다립니다. 권고형 `{ continue: true, additionalContext }` 요청은 최대 8번의 연속 실행으로 제한됩니다. 명시적 `{ decision: "block", reason }` 거부는 권고 요청보다 우선하며 이 한도를 소비하지 않습니다. 훅이 완료를 허용하거나 운영자가 중단할 때까지 차단을 유지합니다. 이유 없는 거부에는 완료 허가 대신 진단용 연속 실행이 제공됩니다. 작업/하위 에이전트 세션에서는 발생하지 않으며 에이전트 소유 백그라운드 작업이 완전히 유휴 상태가 될 때까지 지연됩니다(`session/agent-session.ts`의 `#hasPendingAsyncWake`).
- `cache_warming_decision` — 프롬프트 캐시 워밍 갱신 전에 워머의 비용 정보(`warmCost`, `missCost`, `continuationProbability`, `action`)와 함께 발생합니다. `{ action: "warm" | "stop" }`을 반환하여 재정의합니다. 마지막으로 동작을 반환한 핸들러가 우선하며, 핸들러 실패나 2초보다 느린 응답은 워머의 결정을 유지합니다. `"stop"` 재정의는 다음 실제 요청까지 워밍을 종료합니다. 주 에이전트 루프만 워밍하며 작업/하위 에이전트 세션에서는 발생하지 않습니다. 갱신 자체는 실제 요청을 같은 제공업체 경로로 재생하므로 `before_provider_request`와 `after_provider_response`도 발생합니다. 갱신이 캐시에 적중하려면 대체 페이로드는 실제 요청과 바이트 단위로 같아야 합니다.
- `turn_start` / `turn_end`
- `assistant_message` — 최종 확정된 어시스턴트 메시지마다 에이전트 컨텍스트 반영, 저장, `message_end`, 도구 디스패치 전에 한 번 완료를 기다립니다. `{ content }`를 반환하여 기록, 저장, `message_end` 소비자, 다음 제공업체 요청의 텍스트를 교체합니다. 핸들러는 연쇄 실행됩니다. 이미 스트리밍 업데이트(`message_update`, ACP/RPC 청크)로 전달된 텍스트는 회수하지 않으므로 스트림을 렌더링하는 클라이언트는 원문을 계속 표시할 수 있습니다. 텍스트 블록의 수, 순서, 위치는 유지해야 하며 텍스트만 바꿀 수 있습니다. 모든 비텍스트 블록과 그 밖의 블록 메타데이터는 그대로 두어야 합니다. 바뀌지 않은 텍스트는 원래 `textSignature`를 유지합니다(핸들러가 이를 제거하거나 바꿔도 동일). 수정된 텍스트는 서명을 잃으므로 다른 텍스트에 제공업체 재생 상태를 재사용하지 않습니다. 잘못된 대체값과 핸들러 오류는 보고하고 건너뜁니다. 핸들러 대기 중 중단되면 그때까지 완료된 수정은 유지하고 나머지 핸들러는 건너뜁니다.
- `message_start` / `message_update` / `message_end` — 수명 주기 알림입니다. `message_end`는 분리된 스냅샷을 받으므로 직접 수정해도 에이전트나 제공업체 컨텍스트는 바뀌지 않습니다.

```ts
pi.on("assistant_message", event => ({
	content: event.message.content.map(block =>
		block.type === "text" ? { ...block, text: block.text.replaceAll("teh", "the") } : block,
	),
}));
```

`before_agent_start`는 일반 프롬프트와 사용자 작업을 포함한 각 개입/후속 메시지 묶음이 실제로 대기열에서 꺼내질 때 정책을 준비합니다(`reason: "prompt"`). 대기열 삽입 알림이 아니므로 실행 중인 묶음은 추가 `agent_start` 없이도 이를 발생시킬 수 있습니다. 대기열 조회, 제공업체 재시도, 도구 전용 반복, 합성 메시지만 포함한 대기 연속 실행에서는 발생하지 않습니다. 명시적 합성 프롬프트는 일반 프롬프트 수명 주기를 유지합니다. 대기 상태의 하위 에이전트를 깨우거나 메시지를 보내거나 포커스만 주기 위해 되살리면 `session_start` 뒤에 `reason: "revive"`와 빈 `prompt`로 한 번 발생하고 결과는 버립니다. 확장 기능은 하위 에이전트의 첫 프롬프트에서 등록한 항목을 다시 등록할 수 있습니다. 되살리기는 핸들러가 끝날 때까지 기다리므로 프롬프트별 작업(회상, 분류, 로깅)을 하는 핸들러는 `reason: "revive"`이면 일찍 반환해야 합니다. 깨우기 턴은 에이전트가 시작하므로 이 이벤트를 발생시키지 않지만 이후 일반 프롬프트에서는 평소처럼 실행됩니다.

대기 묶음의 `prompt`에는 선택한 모든 사용자 메시지의 이미 변환된 텍스트가 메시지 사이에 줄바꿈 두 개를 넣어 결합됩니다. 메시지 내부 텍스트 블록은 이어 붙입니다. `images`에는 이미 정규화된 이미지가 전달 순서대로 포함됩니다. 숨겨진 에이전트 귀속 동반 메시지는 이벤트 입력에서 제외하지만 전달 묶음에는 남습니다. 입력 훅, 명령, 템플릿, 원본 첨부 전처리는 다시 실행하지 않습니다.

핸들러는 현재 기본 시스템 프롬프트에서 연쇄 실행됩니다. 최종 재정의는 다른 프롬프트나 사용자 포함 묶음이 정책을 준비할 때까지 다음 제공업체 요청과 연속 실행을 제어합니다. 재정의는 기본값과 무관한 문자열이나 배열도 포함하는 완전한 교체입니다. 호스트는 텍스트 패치를 추론하거나 다시 적용하지 않습니다. 반환된 사용자 지정 메시지는 원본 묶음 뒤에 한 번 추가하며 원본은 순서, 식별성, 귀속, 메타데이터를 유지합니다. 핸들러 대기 중 턴이 중단되거나 세션/대기열 소유권이 바뀌면 호스트는 결과 적용을 취소합니다.

준비 중 반환된 재정의의 원본 기반이 바뀌면(예: 핸들러가 `pi.setActiveTools()`를 기다림) 호스트는 해당 시도의 반환 사용자 지정 메시지와 임시 메모리를 버리고 최종 기반에서 정책 준비를 반복합니다. 전달마다 최대 세 번 시도하며 기반 변경이 반복되면 원본 입력을 전달하지 않고 오류를 발생시킵니다. 대기 중인 원본은 대기열에 남으며 실패한 턴을 정리해도 자동 재시도하지 않습니다. 새 프롬프트나 대기 메시지 전달은 대기열 처리를 다시 열 수 있습니다. 확장 기능이나 조언자의 합성 후속 메시지와 사용자 지정 메시지도 포함되며 사용자만 재시도할 수 있는 것은 아닙니다. 일반 텍스트는 폐기 프롬프트 콜백으로 반환합니다. 갱신으로 배열을 교체해도 기반 내용이 같으면 재시도하지 않습니다. 재정의가 없는 준비는 핸들러나 회상을 다시 실행하지 않고 최종 기반을 사용합니다. 결과를 게시하기 직전에 소유권을 동기적으로 다시 확인하며 늦은 변경이 있으면 메모리나 컨텍스트를 반영하지 않고 전달을 거절합니다.

핸들러는 재진입을 허용해야 합니다. 원본 기반 재시도는 같은 제출에 대해 전체 `before_agent_start` 체인을 다시 호출할 수 있으며 취소된 전달은 재개 시 다시 준비할 수 있습니다. 채택된 시도의 반환 컨텍스트와 임시 메모리만 게시하며 핸들러가 수행한 외부 부작용은 되돌릴 수 없습니다. 정책 재시도로 입력 훅, 명령, 템플릿, 원본 첨부 전처리를 다시 실행하지 않습니다.

이후 대기열 처리가 실패하면 아직 대화 기록에 도달하지 않은 이전 원본을 새로 삽입한 항목보다 앞에 복원합니다. 생성된 준비 컨텍스트는 다시 대기시키지 않으며 명시적으로 비우거나 교체한 대기열을 복구하지 않습니다.
#### 외부 입력 가로채기

`input`은 명령 해석, 스킬/프롬프트 템플릿 확장, 대기열 삽입 전에 제출 진입점에서 한 번 실행됩니다.

| 제출 방식 | `source` |
|---|---|
| 주 세션 Enter 또는 Ctrl+Enter | `"interactive"` |
| RPC 또는 RPC UI 모드의 `prompt`, `steer`, `follow_up`, `abort_and_prompt` | `"rpc"` |

핸들러는 확장 기능/등록 순서로 실행됩니다. 반환된 `text`와 `images` 대체값은 다음 핸들러에 전달됩니다. 생략한 필드는 현재 값을 유지하고 `images: []`는 첨부를 제거합니다. 대체 텍스트는 디스패치 전에 앞뒤 공백을 제거합니다. `handled: true`는 나머지 핸들러와 일반 디스패치를 중지합니다. 남은 이미지가 없는 빈 텍스트도 일반 디스패치를 중지합니다. 핸들러가 `sendUserMessage`나 `sendMessage`로 명시적으로 예약한 작업은 버리지 않습니다.

이것은 진입 이벤트이지 사용자 역할 메시지 이벤트가 아닙니다. 대기열 전달과 재생은 이를 다시 발생시키지 않습니다. 프로그래밍 방식의 `sendUserMessage`/`sendMessage` 호출과 합성 연속 실행은 `input`을 자동 발생시키지 않습니다. 주 세션 Enter의 `.`/`c` 연속 실행 단축 입력은 합성 경로를 유지합니다. 포커스된 하위 에이전트 입력은 채팅 전용 라우팅을 유지하고 주 세션 입력 훅을 호출하지 않습니다. 출력 모드와 ACP 입력은 이 가로채기 계약에 포함되지 않습니다.

Ctrl+Enter는 네이티브 핸들러를 기다리기 전에 제출한 초안을 분리하므로 다른 제출이 이를 재사용할 수 없고 이후 일반 입력은 새 초안으로 남습니다. 처리된 입력/빈 입력은 분리된 제출만 소비합니다. 디스패치가 실패하면 해당 텍스트와 첨부를 새 초안과 함께 복원합니다. 이로 인해 기존 대화형 입력 핸들러 체인이 Esc로 취소 가능해지는 것은 아닙니다. 기본 제공 제출 정리도 `/clear`, `/new`를 포함하여 새 초안을 보존합니다. 명령의 명시적인 미리 채우기와 세션 전환 동작은 유지됩니다.

### 도구 수명 주기

- `tool_call` (실행 전. 차단하거나 도구 실행 `input`을 수정하거나 수동 `additionalContext`를 반환할 수 있습니다. 모델이 요청한 호출은 에이전트 루프의 인수 준비 시 발생하므로 수정값을 다시 검증하며 동시 실행 스케줄링, 실행 이벤트, 저장된 어시스턴트 메시지, 승인 관문에 모두 반영합니다. 비차단 핸들러의 수동 컨텍스트는 묶음의 도구 결과 뒤, 다음 제공업체 요청 전에 어시스턴트 호출 순서로 전달합니다.)
- `tool_result` (실행 후. content/details/isError를 수정하거나 수동 `additionalContext`를 반환할 수 있습니다. `event.isError`가 true여도 결과 컨텍스트는 도구 출력 밖에서 전달하므로 실패 전용 핸들러가 다음 모델 단계를 안내할 수 있습니다.)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (관측용)
- `tool_approval_requested` / `tool_approval_resolved` (관측용. 도구에 승인이 필요하고 승인 핸들러가 등록된 경우에만 `wrapper.ts`에서 발생)

`tool_result`는 미들웨어 방식입니다. 핸들러는 확장 기능 순서로 실행되며 앞선 수정 내용을 봅니다. 모든 핸들러의 서로 다른 비공백 `additionalContext`는 등록 순서로 보존하고(앞뒤 공백을 무시해 비교한 중복은 제거), 해당 호출의 `tool_call` 컨텍스트 앞에 전달합니다.

### 계획 검토 수명 주기

- `plan_review_requested`는 대화형 계획 검토의 `reviewId`, 세션, 제목, 계획 경로와 내용, 표시 순서의 선택지를 보고합니다. 선택지 ID(`execute`, `compact`, `keep`, `refine`, `save`)는 안정적이지만 레이블은 바뀔 수 있으며 `keep`에는 현재 토큰 수가 포함됩니다. 터미널 선택기가 활성 상태인 동안 확장 기능이 `ctx.resolvePlanReview(...)`로 답할 수 있으며 첫 응답이 우선합니다. `save`는 경로 입력창을 열지 않고 기본 파일명을 사용합니다.
- 확장 기능이 승인하면 `input.role`로 지정한 계층에서 실행합니다. `role`을 생략하면 오버레이의 모델 슬라이더에서 현재 선택한 계층을 사용합니다. `plan_review_requested`는 선택 가능한 `tiers`(`role`, `provider`, `model`, 역할이 고정한 경우 `thinkingLevel`; 확인 가능한 계층이 두 개 미만이면 생략)를 나열합니다. 승인은 선택 시점의 계획을 실행합니다. 오버레이 편집 내용이 있으면 이를 사용하고, 없으면 디스크에서 계획 파일을 다시 읽습니다. 따라서 보고된 `planContent`와 다를 수 있습니다. 확장 기능은 응답 전에 계획 파일을 써서 자체 수정본을 실행할 수 있습니다.
- 계층 순서는 선택한 계층이 아니라 설정된 역할 순환 순서를 따릅니다. 슬라이더는 가능한 경우 처음에 `default`를 선택합니다. 원격 `input.role`은 표시 계층을 갱신하고 답변을 확정하여 이후 터미널 입력으로 바꾸지 못하게 합니다.
- `plan_review_resolved`는 선택한 선택지 ID(닫힘, 세션 전환, 다른 검토로 교체, 종료로 취소되면 `undefined`)와 `by: "local" | "extension"`으로 검토 종료 방식을 보고합니다. 모든 `plan_review_requested` 핸들러가 반환한 뒤 오버레이가 실제로 닫힐 때 발생하므로 `plan_review_requested` 핸들러는 긴 작업(원격 왕복 요청, `ctx.ui` 대화상자)을 기다리지 말고 별도 작업으로 넘겨야 합니다.

### 하위 에이전트 수명 주기

- `before_subagent_spawn` → `{ model?: string | string[]; block?: boolean; reason?: string; note?: string }`. 생성한 하위 에이전트(`task`, eval `agent()`, workpool 작업자)마다 부모 세션에서 정확히 한 번 발생합니다. 하위 에이전트가 모델을 확인하기 전 디스패치 시 발생하며 프런트엔드 검증 사전 점검에서는 발생하지 않으므로 상태가 있는 라우터(순환 할당, 할당량)는 하위 에이전트마다 한 번만 진행합니다. 이벤트에는 `agent`, `invocationKind`, `modelRole`(있는 경우 확장 전 역할 별칭), 코어가 사용할 확장된 `patterns`, 선택적 안정 `spawnKey`가 포함됩니다. 반환한 `model`은 역할 식별성을 유지하면서 실행의 시도 순서별 패턴을 교체하므로 나머지 항목은 하위 에이전트의 재시도 대체 체인이 됩니다. 핸들러는 확장 기능 순서로 실행하며 마지막 반환 `model`과 그 `note`가 우선합니다. 작업 UI는 실시간, 비동기, 완료 행에서 이 메모를 실행 라우팅 이유로 표시합니다. `block: true`는 `reason`으로 실행을 거부합니다. 실행을 취소하면 핸들러 제한 시간까지 붙잡아 두지 않고 대기 중인 핸들러를 해제합니다(결과는 버리고 대기 중인 `ctx.ui` 대화상자는 닫음).

### 신뢰성/런타임 신호

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` — 자동 재시도가 모델/제공업체를 전환할 때 `{ from, to, role, reason? }`
- `retry_fallback_succeeded` — 대체 모델에서 요청이 성공할 때 `{ model, role }`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP 알림

- `mcp_notification` — 연결된 MCP 서버에서 받은 모든 JSON-RPC 알림에 대해, 관리자가 알려진 목록/업데이트 메서드(`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`, `notifications/prompts/list_changed`)를 자체 처리한 **후** 발생합니다. 알 수 없는 메서드와 서버 사용자 지정 메서드도 전달합니다. 페이로드: `{ server: string; method: string; params: unknown }`. 여러 확장 기능이 구독할 수 있으며 핸들러 예외는 다른 핸들러 실행을 막지 않습니다. 리스너 연결 전에 받은 알림은 버퍼링하고(크기 제한 FIFO, 최대 100개, 가장 오래된 항목 제거) 첫 구독자에게 전달하므로 확장 기능이 MCP 검색 이후에 연결되어도 시작 시 프레임을 잃지 않습니다.

푸시 가능한 MCP를 세션 개입 메시지로 연결하는 예:

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
    attribution: "agent",
  });
});
```

런타임이 먼저 JSON-RPC 전송과 자체 목록/업데이트 갱신을 처리합니다. 이후 핸들러가 실행되며 `pi.sendMessage` / `pi.sendUserMessage`로 턴 중간에 개입 메시지를 주입할 수 있습니다.

### 사용자 명령 가로채기

- `user_bash` (`{ result }`로 재정의)
- `user_python` (`{ result }`로 재정의)

### `resources_discover`

`resources_discover`는 확장 기능 타입과 `ExtensionRunner`에 존재합니다.
현재 런타임 참고: `ExtensionRunner.emitResourcesDiscover(...)`는 구현되어 있지만 현재 코드베이스에는 이를 호출하는 `AgentSession` 호출 지점이 없습니다.

## 도구 작성 세부사항

`registerTool`은 `types.ts`의 `ToolDefinition`을 사용합니다. `parameters` 필드는 omptype 스키마를 받으며 레거시 확장 기능을 위한 주입된 TypeBox 호환 계층도 계속 사용할 수 있습니다.

팩터리에서 등록하는 것을 권장하지만 나중에 발견한 도구(예: `session_start`)도 활성 레지스트리에 마운트됩니다. 디스패치된 이벤트 핸들러 안에서 한 등록은 해당 핸들러 완료 전에 반영됩니다. `await pi.setActiveTools(...)`도 대기 중인 등록을 기다립니다. 제한된 하위 세션은 늦은 등록을 포함하여 확장 기능 도구를 허용하지 않습니다. 호스트 RPC와 SDK 사용자 지정 도구는 충돌하는 확장 기능 도구보다 계속 우선합니다.

현재 `execute` 시그니처:

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

### 도구 호출 후 수동 컨텍스트 추가

`tool_call` 핸들러는 도구 결과를 바꾸지 않고 `additionalContext`를 반환할 수 있습니다.

```ts
pi.on("tool_call", async event => {
  if (event.toolName === "search") {
    return { additionalContext: "Use this result before searching again." };
  }
});
```

`additionalContext`는 다음 제공업체 요청을 위한 신뢰할 수 있는 핸들러 작성 지침을 담습니다. 호스트는 선택한 전송 계층이 지원할 경우 개발자/시스템 우선순위로 도구 결과 뒤에 이를 출력합니다. 앞뒤 공백을 무시하여 비교한 중복은 두 수준에서 제거합니다. 같은 호출에서 이전 핸들러와 동일한 값, 그리고 같은 묶음에서 이전 호출의 결합 컨텍스트와 동일한 호출 컨텍스트입니다. 원시 도구 출력과 그 밖의 신뢰할 수 없는 데이터는 일반 도구 결과에 남겨야 합니다.

모든 비차단 핸들러의 서로 다른 비어 있지 않은 컨텍스트는 등록 순서로 보존합니다. OMP는 도구 묶음이 끝날 때까지 기다린 뒤 해당 도구 결과 뒤, 다음 제공업체 요청 전에 어시스턴트 도구 호출 순서로 컨텍스트를 출력합니다. 핸들러 컨텍스트는 호출이 실제로 실행되고 오류가 아닌 결과를 반환할 때만 전달합니다. 이 핸들러나 후속 핸들러가 차단하거나, 승인 입력창에서 거부하거나, 중단으로 건너뛰거나, 실패하면 수집한 컨텍스트를 버립니다.

등록된 도구는 실행 중 `ctx.addAdditionalContext?.("...")`로 컨텍스트를 추가할 수 있습니다. 도구 자체가 추가한 컨텍스트는 이후 도구가 오류를 반환해도 유지합니다. 한 호출 안에서는 도구 자체 컨텍스트(중첩 `xd://` 디스패치로 도달한 도구 포함)가 `tool_call` 핸들러 컨텍스트보다 먼저 옵니다. Cursor가 exec 채널에서 실행하는 호출은 버퍼링된 결과 뒤, 다음 제공업체 요청에서 컨텍스트를 전달합니다.

### 네이티브 기본 제공 도구에 위임 (`ctx.invokeTool`)

기본 제공 이름을 다시 등록한 도구(예: 로그나 정책 검사를 추가하려고 `write`를 감쌈)는 재구현하지 않고 원본을 실행할 수 있습니다. 등록한 도구가 기본 제공 도구를 가리면 `execute`에 전달되는 `ctx`는 다음을 포함합니다.

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

같은 이름의 **네이티브** 기본 제공 도구를 실행하고 네이티브 도구 자체의 부작용과 내부 기록 처리를 포함하는 결과를 반환합니다. 위임은 같은 도구에만 가능하므로 임의의 대상에 접근하거나 이 호출에 이미 부여된 승인 범위를 넘어 권한을 높일 수 없습니다. 기본적으로 외부 호출의 중단 신호, 진행 콜백, 도구/제공업체 메타데이터를 상속합니다. 명시적인 `signal` / `onUpdate` 옵션은 해당 채널을 재정의합니다. 같은 이름의 네이티브 기본 제공 도구가 있을 때만 제공됩니다. 기본 제공 도구를 가리지 않는 새 도구의 `ctx.invokeTool`은 `undefined`입니다. 이미 승인받은 같은 도구이므로 네이티브 호출에 관문을 다시 적용하지 않으며, 위임 깊이 제한으로 우발적인 자기 재귀를 방지합니다.

템플릿:

```ts
const z = pi.zod;

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: z.object({}),
  hidden: false,
  defaultInactive: false,
  deferrable: false,
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

`renderCall`의 `options` 인수는 `Theme` API도 제공하므로, 업스트림 pi에서 가져온 `renderCall(args, theme, context)` 형식의 도구 렌더러도 다시 작성하지 않고 올바른 스타일을 적용합니다.

`tool_call`/`tool_result`는 `sdk.ts`에 등록된 기본 제공 도구와 확장 기능/사용자 정의 도구를 가로챕니다. 승인 정책이 거부하면 `tool_call` 전에 실행이 중단될 수 있습니다. 차단되거나 거부된 호출은 실행되지 않으며 정상적인 실행 후 결과 훅도 발생시키지 않습니다.

추가 `ToolDefinition` 필드:

- `hidden`, `defaultInactive`: 명시적으로 요청하지 않는 한 자동 활성화하지 않습니다.
- `loadMode`: 새 도구 이름의 기본값은 `"discoverable"`입니다. 알려진 필수 기본 제공 도구 이름은 명시적 모드 없이 다시 등록하면 `"essential"`을 유지합니다(`tools/essential-tools.ts` 참고). 명시적 모드가 우선합니다.
- `deferrable`, `readsSkillUris`, `strict`.
- `approval`: 기본값은 `"exec"`이며, 계층, 결정 객체 또는 인수를 받는 함수를 허용합니다.
- `mcpServerName`, `mcpToolName`, `legacyName`, `sourcePath`: 검색, 승인, 출처 메타데이터입니다.
- `shellEnv`: 대화형 사용자 셸에 제공할 환경 값입니다.
- `renderCall`, `renderResult`: TUI 컴포넌트입니다.
- `describeCall`, `describeResult`: TSP 터미널용 의미 기반 도구 뷰입니다.

<a id="file-write-fallback-registerfilewritefallback"></a>
### 파일 쓰기 대체 처리 (`registerFileWriteFallback`)

`write`, `edit`, `apply_patch`는 일반 파일 경로에 실제 바이트를 쓸 때 하나의 공통 기본 연산(`file ? file.write(content) : Bun.write(dst, content)`)을 사용합니다. 이 연산이 권한 오류(`EPERM`/`EACCES`/`EROFS`)로 실패하면 코딩 에이전트는 포기하기 전에 `pi.registerFileWriteFallback`으로 등록한 핸들러에 처리를 요청합니다. `EISDIR` 등 다른 오류에는 영향을 주지 않습니다.

```ts
import type { FileWriteFallbackHandler } from "@oh-my-pi/pi-coding-agent";

const writeThroughBroker: FileWriteFallbackHandler = async (req, ctx) => {
  // req: { dst: string; content: string; cause: unknown; sessionId: string | undefined }
  const ok = await myPrivilegedWriter.write(req.dst, req.content);
  return ok;
};

pi.registerFileWriteFallback(writeThroughBroker);
```

핸들러는 등록 순서로 실행합니다. 처음으로 `true`를 반환한 핸들러는 바이트를 디스크에 영구 저장한 것으로 간주하며, 네이티브 도구는 자체 쓰기가 성공한 것처럼 계속 진행합니다. 실제 대상 경로에 파일 스냅샷도 기록하므로 이후 해당 경로에 대한 해시라인 `edit`도 정상 동작합니다. 예외를 던진 핸들러는 로그를 남기고 다음 핸들러로 넘어갑니다. 이는 핸들러별로 적용하므로 같은 확장 기능에서 나중에 등록한 핸들러도 실행됩니다. 모든 핸들러가 `false`를 반환하거나 등록된 핸들러가 없으면 원래 오류를 다시 던집니다.
Bun이 거부된 상위 디렉터리 `mkdir`을 `ENOENT`로 가린 경우, 원래 오류에 `cause`가 없으면 복구한 권한 거부 오류를 연결합니다. 이 기능은 직접 파일시스템 쓰기를 차단하지만 권한 있는 쓰기 채널은 제공하는 샌드박스에 에이전트를 내장하는 호스트를 위한 것입니다.

`req.dst`는 도구에 전달된 경로가 아니라 **심볼릭 링크를 해석한** 대상입니다. 커널은 마지막 구성 요소를 제외한 모든 경로 구성 요소의 링크를 따라갑니다. 따라서 `ws/link -> /elsewhere`인 경우 `ws/link/file`은 작업 공간 안처럼 보여도 실제로는 `ws` 밖을 가리키며, 핸들러에서 단순 접두사 허용 목록을 쓰면 이 경로가 통과할 수 있습니다. 쓰기는 마지막 구성 요소의 링크도 따라가므로 이 부분도 해석합니다. 삭제는 `unlink`가 링크의 대상이 아닌 링크 자체를 제거하므로 마지막 링크를 따라가지 않습니다(삭제의 `req.dst` 자체가 링크일 수 있음). `req.dst`를 신뢰할 수 있는 최종 대상으로 취급하고 다른 정보로 대상을 다시 계산하지 마세요. 마지막 링크가 끊어졌거나 이 프로세스가 상위 경로를 해석할 수 없어 실제 대상을 확정하지 못하면, 권한 있는 쓰기 도우미에 전달할 대상이 없으므로 핸들러를 호출하지 않고 원래 오류를 다시 던집니다.

대상이 호스트의 허용 범위 밖에 있을 때는 다음 두 가지가 중요합니다.

- **상위 디렉터리가 없는 경우.** `Bun.write`는 없는 상위 디렉터리를 직접 만듭니다. 이 `mkdir`이 거부되면 권한 거부 대신 후속 `open()`의 `ENOENT`를 보고합니다. 에이전트는 실제 errno를 복구하기 위해 `mkdir`을 명시적으로 다시 실행하므로, 이 경우도 핸들러에 도달하며 `req.cause`는 `mkdir`의 권한 거부 오류가 됩니다. 이때 `req.dst`의 상위 디렉터리는 아직 없으므로 핸들러가 만들어야 합니다. 실제로 생성 가능한 상위 디렉터리나 잘못된 상위 경로에서 발생한 `ENOENT`는 대체 처리하지 않습니다. (`apply_patch`는 쓰기 전에 별도 단계로 상위 디렉터리를 만듭니다. 대체 핸들러가 등록되어 있으면 이 `mkdir`의 거부를 허용하여 쓰기가 핸들러에 도달하도록 합니다.)
- **해시라인 `MV`.** `edit`의 이동은 LSP 연동 쓰기를 거치지 않고 대상에 직접 씁니다. 이 쓰기도 같은 핸들러로 전달하며, 원본의 링크 해제는 아래 삭제 대체 처리로 전달하므로 쓰기 권한이 없는 디렉터리에서 파일을 옮기는 작업도 완료할 수 있습니다.

이 기능은 의도적으로 에이전트의 모든 쓰기를 가로채지 않습니다. 다음 작업의 권한 오류는 핸들러를 호출하지 않고 기존처럼 전달합니다.

- 아카이브 항목(`foo.zip:entry`)이나 SQLite 행에 대한 `write`. 둘 다 `dst`에 바이트를 쓰는 작업이 아닙니다. 아카이브 재작성은 전체 아카이브를 읽고 항목 하나를 교체한 뒤 임시 파일을 쓰고 원본 위로 이름을 바꿉니다. 따라서 저장되는 것은 도구에 전달한 문자열이 아니라 전체 바이너리 컨테이너입니다. SQLite 쓰기는 바이트 페이로드 없이 데이터베이스 엔진 안에서 수행하는 행 연산입니다. 둘 다 중계하려면 “이 바이트를 이 경로에 저장”하는 것과 다른 요청 형식이 필요합니다.
- 쓰기를 원격 클라이언트에 맡기는 ACP 브리지의 `writeTextFile`.
- `lsp` 도구 자체의 쓰기: 작업 공간 편집이나 코드 동작 적용, 그리고 버퍼를 쓴 후 셸에서 `biome format --write`를 실행하는 Biome 포매터입니다. 하위 프로세스의 쓰기는 프로세스 내부 확장 지점으로 가로챌 수 없습니다.

<a id="file-delete-fallback-registerfiledeletefallback"></a>
### 파일 삭제 대체 처리 (`registerFileDeleteFallback`)

파일 삭제는 쓰기와 다른 기본 연산이므로 별도의 확장 지점을 제공합니다.

```ts
pi.registerFileDeleteFallback(async (req, ctx) => {
  // req: { dst; cause; confirmedFile; sessionId } — no `content`.
  return await myPrivilegedWriter.unlink(req.dst);
});
```

이 기능은 `edit`의 `REM`, 해시라인 `MV`의 원본 삭제, `apply_patch`의 삭제 연산을 처리하며 쓰기 대체 처리와 같은 규칙을 따릅니다. 같은 권한 오류 코드를 처리하고, 처음 `true`를 반환한 핸들러가 우선하며, 예외를 던진 핸들러는 건너뜁니다. 성공한 핸들러가 없으면 원래 오류를 다시 던지고, 등록된 핸들러가 없으면 아무 추가 처리도 하지 않습니다. 차이점은 두 가지입니다.

- **`ENOENT`는 절대 대체 처리하지 않습니다.** 링크 해제 과정에서는 아무것도 생성하지 않으므로, 파일이 없다는 것은 실제로 없다는 뜻입니다. `REM`은 이를 파일을 찾을 수 없다는 오류로 변환합니다.
- **핸들러는 반드시 링크 해제만 해야 하며 재귀 삭제하면 안 됩니다.** macOS에서 디렉터리에 `unlink`를 수행하면 `EPERM`이 발생하므로 오류 코드만으로는 샌드박스의 권한 거부와 구분할 수 없습니다. 따라서 확장 지점은 대상에 `lstat`을 수행하고 디렉터리라면 대체 처리를 거부합니다. 하지만 대상의 메타데이터 자체가 링크 해제를 거부한 동일한 경계 뒤에 있는 일반적인 샌드박스 상황에서는 이 검사를 완료할 수 없으며, 이때 `req.dst`는 디렉터리일 수도 있습니다. `req.confirmedFile`은 대상이 일반 파일임을 확실히 확인한 경우에만 `true`입니다. 링크를 해제하는 것은 허용되지만 링크를 해석하면 전혀 다른 대상에 작용하므로 심볼릭 링크도 `false`입니다. 권한 있는 도우미가 `req.dst`를 재귀 삭제하거나 먼저 실제 경로로 해석하면, 파일 하나만 제거하는 도구가 요청한 범위를 훨씬 벗어나게 됩니다.

**삭제 등록과 쓰기 등록은 의도적으로 분리되어 있습니다.** 쓰기 핸들러는 `req.content`를 `req.dst`에 중계합니다. 삭제 요청이 전달되면 콘텐츠가 없다는 이유로 빈 쓰기를 중계하여, 삭제할 파일을 오히려 길이 0으로 _잘라낼_ 수 있습니다. 따라서 쓰기 전용 핸들러에는 삭제 요청을 전달하지 않습니다.

두 확장 지점에 공통으로 적용되는 수명 주기 제약은 다음과 같습니다.

- 다른 `register*` 호출처럼 **확장 기능을 불러오는 동안 기본 팩터리에서 등록하세요.** 핸들러는 `ExtensionRunner.initialize` 실행 시 설치됩니다. 그때까지 아무것도 등록하지 않은 확장 기능은 완전히 건너뛰므로, 이후에 처음 등록해도 적용되지 않습니다. 핸들러의 `ctx`는 설치 시 캡처하지 않고 호출마다 구성하므로 `ctx.cwd`와 `ctx.hasUI`는 변경 작업이 거부된 시점의 세션 상태를 나타냅니다. 작업 공간 변경(`/move`)은 로드 시 상태에 고정되지 않고 다음 요청에 반영됩니다.
- **레지스트리는 프로세스 전체에서 공유됩니다.** 한 프로세스가 여러 세션을 호스팅할 수 있으므로(하위 에이전트는 별도의 실행기를 사용), 핸들러를 등록한 확장 기능의 세션뿐 아니라 프로세스 안의 모든 세션에서 거부된 쓰기나 삭제가 핸들러에 전달될 수 있습니다. 이는 의도된 동작입니다. 최상위 세션에서 한 번 등록한 호스트는 확장 기능 팩터리를 상속하지 않은 세션을 포함해 하위 에이전트의 쓰기도 중계되기를 기대합니다. 제한된 자식 세션은 부모가 불러온 훅을 유지하지만 주변 환경의 확장 기능을 검색하지 않습니다. `req.sessionId`는 변경 작업을 요청한 세션을 나타내고(도구 호출에서 시작하지 않았으면 `undefined`), `ctx.sessionManager.getSessionId()`는 핸들러 자체의 세션을 나타냅니다. 세션별 판단이 필요하면 둘을 비교하세요. 특히 사용자에게 질문하기 전에 중요합니다. `ctx.ui`는 질문 대상 세션이 아니라 핸들러의 세션에 속하기 때문입니다. 핸들러는 `session_shutdown` 때 제거됩니다.

등록된 핸들러가 없으면 이 기능은 전혀 개입하지 않습니다. 기본 연산은 기존과 똑같이 실행되며 추가 시스템 호출도 수행하지 않습니다.

<a id="ui-integration-points"></a>
## UI 통합 지점

`ctx.ui`는 `ExtensionUIContext` 인터페이스를 구현합니다. 지원 범위는 모드마다 다릅니다.

<a id="interactive-mode-extension-ui-controllerts"></a>
### 대화형 모드 (`extension-ui-controller.ts`)

지원하는 기능:

- 대화 상자: `select`, `confirm`, `input`, `editor`, 선택적 `askDialog`
- 입력 편집: `setEditorText`, `getEditorText`, `pasteToEditor`, `editor`. `supportsEditor`는 붙여넣기가 로컬 또는 원격 입력창을 갱신하는지 나타냅니다(없으면 미지원).
- 자동 완성 계층화: `addAutocompleteProvider(factory)`는 기본 편집기 제공업체를 감쌉니다. 팩터리는 등록 순서로 적용하며 슬래시 명령을 갱신할 때마다 다시 적용합니다.
- 터미널 제목과 작업 메시지 (`setTitle`, `setWorkingMessage`)
- 알림/상태/편집기 텍스트/터미널 입력/사용자 정의 오버레이
- 이름별 테마 목록 조회/불러오기 (`setTheme`은 문자열 이름 지원)
- 도구 펼치기 전환

현재 이 컨트롤러에서 아무 동작도 하지 않는 메서드:

- `setFooter`
- `setHeader`

`ctx.ui.setEditorComponent(factory)`는 실제 편집기에 연결됩니다. 팩터리는 일반 `Editor`/`EditorComponent`가 아니라 `CustomEditor` 하위 클래스를 반환해야 합니다.
`ctx.ui.getEditorComponent()`는 현재 설치된 팩터리(기본 편집기는 `undefined`)를 반환하므로 다른 확장 기능의 편집기를 교체하지 않고 감쌀 수 있습니다. 팩터리 내부에서는 이전 팩터리를 반환합니다.
`setWidget`은 `setHookWidget(...)`을 통해 편집기 위나 아래에 위젯 컴포넌트를 렌더링합니다(`placement: "aboveEditor" | "belowEditor"`). 문자열 배열은 콘텐츠 최대 10줄과 잘림 안내를 표시합니다. 위젯을 제거하려면 `undefined`를 전달하세요. `setEditorText`와 `pasteToEditor`는 편집기를 변경한 뒤 다시 그리기를 요청합니다.

<a id="launching-terminal-commands"></a>
#### 터미널 명령 실행

`ctx.ui.openTerminal(request)`는 대화형 TUI에서만 사용할 수 있습니다. 멀티플렉서 창 영역이나 제공업체 고유 그룹(tmux 창, Zellij/Herdr/Orca 탭 또는 CMUX 작업 공간이며 OS 창이 아님)을 만들고 보고된 네이티브 ID를 반환합니다. 제공업체가 명령을 시작했지만 요청한 위치에 표시하지 못하면 `warning`도 반환합니다. RPC, ACP, 출력, 헤드리스 컨텍스트는 이 선택적 메서드를 제공하지 않습니다. 요청 타입과 지원 제공업체 집합은 표준 실행 기능에서 파생됩니다. tmux, Zellij, Herdr, CMUX, Orca를 지원하며, screen과 wmux는 멀티플렉서 분류에서 인식하지만 현재 실행은 지원하지 않습니다.

제공업체별 세션 감지는 멀티플렉서마다 모듈을 등록하는 `@oh-my-pi/pi-tui/terminal-multiplexer`에 집중되어 있습니다. `hasTerminalMultiplexerSession(provider, env)`는 명시적 세션 표식을 확인합니다. `classifyTerminalMultiplexer(env)`는 프로세스를 호스팅하는 멀티플렉서를 판별하며, 세션 표식, `tmux`/`screen`의 `TERM` 대체 감지, Orca 같은 외부 애플리케이션 순으로 확인합니다. 따라서 Orca 안에서 실행 중인 멀티플렉서가 우선합니다. `isInsideTerminalMultiplexer(env)`는 분류된 멀티플렉서가 화면 격자를 소유할 때만 참입니다. Orca는 터미널 직접 렌더링 경로를 유지합니다. 멀티플렉서가 분류되었다고 중첩 제공업체 세션이나 네이티브 창 영역 ID가 존재한다는 뜻은 아닙니다.

이 기능은 TUI 호스트가 주입하므로 확장 기능에서 디스패처 코드를 가져올 필요가 없습니다.

OMP 내부 호출자는 `classifyTerminalMultiplexer(env)`의 결과를 `getTerminalLaunchPlacement(...)`에 전달하여 지원 및 표시 메타데이터를 얻거나, `createDefaultTerminalLaunchRequest(...)`의 첫 인수로 전달하여 검증된 제공업체 기본 요청을 만들 수 있습니다. 팩터리는 배치, 명령 argv, cwd, 선택적 셸 확인도 받습니다. 두 도우미는 `src/subprocess/terminal-launch.ts`에서 내보냅니다.
배치 조회는 제공업체 표시 이름, 사용자에게 표시할 그룹 이름(`pane`, `tab`, `workspace` 등), 필요한 셸 문법을 반환합니다. 멀티플렉서를 감지하지 못했거나 제공업체가 해당 배치를 지원하지 않으면 오류를 반환합니다. 요청 팩터리는 `{ request }` 또는 `{ error }`를 반환하고 생성한 요청을 검증합니다. 제공업체별 대상, 포커스, 방향, 실행 옵션은 지정하지 않아 백엔드의 기본값을 적용합니다. 셸 입력 방식으로 실행할 때는 대상 셸이 POSIX 문법을 사용하는지 확인한 뒤에만 `shellGrammar: "posix"`를 전달하세요. 팩터리는 이 확인이 누락되면 거부합니다. 확장 기능은 계속 명시적인 타입 지정 요청으로 `ctx.ui.openTerminal(...)`을 사용할 수 있습니다.

```ts
const result = await ctx.ui.openTerminal?.({
  multiplexer: "tmux",
  placement: "pane",
  command: ["bun", "run", "dev"],
  cwd: ctx.cwd,
  target: process.env.TMUX_PANE!,
  focus: false,
  execution: "direct",
});
```

대상은 제공업체 고유 ID/참조이며, 배치에 따라 의미가 다릅니다.

- tmux 창 영역 배치는 창 영역 ID를 대상으로 하며 기본값은 `TMUX_PANE`입니다. 새 창의 대상은 세션 이름/ID이며 현재 TMUX 세션 안에서는 생략할 수 있습니다. 명시적인 창 영역 또는 세션 대상이 있으면 `TMUX`가 설정되지 않아도 CLI에 접근할 수 있습니다.
- Zellij 창 영역 배치는 기존 탭 ID를 대상으로 지정할 수 있습니다(Zellij 0.44.1 이상). 새 탭 생성에는 대상 옵션이 없습니다. 둘 다 활성 `ZELLIJ` 세션이 필요합니다.
- Herdr 창 영역 배치는 창 영역 ID를 대상으로 하며 기본값은 `HERDR_PANE_ID`입니다. 탭 배치는 작업 공간 ID를 대상으로 하며 기본값은 `HERDR_WORKSPACE_ID`입니다. 대상은 활성 Herdr 창 영역 또는 작업 공간에 있어야 합니다.
- Orca 창 영역 분할은 `ORCA_PANE_KEY`를 현재 터미널 핸들로 해석합니다. 감지하려면 `ORCA_PANE_KEY`와 `ORCA_WORKTREE_ID`가 모두 필요합니다. 탭 생성의 기본 대상은 워크트리 `id:<ORCA_WORKTREE_ID>`입니다. 애플리케이션 이름만으로는 Orca 세션을 감지할 수 없습니다. 대상, 제목, 명령은 `--flag=value`로 전달하므로 `--`로 시작하는 값도 데이터로 유지됩니다.
- CMUX 창 영역 배치는 서피스 ID를, 작업 공간 배치는 창 ID를 대상으로 합니다. 대응하는 CMUX 컨텍스트가 활성 상태이면 둘 다 생략할 수 있습니다. 명시적 서피스 대상은 최종 기준이며 주변 작업 공간과 결합하지 않습니다. 소켓 경로와 전송 표식만으로는 활성 로컬 CMUX 서피스가 성립하지 않습니다.

지원하지 않는 대상 조합은 무시하지 않고 실패합니다. 기능 검사는 `TERM`만이 아니라 제공업체 식별 표식 또는 네이티브 대상을 사용합니다. `focus` 제어는 지원하는 배치에만 적용합니다. 거짓일 때 tmux는 `-d`, Zellij는 `--no-focus`(Zellij 0.45.0 이상), Herdr는 `--focus`/`--no-focus`를 사용하며, CMUX는 분할과 작업 공간 생성 모두에 `--focus true|false`를 전달합니다. Orca 탭 생성은 `focus: true`를 `--focus`에 매핑하고 그 외에는 Orca 기본값을 따릅니다. Orca 창 영역 분할에는 포커스 옵션이 없습니다. Orca가 새 탭을 표시할 수 없으면 백그라운드 터미널에서 명령을 시작하며 결과의 `warning`에 이를 알립니다.

실행 방식은 제공업체마다 다릅니다. tmux는 인수가 여러 개인 명령을 직접 실행하지만, 인수가 하나이면 설정된 `default-shell -c`로 실행합니다. 이 셸은 fish, Nushell 또는 POSIX가 아닌 다른 셸일 수 있습니다. 단일 인수 직접 실행 시 디스패처는 `/usr/bin/env --`를 앞에 붙여 공백, 선행 하이픈, 셸 메타문자가 포함된 실행 파일도 데이터로 유지합니다. 단일 인수 실행 파일 이름에 `=`가 있으면 `env`가 대입으로 해석하므로 거부합니다. `execution: "shell"`은 argv를 POSIX 방식으로 인용하고 `default-shell`과 무관하게 `/bin/sh -c`로 실행합니다. tmux는 시작 디렉터리에 형식 확장을 수행하므로 디스패처는 `cwd`의 모든 `#`를 `##`로 전달합니다. Zellij는 직접 argv 실행을 지원합니다. 설치된 CLI보다 새 버전이 필요한 Zellij 옵션(0.44.0 이전의 탭 배치, 0.44.1 이전의 `target`, 0.45.0 이전의 `focus: false`)은 아무것도 생성하기 전에 필요한 버전을 명시하는 오류로 실패합니다. 디스패처는 프로세스마다 한 번 `zellij --version`을 확인합니다.

Herdr의 `pane run`은 대상의 대화형 셸에 텍스트를 입력합니다. 따라서 어댑터는 POSIX 방식으로 인용한 argv를 임시 디렉터리의 비공개 자동 삭제 `/bin/sh` 스크립트에 쓰고 절대 경로만 입력합니다. 단독 경로를 실행하는 모든 대화형 셸(POSIX 셸, fish, Nushell)은 정확한 argv를 실행하므로 Herdr 요청에는 `shellGrammar`가 없습니다. Windows에서는 Herdr 실행을 거부합니다.

CMUX의 `--command`와 Orca의 `terminal split`/`terminal create`는 argv를 직접 실행하지 않고 대상 대화형 셸에 명령 텍스트를 제출합니다. 따라서 요청에 `shellGrammar: "posix"`가 필요합니다. 대상 셸이 POSIX 문법을 허용하는지 확인한 뒤에만 설정하세요. 로컬 OS나 `$SHELL`에서 추론하거나 설정된 셸을 추측하지 않습니다. 이를 확인하지 않았다면 CMUX 또는 Orca 실행을 요청하지 마세요. 확인한 경우 공통 POSIX 셸 인용 도우미로 argv의 각 단어를 인용합니다. Orca의 split/create에는 `--cwd` 플래그가 없으므로 어댑터는 `--command`의 인용된 명령 앞에 `cd <quoted-cwd> &&`를 붙입니다. CMUX 분할도 셸 안에서 디렉터리를 바꾼 뒤 명령을 입력합니다. 이 인용이 Nushell, PowerShell, `cmd.exe` 또는 다른 셸 문법에서 동작한다고 보장하지 않습니다.
Orca CLI는 문서에 명시된 순서로 해석합니다. 설정된 `ORCA_CLI_COMMAND`, Orca 개발 체크아웃(`ORCA_DEV_REPO_ROOT`)의 `orca-dev`, Orca 터미널 밖 Linux의 `orca-ide`, 그 외에는 `orca`를 사용합니다.

이 명령은 터미널 입력으로 제출하므로 셸 입력 요청은 창 영역이나 작업 공간을 만들기 전에 명령 인수의 C0/C1 제어 바이트와 DEL을 거부합니다. CMUX와 Orca는 셸 명령에 포함되는 `cwd`에서도 이를 거부합니다. 직접 tmux 또는 Zellij argv에는 이 제한을 적용하지 않습니다. 이 경우 인수의 줄바꿈은 터미널 입력이 아니라 데이터로 유지됩니다.

Herdr, Zellij, Orca의 `window` 배치는 탭을 만들며 CMUX는 작업 공간을 만듭니다. 제공업체별 필드에는 창 영역 방향, Zellij 부동 창 영역/이름, Herdr 탭 이름, CMUX 작업 공간 이름이 있습니다. Zellij 부동 창 영역은 분할 방향을 지정할 수 없으며, 새 탭 생성은 탭을 대상으로 지정할 수 없습니다. tmux는 필수 창 영역(`%...`) 또는 창(`@...`) ID를 반환합니다. Zellij 0.44.0 이상은 창 영역 ID를 `terminal_<id>`, 탭 ID를 숫자 문자열로 보고합니다. 이전 Zellij의 창 영역 실행은 ID를 보고하지 않으므로 `result.id`를 사용할 수 없습니다. Herdr는 JSON 응답에 창 영역/탭 ID가 있어야 합니다. CMUX는 작업 공간/창 영역 ID가 있으면 보고하지만 JSON 응답에서 생략할 수 있으며, 이때는 `result.id`를 사용할 수 없습니다. Orca는 `result.split.handle`에 창 영역 핸들, `result.terminal.handle`에 탭 핸들을 반환합니다. 최상위 JSON `id`는 터미널 핸들이 아니라 RPC 요청 ID입니다.

`cwd`는 절대 경로여야 합니다. 요청이 객체가 아니거나 알 수 없는 멀티플렉서/배치를 지정하면 `TypeError`로 거부합니다. 인식된 제공업체나 배치라도 실행을 지원하지 않는 경우를 비롯한 나머지 모든 실패는 정제된 `TerminalLaunchError`로 거부합니다. 이 오류에는 제공업체, 연산, 가능한 경우 종료 상태를 포함하지만 명령 argv와 CLI 출력은 포함하지 않습니다. CMUX와 Orca는 잘못된 JSON 응답을 받으면 생성을 재시도하지 않고 거부합니다.

공통 환경 재정의는 없습니다. 각 멀티플렉서는 자체 환경 전파 규칙을 적용하며 디스패처는 통일된 변수 상속을 합성하지 않습니다. 직접 실행 백엔드에서는 요청 argv를 분리된 상태로 유지합니다. 셸 입력 백엔드만 필수 POSIX 문법 확인을 전제로 argv를 셸 텍스트로 변환합니다.

<a id="rpc-mode-rpc-modets"></a>
### RPC 모드 (`rpc-mode.ts`)

`ctx.ui`는 RPC `extension_ui_request` 이벤트로 구현됩니다.

- 대화 상자 메서드(`select`, `confirm`, `input`, `editor`)는 클라이언트 응답과 요청/응답을 주고받습니다.
- 응답을 기다리지 않는 메서드는 요청을 발생시킵니다(`notify`, `setStatus`, 문자열 배열 또는 제거용 `setWidget`, `method: "set_editor_text"`로 전송하는 `setEditorText`). `pasteToEditor`는 `setEditorText`로 대체됩니다.
- `setTitle`은 `PI_RPC_EMIT_TITLE`이 `1`, `true`, `yes`, `on`일 때만 발생시킵니다(대소문자 무시).

RPC 구현에서 지원하지 않거나 아무 동작도 하지 않는 항목:

- `onTerminalInput`
- `custom`; 선택적 `askDialog`는 없습니다.
- `getEditorText`는 `""`, `getEditorComponent`는 `undefined`를 반환합니다.
- `setFooter`, `setHeader`, `setEditorComponent`, `addAutocompleteProvider`
- `setWorkingMessage`
- 테마 전환/불러오기 (`setTheme`은 실패 반환)
- 도구 펼치기 제어는 동작하지 않습니다.

<a id="printheadlesssubagent-paths"></a>
### 출력/헤드리스/하위 에이전트 경로

실행기를 초기화할 때 UI 컨텍스트를 제공하지 않으면 `ctx.hasUI`는 `false`이며 메서드는 아무 동작도 하지 않거나 기본값을 반환합니다. `--mode rpc --no-ui`와 `--mode rpc-ui --no-ui`는 모두 확장 기능에 이 경로를 사용합니다. `rpc-ui`의 도구 대화 상자는 계속 활성화됩니다.

<a id="acp-mode"></a>
### ACP 모드

ACP는 정보 요청 브리지 UI 컨텍스트(`modes/acp/acp-agent.ts`의 `createAcpExtensionUiContext`)를 설치합니다. `ctx.mode`는 `"rpc"`, `ctx.hasUI`는 `true`입니다. `select`/`confirm`/`input`/`editor`와 선택적 `askDialog`는 ACP 양식 정보 요청으로 요청/응답을 주고받습니다. 클라이언트에 `elicitation.form`이 없으면 기본값을 반환합니다. 정보 요청 외 기능(위젯, 편집기 제어, 테마, 터미널 입력, 자동 완성 계층화)은 동작하지 않습니다. `notify`는 디버그 알림을 로그에 남깁니다.

<a id="session-and-state-patterns"></a>
## 세션과 상태 패턴

확장 기능 상태를 영구 보존하려면:

1. `pi.appendEntry("com.example.my-extension.state", data)`로 저장합니다. `customType` 이름 공간은 전역이므로 패키지 이름이나 역방향 도메인으로 한정한 값을 사용하고 [`custom` 세션 항목 참조](./session.md#custom)의 코어 예약값을 피하세요.
2. `session_start`, `session_branch`, `session_tree`에서 `ctx.sessionManager.getBranch()`로 상태를 복원합니다.
3. 도구 결과 이력에서 상태를 확인하거나 복원해야 한다면 도구 결과의 `details`를 구조화된 상태로 유지합니다.

복원 패턴 예:

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === "com.example.my-extension.state"
    ) {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

<a id="session-entry-roles-messagerole-is-camelcase"></a>
### 세션 항목 역할 (`message.role`은 camelCase)

`ctx.sessionManager.getBranch()`를 순회하면 저장된 각 항목에는 `type`이 있습니다(`message`, `custom_message`, `branch_summary`, `compaction` 등. [세션 항목 모델](./session.md#entry-taxonomy) 참고). `type: "message"` 항목은 `entry.message`에 `AgentMessage`를 담습니다. 그 `role` 판별자는 **camelCase**이며, 원시 LLM 전송 형식이나 위의 `tool_call` / `tool_result` **훅** 이름에 쓰이는 snake_case가 아닙니다.

| 저장된 `entry.message.role` | 의미 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `user` | 사용자 / 도구 피드백 턴. |
| `developer` | 개발자 역할 지침 턴. |
| `assistant` | 모델 턴. 도구 호출은 `content` 안의 `{ type: "toolCall" }` 블록입니다. |
| `toolResult` | 도구 하나의 결과. `tool_result`가 **아닙니다**. `toolCallId` / `toolName`이 있습니다. |
| `bashExecution` | 독립적인 `!` bash 실행. |
| `pythonExecution` | 독립적인 Python 실행. |
| `hookMessage` | 레거시 훅 주입 메시지(마이그레이션 전용. `custom` 사용). |
| `fileMention` | 인라인으로 삽입된 `@file` 언급 콘텐츠. |

복원된 에이전트 컨텍스트의 세 역할은 확장 기능에 노출되는 분기 이력의 전용 원본 항목에서 만들어집니다. `getBranch()`는 대신 이 원본 항목을 노출합니다.

| 저장된 `entry.type` | 복원된 `message.role` | 의미 |
| ---------------------- | ---------------------------- | ------------------------------------- |
| `branch_summary` | `branchSummary` | 버린 분기의 요약. |
| `compaction` | `compactionSummary` | 컨텍스트 압축 요약 턴. |
| `custom_message` | `custom` | `pi.sendMessage`로 보낸 메시지 |

`toolCall`은 역할이 아니라 **콘텐츠 블록 타입**입니다. 도구 호출은 `assistant` 메시지의 `content` 배열 안에 있는 블록이며, 짝이 되는 결과는 `role: "toolResult"`인 별도 항목입니다. 이 값들은 **철자 그대로** 비교하세요. snake_case 상수와 비교하거나 먼저 `role`을 소문자로 바꾸는(`"toolResult"` → `"toolresult"`) 필터는 어떤 분기에도 일치하지 않으며 오류나 로그 없이 항목을 **조용히 버립니다**. 그러면 `role`을 기준으로 세션을 캡처할 때 사용자/어시스턴트 텍스트는 전달되지만 모든 도구 결과가 누락됩니다.

```ts
for (const entry of ctx.sessionManager.getBranch()) {
  switch (entry.type) {
    case "custom_message":
      // pi.sendMessage payload: entry.customType, entry.content
      break;
    case "branch_summary":
      // reconstructed as role: "branchSummary"
      break;
    case "compaction":
      // reconstructed as role: "compactionSummary"
      break;
    case "message":
      switch (entry.message.role) {
        case "assistant":
          // tool calls: entry.message.content.filter(b => b.type === "toolCall")
          break;
        case "toolResult":
          // entry.message.toolCallId, entry.message.content
          break;
      }
      break;
  }
}
```

<a id="rendering-extension-points"></a>
## 렌더링 확장 지점

<a id="composer-shape-renderer"></a>
## 입력창 모양 렌더러

`registerComposerShape`는 **외형 → 입력창 모양**에 확장 기능 소유의 입력 편집기 레이아웃을 추가합니다. 확장 기능 팩터리에서 등록하세요. 실제 편집기와 설정 미리보기에서 이 렌더러를 사용합니다.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

const dockStyle: ComposerStyle = {
  id: "acme-dock",
  sideBorders: false,
  verticalChrome: 1,
  statusAttachment: "none",
  bottomBar: "full",
  bottomBarGap: true,
  defaultPromptGutter: "❯ ",

  defaultPaddingX: () => 0,
  sideChromeWidth: () => 0,
  renderTop: ({ box, width, borderColor }) =>
    borderColor(box.horizontal.repeat(width)),
  renderRow: ({ gutter, text, pad }) => [gutter + text + pad],
  renderBottom: () => undefined,
};

export default function (pi: ExtensionAPI) {
  pi.registerComposerShape({
    label: "Acme Dock",
    description: "Prompt below a single rule",
    style: dockStyle,
  });
}
```

`ComposerShapeDefinition`의 구성:

- `label`: 필수 선택기 표시 이름.
- `description`: 선택적 선택기 세부 설명.
- `style`: 완전한 `ComposerStyle` 렌더링 계약. `style.id`는 저장되는 `composer.shape` 값이기도 합니다.

`style.id`는 패키지 이름으로 한정하고, 비어 있지 않으며 앞뒤 공백이 없어야 합니다. 기본 제공 ID(`box`, `band`, `claude`, `pi`, `borderless`, `rule`, `field`, `rail`)는 교체할 수 없습니다. 확장 기능끼리 충돌하면 나중 등록이 우선합니다. ID가 설정된 상태에서 확장 기능을 사용할 수 없으면 편집기는 `box`로 대체합니다.

<a id="composerstyle-layout-metadata"></a>
### `ComposerStyle` 레이아웃 메타데이터

- `filledSurface`: 스타일이 `surfaceColor`로 자체 행 전경을 칠하는지 나타냅니다. 생략하면 확장 기능 소유 ID는 채우기 동작을 유지합니다. 호스트의 테마 텍스트 색을 받으려면 `false`로 설정하세요.
- `sideBorders`: 콘텐츠 행이 측면 장식을 소유하는지 나타냅니다. 단순 설명이 아니라 커서 여유 공간, IME 레이아웃, 스크롤바 동작을 제어합니다.
- `verticalChrome`: 편집기 높이 계산에 사용하는 고정 상단/하단 장식 행의 정확한 수(`0`, `1`, `2`).
- `statusAttachment`: `"top-border"`는 내장 상태 게이지를 받으며, `"top-band"`는 입력 위에 밀착된 완만한 끝 모양의 상태 띠를 사용합니다. `"top-rule-chip"`은 구분선에 붙일 오른쪽 상태 그룹을 받으며, `"none"`은 편집기 장식에서 상태를 분리합니다.
- `bottomBar`: 편집기 아래 독립적인 상태 콘텐츠. `"none"`, `"left"`, `"full"`.
- `bottomBarGap`: 편집기와 독립적인 하단 상태 표시줄 사이에 빈 행을 둘지 여부.
- `defaultPromptGutter`: 호스트가 재정의를 제공하지 않을 때 사용할 프롬프트 텍스트.
- `defaultPaddingX(themePaddingX)`: 이 스타일에서 선택한 가로 여백.
- `sideChromeWidth(paddingX)`: 여백과 테두리/레일 문자를 포함해 콘텐츠 행의 **각** 측면에서 사용하는 표시 셀 수.

`renderTop`과 `renderBottom`은 스타일이 적용된 터미널 행 하나 또는 `undefined`를 반환합니다. `renderRow`는 스타일이 적용된 행 하나 이상을 반환합니다. 일반 렌더링 행은 정확히 `ctx.width`개의 표시 셀을 차지해야 하며 ANSI 이스케이프 시퀀스의 너비는 0입니다. 제공된 `gutter`, `text`, `pad`를 다시 줄바꿈하거나 자르지 말고 보존하세요.

<a id="renderer-context"></a>
### 렌더러 컨텍스트

모든 렌더링 메서드는 `width`, `paddingX`, 테마의 `box` 문자, 다음 세 스타일 함수를 받습니다.

- `borderColor(text)`: 일반 프레임/구분선 색.
- `accentColor(text)`: 모양을 정의하는 레일이나 끝부분에 사용하는 안정적인 강조색.
- `surfaceColor(text)`: 장식된 입력에서 중첩 SGR 초기화 후에도 유지되는 입력창 배경 채우기.

`topBorder`가 있으면 표시 `width`와 함께 이미 스타일이 적용된 상태 콘텐츠입니다. 상단 렌더러가 배치를 책임지며 최종 행 너비를 `ctx.width`로 유지해야 합니다.

`renderRow`는 다음 값도 받습니다.

- `gutter`, `text`, `pad`: 미리 렌더링된 콘텐츠 조각.
- `isLastRow`: 마지막으로 보이는 입력 행인지 여부.
- `cursorOverflow`: 줄 끝 커서가 오른쪽 장식에서 사용하는 셀 수.
- `imeSafeCursorTail`: 터미널 자체 IME 조합 문자열이 장식을 밀지 않도록 커서 뒤 오른쪽 셀을 생략합니다.
- `scrollbarThumb`: 이 행이 편집기 스크롤바 손잡이와 겹치는지 여부.

`packages/tui/src/components/composer/`의 기본 제공 구현은 프레임, 구분선, 배경 채우기, IME 안전 레이아웃의 참고 구현입니다.

<a id="custom-message-renderer"></a>
## 사용자 정의 메시지 렌더러

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return pi-tui Component
});
```

대화형 렌더링에서 사용자 정의 메시지를 표시할 때 사용합니다.

<a id="assistant-thinking-renderer"></a>
## 어시스턴트 추론 렌더러

```ts
import { Container, Text } from "@oh-my-pi/pi-tui";

pi.registerAssistantThinkingRenderer((context, theme) => {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0),
  );
  return container;
});
```

대화형 렌더링에서 표시 중인 각 어시스턴트 추론 블록 아래에 표시 전용 보조 UI를 추가합니다. 렌더러는 이미 보이는 추론 텍스트, 콘텐츠/추론 인덱스, 테마, 비동기 렌더러용 `requestRender()` 콜백을 받습니다. 컴포넌트를 반환한 모든 등록 렌더러를 등록 순서로 추가합니다. 렌더러는 메시지를 변경하면 안 됩니다. 원래 추론 블록이 제공업체/세션의 기준 데이터로 유지됩니다.

<a id="tool-callresult-renderer"></a>
## 도구 호출/결과 렌더러

TUI에서 사용자 정의 도구를 시각화하려면 `registerTool` 정의에 `renderCall` / `renderResult`를 제공하세요.

<a id="constraints-and-pitfalls"></a>
## 제약과 주의점

- 확장 기능을 불러오는 동안 세션 동작은 사용할 수 없습니다. 등록 메서드, `getFlag`, `exec`는 사용할 수 있습니다.
- `tool_call` 오류와 시간 초과는 실행을 차단합니다(실패 시 차단). 제한 시간은 `extensionHandlers.toolCallTimeoutMs`(기본 30,000ms)이며 확장 기능 UI 대기 중에는 계산을 멈춥니다.
- 디스패치되는 대부분의 핸들러에는 30초 제한이 있습니다. `session_shutdown` 핸들러는 2초 제한으로 동시에 실행합니다. 시간 초과는 대기를 중지하고 핸들러 UI를 취소하지만 임의의 확장 기능 부작용을 되돌릴 수는 없습니다.
- 기본 제공 명령과 이름이 충돌하면 진단과 함께 건너뜁니다.
- 예약 단축키는 무시합니다(`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).
- `ctx.reload()`를 현재 명령 핸들러 프레임의 마지막 동작으로 취급하세요.
- 모듈 전역 변수는 부모/자식 바인딩이 공유합니다. 세션별 상태는 팩터리 클로저나 영구 저장된 세션 항목에 두세요.

<a id="extensions-vs-hooks-vs-custom-tools"></a>
## 확장 기능, 훅, 사용자 정의 도구 비교

목적에 맞는 기능을 사용하세요.

- **확장 기능** (`src/extensibility/extensions/*`): 통합 시스템(이벤트 + 도구 + 명령 + 렌더러 + 제공업체 등록).
- **훅** (`src/extensibility/hooks/*`): 레거시 `HookAPI` 이벤트 API. 훅 파일은 확장 기능 실행기를 통해 불러오므로 확장 기능의 의미 규칙으로 실행됩니다([훅](./hooks.md) 참고).
- **사용자 정의 도구** (`src/extensibility/custom-tools/*`): 도구 중심 모듈. 확장 기능과 함께 불러오면 어댑터를 통해 연결되며 확장 기능 가로채기 래퍼도 계속 거칩니다.

정책, 도구, 명령 UX, 렌더링을 한 패키지에서 함께 관리해야 한다면 확장 기능을 사용하세요.
