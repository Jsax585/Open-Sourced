# 인증 브로커와 인증 게이트웨이

인증 브로커는 자격 증명 저장과 OAuth 갱신을 중앙화합니다. 인증 게이트웨이는 클라이언트가 제공업체 자격 증명을 받지 않고 제공업체에 요청할 수 있게 합니다. 브로커에 직접 연결하는 클라이언트는 신뢰할 수 있어야 합니다. 스냅샷에는 OAuth 액세스 토큰과 저장된 API 키가 노출되지만 실제 OAuth 갱신 토큰은 노출되지 않습니다.

- **`omp auth-broker serve`**는 기준 SQLite 자격 증명 저장소를 유지하고 OAuth를 갱신하며 `/v1` 아래에서 스냅샷, 자격 증명, 차단, 사용량, 상태 API를 제공합니다.
- **`omp auth-gateway serve`**는 전달 프록시입니다. OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, pi-native 스트림, TypeSafe System One 판정과 OpenAI/OpenRouter 형식의 이미지, 음성, 전사, 임베딩, 재정렬, 동영상 요청을 받아 브로커 기반 자격 증명을 결정하고 `pi-ai` 제공업체 로직으로 전달합니다. 클라이언트(컨테이너화된 omp, llm-git, macOS 사용량 위젯 등)에는 액세스 토큰이 노출되지 않습니다.
- **`omp auth-gateway stdio`**는 CLI 자체 자격 증명과 모델 역할을 사용하여 같은 경로를 표준 입력/출력의 JSON 줄로 상위 프로세스에 제공합니다. [stdio](#stdio)를 참고하세요.

운영자, 브로커, 게이트웨이 간 전송 보안은 운영자 책임입니다(Tailscale / Wireguard / 역방향 프록시 + TLS). 브로커의 `/v1/healthz`와 게이트웨이의 `/healthz`를 제외한 모든 엔드포인트에는 기본적으로 Bearer 토큰이 필요합니다. 게이트웨이는 CORS `OPTIONS` 사전 요청에도 인증 없이 응답합니다. `--no-auth`는 게이트웨이 수신 인증을 끕니다.

소스: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/ai/src/auth/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-stdio.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

## 데이터 흐름

```
                ┌────────────────────────────────────────────────────────────┐
                │ 브로커 호스트                                               │
                │                                                            │
  개발자 ─────▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  노트북 /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - 갱신 토큰 보관       │    │  (기준 기록 주체)  │    │
                │  │  - 백그라운드 갱신기    │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  Bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  스냅샷 스트림 수신,         │
                │  │  /v1/usage,/v1/models    │  만료 시 브로커를 통해       │
                │  │  /v1/credentials/check   │  ID별 자격 증명 갱신         │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  Bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  게이트웨이 클라이언트
                  (llm-git, macOS 위젯, robomp 컨테이너, IDE 플러그인 등)
                                │
                                ▼ 브로커가 결정한 자격 증명으로 제공업체 요청
                  api.anthropic.com / api.openai.com / …
```

브로커만 OAuth 갱신 토큰을 기록합니다. 게이트웨이를 포함한 클라이언트는 모든 `refresh` 필드가 `REMOTE_REFRESH_SENTINEL`로 대체된 스냅샷을 로드합니다. 액세스 토큰이 만료되면 클라이언트가 `POST /v1/credential/:id/refresh`를 호출하고 브로커가 서버에서 갱신합니다. `RemoteAuthCredentialStore`를 통한 자격 증명 쓰기는 브로커 저장이 완료될 때까지 기다리고 로컬 스냅샷을 갱신한 뒤 반환합니다. 쓰기의 기준은 계속 브로커입니다.

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port] [--trust-proxy-headers]  # 브로커 시작
omp auth-broker token     [--regenerate] [--json]               # Bearer 토큰 출력 또는 교체
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve`는 `getAgentDbPath()`의 로컬 SQLite 저장소를 열고 HTTP 리스너에 바인딩합니다(기본값 `127.0.0.1:8765`). 시작할 때 `<config-dir>/auth-broker.token`에 토큰을 준비합니다(모드 `0600`, 새 상위 디렉터리 `0700`). 백그라운드 갱신기는 즉시 실행되고 이후 `refreshIntervalMs`마다 실행되며(기본 60초), 만료까지 `refreshSkewMs` 이내인 OAuth 자격 증명을 대상으로 합니다(기본 5분).
- 요청 로그는 소켓 상대 주소에 귀속됩니다. 신뢰할 수 있는 역방향 프록시 뒤에서는 `--trust-proxy-headers`를 전달해 인증된 요청에 `X-Forwarded-For` / `X-Real-IP`를 사용하세요. 미인증 요청은 항상 소켓 상대 주소로 기록하고 브로커 경로 밖의 경로는 `<unrouted>`로 기록합니다.
- `token`은 저장된 Bearer 토큰을 출력하거나 새 토큰을 생성합니다. `--regenerate`는 토큰 파일을 교체합니다. 실행 중인 브로커는 재시작해야 새 토큰을 메모리 허용 목록에 로드합니다.
- `login [<provider>]`은 등록된 로그인 흐름(OAuth 또는 제공업체 API 키 로그인)을 로컬에서 실행합니다. 제공업체를 생략하면 대화형 번호 선택기를 표시합니다. `--via=user@host`를 사용하면 `ssh -L <callback-port>:127.0.0.1:<callback-port> -o ExitOnForwardFailure=yes user@host omp auth-broker login <provider>`를 실행하며 자격 증명은 원격 호스트에 기록합니다(`--via`에는 `<provider>`가 필요하고 `--dry-run`은 이 원격 경로에만 적용). 포트는 인증 레지스트리에서 가져옵니다: `anthropic:54545`, `openai-codex:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`, `devin:59653`, `openrouter:54549`, `stencil:54547`. `gitlab-duo-agent`와 `zai-coding-plan`은 이전 `8080`/`9999` 리스너 대신 비루프백/수동 콜백을 사용하므로 호스트에서 직접 실행하세요. 로그인은 프로세스 내 `AuthStorage.oauth.login()`으로 진행합니다.
- `logout [<provider>]`은 원인 `logged out by user`와 함께 제공업체의 활성 행을 비활성화합니다. 비활성화된 삭제 표식은 브로커 API에서 계속 조회할 수 있습니다. 인수를 생략하면 저장된 제공업체의 대화형 번호 선택기를 표시합니다.
- `list`는 저장된 계정이 아니라 `getOAuthProviders()`가 반환하는 로그인 제공업체(표시되는 내장 제공업체와 `registerOAuthProvider` 사용자 지정 제공업체)를 나열합니다. `--json`은 `{ id, name }` 배열을 출력합니다.
- `import <file|dir>`는 CLIProxyAPI 형식 JSON 자격 증명을 로컬 SQLite 저장소로 가져옵니다. `type` 필드를 omp 제공업체에 매핑합니다(`claude → anthropic`, `codex → openai-codex`, `gemini → google-gemini-cli`, `antigravity → google-antigravity`, `gemini-cli → google-gemini-cli`).
- `migrate --from-local`은 로컬 SQLite 자격 증명을 설정된 브로커에 업로드합니다(`POST /v1/credential`). 로컬 API 키는 기본 포함하고, 로컬 OAuth 행은 `--include-oauth`가 없으면 건너뛰며 환경에서 얻은 API 키는 `--include-env`가 없으면 건너뜁니다. 재실행은 브로커 스냅샷을 기준으로 멱등적입니다.
- `status`는 설정된 원격 브로커의 상태를 확인합니다.

### 엔드포인트

| 메서드 | 경로 | 인증 | 용도 |
| --- | --- | --- | --- |
| `GET` | `/v1/healthz` | 없음 | 생존 상태와 버전 |
| `GET` | `/v1/snapshot` | Bearer | 갱신 토큰을 센티널로 대체한 스냅샷 |
| `GET` | `/v1/snapshot/stream` | Bearer | 변경 이벤트와 연결 유지 메시지가 있는 SSE 스냅샷 스트림 |
| `POST` | `/v1/credential` | Bearer | OAuth 또는 API 키 자격 증명 하나 추가/갱신 |
| `POST` | `/v1/credential/:id/refresh` | Bearer | OAuth 자격 증명 하나 강제 갱신 |
| `POST` | `/v1/credential/:id/disable` | Bearer | 원인을 기록하고 자격 증명 하나 비활성화 |
| `GET` | `/v1/credentials/disabled` | Bearer | 비활성 자격 증명 목록, 선택적 `provider` 쿼리 필터 |
| `POST` | `/v1/credential/:id/block` | Bearer | 제공업체/범위별 속도 제한 차단 추가/갱신 |
| `DELETE` | `/v1/credential/:id/block` | Bearer | 본문의 `providerKey`와 `blockScope`가 지정한 차단 삭제 |
| `DELETE` | `/v1/credential/:id/blocks` | Bearer | 자격 증명의 모든 속도 제한 차단 삭제 |
| `GET` | `/v1/usage` | Bearer | 자격 증명 전체의 현재 `UsageReport[]` 집계 |
| `GET` | `/v1/usage/history` | Bearer | 저장된 사용량 기록, 선택적 `sinceMs` 및 `provider` 필터 |
| `POST` | `/v1/usage/observed` | Bearer | 브로커 클라이언트가 관측한 사용량 기록 |
| `GET` | `/v1/usage/clients` | Bearer | 선택적 `sinceMs` 이후 클라이언트 관측 사용량 요약 |
| `POST` | `/v1/usage/stale` | Bearer | 브로커 사용량 캐시 무효화, 선택적 `provider` 범위 |

요청은 `Authorization: Bearer <token>`을 사용합니다. 서버는 메모리 내 토큰 허용 목록과 비교하며 게이트웨이 구현은 타이밍 안전 비교를 사용합니다.

스냅샷은 `generation`, `generatedAt`, `serverNowMs`, `refresher`(`enabled`, `intervalMs`, `skewMs`, `nextSweepInMs`), `credentials`를 포함합니다.
각 자격 증명은 ID/제공업체/민감 정보가 제거된 자격 증명/`identityKey`, `rotatesInMs`, 선택적 속도 제한 `blocks`를 포함합니다.

SSE 스트림은 전체 `snapshot` 이벤트로 시작하며 이후 변경된 `entry`와 삭제/비활성화된 `removed` 이벤트를 전송합니다. SSE 이벤트 이름은 JSON `kind`에도 나타납니다. 변경 데이터는 `generation`, `serverNowMs`, `refresher`와 함께 `entry` 또는 제거된 `id`를 포함합니다. 연결 유지 메시지는 JSON 이벤트가 아닌 SSE 주석입니다.

직접 `POST /v1/credential/:id/refresh`를 호출하면 강제로 갱신합니다. `?reason=auth-recovery` 형식은 업스트림 장애 중 반복 발급을 막기 위해 브로커가 지난 5분 이내에 발급한, 아직 사용 가능한 토큰을 재사용할 수 있습니다.

#### 조건부 스냅샷 롱 폴링

`GET /v1/snapshot?wait=<ms>`는 세대 기반 조건부 폴링을 지원합니다.
이전 응답의 세대를 `If-None-Match`로 보내세요. 브로커는 음수가 아닌 정수 세대를 단독 태그, `"42"` 같은 따옴표 태그, `W/"42"` 같은 약한 따옴표 태그로 받습니다.

`wait`는 숫자로 해석하여 밀리초 정수로 자르고 0~30,000ms 범위로 제한합니다. 없거나 숫자가 아니면 `0`으로 처리합니다. 응답 상태 전이는 다음과 같습니다.

- 태그가 없거나 잘못되었거나 현재 세대와 다르거나 `wait <= 0`이면 현재 민감 정보 제거 스냅샷을 `200`으로 즉시 반환합니다.
- 태그가 일치하고 `wait > 0`이면 세대가 바뀔 때까지 기다립니다. 변경되면 새 스냅샷을 `200`으로, 변경 없이 시간이 초과되면 빈 `304`를, 호출자가 연결을 끊으면 빈 `499`를 반환합니다.

모든 `200`, `304`, `499` 스냅샷 응답에는 따옴표로 감싼 세대 `ETag`, `Cache-Control: no-store`, `Vary: OMP-Auth-Broker-Capabilities`가 포함됩니다. 연결 종료 응답은 대기 전에 캡처한 세대를 사용합니다.

### Codex 차단 범위 호환성

계량 단위별 Codex 차단을 이해하는 클라이언트는 `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`를 보냅니다. 이 경우 스냅샷 응답은 기준 범위 `chat`과 `spark`를 포함합니다. 이 기능을 알리지 않으면 브로커는 전송 시 해당 행을 이전 `shared` 범위로 투영합니다.

로컬 SQLite 스키마 8은 현재 저장소 API가 노출하는 기준 범위로 `chat`과 `spark`를 유지합니다. 또한 `agent.db`를 직접 읽는 계량 단위 도입 전 바이너리를 위해 물리적인 `shared` 호환 미러를 유지합니다. SQLite 트리거는 계량 행에서 미러의 기한과 갱신 시간을 각각 계산하고, 이전 프로세스의 `shared` 쓰기를 두 계량 단위로 복사합니다. 현재 저장소 API는 물리적 미러를 생략하므로 브로커 스냅샷과 모델 선택에서 중복 계산하지 않습니다.

17.1.4를 포함해 이 기능 이전에 출시된 클라이언트는 업그레이드할 때까지 보수적인 `shared` 투영을 받습니다. 기존 프로토콜에서는 이 클라이언트들을 구별할 수 없으므로 혼합 버전 배포에서는 반복 제공업체 요청과 429 응답을 허용하기보다 속도 제한된 자격 증명을 계속 차단하는 쪽을 택합니다.

기능에 따라 달라지는 응답은 `Vary: OMP-Auth-Broker-Capabilities`를 포함해 중간 계층이 다른 클라이언트에 같은 표현을 재사용하지 못하게 합니다. 암호화된 클라이언트 스냅샷 캐시도 새 형식 버전을 사용합니다. 이전 캐시 파일은 무시하고 다시 가져와 클라이언트 버전 간 이전 표현과 계량 범위 표현이 섞이지 않도록 합니다.

### 백그라운드 갱신기

`AuthBrokerRefresher`는 매 순회 전에 활성 자격 증명을 다시 로드하며 순회를 겹쳐 실행하지 않습니다. 수동/백그라운드 갱신은 `OAuthRefresher`의 자격 증명별 단일 실행을 공유합니다. SQLite 갱신 임대도 프로세스 간 쓰기를 조정합니다.

- `isDefinitiveOAuthFailure()`가 분류한 **확정적 실패**는 실패한 자격 증명 버전만 비활성화합니다. 비교 후 저장 방식이 동시 로그인/갱신으로 교체된 자격 증명을 보호하며, 갱신기는 해당 행을 다시 비활성화하지 않고 결과를 기록합니다.
- 네트워크 시간 초과 같은 **일시적 실패**는 자격 증명을 그대로 두고 다음 순회에서 다시 시도합니다.

CLI 브로커 갱신 훅은 저장된 MCP 토큰 엔드포인트/클라이언트 메타데이터를 사용해 관리형 `mcp_oauth:*` 자격 증명도 처리하며 MCP 관리자를 로드할 필요가 없습니다.

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth] [--trust-proxy-headers] [--clients=<file>]
omp auth-gateway stdio
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve`에는 `OMP_AUTH_BROKER_URL`(또는 `config.yml`의 `auth.broker.url`)이 필요합니다. 게이트웨이 자체가 브로커 클라이언트입니다. 실시간 스냅샷을 `RemoteAuthCredentialStore`로 감싸고 계정 풀/정책으로 `AuthStorage`를 구성합니다. 일반 클라이언트와 달리 시작 시 암호화된 스냅샷 캐시를 사용하지 않습니다. 기본 바인딩은 `127.0.0.1:4000`, 토큰 파일은 `<config-dir>/auth-gateway.token`(`0600`)입니다. `--no-auth`는 Bearer 검사를 완전히 끕니다. 신뢰할 수 있는 루프백 리스너에서만 사용하세요. 루프백 바인딩을 강제하지는 않습니다.
- 요청 로그는 소켓 상대 주소에 귀속됩니다. 신뢰할 수 있는 역방향 프록시 뒤에서는 `--trust-proxy-headers`로 인증된 요청에 `X-Forwarded-For` / `X-Real-IP`를 사용하세요. 미인증 요청은 항상 소켓 상대 주소로 기록합니다. 인증된 요청이 URL 또는 전달/기록/식별 헤더에도 게이트웨이 토큰이나 자체 클라이언트 토큰을 포함하면 자격 증명 조회 전에 `400`으로 거부합니다. 각 `auth-gateway request` 로그에는 요청 시작 시 브로커 `credentialId`와 [클라이언트 토큰](#클라이언트-토큰)의 `client`가 기록됩니다.
- `token`은 토큰 파일을 관리합니다. `--regenerate`로 교체한 토큰을 받으려면 실행 중인 게이트웨이를 재시작해야 합니다. `status`는 로컬 토큰 파일과 인증된 브로커 스냅샷을 확인하며 게이트웨이 리스너는 검사하지 않습니다.
- `check`는 실행 중인 게이트웨이를 호출하지 않고 자체 브로커 기반 저장소로 게이트웨이가 사용할 자격 증명을 검사합니다. `--strict`가 없으면 제공업체 사용량 검사를 사용합니다. `--strict`는 적합한 번들 채팅 모델도 시도하므로 할당량을 사용할 수 있습니다. pi-native 전달, Bedrock, Vertex, Cursor 전송 등 적합한 후보가 없는 제공업체는 완성 요청으로 검사할 수 없습니다.

### 클라이언트 토큰

`serve --clients=<file>`은 게이트웨이 토큰 외에 게이트웨이 자체에서 제한하는 Bearer 토큰을 허용합니다. 파일은 각 클라이언트 이름을 토큰 다이제스트와 제한에 매핑합니다.

```json
{
  "ci": {
    "tokenSha256": "<hex SHA-256 of the client's token>",
    "models": ["anthropic/claude-sonnet-4-5", "openai-codex/*"],
    "accounts": {
      "anthropic": ["email:ci@example.com|org:org-team"],
      "openai-codex": ["email:ci@example.com|org:ws-team"]
    }
  }
}
```

- `tokenSha256`은 클라이언트가 `Authorization: Bearer <token>`으로 보내는 토큰의 16진수 SHA-256입니다(`printf %s "$TOKEN" | shasum -a 256`). 파일에는 원본 토큰을 저장하지 않습니다. 두 클라이언트가 공유하거나 게이트웨이 토큰과 같은 다이제스트는 거부합니다.
- `models`는 정확한 `provider/id` 허용 항목이나 `provider/*`를 나열합니다. 생략하면 제공되는 모든 모델을 허용하고 `[]`이면 아무것도 허용하지 않습니다. 목록 밖 모델은 자격 증명 조회 전에 `404 Unknown model`로 응답하며 `GET /v1/models`는 허용된 모델만 표시합니다. 단독 ID는 클라이언트가 호출할 수 있는 같은 ID의 첫 제공 모델로 해석합니다. 제공업체가 붙은 ID를 다른 제공업체의 단독 ID로 다시 해석하지 않습니다.
- `accounts`는 제공업체별 요청에 사용할 수 있는 OAuth 식별 키([계정 풀](#클라이언트-계정-풀)의 `identityKey`, `omp usage accounts`로 조회)를 매핑합니다. 선택, 갱신, 사용량 제한 차단, 인증 복구 교체는 목록 안에서만 수행합니다. 저장된/런타임/환경 API 키는 사용하지 않으며 다른 계정을 빌리는 대신 요청이 실패합니다. 빈 목록은 계정을 허용하지 않습니다. `accounts`가 있으면 제공업체 허용 목록 역할도 합니다. 빠진 제공업체는 `models` 밖 모델처럼 거부하므로 다른 제공업체로 우회할 수 없습니다. `accounts`에 없는 제공업체를 `models`에서 허용하거나 제공업체 ID 앞뒤에 공백이 있으면 파일을 거부합니다. `accounts`가 없으면 모든 제공업체에서 게이트웨이 토큰과 같은 방식으로 자격 증명을 결정합니다.
- 클라이언트의 모든 대화는 나열된 제공업체마다 계정 고정 하나를 공유합니다. 여러 계정이 있어도 대화를 분산하지 않고 사용량 제한 차단이나 인증 복구로 이동할 때까지 같은 계정에 트래픽을 유지합니다. 학습한 대체 경로나 Codex 전송 세션 같은 제공업체 상태는 다른 클라이언트나 게이트웨이 토큰 트래픽과 공유하지 않습니다.
- `/v1/usage`와 `/v1/credentials/check`는 게이트웨이의 모든 계정을 다루므로 클라이언트 토큰에는 `403`을 반환합니다.
- 게이트웨이 토큰은 제한 없이 계속 유효합니다. `--clients`와 `--no-auth`는 함께 사용할 수 없습니다.
- 알 수 없는 필드나 잘못된 항목이 있으면 파일 전체를 거부하고 `serve`가 시작되지 않습니다. 실행 중에는 10초마다 다시 읽습니다. 삭제/변경된 토큰은 다음 요청부터 거부하지만 진행 중인 요청은 승인 당시 모델과 계정으로 재시도를 포함해 완료합니다. 항목이 바뀌면 새 계정 고정을 시작합니다. 파일을 읽거나 파싱할 수 없으면 수정될 때까지 모든 클라이언트 토큰을 거부하며 수정 후 모두 새 계정 고정을 시작합니다. 일부만 기록된 파일을 읽지 않도록 임시 파일을 쓴 뒤 원본으로 이름을 바꾸는 원자적 교체를 사용하세요.

### stdio

`omp auth-gateway stdio`는 신뢰할 수 있는 상위 프로세스 하나(편집기, 터미널의 git UI, 스크립트)를 위한 게이트웨이입니다. 리스너, 토큰, 브로커가 필요하지 않습니다. 다른 `omp` 명령과 같은 자격 증명, 모델(`models.yml`과 확장 제공업체 포함), 설정을 사용하며 브로커가 설정되어 있으면 브로커를, 아니면 로컬 저장소를 사용합니다. 요청과 응답은 JSON 줄입니다.

```
→ {"id": 1, "path": "/v1/chat/completions", "body": {"model": "@commit,@smol", "messages": [...]}}
← {"ready": true, "version": "18.4.11"}
← {"id": 1, "status": 200, "body": {"object": "chat.completion", "choices": [...]}}
```

- 첫 출력 줄은 `{"ready": true, "version": …}`입니다. 요청에 `body`가 있으면 `method` 기본값은 `POST`, 없으면 `GET`입니다. [엔드포인트](#엔드포인트-1)의 `/healthz`를 제외한 모든 경로를 제공합니다.
- 요청은 동시에 실행되며 완료 순서로 응답합니다. 문자열 또는 숫자 `id`로 대응시킵니다. 요청이 아닌 줄에는 원래 `id`가 있으면 이를 포함해 `400`으로 응답합니다.
- JSON 본문은 JSON으로 포함합니다. 텍스트 본문(`stream: true` 요청의 SSE)은 스트림 종료 후 문자열 하나로, 오디오/동영상 등은 `"encoding": "base64"`와 함께 base64로 제공합니다.
- `model`은 모든 `--model` 선택기를 받습니다. `provider/id`, 퍼지 이름, 역할(`@smol`), 처음 해석되는 항목을 사용하는 쉼표 목록을 지원합니다. 시도가 `400` 초과 상태(`499` 제외)로 실패하면 모델의 `retry.fallbackChains`를 따르며 역할 항목이면 역할의 체인을 사용합니다. 응답의 `model`은 실제 응답한 모델입니다.
- 표준 입력이 끝날 때까지 요청을 처리하고 진행 중인 요청에 응답한 뒤 종료합니다.

### 엔드포인트

| 메서드 | 경로 | 인증 | 용도 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 없음 | 생존 상태와 버전 |
| `GET` | `/v1/usage` | Bearer | `UsageReport[]` 집계(`AuthStorage`를 통해 프록시) |
| `GET` | `/v1/models` | Bearer | 자격 증명이 있는 제공업체로 필터링한 레지스트리 카탈로그 |
| `GET` | `/v1/credentials/check` | Bearer | 자격 증명별 인증 상태 검사 |
| `POST` | `/v1/chat/completions` | Bearer | OpenAI Chat Completions 전송 형식 |
| `POST` | `/v1/messages` | Bearer | Anthropic Messages 전송 형식 |
| `POST` | `/v1/responses` | Bearer | OpenAI Responses 전송 형식 |
| `POST` | `/v1/pi/stream` | Bearer | 네이티브 `pi-ai` 스트림 전송 형식 |
| `POST` | `/v1/systemone` | Bearer | TypeSafe System One 판정(`typesafe/jev-latest` 등의 `judge` 모델). `/alpha/decisions`는 OpenRouter Decisions 별칭 |
| `POST` | `/v1/images/generations` | Bearer | 이미지 생성, OpenAI Images JSON 형식. `/v1/images`는 OpenRouter 별칭(`image` 모델) |
| `POST` | `/v1/images/edits` | Bearer | 이미지 편집: OpenAI multipart 또는 OpenRouter JSON 입력 이미지 |
| `POST` | `/v1/audio/speech` | Bearer | 텍스트 음성 변환, OpenAI/OpenRouter JSON 형식. 원본 오디오 바이트 반환(`tts` 모델: `xai-tts`, `openai-speech`) |
| `POST` | `/v1/audio/transcriptions` | Bearer | 음성 텍스트 변환, OpenAI multipart `file` 또는 OpenRouter JSON `input_audio` base64(`openai-transcriptions`의 `stt` 모델, 최대 25MiB) |
| `POST` | `/v1/embeddings` | Bearer | 임베딩, OpenAI 형식(`openai-embeddings`의 `embedding` 모델, OpenAI + OpenRouter, 최대 8MiB) |
| `POST` | `/v1/rerank` | Bearer | 재정렬, OpenRouter 형식(`openrouter-rerank`의 `rerank` 모델) |
| `POST` | `/v1/videos` | Bearer | 동영상 생성 작업 제출, OpenRouter 형식(`openrouter-video`의 `video` 모델). 게이트웨이가 다시 쓴 폴링/콘텐츠 URL과 함께 `202` 반환 |
| `GET` | `/v1/videos/:id` | Bearer | 동영상 작업 조회. 게이트웨이가 발급하는 무상태 `:id`는 제공업체, 모델, 업스트림 작업 ID를 인코딩 |
| `GET` | `/v1/videos/:id/content` | Bearer | 업스트림 콘텐츠 타입으로 완성된 동영상 바이트 스트리밍 |

`POST /v1/systemone`에서 TypeSafe 모델은 TypeSafe 인라인 `assets` 형식을 받습니다(`data_base64`만 지원, multipart `part` 자산은 거부). 모든 자산은 `state`, `instructions`, `criteria`에서 참조해야 하며 다른 네이티브 API는 이 형식에 `422`를 반환합니다. 호환 백엔드에서는 기존 `images` 필드도 사용할 수 있으나 인라인 데이터만 허용합니다. 예: `images: [{type:'image',data:'<base64>',mimeType:'image/png',detail:'high'}]`. 파일 경로는 지원하지 않습니다. 이미지 데이터는 유효한 패딩과 정규 마지막 비트를 갖춘 비어 있지 않은 표준 base64여야 하며 패딩은 생략할 수 있습니다. 선택적 `detail`은 `auto`, `low`, `high`, `original` 중 하나여야 합니다. 잘못된 이미지 필드나 이미지 입력을 지원하지 않는 판정 모델에 보낸 이미지는 제공업체 자격 증명 조회나 업스트림 요청 전에 `422`를 반환합니다. 이미지를 알림 없이 버리지 않습니다.

`POST /v1/images/generations`(및 별칭 `/v1/images`)과 `POST /v1/images/edits`의 이미지 입력은 비어 있지 않은 정규 base64 데이터(패딩 생략 가능)와 문법적으로 유효한 이미지 MIME 타입을 포함해야 합니다. 데이터 URL은 `#`를 담을 수 없으므로 해당 문자가 있는 MIME 타입을 거부합니다. multipart 파일 타입에는 허용하지만 이미지를 데이터 URL로 받는 제공업체는 이를 거부합니다. 게이트웨이 Bearer 인증 이후 잘못된 입력은 제공업체 자격 증명 조회나 갱신 전에 `400 invalid_request_error`를 반환합니다. 지원 이미지 형식은 제공업체마다 다릅니다.

외부 전송 형식에서는 최상위 `model` 필드에서, `/v1/pi/stream`에서는 pi-native 요청 본문에서 모델 ID를 읽습니다. 제공업체가 붙은 ID(`typesafe/jev-latest`)나 단독 ID(`jev-latest`)를 사용할 수 있습니다. 게이트웨이는 브로커에 자격 증명이 있으며 경로가 제공되는 종류(`chat`, `judge`, `image`, `tts`, `stt`, `embedding`, `rerank`, `video`)의 모든 레지스트리 모델로 구성된 카탈로그에서 모델을 결정합니다. 수신 형식을 파싱하고 브로커 기반 `AuthStorage`에서 자격 증명을 결정한 뒤 해당 `pi-ai` 클라이언트로 전달합니다. 채팅은 `streamSimple()`, 판정은 모델 고유 판정 API(예: OpenAI Decisions)로 변환하는 `NativeJudge`, 모달리티 경로는 `generateImage` / `synthesizeSpeech` / `transcribeAudio` / `embed` / `rerank` / `submitVideo`를 사용합니다. 결과는 수신 형식으로 다시 인코딩합니다(스트리밍 채팅 응답은 SSE).

채팅 경로는 채팅 이외 모델에 사용할 경로를 명시한 `400`을 반환합니다(`Model typesafe/jev-latest is a judge model; use POST /v1/systemone`). `GET /v1/models`는 이런 행에 `kind`(`judge` | `image` | `tts` | `stt` | `embedding` | `rerank` | `video`)를 표시하며 없으면 채팅입니다.

제공 카탈로그에는 번들, 캐시, 브로커 검색 모델이 포함됩니다. 호스트의 `models.yml` 재정의/사용자 지정 모델은 무시하여 로컬 기본 URL, 헤더, 키가 브로커 기반 트래픽을 다른 곳으로 보내지 못하게 합니다. 게이트웨이 유효 설정(`auth.accountPolicies`를 제공하는 동일한 `config.yml`)의 `disabledProviders`에 있는 제공업체는 검색/공개/라우팅하지 않습니다. `serve`는 이 계정을 `/v1/usage`와 `/v1/credentials/check`에서 제외하고 `check`도 건너뜁니다. 카탈로그는 15분마다 다시 만들고 자격 증명 변경은 10초마다 확인합니다. 변경 시 온라인 검색을 강제합니다. 제공업체가 붙은 ID는 명확하며 단독 ID는 첫 일치 항목을 사용합니다. 모델 목록에는 `api`, `display_name`, `input_modalities`, 제공되는 `context_length`/`max_output_tokens`도 포함하며, 카탈로그가 도구 미지원을 명시한 경우에만 `supports_tools: false`를 포함합니다.

실시간 OpenRouter 검색은 이미지/Decisions 목록, `/embeddings/models`, `/videos/models`, `/models`의 재정렬 표시 행을 다룹니다. 음성/전사 모델은 카탈로그 종류와 초기 목록을 사용합니다. 번들 대체 목록과 `kind-apis` 실행기 매핑은 `packages/catalog/src/compat/rules/providers/openrouter.kdl`에 정의합니다. 검색별/초별/문자별 과금에는 카탈로그 비용 축이 없으므로 해당 행의 토큰 비용은 0이며 응답의 제공업체 보고 `cost`가 기준입니다.

추론 경로는 `x-omp-install-id`, `x-omp-hostname`, `x-omp-app`에 관측 사용량을 귀속합니다. 표시가 없는 요청은 게이트웨이 호스트의 식별 정보를 사용합니다. 이 귀속 헤더는 업스트림에 전달하지 않습니다. 완료된 비스트리밍 응답은 비용을 알면 `x-litellm-response-cost`에 계산된 비용을 포함합니다. 스트리밍 채팅은 사용량이 오기 전에 헤더를 보내므로 비용 헤더를 포함하지 않습니다. 동영상 비용은 폴링 중에야 확인될 수 있습니다. 토큰만 보고하는 업스트림(TypeSafe)은 카탈로그 모델로 가격을 계산하며 응답 본문의 `cost`(OpenRouter 형식)는 업스트림이 과금한 경우에만 존재합니다.

기본 URL 해석기를 쓰는 TypeSafe 클라이언트는 `TYPESAFE_BASE_URL=http://gateway:4000`과 `TYPESAFE_API_KEY=<gateway token>`을 설정할 수 있습니다. omp의 카탈로그 기반 `judge` 역할은 환경 대체값보다 우선하는 모델의 명시적 `baseUrl`을 전달합니다. 게이트웨이를 사용하려면 `models.yml`에서 TypeSafe 제공업체의 `baseUrl`과 `apiKey`를 설정하세요. OpenAI SDK 형식 클라이언트는 `http://gateway:4000/v1`을 사용합니다.

원본 제공업체 요청을 그대로 통과시키는 경로는 없습니다. 모든 지원 경로는 `pi-ai` 제공업체 로직을 거쳐 자격 증명별 요청 구성, 인증 오류 시 OAuth 갱신, 제공업체 특이 동작을 중앙화합니다.

기반 `Bun.serve`의 `idleTimeout`은 `255 s`로 설정하여 긴 추론 예산 호출이 Bun 기본 유휴 시간 제한으로 종료되지 않도록 합니다.

## 사용량 캐시: 서버 측 5분 지터 + 클라이언트 측 15초 단일 실행

집계 제공업체 사용량 보고서를 두 계층으로 캐시합니다. 두 계층은 의도적으로 함께 사용합니다.

### 서버 측 캐시(브로커 `AuthStorage`)

`AuthStorage`는 자격 증명별 성공한 `UsageReport`를 브로커 SQLite 저장소에 **5분 TTL과 ±25% 지터**로 캐시하여 업스트림 검사를 분산합니다. 정상 캐시값은 마지막 성공 조회(`fetchedAt`) 이후 24시간 유지됩니다. 조회가 실패하면 일반적으로 마지막 정상 보고서를 유지하고 짧은 지터 대기(기본 10초)를 적용하며 제공업체가 정책을 재정의할 수 있습니다. 반복 실패가 24시간 창을 늘리지는 않습니다. 이후에는 조회가 성공할 때까지 사용량을 보고하지 않습니다. 확정적인 인증 실패(사용량 제공업체가 발생시킨 401/403)는 오래된 사용량을 지우며 명시적 무효화는 무효화한 마지막 정상 데이터를 재사용하지 않습니다.

상수: `packages/ai/src/auth/sqlite-credential-store.ts`의 `USAGE_REPORT_TTL_MS = 5 * 60_000`, `packages/ai/src/auth/usage-cache.ts`의 `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000`, `USAGE_FAILURE_BACKOFF_MS = 10_000`. 조회 정책은 `packages/ai/src/auth/usage.ts`에 있습니다.

### 클라이언트 측 단일 실행(`RemoteAuthCredentialStore`)

게이트웨이 또는 다른 브로커 클라이언트가 `fetchUsageReports()` / `getUsageReport(provider, credential)`을 호출하면 `RemoteAuthCredentialStore`는 동시 호출을 단일 `GET /v1/usage` 왕복으로 합치고 결과를 메모리에 **15초** 캐시합니다.

- `USAGE_CACHE_TTL_MS = 15_000`(`packages/ai/src/auth-broker/remote-store.ts`).
- 단일 `#usageInflight` 프로미스를 모든 호출자가 공유합니다. 호출자별 `AbortSignal`은 공유 프로미스에 전달하지 않고 **경쟁 대기**하므로 한 호출자의 취소가 다른 호출자의 진행 중 요청을 취소하지 않습니다.
- 조회 실패 시 오류를 기록하고 `null`을 15초 캐시하여 연속 호출이 실패한 브로커를 즉시 재시도하지 않게 합니다. 집계 사용량은 `null`을 반환하지만 자격 증명별 조회는 최신 클라이언트 관측 헤더 보정값을 사용할 수 있습니다.
- 최신 제공업체 응답 헤더 힌트는 최대 15초 동안 일치하는 보고서에 덧씌웁니다.

클라이언트 캐시 기간은 브로커의 자격 증명별 캐시보다 짧으며 `CredentialSelector`(`packages/ai/src/auth/select.ts`)가 사용하는 사용량 조회를 브로커 왕복 한 번으로 합칩니다.

## 클라이언트 스냅샷 캐시

`discoverAuthStorage()`는 `packages/ai/src/auth-broker/discover.ts`에 위임합니다. 기본적으로 최초 실시간 스냅샷과 이후 브로커 전체 스냅샷을 `~/.omp/cache/auth-broker-snapshot.enc`에 저장합니다. 환경/구성/파일에서 결정된 브로커 Bearer 토큰의 SHA-256으로 AES-256-GCM 암호화하고 브로커 URL 및 캐시 형식 메타데이터로 인증합니다. 토큰이나 URL이 바뀌면 캐시를 읽을 수 없습니다. 쓰기는 `0600` 모드로 원자적으로 수행합니다.

최신성은 로컬 기록 시각이 아니라 `snapshot.generatedAt`을 기준으로 합니다. 기본 TTL은 1시간(`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`)이며 `0`은 캐시 읽기/쓰기를 끕니다. 유효한 캐시는 차단형 재검증이나 시작 요청 예산 없이 즉시 사용합니다. 이후 `RemoteAuthCredentialStore`가 백그라운드 SSE/롱 폴링으로 동기화하므로 일회성 명령에서 캐시 기록 후 변경을 반드시 확인하는 것은 아닙니다. 브로커 토큰 폐기는 캐시 기반 시작을 즉시 실패시키는 대신 이 백그라운드 경로에서 드러날 수 있습니다. 만료된 OAuth 액세스 토큰에는 여전히 브로커 갱신 엔드포인트가 필요합니다.

시작 시 브로커가 중단되어도 유효한 캐시가 있으면 캐시로 시작합니다. 캐시가 없거나 만료/손상/비호환 상태이거나 다른 URL용이거나 다른 토큰으로 암호화되었다면 실시간 스냅샷이 필요하며 조회 실패 시 시작도 실패합니다. 알림 없이 로컬 자격 증명 저장소를 대신 열지 않습니다.

<a id="client-account-pools"></a>
<a id="client-account-pools-routing-not-authorization"></a>
## 클라이언트 계정 풀

브로커 클라이언트는 `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`에 JSON 파일을 지정하여 보이는 브로커 자격 증명을 제한할 수 있습니다. 각 키는 제공업체 ID(또는 아래의 `"*"`)이며 값은 해당 제공업체 자격 증명의 규칙입니다.

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

배열은 브로커 스냅샷 프로토콜의 정확한 `identityKey` 값을 나열합니다. `identityKey`는 인증된 `/v1/snapshot`의 각 자격 증명 항목에 이미 포함되는 토큰 없는 식별 필드입니다. 운영 도구는 `provider`와 `identityKey`만 추출해야 하며 함께 오는 자격 증명 페이로드를 보관하거나 출력해서는 안 됩니다. 전용 계정 목록 CLI는 의도적으로 이 라우팅 기능의 범위 밖입니다.

| 값 | 표시되는 OAuth 계정 | 표시되는 API 키 |
| --- | --- | --- |
| `["id", …]` | 조직/워크스페이스 한정자를 포함해 식별자가 정확히 일치하는 계정만 표시. `[]`는 모두 숨김 | 표시 |
| `true` | 모두 | 표시 |
| `false` | 없음 | 숨김 |
| `{ "accounts"?: ["id", …], "apiKeys"?: boolean }` | `accounts`는 배열 형식과 동일하며 생략하면 모두 표시 | `apiKeys`에 따름. 생략하면 표시 |

자체 키가 없는 제공업체는 `"*"` 규칙을 따르며 `"*"`도 없으면 제한하지 않습니다. `"*": false`는 파일을 허용 목록으로 만듭니다. OAuth와 API 키 모두 나열된 제공업체만 보입니다. 예를 들어 다음은 Codex 계정 하나와 OpenRouter API 키만 노출합니다.
```json
{
  "*": false,
  "openai-codex": { "accounts": ["account:acct-123"], "apiKeys": false },
  "openrouter": true
}
```

SDK 호스트는 `discoverAuthStorage()` 또는 `RemoteAuthCredentialStore`의 `accountPool`에 같은 규칙을 제공할 수 있습니다(제공업체 또는 `"*"`를 키로 하는 식별자 `Set` 또는 `{ accounts?: Set, apiKeys?: boolean }`). 명시적인 프로그래밍 방식 풀은 환경 파일보다 우선합니다.

파일은 브로커 기반 인증 저장소 시작 시 한 번 파싱합니다. 읽을 수 없는 파일, 잘못된 JSON, 잘못된 항목은 풀을 알림 없이 넓히지 않고 초기화를 중단합니다. 전체 스냅샷, SSE 갱신, 갱신 응답, 집계 사용량을 일관되게 필터링합니다. OAuth 계정이나 API 키가 제한된 제공업체는 표시되는 OAuth 식별자에 귀속할 수 있을 때만 집계 보고서를 반환합니다. API 키에만 귀속되거나 일치하는 식별 메타데이터가 없는 보고서는 안전하게 거부합니다. 암호화된 스냅샷 캐시는 원본 브로커 스냅샷으로 유지하여 이를 공유하는 신뢰 프로세스가 서로 다른 풀을 적용할 수 있게 합니다.

풀 적용 위치에 따라 보호 범위가 달라집니다.

- **직접 연결하는 브로커 클라이언트:** **신뢰 클라이언트의 라우팅 정책이며 권한 경계가 아닙니다.** 클라이언트는 브로커 Bearer 토큰을 보유하고 로컬 보기를 적용하기 전 원본 응답을 받으며 브로커 엔드포인트를 직접 호출할 수 있습니다.
- **`omp auth-gateway serve` 클라이언트:** 풀은 게이트웨이 프로세스 안에서 실행되며 클라이언트는 게이트웨이 토큰만 가집니다. 풀이 숨긴 자격 증명은 게이트웨이 자격 증명 보기에 없으므로 경로에서 나열/사용/보고할 수 없습니다. 클라이언트가 게이트웨이 호스트 환경, 풀 파일, 브로커 토큰을 읽을 수 없다면 풀은 실질적인 경계입니다.

브로커 토큰을 가진 프로세스가 다른 자격 증명을 가져오지 못하게 해야 한다면 계정 풀이 아닌 서버 측 브로커 권한 제어를 사용하세요.

### 에이전트별 및 세션별 풀

프로세스 전체 풀은 클라이언트에 보이는 계정을 결정하고 세션 풀은 같은 식별 키로 특정 세션을 더 제한합니다. `omp usage accounts`는 프로세스에 보이는 모든 OAuth 계정의 키를 조직 이름과 함께 토큰 없이 나열합니다. 정확한 이름의 작업 에이전트에 풀을 적용하려면 `task.agentAccountPools`를 설정하거나([설정](./settings.md#providers-and-services)), `createAgentSession()`에 `oauthAccountPools`를 전달하거나, `authStorage.sessions.restrict(provider, sessionId, identityKeys)`를 직접 호출하세요. 나열된 제공업체에서 세션은 목록 안의 표시 가능한 OAuth 계정으로만 인증합니다. 선택, 고정, 대체 시도, 교체, 저장된 초기화 복원은 모두 그 안에서 수행합니다. 저장된/런타임/환경 API 키는 사용하지 않으며 사용 가능한 계정이 없으면 다른 계정을 빌리는 대신 요청이 실패합니다. 구성 키(`models.yml`의 `apiKey`, 대개 프록시 `baseUrl`용)도 풀 요청을 실패시키므로 해당 엔드포인트에 풀 OAuth 토큰이 전송되지 않습니다. 빈 목록은 계정을 허용하지 않습니다. 만료가 임박한 저장된 초기화는 풀 적용 여부와 관계없이 모든 계정에서 여전히 복구합니다. 복구는 초기화를 보유한 계정에 도움이 되기 때문입니다. `oauthAccountPools`로 만든 세션은 조회에 담긴 제공업체 세션 ID와 관계없이 모델 레지스트리를 통한 모든 키 조회에 풀을 강제합니다(제목 생성, 스킬 압축, 조언자, 자체 항목 없이 생성한 하위 에이전트 포함). 세션 ID 없는 조회는 세션 자체 ID로 해석합니다. 세션을 해제하면 풀을 해제하며, 실행이 해제 기한을 넘기면 실행 종료 후 해제합니다. `restrict` 직접 호출자는 세션 종료 시 반환받은 임대를 `authStorage.sessions.unrestrict(provider, sessionId, lease)`에 전달해야 합니다. 임대는 이후 같은 세션에 설치된 제한을 해제하지 않습니다. `authStorage.sessions.permits(provider, sessionId, credentialId)`는 저장된 계정이 세션을 처리할 수 있는지 알려줍니다. 세션 풀도 클라이언트 풀과 같은 신뢰 클라이언트 라우팅 정책이며 권한 경계가 아닙니다.

## 운영자 활성화

`OMP_AUTH_BROKER_URL`(또는 에이전트 `config.yml`/`config.yaml`의 `auth.broker.url`)이 없으면 브로커 기반 자격 증명 저장은 **꺼져 있습니다**. SDK 검색은 `packages/coding-agent/src/session/auth-broker-config.ts`를 통해 공유 `pi-ai` 해석기에 위임하고 로컬 SQLite 대신 `RemoteAuthCredentialStore`를 선택합니다. 런타임/구성/환경 키 재정의는 여전히 일반 자격 증명 우선순위에 참여합니다. 브로커 저장소를 선택해도 이 키가 원격 키가 되는 것은 아닙니다.

### 환경 변수

| 변수 | 용도 | 필요한 경우 |
| --- | --- | --- |
| `OMP_AUTH_BROKER_URL` | 원격 인증 브로커 기본 URL(예: `https://broker.tailnet:8765`). 설정하면 브로커 모드로 전환하여 로컬 SQLite를 우회합니다. | omp 클라이언트가 브로커로 자격 증명을 결정해야 할 때. `omp auth-gateway serve`에도 필수 |
| `OMP_AUTH_BROKER_TOKEN` | `/v1/healthz`를 제외한 모든 브로커 엔드포인트용 Bearer 토큰 | URL이 설정되어 있고 `auth.broker.token`이나 `<config-dir>/auth-broker.token`에서 토큰을 얻을 수 없을 때 |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | 암호화된 로컬 스냅샷 캐시 유효 기간. 기본 `3600000`(1시간), `0`이면 캐시 읽기/쓰기 비활성화 | 브로커 모드에서 선택 |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | 암호화된 로컬 스냅샷 캐시 경로 재정의. 기본 `~/.omp/cache/auth-broker-snapshot.enc` 또는 대응 XDG 캐시 경로 | 브로커 모드에서 선택 |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 제공업체별 브로커 자격 증명 표시 규칙 JSON 파일(OAuth `identityKey` 목록, API 키 토글, 미지정 제공업체의 `"*"` 기본값). 한 번 파싱하며 잘못된 파일은 초기화를 중단합니다. | 브로커 모드에서 선택 |

`resolveAuthBrokerConfig()`의 해석 순서:

1. 환경 변수 `OMP_AUTH_BROKER_URL`, 없으면 `config.yml`의 `auth.broker.url`을 `resolveConfigValue`로 해석합니다.
2. 환경 변수 `OMP_AUTH_BROKER_TOKEN`, 없으면 `config.yml`의 `auth.broker.token`, 그것도 없으면 `<config-dir>/auth-broker.token`을 사용합니다.
3. URL은 있지만 토큰을 결정할 수 없으면 토큰 파일 경로를 안내하는 복구 불가 오류를 발생시킵니다.

게이트웨이는 같은 브로커 URL/토큰 해석 및 계정 풀 환경 파일을 사용합니다. `serve`/`check`는 직접 실시간 스냅샷을 가져오므로 클라이언트 스냅샷 캐시 경로/TTL 변수의 영향을 받지 않습니다.

### `config.yml` 키

| 키 | 기본값 | 용도 |
| --- | --- | --- |
| `auth.broker.url` | 미설정 | `OMP_AUTH_BROKER_URL`과 같으며 환경 변수가 우선합니다. 설정 UI에는 숨겨져 있습니다. 값은 리터럴, 환경 변수 이름, 또는 앞뒤 공백을 제거한 표준 출력을 사용하는 `!<shell command>`로 해석합니다. |
| `auth.broker.token` | 미설정 | `OMP_AUTH_BROKER_TOKEN`과 같으며 환경 변수가 우선합니다. 같은 방식으로 값을 해석합니다. |
| `auth.accountPolicies` | `[]` | 계정별 OAuth 라우팅 규칙: `provider`, 식별 선택자 `account`(`email`, `accountId`, `projectId`, 선택적 `orgId`), 선택적 `priority`, `reservePct`(0~100), `reclaimAbovePct`. `reclaimAbovePct`는 계정의 유효 예비량보다 크고 최대 100입니다. 이만큼 할당량이 남으면 우선순위가 낮은 계정에 자동 고정된 세션이 다음 요청에서 돌아옵니다. 명시적으로 선택한 계정은 이동하지 않습니다. |
| `retry.usageReservePct` | `10` | 계정에 `reservePct` 재정의가 없을 때 보호할 기본 잔여 할당량 비율 |

브로커 연결 값은 프로젝트 설정이 아닌 에이전트 주 구성 파일에서 가져옵니다. 계정 정책/예비량은 프로젝트/명시적 구성 계층을 포함한 유효 설정을 사용합니다. 장기 실행 SDK 세션은 정책 변경을 따르며 유효 브로커 설정이 바뀌면 자격 증명 저장소를 제자리에서 교체할 수 있습니다. 변경 실패 시 현재 저장소를 유지합니다.

#### 세션의 계정 선택과 유지 방식

제공업체에 계정 정책이 있으면 OMP는 계정을 선택하거나 재검토할 때 순위를 매깁니다. 매 요청마다 수행하지는 않으며 유효한 명시적 고정이나 단일 계정이면 생략합니다. 순서대로 차단(제한 도달), 필수 요금제 불충족, 갱신 가능 허용량 소진, 예비량 진입 계정이 불리합니다. 그다음 5시간 창을 아직 쓰지 않은 Codex 계정을 우선하고, 5시간 창을 85% 이상 사용한 계정은 뒤로 보냅니다. 사용량 보고서가 있는 계정이 조회 실패 계정보다 우선하며 그 후에야 높은 `priority`가 우선합니다. 동률이면 사용하지 않을 경우 할당량이 가장 빨리 만료되는 계정을 택합니다. 즉 `priority`는 정상이며 측정된 계정의 순서를 정할 뿐 예비량이나 앞선 안전 검사를 무시하지 않습니다.

이 순위는 **새** 세션의 계정을 고릅니다. 실행 중인 세션은 마지막 계정(고정)을 기억하고 고정이 유효한 동안 유지하여 제공업체 프롬프트 캐시와 서명된 추론을 보존합니다.

- Anthropic 고정은 요청 없이 한 시간이 지나면 만료되며 다른 제공업체 고정은 무기한 유효합니다. 만료되거나 차단된 고정은 순위를 다시 매깁니다.
- 유효한 고정은 계정 상태가 나쁠 때만 이동합니다. 고정 계정이 예비량에 진입하고 다른 계정은 자체 예비량 밖으로 측정되었거나, 허용량을 소진했고 차단되지 않은 다른 계정에 허용량이 남아 있는 경우입니다.
- 우선순위 높은 계정이 회복되어도 유효한 고정은 돌아가지 않습니다. 새 세션은 회복된 계정을 사용하고 실행 중인 세션은 위 조건이 적용될 때까지 유지합니다.
- 사용자가 세션용으로 명시적으로 선택한 계정은 순위나 예비량 때문에 이동하지 않습니다. 다만 차단 중이거나 토큰 갱신 실패 또는 필수 요금제 검사 실패 시 건너뛰고 다른 계정을 시도합니다.
- 고정은 세션과 함께 저장합니다. 재개한 세션은 원래 마지막 사용 시각과 함께 고정을 복원하고 하위 에이전트는 상위 고정에서 시작합니다. 같은 세션에서 보류된 하위 에이전트를 되살리면 저장된 고정이 상위의 자동 선호보다 우선합니다. 명시적 상위 고정은 하위 계정 풀의 제약 안에서 여전히 우선합니다.

### 토큰 파일

| 경로 | 관리 명령 | 모드 |
| --- | --- | --- |
| `<config-dir>/auth-broker.token` | `omp auth-broker token` 또는 `serve` | `0600`, 새 상위 디렉터리 `0700` |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway token` 또는 `serve`(`--no-auth`이면 생성 생략) | `0600`, 새 상위 디렉터리 `0700` |

`<config-dir>`는 `getConfigRootDir()`입니다. 기본값은 `~/.omp/`이며 `PI_CONFIG_DIR`와 활성 프로필을 따릅니다(기본 프로필 구조에서는 `~/.omp/profiles/<name>/`). 토큰을 생성해도 이미 있는 상위 디렉터리의 권한은 강화하지 않습니다.

## 로컬 API 키 해석 순서와의 상호작용

브로커는 호스트에 기록되거나 API로 업로드된 자격 증명을 소유합니다. [models.md](./models.md)의 표준 자격 증명 우선순위는 유지됩니다.

- `AuthStorage.keys.setConfig()` / `.removeConfig()` / `.clearConfig()`는 구성 키를 관리합니다. 명시적 `models.yml`의 `apiKey`는 `--api-key`를 덮어쓰지 **않으면서** 저장된 OAuth보다 우선합니다. 반면 `setConfig(..., { fallback: true })`는 기본 키 참조를 저장된 OAuth와 `/login` 키보다 낮게 배치합니다. 게이트웨이는 의도적으로 로컬 모델 구성 재정의를 무시합니다.

## 관련 문서

- [`secrets.md`](./secrets.md) — 실제로 유출되는 토큰의 비밀값 가리기(예: 셸 출력의 `OMP_AUTH_BROKER_TOKEN`).
- [`models.md`](./models.md) — 제공업체 인증 해석 순서. 브로커는 저장된 자격 증명 계층을 제공합니다.
- [`environment-variables.md`](./environment-variables.md) — `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`을 포함한 전체 환경 변수 참조.
