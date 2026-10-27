<a id="task-agent-discovery-and-selection"></a>
# 작업 에이전트 검색 및 선택

이 문서는 작업 하위 시스템이 에이전트 정의를 검색하고 여러 소스를 병합하며 실행 시 요청된 에이전트를 결정하는 방식을 설명합니다.

우선순위, 잘못된 정의 처리, 에이전트를 사실상 사용할 수 없게 만드는 생성/깊이 제약 등 현재 구현된 런타임 동작을 다룹니다.

<a id="implementation-files"></a>
## 구현 파일

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

<a id="agent-definition-shape"></a>
## 에이전트 정의 구조

작업 에이전트는 `AgentDefinition`(`src/task/types.ts`)으로 정규화됩니다.

- 필수: `name`, `description`, `systemPrompt`
- 선택: `tools`, `spawns`, 우선순위순 `model` 목록, `thinkingLevel`, `output`, `blocking`, `structured`, `autoloadSkills`, `readSummarize`, `prewalk`, `advisor`
- `source`: `"bundled" | "user" | "project"`(확장 에이전트에는 확장 루트의 프로젝트/사용자 수준이 지정됨)
- 선택: `filePath`

`parseAgentFields()`(`src/discovery/helpers.ts`)가 frontmatter를 파싱합니다.

