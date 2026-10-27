# write

> 파일, 쓰기 가능한 내부 리소스, 아카이브 항목, SQLite 행을 만들거나 덮어쓰고 병합 충돌을 해결합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/write.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/write.md`
- 주요 협력 모듈:
  - `packages/utils/src/ar` (`@oh-my-pi/pi-utils/ar`) — 아카이브 선택자 구문 분석, 항목 로딩, 직렬화. write 도구는 임시 파일과 이름 변경을 통한 원자적 쓰기 경계를 제공합니다.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — SQLite 경로를 감지하고 행을 삽입/수정/삭제합니다.
  - `packages/coding-agent/src/tools/conflict-detect.ts` / `conflict-uri.ts` — 충돌 영역 등록/검증, 측면 토큰 확장, 내부 URL 핸들러를 통한 충돌 해결 쓰기를 담당합니다.
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — 쓰기 가능한 내부 리소스와 `xd://` 도구 장치 디스패치.
  - `packages/coding-agent/src/lsp/writethrough.ts` — 쓰기 시 서식 지정과 진단 전달.
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — 생성된 파일의 덮어쓰기를 차단합니다.
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — 쓰기 후 공유 파일시스템 검색 캐시를 무효화합니다.
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — 경로를 해석하고 계획 모드 쓰기 정책을 적용합니다.

## 입력
| 필드 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `path` | `string` | 예 | 대상 경로. 일반 경로는 파일에 씁니다. 쓰기 가능한 내부 URL은 해당 핸들러에 위임합니다. `xd://<device>`는 `content`의 JSON으로 마운트된 도구를 호출합니다. `archive.ext:inner/path`는 `.zip`과 ZIP 형식 별칭(`.jar`, `.war`, `.ear`, `.apk`, …), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, `.asar`의 아카이브 항목에 씁니다. `db.sqlite:table`은 행을 삽입하고 `db.sqlite:table:key`는 수정/삭제합니다. `conflict://<id>`는 등록된 충돌을 해결하며 `conflict://*`는 일괄 해결합니다. 복사한 `[path#TAG]` 래퍼도 허용하며 제거됩니다. |
| `content` | `string` | `proc://<id>/kill` 제외 | 파일/아카이브/내부 리소스의 전체 교체 내용, 충돌 교체 내용 또는 SQLite 행 페이로드. `/kill`에서는 무시됩니다. SQLite 삭제 이외의 쓰기는 JSON5 객체로 파싱되어야 합니다. 비어 있거나 공백만 있는 내용은 키로 지정한 행을 삭제합니다. `xd://`에서는 마운트된 도구의 JSON 인수 객체입니다. |

사용 예:

```text
path: "src/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## 출력
단일 결과를 반환합니다.

- 성공하면 적어도 하나의 텍스트 블록을 반환합니다. 단, `xd://` 디스패치는 마운트된 도구 자체의 내용/오류 결과를 유지합니다.
  - 일반 파일 쓰기: `Successfully wrote <bytes> bytes to <relative-path>` (최종 서식 적용 내용의 UTF-8 바이트 길이. ACP 브리지 영수증은 제출한 내용을 계산합니다).
  - 내부 URL 쓰기: 핸들러가 제공하는 영수증/상태 텍스트가 있으면 사용하고, 없으면 `Successfully wrote <bytes> bytes to <url>`. 파일 기반 URL 쓰기(`local://`, `vault://`)도 실제 저장 경로가 아닌 URL을 표시합니다.
  - 아카이브 쓰기: `Successfully wrote <bytes> bytes to <relative-archive-path>:<entry-path>` (항목 내용의 UTF-8 크기).
  - SQLite 쓰기: `Inserted row into <table>`, `Updated row '<key>' in <table>`, `No row updated ...`, `Deleted row ...`, `No row deleted ...` 중 하나.
  - 충돌 해결: 해당하는 경우 새 hashline 스냅샷 헤더를 포함하는 충돌별 성공 텍스트. 일부 파일은 성공하고 다른 파일은 실패한 일괄 해결은 `isError: true`를 반환할 수 있습니다.
