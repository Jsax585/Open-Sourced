<a id="tree-command-reference"></a>
# `/tree` 명령 참조

`/tree`는 대화형 **세션 트리** 탐색기를 엽니다. 현재 세션 파일의 어떤 항목으로든 이동하여 그 지점부터 계속할 수 있습니다.

새 세션으로 내보내는 것이 아니라 같은 파일 안에서 리프를 이동합니다.

<a id="what-tree-does"></a>
## `/tree`의 동작

- 현재 세션 항목으로 트리를 구성합니다(`SessionManager.getTree()`).
- 키보드 탐색, 필터, 검색을 지원하는 `TreeSelectorComponent`를 엽니다.
- 선택하면 `AgentSession.navigateTree(targetId, { summarize, customInstructions })`를 호출합니다.
- 새 리프 경로에 따라 표시되는 채팅을 다시 구성합니다.
- 사용자/사용자 지정 메시지를 선택하면 편집기에 텍스트를 미리 채울 수 있습니다.

주요 구현:

- `packages/coding-agent/src/slash-commands/builtin-session.ts` (`/tree`, `/branch` 명령 라우팅)
- `packages/coding-agent/src/modes/controllers/input-controller.ts` (키 바인딩 연결, Escape 두 번 누르기 동작)
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` (트리 UI 실행 및 요약 프롬프트 흐름)
- `packages/tui/src/overlays/tree-selector.ts` (탐색, 필터, 검색, 라벨, 렌더링)
- `packages/coding-agent/src/session/agent-session.ts` (`navigateTree` 리프 전환 및 선택적 요약)
- `packages/coding-agent/src/session/session-manager.ts` (`getTree`, `branch`, `branchWithSummary`, `resetLeaf`, 라벨 영구 저장)

<a id="how-to-open-it"></a>
## 여는 방법

다음 중 어느 방법을 사용해도 같은 선택기가 열립니다.

- `/tree`
- `app.session.tree` 동작에 설정한 키 바인딩

편집기가 비어 있을 때 Escape를 두 번 누르면 `doubleEscapeAction` 설정을 따릅니다. `rewind`(기본값)는 전체 화면 대화 기록 되감기 선택기를, `tree`는 이 트리 선택기를 열며, `none`은 단축키를 비활성화합니다. 대화 기록 되감기는 모든 대상에 `navigateTree(..., { summarize: false })`를 호출하며 현재 세션 파일에 머뭅니다. 사용자 요청 초안은 편집기 텍스트를 대체합니다.

되감기는 최근 약 600개 항목을 열되 사용자 턴을 통째로 유지합니다(따라서 한도를 초과할 수 있습니다). `a`를 누르면 선택 지점이나 분기를 바꾸지 않고 이전 기록 전체를 불러옵니다.
`f`를 누르면 재생되는 대화 기록을 필터링합니다(전체 분기를 불러옴). 형제 분기 표시줄이 있으면 왼쪽/오른쪽 키로 이동합니다. 이 조작은 아래 트리 선택기가 아니라 대화 기록 되감기에 해당합니다.

<a id="tree-ui-model"></a>
## 트리 UI 모델

트리는 세션 항목의 부모 포인터(`id` / `parentId`)로 렌더링됩니다.

- 자식은 타임스탬프 오름차순으로 정렬됩니다.
- 활성 리프를 포함한 분기가 선택기에서 먼저 표시되며, 다른 기록에도 계속 접근할 수 있습니다.
- 활성 분기(루트에서 리프까지의 경로)는 글머리표로 표시됩니다.
- 라벨은 노드 텍스트 앞에 `[label]`로 표시됩니다.
- 부모가 없거나 자신을 부모로 지정한 항목, 명시적으로 부모가 null인 항목은 루트가 됩니다. 루트가 여러 개면 가상의 분기 루트를 공유합니다.

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

선택기는 현재 선택을 중심으로 위치를 조정하며 다음 수만큼 행을 표시합니다.

- `max(1, min(max(5, floor(terminalHeight / 2)), terminalHeight - 8))`행. 높이가 작은 터미널에서는 패널 장식 공간을 남깁니다.

<a id="keybindings-inside-tree-selector"></a>
## 트리 선택기 내부 키 바인딩

- `Up` / `Down`: 선택 이동(끝에서 순환)
- `Alt+Up` / `Alt+Down`: 이전/다음 사용자 또는 어시스턴트 턴으로 이동
- `app.tree.previousBranch` / `app.tree.nextBranch` (기본 바인딩 없음. [`keybindings.yml`](./keybindings.md)에서 예를 들어 `Shift+Left` / `Shift+Right`에 바인딩): 중첩된 분기를 가로질러 렌더링 순서상 이전/다음 표시 분기로 이동합니다(끝에서 순환). 분기 시작 노드가 필터로 숨겨져 있으면 첫 번째 표시 자손으로 이동합니다.
- `Page Up` / `Page Down` 또는 `Left` / `Right`: 페이지 이동
- `Home` / `End`: 첫 번째/마지막 표시 항목
- `Enter`: 노드 선택
- `Shift+Enter`: 요약 선택 프롬프트를 열지 않고 요약 후 전환
- `Esc`: 검색 중이면 검색 지우기, 아니면 선택기 닫기
- `Ctrl+C`: 선택기 닫기
- 문자 입력: 검색어 뒤에 추가
- `Backspace`: 검색 문자 삭제
- `Shift+L`: 검색어가 비어 있을 때 라벨 편집/지우기
- `Ctrl+O`: 다음 필터로 순환
- `Shift+Ctrl+O`: 이전 필터로 순환
- `Alt+D/T/U/L/A`: 특정 필터로 바로 이동

<a id="filters-and-search-semantics"></a>
## 필터 및 검색 규칙

초기 모드는 `treeFilterMode`(기본값 `default`)에서 가져옵니다. 모드는 다음 순서로 순환합니다.

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

<a id="default"></a>
### `default`

대화 노드와 명시적으로 숨기지 않은 항목 유형을 표시합니다. 다음 설정/내부 관리 항목 유형은 숨깁니다.

- `label`
- `custom`
- `model_change`
- `thinking_level_change`
- `model_usage`
- `service_tier_change`
- `title_change`
- `credential_pin`
- `session_init`
- `ttsr_injection`
- `mode_change`
- `reset_boundary`

`all` 필터는 이 항목을 메타데이터 행으로 표시합니다. 전용 렌더링이 없는 항목도 빈 행 대신 유형 이름을 표시합니다.

<a id="no-tools"></a>
### `no-tools`

`default`와 같지만 `toolResult` 메시지도 숨깁니다.

<a id="user-only"></a>
### `user-only`

사용자 요청: 일반 사용자 메시지와 사용자가 호출한 스킬/협업 사용자 지정 프롬프트입니다.

<a id="labeled-only"></a>
### `labeled-only`

현재 라벨이 적용된 항목만 표시합니다.

<a id="all"></a>
### `all`

내부 관리/사용자 지정 항목을 포함하여 세션 트리의 모든 항목을 표시합니다.

<a id="tool-only-assistant-node-behavior"></a>
### 도구 호출만 있는 어시스턴트 노드의 동작

도구 호출만 포함하고 정식 텍스트가 없는 어시스턴트 메시지는 `all`을 포함한 모든 필터 모드에서 숨겨집니다. 단, 다음은 예외입니다.

- 메시지가 오류/중단 상태인 경우(`stopReason`이 `stop`도 `toolUse`도 아님)
- 현재 리프인 경우

<a id="search-behavior"></a>
### 검색 동작

- 검색어를 공백으로 토큰화합니다.
- 대소문자를 구분하지 않는 퍼지(부분 수열) 일치를 사용합니다(`fuzzyMatch`).
- 모든 토큰이 일치해야 합니다(AND 규칙).
- 검색 대상 텍스트에는 라벨, 역할, 유형별 내용(메시지 텍스트, 분기 요약 텍스트, 사용자 지정 유형, 도구 명령 일부 등)이 포함됩니다.
- 메시지/사용자 지정 메시지 텍스트는 200자 검색 미리보기로 제한됩니다. 긴 메시지의 모든 바이트를 검색 색인에 넣지는 않습니다.

<a id="selection-outcomes-important"></a>
## 선택 결과(중요)

`navigateTree`는 선택한 항목 유형에 따라 새 리프 동작을 결정합니다.

<a id="selecting-user-message"></a>
### `user` 메시지 선택

- 선택한 항목의 `parentId`가 새 리프가 됩니다.
- 루트 사용자 메시지는 리프를 루트로 초기화합니다.
- 텍스트와 이미지 첨부를 편집 가능한 초안으로 복원합니다.
- 선택기는 편집기가 현재 비어 있을 때만 초안을 씁니다.

<a id="selecting-custom_message"></a>
### `custom_message` 선택

- 일반 사용자 지정 메시지는 사용자 메시지와 같은 부모 리프 규칙 및 텍스트 미리 채우기를 사용합니다.
- 사용자가 호출한 스킬/협업 사용자 지정 프롬프트는 부모 리프 규칙에 따라 원래 사용자 초안과 이미지 첨부를 복원합니다.
- 에이전트/자동 로드 `skill-prompt` 주입은 편집할 수 없습니다. 선택하면 다른 비사용자 항목처럼 해당 노드로 이동합니다.

<a id="selecting-a-past-ask-tool-result"></a>
### 과거 `ask` 도구 결과 선택

- 대화형 `/tree`는 오래된 답변을 재사용하지 않고 원래 질문 UI를 다시 엽니다.
- 취소하면 트리가 바뀌지 않습니다.
- 기존 답변 분기를 보존한 채 새 답변을 형제 도구 결과로 추가하고, 에이전트가 그 답변부터 재개합니다.
- 레거시/손상 데이터에서 원래 질문을 복구할 수 없으면 일반 리프 이동으로 처리합니다.

<a id="selecting-other-nodes"></a>
### 다른 노드 선택

- 선택한 노드 ID가 새 리프가 됩니다.
- 편집기를 미리 채우지 않습니다.

<a id="selecting-current-leaf"></a>
### 현재 리프 선택

- 일반적으로 `Already at this point`와 함께 닫힙니다.
- `/tree` UI는 현재 리프의 사용자 프롬프트를 선택해도 아무 작업을 하지 않습니다. 대화 기록 `/branch` 되감기와 직접 `navigateTree()` 호출은 해당 프롬프트 이전으로 되감을 수 있습니다.
- 현재 리프의 `ask` 결과에서도 다시 답변하는 흐름을 사용할 수 있습니다.

```text
Selection decision (simplified):

