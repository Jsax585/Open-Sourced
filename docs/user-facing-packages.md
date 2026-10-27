# 사용자용 패키지

이 페이지는 패키지별 README/매니페스트 외에 루트 문서에서도 안내해야 하는, README에만 소개된 사용자용 패키지 CLI와 기능을 정리합니다.

## 루트 문서 정책

- 사용자가 직접 또는 `omp`를 통해 실행할 수 있는 패키지별 CLI, 확장 기능, 대시보드, 벤치마크 실행기는 루트 문서에 **포함합니다**.
- 내부 구현 전용 패키지/크레이트는 **명시적으로 제외하고** 해당 아키텍처 문서를 안내합니다.
- 패키지별 설정과 플래그의 기준은 패키지 README와 매니페스트입니다. 루트 문서는 기능을 발견할 수 있도록 정확한 소스 경로를 연결합니다.
- 내부 Rust 크레이트는 독립적인 사용자 명령이나 API로 제공되기 전까지 네이티브 아키텍처 문서에서 다룹니다. 기여자용 안내는 [`native-crates.md`](./native-crates.md)에 있습니다. 현재 모든 `crates/*` 항목은 `@oh-my-pi/pi-natives`와 내장 셸의 내부 구현이므로 [`natives-architecture.md`](./natives-architecture.md) 및 관련 네이티브 문서에서 다룹니다.

## 패키지 CLI와 기능

### `python/robomp` — 자체 호스팅 GitHub 분류 및 수정 서비스

소스: [`python/robomp/README.md`](../python/robomp/README.md), [`python/robomp/pyproject.toml`](../python/robomp/pyproject.toml), [`python/robomp/.env.example`](../python/robomp/.env.example), [`python/robomp/docker-compose.yml`](../python/robomp/docker-compose.yml).

- Python 패키지: `robomp`(Python 3.11 이상). 실행 파일: `robomp`. 명령: `serve`, `triage`, `replay`, `status`, `cleanup`.
- 기능: 허용 목록에 있는 저장소의 GitHub 웹후크를 받아 이슈를 분류하고, 이슈별 `omp --mode rpc` 세션을 재개하며, 댓글이나 수정 PR을 작성하고 후속 이슈/PR 대화를 처리하는 자체 호스팅 서비스입니다. 들어오는 PR 검토는 기본 활성화되며, 선택적으로 켜는 릴리스 감시 기능은 릴리스 CI 실패를 처리합니다(`ROBOMP_RELEASE_SENTINEL_ENABLED`, 기본값 false).
- 대시보드/API: FastAPI가 `/`에서 운영자 대시보드를 제공하며 상태, 이벤트, 이슈, 재실행 엔드포인트도 제공합니다. 번들 Compose 배포에서는 `http://localhost:6543/`에 공개합니다. `bun run robomp:web:dev`는 대시보드 프런트엔드를 개발 모드로 실행하고 `bun run robomp:web:build`는 정적 번들을 다시 빌드합니다.
- 입력/저장: Compose는 서비스별 명시적 환경 변수 허용 목록을 통해 `python/robomp/.env`를 보간하며 `~/.omp/agent/models.container.yml`을 에이전트의 `models.yml`로 마운트합니다. 호스트 CLI 구성은 프로세스 환경과 현재 작업 디렉터리 기준 `.env`를 사용합니다. GitHub 웹후크 이벤트는 SQLite 기반 대기열로 들어가며, Compose는 `/data` 아래 `robomp_data` 볼륨에 데이터베이스, 작업 공간, 세션 대화 기록과 로그를 보관합니다.
- 루트 명령: `bun run robomp:install`은 호스트 개발용 Python 패키지를 설치하고 `bun run robomp:serve`는 호스트에서 실행합니다. `bun run robomp:build`/`bun run robomp:rebuild`, `bun run robomp:up`, `bun run robomp:down`, `bun run robomp:restart`, `bun run robomp:logs`, `bun run robomp:dev`, `bun run robomp:reset`은 컨테이너 배포를 관리합니다.
- 사전 요구 사항: 번들 배포용 Docker Compose v2, 컨테이너 모델 구성과 일치하며 호스트에서 접근 가능한 모델 게이트웨이, GitHub 웹후크 엔드포인트, 허용된 모든 저장소에 쓰기 권한이 있는 봇 PAT가 필요합니다. 오케스트레이터는 HMAC 인증 `gh-proxy`를 요구하며 `GITHUB_TOKEN` 보유를 거부합니다. 번들된 두 컨테이너 배포는 PAT를 사이드카에만 전달합니다. 호스트 개발에서도 PAT가 오케스트레이터 환경과 `.env`에 들어가지 않게 해야 합니다.