- 실행 중 `onUpdate`는 UTF-8 바이트 길이를 사용하여 `Writing <bytes> bytes to <path>...`를 내보낼 수 있습니다. `xd://`는 마운트된 도구의 업데이트를 전달합니다.
- `read` 출력에서 복사한 hashline 접두사를 먼저 제거했다면 첫 텍스트 블록에 추가 안내가 붙습니다.
- hashline 표시 모드에서 일반 파일 쓰기(ACP 브리지 쓰기 포함)와 충돌 해결은 새 `[<relative-path>#TAG]` 헤더를 앞에 붙입니다(파일 기반 URL 쓰기는 `[<url>#TAG]`). 스냅샷에는 읽은 행 이력이 없습니다. 앵커 기반 편집은 여전히 앵커 행을 읽어야 합니다. 일괄 충돌 해결은 성공적으로 쓴 파일마다 헤더 하나를 나열하는 `Snapshots:` 블록을 덧붙입니다.
- 일반 파일 쓰기는 LSP 쓰기 시 진단이 활성화되어 있으면 `details.diagnostics`와 `details.meta.diagnostics`를, shebang 파일에 실행 비트가 추가되면 `details.madeExecutable`도 반환할 수 있습니다.
- 일반/아카이브/단일 충돌 결과는 파일 기반이면 `details.resolvedPath`를 설정합니다. SQLite 쓰기는 `sourcePath(...)`를 통해 `details.meta.source`도 설정합니다. 핸들러가 소유한 URL 쓰기는 핸들러 세부 정보(예: `details.proc`)를 유지합니다. 일반 핸들러 영수증의 세부 정보는 비어 있으며 장치 디스패치는 `details.xdev`를 설정합니다.

## 처리 흐름
1. `WriteTool.execute()`는 복사한 `[path#TAG]` 인수의 래퍼를 제거하고 내부 URL의 유효한 읽기 선택자를 벗겨 쓰기와 읽기가 같은 리소스를 가리키도록 합니다. 쓰기 가능한 URL의 잘못된 선택자/범위 선택자는 거부됩니다.
2. 대상 쓰기 정책에서 선택 사항으로 정한 경우(`proc://<id>/kill`)를 제외하면 `content`가 필요합니다. 장치 전용 세션은 장치/협업 쓰기와, 계획 모드가 활성화된 경우 로컬 샌드박스 초안을 허용합니다. 다른 대상은 변경 전에 실패합니다. 텍스트 페이로드의 hashline 표시 접두사는 제거하지만 메시지, 프로세스 입력, 설정, 충돌 지시문은 핸들러에 그대로 전달합니다.
3. URI 형태의 대상을 검증합니다. 알 수 없는 스킴과 흔한 `xd://` 오타는 로컬 파일명이 되지 않고 실패합니다. URI처럼 보이는 POSIX 파일명을 의도적으로 만들려면 `./`를 앞에 붙이세요.
4. `path`가 `write`를 제공하는 핸들러의 내부 URL이면 위임합니다. `xd://`는 JSON을 검증하고 마운트된 도구에 전달하면서 결과와 승인 등급을 유지합니다. `local://`는 세션 로컬 파일시스템 경로로 이어집니다.
5. `conflict://...`도 핸들러 소유 쓰기의 하나이며 `ConflictProtocolHandler`와 `tools/conflict-uri.ts`가 구현합니다. `conflict://<id>/ours` 같은 범위 읽기는 읽기 전용입니다. 쓰기 가능한 충돌 URI에는 범위가 없습니다. 교체 전에 등록된 마커를 다시 검증합니다.
6. `#resolveArchiveWritePath()`를 호출합니다. 후보 아카이브 파일은 가장 긴 경로부터 확인하며, 존재하는 것이 없으면 가장 짧은 후보 아카이브 경로로 새 컨테이너를 만듭니다.
7. 아카이브 쓰기는 `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })` 후 `#writeArchiveEntry()`를 호출합니다.
   - 상위 디렉터리를 재귀적으로 만듭니다.
   - `readArchiveEntries()`로 기존 항목을 읽고 항목 맵에서 대상을 교체한 뒤 `writeArchive()`로 전체 교체본을 직렬화합니다.
   - 존재하지 않는 선택자 형태 항목에 빈 내용을 쓰는 것은 거부합니다. 기존 텍스트 항목을 불완전한 읽기 투영으로 교체하는 것도 거부합니다.
   - 같은 디렉터리의 임시 경로에 교체본을 쓴 다음 대상 이름으로 변경합니다. 기존 아카이브 심볼릭 링크는 먼저 해석하여 링크 대신 대상이 갱신되도록 합니다.
   - ZIP 형식 별칭은 ZIP으로 유지됩니다. `.tar.gz`/`.tgz`는 gzip, `.tar.zst`/`.tzst`는 zstd를 선택하며 `.asar` 컨테이너도 같은 경계에서 다시 씁니다. 읽기 전용 형식(`.7z`, `.rar`, …)은 거부합니다.
   - 아카이브 파일 경로에 `invalidateFsScanAfterWrite()`를 실행합니다.
