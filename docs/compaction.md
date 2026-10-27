# 컨텍스트 압축과 분기 요약

컨텍스트 압축과 분기 요약은 이전 작업 맥락을 잃지 않고 긴 세션을 계속 사용할 수 있게 하는 두 가지 방식입니다.

- **컨텍스트 압축**은 현재 분기의 오래된 기록을 요약으로 재작성합니다.
- **분기 요약**은 `/tree` 탐색 중 떠나는 분기의 맥락을 기록합니다.

둘 다 세션 항목으로 저장하며 LLM 입력을 재구성할 때 사용자 컨텍스트 메시지로 변환합니다.

## 주요 구현 파일

- `packages/agent/src/compaction/compaction.ts`(컨텍스트 전체 요약과 인계 생성)
- `packages/snapcompact/src/snapcompact.ts`(snapcompact 전략: 기록을 고밀도 비트맵 이미지로 보관)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts`(제공업체 네이티브 스트리밍 압축)
- `packages/agent/src/compaction/shake.ts`(기계적 콘텐츠 생략)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/agent/src/compaction/messages.ts`(공통 LLM 변환과 요약 래퍼)
- `packages/coding-agent/src/session/session-context.ts`(컨텍스트와 대화 기록 구성)
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`(자동 유지 관리 조정)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/session/context-settings.ts`(`compaction.*`, `snapcompact.*`, `branchSummary.*` 정의)

## 세션 항목 모델

컨텍스트 압축과 분기 요약은 일반 어시스턴트/사용자 메시지가 아닌 독립적인 세션 항목입니다.

- `CompactionEntry`
   - `type: "compaction"`
   - `summary`, 선택적 `shortSummary`
   - `firstKeptEntryId`(압축 경계)
   - `tokensBefore`
   - 선택적 `details`, `preserveData`, `fromExtension`
   - 선택적 `method`, `tokensAfter`, `warning`(유지 관리/표시 메타데이터)
   - 선택적 `providerReplayThroughEntryId`(네이티브 재생 스냅샷이 포함하는 마지막 항목)
- `BranchSummaryEntry`
   - `type: "branch_summary"`
   - `fromId`, `summary`
   - 선택적 `details`, `fromExtension`

컨텍스트를 재구성하면(`buildSessionContext`):

1. 활성 경로의 최신 압축을 `compactionSummary` 메시지 하나로 변환합니다.
2. `firstKeptEntryId`부터 압축 지점까지 유지한 항목을 다시 포함합니다.
3. 경로의 이후 항목을 추가합니다.
4. `branch_summary`를 `branchSummary` 메시지로 변환합니다.
5. `custom_message`를 `custom` 메시지로 변환합니다.

이 사용자 지정 역할은 `convertToLlm()`에서 LLM용 메시지로 바꿉니다. `compactionSummary`와 `branchSummary`는 다음 정적 템플릿으로 렌더링한 사용자 메시지가 됩니다.

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`
- `packages/agent/src/compaction/prompts/handoff-summary-context.md`(`method === "handoff"`일 때)

순서 있는 아카이브 블록을 가진 Snapcompact 요약은 래퍼를 거치지 않고 도입문과 아카이브 블록을 직접 보냅니다. `custom` 메시지는 일반적으로 요약 템플릿 없이 원시 내용을 developer 메시지로 전달합니다.

네이티브 재생에는 일치하는 제공업체와 활성 모델의 Responses 계열 API도 필요합니다. 별도 네이티브 압축 엔드포인트가 있다고 Chat Completions나 Anthropic 인코더가 그 출력을 사용할 수 있는 것은 아닙니다.

향후 네이티브 압축을 꺼도 기존 페이로드의 일반 재생은 꺼지지 않습니다. 압축 준비는 더 엄격한 별도 재사용 정책을 따릅니다. 로컬 요약은 불투명한 자리표시자를 읽을 수 있는 요약으로 간주하지 않고 원본 메시지를 다시 펼쳐야 합니다.

## 컨텍스트 압축 파이프라인

### 실행 조건

컨텍스트 압축/유지 관리는 여섯 방식으로 실행합니다.

1. **수동 압축**: `/compact [instructions]`가 `AgentSession.compact(...)`를 호출합니다.
2. **자동 오버플로 복구**: 같은 모델의 어시스턴트 오류가 컨텍스트 초과에 해당할 때 실행합니다.
3. **자동 불완전 출력 복구**: 같은 모델의 메시지가 `stopReason === "length"`로 끝나면 실행합니다(OpenAI/Codex `response.incomplete`, Anthropic 출력/컨텍스트 제한 포함). 아래 출력 한도 검사도 적용합니다.
4. **자동 임계값 유지 관리**: 성공한 턴 뒤 컨텍스트가 결정된 임계값을 넘으면 실행합니다.
5. **턴 도중 임계값 유지 관리**: 도구 루프 턴이 임계값을 넘고 `compaction.midTurnEnabled !== false`이면 다음 제공업체 요청 전에 실행합니다. 하위 에이전트는 항상 검사합니다. 전체 할당이 한 턴이므로 턴 후에만 검사하면 실행이 이미 끝난 뒤라서 `createSubagentSettings`가 자식의 `compaction.midTurnEnabled`를 켭니다.
6. **유휴 유지 관리**: `runIdleCompaction()`이 사유 `"idle"`로 같은 자동 경로를 호출할 수 있습니다.

### 압축 구조 도식

```text
압축 전:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            유지할 메시지
                                   ↑
                          firstKeptEntryId (항목 4)

압축 후(새 항목 추가):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 LLM에 보내지 않음                   LLM에 전송
                                                         ↑
                                              firstKeptEntryId부터 시작

