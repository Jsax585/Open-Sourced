<a id="mcp-server-and-tool-authoring"></a>
# MCP 서버 및 도구 작성

이 문서는 MCP 서버 정의가 coding-agent에서 호출 가능한 `mcp__*` 도구가 되는 과정과 설정이 잘못되거나 중복되거나 비활성화되거나 인증이 필요할 때 운영자가 알아야 할 동작을 설명합니다.

<a id="architecture-at-a-glance"></a>
## 아키텍처 개요

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> loadAllMCPConfigs supplies scope filters and user enablement suppression
  -> capability loader dedupes by server name and equivalent connection (higher priority wins)
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

<a id="1-server-config-model-and-validation"></a>
## 1) 서버 설정 모델 및 검증

`src/mcp/types.ts`는 MCP 설정 작성기와 런타임에서 사용하는 작성 형식을 정의합니다.

- `stdio`(`type` 생략 시 작성기 기본값): `command` 필수, `args`, `env`, `cwd` 선택
- `http`: `url` 필수, `headers` 선택
- `sse`: `url` 필수, `headers` 선택(기존 HTTP+SSE 전송)
- 공통 필드: `enabled`, `timeout`, `requestIdFormat`(`"number"` 또는 `"string"`), `instructions`(`boolean`, 기본값 `true`), `auth`, `oauth`

`timeout`의 단위는 밀리초이며 기본값은 30,000입니다. `0`은 클라이언트 측 시간 제한을 비활성화합니다. 유효한 `OMP_MCP_TIMEOUT_MS` 환경 값은 서버별 시간 제한보다 우선합니다. `requestIdFormat`과 `instructions`는 OMP 전용입니다. 네이티브 설정, 독립형 MCP JSON, OMP 플러그인은 이를 파싱하지만 다른 도구 형식의 공급자는 일반적으로 파싱하지 않습니다.

`validateServerConfig()`(`src/mcp/config.ts`)는 기본 전송 요건을 적용합니다.

- `command`와 `url`을 함께 설정한 구성 거부
- stdio에 `command` 필수
- http/sse에 `url` 필수
- 알 수 없는 `type` 거부

`config-writer.ts`는 추가/갱신 작업에 이 검증을 적용하며 서버 이름도 검증합니다.

- 비어 있지 않아야 함
- 최대 100자
- `[a-zA-Z0-9_.:-]` 그룹을 공백 하나로 구분. 앞뒤 공백이나 연속 공백은 허용하지 않음(예: `cloudflare:cloudflare-api`, `MaaS Slack`)

연결된 서버의 초기화 지침은 서버가 제어하는 미검증 내용이라는 안내와 함께 시스템 프롬프트의 `MCP Server Instructions` 아래에 추가됩니다. 서버별 텍스트는 최대 4,000자입니다. 해당 서버의 지침 블록을 제외하려면 `instructions: false`를 설정하세요. 도구는 비활성화되지 않습니다.

<a id="transport-pitfalls"></a>
### 전송 방식의 주의점

- 작성기 검증은 `type` 생략을 stdio로 처리하므로 추가/갱신에 `command`가 필요합니다. 반면 기능 검색은 엔드포인트에서 생략된 전송 방식을 추론합니다(`command` → stdio, 아니면 `url` → http). 이 차이를 피하려면 `type`을 명시하세요.
- `sse`는 기존 프로토콜 개정 2024-11-05의 HTTP+SSE 전송을 선택합니다. 지속적인 GET 스트림이 `endpoint` 이벤트를 제공하고 해당 URL이 JSON-RPC POST를 받습니다. `"http"` Streamable HTTP 전송과는 다릅니다.
- 발신 JSON-RPC 요청 ID는 생태계 호환성을 위해 기본적으로 증가하는 숫자를 사용합니다. 기존 snowflake 문자열 동작이 필요한 서버에만 `requestIdFormat: "string"`을 설정하세요. 잘못된 값은 검색 중 경고 후 무시됩니다.
- 검증은 구조만 확인하며 연결 가능 여부는 확인하지 않습니다. 문법적으로 유효한 URL도 연결 시 실패할 수 있습니다.

