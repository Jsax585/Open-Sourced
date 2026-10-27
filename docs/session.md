# 세션 저장소와 항목 모델

이 문서는 coding-agent 세션의 런타임 표현, 저장, 마이그레이션 및 재구성 방식에 대한 기준 문서입니다.

## 범위

다루는 내용:

- 세션 JSONL 형식과 버전 관리
- 항목 분류와 트리 의미(`id`/`parentId` 및 리프 포인터)
- 이전 파일이나 잘못된 파일을 불러올 때의 마이그레이션 및 호환 동작
- 컨텍스트 재구성(`buildSessionContext`)
- 저장 보장, 실패 동작, 잘라내기 및 블롭 외부 저장
- 저장소 추상화(`FileSessionStorage`, `MemorySessionStorage`)와 관련 유틸리티

세션 데이터에 영향을 주는 의미 외의 `/tree` UI 렌더링 동작은 다루지 않습니다.

## 구현 파일

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — 트리/리프, 추가, 저장, 블롭, 수명 주기 팩터리 조정
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — 항목/헤더 타입, `SessionEntry` 유니언, `CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — 버전 마이그레이션
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — 파일 로드 및 블롭 참조 해석
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — 잘라내기 및 이미지 블롭 외부 저장
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — 디스크 배치, 디렉터리 인코딩, 터미널별 기록
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — 탐색(목록/최근/대상 결정)
- [`src/session/session-index.ts`](../packages/coding-agent/src/session/session-index.ts) — `history.db`의 제목 색인 및 유휴 요약 저널
- [`src/session/exit-diagnostics.ts`](../packages/coding-agent/src/session/exit-diagnostics.ts) — 미완료 도구 및 중단된 턴 진단
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — 저장소 추상화
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) — 고정 너비의 현재 제목 슬롯
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) — 로컬 색인 및 순서 보장 원격 저장소 어댑터
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — 사용자 지정 메시지 변환기
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — 콘텐츠 주소 기반 블롭 저장소
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — 프롬프트 기록(별도 하위 시스템)

<a id="on-disk-layout"></a>
## 디스크 배치

파일 세션의 기본 위치:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`<encoded-cwd>`는 정규화된 cwd에서 계산하므로 심볼릭 링크 별칭은 같은 버킷을 공유합니다. 홈 아래 디렉터리는 `-<relative>`, 임시 루트 아래는 `-tmp-<relative>`, 그 외는 `--<encoded-absolute>--`이며 경로 구분자는 `-`로 바꿉니다.

접근 시 한동안 사용되었던 해시 방식(`<scope>-<project-basename>-<sha256(canonical-cwd)>`, 17.2.5~17.2.8에서 사용하고 17.2.9의 #7397에서 철회)으로 기록한 버킷과 이전 홈 상대 버킷 표기인 `--<home-encoded>-*--`를 가능한 범위에서 경로 인코딩 이름으로 되돌립니다.

블롭 저장소 위치:

```text
~/.omp/agent/blobs/<sha256>
```

터미널별 기록 파일 위치:

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

기록 내용은 cwd와 세션 파일 경로로 시작합니다. 선택적인 추가 줄은 `fresh`와 `cwdstat <device> <inode>`입니다. 새 기록은 JSONL 파일이 아직 없는 지연 생성 세션을 보존하여 `continueRecent()`가 이전 세션을 다시 열지 않도록 합니다. 명시적인 `newSession()` 경계는 `drop`(`/delete`)이 만드는 지연 생성 후속 세션을 제외하고 반환 전에 헤더를 실제로 기록합니다. 디렉터리 식별 정보는 같은 파일시스템 안에서 프로젝트 이름이 변경된 뒤 자동으로 루트를 다시 지정할 수 있게 합니다. cwd가 없다는 사실만으로 이동을 판단하지는 않습니다. 쓰기는 동기적이며 순서를 지키고, 가능한 범위에서 수행됩니다.

## 파일 형식

세션 파일은 줄마다 JSON 객체 하나를 저장하는 JSONL입니다. 현재 파일은 물리적으로 줄바꿈을 포함한 고정 너비 256바이트 `type: "title"` 슬롯으로 시작하고, 이어서 세션 헤더와 `SessionEntry` 값이 나옵니다. 이전 파일은 헤더로 바로 시작할 수 있습니다. 로더는 물리적 슬롯을 제거하고 현재 제목/출처를 논리 헤더에 반영합니다.

- 논리적으로 첫 항목은 항상 세션 헤더(`type: "session"`)입니다.
- 나머지 논리 항목은 `SessionEntry` 값입니다.
- 일반적인 추가는 트리를 확장하고, 분기 탐색은 메모리 포인터(`leafId`)를 이동합니다. 대상 재작성/삭제 헬퍼는 기존 레코드를 바꿀 수 있습니다.

### 헤더(`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "019c625b-b900-7000-8000-000000000001",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "additionalDirectories": ["/work/shared"],
  "previousSessionFiles": ["/old/location/session.jsonl"],
  "providerPromptCacheKey": "optional inherited cache identity",
  "taskPromptCacheKey": "optional local-only Task sibling family key",
  "parentSession": "optional lineage marker"
}
```

참고:

- 새 세션 ID는 UUIDv7 문자열이며, 리더는 이전 문자열 ID도 허용합니다.
- `additionalDirectories`는 `cwd` 이외의 작업 공간 루트를 정규화하고 중복 제거하여 기록합니다.
- `previousSessionFiles`는 이동 성공 후 이전 절대 위치를 기록합니다.
- `providerPromptCacheKey`는 조건을 만족하는 전체 포크에서 상속한 제공업체 프롬프트 캐시 식별자를 담습니다.
- `taskPromptCacheKey`는 로컬 전용 Task 형제 에이전트 계열 키(`<부모 캐시 키>:<에이전트 이름>`)이며 공유와 HTML 내보내기에서는 생략합니다.
  - 실행기는 자식의 초기 모델과 관계없이 자식 세션 생성 후 이를 파생합니다. 부모 캐시 계보가 비어 있으면 파생하지 않으며 자식은 자체 세션 식별자를 유지합니다.
  - 요청이 사용하기 전에는 세션 범위의 비영속 임시 저장소에 둡니다. `shared-prompt-cache`를 사용하도록 설정된 모델의 첫 기본 요청이 이를 헤더에 기록하므로 포크와 다시 열기에서도 유지됩니다.
  - 각 요청은 자체 모델을 기준으로 사용 여부를 결정합니다. 명시적 세션 키가 우선하며, 그렇지 않으면 사용하도록 설정된 모델에만 계열 키가 적용됩니다.
  - 임시 저장소는 포크, 이동, 분기, 새 세션 초기화, 다른 세션으로 전환할 때 유지되지 않습니다. 이동이나 전환을 롤백하면 복원됩니다.
- `parentSession`은 불투명한 계보 문자열입니다. 현재 코드는 흐름(`fork`, `forkFrom`, `createBranchedSession`, 명시적 `newSession({ parentSession })`)에 따라 세션 ID 또는 세션 경로를 기록합니다. 타입이 지정된 외래 키가 아니라 메타데이터로 취급하세요.

- `titleSource`는 `auto` 또는 `user`이며, 자동 이름 변경은 사용자 제목을 덮어쓸 수 없습니다.

### 항목 기본 구조(`SessionEntryBase`)

헤더 이외의 모든 항목은 다음을 포함합니다.

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

루트 항목(최초 추가 또는 `resetLeaf()` 이후)의 `parentId`는 `null`일 수 있습니다. 생성하는 항목 ID는 일반적으로 8자리 16진수이며, 충돌 재시도를 소진하면 전체 Snowflake ID를 사용합니다. 소비자는 고정 너비를 가정하면 안 됩니다.

<a id="entry-taxonomy"></a>
## 항목 분류

`SessionEntry`는 다음 타입의 유니언입니다.

- `message`
- `model_usage`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

`AgentMessage`를 직접 저장합니다.

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "api": "anthropic-messages",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 120,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "stopReason": "stop",
    "timestamp": 1760000000000
  }
}
```