LLM이 보는 내용:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    프롬프트   cmp에서 생성          firstKeptEntryId 이후 메시지
```

### 오버플로/불완전 출력 복구와 임계값/유휴 유지 관리

자동 경로는 의도적으로 다르게 동작합니다.

- **오버플로 복구**
   - 조건: 현재 모델의 어시스턴트 오류가 컨텍스트 초과로 감지되며 최신 압축보다 오래되지 않았을 때
   - 재시도 전 실패한 어시스턴트 오류 메시지를 활성 상태에서 제거합니다.
   - 컨텍스트 승격을 먼저 시도하며 설정된 더 큰 모델이 있으면 압축 없이 모델을 전환하고 재시도합니다.
   - 승격할 수 없고 압축이 켜져 있으면 `reason: "overflow"`, `willRetry: true`로 `compaction.methodOrder`를 순회합니다. 인계 요청은 초과한 입력을 재사용하므로 건너뜁니다.
   - 성공하면 턴 재시도를 위해 `agent.continue()`를 예약합니다.

- **불완전 출력 복구**
   - 조건: 같은 모델의 메시지가 `stopReason === "length"`로 끝나고 최신 압축보다 오래되지 않았을 때
   - 컨텍스트 창이 압축 임계값 미만이고 턴에 텍스트나 도구 호출이 있으면 잘린 턴을 유지하고 출력 한도 경고를 표시합니다. 압축은 출력 한도를 늘리지 못합니다.
   - 그 외에는 불완전 어시스턴트를 활성 상태에서 제거하고 컨텍스트 승격을 먼저 시도합니다.
   - 유지 관리가 켜져 있으면 임계값 미만의 무출력 턴은 압축 없이 재시도합니다. 추론만 하다가 출력 한도로 멈춘 경우에는 더 작은 단계로 행동하라는 developer 알림도 제공합니다.
   - 임계값 이상이거나 창 크기가 불명확하면 `reason: "incomplete"`, `willRetry: true`로 방법 순서를 순회합니다. 오버플로와 달리 입력은 사용 가능하므로 실행 가능한 `handoff`를 사용할 수 있습니다.
   - 텍스트나 도구 호출 없는 연속 복구는 세 번으로 제한합니다. 새 사용자 입력이나 실행 가능한 출력은 횟수를 초기화합니다. 한도에 도달하면 자동 이어가기를 막고 조치 가능한 실패를 알립니다.
   - 복구 성공 시 이어가기를 예약합니다.

- **임계값 유지 관리**
   - 조건: 오류 없는 성공 메시지의 조정 컨텍스트 토큰이 `resolveThresholdTokens(...)`를 넘을 때. `calculateContextTokens(...)`는 청구되지만 대화 접두사로 재생하지 않는 제공업체 조정 토큰을 빼므로 압축/승격 임계값이 부풀지 않습니다.
   - `compaction.midTurnEnabled !== false`이면 다음 요청 전 안전한 도구 루프 경계도 검사합니다.
   - 최초 조건은 저장된 대화 추정치 이상으로 조정된 제공업체 사용량을 사용합니다. 가지치기는 방금 청구된 프롬프트를 소급해 줄이지 않습니다. 회수 토큰은 이후 유지 관리 대상에 반영합니다. 최신 압축 전 사용량 대신 실시간 저장 추정치를 사용합니다.
   - 턴 후 압축 전에 컨텍스트 승격을 시도합니다.
   - 승격할 수 없으면 `reason: "threshold"`, `willRetry: false`로 방법 순서를 순회합니다.
   - `handoff`를 포함한 모든 방식은 인라인 실행합니다. 턴 후 유지 관리는 `agent_end`가 확정되기 전에 인계 문서를 만들고 압축 항목으로 커밋하므로 `willContinue`/`yielded`가 실제 예약 여부를 반영합니다.
   - 성공하고 `compaction.autoContinue !== false`이면 턴 후 유지 관리가 `prompts/system/auto-continue.md`의 에이전트 작성 developer 자동 이어가기 프롬프트를 예약합니다. 턴 도중 유지 관리는 핵심 루프가 다음 요청을 담당하므로 별도 이어가기를 예약하지 않습니다.

- **유휴 유지 관리**
   - 조건: 스트리밍/압축 중이 아닐 때 `runIdleCompaction()`이 실행됩니다. 요약과 캐시 예열 재생이 경합하지 않도록 대기 예열 갱신부터 취소합니다. 대화형 유휴 타이머는 턴이 빈 입력으로 끝나고 컨텍스트가 `compaction.idleThresholdTokens` 이상일 때 준비합니다. 응답이 장기(1시간, Anthropic 장기 보존) 캐시 읽기/쓰기를 확인했으면 마지막 요청 또는 예열 적중 후 `min(90% of TTL, TTL − 10s)`인 갱신 시점(약 54분)보다 5초 먼저 실행하여 요약 요청도 캐시 접두사를 읽게 합니다. 그 시점을 넘고 만료 전 끝난 턴은 즉시 압축합니다. 5분 캐시는 턴 직후 너무 빨리 만료되어 그 일정에 압축할 가치가 없으므로 타이머 기준으로 삼지 않습니다. 이 경우나 수명이 불명확하거나 이미 만료되었으면 `compaction.idleTimeoutSeconds`를 기다립니다.
   - 단기 캐시의 의도된 절충: 대체 지연은 턴 종료부터, 캐시 수명은 요청 전송부터 계산하므로 기본 300초 지연의 유휴 요약은 5분 캐시가 만료된 뒤 전체 접두사를 새로 읽는 비용을 냅니다. 짧은 휴식이 압축을 유발하지 않도록 허용한 동작입니다. `compaction.idleTimeoutSeconds`를 줄이면(최소 60초) 캐시 수명 안에 실행할 수도 있습니다.
   - `reason: "idle"`을 사용하며 이후 자동 이어가기를 하지 않습니다.

### 페이로드 거부 보호

HTTP 413/페이로드 거부를 자동으로 토큰 초과로 취급하지 않습니다. 알려진 창에 로컬 추정 여유가 10% 이상이고 제공업체 입력 사용량이 창 안에 있거나, 사용량으로 입증된 초과 없이 명시적 이미지 한도 근거가 있으면 자동 이어가기를 막고 승격/압축 대신 페이로드 예산 경고를 냅니다.

사용량이 토큰 초과를 입증하면 컨텍스트를 줄일 수 있습니다. 바이트/미디어 형태의 거부에서는 명시적 미디어 한도 근거 없이 사용량이 토큰 초과를 입증하지 않는 한 Snapcompact를 제외합니다. 창 크기가 불명확하면 실행 가능한 초과 복구 방식을 시도할 수 있습니다. 실행 불가 또는 진전 없는 복구는 같은 기록 재전송 대신 자동 이어가기를 막습니다.

<a id="experimental-notes-backed-context-windows"></a>
### 실험적 노트 기반 컨텍스트 창

`/settings`에서 **노트 기반 컨텍스트 창(실험적)**을 켜면 실행 중 세션에 도구가 즉시 추가됩니다. 같은 설정은 다음과 같습니다.

```yaml
compaction:
   experimentalContextManagement: true
```

이 선택 모드는 자동 요약 재압축을 로컬 컨텍스트 창 경계로 대체합니다. 명시적 모드나 집중 지시가 없는 `/compact`에도 적용합니다. 명시적 압축 모드와 집중 지시는 기존 동작을 유지합니다.

- `context_notes`는 `text`가 없으면 노트를 읽고, 있으면 대체하며, `text: ""`이면 지웁니다.
- 노트 버전은 활성 분기의 저널 항목입니다. 재개/포크 후에도 현재 보이는 최신 버전만 모델 컨텍스트에 주입합니다. 컨텍스트 초기화는 보이는 노트를 지웁니다. 대체 한도는 **16,384 UTF-8바이트**이며 초과 쓰기는 기존 노트를 바꾸지 않고 실패합니다.
- `new_context`는 다음 안전한 도구 루프 경계에서 창 전환을 요청합니다. 요약 모델을 호출하지 않고 완전한 최근 도구 호출/결과 단위와 노트를 유지합니다. 자동 임계값 근처에서는 작업 상태 저장을 창마다 한 번 알립니다.
- `read`와 `grep`은 `history://current/full`에서 원본 메시지와 도구 출력을 복구할 수 있습니다. 텍스트는 안정적인 항목 ID와 창 경계를 포함합니다. 공통 선택자(예: `history://current/full:1-200`, `history://current/full:raw:1-200`)를 지원합니다. 쿼리, 프래그먼트, 끝 슬래시, 추가 경로 구성요소는 거부합니다.
- 전체 기록 경로는 호출 세션의 현재 분기에 묶여 있으며 다른 등록 에이전트나 디스크 검색으로 대체하지 않습니다. 기존 `history://<id>`는 간결한 대화 기록 동작을 유지합니다.

실험적 전환에는 유효 도구 집합에 `context_notes`, `new_context`, `read`, `grep`이 모두 있어야 합니다. 제한 세션에 네 도구가 모두 없으면 기존 유지 관리를 사용합니다. 설정을 끄면 기존 압축으로 돌아가고 실험 도구와 전체 기록 경로를 끕니다. 기존 노트는 저널과 제공업체 컨텍스트에 남습니다.

기본값은 `false`입니다. 기존 세션 저널만을 대화 저장소로 사용하는 영속 노트 및 검색 가능한 기록의 독립 구현입니다.[^experimental-context-history]

[^experimental-context-history]:
    설정을 켜도 이전 가지치기나 명시적 파괴적 기록 작업을 되돌릴 수 없습니다. 텍스트 기록에서 이미지는 마커로 표현합니다. 노트 품질과 적시 갱신은 모델 책임이며 누락된 노트를 자동 생성하지 않습니다.

### Shake 방식

`compaction.methodOrder`에 `shake`를 넣으면 요약 모델 호출 대신 인라인 로컬 축소를 수행합니다. 최근 토큰 보호 창과 최소 절감 임계값을 적용하여 대상 도구 결과 및 큰 fenced/XML 블록을 복구 가능한 `artifact://` 참조로 바꿉니다. 자동 shake는 `action: "shake"`로 일반 자동 압축 이벤트를 내보냅니다.

shake로 복구 구간 아래까지 충분히 줄이지 못하면 임계값, 불완전 출력, 오버플로 복구는 다음 설정 방식으로 넘어가 무효 shake 반복을 방지합니다. 유휴 shake는 타이머가 다음 실행 전 사용량을 재검사하므로 대체하지 않습니다. 수동 `/shake`는 전체 대상 기록을 지정할 수 있는 더 적극적인 별도 명령입니다.

### Snapcompact 방식

`compaction.methodOrder`에 `snapcompact`를 넣으면 LLM 요약 호출을 로컬 결정적 보관 처리(`@oh-my-pi/snapcompact`의 `compact`)로 대체합니다.

