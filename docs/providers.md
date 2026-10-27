<a id="providers"></a>
# 제공자

제공자는 `omp`가 요청을 보낼 수 있는 모델 백엔드입니다. Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, Mistral, xAI, Ollama 같은 로컬 엔진, 호스팅 게이트웨이, 사용자 지정 `models.yml` 제공자, 확장에서 등록한 제공자가 여기에 포함됩니다.

**제공자**는 `anthropic`, `openai`, `google`, `ollama` 같은 계정 또는 백엔드 네임스페이스입니다. **모델**은 해당 제공자에 속한 구체적인 모델이며, `anthropic/claude-opus-4-6`처럼 `provider/model-id` 형식으로 선택합니다. 제공자를 비활성화하면 그 아래의 모든 모델이 선택 대상에서 제외됩니다. 개별 모델만 제한하려면 모델 설정을 사용하세요.

이 페이지에서는 제공자의 사용 가능 여부, 자격 증명 확인, 제공자와 환경 변수의 대응 관계, 로컬 엔진, 제공자 비활성화, 사용자 지정 제공자를 설명합니다. 엔드포인트별 요청, 추론, 도구, 스트림, 사용량, 재시도 제약은 [제공자 엔드포인트 제약](./provider-endpoint-constraints.md)을 참조하세요. 모델 선택과 전체 `models.yml` 스키마는 [모델 및 제공자 구성](./models.md), 설정 파일 위치와 병합 우선순위는 [설정](./settings.md), 자격 증명 저장과 로그인 흐름의 자세한 내용은 [비밀 정보 및 자격 증명](./secrets.md), 전체 환경 변수 참조는 [환경 변수](./environment-variables.md), 로컬 엔진 설정은 [로컬 모델](./local-models.md), 컨텍스트 파일 탐색 제공자는 [컨텍스트 파일](./context-files.md)을 참조하세요.

<a id="factory-droid"></a>
## Factory Droid

`factory-droid` 제공자는 Factory의 Droid 구독 게이트웨이를 직접 사용합니다. 로그인이나 추론에 `droid` 바이너리, 데몬, SDK 하위 프로세스가 필요하지 않습니다.

1. 대화형 세션에서 `omp login factory-droid` 또는 `/login factory-droid`를 실행합니다.
2. 출력된 `auth.factory.ai/device` 링크를 브라우저에서 열고, 표시된 기기 코드를 입력한 다음 로그인을 승인합니다.
3. `factory-droid/kimi-k3` 같은 모델을 선택하고 프롬프트를 보냅니다. 저장된 WorkOS 세션은 자동으로 갱신됩니다. `omp auth-broker login factory-droid`는 브로커 기반 자격 증명을 지원합니다.

이 제공자에는 구독 OAuth를 사용하세요. 설치된 Droid CLI에서 자격 증명을 탐색하거나 `FACTORY_API_KEY`를 읽지 않습니다. Factory의 별도 API 키 제품은 이 통합에 포함되지 않습니다.

모델 목록은 KDL로 제공됩니다(`packages/catalog/src/compat/rules/providers/factory-droid.kdl`, 각 모델의 전송 및 과금 풀은 `rules/runtime/behavior.kdl`). `FACTORY_DROID_CLIENT_VERSION`으로 고정된 Droid CLI 버전(`packages/catalog/src/wire/factory-droid.ts`)에 맞춰 수동으로 관리합니다. 여기에는 구체적인 CLI 모델이 포함되며 Factory Auto Model 라우터나 앱 전용 Flex 변형은 포함되지 않습니다. 계정 기능 플래그, 강제 지원 종료 조건, 조직 정책(명시적 동의 요구 사항 포함), 서비스 지역에 따라 실제 목록이 좁혀집니다. 새 모델 ID에는 카탈로그 업데이트가 필요합니다. 온라인 탐색이 성공하기 전까지 기능 또는 동의 조건이 있는 모델은 숨겨집니다. 오프라인 상태이거나 탐색에 실패하면 캐시된 스냅샷을 유지할 수 있지만, 현재 이용 권한을 보장하지는 않습니다.

이 목록에는 `image` 역할용 Factory `generate_image` 모델(`gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gemini-3-pro-image-preview`)도 포함됩니다. 탐색 시 조직의 관리 설정을 읽은 뒤에만 표시합니다. `imageGenerationEnabled: false`는 모두 숨기고 `imageGenerationAllowedModelIds`는 허용 모델을 제한합니다(빈 목록은 모두 숨김). 이미지 호출은 Standard Credits 풀에 청구합니다.

조직 ID와 데이터 상주 지역은 계정 순환을 포함해 각 요청에 사용되는 자격 증명에 따라 전달되며, 각 계정/상주 지역 범위에는 자체 모델 캐시가 있습니다. 상주 지역은 API 호스트를 선택하고, 별도의 추론 지역(`global`, `us`, `eu`)은 업스트림 사용 자격을 제한합니다.

계정이 토큰 속도 제한 과금을 사용하면 `/usage`와 `omp usage`는 Standard Credits 및 Droid Core 할당량 기간을 표시합니다. 과금 응답에서 해당 모드를 명시적으로 비활성화한 계정도 표시되지만, 할당량 기간이 제공되지 않는다는 안내가 붙습니다. OMP는 잔액을 임의로 만들어 내지 않습니다. 모델 브라우저는 각 모델의 기본 크레딧 요율을 보여 줍니다. 달러 금액은 업스트림 정가 참고치이지 Factory 청구 금액이 아니며, 어느 쪽도 임시 프로모션을 포함하지 않습니다. 달러 참고치가 없는 모델은 `free` 대신 크레딧 요율을 표시합니다. 추가 잔액만으로 초과 사용 과금이 활성화되었다고 판단하지 않습니다.

