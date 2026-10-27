<a id="context-files"></a>
# 컨텍스트 파일

컨텍스트 파일은 세션이 시작되기 전에 `omp`가 자동으로 검색하여 에이전트의 프로젝트 컨텍스트에 삽입하는 Markdown 지침 파일입니다. 저장소 규칙, 아키텍처 참고 사항, 테스트 및 리뷰 요구 사항, 사용자 계정이나 프로젝트에 항상 함께 적용되어야 하는 지침을 담는 데 사용하세요.

에이전트에게 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` 같은 파일을 읽으라고 요청할 필요가 없습니다. 관련 파일은 세션이 시작될 때 이미 검색되고 로드되어 컨텍스트에 포함됩니다.

<a id="how-context-files-relate-to-other-concepts"></a>
## 컨텍스트 파일과 다른 개념의 관계

이름이 비슷한 다음 네 가지는 서로 다르게 동작합니다. 구분해서 이해하세요.

- **컨텍스트 파일**은 일반 Markdown으로 읽혀 생성된 프로젝트 지침에 포함되어 에이전트에게 표시됩니다(기본 프롬프트 템플릿에서는 `<repo-rules>` 내부). 세션을 시작할 때 적용되는 지침이자 저장소 작업을 위한 배경 정보입니다.
- **상시 유지 규칙**은 최상위 네이티브 `RULES.md`에서 가져옵니다. 이 파일은 전체 본문이 모든 요청에 포함되는 항상 적용 규칙으로 변환되므로, 표시되는 대화가 길어져도 컨텍스트에 남아 효력을 유지합니다. 아래의 "상시 유지 규칙과 일반 컨텍스트"를 참고하세요.
- **검색 제공업체**는 각 도구가 파일을 어디에 보관하는지 아는 설정 소스 어댑터입니다. 전체 레지스트리는 `native`, `omp-plugins`, `claude`, `agent-plugins`, `codex`, `agents`, `claude-plugins`, `gemini`, `opencode`, `cursor`, `windsurf`, `cline`, `github`, `vscode`, `agents-md`, `claude-md`, `custom-context`, `mcp-json`, `ssh-json`, `builtin-defaults`입니다. 이 중 일부만 컨텍스트 파일을 제공합니다(`native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`, `claude-md`, `custom-context`). 나머지는 규칙, MCP 서버, 스킬, 명령어, 훅, 도구, SSH 호스트 같은 다른 기능을 제공합니다. 컨텍스트 파일을 제공하는 제공업체가 MCP 서버, 슬래시 명령어, 스킬, 훅, 도구, 프롬프트, 설정도 제공할 수 있습니다.
- **모델 제공업체**는 `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` 같은 추론 백엔드입니다. 두 종류의 ID가 하나의 `disabledProviders` 목록을 공유한다는 점 외에는 컨텍스트 파일과 관련이 없습니다. 아래의 "검색 제공업체 비활성화"와 [제공업체](./providers.md)를 참고하세요.

**스킬** 및 **규칙** 파일(상시 유지되는 `RULES.md`와는 다름)을 작성하는 방법은 [스킬](./skills.md)에서 설명합니다. `SYSTEM.md`로 시스템 프롬프트를 사용자 지정하는 방법은 [시스템 프롬프트 사용자 지정](./system-prompt-customization.md)에서 설명합니다.

<a id="native-omp-files"></a>
## 네이티브 `.omp` 파일

네이티브 제공업체는 새 프로젝트에 권장되는 형식입니다. 사용자 에이전트 디렉터리와 프로젝트 내부의 `.omp/` 디렉터리에서 파일을 읽으며, 검색 우선순위가 가장 높으므로 동일한 범위에서는 다른 모든 규약의 파일보다 우선합니다.

| 파일 | 범위 | 동작 |
| --- | --- | --- |
| `~/.omp/agent/AGENTS.md` | 사용자 | `native` 제공업체가 비활성화되지 않은 한 적용되는 사용자 수준 컨텍스트입니다. 주 세션과 조언자는 받지만, Task 하위 에이전트는 추가 작업 공간 루트를 다시 검색할 때도 받지 않습니다. [세션 유형별 입력](system-prompt-customization.md#inputs-by-session-type)을 참조하세요. |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | 프로젝트 | cwd에서 저장소 루트 방향으로 올라가며 찾은 **가장 가까운 비어 있지 않은 `.omp/` 디렉터리**에 `AGENTS.md`가 있을 때만 적용되는 프로젝트 컨텍스트입니다. 가장 가까운 디렉터리에 이 파일이 없더라도 OMP는 더 먼 `.omp/` 디렉터리로 검색을 이어가지 않습니다. 주 세션과 조언자는 받지만, Task 하위 에이전트는 상속하지 않습니다. |
| `~/.omp/agent/RULES.md` | 사용자 | 사용자 수준의 상시 유지 규칙 내용입니다. 컨텍스트 파일이 아닌 항상 적용 규칙으로 로드됩니다. |
| `<nearest-non-empty-ancestor>/.omp/RULES.md` | 프로젝트 | 상위 경로 탐색에서 선택된 동일한 가장 가까운 비어 있지 않은 `.omp/` 디렉터리에 `RULES.md`가 있을 때만 적용되는 프로젝트 상시 유지 내용입니다. |

다음 두 가지 세부 사항이 중요합니다.

- **가장 가까운 비어 있지 않은 `.omp/` 디렉터리가 네이티브 프로젝트 검색을 담당합니다.** 검색은 현재 작업 디렉터리에서 시작하여 저장소 루트 방향으로 올라갑니다. 비어 있지 않은 `.omp/`를 찾으면 멈추며, 네이티브 `AGENTS.md`와 `RULES.md`는 각각 그 디렉터리에서만 읽습니다. 파일이 없다고 해서 상위 디렉터리로 검색을 이어가지는 않습니다.
- **빈 디렉터리와 파일은 아무 내용도 제공하지 않습니다.** 상위 경로 탐색 중 빈 `.omp/` 디렉터리는 건너뜁니다. 선택된 비어 있지 않은 디렉터리 안에서도 빈 `AGENTS.md`나 `RULES.md`는 아무 내용도 제공하지 않습니다.

`~/.omp/agent`는 현재 활성 네이티브 에이전트 디렉터리를 간단히 표기한 것입니다. `PI_CODING_AGENT_DIR`로 위치를 변경할 수 있습니다. 이름이 있는 프로필(`omp --profile <name>`, `OMP_PROFILE` 또는 `PI_PROFILE`)은 기본적으로 `~/.omp/profiles/<name>/agent`를 사용합니다. `~/.claude` 같은 외부 도구의 사용자 기본 디렉터리는 프로필별로 구분되지 않습니다.

<a id="monorepo-example"></a>
### 모노레포 예시

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

`repo/packages/api`에서 세션을 시작하면 다음과 같이 동작합니다.

- 네이티브 컨텍스트 파일은 `repo/packages/api/.omp/AGENTS.md`(가장 가까운 파일)입니다. `repo/.omp/AGENTS.md`는 함께 포함되지 **않습니다**.
- `repo/packages/api/.omp/`가 가장 가까운 비어 있지 않은 네이티브 디렉터리이므로, 프로젝트 상시 유지 내용은 `repo/packages/api/.omp/RULES.md`에서만 가져올 수 있습니다. 이 파일이 없으면 `repo/.omp/RULES.md`는 사용되지 **않습니다**.

범위가 넓고 오래 유지될 프로젝트 배경 정보는 `AGENTS.md`에 넣으세요. `RULES.md`는 긴 대화에서도 계속 표시되어야 하는 짧고 엄격한 요구 사항에만 사용하세요. Task 하위 에이전트는 상위 에이전트에서 상속했거나 추가 작업 공간 루트에서 검색한 모든 `AGENTS.md` 컨텍스트 파일을 제외하지만 `RULES.md`는 계속 받으므로, 보조 에이전트가 반드시 따라야 하는 내용은 `RULES.md`에 넣으세요. 필터는 파일 이름만 기준으로 합니다. 다른 파일(예: `CLAUDE.md`)의 `@` 가져오기로 불러온 `AGENTS.md` 텍스트와 `AGENTS.local.md` 같은 `contextFiles.extra` 파일은 하위 에이전트에도 전달됩니다.

<a id="other-supported-context-conventions"></a>
## 지원되는 다른 컨텍스트 규약

`omp`는 다른 에이전트 도구의 컨텍스트 및 규칙 파일도 검색하므로, 기존 프로젝트를 마이그레이션하지 않고도 계속 사용할 수 있습니다.

외부 도구의 **사용자 수준** 소스(아래 표의 `claude`, `codex`, `gemini`, `opencode`, `github`)는 `enabledProviders`를 통해 명시적으로 활성화해야 합니다. 해당 도구의 프로젝트 수준 파일은 기본적으로 활성화되어 있습니다. 네이티브 및 `.agent` / `.agents` 사용자 소스는 기본적으로 활성화되어 있습니다. `CLAUDE_CONFIG_DIR`를 명시적으로 지정해도 Claude 사용자 검색이 활성화되며 사용자 기본 디렉터리 위치가 변경됩니다. 예를 들면 다음과 같습니다.

```yaml
enabledProviders:
  - claude
  - github
