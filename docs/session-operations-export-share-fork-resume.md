# 세션 작업: export, dump, share, fresh, clear, fork, resume/continue

이 문서는 현재 구현된 세션 내보내기, 공유, 대화 초기화, 수명 주기, 포크 및 재개 작업의 사용자 관점 동작을 설명합니다.

## 구현 파일

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — export/dump/share 명령 명세
- [`src/slash-commands/builtin-lifecycle.ts`](../packages/coding-agent/src/slash-commands/builtin-lifecycle.ts) — 수명 주기 명령 명세
- [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts) — `/seance` 명령과 세션 선택기 어댑터
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — TUI 실행
- [`src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts) — 재개/가져오기 선택기와 cwd 전환
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`src/export/share.ts`](../packages/coding-agent/src/export/share.ts)
- [`src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`src/cli/flag-tables.ts`](../packages/coding-agent/src/cli/flag-tables.ts) — 재시작 인수 재작성
- [`src/main.ts`](../packages/coding-agent/src/main.ts)

## 작업 비교

| 작업 | 진입 경로 | 세션 변경 | 세션 파일 생성/전환 | 출력 결과물 |
| --- | --- | --- | --- | --- |
| `/dump [all]` | 슬래시 명령(TUI/헤드리스) | 없음 | 없음 | 클립보드/명령 텍스트 및 가능한 경우 임시 JSON 보조 파일. `all`: 임시 zip |
| `/export [--themes] [path]` | 슬래시 명령(TUI/헤드리스) | 없음 | 없음 | HTML 파일 |
| `--export <session.jsonl> [outputPath]` | CLI 시작 빠른 경로 | 런타임 세션 변경 없음 | 활성 세션 없이 대상 파일 읽기 | HTML 파일 |
| `/share` | 슬래시 명령(TUI/헤드리스) | 없음 | 없음 | 암호화된 공유 링크(gist 또는 공유 서버). 임시 HTML은 TUI 사용자 지정 처리기에만 제공 |
| `/new` | 대화형 슬래시 명령 | 있음(빈 대화 시작) | 식별자 전환 및 영구 모드에서 새 헤더 기록 | 없음 |
| `/fresh` | 슬래시 명령(TUI/헤드리스) | 있음(제공업체용 메모리 ID/상태만) | 없음. 현재 파일/헤더 유지 | 없음 |
| `/clear` | 대화형 슬래시 명령 | 있음(실시간/모델 대화 컨텍스트 지우기) | 식별자/파일/기록 유지. 지연 세션은 일반 저장 조건을 따름 | `reset_boundary` 추가 |
| `/delete` | 대화형 슬래시 명령 | 있음(빈 대화 시작) | 현재 저장 세션과 결과물 삭제 시도 후 지연 생성 후속 세션으로 전환(내용이 생길 때까지 빈 파일 없음) | 없음 |
| `/fork` | 대화형 슬래시 명령 | 있음(활성 식별자 변경) | 새 세션 파일 생성 및 전환(영구 모드만) | 결과물 디렉터리가 있으면 새 세션 네임스페이스로 복사 |
| `/fork pane`, `/fork window`, `/fork tab` | 대화형 슬래시 명령 | 없음(부모 유지) | 기록을 비운 현재 대화에서 멀티플렉서 창/그룹(tmux 창, Zellij/Herdr/Orca 탭, CMUX 작업 공간)에 자식 OMP 프로세스 열기 | 자식에 별도 포크 세션 제공 |
| `--fork <id\|path>` | CLI 시작 | 세션 생성 후 있음 | 선택한 원본을 현재 cwd/세션 디렉터리로 포크 | 기본적으로 원본 결과물을 재귀 복사 |
| `/seance [id\|path] [--model sel]` | 대화형 슬래시 명령 | 없음(활성 세션/모델 유지) | 현재 세션 아래 읽기 전용 자문 하위 에이전트로 원본 대화 포크 | 없음. 자문 에이전트는 원본 결과물을 제자리에서 읽음 |
| `/resume [id\|@claude\|@codex]` | 대화형 슬래시 명령 | 있음(활성 메모리 상태 대체) | 선택/일치 세션으로 전환하거나 외부 세션 가져오기 | 없음 |
| `--resume` | CLI 시작 선택기 | 세션 생성 후 있음 | 기존 파일 열기. 현재 폴더 범위에서 시작하며 전체가 빈 경우의 조기 종료와 즉시 Tab 전환을 위해서만 전역 목록 미리 로드 | 없음 |
| `--resume <id\|path>` | CLI 시작 | 세션 생성 후 있음 | 기존 세션 열기. 기록된 cwd가 없으면 현재 디렉터리로 루트 재지정 가능 | 없음 |
| `/restart` | 대화형 슬래시 명령 | 있음(프로세스 재실행) | 설정 플래그 유지. 실제 파일이 있으면 재개하고 없으면 새로 시작 | 없음 |
| `--continue` | CLI 시작 | 세션 생성 후 있음 | 터미널 기록 또는 최신 세션 열기. 없으면 새로 생성 | 없음 |

## 내보내기와 덤프

### `/export [--themes] [outputPath]`(슬래시 명령)

흐름:

1. 협업 명령 명세(`src/slash-commands/builtin-collaboration.ts`)는 `parseExportArgs`로 헤드리스 인수를 파싱합니다. TUI는 같은 파서를 쓰는 `CommandController.handleExportCommand`에 위임합니다.
2. `--themes`는 독립 웹 팔레트 대신 설정된 TUI 어두운/밝은 테마를 선택합니다. 이 플래그를 제거한 뒤 공백으로 구분한 경로를 하나만 허용하며 추가 토큰이 있으면 `Usage: /export [--themes] [path]` 사용법을 표시합니다.
3. `AgentSession.exportToHtml()`은 `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`를 호출합니다.
4. TUI는 경로를 표시하고 브라우저에서 파일을 엽니다. 헤드리스 실행은 열지 않고 경로만 출력합니다.

TUI에서 `/export`의 대상은 `viewSession`입니다. 하위 에이전트에 초점을 맞추면 기본 세션이 아닌 해당 에이전트의 대화 기록과 자손을 내보냅니다. `/dump`와 `/share`는 여전히 기본 세션을 대상으로 합니다.

세부 동작:

