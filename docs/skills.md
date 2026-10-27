# 스킬

스킬은 시작 시 발견되어 다음 형태로 모델에 제공되는 파일 기반 기능 묶음입니다.

- 시스템 프롬프트의 간략한 메타데이터(이름 + 설명)
- `skill://...` 주소를 `read` 도구로 읽어 필요할 때 불러오는 콘텐츠
- 선택적으로 제공되는 대화형 `/skill:<name>` 명령

이 문서는 `packages/coding-agent/src/extensibility/skills.ts`, `packages/coding-agent/src/discovery/builtin.ts`, `packages/coding-agent/src/internal-urls/skill-protocol.ts`, `packages/coding-agent/src/discovery/agents-md.ts`의 현재 런타임 동작을 설명합니다.

## 이 코드베이스에서 스킬이란

발견된 스킬은 다음 정보로 표현됩니다.

- `name`
- `description`
- `filePath` (`SKILL.md` 경로)
- `baseDir` (스킬 디렉터리)
- 출처 메타데이터(`provider`, `level`, 경로)

기능 검증기는 `name`과 `path`만 요구하지만, 각 제공업체는 추가 프런트매터 요건을 적용합니다. 설명인 `description`이 의미 있어야 적절한 스킬을 잘 선택할 수 있습니다.

## 필수 구조와 SKILL.md 작성 요건

### 디렉터리 구조

일반적인 제공업체 루트(native/Claude/Codex/Agents/plugins)에서는 **`skills/` 바로 아래 한 단계**에서 스킬을 발견합니다.

- `<skills-root>/<skill-name>/SKILL.md`

`<skills-root>/group/<skill>/SKILL.md` 같은 중첩 구조는 재귀적으로 탐색하지 않습니다. Claude-plugin 제공업체는 바로 아래 하위 디렉터리뿐 아니라 매니페스트에 선언된 스킬 디렉터리에 `SKILL.md`가 직접 있는 형태도 지원합니다. Agent Plugins 패키지는 고정된 `skills/<name>/SKILL.md` 구조만 사용하며, 레지스트리에서 설치한 Skillshare 패키지는 루트에 `SKILL.md`를 둡니다.

`skills.customDirectories`도 같은 비재귀 구조(`*/SKILL.md`)로 탐색합니다.

```text
제공업체가 탐색하는 구조(skills/ 아래를 재귀적으로 탐색하지 않음):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ 발견됨
  ├─ pdf/
  │   └─ SKILL.md      ✅ 발견됨
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ 제공업체 로더가 발견하지 못함

사용자 지정 디렉터리도 재귀적으로 탐색하지 않으므로, 중첩된 상위 디렉터리를 `customDirectories`로 지정하지 않으면 중첩 경로는 무시됩니다.
```

### `SKILL.md` 프런트매터