```

`"*"` 또는 `"all"`은 모든 외부 사용자 소스를 활성화합니다. 명시적으로 활성화하더라도 `disabledProviders`가 우선합니다.

| 제공업체 ID | 규약 경로 | 범위 | 참고 |
| --- | --- | --- | --- |
| `native` | `.omp/AGENTS.md` | 사용자 + 프로젝트 | 권장 OMP 형식입니다. 사용자 파일은 활성 네이티브 에이전트 디렉터리에 있으며, 프로젝트 파일은 저장소 루트 방향으로 올라가며 찾은 가장 가까운 비어 있지 않은 `.omp/` 디렉터리에서만 읽습니다. |
| `claude` | `.claude/CLAUDE.md` | 사용자 + 프로젝트 | 사용자 파일은 `~/.claude/CLAUDE.md`이며, 프로젝트 파일은 `<cwd>/.claude/CLAUDE.md`만 사용합니다(상위 디렉터리 탐색 없음). |
| `codex` | `.codex/AGENTS.md` | 사용자 | 사용자 파일 `~/.codex/AGENTS.md`만 사용합니다. 프로젝트 수준 Codex 컨텍스트는 `<cwd>/.codex/AGENTS.md`가 아니라 `agents-md` 제공업체를 통한 독립형 `AGENTS.md`에서 가져옵니다. |
| `gemini` | `.gemini/GEMINI.md` | 사용자 + 프로젝트 | 사용자 파일은 `~/.gemini/GEMINI.md`이며, 프로젝트 파일은 `<cwd>/.gemini/GEMINI.md`만 사용합니다(상위 디렉터리 탐색 없음). |
| `opencode` | `.config/opencode/AGENTS.md` | 사용자 | 사용자 파일 `~/.config/opencode/AGENTS.md`만 사용합니다. |
| `github` | `.github/copilot-instructions.md` | 사용자 + 프로젝트 | 프로젝트 파일 `<cwd>/.github/copilot-instructions.md`만 사용하며(상위 디렉터리 탐색 없음), 사용자 전역 파일 `~/.copilot/copilot-instructions.md`도 사용합니다(`COPILOT_HOME`으로 위치 변경 가능). `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`의 `AGENTS.md` 후보도 사용자 범위에서 검토하며, 일반적인 사용자 파일 하나만 유지하는 중복 제거가 적용됩니다. |
| `agents` | `.agent/AGENTS.md`, `.agents/AGENTS.md` | 사용자 + 프로젝트 | 사용자 파일은 `~/.agent/`와 `~/.agents/`에서 가져오며, 프로젝트 파일은 현재 디렉터리에서 저장소 루트까지 올라가며 검색합니다. |
| `agents-md` | `AGENTS.md` | 프로젝트 | 독립형(설정 디렉터리에 속하지 않는) `AGENTS.md` 파일입니다. 현재 디렉터리에서 저장소 루트까지 올라가며 검색하고, 저장소가 사용자 홈 디렉터리 아래에 중첩되어 있으면 저장소를 포함하는 워크스페이스 디렉터리도 홈 디렉터리 직전까지 검색합니다. 저장소 루트가 없고 세션이 홈 아래에 있으면 홈 디렉터리를 검색 경계로 사용하며, 그 경계의 파일도 포함합니다. 부모 디렉터리 이름이 `.`으로 시작하는 파일은 무시합니다. 이러한 파일은 대신 설정 디렉터리 제공업체에 속합니다. |
| `claude-md` | `CLAUDE.md` | 프로젝트 | 독립형(설정 디렉터리에 속하지 않는) `CLAUDE.md` 파일입니다. 현재 디렉터리에서 저장소 루트까지 올라가며 검색하고, 저장소가 사용자 홈 디렉터리 아래에 중첩되어 있으면 저장소를 포함하는 워크스페이스 디렉터리도 홈 디렉터리 직전까지 검색합니다. 저장소 루트가 없고 세션이 홈 아래에 있으면 홈 디렉터리를 검색 경계로 사용하며, 그 경계의 파일도 포함합니다. 부모 디렉터리 이름이 `.`으로 시작하는 파일은 무시합니다. 이러한 파일은 대신 설정 디렉터리 제공업체에 속합니다. |
| `custom-context` | `contextFiles.extra`의 이름 | 사용자 + 프로젝트 | `AGENTS.local.md`처럼 명시적으로 활성화하는 기본 파일명입니다. 프로젝트 탐색 방식은 `agents-md`와 같습니다. 사용자 에이전트 디렉터리도 검색하며, 세션이 연결된 워크트리에 있으면 기본 체크아웃 루트도 검색합니다. 추가로 로드되므로 깊이별 단일 슬롯을 차지하거나 가리지 않습니다. 설정하기 전에는 비어 있습니다. |
| `github` | `.github/instructions/**/*.instructions.md` | 프로젝트 규칙 | GitHub Copilot / VS Code 지침 파일은 규칙으로 변환됩니다. `applyTo: '*'`, `applyTo: '**'` 또는 `applyTo: '**/*'`는 항상 적용되는 내용으로 삽입됩니다. 그 외 `applyTo` glob은 필요할 때 생성된 설명과 함께 규칙집에 나열되며 `rule://<name>`으로 읽을 수 있습니다. `applyTo`가 없어도 규칙집 항목과 검색 경고가 생성됩니다. |

