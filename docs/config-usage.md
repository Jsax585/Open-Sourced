<a id="configuration-discovery-and-resolution"></a>
# 구성 검색 및 해석

이 문서는 coding-agent가 현재 구성을 해석하는 방식을 설명합니다. 어떤 루트를 스캔하는지, 우선순위가 어떻게 작동하는지, 해석된 구성을 설정, 스킬, 훅, 도구, 확장 기능에서 어떻게 사용하는지 다룹니다.

<a id="scope"></a>
## 범위

주요 구현:

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts` (`config.ts`에서 다시 내보냄)
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/registry.ts` (설정 정의, 타입이 지정된 핸들)
- `packages/coding-agent/src/config/all-settings.ts` (모든 도메인의 `settings.ts` 정의를 가져옴)
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

주요 통합 지점:

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

<a id="resolution-flow-visual"></a>
## 해석 흐름(시각화)

```text
         범용 헬퍼 순서 (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        기능 제공업체가 항목을 열거
 (네이티브 제공업체는 사용자 .omp보다 프로젝트 .omp를 먼저 스캔하며,
  다른 제공업체는 자체 로딩 규칙을 따름)
                    │
                    ▼
      제공업체 우선순위 정렬 + 기능 중복 제거
                    │
                    ▼
          하위 시스템별 사용
   (설정, 스킬, 훅, 도구, 확장 기능)
```

<a id="1-config-roots-and-source-order"></a>
## 1) 구성 루트와 소스 순서

<a id="canonical-roots"></a>
## 표준 루트

`src/config.ts`는 고정된 소스 우선순위 목록을 정의합니다.

1. `.omp` (네이티브)
2. `.claude`
3. `.codex`
4. `.gemini`

사용자 수준 기본 경로:

- OMP 네이티브: `~/<PI_CONFIG_DIR>/agent` (일반적으로 `~/.omp/agent`; 이름 있는 프로필을 사용하면 아래 설명에 따라 변경됨)
- Claude의 활성 구성 디렉터리 (기본값은 `~/.claude`; `CLAUDE_CONFIG_DIR`로 재정의)
- `~/.codex`
- `~/.gemini`

