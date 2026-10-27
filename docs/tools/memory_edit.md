# memory_edit

> ID로 Mnemopi 장기 기억을 갱신하거나 삭제하거나 무효화합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/memory-edit.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/memory-edit.md`
- 연관 백엔드: `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory(...)`)

## 등록 / 노출
- 도구 메타데이터는 `approval = "read"`, `strict = true`, `loadMode = "discoverable"`입니다. 성공한 호출이 로컬 기억을 변경하더라도 동일합니다.
- 등록에는 `memory.backend = "mnemopi"`가 필요합니다. `"off"`, `"local"`, `"hindsight"`에서는 도구가 제공되지 않습니다.
- 명시적인 도구 목록이 있는 비제한 세션에서는 등록 시 Mnemopi용 `memory_edit`를 자동으로 포함합니다. 제한된 목록은 확장하지 않습니다.
- 일반적인 `tools.xdev` 세션에서는 검색 가능한 내장 도구가 `xd://memory_edit`로 표시될 수 있습니다. 명시적으로 요청한 도구는 최상위에 유지됩니다.
- 실행은 동기식 단일 실행이며, 진행 콜백이나 취소 매개변수가 없습니다.

## 입력

| 필드 | 유형 | 필수 | 설명 |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | 예 | 적용할 편집 작업. |
| `id` | `string` | 예 | `recall`이 반환한 기억 ID. |
| `content` | `string` | 아니요 | `update`에서 사용할 대체 기억 텍스트. |
| `importance` | `number` | 아니요 | `update`에서 사용할 대체 중요도. `0..1`로 제한됩니다. |
| `replacement_id` | `string` | 아니요 | `invalidate`에서 기록할 대체 기억의 ID. |

## 출력
- `content[0].type = "text"`
- 변경에 성공하면 `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`를 표시합니다.
- 알 수 없거나 해당 작업을 적용할 수 없는 ID는 `Memory <id> was not found...`로 표시합니다. 상태가 `not_found`인 정상 결과입니다.
- 사실 ID는 `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`로 표시합니다. 상태가 `not_editable`인 정상 결과입니다.
- `details`는 `{ status, bank?, store? }`입니다. status는 `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"`이며, 행을 찾은 경우 store는 `"working" | "episodic" | "fact"`입니다.

## 흐름
1. `MemoryEditTool.createIf(...)`는 `memory.backend == "mnemopi"`인 경우에만 도구를 노출합니다.
2. `execute(...)`는 `session.getMnemopiSessionState()`를 가져오며, 백엔드가 초기화되지 않았다면 실패합니다.
3. `update`에는 `content` 또는 `importance`가 하나 이상 필요합니다.
4. 백엔드를 호출하기 전에 `importance`를 `0..1`로 제한합니다.
5. 도구는 `state.editScopedMemory(op, id, { content, importance, replacementId })`를 호출합니다.
6. 백엔드는 중복을 제거한 저장 대상, 회상 대상, 전역 대상을 순서대로 검색합니다. 편집에 성공한 첫 결과를 반환하며, 없으면 찾았지만 작업을 적용할 수 없는 첫 결과를, 그것도 없으면 `not_found`를 반환합니다.
7. 도구는 반환된 상태를 표시하고 백엔드 결과를 변경 없이 `details`에 전달합니다.

## 모드 / 변형
- `update`는 작업 기억의 텍스트 또는 중요도를 교체합니다. 콘텐츠는 패치가 아니라 전체 교체이며, 저장 전에 `redactMemorySecrets(...)`를 거칩니다.
- `forget`은 작업 기억 행을 영구 삭제합니다.
- `invalidate`는 작업 기억 또는 일화 기억 행을 삭제하지 않고 대체된 것으로 표시하며, `replacement_id`를 기록할 수 있습니다.
- 사실 행은 읽을 수 있지만 변경할 수 없습니다. 모든 작업이 `not_editable`을 반환합니다.
- 일화 기억 ID에 대한 `update`/`forget`은 해당 뱅크/저장소 위치와 함께 `not_found`를 반환합니다. 두 작업은 작업 기억만 지원하기 때문입니다.

## 부수 효과
- 파일 시스템: 찾은 행이 들어 있는 로컬 Mnemopi SQLite 데이터베이스를 변경합니다. 저장용, 회상용, 공유 또는 안전하게 발견된 레거시 뱅크일 수 있습니다.
- 네트워크: 없습니다. 편집 작업은 임베딩 또는 추출 제공자를 호출하지 않습니다.
- 세션 상태: 활성 세션의 범위별 Mnemopi 상태를 읽습니다. 이미 주입된 `<memories>` 컨텍스트를 다시 쓰지는 않습니다.

## 제한 및 상한
- 사용하려면 `memory.backend = "mnemopi"`가 필요합니다. Hindsight와 로컬 파일 기반 기억에서는 이 도구를 제공하지 않습니다.
- `id`를 직접 제공해야 합니다. 도구는 콘텐츠로 검색하지 않습니다.
- 회상 미리보기는 기본적으로 500자로 제한됩니다. `update` 전에 항상 `read memory://<id>`를 실행하세요. 이 URL은 호출 세션의 범위별 뱅크에서 전체 행을 가져옵니다.
- `content`와 `importance`가 모두 없는 `update`는 백엔드에 쓰기 전에 거부됩니다.
- `0..1` 밖의 `importance` 값은 거부하지 않고 범위 안으로 제한합니다.

## 오류
- 도구가 노출되었지만 세션 상태가 없으면 `Mnemopi backend is not initialised for this session.`을 던집니다.
- 빈 갱신에는 `memory_edit update requires content or importance.`를 던집니다.
- 없는 ID, update/forget 대상인 일화 기억 ID, 사실 ID는 예외가 아니라 정상 결과입니다. `details.status`를 확인하세요.
- 세션의 뱅크에 해당 행이 없으면 `read memory://<id>`는 `Mnemopi memory <id> not found in the calling session's scoped bank`를 던집니다. 다른 활성 세션에만 있는 행에는 접근할 수 없습니다.

## 참고
- 갱신할 때마다 먼저 `memory://<id>` 전체 행을 읽으세요. 잘린 회상 미리보기를 `content`에 복사하면 보이지 않는 뒷부분이 삭제됩니다.
- 이력이 여전히 유용할 수 있는 오래된 작업/일화 기억에는 `invalidate`를 우선 사용하세요.
- 작업 기억 행을 완전히 삭제해야 할 때만 `forget`을 사용하세요.
