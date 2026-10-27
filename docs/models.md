<a id="model-and-provider-configuration-modelsyml--modelsyaml"></a>
# 모델 및 제공자 구성 (`models.yml` / `models.yaml`)

이 문서는 coding-agent가 현재 모델을 불러오고, 재정의를 적용하고, 자격 증명을 확인하고, 런타임에 모델을 선택하는 방식을 설명합니다.

<a id="what-controls-model-behavior"></a>
## 모델 동작을 제어하는 요소

주요 구현 파일:

- `packages/coding-agent/src/config/model-registry.ts` — 내장 및 사용자 지정 모델 로드, 제공자 재정의, 런타임 탐색, 인증 통합
- `packages/coding-agent/src/config/model-resolver.ts` — 모델 패턴 파싱 및 초기/smol/slow 모델 선택
- `packages/coding-agent/src/config/model-settings.ts` — 모델 선택 설정(`modelRoles`, `enabledModels`, `enabledProviders`/`disabledProviders`, `modelProviderOrder`, `cycleOrder`)
- `packages/coding-agent/src/session/settings.ts` — 제공자 전송 환경설정(`providers.*`)
- `packages/coding-agent/src/config/models-config.ts` 및 `models-config-schema-bundle.ts` — 사용자 지정 제공자/모델 검증
- `packages/coding-agent/src/session/auth-storage.ts` — `@oh-my-pi/pi-ai`의 `AuthStorage` 재내보내기. 자격 증명 우선순위는 `packages/ai/src/auth/cascade.ts`에서 구현
- `packages/catalog/src/compat/resolve.ts` 및 `compat/rules/` — 호환성 및 모델 정책 확인
- `packages/catalog/src/models.ts` 및 `packages/catalog/src/types.ts` — 내장 제공자/모델 및 공개 모델 타입

<a id="config-file-location-and-legacy-behavior"></a>
## 구성 파일 위치와 레거시 동작

기본 프로필의 구성 경로(우선순위 순):

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

이 경로는 `getAgentDir()`이 반환하는 활성 에이전트 디렉터리를 기준으로 합니다. 이름 있는 프로필은
`~/.omp/profiles/<name>/agent/`를 사용합니다. `PI_CONFIG_DIR`은 구성 루트 디렉터리 이름을 바꾸고,
`PI_CODING_AGENT_DIR`은 기본 프로필의 에이전트 디렉터리를 재정의할 수 있습니다.
프로그래밍 방식으로 지정한 `ModelRegistry` 경로는 디렉터리에서 유도한 위치보다 우선합니다.

현재도 유지되는 레거시 동작:

- 두 YAML 파일이 모두 없고 같은 위치에 `models.json`이 있으면 `models.yml`로 마이그레이션합니다.
- `ModelRegistry`에 프로그래밍 방식으로 전달한 명시적 `.json` / `.jsonc` 구성 경로도 계속 지원합니다.

<a id="modelsyml--modelsyaml-shape"></a>
## `models.yml` / `models.yaml` 구조

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id`는 모델 선택과 인증 조회 전반에 사용하는 정규 제공자 키입니다.

`providers`는 레지스트리가 사용하는 유일한 루트 키입니다. 현재 스키마는 알 수 없는 루트 키를 거부하지 않지만, 그런 키는 모델 동작을 구성하지 않습니다.

<a id="provider-level-fields"></a>
## 제공자 수준 필드

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
      timeoutMs: 10000 # optional per-provider HTTP probe timeout in milliseconds
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        imageInputDecoder: stb # local STB decoder; OMP converts WebP before dispatch
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxContextWindow: 256000 # optional extended-context window
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

`maxContextWindow`는 `models` 항목과 `modelOverrides` 모두에서 사용할 수 있습니다.
`contextWindow`는 일반 프롬프트 창으로, `maxContextWindow`는 제공자가 허용하는 더 큰 프롬프트 창으로
설정하세요. `/extended-context on`은 더 큰 창을 선택하며 `off`는 일반 창으로 복원합니다.
`contextWindow`만 지정한 재정의는 이전처럼 두 모드에서 모두 고정됩니다. 이는 제공자의 서버 측 제한이 아니라
OMP의 로컬 컨텍스트 예산을 바꾸므로, 엔드포인트가 구성한 크기의 요청을 허용하는지 확인하세요.
구성한 최댓값은 제공자가 알린 용량을 대체하지 않습니다. Codex Astra처럼 카탈로그 재정의 상한이 있는
모델은 여전히 그 상한으로 제한됩니다. 폐기된 변형 별칭을 포함한 모델별 재정의는 확장 창 선택 전에 확인합니다.

사용자 지정 `models` 항목은 자체 `baseUrl`을 설정할 수 있으며, 그렇지 않으면 제공자 URL을 상속합니다.
내장 모델의 경우 제공자 `baseUrl` 재정의는 이를 상속하는 사용자 지정 모델의 유효 API 범위에 적용되고,
재정의 전용 구성에서는 제공자의 `api` 범위에 적용됩니다. 두 범위가 모두 없으면 제공자 전체에 적용됩니다.
`transport: pi-native`는 항상 게이트웨이 URL을 제공자 전체에 적용합니다.
범위가 없는 OpenRouter `baseUrl`은 `/api/v1` 채팅 루트를 뜻하므로 OpenRouter Decisions(judge) 모델은
동일 호스트의 `/api/alpha` 경로를 사용합니다. 예를 들어 `.../api/v1` 릴레이는
`.../api/alpha/decisions`에서 판단 모델을 제공합니다.

모델 또는 `modelOverrides` 항목의 `preferWebsockets`는 Codex 요청의 WebSocket 전송 선호 여부를
제어합니다. `omitMaxOutputTokens`는 모델에서 유도한 출력 상한을 생략합니다.

<a id="bedrock-request-options"></a>
### Bedrock 요청 옵션

제공자 수준 `guardrailIdentifier`, `guardrailVersion`, `guardrailTrace`는 Converse 요청에 가드레일을
연결합니다. 식별자를 설정하면 버전 기본값은 `"DRAFT"`이며 trace는 `enabled`, `disabled`,
`enabled_full`을 허용합니다. `requestMetadata`는 호출 로그 태그를 제공합니다. 잘못된 항목과 Bedrock의
16개 제한을 넘는 항목은 전송 전에 버립니다. 요청별 태그는 같은 모델 태그를 재정의합니다.
이 필드는 Anthropic Messages 경로를 구성하지 않습니다.

<a id="compaction-options"></a>
### 압축 옵션

- `compactionModel`(`modelOverrides`를 포함한 모델별 설정) — 선호 압축 모델입니다. 활성 모델, 채팅 역할 후보, 최대 컨텍스트 폴백보다 먼저 시도하며 활성 대화 모델을 전환하지 않습니다.
- `remoteCompaction`(제공자 수준 또는 모델별 설정) — 해당 모델에서 제공자 기본 압축을 사용하도록 합니다. 지원 키는 `enabled`, `api`, `endpoint`, `model`, `v2StreamingEnabled`, `v2Endpoint`, `streamingEndpoint`입니다. 제공자 설정을 기준으로 모델별 키가 재정의합니다.

<a id="allowed-providermodel-api-values"></a>
### 허용되는 제공자/모델 `api` 값

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`
- `typesafe`
- `openrouter-decisions`
- `openai-decisions`
- `workers-ai-systemone`

`typesafe`, `openrouter-decisions`, `openai-decisions`, `workers-ai-systemone`은 채팅 전송이 아닌 판단 API입니다. 해당 API로 선언한 모델은 판단 요청에 응답하며 `judge` 모델 역할로 선택합니다. `typesafe`는 TypeSafe의 System One 본문을 `{baseUrl}/v1/systemone`에 전송합니다(TypeSafe, OpenJEV, Kev, 자체 호스팅 Clef 등 모든 System One 서버). `openrouter-decisions`는 같은 본문을 `{baseUrl}/decisions`로 전송합니다. `openai-decisions`는 질문과 답을 OpenAI Decisions API의 `{baseUrl}/decisions` 형식으로 변환합니다(번들 `openai/gpt-6-luna-decisions` 항목은 전송 모델로 `gpt-6-luna` 사용). `workers-ai-systemone`은 System One 본문을 Cloudflare Workers AI의 `{baseUrl}/{model id}`로 전송하며, 기본 URL의 `<account>`는 저장된 자격 증명의 계정 ID 또는 `CLOUDFLARE_ACCOUNT_ID`로 채웁니다. 이 트래픽의 게이트웨이 라우팅 또는 사용자 지정 인증 헤더는 `headers`에 담습니다.
판단 요청은 비전 채팅 요청과 이미지 첨부를 공유할 수 있습니다. 기본 OpenAI Decisions, TypeSafe Jev, OpenRouter Jev, Workers AI 판단 모델과 프롬프트 기반 비전 채팅 모델은 이미지를 지원하며, 텍스트 전용 후보는 이미지 요청에서 건너뜁니다. `Judge.supportsImages`로 호환 후보를 확인하며 이미지 지원 모델이 없는 판단 체인은 이미지를 버리지 않고 명시적으로 실패합니다. 프롬프트 기반 판단은 작은 래스터 확대와 STB 기반 디코더용 WebP 변환을 포함해 선택한 후보에 맞게 이미지를 정규화하며, 기본 판단 모델은 원래 이미지 바이트를 계속 받습니다. System One용 `NativeJudge`를 직접 생성할 때는 `supportsImages: true`를 설정하세요. `createNativeJudge`는 이 플래그를 카탈로그에서 유도합니다.

카탈로그 기반 기본 판단 모델은 선택한 모델의 이미지 범위를 적용합니다. 직접 호출하는 `NativeJudge` 생성자에는 `imageInput` 범위를 명시할 수 있습니다. 이미지 사용을 활성화한다고 관련 없는 System One 모델에 Jev 크기 제한이 상속되지는 않습니다.

OpenAI Decisions는 포함된 `ImageContent.detail`을 전달하며, 명시적 품질 설정이 다르면 기본 이미지 판단 캐시 항목도 구분합니다. TypeSafe Jev에는 대응하는 이미지 세부 수준이 없어 전송과 캐시 식별에서 detail을 무시하므로, detail만 다른 요청은 답을 재사용할 수 있습니다. 생략한 detail과 명시적 `auto`는 기본 설정을 공유합니다.

이미지 입력은 후보 실행 전에 검증합니다. 잘못된 이미지는 체인을 소진하지 않고 호출자 오류로 실패합니다. 제공자가 추가 제한을 적용할 수 있습니다. Workers AI Clef는 각 최대 4 MiB 및 16 MP, 합계 8 MiB인 PNG, JPEG, WebP 이미지를 최대 4개 허용합니다. 유효한 패딩 유무의 base64와 MIME 대소문자 변형은 같은 캐시 식별을 공유합니다.

이미지 필터링 후에는 텍스트 판단과 같은 기본 모델 전용 후속 정책이 적용됩니다. 기본 판단 모델 실패 후에는 다른 호환 기본 모델로만 넘어가며 프롬프트 기반 채팅 모델로 넘어가지 않습니다. 필터링은 이미지 미지원 기본 모델과 요청이 이미지 개수 상한을 넘는 기본 모델을 제거하므로, 호환 기본 모델이 남지 않으면 적격 프롬프트 후보와 비전 지원 세션 모델 폴백이 응답할 수 있습니다. 크기 범위 때문에 기본 모델을 제거하지는 않습니다. 먼저 이미지를 범위에 맞춥니다(아래 참조).

<a id="jev-images-experimental"></a>
#### Jev 이미지(실험적)

Jev의 기본 이미지 판단은 실험적입니다. 직접 TypeSafe Jev는 `jev-latest`, `jev-preview`, `jev-1.13.0`, `jev-1.14.0`을 지원합니다(기본 `judge` 역할은 `typesafe/jev-1.14.0` 사용, TypeSafe 안정 별칭 `jev-latest`는 현재 `jev-1.13.0`). OpenRouter는 `typesafe/jev-1.13`, `typesafe/jev-1.14`, `~typesafe/jev-latest`를 지원합니다.

이미지는 `state`를 대체하지 않고 추가됩니다. 루트가 객체이면 기존 필드를 유지하고 충돌 방지 키 `__omp_judgment_images` 아래에 추가합니다(이미 사용 중이면 숫자 접미사 사용). 배열이면 끝에 추가하고 문자열이면 `[original, ...images]`가 됩니다. 직접 TypeSafe 요청은 각 이미지를 참조된 `assets` 항목으로 추가하고 그 참조를 `state`에 넣으며, 이미지를 첨부할 때만 `TypeSafe-Danger-Zone-Images: true`를 설정합니다. 호출자가 제공한 자산(인증 게이트웨이)은 각각 `state`, `instructions`, `criteria`에서 참조되어야 하며 분할 요청에는 자신이 참조하는 자산만 담습니다. OpenRouter는 이미지를 `image_url` 데이터 URL 부분으로 인코딩하며 TypeSafe 헤더나 최상위 `images` 필드를 사용하지 않습니다.