프로젝트 수준 기본 경로:

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME`은 `.omp`입니다(`packages/utils/src/dirs.ts`). `PI_CONFIG_DIR`는 범용 헬퍼가 사용하는 OMP 사용자 루트를 변경합니다. `PI_CODING_AGENT_DIR`는 이와 다릅니다. 기본 프로필에서는 네이티브 검색, 설정, 런타임 상태 등 `getAgentDir()`를 사용하는 곳에 영향을 주지만, 범용 `getConfigDirs()` / `findConfigFile()`의 OMP 기본 경로는 변경하지 **않습니다**. 이름 있는 프로필은 `PI_CODING_AGENT_DIR`를 무시합니다.

<a id="profiles"></a>
## 프로필

이름 있는 프로필(`omp --profile <name>`, `OMP_PROFILE` 또는 레거시 대체 변수 `PI_PROFILE`)은 OMP 사용자 기본 경로를 옮깁니다. `OMP_PROFILE`이 정의되어 있으면 명시적으로 빈 값인 경우까지 포함해 우선 적용됩니다. `default`, 빈 값 또는 공백은 기본 프로필을 선택합니다. 프로필이 활성화되면 이 문서에서 `~/.omp/agent/...`로 표기한 모든 OMP 네이티브 사용자 수준 경로는 일반적으로 `~/.omp/profiles/<name>/agent/...`로 해석됩니다. `--alias <command>` 자체로는 프로필을 선택하지 않습니다. `--profile`과 함께 사용하면 해당 프로필의 셸 바로가기를 만듭니다.

이름 있는 프로필이 활성화된 동안 상태 표시줄의 `pi` 세그먼트는 브랜드에 프로필 이름을 붙입니다(`π-work`, 또는 턴 실행 중에는 `⠋-work 12s`). 따라서 서로 다른 프로필의 세션을 한눈에 구분할 수 있습니다. 기본 프로필에는 기호만 표시됩니다. 각 프로필에 이미 별도의 테마가 있는 경우처럼 모든 프로필에서 기호만 유지하려면 `statusLine.segmentOptions.pi.showProfile: false`를 설정하세요.

이 경로 이동은 네이티브 제공업체(`builtin.ts`)와 범용 `config.ts` 헬퍼에 동일하게 적용됩니다. 따라서 슬래시 명령, 규칙, 프롬프트, 지침, 훅, 도구, 확장 기능, 설정, 스킬, MCP뿐 아니라 최상위 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 파일과 런타임 상태(세션, 블롭, `agent.db`)에도 적용됩니다. 프로필은 자체 OMP 구성만 보며, 기본 프로필의 에이전트 구성은 보지 않습니다.

키 바인딩은 유일한 예외입니다. 이름 있는 프로필은 기본 프로필의 `~/.omp/agent/keybindings.*`를 자체 `~/.omp/profiles/<name>/agent/keybindings.*` 아래에 병합하며, 프로필 파일이 바인딩별로 우선 적용됩니다([#4867](https://github.com/can1357/oh-my-pi/issues/4867)). 키 바인딩은 사용자가 사용하는 터미널/키보드를 정의하며, 이는 활성 프로필에 따라 바뀌지 않습니다. 따라서 프로필에서 명시적으로 재정의하지 않는 한 사용자 수준 키 재매핑은 모든 프로필에서 계속 작동합니다. 상속된 파일은 프로필 프로세스에서 읽기 전용입니다. 기본 프로필 파일의 레거시 형식 마이그레이션은 기본 프로필 자체가 실행될 때만 이루어집니다.

macOS와 Linux에서는 기존 `$XDG_DATA_HOME/omp`, `$XDG_STATE_HOME/omp` 또는 `$XDG_CACHE_HOME/omp`가 각각 데이터, 상태 또는 캐시 경로를 옮길 수 있습니다. 이름 있는 프로필의 경우, OMP는 해당 XDG 범주에 이미 `omp/profiles/<name>`이 있을 때만 그 범주를 사용합니다. 그렇지 않으면 해당 범주는 `~/.omp/profiles/<name>` 아래에 유지됩니다. XDG 경로를 사용하려면 먼저 `omp config init-xdg`를 실행하세요.

다른 소스 기본 경로는 프로필 범위에 속하지 않으며 모든 프로필에서 동일하게 로드됩니다. 외부 도구 기본 경로(`~/.claude`, `~/.codex`, `~/.gemini`)는 해당 도구에 속하고, 프로젝트 수준 기본 경로(`<cwd>/.omp`, `<cwd>/.claude`, ...)는 작업 디렉터리를 기준으로 합니다. 이 문서 전체에서 환경 변수 재정의나 XDG 경로를 설명하는 경우가 아니라면 `~/.omp/agent`를 활성 프로필의 에이전트 디렉터리를 줄여 쓴 것으로 이해하세요.

<a id="important-constraint"></a>
## 중요한 제약 사항

`src/config.ts`의 범용 헬퍼는 소스 검색 순서에 `.pi`를 포함하지 **않습니다**.

---

<a id="2-core-discovery-helpers-srcconfigts"></a>
## 2) 핵심 검색 헬퍼 (`src/config.ts`)

<a id="getconfigdirssubpath-options"></a>
## `getConfigDirs(subpath, options)`

다음 순서로 정렬된 항목을 반환합니다.

- 사용자 수준 항목이 먼저 옴(소스 우선순위순)
- 그다음 프로젝트 수준 항목이 옴(동일한 소스 우선순위순)

옵션:

- `user` (기본값 `true`)
- `project` (기본값 `true`)
- `cwd` (기본값 `getProjectDir()`)
- `existingOnly` (기본값 `false`)

이 API는 디렉터리 기반 구성 조회(명령, 훅, 도구, 에이전트 등)에 사용됩니다.

비활성화된 외부 사용자 소스(`isUserSourceEnabled`)는 사용자 항목에서 제외됩니다. 프로젝트 항목은 이 헬퍼에서 필터링하지 않습니다. Claude 사용자 경로는 `CLAUDE_CONFIG_DIR`를 따릅니다(앞뒤 공백을 제거하고 프로세스 작업 디렉터리를 기준으로 해석).

<a id="findconfigfilesubpath-options--findconfigfilewithmeta"></a>
## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

순서대로 나열된 기본 경로에서 처음으로 존재하는 파일을 검색하고, 첫 번째 일치 항목을 반환합니다(경로만 또는 경로+메타데이터).

<a id="findallnearestprojectconfigdirssubpath-cwd"></a>
## `findAllNearestProjectConfigDirs(subpath, cwd)`

상위 디렉터리를 거슬러 올라가며 **각 소스 기본 경로별로 가장 가까운 기존 디렉터리**(`.omp`, `.claude`, `.codex`, `.gemini`)를 반환한 뒤, 결과를 소스 우선순위로 정렬합니다.

프로젝트 구성을 상위 디렉터리에서 상속해야 할 때 사용하세요(모노레포/중첩 워크스페이스 동작).

---

<a id="3-file-config-wrapper-configfilet-in-srcconfigconfig-filets-re-exported-from-srcconfigts"></a>
## 3) 파일 구성 래퍼 (`src/config/config-file.ts`의 `ConfigFile<T>`, `src/config.ts`에서 다시 내보냄)

`ConfigFile<T>`는 단일 구성 파일에 대해 스키마 검증을 수행하는 로더입니다.

지원 형식:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

동작:

- 파싱한 데이터를 제공된 omptype 스키마로 검증합니다.
- `.yml` 대상은 `.yml`이 없으면 같은 디렉터리의 대응하는 `.yaml`을 사용합니다. 기존 `.yaml`이 있으면 JSON 마이그레이션도 수행하지 않습니다. `.yaml` 대상은 `.yml`로 대체되지 않습니다.
- `.json`과 `.jsonc` 모두 JSONC로 파싱합니다.
- `invalidate()`가 호출될 때까지 로드 결과를 캐시합니다.
- `tryLoad()`를 통해 세 가지 상태의 결과를 반환합니다.
  - `ok`
  - `not-found`
  - `error` (스키마/파싱 컨텍스트를 포함한 `ConfigError`)

레거시 마이그레이션도 계속 지원합니다.

- 대상 경로가 `.yml`/`.yaml`이면 같은 디렉터리의 대응하는 `.json`을 한 번 자동 마이그레이션합니다(`migrateJsonToYml`).

---

<a id="4-settings-resolution-model-srcconfigsettingsts"></a>
## 4) 설정 해석 모델 (`src/config/settings.ts`)

<a id="definitions-srcconfigregistryts"></a>
### 정의 (`src/config/registry.ts`)

각 설정은 해당 도메인의 설정 모듈(예: `src/tools/settings.ts`, `src/session/settings.ts`, `src/config/model-settings.ts`)에서 `register({ id, type, default, env?, protocolDefault?, validate?, pathScoped?, credential?, ui? })`로 한 번 선언됩니다. `src/config/all-settings.ts`는 설정 패널 순서대로 모든 도메인을 가져옵니다. `register`는 타입이 지정된 `Setting` 핸들(`cfgX`)을 반환하며, 코드는 문자열 키 대신 이 핸들을 통해 읽고 씁니다.

- `cfgX.get(scope)` — 실효 값입니다. `scope`는 `Settings` 인스턴스이거나 이를 포함하는 객체(`AgentSession`, `ToolSession`)입니다. 읽기 결과는 범위별로 메모이제이션됩니다.
- `cfgX.set(scope, v)` — **전역** 계층에 쓰고 백그라운드 저장을 대기열에 넣습니다. 정의의 타입이 거부하는 값은 예외를 발생시킵니다.
- `cfgX.unset(scope)` — 전역 계층에서 키를 제거합니다(`omp config reset`이나 설정 패널 텍스트 필드 지우기가 하는 동작). 따라서 이후 기본값 변경도 계속 적용됩니다.
- `cfgX.setEntry(scope, key, v)` / `cfgX.setMember(scope, item, { member })` — 전역 계층에서 레코드 설정의 항목 하나를 쓰거나(`undefined`는 제거), 목록 설정의 항목 하나를 추가/제거합니다. 저장 시 `config.yml`의 해당 항목만 변경하므로 다른 계층(`--config` 오버레이)이 제공한 항목이 그 파일에 저장되는 일은 없습니다.
- `cfgX.override(scope, v)` / `cfgX.clearOverride(scope)` — 런타임 전용 재정의이며 영구 저장되지 않습니다.
- `cfgX.map(fn)` / `combine({...}, fn)` — 메모이제이션된 파생 값입니다. `.listen(scope, cb)`는 핸들 또는 파생 값의 변경을 관찰합니다.
- `cfgX.provenance(scope)` — 값을 제공하는 계층: `"env" | "runtime" | "overlay" | "project" | "global" | "default"`.
- `cfgX.layered(scope)` — 환경 변수를 무시하고 설정 계층만으로 얻은 값입니다(설정 패널에서 표시하고 편집하는 값).

선언된 타입(또는 열거형 값)에 맞지 않는 구성 값은 경고와 함께 무시되고 기본값이 사용됩니다. 정의의 `validate`는 로드할 때, 매번 다시 로드할 때, 그리고 쓰기 전에 잘못된 값을 거부합니다. 마지막 정상 값을 유지하는 감시자 재로드와 `config.yml`의 외부 편집을 병합하는 저장은 잘못된 파일의 계층만 마지막 정상 값으로 유지하며(경고에 파일 이름 표시), 다른 계층은 계속 갱신합니다. 구성된 `null`은 일반적으로 미설정으로 간주합니다. 모델 역할 및 모델 프리셋 같은 레코드 항목은 런타임 또는 오버레이 계층에서 `null`을 삭제 표식으로 사용해 하위 계층 항목을 숨길 수 있습니다. 프로젝트/전역의 null 항목은 계속 미설정으로 취급됩니다.

<a id="layers-srcconfigsettingsts"></a>
### 계층 (`src/config/settings.ts`)

실효 우선순위는 높은 순서대로 다음과 같습니다.

1. 정의에 선언된 환경 변수(`env: "NAME"`): 설정의 타입으로 파싱하며, 파싱할 수 없는 텍스트는 미설정으로 간주합니다. 불리언은 `parseFlag`를 따릅니다. 빈 값은 미설정, `1`/`y`/`true`/`yes`/`on`(소문자 또는 대문자)은 true, 그 밖의 텍스트는 모두 false입니다
2. 런타임 재정의: 메모리에만 존재하며 영구 저장되지 않음
3. 구성 오버레이: `PI_CONFIG_FILES`(플랫폼별 경로 목록) 다음에 반복 지정한 `omp --config <path>` 파일이 이어짐. 모두 이 프로세스에 한해 `config.yml` 스타일 YAML로 로드됨
4. 프로젝트 설정: 설정 기능을 통해 검색됨(제공업체의 `settings.json` 및 `config.yml`)
5. 전역 설정: `~/.omp/agent/config.yml`과 `config.yaml` 중 먼저 존재하는 파일
6. 정의의 기본값

정의는 대신 `env: { name, fallback: true }`를 선언할 수 있습니다. 이 변수는 기본값만 대체하며, 어느 계층이든 null이 아닌 값을 구성하면 그 값이 우선합니다(`SEARXNG_BASIC_*`에서 사용). `fallback: "blank"`는 구성된 값이 빈 문자열이나 공백 문자열일 때도 변수가 우선하도록 합니다(`SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, `MNEMOPI_EMBEDDING_MODEL`에서 사용).