스킬 타입에서 지원하는 프런트매터 필드:

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean` (Agent Skills에서 `hide`에 해당하는 필드. 케밥 표기법인 `disable-model-invocation`에서 정규화됨)
- 일반 스캐너는 추가 키를 알 수 없는 메타데이터로 보존합니다.
- `enabled: false`이면 일반 스캐너와 Skillshare 탐색에서 해당 스킬을 건너뜁니다.

여기서 `globs`와 `alwaysApply`는 메타데이터이며, 스킬을 자동으로 호출하는 제어 설정이 아닙니다. Agent Plugins 패키지는 관대한 스캐너 대신 더 엄격한 Agent Skills 검증을 사용합니다. 이름/설명 필수, 디렉터리 이름 일치, 유효한 명명 규칙, 허용된 프런트매터 필드 집합을 검사합니다. `hide`, `enabled` 같은 OMP 전용 필드는 허용되지 않습니다.

현재 런타임 동작:

- `name`의 기본값은 스킬 디렉터리 이름입니다.
- 다음 경우에는 `description`이 필수입니다.
  - 네이티브 `.omp` 제공업체의 스킬 탐색(`requireDescription: true`)
  - `omp-plugins` 확장 기능 패키지의 스킬과 `github` 제공업체(`.github/skills/`). 이들도 `requireDescription: true`를 전달합니다.
  - `src/discovery/helpers.ts`의 `scanSkillsFromDir`를 통한 `skills.customDirectories` 탐색(비재귀)
- claude/codex/agents/opencode/claude-plugins 제공업체는 설명이 없는 스킬도 불러올 수 있습니다.
- `agent-plugins`는 Agent Skills 명세에 따라 필수 `name`과 `description`을 검증합니다.

## 탐색 파이프라인

`packages/coding-agent/src/extensibility/skills.ts`의 `loadSkills()`는 세 번에 걸쳐 처리합니다.

1. `loadCapability("skills")`를 통한 **기능 제공업체** 탐색(관리형/자동 학습 제공업체의 스킬은 여기서 건너뛰고 3단계에서 처리)
2. `scanSkillsFromDir(..., { requireDescription: true })`를 통한 **사용자 지정 디렉터리** 탐색(한 단계의 디렉터리 열거). 사용자 지정 디렉터리의 스킬은 이름이 같은 기본 제공업체 스킬을 재정의합니다. 대체된 제공업체 스킬은 본문이 동일하지 않으면 네임스페이스가 붙은 이름으로 계속 접근할 수 있습니다.
3. **관리형(자동 학습) 스킬**(`omp-managed` 제공업체)은 맨 마지막에 처리하므로, 제공업체나 사용자 지정 디렉터리에서 작성되어 활성화된 동명의 스킬이 항상 우선합니다.

`skills.enabled`가 `false`이면 탐색 결과로 스킬을 반환하지 않습니다.

### 기본 제공 스킬 제공업체와 우선순위

제공업체는 우선순위가 높은 순서로 정렬되며, 동률이면 등록 순서를 따릅니다.

현재 등록된 스킬 제공업체:

1. `native` (우선순위 100) — `src/discovery/builtin.ts`를 통한 `.omp` 사용자/프로젝트 스킬
2. `skillshare` (우선순위 95) — 프로젝트의 `.omp/skills.lock.json` 또는 사용자 에이전트 디렉터리의 `skills.lock.json`에 고정된 패키지. Skillshare 저장소에서 불러옵니다. 이름 충돌 시 직접 작성한 스킬이 여전히 우선합니다.
3. `omp-plugins` (우선순위 90) — `extensions:`, `--extension`/`-e`로 불러온 확장 기능 패키지 옆에 포함된 `skills/`, 또는 `~/.omp/plugins/node_modules` 아래에 설치된 플러그인의 스킬
4. `claude` (우선순위 80)
5. `agent-plugins` (우선순위 75) — 표준 루트 `plugin.json`을 가진 이식 가능한 패키지. 일반 플러그인 제공업체는 이 제공업체에 스킬/MCP 탐색을 위임합니다.
6. 우선순위 70 그룹(등록 순서):
   - `claude-plugins`
   - `agents`
   - `codex`
7. `opencode` (우선순위 55)
8. `github` (우선순위 30) — `.github/skills/<name>/SKILL.md` (GitHub Agent Skills 구조, 프로젝트 전용)
9. `omp-managed` (우선순위 5) — `~/.omp/agent/managed-skills` 아래의 자동 학습 스킬. `src/discovery/builtin.ts`에 등록되며 조건 없이 탐색합니다(작성/권유 기능만 `autolearn.enabled`로 제어). 이름이 같은 직접 작성한 스킬이 항상 우선합니다.

기능 중복 제거 키는 스킬 이름입니다. 중복 제거된 `items` 뷰에서는 같은 이름 중 첫 항목이 우선합니다. `loadSkills()`는 이름 충돌을 별도로 해결합니다("이름 충돌과 중복 처리" 참조).

### 출처 전환과 필터링

`loadSkills()`는 다음 제어 설정을 적용합니다.

- 출처 전환: `enableCodexUser`, `enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject`, `enableAgentsUser`, `enableAgentsProject`
- `disabledExtensions`의 `skill:<name>` 항목
- `ignoredSkills` (제외, glob 패턴)
- `includeSkills` (포함 허용 목록, glob 패턴. 비어 있으면 모두 포함)

필터 적용 순서:

1. `disabledExtensions`로 비활성화되지 않았는지 확인
2. 출처가 활성화되어 있는지 확인
3. 무시 대상이 아닌지 확인
4. 포함 대상인지 확인(포함 목록이 있을 때)

`agents` 제공업체(`.agent[s]/skills`)에는 독립적인 `enableAgentsUser`/`enableAgentsProject` 전환 설정이 있습니다. Claude/Codex/Pi를 꺼도 이 제공업체는 **꺼지지 않습니다**. 외부 사용자 수준 제공업체는 `enabledProviders`로 선택해서 켜야 하지만, 해당 프로젝트 루트는 기본적으로 불러옵니다. 네이티브 OMP 출처와 `~/.omp/plugins`에 등록된 마켓플레이스 플러그인도 기본적으로 불러옵니다. `claude-plugins`에서는 이 선택 설정이 Claude Code 자체 사용자 레지스트리의 플러그인만 제어합니다.

### 이름 충돌과 중복 처리

- 기능 중복 제거는 중복 제거된 `items` 뷰에서 이름마다 첫 스킬(우선순위가 가장 높은 제공업체)을 유지합니다. `loadSkills()`는 중복 제거 전 전체 집합으로 작업하므로 낮은 우선순위의 복사본도 검사할 수 있습니다.
- 이후 `extensibility/skills.ts`는 다음을 처리합니다.
  - `realpath`로 같은 파일의 중복을 제거합니다(심볼릭 링크에도 안전).
  - 나중에 들어온 동명의 스킬이 이미 불러온 스킬과 본문이 같고 파싱한 프런트매터도 깊은 비교로 같으면 경고 없이 버립니다(예: 플러그인 복사본을 `~/.agents/skills`에도 복제하여 같은 스킬이 두 번 설치된 경우). 새 스킬이 기본 이름을 가진 기존 스킬보다 우선할 때는(아래 참조), 새 스킬이 대체하는 동일한 복사본들(기본 이름과 네임스페이스 별칭)을 대신 제거하므로 재정의 과정에서 자기 중복을 다시 받아들이지 않습니다.
  - 동명의 스킬이 서로 다르면 우선순위가 높은 스킬은 기본 이름을 유지하고 나머지 변형에는 `<namespace>/<name>`을 붙이며, 충돌 경고에 경로를 표시합니다. 우선순위: 직접 작성한 스킬은 레지스트리 설치 패키지(`skillshare` 제공업체, `omp skill install`)보다 우선하고, 사용자 지정 디렉터리 스킬은 제공업체 스킬보다 우선합니다(#7190). 그 밖에는 먼저 받아들인 스킬(제공업체는 제공업체 우선순위 순서, 사용자 지정 디렉터리는 `skills.customDirectories` 배열 순서)이 기본 이름을 유지합니다. 제공업체가 플러그인 식별자를 추적하면 제공업체 메타데이터의 플러그인 식별자가 네임스페이스가 됩니다. 레지스트리 기반 제공업체는 모두 이를 제공합니다. `claude-plugins`와 `agent-plugins`는 플러그인 이름, `omp-plugins`는 확장 기능 패키지 이름, `skillshare`는 패키지 이름을 사용합니다. 따라서 설치된 플러그인의 네임스페이스는 캐시 경로의 버전 부분이 아니라 자체 이름이며, 플러그인을 업데이트해도 유지됩니다. 그렇지 않으면 스킬의 `skills/` 트리를 소유한 디렉터리 또는 스킬 루트 디렉터리의 이름을 사용하고, `~/.claude/skills` 같은 점으로 시작하는 홈 디렉터리에서는 제공업체 ID로 대체합니다. 네임스페이스가 붙은 자리도 다른 스킬이 차지하고 있으면 `~2`, `~3`, … 접미사를 붙입니다. 서로 다른 스킬은 경고 없이 삭제하지 않습니다.
  - 모든 제공업체와 사용자 지정 디렉터리에서 원본 프런트매터 `name`에 `/` 또는 `\`가 있으면 경고와 함께 거부합니다. 이 구분자는 네임스페이스 형식과 `skill://<name>/<path>` 해석에 예약되어 있으므로, 원본 이름으로 네임스페이스 주소를 차지할 수 없습니다.
  - 편의 API인 `loadSkillsFromDir({ dir, source })`는 `scanSkillsFromDir`의 얇은 어댑터로 유지합니다.