### `packages/stats` — 로컬 사용량 대시보드

소스: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- 패키지: `@oh-my-pi/omp-stats`. 실행 파일: `omp-stats`. 기본 사용자 명령: `omp stats`.
- 기능: 세션 JSONL 로그에서 AI 사용 통계를 보여 주는 로컬 관측 대시보드입니다.
- CLI 모드: `omp stats`는 `http://127.0.0.1:3847`에서 대시보드를 시작하거나 재사용하고 브라우저에서 연 뒤 계속 실행됩니다. `--port <port>`는 포트를, `--host <host>`는 바인딩 주소(기본 루프백)를 바꿉니다. `--summary`는 콘솔 요약을 출력하고 `--json`은 JSON을 출력한 뒤 종료합니다. 독립 실행형 `omp-stats`는 요약 모드에 `--sync`를 사용하며 브라우저를 자동으로 열지 않습니다.
- 프로그래밍 API: 임베딩용 `syncAllSessions()`, `getDashboardStats()` 등의 도우미를 내보냅니다.
- 입력/저장: 중첩된 하위 에이전트 대화 기록을 포함해 활성 프로필의 세션 디렉터리를 재귀 탐색하고 해당 프로필의 통계 데이터베이스에 집계값을 저장합니다. 기본 경로는 `~/.omp/agent/sessions/`와 `~/.omp/stats.db`입니다. 초기화된 XDG 데이터 루트와 이름 있는 프로필은 공유 디렉터리 해석기를 통해 경로를 바꿉니다.
- 출력: 요청/토큰/비용, 제공업체, 모델, 폴더, 도구, 성과, 불만도 대시보드입니다. API 엔드포인트는 `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, `/api/stats/tools`, `/api/stats/gain`, `/api/status`, `/api/events`(SSE), `/api/sync`(POST) 등입니다.
- 부수 효과/제약: 일회성 보고서는 수집과 집계를 마친 뒤 출력합니다. 대시보드는 즉시 바인딩하고 페이지가 이벤트 스트림에 연결하면 백그라운드 수집을 시작합니다. `Ctrl+C`는 CLI의 통계 데이터베이스를 닫고 종료합니다. `omp stats`의 불만도 판정은 설정된 `judge` 역할을 필요할 때 사용하며(텔레메트리 용도 `stats_frustration`) 모델을 호출할 수 있습니다. 독립 실행형 `omp-stats`는 판정 모델을 제공하지 않습니다.

### `packages/omptype` — 스키마 검증 라이브러리

소스: [`packages/omptype/README.md`](../packages/omptype/README.md), [`packages/omptype/package.json`](../packages/omptype/package.json), 저장소의 [omptype 작성 가이드](./omptype-guide.md).

- 패키지: 공개 `@oh-my-pi/omptype`. `bun add @oh-my-pi/omptype`로 설치합니다. 매니페스트는 Node 20 이상과 Bun 1.3.14 이상을 선언합니다.
- 기능: 낮은 초기 인터프리트 비용, 필요할 때 수행하는 빈번한 실행 경로 컴파일, 검증 오류, 기본값, 변환, JSON Schema 생성을 지원하는 호출 가능한 ArkType 호환 스키마입니다.
- 공개 인터페이스: 네이티브 작성용 `@oh-my-pi/omptype`, 호환 빌더용 `/typebox`와 `/zod`, 별칭 없는 ArkType 호환 인터페이스 `/ark`입니다.
- 런타임 동작: 스키마 호출은 검증된 값이나 `type.errors`를 반환합니다. `.assert()`는 값을 반환하거나 예외를 발생시키며 `.allows()`는 불리언 검사를 수행합니다.
- 제약: 모든 ArkType, TypeBox, Zod API를 완전히 구현하는 대신 의도적으로 범위를 한정한 호환 인터페이스입니다.

### `packages/typescript-edit-benchmark` — TypeScript 편집 픽스처 엔진

소스: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/generate.ts`](../packages/typescript-edit-benchmark/src/generate.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/verify.ts`](../packages/typescript-edit-benchmark/src/verify.ts), [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts)의 실행기.

- 패키지: 비공개 `@oh-my-pi/typescript-edit-benchmark`. 독립 실행 파일이 없는 지원 라이브러리입니다.
- 기능: metaharness 편집 어댑터가 사용하는 TypeScript 변형 픽스처를 생성, 로드, 포맷하고 검증합니다.
- 픽스처 생성: 저장소 루트에서 `bun packages/typescript-edit-benchmark/src/generate.ts [--typescript-dir <path>] [generator options]`를 실행합니다. JS/JSX/TS/TSX를 탐색합니다. 소스 경로가 없으면 `badlogic/pi-mono`를 임시 디렉터리에 얕게 복제하고 `packages/`를 탐색합니다. 기본 출력은 `packages/typescript-edit-benchmark/fixtures.tar.gz`이며 생성기 옵션에는 `--count-scale`, `--seed`, `--categories`, 난이도/점수 필터가 있습니다.
- 벤치마크 실행: `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [options]`를 실행하거나 metaharness 대시보드/API에서 `edit` 실행을 시작합니다.
- 실행기 입력에는 제공업체/모델, 추론 수준, 작업별 실행 횟수, 시간 제한, 동시성, 작업 ID, 픽스처 디렉터리 또는 `.tar.gz`, 편집 전략, 안내 모드, 재시도/턴 제한, 출력 경로/형식, 픽스처 검증/목록 플래그가 포함됩니다.
- 픽스처는 작업 메타데이터, 프롬프트, 입력 파일, 예상 파일로 구성됩니다. 실행기는 각 실행의 입력을 `runs/rb-*/` 아래 격리된 작업 디렉터리로 복사하고, 선택적으로 대화 덤프를 기록하며, Markdown 또는 JSON 결과를 작성합니다.

### `packages/metaharness` — 통합 벤치마크 관리자

소스: [`packages/metaharness/README.md`](../packages/metaharness/README.md), [`packages/metaharness/package.json`](../packages/metaharness/package.json), [`packages/metaharness/src/server.ts`](../packages/metaharness/src/server.ts), [`packages/metaharness/src/runner.ts`](../packages/metaharness/src/runner.ts), [`packages/metaharness/src/tb/cli.ts`](../packages/metaharness/src/tb/cli.ts), [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts).

- 패키지: 비공개 `@oh-my-pi/pi-metaharness`. 실행 파일: `metaharness`.
- 기능: Harbor 데이터셋(기본값 `terminal-bench@2.0`), TypeScript 편집, SnapCompact 벤치마크에 대해 단일 대시보드, SQLite 저장소, REST/SSE API, 정규화된 실험 → 실행 → 추적 모델을 제공합니다.
- 대시보드/API: `bun run --cwd packages/metaharness serve -- --port 4700`. 시작 양식과 `POST /api/runs`는 세 벤치마크 어댑터를 모두 지원합니다.
- 직접 실행: `bun packages/metaharness/src/runner.ts --model <provider/model> [Harbor options]` 및 `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [edit options]`.
- 별도 Terminal-Bench 2.1 실행기: `bun run --cwd packages/metaharness bench:tb -- --model <provider/model> [options]`는 접근 가능한 호스트 인증 게이트웨이를 통해 원격 Vibemon microVM에서 로컬 OMP 바이너리를 실행합니다. 작업 필터, 반복 시도/에포크, 동시성, 지출 예산, 도구/환경 제어, 작업 목록을 지원합니다. 산출물과 `tb.sqlite`의 기본 위치는 `runs/tb/`이며 대시보드의 세 어댑터 중 하나가 아닙니다.
- Harbor 소스 모드는 저장소와 캐시된 Linux 의존성 트리를 바인드 마운트하며 제공업체 자격 증명은 인증 게이트웨이 뒤 호스트에 유지합니다. 로컬 tarball, 게시된 패키지, 사전 빌드 바이너리 설치 모드도 사용할 수 있습니다.
- 저장: 정규화된 상태는 `<jobs-dir>/_manager/metaharness.sqlite`에 저장합니다. 벤치마크 고유 산출물은 파일 시스템의 기준 데이터로 유지하며 과거 실행을 자동 검색합니다.
- 출력에는 Harbor 시도 디렉터리, `_bench/<jobName>/report.md`, 실행별 로그, 편집 보고서, 정규화된 추적, 대시보드 지표, REST/SSE 갱신이 포함됩니다.
- 제약: 실험이나 실행을 삭제하면 해당 작업 디렉터리도 삭제되며 대상이 실행 중이면 거부됩니다. Harbor에는 Docker 또는 Apple Container와 Harbor CLI가 필요합니다. 백엔드별 네트워크 및 마운트 제약은 패키지 README를 참고하세요.

### `packages/browser-relay` — 기존 Chrome 탭 제어

소스: [`packages/browser-relay/README.md`](../packages/browser-relay/README.md), [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- 패키지: 비공개 `@oh-my-pi/browser-relay`. 사용자 명령: `omp browser-relay`.
- 설정: `omp browser-relay install`을 실행하고 `~/.omp/browser-relay/extension`에서 압축 해제된 확장 기능을 로드한 뒤, 호출마다 `app.relay: true`로 사용을 선택하세요. 또는 `browser.relay`를 설정하면 프로젝트에 관계없이 프로필 전체에서 릴레이가 기본값이 됩니다(범위에 대한 자세한 내용은 패키지 README 참고).
- 동작: 프로필과 독립적인 전역 데몬 브로커를 통해 릴레이가 자동 시작됩니다. 여러 프로젝트의 사용자가 사용권을 보유하며 마지막 사용권을 반납하면 릴레이가 중지됩니다. `app.target`은 정확한 CDP 대상 ID 또는 URL/제목 부분 문자열로 탭을 빌려 사용합니다. 그렇지 않으면 omp가 자체 백그라운드 탭을 열며 URL로 이동하고 닫으면 제거합니다. `omp browser-relay --no-group`은 자동 탭 그룹화를 끕니다.
- 보안/제약: 루프백에 바인딩합니다. 로컬 프로세스를 신뢰할 수 없다면 `--token`을 사용하세요. Chrome 내부 페이지, DevTools, Web Store, 확장 기능 페이지, DevTools가 열린 탭에는 연결할 수 없습니다.

### `packages/collab-web` — 협업 세션용 브라우저 클라이언트

소스: [`packages/collab-web/README.md`](../packages/collab-web/README.md), [`packages/collab-web/package.json`](../packages/collab-web/package.json), [`docs/collab.md`](./collab.md).

- 패키지: 비공개 `@oh-my-pi/collab-web`. 운영 클라이언트: <https://my.omp.sh/>.
- 기능: 스트리밍 대화 기록, 도구 카드, 하위 에이전트 보기, 프롬프트, 호스트 중단 기능을 포함한 `/collab` 세션용 브라우저 게스트 UI입니다.
- 로컬 실행: `bun run dev`는 포트 3000에서 UI를 제공하고, `bun run mock-host`는 오프라인 릴레이와 스크립트 기반 호스트를 실행하며, `bun run build`는 `dist/`에 정적 SPA를 생성합니다.
- 제약: 로컬이 아닌 배포에는 HTTPS와 접근 가능한 보안 WebSocket 릴레이가 필요합니다. 방 키는 URL 프래그먼트에 남으며 릴레이에 전송되지 않습니다.

### `packages/snapcompact` — 비트맵 컨텍스트 압축 API

소스: [`packages/snapcompact/README.md`](../packages/snapcompact/README.md), [`packages/snapcompact/package.json`](../packages/snapcompact/package.json), [`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts).