- `--copy`, `clipboard`, `copy` 인수는 `/dump`를 사용하라는 경고와 함께 명시적으로 거부합니다.
- 내보내기는 세션 헤더/항목/리프와 에이전트 상태의 현재 `systemPrompt`, 도구 설명을 포함합니다. 헤더의 `previousSessionFiles`는 생략합니다.
- 세션 파일 옆의 하위 에이전트 대화 기록(`<session>/<AgentId>.jsonl`, 중첩 생성도 재귀 처리)은 `subSessions`로 포함합니다(`src/session/sub-sessions.ts`의 `collectSubSessions`; `ExportOptions`에서 `includeSubSessions: false`로 비활성화). 탐색은 자문 대화 기록(`__advisor*.jsonl`)을 건너뛰고 실제 자식 디렉터리만 내려가며 삭제 표시된(종료한) 에이전트는 `aborted`로 표시합니다. 페이지의 task 도구 카드에서 에이전트 ID를 누르면 탐색 경로가 있는 하위 세션 오버레이가 열립니다.
- 도구 호출은 `<omp-tool-view>` 웹 컴포넌트로 렌더링합니다. 이는 collab-web과 공유하는 React 도구별 렌더러(`packages/collab-web/src/tool-render/`)이며 `bun run gen:tool-views`로 `src/export/html/tool-views.generated.js`에 미리 빌드합니다.
- 내보내기 중 세션 항목을 추가하지 않습니다.
- 기본 파일 이름은 현재 디렉터리의 `omp-session-<session-file-stem>.html`입니다. HTML 내보내기는 비밀 정보를 가리거나 암호화하지 않으므로 원시 컨텍스트, 이미지 데이터, 확장 기능 페이로드가 포함될 수 있습니다.

주의:

- 공백 기준으로 파싱하므로 따옴표로 묶어도 공백이 있는 경로는 유지되지 않습니다. 공백 없는 경로를 사용하세요.

### `--export <inputSessionFile> [outputPath]`(CLI)

`main.ts`의 흐름:

1. 대화형/세션 시작 전에 먼저 처리합니다.
2. `exportFromFile(inputPath, outputPath?)`를 호출합니다.
3. `SessionManager.open(inputPath, ..., { suppressBreadcrumb: true, throwIfMissing: true })`로 항목을 불러온 뒤 HTML을 생성하고 기록합니다.
4. 프로세스가 `Exported to: ...` 경로 안내를 출력하고 종료합니다.

세부 동작:

- 입력 파일이 없으면 `File not found: <path>` 오류가 나며, 비었거나 헤더가 잘못된 파일은 입력을 생성/대체하지 않고 실패합니다.
- `AgentSession`을 만들거나 터미널 기록을 갱신하거나 실행 중인 세션을 변경하지 않습니다.
- 독립 내보내기에는 실시간 에이전트 상태가 없어 현재 시스템 프롬프트/도구 설명을 추가하지 않습니다. 불러온 항목과 하위 에이전트 대화 기록을 포함합니다.

### `/dump`(클립보드/헤드리스 텍스트 내보내기)

흐름:

1. `session.formatSessionAsText()`를 호출합니다.
2. 빈 문자열이면 아직 덤프할 메시지가 없다고 알립니다(`No messages to dump yet.`).
3. 그 외에는 `session.dumpLlmRequestToTmpDir()`도 시도하고 결과 경로를 대화 기록에 추가합니다. TUI는 합친 텍스트를 클립보드에 복사하며 헤드리스/ACP 실행은 명령 출력으로 반환합니다.

덤프는 모든 분기나 과거 JSONL 항목이 아닌 실시간 에이전트 메시지 배열을 사용합니다. `/clear`나 컨텍스트 압축 이후에는 현재 실시간 컨텍스트를 반영합니다. 저장된 대화 그래프는 HTML로 내보내세요.

덤프에 포함되는 내용:

- 시스템 프롬프트
- 활성 모델/추론 수준
- 도구 정의와 매개변수
- 사용자/developer/어시스턴트 메시지
- 추론 블록과 도구 호출
- 도구 결과와 실행 블록(`excludeFromContext` bash/python 항목 제외)
- 사용자 지정/훅/파일 참조/분기 요약/컨텍스트 압축 요약 항목

가능한 경우 만드는 JSON 보조 파일은 OS 임시 디렉터리의 `omp-llm-request-<id>.json`입니다. 현재 모델, 추론 수준, 서비스 등급, 시스템 프롬프트, 전송용 도구 스키마, LLM 형식으로 변환한 메시지를 포함합니다. 명령 이후에도 남고 원시 컨텍스트나 비밀 정보를 포함할 수 있으므로 보호하거나 삭제하세요. 보조 파일 실패가 대화 기록 출력을 막지는 않습니다. TUI는 실패를 알리고 헤드리스 실행은 경로를 조용히 생략합니다.

덤프는 세션 저장 항목을 추가하지 않습니다.

### `/dump all`(에이전트별 덤프 zip)

`/dump all`은 `session.dumpSessionArchiveToTmpDir()`를 호출하여 OS 임시 디렉터리에 `omp-dump-<id>.zip`을 쓰며 다음을 포함합니다.

- `session.md` — `/dump`가 복사하는 것과 같은 기본 대화 기록
- `llm-request.json` — `/dump` 보조 파일과 같은 페이로드. 가능한 경우 제공하며 변환 실패 시 생략
- `subagents/<path>.md` — `collectSubSessions`가 찾은 저장된 하위 에이전트마다 하나의 파일(예: `subagents/Scout.md`, `subagents/Scout/Helper.md`). `# Subagent: <path>` 제목, 저장된 모델/추론 수준, 종료한 에이전트의 `Status: aborted`, 마지막 항목 분기의 메시지를 포함하며 기본 세션처럼 난독화를 복원

하위 에이전트 시스템 프롬프트와 도구 목록은 저장하지 않으므로 파일에서도 생략합니다. 메시지가 없는 하위 에이전트는 건너뜁니다. 탐색에 실패해도 아카이브에는 기본 덤프가 남고 보고서에 누락 이유를 표시합니다. TUI는 아카이브 경로를 클립보드에 복사하고 구성 파일을 나열하며 헤드리스/ACP는 같은 보고서를 명령 출력으로 반환합니다. 보조 파일처럼 아카이브도 남으며 원시 컨텍스트나 비밀 정보를 포함할 수 있습니다.

## 공유

`/share`는 세션의 종단 간 암호화 스냅샷을 게시하고 뷰어 링크를 출력합니다. 구현: [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts).

### TUI 1단계: 사용자 지정 공유 처리기(있는 경우)

대화형 TUI의 `loadCustomShare()`는 활성 에이전트 디렉터리(기본 `~/.omp/agent`)에서 처음 존재하는 후보를 확인합니다.

- `share.ts`
- `share.js`
- `share.mjs`

요구 사항:

- 모듈은 `(htmlPath) => Promise<CustomShareResult | string | undefined>` 함수를 기본 내보내기해야 합니다.

있고 유효하면 기존 계약을 유지합니다. 세션을 임시 HTML 파일(`${os.tmpdir()}/${Snowflake.next()}.html`)로 내보내고 처리기에 경로를 전달한 뒤 임시 파일을 제거합니다. 처리기 결과는 다음처럼 해석합니다.

- 문자열 → URL로 취급하여 표시하고 열기
- 객체 → `url` 및/또는 `message` 표시, `url` 열기
- `undefined`/거짓 같은 값 → 일반적인 공유 완료 안내(`Session shared`)

중요한 대체 동작:

- 사용자 지정 처리기가 있지만 로드에 실패하면 명령은 오류를 내고 반환합니다.
- 처리기 실행 중 예외가 나도 오류를 내고 반환합니다.
- 두 실패 모두 기본 흐름으로 **대체하지 않습니다**.
- 사용자 지정 공유 스크립트가 없을 때만 기본 흐름을 실행합니다.
- 헤드리스/ACP 슬래시 명령은 사용자 지정 공유 스크립트를 불러오지 않고 항상 기본 암호화 흐름을 사용합니다.

사용자 지정 처리기는 기본 비밀 정보 제거/암호화 스냅샷이 아닌 일반 HTML 내보내기를 받습니다. 게시, 암호화, 개인정보 정책은 전적으로 처리기 책임입니다. HTML 내보내기 계약 때문에 이 경로에서는 메모리 전용 세션도 공유할 수 없습니다.

### 기본 암호화 공유

헤드리스 실행 또는 TUI에서 사용자 지정 처리기가 없을 때 `shareSession()`은 다음을 수행합니다.

1. 기본 세션 스냅샷(`header`, `entries`, `leafId`, 에이전트 상태의 현재 `systemPrompt`와 도구 설명)을 구성하고 헤더의 `previousSessionFiles`는 생략합니다. HTML 내보내기와 달리 하위 에이전트 대화 파일은 수집하지 않습니다.
2. `share.redactSecrets`가 활성화되어 있고(기본값) 난독화기에 설정되거나 정규식으로 발견한 비밀 정보가 있으면 타입별 필드 가리기로 헤더, 프롬프트, 도구, 항목, 하위 세션, 메시지의 텍스트 필드를 재작성합니다. 인라인 이미지 바이트는 이후 크기 처리까지 유지합니다. 불투명한 제공업체 재생 필드와 타입 없는 확장 기능 페이로드(`details`, `data`, `outputSchema`, 컨텍스트 압축 보존 데이터)는 내부를 순회하지 않고 제거합니다.
3. JSON을 gzip으로 압축하고 새 AES-256-GCM 키로 암호화합니다(`[12B IV][ciphertext+tag]`).
4. `share.store`로 업로드 대상을 선택합니다.
   - **공유 서버**(기본값, `store: "blob"`) — `POST <share.serverUrl>`(기본 `https://my.omp.sh/s`)로 최대 1 MB의 원시 블롭을 전송합니다. 크면 인라인 이미지, 긴 문자열(32,768 → 8,192 → 2,048 → 512자 한도), 오래된 항목 순으로 맞을 때까지 줄입니다. 줄여도 한도를 넘으면 큰 블롭을 올리는 대신 실패합니다.
   - **비공개 gist**(`store: "gist"`) — `gh`가 설치되고 인증되었으면 암호화 블롭을 Base64로 인코딩하여 `session.ompshare.txt`로 올립니다(암호화 후 한도 5 MB, gist 원시 가져오기 한도 10 MB). `gh`를 쓸 수 없거나 gist 생성에 실패하면 공유 서버로 대체합니다.
5. 두 경우 모두 링크는 `<share.serverUrl>/<id>#<base64url key>`입니다. 뷰어 페이지는 블롭을 가져와(16진수 ID는 GitHub gist API, 나머지는 서버 블롭 저장소) 클라이언트에서 복호화합니다. 키는 URL 프래그먼트에만 있으며 HTTP 요청에 포함되지 않습니다.

UI는 공유 URL과 해당하는 경우 원본 gist URL 및 잘라내기 안내를 표시합니다. 헤드리스 `/share`도 같은 줄을 출력합니다. `/export`와 달리 `/share`는 실시간 항목으로 스냅샷을 구성하므로 세션 파일 없이 메모리 전용(`--no-session`) 세션에서도 동작합니다.

공유 취소/중단 의미:

- 로더의 `onAbort` 훅은 편집기 UI를 복원하고 공유 취소를 알립니다(`Share cancelled`).
- 업로드 자체는 도중에 중단하지 않습니다. 취소는 UI 수준이며 업로드가 반환된 뒤 확인합니다.

## 새 세션과 삭제

대화형 `/new`는 새 대화 식별자를 시작합니다. TUI는 먼저 진행 중인 컨텍스트 압축을 중단합니다. `AgentSession.newSession()`은 취소 가능한 `session_before_switch` 이벤트를 내고 이전 실행 중단, 소유한 비동기 작업 취소, 제공업체 상태 종료, 나가는 쓰기/자문 기록기 비우기를 수행합니다. 영구 `SessionManager.newSession()`은 첫 어시스턴트 응답 전이라도 반환 전에 새 헤더를 기록합니다.

새 세션은 현재 모델/설정과 설정된 추론 선택자를 유지하지만 대화/큐, 할 일/체크포인트/도구 상태, 상속 캐시 식별자, 자문 비용, 승격된 메모리 컨텍스트를 지웁니다. 작업 공간 루트는 현재 설정에서 가져오고 프로젝트 지침은 디스크에서 새로 읽습니다. TUI는 초점을 맞춘 하위 에이전트 보기를 떠나고 대화 기록을 지웁니다.

`/delete`는 `drop: true`로 같은 전환을 사용합니다. 세션 파일 경로가 필요하며 이전 JSONL과 결과물 트리를 유지하는 대신 삭제를 시도하고, 삭제에 실패해도 새 세션을 시작합니다. `/new`와 달리 이 후속 세션은 지연 생성됩니다. 내용이 생길 때까지 헤더를 쓰지 않으므로 메시지 없이 종료하면 턴이 없는 세션을 남기지 않습니다. 전환 전 훅은 두 작업 모두 취소할 수 있습니다. Vibe 모드에서는 둘 다 거부합니다.

## Fresh

`/fresh`(TUI/헤드리스)는 **로컬 대화 기록, 세션 파일, 헤더를 건드리지 않고** 현재 세션의 제공업체용 스트림 상태를 초기화합니다. 보이는 대화를 유지하면서 멈추거나 손상된 제공업체 스트림(오래된 프롬프트 캐시, 턴 도중 오류, 어긋난 서버 대화 ID)을 복구할 때 사용하세요.

