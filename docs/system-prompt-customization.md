# 시스템 프롬프트 사용자 지정

코딩 에이전트가 시스템 프롬프트를 조합하는 방식과 `SYSTEM_TEMPLATE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, CLI 플래그로 제어할 수 있는 내용을 설명합니다. 같은 경로나 전체 교체 기능을 제공하는 프로그래밍 API 옵션도 함께 안내합니다.

주요 구현:

- `packages/coding-agent/src/main.ts` (`applyResolvedSystemPromptInputs`)
- `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions`, 프롬프트 구성)
- `packages/coding-agent/src/system-prompt.ts` (`discoverSystemPromptOverride`, `buildSystemPrompt`, `BuildSystemPromptOptions`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (기본 지침 템플릿)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (일반 텍스트 `SYSTEM.md` 템플릿)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (생성되는 `<project-context>` 푸터)

## 블록 구성과 프롬프트 캐싱

제공업체에 전달하는 프롬프트는 순서가 있는 블록 배열입니다. 작업 디렉터리와 무관한 정적 블록이 먼저 나옵니다. 블록 0(기본, 사용자 지정 또는 템플릿 지침 블록)과 eval 프렐류드 안내가 여기에 해당합니다. 작업 디렉터리에서 파생되는 모든 섹션은 `<project-context>`로 시작하는 마지막 푸터 블록에 배치됩니다. 여기에는 워크스테이션 정보, 경로가 포함된 컨텍스트 파일(`<repo-rules>`), `<dir-context>` 포인터, `<workspace-tree>`, `<workspace-roots>`, 활성 중첩 저장소 컨텍스트, 최종 완료 요구사항, 추가 텍스트가 포함됩니다. 작업 하위 에이전트는 푸터 뒤에 실행별 역할/할당 블록을 추가합니다.

Anthropic에서는 첫 `<project-context>`(또는 `<memories>`) 블록 직전의 마지막 블록에 시스템 캐시 중단점이 배치됩니다. 따라서 같은 에이전트가 서로 다른 디렉터리(예: 작업마다 별도의 git 워크트리)에서 실행한 세션과 하위 에이전트가 정적 프롬프트를 캐시된 접두부로 공유합니다. 다른 제공업체에도 동일한 순서의 블록이 전달됩니다.

## 입력과 우선순위

| 입력 | 출처 | 효과 |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--system-prompt-template <path>` | CLI | `<path>`를 반드시 Handlebars 소스로 읽고 번들 기본 지침 블록을 교체합니다. 사용자 지정 프롬프트의 최우선 입력입니다. |
| `--system-prompt <text-or-file>` | CLI | 기존 일반 텍스트 사용자 지정 경로입니다. 사용자 지정 프롬프트의 최우선 입력이며 템플릿 플래그와 함께 사용할 수 없습니다. |
| `SYSTEM_TEMPLATE.md` | 검색된 설정 파일 | 원시 Handlebars 소스입니다. 명시적 재정의와 검색된 `SYSTEM.md`가 모두 없을 때만 사용합니다. |
| `SYSTEM.md` | 검색된 설정 파일 | 기존 일반 텍스트 사용자 지정 경로입니다. 명시적 재정의가 없을 때만 사용합니다. |
| `--append-system-prompt <text-or-file>` | CLI | 렌더링된 프롬프트에 일반 텍스트를 추가합니다. 추가 텍스트의 최우선 입력입니다. |
| `APPEND_SYSTEM.md` | 검색된 설정 파일 | 기존 일반 텍스트 추가 경로이며 추가 플래그가 없을 때 사용합니다. |

**CLI 우선순위:** 명시적인 `--system-prompt` 또는 `--system-prompt-template` 플래그가 검색된 `SYSTEM_TEMPLATE.md`와 `SYSTEM.md`보다 우선합니다. 명시적인 `--append-system-prompt`는 검색된 `APPEND_SYSTEM.md`보다 우선합니다. 두 사용자 지정 프롬프트 플래그는 상호 배타적이며 함께 지정하면 명확한 오류가 발생합니다. 명시적으로 지정한 빈 `--system-prompt` 리터럴도 명시적 입력으로 취급하여 사용자 지정 프롬프트 검색을 억제합니다.