- 버릴 기록을 직렬화하고 공백을 합친 뒤 기본 제공 퍼블릭 도메인 픽셀 글꼴로 모델에 맞춘 PNG 프레임에 그립니다. 프레임 너비는 형태별로 고정하고 높이는 실제 출력한 줄 수에 맞춥니다. 측정된 모델 계열은 **모델 ID**로 형태와 프레임 크기를 결정합니다. Claude는 11px 자간의 X.org `8x13` 글리프를 읽습니다(추가 자간, 검은 글자 `11on16-bw`). 고해상도 계열인 Opus 4.7+·Fable·Mythos에는 Anthropic의 시각 토큰 상한 4,784 아래에서 1932px 프레임을 쓰며 이전 계열은 1568px를 유지합니다. Gemini는 22px 줄 간격의 `8x13` 글리프를 읽습니다(추가 행간, 검은 글자 `8on22-bw`, 2048px). Gemini 3.x는 픽셀 크기와 관계없이 이미지마다 고정 1,120토큰을 과금하기 때문입니다. GPT/Codex는 같은 `8on22-bw`를 1568px로 읽습니다. 패치 과금이 면적에 비례하므로 프레임을 키워도 토큰당 글자 수가 좋아지지 않습니다. Kimi/GLM은 16px 간격의 `8x13` 글리프를 읽습니다(1568px의 `8on16-bw`; Kimi 처리기는 1792px를 넘으면 축소). Vertex나 OpenRouter로 연결한 Claude도 Claude 형태를 유지합니다. 자동 선택은 글꼴도 고려합니다(`resolveShapeForText`). 모델 기본 글꼴이 대화 기록을 안전하게 렌더링하지 못하거나 넓은 CJK 글리프가 대부분이고 `silver16-bw` 격자가 이를 안전하게 렌더링할 수 있으면 `silver16-bw`로 자동 전환합니다. 강제 지정한 변형은 덮어쓰지 않습니다. 측정하지 않은 모델은 전송 API 계열을 따릅니다(Anthropic 계열·알 수 없음 → `11on16-bw`, Google → `8on22-bw`, OpenAI 호환 → `8on22-bw`). 프레임당 토큰 추정은 읽는 모델 계열의 카탈로그 `image-tokenization` 규칙을 따릅니다. Vertex·OpenRouter 뒤의 Claude도 Claude로 계산하며 4.7 이전 Opus/Sonnet/Haiku는 표준 1,568토큰 등급을 적용합니다. 모델 계열 규칙이 없으면 요청을 운반하는 전송 API 카탈로그 규칙을 사용하고 해석된 프레임 크기로 계산합니다. OpenAI 호환 전송에는 `detail: "original"` 힌트도 줍니다. `snapcompact.shape`(기본 `auto`)로 연구 평가 변형을 강제할 수 있습니다. 정사각 격자(`8x8r`/`8x8u`/`6x6u`/`5x8` × 문장별 색조·검은 글자), 모델별 평가 우수 변형(`6x12-dim`, `8x13-bw`, `8on16-bw`, `8on22-bw`, `11on16-bw`, `silver16-bw`), 2열 단어 줄바꿈 `doc-8on16-bw`/`-sent`/`-sent-dim`이 있습니다. `silver16-bw`는 CJK와 비라틴 문자용 내장 Silver TrueType 글꼴을 16px 격자에 쓰며 `dim`은 불용어를 회색으로 표시합니다. 강제 변형은 기하 구조를 유지하되 읽는 모델의 이미지 과금으로 비용을 다시 계산합니다. 모델이 읽기 전에 이미지를 축소하는 호스트(카탈로그 `image-max-edge`; Cursor는 Claude·GPT 이미지를 1024×1024 안에 맞춤)는 강제 변형도 해당 변 길이를 넘지 않도록 프레임 너비를 제한합니다. 같은 설정은 인라인 시스템 프롬프트·도구 결과 이미지화(`snapcompact.systemPrompt`, `snapcompact.toolResults`)도 제어합니다.
- 직렬화는 보관의 대화 밀도를 높입니다. 도구 결과는 앞·뒤를 남기고 자릅니다(기본 2,000자, 앞부분 비율 0.6). 도구 호출 인수는 값당 500자, 호출당 2,000자로 제한하고 도구 출력은 흐린 회색으로 그려 대화가 도구 잡음보다 잘 보이게 합니다. 모든 예산과 흐림은 `SerializeOptions`의 `toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, `dimToolResults`로 설정할 수 있습니다.
- Snapcompact 보관은 `CompactionEntry.preserveData.snapcompact`에 크기가 제한된 원문과 렌더링 프레임으로 저장합니다. 컨텍스트를 재구성할 때마다 가장 오래된 쪽의 일반 텍스트, 가운데 이미지, 가장 최근 쪽의 일반 텍스트 순서로 압축 블록을 복원합니다. 항목의 `summary`는 짧은 재개 안내와 일반 파일 작업 목록뿐입니다.
- 이후 압축은 오래된 PNG를 그대로 넘기지 않고 제한된 원문 `Archive.text`에서 다시 렌더링합니다. `maxFrames`는 기본 `MAX_FRAMES_DEFAULT`(80)이며 상한으로만 작용합니다. 이미지화한 가운데 부분이 크면 내부에서 고품질·저품질·고품질(HQ/LQ/HQ)로 차등 처리하며 시간순 양쪽 가장자리는 원문 텍스트를 유지합니다.
- 모델 호출, API 키, 네트워크를 사용하지 않으므로 오버플로 복구에도 안전합니다. 현재 모델은 이미지를 지원해야 합니다(`model.input`에 `"image"` 포함). 그렇지 않으면 자동 유지 관리는 이를 건너뛰고 다음 설정 방식으로 진행합니다. 수동 `/compact`는 사용자 지정 지침이 없으면 방식 순서를 따릅니다. 사용자 지정 지침은 목적을 지정한 LLM 요약을 뜻합니다.
- 근거: 형태 표는 `packages/snapcompact`의 20만 토큰 평가에서 나왔습니다. 시각 지원 모델에서는 비트맵 프레임이 원시 텍스트보다 낮은 과금 토큰 비용으로 QA 회상 성능을 유지했습니다.

보관 크기는 컨텍스트 창 전체가 아니라 압축 실행 임계값 아래의 여유 공간을 기준으로 정합니다. 활성 모델의 `compaction.modelThresholds`를 반영한 임계값에서 시스템 프롬프트, 도구, 보존할 최근 턴(실행 조건과 같은 방식으로 계산하며 불투명한 추론 재생 서명은 제외), 보관 텍스트, 프롬프트 전 처리라면 대기 중 프롬프트를 뺀 나머지의 절반을 프레임에 배정합니다. 압축된 전체 컨텍스트와 프롬프트를 임계값의 60% 이내로 맞추고 컨텍스트 창도 넘지 않게 합니다. 최소 한 프레임은 허용하며, 버릴 텍스트가 텍스트 가장자리 영역에 들어가면 텍스트 전용 보관이 됩니다. 최소 한 프레임조차 여유를 남기지 못하면 경고를 기록하고 한 프레임을 렌더링합니다. 모델 카탈로그의 `image-tokenization` 규칙이 제공업체 과금과 대조해 `verified`로 확인되었다면 각 프레임에는 활성 모델에 대한 해당 형태의 비용을 적용합니다. 그렇지 않으면 그 비용과 `FRAME_TOKEN_ESTIMATE`(5,024) 중 큰 값을 적용합니다. 여유 공간과 관계없이 기본 80프레임 한도, 배포 카탈로그의 `image-count-budget`, 프레임 페이로드 예산이 상한을 정합니다. 프레임 페이로드 예산 `frameDataBytesBudget`은 배포 카탈로그의 `inline-image-byte-budget` 절반이며 공식 Anthropic·Codex 엔드포인트에서는 12MB, 그 외에는 3,000,000바이트입니다. 형태별 프레임 추정치로 크기를 계산합니다. 컨텍스트를 재구성할 때마다 활성 모델의 프레임 페이로드 예산에 맞춰 보관을 첨부하고, 요청마다 해당 모델 예산을 넘는 가장 오래된 프레임부터 제거하므로 예산이 작은 호스트로 모델을 전환해도 이전의 큰 보관을 보내지 않습니다. 60%는 목표이지 보장이 아닙니다. 렌더링 결과가 목표 또는 프레임 페이로드 예산을 넘으면 둘 다 충족할 것으로 추정한 프레임 수로 가장 오래된 프레임을 제거하며 최대 두 번 다시 렌더링합니다. 바이트 예산 계산은 `frames × budget / payload`를 사용하며 한 프레임까지 줄어든 보관은 더 줄일 수 없습니다. 이후 결과를 요청한 경로가 적합성을 판단합니다. 여전히 바이트 예산이나 컨텍스트 창을 넘으면 사용할 수 없는 프롬프트로 저장하는 대신 거부하거나 건너뜁니다. 임계값 처리 결과와 대기 중 프롬프트가 복구 기준인 80%를 넘으면 경고와 함께 다음 설정 방식으로 넘어갑니다. 이후 `shake` 외에 실행 가능한 방식이 없고 대기 중 프롬프트를 포함해 컨텍스트 창에는 들어간다면 경고와 함께 결과를 유지합니다. 오버플로 및 불완전 출력 복구는 턴을 재시도하며 창에 들어가는지만 요구합니다. 수동 `/compact`는 축소 여부와 창 크기 충족 여부만 검사합니다.

<a id="maintenance-progress-guard"></a>
### 유지 관리 진전 보호

자동 유지 관리는 이어가기를 예약하기 전에 재작성한 컨텍스트가 실제 여유를 만드는지 확인합니다. 일반적으로 해석된 임계값의 80% 이하여야 합니다. 진전이 없으면 기존 Snapcompact 보관을 더 작은 프레임 예산으로 다시 렌더링하거나, 큰 블록을 복구 가능한 결과물 참조로 치환하거나, 첨부 이미지를 제거하는 로컬 복구를 시도할 수 있습니다. 보관 복구는 가장 오래된 원문을 잘라낼 수 있으며 이미지 제거는 파괴적입니다. 그래도 여유를 만들지 못하면 경고를 내고 자동 이어가기를 차단하여 같은 초대형 컨텍스트로 반복하지 않습니다.

<a id="display-transcript"></a>
### 표시용 대화 기록

컨텍스트 압축이 더 이상 화면의 대화를 처음부터 다시 시작하지 않습니다. TUI는 **표시용 대화 기록**(`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`)을 렌더링합니다. 경로의 모든 항목을 시간순으로 표시하고 각 압축이 발생한 자리에 `── 📷 compacted · ctrl+o ──` 같은 얇은 구분선을 삽입합니다. Ctrl+O로 펼치면 요약이 나타납니다. 압축 경계에서 초기화되는 것은 LLM 컨텍스트뿐이며 구분선 위의 스크롤 기록은 세션을 재개한 뒤에도 유지됩니다.

<a id="pre-compaction-pruning"></a>
### 압축 전 가지치기

압축 검사 전에 도구 결과 가지치기(`pruneToolOutputs`)를 실행할 수 있습니다.

기본 가지치기 정책:

- 가장 최근 도구 출력 `40_000`토큰을 보호합니다.
- 추정 절감량 합계가 최소 `20_000`토큰이어야 합니다.
- `50`토큰(`MIN_PRUNE_TOKENS`) 미만의 결과는 비우지 않습니다. `[Output truncated - N tokens]` 자리표시자 자체가 약 8토큰이므로 작은 결과를 치환하면 컨텍스트가 늘고 프롬프트 캐시만 불필요하게 바뀝니다. 대체된 결과와 무의미한 결과는 별도 규칙을 따릅니다. 무의미한 결과 수집기는 이미 절감이 없는 후보를 제외하며, 대체된 읽기 결과는 정확성을 위해 크기에 관계없이 가지치기합니다.
- `skill` 도구 결과, `skill://` 경로의 `read` 결과, 활성 계획 참조 파일 읽기는 가지치기하지 않습니다. 계획 보호는 `AgentSession`이 추가합니다.

