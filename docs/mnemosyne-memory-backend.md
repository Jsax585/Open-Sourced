<a id="mnemopi-memory-backend"></a>
# Mnemopi 메모리 백엔드

omp는 `@oh-my-pi/pi-mnemopi`를 로컬 장기 메모리 백엔드로 사용할 수 있습니다.

다음과 같이 설정합니다.

```yaml
memory:
  backend: mnemopi
```

예시:

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged
```

이 백엔드를 활성화하면 코딩 에이전트는 다음과 같이 동작합니다.

1. 설정된 뱅크 범위에 따라 하나 이상의 로컬 Mnemopi SQLite 데이터베이스를 엽니다.
2. 세션의 첫 모델 턴에 관련 메모리를 `<memories>` 블록으로 불러오며, `agent_start` 리스너에서 회상하면 기본 프롬프트를 갱신합니다.
3. 에이전트 턴이 끝난 뒤 완료된 대화 턴을 보존용 뱅크에 저장합니다. 저장 간격은 `mnemopi.retainEveryNTurns`보다 짧지 않습니다.
4. 압축 과정에서 메모리 백엔드에 `preCompactionContext`를 요청하면 회상한 메모리를 추가 압축 컨텍스트로 사용합니다.
5. 공통 메모리 백엔드 인터페이스를 통해 일반적인 `/memory view`, `/memory stats`, `/memory diagnose`, `/memory clear`, `/memory enqueue` 명령을 사용합니다.

회상한 메모리는 지시가 아니라 배경 컨텍스트입니다. 충돌할 경우 현재 사용자 메시지와 도구 출력이 우선합니다.

<a id="agent-tools"></a>
## 에이전트 도구

Mnemopi를 선택하면 다음 도구를 검색하여 사용할 수 있습니다.

- `recall` — 범위 내 메모리를 검색합니다. 결과에는 미리보기와 메모리 ID가 포함됩니다.
- `retain` — 지속적으로 보존할 사실을 명시적으로 저장합니다.
- `reflect` — 회상한 여러 메모리를 종합해 답변을 만듭니다.
- `memory_edit` — ID로 편집 가능한 메모리를 `update`, `forget`, `invalidate`합니다. 사실 테이블의 행은 읽기 전용입니다.

회상 결과를 교체하기 전에 `read memory://<memory-id>`로 전체 내용과 메타데이터를 읽으세요. 잘린 회상 미리보기는 안전한 업데이트 입력이 아닙니다. 선택적 `learn` 도구도 `autolearn.enabled: true`일 때 Mnemopi에 내용을 보존할 수 있습니다.

첫 턴의 회상은 대화 기록의 일부이며 세션 파일에 `memory_recall` 항목으로 저장됩니다. 세션을 재개하거나 전환하거나 분기할 때 다시 회상하지 않고 해당 블록을 그대로 전송하므로, 시스템 프롬프트와 이를 기반으로 한 공급자 프롬프트 캐시가 프로세스 간에 동일하게 유지됩니다. 이후 회상한 메모리가 삭제, 무효화, 만료되거나 회상 미리보기가 바뀌면(`/memory clear` 또는 `memory_edit`에 의한 변경 포함), 다음 프롬프트로 시작하는 턴에 변경 사항을 나열하는 일회성 숨김 메모가 포함됩니다. 원래 블록은 다시 쓰지 않습니다. 컨텍스트를 초기화하거나 다른 메모리 데이터베이스를 사용하거나 첫 프롬프트를 수정하는 분기로 이동하면 새로 회상합니다. 저장소에서 메모리를 삭제한 뒤에도 회상된 텍스트는 세션 파일에 남습니다.

<a id="settings"></a>
## 설정