<a id="2-discovery-normalization-and-precedence"></a>
## 2) 검색, 정규화 및 우선순위

<a id="capability-based-discovery"></a>
### 기능 기반 검색

`loadAllMCPConfigs()`(`src/mcp/config.ts`)는 `loadCapability(mcpCapability.id)`를 통해 표준 `MCPServer` 항목을 로드합니다.

이후 기능 계층(`src/capability/index.ts`)은 다음을 수행합니다.

1. 활성 공급자를 동시에 호출한 뒤 우선순위순으로 취합
2. `server.name`과 의미상 동일한 연결을 기준으로 중복 제거(먼저 나온 항목 = 가장 높은 우선순위)
3. 남은 항목 검증

중복 이름은 병합하지 않습니다. 이름이 다른 정의도 `isSameMCPConnection()`이 전송 입력의 일치를 확인하면 가려질 수 있습니다. 비교 대상은 인증, OAuth, 실제 요청 ID 형식, 그리고 stdio의 command/args/env/literal 키/cwd 또는 원격 URL/headers입니다. 이름, 시간 제한, 지침 설정은 동일한 연결을 구분하지 않습니다.

억제된 서버도 이름을 차지하므로 우선순위가 높은 정의가 비활성화되어 있다고 해서 같은 이름의 낮은 우선순위 서버로 대체되지 않습니다. 다만 이름이 다른 동일한 연결을 가리지는 않습니다. 프로젝트 설정을 비활성화하면 중복 제거 전에 프로젝트 항목을 제외합니다.

<a id="mcpjson-and-related-files"></a>
### `.mcp.json` 및 관련 파일

`src/discovery/mcp-json.ts`의 전용 대체 공급자는 프로젝트 루트의 `mcp.json`과 `.mcp.json`을 읽습니다(낮은 우선순위).

실제로 MCP 서버는 더 높은 우선순위 공급자에서도 제공됩니다(예: 네이티브 `.omp/...`, 도구별 설정 디렉터리). 작성 시 다음을 따르세요.

- 명시적으로 제어하려면 `.omp/mcp.json`(프로젝트) 또는 `<getAgentDir()>/mcp.json`(사용자, 기본값 `~/.omp/agent/mcp.json`)을 권장합니다. 네이티브 사용자 MCP 설정은 활성 프로필을 따릅니다.
- 대체 호환성이 필요하면 루트의 `mcp.json` / `.mcp.json`을 사용하세요.
- 여러 소스에서 같은 서버 이름을 재사용하면 병합되지 않고 우선순위에 따라 가려집니다.

<a id="normalization-behavior"></a>
### 정규화 동작

`convertToLegacyConfig()`(`src/mcp/config.ts`)는 표준 `MCPServer`를 런타임 `MCPServerConfig`로 매핑합니다.

핵심 동작:

- 전송 방식은 `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`로 추론
- `requestIdFormat` 유지. 생략하면 숫자 ID 사용
- 활성 프로필의 사용자 `disabledServers` 목록에 있는 이름은 항상 억제. `enabled === false`인 서버도 같은 사용자 설정의 `enabledServers`에 이름이 없으면 억제
- 선택적 필드는 존재할 때 유지

<a id="environment-expansion-during-discovery"></a>
### 검색 중 환경 변수 확장

OMP 네이티브 MCP 설정(`.omp/mcp.json`, `~/.omp/agent/mcp.json` 및 각각의 `.mcp.json` 변형)은 런타임 설정으로 변환하기 전에 `${VAR}`와 `${VAR:-default}` 자리표시자를 재귀적으로 확장합니다. `enabled`에는 불리언/문자열 형식(`true`, `false`, `1`, `0`), `timeout`에는 숫자 문자열도 허용합니다. `requestIdFormat`은 `"number"` 또는 `"string"`만 허용하며 다른 값은 경고 후 숫자 ID로 대체합니다.

`src/discovery/mcp-json.ts`의 독립형 대체 공급자는 프로젝트 루트의 `mcp.json`과 `.mcp.json`을 읽고 엔드포인트/인증 필드에서 같은 `${...}` 자리표시자를 확장합니다. `enabled`/`timeout`은 문자열을 강제 변환하지 않고 타입을 검사합니다. 두 공급자 모두 유한한 음수가 아닌 시간 제한을 요구하며 `requestIdFormat`과 불리언 `instructions`를 검증합니다.