8. 아카이브가 아니면 SQLite 후보를 확인합니다. 기존 파일이 SQLite가 아니면 SQLite로 해석하지 않습니다. 일반 파일이나 디렉터리가 아닌 후보(FIFO, 장치, 소켓)는 SQLite 헤더를 읽기 전에 거부합니다.
9. SQLite 쓰기는 `enforcePlanModeWrite(..., { op: "update" })` 후 `#writeSqliteRow()`를 호출합니다.
   - 데이터베이스가 이미 존재해야 합니다.
   - Bun SQLite를 `{ create: false, strict: true }`와 `PRAGMA busy_timeout = 3000`으로 엽니다.
   - 행 키가 있고 `content`가 공백뿐이면 행을 삭제합니다.
   - 비어 있지 않은 `content`는 `Bun.JSON5.parse()`로 파싱하며 객체여야 합니다. 삽입/수정 헬퍼로 전달합니다.
   - 검색 캐시를 무효화하고 `finally`에서 연결을 닫습니다.
10. 그 외에는 `path`를 일반 파일시스템 파일로 처리합니다.
   - 읽기 요청이 잘못 전달되었다고 확실히 판단되는 대상은 거부합니다. 즉 내용이 비어 있는 존재하지 않는 선택자 형태 파일명이나, 세미콜론으로 연결된 존재하지 않는 선택자 경로 목록입니다. 기존 리터럴 경로를 우선하며, 선택자 형태의 단일 파일명을 의도했다면 비어 있지 않은 내용을 사용할 수 있습니다.
   - 변경 전에 계획 모드 정책과 경로 해석을 적용합니다. 심볼릭 링크를 통한 경우를 포함하여 기존 대상이 일반 파일이나 디렉터리가 아니면 거부합니다. 기존 일반 파일은 생성 파일 보호 검사를 거칩니다. 이 검사는 주 스레드에서 파일 앞부분을 열어 읽으므로 그러한 대상에서는 무한히 차단될 수 있습니다.
   - 제출 내용이 OMP 읽기 잘림 안내로 끝나고 현재 소스보다 적은 범위만 포함하면 덮어쓰기를 거부합니다. 텍스트 핸들러 소유 리소스에도 적용되지만 도구 장치 인수는 예외입니다.
   - 사용 가능하면 먼저 ACP 브리지 `writeTextFile`을 시도하고, 아니면 세션 writethrough로 내용을 씁니다. LSP 설정에 따라 서식 지정, 동기화, 진단이 이루어질 수 있습니다.
   - 선두 shebang은 실행 비트를 추가할 수 있습니다. 파일시스템 검색 캐시를 무효화합니다.