- `name` 또는 `description`이 없거나 문자열이 아니면 무효(`null`)이며 호출자는 파싱 실패로 처리합니다.
- `main`과 `sub`는 예약된 이름입니다(앞뒤 공백 제거 및 소문자 변환 후 검사). 이를 사용하는 정의는 무효입니다.
- `tools`는 CSV 또는 배열을 받습니다. 기존 도구 별칭은 정규화되고 혼합 배열에서는 문자열 항목이 유지됩니다. `tools`를 생략하거나 YAML null로 설정하면 기본 내장 도구 집합을 선택합니다. 그 밖에 도구 이름이 없는 선언(`tools: []`, 빈 CSV, 잘못된 스칼라/배열 값 포함)은 내장 도구를 선택하지 않습니다. 구조화된 자식에는 여전히 필수 `yield` 도구가 제공되며 MCP, 확장, 사용자 정의 도구는 추가로 제공됩니다.
- `spawns`는 `*`, CSV 또는 배열을 받습니다.
- 하위 호환 동작: `spawns`가 없지만 `tools`에 `task`가 있으면 `spawns`는 `*`가 됩니다.
- `output`은 내부를 해석하지 않는 스키마 데이터로 전달됩니다.
- `read-summarize: false`(`readSummarize`로 정규화)는 하위 에이전트의 `read` 도구에서 구조 요약을 비활성화합니다. `runSubprocess`가 자식의 격리된 설정에 `read.summarize.enabled: false` 재정의를 적용합니다(`src/task/executor.ts`). 기본 제공 `scout`에서는 비활성화되어 있습니다. 생략하면 부모의 읽기 요약 설정을 상속합니다.
- `model`은 선택자 하나, CSV 또는 배열을 받습니다. 역할 별칭을 확장한 뒤 항목을 순서대로 시도합니다.
- `thinking-level` / `thinking`은 에이전트에 설정된 추론 노력을 선택합니다. `task.enableEffort`(기본값 `false`)로 작업 항목의 대략적인 `effort`(`lo`, `med`, `hi`)가 노출되면 실행 시 이 값이 우선합니다. OMP는 이를 선택된 모델이 지원하는 최저, 중간, 최고 노력 수준에 매핑한 뒤 `task.maxEffort`(기본값 `max`) 이하로 제한합니다. 이 상한은 재시도 대체 모델로 전환해도 유지됩니다. 선택된 모델이 상한 이하의 노력 수준을 지원하지 않으면 생성이 실패합니다. 노력 수준을 제어할 수 없는 모델은 일반 선택자로 돌아갑니다.
- `blocking: true`이면 비동기 작업 실행이 활성화되어 있어도 부모가 해당 에이전트를 기다립니다.
- `structured: true`는 `task.structured`(기본값 `false`)가 꺼져 있어도 해당 에이전트의 구조화된 결과를 유지합니다. 이 에이전트의 작업 생성에는 `yield` 도구가 제공되며 `task.structured: true`와 동일하게 출력 스키마를 결정합니다([구조화된 출력 우선순위](#model-and-structured-output-precedence) 참조). `task.structured`가 켜져 있으면 이 필드는 영향을 주지 않습니다. `false` 또는 생략 시에는 설정을 따릅니다. 설정이 꺼져 있으면 호출자 측 작업 매개변수 `outputSchema`/`schemaMode`는 숨겨집니다. `resolveEffectiveSubagentPolicy()`가 확정된 에이전트를 기준으로 결정하므로 계획 모드 생성에서도 유지되며, 재시작 후 복원 시에는 자식의 저장된 도구 목록에서 `yield`를 복구합니다.
- `autoloadSkills`는 첫 자식 프롬프트 전에 주입할 부모 세션의 스킬 이름을 지정합니다. 알 수 없는 이름은 무시됩니다.
- `prewalk: true`이면 하위 에이전트가 확정된 모델로 시작하고 첫 편집/쓰기 시 기본 prewalk 대상(`smol` 역할)으로 인계합니다. 세션 수준 `--prewalk`와 동일합니다. 문자열 값(예: `prewalk: "@smol"` 또는 `prewalk: "openai/gpt-5-mini"`)은 사용자 지정 대상을 선택합니다. `task.agentPrewalk` 설정 레코드(에이전트 이름 → `"on"` / `"off"` / 패턴, `/agents` 허브의 prewalk 스트립에서 에이전트별 설정)가 frontmatter보다 우선합니다. 대상 결정은 `runSubprocess`(`src/task/executor.ts`)에서 수행합니다. 사용할 수 없는 대상은 생성을 실패시키지 않고 건너뜁니다. 확정된 대상은 모델 제한 적용 후 모델 식별자와 실제 추론 모드/수준이 모두 시작 선택과 일치할 때만 건너뜁니다. 같은 모델이라도 노력 수준을 낮추는 것은 실제 인계이므로 첫 편집/쓰기 시 전환하도록 준비됩니다.
- `advisor: true`이면 생성된 에이전트 세션에 `advisor` 역할로 결정된 모델을 실행하는 조언자가 연결됩니다. 문자열 값(예: `advisor: "deepseek/deepseek-v4-flash"` 또는 `advisor: "@smol:high"`)은 명시적 조언자 모델 패턴(선택적 `:level` 접미사)을 지정하며 생성된 세션의 `modelRoles.advisor`로 적용됩니다. `task.agentAdvisor` 설정 레코드(에이전트 이름 → `"on"` / `"off"` / 패턴, `/agents` 허브의 advisor 스트립에서 에이전트별 설정)가 frontmatter보다 우선합니다. `runSubprocess`(`src/task/executor.ts`)에서 결정하며 하위 에이전트에는 기본적으로 조언자가 없습니다. 실제 활성화 여부는 `session_init`에 저장되어 재시작 후 복원 시에도 유지됩니다.

<a id="role-backed-custom-agents"></a>
## 역할 기반 사용자 정의 에이전트

OMP는 `~/.omp/agent/agents/*.md`에서 사용자 에이전트를, `.omp/agents/*.md`에서 프로젝트 에이전트를 검색합니다.

에이전트 frontmatter에 역할 별칭을 지정한 다음 이름으로 디스패치하세요. 모델 라우팅을 위해 작업 디스패치는 `agent`만 설정하며 작업자 모델은 설정하지 않습니다.

`~/.omp/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

`~/.omp/agent/config.yml`에서 역할 매핑을 설정하세요.

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review`는 `modelRoles.review`를 통해 결정됩니다. 각 `modelRoles.<role>` 값은 구체적인 모델 선택자를 저장하며 `:high` 같은 추론 접미사를 붙일 수 있습니다(`src/config/model-resolver.ts`). 매핑을 변경하면 에이전트 정의를 편집하지 않아도 이후 작업의 모델 결정에 반영됩니다. 작업/eval 사전 점검은 에이전트를 다시 검색하기 전에 현재 전역, 프로젝트, 명시적 오버레이 설정을 다시 읽습니다. 따라서 실행 중인 세션에 추가한 에이전트 파일과 역할 별칭이 하나의 갱신된 설정 상태에서 결정됩니다.

기본 일괄 작업 스키마에서는 공유 `context`와 항목별 `task`, `solutionSpace`를 제공하세요. `solutionSpace`는 작업의 크기가 아니라 얼마나 개방적인지를 설명합니다. 기본값이 아닌 에이전트를 선택할 때만 `agent`를 설정하세요.

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    {
      "agent": "reviewer",
      "task": "Report concrete correctness findings.",
      "solutionSpace": "Review cause and failure modes are open; no known defect."
    }
  ]
}
```

`/model`의 Roles 보기에서 `review`, `fast`, `good` 같은 사용자 정의 역할 매핑을 지정하고 저장할 수 있습니다. 활성 세션 선택이나 기본 세션 선택만 변경해도 이 역할들의 매핑은 바뀌지 않습니다.

<a id="user-tagged-model-agents"></a>
## 사용자가 태그한 모델 에이전트

입력창에 `^`를 입력하면 `Alt+P` 세션 선택기와 같은 범위 및 순위에서 모델을 선택할 수 있습니다. 자동 완성을 수락하면 표시 이름을 보여 주는 하나의 칩이 삽입됩니다. 예를 들어 `Have ^`를 입력하고 모델을 선택한 뒤 `review this change`로 문장을 완성하세요.

제출 시 각 모델은 처음 언급될 때 분기 로컬 가명(`m1`, `m2`, …)을 받습니다. 사용자 메시지에는 `<model agent="m1" name="Display Name"/>`이 포함되고 작업 설명에는 해당 공급자/모델 선택자가 나열됩니다. `task`, eval의 `agent()`, `workpool()`은 이 가명을 `agent`로 받습니다. 이 에이전트들은 전문가 템플릿이 아닌 기본 제공 범용 작업 템플릿을 사용하며 태그한 모델을 명시적으로 지정한 요청에만 사용하도록 설계되었습니다.

모델을 태그해도 세션 도중 모델에 제공되는 `task` 설명은 다시 작성되지 않습니다. 설명에는 현재 기본 프롬프트에 포함된 가명이 나열되고 이후 태그는 다음 사용자 턴에 숨겨진 `session-agents` 시스템 알림으로 전달됩니다. 이 알림은 eval 프렐류드 및 도구 목록 변경과 같은 채널을 이용하므로 공급자 캐시 접두사가 바이트 단위로 유지됩니다. 다음 기본 프롬프트 재구성 시 현재 집합이 설명에 반영됩니다.

가명은 `/resume` 후에도 유지됩니다. 모델이 처음 언급되기 전으로 되돌리면 해당 번호가 해제됩니다. 같은 선택자를 반복하면 가명을 재사용합니다. 알 수 없는 선택자와 `!`/`$` 로컬 실행 초안의 언급은 리터럴로 남습니다. 토큰에는 공백 경계가 필요하며 자동 완성이 뒤쪽 공백을 추가합니다. 한 초안에서 두 모델의 표시 이름이 같으면 모호한 확장을 막기 위해 두 번째 모델은 리터럴 선택자로 남습니다.

세션 정의는 검색된 에이전트 뒤에 추가되므로 같은 이름의 기존 에이전트가 우선합니다. 일반 생성 제한과 모델 재정의 우선순위도 그대로 적용됩니다. 합성 프롬프트는 모델을 등록할 수 없습니다.

<a id="watch-running-agents"></a>
## 실행 중인 에이전트 관찰

디스패치 후 `Alt+A`를 눌러 [에이전트 허브](./agent-hub.md)를 여세요. 실시간 목록에는 각 작업 에이전트의 상태, 현재 활동, 모델, 경과 시간, 사용량이 표시됩니다. 에이전트를 선택하면 대화 기록을 읽고 직접 지시할 수 있으며 대기 중인 에이전트도 같은 보기에서 재개할 수 있습니다. `tui.mouse`를 활성화하면 실시간 작업 카드와 이동 목록 행을 클릭할 수 있습니다. 또는 편집기 위에 고정된 `Subagents` 블록을 관찰하세요.

<a id="vibe_spawn-tier-routing"></a>
### `vibe_spawn` 등급 라우팅

`vibe_spawn`은 `fast`를 기본 제공 `sonic`에, `good`을 기본 제공 `task`에 매핑합니다. 둘 다 기본 제공 에이전트의 모델 기본값보다 먼저 `task.agentModelOverrides`를 통해 모델을 결정합니다(`src/vibe/runtime.ts`, `src/task/agents.ts`).

`task.agentModelOverrides`에는 별칭을, `modelRoles`에는 구체적인 선택자만 두어 이 등급을 역할을 통해 라우팅하세요.

```yaml
task:
  agentModelOverrides:
    sonic: "@fast_worker"
    task: "@good_worker"