"(상위 디렉터리 탐색 없음)"으로 표시된 제공업체는 현재 작업 디렉터리의 설정 디렉터리만 확인합니다. 상위 디렉터리 탐색이 필요하면 네이티브 `.omp/AGENTS.md` 형식이나 독립형 `AGENTS.md` 또는 `CLAUDE.md`(`agents-md` / `claude-md` 제공업체)를 사용하거나, 설정 디렉터리가 있는 디렉터리에서 `omp`를 실행하세요.

검색 레지스트리에는 컨텍스트 파일을 전혀 제공하지 않는 제공업체도 있습니다. `cursor`(`.cursor/rules/*.mdc` 및 레거시 `.cursorrules` 규칙, MCP 서버와 설정), `windsurf`(`.windsurf/rules/*.md`, 레거시 `.windsurfrules`, 전역 Windsurf 규칙, MCP 서버), `cline`(`.clinerules` 규칙), `vscode` 및 `mcp-json`(MCP 서버), `claude-plugins`(Claude 마켓플레이스 플러그인: 스킬, 명령어, 규칙, 훅, 도구, MCP 서버), `omp-plugins`(OMP 플러그인: 스킬, 명령어, 규칙, 프롬프트, 훅, 도구, MCP 서버), `agent-plugins`(Agent Plugins 표준 패키지: 스킬 및 MCP 서버), `ssh-json`(SSH 호스트), `builtin-defaults`(내장 기본 규칙)가 여기에 해당합니다. 이들은 규칙 및 기타 기능과 아래의 공용 `disabledProviders` 스위치에 관련됩니다.

