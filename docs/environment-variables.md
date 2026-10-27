<a id="environment-variables-current-runtime-reference"></a>
# 환경 변수(현재 런타임 참조)

이 참조는 다음의 현재 코드 경로를 기반으로 합니다.

- `packages/coding-agent/src/**`
- `packages/ai/src/**`(coding-agent가 사용하는 제공자/인증 확인)
- 변수가 coding-agent 런타임에 직접 영향을 주는 `packages/utils/src/**`와 `packages/tui/src/**`

현재 활성 동작만 설명합니다.

<a id="resolution-model-and-precedence"></a>
## 확인 모델과 우선순위

대부분의 런타임 조회는 `@oh-my-pi/pi-utils`의 `$env`(`packages/utils/src/env.ts`)를 사용합니다.

`$env` 로드 순서:

1. 기존 프로세스 환경(`Bun.env`)
2. 현재 값이 비어 있거나 없는 키에 대해 시작 작업 디렉터리의 프로젝트 `.env`
3. 현재 값이 비어 있거나 없는 키에 대해 활성 에이전트 `.env`(보통 `~/.omp/agent/.env`)
4. 현재 값이 비어 있거나 없는 키에 대해 활성 구성 루트 `.env`(보통 `~/.omp/.env`)
5. 현재 값이 비어 있거나 없는 키에 대해 홈 `.env`(`~/.env`)

에이전트/루트 위치는 프로필, `PI_CONFIG_DIR`, 기본 프로필에만 적용되는 `PI_CODING_AGENT_DIR`을 따릅니다. dotenv 파일 전체를 Bun의 `node:util.parseEnv`로 파싱하며 따옴표로 감싼 여러 줄 값, 이스케이프한 줄바꿈, 인라인 주석을 지원합니다. 이름은 셸 식별자(`[A-Za-z_][A-Za-z0-9_]*`)여야 하며 안전하지 않은 이름/값은 버립니다. 이 파서는 변수 참조를 리터럴로 유지합니다. 이 모듈 실행 전 변수 확장은 Bun의 시작 디렉터리 dotenv 자동 로드에서만 수행합니다. 하위 셸 필터링도 같은 파서를 사용해 `.env`, `.env.<NODE_ENV>`(기본 `development`), `.env.local`, `.env.<NODE_ENV>.local`의 프로젝트 dotenv 값을 식별합니다. 실행기가 소유한 변수는 보존하면서 셸 하위 프로세스에서 프로젝트 dotenv 자격 증명을 제거합니다. Linux 원래 exec 환경을 신뢰할 수 있는 시작 스냅샷으로 사용하며 다른 환경에서는 가능한 한 값 일치로 판단합니다.

각 `.env` 파일의 추가 규칙: 모든 `OMP_*` 키는 `PI_*` 별칭으로 복제되며, 복제 값이 같은 파일의 `PI_*` 값을 대체합니다. 이는 파싱한 dotenv 파일에 적용하며 부모 프로세스에서 상속한 임의 변수에는 적용하지 않습니다.