텍스트 전용 요청은 원래 요청 구조와 바이트를 유지합니다. 이미지 지원은 나열한 TypeSafe Jev 및 OpenRouter Jev 모델로 한정되며, 다른 System One 호환 서버나 OpenRouter Decisions 모델의 지원을 의미하지 않습니다.

두 경로 모두 각 변 280–1568픽셀, 총 78,400–2,458,624픽셀의 PNG와 JPEG를 허용하며, 그 밖의 입력은 크기를 조절하지 않고 거부합니다. 따라서 판단 체인은 전송 전에 모든 이미지를 기본 판단 모델의 범위에 맞춥니다. 이미 범위 안이면 원래 바이트를 유지합니다. 그렇지 않으면 왜곡 없이 최댓값 이하로 줄이거나 최댓값이 허용하는 한 최솟값에 가깝게 키웁니다. 극단적인 종횡비로 한 변이 여전히 짧으면 왼쪽 위 픽셀로 여백을 채웁니다(401×41 도구 모음 자르기는 1568×280 가운데 배치된 1568×160이 됨). PNG로 다시 인코딩하며 PNG가 바이트 상한을 넘으면 JPEG를 사용합니다. TypeSafe Jev에는 이미지 세부 수준이 없으므로 직접 TypeSafe 요청에서 `ImageContent.detail`을 무시합니다.

