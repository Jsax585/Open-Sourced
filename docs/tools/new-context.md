# new_context

> 현재 노트북과 복구 가능한 브랜치 이력을 보존하면서 새로운 실험적 컨텍스트 창을 요청합니다.

## 소스

- 진입점: `packages/coding-agent/src/tools/context-notes.ts` (`NewContextTool`)
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/new-context.md`
- 요청 처리: `packages/coding-agent/src/session/agent-session.ts`
- 전환 수명 주기: `packages/coding-agent/src/session/session-maintenance.ts`
- 등록: `packages/coding-agent/src/tools/index.ts`

## 등록 / 노출

- `compaction.experimentalContextManagement = true`, 폐기되지 않은 세션, 도구 세션의 소유자 ID와 ID가 일치하는 세션 저널이 필요합니다.
- 설정의 기본값은 `false`입니다. `/settings` → Context → Compaction에서 **노트 기반 컨텍스트 창(실험적)**을 활성화하면 실행 중인 세션에 도구가 즉시 추가됩니다.
- 메타데이터: `approval = "write"`, `strict = true`, `loadMode = "essential"`.
- 노트 기반 전환에는 `context_notes`, `new_context`, `read`, `grep` 도구 네 개가 모두 활성화되어 있어야 합니다. 지원되지 않는 도구 구성에서는 기존 압축 동작을 유지합니다.

## 입력

빈 객체 `{}`입니다. 이 도구는 지침, 노트북 텍스트, 대상 세션 ID를 받지 않습니다. 전환을 요청하기 전에 [context_notes](context-notes.md)로 작업 노트북을 저장하세요.

## 출력

- 텍스트: `New context window requested.`
- 세부 정보: `{ requested: true }`.

이 결과는 요청이 접수되었음을 알립니다. 도구 자체가 압축 경계를 확정하거나 대화를 동기적으로 초기화하지는 않습니다.

## 흐름과 부수 효과

1. 소유 세션의 유효성을 검증하고 취소 여부를 확인합니다.
2. 현재 턴에 한정된 전환 요청을 반환합니다.
3. 소유 에이전트는 쓰기 장치 결과를 포함한 성공한 도구 결과를 받아들이고, 다음 제공자 요청 전에 유지 관리 수명 주기를 통해 요청을 처리합니다.
4. 실험적 수명 주기는 재귀적 요약을 추가로 생성하지 않고 일반 압축 경계를 확정합니다. 최신 노트북과 보존된 최근 메시지로 활성 컨텍스트를 다시 구성하며, 원본 저널 항목은 `history://current/full`을 통해 계속 이용할 수 있습니다.

명시적인 `new_context` 요청은 Auto-Compact 토글을 우회합니다. 전환에는 여전히 실험적 기능과 유지 관리 보호 조건이 적용됩니다. 확정 전에 세션, 브랜치, 모델, 취소 여부, 활성 도구 변경 사항을 다시 검증합니다. 요청 접수 후 기능이 사라지면 요약 제공자 기반 압축으로 대체하지 않고 오래된 요청을 버립니다.

## 제한과 오류

- 비활성화되었거나 폐기되었거나 소유자가 일치하지 않는 도구 세션은 `ToolError`로 실패합니다.
- 요청을 반환하기 전에 취소 여부를 확인합니다.
- 유지 관리 수명 주기는 취소, 확장 훅, 동시 압축, 오래된 세션 또는 브랜치 상태를 처리합니다. 도구 요청이 성공했다고 해서 이후 전환이 확정되었다는 뜻은 아닙니다.
- 이 도구는 새 세션을 만들거나 작업 파일을 변경하거나 원시 저널 이력을 삭제하지 않습니다.

자동 전환, 노트북 알림, 수동 압축 동작은 [압축과 브랜치 요약](../compaction.md)을 참조하세요.