저장된 `message.role` 판별자는 LLM 전송 형식이나 확장 기능 훅 이름에 사용하는 snake_case가 아니라 **camelCase**입니다. 일반 대화 레코드는 `type: "message"` 아래에 다음 역할을 사용합니다.

| 저장된 `message.role` | 소유 패키지 | 참고 |
| ------------------------ | ------------- | --------------------------------------------------------------------------------- |
| `user` | pi-ai | 사용자/도구 피드백 턴 |
| `developer` | pi-ai | developer 역할의 지침 턴 |
| `assistant` | pi-ai | 모델 턴. 도구 호출은 `content` 안의 `{ "type": "toolCall" }` 블록 |
| `toolResult` | pi-ai | 도구 호출 하나의 결과. `tool_result`가 **아님**. `toolCallId`/`toolName` 포함 |
| `bashExecution` | pi-tui | 독립적인 `!`-bash 실행 |
| `pythonExecution` | pi-tui | 독립적인 Python 실행 |
| `hookMessage` | pi-tui | 마이그레이션을 위해 유지하는 이전 훅 주입 메시지. 새 코드는 `custom` 사용 |
| `fileMention` | pi-tui | 인라인 `@file` 참조 내용 |

분기 요약과 컨텍스트 압축 요약 역할은 세션 컨텍스트 재구성 중 전용 최상위 항목에서 합성합니다. `pi.sendMessage`로 보낸 확장 기능 메시지도 `custom_message` 항목으로 저장하고 `custom`으로 재구성합니다.

| 저장된 항목 타입 | 재구성된 역할 |
| -------------------- | ------------------- |
| `branch_summary`     | `branchSummary`     |
| `compaction`         | `compactionSummary` |
| `custom_message`     | `custom`            |

내부 호출자는 `custom` 메시지를 직접 추가할 수 있으므로, 리더는 재구성된 역할에서 저장 구조를 추론하지 말고 `entry.type`으로 구분해야 합니다.

`toolCall`은 메시지 역할이 아니라 **`assistant` 메시지의 `content` 배열 안에 있는 콘텐츠 블록 타입**입니다. 확장 기능이 `message.role`을 snake_case 상수(`tool_result`, `tool_call`)와 비교하거나 비교 전에 소문자로 바꾸면 오류 없이 `toolResult`와 다른 모든 camelCase 역할을 건너뜁니다. 위의 camelCase 값을 그대로 비교하세요. 기본 역할은 `packages/ai/src/types.ts`의 `Message`이고, 나머지는 `CustomAgentMessages`에 병합됩니다(`packages/agent/src/compaction/messages.ts`, `packages/tui/src/chat/messages.ts`). Coding-agent는 사용자 지정 타입을 다시 내보내고 `packages/coding-agent/src/session/messages.ts`에서 제공업체 컨텍스트로 변환합니다.

### `model_usage`

대화 기록 밖에서 수행한 모델 호출을 기록합니다. 필드는 `purpose`, 선택적 모델 `role`, `api`, `provider`, `model`, `usage`, `stopReason`, 선택적 `errorMessage`입니다. 이 레코드는 사용량 집계에만 기여하며 모델 메시지나 대화 턴이 아닙니다. `appendModelUsage()`는 호출을 시작한 세션/분기에 레코드를 연결하며 오래된 세션 소유권을 거부합니다.

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role`은 선택적이며, 없으면 컨텍스트 재구성 시 `default`로 처리합니다. 선택적 `resolvedModelIsFallback`은 재시도 대체 모델 전환을 표시합니다. 예약된 역할 `fallback`은 일시적입니다. 모델 복원은 이 역할의 임시 모델 대신 설정된 기본 모델을 우선합니다.

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier`는 `openai`/`anthropic`/`google`을 키로 하는 계열별 맵(각 값은 `auto`/`default`/`flex`/`scale`/`priority`/`ultrafast`)이며 활성 등급이 없으면 `null`입니다. 단일 문자열(`"flex"`, `"openai-only"`, `"claude-only"` 등)을 저장한 이전 항목은 컨텍스트 재구성 중 이 맵으로 변환합니다. 불러오기만으로 페이로드를 재작성하지는 않습니다.

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

`configured`는 사용자가 선택한 선택자(`"auto"` 또는 구체적인 수준)를 추가로 보존할 수 있습니다. 이전 항목의 리더는 `thinkingLevel`을 대신 사용합니다. 두 필드 모두 `null`일 수 있으며, 결정된 수준이 null이거나 없으면 `"off"`로 재구성합니다.

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

선택적 컨텍스트 압축 메타데이터는 `tokensAfter`, `method`, `providerReplayThroughEntryId`, `warning`입니다. `preserveData`는 확장 기능 상태뿐 아니라 네이티브 OpenAI/Anthropic 재생 상태 또는 snapcompact 아카이브를 담을 수 있습니다. `providerReplayThroughEntryId`는 네이티브 대체 기록에 포함된 마지막 항목을 표시하여 이후 항목이 정상적으로 재생되도록 합니다.

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

루트에서 분기하면(`branchFromId === null`) `fromId`는 리터럴 문자열 `"root"`입니다.

### `reset_boundary`