| 설정 | 기본값 | 설명 |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend` | `off` | 이 백엔드를 활성화하려면 `mnemopi`로 설정합니다. |
| `mnemopi.dbPath` | 에이전트 메모리 디렉터리 | 선택적 SQLite 데이터베이스 경로입니다. |
| `mnemopi.bank` | 미설정 | `Mnemopi`에 전달할 선택적 공유 뱅크 기본 이름입니다. 코딩 에이전트 래퍼는 `mnemopi.scoping`에 따라 이 이름에서 범위를 파생합니다. 미설정 시 공유 뱅크는 `default`이며, 프로젝트별 모드에서는 작업 디렉터리의 기본 이름과 절대 경로의 안정적인 해시로 프로젝트 뱅크를 만듭니다. |
| `mnemopi.scoping` | `per-project` | 메모리 가시성 모드입니다. `global`은 하나의 공유 뱅크, `per-project`는 격리된 프로젝트 메모리, `per-project-tagged`는 프로젝트 로컬 쓰기와 전역 회상 가시성을 사용합니다. |
| `mnemopi.autoRecall` | `true` | 세션의 첫 턴에 메모리를 회상합니다. |
| `mnemopi.autoRetain` | `true` | 완료된 턴을 자동으로 보존합니다. |
| `mnemopi.polyphonicRecall` | `false` | 상호 순위 기반의 표준 순위를 벡터, 그래프, 사실, 시간 관점과 융합합니다. 따라서 (`mnemopi.proactiveLinking` 또는 통합으로) 일화 그래프에 연결된 메모리나 통합 추출 사실로 연결된 메모리를 키워드 일치 없이도 찾을 수 있습니다. `MNEMOPI_POLYPHONIC_RECALL`이 설정되어 있으면 우선합니다. |
| `mnemopi.enhancedRecall` | `false` | 쿼리별 회상 결과를 최대 5분간 캐시합니다. 키에는 모든 회상 옵션(limit, facts, channel, time, bank)이 포함되며, 비슷한 쿼리도 옵션이 동일할 때만 항목을 재사용합니다. 뱅크에 쓰기가 발생하면 캐시를 비웁니다. `MNEMOPI_ENHANCED_RECALL`이 설정되어 있으면 우선합니다. |
| `mnemopi.proactiveLinking` | `false` | 새 메모리를 저장하면서 일화 그래프에 추가하고 관련 개체 및 메모리와 연결합니다. `MNEMOPI_PROACTIVE_LINKING`이 설정되어 있으면 우선합니다. |
| `mnemopi.retainEveryNTurns` | `4` | 자동 보존 쓰기 사이의 최소 사용자 턴 수입니다. |
| `mnemopi.recallLimit` | `8` | 프롬프트 블록에 포함할 최대 회상 메모리 수입니다. |
| `mnemopi.recallContextTurns` | `3` | 회상 쿼리에 포함할, 사용자 메시지를 경계로 나눈 이전 턴 수입니다. |
| `mnemopi.recallMaxQueryChars` | `4000` | 구성된 회상 쿼리의 최대 길이입니다. |
| `mnemopi.injectionTokenLimit` | `5000` | 메모리 프롬프트 주입에 사용할 대략적인 토큰 예산입니다. |
| `mnemopi.debug` | `false` | 백엔드 실패의 디버그 로깅을 활성화합니다. |
| `mnemopi.noEmbeddings` | `false` | `Mnemopi`에 `noEmbeddings`를 전달하고 FTS 전용 회상을 강제합니다. |
| `mnemopi.embeddingVariant` | `en` | 로컬 임베딩 모델 변형입니다. `en`은 `BAAI/bge-base-en-v1.5`(768차원), `multilingual`은 `intfloat/multilingual-e5-large`(1024차원)입니다. `mnemopi.embeddingModel`/`MNEMOPI_EMBEDDING_MODEL`이 우선하며, 변경하면 다음 쓰기 가능한 시작 시 저장된 임베딩을 다시 만듭니다. |
| `mnemopi.embeddingModel` | 변형 기본값 | 명시적 임베딩 모델 ID이며 `mnemopi.embeddingVariant`보다 우선합니다. 우선순위는 이 설정 > `MNEMOPI_EMBEDDING_MODEL` 환경 변수 > 변형 기본값입니다. 빈 문자열이나 `null`은 미설정으로 처리합니다. |
| `mnemopi.embeddingApiUrl` | 환경 변수/기본값 | `Mnemopi`에 전달할 OpenAI 호환 임베딩 엔드포인트입니다. |
| `mnemopi.embeddingApiKey` | 환경 변수/기본값 | `Mnemopi`에 전달할 임베딩 API 키입니다. |
| `mnemopi.llmMode` | `smol` | `smol`은 `memory` 모델 역할과 재시도 체인을 확인하고, `remote`는 아래 설정을 사용하며, `none`은 LLM 호출을 비활성화합니다. |
| `mnemopi.llmBaseUrl` | 환경 변수/기본값 | `llmMode: remote`에서 사용할 OpenAI 호환 LLM 엔드포인트입니다. |
| `mnemopi.llmApiKey` | 환경 변수/기본값 | `llmMode: remote`에서 사용할 LLM API 키입니다. |
| `mnemopi.llmModel` | 환경 변수/기본값 | `llmMode: remote`에서 사용할 LLM 모델 ID입니다. |

<a id="scoping"></a>
## 범위 지정

코딩 에이전트 래퍼는 기본 `Mnemopi` 패키지 위에 다음 범위 규칙을 적용합니다.

- `global`은 회상과 쓰기에 하나의 공유 뱅크를 사용합니다.
- `per-project`는 현재 작업 디렉터리만으로 파생한 뱅크에 쓰고 해당 뱅크에서 회상합니다. 이름은 기본 이름과 절대 경로의 안정적인 해시로 구성되며 주변 Git 구조와 무관합니다.
- `per-project-tagged`는 프로젝트 로컬 뱅크에 쓰고 프로젝트 로컬 뱅크와 공유 전역 뱅크 모두에서 회상하며 중복 결과를 합칩니다.

`global`과 `per-project-tagged`에서는 `retain` 및 `learn` 도구에 `scope: "global"`도 지정할 수 있습니다. 항목이나 교훈을 공유 뱅크에 저장하여 모든 프로젝트에서 회상하도록 합니다. `per-project`에서는 모든 프로젝트가 회상하는 뱅크가 없으므로 이 옵션을 제공하지 않습니다.

비전역 모드에서는 작업 메모리의 모든 행이 `metadata.cwd`에 현재 절대 cwd를 가진 기존 형제 뱅크도 회상합니다. cwd가 혼재하거나 비어 있거나 손상되거나 읽을 수 없는 뱅크는 제외합니다. 시작 시 추가 뱅크 디렉터리는 최대 64개까지 조사합니다. 새 쓰기는 계속 현재 프로젝트 뱅크를 사용합니다.

프로젝트와 전역을 결합하는 동작은 래퍼에서 구현합니다. `@oh-my-pi/pi-mnemopi` 패키지 자체는 뱅크 이름을 선택하는 `bank`를 비롯한 뱅크와 생성자 옵션을 그대로 노출합니다. 공유 뱅크 외의 프로젝트 로컬 뱅크는 Mnemopi의 `BankManager`가 관리하는 형제 뱅크 데이터베이스로 저장됩니다.

<a id="recall-previews-and-full-row-reads"></a>
## 회상 미리보기와 전체 행 읽기

회상 결과에는 전체 행이 아니라 잘린 내용 미리보기가 포함됩니다. 미리보기 한도를 넘는 내용은 끝에 `…`를 붙여 자르며, 결과에 `truncated: true`와 `full_length`(원래 문자 수)도 설정하므로 호출자는 표시 문자를 파싱하지 않고 잘림을 감지할 수 있습니다. 한도는 `RecallOptions.contentPreviewChars`입니다(기본값 `500`, `0`이면 자르지 않음).

전체 행은 언제든 `memory://<memory-id>`를 읽어 가져올 수 있습니다. 현재 작업 메모리 또는 일화 메모리 행을 찾아 작은 YAML 프런트매터 헤더(`id`, `bank`, `store`, `memory_type`, 타임스탬프, `importance`, `veracity`, `session_id`, `metadata`) 뒤에 전체 내용을 반환합니다. `update`는 내용을 통째로 교체하므로 잘린 미리보기에서 보이지 않는 뒷부분을 잃지 않도록, 코딩 에이전트의 모델용 프롬프트는 모든 `memory_edit update` 전에 이 읽기를 요구합니다.