오버레이 목록 내에서는 뒤의 파일이 앞의 파일을 재정의합니다(`PI_CONFIG_FILES` 항목이 `--config` 파일보다 먼저 로드됨). 오버레이 경로는 `~`를 확장한 뒤 활성 프로젝트 디렉터리를 기준으로 해석됩니다.

`protocolDefault: ["rpc", "acp"]`를 지정한 정의는 RPC/ACP 호스트가 정의의 기본값에서 시작하도록 합니다. 시작 시 `applyProtocolDefaults`(`src/main.ts`)는 값이 이미 구성되어 있지 않으면 기본값을 소프트 런타임 재정의로 고정합니다. 이 고정은 해당 설정의 `cfgX.set`/`cfgX.unset`/`cfgX.setEntry`/`cfgX.setMember` 호출(설정 패널, 에이전트 허브, `cfg://`), 해당 설정을 구성한 영구 저장 계층을 발견한 재로드(RPC 파일 감시자가 감지한 `config.yml` 편집), 그리고 해당 설정이 구성된 프로젝트로의 범위 재지정 또는 복제(ACP 세션 자체의 프로젝트 구성)에 의해 해제됩니다.

하위 에이전트는 `parent.overlay(overrides)`를 받습니다. 읽기는 상위의 현재 값으로 위임되지만, 재정의와 이후의 모든 쓰기는 하위에만 남고 영구 저장되지 않습니다.