`/clear`가 추가하는 페이로드 없는 마커입니다. 접힌 실시간 대화 기록과 재구성된 모델 컨텍스트는 적용 가능한 최신 경계 이후부터 시작합니다. 전체 기록 내보내기는 경계 이전 항목도 유지합니다.

### `custom`

핵심 하위 시스템 또는 확장 기능이 소유하는 불투명한 비 LLM 레코드입니다. `buildSessionContext`는 이를 모델 메시지로 직접 바꾸지 않지만, 하위 시스템별 재생 코드는 `customType` 값을 사용하여 런타임 상태를 복원하거나 중단된 턴을 진단할 수 있습니다.

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "com.example.my-extension.state",
  "data": { "state": 1 }
}
```

현재 핵심 코드가 소유하는 값:

| `customType` | `data` 스키마 | 기록 및 사용 주체 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start` | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }` | `AgentSession`이 도구 구현 시작 직전에 마커를 기록합니다. 종료 진단은 이를 어시스턴트 도구 호출 및 도구 결과와 결합하여 미완료 호출을 재구성합니다. 인수 요약은 잘라낸 표현이며 이전의 전체 인수 객체도 읽을 수 있습니다. |
| `session_exit` | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | 정상 폐기와 사후 정리는 어시스턴트 기록이나 미완료 도구 호출이 있으면 종료를 기록합니다. 작성기는 다음 프로세스가 마지막 영속 턴을 확인할 수 있도록 즉시 `flushSync()`를 호출하고 실패는 로그에 기록합니다. 재개 진단은 최신 유효 레코드를 사용합니다. |
| `user_todo_edit` | `{ phases: TodoPhase[] }` | SDK/UI 할 일 편집은 전체 단계 스냅샷을 저장합니다. 할 일 복원은 최신 스냅샷 또는 성공한 `todo` 도구 결과를 역방향 검색하여 단계를 복원합니다. |
| `vibe-session-lifecycle` | `{ version: 1, id, ownerId, parentSessionId, action, ... }` 형식의 버전 1 이벤트. `spawn`은 `cli`, `agent`, `childSessionFile`, `createdAt`을 추가하고, 턴 이벤트는 `turn`, 삭제 표시 이벤트는 `reason`을 추가 | Vibe 런타임이 자식 생성, 턴 시작/완료, 삭제 표시 및 삭제 표시 철회 전환을 저장하고 재생하여 소유한 자식 세션과 진행 중 상태를 복구합니다. 잘못되었거나 범위를 벗어난 이벤트는 무시합니다. |
| `autoresearch-control` | `{ mode: "on" \| "off" \| "clear", goal?: string }` | 내장 autoresearch 명령이 모드/목표 변경을 기록하고 실험 한도 종료는 `mode: "off"`를 기록합니다. `reconstructControlState()`는 재개 시 유효한 레코드를 재생하여 활성 여부와 목표를 복원합니다. `clear`는 목표를 제거합니다. |
| `system-prompt-digest` | 턴별 훅 재정의 전 기본 시스템 프롬프트 블록의 해시인 16진수 문자열 | `AgentSession`은 제공업체 출력의 프롬프트가 분기의 최신 기록과 다르면 기본 어시스턴트 응답 직전에 이를 추가하며, 부모를 재지정한 형제 응답과 함께 되감기 분기로 전달합니다. 재개 세션의 첫 모델 호출 전에는 접두사에 묶인 도구 목록 재구성이 그 프롬프트를 재현할 때만 커밋하며 기록이 없으면 고정합니다. 기본 프롬프트에 주입한 메모리 회상도 해시에 포함되므로 해당 세션은 고정 상태를 유지합니다. |

재개 시 대화 끝이 종료 상태가 아니고 그 뒤에 유효한 최신 `session_exit`가 있으면, `AgentSession`/SDK 초기화는 `stopReason: "aborted"`인 합성 어시스턴트 메시지를 추가하고 표시/에이전트 컨텍스트를 재구성합니다. 정상 종료는 미완료 도구 호출을 기록한 경우에만 이 전환을 유발하며, 비정상 종료 종류는 목록 없이도 유발할 수 있습니다. 따라서 복원된 대화 기록이 중단된 턴을 여전히 실행 중인 것으로 표시하지 않습니다.

표의 문자열은 핵심 소비자를 위해 예약되어 있습니다. 확장 기능은 이를 사용하면 **안 됩니다**. 확장 기능 레코드에는 역도메인이나 패키지 한정 이름 같은 네임스페이스 식별자를 사용하세요. 이름이 충돌하면 핵심 재생 로직이 확장 기능 데이터를 수명 주기 상태로 해석할 수 있습니다. 알 수 없는 네임스페이스 값은 핵심 세션 컨텍스트 재구성에서 불투명하게 유지됩니다.

### `custom_message`

LLM 컨텍스트에 참여하는 확장 기능 제공 메시지입니다. `content`는 문자열 또는 텍스트/이미지 콘텐츠 블록이며, `attribution`은 사용자와 에이전트 중 누가 시작했는지 기록합니다.

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined`는 `targetId`의 레이블을 지웁니다.

### `title_change`

세션 이름 변경의 추가 전용 감사 항목입니다. `title`, `source`(`auto` 또는 `user`), 선택적 `previousTitle`과 `trigger`를 기록합니다. 목록 조회에 전체 파일 재작성이 필요하지 않도록 현재 제목은 고정 너비 제목 슬롯에도 갱신합니다.

`/rename <title>`은 명시적 제목을 설정합니다. 제목 없는 `/rename`은 제목 생성 후보(`tiny`, `commit`, `smol`, 이어서 사용 가능한 현재 모델 대체 후보)를 사용하여 최근 대화에서 제목을 생성하고, 기존 제목에 카드(`<icon> <CODE>: `)가 있으면 유지합니다. 직접 입력했거나 생성한 제목에 카드가 없으면 `title.icons`가 `boring`이 아닌 한 같은 후보(`src/prompts/system/title-card.md`)에서 카드를 생성합니다. 카드 생성 실패 시 일반 제목을 유지하며, 중단되면 직접 입력한 제목에서 카드만 제외합니다. 두 경우 모두 사용자가 요청한 이름 변경(`source: "user"`)이므로 이후 자동 제목 생성으로 바꿀 수 없습니다. 대화가 비었거나 생성에 실패하면 현재 제목을 유지합니다. 생성 도중 세션을 전환하거나 더 새로운 이름 변경이 있으면 오래된 결과를 버립니다. 로컬 tiny 모델 실패는 온라인 제공업체로 대체하지 않습니다.

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

