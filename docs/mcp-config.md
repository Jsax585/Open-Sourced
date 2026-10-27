<a id="mcp-configuration-in-omp"></a>
# OMP의 MCP 설정

이 가이드는 OMP 코딩 에이전트에서 MCP 서버를 추가하고, 수정하고, 검증하는 방법을 설명합니다.

코드에서 기준이 되는 구현:

- 런타임 설정 타입: `packages/coding-agent/src/mcp/types.ts`
- 설정 기록기: `packages/coding-agent/src/mcp/config-writer.ts`
- 로더 및 검증: `packages/coding-agent/src/mcp/config.ts`
- 독립형 `mcp.json` 탐색: `packages/coding-agent/src/discovery/mcp-json.ts`
- 스키마: `packages/coding-agent/src/config/mcp-schema.json`
- 관리형 자격 증명 조회: `packages/coding-agent/src/mcp/oauth-credentials.ts`
- 이식 가능한 플러그인의 MCP 탐색: `packages/coding-agent/src/discovery/agent-plugins.ts`

<a id="preferred-config-locations"></a>
## 권장 설정 위치

OMP는 여러 도구의 설정(`.claude/`, `.cursor/`, `.vscode/`, `opencode.json` 등)에서 MCP 서버를 찾을 수 있지만, OMP 전용 설정에는 일반적으로 다음 기본 파일 중 하나를 사용하는 것이 좋습니다.