일반적인 설정 핸들 쓰기는 전역 계층을 대상으로 하며, 구성 오버레이는 읽기 전용입니다. 모델 역할에는 명시적인 프로젝트 쓰기 API가 있습니다. `setProjectModelRole()` / `clearProjectModelRole()`은 프로젝트 계층을 업데이트하고 변경된 역할만 `<cwd>/.omp/config.yml`에 저장합니다. 기존 런타임 재정의가 역할을 가리게 되는 경우, 프로젝트 역할을 설정하면 해당 재정의를 일시적으로 대체하고 지우면 해당 런타임 슬롯을 제거합니다. 원래 재정의는 프로젝트 범위 변경 시 복원할 수 있도록 보관됩니다.

<a id="settings-load-failures"></a>
### 설정 로드 실패

- 전역/프로젝트 YAML이 없으면 빈 구성으로 취급합니다.
- 잘못된 전역 또는 네이티브 프로젝트 YAML은 파일 잠금 상태에서 같은 디렉터리의 고유한 `.broken-<timestamp>-<pid>-<uuid>` 파일로 이동한 다음, 원본 및 백업 경로를 표시하며 시작에 실패합니다. 읽을 수 없는 파일은 이동하지 않고 실패합니다.
- 모든 `PI_CONFIG_FILES` / `--config` 오버레이는 엄격하게 처리됩니다. 파일 누락, 잘못된 YAML, 매핑이 아닌 문서 루트는 치명적 오류입니다. 오버레이 파일은 격리하지 않습니다.