가지치기한 도구 결과는 다음으로 치환합니다.

- `[Output truncated - N tokens]`

가지치기로 항목이 바뀌면 세션 저장소를 재작성하고 에이전트 메시지 상태를 갱신한 뒤 압축 여부를 결정합니다.

<a id="useless-result-elision"></a>
### 무의미한 결과 생략

도구는 검색 결과가 없거나 `wait`의 안전 상한에 도달했지만 실행 중인 작업만 반환된 경우처럼 완료된 결과를 컨텍스트상 무의미하다고 표시할 수 있습니다. 표시는 도구 결과의 `AgentToolResult.useless`에서 시작합니다. `ToolResultBuilder.useless()` 또는 반환 객체에 직접 설정하며, 에이전트 루프가 저장되는 `ToolResultMessage`에 복사합니다. 오류가 항상 우선하므로 `isError`와 함께 저장하지 않습니다. 이 표시는 다음 세 곳에서 사용합니다.

- **턴별 오래된 결과 처리**(`pruneSupersededToolResults`, 기본 활성화된 `compaction.dropUseless`로 제어): 표시된 결과를 정확히 `[Uneventful result elided]`(`USELESS_NOTICE`)로 비웁니다. 대체된 읽기와 같은 캐시 인식 시점을 적용합니다. 후보 이후 구간이 작고(약 8천 토큰 이하), 프롬프트 캐시 되돌아보기 범위를 아는 모델에서는 보수적인 상한 안에 있거나, 세션 유휴 시간이 제공업체의 프롬프트 캐시 수명을 넘었을 때만 처리합니다. 되돌아보기는 카탈로그 `prompt-cache-lookback`이며 Claude는 20위치입니다. 상한 계산 시 후보를 발행한 어시스턴트 턴, 해당 도구 결과 묶음, 그 이후 전체를 세션의 `convertToLlm`으로 투영하므로 파일 언급, 이미지가 있는 명령 출력, 사용자 지정 메시지의 이미지 분할도 전송 형태대로 반영합니다. 위치는 Anthropic 방식으로 셉니다. 연속된 `tool_use` 또는 `tool_result` 블록은 한 위치이며 오류 결과에서 끌어올린 이미지와 채움 턴도 포함합니다. 다음 요청 입력과 계산하지 않는 투영(고아 결과 안내, 재생된 압축 파일 메타데이터, 도구 변경 제어)에 6위치를 남기기 위해 최대 되돌아보기 범위에서 6을 뺀 값까지만 허용합니다. 이 여유보다 큰 입력이나 투영은 여전히 캐시 재구성을 한 번 유발할 수 있습니다. 알려진 되돌아보기 범위가 없는 모델은 상한을 생략합니다. 임계값 가지치기의 활성 캐시 보호도 같은 제한을 적용합니다. 안내문 자체보다 작은 결과는 절감이 없으므로 비우지 않으며 보호된 도구는 제외합니다.
- **임계값 가지치기**(`pruneToolOutputs`): 표시된 결과는 대체된 읽기와 마찬가지로 최근 결과 보호 창을 우회하며 토큰 수 자리표시자 대신 `USELESS_NOTICE`로 치환합니다.
- **요약 직렬화**: 에이전트와 Snapcompact의 `serializeConversation`은 요약기/보관 입력에서 도구 호출·결과 쌍 전체를 제외합니다. 요약 뒤 원본 영역을 버리므로 이 제외는 캐시 비용을 발생시키지 않습니다.

이 표시는 제공업체 전송 형식에 전달되지 않으며 표시된 쌍은 기록에서 삭제하지 않고 제자리에서 비우기만 합니다. 따라서 도구 호출·결과 짝과 제공업체 네이티브 기록 재생은 유지됩니다.

<a id="boundary-and-cut-point-logic"></a>
### 경계 및 분할 지점 로직

`prepareCompaction()`은 추정, 분할 지점 선택, 기록 요약·턴 접두부·보존 메시지 영역에 사용할 하나의 유효 메시지 열을 만듭니다.

1. 활성 모델이 요약 또는 제공업체 네이티브 기록을 재사용할 수 있는 가장 최근 압축을 찾습니다.
2. 가장 최근 `/clear`의 `reset_boundary`를 따릅니다. 더 새로운 초기화는 이전 요약을 버리며, 더 오래된 초기화도 보존 메시지를 복구할 수 있는 하한으로 남습니다.
3. 로컬 요약에서는 `firstKeptEntryId`부터 이전 압축 레코드 직전까지 원본 항목을 복구하고 그 레코드 뒤 항목을 덧붙입니다.
4. 재사용 가능한 제공업체 네이티브 기록에서는 `providerReplayThroughEntryId`가 이전 스냅샷을 가리키면 그 다음부터 시작하되 최신 초기화 경계를 넘지 않습니다. 네이티브 재생에 이미 포함된 원본 메시지가 아니라 스냅샷부터 커밋까지의 미포함 구간을 복구합니다. 마지막에 네이티브 압축 레코드가 있다고 이 구간이 이미 압축된 것은 아닙니다.
5. 압축 레코드와 기타 비메시지 메타데이터를 제외합니다. 이전 요약은 `previousSummary`로 별도 전달하고 메시지를 담는 `custom_message`와 `branch_summary` 항목은 유지합니다.
6. 실측 사용량 비율로 `keepRecentTokens`를 조정한 뒤 `findCutPoint()`를 실행하고 같은 메시지 열을 `messagesToSummarize`, `turnPrefixMessages`, `recentMessages`로 나눕니다.