잘못된 `enabled`/`timeout` 값은 파일 전체를 실패시키지 않고 경고와 함께 무시합니다.

<a id="3-auth-and-runtime-value-resolution"></a>
## 3) 인증 및 런타임 값 결정

`MCPManager.prepareConfig()`/`#resolveAuthConfig()`(`src/mcp/manager.ts`)가 연결 직전 최종 처리를 수행합니다.

<a id="oauth-credential-injection"></a>
### OAuth 자격 증명 주입

`http`/`sse` 서버에서 `auth: { type: "oauth", credentialId: "..." }` 블록은 선택 사항입니다. 명시적 `auth.type: "apikey"`는 OAuth 자격 증명 조회를 비활성화합니다. OMP는 명시된 임의 또는 기존 OAuth 자격 증명 ID가 조회되면 이를 사용합니다. 관리되는 프로필 범위 ID인 `mcp_oauth:profile:<profile>:<url>`은 해당 프로필이 활성 상태이고 URL이 서버의 확장된 URL 또는 리터럴 URL과 일치할 때만 허용됩니다. 불일치는 무시합니다. 허용된 명시적 ID를 찾지 못하거나 `auth` 블록이 없으면 OMP는 확장된 서버 URL과 리터럴 서버 URL에서 결정적으로 생성한 ID로 자격 증명을 찾습니다. 이 URL 기반 자격 증명은 활성 프로필 범위이므로 정의만 공유하는 서버 항목이 프로필마다 별도로 저장된 OAuth 자격 증명을 사용할 수 있습니다.

대소문자를 구분하지 않는 명시적 `Authorization` 헤더가 설정되어 있으면 URL 기반 대체 조회를 억제합니다. `stdio` 서버에는 연결할 URL이 없습니다. 명시된 임의 또는 기존 자격 증명 ID를 찾을 수 있어야 하며 URL 기반 프로필 범위 ID는 무시합니다.

조회에 성공하면:

- `http`/`sse`: `Authorization: Bearer <access_token>` 헤더 주입
- `stdio`: `OAUTH_ACCESS_TOKEN` 환경 변수 주입

자격 증명을 찾지 못하면 OAuth 값을 주입하지 않고 연결합니다. 갱신 또는 자격 증명 조회 실패는 로그에 기록하며 가능하면 기존 액세스 토큰으로 계속 진행합니다.

<a id="headerenv-value-resolution"></a>
### 헤더/환경 변수 값 결정

연결 전에 관리자는 일반적으로 `resolveConfigValue()`(`src/config/resolve-config-value.ts`)로 stdio의 `env` 값과 HTTP/SSE의 `headers` 값을 결정합니다.

- `!`로 시작하는 값 => 10초 제한으로 셸 명령을 실행하고 앞뒤 공백을 제거한 stdout 사용. 성공한 출력은 캐시하고 동시 요청은 실행 하나를 공유하며 실패 후에는 30초 동안 재시도를 유예
- 실패, 시간 초과, 공백만 출력한 명령은 `undefined`를 반환하므로 해당 항목 생략
- 그 외에는 비어 있지 않은 정확한 이름의 환경 변수 값을 사용하고 없으면 리터럴 값 사용. 결정된 값이 비어 있으면 항목 생략

플러그인 출처 정책 표시는 이 동작을 바꿉니다. `envPolicy: "literal"`은 모든 환경 값을 그대로 유지하고 `envLiteralKeys`는 지정한 키를 빈 값까지 포함하여 유지합니다. `headerPolicy: "origin-locked"`는 설정된 헤더를 리터럴로 유지하며 설정된 URL의 오리진으로만 제한합니다. 클라이언트 생성 헤더는 대소문자를 구분하지 않고 우선합니다. 검색은 해당 패키지 형식에 이 표시를 제공하여 일반적인 비밀 명령 값 결정을 패키지 데이터에 적용하지 않습니다.

