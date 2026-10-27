<a id="magic-keywords"></a>
# 매직 키워드

매직 키워드는 사용자 프롬프트의 일반 문장에 독립적으로 쓰이는 단어로, 해당 턴에 사용자 명의의 숨겨진 지침을 추가할 수 있습니다. 알림 삽입은 기본적으로 활성화되어 있습니다. TUI는 편집기에 포커스가 있을 때 인식된 단어에 애니메이션을 적용하고, 전송된 메시지에서는 정적인 강조 표시를 보여 줍니다. 전역 스위치를 비활성화하면 편집기 애니메이션과 숨겨진 알림은 중단되지만, 정적 강조 표시와 맞춤법 검사 예외는 유지됩니다. 인식된 단어는 macOS의 맞춤법 자동 수정 및 오타 밑줄 표시 대상에서 제외되므로, `workflowz`와 `jevify`가 사전에 있는 단어로 바뀌는 일은 없습니다.

트리거 단어, 그라데이션, 설정 문구, 필수 도구, 알림을 포함한 전체 목록은 `packages/coding-agent/src/modes/magic-keywords.ts`의 단일 테이블에 정의되어 있습니다. 그 외의 모든 영역(설정, 알림 삽입, 편집기 강조 표시)은 이 테이블을 바탕으로 동작합니다.

<a id="keywords"></a>
## 키워드

| 키워드        | 효과 |
| ------------- | ---- |
| `ultrathink`  | 신중한 다단계 추론 알림을 추가합니다. 자동 추론이 활성화된 경우, 해당 턴에는 `providers.autoThinkingMaxEffort`를 우회하여 현재 모델이 지원하는 가장 높은 추론 강도를 선택합니다. |
| `orchestrate` | 다중 에이전트 오케스트레이션 규약을 추가합니다. 전체 작업의 범위를 정하고, 상당한 규모의 독립적인 작업을 병렬로 위임하고, 각 단계를 검증하며, 요청이 완료될 때까지 계속 진행하도록 합니다. 이 알림을 사용하려면 `task`가 활성화되어 있어야 하며, 알림에는 사용 가능한 도구만 명시됩니다. |
| `workflowz`   | 영속적인 `eval` 커널의 `agent()`, `completion()`, 핸들, `wait()`, `workpool()` 헬퍼를 중심으로 하는 결정론적 다중 하위 에이전트 워크플로 규약을 추가합니다. 광범위한 조사, 검토, 마이그레이션, 적대적 검증 범위를 다루는 용도입니다. 알림은 `eval`과 `task`가 모두 활성화된 경우에만 삽입됩니다. |
| `jevify`      | `eval` 커널의 `judge()` 헬퍼를 위한 대량 분류 규약을 추가합니다. 데이터를 불러오기 전에 질문, 평가 기준, 사전 필터, 심층 검토로 넘길 임계값을 확정하고, 모든 항목을 한 배치에서 판정한 뒤, 판정 도구가 표시한 항목만 읽도록 합니다. 커밋/PR 감사, 로그 분류, 예/아니요 판정이나 범주 분류가 필요한 길고 동질적인 목록을 처리하는 용도입니다. 알림은 `eval`이 활성화된 경우에만 삽입됩니다. |

프롬프트의 일반 문장 어디에나 키워드를 사용할 수 있습니다.

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

jevify commit a17c3e0 for changes unrelated to the tui refactor
```

<a id="matching-rules"></a>
## 일치 규칙

소스 코드와 경로가 에이전트의 동작을 우발적으로 바꾸지 않도록, 일치 여부를 엄격하게 판정합니다.

- 정확한 소문자 표기를 사용해야 합니다. `Ultrathink`, `Orchestrate`, `Workflowz`, `Jevify`는 트리거되지 않습니다.
- 키워드는 일반 문장에서 독립적으로 쓰여야 합니다. 문장 부호와 따옴표는 키워드에 붙어 있어도 되지만, 문자, 숫자, 밑줄, 슬래시, 역슬래시, 하이픈, 파일 확장자, 심볼 참조, 호출 구문과 결합된 경우에는 일치하지 않습니다. 예를 들어 `orchestrate,`는 일치하지만, `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, `orchestrate()`는 일치하지 않습니다.
- 울타리 코드 블록(백틱 또는 물결표), 인라인 코드 구간, HTML/XML 주석·태그·요소와 그 안의 내용은 무시됩니다.
- 하나의 프롬프트에서 활성화된 모든 키워드는 각각 자신의 알림을 추가할 수 있습니다. 표시되는 단어는 사용자 메시지에 그대로 남으며, 숨겨진 알림은 사용자 명의의 표시되지 않는 사용자 지정 메시지입니다.
- 일치 판정은 슬래시 명령과 프롬프트 템플릿이 확장된 후의 프롬프트를 사용합니다. 에이전트가 시작한 합성 프롬프트는 알림을 트리거하지 않습니다.
- 지침은 키워드가 포함된 턴에만 적용됩니다.

<a id="configuration"></a>
## 설정

`/settings`를 열고 **상호작용 → 매직 키워드**를 사용하거나, 셸에서 설정을 변경하세요.

```bash
# 모든 매직 키워드 비활성화
omp config set magicKeywords.enabled false

# 다른 키워드는 활성화한 채 개별 키워드 비활성화
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
omp config set magicKeywords.jevify false
```

전역 스위치와 키워드별 스위치 4개의 기본값은 `true`입니다. 전역 스위치는 모든 숨겨진 알림과 편집기 애니메이션을 제어하며, 키워드별 스위치는 해당 알림만 제어합니다(ultrathink의 자동 추론 강도 최댓값 재정의도 포함). 정적 강조 표시와 맞춤법 검사 예외는 유지됩니다. `workflowz`는 설정 키 `magicKeywords.workflow`를 사용하며, 해당 알림은 활성 작업 배치 처리 방식, scout 가용 여부, Eval 커널 도구 설정에 맞춰 조정됩니다. 모든 설정과 현재 값을 확인하려면 `omp config list`를 실행하세요. 설정 범위, 우선순위, 프로젝트 로컬 재정의에 대해서는 [설정](./settings.md)을 참조하세요.