로컬 요약을 갱신할 때 모든 유효 원본 메시지는 세 영역 중 정확히 하나에 속합니다. 예를 들어 `summary(A) + B`가 `summary(A) + B + C`로 늘어나면 다음 준비는 C만이 아니라 B와 C 모두를 분배합니다. 새 `firstKeptEntryId`는 원본 항목을 가리키며 준비 과정은 저널 항목을 이동·복제·재작성하지 않습니다. 이는 로컬 요약 준비의 보장이지 제공업체 네이티브 또는 추측 실행 네이티브 재생의 종단 간 보장은 아닙니다.

유효한 분할 지점:

- `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary` 역할의 메시지 항목
- `custom_message` 항목
- `branch_summary` 항목

필수 규칙: `toolResult`에서는 절대 나누지 않습니다.

준비 과정은 보존 메시지 경계를 고르기 전에 순수 메타데이터(`model_change`, `thinking_level_change`, 라벨 등)를 제외합니다. 이 레코드는 저널에 남지만 대화 입력에는 포함되지 않습니다.

<a id="split-turn-handling"></a>
### 턴 중간 분할 처리

분할 지점이 사용자 턴 시작이 아니면 압축은 이를 턴 중간 분할로 취급합니다.

턴 시작 감지는 다음을 사용자 턴 경계로 봅니다.

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` 항목
- `branch_summary` 항목

턴 중간 분할 압축은 두 요약을 만듭니다.

1. 기록 요약(`messagesToSummarize`)
2. 턴 접두부 요약(`turnPrefixMessages`)

최종 저장 요약은 다음과 같이 합칩니다.

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

<a id="summary-generation"></a>
### 요약 생성

`compact(...)`는 직렬화한 대화 텍스트로 요약을 만듭니다.

1. `convertToLlm()`으로 메시지를 변환합니다.
2. 대상 모델이 선호하는 표현 형식으로 `serializeConversationForSummary()`를 사용해 직렬화합니다.
3. `<conversation>...</conversation>`으로 감쌉니다.
4. 선택적으로 `<previous-summary>...</previous-summary>`를 포함합니다.
5. 선택적으로 확장 훅 컨텍스트와 활성 메모리 백엔드의 압축 컨텍스트를 `<additional-context>` 항목으로 삽입합니다.
6. `SUMMARIZATION_SYSTEM_PROMPT`를 사용해 요약 프롬프트를 실행합니다.

큰 로컬 요약 입력은 예산에 맞는 대화 창으로 나눠 처리하며 각 요약을 다음 갱신으로 넘깁니다. 제공업체가 컨텍스트 초과로 거부하면 해당 창을 절반으로 줄이고 최소 입력 예산까지 다시 계획합니다. 그 외 실패는 그대로 보고합니다.

프롬프트 선택:

- 첫 압축: `compaction-summary.md`
- 이전 요약을 갱신하는 반복 압축: `compaction-update-summary.md`
- 턴 중간 분할의 두 번째 처리: `compaction-turn-prefix.md`
- 짧은 UI 요약: `compaction-short-summary.md`
- 인계 문서: `handoff-document.md`(직렬화 압축이 아닌 `generateHandoff(...)`에서 사용)

원격 요약 방식은 다음 순서로 확인하며, 다음 방식이 있으면 각 단계에서 대체 경로로 진행합니다.

- **V2 스트리밍 Responses 압축**(우선 시도하며 `compaction.remoteStreamingV2Enabled`로 기본 활성화): 적격 모델은 `shouldUseCompactionV2Streaming(...)`으로 판단합니다. `openai-responses`, `azure-openai-responses`, `openai-codex-responses` API, 활성화된 `remoteCompaction.v2StreamingEnabled`(아래 Amazon Bedrock OpenAI 경로에서는 기본 활성화), 해석 가능한 Responses 엔드포인트가 필요합니다. 제공업체 네이티브 도구 호출 기록 재생을 포함한 전체 대화 끝에 `compaction_trigger` 입력 항목을 붙여 모델의 일반 Responses 스트리밍 엔드포인트로 보내고, 정확히 하나의 스트리밍 `compaction` 출력 항목을 요구합니다. 요청에는 세션 라우팅·프롬프트 캐시 식별자(라우팅/세션 ID 헤더와 `prompt_cache_key`)가 들어가며 추론 수준은 일반 턴과 같은 방식으로 결정합니다. 대체 기록은 Codex 방식입니다. `compaction.v2RetainedMessageBudget`(기본 `64000`토큰이며 이 상한 이하로 제한) 안에서 실제 사용자 메시지를 보존한 뒤 압축 항목을 붙이고 `preserveData.openaiRemoteCompaction`에 버전 `"v2"`로 저장합니다. 일시적 스트림 오류는 V1과 동일한 5분 제한(`V2_COMPACTION_TIMEOUT_MS`) 안에서 지수 백오프로 최대 `V2_COMPACTION_MAX_RETRIES`(`2`)회 재시도합니다. 사용자 취소는 재시도하지 않습니다.
- **V1 네이티브 `/responses/compact`**: OpenAI 모델, 호환되는 명시적 `remoteCompaction.endpoint`가 있는 OpenAI Codex 모델, Amazon Bedrock OpenAI 경로의 `openai-responses` 모델(`shouldUseOpenAiRemoteCompaction`)이 대상입니다. 원격 압축이 켜져 있고 V2가 적격하지 않거나 실패하여 실행되지 않았다면 제공업체 네이티브 `/responses/compact` 엔드포인트를 시도합니다. 대체 기록은 `preserveData.openaiRemoteCompaction`에 보존합니다. 네이티브 실패 시 일반 요약으로 조용히 바꾸지 않고 전송 오류를 보고합니다. 다만 `compaction.remoteEndpoint`가 설정되어 있으면 해당 엔드포인트 또는 로컬 요약으로 진행합니다.
- **Anthropic 요청형 압축**(`compact-2026-09-04` 베타): 베타가 지원하는 모델 계열(`compat.supportsServerCompaction` 카탈로그 규칙: `anthropic`, `google-vertex`, `amazon-bedrock`, `bedrock-mantle` 제공업체의 Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5+)이고 실효 엔드포인트가 이를 구현하며 원격 압축이 켜져 있고 OpenAI 경로가 적용되지 않을 때 사용합니다. `shouldUseAnthropicNativeCompaction`이 Claude API, Vertex, Foundry, Claude Platform on AWS, Amazon Bedrock `/anthropic` 경로를 판별합니다. 다른 제공업체가 앞의 네 서비스 중 하나에 연결하면 `remoteCompaction.enabled`가 필요하며 알 수 없는 게이트웨이 URL은 제외합니다. 요약할 기록을 현재 대화의 시스템 프롬프트·도구·추론 설정과 함께 보내고, 하네스 요약 프롬프트를 담은 최상위 `compaction: { type: "summarize", instructions }` 매개변수를 추가합니다. API는 서명된 `compaction` 블록 하나(`stop_reason: "compaction"`)를 반환하며 이를 `anthropicCompaction` 페이로드로 노출합니다. 일반 텍스트 요약은 파일 작업 목록과 함께 항목의 `summary`이자 `preserveData.anthropicCompaction`이 됩니다. 이후 압축 지원 엔드포인트 요청은 블록을 변경 없이 첫 블록으로 돌려보내며 다른 제공업체는 요약 텍스트를 읽습니다. 요약 범위의 순 도구 추가·제거를 담는 서명된 `tool_changes`도 저장하고 그대로 재생합니다. 분할 지점 뒤의 보존 구간은 로컬 요약처럼 세션 항목에서 재생합니다. 거부, 출력 한도, 요약 중 도구 호출 등 서명된 요약이 없는 응답은 OpenAI 경로와 마찬가지로 네이티브 실패입니다. 이전 `compact-2026-01-12` 임계값 베타의 `encryptedContent` 블록은 재생만 지원합니다.
   - Amazon Bedrock에서는 `https://bedrock-runtime.<region>.amazonaws.com/anthropic` 또는 `https://bedrock-mantle.<region>.api.aws/anthropic`을 사용하세요([설정](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic)). 아래 OpenAI 경로의 FIPS·PrivateLink 호스트명도 해당합니다. 이 조건은 해당 `baseUrl`에서 감지한 `compat.bedrockMessagesApi`를 읽습니다. 프록시나 `ANTHROPIC_BASE_URL` 우회 경로를 포함하려면 `models.yml`에 이를 설정하고, Bedrock 경로를 제외하려면 `false`로 설정하세요.
   - 모델 카드에 베타가 표시된 Bedrock Converse 모델(`bedrock-converse-stream`, `compat.supportsServerCompaction`; `providers/amazon-bedrock.kdl` 규칙상 Haiku 4.5/5.5, Sonnet 5/5.5, Opus 4.7/4.8/5/5.5)은 같은 Anthropic Messages 본문을 담은 Bedrock Runtime `InvokeModelWithResponseStream` 보조 요청으로 압축합니다. Converse 자체는 베타를 거부합니다([AWS 압축 가이드](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html)). 일반 턴은 Converse를 유지하며 요약 텍스트를 읽고 서명된 블록은 이후 압축 요청에만 재생합니다. AWS bedrock-runtime 원본(공개·FIPS·PrivateLink)은 기본 적격입니다. 다른 `baseUrl`은 Converse만 구현할 수 있는 게이트웨이로 취급하므로 `remoteCompaction.enabled: true`가 필요합니다. `remoteCompaction.enabled: false`는 모델을 제외합니다.
