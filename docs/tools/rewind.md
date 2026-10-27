# rewind

> 탐색 과정의 컨텍스트를 잘라 내고 간결한 보고서만 남겨 활성 체크포인트를 종료합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/checkpoint.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/rewind.md`
- 주요 연관 구성 요소:
  - `packages/coding-agent/src/session/agent-session.ts` — 대기 중인 되감기 상태를 검증하고 실제 되감기를 적용한 뒤 보존된 보고서를 주입합니다.
  - `packages/coding-agent/src/session/session-manager.ts` — 영속 세션 트리를 분기하고 영속 요약/보고서 항목을 추가합니다.
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()`가 컨텍스트를 재구성할 때 영속 `branch_summary` 항목을 LLM에 보이는 `branchSummary` 메시지로 변환합니다.
  - `packages/coding-agent/src/tools/index.ts` — 도구를 등록하고 `checkpoint.enabled` 활성화 조건을 공유합니다.

## 등록 / 노출
- 도구 메타데이터: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`. 실행은 단발성이며 되감기의 부수 효과는 진행 상황으로 스트리밍되지 않고 나중에 적용됩니다.
- 등록하려면 `checkpoint.enabled = true`가 필요합니다(기본값 `false`).
- 활성화하면 최상위 세션에 도구가 제공됩니다. 하위 에이전트는 기본적으로 이 도구를 발견하지 못하지만 명시적인 `tools:`/요청 도구 목록을 통해 받을 수 있습니다.
- `checkpoint`와 `rewind`는 안전을 위한 한 쌍입니다. 기능이 활성화된 상태에서 둘 중 하나를 명시적으로 요청하면 다른 하나도 자동으로 포함됩니다.
- 일반적인 `tools.xdev` 세션에서는 검색 가능한 내장 도구가 `xd://rewind`로 표시될 수 있습니다. 명시적으로 요청한 도구는 최상위에 남습니다.

## 입력

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `report` | `string` | 예 | 조사 결과입니다. `execute()`가 앞뒤 공백을 제거하고 결과가 비어 있으면 거부합니다. |

## 출력
도구는 하나의 텍스트 결과와 구조화된 세부 정보를 반환합니다.

- 텍스트 본문:
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`:
  - `report: string` — 앞뒤 공백을 제거한 보고서 텍스트
  - `rewound: true`

반환된 도구 결과 자체가 최종 되감기는 아닙니다. `AgentSession`은 `turn_end`까지 기다린 뒤 되감기의 부수 효과를 비동기적으로 적용합니다.

## 처리 흐름
1. `packages/coding-agent/src/tools/index.ts`의 도구 등록은 `checkpoint.enabled`와 최상위/명시적 하위 에이전트 노출 규칙을 적용합니다. `RewindTool.createIf()` 자체는 항상 도구를 생성합니다.
2. 활성 체크포인트가 없으면 `execute()`는 두 상태를 구분합니다.
   - 보존된 완료 되감기가 있음: `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")`
   - 완료된 되감기가 없음: `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")`
3. `params.report`의 앞뒤 공백을 제거하고, 비어 있으면 `ToolError("Report cannot be empty.")`를 던집니다.
4. `details.report`와 `details.rewound = true`가 포함된 `toolResult()`를 반환합니다.
5. 되감기 도구 결과가 성공하면 `AgentSession`이 `details.report` 또는 첫 번째 텍스트 콘텐츠 블록에서 보고서를 추출하여 `#pendingRewindReport`에 저장합니다.
6. `turn_end`에서 `#extractRewindReport()`가 대기 중이거나 성공한 되감기 결과를 찾아 `#applyRewind()`를 호출합니다.
7. `#applyRewind()`는 먼저 `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`를 호출하여 체크포인트 분기 지점에 `branch_summary`를 기록합니다. 해당 항목을 더 이상 찾을 수 없으면 경고를 기록하고 대신 루트에서 분기합니다.
8. 숨겨진 영속 `rewind-report` 사용자 정의 메시지를 추가합니다. 콘텐츠는 `prompts/system/rewind-report.md`에서 렌더링되며, 다음 턴에 체크포인트가 완료되었고 `rewind`를 다시 호출하면 안 된다는 안내와 보고서를 담습니다. 세부 정보에는 `{ report, startedAt, rewoundAt }`가 포함됩니다.
9. 같은 어시스턴트 배치에서 완료된 형제 도구 호출과 결과의 부모를 보존된 분기로 옮깁니다(`rewind`는 제외하고 쓰기 장치 디스패치는 포함). `#lastCompletedRewind`를 설정하고 표시/LLM 컨텍스트를 재구성한 뒤 활성 메시지를 교체합니다. 이전 탐색과 성공한 되감기 도구 결과는 다음 제공자 호출에서 빠집니다. 완료된 형제 작업은 계속 표시되며 재개 후에도 유지됩니다.
10. 비용은 보존하면서 자문 에이전트 세션 상태를 초기화하고, 새 분기에서 할 일 및 모델 언급 상태를 동기화하며, 기록이 다시 작성된 제공자 세션을 닫습니다.
11. 마지막으로 `#checkpointState`와 `#pendingRewindReport`를 비웁니다. 이후 재개하거나 트리를 탐색할 때 영속 보존 보고서가 `#lastCompletedRewind`를 복원합니다.