selected node
   │
   ├─ current leaf (not ask result)? ──> close selector (no-op)
   │
   ├─ ask tool result? ──> re-answer as a sibling branch when questions are recoverable
   │
   ├─ user or ordinary custom message? ──> leaf := parentId (or root)
   │                                         + prefill only into an empty editor
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

<a id="summary-on-switch-flow"></a>
## 전환 시 요약 흐름

요약 프롬프트는 `branchSummary.enabled`(기본값 `false`)로 제어합니다. `Shift+Enter`는 프롬프트 설정과 관계없이 직접 요약을 요청합니다. 사용 가능한 모델이 있어야 합니다. 공급자 자격 증명은 내장 요약기를 실행할 때만 확인하며, 훅이 제공한 요약이나 비어 있는 이탈 경로에는 확인하지 않습니다.

프롬프트가 활성화되어 있으면 일반 Enter로 다음을 선택할 수 있습니다.

- `No summary`(요약 안 함)
- `Summarize`(요약)
- `Summarize with custom prompt`(사용자 지정 프롬프트로 요약)

세부 흐름:

- 요약 프롬프트에서 Escape를 누르면 트리 선택기를 다시 엽니다.
- 사용자 지정 프롬프트를 취소하면 요약 선택으로 돌아갑니다.
- 요약 중에는 UI가 로딩 표시를 보여 주고 Esc에 `abortBranchSummary()`를 바인딩합니다.
- 요약을 중단하면 트리 선택기를 다시 열며 이동을 적용하지 않습니다.