<a id="migration-behavior-still-active"></a>
## 현재도 활성화된 마이그레이션 동작

시작 시 전역 `config.yml`과 `config.yaml`이 모두 없으면 다음을 수행합니다.

1. `~/.omp/agent/settings.json`에서 마이그레이션(성공하면 `.bak`으로 이름 변경)
2. `agent.db`의 레거시 DB 설정과 병합(충돌 시 DB 값 우선)
3. 병합 결과를 `config.yml`에 기록

`#migrateRawSettings`의 필드 수준 마이그레이션:

- `queueMode` -> `steeringMode`
- 레거시 평면 구조 `theme: "..."` -> `theme.dark/theme.light` 구조

---

<a id="5-capabilitydiscovery-integration"></a>
## 5) 기능/검색 통합

핵심 외 구성 로딩의 대부분은 기능 레지스트리(`src/capability/index.ts` + `src/discovery/index.ts`)를 거칩니다.

<a id="provider-ordering"></a>
## 제공업체 순서

제공업체는 숫자 우선순위로 정렬됩니다(높은 값 우선). 전체 목록:

- 네이티브 OMP (`builtin.ts`): `100`
- OMP 플러그인 (`omp-plugins`): `90`
- Claude: `80`
- Agent Plugins 표준 (`agent-plugins`): `75`
- Codex / agents / Claude 플러그인 마켓플레이스: `70`
- Gemini: `60`
- OpenCode: `55`
- Cursor / Windsurf: `50`
- Cline: `40`
- GitHub Copilot: `30`
- VS Code: `20`
- agents-md (`AGENTS.md` 파일) / claude-md (독립형 `CLAUDE.md` 파일): `10`
- mcp-json / ssh-json / managed-skills (자동 학습): `5`
- 내장 기본 규칙 (`builtin-defaults`): `1`

