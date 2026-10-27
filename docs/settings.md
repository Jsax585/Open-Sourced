<a id="settings"></a>
# 설정

`omp`는 내장 기본값, 영속적인 전역 설정 파일, 선택적인 프로젝트 로컬 설정, 일회성 CLI 오버레이, 메모리 내 런타임 재정의에서 설정을 결정합니다. 하나의 저장소에서 전역 기본값과 다른 제공자 집합, 모델 역할, 도구 정책, 메모리 백엔드 또는 UI 동작이 필요하다면 프로젝트 설정을 사용하세요. 컴퓨터 전체 설정은 건드리지 않아도 됩니다.

설정은 일반 YAML 매핑으로 저장됩니다. 각 키, 타입, 기본값, 열거형 값은 해당 설정 정의에서 가져옵니다. 정의는 기능을 소유한 코드 옆에서 `register(...)`로 선언하며(예: `packages/coding-agent/src/tools/settings.ts`), `packages/coding-agent/src/config/all-settings.ts`에서 수집합니다. `omp config`는 전체 스키마를 제공하고, 대화형 `/settings` 패널은 지원되는 UI 편집기가 있는 항목을 제공합니다. 일부 항목은 조건부입니다. UI 선택지가 없는 숫자와 배열은 해당 설정이 패널의 JSON 편집기를 사용하도록 지정하지 않는 한(`contextFiles.extra` 등) 설정 파일에서만 수정할 수 있습니다.

- 모델/제공자 자격 증명, `.env` 파일, API 키를 결정하는 환경 변수 표는 [제공자](./providers.md)를 참조하세요.
- `models.yml`의 사용자 정의 모델 정의는 [모델](./models.md)을 참조하세요.
- 에이전트 컨텍스트에 검색되어 포함되는 지침 파일(`AGENTS.md`, `.omp/` 등)은 [컨텍스트 파일](./context-files.md)을 참조하세요.
- 전체 환경 변수 목록은 [환경 변수](./environment-variables.md)를 참조하세요.
- 턴마다 특수 동작을 활성화하는 프롬프트 단어는 [매직 키워드](./magic-keywords.md)를 참조하세요.

<a id="where-settings-live"></a>
## 설정 저장 위치

| 범위 | 경로 | 읽기 동작 | 쓰기 동작 |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 전역 | `~/.omp/agent/config.yml`(또는 기존 `config.yaml`) | 기본 영속 설정 파일입니다. `config.yml`이 표준 쓰기 대상이며, 기존 `config.yaml`이 있으면 그 파일을 읽고 제자리에서 갱신합니다. | `/settings`, `omp config set`, `omp config reset`이 여기에 씁니다. |
| 이전 전역 형식 | `~/.omp/agent/settings.json` | 두 기본 YAML 파일이 모두 없을 때만 마이그레이션 대상으로 고려합니다. | 쓰지 않습니다. 마이그레이션한 비어 있지 않은 YAML 파일을 저장하는 데 성공하면 `settings.json.bak`으로 이름을 바꿉니다. |
| 프로젝트 | `<cwd>/.omp/config.yml`(및 `.omp/settings.json`) | 프로세스 작업 디렉터리에 비어 있지 않은 `.omp/`가 있으면 읽습니다. | 설정 명령은 임의의 프로젝트 키를 쓰지 않습니다. `modelRoleStorage: project`이면 모델 선택기의 역할 할당이 여기의 `modelRoles`만 갱신합니다. 다른 키는 직접 편집하세요. |
| 이전 프로젝트 형식 | `<cwd>/.omp/settings.json` | 계속 읽으며 프로젝트 `config.yml`을 그 위에 병합합니다. | 설정 명령으로 쓰지 않습니다. |
| CLI 오버레이 | `--config <file>`로 전달한 모든 파일 | 해당 프로세스에 한해 전역 및 프로젝트 설정 다음에 읽습니다. 여러 번 지정할 수 있습니다. | 영속적으로 저장하지 않습니다. |
| 런타임 재정의 | 메모리 내에만 존재 | `--approval-mode`, 역할 플래그, 기능별 환경 변수 등의 설정 재정의로 지정합니다. | 영속적으로 저장하지 않습니다. |

위 전역 경로는 기본 프로필 기준입니다. `omp --profile work`는 대신 `~/.omp/profiles/work/agent`를 선택하여 설정, 인증, 세션, 캐시를 격리합니다. `OMP_PROFILE`로도 프로필을 선택할 수 있습니다. `PI_PROFILE`은 `OMP_PROFILE`이 없을 때만 사용하는 호환성 대체 변수입니다. 명시적인 `--profile`이 두 변수보다 우선하며, `--profile default`는 기본 프로필을 선택합니다.

`PI_CODING_AGENT_DIR`은 `config.yml`과 에이전트 데이터를 포함한 기본 프로필의 에이전트 디렉터리를 옮깁니다. 이름 있는 프로필은 자체 에이전트 디렉터리를 사용하며 이 재정의를 무시합니다. `omp config path`(또는 `omp --profile work config path`)로 활성 설정 디렉터리를 출력하세요.

Linux와 macOS에서는 설정된 `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` 아래에 해당 `omp` 디렉터리가 있으면 데이터/상태/캐시 위치를 변경할 수 있습니다. 이름 있는 프로필에는 해당 `omp/profiles/<name>` 디렉터리가 필요합니다. 이렇게 해도 `config.yml`은 이동하지 않습니다. 활성 에이전트 디렉터리에 남으며, `agent.db`와 분류된 다른 데이터는 별도 위치에 있을 수 있습니다. `omp config init-xdg`는 기본 디렉터리를 만들지만 파일을 이전하거나 환경 변수를 설정하지는 않습니다.

