# 사용자 정의 도구

사용자 정의 도구는 기본 제공 도구와 같은 도구 실행 파이프라인에 연결되는, 모델이 호출할 수 있는 함수입니다.

사용자 정의 도구는 팩터리를 내보내는 TypeScript/JavaScript 모듈입니다. 팩터리는 호스트 API(`CustomToolAPI`)를 받아 도구 하나 또는 도구 배열을 반환합니다.

## 사용자 정의 도구와 다른 기능의 차이

- **사용자 정의 도구**: 모델이 턴 중에 호출할 수 있습니다(`execute` + 매개변수 스키마).
- **확장 기능**: 도구를 등록하고 이벤트를 가로채거나 수정할 수 있는 수명 주기/이벤트 프레임워크입니다.
- **훅**: 확장 기능 실행기를 통해 로드되는 기존 이벤트 기반 가로채기 API입니다.
- **스킬**: 실행 가능한 도구 코드가 아닌 정적 지침/컨텍스트 패키지입니다.

모델이 코드를 직접 호출해야 한다면 사용자 정의 도구를 사용하세요.

## 현재 코드의 통합 경로

현재 두 가지 통합 방식이 사용됩니다.

1. **SDK에서 제공하는 사용자 정의 도구** (`options.customTools`)
   - 확장 기능 도구 정의로 변환되어 세션 레지스트리에 연결됩니다.
   - 제한 없는 세션에서는 최종 적용되는 정의가 숨김/기본 비활성 상태가 아니면 자동으로 활성화됩니다.
   - 제한된 세션(`restrictToolNames: true`)에서는 `allowRestrictedCustomTools: true`가 아니면 SDK 제공 사용자 정의 도구가 제외됩니다. 명시적으로 허용된 도구도 이름이 `toolNames`에 있어야 활성화됩니다.