`AgentSession.freshSession()`:

- 에이전트 스트리밍 중에는 거부합니다. 응답 완료를 기다리거나 먼저 중단하세요.
- 캐시된 모든 제공업체 세션 상태(서버 대화/프롬프트 캐시 핸들)를 닫고 제거한 개수를 알립니다.
- 새 제공업체 세션 ID를 발급하고 메모리 상태 키를 바꾸며 추가 전용 컨텍스트를 무효화하여 다음 턴이 로컬 대화에서 재구성되도록 합니다.
- 로컬 대화 기록, 세션 파일, OMP 세션 관리자 식별자는 유지하며 제공업체용 `AgentSession.sessionId`만 바뀝니다.

표시용/모델용 대화를 모두 유지하므로 `/fresh`는 `/clear`(현재 실시간/모델 대화 지우기), `/new`(완전히 새로운 빈 세션), `/delete`(현재 세션 삭제 시도 후 새 세션)와 다릅니다. `/fresh`만 기존 대화를 유지하며 제공업체 스트림 상태를 새로 시작합니다.

## Clear

대화형 `/clear`는 현재 대화 컨텍스트를 제자리에서 지웁니다. TUI에서만 사용할 수 있으며 응답 스트리밍 또는 포그라운드 bash/Python 실행 중에는 거부합니다. 압축 중이면 중단하고 멈출 때까지 기다린 뒤 초기화합니다.

`AgentSession.resetSessionContext()`:

- 실시간 메시지, 대기 중 방향 수정/후속 턴, 미완료 도구 호출, 오류 상태, 체크포인트/되감기 및 지연 도구 상태, 세션 중지 후속 상태를 제거합니다. 이 에이전트의 대기 중 후속 작업과 비동기 bash/task 작업도 취소합니다.
- 제공업체 세션 상태를 교체하고 자문 에이전트를 다시 준비하며 추가 전용 모델 컨텍스트를 무효화합니다. 메모리 승격도 초기화하여 다음 턴이 기본 시스템 프롬프트와 현재 프로젝트 지침에서 재구성되도록 합니다.
- 세션 ID, 제목, cwd, 모델, 설정, 활성 계획 경로, 대화 파일은 유지합니다.
- 일반 저장 파이프라인으로 `reset_boundary`를 추가합니다. 파일이 이미 있으면 영속 저장하고 메모리 전용/지연 세션이면 메모리에 유지합니다. 접힌 실시간 대화 기록과 재구성 모델 컨텍스트는 최신 경계 뒤에서 시작하지만 저장된 JSONL과 전체 내보내기는 초기화 전 기록도 유지합니다.

성공 후 TUI는 렌더링된 대화 기록을 지웁니다. 대화를 유지하며 스트림 상태만 교체하는 `/fresh`, 새 식별자와 파일을 만드는 `/new`, 이전 저장 세션 삭제를 시도한 뒤 새로 시작하는 `/delete`와 다릅니다.

## BTW 기록