운영 주의사항: `!` 비밀 명령에 오타가 있으면 헤더/환경 항목이 조용히 제거되어 이후 401/403이나 서버 시작 실패를 일으킬 수 있습니다. 환경 변수 이름에 오타가 있으면 해당 리터럴이 서버에서 의미가 있는지와 무관하게 그대로 전송됩니다.

<a id="4-tool-bridge-mcp---agent-callable-tools"></a>
## 4) 도구 브리지: MCP에서 에이전트 호출 가능 도구로

`src/mcp/tool-bridge.ts`는 MCP 도구 정의를 `CustomTool`로 변환합니다.

<a id="naming-and-collision-domain"></a>
### 이름 지정 및 충돌 범위

도구 이름은 다음과 같이 생성됩니다.

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

규칙:

- 소문자로 변환
- `[a-z0-9_]` 이외의 문자를 `_`로 변경
- 연속 밑줄을 하나로 합치고 앞뒤 밑줄 제거
- 정제 후 아무것도 남지 않는 부분은 `server` 또는 `tool`로 대체
- 도구 이름의 중복 `<server>_` 접두사를 한 번 제거
- 64자를 넘는 이름은 읽을 수 있는 접두사를 유지하고 길이 제한 전 전체 생성 이름의 `Bun.hash()`에서 얻은 36진수 앞 8자에 `_`를 붙여 추가

서로 다른 원래 이름도 같은 식별자로 정제될 수 있습니다(예: `my-server`와 `my.server`는 비슷하게 정제됨). 레지스트리에 삽입하기 전에 `deduplicateMCPToolsByName()`이 원래 `<server-name>\0<tool-name>` 출처 키를 사전식으로 비교해 결정적인 승자 하나를 선택합니다. 패배한 출처는 로그에 기록하고 제외하므로 재연결이나 검색 순서가 소유권을 바꾸지 못합니다.

숫자를 유지하기 전에는 숫자가 있는 서버가 숫자를 제거한 이름을 생성했습니다(`context7` → `mcp__context_query_docs`). 이러한 기존 이름을 키로 하는 사용자 `tools.approval`의 `deny`/`prompt` 정책은 이름이 바뀐 도구에도 계속 적용됩니다(안전하게 거부). 기존 `allow` 항목은 상속되지 않으므로 키를 다시 지정해야 합니다.

<a id="schema-mapping"></a>
### 스키마 매핑

`tool-bridge.ts`는 각 MCP `inputSchema`를 `normalizeSchemaForMCP()`에 통과시킨 뒤 `CustomTool` 스키마로 등록합니다. MCP 도구는 `strict: false`와 승인 등급 `"write"`를 선언합니다. 이는 공급자의 엄격한 출력 문법을 비활성화하며 공유 런타임 인수 검증기를 비활성화하지는 않습니다.

디스패치 전에 공유 도구 인수 검증은 null 자리표시자를 정규화할 때 이미 일치하는 `anyOf`/`oneOf` 분기를 우선합니다. 해당 분기에서 null을 허용하는 필수 속성은 명시적 `null` 값을 유지하며 일치하지 않는 닫힌 분기는 이를 알 수 없는 필드로 제거할 수 없습니다. 분기별 후보 안에서는 제한된 복구 파이프라인으로 null 정리/기본값 대체, 판별자 공백 복구, 스키마 기반 타입 강제 변환을 함께 수행할 수 있습니다. 후보를 허용하는 분기가 없으면 복구 결과를 버립니다. 필수 필드, null을 허용하지 않는 속성, `oneOf` 배타성을 포함한 전체 스키마는 여전히 검증됩니다.

분기 검증은 전체 스키마의 로컬 참조 컨텍스트, 손실성 복구에 대한 추측적 유니온 제한, 식별자 공백 제거에 대한 콘텐츠 상위 항목 보호를 유지합니다. 제한된 복구 라운드는 식별자 공백 제거 같은 후속 정규화로 분기가 유효해지면 null 정리를 다시 검토합니다. 단지 변경되었다는 이유만으로 잘못된 후보를 다음 단계로 넘기지 않습니다.

<a id="outbound-argument-normalization"></a>
### 발신 인수 정규화