- 프로젝트: `.omp/mcp.json`
- 사용자: `~/.omp/agent/mcp.json`(이름 있는 프로필이 활성화되어 있으면 `~/.omp/profiles/<name>/agent/mcp.json` — [프로필](#profiles) 참조)

기본 제공 설정 공급자는 호환성을 위해 `.omp/.mcp.json`과 `~/.omp/agent/.mcp.json`도 읽지만, OMP는 위의 기본 `mcp.json` 경로에 기록합니다.

이 사용자 경로는 기본값입니다. `PI_CONFIG_DIR`은 홈 설정 루트를 변경하며, `PI_CODING_AGENT_DIR`은 기본 프로필의 에이전트 디렉터리를 재정의할 수 있습니다. 이름 있는 프로필은 이 재정의를 상속하지 않고 자체 에이전트 디렉터리를 결정합니다. 프로젝트 설정은 계속 `.omp/`에 있습니다.

OMP는 프로젝트 루트의 다음 독립형 파일도 대체 설정으로 허용합니다.

- `mcp.json`
- `.mcp.json`

OMP가 설정을 관리하게 하려면 `.omp/mcp.json` 또는 `~/.omp/agent/mcp.json`을 사용하세요. 다른 MCP 클라이언트도 읽을 수 있는 이식 가능한 대체 파일이 필요한 경우에만 루트의 `mcp.json` / `.mcp.json`을 사용하세요.

<a id="imported-tool-configs"></a>
### 다른 도구에서 가져오는 설정

OMP는 현재 다음 도구의 고유 설정 형식도 변환합니다.

- Claude Code: `~/.claude.json`, `~/.claude/mcp.json`, 프로젝트의 `.claude/.mcp.json` / `.claude/mcp.json`
- Codex: `~/.codex/config.toml` 및 `.codex/config.toml`(`[mcp_servers.*]`)
- Gemini CLI: `~/.gemini/settings.json` 및 `.gemini/settings.json`
- OpenCode: `~/.config/opencode/`, 프로젝트 루트, 프로젝트의 `.opencode/`에 있는 `opencode.json` / `opencode.jsonc`(`mcp` 맵)
- Cursor: `~/.cursor/mcp.json` 및 `.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json` 및 `.windsurf/mcp_config.json`
- VS Code: `mcp.servers`를 사용하는 프로젝트 전용 `.vscode/mcp.json`
- MCP 서버를 선언하는 설치된 Claude 마켓플레이스 플러그인, OMP 확장 패키지, 이식 가능한 Agent Plugins(`plugin.json`과 루트의 `mcp.json`)

Claude Code, Codex, Gemini CLI, Cursor, Windsurf에서는 이름이 같은 사용자 항목보다 프로젝트 항목을 먼저 읽습니다. 이는 프로젝트 항목이 활성 프로필의 사용자 항목보다 우선하는 OMP 고유 설정과 동일합니다. 따라서 프로젝트의 `enabled: false`는 이름이 같은 사용자 서버를 비활성화합니다. OpenCode는 계층 간에 각 서버를 심층 병합합니다. 프로젝트 설정은 사용자 설정보다, `.opencode/`는 프로젝트 루트보다, 같은 디렉터리 안에서는 `.jsonc`가 `.json`보다 우선합니다. 일부 필드만 재정의하면 나머지 필드는 하위 계층에서 상속됩니다. 공급자 간 우선순위는 [탐색 및 우선순위](#discovery-and-precedence)에 나와 있습니다.

<a id="profiles"></a>
### 프로필

이름 있는 프로필(`omp --profile <name>` 또는 `OMP_PROFILE`/`PI_PROFILE`)은 사용자 수준의 MCP 설정을 분리합니다. `omp --profile <name> --alias <command>`는 해당 프로필을 선택하는 셸 바로가기를 만듭니다. 프로필이 활성화되면 **사용자** 범위는 기본 디렉터리 대신 해당 프로필의 에이전트 디렉터리로 해석됩니다.

- 기본 프로필: `~/.omp/agent/mcp.json`
- `<name>` 프로필: `~/.omp/profiles/<name>/agent/mcp.json`

탐색, `/mcp` 명령, 설정 기록기는 모두 활성 프로필을 따릅니다. 따라서 프로필에는 **자신의** 사용자 수준 서버만 표시되며, 기본 프로필의 `~/.omp/agent/mcp.json`은 표시되지 않습니다. 프로필에 서버를 추가하려면 해당 프로필로 실행한 뒤(`omp --profile <name>`) `/mcp add` → 사용자 수준을 선택하거나, `~/.omp/profiles/<name>/agent/mcp.json`을 직접 편집하세요.

프로젝트 범위 MCP 설정(`.omp/mcp.json`)은 프로필이 아니라 작업 디렉터리를 기준으로 하므로 모든 프로필에 적용됩니다. 외부 도구의 설정(`.claude/`, `.cursor/` 등)도 OMP 프로필이 아닌 해당 도구에 속하므로 프로필과 무관합니다.

MCP에도 다른 OMP 고유 설정과 동일한 프로필 규칙이 적용됩니다. [설정 탐색 → 프로필](./config-usage.md#profiles)을 참조하세요.

<a id="add-a-schema-reference"></a>
## 스키마 참조 추가

편집기에서 자동 완성과 검증을 사용하려면 파일 상단에 다음 줄을 추가하세요.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

이제 `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth` 또는 그 밖의 설정 기록 작업이 OMP 관리 MCP 파일을 만들거나 갱신할 때 OMP가 이 참조를 자동으로 기록합니다.

<a id="file-shape"></a>
## 파일 구조

OMP는 다음 최상위 구조를 지원합니다.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

최상위 키:

- `$schema` — 도구 지원을 위한 선택적 JSON Schema URL
- `mcpServers` — 서버 이름을 서버 설정에 연결하는 맵
- `disabledServers` — 활성 프로필의 사용자 차단 목록. 원본 항목의 `enabled` 값에 관계없이 해당 이름으로 발견된 서버를 숨깁니다.
- `enabledServers` — 활성 프로필의 사용자 허용 목록. 원본이 `enabled: false`인 동일 이름의 항목을 강제로 활성화할 수 있지만, `disabledServers`가 여전히 우선합니다.

설정 기록기는 문자, 숫자, `_`, `-`, `.`, `:` 및 공백이 아닌 이름 구간 사이의 단일 공백으로 이루어진 최대 100자의 이름을 허용합니다. 번들 스키마의 이름 패턴에는 콜론과 공백이 빠져 있으므로, `cloudflare:cloudflare-api`나 `MaaS Slack` 같은 이름은 런타임에서 유효하더라도 편집기에서 스키마 오류로 표시될 수 있습니다.

<a id="supported-server-fields"></a>
## 지원하는 서버 필드

모든 전송 방식에 공통으로 적용되는 필드:

- `enabled?: boolean` — `false`이면 이 서버를 건너뜁니다. 단, 활성 프로필의 사용자 `enabledServers` 허용 목록에 이름이 있으면 예외입니다.
- `timeout?: number` — 밀리초 단위 MCP 요청 제한 시간. `0`이면 클라이언트 측 MCP 시간 제한을 비활성화합니다.
- `requestIdFormat?: "number" | "string"` — 발신 JSON-RPC 요청 ID의 인코딩 방식. 기본값은 전송 방식별 정수입니다. `"string"`은 충돌에 강한 Snowflake ID를 사용합니다. 이 OMP 전용 필드는 OMP 고유 파일, 루트의 `mcp.json` / `.mcp.json`, OMP 확장 패키지에서만 읽습니다. 다른 도구에서 변환한 설정에서는 무시됩니다.
- `instructions?: boolean` — 서버가 제공하는 지침을 시스템 프롬프트에 포함합니다(기본값: `true`). 해당 서버의 도구는 비활성화하지 않고 지침만 제외하려면 `false`로 설정하세요. `requestIdFormat`과 마찬가지로 OMP 전용이며, 다른 도구에서 변환한 설정에서는 무시됩니다.
- `auth?: { ... }` — 저장된 자격 증명의 메타데이터. 관리형 자격 증명 주입은 OAuth에 대해 구현되어 있습니다.
- `oauth?: { ... }` — 인증/재인증 중 사용하는 명시적 OAuth 클라이언트 및 콜백 설정

서버의 지침이 도구 정책과 충돌하거나 하위 에이전트 요청을 포함한 모든 요청에 원치 않는 문맥을 추가한다면 지침을 비활성화하세요. 연결된 서버 중 지침을 제공하는 서버가 없으면 MCP 서버 지침 섹션 전체가 생략됩니다. `instructions`는 연결을 구분하는 기준이 아닙니다. 이름이 다른 두 항목이 같은 엔드포인트를 나타내면 우선순위가 높은 항목과 그 항목의 `instructions` 값만 유지됩니다. 따라서 우선하는 항목에 이 옵션을 설정하세요(`/mcp list` 참조). 값을 변경하면 `/mcp reload` 후 이미 연결된 서버에도 적용됩니다.

`OMP_MCP_TIMEOUT_MS`는 프로세스 전체에서 모든 서버별 `timeout`보다 우선합니다. 클라이언트 측 시간 제한을 비활성화하려면 `0`으로, 제한 시간을 지정하려면 `120000` 같은 양의 밀리초 값으로 설정하세요. 설정되지 않았거나 유효하지 않으면 OMP는 서버 값을 사용하고, 그다음 30초 기본값을 사용합니다. 유효하지 않은 값은 로그에 기록하고 무시합니다.

Claude 마켓플레이스 플러그인은 [Claude Code의 서버별 시간 제한 규칙](https://code.claude.com/docs/en/mcp)을 따릅니다. 플러그인의 `.mcp.json` 값은 밀리초 단위이며, `1000` 미만의 값은 탐색 경고와 함께 무시되어 OMP의 일반적인 시간 제한 대체 규칙이 적용됩니다. 이 제약은 OMP 고유 설정에는 영향을 주지 않으므로, 해당 설정에서는 여전히 `0`으로 시간 제한을 비활성화할 수 있습니다.

이 요청 제한 시간은 부모 연결을 빌려 사용하는 하위 에이전트의 MCP 호출에도 적용됩니다. 프록시는 별도의 시간 제한을 추가하지 않으며, 호출자가 취소하면 하위 에이전트의 대기도 중단됩니다.

초기 MCP 탐색은 250ms 대기 후 반환되며, 더 느린 연결은 백그라운드에서 계속 진행됩니다. 이 대기 시간을 변경하려면 `mcp.startupTimeoutMs`를 설정하거나 `OMP_MCP_STARTUP_TIMEOUT_MS`로 재정의하세요. `0`이면 초기 연결 시도가 모두 완료될 때까지 기다립니다. 출력 모드(`-p`, `--mode text|json`)에서는 첫 턴 전에 설정된 모든 서버가 도구를 로드하거나 실패할 때까지 추가로 기다리며, 최대 대기 시간은 `OMP_MCP_TIMEOUT_MS`입니다(기본값 30초). `OMP_MCP_TIMEOUT_MS=0`은 이 준비 대기의 시간 제한도 비활성화하므로, 응답하지 않는 서버 때문에 출력 모드가 무기한 멈출 수 있습니다. 제한 시간까지 사용할 수 없는 서버의 이름은 stderr에 출력됩니다. 대신 `OMP_MCP_REQUIRE_READY=1`을 설정하면 턴 시작 전에 종료 코드 1로 종료합니다. 이러한 출력 모드의 대기는 대화형, RPC, ACP 시작에는 영향을 주지 않습니다. MCP 서버에 백그라운드로 연결하는 대화형 및 `--mode rpc-ui` 세션에서는 첫 턴이 MCP 시작을 최대 1.5초 동안 기다립니다. 따라서 그때까지 연결된 서버는 첫 턴의 시스템 프롬프트에 포함되며, 더 느린 서버는 나중에 등록되어 다음 턴의 프롬프트를 변경합니다.

클라이언트가 생성한 원격 프로토콜 헤더는 대소문자 구분 없이 설정된 헤더보다 우선합니다. Streamable HTTP가 `MCP-Protocol-Version`을 관리합니다. 설정에 있는 같은 헤더는 무시하고 초기화 후 협상된 버전을 전송합니다. 이식 가능한 Agent Plugins에 설정된 헤더는 원본 출처에 고정되며, 리디렉션 시 다른 출처로 전달되지 않습니다.

원격 HTTP 및 SSE 전송은 별도의 소켓 유휴 시간 제한을 두지 않습니다. 적용되는 MCP 제한 시간이 없으면 아무 응답이 없는 연결을 무기한 기다릴 수 있습니다. 중단하려면 호출을 취소하거나 전송 연결을 닫으세요. 스트림이 조용하다는 사실만으로 상대가 여전히 도달 가능한 상태임을 알 수는 없습니다.

<a id="stdio-transport"></a>
### `stdio` 전송

직접 전달한 런타임 설정과 설정 기록기는 `type`이 생략되면 기본값으로 `stdio`를 사용합니다. 탐색 시에는 URL만 있는 항목을 `http`로, 명령이 있는 항목을 `stdio`로 추론합니다. 이식 가능하고 스키마에 맞는 설정을 작성하려면 `type`을 명시하세요.

필수:

- `command: string`

선택 사항:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

예:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

이는 공식 Filesystem MCP 서버 패키지(`@modelcontextprotocol/server-filesystem`)를 사용합니다.

<a id="http-transport"></a>
### `http` 전송

필수:

- `type: "http"`
- `url: string`

선택 사항:

- `headers?: Record<string, string>`

예:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

이는 GitHub가 호스팅하는 GitHub MCP 서버 엔드포인트와 일치합니다.

<a id="sse-transport"></a>
### `sse` 전송

필수:

- `type: "sse"`
- `url: string`

선택 사항:

- `headers?: Record<string, string>`

예:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

호환성을 위해 `sse`를 계속 지원하지만, 현재 MCP 사양은 새 서버에 Streamable HTTP(`type: "http"`)를 권장합니다.

<a id="auth-fields"></a>
## 인증 필드

OMP는 인증과 관련된 두 객체를 인식합니다.

<a id="auth"></a>
### `auth`

```json
{
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

관리형 OAuth에서 `auth`는 저장된 자격 증명을 찾고 갱신하는 방법을 OMP에 알려줍니다. `"apikey"`도 `type` 값으로 허용되지만, 인증 저장소에서 API 키를 로드하거나 주입하지는 않습니다. API 키는 stdio의 `env` 또는 원격 연결의 `headers`에 직접 넣으세요. 아래에서 설명하는 환경 변수 또는 `!command` 간접 참조를 사용하는 것이 좋습니다.

일반적으로 이 블록을 직접 작성할 필요는 없습니다. OMP가 `http`/`sse` 서버의 OAuth 흐름을 완료하면 활성 프로필과 서버 URL에서 결정적으로 생성한 ID(`mcp_oauth:profile:<profile>:<url>`)로 자격 증명을 저장하며, 갱신에 필요한 정보도 함께 보관합니다. 같은 URL을 가리키는 모든 설정은 활성 프로필 자체의 자격 증명을 자동으로 찾아 사용합니다. 여기에는 `auth` 블록 없이 공유 프로젝트의 `mcp.json`에 서버 _정의만_ 포함된 항목도 해당하며, 인증 저장소가 공유 인증 브로커를 사용해도 마찬가지입니다. 이 덕분에 프로젝트 범위 서버를 여러 프로필에서 안전하게 사용할 수 있습니다. 정의를 커밋하면 각 프로필이 `/mcp reauth <name>`으로 자신의 계정을 인증하고 그 계정의 로그인 상태를 유지합니다. 명시적인 `credentialId`도 해석할 수 있으면 그대로 사용합니다. 다만 다른 프로필의 행을 가리키면 프로필 범위의 URL 기반 연결로 대체합니다.

정의만 있는 항목에서 `/mcp reauth`를 실행하면 파일은 변경되지 않습니다. 자격 증명은 갱신 정보를 포함해 전부 활성 프로필의 인증 저장소(로컬 `agent.db` 또는 브로커)에 있으므로, 커밋된 프로젝트 설정에 로컬 인증 상태가 섞이지 않습니다. `Authorization` 헤더를 명시적으로 설정하면(대소문자 구분 없음) 자동 URL 기반 대체 조회가 비활성화됩니다. 명시적으로 지정한 `auth.credentialId`가 해석되면 여전히 관리형 OAuth를 제공하고 해당 헤더를 대체할 수 있습니다.

이 연결은 프로필별이지만 프로젝트별은 아닙니다. 프로필이 URL을 한 번 인증하면, `mcp.json`에서 해당 URL의 서버를 정의하는 _모든_ 체크아웃이 그 프로필의 자격 증명으로 자동 연결됩니다. 커밋된 MCP 정의는 신뢰할 수 있는 입력으로 취급됩니다. 임의의 명령을 실행하는 `stdio` 항목에도 이미 같은 원칙이 적용됩니다. 따라서 중요한 자격 증명이 있는 프로필로 저장소를 열기 전에 그 저장소의 `mcp.json`을 검토하거나, 신뢰할 수 없는 체크아웃에는 전용 프로필을 사용하세요.

<a id="oauth"></a>
### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "scope": "optional space-separated scopes",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

MCP 서버에 명시적인 OAuth 클라이언트, 범위 또는 콜백 설정이 필요하면 `oauth`를 사용하세요. 콜백 리스너의 기본값은 포트 `3000`, 경로 `/callback`입니다. HTTP 루프백 `redirectUri`는 명시적으로 재정의하지 않는 한 자체 포트와 경로를 제공합니다. HTTPS 루프백 리디렉션에는 TLS 종료 지점 뒤의 로컬 HTTP 리스너를 위한 별도의 `callbackPort`가 필요합니다.

`/mcp reauth` 중에는 보호된 리소스나 해당 리소스의 인증 챌린지가 알리는 범위가 우선하며, `oauth.scope`는 대체값으로 사용됩니다. 인가 서버의 `scopes_supported`는 사용 가능한 범위의 목록이지, 이를 모두 부여하라는 요청이 아닙니다. OMP는 이 목록을 로그인 요청에 복사하지 않습니다. 리소스가 범위를 알리지 않으면 `oauth.scope`를 등록된 클라이언트에 허용된 범위로 설정하거나(예: OpenID Connect 로그인의 `"openid"`), 설정하지 않아 인가 서버의 기본값을 사용하세요.

리소스 서버가 제공하는 `/oauth/metadata` 및 `/.mcp/auth` 문서의 범위도 중첩된 `oauth`, `authorization`, `auth` 블록을 포함하여 유지됩니다. 명시적으로 식별된 인가 서버에서 이 경로들을 조회하는 경우, 문서의 `scopes_supported` 배열은 리소스의 요구 사항으로 취급되지 않습니다.

`prompt`는 OAuth의 `prompt` 인가 매개변수를 제어합니다. 기본적으로 OMP는 이를 생략합니다. 단, `offline_access` 범위를 요청한 경우 공급자가 갱신용 접근 권한을 발급할 수 있도록 기본값으로 `"consent"`를 사용합니다. `"consent"`나 `"select_account"`처럼 공급자가 지원하는 값으로 명시적으로 설정하거나, 강제로 생략하려면 `""`로 설정하세요.

예:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Slack 문서에 나오는 관련 엔드포인트:

- MCP 엔드포인트: `https://mcp.slack.com/mcp`
- 인가 엔드포인트: `https://slack.com/oauth/v2_user/authorize`
- 토큰 엔드포인트: `https://slack.com/api/oauth.v2.user.access`

<a id="common-copy-paste-examples"></a>
## 복사해서 사용할 수 있는 일반적인 예제

<a id="filesystem-server-via-stdio"></a>
### stdio를 사용하는 Filesystem 서버

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

<a id="github-hosted-server-via-http"></a>
### HTTP를 사용하는 GitHub 호스팅 서버

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

<a id="github-local-server-via-docker"></a>
### Docker를 사용하는 GitHub 로컬 서버

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

이는 GitHub의 공식 로컬 Docker 이미지 `ghcr.io/github/github-mcp-server`를 사용합니다.

<a id="slack-hosted-server-via-oauth"></a>
### OAuth를 사용하는 Slack 호스팅 서버

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

<a id="secrets-and-variable-resolution"></a>
## 비밀 정보 및 변수 해석

이 부분은 흔히 혼동하기 쉬운 부분입니다.

<a id="discovery-time--expansion"></a>
### 탐색 시 `${...}` 확장

OMP는 OMP 고유 파일과 독립형 대체 파일에서 MCP 설정을 탐색할 때 `${VAR}` 및 `${VAR:-default}` 자리 표시자를 확장합니다. 확장은 `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, `oauth`의 문자열 값에 재귀적으로 적용됩니다. 해석되지 않은 자리 표시자는 리터럴 문자열로 남습니다.

예:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

<a id="pre-connect-envheader-resolution"></a>
### 연결 전 환경 변수 및 헤더 해석

이식 가능한 Agent Plugins는 다른 비밀 정보 처리 규칙을 사용합니다. `${PLUGIN_ROOT}`와 `${PLUGIN_DATA}`만 확장됩니다. 환경 변수와 헤더 값은 빈 문자열을 포함하여 리터럴로 유지되며, `!command`와 단독 환경 변수 이름은 평가되지 않습니다. 공급자가 확장한 마켓플레이스 환경 변수 키도 리터럴로 유지됩니다.

OMP는 stdio 서버를 시작하거나 HTTP/SSE 요청을 보내기 전에 stdio의 `env` 값과 HTTP/SSE의 `headers` 값을 다음과 같이 해석합니다.

1. 값이 `!`로 시작하면 OMP는 나머지를 프로젝트 디렉터리에서 제한 시간 10초의 셸 명령으로 실행하고, 앞뒤 공백을 제거한 stdout을 사용합니다. 성공한 결과는 무효화될 때까지 프로세스 내에서 캐시되며, 동시에 이루어지는 해석은 같은 명령 실행을 공유합니다.
2. 명령이 실패하거나, 제한 시간을 초과하거나, 공백만 출력하면 해당 `env`/`headers` 항목을 생략합니다. 실패한 명령은 30초 대기 후 이후의 해석에서 다시 시도합니다.
3. 그렇지 않으면 OMP는 전체 값이 환경 변수 이름인지 확인합니다.
4. 해당 환경 변수에 비어 있지 않은 값이 설정되어 있으면 환경 변수 값을 사용하고, 그렇지 않으면 문자열을 그대로 사용합니다.

예:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

따라서 다음과 같은 설정이 유효하며 로컬 비밀 정보를 편리하게 사용할 수 있습니다.

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → 현재 셸 환경에서 복사
- `"Authorization": "Bearer hardcoded-token"` → 리터럴 값 사용
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → 명령으로 헤더 생성

<a id="user-level-enable-and-disable-overrides"></a>
## 사용자 수준의 활성화 및 비활성화 재정의

활성 프로필의 사용자 파일은 모든 설정 출처에 걸쳐 적용되는 두 가지 재정의를 제공합니다.

- `disabledServers`는 우선순위가 가장 높은 차단 목록입니다. 출처와 관계없이 이름이 같은 서버를 숨깁니다.
- `enabledServers`는 원본에 `enabled: false`가 있는 동일 이름의 항목을 강제로 활성화합니다. `disabledServers`를 재정의할 수는 없습니다.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

정의가 OMP 소유의 쓰기 가능한 파일에 있으면 `/mcp enable`과 `/mcp disable`은 `enabled`를 직접 갱신합니다. OMP는 다른 도구의 설정을 변경하지 않습니다. 그런 출처에 대해서는 이 명령들이 사용자 수준의 허용 목록 또는 차단 목록을 관리하고, 충돌하는 오래된 재정의를 제거합니다.

<a id="mcp-add-vs-editing-json-directly"></a>
## `/mcp add`와 JSON 직접 편집 비교

안내에 따라 설정하려면 `/mcp add`를 사용하세요.

다음과 같은 경우에는 JSON을 직접 편집하세요.

- 마법사에서 아직 묻지 않는 전송 방식 또는 인증 옵션이 필요한 경우
- 다른 MCP 클라이언트의 서버 정의를 붙여 넣으려는 경우
- 편집기에서 스키마 기반 검증을 사용하려는 경우

편집한 뒤에는 다음 명령을 사용하세요.

- `/mcp reload` — 현재 세션에서 서버를 다시 탐색하고 연결
- `/mcp list` — 서버가 어느 설정 파일에서 왔는지 확인
- `/mcp test <name>` — 서버 하나를 테스트
- `/mcp reconnect <name>` — 모든 설정을 다시 탐색하지 않고 서버 하나에 재연결
- `/mcp reauth <name>` — 관리형 OAuth 자격 증명을 교체하거나, `/mcp unauth <name>`으로 제거
- `/mcp resources`, `/mcp prompts`, `/mcp notifications` — 도구 이외의 MCP 기능 확인

<a id="validation-rules-omp-enforces"></a>
## OMP가 적용하는 검증 규칙

`packages/coding-agent/src/mcp/config.ts`의 `validateServerConfig()`에 따른 규칙:

- `stdio`에는 `command`가 필요합니다.
- `http`와 `sse`에는 `url`이 필요합니다.
- 서버는 `command`와 `url`을 동시에 설정할 수 없습니다.
- 알 수 없는 `type` 값은 거부됩니다.

이 규칙은 검증기/기록기에 직접 전달되는 설정에 적용됩니다. 탐색은 먼저 항목을 표준 형식으로 변환합니다. URL만 있는 항목은 `http`로, 명령이 있는 항목은 `stdio`로 추론하고, 선택한 전송 방식의 필드를 유지합니다. 충돌하는 원본 필드나 알 수 없는 타입을 탐색 단계에서 거부해 줄 것이라고 기대하지 마세요. 전송 방식을 명시하고 스키마에 맞는 정의를 작성하세요.

호환성을 위해 `sse`도 계속 유효하지만, 새로운 호스팅 서버는 일반적으로 `http`로 설정하는 것이 좋습니다.

<a id="discovery-and-precedence"></a>
## 탐색 및 우선순위

OMP는 우선순위가 높은 공급자부터 로드합니다. MCP를 지원하는 공급자의 순서는 다음과 같습니다.

1. OMP 고유 설정
2. OMP 확장 패키지
3. Claude Code
4. Agent Plugins
5. Claude 마켓플레이스 플러그인 및 Codex
6. Gemini CLI
7. OpenCode
8. Cursor 및 Windsurf
9. VS Code
10. 루트의 `mcp.json` / `.mcp.json` 대체 파일

공급자 간에는 첫 번째 정의가 우선합니다. 이름이 중복되어도 병합하지 않습니다. 앞에서 설명한 OpenCode 내부 설정 계층만 예외입니다. 이름이 다른 정의도 전송 방식, 엔드포인트/명령 입력, 인증, 요청 ID 모드가 더 높은 우선순위의 정의와 같으면 가려집니다.

OMP 고유 설정 안에서는 프로젝트의 `.omp/mcp.json`, `.omp/.mcp.json`, 활성 프로필의 사용자 `mcp.json`, `.mcp.json` 순으로 우선합니다. 루트의 대체 파일은 `mcp.json`이 `.mcp.json`보다 우선합니다. 실무에서는 다음과 같이 사용하세요.

- OMP 전용 재정의에는 `.omp/mcp.json` 또는 활성 프로필의 사용자 `mcp.json`을 우선 사용하세요.
- 가능하면 여러 도구에 걸쳐 이름과 엔드포인트 정의가 중복되지 않게 하세요.
- 타사 설정에서 원치 않는 서버가 계속 다시 추가되면 사용자 `disabledServers` 목록을 사용하세요.
- 중복 제거 전에 모든 프로젝트 수준 출처를 제외하여 이름이 같은 사용자 항목이 유지되게 하려면 `mcp.enableProjectConfig: false`를 설정하세요.

<a id="troubleshooting"></a>
## 문제 해결

<a id="server-name-stdio-server-requires-command-field"></a>
### `Server "name": stdio server requires "command" field` 오류

기록기/클라이언트에 원격 설정을 직접 전달한다면 `type: "http"`를 설정하세요. 탐색된 URL 전용 항목은 HTTP로 추론하지만, 명시적으로 stdio로 지정된 항목에는 여전히 명령이 필요합니다.

<a id="server-name-both-command-and-url-are-set"></a>
### `Server "name": both "command" and "url" are set` 오류

전송 방식을 하나만 선택하세요. OMP는 `command`를 stdio로, `url`을 http/sse로 취급합니다.

<a id="mcp-add-worked-but-the-server-still-does-not-connect"></a>
### `/mcp add`는 성공했지만 서버가 여전히 연결되지 않는 경우

JSON은 유효하더라도 서버에 도달하지 못할 수 있습니다. `/mcp test <name>`을 사용하고 다음을 확인하세요.

- 실행 파일 또는 Docker 이미지가 존재하는지
- 필요한 환경 변수가 설정되어 있는지
- 원격 URL에 도달할 수 있는지
- OAuth 또는 API 토큰이 유효한지

<a id="the-server-exists-in-another-tools-config-but-not-in-omp"></a>
### 다른 도구의 설정에 있는 서버가 OMP에는 없는 경우

`/mcp list`를 실행하세요. OMP는 다양한 타사 MCP 파일을 탐색하지만, `mcp.enableProjectConfig` 설정으로 프로젝트 수준 로드를 비활성화할 수도 있으며, 사용자 수준의 `disabledServers` 항목이 해당 이름의 서버를 차단할 수도 있습니다.

<a id="a-browser-mcp-server-is-configured-but-never-loads"></a>
### 브라우저 MCP 서버를 설정했지만 전혀 로드되지 않는 경우

OMP는 기본 제공 브라우저 프렐류드를 호출할 수 있으면 연결을 시도하기 전인 설정 로드 단계에서 인식된 브라우저 자동화 서버를 제외합니다. 구체적인 조건은 `browser.enabled`가 true(기본값)이고, Eval이 등록되어 활성화되어 있으며, 세션이 명시적으로 지정한 도구로만 제한되지 않은 경우입니다. 필터는 이름이 `playwright`, `puppeteer`, `browserbase`, `browser-tools`, `browser-use`, `browser`인 서버, 명령 또는 인수가 정해진 브라우저 MCP 패키지 패턴(`@playwright/mcp`, `@modelcontextprotocol/server-puppeteer`, `@browserbasehq/mcp-server-browserbase`, `@agentdeskai/browser-tools-mcp`, `@agent-infra/mcp-server-browser`, `puppeteer-mcp`, `playwright-mcp`, `pptr-mcp`, `browser-use-mcp`, `mcp-browser-use`) 중 하나와 일치하는 stdio 서버, URL이 browserbase.com 또는 browser-use.com을 가리키는 HTTP/SSE 서버에 적용됩니다. 그 밖의 패키지(예: 서버 이름이 위 목록에 없는 `chrome-devtools-mcp`)는 일치하지 않습니다. 이 필터는 `disabledServers`와 별개입니다.

제외는 알림 없이 이루어지지만, 모든 위치에서 같은 방식으로 표시되지는 않습니다. 두 기본 파일(`~/.omp/agent/mcp.json` 및 `.omp/mcp.json`) 이외의 출처에서 온 서버는 `/mcp list`에 아예 나타나지 않습니다. 타사 설정, 루트의 `mcp.json` / `.mcp.json` 대체 파일, OMP 확장 패키지의 서버는 필터링되면 모두 사라집니다. 두 기본 파일 중 하나에 있는 항목은 여전히 `not connected` 상태로 표시되므로, 기본 파일에 항목이 있는데 서버를 사용할 수 없다면 필터링되었을 수 있습니다. 어느 경우에도 오류나 경고는 기록되지 않습니다.

기본 제공 브라우저 도구 대신 브라우저 MCP 서버를 실행하려면 설정에서 `browser.enabled: false`를 지정하세요. `omp read`는 이 필터를 적용하지 않습니다.

<a id="a-namespaced-server-works-but-the-editor-rejects-its-name"></a>
### 네임스페이스가 있는 서버는 작동하지만 편집기에서 이름을 거부하는 경우

런타임/설정 기록기는 이름에 `:`와 내부의 단일 공백을 허용합니다. 번들 JSON 스키마의 `propertyNames` 패턴은 현재 이를 허용하지 않습니다. 이는 연결 실패가 아니라 스키마와 런타임의 불일치입니다.

<a id="a-config-file-is-silently-absent-from-the-list"></a>
### 설정 파일이 아무 알림 없이 목록에서 빠지는 경우

JSON 형식이 잘못되었거나 서버 맵이 누락되었거나 유효하지 않으면 해당 공급자는 그 파일에서 아무 항목도 제공하지 않습니다. 공급자에 따라 OMP는 세션을 실패시키는 대신 탐색 경고를 기록하거나 파싱 실패를 로그에 남깁니다. JSON 구조를 수정한 다음 `/mcp reload`와 `/mcp list`를 실행하세요.

<a id="references"></a>
## 참고 자료

- MCP 전송 사양: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Filesystem 서버 패키지: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP 서버: https://github.com/github/github-mcp-server
- Slack MCP 서버 문서: https://docs.slack.dev/ai/slack-mcp-server/