2. **파일시스템에서 검색한 모듈** (`discoverCustomToolPaths` / `loadCustomTools`)
   - 제한 없는 세션 초기화는 설정/제공업체/플러그인 도구 모듈을 검색하고 로드한 다음, 생성된 확장 기능을 통해 등록합니다.
   - 이 함수들과 통합 헬퍼 `discoverAndLoadCustomTools`는 `packages/coding-agent/src/extensibility/custom-tools/loader.ts`의 라이브러리 API이기도 합니다.
   - 하위 에이전트는 `preloadedCustomToolPaths`를 재사용하여 검색을 건너뛸 수 있지만, 팩터리는 각 세션 고유의 API에 다시 바인딩됩니다.

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + registered custom definitions)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## 검색 위치 (로더 API)

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames, pushPendingAction?, agentDir?)`는 다음을 병합합니다.

1. 다음을 포함하는 기능 제공업체(`toolCapability`):
   - 기본 OMP 설정 (`<agentDir>/tools`, 기본값 `~/.omp/agent/tools`; `.omp/tools`)
   - Claude 설정 (`<Claude config dir>/tools`, 기본값 `~/.claude/tools`; `.claude/tools`)
   - Codex 설정 (`~/.codex/tools`, `.codex/tools`)
   - OMP 패키지 루트와 Claude 마켓플레이스 플러그인
2. 활성화된 설치 플러그인 매니페스트 (플러그인 로더를 통한 사용자 `~/.omp/plugins` 및 활성 프로젝트 `.omp/plugins` 레지스트리. 프로젝트 패키지가 이름이 같은 사용자 패키지보다 우선합니다)
3. 로더에 전달한 명시적 설정 경로

### 주요 동작

- 외부 사용자 디렉터리는 `enabledProviders`(예: `"claude"` 또는 `"codex"`)로 명시적으로 허용해야 합니다. 프로젝트 디렉터리는 제공업체 전체를 비활성화하지 않는 한 검색됩니다. `CLAUDE_CONFIG_DIR`도 Claude 사용자 소스를 활성화합니다.
- 기본 사용자 검색은 활성 프로필과 전달된 `agentDir`를 따릅니다.
- 검색 과정에서 해석된 경로의 중복을 제거합니다. `loadCustomTools` 자체는 전달된 경로 목록을 로드합니다.
- 파일시스템 도구 이름이 전달된 기본 제공 도구 이름이나 이미 로드된 사용자 정의 도구와 충돌하면 거부됩니다. 설정 경로는 뒤에 추가되며 이름 재정의로 사용되지 않습니다.
- 잘못된 팩터리 결과는 배열 항목별로 보고하므로 같은 팩터리의 유효한 항목은 로드할 수 있습니다. 가져오기/팩터리 실패는 이후 모듈을 중단하지 않고 `errors`에 수집됩니다.
- 자동 도구 디렉터리 검색은 `.ts`와 `.js` 모듈을 찾습니다. 기본 OMP 검색은 바로 아래 하위 디렉터리의 `index.ts`도 확인합니다. 실행 파일 검색은 `.d.ts`를 제외하고, 도구 이름 중복 제거 전에 메타데이터와 스크립트를 걸러냅니다. `.md`, `.json` 같은 선언적 메타데이터는 기능 소비자가 계속 사용할 수 있지만 실행 가능한 도구로 로드하지는 않습니다.
- `.mjs`와 `.cjs` 모듈은 명시적으로 설정한 경로나 선언된 플러그인 도구 항목으로 로드할 수 있지만 위 도구 디렉터리 검색에서 자동으로 찾지는 않습니다. 명시적으로 설정한 `.md` 또는 `.json` 경로도 로드 오류가 발생합니다.
- 상대 설정 경로는 `cwd` 기준으로 해석하고 `~`는 확장합니다.

## 모듈 계약

사용자 정의 도구 모듈은 함수를 내보내야 합니다(기본 내보내기 권장).

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional(),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

`@oh-my-pi/*` 호스트 패키지(기존 `@mariozechner/*` / `@earendil-works/*` 범위 포함)의 값 가져오기는 컴파일된 바이너리에서도 omp 자체가 실행하는 복사본으로 해석됩니다. 도구의 다른 의존성은 도구 자체 위치에서 해석합니다. 도구 모듈과 상대 가져오기는 프로세스당 한 번 평가되고, 각 세션에서 팩터리를 다시 호출합니다.

매개변수 스키마는 Zod 호환 omptype 빌더(`pi.zod`), 기본 omptype 빌더(`pi.arktype`), 기존 버전 호환 TypeBox 심(`pi.typebox`)을 사용할 수 있으며 공유 검증/전송 파이프라인을 거칩니다.

팩터리 반환 타입:

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## 팩터리에 전달되는 API (`CustomToolAPI`)

`types.ts`와 `loader.ts` 기준:

- `cwd`: 호스트 작업 디렉터리
- `exec(command, args, options?)`: 프로세스 실행 헬퍼
- `ui`: UI 컨텍스트 (헤드리스 모드에서는 아무 동작도 하지 않을 수 있음)
- `hasUI`: 비대화형 흐름에서는 `false`
- `logger`: 공유 파일 로거
- `arktype`: 주입된 omptype `type(...)` 빌더
- `zod`: 주입된 Zod 호환 omptype 빌더
- `typebox`: 기존 TypeBox 스타일 스키마용 호환 심
- `pi`: 주입된 `@oh-my-pi/pi-coding-agent` 내보내기
- `pushPendingAction(action)`: `xd://resolve` 또는 `xd://reject`에 일반 텍스트 사유를 쓰면 확정되는 미리보기 작업을 준비합니다

로더는 아무 동작도 하지 않는 UI 컨텍스트와 `hasUI: false`로 시작합니다. 라이브러리 호스트는
실제 UI가 준비되면 반환된 `setUIContext(...)`를 호출할 수 있습니다. 일반 SDK의
파일시스템 도구 초기화는 현재 이 설정 함수를 호출하지 않으므로, 세션에 TUI가 있어도
팩터리 API의 UI는 아무 동작도 하지 않습니다. 런타임이 대기 작업 저장소를
제공하지 않았다면 `pushPendingAction` 호출 시
`Pending action store unavailable for custom tools in this runtime.` 오류가 발생합니다.

## 실행 계약과 타입

`CustomTool.execute` 시그니처:

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params`는 omptype 또는 TypeBox 스키마에서 `Static<TParams>`를 통해 정적으로 타입이 지정됩니다.
- 런타임 인수 검증은 실행 전에 에이전트 루프에서 수행합니다.
- `onUpdate`는 UI 스트리밍용 부분 결과를 내보냅니다.
- `ctx`에는 `sessionManager`, `modelRegistry`, 현재 `model`, `isIdle()`, `hasQueuedMessages()`, `abort()`, `localProtocolOptions`가 포함됩니다. 공개 컨텍스트 타입은 `settings`, `fetch`, `autoApprove`도 허용하지만 일반 SDK 변환은 이 세 필드를 채우지 않습니다.
- `signal`은 취소를 전달하며 `undefined`일 수 있습니다.

세션 초기화 브리지는 사용자 정의 도구를 확장 기능 `ToolDefinition`으로 변환하고 올바른 인수 순서로 호출을 전달합니다. 사용자 정의 도구를 에이전트 도구 인터페이스에 직접 연결하는 라이브러리 소비자는 계속 `CustomToolAdapter`를 사용할 수 있습니다.

도구 정의는 `strict`, `hidden`, `loadMode`, `deferrable`, `readsSkillUris`, `mcpServerName`, `mcpToolName`, `legacyName`, `approval`도 선언할 수 있습니다. `loadMode`를 생략하면 사용자 정의 도구 이름의 기본값은 `"discoverable"`입니다. 단, 정식 필수 기본 제공 이름(`read`, `write`, `bash`, `edit`, `glob`, `find`, `eval`, `task`, `wait`, `learn`, `manage_skill`, `context_notes`, `new_context`)은 래퍼나 재등록으로 등급이 낮아지지 않도록 `"essential"`이 기본값입니다. 명시적 `loadMode`가 항상 우선합니다. 다른 도구도 최상위에 유지하려면 `"essential"`을 사용하세요.

공개 `CustomTool` 타입은 `formatApprovalDetails`, `describeCall`, `describeResult`도 선언하지만 SDK/검색 변환은 이 콜백을 등록된 정의에 전달하지 않습니다. `CustomToolAdapter`를 직접 사용하는 소비자에게는 유지됩니다.

## 모델에 도구를 노출하는 방식

- 세션 초기화는 포함된 SDK 제공 도구와 검색된 사용자 정의 도구를 확장 기능 도구 정의로 래핑합니다. 라이브러리 소비자는 대신 `CustomToolAdapter`를 직접 사용할 수 있습니다.
- 도구는 이름으로 세션 도구 레지스트리에 삽입됩니다.
- 제한 없는 SDK 초기화는 레지스트리에서 최종 선택된 정의가 숨김/기본 비활성 상태가 아니면 사용자 정의 도구와 확장 기능 등록 도구를 자동 활성화합니다. 명시적 `toolNames`로 숨겨진 도구를 활성화할 수 있습니다. 제한된 세션은 `allowRestrictedCustomTools: true`가 아니면 SDK 제공 사용자 정의 도구를 제외하며, 허용한 도구도 이름이 `toolNames`에 있어야 노출합니다. 주변 파일시스템 도구 검색은 건너뜁니다.
- `tools.xdev`가 활성화되고 `read`/`write` 전송을 사용할 수 있으면, 활성화된 검색 가능 도구는 최상위 함수로 알리는 대신 `xd://` 아래에 마운트됩니다. 명시적으로 요청한 도구와 필수 도구는 최상위에 유지됩니다.
- CLI `--tools`는 등록된 사용자 정의 도구를 포함하여 완전히 검색된 세션 레지스트리를 기준으로 검증합니다. 알 수 없는 이름과 사용할 수 없는 기본 제공 도구는 서로 다른 오류를 발생시킵니다.

## 렌더링 훅

선택적 렌더링 훅:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

일반 SDK 및 파일시스템 검색 경로는 사용자 정의 도구를 확장 기능으로 래핑합니다. 이 경로에서 `renderResult`는 위 세 인수만 받으며 브리지는 원래 도구 인수를 전달하지 않습니다. 공개 `CustomTool` 타입은 `CustomToolAdapter`를 직접 사용하는 소비자를 위해 선택적인 네 번째 `args` 매개변수를 유지합니다.

확장 기능 어댑터 경로에서는 `renderCall`의 `options` 인수가 `Theme` API도 제공하므로 업스트림 pi 렌더러가 두 번째 인수를 스타일 지정에 사용할 수 있습니다. 세 번째 인수는 업스트림 pi의 컨텍스트 객체가 아니라 계속 테마입니다.

TUI의 런타임 동작:

- 훅이 있으면 도구 출력을 `Box` 컨테이너 안에 렌더링합니다.
- `renderResult`는 `options` 인수로 `{ expanded, isPartial, spinnerFrame? }`를 받습니다.
- 렌더러 오류는 잡아서 로그에 기록하고 UI는 기본 텍스트 렌더링으로 대체합니다.

## 세션/상태 처리

선택적 `onSession(event, ctx)`는 다음을 포함한 세션 수명 주기 이벤트를 받습니다.

- `start`, `switch`, `branch`, `tree`, `shutdown`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`, `todo_reminder`

분기/세션 컨텍스트가 바뀌면 `ctx.sessionManager`로 이력에서 상태를 재구성하세요.

## 실패와 취소 의미

### 동기/비동기 실패

- `execute`에서 예외를 던지거나 Promise가 거부되면 도구 실패로 처리합니다.
- 에이전트 런타임은 실패를 `isError: true`와 오류 텍스트 내용을 가진 도구 결과 메시지로 변환합니다.
- 확장 기능 래퍼를 사용하면 `tool_result` 핸들러가 내용/상세 정보를 추가로 다시 쓰고 오류 상태까지 재정의할 수 있습니다.

### 취소

- 에이전트 중단은 `AbortSignal`을 통해 `execute`로 전파됩니다.
- 협력적 취소를 위해 하위 프로세스 작업에 `signal`을 전달하세요(`pi.exec(..., { signal })`).
- `ctx.abort()`로 도구가 현재 에이전트 작업의 중단을 요청할 수 있습니다.

### onSession 오류

- 일반 세션 통합은 `onSession` 오류를 잡아 경고로 기록합니다. 자체 수명 주기 전달을 사용하는 라이브러리 소비자는 직접 오류 처리를 제공해야 합니다.

## 설계 시 고려할 실제 제약

- 도구 이름은 활성 레지스트리 전체에서 고유해야 합니다.
- 렌더러/상태 재구성을 위해 `details`에는 결정적이며 스키마 형태를 따르는 출력을 권장합니다.
- UI를 사용하기 전에 `pi.hasUI`를 확인하세요.
- 도구 디렉터리의 `.md`/`.json`은 실행 가능한 모듈이 아닌 메타데이터로 취급하세요.