11. 텍스트와 선택적 진단, 실행 가능 여부, 해석된 경로 또는 장치 디스패치 메타데이터를 반환합니다.

## 모드 / 변형
### 일반 파일 경로
- 대상이 아카이브 선택자로 해석되지 않고 기존 또는 새 SQLite 선택자로도 해석되지 않는 경로입니다.
- 기존 파일은 덮어씁니다.
- `write.ts`는 이 경로에서 `fs.mkdir()`를 호출하지 않습니다. 명시적인 상위 디렉터리 생성은 아카이브 분기에만 있지만 일반 파일 쓰기의 `Bun.write()` 자체가 누락된 상위 디렉터리를 만듭니다.

예:

```text
path: "tmp/output.txt"
content: "hello\n"
```

### 아카이브 항목 쓰기
- 선택자 구문: `archive.ext:inner/path`.
- 지원 접미사: `.zip` 및 ZIP 형식 별칭(`.jar`, `.war`, `.ear`, `.apk`와 기타 zip 계열 확장자), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, `.asar`.
- 내부 경로는 `/`로 정규화하고 빈 세그먼트와 `.`을 제거합니다. `..`과 `/`로 끝나는 디렉터리 대상은 거부합니다.
- 항목 하나를 교체한 뒤 임시 파일과 이름 변경을 통해 전체 아카이브를 다시 씁니다.
- 필요하면 아카이브 파일의 상위 디렉터리를 만듭니다.

예:

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite 테이블 삽입
- 선택자 구문: `db.sqlite:table`.
- `content`는 JSON5 객체로 파싱되어야 합니다.
- 빈 객체도 허용하며 `INSERT INTO <table> DEFAULT VALUES`가 됩니다.
- SQLite 쓰기에서는 쿼리 매개변수를 거부합니다.

예:

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite 행 수정 / 삭제
- 선택자 구문: `db.sqlite:table:key`.
- 비어 있지 않은 `content`는 행을 수정합니다.
- 비어 있거나 공백뿐인 `content`는 행을 삭제합니다.
- `WITHOUT ROWID` 테이블을 포함하여 단일 열 기본 키가 있으면 행 조회에 사용합니다. 없으면 `rowid`로 대체합니다. 복합 기본 키와 사용할 수 없는 rowid 대체 경로는 거부합니다.

수정 예:

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

삭제 예:

```text
path: "data/app.sqlite:users:42"
content: ""
```

### 쓰기 가능한 내부 리소스와 도구 장치
- `agent://<id>`에 비어 있지 않은 `content`를 쓰면 해당 동료에게 메시지를 보냅니다(전달 영수증 텍스트). `agent://all`은 보이는 실행 중 동료에게 방송합니다. 메시징을 사용할 수 있으면 이 쓰기는 읽기 승인 대상이며 계획 모드와 `deviceOnlyWrite`에서도 허용됩니다. `agent://` 읽기는 여전히 출력 아티팩트입니다.
- `proc://<id>`는 서비스 stdin에 `content`를 보냅니다(이미 줄바꿈으로 끝나지 않으면 Enter 추가). 빈 내용은 Enter를 보내며 취소하지 않습니다. `write({ path: "proc://<id>/kill" })`은 작업이나 소유한 하위 에이전트를 취소하거나 서비스를 중지합니다. `content`는 선택 사항이며 무시합니다. `proc://<id>/mode`의 `content`는 지속성을 바꾸는 `persist` 또는 `session`, 아니면 PTY 없이 재시작하여 브로커 이후에도 유지하는 `detached`여야 합니다. Proc 쓰기는 실행 승인이 필요합니다. stdin과 `/mode` 쓰기는 계획 모드에서 차단하며 `deviceOnlyWrite` 세션에서는 사용할 수 없습니다. `/kill`은 둘 다 허용합니다. Proc 읽기는 작업 전달을 소비하지 않습니다. `/kill`과 `/mode`는 쓰기 전용입니다.
- `write` 훅이 있는 등록된 내부 핸들러는 해당 리소스의 의미를 소유합니다(예: `cfg://`, `agent://`, `proc://`). 파일 기반 스킴(`local://`, `vault://`)에는 훅이 없습니다. 라우터가 대상 파일을 찾고(`local://`는 세션 로컬 아티팩트 샌드박스, `vault://`는 vault 루트 아래) 일반 파일 경로로 쓰기를 진행합니다.
- `xd://`는 `write` 뒤에 마운트된 도구 장치를 나열/호출합니다. 먼저 `xd://<name>`을 읽고 `content`에 JSON 객체 하나를 전달하세요. 장치 스키마, 업데이트, 결과 블록, 오류 플래그, 렌더러 메타데이터, 승인 등급은 유지됩니다. 외부 승인 관문은 일반 `write` 정책보다 먼저 `tools.approval.<device>`를 사용합니다. `xd://report_issue`는 별도로 일반 이슈 설명도 허용합니다.
- 알 수 없는 URI 형태 스킴은 실수로 로컬 파일이 생성되지 않도록 거부합니다. 의도한 파일명일 때만 `./scheme://...`을 사용하세요.
- 등록된 읽기 전용 스킴(쓰기 정책 없음: `artifact://`, `skill://`, `history://`, …)은 승인 관문에서 질문 없이 거부합니다(`<scheme>:// URLs are read-only`). `edit`와 `ast_edit` 대상도 같습니다. 쓰기, 편집 또는 bash URL 대상 끝의 행 선택자(`local://notes.md:5`)는 제거하지 않고 거부합니다. `:raw`/`:conflicts`만 벗깁니다.