보존 시에는 프로토콜 마커를 제거한 대화 기록 투영본을 씁니다. 호스트가 저장할 대화 기록과 함께 `embedText` 재정의 값을 제공하면 임베딩, 작업 메모리 FTS 인덱싱(`COALESCE(embed_text, content)`), 재구축 시 재임베딩에 이 투영본을 사용합니다. 따라서 저장된 대화 기록의 보존 프로토콜 마커가 벡터 및 전문 회상을 오염시키지 않습니다.

<a id="recall-ranking-weights"></a>
## 회상 순위 가중치

회상은 각 메모리의 점수에 저장된 `veracity` 레이블의 가중치를 곱하고, 일화 메모리에는 열화 단계의 가중치도 곱합니다. 각 가중치는 회상할 때마다 해당 환경 변수에서 읽습니다.

| 변수 | 기본값 | 적용 대상 |
| ------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `MNEMOPI_STATED_WEIGHT` | `1.0` | 코딩 에이전트의 명시적 메모리 저장(확장 `memory.save` API)이 기록하는 `veracity: stated` |
| `MNEMOPI_UNKNOWN_WEIGHT` | `0.8` | 코딩 에이전트의 자동 대화 기록 보존 및 레이블을 지정하지 않은 쓰기가 기록하는 `veracity: unknown` |
| `MNEMOPI_INFERRED_WEIGHT` | `0.7` | `veracity: inferred` |
| `MNEMOPI_IMPORTED_WEIGHT` | `0.6` | `veracity: imported` |
| `MNEMOPI_TOOL_WEIGHT` | `0.5` | 코딩 에이전트의 `retain` 및 `learn` 도구가 기록하는 `veracity: tool` |
| `MNEMOPI_TIER1_WEIGHT` | `1.0` | 열화 1단계 일화 메모리 |
| `MNEMOPI_TIER2_WEIGHT` | `0.85` | 열화 2단계 일화 메모리 |
| `MNEMOPI_TIER3_WEIGHT` | `0.7` | 열화 3단계 이상 일화 메모리 |