재개한 OAuth 요청을 서비스를 제공한 계정에 다시 고정하고 계정별 프롬프트 캐시 재사용을 보존하기 위해 제공업체와 가명 처리된 SHA-256 계정/범위 해시를 기록합니다. 원시 계정 식별자는 저장하지 않지만, 내보낸 해시는 연결 가능하므로 익명이 아닙니다.

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": ["...", "..."],
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "outputSchemaMode": "strict",
  "restrictToolNames": true,
  "spawns": "*",
  "readSummarize": false
}
```

최신 `session_init`는 비활성 하위 에이전트 복원 계약이기도 합니다. 선택적 필드는 `agent`, `modelRole`, `resolvedModel`, `retryFallback`, `readOnly`, `advisor`, `compactionThreshold`(`thresholdPercent`/`thresholdTokens`)입니다. `isolated: true`는 비활성 상태에서 복원할 수 없는 격리 워크트리 자식을 표시합니다. `systemPrompt`는 모델 호출을 구성한 기본 프롬프트 블록을 담으며 턴별 `before_agent_start` 재정의는 담지 않습니다. 복원은 이를 변경 없이 재생합니다. 모델 호출이 다른 기본 프롬프트나 작업 풀 양도 항목(`workPoolYieldItems`, 복원 시 재생)을 사용하면 더 새로운 `session_init`를 추가합니다. 이전 파일은 합친 문자열 하나를 저장하며 단일 블록으로 복원됩니다. `extractSessionInit()`와 읽기 전용 `peekSessionInit()`가 이 계약을 제공합니다.

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFilePath": "local://PLAN.md" }
}
```

## 버전 관리와 마이그레이션

현재 세션 버전: `3`.

### v1 -> v2

헤더 `version`이 없거나 `< 2`이면 적용합니다.

- 헤더 이외의 각 항목에 `id`와 `parentId`를 추가합니다.
- 파일 순서로 선형 부모 체인을 재구성합니다.
- 컨텍스트 압축 필드 `firstKeptEntryIndex`가 있으면 `firstKeptEntryId`로 마이그레이션합니다.
- 헤더에 `version = 2`를 설정합니다.

### v2 -> v3

헤더 `version < 3`이면 적용합니다.

- `message` 항목의 이전 `message.role === "hookMessage"`를 `"custom"`으로 바꿉니다.
- 헤더에 `version = 3`을 설정합니다.

### 마이그레이션 실행과 저장

- 세션 로드(`setSessionFile`) 중 마이그레이션을 실행합니다.
- 마이그레이션을 실행했으면 즉시 재작성하는 대신 메모리 표현에 전체 재작성 필요 표시를 합니다.
- 다음 저장 작업에서 전체를 재작성한 뒤 증분 추가를 계속합니다.

## 로드 및 호환 동작

`loadEntriesFromFile(path)` 동작:

- 파일이 없으면(`ENOENT`) `[]`를 반환합니다. 단, `throwIfMissing: true`이면 오류를 발생시킵니다.
- 8 MiB 이상의 현재 파일은 스트리밍 JSONL 로더를 사용하고, 작은 파일이나 파일 이외 저장소는 전체 텍스트를 읽습니다.
- 관대한 JSONL 파서는 잘못된 레코드를 건너뛰고 개수를 셉니다.
- 선택적인 고정 너비 제목 슬롯을 제거하고 헤더에 반영합니다.
- 첫 논리 항목이 유효한 세션 헤더가 아니면(`type !== "session"` 또는 문자열 `id` 없음) `[]`를 반환합니다.

`SessionManager.setSessionFile()` 동작:

- 없거나 실제로 빈 파일은 정확히 그 경로에 새 세션을 초기화하고 즉시 헤더를 기록합니다. 반면 `SessionManager.open(..., { throwIfMissing: true })`는 없거나 빈 입력을 거부합니다.
- 비어 있지 않은 데이터에 유효한 선행 세션 헤더가 없으면 파일을 수정하지 않고 거부합니다. 배열만 반환하는 `loadEntriesFromFile()`의 `[]` 결과로는 빈 입력과 손상된 입력을 구분할 수 없으므로 관리자는 `loadSessionFile()` 진단을 사용합니다.
- 유효한 파일을 불러오고 필요하면 마이그레이션한 뒤 블롭 참조를 해석하고 색인합니다. 마이그레이션, 잘못된 레코드 건너뛰기, 로드한 OpenAI 재생 데이터 정제는 다음 저장 작업에 전체 재작성 표시를 합니다.
- 기록된 cwd는 진입할 수 있을 때만 채택합니다. 그렇지 않으면 런타임 cwd는 시작/현재 디렉터리를 유지하고 대화 기록도 원래 위치에 남습니다. 작업 공간 루트 수정은 위치를 옮길 때까지 런타임에만 적용됩니다.

## 트리와 리프 의미

기본 모델은 추가 전용 트리와 변경 가능한 리프 포인터입니다.

- 일반 추가 메서드는 현재 `leafId`를 `parentId`로 하는 새 항목을 만든 뒤 리프를 이동합니다.
- `appendMessageToBranch()`는 활성 리프를 이동하지 않고 명시적 부모에 추가합니다. `appendModelUsage()`도 시작 부모가 더 이상 활성 상태가 아니면 후속 분기의 리프를 유지합니다.
- `branch(entryId)`는 `leafId`만 이동하며 기존 항목은 바꾸지 않습니다.
- `resetLeaf()`는 `leafId = null`로 설정하며, 다음 추가는 새 루트 항목(`parentId: null`)을 만듭니다.
- `branchWithSummary()`는 리프를 분기 대상으로 설정하고 `branch_summary` 항목을 추가합니다.

`getEntries()`는 헤더 이외의 모든 항목을 삽입 순서로 반환합니다. 별도로 저장하는 리프 필드는 없으며 로드 시 마지막 물리 항목에서 리프를 재구성합니다. 따라서 포인터만 바꾸는 `branch()`/`resetLeaf()` 변경을 재로드 후에도 유지하려면 이후 항목 추가가 필요합니다. `discardEntryDurably()`는 메타데이터 분기 마커를 추가하고 저널을 재작성하여 경로 삭제를 영속화합니다.

`createBranchedSession(leafId, { copyArtifacts? })`는 선택한 루트부터 리프까지의 경로만 포함하는 새 식별자를 만듭니다. 이전 레이블 레코드는 버리고 유지하는 항목의 최종 레이블을 다시 만듭니다. 전체 포크와 달리 제공업체 프롬프트 캐시 키를 상속하지 않습니다. `copyArtifacts`를 사용하면(`AgentSession.fork(entryId)`에서 사용) 결과물 디렉터리를 백그라운드에서 복사하고, 새 결과물 관리자는 형제 파일로 이동할 때처럼 ID 할당이나 `artifact://` 해석 전에 복사를 기다립니다.