- 패키지: 공개 `@oh-my-pi/snapcompact`. `bun add @oh-my-pi/snapcompact`로 설치하며 Bun 1.3.14 이상이 필요합니다.
- 기능: 비전 모델의 컨텍스트 압축을 위해 버려지는 대화 기록을 로컬에서 결정적으로 직렬화하고 PNG로 렌더링합니다. 모델 호출이나 API 키는 필요하지 않습니다.
- 공개 진입점은 `compact`, `render`, `renderMany`, `frames`, 형태 선택, 텍스트 정규화/직렬화, 이미지 예산, 파일 작업 도우미를 포함합니다.
- 런타임 제약: 래스터화와 PNG 인코딩에는 `@oh-my-pi/pi-natives`가 필요합니다.

### `packages/mnemopi` — 독립 실행형 로컬 메모리 CLI

소스: [`packages/mnemopi/README.md`](../packages/mnemopi/README.md), [`packages/mnemopi/package.json`](../packages/mnemopi/package.json), [`packages/mnemopi/src/cli.ts`](../packages/mnemopi/src/cli.ts), coding-agent [Mnemopi 메모리 백엔드 가이드](./mnemosyne-memory-backend.md).

- 패키지: 공개 `@oh-my-pi/pi-mnemopi`. 실행 파일: `mnemopi`. Bun 1.3.14 이상이 필요합니다. `bun add --global @oh-my-pi/pi-mnemopi`로 전역 설치한 뒤 `mnemopi <command>`를 실행하세요. 소스 체크아웃에서는 `bun packages/mnemopi/src/cli.ts <command>`가 같은 진입점을 실행합니다.
- 저장과 검색: `store`/`remember`, `recall`/`search`, `update`/`edit`, `delete`/`forget`.
- 조회와 유지 관리: `stats`, `sleep`/`consolidate`, `diagnose`/`doctor`, JSON `export`와 `import`, `read`/`write`/`clear`를 사용하는 `scratchpad`/`sp`, `list`/`create`/`delete`를 사용하는 `bank`.
- 저장: 독립 실행 명령은 기본적으로 `~/.hermes/mnemopi/data/mnemopi.db`를 사용하며 `MNEMOPI_DATA_DIR`로 다른 데이터 디렉터리를 선택합니다. 이 기본값은 OMP가 세션별로 관리하는 메모리 위치와 별개입니다.
- 통합: `mcp`는 패키지의 MCP 서버를 시작합니다. 독립 실행형 CLI는 Mnemopi 저장소를 직접 조작합니다. OMP 세션에 메모리를 통합하려면 백엔드 가이드에 따라 `memory.backend: mnemopi`를 선택하세요.
- 기능 확인과 오류: `mnemopi --help`는 주요 명령 형식을 표시합니다. 알 수 없는 명령이나 잘못된 인수는 간결한 오류를 출력하고 0이 아닌 종료 코드를 반환합니다.
