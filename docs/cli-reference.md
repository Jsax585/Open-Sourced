<a id="cli-reference"></a>
# CLI 레퍼런스

`omp`는 다음과 같이 실행합니다.

```sh
omp [command] [flags] [messages...]
```

첫 번째 위치 인수가 등록된 하위 명령이 **아니면**, `omp`는
일반적으로 기본 명령인 [`launch`](#launch-the-default-command)로 라우팅합니다.
따라서 `omp "fix the build"`는 해당 메시지로 세션을 시작하고, `omp models`는
`models` 하위 명령을 실행합니다. 반면 `marketplace`,
`uninstall`, `extensions` 같은 플러그인 관리 단어를 단독으로 사용하면 `omp plugin …`을 사용하라는 안내가 표시됩니다.
이러한 단어를 프롬프트로 사용하려면 `omp launch <word>`를 사용하세요.

인식되는 하위 명령 앞에 실행 플래그를 지정할 수 있습니다. 이러한 플래그는
`launch`와 `acp`에 전달되지만, 다른 하위 명령 앞에 지정된
인식 가능한 실행 전용 플래그는 적용되지 않고 제거됩니다(예: `omp --cwd dir update`).

`--profile`은 하위 명령 라우팅 전에 적용되므로,
`config`, `models`, `update` 같은 명령에도 해당 프로필 범위가 적용됩니다.

실행 시 도움말도 확인할 수 있습니다.

- `omp --help`는 사용자용 하위 명령과 자주 사용하는 실행 플래그를 나열합니다.
- `omp <command> --help`는 해당 명령의 공개 플래그와 예제를 출력합니다.

이 페이지는 공유 **실행 인터페이스**(`omp` / `omp launch`가
허용하는 플래그)와 모든 최상위 **하위 명령**을 통합한 레퍼런스입니다.
하위 명령별 플래그(예: `omp auth-broker --json`)는
각 명령의 `--help`에 설명되어 있습니다.

<a id="launch-the-default-command"></a>
## 실행(기본 명령)

`omp`와 `omp launch`는 코딩 세션을 시작합니다. 위치 인수는
초기 메시지가 됩니다.

```sh
# 대화형 세션
omp

# 초기 프롬프트가 있는 대화형 세션
omp "List all .ts files in src/"

# 초기 메시지에 파일/이미지 첨부(@ 접두사 사용)
omp @prompt.md @image.png "What color is the sky?"

# 비대화형: 프롬프트를 처리하고 종료(헤드리스 / 출력 모드)
omp -p "List all .ts files in src/"

# 이전 세션 계속하기
omp --continue "What did we discuss?"
```

인수 처리 방식:

- `@<path>`는 초기 메시지에 파일이나 이미지를 첨부합니다.
- 프로토콜 모드가 아닌 경우, TTY가 아닌 stdin을 자동으로 EOF까지 읽어 프롬프트
  텍스트로 사용합니다. `-` 표시를 추가하지 마세요. `--mode`를 생략하면
  파이프 입력이나 TTY가 아닌 stdin이 출력 모드를 선택합니다. stdin 텍스트가 없으면 argv 프롬프트나 첨부 파일이
  필요합니다.
- stdin 텍스트, 텍스트 첨부 파일, 첫 번째 위치 메시지를 합쳐
  초기 프롬프트를 구성합니다. 나머지 위치 메시지는 이후 턴으로 전송됩니다.
- `--`는 플래그 파싱을 종료합니다. 그 뒤의 모든 내용은 플래그처럼
  보이더라도 리터럴 메시지 텍스트로 처리됩니다.

<a id="launch-flags"></a>
### 실행 플래그

<a id="session-and-workspace"></a>
#### 세션 및 작업 공간

| 플래그 | 설명 |
| --- | --- |
| `--cwd <dir>` | 시작할 디렉터리입니다(실행 시 cwd를 재정의). |
| `--add-dir <dir>` | 작업 디렉터리 외에 작업 공간 디렉터리를 추가합니다(반복 사용 가능). |
| `--allow-home` | 임시 디렉터리로 자동 전환하지 않고 `~`에서 시작하도록 허용합니다. |
| `--profile <name>` | 인증, 세션, 설정, 캐시에 격리된 프로필을 사용합니다. |
| `--alias <name>` | 지정한 프로필의 셸 바로가기를 만들고 종료합니다. `--profile` 또는 `OMP_PROFILE`이 필요합니다. |
| `--config <file>` | 이번 실행에 추가 `config.yml` 형식의 오버레이를 로드합니다(반복 사용 가능). |
| `--session-dir <dir>` | 세션 저장 및 조회에 사용할 디렉터리입니다. |
| `--no-session` | 세션을 저장하지 않습니다(일시적 세션). |

<a id="session-history"></a>
#### 세션 기록

| 플래그 | 설명 |
| --- | --- |
| `--continue`, `-c` | 이전 세션을 계속합니다. |
| `--resume [id]`, `-r`, `--session [id]` | ID 접두사나 경로로 세션을 재개하며, 값을 지정하지 않으면 선택기를 엽니다. |
| `--restore [id]` | `--resume`과 같이 세션을 재개한 다음, 마지막 프로세스가 충돌하거나 종료되었을 때 끝내지 못한 작업, 즉 중단된 턴과 실행 중이던 하위 에이전트를 이어서 진행합니다. 대화형 전용이며 프롬프트를 받지 않습니다. [세션 작업](./session-operations-export-share-fork-resume.md#cli---restore)을 참조하세요. |
| `--fork <session>` | 저장된 세션(ID 접두사 또는 경로)을 새 세션으로 포크합니다. [세션 작업](./session-operations-export-share-fork-resume.md)을 참조하세요. |
| `--from-claude` | Claude Code 세션을 OMP로 가져옵니다. |
| `--from-codex` | Codex 세션을 OMP로 가져옵니다. |
| `--export <session>` | 세션 파일을 HTML로 내보내고 종료합니다. |
| `--no-title` | 제목 자동 생성을 비활성화합니다(`PI_NO_TITLE` [환경 변수](./environment-variables.md)와 동일). |

`--continue`, `--resume`, `--restore`, `--fork`, 외부 세션 가져오기는
영구 저장이 필요하므로 `--no-session`과 함께 사용할 수 없습니다. `--from-claude`와 `--from-codex`는
상호 배타적이며 `--continue`, `--resume`,
`--fork`와 함께 사용할 수 없습니다.

<a id="model-selection"></a>
#### 모델 선택

| 플래그 | 설명 |
| --- | --- |
| `--model <id-or-role>` | 사용할 모델 또는 설정된 역할입니다(역할: `slow` 또는 `@slow`; 모델 유사 일치: `opus`, `gpt-5.2`, `openai/gpt-5.2`). |
| `--smol <id>` | 가벼운 작업에 사용할 Smol/고속 모델입니다(또는 `PI_SMOL_MODEL`). |
| `--slow <id>` | 심층 분석에 사용할 저속/추론 모델입니다(또는 `PI_SLOW_MODEL`). |
| `--plan <id>` | 아키텍처 계획에 사용할 계획 모델입니다(또는 `PI_PLAN_MODEL`). |
| `--models <a,b,c>` | `Ctrl+P`로 순환 전환할 모델 패턴의 쉼표 구분 목록입니다. |
| `--provider <name>` | 사용할 제공업체입니다(레거시; `--model` 권장). |
| `--api-key <key>` | API 키입니다(기본값은 환경 변수 사용). |
| `--provider-session-id <id>` | 연속성과 캐시 범위 지정을 위해 제공업체 측의 특정 세션 ID를 재사용합니다. |
| `--prompt-cache-key <key>` | 이 세션의 제공업체 프롬프트 캐시 키를 재정의합니다. |
| `--service-tier <tier>` | OpenAI 서비스 등급: `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast` 중 하나입니다(`none`은 `service_tier`를 생략). |

모델 결정 방식은 [제공업체](./providers.md)와 [모델](./models.md)을 참조하세요.

<a id="thinking-and-reasoning"></a>
#### 추론 및 추론 처리

| 플래그 | 설명 |
| --- | --- |
| `--thinking <level>` | 추론 수준을 설정합니다. `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` 중 하나입니다. |
| `--hide-thinking` | TUI 출력에서 추론 블록을 숨깁니다(표시에만 영향; 모델 추론은 비활성화하지 않음). |
| `--print-thoughts` | 출력 모드의 텍스트 출력에 추론 블록을 포함합니다. |
| `--external-thinking` | 지원되는 GPT/Claude/Gemini 추론을 비활성화하고 비공개 스크래치패드를 사용합니다. 사용에 따른 위험은 사용자가 감수해야 합니다. 제공업체가 이 요청 형태를 오용으로 표시한 사례가 있습니다. |

<a id="prewalk-and-plan-modes"></a>
#### Prewalk 및 계획 모드

| 플래그 | 설명 |
| --- | --- |
| `--prewalk` | 조건에 맞는 첫 번째 편집/쓰기 턴에서 일회성 인계를 준비합니다. `todo`가 활성화되어 있으면 todo 호출이 성공해야 합니다(기본값: 꺼짐). [prewalk](./prewalk.md)를 참조하세요. |
| `--no-prewalk` | `prewalk.enabled`가 설정되어 있어도 prewalk를 비활성화하고, 시작 세션에서 `prewalk.auto`를 제외합니다. `--prewalk`/`--prewalk-into`와 함께 사용할 수 없습니다. |
| `--prewalk-into <id-or-role>` | `smol` 역할 대신 이 대상을 사용하도록 prewalk를 준비합니다. |
| `--plan-yolo` | 읽기 전용 계획 모드로 시작하고, 모델의 계획 제안을 자동 승인한 다음, 실행 대상으로 전환하여 구현합니다. |
| `--plan-yolo-into <id-or-role>` | plan-yolo 실행의 대상 모델입니다(기본값: `smol` 역할). `--plan-yolo`가 필요합니다. |
| `--goal <objective>` | `/goal`을 입력하지 않고 목표 모드로 새 대화형 세션을 시작하여 목표 작업에 착수합니다. `goal.enabled`가 필요하며 대화형 전용입니다. `autoResume`을 우회하며, 위치 프롬프트, `@file` 또는 stdin 입력, `--resume`/`--continue`/`--fork`/가져오기, `--plan-yolo`, `--no-tools`, 시작 시 계획 모드(`plan.defaultOnStartup`)와 함께 사용하면 거부됩니다. |

<a id="tools-approvals-and-runtime"></a>
#### 도구, 승인 및 런타임

| 플래그 | 설명 |
| --- | --- |
| `--tools <a,b,c>` | 활성화할 도구의 쉼표 구분 목록입니다(기본값: 모두). |
| `--no-tools` | 모든 내장 도구를 비활성화합니다. |
| `--no-lsp` | LSP 도구, 서식 지정, 진단을 비활성화합니다. |
| `--no-pty` | PTY 기반 대화형 bash 실행을 비활성화합니다. |
| `--approval-mode <mode>` | 이 세션의 `tools.approvalMode`를 재정의합니다(`always-ask`, `always-ask-cached`, `write`, `yolo`). [승인 모드](./approval-mode.md)를 참조하세요. |
| `--auto-approve`, `--yolo` | yolo 등급 승인을 강제합니다. 명시적 도구/사용자 정책과 제공업체 안전 검사는 계속 적용됩니다. |
| `--advisor` | advisor 런타임을 활성화합니다(각 턴을 수동적으로 검토하고 메모를 주입). [advisor / watchdog](./advisor-watchdog.md)을 참조하세요. |
| `--wait-async` | 출력 모드에서 종료 전 이 실행의 백그라운드 작업을 기다리고 각 결과로 같은 세션에서 새 턴을 시작합니다(`async.printWake`). [헤드리스 / 출력 모드](#headless--print-mode)를 참조하세요. |
| `--max-time <duration>` | 지정한 시간이 지나면 세션을 중지합니다(예: `600`, `10m`, `1h`). |
| `--warn-cost <usd>` | 하위 에이전트를 포함한 세션 비용이 지정한 USD 금액에 도달하면 한 번 경고합니다. `session.warnCost`를 재정의합니다. |
| `--max-cost <usd>` | 세션 비용이 지정한 USD 금액에 도달하면 모델 요청 전송을 중단합니다. 이미 진행 중인 요청으로 한도를 넘을 수 있습니다. `session.maxCost`를 재정의합니다. |

<a id="extensions-hooks-skills-and-rules"></a>
#### 확장 기능, 훅, 스킬 및 규칙

| 플래그 | 설명 |
| --- | --- |
| `--extension <path>`, `-e <path>` | 확장 기능을 로드합니다(반복 사용 가능). [확장 기능](./extensions.md)을 참조하세요. |
| `--hook <path>` | 훅/확장 기능 파일을 로드합니다(반복 사용 가능). [훅](./hooks.md)을 참조하세요. |
| `--trusted-extension <abs-path>` | 기존 절대 경로 모듈 파일의 정확한 허용 목록입니다(반복 사용 가능). 주변 환경의 확장 기능 검색과 패키지 루트 하위 검색을 비활성화합니다. `--extension`/`-e`/`--hook`과 함께 사용할 수 없습니다. |
| `--plugin-dir <dir>` | 로컬 플러그인 디렉터리를 검색 대상에 추가합니다(반복 사용 가능). |
| `--no-extensions` | 확장 기능 검색을 비활성화합니다(명시적 `-e` 경로는 계속 작동). |
| `--skills <globs>` | [스킬](./skills.md)을 필터링할 glob 패턴의 쉼표 구분 목록입니다(예: `git-*,docker`). |
| `--no-skills` | 스킬 검색 및 로드를 비활성화합니다. |
| `--no-rules` | 규칙 검색 및 로드를 비활성화합니다. [컨텍스트 파일](./context-files.md)을 참조하세요. |
| `--no-context-files` | 작업 디렉터리와 모든 `--add-dir` 루트의 [컨텍스트 파일](./context-files.md)(`AGENTS.md`, `CLAUDE.md` 등)을 비활성화합니다. 하위 에이전트에도 상속됩니다. |

<a id="system-prompt"></a>
#### 시스템 프롬프트

| 플래그 | 설명 |
| --- | --- |
| `--system-prompt <text\|file>` | 일반 텍스트 시스템 프롬프트를 재정의합니다(기본값: 코딩 어시스턴트 프롬프트). [시스템 프롬프트 사용자 지정](./system-prompt-customization.md)을 참조하세요. |
| `--system-prompt-template <path>` | `<path>`를 반드시 Handlebars 시스템 프롬프트 템플릿으로 읽습니다. `--system-prompt`와 상호 배타적입니다. [시스템 프롬프트 사용자 지정](./system-prompt-customization.md)을 참조하세요. |
| `--append-system-prompt <text\|file>` | 일반 텍스트나 파일 내용을 시스템 프롬프트에 추가합니다. |

<a id="output-mode"></a>
#### 출력 모드

| 플래그 | 설명 |
| --- | --- |
| `--mode <mode>` | 출력/전송 모드: `text`(기본값), `json`, `rpc`, `acp`, `rpc-ui` 중 하나입니다. [출력 모드](#output-modes---mode)를 참조하세요. |
| `--print`, `-p` | 프롬프트를 비대화형으로 처리하고 종료합니다. |
| `--no-ui` | `rpc`/`rpc-ui`에서 rpc-ui 도구 UI를 비활성화하지 않고 확장 기능을 헤드리스로 실행합니다. |

<a id="information"></a>
#### 정보

| 플래그 | 설명 |
| --- | --- |
| `--help`, `-h` | `omp` 또는 하위 명령의 도움말을 표시하고 종료합니다. |
| `--version`, `-v` | 설치된 버전을 출력하고 종료합니다. |

<a id="headless--print-mode"></a>
### 헤드리스 / 출력 모드

`--print` / `-p`는 `omp`를 비대화형으로 실행합니다. 프롬프트를 처리하고,
마지막 어시스턴트 응답을 stdout에 쓴 다음 TUI에 진입하지 않고 종료합니다. 텍스트
출력은 토큰 단위가 아니라 턴이 완료된 후에 내보내며, 작업 중
표시기(`Working...`)는 stderr로 전송됩니다. 스크립팅과 자동화의 진입점입니다.

```sh
# 답변을 출력하고 종료
omp -p "Summarize the changes in the last commit"

# 출력 텍스트에 모델의 추론 블록 포함
omp -p --print-thoughts "Explain your reasoning for this refactor"

# 파이프라인용 기계 판독 가능 출력
omp -p --mode json "List every TODO in src/" > todos.json

# stdin을 통해 프롬프트 전달
echo "review this diff" | omp -p
```

헤드리스 실행 관련 플래그:

- `--print-thoughts` — 출력되는 텍스트에 추론 블록을 포함합니다.
- `--mode json` — 렌더링된 텍스트 대신 구조화된 이벤트를 내보냅니다.
- `--no-title` — 제목 자동 생성을 건너뜁니다(`PI_NO_TITLE`도 사용 가능).
- `--max-time <duration>` — 실행 시간을 제한합니다.
- `--wait-async` — 백그라운드 작업을 기다리며 실행을 유지합니다(아래 참조).
- `--warn-cost <usd>` / `--max-cost <usd>` — 지정 비용에 도달하면 경고하거나 모델 요청 전송을 중단합니다.

출력 모드는 기본적으로 단발 실행입니다. 프롬프트에 답하면 세션을 정리하고 이 실행에서 시작한
백그라운드 작업(모델이 비동기로 실행한 `bash` 또는 `task` 호출)을 취소합니다.
`--wait-async`(또는 `async.printWake: true`)를 사용하면 대신 해당 작업을 기다립니다.
각 작업 결과는 TUI에서처럼 같은 세션에 전달되어 새 턴을 시작하며, 이 턴에서 추가 작업을
시작할 수도 있습니다. 소유한 작업이나 미전달 결과가 없어지면 종료하며 텍스트 모드는
마지막 턴의 답변을 출력합니다. 무인 실행에는 `--max-time`으로 시간 제한을 설정하세요.

```sh
# 긴 빌드를 백그라운드에서 시작한 뒤 같은 세션에서 결과에 대응
omp -p --wait-async --max-time 2h "통합 테스트 모음을 백그라운드에서 실행하고 실패한 부분을 수정해 줘"
```

`--mode json`은 세션 헤더에 이어 이벤트를 JSON lines 형식으로 내보냅니다.
증분 `message_update` 이벤트에는 전체 부분 메시지 스냅샷이 포함되지 않습니다. 완료된
메시지는 `message_end`로 도착하며, 불투명한 제공업체 재생 페이로드는 생략됩니다.
턴이 최종 실패하면 텍스트 모드와 JSON 모드 모두 0이 아닌 종료 상태를 반환합니다.
`--max-cost`로 중지한 실행은 상태 `3`으로 종료합니다. 한도 메시지는 stderr로 출력되며
(JSON 모드에서는 `cost-gate` 알림), 답변은 출력하지 않습니다.

출력 모드에는 계획 검토 UI가 없으므로 `plan.defaultOnStartup`은
무시됩니다. 무인 계획 수립 및 구현에는 `--plan-yolo`를 사용하세요.

[advisor / watchdog](./advisor-watchdog.md#headless-runs) 문서에서는
advisor 런타임이 활성화된 경우 출력 모드의 정리 동작을 설명합니다.

<a id="output-modes---mode"></a>
### 출력 모드(`--mode`)

| 모드 | 설명 |
| --- | --- |
| `text` | 렌더링된 텍스트입니다. `--mode`를 생략하면 TUI를 사용할 수 있으며, `--mode text`를 명시하면 비대화형 텍스트 출력을 선택합니다. |
| `json` | 헤드리스/기계 처리용 줄바꿈 구분 JSON 이벤트 스트림입니다. `-p`는 선택 사항입니다. |
| `rpc` | stdio를 통한 줄 구분 JSON 명령/응답/이벤트 전송입니다(JSON-RPC 2.0이 아님). [RPC](./rpc.md)를 참조하세요. |
| `rpc-ui` | UI 확장 기능 이벤트가 활성화된 RPC 전송입니다. |
| `acp` | stdio를 통한 Agent Client Protocol 서버입니다. [`acp`](#subcommands) 하위 명령과 동일합니다. [승인 모드 → ACP 세션](./approval-mode.md#acp-sessions)을 참조하세요. |

`--no-ui`를 `--mode rpc` 또는 `--mode rpc-ui`와 함께 사용하면 확장 기능이 헤드리스로 실행됩니다. `ctx.hasUI`는 `false`가 되고, 확장 기능 대화상자는 기본값으로 처리되며, 확장 기능 표시 업데이트는 버려집니다. `rpc-ui`에서는 `ask` 같은 도구 UI가 여전히 호스트의 응답을 받을 `extension_ui_request` 프레임을 보냅니다. 호스트가 요청한 `login` UI는 영향을 받지 않습니다. [RPC 시작](./rpc.md#startup)을 참조하세요.

<a id="subcommands"></a>
## 하위 명령

각 명령의 플래그와 예제는 `omp <command> --help`를 실행하여 확인하세요.

| 명령 | 용도 | 참고 |
| --- | --- | --- |
| `launch` | 코딩 세션을 시작합니다(기본 명령). | [실행 플래그](#launch-flags) |
| `acp` | omp를 stdio 기반 ACP(Agent Client Protocol) 서버로 실행합니다. | [승인 모드](./approval-mode.md#acp-sessions) |
| `auth-broker` | omp auth-broker(자격 증명 저장소)를 관리합니다. | [인증 브로커 / 게이트웨이](./auth-broker-gateway.md) |
| `auth-gateway` | auth-gateway를 실행합니다. 설정된 브로커를 기반으로 하는 HTTP 포워드 프록시(`serve`) 또는 자체 자격 증명을 사용하는 부모 프로세스용 stdin/stdout JSON lines(`stdio`) 방식입니다. | [인증 브로커 / 게이트웨이](./auth-broker-gateway.md) |
| `agents` | 번들로 제공되는 작업 에이전트를 관리합니다. | [작업 에이전트 검색](./task-agent-discovery.md) |
| `bench` | 모델을 벤치마크합니다. 채팅, 프리필, 생성, 프롬프트 캐시 워크로드 전반에서 TTFT/프리필과 디코딩 처리량을 p50/p95와 함께 실시간 대시보드에 표시합니다(`--prefill-bytes`는 합성 프리필 입력 크기를 지정). `--detailed`는 모델별로 단일 사용자, `--par`개 병렬 실행(총 tok/s 및 확장성), 프리필 단계를 실행합니다. | |
| `browser-relay` | Eval의 브라우저 API가 사용자의 Chrome 탭을 제어하는 데 사용하는 로컬 CDP 릴레이를 실행합니다. | [컴퓨터 사용](./computer-use.md) |
| `cleanse` | 가중치를 적용한 병렬 하위 에이전트로 프로젝트 진단 문제를 감지하고 수정합니다. | |
| `collab` | URL을 노출하지 않고 활성 로컬 Collab 호스트를 나열합니다. `collab link <instanceId\|pid>`는 제어 링크를 가져옵니다(보기 전용은 `--view`). | [collab](./collab.md) |
| `clip` | `/record` 녹화본을 공개 클립으로 live.omp.sh에 업로드하고 URL을 출력합니다. | |
| `commit` | 커밋 메시지를 생성하고 변경 로그를 업데이트합니다. | |
| `completions` | 셸 자동 완성 스크립트(bash, zsh, fish)를 출력합니다. | |
| `compress` | 텍스트 파일을 고밀도 프롬프트 문체로 다시 작성하고, 생략한 내용을 보고합니다. | |
| `config` | 구성 설정을 관리합니다. | [config 사용법](./config-usage.md), [설정](./settings.md) |
| `dry-balance` | 무작위 세션 ID 전반에 걸쳐 OAuth 계정 부하 분산을 모의 실행합니다. | |
| `find` | 구현 파일과 줄 범위를 시맨틱 검색합니다. | |
| `gc` | 저장소 가비지 컬렉션을 실행합니다. | |
| `grep` | CLI에서 grep 도구를 테스트합니다. ([`grep` 도구](./tools/grep.md)는 별도의 에이전트 도구입니다.) | |
| `gallery` | 결정론적 갤러리에서 도구, 작성기, 상태 표시줄 렌더러를 미리 봅니다. | |
| `git` | 대화형 전체 화면 git UI입니다. 분할 diff 뷰어, 스테이징 사이드바, 커밋 작성기를 제공합니다. | |
| `grievances` | 보고된 도구 문제(auto-QA grievances)를 확인, 정리하거나 푸시합니다. | |
| `if-bench` | 지시 준수와 작업 기억을 벤치마크합니다. 글리프 배열 작업으로 이루어진 하나의 캐시된 스레드를 사용하며, 고양이 소리 지시문이 프롬프트 내에서 이동합니다. | |
| `images`, `img` | 이미지 게시 백엔드를 검사, 진단, 탐색하고 정리합니다. | |
| `install` | 확장 기능 패키지를 설치하거나 연결합니다(`plugin install` / `plugin link`의 별칭). | [확장 기능](./extensions.md) |
| `join` | 공유 collab 세션에 참여합니다(`/join`과 동일). | [collab](./collab.md) |
| `login` | 터미널에서 모델 제공업체에 로그인합니다(`/login`에 대응). | |
| `models` | 사용 가능한 모델을 나열, 검색하고 새로 고칩니다. | [모델](./models.md) |
| `plugin`, `plugins` | 플러그인을 관리합니다(설치, 제거, 목록 조회 등). | [확장 기능](./extensions.md), [마켓플레이스](./marketplace.md) |
| `play` | 터미널에서 `/record` 녹화본을 재생합니다. Space로 일시 정지하고 `q`로 종료합니다. | |
| `predict` | 프롬프트에 대해 단어 완성 엔진이 실시간으로 표시하는 고스트 텍스트를 비교합니다. | |
| `ps` | 데몬이 감독하는 백그라운드 프로세스를 나열하고 제어합니다(로그, 중지, 강제 종료, 재시작). | |
| `say` | 로컬 TTS 엔진으로 텍스트를 음성 합성하고 스피커로 재생합니다. | [tts 도구](./tools/tts.md) |
| `share` | 암호화된 링크로 저장된 세션을 공유합니다(`/share` 슬래시 명령과 동일). | [세션 작업](./session-operations-export-share-fork-resume.md) |
| `setup` | 온보딩 설정을 실행하거나 선택적 기능의 종속성을 설치합니다. | |
| `shell` | 대화형 셸 콘솔입니다. | |
| `read` | 경로, URL 또는 내부 URI에 대해 read 도구가 반환할 내용을 표시합니다. ([`read` 도구](./tools/read.md)는 별도의 에이전트 도구입니다.) | |
| `render` | 프로덕션 대화 기록 파이프라인을 통해 세션의 전체 스레드를 그립니다(다시 그리기 시간 측정 포함). | |
| `skill`, `skills` | skills.omp.sh에서 스킬을 설치, 검색, 게시하고 관리합니다. | [스킬](./skills.md) |
| `ssh` | SSH 호스트 구성을 관리합니다. | |
| `stats` | 사용 통계를 확인합니다. | |
| `stream` | 로컬 OMP 세션 화면과 채팅을 공개 라이브 채널로 방송합니다. | |
| `update` | 업데이트를 확인하고 설치합니다. `--canary`/`--stable`은 릴리스 채널을 전환합니다. | |
| `usage` | 인증된 모든 계정의 제공업체 사용 한도를 표시하고, 만료가 임박한 저장된 초기화 항목을 표시합니다. `usage clients`는 클라이언트별 토큰 소비량을 분석하며(`--days` 사용), `usage invalidate`는 캐시된 보고서를 삭제합니다. `usage accounts`는 각 OAuth 계정의 제공업체와 식별 키(`task.agentAccountPools` 및 브로커 계정 풀이 사용하는 키; 토큰은 미포함, `--json` 지원)를 나열합니다. `usage reset`은 각 Codex 및 Claude 계정에 저장된 속도 제한 초기화 항목을 `<provider>/<credential id>`별로 나열하며(`--json`, `--redact`), `usage reset <provider>/<credential id>`는 하나를 소비합니다. auth-broker 클라이언트에서도 가능합니다. | [작업 에이전트 검색](./task-agent-discovery.md#model-and-structured-output-precedence), [저장된 초기화 항목](./settings.md#saved-reset-auto-consumption) |
| `tiny-models` | 세션 제목, 메모리, 단어 완성을 위한 초소형 로컬 모델을 다운로드합니다. | [로컬 모델](./local-models.md) |
| `token` | 제공업체의 API 키나 OAuth 토큰을 가져옵니다. | [비밀 정보](./secrets.md) |
| `toks` | 내장 오프라인 토크나이저로 파일이나 텍스트의 토큰 수를 계산합니다. | |
| `ttsr` | Time-Traveling Stream Rules(TTSR)를 검사하고 테스트합니다. (CLI 명령에 관한 설명이며, [TTSR 기능](./ttsr-injection-lifecycle.md)은 별도로 문서화되어 있습니다.) | |
| `worktree`, `wt` | git 워크트리를 추가, 나열하거나 정리합니다. 활성화된 경우 복제 우선 동작을 사용합니다. | |
| `search`, `q`, `web-search` | CLI에서 웹 검색 제공업체를 테스트합니다. | [web_search 도구](./tools/web_search.md) |

> `install`, `join`, `browser-relay`, `auth-gateway`, `tiny-models`는
> 관련 메커니즘(`plugin` 명령, `/join` 슬래시 명령
> 등)을 통해서도 사용할 수 있습니다. 이 표에는
> `packages/coding-agent/src/cli-commands.ts`에 등록된 대로 각 명령이 나열되어 있습니다.

`__complete`는 셸 자동 완성 스크립트가 사용하는 숨겨진 내부 하위 명령입니다.