`navigateTree` 내부 동작:

- 대기 중인 bash 출력을 비우고 대상을 검증합니다.
- 이전 리프부터 공통 조상까지 떠나는 분기의 항목을 수집합니다.
- 취소 가능한 `session_before_tree`를 발생시킵니다. 확장이 요청된 요약을 제공할 수 있습니다.
- 요약을 요청했고 요약할 항목이 있으며 훅이 요약을 제공하지 않은 경우에만 기본 요약기를 실행합니다.
- 상황에 따라 `branchWithSummary(...)`, `branch(newLeafId)` 또는 `resetLeaf()`를 적용합니다.
- 모델 컨텍스트, 체크포인트/되감기 상태, 어드바이저 상태, 할 일, 기록 재작성의 영향을 받는 공급자 세션을 다시 구성합니다.
- `session_tree`를 발생시키고 처리기가 항목을 추가했을 수 있으면 다시 구성합니다.

요약을 요청했지만 요약할 내용이 없으면 요약 항목 없이 이동합니다.

<a id="labels"></a>
## 라벨

트리 UI에서 라벨을 편집하면 `appendLabelChange(targetId, label)`을 호출합니다.

- 비어 있지 않은 라벨은 적용 라벨을 설정/갱신합니다.
- 빈 라벨은 라벨을 지웁니다.
- 라벨은 추가 전용 `label` 항목으로 저장됩니다.
- 트리 노드는 원시 라벨 항목 기록이 아니라 현재 적용된 라벨 상태를 표시합니다.