- 네임스페이스가 붙은 스킬은 `skill://<namespace>/<name>[/<path>]`와 `/skill:<namespace>/<name>` 토큰으로 해석됩니다. 토큰은 프롬프트 맨 앞이나 중간에서 사용할 수 있습니다(중간 토큰은 `/`를 정확히 하나만 허용하며, 더 깊은 경로는 일반 텍스트로 남김). 스킬 이름에는 `/`가 없으므로 정확한 `<host>/<first segment>` 일치는 모호하지 않으며, 첫 경로 부분을 네임스페이스와 이름이 같은 기본 스킬의 상대 경로로 해석하는 것보다 우선합니다.
- 사용자 지정 디렉터리 스킬은 제공업체 스킬 다음에 병합되며, 받아들인 순서와 관계없이 동명의 기본 경로 제공업체 스킬보다 우선합니다(#7190). 사용자 지정 디렉터리 스킬은 기본 이름을 유지하며, 제공업체 스킬이 다르면 네임스페이스가 붙은 이름(이미 사용 중이면 접미사 추가)으로 다시 받아들이고 같으면 제거합니다. 사용자 지정 디렉터리 두 개 사이에서는 `skills.customDirectories`의 첫 디렉터리가 기본 이름을 유지하고 나머지에는 네임스페이스를 붙입니다.
- `disabledExtensions` (`skill:<name>`)와 `skills.ignoredSkills`는 원본 이름과 최종 이름 모두에 적용하므로 네임스페이스 별칭으로 제외를 우회할 수 없습니다. `skills.includeSkills`는 모든 이름이 확정된 뒤 최종 목록에만 적용하므로, 충돌한 기본 스킬 자체를 포함하지 않더라도 `second/*`로 네임스페이스 스킬을 선택할 수 있습니다.

## 런타임 사용 동작

### 시스템 프롬프트에 노출

시스템 프롬프트 구성(`src/system-prompt.ts`)은 발견된 스킬을 다음과 같이 사용합니다.

- 활성 도구가 `readsSkillUris: true`를 선언하면:
  - 숨김 스킬을 제외한 발견된 스킬 목록을 포함합니다.
  - 기능 메타데이터가 투영된 마운트된 `xd://` 도구도 포함하여 판단합니다.
- 그렇지 않으면:
  - 발견된 목록을 생략합니다.

도구 메타데이터가 제공되지 않으면 프롬프트 빌더는 호환성 대체 수단으로 `read`의 존재 여부를 사용합니다.

`hide: true`는 스킬을 비활성화하지 않습니다. 숨김 스킬도 불러오며, 스킬 명령이 활성화되어 있으면 `skill://<name>`과 `/skill:<name>`으로 계속 접근할 수 있습니다.

Task 도구의 하위 에이전트는 일반 세션 생성 과정을 통해 세션의 발견된/제공된 스킬 목록을 받습니다. 작업별로 스킬을 고정하는 재정의는 없습니다.

### 대화형 `/skill:<name>` 명령

`skills.enableSkillCommands`가 true이면 대화형 모드에서 발견된 스킬마다 슬래시 명령을 등록합니다.

`/skill:<name> [args]` 동작:

- 기존의 맨 앞 형식과 일반 문장 안에서 공백으로 구분된 `/skill:<name>` 토큰을 인식합니다.
- 문장 안의 토큰은 제거하고 주변 문장을 인수로 전달합니다.
- 입력 초안이 다른 슬래시 명령이나 로컬 bash/Python 실행 기호로 시작하면 문장 안의 토큰을 호출로 취급하지 않습니다.
- `filePath`에서 스킬 파일을 직접 읽습니다.
- 프런트매터를 제거합니다.
- 본문에 스킬 이름, 기본 디렉터리, 선택적 사용자 인수를 덧붙여 감싼 뒤 사용자 지정 메시지로 주입합니다.
- 전달 모드는 **제출 키 바인딩**을 따릅니다.
  - **Enter** → 스트리밍 중이면 `steer` 대기열로 스킬을 호출하고(일반 텍스트 Enter도 진행 중인 작업에 개입하는 것과 동일), 에이전트가 스트리밍 중이 아니면 일반 유휴 프롬프트로 호출합니다.
  - **Ctrl+Q / Ctrl+Enter** (기본 `app.message.followUp` 바인딩) → 스트리밍 중이면 `followUp` 대기열로 스킬을 호출하고, 스트리밍 중이 아니면 일반 유휴 프롬프트로 호출합니다.

전달 모드를 재정의하는 플래그, 모드 선택기, 프런트매터 설정은 없습니다. 키 바인딩 자체가 선택이며 스트리밍 중 일반 텍스트 라우팅과 같습니다. 두 제출 경로 모두 `input-controller.ts`의 `#invokeSkillCommand`를 거쳐 `src/modes/skill-command.ts`의 `invokeSkillCommandFromText`로 위임합니다.

호출된 스킬 콘텐츠는 호출 종류로 구분하며, 각각 고유한 프롬프트 템플릿을 사용합니다(`src/prompts/skills/`에 위치, `src/extensibility/skills.ts`의 `buildSkillPromptMessage`로 렌더링).

- **사용자 호출** (`/skill:<name>`이 사용하는 `user-invocation.md`): 사용자가 스킬을 호출했다는 안내로 메시지를 시작하고 스킬 본문을 포함한 뒤, 상대 경로(스크립트, 템플릿)를 스킬 디렉터리 기준으로 해석하라는 지침과 함께 스킬 디렉터리(`[Skill directory: <baseDir>]`) 및 선택적 `User: <args>`를 덧붙입니다.
- **자동 로드** (`autoload.md`): 본문 뒤에 `Skill: <path>`와 선택적 `User: <args>`만 붙이는 최소한의 출처 형식입니다. 하위 에이전트가 에이전트 프런트매터의 `autoloadSkills`로 선언된 스킬을 자동 주입할 때 사용하며, 이 숨김 메시지는 사용자가 호출했다고 주장하면 안 됩니다.

## `skill://` URL 동작

`src/internal-urls/skill-protocol.ts`는 다음을 지원합니다.

- `skill://<name>` → `read`에서는 해당 스킬의 `SKILL.md`로 해석됩니다. `bash`에서는 스킬 디렉터리이며(지침은 `skill://<name>/SKILL.md`), `realpath`/`readlink`는 물리 경로를 출력합니다.
- `skill://<name>/<relative-path>` → 해당 스킬 디렉터리 내부로 해석됩니다.

```text
skill:// URL 해석

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

보호 규칙:
- 절대 경로 거부
- `..` 경로 이동 거부
- <pdf-base> 밖으로 벗어나는 해석된 경로 거부
```

해석 세부 사항:

- 스킬 이름은 정확히 일치해야 합니다.
- 상대 경로는 URL 디코딩합니다.
- 절대 경로는 거부합니다.
- 경로 이동(`..`)은 거부합니다.
- 해석된 경로는 어휘적 경로 기준으로 `baseDir` 안에 남아야 합니다.
- Agent Plugins와 Skillshare 스킬은 패키지 루트 내부인지 realpath 검사도 수행하여 심볼릭 링크 이탈을 방지합니다. 같은 패키지 내부의 다른 위치를 가리키는 심볼릭 링크는 허용합니다.
- 디렉터리이면 디렉터리 목록을 반환합니다.
- 파일이 없으면 명시적인 `File not found` 오류를 반환합니다.

콘텐츠 유형:

- Markdown paths => `text/markdown`
- `.json` => `application/json`
- 그 외 파일 => `text/plain`

자산이 없을 때 대체 경로를 검색하지 않습니다.

MCP가 알리는 스킬:

- `skill://` URL의 이름을 소유한 로컬 스킬이 없으면, `read`는 MCP 서버가 정확히 그 URI로 알리는 리소스를 제공합니다(예: Figma의 `skill://figma/figma-use/SKILL.md`). `mcp://skill://…`와 비슷하지만 줄 선택기를 지원합니다. 소유권은 위와 같이 정규화한 URL로 판단하므로 불러온 기본/네임스페이스 스킬이 항상 우선합니다. URI 템플릿은 명시적인 `mcp://`를 통해서만 일치시킵니다.
- `mcp://` 읽기와 똑같이, 아직 연결 중이거나 리소스를 나열 중인 MCP 서버가 있으면 기다린 후 `Unknown skill`을 보고합니다. 대기는 MCP 연결/요청 제한 시간으로 제한되며 읽기를 취소하면 끝납니다.
- 로컬 파일이 필요한 동작(`%load`, 계획 모드 쓰기 검사, `:img` 선택기)은 MCP에 접속하지 않고 `Unknown skill`을 보고합니다.
- MCP가 제공하는 텍스트에는 `read`의 일반 결과 제한이 유지되며, 로컬 스킬 파일만 전체를 읽습니다.
- `omp read`는 읽기가 MCP 리소스에 도달할 때만 MCP 서버를 시작하므로, 로컬 스킬을 읽어도 서버가 실행되지 않습니다.

## 스킬과 AGENTS.md, 명령, 도구, 훅의 차이

### 스킬과 AGENTS.md

- **스킬**: 작업 맥락에 따라 선택하거나 명시적으로 요청하는, 이름이 있는 선택적 기능 묶음
- **AGENTS.md/컨텍스트 파일**: 컨텍스트 파일 기능으로 불러오고 수준/깊이 규칙에 따라 병합하는 지속적인 지침 파일

`src/discovery/agents-md.ts`는 `cwd`부터 상위 디렉터리를 순회하여 독립적인 `AGENTS.md` 파일을 찾습니다. 저장소가 사용자 홈 디렉터리 아래에 중첩되어 있으면, 홈 디렉터리 자체는 제외하고 그 아래의 둘러싼 워크스페이스 디렉터리까지 계속 탐색합니다. 홈 아래에 저장소 루트가 없으면 홈 경계도 포함합니다. 그 밖에는 저장소 루트에서 멈추며, 홈 바깥에서 알려진 저장소 루트가 없으면 파일 시스템 루트에서 멈춥니다. 숨김 소유 디렉터리의 파일은 건너뜁니다.

### 스킬과 슬래시 명령

- **스킬**: 모델이 읽을 수 있는 지식/워크플로 콘텐츠
- **슬래시 명령**: 사용자가 호출하는 명령 진입점
- `/skill:<name>`은 스킬 텍스트를 주입하는 편의 래퍼이며, 스킬 탐색 의미를 바꾸지 않습니다.

### 스킬과 사용자 지정 도구

- **스킬**: 프롬프트 컨텍스트와 `read`로 불러오는 문서/워크플로 콘텐츠
- **사용자 지정 도구**: 스키마와 런타임 부수 효과를 가지며 모델이 호출할 수 있는 실행 가능한 도구 API

### 스킬과 훅

- **스킬**: 수동적인 콘텐츠
- **훅**: 실행 도중 동작을 차단/수정할 수 있는 이벤트 기반 런타임 인터셉터

## 탐색 로직에 맞춘 실용적인 작성 지침

- 각 스킬을 별도의 디렉터리에 둡니다: `<skills-root>/<skill-name>/SKILL.md`
- 프런트매터에 명시적인 `name`과 `description`을 항상 포함합니다.
- 참조 자산은 같은 스킬 디렉터리 아래에 두고 `skill://<name>/...`로 접근합니다.
- 중첩된 분류 체계(`team/domain/skill`)를 사용하려면 `skills.customDirectories`가 중첩된 상위 디렉터리를 가리키도록 설정합니다. 탐색 자체는 여전히 비재귀적입니다.
- 이름 충돌 시 우선순위가 높은 스킬이 기본 이름을 유지합니다. 동일한 복사본은 하나로 합치며, 서로 다른 복사본은 네임스페이스로 계속 접근할 수 있습니다.