[박스 질문](https://docs.typesafe.ai/primitives/box)(`{ type: "box", instructions, image }`)은 Jev 1.14가 필요하며 TypeSafe와 OpenRouter Decisions 판단 모델로만 전달됩니다. 이런 질문이 있는 요청은 그 밖의 모든 후보를 건너뛰고 프롬프트 또는 세션 모델 폴백도 사용하지 않습니다. `image`는 요청의 `images` 인덱스이며 전송되지 않으므로, 여러 이미지 중 검색할 이미지는 `instructions`에서도 지정해야 합니다. Jev는 받은 이미지에 대한 비율로 경계 좌표를 반환합니다. 이미지 맞춤 과정에서 여백을 추가했다면 체인은 좌표를 원래 입력 이미지로 역변환하고 여백 안의 좌표를 경계로 제한합니다.

이미지 제약은 TypeSafe의 [이미지 문서](https://docs.typesafe.ai/images)와 OpenRouter의 [멀티모달 Decisions 가이드](https://openrouter.ai/docs/guides/community/multimodal-decisions)를 참조하세요.

OpenRouter 가이드는 최소 변 길이를 256px로 설명하지만 [실제 Jev 1.14 요청 보고](https://github.com/can1357/oh-my-pi/pull/15887#issuecomment-6218295982)에서 270×300 PNG가 HTTP 400을 받았으므로, 의도적으로 최소 280px 제한을 유지합니다.

예를 들어 TypeSafe Jev를 판단 모델로 구성하고 JavaScript 또는 Python에서 이미지를 첨부할 수 있습니다.

```yaml
modelRoles:
  judge: typesafe/jev-1.14.0
```

```js
await judge(state, question, { images: ["./chart.png"] });
```

```python
await judge(state, question, images=["./chart.png"])
```

모델 또는 `modelOverrides` 항목은 하나의 모델 `kind`를 제공하는 실행기 API도 사용할 수 있습니다. 목록은 `packages/catalog/src/types.ts`의 `RUNNER_API_KINDS`에 있습니다(예: `openai-images`는 `image`, `openai-embeddings`는 `embedding`, `openai-speech`는 `tts` 제공). 내장 `web-search`는 여기에 지정할 수 없으므로 `kind: search`도 불가능합니다. `kind` 기본값은 API 종류(채팅 전송은 `chat`)이며 명시적 `kind`는 해당 API가 제공하는 종류여야 합니다. 채팅 전송은 `chat`과 `tiny`(`tiny`, `memory`, `judge` 역할용 소형 모델)를 제공합니다. `generate_image`가 실행하는 전송(`openai-responses`, `openai-codex-responses`, `google-generative-ai`, `google-gemini-cli`)은 `image`도 제공합니다. `openai-responses`에서는 `/images/generations` 대신 같은 제공자의 GPT-5+ 채팅 모델이 Responses의 `image_generation` 도구로 이미지를 생성합니다. 다음 구성은 탐색한 게이트웨이 모델을 이미지 역할로 옮깁니다.

```yaml
providers:
  my-gateway:
    api: openai-responses
    discovery:
      type: openai-models-list
    modelOverrides:
      gpt-image-2:
        api: openai-images # kind: image, generated via /images/generations
      gpt-image-1.5:
        kind: image # stays on openai-responses, generated via the hosted image tool
```

명시적이거나 실행기 API에서 유도된 구성 `kind`는 같은 ID의 번들 카탈로그 분류보다 우선하며 `modelOverrides`와 갱신 후에도 유지됩니다.

models.yml 로드 시 `modelOverrides`의 `kind`는 파일에서 지정한 API(재정의 자체 `api` 또는 같은 ID의 `models` 항목 API)에 대해서만 검증합니다. 내장/탐색 모델은 API를 나중에 받으므로 재정의를 적용할 때 검증합니다. API가 제공하지 않는 종류는 무시하고 기록합니다. `kind` 없는 `api` 재정의는 실행기 API의 종류를 사용하거나, 새 API도 지원하는 기존 종류를 유지하며, 그렇지 않으면 `chat`으로 만듭니다. 다른 API로 내장 ID를 재정의하는 `models` 항목도 같은 규칙을 따르므로 이미지 항목을 `openai-completions`로 재정의하면 `chat`이 됩니다.

<a id="allowed-authdiscovery-values"></a>
### 허용되는 인증/탐색 값

- `auth`: `apiKey`(기본값), `none`, `oauth`. `none`과 `oauth`는 사용자 지정 제공자의 `apiKey` 필수 조건을 없애지만, `oauth`가 자격 증명을 생성하거나 로그인 흐름을 등록하지는 않습니다. OAuth 스타일 요청을 강제하며, 사용 가능한 자격 증명은 저장된 인증, 환경, 구성 키에서 와야 합니다. 사용자 지정 `anthropic-messages` 모델은 `auth` 생략 시에도 OAuth 스타일 요청을 사용합니다. 일반 API 키 요청에는 `auth: apiKey`를 설정하세요.
- `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, `litellm`, `apple-foundation-models`. Apple 전송은 지원 Mac에서 암시적으로 등록되며 이 YAML 스키마의 `api` 값에는 `apple-foundation-models`를 사용할 수 없습니다.
- `discovery.injectV1`: `openai-models-list`의 선택적 불리언이며 기본값은 `true`입니다. 버전 경로(예: `https://api.opper.ai/v3/compat`)를 OpenAI 호환 루트로 쓰는 게이트웨이에서 강제 `/v1/models`가 다른 작은 목록을 반환한다면, `false`로 설정해 `/v1` 삽입 없이 `{baseUrl}/models`를 조회하세요. 기본 모드와 마찬가지로 `baseUrl` 쿼리 문자열은 무시합니다.
- `transport`: `pi-native`만 허용합니다. 설정하면 제공자의 모든 모델이 `POST /v1/pi/stream`으로 `omp auth-gateway` 호환 `baseUrl`에 전송됩니다. `apiKey`는 게이트웨이 bearer입니다.
- `imageInputDecoder`: `stb`만 허용합니다. 백엔드가 WebP를 받지 못하는 STB 호환 이미지 디코더를 사용하면 사용자 지정 모델 또는 `modelOverrides`에 설정하세요. OMP가 제공자 전송 전에 첨부 및 대화 이력의 WebP 이미지를 변환합니다.
- `imageCountBudget`: 양의 정수입니다. 호스트 요청 하나에 실을 수 있는 이미지 수를 사용자 지정 모델 또는 `modelOverrides`에 지정합니다. 카탈로그 예산을 대체하며, 카탈로그 규칙에 없는 제공자의 기본 예산은 5입니다. 더 높은 제한의 공급사 앞에 있는 게이트웨이에 필요합니다. 세션 이미지가 예산을 넘으면 OMP가 가장 오래된 것부터 버려 캐시된 프롬프트 접두사가 바뀝니다.
- `tokenizer`: 프록시 모델 ID가 모호하거나 비정규 형식이면 특정 내장 로컬 토크나이저를 선택합니다. 허용 값은 `claude-v3`, `claude-v47`, `claude-v5`, `claude-v5-sonnet`, `qwen3`, `deepseek-v3`, `kimi-k2`, `glm5`, `o200k`(OpenAI GPT-5 이상)입니다. 생략하면 카탈로그 식별 정책을 사용하고 알 수 없는 모델에는 빠른 로컬 추정이 유지됩니다.

<a id="validation-rules-current"></a>
## 검증 규칙(현재)

<a id="full-custom-provider-models-is-non-empty"></a>
### 완전한 사용자 지정 제공자(`models`가 비어 있지 않음)

필수 항목:

- `baseUrl`
- `auth: none` 또는 `auth: oauth`가 아니면 `apiKey`
- 제공자 수준 또는 각 모델의 `api`

<a id="override-only-provider-models-missing-or-empty"></a>
### 재정의 전용 제공자(`models`가 없거나 비어 있음)

다음 중 하나 이상을 정의해야 합니다.

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools: true`
- `guardrailIdentifier`
- `requestMetadata`
- 비어 있지 않은 `modelOverrides`
- `discovery`
- `remoteCompaction`

<a id="discovery"></a>
### 탐색

- `discovery.timeoutMs`는 해당 제공자의 런타임 HTTP 확인 제한 시간을 밀리초로 재정의합니다. 양의 유한수여야 합니다.
- 재정의가 없으면 Ollama와 llama.cpp 루프백 확인은 짧은 엔드포인트별 예산(150–250ms)을, 원격/LAN 확인은 10초를 사용합니다. 일반 모델 목록 및 프록시 확인의 기본값은 10초입니다.
- `discovery`에는 제공자 수준 `api`가 필요하지만 `discovery.type: proxy`는 예외입니다(모델별 전송 자동 감지).

<a id="remote-compaction"></a>
### 원격 압축

`remoteCompaction`만으로도 재정의 전용 제공자의 조건을 충족합니다.
지원 키는 `enabled`, `api`, `endpoint`, `model`, `v2StreamingEnabled`,
`v2Endpoint`, `streamingEndpoint`입니다.

Amazon Bedrock OpenAI 경로(`bedrock-runtime.<region>.amazonaws.com` 또는
`bedrock-mantle.<region>.api.aws`의 `/openai/…`, Mantle `/v1` 루트, runtime FIPS 호스트,
두 엔드포인트의 PrivateLink 호스트)의 `openai-responses` 모델은 제공자 ID와 관계없이 별도 활성화 없이
기본 OpenAI 압축을 사용합니다. `enabled: false`로 끄거나 `v2StreamingEnabled: false`로
V1 `/responses/compact` 요청만 유지하세요. [압축](./compaction.md)을 참조하세요.

Bedrock Converse Claude 모델은 AWS 엔드포인트의 Bedrock Runtime 보조 요청으로 기본 압축을 수행합니다.
AWS가 아닌 사용자 지정 `baseUrl`에는 `remoteCompaction.enabled: true`가 필요하며 `enabled: false`로
끕니다. [압축](./compaction.md#summary-generation)을 참조하세요. 별도 Anthropic Messages
`/anthropic` 경로에는 자체 [설정](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic)이 있습니다.

<a id="model-value-checks"></a>
### 모델 값 검증

- `id`는 필수이며 비어 있으면 안 됩니다. 선택적 `name`, 모델 `baseUrl`, `contextPromotionTarget`, `compactionModel`도 비어 있으면 안 됩니다.
- 사용자 지정 `models` 항목의 `contextWindow`와 `maxTokens`를 지정하면 양수여야 합니다. 현재 보조 양수 검증은 `modelOverrides`를 포함하지 않습니다.
- 사용자 지정 모델과 재정의 모두 `maxContextWindow`는 양의 안전한 정수여야 하며, 두 값이 모두 있으면 `contextWindow` 이상이어야 합니다.

<a id="unknown-compatibility-keys"></a>
### 알 수 없는 호환성 키

제공자, 모델, `modelOverrides`의 `compat` 블록에 알 수 없는 키가 있으면 치명적이지 않은 경고가 발생합니다. 대화형 시작에는 알림을, 출력 및 RPC 모드와 모델 목록에는 stderr 행을 표시합니다(JSON 출력 포함, stdout은 그대로 유지). 각 경고는 구성 파일과 점으로 구분된 키 경로를 표시하며, 모델 배열 항목은 스키마 오류처럼 0부터 시작하는 인덱스를 사용합니다. 구성은 계속 로드되고 알 수 없는 키는 향후 호환성을 위해 보존됩니다. 강제 갱신이나 변경 없는 파일 재읽기 후에도 레지스트리는 각 알 수 없는 키 경로를 한 번만 보고합니다.

`compat` 최상위 및 `whenThinking` 재정의 내부의 알려진 레코드 키는 models.yml 호환성 스키마와 런타임 호환성 어휘(전송 축) 양쪽에서 가져옵니다. 스키마는 선별된 일부만 검증하므로 `streamFirstEventTimeoutMs`처럼 런타임이 아는 키는 파일 스키마에 없다는 이유만으로 경고하지 않습니다. 사고 재정의 안에 다른 사고 재정의를 넣을 수 없으므로 중첩 `whenThinking.whenThinking`은 여전히 경고합니다. 사고 및 카탈로그 축은 `compat` 밖에 속하며 포함하지 않습니다. 그 밖의 중첩 검증은 라우팅 블록과 `reasoningEffortMap` 등 스키마가 선언한 고정 필드 객체만 따릅니다. `extraBody` 같은 개방형 맵은 임의 키와 중첩 페이로드를 허용합니다. 런타임 확장 제공자 등록은 파일 스키마로 검증하지 않으며 자체 호환성 필드가 있는 사용자 지정 API를 등록할 수 있습니다.

런타임 어휘는 제공자의 `api`로 필터링하지 않습니다. 다른 API 계열만 읽는 전송 키(예: `openai-completions` 제공자의 Anthropic 전용 키)는 효과가 없어도 경고하지 않습니다.

<a id="command-resolved-secrets"></a>
### 명령으로 확인하는 비밀 정보

제공자 `apiKey` 값과 제공자/모델 `headers` 값 앞에 `!`를 붙이면 명령 stdout에서 비밀 정보를 읽습니다. 명령은 10초 제한으로 비동기 실행되며 stdout의 앞뒤 공백을 제거하고, 비어 있거나 실패한 명령은 생략합니다. 카탈로그를 로드하거나 살펴볼 때는 실행하지 않습니다. 요청 또는 온라인 자격 증명 확인에 필요할 때 확인합니다.

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

성공한 명령 출력은 프로세스 수명 동안 캐시되며 동시 요청은 진행 중인 실행을 공유합니다. 실패 시 30초간 대기합니다. `refreshCommandCredentials`를 요청하는 갱신 호출자(모델 허브의 명시적 갱신 포함)와 401 자격 증명 복구는 관련 캐시 API 키와 헤더를 무효화하지만 일반 카탈로그 갱신은 그렇지 않습니다. `--api-key`를 포함한 런타임 API 키 재정의는 구성된 자격 증명보다 우선합니다.

<a id="merge-and-override-order"></a>
## 병합 및 재정의 순서

ModelRegistry 조합 순서:

1. `models.yml` / `models.yaml`을 로드해 제공자 재정의, 사용자 지정 모델, 모델 재정의, 탐색 구성을 설정합니다.
2. `@oh-my-pi/pi-catalog`에서 내장 모델(`getBundledProviders` / `getBundledModels`)을 로드하고 제공자 재정의와 컨텍스트 정책을 적용합니다.
3. 캐시 및 런타임 탐색 항목을 병합합니다. 권위 있는 제공자 카탈로그는 번들 채팅 목록을 대체할 수 있습니다.
4. 구성한 사용자 지정 `models`, 이어서 확장 등록 모델을 병합합니다.
   - `provider + id`가 일치하면 전송 메타데이터를 대체하고 정의된 모델 필드를 패치합니다.
   - 아니면 모델을 추가하며 누락 메타데이터는 번들 참조 또는 로컬 기본값으로 채웁니다.
5. 노력 단계 변형을 통합하고 `modelOverrides`를 적용한 뒤 구성된 확장 창을 선택합니다.
6. 제공자 Bedrock 필드, 런타임 제공자 재정의, 탐색 전송 정책, 확장 OAuth 카탈로그 투영을 적용합니다.

백그라운드 탐색도 탐색 항목 뒤에 사용자 정의와 모델 재정의를 적용해 병합을 반복하므로
명시적 사용자 구성이 계속 유효합니다.

<a id="provider-model-cache-and-static-fingerprint"></a>
### 제공자 모델 캐시와 정적 지문

제공자별 캐시 모델 목록은 구체화된 모델로 `models.db`(스키마 버전 13)에 저장됩니다.
구체화 정책 스탬프에는 애플리케이션 버전, 빌더 버전, 컴파일된 규칙 해시가 포함되며 호환되지 않는 항목은
무효화됩니다. 요청 헤더 값은 저장하지 않으며 신뢰할 수 있는 로컬 메타데이터나 구성에서 복원해야 합니다.

`static_fingerprint`는 현재 정적 슬라이스와 병합 정책을 해시합니다. 배열에 저장하지 않고 배열의
현재 내용으로 다시 계산합니다. 최신의 권위 있는 캐시가 일치하고 미확인 헤더가 없으면
`resolveProviderModels`는 전체 병합을 건너뛸 수 있습니다. 추가형 공유 카탈로그 캐시는 정적 항목을
다시 적용하며 반환 모델은 변형 통합을 거칩니다. 모델 관리자의 기본 캐시 TTL은 2시간입니다
(개별 제공자가 재정의 가능). 권위 없는 스냅샷은 5분 재시도 간격을 사용합니다.

<a id="shared-catalog-refresh"></a>
### 공유 카탈로그 갱신

번들 카탈로그는 시작 및 오프라인 기준으로 유지됩니다. 시작 시 구성과 캐시 항목을 로드하고 제공자 슬라이스를 지연 구체화합니다. 선택기 검증 전에는 로컬 전용 자격 증명 범위의 데이터 보충 단계를 수행합니다. 백그라운드 갱신은 지원 제공자에 대해 `https://catalog.stencil.so/models.json.zstd`에서 공유 models.dev 카탈로그를 가져옵니다. 새 모델 ID는 각 제공자의 번들 슬라이스에 추가 병합하고 제공자 카탈로그 설명자로 정규화한 뒤 모델 캐시 데이터베이스에 저장합니다. 덕분에 새 OMP 바이너리 없이도 새 모델이 나타날 수 있습니다.

원격 항목은 새 ID의 최신 제한, 가격, 모달리티, 기능 플래그를 제공할 수 있지만 코드, 임의 헤더, 미등록 제공자를 도입할 수는 없습니다. 설명자에서 엔드포인트 탐색을 권위 있는 소스로 선언한 제공자는 그 결과를 사용 가능 채팅 목록에 사용합니다. 공유 카탈로그는 권위 있는 소스가 아니므로 원격 항목이 사라져도 번들 모델을 제거하지 않습니다.

최신 캐시 스냅샷이 있으면 네트워크 요청을 피합니다. 갱신 실패 시 OMP는 마지막 사용 가능 캐시 스냅샷을 유지하고 오래된 상태로 표시하며, 캐시가 없으면 번들 카탈로그로 돌아갑니다. 제공자 탐색 상태에는 `source`(`bundled`, `models.dev`, `provider`, `cache`)와 `fetchedAt`을 기록하여 호출자가 최신 원격 데이터와 오프라인 폴백을 구분할 수 있습니다.

<a id="provider-and-model-identity"></a>
## 제공자 및 모델 식별

레지스트리는 구체적인 `provider` + `id` 식별을 유지합니다. 같은 모델 ID가 여러 제공자에 있으면 정확한
`provider/modelId` 선택기를 사용하세요. 세션 상태와 기록에는 해당 턴을 실행한 구체적 제공자/모델을 저장합니다.

제공자 기본값과 모델별 재정의:

- 제공자의 `headers`, `compat`, `remoteCompaction`이 기준입니다.
- 모델 `headers`는 제공자 헤더 키를 재정의합니다.
- `modelOverrides`는 모델 메타데이터(`name`, `api`, `kind`, `reasoning`, `thinking`, `input`,
  `imageInputDecoder`, `imageCountBudget`, `tokenizer`, `supportsTools`, `cost`, `promptCache`, `premiumMultiplier`, `contextWindow`,
  `maxContextWindow`, `maxTokens`, `omitMaxOutputTokens`, `preferWebsockets`, `headers`, `compat`,
  `contextPromotionTarget`, `compactionModel`, `remoteCompaction`)를 재정의할 수 있습니다.
- `compat`는 중첩 라우팅 블록(`openRouterRouting`, `vercelGatewayRouting`, `extraBody`, `whenThinking`)을 깊게 병합합니다.

<a id="prompt-cache-lifetimes"></a>
## 프롬프트 캐시 수명

`promptCache`는 OMP가 요청할 수 있는 보존 단계별 제공자의 프롬프트 캐시 항목 유지 시간을 지정합니다
(일반 기본값은 `short`. Anthropic OAuth 구독자 요청은 지원되는 경우 `long`이 기본값이며,
명시적 보존 설정 또는 `PI_CACHE_RETENTION`이 우선합니다). 단위는 초이며 추정치입니다.
제공자는 범위를 공개하므로 보수적인 끝값을 선택하세요.

```yaml
providers:
  anthropic:
    modelOverrides:
      claude-sonnet-5:
        promptCache: { short: 300, long: 3600 }
```

명시적 `promptCache`는 카탈로그 수명과 병합하지 않고 대체합니다. `promptCache: {}`는 해당 모델의
사전 예열을 끄며, `short`만 있으면 카탈로그의 `long` 수명을 상속하지 않습니다. 일치 모델에서는
`modelOverrides.promptCache`가 최우선입니다. 런타임 등록 모델 정의는 수명 선택 시 일치 YAML
`models` 정의를 대체하며 런타임 `promptCache`를 생략해도 마찬가지입니다. YAML 수명 대신 실제 유효 모델의
카탈로그 기본값이 적용됩니다. 런타임 대체가 없으면 일치 YAML 수명을, 그것도 없으면 카탈로그 기본값을 사용합니다.

일반 `bun run gen:models` 명령은 현재 카탈로그 정책에서 번들 프롬프트 캐시 수명을 다시 계산합니다.
별도 캐시 재생성 명령은 없습니다.

직접 Anthropic은 기존 5분/1시간 수명(`short: 300`, `long: 3600`)을 유지합니다. API 키는 기본 5분,
OAuth 구독 세션은 1시간이며 API 키도 `long`을 명시적으로 선택할 수 있습니다. Factory Droid의 Claude 모델도 5분/1시간 수명을 가지며 기본값은 5분입니다. `long`은 Anthropic, Vertex, Bedrock, Azure 업스트림에서는 1시간 항목을 기록하고 나머지에서는 5분을 유지합니다. 기본 Amazon Bedrock
Converse의 Claude는 TTL이 5분이며 카탈로그 메타데이터와 요청 전송 모두 지원할 때만 1시간을 사용할 수
있습니다. Bedrock Runtime 또는 Mantle Anthropic Messages 경로의 Claude는 현재 요청 지원에서 5분 수명을
사용하며 지원되지 않는 명시적 `long` 요청은 `short`로 돌아갑니다. Nova와 GPT 등 다른 Amazon Bedrock
모델은 예열하지 않습니다. 실제 사용 보존 단계에 수명이 없는 모델은 예열하지 않습니다. 기반 캐시 동작을
안다면 사용자 지정 모델과 `modelOverrides`에 `promptCache`로 예열을 활성화할 수 있습니다.
[설정](./settings.md)의 `providers.cacheWarming`을 참조하세요.

<a id="usage-costs-and-time-based-pricing"></a>
## 사용 비용과 시간 기반 가격

OMP는 선택한 제공자/모델의 카탈로그 가격으로 토큰 비용을 추정하며, 서버가 금액을 보고하면 우선 사용합니다. 완료 메시지는 기록된 비용을 유지합니다. 가격 경계 통과, 모델 전환, 세션 재열기는 누적 사용량을 다시 계산하지 않습니다.

자체 제공자 `deepseek`의 카탈로그는 [DeepSeek 공식 가격](https://api-docs.deepseek.com/quick_start/pricing)을 따릅니다.

- 피크 시간은 **월요일–금요일 01:00–04:00 및 06:00–10:00 UTC**입니다(시작 포함, 끝 제외). 주말을 포함한 나머지 시간은 **피크 요금의 50%**입니다.
- Flash 가격은 `deepseek-flash`와 폐기되었지만 여전히 허용되는 `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` ID에 적용되며 모두 Flash 요금표로 청구됩니다. 백만 토큰당 피크 요금은 비캐시 입력 $0.30, 캐시 입력 $0.006, 출력 $1.20입니다.
- `deepseek-v4-pro`의 초기 백만 토큰당 피크 요금은 비캐시 입력 $1.32, 캐시 입력 $0.044, 출력 $3.96입니다. **2026-09-14 04:00 UTC**부터는 같은 피크/비피크 일정으로 Flash 요금표를 사용해 추정합니다.

일부 카탈로그 가격은 피크/비피크 요금 없이 특정 날짜에 바뀝니다. `google`, `google-vertex`, `google-antigravity`, `cursor`의 Gemini 4 Argon은 2026-11-30까지 백만 토큰당 입력 $2 / 캐시 입력 $0.10 / 출력 $10으로, **2026-12-01 08:00 UTC**(미국 태평양 자정)부터 Google 정가 $4 / $0.20 / $20으로 추정합니다. 요청 타임스탬프로 가격을 선택하므로 변경 전에 로드한 모델도 카탈로그 업데이트 없이 이후 요청에 새 요금을 적용하며 모델 브라우저와 `omp models --json`에는 현재 가격이 표시됩니다.

로컬 추정은 어시스턴트 메시지의 **요청 시작 타임스탬프**로 전체 요청의 요금표와 요율을 선택합니다. 이는 OMP의 추정 규칙이며 DeepSeek 가격 페이지는 경계를 걸치는 요청의 서버 과금 방식을 명시하지 않습니다. 기록된 비용 없는 과거 사용량을 가져올 때 요청 타임스탬프를 복구할 수 없으면 통계 가져오기는 현재 시각 요율을 고르지 않고 일정 기반 가격을 미산정 상태로 둡니다.

상태 표시줄의 `cost` 부분은 현재 시각 기준으로 **현재 활성 제공자/모델**의 피크 가격에 **↑**, 비피크에 **↓**를 붙입니다. 유휴 상태에서도 요금 경계에서 갱신되며 화살표는 누적 세션 합계에 대한 표시가 아닙니다. 날짜별 가격 변경과 명시적 고정 가격 재정의를 포함해 피크/비피크 요금이 없는 모델에는 화살표가 없습니다.

`modelOverrides`를 포함한 `models.yml`의 명시적 모델 `cost`는 고정 가격 재정의이며 해당 모델의 상속된 시간 기반 가격을 끕니다. `cost`를 생략하면 카탈로그 가격을 유지합니다. `models.yml`은 `timeBased` 일정을 구성하지 **않습니다**. 그 메타데이터는 카탈로그 [KDL 가격 규칙](../packages/catalog/src/compat/rules/README.md#time-based-pricing)에 속합니다.

`models.yml`의 새 사용자 지정 모델이 `cost`를 생략하면 번들 참조 항목의 일정 포함 요금표를 상속합니다.
참조는 모델 ID로 일치시키고 큰 컨텍스트/출력 제한, 완전한 캐시 가격, 자체 OpenAI 항목 순으로 선호합니다.
같은 제공자/같은 ID의 사용자 지정 항목은 `cost` 생략 시 기존 모델 가격을 유지합니다. 일반 프록시와
OpenAI 모델 목록 탐색은 업스트림 가격을 빌리지 않고 로컬 가격 미상(0)을 유지합니다.
LiteLLM 같은 풍부한 제공자 탐색은 자체 가격을 제공할 수 있습니다.

<a id="runtime-discovery-integration"></a>
## 런타임 탐색 통합

<a id="implicit-ollama-discovery"></a>
### 암시적 Ollama 탐색

`ollama`를 명시적으로 구성하지 않으면 레지스트리가 암시적 탐색 제공자를 추가합니다.

- 제공자: `ollama`
- API: `openai-responses`
- 기본 URL: `OLLAMA_BASE_URL`, 다음 `OLLAMA_HOST`, 다음 `http://127.0.0.1:11434`
- 컨텍스트 창: 설정된 `OLLAMA_CONTEXT_LENGTH`, 아니면 Ollama `/api/show` 메타데이터, 아니면 `128000`
- 인증 모드: 키 불필요(`auth: none` 동작)

런타임 탐색은 Ollama 엔드포인트를 호출하고 발견한 OpenAI 호환 모델을 `openai-responses`로 정규화합니다.

`OLLAMA_CONTEXT_LENGTH`는 Ollama 런타임 `num_ctx`를 구성하지 않습니다. Ollama/모델 구성에서 따로 설정하세요.

<a id="implicit-llamacpp-discovery"></a>
### 암시적 llama.cpp 탐색

`llama.cpp`를 명시적으로 구성하지 않으면 레지스트리가 암시적 탐색 제공자를 추가합니다.

- 제공자: `llama.cpp`
- API: `openai-responses`
- 기본 URL: `LLAMA_CPP_BASE_URL` 또는 `http://127.0.0.1:8080`
- 인증 모드: 키 불필요(`auth: none` 동작)

런타임 탐색은 llama.cpp 모델 엔드포인트를 호출하고 로컬 기본값으로 모델 항목을 구성합니다.

제공자의 `api`는 탐색 모델의 기본값이며 카탈로그 규칙은 모델 클래스별로 재정의할 수 있습니다. 암시적/명시적 모든 `discovery.type: llama.cpp` 제공자의 Qwen 클래스 모델은 `openai-completions`로 탐색됩니다. Responses API는 채팅 템플릿의 사고 제어(`enable_thinking` / `chat_template_kwargs`)를 전달할 수 없기 때문입니다. 재정의는 `packages/catalog/src/compat/rules/providers/llama.cpp.kdl`의 `discovery-api`에 있습니다.

첫 응답으로 지연 llama.cpp 모델을 로드하면 OMP는 런타임 컨텍스트와 입력 메타데이터를 다시 확인합니다.
명시적 사용자 지정 모델 및 `modelOverrides` 제한이 확인 결과보다 우선합니다.
암시적 제공자는 구성된 자격 증명 소스가 없을 때만 키가 필요 없습니다.

<a id="implicit-lm-studio-discovery"></a>
### 암시적 LM Studio 탐색

`lm-studio`를 명시적으로 구성하지 않으면 레지스트리가 암시적 탐색 제공자를 추가합니다.

- 제공자: `lm-studio`
- API: `openai-completions`
- 기본 URL: `LM_STUDIO_BASE_URL` 또는 `http://127.0.0.1:1234/v1`
- 인증 모드: 키 불필요(`auth: none` 동작)

런타임 탐색은 OpenAI 호환 모델 목록과, 가능하면 LM Studio 기본 메타데이터를 가져옵니다.
기본 `loaded_context_length`가 학습 창보다 우선하며 첫 응답으로 모델을 JIT 로드하면 OMP가 런타임
메타데이터를 갱신합니다. 명시적 사용자 지정 모델 및 `modelOverrides` 제한은 계속 우선합니다.
탐색한 LM Studio 모델은 `imageInputDecoder: stb`를 사용합니다.

이 경로는 LM Studio가 아닌 로컬 OpenAI 호환 서버에서도 작동합니다. 예를 들어 oMLX가 Ollama의 일반 포트에 바인딩되었다면 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1`로 기존 `/v1/models` 흐름에서 탐색하세요. oMLX와 Ollama를 함께 실행하려면 하나의 포트를 바꿔야 합니다. oMLX를 `ollama`로 구성하지 마세요. Ollama 탐색은 OpenAI `/v1/models`가 아니라 기본 `/api/tags`와 `/api/show` 엔드포인트를 사용합니다.

<a id="implicit-apple-foundation-models-discovery"></a>
### 암시적 Apple Foundation Models 탐색

Apple Silicon macOS에서는 미구성 및 비활성화되지 않은 `apple` 제공자를 프로세스 내 Foundation Models
브리지로 확인합니다. 브리지가 사용 가능으로 보고하면 자격 증명 없이 `apple/on-device`를 사용할 수 있으며
컨텍스트 크기, 추론, 이미지 입력, 도구 지원은 브리지 메타데이터에서 유도합니다. 온디바이스 컨텍스트 창이
기본 coding-agent 프롬프트와 프로젝트 지침보다 작을 수 있으므로 자동으로 선택하지 않습니다.
`--model apple/on-device` 또는 `/model`로 명시적으로 선택하거나 `/login` 또는 다른 로컬 모델을 구성하세요.
지원하지 않는 기기, 비활성화된 Apple Intelligence, 브리지 없는 빌드는 모델을 제공하지 않습니다.
내부 API는 `apple-foundation-models`이며 HTTP 엔드포인트는 사용하지 않습니다.

<a id="litellm-provider-discovery"></a>
### LiteLLM 제공자 탐색

`litellm`이 활성 상태이면(예: `LITELLM_API_KEY` 또는 저장된 인증) 런타임 탐색은 LiteLLM 프록시를 사용합니다.

- 제공자: `litellm`
- API: `mode: decisions`인 모델 그룹은 `openai-decisions`(`judge` 종류), OpenAI 기반 모델은 `openai-responses`, 그 밖의 모델은 `openai-completions`
- 기본 URL: 명시적 제공자 `baseUrl` / `models.yml` 구성, 아니면 `LITELLM_BASE_URL`, 아니면 `http://localhost:4000/v1`
- 인증 모드: 프록시가 키를 요구하면 `LITELLM_API_KEY` 또는 저장된 LiteLLM 인증

런타임 탐색은 `GET /model_group/info`, `GET /v2/model/info`, `GET /model/info`, `GET /v1/model/info` 순으로 LiteLLM 관리 메타데이터를 확인합니다. 구성 키에는 하나 이상의 경로 읽기 권한이 있어야 합니다. 관리 엔드포인트를 제한한 배포에서는 LiteLLM `allowed_routes` 접근 제어로 경로를 허용하거나 탐색에 마스터/관리자 키를 사용하세요.

모든 메타데이터 경로를 사용할 수 없으면 OpenAI 호환 `GET /models` 목록으로 돌아갑니다. 거부 또는 실패한 메타데이터 요청은 엔드포인트와 상태와 함께 한 번 기록하며 `404`는 경로 없음으로 취급합니다. 두 경로 모두 알려진 작업별 LiteLLM 모드 `audio_speech`, `audio_transcription`, `batch`, `embedding`, `guardrail`, `image_edit`, `image_generation`, `moderation`, `ocr`, `rerank`, `search`, `vector_store`, `video_generation`으로 명시된 모델을 제외합니다. 모드가 없거나 null 또는 미인식이면 라우터 별칭이 작동하도록 선택 가능 상태를 유지합니다. 풍부한 메타데이터는 모델별 컨텍스트, 기능, 업스트림 제공자 필드를 매핑합니다. OpenAI 기반 모델은 추론 요약을 유지하기 위해 LiteLLM Responses 경로를 사용하며 혼합 제공자 그룹은 Chat Completions를 유지합니다. 기본 폴백 ID는 알려진 OpenAI 모델 계열로 라우팅하며 가능하면 번들 참조 메타데이터를 사용합니다. 폴백 가격은 미상(0)이고, 구성된 일반 탐색에서 엔드포인트와 번들 참조 모두 제한을 제공하지 않으면 컨텍스트 기본값은 128,000토큰입니다. 풍부한 관리 메타데이터는 제공자별 가격을 제공할 수 있습니다. 이후 확인은 모든 엔드포인트 목록을 합치는 대신 처음 사용 가능한 목록의 모델 메타데이터를 보충하거나 재정의합니다.

<a id="generic-openai-compatible-discovery"></a>
### 일반 OpenAI 호환 탐색

`openai-models-list`는 기본적으로 `{baseUrl}/v1/models`를 읽으며 `/v1`을 중복 추가하지 않습니다.
`discovery.injectV1: false`이면 구성 URL을 완전한 API 루트로 취급합니다. 보고된 `max_model_len`이
`context_length`보다 우선합니다. 둘 다 없으면 중첩 `limits.max_input_tokens`와 `limits.max_output_tokens`가
모두 양의 안전한 정수이고 합계도 안전할 때만 합계를 컨텍스트로 사용합니다. 유효한 `limits.max_output_tokens`는
별도로 채팅 출력 상한을 설정하며 확인된 컨텍스트로 제한합니다. 컨텍스트 쌍이 불완전하거나 잘못되어도
유효한 출력 제한은 버리지 않습니다. 이것이 없으면 유효한 최상위 `max_output_tokens`,
`max_completion_tokens`, `top_provider.max_completion_tokens`, 일반 `max_tokens` 순으로
번들 참조 제한보다 우선하여 상한을 설정합니다. 각 표기를 별도 검증하므로 하나가 유효하지 않아도 다른
유효한 값은 무시하지 않습니다. 그 밖에는 기존 기본/참조/기본값 폴백을 따릅니다.
정보 없는 엔드포인트는 번들 참조의 제한, 추론, 입력 모달리티를 상속할 수 있습니다.
알 수 없는 모델의 일반 채팅 기본값은 컨텍스트 128,000, 출력 32,768입니다. 출력 상한은 확인된 컨텍스트로
제한되며 Anthropic 경로 모델의 폴백 출력 상한은 8,192토큰입니다.

이미지 출력만 알리는 항목은 이미지 생성 실행기가, 임베딩 출력만 알리는 항목은 임베딩 실행기가 됩니다.
혼합 출력은 채팅 모델로 유지됩니다. 이 실행기는 기본 채팅 목록이 아니라 `omp models --kind all`에서 보입니다.

<a id="explicit-provider-discovery"></a>
### 명시적 제공자 탐색

탐색을 직접 구성할 수도 있습니다.

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

사용자 지정 LiteLLM 게이트웨이도 같은 풍부한 탐색 경로를 사용할 수 있습니다.

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM 메타데이터 엔드포인트는 탐색에만 구성 기본 URL 끝의 `/v1`을 제거하며 앞선 프록시 경로는 유지합니다. 런타임 모델 호출은 구성한 OpenAI 호환 `/v1` 기본 URL을 유지합니다.

<a id="proxy-discovery-discoverytype-proxy"></a>
### 프록시 탐색 (`discovery.type: proxy`)

같은 호스트에서 `/v1/messages`와 `/v1/chat/completions`를 모두 제공하는
Anthropic+OpenAI 호환 프록시(new-api / one-api 등)를 위한 기능입니다.
탐색은 `GET /v1/models`(10초 제한, OpenAI 형식 페이로드)를 호출하고
항목의 `supported_endpoint_types`에서 각 모델의 `api`를 유도합니다.

- `"anthropic"` 포함 → `api: anthropic-messages`(`/v1/messages` 경로)
- `"openai"` 포함 → `api: openai-completions`(`/v1/chat/completions` 경로)
- 그 밖에는 제공자 수준 `api`, 생략되었다면 `openai-completions`로 폴백

모델별 전송을 자동 감지하므로 `discovery.type: proxy`에서는 제공자 수준 `api`가 **선택 사항**입니다.
Anthropic SDK는 `/v1/messages`를 덧붙이기 전에 `baseUrl` 끝의 `/v1`을 제거하므로
하나의 탐색 `baseUrl`(`/v1`로 끝남)이 두 전송 모두에서 올바르게 작동합니다.

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

<a id="extension-provider-registration"></a>
### 확장 제공자 등록

확장은 런타임에 `pi.registerProvider(...)`로 제공자를 등록할 수 있으며 다음을 포함합니다.

- 제공자의 모델 대체/추가
- 새 API ID용 사용자 지정 스트림 핸들러 등록
- 사용자 지정 OAuth 제공자 등록
- 자격 증명을 반영한 실시간 목록용 `fetchDynamicModels`(기본 TTL 24시간으로 캐시)
- 사용자 지정 사용량 보고 및 카탈로그 재구축 후 다시 적용되는 OAuth `modifyModels` 투영

<a id="auth-and-api-key-resolution-order"></a>
## 인증 및 API 키 확인 순서

제공자 키 요청의 유효 순서는 다음과 같습니다.

1. 런타임 재정의(CLI `--api-key`)
2. 구성 재정의(`models.yml`의 `providers.<name>.apiKey`)
3. 저장된 OAuth 자격 증명(갱신 포함)
4. 로그인으로 저장한 API 키
5. 확장 등록 구성 폴백(`keys.setConfig(..., { fallback: true })`)
6. 환경 변수 매핑(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` 등)
7. 브로커에서 마이그레이션한 복사본 등 그 밖의 저장 API 키

폴백 단계는 자체 로그인 흐름이 있는 등록 제공자용입니다.
`models.yml`에 명시한 키는 이 폴백이 아니라 2단계에 속합니다.

`models.yml`의 `apiKey` 동작:

- 먼저 값을 환경 변수 이름으로 취급합니다.
- 환경 변수가 없거나 비어 있으면 리터럴 문자열을 토큰으로 사용합니다.

`authHeader: true`이고 제공자 `apiKey`가 설정되어 있으면 모델에 다음을 적용합니다.

- `Authorization: Bearer <resolved-key>` 헤더 삽입.

변수가 없어도 확인에 실패하지 않습니다. `apiKey: MY_PROVIDER_API_KEY`와 `authHeader: true`에서
`MY_PROVIDER_API_KEY`가 없거나 비어 있으면 `Authorization: Bearer MY_PROVIDER_API_KEY`가 됩니다.
환경 기반 키를 사용하는 실행기는 OMP 시작 전에 변수가 설정되어 있고 비어 있지 않은지 확인해야 합니다.

[명령으로 확인하는 비밀 정보](#command-resolved-secrets)는 리터럴 폴백을 사용하지 않습니다.
명령이 실패하거나 공백 제거한 stdout이 비어 있으면 값 없음으로 확인되므로 유도된 bearer 헤더를 추가하지 않습니다.

키 없는 제공자:

- `auth: none` 제공자, 암시적 로컬 제공자, 키 없는 모드로 저장된 선택적 키 로그인은 자격 증명 없이 사용 가능할 수 있습니다.
- 제공자가 키 불필요이고 실제 자격 증명 소스도 구성되지 않았다면 `ModelRegistry.getApiKey*`는 `kNoAuth`를 반환합니다. 구성된 자격 증명이 있으면 여전히 우선합니다.

<a id="broker-mode"></a>
### 브로커 모드

`OMP_AUTH_BROKER_URL` 또는 `auth.broker.url`을 설정하면 로컬 SQLite 자격 증명 저장소를 `RemoteAuthCredentialStore`로 대체합니다. 위 3, 4, 7계층(저장 OAuth 및 API 키)은 `refresh` 토큰을 가린 브로커 스냅샷에서 제공됩니다. 만료되면 로컬 갱신 대신 브로커에 `POST /v1/credential/:id/refresh`를 호출합니다.

`AuthStorage.keys.setConfig`는 런타임 `--api-key`를 재정의하지 않으면서 `models.yml`의 `apiKey`가 브로커 OAuth 토큰보다 우선하도록 합니다. 전체 브로커/게이트웨이 설계와 환경 설정(`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`, `auth.broker.url`, `auth.broker.token`)은 [`auth-broker-gateway.md`](./auth-broker-gateway.md)를 참조하세요.

<a id="model-availability-vs-all-models"></a>
## 사용 가능 모델과 전체 모델

- `getAll()`은 기본적으로 채팅 모델을 반환하며 `getAll("all")`은 모든 카탈로그 종류를 포함합니다.
- `getAvailable()`도 기본은 채팅 전용이며 종류 또는 `"all"`을 지정하면 해당 실행기를 포함합니다.
- 사용 가능 여부는 `disabledProviders`를 제외하고 키 없는 제공자 또는 구성된 자격 증명 소스를 요구합니다. 비밀 명령 실행이나 OAuth 토큰 갱신은 하지 않습니다.

모델이 사용 불가능한 상태로 레지스트리에 존재할 수 있으며 구성된 자격 증명도 요청 시 확인에 실패할 수 있습니다.
`enabledProviders`는 모델 전송 허용 목록이 아니라 외부 구성 소스 탐색을 제어합니다.

<a id="runtime-model-resolution"></a>
## 런타임 모델 확인

<a id="cli-and-pattern-parsing"></a>
### CLI 및 패턴 파싱

`model-resolver.ts`는 다음을 지원합니다.

- 정확한 `provider/modelId`
- 정확한 모델 ID(제공자 추론)
- 퍼지/부분 문자열 일치
- `--models`의 glob 범위 패턴(예: `openai/*`, `*sonnet*`)
- 선택적 `:thinkingLevel` 접미사(`off|minimal|low|medium|high|xhigh|max|auto|inherit`)
- OpenRouter 및 Vercel Gateway 선택기의 `@upstream` 라우팅 접미사(예: `openrouter/anthropic/claude-sonnet-5@anthropic:high`). 정확히 일치하는 리터럴 모델 ID가 여전히 우선합니다.

`--provider`는 레거시이며 `--model`을 권장합니다. 정확한 `provider/modelId`는 모호하지 않습니다.
단독 ID와 퍼지 패턴은 사용 가능한 구체적 모델을 대상으로 확인합니다.

정확한 선택기의 확인 우선순위:

1. 정확한 `provider/modelId` 참조
2. 정확한 단독 ID(대소문자 무시). 여러 제공자에 같은 ID가 있으면 선호 순위로 선택합니다(아래 참조).
3. 폐기된 노력 단계 변형 별칭(통합된 카탈로그 항목, 예: `X`/`X-thinking` 쌍)
4. 제공자 범위 퍼지 일치, 이어서 별칭/날짜 버전 선택을 포함한 부분 문자열 일치

`enabledModels`와 CLI `--models`의 glob 범위 패턴은 정확한 일치 후 구체적 모델에 별도로 실행합니다.

단독 ID가 여러 제공자의 모델과 일치하면 다음 순서로 선호합니다.

1. 최근 사용 모델 변형
2. 제공자 우선순위(`modelProviderOrder` 설정, 이어서 내장 카탈로그 제공자 우선순위)
3. 최근 사용 제공자
4. 레지스트리 순서

<a id="initial-model-selection-priority"></a>
### 초기 모델 선택 우선순위

`findInitialModel(...)`은 다음 순서를 사용합니다.

1. 명시적 CLI 제공자+모델
2. 범위 내 첫 모델(재개가 아닐 때)
3. 저장된 기본 제공자/모델
4. 사용 가능 모델 중 알려진 제공자 기본값(OpenAI/Anthropic 등). 탐색에서 계정 기본 모델을 표시한 제공자(`isProviderDefault`, 예: Devin)는 번들 `default-model` 대신 그 모델을 사용합니다.
5. 첫 사용 가능 모델

자동 폴백은 구체적 자격 증명(키 없는 로컬 포함)이 있는 제공자가 하나라도 있으면 우선 그 풀로 제한합니다.
주변 AWS/Vertex 자격 증명 센티널도 사용 가능하지만 명시적 자격 증명의 제공자를 밀어내지 않습니다.
세션 복원은 별도로 처리하며 저장 모델의 존재와 사용 가능한 자격 증명 확인 여부를 검사합니다.

<a id="role-aliases-and-settings"></a>
### 역할 별칭과 설정

모델 역할은 작업에 모델 선택기를 할당합니다. `models.yml`이 아니라 `config.yml`의 `modelRoles`에 구성하세요. `models.yml`은 제공자와 모델 메타데이터를 정의합니다.

내장 역할은 모델 선택기에서 다음과 같이 묶입니다.

- **채팅 역할:** `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`. `tiny`와 `memory` 역할은 일반 채팅 및 `tiny` 카탈로그 모델을 모두 허용합니다.
- **모델 종류 역할:** `image`, `web`, `speech`, `dictation`, `judge`. 각각 이미지 생성, 검색/근거 기반 채팅, 음성 합성, 음성 인식, 판단 실행기를 선택합니다. `judge`는 tiny와 채팅 모델도 허용합니다.

`vision`과 `image`는 다른 작업입니다. `vision`은 `read screenshot.png?q=...` 같은 이미지 분석용 채팅 모델을, `image`는 `generate_image`용 카탈로그 종류 `image` 모델을 선택합니다. `vision`에 모델을 할당한다고 이미지 입력을 지원하게 되지는 않습니다. 이미지 질문은 모델이 제공자에 이미지 입력을 보낼 수 있는지도 확인합니다.

`tiny` 역할은 세션 제목 같은 백그라운드 작업용 경량 모델을 선택하며 미설정 시 `@smol`로 확인합니다. `memory`는 미설정 시 `@tiny`로 확인합니다. 구성과 폴백 체인 예제는 [모델 설정](./settings.md#models)을 참조하세요.

`/models`에서 기본 이외 역할을 할당하면 보통 활성 대화 모델을 바꾸지 않고 선택기만 저장합니다. 작업이 호출될 때 그 역할을 사용합니다. `plan` 할당 자체로 계획 모드에 들어가지 않으며 `todo` 호출 자체로 계획 모델을 선택하지 않습니다. 계획 모드 중 `plan` 역할을 바꾸면 해당 모델을 다시 적용합니다. `default` 할당은 상위 설정 계층이 편집한 할당을 재정의하지 않는 한 보통 활성 모델도 전환합니다. 세션 전용 모델 선택기는 역할 할당을 다시 쓰지 않고 활성 모델을 바꿉니다.

`@smol` 같은 역할 별칭은 `settings.modelRoles`를 통해 확장하며 `*`는 `@default`를 선택합니다. YAML의 `@` 별칭은 따옴표로 감싸세요(`plan: "@slow"`). 채팅 역할 값에는 `:minimal`, `:low`, `:medium`, `:high` 같은 사고 선택기를 붙일 수 있습니다. 모델 종류 역할에는 채팅 사고 접미사를 사용하지 않습니다.

역할 값에는 쉼표로 구분한 선택기를 넣을 수 있습니다. 요청별 재시도 체인이 아니라 첫 사용 가능 일치를
선택합니다. 요청 실패 폴백은 `retry.fallbackChains`에 별도로 구성합니다(역할, 정확한 모델,
제공자 와일드카드 키. [설정](./settings.md) 참조). `modelRoles`, `modelTags`, `cycleOrder`로
사용자 지정 역할 이름을 도입할 수 있으며 채팅 모델을 사용합니다. 미설정 `smol`과 `slow`는 내장 우선순위
목록보다 명시적 `default`를 먼저 상속합니다. advisor는 명시적 `slow`를 사용하고, 없으면 활성 대화 모델
상속 대신 자체 강력 모델 우선순위 체인을 사용합니다.

역할이 다른 역할을 가리켜도 대상 모델은 정상 상속되며, 참조하는 역할의 명시적 접미사가 그 역할의 사용에 우선합니다.

<a id="model-presets"></a>
### 모델 프리셋

모델 프리셋은 모든 역할 할당과 `defaultThinkingLevel`의 이름 있는 스냅샷으로, 전체 구성을 한 번에 전환할 수 있습니다.

```text
/modelpreset save cheap      # save the current roles and thinking level
/modelpreset switch deep     # apply a saved preset
/modelpreset                 # pick one from a list (interactive)
/modelpreset list | delete <name>
```

`/models`의 Roles 보기에서 `s`를 눌러 현재 구성을 이름과 함께 저장하세요. 프리셋은 `config.yml`의 `modelPresets` 아래에 있습니다.

```yaml
modelPresets:
  deep:
    modelRoles:
      default: anthropic/claude-opus-4-5:high
      smol: anthropic/claude-sonnet-4-5
    defaultThinkingLevel: high
```

전환은 모델 선택기와 같은 방식으로 역할을 기록합니다. `modelRoleStorage`가 고른 범위에 쓰고, 프리셋에 없는 역할을 지우며 `--model`/`--smol` 세션 재정의를 대체합니다. 프리셋의 `defaultThinkingLevel`은 전역 구성에 씁니다. 이후 결과 `default`(프리셋에 없으면 자동 제공자 기본 선택)로 활성 모델을 전환하고, 선택기의 `:level` 접미사 또는 프리셋의 `defaultThinkingLevel`로 세션 사고 수준을 설정합니다. `:inherit`는 모델 전환이 설정한 수준을 유지합니다. 프리셋 `default` 모델을 사용할 수 없으면 아무것도 바꾸지 않습니다. `--config` 파일, `global` 저장 모드의 프로젝트 구성, `project` 저장 모드의 전역 구성 등 다른 계층이 계속 결정하는 역할은 전환되었다고 표시하지 않고 전환 메시지에 우선 계층과 함께 나열합니다. 프로젝트 구성 또는 `--config` 파일이 설정한 `defaultThinkingLevel`도 마찬가지입니다. 세션은 프리셋 수준으로 전환되지만 다음 시작 시 해당 계층의 수준이 복원된다는 사실을 메시지에 표시합니다.

여러 구성 계층에 같은 이름의 프리셋이 있으면 최상위 계층(명령줄, `--config` 파일, 프로젝트 구성, 전역 구성 순)이 통째로 우선합니다. 계층 간 항목을 병합하지 않으므로 `default`만 설정한 프로젝트 `deep`에는 전역 `deep`의 다른 역할이 적용되지 않습니다. `--config` 파일 또는 명령줄 재정의의 `null` 항목은 프리셋을 목록과 전환에서 숨깁니다. 프로젝트 구성의 `null`은 무시되므로 같은 이름의 전역 프리셋이 계속 적용됩니다. 저장은 항상 이름 있는 항목을 전역 구성에 쓰며, 더 높은 계층이 그 이름에 계속 우선하면 알립니다.

저장은 `--model` 세션 재정의를 포함한 유효 할당과 구성된 `defaultThinkingLevel`을 캡처하며, 세션의 현재 사고 수준을 저장하지는 않습니다.

관련 설정:

- `modelRoles`(레코드)
- `enabledModels`(범위 패턴 목록)
- `modelProviderOrder`(동등한 구체적 선택지가 ID를 공유할 때의 제공자 우선순위)
- `providers.kimiApiFormat`(`auto|openai|anthropic`. `auto`는 서버가 선언한 모델 메타데이터를 따름)
- `providers.openaiWebsockets`(OpenAI Codex 전송의 `auto|off|on` WebSocket 선호)
- `providers.openaiLiveSteering`(Codex WebSocket으로 응답 중 사용자 메시지를 GPT-6 응답에 전달)

`modelRoles`는 `provider/modelId` 같은 모델 선택기를 저장합니다. `enabledModels`와 CLI `--models`는
정확한 선택기, glob, 퍼지 일치를 허용합니다. 결과 범위는 채팅 모델만 제한합니다(Ctrl+P 순환,
시작 모델, `/model`의 채팅 역할). 판단, 검색, 이미지, 음성 모델은 각 역할에서 계속 사용 가능하므로
이를 지정한 항목도 허용되지만 효과는 없습니다.

`enabledModels`, `enabledProviders`, `disabledProviders` 항목은 경로 접두사 범위로 지정할 수도 있습니다.

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

문자열 항목은 모든 곳에 적용됩니다. 범위 항목은 현재 작업 디렉터리가 구성한 경로이거나 그 하위일 때 적용됩니다. `path`, `paths`, `pathPrefix`, `pathPrefixes`를 사용하세요. 값에는 `enabledModels`용 `models`, 제공자 설정용 `providers`, 공통으로 `values`를 사용할 수 있습니다.

<a id="model-and-omp-models"></a>
## `/model`과 `omp models`

두 인터페이스 모두 제공자 접두사가 붙은 구체적 모델을 표시하고 선택할 수 있게 유지합니다.

- `/model` / `/models`는 역할 할당과 제공자 카탈로그가 있는 모델 허브를 엽니다. 세션 전용 선택기는 역할 할당을 저장하지 않고 활성 모델을 바꿉니다.
- `omp models`(기본 `ls` 동작)는 사용 가능 **채팅** 모델을 제공자별 표로 출력합니다. `--kind <kind>`는 다른 카탈로그 종류를, `--kind all`은 모든 종류를 선택합니다.
- `omp models find <substring>`은 제공자, ID, 이름으로 필터링합니다. `omp models refresh`는 모델 캐시 TTL을 무시하고 온라인 카탈로그를 다시 가져옵니다. 제공자 이름은 `ls` 필터로도 작동합니다(예: `omp models openai-codex`).
- 그 밖의 플래그: `--json`, 반복 가능한 `-e <path>` / `--extension <path>`, `--no-extensions`(주변 탐색 생략, 명시적 `-e`는 로드), 반복 가능한 `--config <overlay>`.

JSON에는 `provider`, `kind`, `id`, `selector`, `name`, 제한, 추론/사고 메타데이터, 선언된 `input`,
`cost`가 포함되며 모델 전송 `api`는 노출하지 않습니다.

제공자 행을 선택하면 명시적 `provider/modelId`를 저장합니다.

표의 `images` 열은 실제 전송 내용을 표시합니다. 이미지를 제거하는 모델(`compat.stripImageInput`,
[이미지 처리](#compatibility-and-routing-fields) 참조)은 사양이 `input: [text, image]`여도 `no`를
표시합니다. `--json`은 선언된 `input`을 유지합니다.

<a id="context-promotion"></a>
## 컨텍스트 승격

컨텍스트 승격은 압축 전에 명시적으로 구성한 더 큰 컨텍스트 모델로 전환합니다.
컨텍스트 초과 오류와 프롬프트 전 또는 턴 후 압축 임계점에서 시도합니다.

컨텍스트 승격과 [재시도 모델 폴백](./non-compaction-retry-policy.md)은 독립적입니다.
**Auto-Promote Context**(`contextPromotion.enabled`)를 꺼도 `retry.fallbackChains`는 꺼지지 않습니다.
`retry.modelFallback`이 켜져 있으면 폴백 모델의 컨텍스트가 더 크더라도 제공자 오류로 활성 모델을 전환합니다.
이 전환을 막으려면 `retry.modelFallback: false`를 설정하세요. 같은 모델 재시도(`retry.enabled`)와
자동 압축(`compaction.enabled`)에는 영향이 없습니다.

<a id="trigger-and-order"></a>
### 트리거와 순서

컨텍스트 초과 오류(예: `context_length_exceeded`)로 턴이 실패하면 `AgentSession`은 압축 폴백 **전에** 승격을 시도합니다.

1. `contextPromotion.enabled`가 참이면 승격 대상을 확인합니다(아래 참조).
2. 대상을 찾으면 전환하고 요청을 재시도합니다. 압축은 필요 없습니다.
3. 사용 가능한 대상이 없으면 현재 모델에서 자동 압축으로 넘어갑니다.

<a id="target-selection"></a>
### 대상 선택

선택은 명시적이며 모델 기반입니다.

1. `currentModel.contextPromotionTarget`(구성된 경우)

구성한 대상만 고려하며 같은 제공자/API의 더 큰 형제 모델을 자동 선택하지 않습니다. 대상은 사용 가능하고 현재 모델과 달라야 하며, 알려진 컨텍스트 창이 엄격히 더 크고 사용 가능한 자격 증명을 확인할 수 있어야 합니다(`ModelRegistry.getApiKey(...)`).

<a id="openai-codex-websocket-handoff"></a>
### OpenAI Codex WebSocket 인계

`openai-codex-responses`로 또는 그 모델에서 전환할 때 모델 전환 전에 세션 제공자 상태 키 `openai-codex-responses`를 닫습니다. WebSocket 전송 상태를 버려 다음 턴이 승격된 모델에서 깨끗하게 시작하도록 합니다.

<a id="persistence-behavior"></a>
### 저장 동작

승격은 임시 전환(`setModelTemporary`)을 사용합니다.

- 임시 역할 `"fallback"`의 `model_change`로 기록합니다(영구 사용자 모델 선택 아님).
- 저장된 역할 매핑은 다시 쓰지 않습니다.

<a id="configuring-promotion-targets"></a>
### 승격 대상 구성

모델 메타데이터의 `contextPromotionTarget`으로 대상을 직접 구성하세요.

`contextPromotionTarget`은 다음 중 하나를 허용합니다.

- `provider/model-id`(명시적)
- `model-id`(현재 제공자 안에서 확인)

명시적 OpenAI 승격 대상의 `models.yml` 예제:

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

모델 이름에서 유도한 체인에 의존하지 마세요. 대상을 명시적으로 구성하거나
제공자의 탐색 메타데이터에서 제공한 대상을 사용하세요.

<a id="compatibility-and-routing-fields"></a>
## 호환성 및 라우팅 필드

`compat` 블록은 엔드포인트 감지와 `packages/catalog/src/compat/rules/`의 KDL 제공자/모델 규칙 적용 후
`packages/catalog/src/compat/resolve.ts`에 희소 재정의를 제공합니다.
YAML 스키마는 `packages/coding-agent/src/config/models-config-schema-bundle.ts`에서 구성합니다.
확인된 구조는 모델 API에 따라 달라집니다. `OpenAICompat`는 희소 OpenAI 입력 타입이며,
chat-completions와 Responses 전송은 `packages/catalog/src/types.ts`의 대응하는 확인 레코드를 사용합니다.

이 필드와 상호작용하는 엔드포인트별 예외는 [제공자 엔드포인트 제약](./provider-endpoint-constraints.md)에 정리되어 있습니다.

`models.yml`은 아래 키를 지원합니다(모두 선택 사항. 미설정 시 카탈로그 규칙과 엔드포인트 기본값 사용).
필드는 확인된 호환성 레코드에 해당 필드가 선언된 API에만 영향을 줍니다.

요청 구성:

- `supportsStore` — 요청에 `store: false`를 출력합니다. 기본값: 자동(비표준 엔드포인트는 끔).
- `supportsDeveloperRole` — 추론 모델에 `system` 대신 `developer` 시스템 역할을 사용합니다. 기본값: 자동.
- `supportsMultipleSystemMessages` — 선행 system/developer 메시지를 합치지 않고 별도로 유지합니다. 기본값: 자동(알려진 OpenAI 호환 호스팅 API는 유지, 엄격 템플릿/로컬 호스트는 합침).
- `supportsUsageInStreaming` — 스트리밍 응답의 토큰 사용량을 받도록 `stream_options: { include_usage: true }`를 보냅니다. 기본값: 자동(보통 켬, Cerebras 호스트는 끔).
- `maxTokensField` — `"max_completion_tokens"` 또는 `"max_tokens"`. 기본값: 자동.
- `supportsToolChoice` — `tool_choice` 매개변수를 허용합니다. 기본값: 자동. `tool_choice`에 400을 반환하는 엔드포인트(예: 추론을 켠 DeepSeek)에는 `false`를 설정하세요.
- `supportsForcedToolChoice` — 특정 도구를 요구하는 강제 `tool_choice`를 허용합니다. 기본값: 자동. `false`이면 강제 선택기를 `auto`로 낮춰 강제 도구 호출을 거부하는 엔드포인트(일부 사고 필수 OpenAI 호환 모델 등)에서도 도구를 사용할 수 있게 합니다.
- `disableReasoningOnForcedToolChoice` — `tool_choice`가 호출을 강제하면 `reasoning_effort` / OpenRouter `reasoning`을 제거합니다. 기본값: 자동(Kimi/Anthropic 프런트 엔드포인트).
- `disableReasoningOnToolChoice` — 어떤 `tool_choice`든 전송할 때 추론 필드를 제거합니다. 기본값: 자동(DeepSeek 추론 모델).
- `disableReasoningWithTools` — 강제 선택이 없어도 도구가 있으면 추론을 억제합니다. 카탈로그 정책 재정의가 없으면 기본 `false`.
- `alwaysSendMaxTokens` — 호출자가 지정하지 않아도 항상 최대 토큰 필드를 보냅니다. 기본값: 자동(Kimi 계열은 `max_tokens`에서 TPM 제한 유도).
- `strictResponsesPairing` — Responses API 도구 호출/결과 이력이 엄격한 쌍을 이루어야 합니다. 기본값: 자동(Azure OpenAI, GitHub Copilot).
- `statefulResponses` — `openai-responses`의 저장된 `previous_response_id` 연결을 켜거나 끕니다. 켜면 후속 턴에 `store: true`와 변경분 입력을 보내고, 끄면 `store: false`로 전체 컨텍스트를 재전송합니다. 우선순위: 호출 옵션 > `PI_OPENAI_STATEFUL` > `compat.statefulResponses` > `compat.officialEndpoint`(공식 OpenAI는 켬, 나머지는 끔). 이 키는 `officialEndpoint`나 `text.verbosity` 같은 공식 전용 필드를 켜지 않으며 Codex/Azure Responses 동작을 바꾸지 않습니다.
- `streamIdleTimeoutMs` — 느린 추론 호스트용 스트림 감시 유휴 제한 시간 하한(ms). 기본값: 자동(GLM coding-plan 호스트, 직접 DeepSeek 추론).
- `streamMarkupHealingPattern` — `kimi`, `dsml`, `qwen`, `thinking` 문법으로 유출된 스트림 제어 마크업을 복구합니다. 기본값: 엔드포인트/모델 정책.
- `cacheControlFormat` — `"anthropic"`이면 chat-completions 페이로드에 Anthropic 스타일 프롬프트 캐시 마커를 포함합니다. 기본값: 자동(OpenRouter `anthropic/*` 모델).
- `supportsLongPromptCacheRetention` — 호스트가 Responses API의 `prompt_cache_retention: "24h"`를 지원합니다. 기본값: 자동(api.openai.com).
- `supportsImageDetailOriginal` — 엔드포인트가 지원하면 Responses API의 비표준 `detail: "original"` 이미지 모드를 허용합니다. 기본값은 OpenAI, Azure OpenAI, Codex에서 `true`, 사용자 지정/로컬, xAI, Copilot 등 다른 호스트에서 `false`입니다. 사용자 지정 호스트는 `compat.supportsImageDetailOriginal: true`로 활성화하지 않으면 snapcompact 프레임과 컴퓨터 스크린샷에 `auto`를 받습니다. 명시적 `false`는 알려진 호스트 기본값도 재정의합니다.
- `supportsConfigurationUpdate` — 요청 수준 노력은 프롬프트 캐싱용으로 고정한 채 `configuration_update` 입력 항목으로 세션 중 `reasoning.effort`를 바꿀 수 있게 합니다(GPT-6 Astra). 기본값: 자동(모든 호스트의 `gpt-6-astra`는 `true`, 나머지는 `false`). 이 항목 유형에 HTTP 400을 반환하는 사용자 지정 `openai-responses` / `openai-codex-responses`에는 `false`를 설정하세요. 그러면 노력 변경을 최상위 `reasoning.effort`로 보내고 갱신 항목은 출력하지 않습니다.
- `supportsSteering` — Codex WebSocket 전송이 `response.steer`를 보내 모델 응답 중 입력한 메시지를 다음 요청까지 기다리지 않고 해당 응답에 포함하도록 합니다. 기본값: 자동(GPT-6 계열은 `true`). 이벤트를 거부하는 프록시에는 `false`를 설정하세요.
- `extraBody` — 모든 요청 본문에 병합할 추가 최상위 필드(게이트웨이 힌트, 컨트롤러 선택기 등).

이미지 처리:

- `stripImageInput` — `openai-completions` 요청 인코딩 전에 이미지 부분을 제거합니다(OpenRouter 채팅 폴백 `PI_OPENROUTER_RESPONSES=0` 포함). 카탈로그 클래스 규칙은 제공자의 자체 `input` 선언과 별개로 엔드포인트가 흔히 텍스트 전용으로 제공하는 모델 계열(DeepSeek 클래스 등)에 이를 설정하므로 `input: [text, image]`여도 이미지를 보내지 않을 수 있습니다. 모델별 `compat`는 이 규칙 위에 깊게 병합되어 우선합니다. 비전 보강 프록시 등 엔드포인트가 실제 `image_url`을 받는 ID에는 `stripImageInput: false`를 설정하세요. 기본값: 자동(카탈로그 클래스/제공자 규칙). Responses와 Anthropic/Google 인코더는 모델이 선언한 모달리티를 전송하며 `pi-native`도 같습니다(원래 컨텍스트를 게이트웨이에 전달하므로 클라이언트 가드가 실행되지 않고 `images` 열은 선언된 `input`을 표시).

추론/사고:

사용자 지정 모델과 재정의에는 필수 `mode`, `efforts` 및 `defaultLevel`, `effortMap`, `supportsDisplay`,
`requiresEffort`를 가진 `thinking`을 정의할 수 있습니다. 모드는 `effort`, `budget`, `google-level`,
`anthropic-adaptive`, `anthropic-budget-effort`입니다. 노력 순서는 `minimal|low|medium|high|xhigh|max`입니다.
레거시 `levels` 또는 `minLevel`/`maxLevel` 구조는 `efforts`로 정규화하며 명시적 `efforts`가 우선합니다.
`requiresEffort`의 기본값은 자동 감지입니다. 구성 백엔드가 명시적 추론 끄기 요청을 허용한다고
확인한 경우에만 `false`로 설정하세요. 그러면 `:off` 선택기가 최저 노력으로 제한되는 것을 막습니다.

기본 `thinkingFormat: openai` 사용자 지정 모델의 `--thinking off`는 `openai-completions`에서
명시적 끄기 페이로드가 없습니다. `requiresEffort: false`여도 `reasoning_effort`를 보내면
`efforts`의 첫 노력을 요청합니다(예: `efforts: [low, medium, high]`는 `reasoning_effort: low` 전송).
따라서 낮은 노력부터 나열하세요. 추론을 끄려면 서버가 끄기로 취급하는 요청 구조가 필요합니다.
예를 들어 `thinkingFormat: qwen-chat-template`는
`chat_template_kwargs: { enable_thinking: false }`를 보냅니다.

- `supportsReasoningEffort` — `reasoning_effort`를 허용합니다. 기본값: 엔드포인트/모델 정책. 같은 제공자 안에서도 지원 형식이 다를 수 있습니다.
- `supportsReasoningParams` — 요청 구성 시 추론 매개변수를 전송할 수 있는지 지정합니다. 기본값: 자동(GitHub Copilot chat-completions는 끔).
- `supportsReasoningSummary` — Responses 추론 요약을 허용합니다. 기본값: 엔드포인트/모델 정책. `reasoning.summary`를 거부하면 `false`로 설정하세요.
- `reasoningEffortMap` — 내부 노력 수준(`minimal|low|medium|high|xhigh|max`)에서 제공자 문자열로의 부분 매핑(예: Fireworks GLM의 `minimal -> "none"`).
- `thinkingFormat` — 사고 요청 구조: `"openai"`(`reasoning_effort`), `"openrouter"`(`reasoning: { effort }`), `"zai"`(`thinking: { type: "enabled" }`), `"qwen"`(최상위 `enable_thinking`), `"qwen-chat-template"`(`chat_template_kwargs.enable_thinking`). 기본값: 엔드포인트/모델 정책, 보통 `"openai"`.
- `qwenTemplateReasoningEffort` — 선택한 노력을 Qwen 3.8+ 채팅 템플릿의 `reasoning_effort` 키워드 인수로 전달합니다(`chat_template_kwargs.reasoning_effort`, `qwen` 형식에는 최상위 필드도 사용). 기본값: 카탈로그 정책(LM Studio, llama.cpp 탐색, vLLM의 Qwen 3.8+에서 켬). 알 수 없는 `chat_template_kwargs`를 거부하는 엄격 서버에는 `false`로 설정하세요. 그러면 Qwen 형식에 노력을 보내지 않고 템플릿 자체 기본값으로 실행합니다.
- `reasoningContentField` — 사고 과정을 담는 assistant 필드: `"reasoning_content"`, `"reasoning"`, `"reasoning_text"`. 기본값: 자동.
- `requiresReasoningContentForToolCalls` — assistant 도구 호출 턴은 추론 필드를 왕복 전달해야 합니다. 기본값: 엔드포인트/모델 정책(DeepSeek, Kimi, 추론 활성 OpenRouter 포함).
- `allowsSyntheticReasoningContentForToolCalls` — 이전 assistant 도구 호출 턴에 제공자 추론 내용이 없을 때 대체 추론 필드를 허용합니다. 기본값: 엔드포인트/모델 정책. 정확한 추론 값을 검증하는 제공자에는 `false`를 설정하세요.
- `requiresAssistantContentForToolCalls` — assistant 도구 호출 턴에 비어 있지 않은 텍스트가 필요합니다. 기본값: 엔드포인트/모델 정책(Kimi, 직접 DeepSeek 추론 포함).
- `whenThinking` — 실제 사고 모드 요청에만 적용할 부분 호환성 재정의(기준 compat 위에 깊게 병합).

도구/메시지 정규화:

- `requiresToolResultName` — 도구 결과 메시지에 `name` 필드가 필요합니다(Mistral). 기본값: 자동.
- `requiresAssistantAfterToolResult` — 도구 결과 뒤 사용자 메시지 사이에 assistant 턴이 필요합니다. 기본값: 자동.
- `requiresThinkingAsText` — 사고 블록을 `<thinking>` 구분자로 감싼 텍스트로 변환합니다(Mistral). 기본값: 자동.
- `requiresMistralToolIds` — 도구 호출 ID를 정확히 영숫자 9자로 정규화합니다. 기본값: 자동.
- `supportsStrictMode` — 도구 스키마의 도구별 `strict` 필드를 허용합니다. 기본값: 제공자/baseUrl별 보수적 자동 감지.
- `toolStrictMode` — `"all_strict"`는 모든 도구를 strict로 강제하고 `"none"`은 끕니다. 미설정 시 엔드포인트/모델 정책(보통 혼합, Cerebras 호스트는 모두 strict).

게이트웨이 라우팅(`baseUrl`이 게이트웨이와 일치할 때만 적용):

- `openRouterRouting.only` / `openRouterRouting.order` — `openrouter.ai`의 제공자 라우팅(<https://openrouter.ai/docs/provider-routing> 참조).
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — `ai-gateway.vercel.sh`의 제공자 라우팅(<https://vercel.com/docs/ai-gateway/models-and-providers/provider-options> 참조).

제공자 수준 `compat`가 기준이며 모델별 `compat`를 그 위에 깊게 병합합니다.
`openRouterRouting`, `vercelGatewayRouting`, `extraBody`, `whenThinking`은 중첩 객체로 병합합니다.

<a id="anthropic-compatibility-anthropic-messages"></a>
### Anthropic 호환성 (`anthropic-messages`)

`anthropic-messages` 모델에는 별도 `AnthropicCompat` 구조(`packages/catalog/src/types.ts`)를 사용합니다.
`models.yml` 스키마는 strict 도구 비활성화를 최상위 제공자 필드로 노출합니다.
`compat` 안에서는 `AnthropicCompat` 필드 이름과 일치하는 공유 키를 모두 반영합니다:
`supportsContextManagement`, `supportsEagerToolInputStreaming`, `supportsForcedToolChoice`,
`allowAnthropicHeaderOverrides`, `requiresToolResultId`, `replayUnsignedThinking`, `bedrockMessagesApi`,
`stripImageInput`, `streamIdleTimeoutMs`. 다른 Anthropic 조절 항목은 내장 카탈로그 메타데이터가 제공하며
여기서 구성할 수 없습니다. `applyCompatOverrides`는 확인된 구조에 선언되지 않은 재정의 키를 버립니다.

<a id="bedrock-compatibility-bedrock-converse-stream"></a>
### Bedrock 호환성 (`bedrock-converse-stream`)

같은 `compat` 슬롯에서 Bedrock 모델용 `promptCacheMode`(`none`, `automatic`, `explicit`),
`supportsLongPromptCacheRetention`, `promptCacheMinimumTokens`, `promptCacheMaximumCheckpoints`,
`supportsForcedToolChoice`(`false`이면 강제 `any`/`tool`을 `auto`로 폴백. Claude Opus/Sonnet 5.5에 내장),
`supportsThinkingBindingControls`를 허용합니다. 접두사 결합 Claude 모델(Fable 5.1+, Opus/Sonnet/Haiku 5.5)은
기본적으로 `thinking.block_binding`, `thinking-binding-controls-2026-08-01` 베타,
`/input_transformations` 응답 경로를 보냅니다. 거부하는 게이트웨이/지역에는
`supportsThinkingBindingControls: false`를 설정하세요. 로컬 접두사 결합 보호는 유지되며,
접두사 불일치 거부 시 결합된 사고를 제거하고 한 번 재시도합니다.

기본 `bedrock-converse-stream` 요청은 `bedrock-runtime.{region}.amazonaws.com`으로 갑니다.
요청별 명시적 지역 또는 모델 ARN 지역이 우선합니다. 없으면 `AWS_REGION`/`AWS_DEFAULT_REGION`/AWS 프로필의
주변 지역이 추론 프로필의 지역 접두사와 호환될 때 사용하며, 호환 가드레일 ARN 지역 또는 해당 지역 기본값으로
폴백합니다. 알려진 지역 접두사가 없는 모델은 주변 지역, 가드레일 ARN 지역, `us-east-1` 순으로 사용합니다.
VPC/PrivateLink 엔드포인트, FIPS 호스트, 게이트웨이 등 다른 곳으로 보내려면 `providers.amazon-bedrock` 또는
`api: bedrock-converse-stream` 사용자 지정 제공자에 `baseUrl`을 설정하세요. `baseUrl`의 경로는 접두사로,
쿼리는 최종 URL 끝에 유지하며 서명 시 SigV4 정규 요청에도 포함합니다.
최종 URL은 `{baseUrl}/model/{id}/converse-stream[?query]`입니다.
따라서 헤더 대신 쿼리 매개변수로 인증하는 게이트웨이도 지원합니다.

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://vpce-0123456789abcdef0.bedrock-runtime.us-east-1.vpce.amazonaws.com
```

한 가지 호스트 형식은 그대로 사용하지 않습니다. `baseUrl`이 정확히 `bedrock-runtime.{region}.amazonaws.com`이면
AWS 자체 엔드포인트이므로 지역 부분을 확인된 지역으로 바꿉니다. 서명 지역은 전송 지역과 일치해야 하며 모든
번들 Bedrock 모델에 이미 이런 `baseUrl`이 있습니다. 원본을 정확히 고정하려면 VPC 엔드포인트,
`-fips`, 게이트웨이 같은 별도 호스트를 사용하세요.

SigV4는 여전히 실제 AWS 지역으로 서명하므로 `baseUrl`은 지역 확인 자체에 영향을 주지 않습니다.
엔드포인트가 특정 지역을 요구하면 `AWS_REGION` 또는 지역 범위 모델 ID/ARN을 사용하세요.
SigV4 대신 bearer 토큰을 받는 게이트웨이는 AWS 서명 자격 증명이 필요 없습니다.
제공자 `apiKey` 또는 `AWS_BEARER_TOKEN_BEDROCK`을 설정하면 서명을 건너뜁니다.
지역 확인은 여전히 AWS 기본 호스트를 제어합니다.

<a id="claude-on-bedrocks-anthropic-messages-api-anthropic"></a>
### Bedrock Anthropic Messages API의 Claude (`/anthropic`)

Amazon Bedrock은 두 엔드포인트의 `/anthropic`에서 Anthropic Messages API로 Claude도 제공합니다.
AWS는 새 애플리케이션에 `bedrock-runtime`을 권장합니다
([Anthropic Messages API로 추론](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html)).
Claude Opus 4.7 이상은 여기서 제공하며 Opus 4.6 이하는 Converse에 남습니다
([Amazon Bedrock의 Claude](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)).

| 경로 | 기본 URL | 제공자 | 모델 ID |
| --- | --- | --- | --- |
| bedrock-runtime | `https://bedrock-runtime.<region>.amazonaws.com/anthropic` | `amazon-bedrock` | 추론 프로필, 예: `us.anthropic.claude-opus-5-5` |
| bedrock-mantle | `https://bedrock-mantle.<region>.api.aws/anthropic` | `bedrock-mantle` | `anthropic.claude-opus-5-5` |

FIPS 호스트(`bedrock-runtime-fips.<region>.amazonaws.com`)와 AWS PrivateLink 엔드포인트별 호스트
(`<vpce-id>[-<az>].bedrock-runtime.<region>.vpce.amazonaws.com`, `bedrock-runtime-fips`와
`bedrock-mantle`도 동일)는 같은 경로로 인식합니다. 비공개 DNS가 켜진 VPC 엔드포인트는
공개 호스트 이름에 응답하므로 바꿀 필요가 없습니다
([Bedrock VPC 엔드포인트](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)).

표의 제공자 아래에 `api: anthropic-messages`로 모델을 정의하세요. 두 제공자 ID에는 Claude의 요청 시 압축을
활성화하는 카탈로그 규칙이 있습니다([압축](./compaction.md)). 일반 API 키 요청을 보내도록 `auth: apiKey`를
설정하세요. 없으면 사용자 지정 `anthropic-messages` 모델은 Claude Code 요청 구성을 사용합니다.
예제는 [Amazon Bedrock API 키](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)로
인증합니다. OMP는 runtime 경로 요청을 SigV4로 서명하지 않습니다. runtime URL에는 지역을 적으세요.
Mantle URL은 `{region}`을 유지할 수 있으며 OMP가 AWS 지역 설정에서 채웁니다.

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com
    apiKey: AWS_BEARER_TOKEN_BEDROCK
    auth: apiKey
    models:
      - id: us.anthropic.claude-opus-5-5
        api: anthropic-messages
        baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
        reasoning: true
        input: [text, image]
  bedrock-mantle:
    baseUrl: https://bedrock-mantle.{region}.api.aws/openai/v1
    apiKey: AWS_BEARER_TOKEN_BEDROCK
    auth: apiKey
    models:
      - id: anthropic.claude-opus-5-5
        api: anthropic-messages
        baseUrl: https://bedrock-mantle.{region}.api.aws/anthropic
        reasoning: true
        input: [text, image]
```

이 경로의 요청은 `compat.bedrockMessagesApi`로 구성하며, OMP는 모든 제공자 ID에서 Bedrock
`/anthropic` `baseUrl`을 통해 감지합니다. 두 경로 모두 도구 `strict` 필드를 거부하므로 제거합니다.
또한 runtime 경로가 강제하는 Bedrock [요청 메타데이터 패턴](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)에
`metadata.user_id`를 맞춥니다. 값이 맞으면 유지하고, 아니면 세션 ID를 보내며 그것도 없으면 생략합니다.
두 처리는 `onPayload` 훅 후에 실행합니다. 두 경로 모두 사고 서명을 검증하므로 기본적으로
서명 없는 사고를 재전송하지 않습니다.

URL 검사는 프록시 뒤 Bedrock 경로나 자체 `anthropic` 제공자의 `ANTHROPIC_BASE_URL` 재라우팅을 볼 수
없습니다. 명시적으로 활성화하지 않으면 일반 Anthropic 요청을 유지합니다.
제공자 전체 또는 `modelOverrides` 아래 `compat`에 플래그를 설정해 켜거나, Bedrock URL에서도
끄려면 `false`를 설정하세요.

```yaml
providers:
  anthropic:
    compat:
      bedrockMessagesApi: true # ANTHROPIC_BASE_URL points at bedrock-runtime /anthropic
```

요청 시 압축에는 여전히 카탈로그가 해당 기능을 부여한 모델 계열(`amazon-bedrock`, `bedrock-mantle`,
`anthropic`, `google-vertex` 제공자 ID)이 필요합니다. 임의 프록시 제공자 ID가
`bedrockMessagesApi`만으로 그 기능을 얻지는 않습니다.

<a id="strict-tool-schemas-disablestricttools"></a>
### 엄격한 도구 스키마 (`disableStrictTools`)

Anthropic API는 모델이 제공 스키마를 항상 정확히 따르도록 하는 도구 정의 `strict` 필드를 지원합니다. OMP는 스키마가 Anthropic 엄격 문법 제한에 맞는 자주 쓰는 내장 `anthropic-messages` 도구의 작은 허용 목록(`python`, `edit`, `find`)에서 기본 활성화합니다. 다른 도구도 정규화 스키마를 보내지만 `strict`는 생략합니다. `bash`는 제외합니다. 엄격 디코딩은 속성 순서를 고정하므로 호출이 `async`를 쓴 후에는 그 앞에 선언된 `timeout`을 출력할 수 없기 때문입니다.

Anthropic API 앞의 타사 제공자(AWS Bedrock, Azure, 자체 호스팅 프록시)는 이 필드를 항상 구현하지는 않아 포함 요청을 거부할 수 있습니다. 허용 목록 도구의 엄격 모드를 끄려면 제공자 수준에 `disableStrictTools: true`를 설정하세요.

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools`는 제공자의 모든 모델에 적용되는 제공자 수준 플래그입니다. OMP가 원래 strict로 표시할 도구의 Anthropic `strict` 마커만 끄며 런타임 도구 인수 검증은 바꾸지 않습니다. 첫 스트리밍 토큰 전에 Anthropic이 엄격 문법 과대 오류를 보고하면 OMP는 strict 도구 없이 자동 재시도할 수 있지만, 다른 이유로 `strict`를 거부하는 프록시는 플래그를 명시해야 합니다.

전송 도구 스키마는 `packages/ai/src/utils/schema/normalize.ts`의 통합 흐름으로 정규화합니다
(Google/CCA/MCP 디스패처 및 OpenAI 엄격 모드 정리+강제 파이프라인).
로컬 `$ref` 인라인화, 단일 항목 `allOf` 통합, `anyOf` 래퍼 설명 끌어올리기,
enum/const 기본 타입 추론 같은 엄격 모드 경계 사례와 제공자별 디스패처 매핑은
[`ai-schema-normalize.md`](./ai-schema-normalize.md)를 참조하세요.

<a id="practical-examples"></a>
## 실제 예제

<a id="local-openai-compatible-endpoint-no-auth"></a>
### 로컬 OpenAI 호환 엔드포인트(인증 없음)

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

탐색 가능한 `/v1/models` 엔드포인트가 있는 oMLX 또는 다른 로컬 OpenAI 호환 서버에서는 모델 수동 나열보다 탐색을 권장합니다. 서버가 실제 제공하는 엔드포인트 계열로 `api`를 설정하세요. `openai-completions`는 `/v1/chat/completions`를 사용하며 `/v1/responses` 서버에는 `openai-responses`가 필요합니다.

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

내장 vLLM 제공자는 사용자 지정 탐색 유형 선언 없이 기본값이 아닌 엔드포인트로 지정할 수 있습니다. OMP는 vLLM의 `/v1/models` 메타데이터를 사용하며 `max_model_len` 필드를 탐색된 컨텍스트 창으로 유지합니다.

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

여러 vLLM 엔드포인트에는 일반 OpenAI 호환 탐색 경로와 임의 제공자 ID를 사용하세요. 인증 없는 로컬 서버에는 `auth: none`, 인증 서버에는 `apiKey`를 설정합니다. 일반 탐색은 먼저 `max_model_len`을 읽고 일반 OpenAI 호환 폴백으로 `context_length`를 읽습니다.

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

<a id="hosted-proxy-with-env-based-key"></a>
### 환경 기반 키를 사용하는 호스팅 프록시

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    auth: apiKey
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

<a id="override-built-in-provider-route--model-metadata"></a>
### 내장 제공자 경로 및 모델 메타데이터 재정의

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

<a id="legacy-consumer-caveat"></a>
## 레거시 사용 시 주의

대부분의 모델 구성은 이제 `ModelRegistry`를 통해 `models.yml` / `models.yaml`에서 처리합니다.
프로그래밍 방식으로 전달한 명시적 `.json` / `.jsonc` 경로도 계속 지원합니다.
활성 에이전트 디렉터리의 `models.yml`은 `models.yaml`보다 우선합니다.

<a id="failure-mode"></a>
## 실패 동작

`models.yml` / `models.yaml`이 스키마 또는 검증에 실패하면 다음과 같습니다.

- 레지스트리는 내장 모델로 계속 동작합니다.
- 오류는 `ModelRegistry.getError()`로 노출되며 UI/알림에도 표시됩니다.