`/btw` 기록은 세션 결과물 옆에 저장하며 기본 대화 밖에 유지합니다. 키보드 조작, 후속 대화, 저장, 마이그레이션 안전성은 [BTW 명령 참조](slash-command-internals.md#11-built-in-command-note-btw)를 참조하세요.

## 포크

인수 없는 `/fork`는 현재 세션에서 새 세션을 만들고 활성 식별자를 전환합니다. `/fork pane`은 새 분할 창에 별도 OMP 프로세스를 열고, `/fork window`와 `/fork tab`은 새 멀티플렉서 그룹(tmux 창, Zellij/Herdr/Orca 탭, CMUX 작업 공간)에 엽니다. 자식은 현재 저장된 대화 기록에서 시작하고 부모는 활성 상태로 계속 실행됩니다.

`/fork `를 입력하면 `[pane|window|tab]`을 흐린 인라인 텍스트로 표시하며 Enter는 여전히 인수 없는 제자리 포크를 실행합니다. 접두사(`/fork w`)를 입력하면 제안을 열고 선택 인수의 나머지를 흐리게 표시합니다. Tab으로 수락합니다.

배치 명령은 터미널에서 tmux, Zellij, Herdr, CMUX, Orca를 자동 감지합니다. `/fork auto`는 하위 명령이 아닙니다(유효 인수: `pane`, `window`, `tab`). `window`는 tmux 창, Zellij/Herdr/Orca 탭, CMUX 작업 공간에 대응합니다. 일반 터미널, `screen`, `wmux`는 지원하지 않아 명시적 오류가 나므로 인수 없는 `/fork`를 사용하세요.

### 사전 조건과 즉시 검사

- 인수 없는 `/fork`는 스트리밍 중 경고와 함께 거부합니다.
- 스트리밍 중 배치 포크는 실행 전에 확인합니다. 자식은 부분 응답을 생략할 수 있으며 확인해도 부모 응답을 멈추지 않습니다.
- Vibe 모드에서는 포크를 거부합니다.
- 배치 포크에는 이미 저장된 대화 파일이 필요합니다. 자식 실행 전에 대기 중 쓰기를 비우며 부모 세션은 전환하지 않습니다.
- CLI `--api-key` 재정의는 멀티플렉서 명령에 안전하게 전달할 수 없어 키 노출 대신 배치 포크를 거부합니다.
- UI 상태/로딩 표시는 기존 인수 없는 `/fork` 흐름에서만 지웁니다.

### 터미널 배치 흐름

배치 명령은 현재 CLI 진입점과 재시작에 안전한 시작 플래그로 자식 명령을 재구성합니다. `--goal` 같은 일회성 선택자와 위치 프롬프트는 제외합니다. 오래된 모델, 추론, 프로필, 프롬프트 캐시 키, 작업 디렉터리 플래그를 활성 세션 값으로 바꾸고, 부모가 채운 캐시를 읽도록 부모 프롬프트 캐시 키에 고정합니다. 자식은 유효한 에이전트/설정 디렉터리, 해석된 설정 오버레이(`/move` 후에도 원래 경로 유지), 부모 세션 디렉터리 및 XDG 기본 디렉터리를 받습니다. 부모가 설정하지 않은 범위 변수는 빈 값으로 내보내지 않고 해제합니다. `--fork`와 현재 대화 파일의 절대 경로로 시작합니다. 공통 터미널 실행기가 제공업체별 실행을 처리하고 기능/시작 실패를 TUI에 알립니다. CMUX와 Orca는 대상의 대화형 셸이 POSIX 문법을 지원한다는 명시적 확인이 필요하며 로컬 OS나 `SHELL`에서 추론하지 않습니다. 거절하면 세션 쓰기 비우기나 터미널 실행 전에 멈춥니다. `window`와 `tab`은 모두 그룹 배치입니다. Orca CLI는 문서화된 순서(`ORCA_CLI_COMMAND`, Orca 개발 체크아웃의 `orca-dev`, Orca 터미널 밖 Linux의 `orca-ide`, `orca`)로 찾습니다.

Orca CLI의 `--command`는 argv가 아닌 셸 텍스트이며 `--cwd`가 없습니다. 확인 후 OMP는 공통 POSIX 인용으로 `cd <quoted-cwd> && <quoted-command>`를 제공합니다. Orca가 새 탭을 표시하지 못하고 백그라운드 터미널에서 시작하면 `/fork`는 보이는 탭이라고 하지 않고 경고합니다.

### 세션 수준 흐름

기존 인수 없는 `/fork`는 `AgentSession.fork()`를 사용합니다.

1. 취소 가능한 `session_before_switch`를 `reason: "fork"`로 내보냅니다.
2. 대기 중 bash/세션 쓰기를 비우고 자문 기록기를 비운 뒤 분리합니다.
3. 대화와 사용량 귀속을 유지하는 `SessionManager.fork()`를 호출합니다.
4. 결과물 디렉터리를 이전 네임스페이스에서 새 네임스페이스로 가능한 범위에서 복사합니다. ENOENT 이외 실패는 로그에 기록하고 치명적으로 처리하지 않습니다.
5. `agent.sessionId`를 갱신하고 명시적 캐시 키가 고정되지 않았으면 이전 제공업체 프롬프트 캐시 키를 상속합니다.
6. `session_switch`를 `reason: "fork"`로 내보냅니다.

`SessionManager.fork()` 동작:

- 영구 모드와 할당된 세션 파일 경로가 필요하며 원본이 이미 디스크에 있을 필요는 없습니다.
- 새 세션 ID와 JSONL 경로를 만듭니다.
- 헤더를 새 `id`, 새 타임스탬프, 동일한 `cwd`, 이전 세션 ID인 `parentSession`, 이전 헤더의 상속 키(고정 키가 없으면 이전 세션 ID)인 `providerPromptCacheKey`로 재작성합니다.
- 새 파일에서 헤더 이외의 모든 항목을 그대로 유지합니다.

### 비영구 동작

- 메모리 세션 관리자의 `fork()`는 `undefined`를 반환합니다.
- `AgentSession.fork()`는 `false`를 반환합니다.
- UI는 저장되지 않았거나 취소되어 포크에 실패했다고 알립니다(`Fork failed (session not persisted or cancelled)`).

### 특정 항목에서 포크(`AgentSession.fork(entryId)`, RPC `fork`)

`AgentSession.fork(entryId)`는 전체 세션 대신 대화 기록의 특정 지점에서 포크합니다. RPC `fork`는 `entryId`가 있으면 이를 호출하고 없으면 일반 `fork()`를 호출합니다.

- 전체 포크처럼 Vibe 모드에서는 거부합니다.
- `entryId`는 `message` 항목(사용자, 어시스턴트 또는 다른 메시지 역할)이어야 하며 아니면 `Invalid entry ID for forking` 오류가 납니다.
- `AgentSession.isBusyForSnapshot`이 참이면(응답 스트리밍, 사용자 bash/eval, 압축, 인계, 재시도 진행 중) `SessionBusyError`가 납니다. `session_before_branch` 전후와 대기 중 bash 출력/세션 쓰기 비우기 후에 검사합니다. 마지막 검사는 이전 세션의 다음 턴 메시지, 비동기 작업, 자동 학습 캡처를 버리기 전이므로 거부된 포크는 세션을 유지합니다. 나머지 비우기 대기 중 들어온 프롬프트는 `branch()`처럼 절단 시 프롬프트 세대 증가로 버립니다. `/btw` 분기도 같은 조건을 사용합니다.
- `entryId`가 어시스턴트 도구 호출 배치(어시스턴트 메시지 또는 대응 결과) 안에 있으면 트리를 따라가며 결과 사이 단독 비메시지 항목을 넘어 기록된 도구 결과까지 절단 지점을 확장합니다. 원본에 결과가 있는 호출에서 끝나지 않으며 결과가 없던 호출은 그대로 둡니다.
- 전환은 항목 직전이 아니라 결정된 항목을 포함해 자르는 `AgentSession.branch()` 흐름입니다. 취소 가능한 `session_before_branch`(`reason: "fork"`; `entryId`는 버릴 항목이 아닌 마지막 유지 항목), `SessionManager.createBranchedSession(leafId, { copyArtifacts: true })`, 에이전트 메시지 재구성, `session_branch`(`reason: "fork"`) 순입니다.
- 새 파일은 결정된 항목을 포함한 루트부터의 경로, 유지 항목의 레이블, 제목을 유지하고 `parentSession`을 이전 파일로 설정합니다. 삭제한 항목만 참조하는 결과물도 포함한 전체 디렉터리를 백그라운드 복사합니다. 새 결과물 관리자는 ID 할당/`artifact://` 해석 전에 기다리므로 기존 참조는 유지되고 새 결과물은 새 ID를 받습니다. 전체 포크와 달리 `branch()`처럼 프롬프트 캐시 키를 상속하지 않습니다.
- 전체 포크와 달리 비영구 모드에서도 메모리 교체로 동작합니다.
- `AgentSession.fork(undefined, { requireIdle: true })`는 전체 포크에도 같은 유휴 조건을 `session_before_switch` 전과 비우기 후 적용합니다. RPC는 두 변형 모두 이 옵션을 전달하므로 `code: "session_busy"`로 거부합니다. 대화형 `/fork`는 전달하지 않아 실행 중 bash를 새 세션으로 가져갈 수 있습니다.

### CLI `--fork <id|path>`

시작 시 `--fork`는 일반 세션 생성 전에 결정합니다.

1. `--no-session`과 함께 쓰면 거부합니다.
2. 경로 형태(`/`, `\`, `.jsonl`)는 지정 경로에서 직접 포크합니다.
3. 다른 값은 `resolveResumableSession(...)`으로 로컬부터 찾고 `sessionDir`를 강제하지 않았으면 전역 검색합니다. 소문자로 바꾼 세션 ID 접두사, 전체 JSONL 이름 접두사, 타임스탬프를 뺀 ID 접미사를 허용합니다.
4. 현재 cwd/세션 디렉터리 범위에 파일을 만들고 시작용 활성 관리자로 사용합니다. 원본 결과물은 기본 재귀 복사합니다. 원본이 없으면 빈 포크 대신 실패합니다. 복사된 활성 분기의 미해결 도구 호출에는 실행 안 됨이 아닌 결과 알 수 없음 결과를 연결합니다. 길이 제한 종료에서는 실행 시작 마커가 없을 때만 미실행 보호를 유지합니다. 마지막 메시지 이후 프로세스 종료가 기록된 원본은 여기서 복구하지 않고 자식이 미완료 호출을 경고한 뒤 일반 프로세스 종료 복구로 연결합니다. 부모 대화 기록은 바뀌지 않습니다.
5. 전체 컨텍스트 포크는 원본 헤더의 상속 키 또는 원본 세션 ID에서 `providerPromptCacheKey`를 자동 설정합니다. 명시적 `--model`, `--thinking`, `--system-prompt`, `--system-prompt-template`, `--append-system-prompt`, `--tools`, `--no-tools` 또는 적용 가능한 범위 모델 재정의가 있으면 자동 상속을 제거합니다.

`--prompt-cache-key <key>`는 OMP 세션 ID 및 `--provider-session-id`와 독립적으로 제공업체 프롬프트 캐시 식별자를 고정합니다. `--provider-session-id`는 제공업체 세션/라우팅 헤더와 고정 자격 증명 선택을 계속 제어하며 `--prompt-cache-key`는 지원되는 OpenAI Responses `prompt_cache_key` 페이로드를 제어합니다.

## Seance

`/seance [id|path] [--model selector]`는 원본이 없으면 선택기를 열고 ID나 경로(`~` 확장)가 있으면 직접 선택합니다. 입력 ID는 현재 프로젝트 이후 모든 프로젝트를 검색합니다. 원본은 작성기를 열지 않고 읽으며 절대 수정하지 않습니다.

각 자문은 원본 대화 기록만 `<current session artifacts>/<ConsultId>.jsonl`로 포크하며 헤더에 `seanceSource`를 둡니다. 결과물은 복사하지 않습니다. 자문 에이전트의 `history://`, `artifact://`, `agent://`는 원본 결과물을 제자리에서 읽고 새 결과물 ID는 원본보다 뒤에서 할당하여 상속한 `artifact://<n>`이 원본을 계속 가리킵니다. 현재 세션에 반복 자문해도 트리 사본이 아닌 자문별 대화 파일 하나만 추가합니다.

복원 가능하면 원본 활성 분기의 모델을 사용하고 `--model selector`로 재정의합니다. 저장된 모델이 없으면 모델 선택기를 바로 엽니다.

자문은 추가 작업 공간 루트, 작업 공간 트리, 컨텍스트 파일, 스킬, 규칙, 상속 에이전트, 확장 기능, MCP, IRC, LSP를 제외합니다. 원본 `session_init` 계약은 비활성 `source_session_init` 항목이 됩니다. 도구는 활성화된 `read`, `grep`, `glob`으로 제한하며 `task.structured`는 `yield`를 추가합니다. 비활성 복원에는 `seanceSource` 헤더가 필요하며 같은 읽기 전용 도구로 저장 프롬프트를 복원합니다.

상속 원본 비용은 0으로 만들고 새 자문 턴은 기존 task/에이전트 허브 사용량 추적을 사용합니다.

담당 구현: [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts)(명령/선택기), [`src/task/seance.ts`](../packages/coding-agent/src/task/seance.ts)(원본/모델 결정과 복원 계약), [`src/task/seance-policy.ts`](../packages/coding-agent/src/task/seance-policy.ts)(격리 옵션), `SessionManager.forkFrom(..., { seance: true })`(포크).

## 재개와 이어가기

## 대화형 `/resume [value]`

인수가 없으면:

1. `SessionManager.listForPicker(currentCwd, currentSessionDir)`의 세션 선택기를 엽니다. 고정 항목이 먼저 오고 제목/프롬프트 없는 0턴 초기는 고정하지 않았으면 숨깁니다. 항상 현재 폴더 범위로 열며 빈 상태에서는 자동 전환 대신 Tab으로 모든 프로젝트에 가도록 안내합니다.
2. Tab은 모든 프로젝트 범위로 전환하고 `SessionManager.listAllForPicker()`를 지연 로드/캐시합니다.
3. 선택하면 `SelectorController.handleResumeSession(sessionPath)`가 `session.switchSession(sessionPath)`를 호출합니다. 거부되면 `false`를 반환하고 선택기는 새 세션 UI를 적용하지 않고 멈춥니다.
4. 성공하면 채팅/할 일을 지우고 재구성한 뒤 세션 재개를 알립니다(`Resumed session`, 다른 프로젝트이면 `Resumed session in <dir>`). 다른 프로젝트에서는 `applyCwdChange`로 프로세스 cwd와 관련 캐시를 바꿉니다.

인수가 있으면:

- `/resume <id>`는 ID/파일 이름 접두사를 로컬 우선, 전역 대체 검색으로 결정하고 직접 전환합니다. 모르면 `Session "<value>" not found` 오류를 알립니다.
- `/resume @claude`, `/resume @codex`는 외부 세션 선택기를 엽니다. 선택하면 새 OMP 식별자로 변환/저장한 뒤 전환합니다.

## CLI `--resume`

### `--resume`(값 없음)

- `main.ts`는 현재 cwd/sessionDir의 `SessionManager.listForPicker()`로 현재 폴더 선택기를 엽니다. 비었으면 Tab 전환이 즉시 가능하도록 `SessionManager.listAllForPicker()`를 미리 읽지만 자동 범위 전환은 하지 않습니다. 전역 목록도 비었을 때만 세션이 없다고 출력합니다(`No sessions found`).
- 세션 생성 전에 `SessionManager.open(selectedPath)`로 선택 파일을 열고 `switchToResumedProject`로 프로세스/프로젝트를 재개 세션 cwd로 전환하며 cwd 설정/플러그인 캐시를 다시 읽고 범위 모델을 다시 결정합니다.

### `--resume <value>`

`createSessionManager()` 결정 순서:

1. 경로처럼 보이면(`/`, `\`, `.jsonl`) 직접 엽니다. 없으면 생성하지 않고 `Session "<path>" not found.` 오류로 실패합니다.
2. 그 외에는 `resolveResumableSession(...)`이 현재 범위(`SessionManager.list(cwd, sessionDir)`)부터 검색하고, 명시적 `sessionDir`가 없을 때만 전역(`SessionManager.listAll()`) 검색합니다.
3. 대소문자를 구분하지 않는 세션 ID 접두사, 전체 JSONL 파일 이름 접두사, `<timestamp>_<sessionId>.jsonl`의 타임스탬프 뒤 ID 접미사를 허용합니다.

ID/파일 이름 접두사 일치 동작(로컬/전역):

- 기록 디렉터리가 없어졌으면 현재 디렉터리로 이동/루트 재지정할지 묻습니다(`Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`).
  - 기본값인 예를 선택하면 `initialCwd`로 사라진 원본 cwd에 `SessionManager.open()`을 고정한 뒤 `manager.moveTo(cwd, sessionDir)`로 복제 없이 루트를 다시 지정합니다.
  - 아니요면 시작을 취소합니다. 비 TTY에서는 대화형 실행을 안내하는 오류로 실패합니다.
- 디렉터리가 있으면 직접 엽니다. 이후 프로세스/프로젝트를 재개 cwd로 전환하고 cwd 설정/플러그인 캐시를 다시 읽습니다. 암묵적으로 포크하지 않습니다.

경로 값은 누락 디렉터리 이동 질문 없이 직접 엽니다. 기록 cwd가 없거나 권한으로 막혔으면 대화 파일을 옮기지 않고 시작 cwd를 유지합니다. cwd 전환/범위 재설정 실패도 대체 경고를 출력합니다. 선택기에도 같은 진입 가능 정책을 적용합니다. 직접 경로가 없으면 `Session "<path>" not found.`로 실패하고, 기존 빈 파일이나 잘못된 비어 있지 않은 헤더도 파일 수정 없이 안전하게 실패합니다.

## CLI `--restore`

`--restore [value]`는 `--resume [value]`와 동일하게 선택/열기한 뒤 대화형 TUI가 준비되면 마지막 프로세스가 죽을 때 끝내지 못한 일을 이어갑니다(`task/restore.ts`, `restoreSession`). Tern 세션 데몬은 충돌 후 이 플래그로 omp 창을 재실행합니다. omp는 세션 파일 정보와 함께 OSC 1337 사용자 변수 `omp_restore=1`을 보고하여 플래그 지원을 알립니다.

1. **하위 에이전트부터 복원합니다.** 세션 아래의 저장된 모든 하위 대화 파일(`<session>/<AgentId>.jsonl`, 중첩 포함) 중 턴 도중 끝났고, 삭제 표시가 없으며, 비활성 복원이 가능한(`session_init` 계약이 있고 격리되지 않은) 에이전트는 자신의 ID로 부모의 백그라운드 작업에서 모니터링되는 턴 하나를 더 실행합니다. 수명 주기 복원기가 대화에서 재구성하고 아래 방식으로 이어가며 결과는 일반 `async-result`로 부모에 전달되므로 기다리던 작업을 다시 찾을 수 있습니다.
2. **그다음 세션 자체 턴을 복원합니다**(`AgentSession.restoreInterruptedTurn`). `session_exit` 없이 끊긴 턴(충돌, SIGKILL, 전원 손실은 기록하지 않음)은 기록된 종료 복구와 같은 방식으로 먼저 닫습니다. 미완료 도구 호출에 결과 알 수 없음 결과를 붙이고 중단 턴 종료를 기록합니다. 이후 `/retry`처럼 재시도합니다. 모든 호출이 끊긴 배치는 다시 실행하고, 그 외에는 모델이 대화 기록의 끝에서 응답합니다.

마지막 턴이 완료/실패했거나 사용자가 중단했거나 이후 정상 종료가 기록되었으면(중단 상태에서 사용자가 종료) 이어가지 않습니다. `--restore`는 대화형 전용이고 프롬프트를 받지 않으며 `--continue`, `--fork`, 가져오기, `--goal`, `--no-session`과 함께 쓸 수 없습니다. `/restart`는 다른 일회성 선택자처럼 이를 제거합니다.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. 현재 cwd의 세션 디렉터리를 결정합니다.
2. 터미널별 기록을 읽습니다. 새 지연 JSONL이 아직 없다는 기록이면 이전 대화를 열지 않고 새로 시작합니다. 명시적 `newSession()` 경계는 이미 영속 헤더가 있습니다.
3. 중첩 결과물/하위 세션을 가리키면 최대 8단계 올라가 최상위 대화형 부모를 찾습니다.
4. 명시적 세션 디렉터리가 있으면 그 안에 있는 일치 cwd 기록을 사용합니다. 그 외에는 제목/프롬프트 없는 0턴 초기 항목을 건너뛰고 재개 가능한 최신 세션을 선택합니다.
5. 기록 cwd가 다르고 없어졌을 때 자동 루트 재지정은 현재 디렉터리 장치/inode가 기록의 식별자와 같고 우선할 실제 현재 프로젝트 세션이 없어야 합니다. 삭제/마운트 해제 경로, 식별자 없는 이전 기록, 파일시스템 간 이동만으로는 기록 이동 근거가 충분하지 않습니다.
6. 선택 세션을 열거나 후보가 없으면 새로 만듭니다.

호환을 위해 `--continue <full-UUID>`에서 UUID가 유일한 위치 메시지이면 `--resume <UUID>`로 정규화합니다. 명시적 세션 플래그/디렉터리가 없으면 `autoResume`도 같은 `continueRecent` 동작을 사용하고 이전 대화가 있으면 모델/추론 상태를 복원합니다.

시작 시에만 적용하며 대화형 `/continue` 명령은 없습니다.

## 재시작

대화형 `/restart`는 일반 정리, 사후 정리 및 stdout 비우기 후 CLI를 재실행합니다. `restartArgv()`는 시작 설정 플래그를 유지하지만 원래 프롬프트/`@file` 위치 인수와 일회성 세션 선택자(`--session`, `--resume`, `--continue`, `--fork`, 외부 가져오기)는 제거합니다. 실제 디스크에 세션이 있을 때만 `--resume <current-id>`를 추가하고 메모리 전용/미생성 세션은 새로 시작합니다.

POSIX는 가능하면 프로세스 이미지를 대체합니다. Windows 또는 exec 실패 시 터미널 스트림을 상속한 대체 프로세스를 생성합니다.

## 세션 전환의 실제 런타임 상태 변경

`AgentSession.switchSession(sessionPath)`는 재개 계열 작업의 런타임 전환을 수행합니다.

1. 취소 가능한 `session_before_switch`를 `reason: "resume"`, `targetSessionFile`과 함께 내보냅니다.
2. 에이전트 이벤트 구독을 끊고 진행 중 작업을 중단하며 선택적 전환 전 조정기를 실행합니다.
3. 대기 bash/세션 쓰기를 비우고 관리자 상태, 메시지/모든 큐, 모델/추론/서비스 등급, 도구/프롬프트, 제공업체/캐시 ID, 메모리 승격, 체크포인트 되감기 상태를 롤백용으로 캡처합니다.
4. 에이전트와 다음 턴 큐를 지웁니다. 다른 파일이면 자문 기록기를 비우고 분리합니다.
5. `sessionManager.setSessionFile(sessionPath)`를 호출하고 제공업체 캐시/세션 ID와 메모리 키를 갱신하며 표시 컨텍스트 구성, 기록 모델 결정, 체크포인트 복원을 수행합니다. 다른 파일에서 기록 모델을 복원할 수 없으면 `Could not restore model <provider/id>`로 실패합니다(아래 참조).
6. `session_switch`를 `reason: "resume"`로 내보냅니다.
7. 메시지 대체, 자문 상태 초기화, 할 일 동기화를 수행합니다. 다른 파일이거나 같은 파일 재로드에서 재생 메시지가 달라졌으면 캐시 제공업체 세션을 닫습니다.
8. 결정한 모델 또는 명시적으로 요청한 모델을 적용합니다. 분기가 중단 턴으로 끝났으면 합성 중단 메시지를 추가하고 컨텍스트를 재구성합니다.
9. 설정/유효 추론과 계열별 서비스 등급을 복원하며 대상 분기에 항목이 없으면 현재 설정을 사용합니다.
10. 다른 대화 파일이면 메모리 컨텍스트를 초기화하고, 모든 대화 재작성에서 세션 범위 도구 상태를 지웁니다.
11. 이벤트를 다시 연결하고 선택적 세션 전환 조정기(대화형에서는 plan 같은 저장 모드 재진입)를 실행하며 작업 공간 루트 시스템 프롬프트 블록을 가능한 범위에서 새로 고칩니다. 조정/프롬프트 갱신 오류는 확정 전환을 롤백하지 않고 로그에 기록합니다.
12. 대상 자문 비용 복원, bash 전환 마무리, ID 변경 시 콜백 알림을 수행하고 `true`를 반환합니다.

전환 전 훅 취소나 cwd 정책 거부 시 `false`를 반환합니다. cwd 변경 콜백 없는 프로젝트 간 전환은 대상 cwd를 조용히 채택하지 않고 거부하며 콜백 거부도 취소입니다. 대화형 선택기는 결과를 확인하고 기존 세션/UI를 유지합니다.

보호된 전환 단계에서 예외가 나면 캡처한 세션, 큐/메시지, 도구/프롬프트, 모델/추론/등급, 제공업체/캐시, 메모리, 체크포인트 상태를 복원하고 이전 구독을 다시 연결한 뒤 모드 조정을 다시 실행하고 예외를 다시 던집니다.

일반 재개 전환은 기존 대화를 엽니다. `setSessionFile()`에 위임하므로 없거나 빈 명시적 대상은 그 경로에 새 세션을 기록할 수도 있지만 잘못된 비어 있지 않은 헤더는 거부합니다.

모델 복원은 시작 재개처럼 안전하게 실패하며 기록하지 않은 모델로 조용히 옮기지 않습니다. `hasUI`와 `allowSessionModelFallback`이 있는 세션(TUI)에서 `retry.modelFallback`이 켜졌을 때만 현재 모델을 유지하고 `Could not restore model <provider/id>. Using <provider/id>` 경고를 냅니다. 명시적 `model` 옵션(RPC `open_session`/`switch_session`의 `provider`/`modelId`)은 기록 모델을 대체하며 같은 파일 재로드는 현재 모델을 유지합니다.

## 이벤트와 취소 지점

### 전환/포크 수명 주기 훅

`newSession`, `fork`, `switchSession`의 경우:

- 이전 이벤트: `session_before_switch`
  - 사유: `new`, `fork`, `resume`
  - `{ cancel: true }` 반환으로 취소 가능
- 이후 이벤트: `session_switch`
  - 같은 사유 집합
  - `previousSessionFile` 포함

`ExtensionRunner.emit()`는 첫 취소 이전 이벤트 결과에서 조기 반환합니다. 전환 전 훅이 취소하면 `switchSession()`은 `false`를 반환하고 전환 후 이벤트를 내지 않습니다.

### 사용자 지정 도구 `onSession` 동작

SDK는 확장 기능 세션 이벤트를 사용자 지정 도구 `onSession` 콜백에 연결합니다.

- `session_switch` → `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` → `reason: "branch"`
- `session_start` → `reason: "start"`
- `session_tree` → `reason: "tree"`
- `session_shutdown` → `reason: "shutdown"`

관찰용 콜백이며 전환/포크를 취소하지 않습니다.

### 그 밖의 관련 취소 지점

- 스트리밍 중 `/fork`는 차단합니다. 현재 응답을 기다리거나 중단해야 합니다.
- 선택기를 닫아 `/resume`을 취소할 수 있습니다.
- 누락 디렉터리 이동/루트 재지정 질문을 거절하여 프로젝트 간 `--resume <id>`를 취소할 수 있습니다.
- `/share`는 UI 취소 경로(`Share cancelled`)가 있지만 업로드 자체는 도중 중단하지 않습니다.

## 비영구(메모리 전용) 세션 동작

`SessionManager.inMemory()`(`--no-session`)로 만들면:

- 세션 파일 경로가 없습니다.
- `/export`는 `Cannot export in-memory session to HTML`로 실패하여 명령 오류 UI에 전달합니다. `/share`는 실시간 항목 스냅샷이므로 동작합니다.
- `/fork`는 영구 저장이 필요해 실패합니다.
- `/dump`는 메모리 상태를 직렬화하므로 동작합니다.
- 네이티브 CLI `--resume`, `--continue`, `--fork`와 `--no-session`의 조합은 거부합니다. 예비 파싱이 메모리 관리자를 할당할 수 있지만 일반 실행 전에 검증에서 거부합니다.

## 현재 구현의 주의 사항

- `/share` 사용자 지정 처리기 실패는 기본 암호화 공유로 대체하지 않고 TUI 명령을 오류로 끝냅니다.
- `/export` 인수 분리는 따옴표로 묶은 공백 경로를 유지하지 않습니다.
- `/delete`는 가능한 범위에서만 삭제합니다. 현재 JSONL과 결과물 디렉터리 삭제를 시도하고 실패는 로그에 기록하며 그래도 새 세션을 만들고 전환합니다. 실패하거나 일부만 삭제되면 이전 세션/결과물이 남을 수 있으므로 완전 삭제를 보장하는 경계가 아닙니다.