<a id="tree-vs-adjacent-operations"></a>
## `/tree`와 관련 작업 비교

| 작업 | 범위 | 결과 |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree` | 현재 세션 파일 | 선택한 지점으로 리프 이동(같은 파일) |
| `/branch` (별칭 `/rewind`) | 현재 세션 파일 | 대화 기록 되감기를 열어 같은 파일에서 리프를 이동하고 사용자 요청 초안을 복원 |
| `/fork` | 현재 세션 전체 | 세션을 새로운 영구 세션 파일로 복제 |
| `/resume` | 세션 목록 | 다른 세션 파일로 전환 |

핵심 차이: `/tree`와 `/branch`는 하나의 세션 파일 안에서 탐색합니다. `/fork`는 파일을 복제하고 `/resume`은 파일을 전환합니다. 프로그래밍 방식의 `AgentSession.branch()` API는 여전히 별도의 분기 세션을 만듭니다.

<a id="operator-workflows"></a>
## 운영 작업 흐름

<a id="re-run-from-an-earlier-user-prompt-without-losing-current-branch"></a>
### 현재 분기를 잃지 않고 이전 사용자 프롬프트부터 다시 실행

1. `/tree` 실행
2. 이전 사용자 메시지를 검색/선택
3. `No summary` 선택(필요하면 요약 선택)
4. 편집기에 미리 채워진 텍스트 편집
5. 제출

결과: 같은 세션 파일의 선택 지점에서 새 분기가 자랍니다.

<a id="leave-current-branch-with-context-breadcrumb"></a>
### 맥락을 남기고 현재 분기 떠나기

1. `branchSummary.enabled` 활성화
2. `/tree`에서 대상 노드 선택
3. `Summarize` 선택(또는 사용자 지정 프롬프트)

결과: 계속하기 전에 대상 위치에 `branch_summary` 항목을 추가합니다.

<a id="investigate-hidden-bookkeeping-entries"></a>
### 숨겨진 내부 관리 항목 조사

1. `/tree` 실행
2. `Alt+A` 누르기(전체)
3. `model`, `thinking`, `custom` 또는 라벨 검색

결과: 대화 노드뿐 아니라 전체 내부 타임라인을 검사합니다.

<a id="bookmark-pivot-points-for-later-jumps"></a>
### 나중에 이동할 전환 지점에 북마크 설정

1. `/tree` 실행
2. 항목으로 이동
3. `Shift+L`을 누르고 라벨 설정
4. 나중에 `Alt+L`(`labeled-only`)로 빠르게 이동

결과: 지속적으로 남는 분기 이정표 사이를 빠르게 탐색합니다.