## 컨텍스트 재구성(`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)`는 모델에 보낼 내용을 결정합니다. `options.transcript: true`는 대신 표시용 대화 기록을 구성합니다. 전체 기록 모드는 컨텍스트 압축을 인라인으로 보존하고, `collapseCompactedHistory`는 현재 압축된 끝부분만 렌더링하며, `keepDanglingToolCalls`는 턴 도중 UI를 재구성할 때 실행 중인 도구 호출을 보존합니다.

알고리즘:

1. 리프를 결정합니다.
   - `leafId === null`이면 빈 컨텍스트를 반환합니다.
   - 명시적 `leafId`가 있으면 해당 항목을 찾았을 때 사용합니다.
   - 그 외에는 마지막 항목을 사용합니다.
2. `parentId`를 따라 루트로 이동하되 손상된 순환을 제한하기 위해 반복 ID에서 멈춘 뒤 루트→리프 순으로 뒤집습니다.
3. 경로에서 런타임 상태를 도출합니다.
   - 최신 `thinking_level_change`의 결정된 추론 선택자와 설정된 추론 선택자
   - 최신 `service_tier_change`의 서비스 등급
   - `model_change` 항목의 모델 맵(`role ?? "default"`). 어시스턴트 메시지 추론은 명시적 기본값을 만나기 전까지만 사용하는 이전 형식 대체 수단
   - 중복 제거한 `injectedTtsrRules`
   - 최신 `mode_change`의 mode/modeData(기본 모드는 `"none"`)
4. 출력 경계를 선택합니다.
   - 뒤에 있는 `reset_boundary`는 경계까지의 모든 내용을 모델 컨텍스트와 접힌 실시간 대화 기록에서 숨깁니다.
   - 그 외에는 최신 컨텍스트 압축의 요약과 유지한 메시지/압축 후 메시지를 출력합니다. 제공업체 네이티브 대체 기록이 유지할 모델 컨텍스트를 제공할 수도 있습니다.
   - 전체 대화 기록 내보내기는 초기화 이전 기록을 유지하고 컨텍스트 압축을 시간순으로 렌더링합니다.
5. `message`, `custom_message`, `branch_summary` 항목을 메시지로 변환합니다. 다른 항목 타입은 재생 상태나 메타데이터에만 영향을 줍니다.
6. 턴 도중 대화 기록을 위해 명시적으로 유지하지 않은 미완료 도구 호출을 재생에서 제거하고, 재작성한 턴의 보호된 추론 메타데이터를 무력화합니다. 안전하지 않은 중단/오류 어시스턴트 턴과 대응 도구 결과를 모델 컨텍스트에서 제거합니다.

## 저장 보장과 실패 모델

### 영구 저장과 메모리 저장

- `SessionManager.create/open/continueRecent/forkFrom` → 영구 저장 모드(`persist = true`)
- `SessionManager.inMemory` → `MemorySessionStorage`를 사용하는 비영구 모드(`persist = false`)

### 쓰기 파이프라인

지연 파일 생성 조건을 충족한 뒤에는 완료된 일반 추가 작업이 메모리와 로컬 파일 저장소를 동기적으로 갱신합니다. `fsync`는 없으므로 성공한 로컬 쓰기는 소프트웨어 충돌에는 대비하지만 전원 손실에는 대비하지 않습니다. 색인된 Redis/SQL 백엔드는 로컬 보기를 즉시 갱신하지만 원격 반영은 순서가 있는 비동기 큐로 수행하므로, 쓰기 확인에는 `flush()`/백엔드 큐 비우기가 필요합니다. 제목 변경과 원자적 배치는 별도로 완료를 기다리는 저장 경로를 사용합니다. 스트리밍 중인 부분 텍스트는 완성된 메시지를 추가할 때까지 저장하지 않습니다.

- 새 일반 세션은 어시스턴트 메시지가 있거나 호출자가 `ensureOnDisk()`를 호출하기 전까지 메모리에만 남습니다.
- 그 전에는 항목을 메모리에 보관하며, 조건을 충족하면 전체 제목 슬롯, 헤더, 누적 항목을 기록합니다.
- 명시적 `newSession()`(`/new` 포함)은 반환 전에 `ensureOnDisk()`를 호출하여 터미널 간 빈 세션 경계를 보존합니다. `/delete`의 후속 세션(`drop`)은 예외로 지연 생성을 유지합니다. 새 터미널 기록이 이미 이 터미널을 해당 세션에 고정하고 삭제 실패 시 이전 세션도 유효한 재개 대상이기 때문입니다. 턴 없이 종료하면 빈 파일을 남기지 않아야 합니다.
- 이후에는 항목을 증분 추가합니다.
- 편집기 초안을 저장하면 검색 가능한 헤더를 강제로 기록하고 마커와 함께 `draft.txt`를 저장합니다. 시작 메타데이터만 남은 상태에서 초안이 없어지면 종료 시 초안 전용 세션을 제거합니다. 명시적 `ensureOnDisk()` 세션은 재개할 수 있습니다.
- 동시에 완료된 추가 작업은 진행 중인 원자적 재작성을 확정적인 전체 본문 재작성으로 대체하여 오래된 반영이 덮어쓰지 못하게 합니다.
- 큐에 들어간 색인 전체 재작성은 확인 전까지 최신 상태가 아닙니다. 후속 작업이 대체한 뒤에 보호된 재작성이 반영되면 관리자는 영속 본문을 검증하고 바이트 크기를 기록한 뒤 새 대화 기록을 재시도합니다.

### 영속성 작업