설정 정의에 선언한 변수([설정 우선순위](./settings.md#precedence) 참조)는 별도 설명이 없으면 설정 타입에 따라 파싱합니다. 불리언 변수(`PI_PY`, `PI_JS`, `PI_INTENT_TRACING`, `PI_AUTO_QA`, `HINDSIGHT_AUTO_RECALL` 등)는 `parseFlag`를 따릅니다. 빈 값은 무시하여 설정을 적용하고, `1`, `y`, `true`, `yes`, `on`(전부 소문자 또는 전부 대문자)은 참, 그 밖의 비어 있지 않은 값은 거짓입니다.

---

<a id="1-modelprovider-authentication"></a>
## 1) 모델/제공자 인증

별도 설명이 없으면 `getEnvApiKey()`(`packages/ai/src/stream.ts`)에서 사용합니다.

일반 제공자 자격 증명 이름은 `packages/catalog/src/compat/rules/providers/*.kdl`과 `auth/*.kdl`의 `env` 항목에서 가져옵니다. `packages/ai/src/registry/hooks/env.ts`는 계산형 Foundry, Bedrock, Vertex 확인기를 제공합니다.

<a id="core-provider-credentials"></a>
### 주요 제공자 자격 증명

| 변수 | 용도 | 필요한 경우 | 참고 / 우선순위 |
| --- | --- | --- | --- |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic API 인증 | OAuth 토큰 인증으로 Anthropic 사용 | 제공자 인증 확인에서 `ANTHROPIC_API_KEY`보다 우선 |
| `ANTHROPIC_API_KEY` | Anthropic API 인증 | OAuth 토큰 없이 Anthropic 사용 | `ANTHROPIC_OAUTH_TOKEN` 다음 폴백 |
| `ANTHROPIC_FOUNDRY_API_KEY` | Azure Foundry / 기업 게이트웨이의 Anthropic | `CLAUDE_CODE_USE_FOUNDRY` 활성 | Foundry 모드에서 `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`보다 우선 |
| `OPENAI_API_KEY` | OpenAI 인증 | 명시적 apiKey 인수 없이 OpenAI 계열 제공자 사용 | OpenAI Completions/Responses 제공자에서 사용 |
| `OPENAI_CODEX_OAUTH_TOKEN` | OpenAI Codex 인증 | `openai-codex` 제공자 사용 | 환경에서 제공한 Codex OAuth 토큰 |
| `GEMINI_API_KEY` | Google Gemini 인증 | `google` 제공자 모델 사용 | Gemini 제공자 매핑의 기본 키 |
| `GOOGLE_API_KEY` | Gemini 이미지 도구 인증 폴백 | `GEMINI_API_KEY` 없이 `gemini_image` 사용 | coding-agent 이미지 도구 폴백 경로에서 사용 |
| `GROQ_API_KEY` | Groq 인증 | Groq 모델 사용 | |
| `CEREBRAS_API_KEY` | Cerebras 인증 | Cerebras 모델 사용 | |
| `FIREWORKS_API_KEY` | Fireworks 인증 | Fireworks 모델 사용 | |
| `FIREPASS_API_KEY` | Fire Pass 인증 | Fire Pass 모델 사용 | |
| `TOGETHER_API_KEY` | Together 인증 | `together` 제공자 사용 | |
| `ABLITERATION_API_KEY` / `ABLIT_KEY` | Abliteration 인증 | `abliteration` 제공자 사용 | `ABLITERATION_API_KEY` 우선 |
| `AIMLAPI_API_KEY` | AIML API 인증 | `aimlapi` 제공자 사용 | OpenAI 호환 AIML API 엔드포인트 `https://api.aimlapi.com/v1` |
| `HUGGINGFACE_HUB_TOKEN` | Hugging Face 인증 | `huggingface` 제공자 사용 | 기본 Hugging Face 토큰 환경 변수 |
| `HF_TOKEN` | Hugging Face 인증 | `huggingface` 제공자 사용 | `HUGGINGFACE_HUB_TOKEN` 미설정 시 폴백 |
| `SYNTHETIC_API_KEY` | Synthetic 인증 | Synthetic 모델 사용 | |
| `NVIDIA_API_KEY` | NVIDIA 인증 | `nvidia` 제공자 사용 | |
| `NANO_GPT_API_KEY` | NanoGPT 인증 | `nanogpt` 제공자 사용 | |
| `NOVITA_API_KEY` | Novita 인증 | `novita` 제공자 사용 | |
| `VENICE_API_KEY` | Venice 인증 | `venice` 제공자 사용 | |
| `LITELLM_API_KEY` | LiteLLM 인증 | `litellm` 제공자 사용 | OpenAI 호환 LiteLLM 프록시 키 |
| `LM_STUDIO_API_KEY` | LM Studio 인증(선택 사항) | 인증 호스트에서 `lm-studio` 사용 | 로컬 LM Studio는 보통 인증 없이 실행. 키가 필요하면 비어 있지 않은 모든 토큰 허용 |
| `OLLAMA_API_KEY` | Ollama 인증(선택 사항) | 인증 호스트에서 `ollama` 사용 | 로컬 Ollama는 보통 인증 없이 실행. 키가 필요하면 비어 있지 않은 모든 토큰 허용 |
| `LLAMA_CPP_API_KEY` | llama.cpp 인증(선택 사항) | 인증 호스트에서 `llama.cpp` 사용 | 로컬 llama.cpp는 보통 인증 없이 실행. 키가 구성되어 있으면 비어 있지 않은 모든 토큰 허용 |
| `XIAOMI_API_KEY` | Xiaomi MiMo 인증 | `xiaomi` 제공자 사용 | |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan 인증(AMS) | `xiaomi-token-plan-ams` 사용 | |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | Xiaomi MiMo Token Plan 인증(CN) | `xiaomi-token-plan-cn` 사용 | |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan 인증(SGP) | `xiaomi-token-plan-sgp` 사용 | |
| `MOONSHOT_API_KEY` | Moonshot 인증 | `moonshot` 제공자 사용 | `KIMI_API_KEY`를 폴백 별칭으로 허용 |
| `STEPFUN_API_KEY` | StepFun 인증 | `stepfun` 제공자 사용 | 키는 지역 범위. `.ai` 키는 `api.stepfun.ai`, `.com` 키는 `api.stepfun.com`에 사용 |
| `HELMCODE_API_KEY` | Helmcode 인증 | `helmcode` 제공자 사용 | |
| `XAI_API_KEY` | xAI 인증 | xAI 모델 사용 또는 `xai-oauth` 폴백 | |
| `XAI_OAUTH_TOKEN` | xAI OAuth/SuperGrok 인증 | `xai-oauth` 제공자 사용 | `xai-oauth`에서 `XAI_API_KEY`보다 우선 |
| `OPENROUTER_API_KEY` | OpenRouter 인증 | OpenRouter 모델 사용 | 선호/자동 제공자가 OpenRouter이면 이미지 도구도 사용 |
| `MISTRAL_API_KEY` | Mistral 인증 | Mistral 모델 사용 | |
| `ZAI_API_KEY` | z.ai 인증 | z.ai 모델 사용 | z.ai 웹 검색 제공자도 사용 |
| `ZHIPU_API_KEY` | Zhipu Coding Plan 인증 | `zhipu-coding-plan` 사용 | |
| `UMANS_AI_CODING_PLAN_API_KEY` | Umans AI Coding Plan 인증 | `umans` 제공자 사용 | |
| `MINIMAX_API_KEY` | MiniMax 인증 | `minimax` 제공자 사용 | |
| `MINIMAX_CODE_API_KEY` | MiniMax Code 인증 | `minimax-code` 제공자 사용 | |
| `MINIMAX_CODE_CN_API_KEY` | MiniMax Code CN 인증 | `minimax-code-cn` 사용 | |
| `OPENCODE_API_KEY` | OpenCode 인증 | `opencode-go` / `opencode-zen` 모델 사용 | |
| `QIANFAN_API_KEY` | Qianfan 인증 | `qianfan` 제공자 사용 | |
| `QWEN_OAUTH_TOKEN` | Qwen Portal 인증 | OAuth 토큰으로 `qwen-portal` 사용 | `QWEN_PORTAL_API_KEY`보다 우선 |
| `QWEN_PORTAL_API_KEY` | Qwen Portal 인증 | API 키로 `qwen-portal` 사용 | `QWEN_OAUTH_TOKEN` 다음 폴백 |
| `ZENMUX_API_KEY` | ZenMux 인증 | `zenmux` 제공자 사용 | ZenMux OpenAI 및 Anthropic 호환 경로에서 사용 |
| `COMMAND_CODE_API_KEY` | Command Code 인증 | `commandcode` 제공자 사용 | `COMMANDCODE_API_KEY`를 레거시 별칭으로 허용 |
| `CHARM_HYPER_API_KEY` | Charm Hyper 인증 | `charm-hyper` 제공자 사용 | `HYPER_API_KEY`를 폴백 별칭으로 허용 |
| `VLLM_API_KEY` | vLLM 인증/탐색 활성화 | `vllm` 제공자 사용(로컬 OpenAI 호환 서버) | 인증 없는 로컬 서버는 비어 있지 않은 모든 값 허용 |
| `CURSOR_ACCESS_TOKEN` | Cursor 제공자 인증 | Cursor 제공자 사용 | `CURSOR_API_KEY`를 별칭으로 허용 |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway 인증 | `vercel-ai-gateway` 사용 | `VERCEL_AI_GATEWAY_API_KEY`를 별칭으로 허용 |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway 인증 | `cloudflare-ai-gateway` 사용 | AI Gateway Run 권한의 게이트웨이 토큰. `/login`이 라우팅 ID와 함께 저장 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI 인증 | `cloudflare-workers-ai` 사용(Clef 판단 모델) | Workers AI Read 및 Edit 권한 API 토큰. `CLOUDFLARE_AUTH_TOKEN` 폴백 허용 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare AI Gateway / Workers AI 계정 라우팅 | 환경에서 게이트웨이 또는 Workers AI 토큰 제공 | `/login`으로 계정 ID를 저장했다면 불필요 |
| `CLOUDFLARE_GATEWAY_ID` | Cloudflare AI Gateway 선택 | 환경에서 게이트웨이 토큰 제공 | 보통 `default`인 게이트웨이 슬러그. `/login`으로 저장했다면 불필요 |
| `SNOWFLAKE_PAT` | Snowflake Cortex 인증 | `/login` 없이 `snowflake` 사용 | 프로그래밍 접근 토큰. 짧은 수명과 역할 제한 권장 |
| `SNOWFLAKE_ACCOUNT` | Snowflake Cortex 계정 라우팅 | `SNOWFLAKE_PAT` 사용 | 계정 식별자(`orgname-accountname`) 또는 계정 URL. `/login` 후 불필요 |
| `ALIBABA_CODING_PLAN_API_KEY` | Alibaba Coding Plan 인증 | `alibaba-coding-plan` 사용 | |
| `ALIBABA_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan 인증 | `alibaba-token-plan` 사용 | 선호하는 제공자 전용 이름 |
| `BAILIAN_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan 인증 | `alibaba-token-plan` 사용 | Qwen Code Token Plan 프리셋과 호환 |
| `CORAL_API_KEY` | CoralBricks 인증(별칭: `CORALBRICKS_API_KEY`) | `coralbricks` 사용 | |
| `DEEPINFRA_API_KEY` | DeepInfra 인증 | `deepinfra` 사용 | |
| `DEEPSEEK_API_KEY` | DeepSeek 인증 | DeepSeek 모델 사용 | |
| `SILICONFLOW_API_KEY` | SiliconFlow 인증 | `siliconflow` 사용 | |
| `SILICONFLOW_CN_API_KEY` | SiliconFlow(중국) 인증 | `siliconflow-cn` 사용 | |
| `KILO_API_KEY` | Kilo 인증 | Kilo 모델 사용 | |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud 인증 | `ollama-cloud` 사용 | |
| `CLINE_API_KEY` | ClinePass 구독 및 무료 등급 인증 | `cline-pass` 제공자 사용 | 공식 Cline API 키 변수 |
| `YOLO_AUTO_API_KEY` | Yolo-Auto 인증 | `yolo-auto` 사용 | 정액 Qwen 모델. `https://yolo-auto.com/v1/models`로 검증 |
| `WAFER_SERVERLESS_API_KEY` | Wafer Serverless 인증 | `wafer-serverless` 사용 | 종량제 Wafer SKU. `https://pass.wafer.ai/v1/models`로 검증 |
| `GITLAB_TOKEN` | GitLab Duo 인증 | `gitlab-duo` / `gitlab-duo-agent` 사용 | 두 GitLab 제공자가 같은 토큰 사용 |
| `BASETEN_API_KEY` | Baseten 인증 | `baseten` 사용 | 대화형 API 키 로그인(`/login baseten`, Baseten 대시보드 키)으로도 구성 |
| `COREWEAVE_API_KEY` / `WANDB_API_KEY` | CoreWeave Serverless Inference 인증 | `coreweave` 사용 | 둘 다 허용(W&B 폴백). 필수 `OpenAI-Project` 헤더는 `COREWEAVE_PROJECT`(폴백 `WANDB_INFERENCE_PROJECT`)로 제공 |
| `SAKANA_API_KEY` / `FUGU_API_KEY` | Sakana AI 인증 | `sakana` 사용 | 둘 다 허용. `SAKANA_BASE_URL` / `FUGU_BASE_URL`로 요청 기본 URL 재정의 |
| `SAMBANOVA_API_KEY` | SambaNova Cloud 인증 | `sambanova` 사용 | 대화형 API 키 로그인(`/login sambanova`)으로도 구성 |
| `DEVIN_API_KEY` | Devin 인증 | `devin` 사용 | 대화형 로그인(`/login devin`, OAuth)도 가능 |
| `AIAND_API_KEY` | ai& 인증 | `aiand` 사용 | |
| `GMI_API_KEY` | GMI Cloud 인증 | `gmi-cloud` 사용 | |
| `MODEL_API_KEY` / `META_API_KEY` | Meta Model API 인증 | `meta` 사용 | 둘 다 허용 |
| `INCEPTION_API_KEY` | Inception Mercury API 인증 | `inception` 사용 | `/login inception`도 가능. 1토큰 Mercury 3 요청으로 키 검증(`/v1/models`는 공개) |
| `SINGULARITYAPI_DEV_API_KEY` | SingularityAPI 범용 게이트웨이 인증 | `singularityapi-dev` 사용 | 종량제, 300개 이상 모델. `https://api.singularityapi.dev/v1/models`로 검증 |
| `SINGULARITYAPI_TECH_API_KEY` | SingularityAPI 예약 레인 인증 | `singularityapi-tech` 사용 | 슬롯 예약 DeepSeek 레인. `https://api.singularityapi.tech/v1/models`로 검증 |

<a id="githubcopilot-tokens"></a>
### GitHub/Copilot 토큰

| 변수 | 용도 | 참고 |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot 제공자 인증 | 일반 GitHub 토큰은 여기서 사용하지 않음 |
| `COPILOT_INTEGRATION_ID` | GitHub Copilot 클라이언트 ID 재정의 | 기본 `copilot-chat`(채팅 인터페이스). 거부 요청은 Copilot CLI로 한 번 재시도. 설정하면 클라이언트 ID를 고정하고 재시도 생략([#11372](https://github.com/can1357/oh-my-pi/issues/11372)) |
| `GH_TOKEN` | 웹 스크레이퍼 GitHub API 인증 | 스크레이퍼에서 `GITHUB_TOKEN` 다음 폴백 |
| `GITHUB_TOKEN` | 웹 스크레이퍼 GitHub API 인증 | 스크레이퍼가 `GH_TOKEN`보다 먼저 확인 |

<a id="auth-broker--auth-gateway-remote-credential-vault"></a>
### 인증 브로커 / 인증 게이트웨이(원격 자격 증명 보관소)

브로커를 켜면 로컬 SQLite 자격 증명 저장소를 우회하며 모든 OAuth 갱신/접근 토큰은 브로커 호스트에 있습니다. 전체 프로토콜, CLI 인터페이스, 5분/15초 사용량 캐시 계층은 [`auth-broker-gateway.md`](./auth-broker-gateway.md)를 참조하세요.

| 변수 | 용도 | 필요한 경우 | 참고 / 우선순위 |
| --- | --- | --- | --- |
| `OMP_AUTH_BROKER_URL` | 원격 인증 브로커 기본 URL(예: `https://broker.tailnet:8765`), 브로커 모드 선택 | 브로커로 자격 증명 확인. `omp auth-gateway serve`에도 필수(게이트웨이도 브로커 클라이언트) | `config.yml`의 `auth.broker.url`보다 우선. 설정되었는데 확인 가능한 토큰이 없으면 `resolveAuthBrokerConfig()`는 로컬 SQLite로 폴백하지 않고 오류 발생 |
| `OMP_AUTH_BROKER_TOKEN` | `/v1/healthz` 이외 모든 브로커 엔드포인트에 보내는 bearer 토큰 | `OMP_AUTH_BROKER_URL`이 설정되고 `auth.broker.token` 또는 `<config-dir>/auth-broker.token`의 토큰이 없음 | 확인 순서: 이 환경 변수 → `auth.broker.token`(`$ENV_NAME` 간접 참조 지원) → `<config-dir>/auth-broker.token`(모드 `0600`). `<config-dir>`은 `PI_CONFIG_DIR`을 따르는 `~/.omp/` |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | 암호화 로컬 브로커 스냅샷 캐시의 최신성 기간 | 브로커 모드에서 선택 사항 | 기본 `3600000`(1시간). 최신성은 브로커 `snapshot.generatedAt` 기준. `0`이면 캐시 읽기/쓰기를 끄고 시작마다 이전의 차단 가져오기 강제 |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | 암호화 로컬 브로커 스냅샷 캐시 경로 | 브로커 모드에서 선택 사항 | 기본 `~/.omp/cache/auth-broker-snapshot.enc` 또는 대응 XDG 캐시. 테스트, 임시 호스트, `0600` 캐시 파일 이동에 유용 |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 브로커 클라이언트의 프로세스 범위 자격 증명 가시성(OAuth 계정 및 API 키) | 브로커 모드에서 선택 사항 | 제공자 ID를 규칙에 매핑하는 JSON 객체 경로. `identityKey` 배열(`[]`는 OAuth 계정을 숨기지만 API 키는 유지), `true`/`false`(전체/없음), `{ "accounts"?: [...], "apiKeys"?: boolean }` 허용. 항목 없는 제공자는 `"*"` 규칙을 따르고, 그것도 없으면 무제한. `"*": false`이면 허용 목록. 시작 시 한 번 파싱하며 잘못된 입력은 안전하게 차단. 브로커 권한 부여는 아니며 직접 클라이언트는 여전히 브로커 토큰을 보유. `omp auth-gateway serve` 안에서는 게이트웨이 클라이언트의 접근 범위를 제한([auth-broker-gateway.md](./auth-broker-gateway.md#client-account-pools) 참조) |

게이트웨이에 전용 환경 변수는 없으며 `OMP_AUTH_BROKER_*`를 상속합니다. 자체 수신 bearer 토큰은 `<config-dir>/auth-gateway.token`에 있고 `omp auth-gateway token`으로 관리합니다.

---

<a id="2-provider-specific-runtime-configuration"></a>
## 2) 제공자별 런타임 구성

<a id="outbound-proxy-routing"></a>
### 아웃바운드 프록시 라우팅

제공자 HTTP fetch는 `NO_PROXY` / `no_proxy` 적용 후 다음 순서로 프록시를 확인합니다.

1. `PI_PROXY_<PROVIDER>`(제공자 ID를 대문자로, 영숫자 이외 문자를 `_`로 변환. 예: `PI_PROXY_GITHUB_COPILOT`)
2. `PI_PROXY`
3. HTTPS와 WebSocket 대상에는 `HTTPS_PROXY` / `https_proxy`, HTTP에는 `HTTP_PROXY` / `http_proxy`
4. `ALL_PROXY` / `all_proxy`

제공자 프록시 조회는 프로세스 수명 동안 캐시합니다. Localhost 대상은 제공자 fetch 래퍼를 우회합니다.

두 `PI_PROXY` 형식은 범위가 다릅니다.

- `PI_PROXY`는 CLI 시작 시 프로세스 전체 `fetch`에 설치되므로 제공자 fetch 래퍼 밖의 OAuth 토큰 갱신/로그인, 사용량 확인, 모델 탐색에도 적용됩니다. 그렇지 않으면 스트림 자체는 프록시를 사용해도 지역 차단 토큰 엔드포인트는 갱신 시 `403 Request not allowed`를 반환합니다.
- `PI_PROXY_<PROVIDER>`는 해당 제공자 요청에만 적용되고 그 요청의 `PI_PROXY`보다 우선합니다. 위의 비제공자 범위 호출에는 적용되지 않으므로 제공자가 지역을 차단하면 `PI_PROXY`도 설정하세요.

루프백, 링크 로컬, 사설 범위(`10/8`, `172.16/12`, `192.168/16`), `NO_PROXY` 대상은 항상 우회하므로 로컬 모델 서버와 MCP 호스트는 직접 연결을 유지합니다.

<a id="request-body-compression"></a>
### 요청 본문 압축

`request-encodings` / `endpoint-hosts` 카탈로그 규칙에 선언된, 압축 해제가 가능한 제공자 자체 엔드포인트에는 1 KiB 이상 요청 본문을 압축해 보냅니다. 공식 Anthropic API는 gzip, ChatGPT Codex 백엔드는 zstd, `api[.individual|.business|.enterprise].githubcopilot.com`의 GitHub Copilot API는 zstd(실패 시 gzip)입니다. 프록시, 릴레이, models.yml 게이트웨이(내장 제공자 ID여도), 그 밖의 모든 호스트에는 비압축 JSON을 보냅니다. 엔드포인트 또는 앞단 TLS 검사 프록시가 인코딩을 거부하고 비압축 재전송이 성공하면 남은 프로세스 수명 동안 해당 호스트의 그 인코딩을 끕니다.

| 변수 | 동작 |
| --- | --- |
| `PI_REQUEST_COMPRESSION` | `0`/`false`/`no`/`off`이면 모든 요청 본문을 비압축 전송(기본 활성) |

<a id="anthropic-api-version"></a>
### Anthropic API 버전

| 변수 | 동작 |
| --- | --- |
| `PI_ANTHROPIC_API_VERSION` | 공식 Anthropic API(`api.anthropic.com`)에 보내는 `anthropic-version`: `2023-06-01`(기본값) 또는 `2026-10-21`. `2026-10-21`은 `temperature`/`top_p`/`top_k`를 거부하므로 생략합니다. 다른 호스트(Bedrock, Foundry, Copilot, 게이트웨이, Anthropic 호환 제공자)는 `2023-06-01`을 유지합니다. 알 수 없는 값은 경고를 기록하고 `2023-06-01`을 사용합니다. |

<a id="anthropic-foundry-gateway-azure--enterprise-proxy"></a>
### Anthropic Foundry Gateway(Azure / 기업 프록시)

`CLAUDE_CODE_USE_FOUNDRY`를 켜면 Anthropic 요청은 Foundry 모드로 전환합니다.

- 기본 URL은 `FOUNDRY_BASE_URL`에서 확인합니다(미설정 시 모델/기본 URL 유지).
- `anthropic` 제공자의 API 키 확인 순서는 `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`가 됩니다.
- `ANTHROPIC_CUSTOM_HEADERS`는 쉼표/줄바꿈으로 구분한 `key: value` 쌍으로 파싱해 요청 헤더에 병합합니다. `ANTHROPIC_BASE_URL`이 기업 API 게이트웨이처럼 Anthropic 이외 호스트를 가리킬 때도 전달하므로, 전용 인증 헤더가 필요한 기업 게이트웨이를 Foundry 모드 없이 사용할 수 있습니다.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`(Claude Code와 같은 계약)는 `anthropic` 요청에서 출시 전 본문 필드와 대응 `anthropic-beta` 토큰을 생략합니다. 대상은 `context_management`, 베타 도구 필드(`strict`, `defer_loading`, `eager_input_streaming`), 대화 중 도구 변경, `output_config.format`, `output_config.task_budget`, `thinking.block_binding`, Anthropic 서버 압축입니다. 노력, 적응형 사고, 교차 사고, 확장 컨텍스트는 유지합니다. Claude Code와 달리 호출자가 제공한 베타 및 `anthropic-beta` 헤더에서도 대응 베타를 제거합니다. `ANTHROPIC_BASE_URL` 게이트웨이가 이를 거부할 때 사용하며 Foundry 모드와 무관하게 작동합니다. 적용 제공자는 `honors-claude-code-beta-kill-switch` 호환성 축(`models.yml`의 `compat.honorsClaudeCodeBetaKillSwitch`)으로 정합니다.
- TLS 클라이언트/서버 자료는 `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` 환경 값으로 삽입할 수 있습니다. 각각 다음을 허용합니다.
  - PEM 콘텐츠의 파일 시스템 경로
  - 인라인 PEM(이스케이프한 `\n` 포함)

  `NODE_EXTRA_CA_CERTS`는 Foundry뿐 아니라 모든 제공자 fetch(OpenAI 호환, Codex, Ollama, Azure Responses, Google, Anthropic)에 적용합니다. Bun `fetch`가 이를 기본 소비하지 않으므로 시스템 루트 저장소와 함께 `RequestInit.tls.ca`에 번들을 병합합니다. `CLAUDE_CODE_*` mTLS 자료는 Anthropic Foundry 전용으로 유지됩니다.

| 변수 | 값 타입 | 동작 |
| --- | --- | --- |
| `CLAUDE_CODE_USE_FOUNDRY` | 불리언 유사 문자열(`1`, `true`, `yes`, `on`) | Anthropic 제공자의 Foundry 모드 활성화 |
| `FOUNDRY_BASE_URL` | URL 문자열 | Foundry 모드의 Anthropic 엔드포인트 기본 URL |
| `ANTHROPIC_FOUNDRY_API_KEY` | 토큰 문자열 | `Authorization: Bearer <token>`에 사용 |
| `ANTHROPIC_CUSTOM_HEADERS` | 헤더 목록 문자열 | `header-a: value, header-b: value` 또는 줄바꿈 구분 추가 헤더. Foundry 밖에서도 `ANTHROPIC_BASE_URL`이 Anthropic 이외 호스트면 전달 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 불리언 유사 문자열(`1`, `true`, `yes`, `on`) | `anthropic` 제공자의 출시 전 필드(`context_management`, 베타 도구 필드, 작업 예산, 구조화 출력 형식, `thinking.block_binding`, 서버 압축)와 베타 헤더 생략 |
| `NODE_EXTRA_CA_CERTS` | PEM 경로 또는 인라인 PEM | 서버 인증서 검증용 추가 CA 체인 |
| `CLAUDE_CODE_CLIENT_CERT` | PEM 경로 또는 인라인 PEM | mTLS 클라이언트 인증서 |
| `CLAUDE_CODE_CLIENT_KEY` | PEM 경로 또는 인라인 PEM | mTLS 클라이언트 개인 키(인증서와 짝 필요) |

<a id="amazon-bedrock"></a>
### Amazon Bedrock

| 변수 | 기본값 / 동작 |
| --- | --- |
| `AWS_REGION` | 기본 지역 소스 |
| `AWS_DEFAULT_REGION` | `AWS_REGION` 미설정 시 폴백 |
| `AWS_PROFILE` | 이름 있는 프로필 인증 경로 활성화 |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | IAM 키 인증 경로 활성화 |
| `AWS_BEARER_TOKEN_BEDROCK` | 최우선 bearer 토큰 인증 경로. 설정 시 AWS 프로필/자격 증명 체인 조회 생략 |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | 제공자 감지에서 Bedrock을 사용 가능으로 표시(실제 자격 증명 확인은 환경 키, 프로필/SSO/`credential_process`, IMDSv2 순) |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` | 제공자 감지에서 Bedrock을 사용 가능으로 표시(위 ECS 변수와 같은 주의 사항) |
| `AWS_BEDROCK_SKIP_AUTH` | Converse에 더미 자격 증명을 삽입하는 불리언 플래그(프록시/무인증). 빈 값은 false로 위임 |
| `HTTPS_PROXY` / `HTTP_PROXY` | Bun 기본 fetch 프록시 지원으로 적용(이제 제공자는 AWS SDK / proxy-agent 전송을 제공하지 않음) |
| `NO_PROXY` | 일치 호스트를 Bun 기본 프록시 라우팅에서 제외 |

제공자 코드의 지역 폴백: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

`bedrock-mantle`도 `packages/ai/src/registry/aws.ts`로 bearer 토큰과 AWS 자격 증명 소스를 감지합니다. `AWS_BEDROCK_SKIP_AUTH`는 Mantle이 아니라 Converse 제공자 확인기에만 적용됩니다.

기본 Bedrock 확인기가 구현한 추가 자격 증명 체인 제어:

| 변수 | 동작 |
| --- | --- |
| `AWS_SESSION_TOKEN` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`와 짝을 이루는 세션 토큰 |
| `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` | 공유 자격 증명/구성 INI 경로 재정의 |
| `AWS_SDK_LOAD_CONFIG` | `1`/`true`이면 명시적 프로필 없이 공유 구성 로드 활성화 |
| `AWS_ROLE_SESSION_NAME` | 웹 ID 역할 수임용 세션 이름 |
| `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | ECS 컨테이너 자격 증명 인증 |
| `AWS_EC2_METADATA_DISABLED` | `true`이면 IMDSv2 비활성화 |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` | IMDS 엔드포인트 재정의 / IPv6 폴백 선택 |

<a id="azure-openai-responses"></a>
### Azure OpenAI Responses

| 변수 | 기본값 / 동작 |
| --- | --- |
| `AZURE_OPENAI_API_KEY` | 옵션으로 API 키를 전달하지 않으면 필수 |
| `AZURE_OPENAI_API_VERSION` | 기본 `v1` |
| `AZURE_OPENAI_BASE_URL` | 직접 기본 URL 재정의 |
| `AZURE_OPENAI_RESOURCE_NAME` | `https://<resource>.openai.azure.com/openai/v1` 기본 URL 구성에 사용 |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | 선택적 매핑 문자열: `modelId=deploymentName,model2=deployment2` |

기본 URL 확인: 옵션 `azureBaseUrl` → 환경 `AZURE_OPENAI_BASE_URL` → 옵션/환경 리소스 이름 → `model.baseUrl`.

<a id="google-vertex-ai"></a>
### Google Vertex AI

| 변수 | 필수 여부 | 참고 |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | 옵션에 없으면 필수 | 기본 프로젝트 ID 소스 |
| `GCP_PROJECT` | 폴백 | 대체 프로젝트 ID 소스 |
| `GCLOUD_PROJECT` | 폴백 | 대체 프로젝트 ID 소스 |
| `GOOGLE_CLOUD_PROJECT_ID` | OAuth 로그인 도우미 전용 | Gemini CLI OAuth 프로젝트 탐색에 사용 |
| `GOOGLE_VERTEX_LOCATION` | 옵션에 없으면 필수 | 기본 Vertex 위치 소스 |
| `GOOGLE_CLOUD_LOCATION` | 폴백 | 대체 Vertex 위치 소스 |
| `VERTEX_LOCATION` | 폴백 | 대체 Vertex 위치 소스 |
| `GOOGLE_CLOUD_API_KEY` | 조건부 | 직접 Vertex API 키 인증. 없으면 프로젝트와 위치가 설정된 경우 ADC 폴백 인증 가능 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 조건부 | 설정 시 파일이 있어야 함. 없으면 ADC 폴백 경로(`~/.config/gcloud/application_default_credentials.json`) 확인 |

`GOOGLE_CLOUD_ACCESS_TOKEN` 또는 호환 폴백 `CLOUDSDK_AUTH_ACCESS_TOKEN`은 명시적 Google OAuth 접근 토큰을 제공하며 ADC 토큰 획득을 우회합니다.

<a id="kimi"></a>
### Kimi

| 변수 | 기본값 / 동작 |
| --- | --- |
| `KIMI_CODE_OAUTH_HOST` | 기본 OAuth 호스트 재정의 |
| `KIMI_OAUTH_HOST` | 폴백 OAuth 호스트 재정의 |
| `KIMI_CODE_BASE_URL` | Kimi 사용량 엔드포인트 기본 URL 재정의(`usage/kimi.ts`) |

OAuth 호스트 체인: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

<a id="openai-compatible-endpoint-controls"></a>
### OpenAI 호환 엔드포인트 제어

| 변수 | 기본값 / 동작 |
| --- | --- |
| `OPENAI_BASE_URL` | 모델/제공자가 기본값을 제공할 때 OpenAI 호환 요청의 기본 URL 폴백 |
| `MOONSHOT_BASE_URL` | Moonshot 채팅 및 모델 탐색 엔드포인트 재정의 |
| `XAI_BASE_URL` | `xai`/`xai-oauth` 채팅, 이미지 생성, 웹 검색의 xAI 엔드포인트 재정의. 모델이 번들 `https://api.x.ai/v1`을 사용할 때만 적용하므로 models.yml `baseUrl` 우선. `xai-oauth` OAuth 자격 증명은 절대 전달하지 않음 |
| `SAKANA_BASE_URL` / `FUGU_BASE_URL` | Sakana/Fugu 엔드포인트 재정의(`SAKANA_BASE_URL` 우선) |
| `PI_OPENROUTER_RESPONSES` | `0`이 아니면 Responses API 활성. `0`은 OpenAI Completions 경로 선택 |
| `UMANS_WEBSEARCH_PROVIDER` | 명시적 지정이 없을 때 Umans Anthropic 웹 검색 제공자 기본 선택 |

<a id="gemini-cli-and-antigravity-compatibility"></a>
### Gemini CLI와 Antigravity 호환성

| 변수 | 기본값 / 동작 |
| --- | --- |
| `PI_AI_GEMINI_CLI_VERSION` | Gemini CLI user-agent 버전 태그 재정의(미설정 시 `0.46.0`) |
| `PI_AI_ANTIGRAVITY_VERSION` | 자동 탐색한 Antigravity 허브 user-agent 버전 재정의. 미설정 및 탐색 실패 시 `2.26.0` 폴백 |
| `PI_AI_ANTIGRAVITY_CL` | Antigravity 허브 user-agent 빌드 변경 목록 재정의(미설정 시 `1005016104`) |
| `PI_AI_ANTIGRAVITY_OS` | Antigravity 허브 user-agent os_type 재정의(미설정 시 호스트 OS의 기본 빌드인 `darwin`, `linux`, `windows`. 다른 OS는 `linux`) |
| `PI_AI_ANTIGRAVITY_ARCH` | Antigravity 허브 user-agent arch 재정의(미설정 시 해당 빌드의 아키텍처. macOS는 `arm64`, Linux와 Windows는 `amd64`) |

<a id="gitlab-duo"></a>
### GitLab Duo

| 변수 | 기본값 / 동작 |
| --- | --- |
| `GITLAB_CLIENT_ID` | OAuth 클라이언트 ID. 미설정 시 번들 GitLab OAuth 앱 클라이언트 ID 사용 |
| `GITLAB_REDIRECT_URI` | GitLab에 알릴 정확한 OAuth 리디렉션 URI. 미설정 시 로컬 콜백은 `http://localhost:8080/callback`, 임의 포트 폴백 사용. HTTP/HTTPS 필수. 루프백 콜백은 HTTP와 URI 호스트/포트 바인딩 필수 |
| `GITLAB_DUO_NAMESPACE_ID` | Workflow 네임스페이스 재정의. 런타임 옵션 우선. 없으면 현재 자격 증명과 작업 디렉터리로 네임스페이스/프로젝트 탐색 |
| `GITLAB_DUO_PROJECT_ID` | ID로 Workflow 프로젝트 재정의. 런타임 `projectId`, 런타임 `projectPath` 순으로 우선. 이 변수는 `GITLAB_DUO_PROJECT_PATH`보다 우선 |
| `GITLAB_DUO_PROJECT_PATH` | 런타임 프로젝트 또는 `GITLAB_DUO_PROJECT_ID`가 없을 때 경로로 Workflow 프로젝트 재정의 |
| `GITLAB_DUO_WORKFLOW_DEFINITION` | Workflow 정의 재정의. 런타임 `workflowDefinition` 우선. 기본 `ambient` |
| `GITLAB_DUO_WORKFLOW_TRACE` | 정확히 `1`일 때만 Workflow 추적 활성. 추적 이벤트를 행당 JSON 객체 하나로 추가하며 쓰기 실패 무시 |
| `GITLAB_DUO_WORKFLOW_TRACE_FILE` | 추적 출력 경로. 앞뒤 공백 제거 후 미설정/빈 값이면 제공자 모듈 기준 `../../../../.tmp/gitlab-duo-workflow-trace.log`의 절대 경로 사용(소스 체크아웃에서는 `<repo>/.tmp/gitlab-duo-workflow-trace.log`). 없는 부모 디렉터리는 자동 생성 |

`GITLAB_CLIENT_ID`와 `GITLAB_REDIRECT_URI`는 OAuth 로그인에 영향을 줍니다.
네 가지 라우팅/생성 재정의(`GITLAB_DUO_NAMESPACE_ID`, `GITLAB_DUO_PROJECT_ID`,
`GITLAB_DUO_PROJECT_PATH`, `GITLAB_DUO_WORKFLOW_DEFINITION`)는 `gitlab-duo-agent` Workflow
네임스페이스/프로젝트 확인 또는 워크플로 생성에 영향을 주며 OAuth를 구성하지 않습니다.
추적 변수 두 개는 로컬 진단 출력에만 영향을 줍니다.
루프백이 아닌 리디렉션 URI는 로컬 콜백 리스너가 직접 처리할 수 없으므로 코드 붙여넣기 경로로 완료합니다.

<a id="openai-codex-responses-featuredebug-controls"></a>
### OpenAI Codex responses(기능/디버그 제어)

| 변수 | 동작 |
| --- | --- |
| `PI_CODEX_DEBUG` | `1`/`true`이면 Codex 제공자 디버그 로그 활성 |
| `PI_CODEX_WEBSOCKET` | `1`/`true`이면 WebSocket 전송 선호 활성 |
| `PI_CODEX_RESPONSES_LITE` | `1`/`true`이면 일반 추론에 Responses Lite 사용. `0`/`false`는 표준 Responses 본문 강제. 미설정 시 일반 추론은 전체 Responses |
| `PI_OPENAI_STATEFUL` | 플랫폼 OpenAI Responses API의 상태 유지 연결 기본값 재정의(`previous_response_id`, `store: true` 강제). 기본은 api.openai.com에서 켬, 나머지는 끔 |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` | 양의 정수 재정의(기본 `300000`) |
| `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` | 첫 이벤트 제한 시간 재정의(기본 `300000`) |
| `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS` | Ping 간격 재정의(기본 `10000`) |
| `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS` | Pong 제한 시간 재정의(기본 `60000`) |
| `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` | 버퍼 메시지 용량 재정의(기본 `4096`) |
| `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` | 연결 재사용이 중지되는 최대 유휴 시간(기본 `30000`). `0`은 유휴 경과 제한 해제 |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET` | 음이 아닌 정수 재정의(기본 `5`) |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS` | 양의 정수 기본 백오프 재정의(기본 `500`) |
| `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` | 일반 스트림 첫 이벤트 제한 시간. `0`은 해제 |
| `PI_STREAM_IDLE_TIMEOUT_MS` | 일반 스트림 유휴 제한 시간. `0`은 해제 |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` | OpenAI 전용 첫 이벤트 제한 시간 재정의. `0`은 해제이며 일반 값보다 우선. 영구 설정은 `omp config set providers.streamFirstEventTimeoutSeconds <seconds>` |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` | OpenAI 전용 유휴 제한 시간 재정의. `0`은 해제이며 일반 값보다 우선. 영구 설정은 `omp config set providers.streamIdleTimeoutSeconds <seconds>` |

<a id="cursor-provider-debug"></a>
### Cursor 제공자 디버그

| 변수 | 동작 |
| --- | --- |
| `DEBUG_CURSOR` | 제공자 디버그 로그 활성. `2`/`verbose`이면 자세한 페이로드 일부 표시 |
| `DEBUG_CURSOR_LOG` | JSONL 디버그 로그 출력의 선택적 파일 경로 |

<a id="prompt-cache-compatibility-switch"></a>
### 프롬프트 캐시 호환성 스위치

| 변수 | 동작 |
| --- | --- |
| `PI_CACHE_RETENTION` | 지원되는 경우 캐시 보존 재정의(`anthropic`, `openai-responses`, Bedrock). `long`, `short`, `none` 허용, 다른 값 무시 |

---

<a id="3-web-search-subsystem"></a>
## 3) 웹 검색 하위 시스템

<a id="search-provider-credentials"></a>
### 검색 제공자 자격 증명

| 변수 | 사용처 |
| --- | --- |
| `EXA_API_KEY` | Exa 검색/MCP. `/login exa`도 가능 |
| `TINYFISH_API_KEY` | TinyFish 검색 제공자(필수) |
| `BRAVE_API_KEY` | Brave 검색 제공자 |
| `DEEPSEEK_API_KEY` | DeepSeek 검색 제공자(DeepSeek 모델과 같은 키) |
| `PERPLEXITY_API_KEY` | Perplexity 검색 제공자 API 키 모드 |
| `PERPLEXITY_COOKIES` | Perplexity 쿠키 인증 검색 모드 |
| `PI_PERPLEXITY_RESPONSES` | `1`이면 Chat Completions 대신 Perplexity Responses 엔드포인트 선택 |
| `PI_PERPLEXITY_MODEL` | Perplexity 개인 구독 모델 선호(기본 `experimental`) |
| `PI_PERPLEXITY_API_MODEL` | Perplexity 직접 API 모델 재정의(기본 `sonar-pro`) |
| `FIRECRAWL_API_KEY` | Firecrawl 검색 제공자(미설정 시 키 없는 폴백) 및 fetch 읽기 백엔드(필수) |
| `FIRECRAWL_BASE_URL` | Firecrawl API 엔드포인트 재정의(`FIRECRAWL_API_URL`은 폴백 별칭) |
| `TAVILY_API_KEY` | Tavily 검색 제공자 |
| `ZAI_API_KEY` | z.ai 검색 제공자(`agent.db` 저장 OAuth도 확인) |
| `OPENAI_API_KEY` / DB의 Codex OAuth | Codex 검색 모델 사용 가능 여부/인증 |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY` | Kimi/Moonshot 검색 제공자 환경 인증 |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot 검색 엔드포인트 재정의 |
| `KAGI_API_KEY` | Kagi 검색 제공자 |
| `JINA_API_KEY` | Jina 검색 제공자 |
| `PARALLEL_API_KEY` | Parallel 검색 제공자 |
| `OLLAMA_CLOUD_API_KEY` | Ollama 웹 검색 제공자 |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN` | SearXNG 엔드포인트 및 선택적 bearer 토큰. `searxng.endpoint` / `searxng.token`이 미설정, `null`, 빈 값일 때 폴백 |
| `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD` | SearXNG HTTP Basic Auth 자격 증명. 대응 `searxng.basic*` 설정이 미설정 또는 `null`일 때만 폴백(빈 문자열도 유효 자격 증명) |

DuckDuckGo 검색은 키가 필요 없습니다. JavaScript 없는 HTML 프런트엔드(`html.duckduckgo.com`)를 조회하므로 자격 증명이 필요 없으며 startpage, google, ecosia, mojeek과 함께 자격 증명 없는 `public` 통합 검색에도 공급합니다.

SearXNG는 `~/.omp/agent/config.yml`의 대응 설정 `searxng.endpoint`, `searxng.token`, `searxng.basicUsername`, `searxng.basicPassword`도 읽으며 환경 변수는 폴백입니다.

<a id="anthropic-web-search-authentication"></a>
### Anthropic 웹 검색 인증

Anthropic 카탈로그 모델의 `searchAnthropic()`은 다음 순서로 자격 증명을 사용합니다.

1. `ANTHROPIC_SEARCH_API_KEY`
2. 선택한 모델/제공자의 모델 레지스트리 자격 증명 확인기. 구성한 런타임 자격 증명, 저장 OAuth 또는 API 키 로그인, 제공자의 일반 환경 폴백 포함

`ANTHROPIC_SEARCH_API_KEY`는 검색 전용 인증 소스이며 채팅 자격 증명을 바꾸지 않습니다. 선택 카탈로그 모델이 모델 ID와 엔드포인트를 제공하므로 별도 Anthropic 검색 모델/기본 URL 환경 재정의는 없습니다.

| 변수 | 기본값 / 동작 |
| --- | --- |
| `ANTHROPIC_SEARCH_API_KEY` | Anthropic 웹 검색 요청 전용 API 키. 선택 모델의 일반 자격 증명 확인기보다 먼저 시도하며 채팅 완성에 영향 없음 |

<a id="perplexity-oauth-flow-behavior-flag"></a>
### Perplexity OAuth 흐름 동작 플래그

| 변수 | 동작 |
| --- | --- |
| `PI_AUTH_NO_BORROW` | 설정 시 Perplexity 로그인 흐름의 macOS 기본 앱 토큰 빌리기 경로 비활성화 |

<a id="typesafe-judgments"></a>
### TypeSafe 판단

앱이 자체 상태에 대해 내리는 작은 타입 지정 결정(`auto` 사고 수준 난이도 분류, Smart 예기치 않은 중단 감지, git TUI AI 스테이징, `judge()` eval 도우미)은 `judge` 모델 역할을 사용합니다. TypeSafe 자격 증명이 있으면 카탈로그는 `GET /v1/models`에서 계정에 보이는 판단 모델을 탐색합니다. 알려진 경우 `jev-latest`, `jev-preview`를 포함하고 별칭 전용 목록에서 누락한 초기 `jev-1.14.0`도 유지하며 역할은 정확한 카탈로그 모델을 선택합니다. 내장 판단 체인은 `typesafe/jev-1.14.0`, `openrouter/typesafe/jev-1.14`, `tiny`, `smol`, `default`, 활성 세션 모델 순입니다. 체인이 기본 System One 모델(직접 TypeSafe 또는 OpenRouter)에 도달하면 다른 기본 모델로만 폴백합니다. 모든 기본 판단 모델이 실패하면 프롬프트 채팅/온디바이스 모델로 낮추지 않고 판단을 실패시킵니다. 실패 후보마다 `judgment candidate failed`로 기록합니다. `typesafe/jev-preview`나 다른 후보를 선택하려면 `modelRoles.judge` 또는 `retry.fallbackChains.judge`를 구성하세요.

| 변수 | 기본값 / 동작 |
| --- | --- |
| `TYPESAFE_API_KEY` | 탐색 및 System One 요청용 TypeSafe API 키. `/login typesafe`도 가능 |
| `TYPESAFE_BASE_URL` | API 루트 재정의(기본 `https://api.typesafe.ai`). 모델 탐색, `/login` 검증, System One 요청에 사용 |
| `OPENAI_API_KEY` | OpenAI Decisions 판단 모델 `openai/gpt-6-luna-decisions`(`POST /v1/decisions`의 GPT-6 Luna)도 인증. 사용하려면 `judge` 역할에 할당 |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID`와 함께 Cloudflare Workers AI Clef 판단 모델(`cloudflare-workers-ai/@cf/cloudflare/clef`, `.../clef-flash`) 인증. `/login cloudflare-workers-ai`도 가능 |
| `TYPESAFE_DEFAULT_MODEL` | 호출자가 모델을 전달하지 않을 때 독립형 `pi-ai` TypeSafe 클라이언트 기본값(기본 `jev-latest`). coding-agent는 `judge` 역할이 선택한 모델을 전달하므로 이 변수는 앱 역할 선택이나 탐색 모델 ID를 재정의하지 않음 |

---

<a id="4-python-tooling-and-kernel-runtime"></a>
## 4) Python 도구 및 커널 런타임

| 변수 | 기본값 / 동작 |
| --- | --- |
| `PI_PY` | Python 불리언 플래그 재정의. 미설정/빈 값이면 `eval.py`에 위임(기본 활성) |
| `PI_JS` | JavaScript 불리언 플래그 재정의. 미설정/빈 값이면 `eval.js`에 위임(기본 활성) |
| `PI_PYTHON_SKIP_CHECK` | 참 같은 플래그면 Python 인터프리터 사용 가능 검사 생략(하위 프로세스 실행기는 필요할 때 시작) |
| `PI_PYTHON_IPC_TRACE` | 참 같은 플래그면 Python 실행기 하위 프로세스와 주고받는 NDJSON 프레임 기록 |
| `VIRTUAL_ENV` | Python 런타임 확인의 최우선 venv 경로 |
| `CONDA_PREFIX` | `VIRTUAL_ENV` 다음, 로컬 `.venv` / `venv` 디렉터리 전의 Python 환경 폴백 |

Python 하위 프로세스 필터링은 일반 API 키를 차단하고 안전한 기본 변수 및 `LC_`, `XDG_`, `PI_` 접두사를 허용합니다.

셸 하위 프로세스 필터링은 별도입니다(`packages/utils/src/env.ts`). Python 키 허용 목록 대신 프로젝트 dotenv 값을 제거합니다.

---

<a id="5-agentruntime-behavior-toggles"></a>
## 5) 에이전트/런타임 동작 전환

| 변수 | 기본값 / 동작 |
| --- | --- |
| `PI_SMOL_MODEL` | `smol` 모델 역할의 일시적 재정의(CLI `--smol` 우선) |
| `PI_SLOW_MODEL` | `slow` 모델 역할의 일시적 재정의(CLI `--slow` 우선) |
| `PI_PLAN_MODEL` | `plan` 모델 역할의 일시적 재정의(CLI `--plan` 우선) |
| `PI_NO_TITLE` | 설정하면(비어 있지 않은 모든 값) 첫 사용자 메시지에서 세션 제목 자동 생성 비활성화 |
| `OMP_BUILD_LABEL` | 이 프로세스가 쓰는 모든 세션 항목에 빌드와 함께 기록하는 자유 형식 이름(한 줄로 합치고 처음 80자로 제한). 사용자 지정 또는 실험용 빌드의 대화 기록을 구분할 수 있으며 `/session`에 표시 |
| `PI_TINY_DEVICE` | 로컬 tiny 모델의 추론 백엔드. `providers.tinyModelDevice` 설정 재정의(기본 CPU). ONNX 제공자 `cpu`, `gpu`, `webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu`, `webnn-npu` 지원. Apple silicon에서 mlx-lm으로 MLX 가중치를 실행하려면 `mlx`/`metal` 사용 |
| `PI_TINY_DTYPE` | 로컬 tiny 모델의 ONNX 양자화/정밀도. `providers.tinyModelDtype` 설정 재정의(기본 각 모델에 포함된 dtype, 현재 `q4`). `auto`, `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16` 지원 |
| `PI_NO_INTERLEAVED_THINKING` | `1`이면 Anthropic 교차 사고 예산 동작을 끄고 이전 사고 모드의 출력 토큰 확장 사용 |
| `PI_NO_THINKING_LOOP_GUARD` | `1`이면 모델 사고 루프 방지 기능 비활성화 |
| `NULL_PROMPT` | `true`이면 시스템 프롬프트 빌더가 빈 문자열 반환 |
| `PI_BLOCKED_AGENT` | task 도구에서 특정 하위 에이전트 유형 차단 |
| `PI_TASK_MAX_OUTPUT_BYTES` | 하위 에이전트별 최대 출력 캡처 바이트 수(기본 `500000`) |
| `PI_TASK_MAX_OUTPUT_LINES` | 하위 에이전트별 최대 출력 캡처 줄 수(기본 `5000`) |
| `PI_WALK_WORKERS` | `omp grep` 탐색기 및 관련 병렬 순회에서 사용하는 파일 시스템 탐색 작업자 수(`pi-walker`, 기본 `4`, `0` = 자동 감지, `1` = 순차 실행). 이전 이름은 `PI_GREP_WORKERS`이며 더 이상 읽지 않음 |
| `PI_TIMING` | 설정하면(비어 있지 않은 모든 값) `logger.printTimings()`로 계층형 시간 측정 구간 트리를 **stderr**에 출력. 대화형 모드에서는 에이전트 준비 후(TUI 시작 전) 출력하고, 출력 모드에서는 전체 프롬프트 묶음 완료 후 출력. 출력 모드 프롬프트를 `print:prompt:initial` / `print:prompt:next` 구간으로 감싸 사용자 메시지마다 별도 행으로 표시. 대화형 모드에서 `PI_TIMING=x`는 출력 직후 코드 0으로 프로세스 종료(콜드 시작만 측정할 때 사용). `PI_TIMING=full`은 상위 N개 대신 모든 모듈 로드 항목 표시 |
| `PI_DEBUG_STARTUP` | 설정하면(비어 있지 않은 모든 값) 각 시작 단계의 시작/종료 시 동기식 `[startup] <phase>:start` / `:done` 표시를 한 줄씩 **stderr**에 출력. 명령 모듈 가져오기(`cli:load:<name>`)와 네이티브 애드온 추출/`dlopen`(`native:*`) 포함. 시작 완료 후에만 출력하는 `PI_TIMING`과 달리 완전히 멈춰도 표시가 남으므로 stderr의 마지막 줄로 멈춘 단계를 확인 가능. `PI_TIMING`과 함께 사용할 수 있으며 표시와 구간 트리는 같은 단계 이름 사용 |
| `OMP_LOG_LEVEL` | `logs/omp.<date>.<pid>.log` 파일에 기록하는 가장 상세한 수준: `error`, `warn`, `info`, `debug`(기본 모든 수준). 기록은 일괄 쓰기(최대 초당 한 번 또는 64 KiB마다 한 번). `warn`과 `error` 기록은 즉시 쓰며 종료, 시그널, 치명적 오류 경로에서 나머지를 모두 기록 |
| `PI_PACKAGE_DIR` | 패키지 자산 기본 디렉터리 확인 재정의(`docs/`, `examples/`, `CHANGELOG.md`) |
| `OMP_SKIP_SETUP` | `0`, `false`, `no` 이외의 비어 있지 않은 값이면 자동 대화형 설정 화면 생략. 명시적으로 강제한 설정은 이 값 무시 |
| `PI_DISABLE_LSPMUX` | `1`이면 lspmux 감지/통합을 끄고 LSP 서버 직접 실행 강제 |
| `PI_RPC_EMIT_TITLE` | RPC 모드의 제목 이벤트를 활성화하는 불리언 유사 플래그 |
| `SMITHERY_URL` | Smithery 웹 URL 재정의(기본 `https://smithery.ai`) |
| `SMITHERY_API_URL` | Smithery API 기본 URL 재정의(기본 `https://api.smithery.ai`) |
| `SMITHERY_API_KEY` | 관리형 MCP 인증 조회용 Smithery API 키 |
| `PUPPETEER_EXECUTABLE_PATH` | Eval 브라우저 런타임의 Chromium 실행 파일 재정의 |
| `LITELLM_BASE_URL` | LiteLLM 프록시 기본 URL 폴백(미설정 시 `http://localhost:4000/v1`). 명시적 `providers.litellm.baseUrl` / `models.yml` 구성 우선 |
| `LM_STUDIO_BASE_URL` | 기본 암시적 LM Studio 탐색 기본 URL 재정의(미설정 시 `http://127.0.0.1:1234/v1`) |
| `OLLAMA_BASE_URL` | 기본 암시적 Ollama 탐색 기본 URL 재정의(미설정 시 `OLLAMA_HOST`, 그다음 `http://127.0.0.1:11434`) |
| `OLLAMA_HOST` | `OLLAMA_BASE_URL`이 없을 때 암시적 Ollama 탐색에 사용하는 호스트. `127.0.0.1:11434`, `http://host:11434` 같은 Ollama 형식 값 허용 |
| `OLLAMA_CONTEXT_LENGTH` | 암시적 Ollama 탐색의 컨텍스트 창을 재정의하는 양의 정수. OMP 컨텍스트 예산에만 영향을 주며 Ollama 런타임의 `num_ctx`는 변경하지 않음 |
| `LLAMA_CPP_BASE_URL` | 기본 암시적 Llama.cpp 탐색 기본 URL 재정의(미설정 시 `http://127.0.0.1:8080`) |
| `PI_EDIT_VARIANT` | 유효한 값(`patch`, `replace`, `hashline`, `apply_patch`, `sloppy`)이면 edit 도구 변형 강제. `auto`를 포함한 잘못된 값은 무시. 일치하는 `edit.modelVariants` 항목이 있으면 여전히 우선 |
| `PI_EDIT_FUZZY` | `1`/`true`는 edit 유사 일치 강제 활성화, `0`/`false`는 비활성화. `auto` 또는 그 밖의 값은 무시하고 `edit.fuzzyMatch` 적용 |
| `PI_EDIT_FUZZY_THRESHOLD` | `edit.fuzzyThreshold`를 재정의하는 `[0, 1]` 범위의 유사 일치 임계값. `auto`, 숫자가 아닌 값, 범위 밖 값은 무시 |
| `PI_INTENT_TRACING` | 도구 의도 메타데이터의 불리언 플래그 재정의. 미설정/빈 값이면 `tools.intentTracing`에 위임 |
| `PI_STRICT_EDIT_MODE` | `1`이면 내장 모델별 편집 모드 폴백 비활성화. `PI_EDIT_VARIANT` 또는 `edit.modelVariants`가 재정의하지 않으면 구성한/전역 `edit.mode` 사용 |
| `PI_FORCE_IMAGE_PROTOCOL` | 사용하는 곳에서 지원 이미지 프로토콜(`kitty`, `iterm2`/`iterm`, `sixel`, `none`) 강제. tmux 안에서 `kitty`를 설정하면 `PI_KITTY_PLACEHOLDERS=0` 또는 `PI_NO_KITTY_PLACEHOLDERS=1`로 끄지 않는 한 Kitty 유니코드 자리표시자 배치도 활성화 |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | `PI_FORCE_IMAGE_PROTOCOL=sixel`일 때 SIXEL 패스스루 허용 |
| `PI_NO_PTY` | `1`이면 bash 도구의 대화형 PTY 경로 비활성화 |
| `OMP_MCP_TIMEOUT_MS` | 모든 MCP 서버의 클라이언트 요청 제한 시간과 출력 모드 준비 대기 시간(ms) 재정의(기본 `30000`). `0`은 두 제한을 모두 해제하므로 출력 모드가 서버를 무기한 기다릴 수 있음. 잘못된 값(음수 또는 숫자가 아닌 값)은 경고와 함께 무시하고 서버별 구성 또는 기본값 사용 |
| `OMP_MCP_STARTUP_TIMEOUT_MS` | 초기 MCP 탐색 대기 시간(ms). `mcp.startupTimeoutMs` 재정의(기본 `250`). `0`은 초기 연결이 정리될 때까지 대기. 잘못된 값은 로그에 남기고 무시. 출력 모드는 별도로 첫 턴 전에 완전한 준비 상태까지 대기 |
| `OMP_MCP_REQUIRE_READY` | `1`이면 구성한 MCP 서버 중 대기 중이거나 실패한 서버가 있을 때 출력 모드가 첫 턴 전에 종료 코드 1로 종료. 미설정 시 사용할 수 없는 서버마다 stderr 경고를 출력하고 턴 진행 |
| `PI_DISABLE_UUTILS_BUILTINS` | `0`/`false` 이외의 비어 있지 않은 값이면 bash 도구의 uutils 내장 명령 비활성화. `shell.env.PI_DISABLE_UUTILS_BUILTINS` 우선 |
| `OMP_NO_WEBP` | `1` 또는 `true`(대소문자 무시)이면 이미지 크기 조절 형식 선택에서 WebP 비활성화 |
| `MNEMOPI_EMBEDDING_MODEL` | `mnemopi.embeddingModel`의 임베딩 모델 폴백. 설정이 없거나 `null` 또는 공백일 때 사용하며 그 밖에는 설정 우선 |
| `PI_AUTO_QA` | 자동 도구 문제 보고서 삽입/기록의 최우선 불리언 플래그. `1`/`y`/`true`/`yes`/`on` 이외의 비어 있지 않은 값이면 비활성화. 미설정/빈 값이면 `dev.autoqa` 설정 사용 |
| `PI_AUTO_QA_PUSH` | `1`/`true`이면 동의 대화 상자를 건너뛰고 헤드리스/비대화형 환경에서 도구 문제 전송 기록 강제 |
| `PI_AUTO_QA_PUSH_URL` | 자동 QA 문제 보고 전송 엔드포인트 재정의. `dev.autoqaPush.endpoint` 설정보다 우선 |
| `PI_AUTO_QA_PUSH_TOKEN` | 자동 QA 문제 보고 전송용 bearer 토큰 재정의. `dev.autoqaPush.token`보다 우선 |
| `PI_BROWSER_RELAY` | 브라우저 릴레이의 `0`/`1` 비상 스위치. `browser.relay` 설정 재정의(Eval의 브라우저 API가 필요로 할 때 릴레이 자동 시작) |
| `OMP_DAEMON_IDLE_GRACE_MS` | 마지막 `omp` 클라이언트 연결 해제 후 데몬 브로커가 종료하고 관리 중인 비분리 데몬(bash 도구의 `name`으로 시작한 서비스 등)을 중지하기 전 대기 시간(ms, 기본 `3000`). `omp` 프로세스가 브로커를 시작할 때 한 번 읽으며 10진수 `parseInt` 접두사 사용(`5s`는 `5`, `2.5`는 `2`). `0`이면 마지막 클라이언트 연결 해제 즉시 브로커 종료. 음수 또는 첫 부분에 숫자가 없는 값은 기본값 사용 |

<a id="hindsight-memory-backend"></a>
### Hindsight 메모리 백엔드

지원하는 각 환경 변수는 대응하는 `hindsight.*` 설정을 재정의하며, 그 설정은 내장 기본값보다 우선합니다.
문자열 값은 앞뒤 공백을 제거하고 빈 값은 무시합니다.
불리언 값은 위의 설정 기반 플래그 규칙을 따릅니다. 빈 값은 무시하고,
`1`, `y`, `true`, `yes`, `on`(전부 소문자 또는 전부 대문자)은 참, 나머지는 거짓입니다.
정수 값은 10진수 `parseInt` 접두사를 사용합니다(`5000ms`는 `5000`, `2.5`는 `2`).
빈 값과 숫자가 아닌 값은 무시하며 파싱한 정수의 범위를 제한하지 않습니다.
열거형 값은 나열된 소문자 값 중 하나와 일치해야 합니다(앞뒤 공백은 무시).
잘못된 값은 무시합니다.

| 변수 | 재정의하는 설정 | 허용 값 / 내장 기본값 |
| --- | --- | --- |
| `HINDSIGHT_API_URL` | `hindsight.apiUrl` | 비어 있지 않은 문자열. 기본 `http://localhost:8888` |
| `HINDSIGHT_API_TOKEN` | `hindsight.apiToken` | 비어 있지 않은 문자열. 기본 미설정 |
| `HINDSIGHT_BANK_ID` | `hindsight.bankId` | 비어 있지 않은 문자열. 기본 미설정이므로 선택한 범위 지정 모드에서 뱅크 결정 |
| `HINDSIGHT_BANK_MISSION` | `hindsight.bankMission` | 비어 있지 않은 문자열. 기본 빈 문자열 |
| `HINDSIGHT_RETAIN_MODE` | `hindsight.retainMode` | `full-session` 또는 `last-turn`. 기본 `full-session` |
| `HINDSIGHT_RECALL_BUDGET` | `hindsight.recallBudget` | `low`, `mid`, `high`. 기본 `mid` |
| `HINDSIGHT_AUTO_RECALL` | `hindsight.autoRecall` | 불리언. 기본 `true` |
| `HINDSIGHT_AUTO_RETAIN` | `hindsight.autoRetain` | 불리언. 기본 `true` |
| `HINDSIGHT_SCOPING` | `hindsight.scoping` | `global`, `per-project`, `per-project-tagged`. 기본 `per-project-tagged` |
| `HINDSIGHT_DEBUG` | `hindsight.debug` | 불리언. 기본 `false` |
| `HINDSIGHT_RECALL_MAX_TOKENS` | `hindsight.recallMaxTokens` | 정수. 기본 `1024` |
| `HINDSIGHT_RECALL_CONTEXT_TURNS` | `hindsight.recallContextTurns` | 정수. 기본 `1` |
| `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `hindsight.recallMaxQueryChars` | 정수. 기본 `800` |
| `HINDSIGHT_RETAIN_EVERY_N_TURNS` | `hindsight.retainEveryNTurns` | 정수. 기본 `3` |
| `HINDSIGHT_REQUEST_TIMEOUT_MS` | `hindsight.requestTimeoutMs` | 정수 밀리초. 기본 `30000` |
| `HINDSIGHT_REFLECT_TIMEOUT_MS` | `hindsight.reflectTimeoutMs` | 정수 밀리초. 기본 `120000` |
| `HINDSIGHT_RECALL_TIMEOUT_MS` | `hindsight.recallTimeoutMs` | 정수 밀리초. 기본 `30000` |
| `HINDSIGHT_RETAIN_TIMEOUT_MS` | `hindsight.retainTimeoutMs` | 정수 밀리초. 기본 `60000` |

CLI `--no-pty`를 사용하면 내부적으로도 `PI_NO_PTY`를 설정합니다.

---

<a id="6-storage-and-config-root-paths"></a>
## 6) 저장소 및 구성 루트 경로

coding-agent의 데이터 저장 위치와 로드할 프로세스 로컬 설정 오버레이에 영향을 줍니다.

| 변수 | 기본값 / 동작 |
| --- | --- |
| `OMP_PROFILE` | 표준 이름 있는 프로필 선택자. 명시적으로 빈 값이어도 `PI_PROFILE`보다 우선 |
| `PI_PROFILE` | `OMP_PROFILE`이 정의되지 않았을 때만 사용하는 레거시 프로필 선택자 |
| `PI_CONFIG_DIR` | 홈 아래 구성 루트 디렉터리 이름(기본 `.omp`) |
| `PI_CODING_AGENT_DIR` | 기본 프로필 전용 전체 에이전트 디렉터리 재정의. 이름 있는 프로필은 무시 |
| `PI_CODING_AGENT_SESSION_DIR` | 시작 인수 파싱에서 사용하는 초기 세션 디렉터리 재정의 |
| `PI_NATIVES_DIR` | XDG/기본 경로보다 우선하는 네이티브 애드온 추출/준비 루트 재정의. 로더가 `<version>` 추가. 앞뒤 공백 제거, `~` 확장, 정규화를 수행하며 빈 값이나 상대 경로는 무시. 다운로드한 tree-sitter 문법(`grammars/`)도 옮기지만 세션, 플러그인, 그 밖의 데이터는 옮기지 않음. `omp`를 실행하는 사용자만 쓸 수 있어야 함. 예상 크기와 일치하는 기존 애드온은 다시 추출하지 않고 재사용하며 버전은 로드 후에만 확인하기 때문 |
| `PI_CONFIG_FILES` | 플랫폼 경로 목록 형식의 설정 오버레이(Unix는 `:`, Windows는 `;`). 명시적 `--config` 오버레이 전에 순서대로 로드 |
| `CLAUDE_CONFIG_DIR` | Claude Code 사용자 구성 디렉터리 재정의(앞뒤 공백 제거 후 프로세스 작업 디렉터리 기준으로 확인). Claude의 `.claude.json`도 `<override>/.claude.json`으로 이동. 프로젝트 `.claude` 디렉터리는 이동하지 않음 |
| `OMP_AUTORESEARCH_DB_DIR` | 프로젝트별 autoresearch DB와 프로젝트 산출물 루트 디렉터리 재정의 |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | macOS/Linux에서 대상 `omp` 루트(또는 이름 있는 프로필 루트)가 이미 있을 때만 대응 OMP 경로 변경 |
| `PWD` | 경로 도우미에서 정규 현재 작업 디렉터리를 비교할 때 사용 |
| `OMP_WORKTREE_DIR` | 에이전트 관리 워크트리 디렉터리 재정의(기본 `~/.omp/wt`). 절대 경로 또는 `~` 기준 경로여야 하며 상대 경로는 무시. `worktree.base` 설정보다 우선 |
| `OMP_GITHUB_CACHE_DB` | GitHub 보기 캐시 데이터베이스 경로 재정의(기본 `~/.omp/cache/github-cache.db`) |
| `PI_BUILD_URL` | 독립 실행형 바이너리를 가져오는 빌드 서비스의 출처(기본 `https://build.stencil.so`, 끝의 슬래시 제거). 바이너리 설치의 `omp update`, 바이너리 전용 릴리스로 전환하는 바이너리 교체, 컴파일된 바이너리의 시작 시 업데이트 확인은 `<origin>/api/products/omp/latest/<target>?channel=stable\|canary` 조회. 다운로드는 응답의 크기와 SHA-256으로 검증하며 설치된 바이너리에 적용할 패치가 제공되면 패치로 다운로드. 설치 스크립트(`install.sh`, `install.ps1`)도 같은 출처에서 다운로드 |
| `PI_GRAMMARS_URL` | 필요할 때 받는 WebAssembly tree-sitter 문법의 기본 URL(기본 `https://github.com/stencil-hq/wasm-grammars/releases/download`). `<base>/<release>/<file>.zst`로 자산을 가져오고 애드온에 고정된 SHA-256으로 검증한 뒤 `<natives dir>/grammars`(`~/.omp/natives/grammars`)에 저장 |

---

<a id="7-shelltool-execution-environment"></a>
## 7) 셸/도구 실행 환경

(`packages/utils/src/procmgr.ts`와 coding-agent bash 도구 통합 기준)

| 변수 | 동작 |
| --- | --- |
| `PI_BASH_NO_CI` | 실행한 셸 환경에 `CI=true`를 자동 삽입하지 않음 |
| `CLAUDE_BASH_NO_CI` | `PI_BASH_NO_CI`의 레거시 별칭 폴백 |
| `PI_BASH_NO_LOGIN` | 비어 있지 않은 값이면 POSIX 로그인 셸 모드 비활성화(`-l -c` 대신 `-c`) 및 PowerShell `-NoProfile` 추가. cmd.exe는 항상 `/c` 사용 |
| `CLAUDE_BASH_NO_LOGIN` | `PI_BASH_NO_LOGIN`의 레거시 별칭 폴백 |
| `PI_SHELL_PREFIX` | 선택적 명령 접두사 래퍼 |
| `CLAUDE_CODE_SHELL_PREFIX` | `PI_SHELL_PREFIX`의 레거시 별칭 폴백 |
| `VISUAL` | 우선 사용하는 외부 편집기 명령 |
| `EDITOR` | 폴백 외부 편집기 명령 |

`PI_BASH_NO_CI`, `PI_BASH_NO_LOGIN`, `PI_SHELL_PREFIX`는 표준 변수가 없거나 비어 있으면 `CLAUDE_*` 별칭을 사용합니다. 이 제어는 불리언 파싱이 아니라 비어 있지 않은 문자열 여부를 확인하므로 `0`이나 `false`도 대응하는 CI/로그인 비활성화 제어를 활성화합니다.

<a id="set-by-the-bash-tool"></a>
### `bash` 도구가 설정하는 변수

에이전트가 `bash` 도구로 실행하는 모든 명령(포그라운드, 백그라운드, PTY, ACP 클라이언트 터미널, `name`으로 시작한 서비스)은 현재 세션 식별 정보를 받습니다.

| 변수 | 값 |
| --- | --- |
| `PI_SESSION_ID` | 현재 세션 ID |
| `PI_SESSION_FILE` | 현재 세션 JSONL 파일의 절대 경로. 저장하지 않는 경우(`--no-session`) 빈 값 |

각 도구 호출 시작 시 값을 읽으므로 다음 호출은 `/fork`, `/new`, `/resume`을 반영하고 이미 실행 중인 호출은 시작 당시의 세션을 유지합니다. 항상 설정하므로 빈 값도 부모 omp 프로세스에서 상속한 오래된 값을 대체합니다. 사용자 `!` 명령에는 전달하지 않습니다.

```bash
echo "$PI_SESSION_ID"
```

---

<a id="8-uithemesession-detection-auto-detected-env"></a>
## 8) UI/테마/세션 감지(자동 감지 환경 변수)

런타임 신호로 읽으며 보통 수동 구성 대신 터미널/OS에서 설정합니다.

| 변수 | 용도 |
| --- | --- |
| `COLORTERM`, `TERM`, `WT_SESSION` | 색상 기능 감지(테마 색상 모드) |
| `COLORFGBG` | 터미널 배경의 밝음/어두움 자동 감지 |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR` | 시스템 프롬프트/컨텍스트의 터미널 식별 정보 |
| `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `TERM_SESSION_ID`, `WT_SESSION` | 터미널별 안정적인 세션 추적 ID |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM` | 시스템 정보 진단 |
| `APPDATA`, `XDG_CONFIG_HOME` | lspmux 구성 경로 확인 |
| `HOME` | MCP 명령 UI에서 경로 축약 |

`COPILOT_HOME`은 GitHub Copilot 구성 홈(기본 `~/.copilot`)을 재정의하고, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`는 쉼표로 구분한 추가 지침 디렉터리를 제공합니다. `JS_DEBUG_DAP_SERVER`는 기존 JavaScript 디버그 어댑터 서버를 선택하며, `XDG_DATA_HOME`도 번들 디버거 탐색에 사용합니다.

---

<a id="9-tui-runtime-flags-shared-package-affects-coding-agent-ux"></a>
## 9) TUI 런타임 플래그(공유 패키지, coding-agent UX에 영향)

| 변수 | 동작 |
| --- | --- |
| `PI_NOTIFICATIONS` | `off` / `0` / `false`이면 데스크톱 알림 차단 |
| `PI_TUI_WRITE_LOG` | 설정하면 TUI 쓰기를 파일에 기록. OSC 52 클립보드 쓰기는 내용이 아닌 페이로드 길이만 기록 |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | `1`이면 원시 `0x08`을 Backspace 대신 Ctrl+Backspace로 해석. SSH/컨테이너 경유로 Windows Terminal 클라이언트가 가려질 때 사용 |
| `PI_HARDWARE_CURSOR` | `1`이면 하드웨어 커서 모드 활성화 |
| `PI_NO_SYNC_OUTPUT` | 설정하면(비어 있지 않은 모든 값) TUI 자동 줄바꿈 방지는 유지하면서 DEC 2026 동기화 출력 래퍼 비활성화 |
| `PI_NO_DECCARA` | 설정하면(참으로 평가되는 값) Kitty DECCARA 직사각형 SGR 배경 채우기 비활성화(패딩 문자열 렌더링 강제) |
| `PI_NO_GLYPH_PROTOCOL` | `1`이면 Glyph Protocol 핸드셰이크(APC `25a1`) 생략. nerd 프리셋 아이콘은 omp가 Rio/Ghostty에 인밴드로 등록한 윤곽선 대신 터미널 자체 글꼴만 사용 |
| `PI_TUI_NATIVE` | Tern Surface Protocol 탐색: `0`은 탐색하지 않음(항상 ANSI 행 렌더러), `1`은 멀티플렉서와 테스트 런타임 안에서도 탐색. 미설정 시 모든 직접 연결 터미널 탐색. `hello` 응답이 있어야 네이티브 렌더링으로 전환 |
| `PI_TUI_TSP_RECORD` | 송수신한 모든 Tern Surface Protocol 메시지를 타임스탬프와 함께 기록하는 JSONL 파일 경로 |
| `PI_TUI_NATIVE_STATS` | `1`이면 네이티브 프레임마다 연산 수와 `rows` 폴백 횟수를 디버그 수준으로 기록 |
| `PI_DEBUG_REDRAW` | `1`이면 다시 그리기 디버그 로그 활성화 |
| `PI_FORCE_IMAGE_PROTOCOL` | 터미널 이미지 프로토콜 감지 강제(`kitty`, `iterm2`/`iterm`, `sixel`, `none`). 터미널 멀티플렉서 안에서 `kitty`를 설정하면 `PI_KITTY_PLACEHOLDERS=0` 또는 `PI_NO_KITTY_PLACEHOLDERS=1`로 끄지 않는 한 Kitty 유니코드 자리표시자 배치도 활성화 |
| `PI_KITTY_PLACEHOLDERS` | `1`은 Kitty 유니코드 자리표시자 배치 강제 활성화, `0`은 강제 비활성화. 터미널 멀티플렉서 안에서는 외부 터미널이 Kitty `U=1` 자리표시자를 지원하는지 확인한 뒤에만 `1` 사용. 그렇지 않으면 U+10EEEE가 문자 그대로 PUA 상자로 표시될 수 있음 |
| `PI_NO_KITTY_PLACEHOLDERS` | `1`은 Kitty 유니코드 자리표시자 배치를 완전히 비활성화하며 `PI_KITTY_PLACEHOLDERS`보다 우선 |
| `PI_TUI_RESIZE_IN_PLACE` | `1`/`true`는 제자리 크기 조절 강제(대체 화면 임시 사용 및 ED3 줄 재배치 없음), `0`/`false`는 대체 화면의 빠른 경로 강제. 대체 화면 전환 시 크기를 다시 알리는 Warp에서는 기본 활성화. 단, ConPTY 호스트(Windows 및 `wslhost`를 통한 WSL)는 예외. 이 환경에서는 conhost가 격자를 소유하고 크기 조절 시 자체 뷰포트를 다시 그리므로 기준점을 복구할 수 없음 |

<a id="browser-launchproxy-controls"></a>
### 브라우저 실행/프록시 제어

| 변수 | 동작 |
| --- | --- |
| `PUPPETEER_PROXY` | Chromium의 `--proxy-server` 실행 인수 추가 |
| `PUPPETEER_PROXY_BYPASS_LOOPBACK` | 불리언 유사 플래그. 우회 목록에 `<-loopback>`을 추가해 localhost도 프록시 사용 |
| `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` | 불리언 유사 플래그. 인증서 오류를 무시하도록 Chromium 실행 |
| `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` | 브라우저가 분할 창을 열 때 대상 cmux 작업 공간/화면 지정 |
| `CMUX_RELAY_ID`, `CMUX_RELAY_TOKEN` | cmux 릴레이 식별/인증 폴백 |

---

<a id="10-commit-generation-controls"></a>
## 10) 커밋 생성 제어

| 변수 | 동작 |
| --- | --- |
| `PI_COMMIT_TEST_FALLBACK` | `true`(대소문자 무시)이면 커밋 폴백 생성 경로 강제 |
| `PI_COMMIT_NO_FALLBACK` | `true`이면 에이전트가 제안을 반환하지 않을 때 폴백 비활성화 |
| `DEBUG` | 설정하면 커밋 에이전트 오류 스택 추적 출력 |

---

<a id="11-opentelemetry-export"></a>
## 11) OpenTelemetry 내보내기

OMP는 하나 이상의 신호에 엔드포인트가 있을 때만 OTLP 내보내기를 초기화합니다. 엔드포인트를 구성했어도 내보내기를 생략하려면 `telemetry.otlpExportEnabled: false`(`/settings` → 제공자 → 개인정보 보호)를 설정하세요. `OTEL_SDK_DISABLED=true`도 초기화를 비활성화합니다.

| 변수 그룹 | 동작 |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 공통 엔드포인트 폴백 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 신호별 엔드포인트. 공통 엔드포인트보다 우선 |
| `OTEL_EXPORTER_OTLP_HEADERS` | 공통 OTLP 요청 헤더. 값을 퍼센트 인코딩한 `key=value,key2=value2` 목록 |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | 신호별 요청 헤더. 공통 헤더에 키별로 병합하며 같은 키는 재정의 |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | 목록에 `none`이 있으면 해당 신호 비활성화 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` 및 신호별 `..._PROTOCOL` 변형 | 이 런타임에서는 `http/protobuf`만 활성화. 다른 프로토콜을 명시하면 해당 신호 비활성화 |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | OpenTelemetry 리소스 메타데이터 |
| `OTEL_LOG_LEVEL` | 내보내는 OMP 로그의 최소 수준 |

헤더 값은 퍼센트 디코딩하므로 공백과 `,`/`=` 구분자를 인코딩하세요.

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:8000/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20$LAMINAR_PROJECT_API_KEY"
```

---

<a id="security-sensitive-variables"></a>
## 보안에 민감한 변수

다음은 비밀 정보로 취급하고 로그에 남기거나 커밋하지 마세요.

- 제공자/API 키 및 OAuth/bearer 자격 증명(모든 `*_API_KEY`, `*_TOKEN`, OAuth 접근/갱신 토큰)
- 클라우드 자격 증명(`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS` 경로는 서비스 계정 정보를 노출할 수 있음)
- 검색/제공자 인증 변수(`EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, Anthropic 검색 키)
- Foundry mTLS 자료(`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, 사설 CA 번들을 가리키는 경우 `NODE_EXTRA_CA_CERTS`)
- OTLP 내보내기 헤더(`OTEL_EXPORTER_OTLP_HEADERS` 및 신호별 `..._{TRACES,LOGS,METRICS}_HEADERS` 변형). 수집용 bearer 토큰/프로젝트 키를 포함

Python 런타임도 커널 하위 프로세스 실행 전에 일반적인 키 변수 다수를 명시적으로 제거합니다(`packages/coding-agent/src/eval/py/runtime.ts`).