```text
제공업체 우선순위 (높은 값 우선)

native (.omp)           우선순위 100
omp-plugins             우선순위  90
claude                  우선순위  80
agent-plugins           우선순위  75
codex / agents /
  claude-plugins        우선순위  70
gemini                  우선순위  60
opencode                우선순위  55
cursor / windsurf       우선순위  50
cline                   우선순위  40
github                  우선순위  30
vscode                  우선순위  20
agents-md / claude-md   우선순위  10
mcp-json / ssh-json /
  managed-skills        우선순위   5
builtin-defaults        우선순위   1
```

<a id="dedup-semantics"></a>
## 중복 제거 의미 체계

기능은 `key(item)`을 정의합니다.

- 같은 키 => 첫 번째 항목이 우선(우선순위가 더 높거나 먼저 로드된 항목)
- 키 없음(`undefined`) => 중복 제거 없이 모든 항목 유지

관련 키:

- 스킬: `name`
- 도구: `name`
- 훅: `${type}:${tool}:${name}`
- 확장 기능 모듈: `name`
- 확장 기능: `name`
- 설정: 중복 제거 없음(모든 항목 유지)

---

<a id="6-native-omp-provider-behavior-packagescoding-agentsrcdiscoverybuiltints"></a>
## 6) 네이티브 `.omp` 제공업체 동작 (`packages/coding-agent/src/discovery/builtin.ts`)

네이티브 제공업체(`id: native`)는 다음 위치에서 네이티브 구성을 읽습니다.

- 프로젝트: `<cwd>/.omp/...`
- 사용자: `~/.omp/agent/...`

<a id="directory-admission-rules"></a>
### 디렉터리 사용 허용 규칙