- `flush()`는 비동기 디스크/저장 큐와 열린 작성기를 비웁니다(`fsync` 없음). `flushSync()`는 동기 지원 작업을 비우거나 최신이 아닌 파일을 재작성합니다. 큐에 있는 원격 반영은 확인하지 못하므로 해당 백엔드에서는 완료를 기다리는 `flush()`/큐 비우기가 여전히 필요합니다.
- 원자적 전체 재작성은 커밋 보호 및 예상 바이트 크기 사전 조건과 함께 저장소 `writeTextAtomic`을 사용합니다. 파일 저장소는 임시 기록 후 대상으로 이름을 바꾸며, EPERM에 안전한 기존 파일 이동 대체 경로도 포함합니다.
- 로컬 추가와 반영은 프로세스 간 반영 잠금을 공유합니다. 바이트 크기가 바뀌면 `SessionWriteConflictError`, 잠금 경합이면 준비된 재작성을 반영하지 않고 `SessionLockError`를 발생시킵니다. 콘텐츠 해시 비교가 아니므로 협조하지 않는 외부 작성기를 방어할 수는 없습니다.
- `FileSessionStorage`는 프로세스가 쓰는 각 세션에 프로세스 소유 OS 임대를 유지합니다. 파일 경로가 아닌 세션 ID를 키로 하므로 심볼릭 링크, 하드 링크, 이동 후 같은 저널에 도달한 모든 프로세스가 같은 임대를 사용합니다. 임대는 `<session-owners>/<session-id>`에 대한 `pi-utils`의 `tryAcquireFileLock`입니다. `<session-owners>`는 프로필 간 공유하는 `~/.omp/run/session-owners`(XDG: `$XDG_STATE_HOME/omp/run/session-owners`)입니다. Linux는 추상 소켓, Windows는 이름 있는 뮤텍스를 사용하므로 파일을 만들지 않으며, macOS와 다른 비 Linux Unix는 해당 디렉터리의 보조 파일에 `flock`을 사용합니다. 쓰기 경로만 임대를 획득하므로 처음 쓰는 프로세스가 소유하며, 조회용 열기(`omp share`, `--export`, `render`)는 획득하지 않습니다. 한 프로세스의 관리자들은 임대를 공유합니다. 종료나 세션 전환 시 해제하고 프로세스가 끝나면 커널이 해제합니다. 홈이나 상태 디렉터리가 다른 프로세스는 같은 임대를 만나지 않습니다. 단순 파일 복사는 ID를 유지하므로 원본 작성기가 살아 있는 동안 사본에 쓰는 프로세스는 형제 파일로 이동합니다. Collab 게스트 복제본은 별도 ID를 사용하고 `parentSession`은 호스트 ID로 두므로 호스트와 경합하지 않습니다.
- 다른 실행 중 프로세스가 임대한 세션에는 절대 쓰지 않습니다. 최초 쓰기는 같은 디렉터리의 새 형제 `<timestamp>_<new-session-id>.jsonl`로 세션을 이동하고 전체 메모리 대화 기록을 한 번 반영한 뒤 증분 추가합니다. 소유자 파일은 건드리지 않습니다. `fork`처럼 새 세션 ID, 이전 ID를 가리키는 `parentSession`, 기존 제공업체 프롬프트 캐시 키를 사용하므로 ID 재개, 제목 색인, 선택기에 같은 ID의 파일 두 개가 나타나지 않습니다. 결과물 디렉터리는 이동한 세션이 이미 쓴 파일을 덮어쓰지 않고 백그라운드 복사합니다. 결과물 관리자는 ID 할당이나 `artifact://` 해석 전에 복사를 기다리며 `flush()`/`close()`도 기다립니다. 결과물 관리자를 거치지 않는 `local://`와 `agent://` 읽기는 복사가 끝날 때까지 이동 전 파일을 찾지 못할 수 있습니다.
- `moveTo()`는 무엇이든 이동하거나 디렉터리를 만들기 전에 다른 실행 중 프로세스가 쓰는 세션의 이동 및 다른 프로세스가 헤더 ID 기준으로 쓰는 대상 세션 파일의 교체를 거부합니다.
- `bun test`에서는 실제 상태 디렉터리 대신 `<os temp>/omp-test-session-owners-<uid>`를 임대 디렉터리로 사용합니다. `session-storage` 로드 시 `PI_TEST_SESSION_OWNERS_DIR`로 내보냅니다. 세션을 쓰는 omp 프로세스를 생성하는 테스트는 `env: process.env`를 전달하거나(Bun 기본값은 시작 환경), 자식이 `PI_TEST_RUNTIME=1`을 상속하여 같은 디렉터리를 계산하는 `ci-test-ts`에서 실행해야 합니다.
- 파일/메모리 백엔드의 전체 재작성 중 영속 바이트에 대한 `SessionWriteConflictError`는 임대 없는 작성기(이전 omp 또는 외부 도구)가 파일을 바꿨음을 뜻합니다. 관리자는 파일을 다시 읽고 자신에게 없는 항목을 보조 분기로 유지하며 활성 리프는 유지한 채 읽은 크기를 기준으로 재작성당 최대 세 번 재시도합니다. 매번 파일이 바뀌면 이후 쓰기마다 직렬화하는 대신 기존 파일을 맡기고 형제 파일로 이동합니다(`reason: "contested"`). 삭제된 파일은 다시 만들며, 더 이상 이 세션으로 읽히지 않는 파일은 건드리지 않고 형제로 이동합니다. 색인 백엔드는 자체 미확인 반영과의 경합일 수 있으므로 충돌을 계속 보고합니다.
- `appendEntriesAtomically()`는 동기 콜백의 추가 작업을 하나의 원자적 반영으로 묶습니다. 실패하면 준비된 항목을 롤백하고 유지된 동시 작업을 복구합니다.
- 재작성은 이름 변경, 항목 재작성, 마이그레이션/정제, 이동/포크, 복구에 사용합니다. 세션 제목 변경은 일반적으로 본문을 재작성하지 않고 고정 너비 제목 슬롯을 갱신하고 `title_change` 감사 항목을 추가합니다.

### 오류 동작

- 일반 추가 실패는 턴 루프로 예외를 던지는 대신 세션 파일 맥락과 함께 한 번 기록하고 보관합니다. 이후 추가는 전체 메모리 저널을 재시도할 수 있으며 `flush()`/`flushSync()`와 종료는 해결되지 않은 실패를 드러냅니다.
- `onPersistenceNotice`는 세션이 형제 파일로 이동하는 것을 `SessionPersistenceNotice`(`reason`, `from`, `to`)로 알립니다. 실패를 보관하지 않으며 `onPersistenceError`로 전달하지 않습니다. 보관된 실패처럼 지금까지의 모든 알림을 새 구독자마다 재생합니다. 대화형 모드는 경고로, 출력 모드는 stderr로, RPC는 `warning` 알림 프레임으로 표시하며 경로는 홈 상대 경로입니다.
- 원자적 배치 및 복구 경로는 확정적 복구를 시도합니다. 이미 반영되었을 가능성이 있고 복구의 영속성을 입증할 수 없으면 `SessionPersistenceIndeterminateError`가 원래 오류와 복구 오류를 포함해 안전하게 실패합니다.
- 작성기 종료는 첫 유의미한 오류를 전파합니다. 최종 폐기는 관리자를 봉인하여 늦은 추가/재작성을 무효화한 뒤 보관 항목을 해제하므로 폐기한 관리자가 복원된 대화 기록을 덮어쓸 수 없습니다.