- **사용자 지정 원격 엔드포인트**: `compaction.remoteEndpoint`가 설정되고 원격 압축이 활성화되어 있으면 로컬 요약 생성은 두 전송 형식 중 하나로 POST합니다.
   - 사용자 지정 omp 요약기 엔드포인트는 `{ systemPrompt, prompt, maxTokens }`를 받으며 최소 `{ summary }`를 포함한 JSON을 반환해야 합니다.
   - 경로가 `/chat/completions`로 끝나는 OpenAI 호환 엔드포인트는 `{ model, messages, stream: false, max_tokens }`를 받습니다. `messages`에는 시스템 프롬프트와 사용자 프롬프트가 하나씩 들어갑니다. 요약은 `choices[0].message.content`에서 읽으므로 llama.cpp·vLLM 같은 자체 호스팅 서버를 별도 요약기 호환 계층 없이 원격 압축기로 사용할 수 있습니다.

Amazon Bedrock OpenAI 경로는 별도 활성화 없이 두 OpenAI 압축 경로를 모두 사용합니다. 제공업체 ID와 관계없이 `api: openai-responses`인 모델의 `baseUrl`에서 경로를 감지합니다(`packages/catalog/src/hosts.ts`의 `isBedrockOpenAIUrl`). `bedrock-runtime` 또는 `bedrock-mantle` 엔드포인트의 HTTPS `/openai/…` 경로, 또는 문서화된 Mantle `/v1` 기본 경로가 대상입니다. 호스트명은 공개 호스트(`bedrock-runtime.<region>.amazonaws.com`, FIPS의 `bedrock-runtime-fips.<region>.amazonaws.com`, `bedrock-mantle.<region>.api.aws`; 기본 제공 `bedrock-mantle`의 `{region}` 템플릿 포함)와 AWS PrivateLink 엔드포인트별 이름(`<vpce-id>[-<az>].bedrock-runtime[-fips].<region>.vpce.amazonaws.com` 또는 `….bedrock-mantle.<region>.vpce.amazonaws.com`)입니다. 비공개 DNS를 쓰는 VPC 엔드포인트는 공개 이름에 응답합니다([Amazon Bedrock 지원 엔드포인트](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html), [Bedrock 서비스 엔드포인트](https://docs.aws.amazon.com/general/latest/gr/bedrock.html), [Bedrock VPC 엔드포인트](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html), [PrivateLink DNS 이름](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html)). `/anthropic`, bedrock-runtime의 `/v1`, Converse 루트 등 다른 Bedrock 경로는 해당하지 않습니다. 이 Bedrock 경로에서만 `prepareBedrockCompactionRequest`(`packages/agent/src/compaction/bedrock.ts`)가 두 압축 요청을 일반 Bedrock 턴과 같은 형태로 만듭니다. 설정 헤더를 해석하고 전송 fetch(제공업체 프록시, 추가 CA, User-Agent, 요청 기록)를 적용하며 제공업체 자체 요청 훅을 실행합니다. 따라서 기본 제공 `bedrock-mantle`은 `{region}`을 채우고 Bearer 토큰 또는 SigV4 서명을 사용합니다. 다른 제공업체의 압축 요청은 자체 전송을 유지합니다. `models.yml`에서 모델이나 제공업체의 기본 동작을 끄려면 `remoteCompaction.enabled: false`(두 경로) 또는 `remoteCompaction.v2StreamingEnabled: false`(V1만 사용)를 설정하세요. AWS는 두 엔드포인트의 [Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)를 문서화하며 OpenAI는 [Amazon Bedrock의 OpenAI 모델](https://developers.openai.com/api/docs/guides/amazon-bedrock) 기능 지원 범위를 제공합니다. 이 페이지들은 압축을 언급하지 않습니다. 대신 원문 기준 2026-09-25에 Bedrock API 키(SigV4 아님)와 공개 `/openai/v1` 기본 경로로 실제 지원을 확인했습니다. `us-east-1`의 bedrock-runtime(`us.openai.gpt-6-astra`, `-sol`, `-luna`)과 bedrock-mantle(`openai.gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`)에서 V1 `POST {base}/responses/compact`는 `object: "response.compaction"`을 반환했고 V2는 `compaction` 출력 항목을 스트리밍했습니다. FIPS, PrivateLink, Mantle `/v1` 기본 경로는 같은 서비스에 연결하지만 실제 검증하지 않았습니다. Mantle의 `openai.gpt-oss-120b`는 Responses API를 지원하지 않습니다.

네이티브 원격 압축(V2·V1·Anthropic)이 성공하면 로컬 LLM 요약은 완전히 건너뜁니다. OpenAI 경로의 영구 기록은 제공업체 재생 페이로드에 있으며 저장 `summary`는 자리표시자 안내와 파일 작업 목록입니다. Anthropic 경로는 실제 요약 텍스트를 저장하므로 이후 다른 제공업체도 이를 바탕으로 압축할 수 있습니다.

일반 로컬 요약에서 네이티브 압축을 시작하면 준비된 대화와 함께 그 요약을 컨텍스트 메시지로 넣습니다. 이후 네이티브 처리는 자리표시자 요약을 다시 삽입하지 않고 제공업체 페이로드를 재사용합니다. Snapcompact 원문은 별도 보관 마이그레이션 경로를 유지합니다.

추측 실행 네이티브 압축에서 `providerReplayThroughEntryId`는 나중 커밋 위치가 아닌 스냅샷의 마지막 항목을 기록합니다. 컨텍스트 재구성과 다음 압축 준비는 두 위치 사이에 추가한 메시지와 커밋 이후 메시지를 순서대로 포함합니다. 네이티브 페이로드와 미포함 구간은 각각 한 번씩 재생합니다. `/clear`가 해당 압축보다 나중이면 둘 다 버립니다.

조언자 런타임은 이후 유지 관리를 위해 네이티브 `preserveData`를 보존하고 다음 모델 요청의 메모리 내 압축 요약에 제공업체 페이로드를 첨부합니다. 네이티브 재생에 보존 구간이 이미 들어 있으므로 같은 구간을 원시 메시지로 다시 덧붙이지 않습니다. 로컬 요약은 최근 메시지를 별도 유지합니다. 조언자 요청도 공유 메시지 변환기를 사용하므로 텍스트 압축 요약과 네이티브 페이로드가 모두 제공업체에 전달됩니다.

<a id="handoff-generation"></a>
### 인계 생성

`packages/agent/src/compaction/compaction.ts`는 `generateHandoff(...)`와 `generateHandoffFromContext(...)`를 내보냅니다. Coding-agent는 `SessionHandoff`를 통해 컨텍스트 인식 함수를 사용합니다. 보조 요청에는 기본 시스템 프롬프트, 정규화한 도구, 변환한 현재 기록, 현재 프롬프트 캐시 키, 고유 보조 세션 ID, 마지막의 에이전트 귀속 `user` 인계 프롬프트가 들어갑니다. `toolChoice: "none"`으로 시작하며 명시적 도구 선택 호환성 거부가 있을 때만 `"auto"`로 한 번 재시도합니다. 결합한 텍스트 블록만 반환하고 도구는 실행하지 않습니다. [인계 파이프라인](./handoff-generation-pipeline.md)을 참고하세요.

인계는 현재 세션에 일반 `CompactionEntry`를 저장합니다. `SessionMaintenance.handoff()`(수동 `/handoff`)와 자동 유지 관리의 `handoff` 방식은 모두 `SessionHandoff.generateDocument()`로 문서를 만들고, `prepareCompaction`의 `firstKeptEntryId`와 함께 압축 요약으로 저장합니다. 따라서 최근 기록은 보존하며 세션 ID, 대화 기록, 제공업체 캐시 키는 바뀌지 않습니다.

`compaction.handoffSaveToDisk`가 켜져 있으면 **자동 실행된** 인계는 저장된 세션의 결과물 디렉터리에 `handoff-<ISO timestamp>.md`도 씁니다. 이 설정은 수동 인계를 파일로 쓰지 않으며 저장하지 않는 세션에는 결과물 디렉터리가 없습니다.

<a id="file-operation-context-in-summaries"></a>
### 요약의 파일 작업 컨텍스트

압축은 어시스턴트 도구 호출로 누적 파일 작업을 추적합니다.

- `read(path)` → 읽은 파일 집합
- `write(path)` → 수정한 파일 집합
- `edit(path)` → 수정한 파일 집합

누적 동작:

- 이전 항목이 pi에서 생성된 경우(`fromExtension !== true`)에만 이전 압축 세부 정보를 포함합니다.
- 턴 중간 분할에서는 턴 접두부의 파일 작업도 포함합니다.
- `details.readFiles`에서는 수정도 한 파일을 제외하고 `details.modifiedFiles`에 나머지를 담습니다. 저장 형식은 바뀌지 않습니다.

파일 목록은 공통 접두부를 접은 그룹별 디렉터리 트리(find 도구 형태)이며 파일별 접근 표시를 붙입니다. 읽기만 한 파일은 `(Read)`, 한 번도 읽지 않고 수정한 파일은 `(Write)`, 수정했고 누적 읽기 집합에도 있는 파일은 `(RW)`입니다. 최대 20파일로 제한하고 나머지는 `[…N files elided…]` 줄로 표시합니다. LLM 요약 방식은 `upsertFileOperations`를 통해 `<files>` 태그로 덧붙이며 Snapcompact는 요약 템플릿 안의 `FILES` 구역에 렌더링합니다.

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

이전 버전이 쓴 요약의 `<read-files>`/`<modified-files>` 태그는 `<files>`와 함께 제거한 뒤 다시 덧붙이므로 다음 압축 때 오래된 요약도 자동으로 정리됩니다.

<a id="persist-and-reload"></a>
### 저장 및 다시 로드

요약을 생성하거나 훅이 요약을 제공한 뒤 에이전트 세션은 다음을 수행합니다.

1. `appendCompaction(...)`으로 `CompactionEntry`를 추가합니다. 인계 방식은 같은 세션에 생성한 문서를 항목의 요약으로 저장합니다.
2. 활성 리프에서 `buildDisplaySessionContext()`로 표시 컨텍스트를 재구성합니다.
3. 실행 중 에이전트 메시지를 재구성한 컨텍스트로 교체합니다.
4. 재구성한 분기에서 활성 할 일 단계를 동기화하고 기록을 재작성한 제공업체 세션을 닫습니다.
5. `session_compact` 훅 이벤트를 발생시킵니다.

<a id="branch-summarization-pipeline"></a>
## 분기 요약 파이프라인

분기 요약은 토큰 초과가 아닌 트리 탐색에 연결됩니다.

<a id="trigger"></a>
### 실행 조건

`navigateTree(...)` 실행 중:

1. `collectEntriesForBranchSummary(...)`로 이전 리프부터 공통 조상까지 떠나는 항목을 계산합니다.
2. 호출자가 요약을 요청했으면(`options.summarize`) 리프를 바꾸기 전에 요약을 생성합니다.
3. 요약이 있으면 `branchWithSummary(...)`로 탐색 대상에 붙입니다.

보통 `branchSummary.enabled`가 켜져 있을 때 `/tree` 흐름으로 실행합니다.

<a id="branch-switch-shape-visual"></a>
### 분기 전환 구조 도식

```text
탐색 전 트리:

         ┌─ B ─ C ─ D (이전 리프, 떠날 분기)
    A ───┤
         └─ E ─ F (대상)

공통 조상: A
요약할 항목: B, C, D

요약을 포함한 탐색 후:

         ┌─ B ─ C ─ D (떠난 분기, 변경 없음)
    A ───┤
         └─ E ─ F ─ [B,C,D 요약] (새 리프)
```

<a id="preparation-and-token-budget"></a>
### 준비 및 토큰 예산

`generateBranchSummary(...)`는 다음과 같이 예산을 계산합니다.

- `tokenBudget = (model.contextWindow || 128000) - branchSummary.reserveTokens`

이후 `prepareBranchEntries(...)`는 다음을 수행합니다.

1. 첫 번째 처리: 이전 pi 생성 `branch_summary` 세부 정보를 포함해 요약할 모든 항목의 누적 파일 작업을 수집합니다.
2. 두 번째 처리: 최신에서 오래된 순서로 순회하며 토큰 예산에 도달할 때까지 메시지를 추가합니다.
3. 최근 컨텍스트 보존을 우선합니다.
4. 연속성을 위해 예산 경계 근처의 큰 요약 항목도 포함할 수 있습니다.

분기 요약 입력에는 압축 항목을 메시지(`compactionSummary`)로 포함합니다.

<a id="summary-generation-and-persistence"></a>
### 요약 생성 및 저장

분기 요약:

1. `serializeConversationForSummary()`와 대상 모델의 선호 표현 형식으로 선택한 메시지를 변환·직렬화합니다.
2. `<conversation>`으로 감쌉니다.
3. 사용자 지정 지침이 있으면 사용하고 없으면 `branch-summary.md`를 사용합니다.
4. `SUMMARIZATION_SYSTEM_PROMPT`와 출력 한도 2,048토큰으로 요약 모델을 호출합니다.
5. `branch-summary-preamble.md`를 앞에 붙입니다.
6. 파일 작업 태그를 덧붙입니다.

결과는 선택적 세부 정보(`readFiles`, `modifiedFiles`)와 함께 `BranchSummaryEntry`로 저장합니다.

<a id="extension-and-hook-touchpoints"></a>
## 확장 기능 및 훅 연동 지점

### `session_before_compact`

압축 전 훅입니다.

가능한 동작:

- 압축 취소(`{ cancel: true }`)
- 완전한 사용자 지정 압축 페이로드 제공(`{ compaction: CompactionResult }`)

훅의 `customInstructions`에는 공개 사용자 초점만 담깁니다. 현재 계획 모드의 “승인 후 컨텍스트 압축” 정제 프롬프트 같은 내부 요약기 지침은 `CompactOptions`의 별도 `internalGuidance` 채널로 전달합니다. 이 채널은 네이티브 요약에만 도달하며 이 훅이나 `session.compacting`에는 전달되지 않습니다. 둘 다 설정되어 있으면 요약기는 `internalGuidance`를 사용하지만 훅에는 공개 `customInstructions`가 계속 보입니다(이슈 #4359).

### `session.compacting`

기본 압축의 프롬프트·컨텍스트 사용자 지정 훅입니다.

반환 가능한 값:

- `prompt`: 기본 요약 프롬프트 재정의
- `context`: `<additional-context>`에 삽입할 추가 컨텍스트 줄
- `preserveData`: 압축 항목에 저장할 데이터

### `session_compact`

저장된 `compactionEntry`와 `fromExtension` 표시를 포함하는 압축 후 알림입니다.

### `session_before_tree`

트리 탐색 시 기본 분기 요약 생성 전에 실행합니다.

가능한 동작:

- 탐색 취소
- 사용자가 요약을 요청했을 때 사용할 사용자 지정 `{ summary: { summary, details } }` 제공

### `session_tree`

이전·새 리프와 선택적 요약 항목을 노출하는 탐색 후 이벤트입니다.

<a id="runtime-behavior-and-failure-semantics"></a>
## 런타임 동작 및 실패 의미

- 수동 압축은 먼저 현재 에이전트 작업을 중단합니다. 실행 중 턴을 끊었다면 요약을 저장한 뒤 이어갑니다. 세션이 너무 작거나 이미 압축되어 아무 변경도 하지 않는 경우에는 기록이 바뀌지 않으므로 즉시 이어갑니다. 대기 중인 방향 수정·후속 메시지가 있으면 우선 사용하고 없으면 자동 이어가기 프롬프트를 사용합니다. 훅 취소나 요약기 실패 시에는 이어가지 않습니다. `compaction.autoContinue`가 `false`이거나 호출자가 `suppressContinuation`을 전달하면 이어가기를 생략합니다. 계획 모드 승인은 자체 실행 턴을 보냅니다. 유휴 상태에서 실행한 수동 압축은 턴을 시작하지 않습니다. 압축 중 제출한 프롬프트는 압축 완료를 기다리며, 턴을 시작하거나 대기열에 넣으면 기존 이어가기를 대체합니다. 로컬에서 처리하는 확장·사용자 지정 명령은 이어가기를 다시 넘겨주지만, 해당 명령이 유발한 턴(`pi.sendMessage(..., { triggerTurn: true })`, `pi.sendUserMessage()`), 이후 프롬프트 또는 다른 턴이 먼저 시작되면 그렇지 않습니다. 이렇게 이어가기가 보류된 동안 두 번째 수동 압축을 시작하면 새 압축이 이어가기를 넘겨받습니다.
- `abortCompaction()`은 수동 압축, 자동 압축, 인계 생성 컨트롤러를 취소합니다.
- 자동 압축은 UI·상태 갱신용 시작·종료 세션 이벤트를 발생시킵니다.
- 자동 압축은 여러 모델 후보와 일시적 실패 재시도를 시도할 수 있습니다. 재시도 대기 시간이 길면 사용 가능한 다음 후보를 우선합니다.
- 오버플로 오류는 컨텍스트 승격·압축으로 처리하므로 일반 재시도 경로에서 제외합니다.
- 자동 압축 실패 시:
   - 오버플로 경로는 `Context overflow recovery failed: ...`를 발생시킵니다.
   - 불완전 출력 경로는 `Incomplete response recovery failed: ...`를 발생시킵니다.
   - 임계값·유휴 경로는 `Auto-compaction failed: ...`를 발생시킵니다.
- 준비된 추측 실행 결과를 포함한 자동 요약 후보는 저장 전에 컨텍스트 감소 여부를 확인합니다. 크기를 줄이지 못한 후보는 다음 설정 방식으로 넘어가며, 어느 방식도 진전하지 못하면 압축 항목을 저장하지 않습니다. 새 추측 요청을 포함한 턴 중 재시도는 보존 기록의 절단 지점이 앞으로 이동할 때까지 억제됩니다.
  네이티브 Responses 재생은 불투명한 암호화 상태 바이트가 아닌 표시되는 대체 기록과 이미지 추정치를 계산합니다. 비교 양쪽 모두 재구축한 활성 컨텍스트를 사용하므로 `/clear` 이전 기록이 감소 기준을 부풀릴 수 없습니다. 이는 로컬 추정치이며 제공업체 청구 토큰 수가 아닙니다.
- 분기 요약은 Escape 같은 중단 신호로 취소할 수 있으며 취소·중단된 탐색 결과를 반환합니다.

<a id="settings-and-defaults"></a>
## 설정 및 기본값

`packages/coding-agent/src/session/context-settings.ts`에 정의합니다.

- `compaction.enabled` = `true`
- `compaction.experimentalContextManagement` = `false`. 선택적으로 영구 노트, 분기 종속 원시 기록 조회, 로컬 컨텍스트 창 전환을 사용합니다. 토글하면 실행 중인 세션에 `context_notes`/`new_context`를 추가하거나 제거합니다.
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`. `remote`는 가능할 때 제공업체 네이티브 서버 압축(OpenAI Responses 압축, Bedrock Converse Runtime 보조 요청을 포함하는 Anthropic 압축 베타)을 사용합니다. 사용할 수 없거나 실패한 방식은 다음 선호 방식으로 넘어갑니다.
- `compaction.asyncEnabled` = `true`. 비동기(추측 실행) 압축입니다. 컨텍스트가 임계값 직전 구간 `[threshold − lead, threshold)`에 들어가면(`lead = clamp(threshold × 0.125, 8192, 32000)`) 유지 관리는 분기 스냅샷을 바탕으로 설정된 첫 LLM 기반 방식(`remote`, `handoff`, `soft`)의 백그라운드 요약을 시작합니다. 보조 세션 ID로 현재 턴과 격리합니다. 실제 임계값을 넘으면 준비한 결과를 즉시 저장해 요약 지연을 숨기며 스냅샷 이후 턴은 변경 없이 요약 뒤에 붙입니다. 분기 접두부가 바뀌거나(새 압축, 초기화 경계, `/tree` 탐색), 활성 모델이 제공업체 네이티브 재생 페이로드를 더 이상 읽을 수 없거나, 계산 이후 컨텍스트가 `keepRecentTokens` 이상 늘면 준비한 결과를 버립니다. 마지막 경우에는 새 추측 실행으로 대체합니다. 확장 기능이 `session_before_compact`를 등록했으면 추측 실행을 생략합니다. 실행 중에는 상태 표시줄의 자동 압축 아이콘이 맥동하고 결과가 준비되면 강조색을 유지합니다.
- `compaction.reserveTokens`는 기본 미설정입니다. 실효 예약량은 `max(floor(contextWindow × 0.15), configuredReserve ?? 16384)`입니다. 작은 창에서 미설정 기본값이 부적절하거나 실효 예약량이 창 전체 이상이면 예산 검사는 비례 예약량을 사용합니다. 그 외 명시적 예약량도 최소 15%를 유지합니다.
- `compaction.keepRecentTokens` = `20000`. 준비 과정에서는 압축된 컨텍스트가 복구 구간(트리거의 80%)에 들어가도록 이 예산을 제한합니다. 상한은 `0.8 × trigger − reserveFloor`이며, `reserveFloor`는 실효 예산 예약량과 `compaction.reserveTokens`(미설정 시 `16384`) 중 작은 값입니다. 하한만으로 구간을 채우면 구간의 절반을 사용합니다. 측정 사용량에 따른 조정 전에 이 상한을 적용하므로 작은 창이나 제공업체가 제한한 창에서 트리거가 낮으면 즉시 다시 압축하는 대신 더 적은 기록을 유지합니다.
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`. `false`는 해당 설정을 지정한 세션에만 적용하며 생성한 하위 에이전트에는 적용하지 않습니다. 각 하위 에이전트는 실행 중 검사를 유지하므로 단일 턴 작업도 설정한 임계값에서 압축합니다.
- `compaction.handoffSaveToDisk` = `false`
- `handoff` 방식은 현재 캐시의 보조 요청 파이프라인으로 인계 문서를 만들고 현재 세션의 압축 항목으로 저장합니다. 새 세션은 만들지 않으며 `/handoff`는 같은 작업을 수동 실행합니다.
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1`, `compaction.thresholdTokens` = `-1`. 양수 고정 토큰 한도가 백분율보다 우선하며 그렇지 않으면 예약량 기반 임계값을 사용합니다.
- `compaction.modelThresholds` = `{}`. `provider/model-id` 또는 `provider/…*` 접두부를 활성 모델의 토큰 기준값, 고정 실행 조건(`"f90000"`), 두 임계값을 대체할 백분율에 매핑합니다. 토큰 기준값은 창 대신 임계값 정책의 배율 기준이 되며 전역 `thresholdTokens`는 제외합니다. `/models` 역할 화면(`k`)에서 편집할 수 있습니다. [설정](./settings.md#context-compaction-and-memory)을 참고하세요.
- `task.agentCompactionThresholdOverrides` = `{}`. 정확한 이름의 task/eval 에이전트를 해당 에이전트의 두 임계값을 대체할 토큰 수(`90000`) 또는 백분율(`"80%"`)에 매핑합니다. [설정](./settings.md#context-compaction-and-memory)을 참고하세요.
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`(확인된 1시간 프롬프트 캐시 항목이 시간을 정하지 않을 때의 대체값)
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"`(`"agents-md"`와 `"all"`은 일시적인 시스템 프롬프트 이미지화를 활성화)
- `snapcompact.toolResults` = `false`(최신 결과를 포함한 큰 도구 결과의 일시적 이미지화). 모델 카탈로그 규칙이 `snapcompact-image-reads`(Opus 5.5+)를 지정하지 않으면 `read` 결과는 텍스트로 유지합니다. 프레임은 공백을 합치므로 이미지화된 `read`는 각 줄의 앞쪽 들여쓰기를 개수 표시로 그립니다. 예를 들어 `[»2]`는 탭 두 개, `[·4]`는 공백 네 개입니다. 편집할 때 복사할 수 있도록 `[path#TAG]` 헤더는 프레임 옆에 텍스트로 유지합니다. 계획기는 `snapcompact.*` 설정·모델·이전 기록이 바뀌거나 이후 이미지가 제공업체 이미지 상한을 초과할 때까지 결과를 처음 전송한 형태로 유지합니다. 이후 요청 바이트 한도로 오래된 인라인 프레임이 제거될 수 있으며 다른 인라인 이미지도 같습니다.
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

이 값은 런타임에서 `AgentSession`, `SessionMaintenance`, 압축·분기 요약 모듈이 사용합니다.
