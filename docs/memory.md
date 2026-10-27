# 자율 메모리

omp는 다섯 가지 메모리 모드를 지원합니다. 메모리는 기본적으로 비활성화되어 있으며, `/settings` 또는 `config.yml`에서 백엔드 하나를 선택할 수 있습니다.

| `memory.backend` | 저장 방식 및 동작 | 안내 |
| ---------------- | ---------------- | ---- |
| `off` | 메모리 백엔드 사용 안 함 | — |
| `local` | 저장된 세션에서 생성하는 프로젝트별 요약 및 교훈 | 이 페이지 |
| `hindsight` | 원격 뱅크 단위 Hindsight 메모리 | [Hindsight](#hindsight-원격-백엔드) |
| `mnemopi` | 로컬 Mnemopi SQLite 메모리 | [Mnemopi 메모리 백엔드](./mnemosyne-memory-backend.md) |
| `sharpshooter` | 마찰 신호를 기준으로 기록하고 백그라운드에서 통합하는 프로젝트 결정 파일(아키텍처/제품/스타일) | [Sharpshooter](#sharpshooter-백엔드) |

로컬 요약 파이프라인을 활성화하려면 다음과 같이 설정합니다.

```yaml
memory:
  backend: local
```

## 사용법

### 주입되는 내용

세션이 시작될 때 현재 프로젝트의 통합 요약이나 수동으로 기록한 교훈이 있으면 시스템 프롬프트에 **Memory Guidance** 블록으로 주입됩니다. 요약과 교훈은 `memories.summaryInjectionTokenLimit`을 공유합니다.

시작 시 통합 작업이 첫 번째 프롬프트 구성 이후에 완료되면 활성 세션의 요약 스냅샷을 갱신합니다. 기록된 교훈은 최초 스냅샷에 고정되므로 동시에 실행되는 `learn` 호출도 이후 세션에만 영향을 줍니다.

- 메모리는 작업 과정과 이전 결정을 참고하는 휴리스틱 맥락으로 취급하세요. 현재 저장소 상태에 대한 권위 있는 정보는 아닙니다.
- 메모리로 인해 계획이 달라지면 해당 메모리 아티팩트 경로를 인용하고, 실행하기 전에 현재 저장소의 근거도 함께 확인하세요.
- 메모리가 저장소 상태나 사용자 지시와 충돌하면 저장소 상태와 사용자 지시를 우선하고, 충돌하는 메모리는 오래된 정보로 취급하세요.

### 메모리 아티팩트 읽기

에이전트는 `read` 도구에 `memory://` URL을 사용하여 메모리 파일을 직접 읽을 수 있습니다.

| URL | 내용 |
| --- | ---- |
| `memory://root` | 시작 시 주입되는 간결한 요약 |
| `memory://root/MEMORY.md` | 전체 장기 메모리 문서 |
| `memory://root/learned.md` | `learn` 도구로 기록한 교훈 |
| `memory://root/skills/<name>/SKILL.md` | 생성된 스킬 실행 지침 |
| `memory://<memory-id>` | YAML 프런트매터 메타데이터 헤더가 포함된 전체 Mnemopi 메모리 행(작업 메모리 또는 에피소드 메모리). `memory.backend`가 `mnemopi`일 때만 사용 가능 |

`memory://<memory-id>` 형식은 잘린 회상 미리보기 대신 저장된 전체 행을 반환합니다. 미리보기 한도를 넘은 회상 내용은 끝에 `…`가 붙습니다. 에이전트는 `memory_edit update`를 수행하기 전에 전체 행을 읽도록 지시받습니다.

`memory://root[/…]` 행은 파일 기반이며, 통합 파이프라인을 통해 디스크의 메모리 루트를 채우는 `memory.backend: local`에서만 존재합니다. `hindsight`나 `mnemopi`에서는 루트를 기록하지 않으므로 해당 URL을 해석할 수 없습니다. 대신 `recall`/`reflect`를 사용하세요. `mnemopi`에서는 `read memory://<memory-id>`도 사용할 수 있습니다.

### `/memory` 슬래시 명령

| 하위 명령 | 동작 |
| --------- | ---- |
| `view` | 현재 백엔드의 주입 내용을 표시 |
| `stats` | 지원되는 경우 백엔드별 메모리 통계를 표시 |
| `diagnose` | 지원되는 경우 백엔드별 진단 정보를 표시 |
| `queue` | 통합을 기다리는 메모리 변경분을 표시 |
| `sync` | 지금 메모리 통합을 실행 |
| `clear` / `reset` | 활성 백엔드의 메모리 데이터/아티팩트를 삭제 |
| `enqueue` / `rebuild` | 활성 백엔드의 통합/보존 작업을 강제로 실행 |
| `mm …` | Hindsight 멘탈 모델 관리(`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`). ACP 모드에서는 지원하지 않음 |

### 교훈 기록

`autolearn.enabled`를 활성화하면 `learn` 도구를 사용할 수 있습니다.

```yaml
autolearn:
  enabled: true
```

로컬 백엔드가 활성화되어 있으면 `learn`은 명시적인 장기 교훈을 프로젝트의 `learned.md`에 저장합니다. 교훈은 최신순으로 정렬되고, 중복이 제거되며, 비밀 정보가 가려지고, 최대 100개로 제한됩니다. 다음 세션부터 주입되며, `learn` 호출은 활성 세션의 프롬프트 캐시 접두부를 변경하지 않습니다. 각 교훈의 내용은 2,000자, 선택적 맥락은 400자로 제한됩니다. 로컬 백엔드는 구조화된 메모리 검색, `recall`, `retain`, `reflect`, `memory_edit`를 지원하지 않습니다.

## 동작 방식

로컬 요약 메모리는 시작 시 실행되는 백그라운드 파이프라인이 생성합니다. `/memory enqueue`는 다음 시작 시 처리할 통합 작업을 표시합니다. 하위 에이전트와 세션 파일에 저장되지 않는 세션에서는 파이프라인을 실행하지 않습니다.

**1단계 — 세션별 추출:** 마지막 처리 이후 변경된 과거 세션마다 모델이 세션 기록을 읽고 기술적 결정, 제약 조건, 해결된 실패, 반복적인 작업 흐름 등 장기적으로 유용한 정보를 추출합니다. 너무 최근이거나 오래된 세션, 현재 활성 상태인 세션, 설정된 검색/기간 한도를 벗어난 세션은 건너뜁니다. 각 추출 작업은 해당 세션의 원시 메모리 블록과 짧은 개요를 생성합니다.

**2단계 — 통합:** 추출이 끝나면 두 번째 모델 실행이 모든 세션별 추출 결과를 읽고 디스크에 기록할 세 가지 결과물을 생성합니다.

- `MEMORY.md` — 선별·정리된 장기 메모리 문서
- `memory_summary.md` — 세션 시작 시 주입되는 간결한 텍스트
- `skills/` — 각각 별도 하위 디렉터리에 저장되는 재사용 가능한 절차 지침

별도로 관리하는 `learned.md`는 통합 작업이 덮어쓰지 않습니다.

2단계는 여러 프로세스가 동시에 시작될 때 중복 실행을 방지하기 위해 임대와 하트비트를 사용합니다. 이전 실행에서 남은 오래된 스킬 디렉터리는 자동으로 정리됩니다.

통합 결과를 `MEMORY.md`, `memory_summary.md` 또는 생성된 스킬로 디스크에 기록하기 전에 일반적인 비밀 정보/토큰 패턴을 가립니다.

### 추출 동작

메모리 추출 및 통합 동작은 `packages/coding-agent/src/prompts/memories/`의 정적 프롬프트 파일이 결정합니다.

| 파일 | 용도 | 변수 |
| ---- | ---- | ---- |
| `stage_one_system.md` | 세션별 추출용 시스템 프롬프트 | — |
| `stage_one_input.md` | 세션 내용을 감싸는 사용자 턴 템플릿 | `{{thread_id}}`, `{{response_items_json}}` |
| `consolidation_system.md` | 세션 간 통합용 시스템 프롬프트 | — |
| `consolidation.md` | 세션 간 통합용 사용자 턴 프롬프트 | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md` | 실행 중인 세션에 주입되는 메모리 지침 | `{{memory_summary}}`, `{{learned}}` |

### 모델 선택

메모리는 모델 역할 시스템을 활용합니다.

| 단계 | 역할 | 용도 |
| ---- | ---- | ---- |
| 1단계(추출) | `default` | 세션별 지식 추출 |
| 2단계(통합) | `smol` (`default`, 이후 현재/레지스트리의 첫 번째 모델로 대체) | 세션 간 정보 종합 |

요청한 메모리 역할이 설정되어 있지 않으면 메모리 모델은 `default` 역할, 활성 세션 모델, 레지스트리의 첫 번째 모델 순으로 대체 모델을 선택합니다.

## 설정

| 설정 | 기본값 | 설명 |
| ---- | ------ | ---- |
| `memory.backend` | `off` | 이 파이프라인을 사용하려면 `local` 선택. 백엔드를 명시하지 않은 경우 기존 `memories.enabled: true`는 `memory.backend: local`로 마이그레이션됨 |
| `memories.maxRolloutAgeDays` | `30` | 이 기간보다 오래된 세션은 처리하지 않음 |
| `memories.minRolloutIdleHours` | `12` | 이 기간 이내에 활성 상태였던 세션은 건너뜀 |
| `memories.maxRolloutsPerStartup` | `64` | 한 번의 시작에서 처리할 최대 세션 수 |
| `memories.threadScanLimit` | `300` | 시작 시 검색할 최대 최근 세션 레코드 수 |
| `memories.maxRawMemoriesForGlobal` | `200` | 전역 통합에 제공할 최대 세션별 추출 결과 수 |
| `memories.stage1Concurrency` | `8` | 동시에 실행할 세션별 추출 작업 수 |
| `memories.stage1LeaseSeconds` | `120` | 추출 작업 임대 기간 |
| `memories.stage1RetryDelaySeconds` | `120` | 실패한 추출 작업을 다시 가져올 수 있을 때까지의 대기 시간 |
| `memories.phase2LeaseSeconds` | `180` | 통합 작업 임대 기간 |
| `memories.phase2RetryDelaySeconds` | `180` | 실패한 통합 작업의 재시도 대기 시간 |
| `memories.phase2HeartbeatSeconds` | `30` | 통합 작업 임대 하트비트 간격 |
| `memories.rolloutPayloadPercent` | `0.7` | 선택한 모델의 컨텍스트 예산 중 세션 페이로드에 사용할 비율 |
| `memories.phase1InputTokenLimit` | `4000` | 세션별 추출 입력 한도 |
| `memories.fallbackTokenLimit` | `16000` | 모델에 유한한 컨텍스트 창이 선언되지 않은 경우 사용할 모델 토큰 예산 |
| `memories.summaryInjectionTokenLimit` | `5000` | 시스템 프롬프트에 주입되는 요약과 기록된 교훈이 공유하는 대략적인 토큰 한도 |

## Hindsight 원격 백엔드

Hindsight를 사용하려면 접근 가능한 [Hindsight](https://hindsight.vectorize.io/) 서버가 필요합니다. 기본 엔드포인트는 `http://localhost:8888`이며, 서버에서 인증을 요구하면 토큰을 설정하세요.

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 환경 변수는 `hindsight.*` 설정보다 우선하고, 설정은 내장 기본값보다 우선합니다. 지원되는 18개 재정의 항목, 허용 값, 파싱 규칙, 우선순위, 기본값은 [전체 Hindsight 환경 변수 표](./environment-variables.md#hindsight-memory-backend)를 참고하세요.

기본적으로 Hindsight는 `per-project-tagged` 범위를 사용합니다. 쓰기는 프로젝트 태그와 함께 공유 뱅크에 저장되며, 회상에는 프로젝트 태그가 붙은 메모리와 태그 없는 전역 메모리가 포함됩니다. `per-project`는 각 작업 디렉터리 프로젝트를 별도 뱅크로 격리하고, `global`은 하나의 공유 뱅크를 사용합니다. `hindsight.bankId`를 명시하면 뱅크 기본 이름을 선택합니다. 뱅크 ID, 접두부 또는 범위를 변경하면 기본 세션 상태를 다시 구성하여 이후 작업이 새 범위를 사용하도록 합니다.

두 프로젝트 범위 모드는 동일한 방식으로 프로젝트 이름을 정합니다. 저장소의 기본 체크아웃 루트(하나의 저장소에 연결된 모든 워크트리가 같은 디렉터리로 해석됨)를 구한 다음 디렉터리 기본 이름을 소문자로 변환합니다. 따라서 `~/code/General`의 체크아웃에는 `project:general` 태그가 붙습니다. 태그는 문자열 그대로 일치시키므로 이 변환 덕분에 경로의 대소문자와 관계없이 하나의 저장소가 하나의 메모리 범위를 사용합니다.

기본 세션은 첫 모델 턴에서 회상하고(`hindsight.autoRecall: true`), 기본적으로 사용자 턴 세 번마다 완료된 대화 턴을 자동 보존합니다. `/memory enqueue`는 대기 중인 도구 보존 요청을 처리하고 현재 세션을 강제로 보존합니다. 에이전트 종료 시 기본 상태는 주기에 따른 보존을 예약하고 보존 큐를 처리합니다. 세션을 폐기할 때는 상태를 해제하기 전에 큐를 모두 처리합니다. 요청 실패와 설정된 시간 초과는 로그에 기록하며 코딩 세션은 계속 사용할 수 있습니다. 하위 에이전트는 명시적인 `recall`, `retain`, `reflect` 호출에 부모의 클라이언트, 뱅크, 범위를 공유하지만 자체적인 자동 회상이나 보존은 실행하지 않습니다.

회상 결과는 지시가 아닌 배경 맥락으로 주입되며, 압축 시 추가 맥락으로도 사용할 수 있습니다. 첫 턴의 회상 결과는 세션 파일에 저장되므로 세션 재개, 전환 또는 포크 시 다시 회상하지 않고 그대로 전송합니다. 컨텍스트 초기화, 뱅크나 태그 필터 변경, 첫 프롬프트를 수정하는 분기에서는 새로 회상합니다. Hindsight 메모리는 ID로 조회할 수 없어 회상 이후의 변경 사항은 보고되지 않습니다. 멘탈 모델은 새 프로세스가 시작될 때 계속 다시 불러옵니다. Hindsight를 선택하면 `recall`, `retain`, `reflect`가 제공됩니다. 이 백엔드는 원본 Hindsight 메모리를 편집하지 않으므로 `memory_edit`는 제공되지 않습니다.

`/memory view`, `/memory stats`, `/memory diagnose`, `/memory enqueue`는 활성 Hindsight 상태를 통해 동작합니다. `/memory clear`는 먼저 대기 중인 보존 요청을 모두 처리한 뒤 로컬 세션 상태와 회상 캐시만 지웁니다. **서버 측 뱅크는 삭제하지 않습니다.** 해당 뱅크는 Hindsight UI나 API로 삭제하세요.

## Sharpshooter 백엔드

Sharpshooter는 프로젝트의 결정을 담은 짧은 파일 세 개(`architecture.md`, `product.md`, `style.md`)를 유지하고 시스템 프롬프트에 주입합니다. 서버는 필요하지 않습니다. 파일은 `<agentDir>/memories/sharpshooter/<bank>/`에 저장되며, 뱅크는 작업 디렉터리에서 결정되므로 프로젝트마다 자체 결정을 유지합니다.

```yaml
memory:
  backend: sharpshooter
sharpshooter:
  minPromptLength: 4
  intervalMinutes: 5
```

**추출:** 기본 세션의 각 사용자 프롬프트(하위 에이전트는 제외)를 추출 모델에 보내고, 모델은 아키텍처, 제품 및 스타일 결정, 제약 조건, 거부한 접근 방식, 정정 사항 등 사용자가 내린 장기적인 결정을 세션별 큐에 변경분으로 기록합니다. 슬래시 명령과 `sharpshooter.minPromptLength`자보다 짧은 프롬프트는 보내지 않습니다. 세션에서는 한 번에 하나의 추출 작업만 실행하며, 실행 중 도착한 프롬프트는 추출하지 않습니다. "opt 2" 같은 짧은 답변은 직전 어시스턴트 메시지를 기준으로 해석하지만 기본값인 16자에서는 너무 짧아 전송되지 않습니다. 이를 기록하려면 `sharpshooter.minPromptLength`를 낮추세요.

**통합:** 스케줄러는 매분 확인하고 마지막 실행 이후 `sharpshooter.intervalMinutes`가 지나면 한 번의 모델 실행으로 대기 중인 변경분을 세 파일에 적용한 뒤 큐에서 제거합니다. `/memory enqueue`는 즉시 통합하고, `/memory queue`는 대기 중인 변경분을 나열하며, `/memory clear`는 프로젝트의 파일과 큐를 삭제합니다.

| 설정 | 기본값 | 설명 |
| ---- | ------ | ---- |
| `memory.backend` | `off` | 이 백엔드를 활성화하려면 `sharpshooter`로 설정 |
| `sharpshooter.model` | 미설정 | 추출 및 통합용 모델 선택자. 미설정 시 `smol` 역할 사용 |
| `sharpshooter.minPromptLength` | `16` | 이 글자 수보다 짧은 프롬프트는 추출용으로 전송하지 않음. `2` 미만의 값은 `2`로 동작. 문자는 표시되는 단위로 계산하므로 CJK 문자나 이모지도 하나로 세며 모든 언어에서 동일함. 따라서 중국어 사용자는 "用方案二" 같은 짧은 답변을 기록하도록 값을 낮출 수 있음 |
| `sharpshooter.intervalMinutes` | `5` | 통합 실행 사이의 최소 시간(분) |
| `sharpshooter.injectionTokenLimit` | `15000` | 시스템 프롬프트에 주입되는 결정 파일의 대략적인 토큰 한도 |

## 주요 파일

- `packages/coding-agent/src/memories/index.ts` — 파이프라인 조정, 주입, 삭제/큐 등록 진입점(`/memory` 명령은 `packages/coding-agent/src/memory-backend/local-backend.ts`를 통해 이곳으로 연결됨)
- `packages/coding-agent/src/memories/storage.ts` — SQLite 기반 작업 큐 및 스레드 레지스트리
- `packages/coding-agent/src/prompts/memories/` — 메모리 프롬프트 템플릿
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 처리기