프로그래밍 API 옵션은 CLI 플래그와 별도의 계약을 사용합니다. [프로그래밍 API 옵션](#프로그래밍-api-옵션)을 참고하세요.

이 빈 리터럴은 검색된 `SYSTEM.md`와 `SYSTEM_TEMPLATE.md`를 억제하지만 OMP가 생성하는 지침을 비활성화하지는 않습니다. 이를 비활성화하는 것은 프로그래밍 API의 전체 교체 옵션인 `CreateAgentSessionOptions.systemPrompt`뿐입니다.

명시적인 사용자 지정 소스가 없으면 프로젝트를 먼저 검색하고 사용자 수준을 검색합니다. 같은 범위에서는 리터럴이 템플릿보다 우선합니다. 프로젝트 `SYSTEM.md`, 프로젝트 `SYSTEM_TEMPLATE.md`, 사용자 `SYSTEM.md`, 사용자 `SYSTEM_TEMPLATE.md` 순입니다. `SYSTEM.md`는 오랫동안 사용된 재정의 방식이므로 작성자가 템플릿을 사용하려고 의도적으로 제거하기 전까지 기존 리터럴이 계속 동작합니다. 두 파일명은 같은 기능 제공업체를 통해 확인하므로 상위 디렉터리 탐색(중첩 cwd에서 저장소 루트 `.omp` 검색)과 `.agent` / `.agents` 디렉터리가 리터럴과 템플릿에 동일하게 적용됩니다. `.claude`, `.codex`, `.gemini` 프로젝트 기준 경로는 실행 시 cwd에서 확인합니다. 다른 도구의 사용자 기준 경로는 `enabledProviders`로 명시적으로 활성화해야 합니다. `CLAUDE_CONFIG_DIR`도 Claude 사용자 기준 경로를 활성화하고 그 위치를 변경합니다.

네이티브 사용자 경로는 활성 프로필을 따릅니다. `omp --profile work`에서는 `~/.omp/agent`가 `~/.omp/profiles/work/agent`로 바뀝니다. `PI_CONFIG_DIR`는 네이티브 설정 디렉터리 이름을 변경합니다. `SYSTEM.md`와 `SYSTEM_TEMPLATE.md`의 기능 검색은 `getAgentDir()`를 사용하므로 `PI_CODING_AGENT_DIR`를 따릅니다. `APPEND_SYSTEM.md`와 `TITLE_SYSTEM.md`의 공통 설정 기준 경로 조회는 이 변수를 임의의 대체 기준 경로로 사용하지 않습니다. 명시적 CLI 플래그나 프로그래밍 API 옵션은 모든 검색된 파일보다 우선합니다. 공통 설정 디렉터리 계약은 [설정 사용법](./config-usage.md)을 참고하세요.

`--system-prompt-template <path>`는 엄격한 파일 경로입니다. 템플릿이 없거나 읽을 수 없거나 비어 있거나 형식이 잘못되면 오류이며 리터럴 프롬프트로 처리하지 않습니다. 검색된 빈 `SYSTEM_TEMPLATE.md`는 건너뜁니다(검색된 리터럴이 있으면 이미 검색에서 우선합니다). `buildSystemPrompt()`가 직접 검색한 잘못된 템플릿은 경고 후 번들 프롬프트를 렌더링합니다. CLI 검색은 읽은 소스를 명시적 SDK 템플릿으로 전달하므로 검색된 템플릿의 형식이 잘못되면 CLI 시작이 실패합니다. 같은 범위의 리터럴은 항상 검색에서 우선하므로 리터럴 옆의 잘못된 템플릿은 렌더링되지 않습니다. 검색된 템플릿은 기능 검색 중 한 번만 읽으며 이후 런타임 재구성에서는 메모리의 소스를 다시 렌더링합니다.

### 텍스트 또는 파일 확인

기존 일반 텍스트 플래그의 확인 규칙은 유지됩니다. `--system-prompt` 또는 `--append-system-prompt` 값이 한 줄이면 OMP는 먼저 해당 값을 파일 경로로 읽으려고 합니다. 경로가 없거나 경로로 쓰기에 너무 길어 읽기가 실패하면 값을 리터럴로 사용합니다. 줄바꿈이 포함된 값은 파일을 읽지 않고 리터럴로 사용합니다. 그 밖의 파일 읽기 실패는 기록하고 원래 값을 리터럴로 사용합니다. 이 대체 동작은 `--system-prompt-template`에는 적용되지 **않습니다**.

## 일반 `SYSTEM.md`가 교체하는 내용

`SYSTEM.md`가 유일한 원시 시스템 메시지가 되는 것은 아닙니다. CLI는 이를 `CreateAgentSessionOptions.customSystemPrompt`로 저장하고, `buildSystemPrompt`는 기본 `system-prompt.md` 대신 `custom-system-prompt.md`를 렌더링합니다.

일반 사용자 지정 템플릿은 다음 생성 내용을 유지합니다.

- 사용자 지정 텍스트
- 검색된 스킬
- 항상 적용되는 규칙과 규칙집 목록
- 활성화된 경우 비밀정보 마스킹 지침

별도의 `<project-context>` 푸터도 유지되며 워크스테이션 정보, 검색된 컨텍스트 파일, 하위 디렉터리 컨텍스트 포인터, 선택적 작업 공간 정보, 활성 중첩 저장소 컨텍스트, 최종 완료 요구사항, 추가 텍스트를 담습니다. 컴퓨터 도구 안전 지침 같은 선택적 추가 시스템 블록도 해당할 때 유지됩니다. 제공업체가 호출할 수 있는 도구 스키마는 여전히 제공업체 대상 세션이 생성합니다.

사라지는 것은 기본 지침 템플릿에만 있는 내용입니다. 기본 역할/성격 텍스트, 도구 목록과 일반 도구 정책, 내부 URL 목록, 탐색/위임/워크플로 규칙, `xd://` 프로토콜 안내가 여기에 해당합니다. 생성된 스킬과 규칙은 **사라지지 않습니다**. 번들 일반 사용자 지정 템플릿이 이를 명시적으로 렌더링합니다.

따라서 다음과 같이 선택하세요.

- 완전한 기본 프롬프트를 유지하면서 지침을 조금 추가하려면 `APPEND_SYSTEM.md` 또는 `--append-system-prompt`만 사용합니다.
- 번들 일반 사용자 지정 생성 섹션을 유지하면서 기본 지침 템플릿을 교체하려면 `SYSTEM.md` 또는 `--system-prompt`를 사용합니다.
- 일반 사용자 지정 프롬프트에도 기본 도구 정책이나 워크플로가 필요하면 필요한 지침을 직접 복사하고 관리해야 합니다. `system-prompt.md`의 선택적 상속은 지원하지 않습니다.

### 추가 텍스트의 배치

`SYSTEM.md`나 `SYSTEM_TEMPLATE.md`가 없으면 추가 텍스트는 기본 지침 블록과 프로젝트/환경 내용 뒤인 `project-prompt.md` 끝에 렌더링됩니다.

`SYSTEM.md`가 있어도 추가 텍스트는 `project-prompt.md` 끝에 렌더링됩니다. `custom-system-prompt.md`가 사용자 지정 텍스트, 스킬, 규칙을 담고, 컨텍스트 파일과 추가 텍스트를 포함하는 푸터가 그 블록 뒤에 옵니다.

`SYSTEM_TEMPLATE.md`(또는 `--system-prompt-template`)가 있으면 추가 텍스트는 여전히 일반 프로젝트/푸터 경로에서 생성됩니다. 원시 템플릿은 블록 0을 제어하며 추가 텍스트의 암묵적 사본을 받지 않습니다.

OMP가 생성하는 추가 내용(활성화된 메모리/자동 학습 기능 및 MCP 안내)은 사용자가 제공한 추가 텍스트 앞에 결합됩니다.
이 생성 블록은 서버가 제어하며 검증되지 않은 텍스트라고 명시하는 `## MCP Server Instructions`로 끝날 수 있습니다.
생성 블록이 사용자 제공 텍스트보다 앞서면 사용자 텍스트는 별도의 `## User Instructions` 제목 아래 렌더링되므로 서버 소유 섹션의 마지막 문단처럼 보이지 않습니다.
생성 블록 없이 추가 텍스트만 있으면 제목 없이 그대로 출력합니다.

## 세션 유형별 입력

각 세션 유형에 전달되는 자동 입력입니다. 입력은 존재하거나 활성화된 경우에만 적용되며, 성격은 기본 템플릿의 성격 블록을 뜻합니다. 조언자는 메모리 지침과 공통 및 조언자별 지침을 포함하는 전용 프롬프트를 구성합니다. `WATCHDOG.md`의 `@path` 가져오기는 확장됩니다.

| 세션 유형 | `AGENTS.md` | `CLAUDE.md` / `GEMINI.md` | `APPEND_SYSTEM.md` / `--append-system-prompt` | MCP 도구 | MCP 서버 지침 | `WATCHDOG.md` | 성격 |
| ---------------- | ------------- | ------------------------- | --------------------------------------------- | --------- | ----------------------- | ------------- | ----------- |
| 주 세션 | 검색 | 검색 | 예 | 예 | 예 | 아니요 | 설정값 |
| 작업 하위 에이전트 | 상속 안 함 | 상속 | 아니요 | 상속 | 상속 | 아니요 | `none` |
| 조언자/감시자 | 상속 | 상속 | 아니요 | 아니요 | 아니요 | 예 | 없음 |

1. Task 하위 에이전트는 상위 에이전트에서 상속했거나 추가 작업 공간 루트에서 검색한 컨텍스트 파일 중 기본 파일명이 `agents.md`인 파일을 모두 제외합니다(대소문자 구분 없음). 사용자 수준 `~/.omp/agent/AGENTS.md`도 포함됩니다. `@` 가져오기로 불러온 텍스트는 필터링하지 않습니다.
2. 컨텍스트 검색은 디렉터리 깊이마다 사용자 파일 하나와 프로젝트 파일 하나를 선택하며 우선순위가 높은 제공업체가 우선합니다. 다른 도구의 사용자 파일은 `enabledProviders`로 명시적으로 활성화해야 합니다. 독립적인 `CLAUDE.md`를 지원하며 `GEMINI.md`는 사용자 및 프로젝트 `.gemini` 디렉터리에서 읽습니다.
3. 작업 에이전트의 `tools:` 목록은 MCP 도구나 서버 지침을 제거하지 않습니다. 도구는 최상위 또는 `xd://`에서 계속 사용할 수 있습니다. 계획 모드 작업과 제한된 세션의 하위 에이전트는 `restrictToolNames`를 사용하여 둘 다 제거합니다.

## Handlebars 템플릿 경로

`SYSTEM_TEMPLATE.md`와 `--system-prompt-template <path>`는 파일에서 원시 Handlebars 소스를 선택합니다. 프로그래밍 호출자는 대신 `CreateAgentSessionOptions.systemPromptTemplate` 또는 `buildSystemPrompt({ systemPromptTemplate })`로 원시 Handlebars 소스를 전달할 수 있습니다. 이 프로그래밍 옵션은 경로가 아니라 템플릿 자체입니다. 각 경로는 번들 템플릿과 동일한 실시간 데이터 및 등록된 헬퍼를 사용하여 번들 `system-prompt.md` 대신 렌더링됩니다.

블록 0 밖의 생성 블록은 그대로 유지됩니다. `<project-context>` 푸터(생성 컨텍스트, 활성 중첩 저장소 컨텍스트, 추가 내용 포함), 컴퓨터 안전 지침, 제공업체 도구 스키마가 여기에 해당합니다. 원래 번들 템플릿 안에 있는 데이터 기반 섹션은 자동으로 추가되지 않습니다. 템플릿은 `skills`, `rules`, `alwaysApplyRules`, `toolInventory`, `internalUrls`(세션에서 사용 가능한 내부 URL 스킴마다 렌더링된 한 줄), `xdevTools`, `xdevDocs`를 사용할 수 있지만 각각 참조할 때만 출력됩니다. 특히 `{{toolInventory}}`나 `{{xdevDocs}}`를 생략하면 해당 블록 내부 목록도 생략됩니다. 마운트 알림 중복 제거는 렌더링된 출력을 따릅니다. 블록 0에 `xd://` 참조가 있는 템플릿은 목록을 포함한 것으로 취급하고, 없는 템플릿은 그렇지 않습니다.

생성 프로젝트/푸터 경로는 이미 `contextFiles`와 `appendPrompt`를 한 번 렌더링합니다. 의도적으로 중복 사본을 원하지 않는 한 템플릿은 블록 0에서 이 필드를 렌더링하지 않는 것이 좋습니다.

현재 렌더링된 문구를 복사하기보다 실제 세션 설정과 실시간 도구 데이터를 사용하세요. 작업 하위 에이전트 프롬프트를 렌더링할 때 `subagent`는 true입니다. 번들 템플릿은 이를 사용하여 검증 의무를 주 에이전트에 인계하는 지침으로 대체합니다. `eagerTasks`와 `eagerTasksAlways`는 세션 시작 시 저장한 작업 설정을 반영하고, `xdevDocs`, `toolInventory`, `toolRefs`는 프롬프트 재구성 시 마운트된 장치와 도구 상태를 반영합니다. `xdevDocs`는 해당 재구성에 사용한 `tools.xdevDocs` / `tools.xdevInlineDevices` 설정도 반영합니다.

템플릿은 번들 프롬프트와 같은 헬퍼 집합(`if`, `each`, `unless`, `list`, `when`, `has`, `ifAny`, `includes` 및 그 밖의 등록된 헬퍼)을 사용합니다. 사용자 파일을 위한 별도 헬퍼는 생성하지 않습니다. 템플릿에 삽입되는 값은 데이터이지 두 번째 템플릿 처리 대상이 아닙니다. `xdevDocs`, 컨텍스트 파일, 도구 설명 또는 다른 값 안의 Handlebars 형태 텍스트는 재귀적으로 렌더링하지 않습니다.

이 경계 양쪽을 모두 프롬프트 입력으로 취급하세요. 템플릿 파일을 다른 시스템 수준 설정처럼 보호하고, 작업 공간, 확장 기능, MCP, 마운트된 장치 설명을 신뢰할 수 있는 정책으로 취급하기 전에 검토하세요. 동적 xdev 메타데이터는 제삼자 텍스트일 수 있습니다. CLI는 시작할 때 템플릿 파일을 한 번 읽습니다. 프로그래밍 방식의 원시 소스는 이미 메모리에 있습니다. 이후 런타임 프롬프트 재구성은 메모리의 소스를 현재 실시간 데이터와 설정으로 다시 렌더링하지만 변경된 파일을 다시 읽지 않습니다. 파일을 수정한 뒤에는 OMP를 다시 시작하세요.

## 일반 텍스트와 템플릿의 계약

`SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, `--append-system-prompt`는 일반 텍스트로 유지됩니다. 번들 Handlebars 템플릿에 삽입되는 값이며 그 내용을 Handlebars로 재귀 컴파일하지 않습니다.

예를 들어 `SYSTEM.md`에 다음 내용이 있으면:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if internalUrls.length}}Internal URLs available.{{/if}}
```

이 문자는 모델에 그대로 전달됩니다. `cwd`, `skills`, `rules`, `toolRefs` 같은 내부 값은 일반 텍스트 경로에서 비공개 구현 세부사항으로 유지됩니다. 날짜는 템플릿 값으로 노출하지 않으며 첫 사용자 턴에서 세션 cwd와 함께 요청별 알림으로 전달됩니다.

명시적으로 선택하는 `SYSTEM_TEMPLATE.md` / `--system-prompt-template` / 프로그래밍 API `CreateAgentSessionOptions.systemPromptTemplate` 및 `buildSystemPrompt({ systemPromptTemplate })` 경로만 Handlebars를 컴파일합니다. 명시적인 템플릿이 잘못되었거나 비어 있으면 명확하게 실패하며 일반 텍스트로 대체하지 않습니다. 검색된 빈 템플릿은 건너뜁니다. `buildSystemPrompt()`가 검색한 잘못된 템플릿은 경고 후 번들 프롬프트로 대체합니다. CLI가 검색한 소스는 명시적 SDK 입력으로 전달되므로 Handlebars 형식이 잘못되면 실패합니다.

## 사용 예

### 기본 프롬프트에 규칙 추가

`SYSTEM.md`나 `SYSTEM_TEMPLATE.md` 없이 `APPEND_SYSTEM.md`를 만드세요.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### 사용자 지정 기본 프롬프트 제공

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP는 생성 컨텍스트, 스킬, 규칙, 프로젝트/환경 푸터를 계속 추가하지만 기본 지침 템플릿의 도구 및 워크플로 안내는 추가하지 않습니다.

### 번들 프롬프트 이전

1. `packages/coding-agent/src/prompts/system/system-prompt.md`를 `~/.omp/agent/SYSTEM_TEMPLATE.md` 또는 `<cwd>/.omp/SYSTEM_TEMPLATE.md`로 복사합니다.
2. 필요한 Handlebars 블록과 실시간 데이터 자리표시자를 유지하면서 문구를 수정합니다.
3. 렌더링된 `/dump` 프롬프트는 절대 복사하지 마세요. 설정, 도구 목록, 마운트된 장치 데이터가 고정됩니다.
4. OMP를 업데이트할 때 템플릿과 배포된 소스 경로를 비교합니다.
5. 같은 범위의 `SYSTEM.md`를 제거하거나 이름을 바꿉니다. 검색된 리터럴이 검색된 템플릿보다 우선하므로 리터럴이 없어져야 템플릿이 적용됩니다.

### Handlebars 템플릿 제공

`<cwd>/.omp/SYSTEM_TEMPLATE.md`를 만드세요(또는 같은 파일을 `--system-prompt-template`에 전달하세요).

```handlebars
# Delegation
{{#if eagerTasksAlways}}
After settling the design, MUST delegate substantial work through `{{toolRefs.task}}`.
{{else}}
{{#if eagerTasks}}
After settling the design, SHOULD delegate substantial work through `{{toolRefs.task}}`.
{{else}}
Delegate only when the request or repository guidance calls for it.
{{/if}}
{{/if}}

# Tools
{{toolInventory}}

{{#if xdevTools.length}}
## xd:// protocol
Write JSON args as `content` to `xd://<tool>` via `{{toolRefs.write}}`.
{{xdevDocs}}
{{/if}}
```

이 예는 완전하게 실행 가능한 Handlebars Markdown 템플릿입니다. 내장 블록 헬퍼와 실시간 필드만 사용합니다. `eagerTasksAlways`, `eagerTasks`, `toolInventory`, `xdevTools`, `toolRefs`, `xdevDocs`를 의도적으로 참조하며 생략한 필드는 자동 삽입되지 않습니다.

### 성격 블록 교체

기본 템플릿은 `personality` 설정(`default`, `friendly`, `pragmatic`, `none`)으로 선택한 성격 블록을 렌더링합니다. 사용자 수준의 `PERSONALITY.md`는 선택한 프리셋 텍스트를 교체합니다.

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

에이전트 디렉터리만 확인합니다(기본값 `~/.omp/agent`, 프로필 및 XDG 반영). 프로젝트 수준이나 다른 설정 기준 경로는 조회하지 않습니다. `personality: none`은 여전히 블록 전체를 생략합니다(하위 에이전트는 항상 `none`으로 실행). 파일이 비어 있거나 읽을 수 없으면 경고를 기록하고 설정된 프리셋으로 대체합니다.

### 자동 세션 제목 사용자 지정

`SYSTEM.md`와 `APPEND_SYSTEM.md`는 제목 생성 호출에 영향을 주지 않습니다. `TITLE_SYSTEM.md`를 사용하세요.

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md`는 상위 디렉터리 탐색 없이 프로젝트 우선으로 설정 기준 경로를 검색합니다. 다른 도구의 사용자 기준 경로는 `enabledProviders`(Claude는 `CLAUDE_CONFIG_DIR`도 가능)로 명시적으로 활성화해야 합니다. 파일이 없으면 OMP는 첫 응답의 분기(캐시된 프롬프트를 사용하는 세션 자체 모델)에서 새 세션 제목을 생성하고 번들 소형 모델 제목 프롬프트를 대체 수단으로 사용합니다. 재정의는 최초 자동 제목과 재계획에 따른 제목 갱신 모두에 사용되며 응답 분기를 비활성화합니다. 이 경우 소형 제목 모델이 제목을 생성합니다.

사용자 지정 프롬프트를 사용해도 생성된 제목 출력에는 정규화 계약이 강제됩니다. OMP는 앞뒤 공백을 제거한 첫 줄만 고려하며, 감싼 따옴표, `<title>...</title>` 표시, 끝 문장부호를 제거합니다. `none`이나 `<title/>`는 “아직 제목 없음”으로 취급합니다. 80자 또는 12단어를 넘는 결과는 자르지 않고 거부합니다. 비어 있거나 보류되거나 거부된 출력은 세션을 이름 없는 상태로 두므로 나중에 적합한 제목 생성 시도에서 이름을 지정할 수 있습니다.

## 프로그래밍 API 옵션

프로그래밍 API 호출자는 CLI 플래그가 아닌 별도 옵션을 사용합니다. `CreateAgentSessionOptions.systemPromptTemplate`과 `buildSystemPrompt({ systemPromptTemplate })`는 원시 Handlebars 소스를 받습니다. `CreateAgentSessionOptions.customSystemPrompt`는 이미 읽은 리터럴 텍스트입니다. `buildSystemPrompt`의 `customPrompt`는 경로 또는 리터럴로 확인하는 일반 텍스트이며 `resolvedCustomPrompt`는 이미 읽은 텍스트입니다.

템플릿 소스와 리터럴 사용자 지정 프롬프트는 함께 사용할 수 없습니다. `systemPromptTemplate`은 `CreateAgentSessionOptions`의 `customSystemPrompt`, 그리고 `buildSystemPrompt`의 `customPrompt` / `resolvedCustomPrompt`와 충돌합니다. 이런 조합은 한쪽을 조용히 선택하지 않고 명확하게 실패합니다.

## 제공업체 대상 전체 교체(프로그래밍 API 전용)

`CreateAgentSessionOptions.systemPrompt`는 별도의 하위 수준 프로그래밍 API입니다. 빈 문자열이나 배열을 포함한 고정 문자열 또는 배열은 OMP가 생성한 모든 블록을 교체하고 사용하지 않는 시스템 프롬프트 템플릿의 검색/렌더링을 건너뜁니다. 옵션 검증까지 건너뛰지는 않습니다. 값이 비어 있거나 `systemPrompt`가 고정 교체값이어도 `systemPromptTemplate`과 `customSystemPrompt`를 함께 정의하면 거부합니다. 콜백은 대신 일반 템플릿/사용자 지정 조합 이후 생성된 블록 배열을 받아 대체값을 반환합니다. 이 경로에는 일반 템플릿 검색과 오류가 적용됩니다. 어느 형태든 생성 컨텍스트와 안전 블록을 모두 생략할 수 있습니다.

`CreateAgentSessionOptions.systemPromptTemplate`은 앞서 설명한 조합형 프로그래밍 API입니다. 원시 Handlebars 소스를 받아 블록 0을 교체하며 OMP가 생성한 푸터(컨텍스트, 활성 저장소 컨텍스트, 추가 텍스트), 안전 블록, 제공업체 도구 스키마는 유지합니다. `customSystemPrompt`와 상호 배타적입니다. 내보낸 `buildSystemPrompt({ systemPromptTemplate })` 옵션도 같은 원시 텍스트 계약과 충돌 동작을 가지며, `customPrompt` 옵션은 계속 경로 또는 리터럴로 확인하는 일반 텍스트입니다.

CLI 플래그와 파일은 `systemPrompt`를 설정하지 **않습니다**. 일반 텍스트/템플릿 사용자 지정 경로와 추가 경로를 선택하며 앞서 설명한 OMP 생성 블록을 계속 거칩니다.

## 빠른 참조

| 목적 | 사용 방법 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 완전한 기본 프롬프트를 유지하며 지침 추가 | `APPEND_SYSTEM.md` 또는 `--append-system-prompt` |
| 기본 지침 블록을 일반 텍스트로 교체 | `SYSTEM.md` 또는 `--system-prompt` |
| 기본 지침 블록을 Handlebars로 교체 | `SYSTEM_TEMPLATE.md` 또는 `--system-prompt-template <path>` |
| 프로그래밍 API로 원시 Handlebars 제공 | `CreateAgentSessionOptions.systemPromptTemplate` 또는 `buildSystemPrompt({ systemPromptTemplate })` |
| 제공업체 대상 시스템 블록 전체 교체 | `CreateAgentSessionOptions.systemPrompt` |
| 자동 세션 제목 사용자 지정 | `TITLE_SYSTEM.md` |
| 나머지 기본 프롬프트를 유지하며 성격 블록 교체 | `PERSONALITY.md` |
| 일반 사용자 파일에서 `{{cwd}}` 등 내부 변수 사용 | 지원하지 않습니다. 일반 사용자 내용은 그대로 삽입됩니다. |
| 템플릿에 실시간 설정, 도구 목록, xdev 문서 포함 | `{{eagerTasks}}`, `{{toolInventory}}`, `{{xdevDocs}}` 등 해당 Handlebars 필드를 참조합니다. |
| 선택한 기본 템플릿 섹션을 자동 상속 | 지원하지 않습니다. 템플릿이 필요한 데이터를 참조해야 합니다. |
| 디렉터리별 재정의 | 지원되는 프로젝트 설정 기준 경로를 사용합니다. 네이티브 `.omp` 및 `.agent` / `.agents` 사용자 지정 프롬프트는 상위 디렉터리 검색도 지원합니다. |
| 전역 재정의 | 활성 네이티브 에이전트 디렉터리 또는 지원되는 다른 사용자 설정 기준 경로를 사용합니다. |