계정 순환으로 선택한 모델의 컨텍스트 창이 줄어들 경우, OMP는 기존 대화가 들어갈지 추측하지 않고 해당 재시도를 보내기 전에 중단합니다. `omp models refresh factory-droid`로 탐색을 갱신하고 지역에 맞는 모델을 선택한 다음 다시 시도하세요.

확장 컨텍스트를 비활성화해도 Factory의 기본 컨텍스트 제한은 유지됩니다. Factory GPT와 Gemini 경로는 출력 토큰 상한을 생략하므로, 제한이 있는 임시 턴은 조용히 무제한으로 실행하는 대신 `maxTokens` 요청을 거부합니다.

<a id="how-omp-decides-a-provider-is-available"></a>
## `omp`의 제공자 사용 가능 여부 판단 방식

모델 레지스트리는 다음 소스를 조합합니다.

1. 번들 모델 카탈로그.
2. 활성 에이전트 디렉터리의 `models.yml`에 있는 사용자 지정 제공자 및 모델 항목(기본값: `~/.omp/agent/models.yml`).
3. 로컬 엔진과 탐색이 활성화된 호스팅 제공자의 캐시된 모델 및 런타임 탐색 모델.
4. 확장 자체 탐색을 포함해 확장에서 등록한 제공자 및 모델.

시작 시 모든 엔드포인트를 기다리지 않고 구성과 캐시된 탐색 메타데이터를 불러옵니다. 이후 온라인 갱신으로 탐색 기반 카탈로그를 채웁니다. 신뢰할 수 있는 탐색이 성공하면 번들 제공자 항목을 대체할 수 있으며, 명시적 사용자 지정 모델과 재정의는 탐색된 카탈로그에 다시 적용됩니다. 브로커 기반 게이트웨이 모드에서는 로컬 `models.yml` 라우팅, 자격 증명, 사용자 지정 모델을 무시합니다.

레지스트리는 현재 선택할 수 없는 모델도 보유할 수 있습니다. 다음 두 조건을 모두 충족해야 모델이 **사용 가능**해집니다.

1. 제공자 ID가 유효한 `disabledProviders` 목록에 **없어야** 합니다. **그리고**
2. 제공자가 **키 불필요** 상태(암시적 로컬 제공자, `auth: none`인 사용자 지정 제공자, 키 없는 모드로 저장한 선택적 키 로그인)이거나 인증이 구성되어 있어야 합니다.

사용 가능 여부는 빠른 구성 확인이지 자격 증명 검증 요청이 아닙니다. 명령 기반 키를 실행하거나 OAuth 토큰을 갱신하지 않습니다. 따라서 잘못 구성한 키도 사용 가능으로 표시되었다가 추론 시 실패할 수 있습니다.

`disabledProviders`는 자격 증명보다 _먼저_ 확인합니다. 제공자 ID가 비활성화되어 있으면 저장된 키, OAuth 세션, 환경 변수, `.env` 항목, `models.yml`의 `apiKey` 중 무엇이 있어도 선택할 수 없습니다. 자격 증명과 관계없이 해당 제공자의 모델은 사용 가능 목록에서 제외됩니다. 유효한 목록에서 ID를 제거하면 복원됩니다.