modelRoles:
  fast_worker: openai/gpt-5-mini
  good_worker: openai/gpt-5.4:high
```

`vibe_spawn`의 `cli`는 계속 `fast` 또는 `good`입니다. 작업자 모델을 바꾸려면 `modelRoles`를 갱신하세요.

<a id="bundled-agents"></a>
## 기본 제공 에이전트

기본 제공 에이전트는 텍스트 가져오기를 통해 빌드 시 포함됩니다(`src/task/agents.ts`).

`EMBEDDED_AGENT_DEFS`는 다음을 정의합니다.

- 프롬프트 파일의 `scout`, `reviewer`, `security-reviewer`
- 공유 `task.md` 본문에 frontmatter를 주입한 `task`, `sonic`. 기본 제공 에이전트 중 `prewalk`를 설정하는 에이전트는 없습니다. 범용 `task` 에이전트의 인계는 `task.prewalk` 설정(기본값 꺼짐) 또는 `/agents` / `task.agentPrewalk` / 사용자 에이전트 frontmatter를 통한 에이전트별 설정으로 준비됩니다.

로딩 경로:

1. `loadBundledAgents()`가 `parseAgent(..., "bundled", "fatal")`로 포함된 Markdown을 파싱합니다.
2. 결과를 메모리에 캐시합니다(`bundledAgentsCache`).
3. `clearBundledAgentsCache()`는 테스트 전용 캐시 초기화입니다.

기본 제공 정의는 `level: "fatal"`로 파싱하므로 복구할 수 없는 YAML 오류나 잘못된 필수 필드는 예외를 발생시키며 검색 전체가 실패할 수 있습니다.

<a id="filesystem-and-plugin-discovery"></a>
## 파일 시스템 및 플러그인 검색

`discoverAgents(cwd, home, extensionRoots?)`(`src/task/discovery.ts`)는 OMP 네이티브 루트, OMP 확장 패키지, Claude 마켓플레이스 플러그인 루트의 에이전트를 병합한 뒤 기본 제공 정의를 추가합니다. `.claude/agents`, `.codex/agents`, `.gemini/agents` 같은 다른 하네스의 직접 루트는 의도적으로 건너뜁니다. 이들의 frontmatter 스키마는 OMP 작업 에이전트 계약이 아니기 때문입니다(`TASK_AGENT_CONFIG_SOURCE = ".omp"`가 네이티브 설정 디렉터리 목록을 필터링).

<a id="discovery-inputs-and-precedence"></a>
### 검색 입력과 우선순위

1. `findAllNearestProjectConfigDirs("agents", cwd)`의 가장 가까운 프로젝트 `.omp/agents` 디렉터리(첫 번째 `.omp` 일치만)
2. `getConfigDirs("agents", { project: false })`의 사용자 `.omp/agents` 디렉터리(첫 번째 `.omp` 일치만)
3. `listOmpExtensionRoots(...)`가 반환한 활성 OMP 확장 패키지 각각의 `<extension-root>/agents`. 순서는 다음과 같습니다.
   - 명시적 CLI `--extension` / SDK `additionalExtensionPaths` 디렉터리 루트
   - 세션의 실제 `extensions:` 배열(설정 순서)
   - 설치된 npm/link 플러그인
   프로젝트 및 사용자 `extensions:` 배열은 합쳐지지 않습니다. 설정은 배열 교체 우선순위를 따릅니다. 세션 오버레이/런타임 재정의와 설정된 배열의 프로젝트/사용자 출처는 유지됩니다. `explicit-only` 모드(`--no-extensions` 또는 SDK `disableExtensionDiscovery`)에서는 명시적 루트만 이 패키지 검색 대상에 포함됩니다. 파일 진입점에는 검색할 `agents/` 하위 디렉터리가 없습니다.
4. `agents/` 하위 디렉터리가 있는 Claude 마켓플레이스 플러그인 루트(`listClaudePluginRoots(home, cwd)`). `isProviderEnabled("claude-plugins")`일 때만 포함되며 프로젝트 범위 플러그인이 사용자 범위보다 먼저 정렬됩니다. 사용자 범위 루트는 추가로 `claude-plugins` 또는 `claude` 사용자 소스가 활성화되어야 합니다(`isUserSourceEnabled`: 일반적으로 `enabledProviders`, 예: `["claude-plugins"]`; `CLAUDE_CONFIG_DIR`가 설정되면 `claude`도 암묵적으로 활성화). 단, 출처가 외부 `~/.claude/plugins` 트리가 아닌 루트(omp 자체 설치의 `origin: "omp"`, `--plugin-dir` 루트)는 예외입니다. 스킬 경로와 같은 예외 규칙입니다.
5. 기본 제공 에이전트(`loadBundledAgents()`)

`omp-plugins` 기능 공급자가 비활성화되면 OMP 확장 패키지 검색 대상도 비활성화됩니다. 마켓플레이스 루트는 `listOmpExtensionRoots`에서 제외되며 별도로 제어되는 Claude 플러그인 경로로만 들어옵니다.

Claude 형식 플러그인 에이전트는 Claude 별칭을 OMP 선택자로 오해하지 않도록 frontmatter의 `model`을 버립니다. 외부 Claude 루트뿐 아니라 매니페스트에서 Claude 형식을 선언한 패키지에도 적용되며 OMP 설치와 `--plugin-dir` 루트도 포함됩니다. OMP 네이티브 및 Agent-Plugins 표준 패키지는 모델 선택자를 유지합니다.

<a id="merge-and-collision-rules"></a>
## 병합 및 충돌 규칙

검색은 정확한 `agent.name`을 기준으로 먼저 나온 항목을 유지하며 중복을 제거합니다.

- `Set<string>`이 이미 나온 이름을 추적합니다.
- 로드된 에이전트를 디렉터리 순서로 펼치고 아직 나오지 않은 이름만 유지합니다.
- 기본 제공 에이전트도 같은 집합으로 필터링하여 아직 없는 이름만 추가합니다.

따라서 다음이 성립합니다.

- 프로젝트 `.omp`가 사용자 `.omp`보다 우선합니다.
- 앞선 확장 루트가 뒤의 확장 루트, Claude 마켓플레이스 플러그인, 기본 제공 에이전트보다 우선합니다.
- 기본 제공이 아닌 에이전트가 같은 이름의 기본 제공 에이전트보다 우선합니다.
- 이름 비교는 대소문자를 구분합니다(`Task`와 `task`는 서로 다름).
- 한 디렉터리에서는 중복 제거 전에 Markdown 파일을 파일명의 사전식 순서로 읽습니다.

<a id="invalidmissing-agent-file-behavior"></a>
## 잘못되거나 누락된 에이전트 파일 처리

각 디렉터리(`loadAgentsFromDir`)에서:

- 읽을 수 없거나 없는 디렉터리: 빈 디렉터리로 처리(`readdir(...).catch(() => [])`)
- 파일 읽기 또는 파싱 실패: 경고를 기록하고 파일을 건너뜀
- 파싱 경로는 `parseAgent(..., level: "warn")` 사용

frontmatter 실패 처리는 `parseFrontmatter`에서 이루어집니다.

- 기본 관대한 파서는 줄바꿈과 kebab-case 키를 정규화하고 YAML의 탭을 바꾸며 실패를 보고하기 전에 모호한 일반 스칼라를 복구할 수 있습니다.
- `warn` 수준에서 복구되지 않은 파싱 오류는 경고를 기록한 뒤 최상위 `key: value` 줄을 사용하는 방식으로 대체됩니다.
- 대체 값은 가능하면 개별적으로 YAML로 파싱하여 스칼라/배열 타입을 유지합니다.
- 필수 필드가 여전히 잘못되면 `parseAgentFields`가 실패하고 `AgentParsingError`를 던집니다. 디렉터리 로더가 이를 잡아 파일을 건너뜁니다.

결과적으로 잘못된 사용자 정의 에이전트 파일 하나가 다른 파일의 검색을 중단시키지 않습니다.

<a id="agent-lookup-and-selection"></a>
## 에이전트 조회 및 선택

조회는 정확한 이름으로 선형 검색합니다.

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- 제한 없는 세션에서 `agent` 필드를 생략하면 기본값은 `task`입니다.
- 부모의 `spawns` 목록이 제한되어 있으면 `agent` 생략 시 목록의 첫 에이전트가 기본값입니다.

`resolveEffectiveSubagentPolicy()`는 작업 및 eval 기반 하위 에이전트 실행에서 공유됩니다. 아티팩트를 할당하기 전에 다음을 수행합니다.

1. 런타임 재정의를 유지하면서 현재 세션의 저장된 전역, 프로젝트, 명시적 오버레이 설정을 원자적으로 다시 읽습니다.
2. 부모 생성 정책에서 생략되거나 명시된 에이전트 이름을 결정합니다.
3. 깊이, 차단된 자기 재귀, 부모 생성 정책 가드를 적용합니다.
4. 세션의 cwd와 실제 확장 루트 설정으로 에이전트를 다시 검색하고 사용자 태그 세션 에이전트를 추가한 뒤 정확한 이름으로 조회합니다.
5. `task.disabledAgents`를 검사합니다.
6. 계획 모드 제한, 출력 스키마, 모델 정책, 격리 정책을 결정합니다.

이름이 없으면 사전 점검이 `Unknown agent "...". Available: ...`로 실패하며 하위 프로세스는 실행되지 않습니다.

<a id="description-vs-execution-time-discovery"></a>
### 설명 생성 시 검색과 실행 시 검색의 차이

`TaskTool.create()`는 모델에 제공할 도구 설명을 만들 때 확정된 작업 디렉터리와 전체 실제 확장 루트 설정을 기준으로 검색 결과를 메모이제이션합니다. 설명을 읽을 때마다 현재 기본 프롬프트에 고정된 사용자 태그 모델 에이전트도 포함됩니다([사용자가 태그한 모델 에이전트](#user-tagged-model-agents) 참조). 실시간 집합은 사용하지 않으므로 세션 중 모델을 태그해도 공급자 도구 접두사는 바뀌지 않습니다. 실행 시에는 에이전트를 다시 검색하고 실시간 세션 에이전트를 병합하므로 세션 도중 에이전트 또는 확장 파일이 바뀌었다면 런타임 집합이 이전 설명과 다를 수 있습니다. 대기 여부는 오래된 설명 생성 시점의 에이전트 객체가 아니라 정책 결정 후에 정해집니다.

<a id="model-and-structured-output-precedence"></a>
## 모델 및 구조화된 출력 우선순위

작업 디스패치의 모델 우선순위는 다음과 같습니다.

1. `task.agentModelOverrides[agentName]`
2. 에이전트 frontmatter의 우선순위순 `model` 목록
3. 부모의 활성 모델, 이후 부모의 설정된/기본 모델 대체값

앞의 두 소스에 있는 역할 별칭은 `modelRoles`를 통해 확장됩니다. 공유 eval 브리지는 설정 재정의보다 우선하는 호출별 모델 재정의를 제공할 수도 있습니다. 작업 전송 스키마는 이 필드를 노출하지 않습니다.

정책 결정 후 실제 디스패치에 대해 `before_subagent_spawn` 확장 훅이 한 번 실행됩니다. 생성을 차단하거나 확정된 모델 패턴을 교체할 수 있으며 라우팅 메모는 진행 메타데이터로 전달됩니다.

`Alt+P`의 작업 모델 선택은 해당 세션에만 적용됩니다. `/agents`에서 모델을 저장하면 현재 세션의 런타임 선택을 대체하고 이후 세션을 위해 새 값을 저장합니다.

압축 트리거는 모델 및 서비스 등급 선택과 별개입니다. 대소문자를 구분하는 정확한 `task.agentCompactionThresholdOverrides[agentName]` 항목(`90000` 또는 `"80%"`)은 해당 에이전트에 대해서만 `compaction.threshold*` 설정을 대체합니다. 항목이 없는 에이전트와 그 에이전트가 생성한 에이전트는 기본 세션의 임계값을 사용합니다. [설정](./settings.md#context-compaction-and-memory)을 참조하세요.

요청 예산도 같은 정확한 이름 패턴을 따릅니다. `task.agentSoftRequestBudget[agentName]` 항목(음수가 아닌 정수)은 해당 에이전트의 소프트 요청 예산으로, `task.softRequestBudget`와 기본 제공 scout/sonic 상한을 모두 대체합니다. 따라서 전역 설정으로는 낮출 수만 있는 예산을 높일 수도 있습니다. `0`은 해당 에이전트의 가드를 비활성화하고 `null`은 하위 설정 계층의 항목을 지웁니다. 항목이 없는 에이전트는 기본 제공 상한으로 제한된 전역 설정을 유지합니다. [task](./tools/task.md#limits--caps)를 참조하세요.

서비스 등급 우선순위는 모델 선택과 독립적입니다. 대소문자를 구분하는 정확한 `task.agentServiceTierOverrides[agentName]` 항목이 `tier.subagent`보다 우선하며 항목이 없으면 전역 동작을 유지합니다. `inherit`는 다음 생성에 사용할 부모 세션의 실시간 공급자 계열별 등급(`/fast` 변경 포함)을 캡처합니다. 자식 세션은 인증 대체와 확장 등록 모델처럼 세션에서만 결정할 수 있는 패턴 처리 후 최종 선택한 모델에 맞춰 구체적인 값을 결정합니다. 해당 계열이 그 값을 지원할 때만 그 모델의 공급자 계열에 값을 채웁니다. 따라서 같은 계열의 재시도 대체는 등급을 유지하고 다른 계열의 대체는 상속하지 않습니다. 결정된 맵은 비어 있어도 자식 세션과 함께 저장되므로 재시작 후 대기 에이전트를 복원해도 `tier.subagent`에서 다시 도출하지 않고 에이전트별 등급을 유지합니다. 이 항목은 작업/eval 디스패치에서만 조회합니다. 같은 실행기를 통해 시작한 Vibe 작업자는 `tier.subagent`를 유지합니다. 서비스 등급은 설정으로만 지정할 수 있습니다. 에이전트 frontmatter와 작업/eval 전송 형식에는 등급 필드나 자동 Fast 정책이 없습니다.

계정 선택은 모델 및 서비스 등급 선택과 독립적입니다. 대소문자를 구분하는 정확한 `task.agentAccountPools[agentName]` 항목은 공급자 ID를 OAuth ID 키에 매핑합니다. 이 키는 브로커 [클라이언트 계정 풀](./auth-broker-gateway.md#client-account-pools-routing-not-authorization)에서 사용하는 `identityKey` 값이며 Anthropic의 `email:<address>|org:<id>` 등이 있습니다. [`omp usage accounts`](./cli-reference.md)로 확인할 수 있습니다. 나열된 각 공급자에 대해 자식은 해당 계정으로만 인증합니다. 순위 지정, 부모에서 복사한 계정 선호도, 복원된 고정 계정, 대체 시도, 자격 증명 순환, 저장된 초기화 복원은 모두 풀 안에서만 이루어집니다. 런타임, 환경, 저장된 API 키는 사용하지 않습니다. 공급자에 대한 `models.yml`의 `apiKey`가 있으면 풀 토큰을 해당 엔드포인트로 보내는 대신 요청이 실패합니다. 풀 안에 요청을 처리할 계정이 없으면 다른 계정을 빌리지 않고 `No API key for provider: … restricted to its OAuth account pool`로 실패합니다. 빈 목록은 어떤 계정도 허용하지 않습니다. 만료가 임박한 저장된 초기화는 모든 계정에서 계속 회수합니다. 회수는 초기화를 보유한 계정에 대한 작업이기 때문입니다. 풀은 모델을 선택하지 않으므로 자식이 호출할 공급자는 여전히 모델 및 재시도 대체 정책이 결정합니다. 풀은 에이전트가 수행하는 모든 키 조회에 적용되며 공급자 세션 ID와 무관합니다. 새 세션과 초기화 세션, 조언자, 제목 생성, 스킬 압축, 자체 항목이 없는 하위 에이전트까지 포함합니다(자체 항목이 있으면 대체). Vibe 작업자는 첫 턴부터 풀을 적용받으며 같은 프로세스 또는 재시작 후 복원된 대기 에이전트는 자신의 이름에 대한 현재 항목을 적용받습니다. 사용자 정의 SDK `getApiKey` 리졸버는 풀을 우회합니다.

런타임 출력 스키마 우선순위는 다음과 같습니다.

1. 작업 항목의 명시적 `outputSchema`
2. 에이전트 frontmatter의 `output`
3. 부모 세션의 `outputSchema`

작업 항목의 선택적 `schemaMode`는 부모 세션 모드보다 우선합니다. 기본값은 `permissive`입니다.

이 스키마들은 구조화된 실행에만 적용됩니다. `task.structured`가 꺼져 있으면(기본값) 작업 생성에는 출력 스키마와 `yield` 도구가 제공되지 않고 최종 어시스턴트 메시지를 반환합니다. 단, 정의에 `structured: true`가 있는 에이전트는 예외입니다. 이들은 작업 항목의 `outputSchema`가 노출되지 않으므로 에이전트 `output`, 부모 세션 스키마 순서로 결정합니다. eval `agent()`와 workpool 생성은 항상 구조화됩니다.

호출자가 명시한 스키마는 두 모드 모두 사전 점검에서 검증합니다. 에이전트/세션 스키마는 실제 모드가 `strict`일 때 사전 검증합니다. 잘못된 스키마는 자식 실행 전에 실패합니다.

모델에 제공되는 프롬프트(`src/prompts/tools/task.md`)는 읽기 전용 에이전트를 표시하고 `scout`/`sonic`에 추론을 떠넘기지 않도록 경고합니다.

<a id="command-discovery-interaction"></a>
## 명령 검색과의 관계

`src/task/commands.ts`는 에이전트 정의가 아닌 워크플로 명령을 위한 별도 기반 구조이지만 전체 패턴은 같습니다.

- 기능 공급자에서 먼저 검색
- 이름 기준으로 먼저 나온 항목을 유지하며 중복 제거
- 아직 없는 기본 제공 명령 추가
- `getCommand`를 통한 정확한 이름 조회

`src/task/index.ts`는 명령 헬퍼를 에이전트 검색 헬퍼와 함께 다시 내보냅니다. 에이전트 검색 자체는 런타임에 명령 검색에 의존하지 않습니다.

<a id="availability-constraints-beyond-discovery"></a>
## 검색 외의 가용성 제약

에이전트가 검색되더라도 실행 가드레일 때문에 실행할 수 없을 수 있습니다.

<a id="disabled-agent-settings"></a>
### 비활성 에이전트 설정

`resolveEffectiveSubagentPolicy()`는 에이전트를 결정한 뒤 `task.disabledAgents`를 검사합니다. 비활성 이름이면 사전 점검이 실패하고 사용 가능한 활성 대안이 있으면 나열합니다.

<a id="parent-spawn-policy"></a>
### 부모 생성 정책

리졸버는 `session.getSessionSpawns()`를 검사합니다.

- `"*"`(`true`, `null`, 생략도 포함) => 모두 허용. `agent` 생략 시 기본값은 `task`
- `""` 또는 `false` => 모두 거부
- CSV 목록 => 나열된 이름만 허용. `agent` 생략 시 첫 이름이 기본값

거부 시: `Cannot spawn '...'. Allowed: ...`.

<a id="blocked-self-recursion-env-guard"></a>
### 자기 재귀 차단 환경 가드

`PI_BLOCKED_AGENT`(또는 내부 요청 재정의)는 검색 전에 같은 차단 에이전트를 생성하려는 시도를 거부합니다.

<a id="recursion-depth-gating"></a>
### 재귀 깊이 제한

`task.maxRecursionDepth`의 기본값은 `2`이며 음수는 상한을 비활성화합니다. 공유 정책은 현재 작업 깊이가 이미 상한에 도달했으면 생성을 거부합니다. 자식이 상한에 도달하면 `runSubprocess`도 도구 목록에서 `task`를 제거하고 생성 정책을 비웁니다.

명시적인 에이전트 도구 목록에서는 `spawns`가 선언되어 있고 깊이가 허용하면 `runSubprocess`가 `task`를 자동 추가합니다. 기존 `exec` 항목은 eval 백엔드가 있을 때 `bash`와 `eval`로 확장됩니다. `task` 또는 `bash`가 있는 목록에는 부모가 정확히 제한된 도구 목록을 요구하지 않는 한 `wait`도 추가됩니다. 다만 비동기, IRC, 서비스 깨우기 소스가 없으면 도구 구성 시 `wait`를 제외합니다. 다른 에이전트로 메시지를 보내려면 자식 도구 목록에 `write`가 있고 IRC가 활성화되어야 합니다. 외부에서 지시를 받는 데에는 필요하지 않습니다.

<a id="plan-mode-behavior"></a>
## 계획 모드 동작

부모의 계획 모드가 켜져 있으면 `resolveEffectiveSubagentPolicy()`가 하위 프로세스를 시작하기 전에 `effectiveAgent`를 구성합니다.

- 계획 모드 하위 에이전트 시스템 프롬프트를 앞에 추가
- 도구를 `read`, `grep`, `glob`, `web_search`로 제한. 에이전트 자체 도구 목록에 `ast_grep`가 있으면 함께 허용
- 자식 생성 허용 목록 제거
- `prewalk` 제거(읽기 전용 탐색에는 prewalk의 계획/구현 유도 지시를 제공하면 안 됨)

계획 모드는 eval로 정의한 도구와 생성별 격리, 적용, 병합 제어도 거부합니다. 하위 프로세스 실행, 모델/추론 재정의, 출력 스키마 선택에 모두 같은 `effectiveAgent`를 사용합니다.
