# checkpoint

> 현재 최상위 대화 상태를 표시하여 나중에 `rewind`가 탐색 과정의 컨텍스트를 보고서로 압축할 수 있게 합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/checkpoint.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- 주요 협력 구성 요소:
  - `packages/coding-agent/src/session/agent-session.ts` — 도구 실행이 성공하면 활성 체크포인트를 캡처합니다.
  - `packages/coding-agent/src/session/session-manager.ts` — 일반 세션 항목 스트림을 영속화하며, 활성 체크포인트 표시는 영속화하지 않습니다.
  - `packages/coding-agent/src/tools/index.ts` — 도구를 등록하고 `checkpoint.enabled`로 사용 여부를 제어합니다.
  - `packages/coding-agent/src/tools/settings.ts` — 기본적으로 꺼진 기능 플래그(`cfgCheckpointEnabled`)를 정의합니다.

## 등록 / 노출
- 도구 메타데이터: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`. 실행 결과는 한 번에 전달되며 진행 상황 업데이트는 스트리밍하지 않습니다.
- 등록하려면 `checkpoint.enabled = true`여야 합니다(기본값 `false`).
- 활성화하면 최상위 세션에 도구가 제공됩니다. 하위 에이전트는 기본적으로 이 도구를 발견하지 못하지만, 명시적인 `tools:`/요청 도구 목록을 통해 받을 수 있습니다.
- `checkpoint`와 `rewind`는 안전을 위한 쌍입니다. 기능이 켜진 상태에서 둘 중 하나를 명시적으로 요청하면 등록 시 다른 하나도 자동으로 포함됩니다.
- 일반적인 `tools.xdev` 세션에서는 검색 가능한 내장 도구가 `xd://checkpoint`로 표시될 수 있습니다. 명시적으로 요청한 도구는 최상위에 유지됩니다.

## 입력

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `goal` | `string` | 예 | 조사 목표입니다. 스키마에서 필수이며 도구 결과에 그대로 반환됩니다. 구현은 공백을 제거하거나 빈 문자열을 거부하지 않습니다. |

## 출력
도구는 텍스트 결과 하나와 구조화된 세부 정보를 반환합니다.

- 텍스트 본문:
  - `Checkpoint: <goal>`
  - `Finish exploration and formulate findings.`
- `details`:
  - `goal: string`
  - `startedAt: string` — `CheckpointTool.execute()` 안에서 생성한 ISO 타임스탬프

체크포인트 ID, 아티팩트 URI, 작업 핸들, 파일 경로 또는 복원 토큰은 반환하지 않습니다.

## 흐름
1. `packages/coding-agent/src/tools/index.ts`의 도구 등록은 `checkpoint.enabled`와 최상위/명시적 하위 에이전트 노출 규칙을 적용합니다. `CheckpointTool.createIf()` 자체는 항상 도구를 생성합니다.
2. `session.getCheckpointState?.()`가 이미 설정되어 있으면 `CheckpointTool.execute()`는 `ToolError("Checkpoint already active.")`로 중첩 체크포인트를 거부합니다.
3. `startedAt = new Date().toISOString()`을 생성하고 일반 `toolResult()` 페이로드를 반환합니다. 도구 메서드 자체는 체크포인트 상태를 변경하지 않습니다.
4. 체크포인트의 `message_end`가 성공하면 `AgentSession`은 다음을 동기적으로 캡처합니다.
   - `checkpointMessageCount` — 체크포인트 도구 결과가 이미 추가된 후의 현재 `agent.state.messages.length`
   - `checkpointEntryId` — 처음에는 `null`이며, 이후 메시지 동일성을 기준으로 영속화된 체크포인트 도구 결과 항목 자체의 ID가 채워짐
   - `startedAt` — 도구 세부 정보에서 복사하거나 다시 생성
5. `#pendingRewindReport`와 `#lastCompletedRewind`를 지우고, 대기 작업 전에 숨겨진 `checkpoint-active-reminder`를 방향 지시 메시지로 큐에 넣습니다. 이 알림은 다음 제공자 호출에 전달되고 체크포인트 항목 뒤에 영속화됩니다. rewind의 분기 절단으로 제거됩니다.
6. 재개, 세션 전환 또는 트리 탐색 시 `#rehydrateCheckpointRewindState()`가 현재 영속화된 분기를 검사합니다. 이후에 유지된 rewind 보고서가 없는 가장 최근의 성공한 체크포인트에서 활성 체크포인트 경계와 보호 장치를 재구성합니다.

## 부수 효과
- 세션 상태(대화 기록, 메모리, 작업, 체크포인트, 레지스트리)
  - 메모리의 `AgentSession.#checkpointState`를 설정합니다.
  - 체크포인트 경계를 메시지 수와 영속화된 체크포인트 도구 결과 항목 ID로 기록합니다.
  - 일반적인 성공 도구 결과 항목만으로 재개 후 미완료 체크포인트를 재구성할 수 있습니다. 별도의 체크포인트 표시 항목은 없습니다.
  - 이후 종료 보호 장치를 활성화합니다. 체크포인트가 활성 상태이고 대기 중인 rewind 보고서가 없으면 `#enforceRewindBeforeYield()`가 developer 역할 경고를 삽입하고 다음 턴을 예약합니다.
- 사용자에게 보이는 프롬프트 / 대화형 UI
  - 도구 프롬프트와 숨겨진 체크포인트 활성 알림은 조사 후 `rewind`를 호출하도록 모델에 지시합니다.
  - 에이전트가 먼저 `yield`하려 하면 `AgentSession`이 다음을 삽입합니다.

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## 제한 및 상한
- 사용 가능 여부는 `checkpoint.enabled`로 제어하며 기본값은 `false`입니다.
- 세션 또는 하위 에이전트마다 활성 체크포인트는 하나만 허용됩니다.
- 하위 에이전트에는 명시적인 요청 도구 항목이 필요합니다. 체크포인트 도구 중 하나를 요청하면 짝 도구도 자동으로 포함됩니다.
- 체크포인트 상태는 전용 항목으로 영속화하지 않습니다. 프로세스 재개 후에도 활성 분기에 있는 성공한 체크포인트 도구 결과 항목으로 재구성합니다.
- 일반 체크포인트 도구 호출/결과 메시지에는 세션 영속화가 적용됩니다. 전역 세션 영속화 잘라내기 한도는 `packages/coding-agent/src/session/session-persistence.ts`의 `MAX_PERSIST_CHARS = 500_000`입니다.

## 오류
- `ToolError("Checkpoint already active.")` — 이전 체크포인트를 되감거나 해제하지 않았을 때 발생합니다.
- 도구 본문에는 로컬 `try/catch`가 없으므로 예상치 못한 예외는 전파됩니다.

## 참고
- 요약 문자열 `Create a git-based checkpoint to save and restore session state`와 달리, 구현은 git을 호출하거나 파일시스템 상태의 스냅샷을 만들지 않습니다.
- 캡처하는 상태는 대화/세션 메타데이터뿐입니다.
  - 메모리 내 메시지 수
  - 세션 트리에 영속화된 체크포인트 도구 결과 항목 ID
  - 타임스탬프
- 캡처하지 않는 항목:
  - 작업 트리 내용 또는 스테이징된 변경 사항
  - 아티팩트 또는 블롭 저장소 내용
  - `packages/coding-agent/src/session/history-storage.ts`의 SQLite 프롬프트 기록 행
  - `packages/coding-agent/src/session/agent-storage.ts`의 인증 또는 에이전트 레코드