- 슬래시 명령, 디렉터리 규칙, 프롬프트, 지침, 훅, 도구, 확장 기능, 확장 기능 모듈, 설정은 루트 디렉터리가 존재하고 비어 있지 않을 때만 프로젝트/사용자 루트를 사용합니다.
- 스킬은 현재 작업 디렉터리에서 저장소 루트/홈 경계까지 각 상위 디렉터리의 `<ancestor>/.omp/skills`와 `~/.omp/agent/skills`를 스캔하며, 루트 `.omp` 디렉터리 자체가 비어 있지 않아야 한다는 조건은 없습니다.
- `SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `RULES.md`, `.omp/AGENTS.md`는 사용자 수준 파일을 직접 읽고, 프로젝트 파일에는 가장 가까운 비어 있지 않은 상위 `.omp` 디렉터리를 사용합니다. 프로젝트 시스템 프롬프트 항목은 사용자 항목보다 먼저 로드됩니다. `RULES.md`는 항상 적용되는 고정 규칙이 됩니다. `SYSTEM.md` / `APPEND_SYSTEM.md`의 전체 동작 규약은 [`docs/system-prompt-customization.md`](./system-prompt-customization.md)를 참조하세요.
- MCP는 루트가 비어 있지 않은지 확인하는 사용 허용 헬퍼를 사용하지 않습니다. 프로젝트의 `.omp/mcp.json`, `.omp/.mcp.json`을 차례로 읽은 다음 사용자의 `mcp.json`, `.mcp.json`을 직접 읽습니다.

<a id="scope-specific-loading"></a>
### 범위별 로딩

- 스킬: `<ancestor>/.omp/skills/*/SKILL.md` 및 `~/.omp/agent/skills/*/SKILL.md`
- 관리형 스킬: 별도의 우선순위 5 제공업체를 통해 `~/.omp/agent/managed-skills/*/SKILL.md`를 로드합니다. 이름이 충돌하면 다른 제공업체의 작성된 스킬이 우선합니다. 검색은 조건 없이 수행됩니다. `autolearn.enabled`는 로딩이 아니라 쓰기/유도를 제어합니다.
- 슬래시 명령: `commands/*.md`
- 규칙: `rules/*.{md,mdc}`와 최상위 `RULES.md`
- 프롬프트: `prompts/*.md`
- 지침: `instructions/*.md`
- 훅: `hooks/pre/*`, `hooks/post/*`
- 도구: `tools/*.{json,md,ts,js,sh,bash,py}` 및 `tools/<name>/index.ts`
- 확장 기능 모듈: `extensions/` 아래에서 검색(+ 레거시 `settings.json.extensions` 문자열 배열)
- 확장 기능: `extensions/<name>/gemini-extension.json`
- 설정 기능: `settings.json`, 그다음 `config.yml`
- 컨텍스트 파일: `.omp/AGENTS.md`; 상위 디렉터리의 독립형 `AGENTS.md` 파일은 우선순위가 낮은 `agents-md` 제공업체가 별도로 로드

<a id="nearest-project-lookup-nuance"></a>
### 가장 가까운 프로젝트 조회의 세부 동작

`SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `RULES.md`, `.omp/AGENTS.md`의 경우 네이티브 제공업체는 가장 가까운 비어 있지 않은 프로젝트 `.omp` 디렉터리까지 상위로 탐색합니다.

<a id="7-how-major-subsystems-consume-config"></a>
## 7) 주요 하위 시스템의 구성 사용 방식

<a id="settings-subsystem"></a>
## 설정 하위 시스템

- `Settings.init()`은 위에서 설명한 우선순위에 따라 전역 YAML 파일, 검색된 프로젝트 설정, `PI_CONFIG_FILES` / `--config` 오버레이, 런타임 재정의를 로드합니다.
- `level === "project"`인 기능 항목만 프로젝트 계층에 병합됩니다.

<a id="session-title-prompt-override"></a>
### 세션 제목 프롬프트 재정의

범용 구성 기본 경로 중 아무 곳에나 `TITLE_SYSTEM.md`를 만드세요.

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- `TITLE_SYSTEM.md`가 없으면 번들로 제공되는 제목 프롬프트를 유지합니다. 이때 새 세션의 첫 제목은 첫 응답에서 분기해 생성됩니다. 응답의 첫 텍스트 또는 도구 호출 블록이 시작되면 세션 자체의 모델이 캐시된 접두부를 사용하는 별도 턴에서 `src/prompts/system/title-fork.md`에 답하면서 제목과 카드 인덱스(Nerd Fonts 아이콘, 이모지, 1~6자 코드)를 지정합니다. 창 제목에는 `<icon> <CODE>: <title>`로 표시됩니다. 분기가 실패하거나, 시간 초과되거나, 거절되거나, 응답이 시작되지 않으면 경량 제목 모델이 대신 처리합니다.
- `TITLE_SYSTEM.md`가 있으면 첫 제목은 분기를 건너뛰고 재정의를 사용하는 경량 제목 모델에서 생성되며, 재계획에 따른 갱신도 마찬가지입니다.
- 검색은 현재 프로젝트 디렉터리 기본 경로(`<cwd>/.omp`, `.claude`, `.codex`, `.gemini`)를 먼저 확인한 다음 범용 헬퍼 순서대로 사용자 기본 경로를 확인합니다. 네이티브 `SYSTEM.md`와 달리 프로젝트 제목 검색은 상위 디렉터리를 탐색하지 **않습니다**.
- 이 재정의는 자동 세션 제목 생성 시스템 프롬프트만 대체합니다. 일반적인 `SYSTEM.md` / `APPEND_SYSTEM.md` 프롬프트 사용자 지정에는 영향을 주지 않습니다.
- 온라인 경로는 제목 모델에 제목을 `<title>...</title>`로 감싸도록 요청하고 텍스트에서 관대하게 파싱합니다(일반 문장, 잘리거나 닫히지 않은 태그, 불필요하게 출력된 `{"title": "..."}` JSON도 모두 처리 가능). `TITLE_SYSTEM.md` 재정의 뒤에는 `<title>`로 감싸라는 지침이 추가됩니다. 로컬 경량 제목 경로는 `<title>...</title>` 사전 채움/중지 래퍼를 유지하고 이 파일을 시스템 턴으로 사용합니다.

<a id="skills-subsystem"></a>
## 스킬 하위 시스템

- `extensibility/skills.ts`는 `loadCapability(skillCapability.id, { cwd })`를 통해 로드합니다.
- 소스 토글과 필터(`ignoredSkills`, `includeSkills`, 사용자 지정 디렉터리)를 적용합니다.
- 레거시 이름의 토글(`skills.enablePiUser`, `skills.enablePiProject`)도 여전히 존재하지만, 네이티브 제공업체(`provider === "native"`)를 제어합니다.

<a id="hooks-subsystem"></a>
## 훅 하위 시스템

- `discoverExtensionPaths()`(`extensibility/extensions/loader.ts`)는 훅 기능의 `.ts`/`.js` 훅 경로를 확장 기능 모듈 목록에 추가합니다.
- 그런 다음 해당 모듈은 다른 확장 기능과 마찬가지로 확장 기능 로더와 실행기를 통해 로드되고 실행됩니다.

<a id="tools-subsystem"></a>
## 도구 하위 시스템

- `discoverAndLoadCustomTools()`는 도구 기능 + 플러그인 도구 경로 + 명시적으로 구성된 경로에서 도구 경로를 해석합니다.
- 선언형 `.md/.json` 도구 파일은 메타데이터만 포함합니다. 실행 가능한 로딩에는 코드 모듈이 필요합니다.

<a id="extensions-subsystem"></a>
## 확장 기능 하위 시스템

- `discoverAndLoadExtensions()`는 네이티브 확장 기능 모듈 기능 항목, JS/TS 훅 팩터리, 설치된 플러그인 진입점, 명시적으로 구성된 경로를 로드합니다.
- 주변 환경의 확장 기능 모듈 기능 검색은 명시적으로 `provider: "native"`로 제한됩니다. 이 단계에서는 외부 제공업체를 스캔하지 않습니다.

---

<a id="8-precedence-rules-to-rely-on"></a>
## 8) 기준으로 삼을 우선순위 규칙

다음과 같이 이해하면 됩니다.

1. `config.ts`의 소스 디렉터리 순서가 후보 경로 순서를 결정합니다.
2. 기능 제공업체 우선순위가 제공업체 간 우선순위를 결정합니다.
3. 기능 키 중복 제거가 충돌 동작을 결정합니다(키가 있는 기능은 첫 번째 항목 우선).
4. 하위 시스템별 병합 로직이 실효 우선순위를 추가로 바꿀 수 있습니다(특히 설정).

<a id="settings-specific-caveat"></a>
### 설정 관련 주의 사항

설정 기능 항목은 중복 제거되지 않습니다. `Settings.#loadProjectSettings()`는 반환된 순서대로 프로젝트 항목을 깊은 병합하므로, 뒤의 항목이 앞의 항목을 재정의합니다. 제공업체는 우선순위가 높은 순서에서 낮은 순서로 방문하므로, 우선순위가 낮은 제공업체의 설정이 높은 제공업체의 설정을 재정의할 수 있습니다. 네이티브 제공업체 내에서는 프로젝트 `config.yml`이 `settings.json` 뒤에 오며 이를 재정의합니다. 그런 다음 네이티브 `.omp/config.yml`의 모델 역할이 권위 있는 프로젝트 모델 역할 계층으로 다시 적용됩니다.

---

<a id="9-legacycompatibility-behaviors-still-present"></a>
## 9) 여전히 남아 있는 레거시/호환성 동작

- YAML을 대상으로 하는 파일의 `ConfigFile` JSON -> YAML 마이그레이션.
- `settings.json` 및 `agent.db`에서 `config.yml`로의 설정 마이그레이션.
- 필드 마이그레이션은 이름이 변경되거나 제거된 설정과 값 구조 변경을 처리합니다. 여기에는 `queueMode`, 변경 로그 설정, 평면 구조 `theme`, 폐기된 이미지 도구 설정, 작업 격리/즉시 실행 설정, 제거된 편집 및 컨텍스트 압축 모드, `inlineToolDescriptors`, 상태 표시줄 세그먼트, 제공업체/검색 설정, 메모리/hindsight 설정, 중첩 리프 이름 변경이 포함됩니다. 현재의 전체 목록은 `Settings.#migrateRawSettings()`를 참조하세요.
- 레거시 설정 이름 `skills.enablePiUser` / `skills.enablePiProject`는 네이티브 스킬 소스를 제어하는 설정으로 여전히 활성화되어 있습니다.

이러한 호환성 경로를 코드에서 제거하면 이 문서를 즉시 업데이트하세요. 현재도 여러 런타임 동작이 여기에 의존합니다.