실시간 도구나 지연 도구가 `tools/call`을 보내기 전에 브리지는 다음 순서로 호출 인수를 정규화합니다.

1. 최상위의 객체가 아닌 값, `null`, 배열은 빈 인수 객체가 됩니다.
2. MCP 도구 자체 스키마가 하네스 주입 의도 필드 `i`를 선언하거나 제약하지 않으면 제거합니다(스키마 결합자 또는 로컬 참조로 도달한 선언도 포함).
3. MCP 스키마에 선언되어 있지만 `required`에는 없는 속성은 값이 `undefined`, 빈 문자열, 빈 비배열 객체이면 생략합니다. 필수 속성, 선언되지 않은 속성, `0`, `false`, `null`, 배열(빈 배열 포함)은 유지합니다.
4. 중첩 객체와 배열을 재귀적으로 순회하며 문자열 값을 처리합니다. 등록된 파일 기반 내부 URL(`local://`에 한정되지 않음)은 `InternalUrlRouter.locate()`를 거쳐 가능한 경우 실제 파일 시스템 경로가 됩니다. 조회 전에 읽기 선택자를 분리합니다. locator가 `null`을 반환하면 원래 문자열을 유지하고 오류를 내면 `tools/call` 전에 정규화를 중단합니다. `local://`에서는 기존 디렉터리와 세션 루트도 경로로 변환되며 없는 대상은 그대로 둡니다. 잘못된 경로나 범위를 벗어나는 경로, 세션 컨텍스트 부재는 예외를 발생시킵니다.

따라서 서버 작성자는 모델이 생성한 호출의 모든 필드가 서버에 도달한다고 가정하지 말고 정규화된 페이로드를 기준으로 검증해야 합니다.

<a id="execution-mapping"></a>
### 실행 매핑

`MCPTool.execute()` / `DeferredMCPTool.execute()`는 다음을 수행합니다.

- MCP `tools/call` 호출
- 이미지 블록을 유지하면서 텍스트/리소스 콘텐츠 결합
- `serverName`, `mcpToolName`, 원시 콘텐츠, MCP `_meta`, 공급자 메타데이터를 포함한 상세 정보 반환
- 상세 정보에 `structuredContent`를 유지하고 기존 텍스트 블록에 같은 JSON 값이 없으면 fenced JSON 텍스트 블록 추가
- 서버가 보고한 `isError`를 `Error:` 접두사 및 `isError: true`로 매핑
- 재연결 콜백이 있으면 `_meta["mcp/www_authenticate"]`가 포함된 `isError` 결과를 인증 챌린지로 재연결한 뒤 한 번 재시도
- 재시도 가능한 연결 오류에 재연결 및 한 번 재시도. 지연 도구는 최초 연결 조회 실패 후에도 재연결 가능
- 잡힌 전송/런타임 실패를 서버/도구, 전송, 단계, 실패, 재시도 가능 여부, 메시지, 다음 단계 필드가 포함된 `MCP failure`로 표시
- AbortError를 `ToolAbortError`로 변환하여 중단 의미 유지

<a id="5-operator-lifecycle-addeditremove-and-live-updates"></a>
## 5) 운영 수명 주기: 추가/편집/제거와 실시간 갱신

대화형 모드는 `src/modes/controllers/mcp-command-controller.ts`에서 `/mcp`를 제공합니다.

지원 작업:

- `list`
- `add`(마법사 또는 빠른 추가)
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`, `prompts`, `notifications`
- Smithery 검색/로그인/로그아웃 절차

설정 쓰기는 원자적입니다(`writeMCPConfigFile`: 고유 임시 파일 생성 후 이름 변경). 읽기-수정-쓰기 작업은 파일별 잠금을 유지합니다.

전체 다시 로드는 `MCPCommandController.reloadServers()`를 사용합니다.

1. `mcpManager.disconnectAll()`
2. MCP 프롬프트 명령과 기능 파일 시스템 캐시 제거
3. 현재 프로젝트/브라우저 필터와 세션 확장 루트로 `mcpManager.discoverAndConnect()` 실행
4. `session.refreshMCPTools(mcpManager.getTools())`

일부 변경은 해당 서버만 다시 연결하거나 연결을 해제한 뒤 도구를 갱신합니다. `refreshMCPTools()`는 레지스트리 변경을 직렬화하고 관리자 소유 MCP 도구와 확장 소유 MCP 도구를 조정하며 연결된 관리자 도구를 즉시 활성화합니다(해당되는 경우 `xd://` 아래에 마운트). 확장 소유 MCP 도구는 이전 선택 상태를 유지합니다. 변경 사항은 재시작 없이 적용됩니다.