### 병합 충돌 해결
- `<file>:conflicts`(또는 마커가 나타나는 읽기 범위)를 읽으면 세션 내에서 안정적인 ID가 등록됩니다. `conflict://<N>`은 기록된 마커 블록만 교체하고 파일과 다시 검증합니다. 복사한 인접 문맥이 블록 밖의 행을 중복시킬 경우 잘라내고 영수증에 안내합니다.
- 행 전체가 `@ours`, `@theirs`, `@base`, `@both`이면 기록된 해당 측 내용으로 확장합니다(`@both`는 ours 다음 theirs). `@base`는 diff3 기준 내용이 필요합니다. 다른 내용은 리터럴입니다.
- `conflict://*`에 일반 내용을 쓰면 모든 등록된 충돌에 같은 교체/토큰 확장을 적용합니다. `1: @ours\n2: @theirs` 같은 ID별 지시문은 나열된 ID만 해결합니다. 비어 있지 않은 모든 지시문 행은 측면 토큰 하나를 사용해야 하며 ID는 중복할 수 없습니다.
- 일괄 처리는 파일별로 전부 적용하거나 전혀 적용하지 않으며 아래에서 위로 처리합니다. 다른 파일은 성공할 수 있습니다. 파일 간 부분 성공은 `isError: true`를 반환하고, 전부 실패하면 예외를 던집니다. 성공한 ID는 무효화하며 실패한 파일의 ID는 재시도를 위해 등록된 채로 둡니다.
- 마커가 남아 있으면 충돌 쓰기는 LSP 서식 지정/진단을 건너뜁니다. 같은 일괄 처리에서 이미 해결한 영역의 오래된 중복 등록은 해결된 것으로 취급합니다. 서로 다른 동일 블록은 계속 개별 지정할 수 있습니다.
- `/ours`, `/theirs`, `/base`, `/both` URI 범위는 읽기 전용입니다.

## 부수 효과
- 파일시스템
  - 일반 파일을 만들거나 덮어씁니다.
  - 항목을 쓸 때 같은 디렉터리의 임시 파일과 이름 변경으로 전체 아카이브를 원자적으로 다시 씁니다.
  - 아카이브 파일의 상위 디렉터리를 명시적으로 만듭니다. 일반 파일 백엔드도 누락된 상위 디렉터리를 지원합니다.
  - 기존 SQLite 데이터베이스를 변경하며 새 SQLite DB는 만들지 않습니다.
  - `conflict://...` 쓰기는 파일의 충돌 마커를 해결합니다.
  - 일반 파일 쓰기가 성공한 뒤 shebang 파일에 chmod로 실행 권한을 부여할 수 있습니다.
