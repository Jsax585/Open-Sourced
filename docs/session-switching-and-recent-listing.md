# 세션 전환과 최근 세션 목록

이 문서는 coding-agent가 최근 세션을 찾고, `--resume` 대상을 결정하고, 세션 선택기를 표시하며, 실행 중인 활성 세션을 전환하는 방식을 설명합니다.

대체 처리 경로와 주의 사항을 포함하여 현재 구현의 동작에 초점을 맞춥니다.

## 구현 파일

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/tui/src/apps/session-picker.ts`](../packages/tui/src/apps/session-picker.ts)
- [`packages/tui/src/overlays/session-selector.ts`](../packages/tui/src/overlays/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 최근 세션 탐색

### 디렉터리 범위

`SessionManager`는 기본적으로 정규화된 cwd별 버킷에 파일 세션을 저장합니다.

- `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`

`<encoded-cwd>`는 정규화된 cwd를 경로 인코딩한 값입니다(홈 아래는 `-<relative>`, 임시 루트 아래는 `-tmp-<relative>`, 그 외에는 `--<encoded-absolute>--`; [session.md](session.md#on-disk-layout) 참조). 철회된 17.2.5-17.2.8 해시 방식의 버킷은 가능한 범위에서 마이그레이션합니다. 명시적인 `sessionDir`가 없으면 `SessionManager.list(cwd, sessionDir?)`는 결정된 버킷만 읽습니다.

### 서로 다른 데이터를 반환하는 두 목록 경로

목록을 만드는 파이프라인은 두 가지입니다.

1. `getRecentSessions(sessionDir, limit = 4)`(시작 화면/요약 보기)
   - 파일을 나열하고 `mtime` 내림차순으로 정렬합니다.
   - `history.db`의 세션 제목 인덱스를 사용해 이미 인덱싱된 파일을 읽지 않습니다.
   - 인덱싱된 제목이 없는 파일은 전체 목록과 같은 앞부분/끝부분 스캔 및 어시스턴트 탐지 대체 처리를 사용합니다. 제목 없는 빈 세션 뼈대는 건너뛰고, 발견한 제목은 인덱스에 채웁니다.
   - 현재의 고정 너비 제목 슬롯 파일과 이전의 헤더 우선 파일을 모두 이해합니다.
   - 가벼운 `RecentSessionInfo`(`path`, `name`, `timeAgo`)를 반환합니다.

2. `SessionManager.list(...)` / `SessionManager.listAll()`(재개 선택기와 ID 검색)
   - 보통 파일마다 앞부분 4 KiB와 제한된 끝부분 32 KiB를 읽습니다. 두 구간 모두에서 어시스턴트 턴을 찾지 못하면 저장소가 제공하는 대체 처리로 본문 줄을 탐색해 턴을 찾을 수 있어, 빈 세션으로 잘못 분류하는 일을 막습니다.
   - `SessionInfo`(`path`, `id`, `cwd`, 제목/부모 메타데이터, 날짜, 크기, 메시지 미리보기/개수, 수명 주기 상태)를 구성합니다.
   - 목록 텍스트에는 앞부분 파싱과 마커 개수 계산을, 마지막 메시지의 수명 주기 상태에는 끝부분 파싱을 사용합니다. 앞부분 이후의 메시지는 `allMessagesText`에 없을 수 있습니다.
   - 상태는 `complete`, `interrupted`, `aborted`, `error`, `pending`, `unknown` 중 하나입니다.
   - 내부 스캔은 `modified` 내림차순으로 정렬하고, 관리자 API는 고정된 세션을 앞에 놓습니다. stat 정보를 키로 삼아 스캔 결과를 캐시하며, 큰 목록은 동시 작업자 수를 제한합니다.

선택기 호출자는 `listForPicker(...)` / `listAllForPicker()`를 사용하며, 이 함수는 고정되지 않은 제목 없는 빈 세션 뼈대도 제외합니다. 제목이나 탐지 가능한 첫 프롬프트가 있으면 턴이 없는 세션도 유지합니다. 끝부분의 수명 주기 상태를 확인하여 응답이 있는 세션을 빈 뼈대로 오인하지 않습니다. 명시적 ID 탐색은 필터링하지 않은 스캔을 사용합니다.

일반적인 디렉터리별 스캔은 EPERM 원자적 재작성 대체 처리에서 생성한 `.bak`의 원본 JSONL이 없을 때, 가장 최신의 고아 `.bak`을 복구합니다. `listSessionsReadOnly`는 변경하지 않는 변형입니다.

### 메타데이터 대체 처리

최근 세션 요약(`RecentSessionInfo`):

- 표시 이름 우선순위(`sessionDisplayName`): `title` -> 첫 사용자 메시지 -> `Untitled · <time>` 레이블(원시 `id`는 의도적으로 사용하지 않음)
- 시작 화면은 고정 길이가 아니라 사용 가능한 열 너비에 맞춰 표시 이름을 자릅니다.
- 제목/메시지에서 만든 이름은 첫 줄만 남기고 제어 문자를 제거합니다(`sanitizeSessionName`).

`SessionInfo` 목록 항목:

- `title`은 고정 제목 슬롯 값이 있으면 그 값, 없으면 `header.title`, 그것도 없으면 앞부분에서 마지막으로 발견한 압축 `shortSummary`입니다.
- `firstMessage`는 앞부분에서 찾을 수 있는 첫 사용자 메시지 텍스트이며, 없으면 `"(no messages)"`입니다.
- 선택기는 수정 시각, 파일 크기, 실행 중인 세션의 `current` 표시, 수명 주기 상태(`unknown` 제외), 분기 표시를 보여 주며, 모든 프로젝트 범위에서는 cwd도 표시합니다.

## `--continue` 대상 결정과 터미널별 기록 우선순위

`SessionManager.continueRecent(cwd, sessionDir?)`는 다음 순서로 대상을 결정합니다.

1. 터미널별 기록(`~/.omp/agent/terminal-sessions/<terminal-id>`)을 읽습니다.
2. 기록을 검증합니다. 파일이 생성된 대상은 사용할 수 있습니다. 대상이 없으면 선택적인 세 번째 줄이 `fresh`인 경우에만 사용할 수 있으며, 이는 아직 파일이 생성되지 않은 지연 `/new` 경계를 뜻합니다.
3. 파일이 없는 fresh 대상은 이전 대화로 되돌아가 복원하지 않고 새 세션을 시작합니다.
4. 수정 이전에 남은 오래된 하위 에이전트 기록은 해당 대화형 부모 세션으로 해석합니다.
5. 기록의 cwd가 다르고 더 이상 존재하지 않으며 실제 현재 cwd 세션이 우선하지 않는 경우, 기록된 장치/inode가 현재 디렉터리와 일치할 때만 루트를 변경합니다(`open` + `moveTo`). 삭제되거나 마운트 해제되거나 파일시스템을 넘어 이동한 프로젝트는 이름 변경을 입증하지 않습니다.
6. 그 외에는 cwd가 현재 cwd와 일치하는 기록을 사용합니다(명시적 `sessionDir`가 있으면 그 안에 있어야 함). cwd가 다르면 현재 버킷의 비어 있지 않은 최신 세션을 사용합니다.
7. 사용 가능한 기록이 없으면 mtime 기준으로 비어 있지 않은 최신 세션을 선택하고, 없으면 새 세션을 만듭니다.

터미널 ID는 TTY 경로를 우선하며 환경 기반 식별자(`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION`)를 대안으로 사용합니다. Zellij ID는 `ZELLIJ_SESSION_NAME`이 있으면 포함하며 경로 구분자를 정규화합니다.

터미널별 기록 쓰기는 가능한 범위에서 수행하며 실패해도 치명적이지 않습니다.

유일한 위치 인수 값이 세션 ID 형식과 일치하면 `-c <value>`를 명시적 재개 대상으로 정규화합니다. 그 외의 위치 인수 텍스트는 `--continue`의 초기 프롬프트로 유지합니다.

## 시작 시 재개 대상 결정(`main.ts`)

### `--resume <value>`

`createSessionManager(...)`는 문자열 값이 있는 `--resume`을 두 방식으로 처리합니다.

1. 경로 형태의 값(`/`, `\\`를 포함하거나 `.jsonl`로 끝남)
   - `SessionManager.open(sessionArg, parsed.sessionDir, undefined, { throwIfMissing: true })`를 직접 호출합니다. 없는 경로에는 세션을 만들지 않고 `Session "<path>" not found.`로 실패합니다.

2. 재개 키 값
   - `resolveResumableSession(...)`은 먼저 로컬 세션을 검색한 뒤 모든 세션을 검색합니다. 단, 사용자 지정 `sessionDir`가 있으면 전역 대체 검색을 하지 않습니다.
   - 대소문자를 구분하지 않으며 `id` 접두사, 전체 JSONL 파일명 접두사, 타임스탬프 뒤의 세션 ID 접미사를 허용합니다.
   - 수정 시각 내림차순의 첫 일치 항목을 사용합니다(모호성 확인 없음).

일치한 세션에 기록된 cwd가 더 이상 존재하지 않으면 CLI는 `Move (re-root) it into the current directory? [Y/n]`을 묻습니다. 수락하면 세션을 열고 `moveTo(cwd)`로 이동하며, 거절하면 정상 종료합니다. 비 TTY에서는 응답할 수 없으므로 `SessionResolutionError`가 발생합니다.

그 외에는 전역 검색 결과를 포함해 기록된 프로젝트에서 세션을 엽니다. 시작 과정은 에이전트를 구성하기 전에 프로세스 cwd를 바꾸고, 프로젝트 범위 설정/플러그인을 다시 로드하며, 활성화된 모델을 다시 결정합니다. 다른 프로젝트의 일치 항목이라는 이유만으로 분기하지는 **않습니다**.

일치 항목이 없으면 `Session "..." not found.`를 던집니다.

### `--resume`(값 없음)

초기 세션 관리자 구성 후 처리합니다.

1. `SessionManager.listForPicker(cwd, parsed.sessionDir)`로 현재 폴더 세션을 나열합니다.
2. 비어 있으면 `SessionManager.listAllForPicker()`로 전체가 비어 있는지 확인하고 Tab 범위를 미리 로드합니다. 선택기 자체가 모든 프로젝트 범위로 자동 전환하지는 않습니다.
3. 두 목록이 모두 비어 있으면 `No sessions found`를 출력하고 종료합니다.
4. 전체 화면 TUI 선택기(`selectSession`)를 엽니다.
5. 취소하면 `No session selected`를 출력하고 종료합니다.
6. 선택하면 `SessionManager.open(selected.path)`를 호출한 뒤 프로세스/프로젝트 범위 상태를 해당 세션의 cwd로 전환하고(`switchToResumedProject`: `setProjectDir`, 플러그인 캐시 초기화, 설정 다시 로드), 범위별 모델을 다시 결정합니다.

### `--continue`

`SessionManager.continueRecent(...)`를 직접 사용합니다(위의 터미널별 기록 우선 동작).

## 선택기 기반 선택의 내부 동작

## CLI 선택기(`packages/tui/src/apps/session-picker.ts`)

`selectSession(sessions, options)`는 `SessionSelectorComponent`로 대체 화면의 전체 화면 TUI를 만들며 정확히 한 번 완료됩니다.

- 선택 -> 선택한 `SessionInfo`로 완료
- 취소(Esc) -> `null`로 완료
- 강제 종료(Ctrl+C 경로) -> TUI를 중지하고 종료
- Tab은 현재 폴더 / 모든 프로젝트 범위를 전환합니다. 모든 프로젝트 목록은 지연 로드하거나 미리 로드하여 제공합니다.
- 검색은 짧은 디바운스 후 세션 메타데이터/앞부분 텍스트와 `history.db`의 프롬프트 기록 일치 항목을 결합합니다.
- 전체 화면 선택기에서 마우스 휠은 선택을 바꾸고 왼쪽 클릭은 항목을 선택합니다.
- Delete 또는 검색어가 비어 있을 때 Backspace를 누르면 확인 후 JSONL과 세션 아티팩트를 삭제합니다.

## 세션 내 대화형 선택기(`SelectorController.showSessionSelector`)

처리 흐름:

1. `SessionManager.listForPicker(currentCwd, currentSessionDir)`로 현재 폴더 세션을 가져옵니다. 폴더 범위가 비어 있어도 모든 프로젝트 목록은 지연 로드합니다.
2. `ctx.ui.showOverlay`로 `SessionSelectorComponent`를 대체 화면의 전체 화면 오버레이에 표시합니다(왼쪽 위 기준 전체 크기이며 아래 대화 기록은 건드리지 않음). 모든 프로젝트 지연 로드(`loadAllSessions`), `history.db` 프롬프트 검색, 삭제, 고정 세션 표시, 현재 세션 표시를 연결합니다.
3. 콜백:
   - 선택 -> 선택기 입력을 잠그고 `handleResumeSession(sessionPath)`를 호출합니다. 성공하면 오버레이를 숨기고 편집기 포커스를 복원합니다. 복구 가능한 전환 전 실패는 잠금을 풀고 선택기를 열어 둡니다.
   - 취소 -> 오버레이를 숨기고 편집기 포커스를 복원한 뒤 다시 렌더링합니다.
   - 종료 -> 오버레이를 숨긴 뒤 `ctx.shutdown()`을 호출합니다.

`/resume <id-prefix>`는 로컬, 전역 순서로 일치 항목을 찾아 직접 전환합니다. 대신 `/resume @claude`와 `/resume @codex`는 원본을 읽기 전용으로 다루는 가져오기 선택기를 엽니다. 선택한 외부 대화 기록을 OMP 세션으로 저장한 뒤 전환합니다. 이 선택기는 삭제, 기록 검색 보강, 모든 프로젝트 범위를 제공하지 않습니다.

## 세션 선택기 컴포넌트 동작

`SessionList`는 다음을 지원합니다.

- Up/Down 및 Page Up/Page Down 탐색(끝에서 멈추며 순환하지 않음)
- Enter로 선택
- Delete 또는 빈 검색어에서 Backspace로 확인 후 삭제
- Esc로 취소, Ctrl+C로 종료
- Tab으로 현재 폴더 / 모든 프로젝트 범위 전환
- 전체 화면 선택기의 마우스 휠/클릭
- id/제목/cwd/첫 메시지/앞부분 메시지 텍스트/경로에 대한 다중 토큰 검색: 정확한 문자열 일치 항목을 최신순으로 먼저 표시하고, 충분히 강한 유사 일치 항목을 이어서 표시합니다. 입력이 잠시 멈추면 `history.db` 프롬프트 기록 일치 항목의 순위가 올라갈 수 있습니다.
- 실행 중인 세션은 `currentSessionPath`가 제공되면 메타데이터 줄에 `current`로 표시하며, 열 때와 Tab 범위 전환 후 포커스를 맞춥니다.

빈 목록 렌더링:

- 현재 폴더 범위는 `No sessions in current folder. Press Tab to view all.`, 모든 프로젝트 범위는 `No sessions found`를 표시합니다.
- 빈 목록에서 Enter/Delete/Backspace는 아무 동작도 하지 않습니다.
- Esc/Ctrl+C는 계속 작동합니다.

## 런타임 전환 실행(`AgentSession.switchSession`)

`switchSession(sessionPath)`는 프로세스 내 전환의 핵심 경로입니다.

수명 주기/상태 전이:

1. 이전 파일을 보관하고 취소 가능한 `session_before_switch`(`reason: "resume"`, 대상 파일)를 발생시킵니다.
2. 에이전트 리스너를 분리하고 활성 작업을 중단하며, 전환 전 조정기를 실행하고 대기 중인 bash/세션 쓰기를 플러시합니다.
3. 롤백 상태(관리자, 큐, 메시지, 모델/추론/등급, 도구/프롬프트, 공급자 캐시 식별자, 체크포인트/되감기 상태)를 저장한 뒤 메시지 큐를 비웁니다.
4. 다른 세션으로 전환할 때는 자문 기록기의 처리를 마치고 분리합니다.
5. `sessionManager.setSessionFile(sessionPath)`: 터미널별 기록을 갱신하고, 항목을 로드/마이그레이션/블롭 해석/인덱싱하며, cwd 정책이 허용하면 존재하는 기록된 cwd를 적용합니다.
6. 세션 ID, 메모리 키, 상속된 공급자 캐시 키, 표시 컨텍스트를 동기화합니다. 기록된 모델을 결정하고(아래 참조), 체크포인트/되감기 상태를 복원합니다.
7. `session_switch`를 발생시키고 메시지를 교체하며, 자문 세션 상태를 초기화하고 할 일을 동기화합니다.
8. 다른 세션이거나 재생 내용이 바뀐 동일 세션 재로드라면 공급자 세션을 닫습니다.
9. 결정한 모델 또는 호출자가 명시한 `model`을 적용합니다.
10. 로드한 분기가 중단된 도구 흐름으로 끝났으면 합성 중단 메시지를 추가하고 표시 컨텍스트를 다시 구성합니다.
11. 설정된 추론(`auto`는 auto로 유지)과 계열별 서비스 등급을 복원합니다. 대응하는 항목이 없으면 현재 설정을 사용합니다.
12. 필요에 따라 메모리/도구 세션 상태를 초기화하고, 리스너를 다시 연결하며, 모드 조정을 실행하고 작업 공간을 반영하는 기본 시스템 프롬프트를 새로 고칩니다.
13. 다른 세션이면 자문 비용을 복원하고, bash 전환을 마무리하며, 세션 변경 콜백에 알리고 성공 시 `true`를 반환합니다.
`switchSession()`은 전환 전 훅이 취소하거나 cwd 정책이 전환을 거부하면 `false`를 반환합니다. cwd 변경 콜백이 없는 프로젝트 간 전환은 대상 cwd를 조용히 적용하지 않고 거부합니다. 콜백 거부도 취소입니다.

스냅샷 이후 실패하면 이전 관리자와 런타임 상태를 복원하고 다시 연결/조정하며, bash 전환을 실패로 표시합니다. cwd 정책 거부는 `false`를 반환하고, 다른 실패는 다시 던집니다. 성공 경로의 모드 조정 및 기본 프롬프트 갱신 실패는 전환을 되돌리지 않고 로그에 남깁니다.

기록된 모델은 시작 시 재개와 같은 방식으로 결정합니다. 등록되고 활성화되었으며 인증 정보가 설정된 첫 역할/기본 후보를 선택하고, 공급자 범위 탐색을 새로 고친 뒤 한 번 재시도합니다. 다른 세션에서 아무 모델도 결정하지 못하면 `session_switch` 전에 `Could not restore model <provider/id>`를 던지고 롤백합니다. `hasUI`와 `allowSessionModelFallback`으로 만든 세션(TUI)은 `retry.modelFallback`이 켜져 있으면 대신 현재 모델을 유지하며, `onModelFallback` 또는 `notice` 이벤트로 `Could not restore model <provider/id>. Using <provider/id>`를 알립니다. 같은 파일을 다시 로드하면 현재 모델을 유지합니다. 모델을 선택하는 호출자는 `model`을 전달합니다(`provider`/`modelId`가 있는 RPC `open_session`/`switch_session`). collab 복제본은 호스트 상태가 모델을 제공하므로 `keepModel`을 전달합니다.

## 대화형 전환 후 UI 상태 재구성

`SelectorController.handleResumeSession`은 먼저 `switchSession`을 호출합니다. `false`가 반환되면 새 세션 UI 갱신을 적용하기 전에 멈추고 기존 세션/UI를 유지합니다. 전환에 성공하면 다음을 수행합니다.

- 로딩 애니메이션 중지
- 상태 컨테이너 비우기
- 대기 메시지 UI와 대기 도구 맵 비우기
- 스트리밍 컴포넌트/메시지 참조 초기화
- 재개한 세션의 cwd가 이전과 다르면 프로세스와 cwd 기반 캐시를 새 위치로 변경(`applyCwdChange`)
- 채팅 컨테이너를 비우고 세션 컨텍스트에서 다시 렌더링(`renderInitialMessages`)
- 새 세션 아티팩트에서 할 일 다시 로드
- `Resumed session`(프로젝트 간 재개는 `Resumed session in <dir>`)을 표시한 뒤 모델 대체 경고가 있으면 표시

따라서 보이는 대화/할 일 상태는 새 세션 파일에서 다시 구성됩니다.

## 시작 시 재개와 세션 내 전환 비교

### 시작 시 재개(`--continue`, `--resume`, 직접 열기)

- `createAgentSession(...)` 전에 세션 파일을 선택합니다.
- `sdk.ts`가 생성 중 기존 세션 컨텍스트를 구성합니다.
- 에이전트 메시지와 재생 상태는 구성 중 한 번 복원합니다.
- 모델/추론/서비스 등급은 저장된 상태를 사용하고 없으면 현재 설정을 사용합니다.
- 이후 대화형 모드가 저장된 모드 상태를 조정합니다.

### 세션 내 전환(`/resume` 방식의 선택기 경로)

- 이미 실행 중인 세션에서 `AgentSession.switchSession(...)`을 사용합니다.
- 메시지/모델/추론/등급과 세션 범위 런타임 상태를 제자리에서 다시 구성합니다.
- `session_before_switch`/`session_switch` 훅을 발생시킵니다.
- UI 채팅/할 일을 새로 고칩니다.
- 등록된 세션 전환 조정기를 통해 대화형 모드 조정을 실행합니다.

## 실패와 경계 사례 동작

### 취소 경로

- CLI 선택기 취소 -> `null`을 반환하고 호출자가 `No session selected`를 출력한 뒤 프로세스가 종료합니다.
- 대화형 선택기 취소 -> 세션을 바꾸지 않고 오버레이를 닫습니다.
- 핵심 훅 또는 cwd 정책 취소 -> `switchSession()`이 `false`를 반환합니다. 대화형 선택기는 UI 갱신/상태 처리 전에 멈춰 이전 세션과 UI를 유지합니다. 콜백 없는 프로젝트 간 전환은 대상 cwd를 조용히 적용하지 않고 거부합니다.
- 대체 허용 없이 저장된 모델을 복원할 수 없음 -> `switchSession()`이 `Could not restore model <provider/id>`를 던집니다. 선택기와 `/resume <id>`는 오류를 표시하고 이전 세션을 유지합니다.

### 빈 목록 경로

- CLI `--resume`(값 없음): 현재 폴더와 전역 목록이 **모두** 비어 있을 때만 `No sessions found`를 출력하고 종료합니다. 그 외에는 빈 폴더 범위 선택기가 Tab 사용을 안내합니다.
- 대화형 선택기: 빈 폴더 범위는 Tab 안내를 표시하며 계속 취소할 수 있습니다.

### 대상 세션 파일이 없거나 유효하지 않은 경우

특정 경로를 열거나 전환할 때(`setSessionFile`):

- `setSessionFile`에 명시적으로 전달한 경로가 없거나 비어 있으면 그 경로에 새 세션을 초기화하고 저장합니다.
- 비어 있지 않은 파일의 헤더가 없거나 잘못되었으면 `Cannot resume session "...": the session header is missing or malformed. The file was not modified.`를 던집니다.
- 엄격한 열기/재개 경로는 항목이 없는 파일을 새로 만드는 대신 거부할 수 있습니다.
- 유효한 헤더 뒤의 잘못된 본문 레코드는 관대하게 복구하며, 로드한 파일을 재작성 대상으로 표시합니다.

유효하지 않은 헤더를 복구할 때 원본 파일을 덮어쓰지 않습니다.

### 치명적 실패

전환/열기는 실제 I/O 실패(권한 오류, 재작성 실패 등)에서 여전히 예외를 던질 수 있으며, 이는 호출자에게 전파됩니다.

### ID 접두사 검색 주의 사항

- 검색은 소문자로 바꾼 세션 ID, JSONL 파일명, 파일명 타임스탬프 뒤 ID 접미사에 `startsWith`를 사용합니다.
- 수정 시각 내림차순의 첫 일치 항목이 선택됩니다. 여러 세션이 접두사를 공유해도 모호성을 해소하는 UI는 없습니다.
- 앞부분 목록 메타데이터는 의도적으로 가볍게 구성하므로, 검색 텍스트에 세션 파일의 첫 4KB 밖에 있는 메시지는 포함되지 않을 수 있습니다.