## 데이터 크기 제어와 블롭 외부 저장

항목을 저장하기 전에:

- 500,000자를 넘는 문자열은 `"[Session persistence truncated large content]"`로 잘라냅니다. 단, 재생을 위해 바이트가 정확히 유지되어야 하는 서명/암호화 제공업체 블록, 서명 필드, 검증된 Anthropic 네이티브 웹/도구 검색 기록 블록, Anthropic 서버 압축 재생 전달 데이터, Cursor 서버 레코드(`cursorHistory` 페이로드)는 제외합니다.
- 임시 `jsonlEvents`를 제거합니다.
- 객체에 문자열 `content`와 숫자 `lineCount`가 모두 있으면 잘라낸 뒤 줄 수를 다시 계산합니다.
- `image_url` 필드의 이미지 데이터 URL은 길이와 관계없이 블롭 저장소에 콘텐츠 주소로 저장하고 `blob:sha256:<hash>`로 바꿉니다. 이미지 `content` 블록, `images[]`, snapcompact `frames[]`, 이미지 생성 결과의 1,024자 이상 Base64 페이로드도 외부 저장합니다.
- 기준 추론 항목이 이미 `providerPayload`에 있으면 중복 OpenAI Responses `thinkingSignature` 사본을 생략합니다.
- 외부 저장된 MCP 도구 결과는 렌더링된 구조화 출력이 잘라내기 결과물에 이미 있으면 중복 `details.structuredContent`를 생략합니다.

이 저장용 변환은 실시간 항목을 바꾸지 않습니다. 로드 시 일반 이미지 참조는 인라인 페이로드로 복원합니다. Snapcompact 프레임은 컨텍스트 재구성에서 선택할 때까지 지연 상태를 유지합니다. 이전 저장 코드로 프레임이 잘린 아카이브는 남겨 둔 텍스트나 손상되지 않은 프레임을 사용합니다.

## 저장소 추상화

`SessionStorage`는 `SessionManager`가 사용하는 파일시스템 유사 작업을 담당합니다. 동기 디렉터리/존재/쓰기/stat/목록 작업과 비동기 읽기, 부분 읽기, 쓰기, 보호된 원자적 쓰기, 이름 변경, 연결 해제, 결과물을 고려한 삭제, 제목 갱신, 작성기 생성, 백엔드 큐 비우기를 포함합니다. 선택 기능은 동기 읽기, 원격 쓰기 확인, 어시스턴트 턴 검색, 파일 잠금, 세션 소유권 획득, 조건부 결과물 포함 삭제입니다.

구현과 어댑터:

- `FileSessionStorage`: 실제 로컬 파일
- `MemorySessionStorage`: 비영구 세션과 테스트용 맵/청크 기반 메모리 저장소
- `IndexedSessionStorage`: Redis/SQL 기반 저장소의 공통 로컬 색인 및 순서 보장 원격 반영

`SessionStorageWriter`는 `append`, 선택적 `appendSync`, `flush`, 선택적 `flushSync`, `isOpen`, `close`, `getError`를 제공합니다.

### 수동 저장소 유지 관리

`omp gc`는 기본적으로 유지 관리 미리보기를 표시합니다. 참조 없는 블롭 정리, 조건을 만족하는 비활성 세션 보관, 데이터베이스 WAL 체크포인트, 오래된 상태 정리에는 `--apply`가 필요합니다. 저장소 유지 관리는 모델 컨텍스트 압축과 별개입니다.

세션 단계는 5분의 쓰기 유예 기간이 지난 대화 기록 재작성 임시 파일(`.<name>.jsonl.<snowflake>.tmp` 및 등록된 `--session` 파일 옆의 같은 패턴)도 제거합니다. 실행 중인 재작성은 수 밀리초 안에 임시 파일의 이름을 바꾸므로 오래된 파일은 종료되거나 충돌한 작성기가 남긴 것입니다.

오래된 상태 단계는 명시적으로 선택해야 합니다. `--stale` 또는 `gc.stale` 활성화(기본 꺼짐) 시에만 실행하므로 단순한 `omp gc --apply`는 보고서나 복제본을 삭제하지 않습니다. 세션 파일이 없어진 `custom-session-files` 마커와 터미널별 기록은 하루가 지나면 제거합니다. 지연 세션 마커는 첫 턴에만 기록되는 대화 기록을 가리킵니다. 새 `/new` 경계 기록은 항상 유지합니다. 대화 파일이 없어도 `--continue`가 이를 따르며, 세션 파일 생성 시 다시 기록하거나 터미널의 다음 세션이 대체합니다. 기본 에이전트 디렉터리 또는 부모를 설정 루트로 취급하는 `agent`라는 사용자 지정 디렉터리에서는 최신 `gc.staleRetainNewest`개(기본 20) 밖에 있고 `gc.staleRetainDays`일(기본 30)보다 오래된 디버그 보고서 묶음(`reports/*.tar.gz`) 및 Collab 게스트 복제본(`collab/*.jsonl`, 결과물 디렉터리, 사용자 지정 세션 마커)도 만료시킵니다. 터미널 기록이 가리키거나 실행 중 게스트가 열어 둔 복제본은 유지합니다. 오래된 상태를 블롭 정리 전에 제거하므로 만료 복제본만 참조하던 블롭도 같은 실행에서 정리합니다.

파일 압축 단계도 `--compress` 또는 `gc.compress`(기본 꺼짐)로 명시적으로 선택합니다. 대화 기록이 `gc.compressAfterDays`일(기본 7, `--compress-after-days`) 동안 유휴 상태이면 세션의 모든 파일(대화 기록과 결과물 트리)을 파일시스템의 투명 압축으로 저장하며 최근 기록한 파일은 건너뜁니다. 압축할 파일이 남은 세션에만 소유권 임대를 획득합니다. 실행 중 프로세스가 대화 기록 또는 결과물 트리 안의 중첩 대화 기록(파일 이름과 무관하게 세션 헤더로 판별하는 하위 에이전트 세션)을 임대 중이면 건너뛰고, 파일 재작성 동안 임대를 유지합니다. 보관과 달리 마지막 턴이 중단된 세션도 재개 가능하므로 대상입니다. 경로, 바이트, mtime이 바뀌지 않고 기록/통계 행도 삭제하지 않으므로 압축 세션은 계속 목록 조회, 재개, 검색할 수 있습니다. 링크가 하나이고 파일시스템 블록 하나보다 큰 일반 파일이 대상이며 이미 압축된 형식(`.gz`, `.zst`, 이미지)은 건너뜁니다. 세션 루트가 있는 볼륨에 따라 방식을 정합니다.