<a id="extra-filenames"></a>
## 추가 파일명

내장 검색은 고정된 이름(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md`)만 인식합니다. 다른 기본 파일명도 로드하려면 `contextFiles.extra`에 나열하세요.

```yaml
# ~/.omp/agent/config.yml
contextFiles:
  extra:
    - AGENTS.local.md
```

`/settings` → **컨텍스트** → **추가 컨텍스트 파일**에서도 **전역** 목록을 편집할 수 있습니다. `["AGENTS.local.md", "TEAM.md"]` 같은 JSON 배열을 입력하세요. `[]`는 전역 추가 파일을 비활성화하고, 필드를 비우면 전역 재정의가 제거됩니다. 프로젝트 설정(`.omp/config.yml`)에서 `contextFiles.extra`를 지정하면 이 행은 숨겨지므로, 저장소의 목록이 전역 설정에 복사되는 일은 없습니다. 변경하려면 프로젝트 설정을 편집하거나 제거하세요. 업데이트된 파일을 로드하려면 새 세션을 시작하세요.

기본적으로 목록은 비어 있습니다. 항목은 경로가 아닌 파일명입니다. 설정을 로드할 때 `../AGENTS.local.md`는 거부되며, 내장 이름인 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md`도 거부됩니다(이 파일들은 이미 제공업체가 있으므로 목록에 넣으면 파일이 중복되거나 가림 동작을 우회하게 됩니다). 이는 하드 코딩된 `.local.md` 형제 파일 검색을 대체하는 설정 가능한 방식입니다([#12496](https://github.com/can1357/oh-my-pi/pull/12496)). 사용할 이름을 직접 선택하며, 목록을 설정하지 않으면 아무것도 검색하지 않습니다.

각 이름은 독립형 `AGENTS.md`와 같은 방식으로 검색합니다(`agents-md` 탐색: cwd에서 저장소 루트까지 올라가며, 동일한 홈 디렉터리 경계 적용). 부모 디렉터리 이름이 `.`으로 시작하는 파일은 건너뜁니다. 빈 파일은 아무 내용도 제공하지 않습니다.

각 이름에 대해 다음 두 위치도 확인합니다.

- 활성 사용자 에이전트 디렉터리(`~/.omp/agent/<name>` 또는 프로필 / `PI_CODING_AGENT_DIR` 디렉터리)의 사용자 수준 파일. 실제로 적용되는 목록이 프로젝트 설정(`.omp/config.yml`)에서 왔다면 이 위치는 건너뜁니다. 따라서 저장소가 에이전트 디렉터리의 `config.yml` 같은 파일을 프롬프트로 가져올 수 없습니다.
- 세션이 연결된 git 워크트리에 있는 경우 `<primary-checkout>/<name>`. 일반 탐색은 워크트리의 `.git`에서 멈추므로, 기본 체크아웃에만 존재하고 gitignore로 제외된 `AGENTS.local.md`는 이 방식으로 가져옵니다. 기본 체크아웃의 루트만 확인하며, 그 안에서 cwd에 대응하는 디렉터리는 확인하지 않습니다.

추가 파일은 깊이별 단일 범위 슬롯을 차지하지 않으며, 그 슬롯을 차지한 파일에 가려지지도 않습니다. `AGENTS.local.md`는 `AGENTS.md`와 함께 로드됩니다. 같은 깊이에서는 추가 파일이 해당 범위에서 선택된 파일 뒤에 삽입되므로, 둘 중 추가 파일이 더 두드러집니다. 추가 파일 내부의 `@` 가져오기는 해당 파일 자체의 디렉터리를 기준으로 해석됩니다.

이름 하나를 끄려면 `disabledExtensions`를 사용하세요(`context-file:project:AGENTS.local.md` 또는 `context-file:user:AGENTS.local.md`). 제공업체를 끄려면 `disabledProviders: [custom-context]`를 사용하세요. 모든 배열 설정과 마찬가지로, 우선순위가 더 높은 계층은 목록에 추가하는 대신 목록을 교체합니다.

<a id="load-order-and-shadowing"></a>
## 로드 순서와 가림 동작

두 제공업체가 _동일한_ 범위를 나타내면 우선순위가 높은 제공업체가 선택됩니다. 전체 레지스트리 우선순위는 다음과 같습니다.

| 우선순위 | 제공업체 ID |
| ---: | --- |
| 100 | `native` |
| 90 | `omp-plugins` |
| 80 | `claude` |
| 75 | `agent-plugins` |
| 70 | `agents`, `claude-plugins`, `codex` |
| 60 | `gemini` |
| 55 | `opencode` |
| 50 | `cursor`, `windsurf` |
| 40 | `cline` |
| 30 | `github` |
| 20 | `vscode` |
| 10 | `agents-md` |
| 10 | `claude-md` |
| 9 | `custom-context` |
| 5 | `mcp-json`, `ssh-json` |
| 1 | `builtin-defaults` |

이후 검색된 파일은 범위별로 중복 제거됩니다.

- 모든 제공업체를 통틀어 **사용자 컨텍스트 파일 하나**만 유지됩니다. `native`의 우선순위가 가장 높으므로 `~/.omp/agent/AGENTS.md`가 다른 모든 사용자 수준 컨텍스트 파일을 가립니다.
- **추가 파일명은 이 슬롯을 사용하지 않습니다.** `contextFiles.extra`의 파일은 해당 범위에서 선택된 파일과 함께 로드됩니다. [추가 파일명](#extra-filenames)을 참고하세요.
- **디렉터리 깊이별로 프로젝트 컨텍스트 파일 하나를 유지합니다.** 깊이는 현재 디렉터리를 기준으로 측정합니다. cwd는 깊이 0, 부모는 깊이 1이며 이후에도 같은 방식입니다. 상위 디렉터리의 설정 하위 디렉터리(`.claude/`, `.github/`, `.gemini/`, …)는 해당 상위 디렉터리와 같은 깊이로 간주합니다.
- **동일한 깊이에서는 우선순위가 높은 제공업체가 나머지를 가립니다.**
- **깊이가 다르면 여러 파일이 유지됩니다.** 모노레포에서 상위 디렉터리의 `AGENTS.md`와 패키지 수준의 `AGENTS.md`는 깊이가 다르므로 둘 다 로드됩니다.
- **가져오기 확장 후 포함 관계에 있는 파일은 통합됩니다.** 더 나중에 오는 더 가까운 파일이 더 먼 상위 파일의 정규화된 전체 문단 시퀀스를 연속해서 포함하면, 그 상위 파일은 생략됩니다. 완전히 동일한 사본도 여기에 해당하지만, 바꾸어 표현하거나 다른 문단이 사이에 끼어 있는 경우에는 중복으로 취급하지 않습니다. 이 포함 관계 검사에서는 깊이가 없는 사용자 파일을 프로젝트 파일보다 먼저 정렬하므로, 일치하는 프로젝트 사본이 유지됩니다.

최종 삽입 순서는 **유지된 사용자 범위 파일이 먼저**, 그다음 더 먼 프로젝트 상위 디렉터리, 마지막으로 cwd에 더 가까운 프로젝트 파일 순입니다. 나중에 오는 파일은 생성된 컨텍스트의 끝에 더 가깝게 위치하므로 더 두드러집니다.

<a id="worked-shadowing-example"></a>
### 가림 동작의 구체적인 예시

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .github/copilot-instructions.md
```

`repo/packages/api`에서 시작하면 다음과 같이 동작합니다.

- `repo/AGENTS.md`는 `agents-md`가 깊이 2에서 찾아 유지합니다.
- `repo/packages/api/AGENTS.md`(`agents-md`, 우선순위 10)와 `repo/packages/api/.github/copilot-instructions.md`(`github`, 우선순위 30)는 모두 깊이 0으로 해석됩니다. GitHub의 우선순위가 더 높아 패키지 수준의 독립형 `AGENTS.md`를 가리므로, 해당 깊이에서는 Copilot 파일이 선택됩니다.
- 유지된 두 파일은 루트가 먼저, 패키지가 마지막이 되도록 정렬되므로 `packages/api`의 파일이 더 두드러집니다.
- `repo/packages/api/.omp/AGENTS.md`를 추가하면 `native`(우선순위 100)가 깊이 0에서 바로 선택되어 우선순위가 낮은 두 파일을 모두 가립니다.

<a id="injection-behavior"></a>
## 삽입 동작

검색된 컨텍스트 파일은 하나의 `<repo-rules>` 블록으로 삽입되며, 유지된 파일마다 위 정렬 순서대로 `<file>` 요소 하나가 들어갑니다. 이 블록은 정적 시스템 프롬프트 뒤에 오는 후행 `<project-context>` 시스템 블록에 위치하며, 작업 디렉터리에서 파생되는 다른 모든 섹션(`<dir-context>`, `<workspace-tree>`, `<workspace-roots>`)과 함께 배치됩니다. 따라서 서로 다른 디렉터리의 세션도 정적 프롬프트를 캐시된 접두부로 공유합니다.

```xml
<repo-rules>
MUST follow these context files for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</repo-rules>
```

`SYSTEM.md`에서 번들로 제공되는 사용자 지정 프롬프트 템플릿이나 사용자 지정 템플릿을 선택해도 동일한 후행 블록이 출력됩니다. 모든 모드에서 에이전트는 각 파일의 절대 경로와 완전히 확장된 Markdown 내용(`@` 가져오기가 이미 해석된 상태)을 봅니다.

로드는 자동으로 이루어집니다. 세션 중에 에이전트에게 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` 같은 파일을 검색하라고 지시할 필요가 없습니다.

워크스페이스 트리 스캔이 활성화되어 있으면(`includeWorkspaceTree`), 자동 로드되지 _않은_ 더 깊은 디렉터리의 `AGENTS.md` 파일(예: 현재 디렉터리 아래의 파일)은 별도의 `<dir-context>` 블록에 표시됩니다. 이 블록은 파일 경로를 나열하고, 해당 디렉터리를 편집하기 전에 파일을 읽으라고 에이전트에게 알려줍니다. 이러한 파일은 전체 내용이 삽입되는 것이 아니라 참조로 제공됩니다.

<a id="-imports"></a>
## `@` 가져오기

모든 컨텍스트 파일에서 `@path` 토큰은 삽입 전에 참조된 파일의 내용으로 인라인 확장됩니다.

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

정확한 규칙은 다음과 같습니다.

- **상대 경로는 가져오는 파일 자체의 디렉터리를 기준으로 해석되며**, 세션의 작업 디렉터리를 기준으로 하지 않습니다.
- **`~/`와 `~`**는 사용자 홈 디렉터리를 기준으로 해석됩니다. 절대 경로는 그대로 사용합니다.
- **펜스 코드 블록과 인라인 코드 구간 안의 토큰은 그대로 둡니다.** `@token`을 확장하지 않고 그 토큰에 _관해 설명_하고 싶을 때 유용합니다.
- **`git@github.com:org/repo.git`와 `user@example.com` 형태의 토큰은 가져오기로 취급하지 않습니다.** `@`가 줄의 시작에 있거나 공백 또는 탭 뒤에 있을 때만 가져오기 토큰으로 인정됩니다.
- **문장 끝 구두점은 경로에서 잘라냅니다**(`. , ; : ! ? ) ] } " '`). 따라서 `@docs/setup.md.`는 `docs/setup.md`를 가져옵니다.
- **가져오기는 최대 5단계까지 재귀적으로 수행됩니다.** 가져온 파일 자체에도 `@` 가져오기가 있을 수 있으며, 총 깊이는 최대 5입니다.
- **반복 가져오기와 순환 참조는 건너뜁니다.** 현재 확장 트리에 이미 포함된 파일은 다른 분기에서 참조하더라도 다시 확장하지 않습니다. 나중에 나타난 `@token`은 리터럴로 남습니다.
- **대상이 없거나 읽을 수 없으면 오류를 내는 대신 원래의 `@token` 텍스트를 그대로 남깁니다.**

<a id="sticky-rules-vs-normal-context"></a>
## 상시 유지 규칙과 일반 컨텍스트

대부분의 지침에는 일반 컨텍스트 파일(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …)을 사용하세요. 저장소 개요, 코드 스타일, 빌드 및 테스트 명령어, 리뷰 요구 사항, 로컬 규칙 등이 여기에 해당합니다. 이 내용은 세션 시작 시 생성되는 프로젝트 컨텍스트에 로드됩니다.

긴 대화로 인해 시작 컨텍스트가 대화 기록의 훨씬 위로 밀려난 뒤에도 계속 적용되어야 하는 소수의 엄격한 요구 사항에는 최상위 **`RULES.md`**를 사용하세요.

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md`는 특별하게 취급됩니다.

- 네이티브 위치에서**만** 읽습니다. 활성 사용자 에이전트 디렉터리와, cwd에서 저장소 루트 방향으로 탐색하여 선택한 가장 가까운 비어 있지 않은 프로젝트 `.omp/` 디렉터리가 해당됩니다. 해당 프로젝트 디렉터리에 `RULES.md`가 없더라도 OMP는 더 먼 `.omp/RULES.md`로 대체하지 않습니다.
- 컨텍스트 파일이 아니라 **항상 적용 규칙**으로 로드되므로 전체 본문이 모든 요청에 포함됩니다. 필요할 때만 읽는 규칙집 항목으로 격하되지 않으며, 긴 세션에서도 효력을 유지합니다. 기본적으로 시스템 프롬프트에 포함됩니다. `snapcompact.systemPrompt` 이미지화가 활성화된 비전 모델에서는 이 규칙을 포함한 시스템 프롬프트가 대신 첨부 이미지 프레임으로 전송될 수 있지만, 어느 방식이든 본문은 요청과 함께 전달됩니다.
- 세션 시작 시와 `/clear`, `/new` 같은 세션 범위 재구성 시 디스크에서 다시 검색합니다. 따라서 OMP 실행 중에 파일을 만들거나 편집하면 다음 초기화 시 적용되며, 다시 시작할 필요가 없습니다.
- **항상 상시 유지됩니다.** 프런트매터로 상시 유지 동작을 해제할 수 없습니다. 조건부 또는 선택적 적용이 필요하면 일반 규칙 파일을 작성하세요([스킬](./skills.md) 참고).
- 사용자 후보와 프로젝트 후보는 서로 다른 규칙 이름인 `RULES`와 `RULES@project`를 사용합니다. 둘 다 함께 로드될 수 있습니다. 규칙 중복 제거는 이름을 기준으로 하므로, 일반 규칙에 이 이름들을 사용하지 마세요. 네이티브 일반 규칙이 먼저 로드되어 상시 유지 후보를 가릴 수 있습니다.
- 사용자 지정 프롬프트, 덧붙이는 텍스트 또는 컨텍스트 파일에 이미 들어 있는 항상 적용 내용은 정규화된 문단 포함 관계 검사를 통해 생성되는 항상 적용 섹션에서 생략됩니다. 해당 내용은 이를 포함하는 원본을 통해 계속 전달됩니다.

`RULES.md`는 짧게 유지하세요. 긴 배경 정보는 `AGENTS.md`에 넣어야 합니다. 생성된 컨텍스트와 항상 적용 규칙은 모두 요청 시 시스템 프롬프트 컨텍스트를 차지합니다.

<a id="disabling-discovery-providers"></a>
## 검색 제공업체 비활성화

`~/.omp/agent/config.yml`, 프로젝트의 `.omp/config.yml` 또는 `--config` 오버레이에서 `disabledProviders` 설정으로 제공업체를 끌 수 있습니다.

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders`는 서로 관련 없는 두 하위 시스템이 사용하는, **하나의 공용 ID 네임스페이스를 가진 제공업체 전체 스위치**입니다.

| ID 종류 | 예시 | 목록에 넣었을 때의 효과 |
| --- | --- | --- |
| 검색 제공업체 ID | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`, `claude-md`, `custom-context` | 컨텍스트 파일뿐 아니라 해당 소스가 제공하는 MCP 서버, 슬래시 명령어, 스킬, 훅, 도구, 프롬프트, 설정을 포함한 전체 설정 소스가 제거됩니다. |
| 모델 제공업체 ID | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | 자격 증명이 있어도 해당 모델 백엔드가 선택 대상에서 제거됩니다. [제공업체](./providers.md)를 참고하세요. |

ID는 정확히 일치해야 하며 두 네임스페이스가 우연히 충돌하지 않습니다. `google`은 Google 모델 백엔드를 비활성화하고, `gemini`는 Gemini CLI 검색 파일을 비활성화합니다. 검색 제공업체를 비활성화하면 생각보다 영향이 큽니다. 예를 들어 `claude`를 비활성화하면 `CLAUDE.md`뿐 아니라 Claude를 통해 검색된 MCP 서버, 명령어, 스킬, 훅, 도구, 설정도 제거됩니다. 컨텍스트 파일만 제외하고 제공업체가 제공하는 나머지는 유지하려면 대신 [`disabledExtensions`](#disabling-a-single-context-file)를 사용하세요.

**경로 범위** 항목을 지원하는 설정은 `enabledModels`와 `disabledProviders`뿐입니다. 이를 통해 하위 트리별로 제공업체 사용 가능 여부를 다르게 지정할 수 있습니다.

```yaml
disabledProviders:
  - github # 모든 위치에서 비활성화
  - path: ~/work/legacy-claude
    providers:
      - claude # 이 디렉터리 아래에서만 비활성화
```

범위 지정 항목은 cwd가 설정된 경로와 같거나 그 아래에 있을 때 적용됩니다. `~`는 홈 디렉터리로 확장됩니다. 단순 문자열 항목은 모든 위치에 적용됩니다.

우선순위가 더 높은 설정 계층은 배열 설정에 추가하는 대신 **교체**한다는 점을 기억하세요. 전역 설정에서 `claude`를 비활성화했더라도 프로젝트 설정이 `disabledProviders: [github]`를 지정하면, 해당 프로젝트에서는 Claude 검색이 다시 활성화되고 GitHub만 비활성화됩니다. 전체 계층 우선순위, 병합 규칙, 경로 범위 배열의 세부 사항은 [설정](./settings.md)을 참고하세요.

<a id="disabling-a-single-context-file"></a>
## 개별 컨텍스트 파일 비활성화

`disabledProviders`는 전체 설정 소스를 제거합니다. 컨텍스트 파일 하나만 제외하고 해당 제공업체가 제공하는 나머지는 유지하려면 `disabledExtensions`에 해당 확장 기능 ID를 나열하세요.

```yaml
# ~/.omp/agent/config.yml, .omp/config.yml 또는 --config 오버레이
disabledExtensions:
  - context-file:user:CLAUDE.md
```

컨텍스트 파일 ID의 형식은 `context-file:<level>:<basename>`입니다. `<level>`은 `user` 또는 `project`이며, `<basename>`은 디렉터리 부분을 제외한 파일명입니다.

| ID | 비활성화 대상 |
| --- | --- |
| `context-file:user:CLAUDE.md` | 사용자 수준 `CLAUDE.md`를 비활성화하되, Claude의 MCP 서버, 명령어, 스킬, 훅, 도구, 설정은 계속 로드합니다. |
| `context-file:project:AGENTS.md` | 탐색이 도달하는 각 디렉터리 깊이의 **모든** 프로젝트 수준 `AGENTS.md`를 비활성화합니다. ID에는 깊이 정보가 없습니다. |
| `context-file:user:AGENTS.md` | 어느 제공업체가 제공했는지와 관계없이 이름이 `AGENTS.md`인 모든 사용자 수준 파일을 비활성화합니다. |

수준과 파일명만 일치 여부를 판단하므로, 항목 하나가 해당 수준에서 그 이름의 파일을 제공하는 모든 제공업체에 적용됩니다. 프로젝트 항목을 특정 깊이 하나로 제한할 수는 없습니다. 디렉터리별 제어가 필요하면 다르게 적용할 하위 트리에 프로젝트 `.omp/config.yml`을 사용하거나 위의 경로 범위 `disabledProviders` 형식을 사용하세요.

비활성화는 가림과 다르며, 그 차이는 동작에서도 드러납니다. 비활성화된 파일은 중복 제거 전에 제외되므로 해당 범위를 차지하지 않습니다. **이전에 그 파일에 가려졌던 파일이 대신 로드됩니다.** `.claude/CLAUDE.md`와 `AGENTS.md`가 모두 있는 프로젝트에서는 보통 `CLAUDE.md`가 깊이 0 범위에서 선택됩니다. `context-file:project:CLAUDE.md`를 비활성화하면 범위가 비는 것이 아니라 `AGENTS.md`가 프로젝트 컨텍스트가 됩니다. 해당 범위에 파일을 전혀 남기지 않으려면 각 후보 이름을 모두 비활성화하세요.

일상적인 두 가지 사용 사례는 다음과 같습니다.

- **비대화형 실행.** 자신의 대화형 세션에 맞춰 작성한 사용자 수준 컨텍스트 파일은, 자체 지침을 전달하는 다른 프로그램이 구동하는 `-p` 실행에는 대개 적합하지 않습니다. `--config` 오버레이에서 이를 비활성화하면 대화형 설정은 그대로 유지할 수 있습니다.
- **위임된 작업.** 한 에이전트가 다른 에이전트를 구동할 때 호출자의 운영 지침이 사용자 수준 컨텍스트로 피호출자의 프롬프트에 전달되어, 실제로 부여된 작업과 충돌할 수 있습니다.

`disabledExtensions`는 경로 범위를 지원하지 않습니다. `path:` 형식을 허용하는 것은 `enabledModels`와 `disabledProviders`뿐입니다. 모든 배열 설정과 마찬가지로 우선순위가 더 높은 계층에서 병합되지 않고 교체됩니다.

`/extensions`에서 ID를 대화형으로 살펴볼 수 있습니다. 이 명령은 검색된 모든 컨텍스트 파일의 수준, 소스, 현재 상태를 나열하며 동일한 설정을 켜거나 끕니다.

<a id="troubleshooting"></a>
## 문제 해결

<a id="a-file-is-not-loaded"></a>
### 파일이 로드되지 않음

- 네이티브 프로젝트 컨텍스트는 가장 가까운 비어 있지 않은 `.omp/` 디렉터리에서만 읽습니다. 해당 디렉터리에는 비어 있지 않은 `AGENTS.md`가 있어야 합니다. 없더라도 더 먼 네이티브 디렉터리로 검색을 이어가지 않습니다.
- 독립형 `CLAUDE.md`는 `native`가 아니라 `claude-md`가 처리합니다.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, `.github/copilot-instructions.md`는 현재 작업 디렉터리의 설정 디렉터리에서만 읽으며, 모든 상위 디렉터리에서 읽지는 않습니다.
- `~/.codex/AGENTS.md`와 `~/.config/opencode/AGENTS.md`는 사용자 수준 전용이며 프로젝트 대응 파일이 없습니다.
- 네이티브 및 독립형 제공업체에서 빈 파일은 아무 내용도 제공하지 않습니다.
- 비활성화된 검색 제공업체는 아무것도 제공하지 않습니다. 전역, 프로젝트, `--config` 계층 전체에서 `disabledProviders`를 확인하세요.
- 외부 사용자 소스는 명시적으로 활성화해야 합니다. `enabledProviders`에 `claude`, `codex`, `gemini`, `opencode`, `github`가 있는지 확인하세요. 프로젝트 소스에는 이러한 명시적 활성화가 필요하지 않습니다.
- 파일 하나만 개별적으로 끌 수도 있습니다. `disabledExtensions`에 일치하는 `context-file:<level>:<basename>` 항목이 있는지 확인하고, 프로젝트 항목은 모든 깊이에 적용된다는 점을 기억하세요. 이것이 원인이라면 `/extensions`에 해당 파일이 비활성화 상태(`disabled`)로 표시됩니다.
- 이름이 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md`가 아닌 파일은 `contextFiles.extra`에 나열되어 있을 때만 검색됩니다. 이 설정을 지정하지 않으면 연결된 워크트리에서는 기본 체크아웃의 사본을 볼 수 없습니다. 일반 탐색은 워크트리에서 멈춥니다.

<a id="the-wrong-file-wins"></a>
### 잘못된 파일이 선택됨

하나의 사용자 범위 또는 프로젝트 깊이에서는 우선순위가 높은 제공업체가 나머지를 가립니다(native > claude > agents/codex > gemini > opencode > github > agents-md > claude-md). 동작을 확실하게 고정하려면 지침을 `.omp/AGENTS.md`로 옮기거나(native가 항상 우선함) 경쟁하는 검색 제공업체를 비활성화하세요.

<a id="user-context-disappeared"></a>
### 사용자 컨텍스트가 사라짐

사용자 수준 컨텍스트 파일은 하나만 유지되며, `~/.omp/agent/AGENTS.md`의 우선순위가 가장 높습니다. 외부 사용자 소스는 `enabledProviders`를 통해 명시적으로 활성화해야 합니다. 네이티브 파일이 있으면 사용자 수준의 `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.copilot/copilot-instructions.md`, `~/.agent`/`~/.agents` 파일을 가립니다. 사용자 지침을 네이티브 파일로 통합하거나, 다른 도구의 파일을 선호하면 네이티브 파일을 제거하세요.

<a id="a-rulesmd-file-is-ignored"></a>
### `RULES.md` 파일이 무시됨

네이티브 `RULES.md` 위치에서만 상시 유지됩니다. 활성 사용자 에이전트 디렉터리와, cwd에서 저장소 루트 방향으로 선택된 가장 가까운 비어 있지 않은 프로젝트 `.omp/` 디렉터리가 해당됩니다. 더 가까운 비어 있지 않은 `.omp/` 디렉터리가 있으면, 그 안에 `RULES.md`가 없더라도 더 먼 네이티브 디렉터리를 차단합니다. 다른 위치의 `RULES.md`는 인식되는 규약이 아닙니다.

<a id="an--import-did-not-expand"></a>
### `@` 가져오기가 확장되지 않음

대상이 cwd가 아닌 가져오는 파일을 기준으로 존재하는지 확인하세요. 펜스 코드 블록이나 인라인 코드 구간 안의 가져오기는 의도적으로 리터럴로 남겨 둡니다. `git@`/이메일 형태의 토큰은 가져오지 않으며, 순환 참조는 건너뛰고, 확장은 5단계 후에 멈춥니다. 대상이 없으면 원래의 `@path` 텍스트가 변경되지 않고 남습니다.