암시적 `ollama`와 `lm-studio` 탐색은 기본적으로 키가 필요 없으며, 암시적 `llama.cpp`도 인증을 구성하지 않았다면 키가 필요 없습니다. 지원되는 Apple Silicon 시스템의 Apple Foundation Models도 키가 필요 없습니다. [내장 로컬 엔진](#built-in-local-engines)을 참조하세요.

<a id="credentials-and-precedence"></a>
## 자격 증명과 우선순위

제공자에 API 키가 필요하면 `omp`는 다음 순서로 확인합니다(처음 일치하는 항목이 우선).

1. **런타임 재정의**: CLI `--api-key`처럼 현재 프로세스에 제공한 키입니다. 영구 저장하지 않습니다.
2. **`models.yml` 구성 키**: 사용자 지정 제공자에 고정한 `apiKey`이며, 구성에서 온 bearer로 등록됩니다. 프록시가 거부할 업스트림 OAuth 토큰을 전달하는 대신 사용자 지정 `baseUrl`이나 게이트웨이에 제공한 키를 사용하도록 의도적으로 저장된 OAuth보다 우선합니다.
3. **저장된 OAuth 자격 증명**: 필요할 때 갱신하며 여러 계정의 순위를 정하고 자동으로 순환합니다. Anthropic과 ChatGPT(Codex)는 각 조직 또는 작업 공간을 별도 계정으로 취급합니다. 하나의 이메일에 Team 또는 Enterprise 좌석과 개인 요금제가 모두 있다면 구독별로 한 번씩 로그인할 수 있습니다(브라우저 동의 페이지에서 작업 공간 선택). 계정 순환에서도 두 계정으로 취급합니다.
4. **로그인으로 저장한 API 키**: 성공한 `/login`에서 저장한 API 키 자격 증명입니다.
5. **확장 구성 폴백**: `apiKey` 참조와 OAuth/로그인 흐름을 모두 등록한 확장 제공자는 그 참조를 저장된 OAuth 및 로그인 키보다 낮은 우선순위에 둡니다.
6. **제공자 환경 변수**: `.env` 파일에서 불러온 값도 포함합니다([환경 변수 표](#environment-variables-and-env-files) 참조).
7. **그 밖의 저장된 API 키**: 예를 들어 브로커에서 마이그레이션한 키입니다. 명시적 환경 변수가 우선하도록 마지막 수단으로 사용합니다.

로컬 자격 증명은 활성 인증 저장소(기본값: `~/.omp/agent/agent.db`)에 저장되며, 브로커 모드는 구성된 공유 인증 브로커를 사용합니다. 이름 있는 프로필과 Linux XDG 레이아웃은 저장소 위치를 바꿀 수 있습니다. 기본 프로필에서는 `PI_CODING_AGENT_DIR`이 에이전트 디렉터리를 재정의합니다. 경로 확인 방식은 [설정](./settings.md)과 [비밀 정보 및 자격 증명](./secrets.md)을 참조하세요.

<a id="oauth-vs-api-key-and-provider-scoped-logins"></a>
### OAuth와 API 키, 제공자 범위 로그인

로그인은 **제공자 범위**입니다. `anthropic` 인증은 `openai`를 인증하지 않으며, 각 제공자는 자체 자격 증명을 관리합니다. 비활성화된 제공자는 유효한 저장 인증이 있어도 비활성 상태를 유지합니다.

세션 안에서 대화형 슬래시 명령을 사용하세요.

- `/login` — OAuth/키 선택기를 엽니다. `/login <provider>`는 해당 제공자로 바로 이동합니다(예: `/login anthropic`). 콜백을 붙여 넣어야 하는 OAuth 흐름에서는 `/login <redirect-url>`로 완료합니다.
- `/logout` — 저장된 자격 증명을 제거할 제공자 선택기를 엽니다.

세션 밖에서는 `omp login [<provider>]`가 확장 등록 제공자를 포함해 터미널에서 같은 로그인을 실행합니다. 인증 URL을 출력하고 브라우저에서 열며, stdin으로 입력을 받고, 세션과 같은 저장소(로컬 `agent.db` 또는 구성된 인증 브로커)에 저장합니다. 제공자를 생략하면 번호가 붙은 선택기가 표시됩니다. 로그인에 성공하면 해당 제공자의 모델 카탈로그를 온라인으로 갱신하여 새로 허용된 모델을 표시합니다.

공유 인증 브로커를 사용하는 헤드리스 또는 원격 구성에서는 CLI의 `omp auth-broker login <provider>` / `omp auth-broker logout` 및 `status`, `list`, `import`, `migrate`를 사용할 수 있습니다. 브로커 모델은 [비밀 정보 및 자격 증명](./secrets.md)을 참조하세요.

모델에 자격 증명이 없으면 `omp`는 `/login`을 실행하거나 제공자 환경 변수를 설정하라고 안내합니다.

ClinePass는 `CLINE_API_KEY`를 설정하거나 `/login cline-pass`를 실행하세요. Cline 대시보드를 열고 새 API 키를 `/users/me`로 검증하며, 완성 요청으로 확인하거나 구독 할당량을 소모하지 않습니다. OMP는 Cline의 공개 추천 모델 엔드포인트에서 목록을 갱신하며 오프라인 시작을 위해 검토된 Cline 메타데이터를 번들로 제공합니다. 새로운 실시간 ID는 업스트림 참조로 보강하거나, 임의의 추론 제어를 만들지 않는 보수적인 메타데이터를 사용합니다. `omp usage`는 5시간, 주간, 월간 할당량 기간을 표시합니다. 무료 등급 모델에는 `(free)`가 표시되며 같은 키를 사용합니다. 구독 모델에는 API 환산 참고 요금이 표시되지만 실제 요금은 스트리밍된 게이트웨이 비용이 기준입니다. 요청은 Cline CLI 클라이언트 헤더와 세션별로 일정한 작업 ID를 따르며, 추론 제어는 모델별로 유지됩니다.

Command Code는 `COMMAND_CODE_API_KEY`를 설정하거나 `/login commandcode`를 실행하세요. 로그인은 Command Code의 `/alpha/whoami` 엔드포인트로 키를 확인하며 Command Code CLI처럼 401일 때만 거부하므로, 403이거나 확인할 수 없으면 키를 유지합니다. Command Code CLI와 동일하게 Claude 모델은 Anthropic Messages, GPT 모델 10개는 OpenAI Responses, 나머지는 Chat Completions 엔드포인트를 사용합니다. 사고 수준, 이미지 입력, 출력 제한, 가격은 Command Code CLI 모델 레지스트리를 따릅니다. 아직 그 레지스트리에 없는 Claude Sonnet 5.5는 Anthropic 카탈로그를 따릅니다. GPT 모델은 호스팅 웹 검색을 실행할 수 있지만, Command Code가 제공하지 않는 호스팅 이미지 생성은 사용할 수 없습니다. TypeSafe의 `typesafe/jev` 판단 모델은 `judge` 역할에서 사용할 수 있습니다. `omp usage`, `/usage`, 상태 표시줄에는 크레딧 잔액과, 해당 요금제에 있는 경우 5시간 및 주간 사용 기간이 표시됩니다. 이 수치는 Command Code CLI가 사용하는 계정 엔드포인트에서 가져오며 Provider API 문서에는 설명되어 있지 않습니다.

<a id="pinning-a-key-in-modelsyml"></a>
### `models.yml`에 키 고정하기

사용자 지정 제공자의 `apiKey`는 **환경 변수 이름 또는 리터럴**로 해석됩니다. 대소문자가 정확히 일치하고 비어 있지 않은 환경 변수의 이름이면 해당 값을 사용하고, 아니면 문자열 자체를 키로 사용합니다. 값 앞에 `!`를 붙이면 셸 명령으로 실행하고 stdout의 앞뒤 공백을 제거한 값을 사용합니다(전체 값 문법은 [모델 및 제공자 구성](./models.md) 참조).

```yaml
# ~/.omp/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY # reads this env var if set, else literal text
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

사용자 지정 제공자에 `authHeader: true`를 설정하면 확인된 키가 해당 제공자의 모든 요청에 `Authorization: Bearer <key>` 헤더로 삽입됩니다.

<a id="environment-variables-and-env-files"></a>
## 환경 변수와 `.env` 파일

아래 변수는 런타임/구성 재정의와 저장된 OAuth/로그인 자격 증명 다음에 자격 증명을 제공합니다. 로그인으로만 인증하는 제공자는 키 변수가 없을 수 있습니다. 일반 폴백 이름은 카탈로그 제공자 KDL에서 오며, 인증 정책은 순서가 있는 이름 목록이나 계산된 확인기로 이를 재정의할 수 있습니다.

<a id="core-providers"></a>
### 주요 제공자

| 제공자 ID | 환경 변수 |
| --- | --- |
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`, 다음 `ANTHROPIC_API_KEY` (`CLAUDE_CODE_USE_FOUNDRY=true`인 Foundry 모드에서는 `ANTHROPIC_FOUNDRY_API_KEY` 우선) |
| `openai` | `OPENAI_API_KEY` |
| `openai-codex` | `OPENAI_CODEX_OAUTH_TOKEN` |
| `google` | `GEMINI_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY` 또는 ADC(명시적 `GOOGLE_APPLICATION_CREDENTIALS` 또는 gcloud 기본 ADC 파일과 프로젝트 및 위치 변수, 아래 참조) |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `xai-oauth` | `XAI_OAUTH_TOKEN`, 다음 `XAI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` |
| `cursor` | `CURSOR_ACCESS_TOKEN` |
| `azure` | `AZURE_OPENAI_API_KEY` |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, AWS 프로필, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, 또는 ECS/IRSA/EC2 자격 증명 체인 |

<a id="additional-hosted-providers"></a>
### 추가 호스팅 제공자

| 제공자 ID | 환경 변수 |
| --- | --- |
| `abliteration` | `ABLITERATION_API_KEY`, 다음 `ABLIT_KEY` |
| `aiand` | `AIAND_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `alibaba-token-plan` | `ALIBABA_TOKEN_PLAN_API_KEY`, 다음 `BAILIAN_TOKEN_PLAN_API_KEY` |
| `baseten` | `BASETEN_API_KEY` |
| `bedrock-mantle` | `AWS_BEARER_TOKEN_BEDROCK` 또는 AWS 자격 증명 체인(SigV4) |
| `commandcode` | `COMMAND_CODE_API_KEY`, 다음 `COMMANDCODE_API_KEY` |
| `coralbricks` | `CORAL_API_KEY`, 다음 `CORALBRICKS_API_KEY` |
| `deepinfra` | `DEEPINFRA_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `siliconflow` | `SILICONFLOW_API_KEY` |
| `siliconflow-cn` | `SILICONFLOW_CN_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `typesafe` | `TYPESAFE_API_KEY` |
| `coreweave` | `COREWEAVE_API_KEY`, 다음 `WANDB_API_KEY` |
| `nvidia` | `NVIDIA_API_KEY` |
| `devin` | `DEVIN_API_KEY` |
| `gmi-cloud` | `GMI_API_KEY` |
| `huggingface` | `HUGGINGFACE_HUB_TOKEN`, 다음 `HF_TOKEN` |
| `inception` | `INCEPTION_API_KEY` |
| `moonshot` | `MOONSHOT_API_KEY`, 다음 `KIMI_API_KEY` |
| `stepfun` | `STEPFUN_API_KEY` |
| `helmcode` | `HELMCODE_API_KEY` |
| `meta` | `MODEL_API_KEY`, 다음 `META_API_KEY` |
| `nanogpt` | `NANO_GPT_API_KEY` |
| `novita` | `NOVITA_API_KEY` |
| `venice` | `VENICE_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` (카탈로그 탐색에는 `VERCEL_AI_GATEWAY_API_KEY`도 사용) |
| `cloudflare-ai-gateway` | `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_TOKEN`, 다음 `CLOUDFLARE_AUTH_TOKEN`, + `CLOUDFLARE_ACCOUNT_ID` |
| `snowflake` | `SNOWFLAKE_PAT` + `SNOWFLAKE_ACCOUNT` |
| `litellm` | `LITELLM_API_KEY`; 프록시 엔드포인트용 선택 사항 `LITELLM_BASE_URL` |
| `kilo` | `KILO_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `zenmux` | `ZENMUX_API_KEY` |
| `zhipu-coding-plan` | `ZHIPU_API_KEY` |
| `umans` | `UMANS_AI_CODING_PLAN_API_KEY` |
| `qianfan` | `QIANFAN_API_KEY` |
| `qwen-portal` | `QWEN_OAUTH_TOKEN`, 다음 `QWEN_PORTAL_API_KEY` |
| `synthetic` | `SYNTHETIC_API_KEY` |
| `minimax-code` | `MINIMAX_CODE_API_KEY` |
| `minimax-code-cn` | `MINIMAX_CODE_CN_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `alibaba-coding-plan` | `ALIBABA_CODING_PLAN_API_KEY` |
| `sakana` | `SAKANA_API_KEY`, 다음 `FUGU_API_KEY` |
| `sambanova` | `SAMBANOVA_API_KEY` |
| `aimlapi` | `AIMLAPI_API_KEY` |
| `gitlab-duo`, `gitlab-duo-agent` | `GITLAB_TOKEN` |
| `opencode-zen`, `opencode-go` | `OPENCODE_API_KEY` |
| `cline-pass` | `CLINE_API_KEY` |
| `factory-droid` | 없음 — `/login factory-droid` 사용 |
| `firepass` | `FIREPASS_API_KEY` |
| `wafer-serverless` | `WAFER_SERVERLESS_API_KEY` |
| `xiaomi` | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-ams` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-cn` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-sgp` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `ollama-cloud` | `OLLAMA_CLOUD_API_KEY` |
| `ollama` | `OLLAMA_API_KEY` (선택 사항, 로컬 탐색은 기본적으로 키 불필요) |
| `lm-studio` | `LM_STUDIO_API_KEY` (선택 사항, 기본적으로 키 불필요) |
| `llama.cpp` | `LLAMA_CPP_API_KEY` (서버가 인증을 요구할 때만) |
| `vllm` | `VLLM_API_KEY` (인증 없는 로컬 서버에서는 선택 사항) |
| `yolo-auto` | `YOLO_AUTO_API_KEY` |
| `charm-hyper` | `CHARM_HYPER_API_KEY`, 다음 `HYPER_API_KEY` |
| `singularityapi-dev` | `SINGULARITYAPI_DEV_API_KEY` |
| `singularityapi-tech` | `SINGULARITYAPI_TECH_API_KEY` |

Vertex ADC 사용 가능 여부는 프로젝트 별칭 `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `GCLOUD_PROJECT`와 위치 별칭 `GOOGLE_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_LOCATION`을 허용합니다.

`xai-oauth`의 `XAI_API_KEY`는 명시적 요청에는 허용되지만 SuperGrok 모델을 자동으로 사용 가능하게 하거나 우선 선택하지 않습니다. 자동 사용 가능 상태에는 전용 `XAI_OAUTH_TOKEN` 또는 저장/구성된 인증이 필요합니다.

`/login cloudflare-ai-gateway`는 게이트웨이 토큰, Cloudflare 계정 ID, 게이트웨이 ID를 입력받고 세 값을 함께 저장합니다. 환경 변수를 사용하려면 위 세 값을 모두 설정하세요. OMP는 모델별로 Anthropic, OpenAI 또는 Workers AI 게이트웨이 경로를 선택하므로 `models.yml`의 기본 URL을 재정의할 필요가 없습니다.

`cloudflare-workers-ai`는 Cloudflare Clef 판단 모델(`cloudflare-workers-ai/@cf/cloudflare/clef`와 `cloudflare-workers-ai/@cf/cloudflare/clef-flash`)을 `judge` 모델로 제공합니다. 사용하려면 하나를 `judge` 역할에 지정하세요. `/login cloudflare-workers-ai`는 Workers AI Read 및 Edit 권한이 있는 Cloudflare API 토큰(`https://dash.cloudflare.com/profile/api-tokens`에서 생성)과 계정 ID를 입력받고 함께 저장합니다. 환경 변수로는 `CLOUDFLARE_API_TOKEN`(또는 `CLOUDFLARE_AUTH_TOKEN`)과 `CLOUDFLARE_ACCOUNT_ID`를 설정하세요.

`/login snowflake`는 Snowflake 계정 식별자 또는 계정 URL을 입력받고 Snowflake의 내장 로컬 애플리케이션 OAuth 통합으로 브라우저 로그인한 뒤 계정과 토큰을 저장합니다. 환경 변수를 사용하려면 `SNOWFLAKE_PAT`와 `SNOWFLAKE_ACCOUNT`를 모두 설정하세요.

`charm-hyper`는 코딩 에이전트를 위한 Charm의 OpenAI 호환 추론 게이트웨이입니다. `https://hyper.charm.land/`에서 키를 발급하거나 관리하세요. 모델 목록은 제공자의 공개 `/v1/models` 엔드포인트에서 실시간으로 탐색하며, `HYPER_API_KEY`는 `CHARM_HYPER_API_KEY`의 폴백 별칭으로 허용됩니다.

`inception`은 Inception의 기본 Mercury API입니다. `INCEPTION_API_KEY`를 설정하거나 `https://platform.inceptionlabs.ai/dashboard/api-keys`의 키로 `/login inception`을 실행한 뒤 `inception/mercury-3`를 선택하세요. OMP는 `/v1/models`에서 Mercury 3, Mercury 2.5, Mercury 2를 포함한 채팅 모델을 탐색하며 FIM/편집 및 Decisions 전용 모델은 제외합니다. Mercury 3는 1,000,000토큰 컨텍스트와 최대 131,072 출력 토큰을 지원합니다. 사고 수준은 `minimal`, `low`, `medium`, `high`입니다. `minimal`은 Inception의 `instant`에 대응하며, `off`는 추론을 완전히 끄는 대신 가장 낮은 노력을 요청합니다. Mercury는 추론을 스트리밍하지 않으므로 사고 텍스트가 나타나지 않으며, `high` 턴에서는 첫 출력까지 몇 분간 조용할 수 있습니다. OMP는 Mercury 3의 첫 청크를 최대 10분 기다립니다(`providers.streamFirstEventTimeoutSeconds`로 재정의). `/v1/models`가 Mercury 3를 $0로 보고하는 동안 OMP는 공개 출시 요금(백만 토큰당 입력 $0.10 / 출력 $0.35)을 사용하며, `/v1/models`가 보고하는 요금이 있으면 그것이 우선합니다.

SingularityAPI는 하나의 브랜드 아래 서로 무관한 두 제품을 판매하므로 OMP는 별도 제공자로 취급합니다. 키, 과금 모델, 노력 단계가 공유되지 않으며 서로의 호스트에서 상대 키를 허용하지 않습니다.

`singularityapi-dev`는 종량제 범용 추론 게이트웨이입니다(DeepSeek, Kimi, GLM, 최상위 플래그십 등 300개 이상 모델). `https://app.singularityapi.dev`에서 키를 생성하거나 `/login singularityapi-dev`를 실행하고 `SINGULARITYAPI_DEV_API_KEY`를 설정하세요. 목록, 제한, 요금은 `https://api.singularityapi.dev/v1/models`에서 실시간으로 탐색합니다.

`singularityapi-tech`는 예약형 DeepSeek 레인 게이트웨이입니다. 선불 크레딧이 아니라 예약한 슬롯에 사용량이 청구되므로, 활성 슬롯이 없으면 유효한 키도 `https://app.singularityapi.tech`에서 예약하기 전까지 403을 반환합니다. 해당 사이트에서 `sk-...` 키를 생성하거나 `/login singularityapi-tech`를 실행하고 `SINGULARITYAPI_TECH_API_KEY`를 설정하세요. 레인 목록은 `https://api.singularityapi.tech/v1/models`에서 실시간으로 탐색합니다.

`anthropic`, `openai-codex`, `github-copilot`, `cursor`, `muse-code`, `ollama-cloud`, `qwen-portal`, `kimi-code`, `xai-oauth`, `wafer-serverless`, `google-gemini-cli`, `google-antigravity`, `devin` 및 GitLab 제공자(`gitlab-duo`, `gitlab-duo-agent`)처럼 OAuth 기반인 제공자는 보통 환경 변수 대신 `/login`으로 접근합니다. 대화형 API 키 로그인도 있습니다. `/login baseten`, `/login coreweave`, `/login sakana`, `/login singularityapi-dev`, `/login singularityapi-tech`는 대시보드/API 키를 입력받습니다(`coreweave`에는 `OpenAI-Project` 헤더용 `COREWEAVE_PROJECT`도 필요). 여기에 없는 검색 도구 및 구성 변수는 [환경 변수](./environment-variables.md)를 참조하세요.

<a id="env-discovery-and-precedence"></a>
### `.env` 탐색과 우선순위

`omp`는 제공자를 조회하기 전에 네 개의 `.env` 파일을 프로세스 환경에 미리 불러옵니다. 각 변수는 **비어 있지 않은** 첫 소스가 우선합니다. 높은 순서부터 다음과 같습니다.

1. 프로세스 환경에 이미 있는 비어 있지 않은 값.
2. `<project>/.env`
3. 활성 에이전트 디렉터리의 `.env`(기본값: `~/.omp/agent/.env`).
4. 활성 구성 루트의 `.env`(기본값: `~/.omp/.env`).
5. `~/.env`

기존의 비어 있지 않은 프로세스 값은 덮어쓰지 않으며, 빈 값은 뒤의 파일에서 채울 수 있습니다. 비어 있지 않은 프로젝트 값은 에이전트, 구성 루트, 홈 파일보다 우선합니다. 이름 있는 프로필은 자체 구성 루트와 에이전트 디렉터리를 사용합니다. Bun이 이 로더 전에 프로젝트 dotenv 변형을 미리 불러올 수도 있으며, 이미 존재하는 값은 프로세스 값으로 취급합니다.

프로젝트 로컬 `.env`는 특정 저장소에 프로젝트 전용 게이트웨이, 키, 로컬 엔드포인트를 적용하는 가장 간단한 방법입니다.

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` 파일은 주석, 따옴표/여러 줄 값, `export` 접두사를 포함한 Node의 `parseEnv` 문법을 사용합니다. 파싱 후에는 다음을 적용합니다.

- 키는 `[A-Za-z_][A-Za-z0-9_]*`와 일치해야 하며 다른 이름은 버립니다.
- NUL 바이트가 포함된 값은 버립니다.
- `OMP_` 접두사 키는 대응하는 `PI_` 이름으로 복제하며 같은 파일의 `PI_` 항목을 덮어씁니다.

<a id="built-in-local-engines"></a>
## 내장 로컬 엔진

Ollama, llama.cpp, LM Studio는 `models.yml` 항목 없이 자동으로 탐색합니다. 각 기본 URL은 환경 변수로 재정의할 수 있습니다.

| 제공자 ID | 기본 URL(환경 재정의 → 기본값) | 참고 |
| --- | --- | --- |
| `ollama` | `OLLAMA_BASE_URL`, 다음 정규화된 `OLLAMA_HOST`, 아니면 `http://127.0.0.1:11434` | 기본적으로 키 불필요. |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, 아니면 `http://127.0.0.1:8080` | 인증을 구성하지 않으면 키 불필요. |
| `lm-studio` | `LM_STUDIO_BASE_URL`, 아니면 `http://127.0.0.1:1234/v1` | 기본적으로 키 불필요. |

암시적 Ollama와 llama.cpp 모델은 `openai-responses`를, LM Studio는 `openai-completions`를 사용합니다. macOS arm64에서는 `apple`도 프로세스 내 Apple Foundation Models 브리지(`local://apple-foundation-models`)를 확인합니다. 브리지가 모델 사용 가능 상태를 보고할 때만 `apple/on-device`를 제공합니다. 지원하지 않는 기기, 비활성화된 Apple Intelligence, 브리지 없는 빌드에서는 모델이 없습니다. 온디바이스 컨텍스트는 표준 프롬프트와 프로젝트 지침을 담기에 너무 작을 수 있으므로 OMP가 자동 선택하지 않습니다. `--model apple/on-device` 또는 `/model`로 명시적으로 선택하세요.

다음 경우에는 암시적 엔진을 **건너뜁니다**.

- 같은 ID의 제공자가 `models.yml`에 이미 구성되어 있음(명시적 구성 우선).
- 제공자 ID가 유효한 `disabledProviders` 목록에 있음.

엔진 설치 및 실행은 [로컬 모델](./local-models.md)을 참조하세요.

<a id="disabling-model-providers"></a>
## 모델 제공자 비활성화

`disabledProviders` 설정으로 제공자의 모델을 선택 대상에서 제거하세요.

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

제공자 ID는 정확히 일치해야 합니다. Google Gemini API 제공자를 숨기려면 `google`을 비활성화하세요. OAuth 기반 Google 제공자 `google-gemini-cli`와 `google-antigravity`는 별도 ID이므로 각각 비활성화해야 합니다. `ollama`, `llama.cpp`, `lm-studio`를 비활성화하면 해당 엔진의 로컬 탐색이 중지됩니다.

`disabledProviders`는 다음 모두에 동일하게 적용됩니다.

- 번들 카탈로그 제공자.
- 사용자 지정 `models.yml` 제공자.
- 런타임 탐색 제공자 모델.
- 확장 등록 제공자.
- 암시적 로컬 엔진.

제공자를 비활성화해도 저장된 자격 증명은 삭제되지 않습니다. 유효한 목록에서 ID를 제거하면 다시 활성화됩니다.

<a id="project-specific-provider-control"></a>
## 프로젝트별 제공자 제어

프로젝트 설정은 `<project>/.omp/config.yml`에 있습니다. 특정 저장소에서 전역 기본값과 다른 제공자 집합을 허용하거나 숨겨야 할 때 사용하세요.

```yaml
# <project>/.omp/config.yml
disabledProviders:
  - openai
  - openrouter
```

설정 배열은 높은 우선순위 계층의 값으로 통째로 **대체**되며 병합하거나 덧붙이지 않습니다. 전역 파일에서 세 제공자를 비활성화하고 프로젝트 파일에서 하나를 비활성화하면, 프로젝트에는 프로젝트 목록만 적용됩니다.

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - google

# <project>/.omp/config.yml
disabledProviders:
  - groq
```

프로젝트 내부의 최종 결과:

```json
["groq"]
```

프로젝트 배열은 해당 프로젝트에서 시작한 세션의 `anthropic`, `openai`, `google`을 다시 활성화합니다. 프로젝트에서 전역 집합에 _추가_하려면 전역 ID도 프로젝트 파일에 다시 적으세요. `--config` 오버레이와 런타임 재정의를 포함한 전체 우선순위는 [설정](./settings.md)을 참조하세요.

<a id="path-scoped-disabledproviders"></a>
## 경로 범위 `disabledProviders`

`disabledProviders`에는 일반 문자열 항목(모든 곳에 적용)과 경로 범위 항목(현재 작업 디렉터리가 구성된 경로와 일치할 때만 적용)을 섞을 수 있습니다.

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
  - paths:
      - ~/work/client-a
      - ~/work/client-b
    values:
      - openrouter
```

- 일반 문자열 항목은 항상 적용됩니다.
- 범위 항목은 현재 작업 디렉터리가 구성한 경로와 **같거나 그 아래**에 있을 때 적용됩니다. `~`는 홈 디렉터리로 확장됩니다.
- 허용되는 경로 키: `path`, `paths`, `pathPrefix`, `pathPrefixes`.
- 허용되는 값 키: `providers`, `values`, `items`.

위 예제에서는 다음과 같습니다.

- `ollama`는 모든 곳에서 비활성화됩니다.
- `~/projects/sensitive` 아래에서는 `anthropic`과 `openai`도 비활성화됩니다.
- `~/work/client-a`와 `~/work/client-b` 아래에서는 `openrouter`도 비활성화됩니다.

경로 범위는 설정 병합 **후에** 확인합니다. 높은 우선순위 계층이 배열 전체를 대체하므로 프로젝트 수준 `disabledProviders` 배열은 전역 배열에만 있는 범위 항목을 제거합니다. `enabledModels`와 `enabledProviders`도 이 형식을 지원합니다. 자세한 내용은 [설정](./settings.md)을 참조하세요.

<a id="provider-ids-vs-discovery-provider-ids"></a>
## 제공자 ID와 탐색 제공자 ID

`disabledProviders`는 서로 다른 두 하위 시스템을 제어하는 **하나의 공유 ID 네임스페이스**를 사용합니다.

- **모델 제공자** — 이 페이지의 백엔드(`anthropic`, `openai`, `ollama`, 사용자 지정 `models.yml` ID 등). 비활성화하면 해당 모델이 선택 대상에서 제거됩니다.
- **탐색 제공자** — 컨텍스트 파일, MCP 서버, 명령, 스킬, 훅, 도구, 프롬프트, 설정의 소스입니다. 비활성화하면 해당 소스가 기능 항목을 제공하지 않습니다.

| 항목 유형 | 예 | 효과 |
| --- | --- | --- |
| 모델 제공자 ID | `anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `my-gateway` | 해당 제공자의 모델을 사용 가능 목록에서 제거합니다. |
| 탐색 제공자 ID | `native`, `claude`, `codex`, `gemini`, `agents`, `github` | 해당 탐색 소스의 기능 항목 제공을 중지합니다. |

`enabledProviders`는 명시적으로 활성화하는 사용자 수준 외부 탐색 소스를 제어하며, 모델 제공자 허용 목록이 아닙니다. 프로젝트 수준 외부 소스는 별도의 탐색 동작을 따릅니다. 모델 선택을 제한하려면 모델 설정을 사용하세요.

비슷한 이름에 주의하세요. Google Gemini **API** 모델은 모델 제공자 ID `google`을 사용합니다. `gemini`는 Google 모델 제공자가 아니라 `GEMINI.md`를 읽는 **탐색** 제공자 ID입니다. 구성 소스 전체를 비활성화하려는 경우에만 탐색 ID를 사용하세요. 탐색 제공자 측 설명은 [컨텍스트 파일](./context-files.md)을 참조하세요.

<a id="custom-providers-in-modelsyml"></a>
## `models.yml`의 사용자 지정 제공자

사용자 지정 제공자는 `~/.omp/agent/models.yml`의 `providers:` 아래에 정의합니다. 여기에 정의한 제공자 ID는 내장 제공자와 동일한 선택, 자격 증명 확인, `disabledProviders` 규칙을 따릅니다.

최소 OpenAI 호환 제공자:

```yaml
providers:
  my-openai-compatible:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_OPENAI_COMPATIBLE_KEY # env-var-name or literal
    models:
      - id: fast-chat
        name: Fast Chat
        contextWindow: 128000
        maxTokens: 8192
```

<a id="zhipu-bigmodel-account-balance-keys"></a>
### Zhipu BigModel 계정 잔액 키

`/login zai`는 글로벌 Z.AI Coding Plan 엔드포인트를, `/login zhipu-coding-plan`은 중국 내 Zhipu Coding Plan 엔드포인트를 대상으로 합니다. 어느 흐름도 `https://open.bigmodel.cn/api/paas/v4`의 일반 종량제 BigModel 엔드포인트를 구성하지 않습니다.

표준 BigModel 계정 잔액에서 발급한 API 키에는 사용자 지정 제공자를 사용하세요.

```yaml
providers:
  bigmodel:
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    api: openai-completions
    apiKey: BIGMODEL_API_KEY
    models:
      - id: glm-4.6
        name: GLM-4.6 (BigModel)
```

`omp`를 시작하기 전에 `BIGMODEL_API_KEY`를 `<id>.<secret>` 키로 설정한 뒤 `bigmodel/glm-4.6`을 선택하세요. 이 키에는 `sk-` 접두사가 없습니다.

키 없는 로컬 제공자(자격 증명 불필요):

```yaml
providers:
  local-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        name: Local Model
        contextWindow: 32768
        maxTokens: 4096
```

탐색 활성 제공자(런타임에 엔드포인트에서 모델을 가져옴):

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true # send Authorization: Bearer <resolved key>
    disableStrictTools: true
    discovery:
      type: proxy
```

전체 스키마, 허용되는 모든 `api` 값, 탐색 `type`, 모델 재정의, 동등성 설정은 [모델 및 제공자 구성](./models.md)을 참조하세요.

사용자 지정 제공자를 비활성화하려면 ID를 정확히 나열하세요.

```yaml
disabledProviders:
  - my-openai-compatible
  - team-proxy
```

<a id="troubleshooting"></a>
## 문제 해결

**제공자의 모델을 선택할 수 없습니다.** 제공자에 자격 증명(`/login <provider>`, 내보낸 환경 변수, `models.yml`의 `apiKey`)이 있고 그 ID가 유효한 `disabledProviders` 목록에 없는지 확인하세요. 규칙은 비활성화되지 않음 **그리고** (키 불필요 **또는** 자격 증명 있음)입니다. 로컬 엔진은 초기 탐색 목록을 채울 때 응답해야 합니다. 이후 캐시된 카탈로그 항목은 표시될 수 있지만 추론에는 여전히 엔진이 필요합니다. Apple 사용 가능 여부는 프로세스 내 브리지로 확인합니다.

**잘못된 키가 사용됩니다(`.env`의 오래된 키).** 확인 우선순위는 런타임 `--api-key`, `models.yml` 구성 키, 저장된 OAuth, `/login`으로 저장한 키, 확장 구성 폴백, 환경 또는 `.env`, 그 밖의 저장된 API 키 순입니다. 비어 있지 않은 프로세스 환경 변수는 모든 `.env` 파일보다 우선하고, 비어 있지 않은 `<project>/.env` 값은 `~/.env`보다 우선합니다. 예상하지 않은 키가 선택되면 내보낸 셸 변수와 네 개의 `.env` 파일을 우선순위대로 살펴보고 적용되면 안 되는 값을 지우세요.

**비활성화한 제공자가 계속 표시됩니다.** `disabledProviders` 배열은 병합하지 않고 대체합니다. 프로젝트의 `<project>/.omp/config.yml` 배열은 전역 배열을 완전히 덮어씁니다. 현재 디렉터리의 _최종_ 목록을 확인하고(경로 범위 항목은 구성한 경로 및 하위에서만 적용) ID 철자가 정확한지 확인하세요. 병합된 값은 `omp config get disabledProviders`로 살펴볼 수 있습니다([설정](./settings.md) 참조).

**탐색 제공자 이름이 모델에 영향을 주지 않습니다(또는 그 반대).** ID 네임스페이스는 공유됩니다. `gemini`, `codex`, `claude`, `native`, `agents`는 탐색 소스 ID이며 Google 모델 백엔드는 `google`입니다. 올바른 종류의 제공자를 비활성화하는지 확인하세요.

**사용자 지정 `models.yml` 제공자가 로드되지 않습니다.** YAML 또는 스키마 오류가 있으면 레지스트리는 사용자 지정 파일을 건너뜁니다. `omp models`로 파일을 검증하세요(`omp models find <substr>`로 한 제공자로 범위 제한 가능). 사용자 지정 `models`가 있는 제공자에는 `baseUrl`, 인증(`auth: none` 또는 `auth: oauth`가 아니면 `apiKey`), 제공자 수준 또는 모든 모델의 `api`가 필요합니다. 모델이 없는 제공자도 지원되는 재정의(`baseUrl`, `headers`, `apiKey`, `auth: none`, `compat`, `disableStrictTools`, `guardrailIdentifier`, `requestMetadata`, `remoteCompaction`, `modelOverrides`, `discovery`)를 하나 이상 정의하면 유효합니다. 탐색 제공자는 `models`를 생략할 수 있지만, `discovery.type`이 `proxy`가 아니면 제공자 수준 `api`가 필요합니다. 명시적 `ollama`, `lm-studio`, `llama.cpp` 항목은 의도적으로 같은 ID의 내장 탐색을 대체합니다. [모델 및 제공자 구성](./models.md)을 참조하세요.