<a id="mode-differences"></a>
### 모드별 차이

- **대화형/TUI 모드**: `/mcp`가 앱 내 사용자 인터페이스를 제공합니다(마법사, OAuth 절차, 연결 상태 텍스트, 즉각적인 런타임 재바인딩).
- **SDK/헤드리스 통합**: `discoverAndLoadMCPTools()`(`src/mcp/loader.ts`)가 관리자, 로드된 도구, 서버별 오류, 연결된 서버 이름, 추출한 Exa 키를 반환합니다. `/mcp` 명령 인터페이스는 없습니다. 연결이 백그라운드에서 계속되는 동안 캐시된 정의를 지연 도구로 반환할 수 있습니다.

<a id="6-user-visible-error-surfaces"></a>
## 6) 사용자에게 표시되는 오류

사용자/운영자가 흔히 보게 되는 오류 문자열:

- 추가/갱신 검증 실패:
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- 빠른 추가 인수 문제:
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- 연결/테스트 실패:
  - `Failed to connect to "<name>": <message>`
  - 시간 초과 도움말은 시간 제한을 늘리도록 안내
  - `401/403`에 대한 인증 도움말
- 인증/OAuth 절차:
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- 비활성 서버 사용:
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

검색 중 잘못된 소스 JSON은 일반적으로 경고/로그로 처리합니다. 설정 작성기 경로는 명시적 오류를 발생시킵니다.

<a id="7-practical-authoring-guidance"></a>
## 7) 실용적인 작성 지침

이 코드베이스에서 견고한 MCP 구성을 작성하려면:

1. 모든 MCP 지원 설정 소스 전체에서 서버 이름을 고유하게 유지하세요.
2. 생성되는 `mcp__` 충돌을 피하려면 MCP 도구 이름 정제 후에도 서로 구분되는 이름을 권장합니다.
3. 의도치 않은 stdio 기본값을 피하려면 `type`을 명시하세요.
4. 검색된 서버의 `enabled: false`를 재정의하려면 활성 프로필의 사용자 `enabledServers` 목록을 사용하세요. 이름이 두 목록에 모두 있으면 `disabledServers`가 항상 우선합니다.
5. 원격 OAuth 서버에서 유효한 명시적 `credentialId`는 선택 사항입니다. 정의만 있는 `http`/`sse` 항목은 같은 URL에 연결된 활성 프로필의 자격 증명을 사용할 수 있습니다. 이 URL 기반 대체 조회를 억제해야 하면 `Authorization` 헤더를 명시하세요.
6. 명령 기반 비밀 값 결정(`!cmd`)을 사용한다면 명령 출력이 안정적이고 비어 있지 않은지 확인하세요.

<a id="implementation-files"></a>
## 구현 파일

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts)
- [`src/mcp/config-writer.ts`](../packages/coding-agent/src/mcp/config-writer.ts)
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts)
- [`src/discovery/mcp-json.ts`](../packages/coding-agent/src/discovery/mcp-json.ts)
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/config/resolve-config-value.ts`](../packages/coding-agent/src/config/resolve-config-value.ts)
- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts)
- [`src/mcp/errors.ts`](../packages/coding-agent/src/mcp/errors.ts)
- [`src/mcp/timeout.ts`](../packages/coding-agent/src/mcp/timeout.ts)
- [`src/mcp/oauth-credentials.ts`](../packages/coding-agent/src/mcp/oauth-credentials.ts)
- [`src/session/session-tools.ts`](../packages/coding-agent/src/session/session-tools.ts)
- [공유 인수 검증](../packages/ai/src/utils/validation.ts)
