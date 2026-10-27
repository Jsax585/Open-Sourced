---
name: authoring-extensions
description: 새 omp 확장을 만들 때 사용합니다. ExtensionAPI, 팩터리 시그니처, 도구/명령/이벤트 등록, 로컬 개발 테스트를 다룹니다.
---

# 확장 작성하기

확장은 `omp`에 기능을 추가하는 기본 방법입니다. 하나의 확장 모듈에서 LLM이 호출할 도구, 사용자가 실행할 슬래시 명령, 세션 수명 주기 전반에 걸쳐 실행되는 이벤트 핸들러를 모두 하나의 TypeScript 파일로 등록할 수 있습니다. 기본 팩터리는 동기적으로 초기화하거나 프라미스를 반환할 수 있습니다.

## 최소 구성의 확장

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

이것만으로 작동하는 확장이 완성됩니다. `~/.omp/agent/extensions/hello.ts`에 넣고 omp를 다시 시작하면 알림이 표시됩니다.

## 전체 예제

다음 확장은 슬래시 명령, 도구, 세션 시작 훅을 등록합니다.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  // Runs once when the session loads
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  pi.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      pi.sendMessage(
        {
          customType: "greeting",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## 검색 경로

omp는 다음 소스에서 확장 모듈을 불러옵니다.

1. 기능 검색 시스템으로 찾은 기본 `.omp` 위치:
   - 검색 경계 안에 있는 프로젝트/상위 디렉터리의 `.omp/extensions/` 디렉터리
   - `~/.omp/agent/extensions/`
   - `.omp/settings.json#extensions` 또는 `~/.omp/agent/settings.json#extensions`에 나열된 레거시 확장 경로
2. 검색된 JavaScript/TypeScript 훅 팩터리(`hooks/pre/`, `hooks/post/`). 확장 실행기를 통해 연결됩니다.
3. `~/.omp/plugins/node_modules` 또는 프로젝트 플러그인 루트 아래에 설치되어 활성화된 플러그인. npm, 마켓플레이스, `omp plugin link` 설치를 포함하며 `omp.extensions`/`pi.extensions` 매니페스트를 통해 불러옵니다.
4. CLI(`omp --extension ./my-ext.ts`, 단축형 `-e`; `--hook`도 별칭으로 처리)와 구성의 `extensions:` 설정으로 명시한 경로.

런타임은 해석된 절대 경로를 기준으로 중복을 제거하며, 먼저 발견한 항목이 우선합니다.

`--no-extensions`는 주변 경로의 자동 검색을 비활성화하지만 명시적인 `--extension`/`--hook` 경로와 거기에 포함된 기능은 허용합니다. 모듈 파일만 정확히 허용하려면 `--trusted-extension /absolute/path/to/module.ts`를 반복해서 지정하세요. 경로는 존재하는 파일이어야 하며, 주변 확장 자동 검색은 비활성화되고 해당 파일은 인접 기능을 검색하기 위한 패키지 루트로 취급되지 않습니다. `--extension`, `-e`, `--hook`과 함께 사용할 수 없으며, 신뢰된 모듈을 불러오다 오류가 나면 시작이 중단됩니다. 이는 검색 제어 기능이지 확장 코드를 격리하는 샌드박스가 아닙니다.

사용자 디렉터리는 활성 프로필의 에이전트 디렉터리입니다. 기본값은 `~/.omp/agent`이며, 기본 레이아웃에서 `omp --profile <name>`은 `~/.omp/profiles/<name>/agent`를 사용합니다. `PI_CODING_AGENT_DIR`는 기본 프로필의 에이전트 디렉터리를 재정의하지만, 이름 있는 프로필은 별도의 디렉터리를 사용합니다. 초기화된 XDG 루트에 따라 이 위치가 달라질 수 있습니다.

경로가 디렉터리를 가리키면 omp는 다음 순서로 진입점을 찾습니다.

1. `omp.extensions`(또는 레거시 `pi.extensions`) 필드가 있는 `package.json`
2. `index.ts`
3. `index.js`

`extensions/` 디렉터리를 검색할 때 omp는 바로 아래의 `*.ts`/`*.js` 파일과 `index.ts`, `index.js` 또는 매니페스트가 있는 한 단계 아래의 하위 디렉터리도 불러옵니다.

확장 패키지는 인접 기능 디렉터리도 포함할 수 있습니다. `extensions:` 또는 `--extension`/`-e`로 패키지를 불러오면 `omp-plugins` 공급자가 패키지의 `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, `.mcp.json`을 검색합니다.

## package.json 매니페스트

확장을 설치 가능한 플러그인으로 패키징하려면 `package.json`에 `omp` 필드를 추가하세요.

```json
{
  "name": "my-omp-extension",
  "omp": {
    "extensions": ["./src/main.ts"]
  }
}
```

하위 호환성을 위해 레거시 `pi` 키도 허용합니다.

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

여러 진입점을 지원합니다.

```json
{
  "omp": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

설치된 플러그인의 매니페스트 항목은 `.ts`, `.js`, `.mjs`, `.cjs`일 수 있습니다. 항목이 디렉터리를 지정하면 `index.ts`, `index.js`, `index.mjs`, `index.cjs`를 찾습니다. 기본/구성된 확장 디렉터리의 자동 검색은 여전히 `.ts`와 `.js`로 제한됩니다.

## 명령 등록하기

```ts
pi.registerCommand("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext`의 세션 제어 메서드:

| 메서드 | 동작 |
|---|---|
| `waitForIdle()` | 에이전트의 스트리밍이 끝날 때까지 대기 |
| `newSession(opts?)` | 새 세션 열기 |
| `switchSession(path)` | 기존 세션 파일로 전환 |
| `branch(entryId)` | 특정 기록 항목에서 분기 |
| `navigateTree(id, opts?)` | 세션 트리의 다른 지점으로 이동 |
| `reload()` | 세션 런타임 다시 불러오기 |
| `compact(instructionsOrOptions?)` | 현재 컨텍스트 압축. 기본 `ExtensionContext`에서도 사용 가능 |

세션 전환, 분기, 트리 탐색, 다시 불러오기는 명령 컨텍스트에서 수행하세요. `compact()`는 지시 문자열 또는 `CompactOptions`를 받습니다.

## 도구 등록하기

도구는 LLM이 호출합니다. 매개변수 정의에는 주입된
Zod 호환 omptype 빌더를 사용할 수 있습니다. `pi.arktype`과 레거시 호환
`pi.typebox`도 사용할 수 있습니다.

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).optional().describe("Max results"),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: { query: params.query, count: 0 } };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: { query: params.query, count: 0 } });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