- 하위 프로세스 / 네이티브 바인딩
  - `bun:sqlite`의 Bun SQLite 바인딩을 사용합니다.
  - `packages/utils/src/ar`의 통합 아카이브 유틸리티를 사용합니다. 압축 tar에는 tar 직렬화와 gzip/zstd 프레이밍, ZIP에는 `node:zlib` 기반 DEFLATE 프레이밍, ASAR에는 인코더를 사용합니다.
  - `packages/coding-agent/src/lsp/index.ts`를 통해 설정된 LSP 서버와 통신할 수 있습니다.
- 세션 상태
  - `invalidateFsScanAfterWrite()`로 공유 파일시스템 검색 캐시 항목을 무효화합니다.
  - 대상을 변경하기 전에 계획 모드 쓰기 제한을 적용합니다.
  - 일반 파일과 충돌 해결의 파일 변경/스냅샷 상태를 갱신합니다. 해결된 충돌 ID는 무효화합니다.
  - `xd://`는 마운트된 도구를 호출하므로 해당 도구에 문서화된 부수 효과가 발생할 수 있습니다.
- 백그라운드 작업 / 취소
  - `WriteTool`에서 도구를 `concurrency = "exclusive"`로 표시합니다.
  - 쓰기 본문은 `untilAborted`로 감쌉니다. LSP writethrough는 시간 초과 후 지연 진단 조회를 예약할 수 있습니다.

## 제한 및 상한
- 일반/내부 파일 내용에는 메모리 내 처리 외의 도구 수준 바이트 상한이 없습니다. 아카이브 리더 기본값은 메모리 내 입력 `256 MiB`, 항목당 `64 MiB`입니다. ZIP 출력은 항목 수가 많으면 ZIP64 레코드를 내보내지만 항목 크기와 중앙 디렉터리/항목 오프셋은 32비트 센티널 미만으로 유지됩니다.
- 생성 파일 보호는 `crates/pi-natives/src/edit.rs`의 `editAutoGeneratedMessage`에 위임하며 최대 `1024`바이트를 읽습니다. `crates/pi-edit/src/path_policy.rs`는 헤더를 최대 `40`행 확인합니다. `edit.blockAutoGenerated`가 이 보호를 제어합니다.
- SQLite 쓰기는 `PRAGMA busy_timeout = 3000`을 설정합니다.
- LSP writethrough(`packages/coding-agent/src/lsp/writethrough.ts`)의 `runLspWritethrough()` 작업 시간 제한은 `5_000`ms이며 `AbortSignal.timeout(25_000)`으로 지연 진단을 예약할 수 있습니다.
- shebang 실행 권한 처리는 호스트 파일시스템의 chmod 지원 여부에 따라 다릅니다.