슬립 통합은 작업 메모리의 레이블을 생성된 일화 메모리에 이어 붙입니다.

`true` 또는 `likely_true` 레이블의 가중치는 항상 `1.0`이며 `false`는 `0`입니다. `mnemopi.polyphonicRecall`에서는 이 가중치가 융합된 `hybrid` 관점이 되는 표준 순위를 정합니다. 벡터, 그래프, 사실, 시간 관점에는 적용하지 않습니다.

<a id="llm-and-embeddings"></a>
## LLM과 임베딩

FTS 및 임베딩 경로는 아래 설정을 사용합니다. `llmMode: smol`은 `memory` 역할과 설정된 재시도 체인을 확인하고 호출 시점에 자격 증명을 가져옵니다. 역할이 미설정이면 `tiny`, 그다음 빠른 모델(`smol`) 기본값을 재사용합니다. 로컬 추론 및 온라인 모델을 모두 지원합니다. `llmMode: remote`는 OpenAI 호환 엔드포인트 설정을 사용하며 `llmMode: none`은 LLM 호출을 비활성화합니다. 사용할 수 있는 모델이나 자격 증명을 찾지 못하면 LLM 기반 작업 없이 Mnemopi를 계속 실행합니다. 기존 `providers.memoryModel` 설정은 `memory` 역할로 마이그레이션됩니다.

FTS 전용:

```yaml
memory:
  backend: mnemopi
mnemopi:
  noEmbeddings: true
```

동등한 생성자 형태:

```ts
new Mnemopi({ noEmbeddings: true });
```

원격 임베딩:

```yaml
mnemopi:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

동등한 생성자 형태:

```ts
new Mnemopi({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

원격 LLM:

```yaml
mnemopi:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

동등한 생성자 형태:

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

교체되는 OAuth 토큰을 위한 동적 함수형 LLM:

```ts
new Mnemopi({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithPiAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

관리형 memory 역할 LLM:

```yaml
mnemopi:
  llmMode: smol
```

코딩 에이전트는 `memory` 역할을 확인하고 동적 완성 함수를 전달합니다. 따라서 각 Mnemopi LLM 호출은 호출 시점의 최신 공급자 자격 증명을 가져오고 해당 역할의 대체 후보를 시도할 수 있습니다.

```ts
new Mnemopi({
  llm: async (prompt, opts) => completeMemoryRoleWithCurrentAuth(prompt, opts),
});
```

<a id="operational-notes"></a>
## 운영 참고 사항

- 기본 공유 데이터베이스는 에이전트 메모리 디렉터리 아래 `mnemopi/mnemopi.db`에 있습니다. 프로젝트 범위 뱅크는 해당 Mnemopi 디렉터리 아래의 형제 데이터베이스 경로를 사용합니다.
- `/memory clear`는 활성 설정 범위에 속한 모든 Mnemopi SQLite 데이터베이스와 부속 WAL/SHM 파일을 삭제합니다.
- `/memory enqueue`는 현재 세션의 보존을 강제하고 대기 중인 사실 추출을 비운 뒤, 대상 작업 메모리 행에 Mnemopi 슬립/통합을 실행합니다.
- Mnemopi 백엔드가 활성화되어 있으면 `/memory stats`와 `/memory diagnose`는 백엔드별 뱅크 통계 및 진단을 표시합니다.
- 하위 에이전트는 별도의 Mnemopi 보존 루프를 소유하지 않습니다. 부모 Mnemopi 상태가 있으면 부모 상태를 참조하며, 없으면 비활성 상태를 유지합니다.
- 기본 백엔드 시작 시, 첫 쓰기가 TTL 기준으로 잘라내기 전에 소유한 뱅크 전체에서 대상 작업 메모리 행을 승격합니다. 승격 실패는 기록하되 백엔드를 비활성화하지 않습니다.
- 백엔드 시작은 가능한 범위에서 진행합니다. 데이터베이스나 모델 초기화에 실패하면 경고를 기록하고 Mnemopi가 비활성인 채로 세션을 계속합니다. 이때 메모리 도구는 백엔드가 초기화되지 않았다고 알립니다.
- 로컬 임베딩 모델은 세션별이 아니라 머신별로 한 번 로드됩니다. 각 (모델, fastembed 캐시 디렉터리) 쌍은 `~/.omp/run/mnemopi/` 아래 IPC 엔드포인트를 소유하는 하나의 분리된 `omp mnemopi embed <model>` 서버가 제공합니다(로그는 옆에 저장). 처음 필요한 omp 프로세스가 서버를 시작하고 나머지는 연결합니다. 추론은 서버 전용 `onnxruntime` 자식 프로세스에서 실행됩니다. 서버는 요청이 15분간 없으면 종료하여 모델 메모리를 해제하며, 다른 버전의 omp 프로세스가 연결하면 교체됩니다. 정상 상태의 임베딩이 2분을 넘기면 실패하고 서버는 추론 자식 프로세스를 종료한 뒤 다시 생성합니다.

<a id="shutdown-and-durability"></a>
## 종료와 내구성

일반 대화형 종료와 출력 모드 종료는 의도적으로 `/memory enqueue`보다 가벼운 경로를 사용합니다.

1. 기본 상태는 새 사실 추출을 비활성화한 채 현재 대화 기록을 보존합니다.
2. 이미 진행 중이던 추출을 비우지만, 세션별 슬립이나 전체 세션 간 승격은 실행하지 않습니다.
3. 이 배출 작업이 끝난 뒤에만 소유한 SQLite 뱅크 핸들을 닫습니다. 배출 중에도 임베딩이 필요할 수 있으므로 프로세스는 상태 폐기 후 임베딩 서버 연결을 끊습니다. 서버는 유휴 종료 시점까지 다른 세션을 위해 계속 실행되며, 이미 진행 중인 모델 다운로드도 마칩니다.

부모 상태를 참조하는 하위 에이전트 상태는 공유 뱅크를 소유하거나 닫지 않습니다. 최종 보존, 비우기, 핸들 닫기는 부모 상태가 담당합니다.

대화형 및 출력 모드 종료는 이 배출 작업에 1.5초를 부여합니다. 시간이 만료되면 진행 중인 배출을 분리하고 완료 시 핸들을 닫도록 하여, 닫힌 데이터베이스에 쓰는 경합을 피합니다. 프로세스가 먼저 종료될 수 있습니다. 이미 기록된 작업 메모리 행은 지속적으로 보존되지만 마지막 몇 턴의 승격이나 임베딩은 미완료일 수 있습니다. 앞선 턴에서 에이전트 종료 시 수행한 보존에는 영향이 없습니다.

`/memory enqueue`는 명시적으로 더 강한 내구성 경계입니다. 보존을 강제하고 대기 중인 추출을 비우며 소유한 뱅크 전체에 완전한 슬립/통합을 실행합니다. 다만 Mnemopi의 경과 시간 조건을 우회하지는 않습니다. `sleepAllSessions`는 `Math.floor(workingMemoryTtlHours / 2)`시간보다 오래된 미통합 작업 메모리 행을 선택합니다(기본 TTL 24시간이면 12시간). 따라서 즉시 enqueue한 뒤에도 새 행은 작업 메모리에 남습니다. 종료 전에 이 명령으로 보존과 대기 작업 비우기를 강제하거나, 경과 시간 조건을 충족한 뒤 실행하여 대상 행을 승격하세요. 일반 종료는 해당 행을 승격하지 않습니다.