기본 프로젝트 설정의 범위는 의도적으로 프로세스 작업 디렉터리의 `.omp/` 폴더로 한정됩니다. 설정 검색은 가장 가까운 `.omp/`를 찾아 상위 디렉터리를 탐색하지 **않습니다**. 다른 검색 제공자(Claude, Codex, Gemini, Cursor, OpenCode)도 자체 파일에서 프로젝트 수준 설정을 제공할 수 있습니다. 이 설정은 `omp` 설정 명령에서는 읽기 전용이며 제공자 ID로 끌 수 있습니다([제공자 및 소스 비활성화](#provider-and-source-disabling) 참조).

<a id="config-file-formats"></a>
## 설정 파일 형식

표준 전역 파일은 `config.yml`의 YAML이며, `config.yaml`도 호환 파일명으로 허용합니다. 다른 파일(예: `models.yml`)에 사용하는 일반 설정 로더는 `.yml`, `.yaml`, `.json`, `.jsonc`를 지원합니다.

- `.yml`/`.yaml` 경로를 요청했는데 같은 위치에 동일 이름의 `.json`만 있으면 자동으로 YAML로 마이그레이션합니다(멱등적이며 프로세스당 한 번).
- `.json`과 `.jsonc` 설정은 마이그레이션 없이 그대로 읽습니다.
- 빈 YAML(또는 YAML `null`)은 빈 설정 매핑으로 취급합니다. 매핑이 아닌 다른 최상위 값은 유효하지 않습니다. 쓰기가 가능한 시작 과정에서 `omp`는 구문이 잘못되거나 매핑이 아닌 영속 설정 파일을 고유한 `.broken-*` 백업으로 옮기고, 원래 오류와 백업 경로를 표시한 뒤 종료합니다. 최상위 값이 배열/스칼라인 `--config` 오버레이도 치명적인 오류지만 파일을 옮기지는 않습니다.
- 일반 스키마 항목의 잘못된 값은 경고를 내고 스키마 기본값으로 읽습니다. 에이전트별 압축 트리거나 제공자 동시성 제한처럼 명시적인 검증기가 있는 설정은 대신 구성을 거부할 수 있습니다. 직접 작성한 파일의 알 수 없는 키는 등록된 설정을 대신하지 못합니다.

<a id="reading-and-writing-settings"></a>
## 설정 읽기 및 쓰기

세션 안에서는 대화형 `/settings` 패널을, 셸에서는 `omp config` 명령을 사용하세요. CLI는 설정 환경 변수를 포함한 유효 값을 읽습니다. 패널은 환경에서 공급한 값이 아닌 병합된 설정 계층 값을 표시하고 편집합니다. 설명에 활성 환경 재정의를 표시하므로 환경의 자격 증명이 미리 채워지거나 저장되지 않습니다. 일반 영속 쓰기는 **전역** 파일에 저장됩니다. 단, `modelRoleStorage: project`일 때 모델 선택기의 역할 변경은 예외입니다([쓰기 대상](#where-writes-go) 참조).

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # remove a key from config.yml so its default applies
omp config path                 # print the active agent directory
```

일반 실행 시에도 전체 최초 실행 애니메이션을 보려면 `startup.showSplash`를 설정하세요.

```bash
omp config set startup.showSplash true
```

이 설정은 시작 스플래시 애니메이션만 제어합니다. 설정 마법사를 다시 실행하거나 설정 상태를 바꾸지 않으며, `startup.quiet: true`이면 스플래시를 포함한 모든 시작 UI가 여전히 숨겨집니다.

<a id="subcommands"></a>
### 하위 명령

| 명령 | 효과 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp config list` | 모든 설정을 탭별로 묶어 현재 값과 타입을 출력합니다. `--json`은 설정 경로를 키로 하는 `{ value, type, description }` 객체를 출력합니다. 설정된 자격 증명 필드는 사람이 읽는 출력에서 `********`로 가리며, JSON에서는 `value`를 생략하고 `redacted: true`를 출력합니다. |
| `omp config get <key>` | 한 키의 유효 값을 출력합니다. 알 수 없는 키이면 0이 아닌 코드로 종료합니다. `--json`은 `{ key, value, type, description }`을 출력합니다. 명시적으로 단일 키를 요청한 것이므로 자격 증명 값은 가리지 않고 반환합니다. |
| `omp config set <key> <value>` | 키의 스키마 타입에 따라 `<value>`를 파싱하고 전역 기본 YAML 파일에 쓴 뒤 저장한 값을 출력합니다. 다른 소스가 여전히 유효 값을 공급하면 어느 소스인지 알립니다(`--json`: `overriddenBy`는 환경 변수 이름 또는 `project`, `overlay`, `runtime`이며, `fallbackEnv`는 저장한 값이 비어 있을 때 사용하는 대체 환경 변수의 이름입니다). |
| `omp config reset <key>` | 전역 키를 삭제하여 다른 설정 계층이나 스키마 기본값이 적용되게 합니다. 최종 유효 값을 출력하며 비어 있지 않은 자격 증명은 `********`로 가립니다. JSON은 자격 증명의 `value`를 생략하고 `{ key, redacted: true }`를 출력합니다. |
| `omp config path` | 활성 에이전트 디렉터리를 출력합니다(`PI_CODING_AGENT_DIR` 반영). |
| `omp config init-xdg` | Linux와 macOS에서 유효한 XDG 데이터, 상태, 캐시 홈 아래에 `omp` 디렉터리를 만듭니다. 기존 파일을 옮기거나 XDG 환경 변수를 설정하지 않습니다. 다른 플랫폼에서는 0이 아닌 코드로 종료합니다. |

하위 명령 없이 `omp config`를 실행하면 설정 목록을 표시합니다. `--help` 또는 `-h`는 명령 도움말을 표시합니다. `list`, `get`, `set`, `reset`에서 `--json` 플래그를 사용할 수 있습니다.

<a id="value-parsing"></a>
### 값 파싱

`omp config set`은 대상 키의 스키마 타입에 따라 값 문자열을 파싱합니다. 먼저 문자열 앞뒤의 공백을 제거합니다.

| 타입 | 허용 입력 | 참고 |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | 대소문자를 구분하지 않습니다. 그 외는 거부합니다. |
| number | 유한한 JavaScript 숫자 | `Infinity`/`NaN`은 거부합니다. |
| enum | 해당 키의 허용 값 하나(그대로 또는 JSON 따옴표로 감싼 값) | 정확히 일치해야 합니다. 오류에 유효한 값 목록이 표시됩니다. |
| array | JSON 배열 | 예: `'["anthropic","openai"]'`. 파싱 가능하고 배열이어야 합니다. |
| record | JSON 객체 | 예: `'{"bash":"prompt"}'`. 파싱 가능하며 배열이 아닌 객체여야 합니다. |
| string | 일반 텍스트 또는 JSON 따옴표로 감싼 문자열 | 일반 텍스트는 앞뒤 공백을 제거하고, JSON 문자열 내용은 디코딩합니다. 여러 단어 인수는 공백으로 연결합니다. |

키는 실제 스키마 경로와 정확히 일치해야 합니다. 축약형은 없습니다. `theme`이 아니라 `theme.dark`를 설정하세요.

파싱 후에도 설정별 정규화와 검증은 적용됩니다. 예를 들어 제공자 동시성 제한은 양수여야 하며 요청 수는 정수로 내림합니다.

<a id="where-writes-go"></a>
### 쓰기 대상

`omp config set`, `omp config reset`, `/settings`, 영속적인 런타임 설정 변경은 활성 에이전트 디렉터리의 전역 기본 YAML 파일에 씁니다. 런타임 전용 재정의는 저장하지 않습니다. 설정 명령은 `<cwd>/.omp/config.yml`에 임의의 키를 쓰지 않습니다. `modelRoleStorage: project`일 때 모델 역할을 할당하거나 지우면 해당 파일의 영향을 받는 역할만 갱신합니다. 없는 프로젝트 역할은 전역 역할로 대체됩니다. 다른 프로젝트 로컬 재정의를 만들려면 프로젝트 파일을 직접 편집하세요([프로젝트 로컬 설정](#project-local-config) 참조).

저장은 디바운스되며 잠금 상태에서 파일을 다시 읽습니다. 서로 다른 항목에 대한 외부 편집은 보존됩니다. 로컬 변경을 준비한 후 외부 작성자가 같은 전역 설정이나 모델 역할을 변경했다면, 오래된 로컬 변경으로 최신 파일 값을 덮어쓰는 대신 경고와 함께 건너뜁니다.

기본 설정이 심볼릭 링크이면 저장 시 링크를 보존하고 해석된 대상을 갱신합니다. `.` 또는 `..`이 포함된 대상은 운영 체제 규칙을 따릅니다. Windows는 중간 링크를 따라가기 전에 이 부분을 축약하지만 POSIX는 디스크의 각 구성 요소를 탐색합니다. 따라서 `alias/../config.yml` 같은 대상은 두 플랫폼에서 서로 다른 파일을 가리킬 수 있습니다.

<a id="live-file-changes"></a>
### 파일 변경 실시간 반영

대화형 세션과 RPC/RPC-UI 호스트는 전역 기본 파일, 프로젝트 설정 소스, 설정 오버레이를 감시합니다. 잠깐의 디바운스 후 변경 내용을 다시 읽으며 런타임 재정의를 보존합니다. 파싱이나 검증에 실패한 계층은 마지막 유효 값을 유지하고 경고를 기록합니다. 다른 유효한 계층은 계속 새로 고칠 수 있습니다. 실시간 다시 읽기는 잘못된 파일을 `.broken-*` 백업으로 옮기지 않습니다.

심볼릭 링크 설정은 대상 편집과 프로필 링크를 포함한 모든 중간 파일/디렉터리 심볼릭 링크 교체를 추적합니다. 링크 대상이 바뀌면 새 대상에 대한 이후 편집도 감시합니다.

다시 읽기는 소비 코드에서 사용할 수 있는 설정 값을 바꾸며 시작 시에만 수행하는 작업을 다시 실행하지 않습니다. 제공자 소스 전환은 다음 검색부터 적용됩니다. Task/eval 디스패치도 하위 에이전트 정책을 결정하기 전에 영속 설정을 다시 읽습니다.

`modelRoles`, `retry.fallbackChains`, `task.agentModelOverrides`의 라우팅 변경은 호스트를 다시 시작하지 않아도 이후 하위 에이전트 실행과 대체 판단에 적용됩니다. `auth.accountPolicies`와 `retry.usageReservePct` 역시 이후 자격 증명 선택과 할당량 확인에 사용하는 장기 실행 계정 라우터를 갱신합니다. 다시 읽기는 실행 중인 하위 에이전트를 재시작하거나 정상인 활성 세션의 모델을 바꾸지 않습니다. 명시적인 런타임 재정의가 여전히 우선합니다.

<a id="precedence"></a>
## 우선순위

설정의 유효 값은 낮은 우선순위부터 높은 우선순위 순으로 다음과 같이 구성됩니다.

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides  <-  setting env var
```

높은 우선순위부터 나열하면 다음과 같습니다.

1. **설정 환경 변수** — 설정 정의에 선언된 환경 변수입니다(예: `eval.py`의 `PI_PY`, `auth.broker.url`의 `OMP_AUTH_BROKER_URL`). 사용자 정의 파서가 없다면 설정 타입에 따라 파싱하며, 파싱 불가능한 텍스트(`PI_EDIT_VARIANT=auto` 등)는 미설정으로 취급합니다. 불리언은 `parseFlag` 규칙을 따릅니다. 빈 값은 미설정, `1`/`y`/`true`/`yes`/`on`(모두 소문자 또는 모두 대문자)은 참, 다른 값은 거짓입니다. 일부 변수(`SEARXNG_*`, `MNEMOPI_EMBEDDING_MODEL`)는 대체값으로 선언되어 내장 기본값만 대체하므로 구성된 계층이 우선합니다. 단, 설정된 `null`은 미설정으로 취급합니다. `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, `MNEMOPI_EMBEDDING_MODEL`은 설정이 빈 문자열일 때도 적용됩니다.
2. **런타임 재정의** — `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--advisor`, `--external-thinking`, 프로토콜 모드 기본값 등 현재 프로세스의 메모리에 적용한 설정입니다. 영속적으로 저장하지 않습니다. `--model`, `--thinking`, `--service-tier`, `--no-lsp`, `--no-pty`, `--api-key` 같은 다른 일회성 옵션은 모두 레지스트리 설정인 것이 아니라 세션/모델/전송 옵션에 영향을 줍니다. 프로토콜 모드 기본값(RPC/ACP)은 다른 곳에서 해당 설정을 구성하지 않은 동안만 유지됩니다. 해당 설정 쓰기/초기화, 다시 읽기로 반영된 `config.yml` 또는 프로젝트 편집, ACP 세션 자체의 프로젝트 설정이 이를 대체합니다.
3. **CLI 설정 오버레이** — 각 `--config <file>`입니다. 나중 오버레이 파일이 앞선 파일을 재정의합니다.
4. **프로젝트 설정** — `<cwd>/.omp/settings.json` 다음 `<cwd>/.omp/config.yml`(그리고 다른 검색 제공자가 프로젝트 수준에서 공급하는 설정)입니다.
5. **전역 설정** — 활성 에이전트/프로필 디렉터리의 `config.yml`(또는 기존 `config.yaml`)입니다.
6. **내장 기본값** — 설정 정의에서 가져옵니다.

모든 계층에서 설정되지 않은 키는 읽을 때 기본값으로 결정됩니다.

<a id="environment-overrides"></a>
### 환경 변수 재정의

환경 변수는 `config.yml`에 다시 저장되지 않습니다. 설정 정의에서 선언한 변수는 위에서 설명한 최상위 계층을 구성합니다. 다른 변수는 해당 값의 소유 기능이 직접 읽거나(`PI_NO_PTY`) 런타임 재정의로 적용합니다(`PI_SMOL_MODEL`은 해당 프로세스의 `smol` 모델 역할을 설정). 관련 설정 재정의와 구성 선택 변수는 다음과 같습니다.

| 환경 변수 | 재정의하는 설정 | 참고 |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL` | `modelRoles.smol` | `--smol`로도 지정할 수 있습니다. |
| `PI_SLOW_MODEL` | `modelRoles.slow` | `--slow`로도 지정할 수 있습니다. |
| `PI_PLAN_MODEL` | `modelRoles.plan` | `--plan`으로도 지정할 수 있습니다. |
| `PI_NO_PTY=1` | (PTY bash 비활성화) | 해당 프로세스에서 `--no-pty`와 같습니다. |
| `PI_PY` | `eval.py` | `PI_PY=0`은 Python eval 백엔드를 비활성화합니다. |
| `PI_JS` | `eval.js` | `PI_JS=0`은 JavaScript eval 백엔드를 비활성화합니다. |
| `PI_TINY_DEVICE` | `providers.tinyModelDevice` | 로컬 소형 모델의 ONNX 실행 제공자 또는 `mlx` 백엔드입니다. |
| `PI_TINY_DTYPE` | `providers.tinyModelDtype` | 로컬 소형 모델의 ONNX 정밀도입니다. |
| `OMP_AUTH_BROKER_URL` | `auth.broker.url` | 환경 값이 설정보다 우선합니다. |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token` | 환경 값이 설정보다 우선합니다. |
| `PI_CODING_AGENT_DIR` | (기본 프로필의 에이전트 디렉터리 이동) | 이름 있는 프로필은 이 재정의를 무시합니다. |
| `OMP_PROFILE` / `PI_PROFILE` | (프로필 선택) | `OMP_PROFILE`이 있으면 우선하며, `--profile`이 환경 변수보다 우선합니다. |
| `PI_EDIT_VARIANT` | `edit.mode` | `apply_patch`, `hashline`, `patch`, `replace`, `sloppy`. `auto`는 미설정입니다. |
| `PI_EDIT_FUZZY` | `edit.fuzzyMatch` | 정확히 소문자 `1`/`true`이면 활성화하고, `0`/`false`이면 비활성화합니다. 다른 텍스트이면 설정을 따릅니다. |
| `PI_EDIT_FUZZY_THRESHOLD` | `edit.fuzzyThreshold` | 0–1의 부동소수점 임계값으로 파싱합니다. 잘못되거나 범위를 벗어난 값은 미설정입니다. |
| `PI_INTENT_TRACING` | `tools.intentTracing` | 불리언 환경 변수 파서를 사용합니다. |
| `PI_AUTO_QA` | `dev.autoqa` | 저장된 동의에 따라 자동 도구 문제 보고를 활성화/비활성화합니다. |
| `PI_NO_THINKING_LOOP_GUARD` | `model.loopGuard.enabled` | `1`만 비활성화합니다. 다른 값은 설정을 재정의하지 않습니다. |
| `SEARXNG_ENDPOINT` / `SEARXNG_TOKEN` | `searxng.endpoint` / `searxng.token` | 설정이 없거나 null 또는 빈 문자열이면 대체합니다. |
| `SEARXNG_BASIC_USERNAME` / `SEARXNG_BASIC_PASSWORD` | `searxng.basicUsername` / `searxng.basicPassword` | 없거나 null일 때만 대체합니다. 설정된 빈 문자열도 유효한 자격 증명입니다. |
| `MNEMOPI_EMBEDDING_MODEL` | `mnemopi.embeddingModel` | 없거나 null 또는 빈 문자열이면 대체합니다. |
| `PI_CONFIG_FILES` | CLI 설정 오버레이 | 플랫폼별 경로 목록입니다(Unix는 `:`, Windows는 `;`). `--config` 오버레이 전에 목록 순서대로 읽습니다. |

제공자 API 키는 별도로 결정합니다(저장된 인증, OAuth, `models.yml`, 환경 변수, `.env` 파일). [제공자](./providers.md)와 전체 [환경 변수](./environment-variables.md) 참조를 확인하세요.

<a id="merge-rules"></a>
## 병합 규칙

계층은 깊은 병합으로 결합합니다.

- **객체는 깊게 병합합니다.** 하위 계층에만 있는 키는 유지하며 상위 계층에 있는 키는 재정의합니다.
- **스칼라와 배열은 우선순위가 높은 계층으로 전체를 대체합니다.** 상위 계층 배열을 하위 계층 배열에 덧붙이지 않습니다.
- **설정된 `null`은 읽을 때 미설정으로 취급하므로** 하위 계층 값이 아닌 스키마 기본값(또는 대체 환경 변수)을 적용합니다. 프로젝트 `modelRoles` 항목은 예외입니다. 지워졌거나 null인 프로젝트 역할은 전역 역할로 대체됩니다.
- **이름 있는 모델 프리셋은 전체 단위로 결정하며** 계층 간 깊게 병합하지 않습니다. 같은 이름의 프로젝트 프리셋은 전역 프리셋을 대체합니다. 런타임/오버레이의 `null` 항목은 하위 계층 프리셋을 숨길 수 있습니다.

점으로 구분된 설정 경로에는 중첩 YAML 매핑을 사용하세요.

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

<a id="bash-command-approval-patterns"></a>
### Bash 명령 승인 패턴

`tools.approval`은 도구 이름을 키로 하는 레코드입니다. `tools.approval.eval`, `tools.approval.computer` 같은 점 표기는 별도 설정 ID가 아니라 해당 레코드의 항목을 가리킵니다. 각 항목은 해당 도구의 기본 정책을 지정합니다. bash에는 `bash.patterns`로 순서 있는 명령 규칙을 추가할 수 있으며 첫 일치 규칙이 적용됩니다. 패턴은 일반 텍스트와 와일드카드 `*`를 지원합니다. 공백은 예외로, 일치 검사 전에 패턴과 명령 양쪽의 연속된 스페이스, 탭, 줄바꿈을 공백 하나로 축약하고 앞뒤 공백을 제거합니다. 따라서 패턴의 줄바꿈은 모든 공백과 일치합니다. `match: "*\n*"`는 `"* *"`처럼 동작하여 공백이 포함된 모든 명령과 일치합니다. `deny`와 `prompt` 규칙은 각 구간을 검사하므로(아래 참조), 줄바꿈으로 나눈 목록에서 위험한 명령을 잡기 위해 줄바꿈 전용 규칙을 만들 필요는 없습니다. `allow` 규칙은 따옴표 밖 줄바꿈 명령 구분자를 거부하지만, 전체 명령이 일치하면 따옴표로 감싸거나 이스케이프한 리터럴 줄바꿈이 포함된 명령은 승인할 수 있습니다.

기본적으로 `allow` 규칙은 명령 전체와 일치해야 하며 복합 명령줄을 승인할 수 없습니다. `bash.allowCompoundCommands: true`로 설정하면 `&&`로만 연결된 두 개 이상의 리터럴 명령으로 이루어진 보수적인 체인도 평가합니다.
```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  allowCompoundCommands: true
  patterns:
    - match: "rm -f *"
      approval: allow
```

이 구성에서는 `cmp tmp/result.json artifacts/result.json && rm -f tmp/result.json`을 프롬프트 없이 실행할 수 있습니다. OMP는 원래 각 구간에 대해 순서 있는 규칙을 독립적으로 결정합니다. `rm`은 명시적으로 허용하고, 일치 규칙이 없는 `cmp` 구간은 일반적인 단독 bash 정책을 상속합니다. 일치하지 않는 구간이 하나라도 있으면 명령은 명시적인 정책 없이 `exec` 등급을 유지하므로, 일반 결정기가 `tools.approval.bash` 다음 활성 승인 모드를 적용합니다. 따라서 도구 전체 정책이나 모드가 요구할 때만 일치하지 않는 구간에 대한 승인 프롬프트가 표시됩니다.

명시적인 제한은 체인 전체에서 보수적으로 결합합니다. 결정된 `deny`가 우선하고, 없으면 결정된 `prompt`가 우선합니다. 전체 체인에는 일치하지만 개별 구간에는 일치하지 않는 `deny` 또는 `prompt` 규칙은 전체 체인 제한으로 유지됩니다(예: `cmp * && rm *`). 일치하는 전체 체인 제한을 모두 고려하므로, 뒤의 전체 체인 `deny`가 앞의 전체 체인 `prompt`보다 우선합니다. 그 외에는 구간 규칙이 첫 일치 순서를 유지합니다. `git status && git status`를 평가할 때 앞선 `git status` 허용이 나중 `git *` 거부로 뒤집히지 않습니다.

따라서 이 설정을 활성화하면 좁은 구간 허용 규칙이 광범위한 일괄 거부보다 앞에 있을 때 기본 정책이 거부하던 복합 명령을 허용할 수 있습니다. 항상 적용해야 하는 구간 거부 규칙은 겹치는 허용 규칙 앞에 두세요.

이 선택 기능은 따옴표로 감싼 리터럴 인수를 포함하여 리터럴 인수로 된 평면 `&&` 체인만 허용합니다. 확장, 변수 할당, 다른 제어 흐름, 리디렉션, 글로빙, 줄바꿈, 잘못된 구문, `cd`, `source`, `eval` 같은 셸 상태 변경 명령은 거부합니다. 거부한 형식은 기존 승인 동작을 유지합니다. 이 설정을 활성화해도 `allow` 패턴이 승인할 수 있는 비체인 명령의 범위는 넓어지지 않습니다. 명시적인 체인/구간 제한은 기존의 원본 및 정규화된 중요 명령 검사 전에 결정합니다. 이 검사도 전체 명령과 모든 구간을 확인하므로 광범위한 허용으로 뒤쪽 중요 구간을 숨길 수 없습니다.

이 선택 기능에는 POSIX 따옴표 규칙을 사용하는 것으로 확실히 식별된 셸이 필요합니다. `sh`, `bash`, `dash`, `ash`, `ksh`, `zsh`와 해당 `.exe` 이름을 지원합니다. 중앙 분류기는 Windows 및 POSIX 경로에서 실행 파일의 기본 이름을 확인합니다. cmd, PowerShell, fish, 알 수 없는 래퍼를 포함한 다른 셸은 기존 승인 동작을 유지합니다. 따옴표 규칙이 인식기와 다를 수 있기 때문입니다. 예를 들어 fish는 작은따옴표 안의 `\'`를 이스케이프한 따옴표로 처리하지만 POSIX 셸은 그렇지 않습니다.

유효한 규칙 승인은 `allow`, `prompt`, `deny`입니다. 이 선택 기능과 무관하게 `deny`와 `prompt` 규칙은 전체 명령 또는 다른 복합 형식에서 토큰화한 구간(`&&`, `||`, `;`, `|`, 단일 `&`, 서브셸, 줄바꿈으로 분리)과 일치할 수 있습니다. 따라서 `match: "rm -rf *"`는 `cd /tmp && rm -rf build`와 `sleep 1 & rm -rf build`를 거부할 수 있습니다.

`bash.patterns`는 승인 정책이지 격리 기능이 아닙니다. 허용된 프로그램은 여전히 bash 프로세스의 파일 시스템, 네트워크, 하위 프로세스 접근 권한을 가지며, 겉보기에는 좁은 범위의 프로그램도 자체 옵션이나 설정으로 더 광범위한 동작을 수행할 수 있습니다. 규칙은 `bash` 도구에만 적용되며 `eval`로 시작한 셸에는 적용되지 않습니다. 이 경로도 막으려면 `tools.approval.eval` 정책(`prompt` 또는 `deny`)도 추가하세요. [도구 승인 모드](./approval-mode.md)를 참조하세요.

<a id="bash-interceptor-patterns"></a>
### Bash 인터셉터 패턴

`bashInterceptor`는 `bash.patterns`와 별개입니다. 명령 실행 가능 여부를 정의하는 대신 Bash 명령을 전용 도구로 안내합니다. 명시적으로 활성화하고 대체 도구 및 모델에 표시할 메시지와 함께 정규식 패턴을 구성하세요.

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

지정한 대체 도구가 현재 세션에서 사용 가능해야 인터셉터가 Bash 호출을 차단합니다. 복합 명령 동작과 적용 순서를 포함한 권한 정책과 전용 도구 안내의 자세한 비교는 [Bash 도구 문서](tools/bash.md#command-policy-and-dedicated-tool-routing)를 참조하세요.

<a id="worked-example-global-vs-project"></a>
### 실제 예: 전역과 프로젝트

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - google

# <repo>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

`<repo>` 내부의 유효 설정:

```yaml
tools:
  approvalMode: write # kept from global (object deep-merge)
  approval:
    bash: allow # overridden by project
    read: allow # kept from global
disabledProviders:
  - groq # project array REPLACES the global array
```

배열 대체는 가장 흔히 혼동하는 부분입니다. 프로젝트의 `disabledProviders`는 전역 목록을 확장하지 않고 해당 프로젝트의 전체 목록이 됩니다. `enabledModels`, `cycleOrder`, `extensions`를 비롯한 모든 배열 타입 설정에도 같습니다.

<a id="project-local-config"></a>
## 프로젝트 로컬 설정

저장소 자체 설정이 필요하면 `<repo>/.omp/config.yml`을 만드세요.

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  methodOrder: [snapcompact, remote, soft]
  thresholdPercent: 80

theme:
  dark: titanium
```

저장소 정책에서 허용하지 않는 한 커밋하는 프로젝트 설정에 비밀 정보를 넣지 마세요. 자격 증명에는 환경 변수, 저장된 인증, 인증 브로커, 버전 관리하지 않는 `--config` 오버레이를 권장합니다.

<a id="one-shot-overlays"></a>
### 일회성 오버레이

영속적으로 저장하지 않을 임시 계층에는 `--config`를 사용하세요.

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

래퍼는 대신 `PI_CONFIG_FILES`를 플랫폼별 구분자를 사용하는 경로 목록으로 설정할 수 있습니다(Unix는 `:`, Windows는 `;`). 환경 오버레이는 명시적인 `--config` 오버레이 전에 목록 순서대로 읽습니다.

`--config`는 기본 실행 명령, `acp`, `models`, `dry-balance`에서 지원합니다. `models`와 `dry-balance`에서는 명령 이름 뒤에 두세요(`omp dry-balance --config ./policy.yml`). 명령 이름 앞에 두면 버립니다.

오버레이 경로는 프로세스 작업 디렉터리를 기준으로 결정하며 `~`를 확장합니다. 각 오버레이는 YAML 매핑으로 파싱되어야 합니다. 파일 누락, 잘못된 YAML, 최상위 배열/스칼라는 치명적인 오류이며 우선순위가 낮은 설정으로 조용히 대체하지 **않습니다**.

<a id="path-scoped-arrays"></a>
## 경로 범위 배열

세 배열 설정 `enabledModels`, `enabledProviders`, `disabledProviders`는 일반 문자열 외에 경로 범위 항목도 허용하므로 하나의 전역 설정으로 디렉터리마다 다르게 동작할 수 있습니다.

```yaml
enabledModels:
  - claude-sonnet-4-5 # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

일반 문자열 항목은 모든 위치에 적용됩니다. 범위 지정 항목은 현재 작업 디렉터리가 설정 경로와 **같거나 그 아래**일 때 적용됩니다. `~`는 홈 디렉터리로 확장하며 상대 경로는 일치 검사 전에 해석합니다.

허용하는 **경로** 키(여러 키를 함께 사용 가능): `path`, `paths`, `pathPrefix`, `pathPrefixes`.

허용하는 **값** 키:

- `models`(`enabledModels`용) 또는 `providers`(`enabledProviders`, `disabledProviders`용)
- `values` 또는 `items`(모든 설정용)

문자열 값만 유지하며 잘못된 범위 항목은 무시합니다. 경로 범위는 계층 병합 **후**에 결정하므로 최종 유효 배열을 읽습니다.

<a id="provider-and-source-disabling"></a>
## 제공자 및 소스 비활성화

`enabledProviders`는 외부 사용자 수준 설정 소스를 검색에 포함합니다. 기본값이 비어 있으므로 Cursor, Codex, Claude, Claude 마켓플레이스 플러그인, Gemini, OpenCode, Windsurf, GitHub의 사용자 루트는 제공자 ID(또는 `*`/`all`)를 나열하기 전까지 보통 제외됩니다. `claude`를 활성화하면 `claude-plugins`도 활성화합니다. 명시적인 `CLAUDE_CONFIG_DIR`은 목록 항목 없이도 Claude 사용자 루트를 포함합니다. 명시적으로 선택한 검색 루트도 포함될 수 있습니다. 여전히 `disabledProviders`가 우선합니다.

프로젝트 루트는 활성 상태를 유지합니다. 기본 OMP 및 `.agents` 루트(기본 마켓플레이스 플러그인 포함)는 외부 소스가 아니므로 항목이 필요하지 않습니다.

`disabledProviders`는 자격 증명을 확인하기 전에 서로 다른 두 하위 시스템을 제어하는 하나의 공유 ID 네임스페이스입니다.

| 항목 종류 | ID 예 | 효과 |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 모델 제공자 | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | 자격 증명이 있어도 모델 선택에서 해당 백엔드를 제거합니다. [제공자](./providers.md)를 참조하세요. |
| 검색 소스 | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | 해당 소스가 컨텍스트 파일, MCP 서버, 명령, 스킬, 훅, 도구, 프롬프트, 설정을 제공하지 못하게 합니다. [컨텍스트 파일](./context-files.md)을 참조하세요. |

대부분의 제공자 제어 사례에서는 모델 제공자 ID를 나열합니다. `claude` 검색 소스를 비활성화하는 것은 `anthropic` 모델 제공자를 비활성화하는 것과 다릅니다. 전자는 Claude 형식 설정 검색을 멈추고 후자는 Anthropic 모델 백엔드를 끕니다.

배열은 덧붙이지 않고 대체하므로 `disabledProviders`를 설정하는 프로젝트는 원하는 전체 집합을 나열해야 합니다.

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml — inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

기본값은 빈 배열입니다(비활성화 없음). 두 하위 시스템의 제공자 ID와 순서는 [제공자](./providers.md) 및 [컨텍스트 파일](./context-files.md)을 참조하세요.

기본 프로젝트 `modelRoles`는 `.omp/config.yml`에서 직접 읽기도 하므로, `native` 검색 제공자를 비활성화해도 해당 모델 역할 계층을 제외하지 않습니다.

<a id="settings-catalog"></a>
## 설정 목록

아래 목록은 자주 사용하는 설정을 소개하며 전체 스키마는 아닙니다. 모든 키, 현재 값, 타입, 설명의 기준은 `omp config list`입니다. 여기의 기본값과 열거형 값은 스키마에서 가져옵니다. 환경 변수나 플래그 재정의를 허용하는 설정에는 이를 명시했습니다. 해당 재정의는 프로세스에만 적용되며 영속적으로 저장하지 않습니다.

<a id="models"></a>
### 모델

`modelRoles`는 각 작업의 기본 선택자를 할당합니다. `retry.fallbackChains`는 순서 있는 대체 목록을 제공하므로 서비스별 설정에서 제공자/백엔드를 선택하지 마세요. 채팅 선택자는 사고 접미사(`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`, `:auto`, `:inherit`)를 포함할 수 있습니다. 비채팅 실행기는 채팅 사고 예산을 사용하지 않습니다. 역할 값에는 쉼표로 구분된 순서 있는 선택자나 `@smol` 같은 역할 별칭도 포함할 수 있습니다. 역할의 대체 체인은 별도로 구성합니다.

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

  # Lightweight chat/tiny workloads
  tiny: local/lfm2.5-230m
  memory: local/lfm2-1.2b

  # Model-kind workloads
  image: openai/gpt-image-2
  web: web/duckduckgo
  speech: local/kokoro
  dictation: local/parakeet-tdt-0.6b-v3
  judge: typesafe/jev-1.14.0

retry:
  fallbackChains:
    tiny: [] # explicit empty chain: do not fall back
    memory:
      - openai/gpt-4.1-mini
    web:
      - web/parallel
      - web/perplexity
      - web/exa
      - web/firecrawl
    speech: []
    dictation: []
    judge:
      - typesafe/jev-preview
      - "@tiny"
      - "@smol"
      - "@default"

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

내장 채팅 역할은 `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`, `widget`입니다. `tiny`와 `memory` 역할은 `tiny` 카탈로그 모델과 일반 채팅 모델을 모두 허용합니다. `widget`은 각 백그라운드 작업의 실시간 위젯 사양을 작성하며, 할당하기 전까지 `smol`처럼 결정됩니다. 내장 모델 종류 역할은 `image`, `web`, `speech`, `dictation`, `judge`이며 각각 이미지, 검색/근거 기반 채팅, TTS, STT, 판단 실행기를 선택합니다. `judge`는 소형 모델과 채팅 모델도 허용하므로 `@tiny` 같은 별칭을 대체값으로 사용할 수 있습니다. 카탈로그 종류는 `chat`, `tiny`, `image`, `tts`, `stt`, `search`, `judge`입니다. `kind`가 없는 사용자 정의 모델은 채팅 모델로 유지됩니다.

`/model`을 열고 **역할** 보기에서 역할을 할당하고 대체 행을 편집하세요. 채팅 역할과 모델 종류 역할은 별도 기능 섹션에 표시되며, 선택기는 선택한 역할이 허용하는 모델로 할당 대상을 필터링합니다. 같은 카탈로그를 직접 나열하려면 `omp models --kind chat`, `omp models --kind tiny`, `omp models --kind image`, `omp models --kind tts`, `omp models --kind stt`, `omp models --kind search`, `omp models --kind judge`를 사용하세요. 전체는 `--kind all`입니다.

역할의 `modelRoles.<role>`는 기본 모델이며 `retry.fallbackChains.<role>`는 대체 목록입니다. 모델 종류 역할에서 체인이 미설정이면 해당 역할의 내장 우선순위 목록을 사용하고, `[]`는 명시적으로 **대체 없음**을 뜻합니다. `retry.fallbackChains.default` 체인은 채팅 역할/세션의 대체용이며 모델 종류 역할 자체 체인을 대체하지 않습니다. `web/parallel`, `web/perplexity`, `web/exa`, `web/firecrawl` 같은 명시적인 검색 항목은 지원되는 익명 모드를 포함하여 구성한 후보로 시도합니다. 필수 자격 증명이 없으면 해당 명시적 항목의 가용성 오류가 발생합니다.

일회성 검색에서는 `omp search`, `omp q`, `omp web-search`가 `--model`로 카탈로그 선택자를 받습니다. 예: `omp web-search --model web/duckduckgo "current Bun release"`. 세션 내 `web_search` 도구에는 호출별 모델 재정의가 없으며 `modelRoles.web`와 `retry.fallbackChains.web`를 따릅니다.

이미지 선택도 제공자 이름이 아닌 전체 카탈로그 모델 선택자를 사용합니다. `modelRoles.image`, 해당 대체 체인 또는 `generate_image` 요청의 선택적인 `model`을 지정하세요. OpenRouter 이미지 모델은 OpenRouter의 기본 이미지 API로 실행합니다.

기존 설정은 읽을 때 자동으로 마이그레이션합니다. `providers` 아래의 폐기된 백엔드 선택자(`webSearch`, `webSearchOrder`, `webSearchExclude`, `webSearchGeminiModel`, `image`, `imageOrder`, `tts`, `judgmentProvider`, `autoThinkingModel`, `unexpectedStopModel`, `tinyModel`, `memoryModel`)는 가능한 경우 `modelRoles`와 `retry.fallbackChains`로 변환한 뒤 제거합니다. 폐기된 `tts.localModel` 키는 제거하며(Kokoro가 표준 로컬 TTS 모델), `stt.modelName` 값은 표준 `modelRoles.dictation` 선택자로 이전한 뒤 제거합니다. 장치, dtype, 음성, 제한 시간, `live.*` 동작 등 다른 서비스 제어는 일반 설정으로 유지됩니다.

| 키 | 타입 | 기본값 | 참고 |
| ---------------------- | ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoles` | record | `{}` | 역할 이름에서 기본 선택자 또는 순서 있는 기본 후보로의 매핑입니다. 할당, `modelTags`, `cycleOrder`로 사용자 정의 채팅 역할을 추가할 수 있습니다. `--smol`/`--slow`/`--plan`과 해당 `PI_*_MODEL` 변수는 한 번의 실행에서 역할을 재정의합니다. `--model`은 활성 채팅 모델을 선택합니다. |
| `modelRoleStorage` | enum | `global` | `global`은 활성 전역/프로필 설정에 모델 선택기의 역할 할당을 저장합니다. `project`는 `<cwd>/.omp/config.yml`에 해당 역할 할당만 저장합니다. 없는 프로젝트 역할은 전역 역할로 대체됩니다. |
| `modelPresets` | record | `{}` | 각 값이 `{ modelRoles, defaultThinkingLevel }`인 이름 있는 모델 프리셋입니다. `/modelpreset save`와 `/models` 역할 보기(`s`)에서 쓰고 `/modelpreset switch`로 적용합니다. 저장은 전역 설정의 해당 이름 항목만 갱신합니다. 프로젝트 정의 프리셋은 나열하고 적용하지만 전역에 복사하지 않습니다. [모델 프리셋](./models.md#model-presets)을 참조하세요. |
| `modelTags` | record | `{}` | 사용자 정의 역할/태그 메타데이터입니다. 추가 채팅 역할을 도입할 수 있습니다. |
| `modelProviderOrder` | array | `[]` | 모델 ID가 모호할 때 선호하는 제공자 순서입니다. |
| `cycleOrder` | array | `["smol","default","slow"]` | 모델 전환기가 순환하는 채팅 역할입니다. |
| `enabledModels` | array | `[]` | 모델 허용 목록입니다. [경로 범위 항목](#path-scoped-arrays)을 지원합니다. 비어 있으면 사용 가능한 모든 모델입니다. |
| `enabledProviders` | array | `[]` | 읽을 외부 사용자 수준 검색 소스입니다. 경로 범위 항목을 지원합니다. [위 설명](#provider-and-source-disabling)을 참조하세요. |
| `disabledProviders` | array | `[]` | 비활성화한 모델/검색 제공자입니다. [경로 범위 항목](#path-scoped-arrays)을 지원합니다. [위 설명](#provider-and-source-disabling)을 참조하세요. |
| `includeModelInPrompt` | boolean | `true` | 시스템 프롬프트에 활성 모델 이름을 포함합니다. |

`models.yml` 스키마와 사용자 정의 제공자 정의는 [모델](./models.md)을 참조하세요.

<a id="advisor"></a>
### 어드바이저

어드바이저는 구성 가능한 주기로 기본 에이전트의 턴을 검토하고 조언을 주입할 수 있습니다. `advisor.enabled`, `/advisor on`, `--advisor`로 활성화합니다. 기본 단일 어드바이저의 모델은 `modelRoles.advisor`로 선택합니다. 미설정이면 구성된 `slow` 역할 또는 내장 느린 모델 우선순위를 사용합니다. 명시적으로 할당한 어드바이저가 사용 불가능해도 다른 모델을 조용히 선택하지 않습니다.

`WATCHDOG.yml`(또는 `WATCHDOG.yaml`)에 각자의 모델, 도구, 지침, 노트 예산, 검토 주기, 따라잡기 정책을 가진 이름 있는 어드바이저 목록을 정의할 수 있습니다. 해당 스키마, 공유 `WATCHDOG.md` 지침, 주기 제어, 따라잡기 의미는 [어드바이저 구성](./advisor-watchdog.md)을 참조하세요.

| 키 | 타입 | 기본값 | 참고 |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.enabled` | boolean | `false` | `modelRoles.advisor`가 사용 가능한 모델로 결정되면 어드바이저 런타임을 활성화합니다. |
| `task.agentAdvisor` | record | `{}` | 에이전트별 하위 에이전트 어드바이저입니다. 에이전트 이름 → `"on"` / `"off"` / 어드바이저 모델 패턴. 에이전트 프런트매터의 `advisor`를 재정의하며 `/agents` 허브에서 구성합니다. |
| `advisor.syncBacklog` | enum | `off` | 기본 따라잡기 정책입니다. `off`는 기다리지 않습니다. `1`, `3`, `5`는 해당 누적 검토 임계값에서 최대 30초 기다립니다. `strict`는 시간 상한 없이 예정된 검토를 기다립니다. 중단, 실패, 할당량 일시 정지, 전환, 해제 시 대기를 해제합니다. `WATCHDOG.yml`의 선택적인 어드바이저별 `syncBacklog`가 이 정책을 재정의하며 생략하면 상속합니다. |
| `advisor.immuneTurns` | number | `3` | 우려 또는 차단 사항이 끼어든 뒤, 도구 루프의 연속 턴을 포함하여 이 수만큼 기본 턴 동안 추가 우려를 중단 없는 부가 의견으로 전달합니다. 차단 사항은 계속 예외입니다. |
| `advisor.continueSeverity` | enum | `concern` | 최종 답변을 마친 에이전트를 깨우는 노트의 최소 심각도(`nit`, `concern`, `blocker`)입니다. 더 낮은 심각도의 노트는 대화 기록 끝의 카드로 남고 다음 사용자 메시지와 함께 전달됩니다. 모든 어드바이저에 실시간 적용됩니다. |
| `advisor.reviewMode` | enum | `turn` | `WATCHDOG.yml` 목록이 없을 때 기본 어드바이저 주기입니다. 모든 기본 턴을 검토하거나 `agent-end`로 최종 응답 후 제어를 넘길 때만 검토합니다. 목록 항목은 자체 `reviewMode`를 지정합니다(기본 `turn`). 실시간 적용됩니다. |
| `advisor.reviewInterval` | number | `1` | 기본 어드바이저에만 적용합니다. 검토 가능한 업데이트 N개마다 검토합니다. 건너뛴 업데이트는 다음 예정 검토에 보내며, 보류 중인 조언 전달은 주기에 의존하지 않습니다. 실시간 적용됩니다. |
| `advisor.maxNotesPerUpdate` | number | `4` | 어드바이저 검토당 허용하는 비차단 노트 수로 1–32입니다. 높은 심각도의 노트는 같은 검토의 보류 노트만 대체할 수 있습니다. `WATCHDOG.yml`의 최상위 또는 어드바이저별 값이 이 기본값보다 우선합니다. |
| `advisor.evictStaleResults` | boolean | `true` | 검토 전에 이전 검토에서 얻은 어드바이저의 `read`/`grep`/`glob` 출력을 짧은 대체 문구로 바꿉니다. 최신 검토는 유지합니다. |

<a id="thinking"></a>
### 사고

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

`thinkingBudgets.<level>`은 추론 토큰 예산을 지원하는 전송(Anthropic, Google/Gemini, Bedrock Claude, GitLab Duo의 Anthropic 경로, Anthropic 호환 계층, 인증 게이트웨이, 예산 모드의 `cline-pass` 포함)에서 선택한 사고 수준의 토큰 예산을 재정의합니다. 노력 수준 기반 OpenAI 호환 요청은 제어하지 않습니다. 로컬 llama.cpp, Ollama 같은 `openai-completions` 제공자는 자체 사고/노력 제어를 사용하므로 이 예산을 바꿔도 요청 본문에 영향이 없습니다. 해당 모델에서 사용 가능한 노력 수준을 선택하려면 `defaultThinkingLevel` 또는 `--thinking`을 사용하세요.

| 키 | 타입 | 기본값 | 값 |
| --------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultThinkingLevel` | enum | `high` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. `--thinking`으로 실행별 재정의가 가능합니다. |
| `hideThinkingBlock` | boolean | `false` | 출력에서 사고 블록을 숨깁니다. `--hide-thinking`은 해당 실행에만 설정합니다(표시 전용). |
| `thinkingBudgets.minimal` | number | `1024` | `minimal` 수준의 토큰 예산입니다. |
| `thinkingBudgets.low` | number | `2048` | `low`의 토큰 예산입니다. |
| `thinkingBudgets.medium` | number | `8192` | `medium`의 토큰 예산입니다. |
| `thinkingBudgets.high` | number | `16384` | `high`의 토큰 예산입니다. |
| `thinkingBudgets.xhigh` | number | `32768` | `xhigh`의 토큰 예산입니다. |
| `thinkingBudgets.max` | number | `32768` | `max`의 토큰 예산입니다. |
| `providers.autoThinkingMaxEffort` | enum | `xhigh` | `defaultThinkingLevel: auto`가 결정할 수 있는 최고 노력 수준입니다. `xhigh`는 분류기를 최상위보다 한 단계 아래로 제한하여 `ultrathink`만 `max`에 도달하게 합니다. `max`는 해당 수준을 제공하는 모델에서 분류기가 최상위 요금을 쓰도록 허용합니다. 어느 쪽이든 로컬 온디바이스 분류기는 `xhigh`로 제한됩니다. 이 설정은 `auto`의 **결정값**을 제어합니다. 상한 이하의 수준이 없는 모델에는 자동 수준을 지정하지 않으며, 메타데이터에서 명시적인 노력을 요구하는 모델에는 전송이 여전히 최저 지원 수준을 보냅니다. `["max"]` 단계에서는 모델이 다른 값을 받지 않으므로 그 값이 `max`입니다. |

<a id="sampling"></a>
### 샘플링

숫자형 샘플링 설정에서 음수(보통 `-1`)는 “제공자/모델 기본값 사용”을 뜻하며 `omp`는 해당 매개변수를 보내지 않습니다.

| 키 | 타입 | 기본값 | 참고 |
| ------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `temperature` | number | `-1` | 샘플링 온도입니다. |
| `topP` | number | `-1` | 뉴클리어스 샘플링입니다. |
| `topK` | number | `-1` | Top-K 샘플링입니다. |
| `minP` | number | `-1` | 최소 확률 컷오프입니다. |
| `presencePenalty` | number | `-1` | 존재 페널티입니다. |
| `repetitionPenalty` | number | `-1` | 반복 페널티입니다. |
| `textVerbosity` | enum | `medium` | `low`, `medium`, `high`. OpenAI Responses가 전송합니다. Codex는 명시적으로 구성한 경우에만 전달하고, 아니면 모델/제공자 기본값을 유지합니다. |
| `tier.openai` | enum | `none` | `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. OpenAI / OpenAI-Codex 및 OpenAI 계열 OpenRouter 모델에 `service_tier`로 보냅니다. `ultrafast`는 OpenAI API와 검색 결과에서 지원을 알린 Codex 모델에만 보냅니다(`/fast ultra`). 한 세션의 OpenAI 재정의는 `--service-tier <value>`로 실행하세요. 플래그는 영속적으로 저장하지 않습니다(`none`이면 `service_tier` 생략). |
| `tier.anthropic` | enum | `none` | `none`, `priority`. `priority`는 지원되는 직접 연결 Claude 모델에서 빠른 모드를 구현합니다(Bedrock/Vertex와 OpenRouter 경유에서는 무시). |
| `tier.google` | enum | `none` | `none`, `flex`, `priority`. Gemini API는 본문에 보내며 Vertex는 헤더로 `priority`를 보냅니다(Vertex에서 `flex`는 효과 없음). |
| `tier.subagent` | enum | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. 생성된 모델 계열에 적용합니다. `inherit`는 기본 에이전트를 따릅니다. |
| `task.agentServiceTierOverrides` | record | `{}` | task/eval 디스패치로 생성하는 에이전트의 정확한 이름별 재정의입니다(Vibe 작업자는 `tier.subagent` 유지). 값: `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. 항목은 `tier.subagent`보다 우선하며 구체적인 값은 결정된 모델의 제공자 계열이 지원할 때만 적용합니다. 매핑이 아닌 값은 설정 읽기에 실패합니다. |
| `tier.advisor` | enum | `none` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. 어드바이저 모델 계열에 적용합니다. |
| `personality` | enum | `default` | `default`, `friendly`, `pragmatic`, `none`. 사용자 수준 `<agent dir>/PERSONALITY.md`가 선택한 프리셋 텍스트를 대체합니다. `none`이면 여전히 블록을 생략합니다. [시스템 프롬프트 사용자 정의](./system-prompt-customization.md)를 참조하세요. |

<a id="retry-and-fallback"></a>
### 재시도 및 대체

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackOn: any
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Chat roles without their own chain may inherit "default". Model-kind
    # roles use their own built-in defaults instead.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override inherited or built-in fallbacks. An explicit
    # [] disables fallback for that role. Chat selectors accept an optional
    # thinking suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    web: []
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider — current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*

providers:
  anthropic:
    serverSideFallback: false
```

| 키 | 타입 | 기본값 | 참고 |
| ---------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry.enabled` | boolean | `true` | 일시적인 제공자 오류를 재시도합니다. |
| `retry.maxRetries` | number | `10` | 요청당 최대 재시도 횟수입니다. |
| `retry.baseDelayMs` | number | `500` | 초기 백오프입니다. |
| `retry.maxDelayMs` | number | `300000` | 백오프 상한(5분)입니다. 제공자가 이보다 긴 대기를 지정했고 자격 증명/모델 대체도 성공하지 못하면 즉시 실패합니다. 단, `retry.waitForUsageReset`이 신뢰할 수 있는 할당량 초기화 대기를 허용하면 예외입니다. `0`은 상한을 해제합니다. |
| `retry.modelFallback` | boolean | `true` | 채팅 모델이 사용 불가능하면 다른 모델로 대체합니다. 온라인 세션 제목 생성 등 이 스위치를 따르는 역할 기반 도우미는 `false`일 때 첫 번째 결정 가능한 후보 이후 멈춥니다. `contextPromotion.enabled`와 독립적이며 `retry.fallbackChains`의 모델 전환을 멈추는 스위치입니다. |
| `retry.fallbackOn` | enum | `any` | 세션 턴(하위 에이전트 포함) 또는 어드바이저 턴의 어떤 요청 실패가 `retry.fallbackChains`를 순회할지 정합니다. `any`는 모든 제공자 오류에서 전환합니다. `usage-limit`는 사용량 제한(할당량 기간, 지출 상한, 잔액 소진)에서만 전환합니다. 세션 턴의 다른 재시도 가능 오류는 일반 백오프로 같은 모델을 `retry.maxRetries`까지 재시도한 뒤 표시하며, 거부를 포함한 재시도 불가능 오류는 즉시 표시합니다. `except-usage-limit`는 나머지 모든 오류에서 전환하고 사용량 제한은 기다리거나 표시합니다. 체인을 사용하지 않는 어드바이저는 자체 재시도/삭제 동작을 유지합니다(`docs/advisor-watchdog.md` 참조). 자격 증명 순환과 `retry.usageAwareFallback`에는 영향이 없습니다. |
| `retry.fallbackChains` | record | `{}` | 역할, 모델 선택자 또는 `provider/*` 와일드카드를 순서 있는 대체 선택자에 매핑합니다. `/`가 포함된 키는 모델 기준이며 역할보다 우선합니다. `provider/model-id`는 정확한 모델, `provider/*`는 제공자의 모든 모델과 일치합니다. `provider/*` **항목**은 실패한 모델 ID를 유지하고 제공자를 바꿉니다. 모델 종류 역할은 미설정이면 내장 체인을, `[]`이면 대체 없음을 사용하며 `default` 체인은 적용하지 않습니다. 알 수 없는 모델/제공자 또는 잘못된 체인은 시작 시 설정 경고로 보고합니다. |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | `cooldown-expiry`는 억제 기간이 끝나면 기본 모델로 돌아갑니다. `never`는 수동으로 전환할 때까지 대체 모델을 유지합니다. |
| `retry.waitForUsageReset` | boolean | `false` | 초기화 힌트 또는 완전한 사용량 보고가 신뢰할 수 있는 시각을 제공하면 제공자가 지정한 사용량 제한 대기가 `retry.maxDelayMs`를 넘도록 허용합니다. 대기는 중단할 수 있지만 하위 에이전트도 대기시킬 수 있습니다. |
| `retry.usageAwareFallback` | boolean | `false` | 턴 전에 신뢰할 수 있는 코딩 요금제 할당량 보고를 사용하여 정상적인 같은 제공자 계정을 우선하고 이후 구성된 대체 모델을 선택합니다. 사용량을 알 수 없으면 현재 모델을 유지하며 일반 API 키는 제외합니다. |
| `retry.usageReservePct` | number | `10` | 사용량 인식 대체가 보호할 잔여 할당량 비율입니다. |
| `retry.usageReservePolicy` | enum | `confirm` | `confirm`, `auto`, `fail-closed`. 예비량에 도달하면 `confirm`은 대화형 확인자가 있을 때 묻고 아니면 자동 대체합니다. 소진한 할당량은 확인 없이 대체할 수 있습니다. `fail-closed`는 알려진 예비량/소진 할당량을 사용하는 대신 차단합니다. |
| `providers.anthropic.serverSideFallback` | boolean | `false` | 지원되는 직접 연결 Claude Fable/Mythos 요청에 Anthropic의 `server-side-fallback-2026-06-01` 베타를 사용합니다. 카탈로그 소유 서버 측 체인은 현재 `claude-opus-5-5`가 아닌 `claude-opus-5`를 대상으로 합니다. 지원하지 않는 모델과 호스트에는 체인이 없습니다. |

활성 채팅 모델이 계속 실패하고(429, 할당량 한계, 제공자 장애) `retry.modelFallback`이 켜져 있으면 세션은 구체성 순으로 실패 모델을 소유한 체인을 선택합니다. 정확한 `provider/model-id` 키, `provider/*` 와일드카드, 현재 역할의 체인, `default` 순입니다. `default`는 어떤 역할에도 속하지 않는 실시간 모델(`/model` 전환, 임시 전환)도 소유합니다. 유효 체인은 소유 역할의 기본 모델 다음 구성된 항목으로 이루어지며, 체인 어디에도 없는 실시간 선택자에는 전체 체인을 제공합니다. 여러 역할이 같은 모델을 할당해도 YAML 키 순서로 결정하지 않습니다. 실시간 세션 역할이 우선하고, 세션이 해당 역할에 있지 않으면 다른 일치 채팅 역할보다 `default`가 우선합니다. 선택자가 아직 쿨다운 중인 채팅 후보는 건너뛰고 나머지 턴 동안 전환합니다. 모델 종류 실행기는 자체 이름 있는 역할 체인을 별도로 결정하며 `default`를 사용하지 않습니다. 에이전트 정의에 여러 모델 패턴이 있으면 하위 에이전트는 생성별 자체 체인을 받습니다. 첫 번째 결정 가능한 패턴이 기본 모델이고 나머지는 대체값입니다. `fallbackChains`에는 `agent:<name>` 키가 없습니다. 단일 모델로 생성된 하위 에이전트는 역할 체인(`@reviewer` → `fallbackChains.reviewer`) 또는 역할 체인이 없으면 `default`를 상속합니다. 명시적 `[]`이면 `default`에 같은 모델을 할당했어도 대체하지 않습니다. 정확한 모델 및 `provider/*` 키는 여전히 상속된 체인보다 우선합니다.

`openrouter/google/*` 같은 접두사 와일드카드를 체인 키나 항목으로 사용할 수 있습니다. 접두사 아래의 ID와 일치하거나 제공자를 바꿀 때 실패 모델의 순수 ID 앞에 접두사를 붙입니다. 접미사 없는 대체 항목은 실패 턴의 사고 수준을 상속하고 명시적인 접미사는 이를 대체할 수 있습니다. 체인을 소진하면 복구 과정에서 현재 대체 모델 자체의 체인도 확인할 수 있으며, 각 전환은 여전히 재시도 횟수를 소비합니다. 복구 순서와 할당량 동작은 [재시도 정책](./non-compaction-retry-policy.md)을 참조하세요.

재시도 모델 대체는 컨텍스트 승격과 다릅니다. `contextPromotion.enabled: false`는 모델의 `contextPromotionTarget`으로의 [컨텍스트 승격](./models.md#context-promotion)만 끕니다. 제공자 오류 후 `retry.fallbackChains`가 활성 모델을 전환하지 못하게 하려면 `retry.modelFallback: false`를 설정하세요. 같은 모델 재시도와 압축은 계속 사용할 수 있습니다.

<a id="tools-and-approvals"></a>
### 도구 및 승인

```yaml
tools:
  format: auto
  approvalMode: yolo # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| 키 | 타입 | 기본값 | 참고 |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.format` | enum | `auto` | 도구 전송 형식: `auto`, `native`, `glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma`, `minimax`. `native`는 항상 제공자 기본 도구 호출을 사용합니다. `auto`도 기본 호출을 사용하지만 선택 모델이 명시적으로 `supportsTools: false`이면 모델 계열 소유 방언을 선택하고 알려진 계열 방언이 없으면 GLM을 사용합니다. 다른 값은 해당 인밴드 방언을 강제합니다. `xml`은 [일반 XML 형식](./toolconv/xml.md), `minimax`는 [MiniMax 형식](./toolconv/minimax.md)입니다. [GLM](./toolconv/glm-4.5.md), [Qwen3/Hermes](./toolconv/qwen3.md), [Kimi](./toolconv/kimi-k2.md), [Anthropic](./toolconv/anthropic.md), [DeepSeek](./toolconv/deepseek.md), [Harmony](./toolconv/harmony.md), [Gemini](./toolconv/gemini.md), [Gemma](./toolconv/gemma.md)를 참조하세요. |
| `tools.approvalMode` | enum | `yolo` | `always-ask`(읽기 전용 자동 승인), `always-ask-cached`(**묻고 기억**: 파일 읽기 전에도 묻고 파일/폴더를 기억할 수 있음. [승인 모드](./approval-mode.md) 참조), `write`(읽기 + 작업 공간 쓰기 자동 승인), `yolo`(모든 등급 자동 승인). `--approval-mode`와 `--auto-approve`/`--yolo`로 실행별 재정의가 가능합니다. |
| `tools.approval` | record | `{}` | 도구 이름을 키로 하는 도구별 정책으로 값은 `allow`, `deny`, `prompt`입니다. 예: `omp config set tools.approval '{"bash":"prompt"}'`. |
| `tools.restrictedFolders` | array | `[]` | 승인 모드(`yolo` 포함)나 기억된 허용 내역에 관계없이 모든 읽기, 쓰기, 편집, 검색, 명령에 명시적인 승인이 필요한 폴더입니다. 해당 폴더와 그 아래의 모든 항목을 포함하며, 명령은 실행 디렉터리를 기준으로 판단합니다. [승인 모드](./approval-mode.md#restricted-folders)를 참조하세요. |
| `tools.maxTimeout` | number | `0` | 에이전트가 요청할 수 있는 최대 제한 시간(초)입니다. `0`은 설정 상한 없음입니다. |
| `tools.intentTracing` | boolean | `true` | 에이전트에게 도구 호출별 의도를 설명하도록 요청합니다. `PI_INTENT_TRACING`이 재정의합니다. |
| `tools.outputMaxColumns` | number | `768` | 스트리밍 출력의 줄별 바이트 상한입니다. `0`은 비활성화합니다. |
| `tools.artifactSpillThreshold` | number | `50` | 도구 출력이 이 KB를 넘으면 아티팩트로 내보냅니다. |
| `tools.artifactHeadBytes` | number | `20` | 아티팩트로 내보낼 때 인라인으로 유지할 앞부분 KB입니다. `0`은 뒷부분만 유지합니다. |
| `tools.artifactTailBytes` | number | `20` | 아티팩트로 내보낼 때 인라인으로 유지할 뒷부분 KB입니다. |
| `tools.artifactTailLines` | number | `500` | 아티팩트로 내보낼 때 인라인으로 유지할 뒷부분 최대 줄 수입니다. |
| `tools.artifactMaxBytes` | number | `16` | 스트리밍 도구 출력(bash, python, js eval)을 저장하는 아티팩트 파일의 MB 상한입니다. 더 큰 출력은 잘림 안내 앞뒤로 시작 부분(최대 3MB)과 나머지 최신 부분을 유지합니다. `0`은 무제한입니다. |
| `tools.xdev` | boolean | `true` | 모든 스키마를 직접 노출하는 대신 검색 가능한 도구를 `xd://` 장치 URL에 마운트합니다. 끄면 활성화된 도구를 최상위에 노출합니다. |
| `tools.xdevDocs` | enum | `catalog` | `inline`은 모든 마운트 문서/스키마를 포함하고, `builtins`는 내장 항목만 인라인으로 포함하며, `catalog`는 장치를 나열하고 필요할 때 문서를 가져옵니다. |
| `tools.xdevInlineDevices` | array | `[]` | `builtins` 모드에서 인라인으로 포함할 동적 장치 이름 glob입니다. `catalog` 모드에서는 무시합니다. |
| `async.enabled` | boolean | `true` | 비동기 bash 명령과 백그라운드 작업 실행을 활성화합니다. |
| `async.maxJobs` | number | `100` | 실행 중인 백그라운드 작업 상한으로 최소 1로 내림 제한합니다. 대기/큐 작업은 실행 슬롯을 소비하지 않습니다. |
| `async.printWake` | boolean | `false` | 출력 모드(`-p`, `--mode json`)에서 종료 시 백그라운드 작업을 취소하는 대신 기다리고, 결과마다 같은 세션에서 새 턴을 시작합니다. `--wait-async`와 같습니다. |
| `async.widgets` | boolean | `true` | `wait` 카드, 작업 표시 및 호버 카드, 작업 시트에서 실행 중인 백그라운드 작업의 실시간 위젯(출력 기반 차트, 막대, 상태 격자)을 표시합니다. `widget` 모델 역할이 작업별 사양 하나를 작성하며 이후 갱신은 모델 호출 없이 로컬에서 계산합니다. 끄면 일반 작업 행을 표시합니다. |

마운트는 여전히 세션의 명시적인 도구 허용 목록을 따릅니다. `read`만 허용하고 `write`를 생략한 세션이 장치 전용 쓰기 전송을 받을 수는 있지만, 파일 시스템 쓰기 권한이 생기는 것은 아닙니다.

개별 내장 도구와 Eval 프렐류드는 자체 키로 켜고 끕니다. 예: `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `computer.enabled`, `ratchet.enabled`(기본 `false`. `ratchet(flow)` eval/힐 클라이밍 프렐류드이며 `/ratchet`은 현재 세션에서만 활성화), `archive.enabled`(기본 `true`. 프롬프트 이력, 최근 프로젝트, 이전 세션, 요약의 읽기 전용 `archive` eval 프렐류드), `astEdit.enabled`, `astGrep.enabled`, `find.enabled`(`auto`/`on`/`off`. `auto`는 `judge` 역할이 기본 TypeSafe jev 모델로 결정될 때만 `find` 활성화), `web_search.enabled`. 이미지 질문은 `read <image>?q=<question>`를 사용하며 `images.questionTimeoutMs`를 따릅니다.

<a id="window-scoped-computer-use"></a>
### 창 범위 컴퓨터 사용

기본적으로 비활성화된 `computer` Eval 프렐류드는 운영 체제 기본 API로 실제 호스트 창을 캡처하고 제어합니다. 창 핸들은 포커스를 바꾸거나 실제 포인터를 움직이지 않고 앱을 격리합니다. `desktop` 객체는 선택한 디스플레이의 합성 화면과 전역 입력 동작을 유지합니다. Chromium/CDP 탭과 구조화된 페이지 자동화를 관리하는 `browser` Eval 프렐류드와는 별개입니다.

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| 키 | 타입 | 기본값 | 참고 |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `computer.enabled` | boolean | `false` | 창을 인식하는 `computer` Eval 프렐류드를 활성화합니다. `/computer` 슬래시 명령은 현재 세션에서만 전환합니다. |
| `computer.display` | string | `all` | `desktop` 대상만 제어합니다. 모든 활성 디스플레이를 합성하거나 숫자 디스플레이 ID 하나를 사용합니다. |
| `computer.maxWidth` | number | `3840` | 합성 스크린샷 최대 너비(픽셀)입니다. GitHub Copilot Responses, xAI OAuth 등 원본 세부 정보를 보존할 수 없는 이미지 전송에서는 유효 너비를 `1280`으로 제한합니다. Claude 계열 모델도 호환성 대체로 같은 상한을 사용합니다. |
| `computer.maxHeight` | number | `2400` | 합성 스크린샷 최대 높이(픽셀)입니다. 해당 좌표 안전 전송은 유효 높이를 `896`으로 제한하며 다른 모델은 설정 제한을 유지합니다. |
| `computer.backgroundFallback` | enum | `takeover` | 창 입력 호출의 백그라운드 경로가 사용 불가능할 때의 동작입니다. `takeover`는 해당 호출만 제어권을 넘겨받아 다시 실행하고 사용자 앱으로 포커스를 돌려주며(macOS는 사용자가 계속 입력했어도 복원, X11과 Windows는 일반 제어권 인계로 실행) 결과에 이를 알립니다. `refuse`는 `BackgroundUnavailable`로 실패하며 제어권을 가져오지 않습니다. `takeover`에서 호출 자체가 `takeover`를 전달하면 다시 실행하지 않습니다. `refuse`에서는 모델 자체의 `takeover: true`, `raise()`, 활성화하는 `apps.open`, `control.acquire`, 데스크톱 루트 입력, macOS 외의 `el.focus()`, macOS에서 메뉴를 여는 호출(오른쪽 클릭, Control 클릭, `AXShowMenu`, `menu` 옵션, 팝업/메뉴 버튼의 누르기·왼쪽 클릭·길게 누르기·드래그, 팝업 버튼의 `setValue`)을 전송 전에 거부합니다. |

컴퓨터 설정과 활성 모델의 좌표 안전 이미지 제한은 호출마다 읽습니다. 런타임 변경과 성공적으로 다시 읽은 파일 편집은 다음 호출부터 적용됩니다. 직접 `computer` 도우미와 `computer.run(fnOrCode, options)`에 전달한 코드는 데스크톱 루트 또는 `window(...)`로 대상을 선택합니다. 대상 전환은 이전 좌표 프레임을 무효화하므로 포인터 입력 전에 새 대상을 캡처하세요. 입력 활성화 전에 `tools.approvalMode` 또는 `tools.approval.computer`를 구성하고 플랫폼 권한을 부여하세요. [창 범위 컴퓨터 사용](computer-use.md)을 참조하세요.

<a id="shell-eval-and-lsp"></a>
### 셸, eval, LSP

```yaml
bash:
  enabled: true
  allowCompoundCommands: false
  autoBackground:
    enabled: true
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| 키 | 타입 | 기본값 | 참고 |
| --------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash.enabled` | boolean | `true` | bash 도구를 활성화합니다. |
| `bash.allowCompoundCommands` | boolean | `false` | 평면 리터럴 `&&` 체인을 구간별로 평가합니다. 일치하지 않는 구간은 일반 bash 승인 정책과 모드를 상속합니다. |
| `bash.gitGuard` | boolean | `false` | 여러 에이전트가 공유하는 체크아웃용입니다. 병합/리베이스 충돌 해결 중이 아니면 `git stash`(`list`/`show`/`create` 제외), `reset --hard`, 다른 커밋으로의 `reset`, `switch`와 브랜치 `checkout`, 경로에 대한 `checkout`/작업 트리 `restore`를 거부합니다. 스테이징 해제는 허용합니다. 내장 셸의 `git` 내장 명령이 강제하므로 확장된 명령과 실제 cwd를 확인합니다. 서비스, 클라이언트 터미널, `pty` 호출, 경로나 다른 프로그램을 통해 시작한 git은 보호하지 않습니다. |
| `launch.enabled` | boolean | `true` | 공유하는 장기 실행 프로젝트 프로세스를 위한 이름 있는 `bash` 서비스와 `proc://` 관리를 활성화합니다. 별도 launch 도구는 없습니다. |
| `bash.autoBackground.enabled` | boolean | `true` | 오래 실행되는 명령을 자동으로 백그라운드로 보냅니다. |
| `bash.autoBackground.thresholdMs` | number | `60000` | 자동 백그라운드 전환 전 임계 시간입니다. |
| `bash.direnv` | enum | `auto` | `auto`는 허용된 저장소 `.envrc`를 내장 bash 세션에 읽어 들이고 `off`는 통합을 끕니다. `direnv allow`를 우회하지 않습니다. |
| `bash.direnvLoadTimeoutMs` | number | `30000` | 초기 `direnv export`의 최대 대기 시간입니다. 시간 초과 시 세션에 direnv 환경을 적용하지 않습니다. |
| `eval.py` | boolean | `true` | Python eval 백엔드입니다. `PI_PY=0`은 해당 프로세스에서 비활성화합니다. |
| `eval.js` | boolean | `true` | JavaScript eval 백엔드입니다. `PI_JS=0`은 해당 프로세스에서 비활성화합니다. |
| `eval.autoProvision` | boolean | `true` | 첫 `%bun add`에서 관리형 JavaScript eval 패키지 환경을 만듭니다. |
| `eval.tools.enabled` | boolean | `true` | 커널에서 정의한 `@tool` / `tool(fn)` 함수를 `task`, `agent()`, `workpool()` 하위 에이전트에 노출합니다. |
| `eval.workpool.freshAgents` | boolean | `false` | 유휴 작업자 재사용이나 대기 항목 일괄 처리 대신 항목마다 새 workpool 에이전트를 생성합니다. |
| `python.kernelMode` | enum | `session` | `session`(영속 커널) 또는 `per-call`입니다. |
| `python.interpreter` | string | `""` | Python 인터프리터 경로입니다. 비어 있으면 자동 탐지합니다. |
| `lsp.enabled` | boolean | `true` | 언어 서버 통합입니다. `--no-lsp`는 해당 실행에서 비활성화합니다. |
| `lsp.lazy` | boolean | `true` | 필요할 때 서버를 시작합니다. |
| `lsp.shared` | boolean | `true` | 브로커가 관리하는 프로젝트별 LSP 멀티플렉서를 통해 언어 서버를 시작합니다. 연결마다 자체 서버를 받습니다. 해제된 서버는 다음 연결을 위해 최대 5분간 유지되지만 다른 omp 프로세스가 프로젝트 멀티플렉서를 실행 중일 때만 가능합니다. 마지막 프로세스 종료 몇 초 후 멀티플렉서가 멈춥니다. 브로커를 사용할 수 없으면 전용 서버로 대체합니다. |
| `lsp.diagnosticsOnWrite` | boolean | `true` | 쓰기 후 진단을 실행합니다. |
| `lsp.diagnosticsOnEdit` | boolean | `false` | 편집 후 진단을 실행합니다. |
| `lsp.formatOnWrite` | boolean | `false` | 쓸 때 파일을 포맷합니다. |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | 중복 진단을 합칩니다. |
| `lsp.requestTimeout` | number | `10` | 에이전트가 `timeout`을 지정하지 않았을 때 언어 서버의 진단, 호버 등 응답을 기다리는 초입니다(호출 기한은 최소 20초). 편집 후 늦은 진단도 적어도 이만큼 기다립니다. `lsp` 도구의 `timeout`은 5–300초와 `tools.maxTimeout` 범위 안에서 호출별로 늘리거나 줄입니다. |
| `shellPath` | string | _(미설정)_ | 서비스, 터미널, `!`용 외부 셸입니다. 일반 bash 도구 호출은 내장 brush를 사용합니다. |
| `shellCommandPrefix` | string | _(미설정)_ | 자체 셸 도구를 구성하는 이전 Pi 확장에 전달합니다. OMP 기본 셸에는 적용하지 않습니다. |

<a id="files-editing-and-reading"></a>
### 파일: 편집 및 읽기

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace, sloppy
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true
  blackbox:
    enabled: false

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| 키 | 타입 | 기본값 | 참고 |
| ------------------------- | ------- | ---------- | ------------------------------------------------- |
| `edit.mode` | enum | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`, `sloppy`. `PI_EDIT_VARIANT`로 모드를 고정합니다. |
| `edit.modelVariants` | record | `{}` | 순서 있는 대소문자 무시 모델 선택자 부분 문자열 → 편집 모드 매핑입니다. 첫 일치 항목이 적용됩니다. |
| `edit.fuzzyMatch` | boolean | `true` | 퍼지 앵커 일치를 허용합니다. |
| `edit.fuzzyThreshold` | number | `0.95` | 퍼지 일치의 유사도 임계값입니다. |
| `edit.blockAutoGenerated` | boolean | `true` | 생성된 파일이나 잠금 파일 같은 파일 편집을 거부합니다. |
| `edit.streamingAbort` | boolean | `false` | 스트리밍 편집 불일치 시 중단합니다. |
| `edit.enforceSeenLines` | boolean | `true` | 이전 읽기/검색에서 전체가 표시된 적 없는 줄에 고정한 편집을 거부합니다. |
| `edit.recoverInlineEdits` | boolean | `true` | 어시스턴트 텍스트에서 인식한 편집 조각을 복구합니다. |
| `edit.autoRepair.enabled` | boolean | `false` | 새로 생긴 AST 파싱 회귀를 `smol` 모델에 수정하도록 요청합니다. 다시 파싱에 성공한 수정만 수락하며 아니면 경고합니다. |
| `edit.blackbox.enabled` | boolean | `false` | AST 파싱 회귀 시 전체 소스를 덧붙입니다. |
| `read.defaultLimit` | number | `300` | 선택자 없이 `read`할 때 기본 줄 수입니다. |
| `read.summarize.enabled` | boolean | `true` | 코드 읽기에 구조 요약을 제공합니다. |
| `read.summarize.prose` | boolean | `false` | 산문 파일도 요약합니다. |
| `read.toolResultPreview` | boolean | `false` | 도구 결과의 인라인 미리 보기입니다. |
| `read.renderMarkdown` | boolean | `false` | Markdown 문서 읽기를 TUI에서 렌더링합니다. |
| `readLineNumbers` | boolean | `false` | 일반 줄 번호를 표시합니다. |

<a id="context-compaction-and-memory"></a>
### 컨텍스트, 압축, 메모리

`/extended-context on`은 더 큰 컨텍스트 창을 사용하고 `/extended-context off`는 표준 창과 프리미엄 요금 상한을 복원합니다. `openai-codex/gpt-6-astra`, `openai-codex/gpt-6.1-sol` 및 해당 `-wm` 경로에서 off는 Codex 기본 창(Astra 272,000토큰, GPT-6.1 Sol 500,000토큰)을 사용하고 on은 검토된 922,000토큰 입력 창(128K 출력을 포함한 총 1.05M 컨텍스트) 또는 검색된 더 높은 최댓값을 사용합니다. 검토된 최댓값은 오래된 낮은 검색값을 바로잡습니다. `models.yml`의 명시적인 모델별 `contextWindow` 재정의는 두 모드 모두에서 우선합니다. 토글이 해당 모델을 다시 제어하게 하려면 재정의를 제거하세요. Codex 재정의는 여전히 서버가 실제로 허용하는 유효 상한으로 제한하므로 임의의 더 큰 창이 아닌 검토된 최댓값 또는 더 높은 실시간 최댓값을 허용합니다.

사용자 정의 제공자는 `models.yml`의 모델 또는 `modelOverrides` 항목에 `contextWindow`(일반)와 `maxContextWindow`(확장)를 설정하여 같은 토글을 사용할 수 있습니다. `maxContextWindow` 없는 `contextWindow` 재정의는 두 모드에서 고정됩니다. [모델 구성](models.md)을 참조하세요. 이 값은 로컬 예산을 제어하며 업스트림 엔드포인트가 받는 요청 크기를 바꾸지는 않습니다.

압축 여유 공간은 이 선택 기능과 별개입니다. 기본 15% 예비량에서 문서화된 Astra 확장 창의 자동 압축 임계값은 783,700토큰입니다. 별도의 긴 컨텍스트 요금 배수가 없어도 더 큰 창은 더 많은 사용량을 소비할 수 있습니다.

```yaml
extendedContext: false

contextPromotion:
  enabled: false

compaction:
  enabled: true
  methodOrder: [remote, snapcompact, handoff, shake, soft]
  midTurnEnabled: true # check thresholds between tool-loop provider requests
  thresholdPercent: -1 # -1 = default reserve-based behavior
  thresholdTokens: -1 # fixed token limit when > 0
memory:
  backend: off # off, local, hindsight, mnemopi
```

| 키 | 타입 | 기본값 | 참고 |
| ----------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extendedContext` | boolean | `false` | 더 큰 모델 창을 사용합니다. `/extended-context on`, `off`, `status`. |
| `workspace.additionalDirectories` | array | `[]` | 모든 세션에 추가할 작업 공간 루트입니다. 상대 경로는 cwd에서 해석합니다. `/add-dir`와 `/remove-dir`로 실시간 관리합니다. |
| `contextPromotion.enabled` | boolean | `false` | 컨텍스트 초과 시 활성 모델의 명시적인 `contextPromotionTarget`으로 승격합니다. `retry.fallbackChains`에는 영향이 없으며 그 전환은 `retry.modelFallback`이 제어합니다. |
| `compaction.enabled` | boolean | `true` | 자동 대화 압축입니다. |
| `compaction.asyncEnabled` | boolean | `true` | 컨텍스트가 압축 임계값에 가까워지면 백그라운드에서 미리 요약하고, 임계값을 넘을 때 준비된 결과를 삽입합니다. |
| `compaction.midTurnEnabled` | boolean | `true` | 다음 제공자 요청 전에 안전한 턴 중간 도구 루프 경계에서 임계값을 검사합니다. `false`는 구성한 세션에만 적용합니다. 하위 에이전트는 전체 할당이 한 턴이므로 항상 검사합니다. |
| `compaction.methodOrder` | array | `remote, snapcompact, handoff, shake, soft` | 순서 있는 대체 방법입니다. `remote`는 제공자 기본 서버 압축(OpenAI Responses compact, Anthropic 압축 베타)을 사용합니다. 사용 불가능하거나 실패하면 다음 방법으로 진행합니다. |
| `compaction.thresholdPercent` | number | `-1` | 컨텍스트 대비 비율 트리거입니다. `-1`은 예비량 기반 기본값입니다. |
| `compaction.thresholdTokens` | number | `-1` | `> 0`일 때 고정 토큰 트리거입니다. |
| `compaction.modelThresholds` | record | `{}` | `provider/model-id` 또는 `*`로 끝나는 접두사(`deepseek/*`)를 키로 하는 모델별 압축 제한입니다. 압축 정책이 비례 계산하는 토큰 기준량(`90000`), 고정 토큰 트리거(`"f90000"`), 창의 비율(`"80%"`)을 사용합니다. 아래를 참조하세요. |
| `compaction.modelThresholdsEnabled` | boolean | `true` | `compaction.modelThresholds` 적용 여부입니다. `task.agentCompactionThresholdOverrides` 항목이 있는 하위 에이전트는 이를 끈 상태로 실행합니다. |
| `task.agentCompactionThresholdOverrides` | record | `{}` | 정확한 task/eval 에이전트 이름 → 압축 트리거 매핑입니다. 양수 토큰 수(`90000`) 또는 비율 문자열(`"80%"`)입니다. 아래를 참조하세요. |
| `compaction.reserveTokens` | number | _(미설정)_ | 절대 예비량 하한입니다. 미설정이면 `16384`와 컨텍스트 창의 15% 중 큰 값을 유효 예비량으로 사용합니다. 기본값으로 인해 작은 창의 실용적인 예산이 사라지면 15% 예비량으로 대체합니다. |
| `compaction.keepRecentTokens` | number | `20000` | 요약 압축에서 유지할 최근 이력 토큰 예산입니다. |
| `compaction.autoContinue` | boolean | `true` | 압축 후 자동으로 계속합니다. |
| `memory.backend` | enum | `off` | `off`, `local`, `hindsight`, `mnemopi`. 백엔드마다 자체 `hindsight.*` / `mnemopi.*` / `memories.*` 조정 키가 있습니다. |
| `autolearn.enabled` | boolean | `false` | 실험적 기능: 상시 교훈 캡처 지침과 `manage_skill`(메모리 백엔드 활성 시 `learn`도)을 활성화합니다. 관리형 스킬은 `<agent dir>/managed-skills`에 저장됩니다. |
| `autolearn.autoContinue` | boolean | `false` | 조건에 맞는 기본 에이전트 정지 후 비공개 캡처 턴을 실행합니다(추가 토큰 소비). 끄면 상시 지침만 유지하며 다음 턴에 숨겨진 알림을 삽입하지 않습니다. 중단, 계획 모드, 목표 루프 턴은 건너뜁니다. |
| `autolearn.minToolCalls` | number | `5` | 자동 캡처 대상이 되기 위해 기본 턴에서 완료해야 하는 최소 도구 호출 수입니다. |

양수 `compaction.thresholdTokens`는 `thresholdPercent`보다 우선합니다. 이 값 또는 `f` 모델 항목 같은 고정 트리거가 모델 컨텍스트 창 이상이면(예: 제공자가 창을 더 작게 제한한 경우) 예비량 기반 기본값처럼 창에서 예비량을 뺀 지점에 압축합니다. `/models` 미리 보기에는 `capped by window`로 표시합니다. 그 외 양수 비율은 1–99%로 제한하고 0 이하 비율은 예비량 기반 임계값을 사용합니다.

트리거는 설정한 값 그대로입니다. 작은 창이나 제공자가 제한한 창에서는 대신 최근 이력을 덜 유지합니다. 유지할 꼬리 이력은 `0.8 × 트리거 − reserveFloor`(하한만으로 이를 채우면 `0.8 × 트리거`의 절반)로 제한하여 압축 결과가 트리거의 복구 구간 아래에 오도록 합니다. `reserveFloor`는 유효 예산 예비량과 `compaction.reserveTokens`(미설정 시 `16384`) 중 작은 값입니다. 예를 들어 100k 창에 `thresholdPercent: 40`이면 40,000토큰에서 압축하고, 최근 이력은 설정값 20,000 대신 최대 15,616토큰을 유지합니다.

`compaction`에는 `omp config list`에서 볼 수 있는 추가 조정 키(유휴 압축, 대체/삭제 휴리스틱)가 있습니다. 전체 전략 참조는 [압축](./compaction.md)을 확인하세요.

모델별 압축 제한은 일치하는 모델에 적용합니다. 토큰 수는 일반 정책이 비례 계산할 기준량입니다. omp는 임계값 계산 시 이를 모델 창으로 취급하므로 기본값에서는 기준량에서 예비량을 뺀 지점(약 109k 초과 기준량은 85%)에, `compaction.thresholdPercent: 80`이면 기준량의 80%에 압축합니다. 전역 `compaction.thresholdTokens`는 해당 모델에 적용하지 않습니다. 대신 정확한 트리거로 지정하려면 수 앞에 `f`를 붙이세요(`f400k`, 저장값 `"f400000"`). 비율 항목은 두 `compaction.threshold*` 설정을 대체하고 실제 창에 비례 계산합니다. 요청과 초과 처리는 여전히 실제 창을 사용합니다. `/models` 미리 보기는 각 모델의 압축 지점을 표시합니다. 제한을 설정하려면 **역할** 보기에서 역할이나 대체 행을 선택하고 `k`를 누르거나 **압축 제한**을 클릭한 뒤 `400k`, `f400k`, `1M`, `80%`를 입력하세요(빈 입력은 초기화). 전역 설정에 정확한 `provider/model-id` 키를 씁니다. 직접 작성하려면:

```yaml
compaction:
  thresholdPercent: 80
  modelThresholds:
    "deepseek/*": 90000
    "openrouter/anthropic/*": "60%"
    anthropic/claude-opus-5.5: 150000 # base: compacts at 80% of 150k
    openai/gpt-5.6-terra: "f400000" # fixed: compacts at exactly 400k
```

- 정확한 `provider/model-id` 키가 우선하며 아니면 `*`로 끝나는 가장 긴 일치 접두사를 적용합니다. `*`는 끝에만 허용하고 모든 키에 `provider/` 부분이 필요합니다.
- 항목 값은 아래 `task.agentCompactionThresholdOverrides`처럼 파싱하고(`null`은 하위 계층 항목 지움), 추가로 `"fN"` 고정 형식을 허용합니다. 에이전트 항목의 토큰 수는 항상 정확한 트리거이며 거기에는 `f` 접두사를 허용하지 않습니다.
- 트리거는 활성 모델을 따릅니다. 모델 전환, 컨텍스트 승격, 어드바이저는 각자 모델 항목을 사용합니다.
- `task.agentCompactionThresholdOverrides` 항목은 해당 에이전트의 모델 항목보다 우선하며 실행 중에 추가한 항목도 포함합니다.
- 프로젝트 설정에 같은 모델 키가 있으면 허브는 편집을 거부합니다. 대신 프로젝트 설정을 변경하세요.
- 표준 모델 창보다 큰 토큰 기준량 또는 표준 창 이상의 고정 트리거는 `extendedContext`를 켜지 않고도 해당 모델의 확장 창을 사용합니다(`extendedContext`가 제공하는 창이며 긴 컨텍스트 요금 등급 포함). 기준량은 원하는 창 크기이므로 비례 계산한 트리거가 표준 창 안에 있어도 확장 창을 엽니다(272K 모델에 `300k` 기준량을 주면 255K에 압축하지만 더 큰 창으로 실행하여 예비량을 여유 공간으로 유지). 표준 창을 유지하려면 표준 창 이하의 기준량 또는 표준 창 미만의 `f` 트리거를 사용하세요. 허브는 먼저 경고하고 Enter를 두 번째 누르면 저장합니다. 모델의 최대 실행 가능 창보다 큰 기준량과 최대 창 이상의 고정 트리거는 거부합니다. `task.agentCompactionThresholdOverrides` 항목이 적용되는 하위 에이전트는 모델 항목을 무시하므로 표준 창을 유지합니다.

task/eval 하위 에이전트의 에이전트별 압축 트리거입니다. 아래는 기본 세션을 40,000토큰으로 유지하고 `scout`는 창의 80%, `task`는 90,000토큰에서 압축합니다.

```yaml
compaction:
  thresholdTokens: 40000

task:
  agentCompactionThresholdOverrides:
    scout: "80%"
    task: 90000
```

- 키는 대소문자를 구분하는 정확한 에이전트 이름입니다(`scout`는 `Scout`와 일치하지 않음).
- 숫자는 고정 토큰 트리거(양의 정수), `"N%"` 문자열은 컨텍스트 창의 비율이며 `0 < N ≤ 100`입니다. 항목은 해당 에이전트의 `compaction.thresholdTokens`와 `compaction.thresholdPercent`를 모두 대체합니다.
- `null`은 우선순위가 낮은 설정 계층의 항목을 지웁니다. 다른 값은 설정 읽기에 실패합니다.
- 항목이 없는 에이전트(재정의된 에이전트가 생성한 에이전트 포함)는 기본 세션의 `compaction.*` 임계값을 사용합니다. 기본 세션과 Vibe 작업자는 영향받지 않습니다.
- 결정된 트리거는 하위 에이전트 세션과 함께 저장되며 되살릴 때 재사용합니다.

<a id="appearance-and-terminal"></a>
### 외관 및 터미널

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto # off, auto, always
```

| 키 | 타입 | 기본값 | 값 |
| ----------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `theme.dark` | string | `titanium` | 어두운 터미널 배경에서 사용하는 테마입니다. |
| `theme.light` | string | `light` | 밝은 터미널 배경에서 사용하는 테마입니다. |
| `symbolPreset` | enum | `unicode` | `unicode`, `nerd`, `ascii`. |
| `colorBlindMode` | boolean | `false` | diff 추가 항목에 녹색 대신 파란색을 사용합니다. |
| `showHardwareCursor` | boolean | `true` | 터미널 하드웨어 커서를 표시합니다. |
| `statusLine.preset` | enum | `default` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`. |
| `statusLine.separator` | enum | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent` | boolean | `true` | 편집기 테두리를 세션 색으로 칠합니다. |
| `statusLine.transparent` | boolean | `false` | 상태 줄에 터미널 배경을 사용합니다. |
| `statusLine.showHookStatus` | boolean | `true` | 훅 상태 메시지를 표시합니다. |
| `terminal.showImages` | boolean | `true` | 터미널이 지원하면 이미지를 인라인으로 렌더링합니다. |
| `images.autoResize` | boolean | `true` | 모델 호환성을 위해 큰 이미지의 크기를 조절합니다. |
| `images.blockImages` | boolean | `false` | 제공자에게 이미지를 보내지 않습니다. |
| `tui.hyperlinks` | enum | `auto` | `off`, `auto`, `always`. |
| `tui.autoGraph` | enum | `always` | 그래픽을 지원하는 터미널에서 에이전트 답변의 숫자 표를 테마 색상의 차트로 만듭니다. `always`는 내장 최선 추정을 사용합니다. `smart`는 숫자 열이 여러 개이거나 번호가 붙은 행이 있는 표에서 판단 모델이 차트를 다듬도록 합니다(종류, 열, 행 이름/그룹, 축척/기준 행, 각 지표의 좋은 방향, 초점 행, 제목). `off`는 표를 그대로 둡니다. Tern에는 SVG로 보냅니다. TUI 기본 세션에만 적용합니다. 하위 에이전트 기록, print, RPC, ACP 출력은 일반 형식이며 시스템 프롬프트에서도 다이어그램/차트 지침을 생략합니다. |
| `tui.mouse` | boolean | `false` | 기본 세션에서 마우스 클릭을 캡처하여 실시간 하위 에이전트 카드와 HUD 행을 클릭하면 포커스를 주고 호버 대상을 강조합니다. 활성 시 기본 텍스트 선택은 Shift+드래그, 휠 스크롤은 Shift+휠이 됩니다. |
| `display.pinnedAgents` | enum | `collapsed` | 편집기 위 고정 실시간 에이전트 바로가기 목록입니다. `off`는 숨김, `collapsed`는 확장 버튼과 일부 행 표시, `full`은 전체 표시입니다. |
| `display.subagentLivePreview` | boolean | `false` | 고정된 각 하위 에이전트의 현재 또는 가장 최근 도구 호출을 바로가기 목록 행 아래에 표시합니다. |
| `tui.resizeScrollback` | enum | `rebuild` | 너비 조절이 안정된 뒤 터미널 스크롤백에 유지된 기록 행을 갱신하는 방식입니다. `append`는 남겨둔 이력 아래에 새 너비로 기록을 재생하고, `rebuild`는 패널 스크롤백을 지운 뒤 현재 너비로 한 번 재생하며, `preserve`는 뷰포트만 다시 그립니다. |
| `tui.completeScrollback` | boolean | `false` | 커지는 HUD나 대화상자가 화면 밖으로 밀어낸 기록 행을 즉시 스크롤백으로 보냅니다. 줄어들면 새 출력이 채울 때까지 기록과 입력 사이에 빈 행이 남습니다. |

사용자 정의 상태 줄은 `statusLine.preset: custom`으로 설정하고 `statusLine.leftSegments`, `statusLine.rightSegments`, `statusLine.segmentOptions`를 구성하세요. 어느 세그먼트 목록이든 `status`를 포함하면 `ctx.ui.setStatus()`로 등록한 확장 상태를 키 순서로 정렬하여 인라인으로 연결해 표시합니다. `statusLine.showHookStatus: false`이면 바닥글의 같은 상태를 숨깁니다.

`path` 세그먼트는 홈 디렉터리를 `~`로 줄입니다. Windows의 공유 경로 형식 처리는 도구 라벨과 오류 텍스트를 포함하여 긴 홈 이름과 기존 8.3 별칭(`ADMINI~1` 등)을 모두 인식합니다. 홈 접두사만 줄이며 나머지 경로 구성 요소의 표기는 유지하고 작업 디렉터리나 환경을 변경하지 않습니다. 상태 줄에 전체 경로를 유지하려면 `statusLine.segmentOptions.path.abbreviate: false`를 설정하세요.

`pi` 세그먼트는 브랜드에 활성 이름 있는 프로필 태그를 붙입니다(`π-work`. [프로필](config-usage.md#profiles) 참조). 태그를 숨기려면 `statusLine.segmentOptions.pi.showProfile: false`를 설정하세요.

`cost` 세그먼트는 기록된 세션 비용을 표시합니다. 활성 제공자/모델에 시간대별 요금이 있으면 피크 시간에는 `↑`, 비피크에는 `↓`를 붙이고 유휴 중에도 경계 시각에 갱신합니다. 화살표는 과거 지출이 아닌 현재 요율을 반영하며 정액 모델과 명시적인 비용 재정의에는 화살표가 없습니다. UTC 일정과 추정 의미는 [사용 비용과 시간 기반 요금](models.md#usage-costs-and-time-based-pricing)을 참조하세요.

<a id="interaction"></a>
### 상호작용

| 키 | 타입 | 기본값 | 값 |
| ---------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `steeringMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. 대기 중인 방향 조정 메시지의 전달 방식입니다. |
| `followUpMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. |
| `interruptMode` | enum | `immediate` | `immediate`, `wait`. |
| `doubleEscapeAction` | enum | `rewind` | `rewind`, `tree`, `none`: 되감기 선택기 열기, 세션 트리 열기, 아무 동작 안 함입니다. |
| `autoResume` | boolean | `false` | cwd의 가장 최근 세션을 자동 재개합니다. |
| `plan.enabled` | boolean | `true` | 계획 모드를 활성화합니다. |
| `plan.defaultOnStartup` | boolean | `false` | 계획 모드가 활성화되어 있으면 새로운 대화형 세션을 계획 모드로 시작합니다. Print/JSON(`--print`) 모드는 이를 무시하고 안내를 출력합니다. 헤드리스 계획 흐름에는 `--plan-yolo`를 사용하세요. |
| `ask.timeout` | number | `0` | 이 초 후 추천 ask 옵션을 자동 선택합니다. `0`은 자동 선택을 끕니다. `cfg://` 승인 프롬프트의 시간도 제한하지만 응답하지 않은 승인은 자동 선택 대신 쓰기를 거부합니다. |
| `ask.notify` | enum | `on` | `on`, `off`. |
| `input.bareExitOnEmptySession` | boolean | `true` | 첫 메시지 전에 정확히 `exit`, `quit`, `q`를 제출하면 종료합니다(대소문자 무시). |
| `input.bareSlashCommands` | boolean | `false` | `/` 없이 정확한 명령 이름을 실행합니다. 세션 메시지가 있으면 Enter를 두 번 눌러 확인해야 합니다. |
| `tui.vimMode` | boolean | `false` | 모달 프롬프트 편집을 활성화합니다. `tui.vimModeDisplay`는 `text`, `icon`, `none`을 선택합니다(기본 `text`). |
| `startup.quiet` | boolean | `false` | 스플래시를 포함한 환영/시작 UI를 숨깁니다. |
| `startup.showSplash` | boolean | `false` | 설정을 다시 실행하지 않고 일반 대화형 시작에서 전체 설정 애니메이션을 표시합니다. |
| `startup.changelogMode` | enum | `summary` | `summary`, `expanded`, `hidden`: 시작 시 릴리스 노트 표시 방식을 선택합니다. |
| `startup.setupWizard` | boolean | `true` | 새 온보딩 단계를 설정 버전당 한 번 표시합니다. |

<a id="providers-and-services"></a>
### 제공자 및 서비스

이미지 생성, 웹 검색, 음성 출력, 받아쓰기, 판단의 모델/백엔드 순서는 [모델](#models)의 해당 `modelRoles`와 `retry.fallbackChains` 항목으로 구성합니다. 이 섹션은 모델 선택과 독립적인 전송/서비스 동작을 설명합니다.

```yaml
providers:
  fetch: auto
  webSearchTimeoutSeconds: 60
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openaiLiveSteering: true
  openrouterVariant: default
  kimiApiFormat: auto
  cacheRetention: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

tts:
  localVoice: af_heart
  localSpeed: 1

speech:
  enabled: false
  voice: af_heart
  speed: 1

stt:
  enabled: false
  language: en
  submitTrigger: never

exa:
  enabled: true
  searchDelayMs: 1000

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| 키 | 타입 | 기본값 | 값 / 참고 |
| ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.webSearchTimeoutSeconds` | number | `60` | 웹 검색 전송의 후보별 제한 시간입니다. `300` 초과 값은 5분으로 제한합니다. 전체 체인 기한이 아니며 시간 초과 후 `web` 역할은 다음 후보로 진행합니다. |
| `providers.fetch` | enum | `auto` | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `firecrawl`, `jina`. |
| `providers.tinyModelDevice` | enum | `default` | 로컬 소형 모델의 ONNX 실행 제공자 또는 `mlx`(Apple Silicon, mlx-lm 경유)입니다. `PI_TINY_DEVICE`로 재정의합니다. |
| `providers.maxInFlightRequests` | record | `{}` | 같은 설정 루트를 사용하는 로컬 `omp` 프로세스 간 공유하는 LLM HTTP 요청의 제공자별 양수 동시성 제한입니다. 생략한 제공자는 무제한입니다. `omp config set`은 양수가 아니거나 숫자가 아닌 값을 거부합니다. |
| `providers.tinyModelDtype` | enum | `default` | 로컬 소형 모델의 ONNX 정밀도입니다. `PI_TINY_DTYPE`로 재정의합니다. |
| `tts.localVoice` | enum | `af_heart` | 로컬 Kokoro TTS 실행기의 음성입니다. 사용 가능한 로컬 음성은 `modelRoles.speech`와 독립적으로 구성할 수 있습니다. |
| `tts.localSpeed` | number | `1` | 로컬 Kokoro TTS 실행기(`tts` 도구, `omp say`)의 말하기 속도입니다. `1`은 일반 속도이며 `0.5`–`2.5`로 제한합니다. |
| `speech.voice` | enum | `af_heart` | 어시스턴트 출력 음성 읽기를 활성화했을 때 사용하는 Kokoro 음성입니다. |
| `speech.speed` | number | `1` | 어시스턴트 출력 음성 읽기의 말하기 속도입니다. `1`은 일반 속도이며 `0.5`–`2.5`로 제한합니다. |
| `stt.enabled` | boolean | `false` | 마이크 음성 인식을 활성화합니다. 인식 모델은 `modelRoles.dictation`으로 선택합니다. |
| `stt.language` | string | `en` | 음성 인식의 원본 언어 힌트입니다. |
| `stt.submitTrigger` | enum | `never` | 완료된 받아쓰기 자동 제출 시점입니다. `never`, `release`, `release-complete`, `say-submit`. |
| `providers.openaiWebsockets` | enum | `auto` | `auto`, `off`, `on`. |
| `providers.streamFirstEventTimeoutSeconds` | number | `-1` | 첫 스트림 이벤트 감시 제한입니다. `-1`은 제공자/환경 기본값, `0`은 비활성화, 양수는 초 단위입니다. |
| `providers.streamIdleTimeoutSeconds` | number | `-1` | 스트림 이벤트 사이 최대 무응답 시간입니다. 같은 `-1`/`0` 규칙을 따릅니다. |
| `providers.anthropic.slowMode` | enum | `off` | `off`, `auto`. 5시간 제한에 도달했고 해당 경로가 제공될 때 Anthropic 구독의 낮은 우선순위 복구를 사용합니다. `/slow on`으로 활성화합니다. |
| `providers.openaiLiveSteering` | boolean | `true` | GPT-6 응답 스트리밍 중 입력한 메시지를 다음 도구 경계까지 기다리지 않고 해당 응답에 전달합니다(Codex WebSocket의 `response.steer`). |
| `providers.openrouterVariant` | enum | `default` | `default`, `nitro`, `floor`, `online`, `exacto`. |
| `providers.kimiApiFormat` | enum | `auto` | `auto`, `openai`, `anthropic`. `auto`는 실시간 모델 메타데이터를 따릅니다. |
| `providers.cacheRetention` | enum | `auto` | `auto`, `short`, `long`, `none`. 지원하는 제공자에 전달할 프롬프트 캐시 유지 정책입니다. `auto`는 제공자 기본값(Anthropic: OAuth 구독자 세션 1시간, API 키 5분)을 유지하고 `PI_CACHE_RETENTION`을 따릅니다. `short`는 5분 강제, `long`은 지원 시 1시간 TTL 사용, `none`은 프롬프트 캐시와 캐시 친화성 라우팅 비활성화입니다. |
| `providers.cacheWarming` | enum | `idle` | `off`, `streaming`, `idle`. 프롬프트 캐시 워밍은 캐시 항목 만료 직전에 출력 토큰 예산 1로 마지막 요청을 재생합니다. Anthropic Messages는 첫 생성 출력에서 멈추고 Converse는 마지막 캐시 사용량을 반영하기 위해 총 1토큰 요청을 완료합니다. 예상 캐시 미스 회피 비용이 갱신 비용보다 최소 $0.05 클 때만 워밍합니다. 갱신이 캐시를 놓치거나 실패하면 다음 실제 요청까지 워밍을 중단합니다. `off`는 끄고, `streaming`은 긴 도구 실행 중 접두사를 보호하며 에이전트가 멈추면 종료합니다. `idle`은 마지막 실제 요청 후 30분까지 실행 사이에도 갱신합니다(계속할 확률 15%). 따라서 해당 시간보다 짧은 캐시 수명만 대상입니다(Anthropic/AWS Claude 5분 항목이며 OAuth 구독자 세션 같은 1시간 항목은 아님). 실제 사용한 유지 등급의 수명을 따르며 `providers.cacheRetention: none`이면 워밍하지 않습니다. 사용하는 유지 등급의 수명이 선언되지 않은 모델([모델](./models.md) 참조)은 워밍하지 않습니다. |
| `provider.appendOnlyContext` | enum | `auto` | `auto`, `on`, `off`. |
| `exa.enabled` | boolean | `true` | Exa 웹 검색 제공자를 활성화합니다. |
| `exa.searchDelayMs` | number | `1000` | Exa 웹 검색 요청 사이 최소 지연(밀리초)입니다. `0`이면 속도 조절을 끕니다. |
| `searxng.endpoint` | string | _(미설정)_ | SearXNG 인스턴스 URL입니다. |
| `searxng.token` | string | _(미설정)_ | SearXNG 토큰입니다. `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines`(쉼표로 구분한 엔진 이름 또는 bang 단축형. 예: `ddg, br, startpage`. API의 `engines=` 매개변수로 전송)/`searxng.safesearch`도 있습니다. |
| `auth.broker.url` | string | _(미설정)_ | 인증 브로커 URL입니다. 실제 자격 증명 연결에는 프로젝트/설정 오버레이 값이 아닌 환경 다음 전역 기본 설정을 사용합니다. |
| `auth.broker.token` | string | _(미설정)_ | 인증 브로커 토큰입니다. `OMP_AUTH_BROKER_TOKEN`이 전역 기본 설정보다 우선하며 브로커 토큰 파일은 대체값입니다. 프로젝트/설정 오버레이 값은 자격 증명 대상을 바꾸지 않습니다. |
| `task.agentAccountPools` | record | `{}` | 정확한 task/eval 에이전트 이름 → 제공자 ID → OAuth ID 키([클라이언트 계정 풀](./auth-broker-gateway.md#client-account-pools-routing-not-authorization)의 `identityKey` 값. Anthropic 예: `email:<address>\|org:<id>`. `omp usage accounts`로 나열) 매핑입니다. 에이전트는 나열한 제공자마다 해당 계정으로만 인증하고 다른 계정이나 API 키는 사용하지 않으며, 어느 계정도 처리하지 못하면 실패합니다. 빈 목록은 계정을 허용하지 않습니다. 잘못된 항목은 설정 읽기에 실패합니다. [Task 에이전트 검색](./task-agent-discovery.md#model-and-structured-output-precedence)을 참조하세요. |
| `secrets.enabled` | boolean | `false` | 제공자 요청 전에 구성된 비밀 정보 난독화와 자격 증명 형태 토큰의 내장 마스킹을 활성화합니다. [비밀 정보 난독화](./secrets.md)를 참조하세요. |

제공자 자격 증명과 사용자 정의 모델 정의는 별도로 구성합니다. [제공자](./providers.md)와 [모델](./models.md)을 참조하세요.

<a id="saved-reset-auto-consumption"></a>
#### 저장된 초기화권 자동 사용

`codexResets.autoRedeem`과 `claudeResets.autoRedeem`은 저장된 초기화권 사용을 독립적으로 제어합니다. `yes`는 자동 사용을 켜고 `no`는 끄며 `unset`은 최초 사용 전에 동의를 요구합니다. 질문할 프롬프트 UI가 없는 세션(`omp -p` 등)은 `unset`일 때 초기화권이 5분 이내에 만료되어 달리 소실될 경우에만 사용합니다. 다른 경우에는 `/usage reset`을 안내하며 동의를 기다립니다.

사용량 갱신에서 향후 **5분** 이내 만료되는 사용 가능한 저장 초기화권을 감지하면 사용량이 적거나 없어도, 예비 크레딧이 있어도, `salvageHorizonHours: 0`이어도 자동 사용을 시도합니다. 제공자 사용 조건, 적용 제한 요건, 쿨다운, 중복 사용 방지는 여전히 적용합니다.

`salvageHorizonHours`는 그보다 이른 사용량 기반 소진 방지를 제어합니다. `0`으로 설정해도 5분 최후 기회 규칙은 유지합니다. 모든 자동 사용을 끄려면 제공자의 `autoRedeem`을 `no`로 설정하세요.

직접 하나를 사용하려면 세션에서 `/usage reset` 또는 셸에서 `omp usage reset`을 사용하세요. 후자는 세션이나 TTY 없이 인증 브로커 클라이언트에서도 동작합니다. 인수 없이는 계정별 저장 초기화권을 `<provider>/<credential id>`별로 나열하고, 대상을 지정하면 해당 계정의 초기화권 하나를 사용합니다.

`omp usage`와 활성 계정 상태 줄의 사용량 세그먼트는 초기화권이 복원하는 계정의 가장 많이 찬 기간이 25% 이상 사용된 경우 **7일** 이내 만료되는 저장 초기화권을 표시합니다. **24시간** 이내에는 `omp usage`가 계정별 배너를 먼저 표시합니다. 위 자동 처리에서 초기화권을 사용하는지, 먼저 묻는지(대화형 omp 세션이 열린 동안만), 사용하지 않는지와 제공자가 허용할 때 즉시 사용하는 `/usage reset` 대상을 표시합니다. 대화형 TUI는 대화마다 한 번 경고합니다.

<a id="cost-limits"></a>
### 비용 제한

```yaml
session:
  warnCost: 5   # USD: 세션 지출이 이 금액에 도달하면 한 번 경고
  maxCost: 10   # USD: 이 지출부터 모델 요청 전송 중지
```

두 값은 기본적으로 미설정이며 양수 USD 금액을 받습니다. `--warn-cost`와 `--max-cost`로 한 실행에 한해 재정의할 수 있고 열린 세션에서 설정하거나 바꾸면 다음 요청부터 적용됩니다. 지출은 모델 카탈로그 가격에 따라 세션과 하위 에이전트의 모든 모델 요청을 셉니다. 에이전트 턴, 부가 요청(압축, 인계, 자문 검토, `/btw`, 캐시 예열), eval `completion()`/`judge()`/`judge_batch()`, 판단 기반 `find`, 이미지 질문, 텍스트 전용 모델의 이미지 설명, 편집 자동 복구, 작업 위젯을 포함합니다. 상한에서는 이들도 거부하고 세션 제목도 생성하지 않습니다. 메모리 추출(Mnemopi와 메모리 통합)은 백그라운드에서 실행하며 집계하거나 거부하지 않습니다. 요청을 보내기 전에 상한을 확인하므로 이미 진행 중인 요청은 상한을 넘겨 완료될 수 있습니다. `--resume`/`--continue`로 시작하거나 전환한 세션은 파일에 기록된 지출(하단과 `/usage`의 합계)부터 시작하며, 이전 실행의 백그라운드 하위 에이전트 지출과 부가 요청은 빠져 있습니다. `/new`는 0부터 시작하지만 포크, 분기, `/btw`는 세션 지출을 유지합니다. 상한으로 실행을 중지하면 대화형 TUI는 이유를 표시하고 거부된 프롬프트를 편집기에 돌려놓으며, 출력 모드는 상태 `3`으로 종료하고 RPC는 `error.code: "cost_cap"`을 보고합니다.

<a id="other-groups"></a>
### 기타 그룹

이 목록에서 개별 표로 다루지 않은 모든 스키마 경로는 명시적으로 `omp config list`를 참조하세요. 추가 그룹은 다음과 같습니다.

- 에이전트 동작 및 안전: `ask.*`, `dev.*`, `eval.*`, `features.*`, `goal.*`, `loop.*`, `model.loopGuard.*`, `model.toolCallLoopGuard.*`, `prewalk.*`, `recap.*`, `sharpshooter.*`, `task.*`, `tools.*`, `vault.*`.
- 실행 및 콘텐츠: `commit.*`, `completion.*`, `edit.*`, `error.*`, `extensionHandlers.*`, `generate_image.*`, `git.*`, `images.*`, `live.*`, `paste.*`, `power.*`, `read.*`, `shellMinimizer.*`, `speech.*`, `terminal.*`, `title.*`.
- 인터페이스 및 시작: `composer.*`, `display.*`, `input.*`, `marketplace.*`, `spelling.*`, `statusLine.*`, `startup.*`, `stt.*`, `tui.*`, `ttsr.*`, `update.*`.
- 검색, 공유, 인증: `auth.*`, `browser.*`, `claudeResets.*`, `codexResets.*`, `collab.*`, `commands.*`, `contextFiles.*`, `gc.*`, `ida.*`, `mcp.*`, `share.*`, `skills.*`, `stream.*`, `telemetry.*`. `contextFiles.extra`는 [컨텍스트 파일](./context-files.md#extra-filenames)에 설명되어 있습니다.
- 그룹 없는 키: `setupVersion`, `proseOnlyThinking`, `omitThinking`, `externalThinking`, `includeWorkspaceTree`, `autocompleteMaxVisible`, `emojiAutocomplete`, `disabledExtensions`, `inlineToolDescriptors`, `treeFilterMode`.

이 설정도 위와 같은 스키마 정의 타입 및 기본값 규칙을 따릅니다.

<a id="legacy-migration"></a>
## 이전 형식 마이그레이션

`omp`는 이전 설정 구조를 자동으로 마이그레이션합니다. 별도 조치가 필요하지 않으며 `config.yml`에서 볼 수 있는 변경을 알 수 있도록 나열합니다.

<a id="startup-migration-to-configyml"></a>
### 시작 시 `config.yml`로 마이그레이션

활성 에이전트 디렉터리에 `config.yml`과 호환 파일 `config.yaml`이 모두 없으면 쓰기가 가능한 시작 과정에서 다음 순서로 이전 소스를 병합합니다.

1. `<agent dir>/settings.json`.
2. `agent.db`에 저장된 설정(충돌하는 JSON 값보다 우선).

마이그레이션 결과가 비어 있지 않으면 `config.yml`에 씁니다. 쓰기에 성공한 뒤에만 파싱한 이전 JSON을 `settings.json.bak`으로 이름을 바꾸고 이전한 데이터베이스 설정을 지웁니다. 결과가 비어 있으면 YAML 파일을 만들지 않습니다.

기본 YAML 파일 중 하나라도 있으면 더 이상 이전 소스를 참조하지 않습니다. 일반 설정 로더도 다른 설정 파일에 `.json` 형식만 있으면 `.json` -> `.yml` 마이그레이션을 수행합니다.

<a id="field-level-migrations"></a>
### 필드 수준 마이그레이션

원시 설정을 읽을 때마다 적용하는 주요 마이그레이션입니다(전역, 프로젝트, 오버레이, 생성자 재정의). 표준 형식 변경은 이후 저장 때 파일에 반영됩니다.

| 이전 | 이후 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `inspect_image.enabled` / `inspect_image.mode` | 제거 |
| `inspect_image.timeoutMs`                                                | `images.questionTimeoutMs`                                                                                   |
| `queueMode`                                                              | `steeringMode`                                                                                               |
| 평면 `theme: "<name>"` 문자열 | `theme.dark` / `theme.light`(명도로 슬롯 선택. 내장 `light`/`dark`는 제거하여 기본값 사용) |
| 이전 `task.isolation.mode: none` | `task.isolation.enabled: false` |
| 이전 `task.isolation.mode: <backend>` | `task.isolation.enabled: true` + `isolation.backend: <backend>` |
| `task.simple` | 제거 |
| 이전 격리 백엔드(`worktree`, `fuse-overlay`, `fuse-projfs`) | `rcopy`, `overlayfs`, `projfs` |
| `lastChangelogVersion` | 마커 파일로 옮기고 `config.yml`에서 제거 |
| `doubleEscapeAction: branch` | `doubleEscapeAction: rewind` |
| `collapseChangelog` | `startup.changelogMode` (`true` → `summary`, `false` → `expanded`) |
| `edit.mode` / `edit.modelVariants`의 `atom`, `vim` 값 | `hashline` |
| `readHashLines` | 제거. 해시 앵커는 `edit.mode`를 따름 |
| `compaction.strategy` / `compaction.remoteEnabled` | `compaction.methodOrder`. 명시적인 전략/원격 비활성화는 유지 |
| `snapcompact.systemPrompt` 불리언 | `all` / `none` |
| `task.eager` / `todo.eager` 불리언 | `always` / `default` |
| `features.unexpectedStopDetection` 불리언 | `smart` / `none` |
| `inlineToolDescriptors` / `find.enabled` 불리언 | `on` / `off` |
| `spelling.autocomplete` 불리언 | `auto` / `off` |
| `search.enabled` / `search.contextBefore` / `search.contextAfter` | 해당 `grep.*` 키 |
| `serviceTier` / `serviceTierSubagent` / `serviceTierAdvisor` | 계열별 `tier.*`. `fastModeScope`는 제거 |
| `advisor.subagents` | `task.agentAdvisor.task` (`on` / `off`) |
| `dev.autoqa.consent` / `todo.reminders.max` | `dev.autoqaConsent` / `todo.remindersMax` |
| `providers.parallelFetch` | 제거. `providers.fetch` 사용 |
| `providers` 모델/백엔드 선택자, `tts.localModel`, `stt.modelName` | [모델](#models)에 설명된 역할/체인 마이그레이션. 폐기 키 제거 |
| `exa.enableSearch` / `exa.enableResearcher` / `exa.enableWebsets` | 검색 활성화를 `exa.enabled`로 통합. researcher/websets 토글 제거 |
| `computer.backend`, `tools.discoveryMode`, `tools.essentialOverride`, `mcp.discoveryMode`, `mcp.discoveryDefaultServers` | 제거 |

<a id="troubleshooting"></a>
## 문제 해결

<a id="a-project-setting-is-not-taking-effect"></a>
### 프로젝트 설정이 적용되지 않음

- `.omp/config.yml`이 있는 디렉터리에서 `omp`를 시작하세요. 설정 검색은 상위 디렉터리가 아닌 현재 작업 디렉터리의 `.omp/`만 확인합니다.
- `.omp/`가 비어 있지 않은지 확인하세요. 빈 설정 디렉터리는 무시합니다.
- 파일이 유효한 YAML이고 최상위가 매핑인지 확인하세요.
- 해당 디렉터리에서 `omp config get <key>`로 유효 값을 확인하세요.
- `--config` 오버레이와 런타임 플래그가 프로젝트 설정보다 우선한다는 점에 유의하세요.

<a id="a-global-array-disappeared-in-a-project"></a>
### 프로젝트에서 전역 배열이 사라짐

배열은 덧붙이지 않고 대체합니다. 프로젝트에서 `disabledProviders`, `enabledModels`, `cycleOrder`, `extensions` 또는 다른 배열을 설정하면 원하는 **전체** 값을 프로젝트 계층에 포함하세요. 전역 배열은 완전히 대체됩니다.

<a id="a-provider-is-still-available-after-editing-config"></a>
### 설정 편집 후에도 제공자를 사용할 수 있음

- 모델 제공자 ID(예: `anthropic`)와 검색 소스 ID(예: `claude`) 중 무엇을 비활성화했는지 확인하세요. 공유 `disabledProviders` 네임스페이스에 속하지만 효과가 다른 별도 ID입니다.
- 프로젝트나 오버레이의 `disabledProviders` 배열이 전역 배열을 대체하는지 확인하세요.
- 자격 증명은 환경 변수, `.env`, OAuth, 저장된 인증, `models.yml`에서 계속 공급될 수 있습니다. 제공자를 비활성화하면 이와 무관하게 선택을 차단하지만 올바른 계층을 편집했는지 확인하세요. [제공자](./providers.md)를 참조하세요.
- 실시간 다시 읽기가 마지막 유효 계층을 유지했다는 경고가 있는지 확인하세요. 제공자 소스 전환은 다음 검색부터 적용하므로 이미 열린 카탈로그/선택기는 새로 고쳐야 할 수 있습니다.

<a id="omp-config-set-changed-the-wrong-file"></a>
### `omp config set`이 다른 파일을 변경함

`omp config set`과 `omp config reset`은 활성 에이전트/프로필 디렉터리의 전역 기본 YAML 파일(`config.yml` 또는 기존 호환 `config.yaml`)에 씁니다. `omp config path`로 해당 디렉터리를 출력하고 `--profile`, `OMP_PROFILE`, `PI_CODING_AGENT_DIR`을 확인하세요. 프로젝트 로컬 키는 `<repo>/.omp/config.yml`을 직접 편집하세요.

<a id="a---config-overlay-fails-at-startup"></a>
### 시작 시 `--config` 오버레이가 실패함

`--config` 파일은 프로세스 로컬 YAML 매핑입니다. 파일 누락, 잘못된 YAML, 최상위 배열/스칼라는 치명적인 오류이며 우선순위가 낮은 설정으로 조용히 대체하지 않습니다. 경로나 내용을 수정하세요.

<a id="an-environment-variable-beats-my-config"></a>
### 환경 변수가 설정보다 우선함

일부 설정(모델 역할, eval 백엔드, 소형 모델 장치/정밀도, 인증 브로커, PTY)은 컴퓨터별 편의를 위해 환경 변수나 CLI 플래그로 재정의할 수 있으며 이 값이 `config.yml`보다 우선합니다. 저장된 값이 적용되도록 변수를 해제하거나 플래그를 제거하세요. [환경 변수 재정의](#environment-overrides)와 [환경 변수](./environment-variables.md)를 참조하세요.

<a id="omp-config-set-key-says-unknown-setting"></a>
### `omp config set <key>`가 "Unknown setting"을 표시함

키는 축약 없이 스키마 경로와 정확히 일치해야 합니다. `theme`이 아닌 `theme.dark`를 사용하세요. `omp config list`로 모든 유효 키를 확인하세요.