## 모드 / 변형
- 일반 되감기: 체크포인트 항목이 존재하며 세션 기록이 정확히 그 항목에서 분기합니다.
- 대체 되감기: 현재 세션 트리에 체크포인트 항목 ID가 없으므로 루트에서 분기하고 경고를 기록합니다.
- 턴 종료 후 적용: 도구 결과는 되감기만 요청하며, 분기와 컨텍스트 교체는 해당 어시스턴트 턴이 끝난 뒤 수행됩니다.
- 재개된 체크포인트: 활성 영속 분기에 있는 미완료 상태의 성공한 체크포인트 도구 결과가 체크포인트 상태를 복원하여 프로세스 재개 후에도 되감기를 허용합니다.

## 부수 효과
- 세션 상태(대화 기록, 메모리, 작업, 체크포인트, 레지스트리)
  - 체크포인트 분기와 보존된 요약/보고서로 활성 대화 기록을 재구성합니다. 파일이나 프로세스 상태는 복원하지 않습니다.
  - 렌더링된 복구 안내와 보고서를 담은 숨겨진 사용자 정의 메시지 `rewind-report`를 추가합니다.
  - `#lastCompletedRewind`를 기록하고 활성 체크포인트와 대기 보고서를 비우며, 자문 에이전트를 초기화하고 할 일 상태를 다시 동기화하며, 기록 재작성으로 무효화된 제공자 세션을 닫습니다.
  - 영속 세션의 리프를 체크포인트 분기 지점으로 옮기고 새 세션 항목을 추가합니다.
- 파일 시스템
  - 일반적인 `SessionManager` 추가 저장을 통해 새 `branch_summary` 및 `custom_message` 항목을 세션 `.jsonl` 파일에 영속화합니다.
  - 세션 파일 이름은 세션 디렉터리의 `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl`입니다. 재정의가 없으면 기본 디렉터리는 `~/.omp/agent/sessions/<encoded-cwd>/`입니다.
- 사용자에게 표시되는 프롬프트 / 대화형 UI
  - 도구 결과는 턴 종료 적용 전에 표시됩니다.
  - 영속 `branch_summary`는 컨텍스트 재구성 시 LLM에 보이는 `branchSummary` 메시지가 됩니다. 압축 렌더링에서는 사용자 역할의 `<summary>` 블록으로 표시됩니다.
  - 숨겨진 `rewind-report` 사용자 정의 메시지는 다음 제공자 호출을 위한 개발자 역할의 보존 안내가 됩니다.
- 백그라운드 작업 / 취소
  - 되감기 적용은 `turn_end`까지 지연됩니다. 별도 작업 객체나 취소 핸들은 없습니다.

## 제한 및 상한
- 사용 가능 여부는 `checkpoint.enabled`에 따라 결정되며 기본값은 `false`입니다.
- 하위 에이전트에는 명시적인 요청 도구 항목이 필요합니다. 체크포인트 도구 중 하나를 요청하면 짝 도구도 자동으로 포함됩니다.
- 세션에는 활성 체크포인트가 최대 하나만 존재합니다. 여러 체크포인트에 이름을 붙이거나 선택하는 방법은 없습니다.
- 보고서 텍스트는 `trim()` 이후 비어 있으면 안 됩니다.
- 되감기는 활성 대화/세션 트리 컨텍스트만 복원합니다. 파일, 아티팩트, blob, 프로세스 또는 git을 복원하는 경로는 없습니다.
- 영속 보고서/요약 콘텐츠에는 전역 세션 저장 상한 `MAX_PERSIST_CHARS = 500_000`이 적용됩니다.

## 오류
- `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")` — 활성 분기에 이미 보존된 완료 상태가 있으면 발생합니다.
- `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")` — 활성 체크포인트와 완료된 되감기가 모두 없으면 발생합니다.
- `ToolError("Report cannot be empty.")` — 앞뒤 공백을 제거한 보고서가 비어 있으면 발생합니다.
- 적용 중 체크포인트 항목 ID가 없더라도 완료된 도구 호출이 실패하지는 않습니다. `#applyRewind()`가 `Rewind branch checkpoint missing, falling back to root`를 기록하고 루트에서 분기합니다.

## 참고
- 체크포인트 선택은 암묵적입니다. `rewind`는 마지막 미완료 상태의 성공한 `checkpoint`에서 캡처하거나 복원한 단일 `#checkpointState`를 항상 대상으로 삼습니다. 체크포인트 목록, 레이블 또는 ID 매개변수는 없습니다.
- 복원되는 상태는 활성 대화/세션 트리 컨텍스트입니다.
  - `checkpointEntryId` 또는 대체 루트로 초기화된 영속 분기
  - 버린 탐색 경로의 분기 요약
  - 보존된 `rewind-report` 사용자 정의 메시지
  - 해당 분기에서 재구성한 메모리 내 메시지
- 복원되지 않는 항목:
  - 파일 시스템 또는 git 상태
  - `packages/coding-agent/src/session/artifacts.ts`의 아티팩트
  - `packages/coding-agent/src/session/blob-store.ts`의 blob 저장소 페이로드
  - `packages/coding-agent/src/session/history-storage.ts`의 프롬프트 기록 행
  - `packages/coding-agent/src/session/agent-storage.ts`의 인증 또는 기타 에이전트 저장 데이터
- 동시 편집 조정은 없습니다. 되감기는 코드나 세션에 인접한 외부 상태를 병합하거나 되돌리지 않습니다.
- 되감기는 영속 세션 기록을 파괴하지 않습니다. `branchWithSummary()`는 새 `branch_summary` 항목을 추가하고 리프를 이동합니다. 버린 항목은 `.jsonl` 로그에 남지만 활성 분기에서는 제외됩니다.