## 오류
- 잘못된 아카이브 하위 경로는 다음과 같은 메시지의 `ToolError`를 던집니다.
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite 경로 파싱은 지원하지 않는 형식에서 예외를 던집니다.
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- SQLite DB가 없으면 `SQLite database '<path>' not found`로 나타납니다.
- SQLite 내용 오류에는 잘못된 JSON5, 객체가 아닌 페이로드, 알 수 없는 열, 스칼라가 아닌 값, 빈 수정 객체, 복합 기본 키, 사용할 수 없는 rowid 대체 경로가 포함됩니다. 읽기 방식의 `?where=` 선택자는 쓰기의 우회 수단이 아닙니다.
- 기존 일반 파일이 생성된 파일로 보이면 `assertEditableFile()`이 거부할 수 있습니다.
- 일반 파일 대상과 SQLite 데이터베이스 후보가 일반 파일이나 디렉터리가 아니면 `Cannot write '<path>': it is a <kind>, not a regular file or directory.`로 거부합니다. 이를 프로세스 안에서 열거나 읽으면 무한히 차단될 수 있습니다(작성자 없는 FIFO, 터미널).
- 파일 기반 URL 쓰기의 대상이 기존 디렉터리면 `<scheme>:// URL must resolve to a file: <url>`로 실패합니다.
- URI 형태의 알 수 없는 대상과 잘못되었거나 없는 `xd://` 장치는 로컬 파일을 쓰지 않고 실패합니다. 마운트된 장치는 자체 스키마/도구 오류를 표시합니다.
- 존재하지 않는 선택자 형태 대상에 대한 빈 쓰기와 세미콜론으로 연결된 선택자 목록은 읽기/쓰기 전달 오류로 추정하여 거부합니다.
- 읽지 않은 소스를 버리게 되는 불완전한 읽기 투영은 거부합니다. 누락된 범위를 다시 읽고 전체 파일을 교체하거나 부분 변경에 `edit`를 사용하세요.
- 충돌 범위 쓰기는 읽기 전용입니다. 잘못되었거나 오래된 ID, 잘못된 일괄 지시문, 누락된 `@base`, 오래된 마커 위치는 `ToolError`를 발생시킵니다.
- 아카이브 읽기/쓰기 실패와 예상치 못한 SQLite 예외는 `ToolError(error.message)`로 감쌉니다.
- 일치하는 LSP 서버가 없거나 LSP 서식 지정/진단 시간이 초과되어도 파일 쓰기는 완료됩니다. 진단은 생략될 수 있습니다.

## 참고
- 아카이브 경로 감지는 SQLite 감지보다 먼저 실행됩니다. 아카이브 선택자와 일치하는 경로는 절대 SQLite로 처리하지 않습니다.
- 기존 `.sqlite` / `.db` 파일에 SQLite 매직 바이트가 없으면 SQLite 감지를 포기하고 일반 파일 쓰기로 처리합니다.
- 아카이브 재작성은 통합 `readArchiveEntries()` / `writeArchive()` 경계와 임시 파일 이름 변경을 사용합니다. 문자열 항목은 UTF-8로 인코딩합니다.
- 기존 아카이브 심볼릭 링크는 해석된 대상의 접미사로 형식을 추론합니다. 알 수 없는 접미사면 비압축 tar로 대체하며 선택자의 접미사가 이를 재정의하지 않습니다.
- 프롬프트는 흔한 두 안티패턴을 금지합니다. `edit`를 써야 하는 일상적 편집에 `write`를 사용하는 것과 명시적인 요청 없이 `*.md` / `README` 파일을 만드는 것입니다. 요청하지 않은 이모지도 금지합니다.
- 일반 쓰기 영수증은 `Buffer.byteLength(...)`로 UTF-8 바이트를 계산합니다. 핸들러 소유 영수증은 자체 내용/상태 문구를 정의합니다.
- `stripWriteContent()`는 세션의 파일 표시 모드에서 `hashLines`가 활성화되었을 때만 hashline 접두사를 제거합니다. 아니면 내용을 그대로 씁니다. 활성화되어도 모든 내용 행에 접두사가 있고, 빈 행·생략 행·헤더 행 뒤를 제외하고 각 번호가 위 행보다 하나씩 클 때만 제거합니다(`read`와 `grep`의 행 번호 방식). 16진 덤프 주소나 로그 타임스탬프처럼 번호가 뛰면 유지하며, 마커 없이 행을 건너뛰는 부분 보기(편집 미리보기, `ast_grep` 일치)도 그대로 유지합니다. `conflict://*`의 ID별 지시문은 어느 경우든 복사한 `LINE:` 접두사 뒤에서 인식합니다.

- 도구는 `strict = true`, `loadMode = "essential"`, 배타적 동시성을 사용합니다. 네이티브 기록 보기는 내용의 첫 8행을 미리 보여 줍니다. `xd://` 결과는 렌더링을 마운트된 장치에 위임합니다.
