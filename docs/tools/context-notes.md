# context_notes

> 현재 분기의 영속적인 실험용 컨텍스트 노트를 읽거나 교체합니다.

## 소스

- 진입점: `packages/coding-agent/src/tools/context-notes.ts` (`ContextNotesTool`)
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/context-notes.md`
- 노트 투영: `packages/coding-agent/src/session/context-notes.ts`
- 등록: `packages/coding-agent/src/tools/index.ts`

## 등록 / 노출

- `compaction.experimentalContextManagement = true`, 폐기되지 않은 세션, 그리고 도구 세션의 소유자 ID와 ID가 일치하는 세션 저널이 필요합니다.
- 설정 기본값은 `false`입니다. `/settings` → Context → Compaction에서 **Notes-backed context windows (experimental)**를 켜세요. 일반적인 실행 중 세션은 즉시 도구 구성을 조정합니다. 제한된 세션은 호스트가 제공한 도구 목록을 유지합니다.
- 메타데이터: `strict = true`, `loadMode = "essential"`. `text` 속성이 없는 호출은 읽기 승인을 요청하고, 이 속성이 있는 호출은 쓰기 승인을 요청합니다.
- 노트 기반 전환에는 `context_notes`, `new_context`, `read`, `grep` 네 도구가 모두 활성 상태여야 합니다.

## 입력

| 필드 | 타입 | 필수 | 설명 |
| ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `text` | `string` | 아니요 | 노트 전체를 교체할 내용입니다. 읽으려면 생략하고, 지우려면 빈 문자열을 사용합니다. 쓰기는 표시된 노트에 추가하는 것이 아니라 교체합니다. |

## 출력

- 읽기: 가장 최근에 표시되는 노트 텍스트를 반환하며, 없으면 `No context notes are stored for this session branch.`를 반환합니다. 세부 정보에는 `text`와, 노트가 있으면 해당 노트의 `entryId`가 포함됩니다.
- 쓰기: `Context notes saved.`를 반환합니다. 세부 정보에는 `entryId`, 저장된 `text`, UTF-8 바이트 수인 `bytes`가 포함됩니다.

## 흐름 및 부수 효과

1. 현재 소유 저널을 확인하고 취소 여부를 검사합니다.
2. 읽기는 활성 분기에서 최신 노트 리비전을 투영합니다.
3. 쓰기는 바이트 한도를 검증하고 소유자와 분기 말단을 캡처한 뒤 디스크 준비를 기다립니다.
4. 취소 여부, 세션 소유권, 기능 사용 가능 여부, 분기 말단을 다시 검사한 뒤 `{ version: 1, text }`를 담은 `experimental_context_notes` 사용자 정의 항목을 추가합니다.
5. 성공을 반환하기 전에 저널을 플러시합니다.

비어 있지 않은 최신 유효 노트는 실험용 컨텍스트 재구성에 포함되며 컨텍스트 전환 및 디스크에서의 재개 후에도 유지됩니다. 유효하지 않은 과거 노트 항목은 이전의 유효한 리비전을 가리지 않고 건너뜁니다. 컨텍스트 초기화는 이전 노트 리비전을 숨깁니다. 노트를 지우면 빈 리비전을 추가하며 이전 저널 항목은 삭제하지 않습니다. 노트 텍스트와 복구된 기록은 검증하기 전까지 신뢰할 수 없는 과거 데이터로 취급하세요.

## 제한 및 오류

- 최대 노트 크기: **16,384 UTF-8바이트**. 한도를 초과한 쓰기는 항목을 추가하기 전에 실패합니다. 노트를 줄이고 `read` 또는 `grep`으로 `history://current/full`에서 근거 세부 정보를 복구하세요.
- 비활성화되거나 폐기되었거나 소유자가 일치하지 않는 세션은 `ToolError`로 실패합니다.
- 디스크 준비 중 분기가 바뀌면 다른 분기에 저장하지 않고 쓰기를 거부합니다.
- 취소 및 영속화 오류는 호출자에게 전파됩니다.

컨텍스트 전환은 [new_context](new-context.md)를, 실험용 유지 관리 수명 주기는 [압축 및 분기 요약](../compaction.md)을 참고하세요.