- **APFS (macOS):** 디렉터리 장치를 마운트 표의 `apfs` 항목과 비교하여 감지합니다. `ditto --hfsCompression`은 원본 옆의 새 `.omp-gc-compress-XXXXXX` 임시 디렉터리에 소유자 마커와 함께 압축 사본을 쓰며 원본 mtime을 나노초까지 유지합니다. 크기와 SHA-256이 같고 할당 공간이 줄어들 때만 원본을 교체합니다. 이름 변경 직전에 원본 inode, 크기, mtime이 선택 당시와 같고 링크도 여전히 하나여야 합니다. 대화 기록의 검사와 이름 변경은 추가 작업을 직렬화하는 세션 반영 잠금 아래 실행합니다. 종료된 실행이 남긴 임시 디렉터리는 다음 `--compress --apply`에서 세션/아카이브 루트 아래에서 제거합니다. 같은 이름이지만 소유자 마커가 없는 디렉터리는 비어 있을 때만 제거합니다. 통계 동기화와 대시보드 감시기는 `.omp-gc-compress-*`를 건너뛰어 임시 사본을 읽지 않습니다. 교체 파일은 새 inode이므로 다음 통계 동기화에서 압축 대화 기록을 처음부터 한 번 다시 읽고 기존 세션 행을 중복 없이 대체합니다. 압축 파일에 추가하면 비압축으로 돌아가며 이후 실행에서 다시 처리합니다.
- **NTFS (Windows):** `GetVolumeInformationW`가 NTFS와 파일별 압축 지원을 보고하는지 확인합니다. `compact /c`는 inode와 타임스탬프를 유지하면서 각 파일에 LZNT1 압축을 적용하며 이후 추가도 압축 저장합니다. 쓰기 시 전체 파일을 풀어야 하는 WOF(`compact /exe`)는 사용하지 않습니다.

다른 파일시스템에서는 이 단계를 지원하지 않는다고 표시합니다.

블롭 참조 검색, 아카이브 기록/통계 조정, gzip 생성, 롤백 중 저널 페이로드 I/O는 스트리밍합니다. 활성 `.jsonl`, 복구 가능한 `.jsonl.*.bak`, 보관된 `.jsonl.gz` 레코드는 모두 참조 탐색에 참여하며 잘못된 JSON 텍스트 안의 참조도 포함합니다. 압축 검색 결과로 삭제를 허용하기 전에 전체 스트림을 읽고 검증합니다. 아카이브를 풀면 원래 JSONL 바이트가 유지되며 결과물 트리도 기존 배치를 유지합니다.

스트리밍은 저널 전체를 메모리에 올리는 것을 피하지만 GC가 일정한 메모리만 사용한다는 뜻은 아닙니다. 긴 단일 레코드, 참조 집합, 기록/통계 식별자 모음은 여전히 메모리를 사용합니다. 아카이브 반영 중에는 원본 파일과 임시 압축 출력도 공존합니다.

## 세션 탐색 유틸리티

탐색 헬퍼는 `session-listing.ts`에 있으며 `SessionManager`는 프로젝트 범위 래퍼를 제공합니다.

- `getRecentSessions(sessionDir, limit?)` → 가벼운 시작 화면 메타데이터. 기본 한도 4
- `findMostRecentSession(sessionDir)` → mtime 기준 최신 세션
- `findMostRecentNonEmptySession(sessionDir)` → 재개 가능한 내용이 있는 최신 세션. `continueRecent`에서 사용
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` → 수명 주기 상태를 포함한 프로젝트 범위 목록
- `listSessionsReadOnly(...)` → 백업 복구 없이 동일한 메타데이터 제공
- `listAllSessions(storage)` / `SessionManager.listAll()` → 임의의 사용자 지정 디렉터리가 아닌 관리 세션 루트 아래 프로젝트 버킷
- `SessionManager.listForPicker(...)` / `listAllForPicker()` → 고정 항목 우선 목록. 제목/프롬프트가 없는 0턴 초기는 제거하지만 고정한 초기 세션은 선택 가능
- `resolveResumableSession(...)` → 로컬 조회 후 선택적 전역 대체 검색

`getRecentSessions()`는 파일 stat을 정렬한 뒤 먼저 `history.db`의 `session_titles` 색인에서 제목을 조회합니다. 색인되지 않은 파일은 내용을 검색하고 제목을 채웁니다. `findMostRecentSession()`은 앞부분 4 KiB를 읽습니다. 상태를 포함하는 전체/비어 있지 않은 세션 검색은 앞부분과 제한된 끝부분 32 KiB를 읽습니다. 검색은 stat을 키로 캐시하며 큰 전체 목록은 제한된 병렬 작업자를 사용합니다. 일반 디렉터리별 검색은 기본 JSONL이 없을 때 가장 최근의 고아 EPERM 백업도 복구합니다.

`SessionManager.list()`/`listAll()`은 고정 세션을 먼저 정렬하고 원시 목록 헬퍼는 최신순으로 정렬합니다. 빈 항목 필터는 선택기/이어가기에만 적용하고 ID 조회나 유지 관리에는 적용하지 않습니다. 재개 대상 비교는 대소문자를 구분하지 않으며 세션 ID 접두사, 전체 파일 이름 접두사, 타임스탬프 뒤의 ID 접미사를 허용합니다. 명시적 `sessionDir`는 `allowGlobalFallback: true`를 요청하지 않는 한 전역 대체 검색을 비활성화합니다.

## 관련 있지만 별개인 프롬프트 기록 저장소

`HistoryStorage`(`history-storage.ts`)는 세션 재생이 아닌 프롬프트 회상/검색을 위한 별도 SQLite 하위 시스템입니다.

- DB: `~/.omp/agent/history.db`
- 테이블: `history(id, prompt, created_at, cwd, session_id, use_count)`. `prompt`는 고유함
- FTS5 색인: `history_fts`. 삽입 트리거가 새 프롬프트를 색인
- 줄바꿈과 앞뒤 공백을 정규화한 뒤 데이터베이스 전체에서 프롬프트 중복 제거
- 다시 제출하면 최신 타임스탬프/cwd/세션 출처를 갱신하고 `use_count` 증가
- `add()`는 완료된 프로미스를 반환하기 전에 동기적으로 기록하며 실패는 예외 대신 로그에 기록
- 같은 DB에는 독립적인 `session_titles`와 추가 전용 `session_recaps` 테이블도 있음. 유휴 요약은 세션 JSONL이나 모델 컨텍스트에 들어가지 않음

대화 그래프/상태 재생에는 세션 파일을, 프롬프트 기록 UX에는 `HistoryStorage`를 사용하세요.