도구 정의에는 `loadMode: "essential" | "discoverable"`(기본값 `"discoverable"`), `approval: "read" | "write" | "exec"`(기본값 `"exec"`), 공급자의 구조화 출력 문법 동작을 제어하는 `strict`도 설정할 수 있습니다. 스킬 지침 URL을 읽을 수 있는 도구에만 `readsSkillUris: true`를 설정하세요. 이 기능을 통해 시스템 프롬프트가 검색된 스킬을 노출합니다. `hidden`은 명시적인 도구 선택을 요구하며, `defaultInactive`는 활성화를 확장의 `setActiveTools()`에 맡깁니다.

## 이벤트 구독하기

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName !== "bash") return;

  const command = String((event.input as { command?: unknown }).command ?? "");
  if (command.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

pi.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});

pi.on("session_stop", async (event) => {
  if (event.stop_hook_active) return;
  return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

전체 이벤트 목록은 [확장 작성 가이드](../extensions.md)를 참고하세요.

## 확장과 훅 — 언제 무엇을 사용할까

| 필요 사항 | 선택 |
|---|---|
| 하나의 모듈에 도구 + 명령 + 이벤트 구현 | **확장** (`ExtensionAPI`) |
| 순수 이벤트 가로채기(정책, 비밀 정보 가리기) | **확장** 또는 **훅** (둘 다 가능하지만 확장 권장) |
| 기존 레거시 훅 모듈 사용 | **훅** (`@oh-my-pi/pi-coding-agent/extensibility/hooks`의 `HookAPI`) |
| 공급자, 단축키, CLI 플래그 등록 | **확장만 가능** |
| 마켓플레이스 플러그인으로 배포 | **확장** (`package.json` 매니페스트 사용) |

새로 작성할 때는 `ExtensionAPI`를 사용하세요. 일반 세션에서 검색된 JS/TS 훅 팩터리는 이 API로 불러오며, 독립형 `HookRunner`는 레거시 SDK 사용자를 위해 유지됩니다. 이벤트 이름이 같아도 두 실행기의 결과 연결 동작이 같다는 뜻은 아닙니다.

## 디버깅

omp는 활성 상태 루트의 `logs/` 디렉터리(기본값 `~/.omp/logs/`)에 구조화된 로그를 기록합니다. 디버그 수준은 항상 활성화되며, TUI가 깨지는 것을 막기 위해 콘솔에는 출력하지 않습니다. 기록은 일괄 처리되므로 디버그 로그가 표시되기까지 최대 1초가 걸릴 수 있지만 `warn`, `error` 로그는 즉시 기록됩니다. 각 파일 이름에는 프로세스 ID가 포함되며, 프로세스가 처음 로그를 기록할 때 파일이 생성됩니다. 기본 프로필의 오늘 로그를 실시간으로 확인하여 확장 로드 진단 정보를 볼 수 있습니다.

```
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

확장을 불러오지 못하면 경로와 오류가 로그에 기록됩니다. 불러온 확장은 `pi.logger`로 자체 디버그 로그를 남길 수도 있습니다.

파일을 제거하지 않고 특정 확장 모듈을 이름으로 일시 비활성화하려면 다음과 같이 설정하세요.

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

이름은 파일 확장자를 뺀 부분에서 파생됩니다(`index.ts` 형식의 진입점은 디렉터리 이름 사용). 예: `/path/to/my-ext.ts` → `my-ext`.

## 주요 제약 사항

- **로드 중에는 런타임 동작을 호출하지 마세요.** 세션이 활성화되기 전 모듈 평가 중에 `pi.sendMessage()` 같은 메서드를 동기적으로 호출하면 `ExtensionRuntimeNotInitializedError`가 발생합니다. 로드 중에는 핸들러/도구/명령을 등록하고, 런타임 동작은 이벤트 핸들러, 도구, 명령 안에서만 수행하세요.
- **`tool_call` 오류는 차단으로 처리됩니다.** `tool_call` 핸들러가 예외를 던지면 도구가 차단됩니다.
- **직접 예약한 콜백은 격리 없이 같은 프로세스에서 실행됩니다.** 원시 `setInterval`/`setTimeout` 또는 분리된 프라미스의 콜백이 예외를 던지면 핸들러 디스패치의 try/catch를 벗어나 전체 세션이 중단됩니다(`uncaughtException`). 백그라운드 작업에는 `ctx.setInterval` / `ctx.setTimeout`을 사용하세요. 콜백 예외를 처리하고 `session_shutdown` 시 자동으로 정리합니다. 원시 타이머를 사용하려면 직접 `try/catch`와 정리 처리를 추가해야 합니다.
- **명령 이름은 내장 명령과 충돌하면 안 됩니다.** 충돌하는 명령은 진단 로그를 남기고 건너뜁니다.
- **예약된 단축키는 무시됩니다** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).

## 더 읽어보기

- `docs/extensions.md` — 런타임 내부 구조와 전체 API 참조
- `docs/extension-loading.md` — 자세한 경로 해석 규칙
- `docs/hooks.md` — 훅 하위 시스템 내부 구조
- `docs/skills/examples/hello-extension/` — 완전히 작동하는 예제
