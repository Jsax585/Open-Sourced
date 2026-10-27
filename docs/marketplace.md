# 마켓플레이스 플러그인 시스템

마켓플레이스 시스템으로 Git, 로컬 디렉터리 또는 카탈로그 직접 제공 출처에서 플러그인을 탐색하고 설치·관리할 수 있습니다. Claude Code 플러그인 레지스트리 형식과 호환됩니다.

## 빠른 시작

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

TUI에서 인수 없이 `/marketplace`를 실행하면 대화형 플러그인 탐색기가 열립니다. ACP/RPC 명령 처리에서는 `/marketplace`가 설정된 마켓플레이스 목록을 표시하며, 탐색하려면 `/marketplace discover`를 사용합니다.

## 개념

**마켓플레이스**는 `.omp-plugin/marketplace.json`(권장) 또는 `.claude-plugin/marketplace.json`(Claude Code 호환 대체 경로)에 카탈로그 파일이 있는 Git 저장소나 로컬 디렉터리입니다. 카탈로그는 사용 가능한 플러그인과 각 플러그인의 출처, 설명, 메타데이터를 나열합니다.

**플러그인**은 스킬, 명령, 에이전트, 규칙, 훅, 도구, MCP 서버, LSP 서버 또는 DAP 어댑터 같은 Claude/OMP 플러그인 콘텐츠가 들어 있는 디렉터리입니다. 루트 `plugin.json`에서 Agent Plugins 1.0.0 스키마를 선언하는 패키지는 스킬과 `mcp.json`에 이식 가능한 `agent-plugins` 탐색 제공업체를 사용하며, 혼합형 패키지는 OMP 전용 콘텐츠도 제공할 수 있습니다. 마켓플레이스 설치는 `package.json`의 `omp.extensions`에 선언된 확장 기능 모듈도 불러옵니다. 설치 과정에서 캐시된 플러그인을 해당 범위의 `node_modules` 트리에 심볼릭 링크로 연결하고 `omp-plugins.lock.json`에 기록합니다. 이는 npm으로 설치하거나 `omp plugin link`로 연결한 플러그인과 동일한 런타임 경로입니다. 플러그인은 `name@marketplace`로 식별합니다(예: `code-review@claude-plugins-official`).

**범위**: 마켓플레이스 플러그인은 두 범위에 설치할 수 있습니다.

- **user** (기본값) — 모든 프로젝트에서 사용 가능하며, 사용자 플러그인 데이터 루트의 `installed_plugins.json`에 저장됩니다(기본 경로: `~/.omp/plugins/installed_plugins.json`).
- **project** — 현재 프로젝트에서만 사용 가능하며, `.omp/`가 있는 가장 가까운 상위 디렉터리 아래의 `.omp/plugins/installed_plugins.json`에 저장됩니다. `.omp/`가 없으면 가장 가까운 Git 루트를 사용합니다. 어느 기준점도 없을 때 프로젝트 설치를 명시하면 현재 작업 디렉터리에 이 트리를 만들 수 있습니다. 홈 디렉터리는 프로젝트로 취급하지 않습니다.

활성화된 프로젝트 범위 설치는 같은 플러그인의 활성화된 사용자 범위 설치보다 우선합니다. 비활성화된 프로젝트 설치는 사용자 설치를 가리지 않습니다.

Linux와 macOS에서 `omp config init-xdg`는 XDG 데이터, 상태, 캐시 루트를 초기화하며 기존 데이터를 옮기지는 않습니다. `XDG_DATA_HOME`이 설정되고 그 아래 `omp/` 디렉터리가 초기화되어 있으면 사용자 마켓플레이스/플러그인 상태는 `$XDG_DATA_HOME/omp` 아래에서 해석됩니다(`marketplaces.json`, `plugins/` 포함). 이름이 있는 프로필은 각자의 루트를 사용하며, XDG 경로를 사용하려면 해당 `omp/profiles/<name>/` 디렉터리가 있어야 합니다. 아래의 `~/.omp` 경로는 XDG를 사용하지 않는 기본 프로필의 기본 경로입니다.

XDG 레지스트리 경로를 처음 해석할 때 XDG 대상이 없으면 기존 설정 루트의 `marketplaces.json`을 가능한 경우 복사하며, 원본 파일은 유지합니다. 이 보조 기능은 플러그인 설치 트리를 복사하지 않습니다.

## 명령

### 대화형 모드

| 명령 | 동작 |
| -------------- | ----------------------------------------- |
| `/marketplace` 또는 `/marketplace install` | 대화형 플러그인 탐색기 열기(설치) |

### 마켓플레이스 관리

| 명령 | 동작 |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>` | 마켓플레이스 출처 추가 |
| `/marketplace remove <name>` | 마켓플레이스 제거 |
| `/marketplace update [name]` | 카탈로그 다시 가져오기. 이름을 생략하면 모두 갱신 |
| `/marketplace list` | 설정된 마켓플레이스 목록 표시 |

### 플러그인 작업

| 명령 | 동작 |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `/marketplace discover [marketplace]` | 사용 가능한 플러그인 탐색 |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | 플러그인 설치 |
| `/marketplace uninstall [--scope user\|project] name@marketplace` | 플러그인 제거. 인수가 없으면 TUI 선택기 열기 |
| `/marketplace installed` | 설치된 마켓플레이스 플러그인 목록 표시 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]` | 하나 또는 모든 플러그인 업그레이드 |
| `/plugins list` | npm/link 및 마켓플레이스 플러그인 목록 표시 |
| `/plugins enable [--scope user\|project] <plugin>` | npm/link 또는 마켓플레이스 플러그인 활성화 |
| `/plugins disable [--scope user\|project] <plugin>` | npm/link 또는 마켓플레이스 플러그인 비활성화 |

### 해당 CLI 명령

명령줄에서도 같은 작업을 수행할 수 있습니다.

```
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--dry-run] [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--dry-run] [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] name@marketplace
omp plugin disable [--scope user|project] name@marketplace
omp plugin list

```

TUI의 `/plugins enable`과 `/plugins disable`은 현재 세션의 스킬, 슬래시 명령, 작업 에이전트, MCP 서버를 즉시 새로 고칩니다. 필요하면 `--scope`로 마켓플레이스 설치를 선택하며, npm/link 활성화 전환은 전역으로 적용됩니다. 그 밖의 TUI 마켓플레이스 변경(명시적 명령과 선택기)은 디스크 상태를 갱신하고 탐색 캐시를 무효화하지만 현재 세션을 새로 고치지는 않습니다. 변경 후 `/reload-plugins`를 실행하면 작업 에이전트, 스킬, 슬래시 명령, MCP 서버가 새로 고쳐집니다. 새로 설치한 비 MCP 도구, 훅, 확장 기능 모듈에는 세션 재시작이 필요합니다. ACP/RPC 마켓플레이스 핸들러는 스킬과 슬래시 명령을 자동으로 새로 고치며, ACP는 작업 에이전트 탐색도 새로 고칩니다. 두 원격 핸들러 모두 MCP 서버를 다시 연결하거나 초기화된 모든 기능 집합을 다시 구성하지는 않습니다.

CLI 설치의 `--dry-run`은 플러그인 저장소를 가져오거나 플러그인 상태를 쓰지 않고, 캐시된 카탈로그, 범위, 기존 설치 및 로컬에서 확인할 수 있는 출처 제약을 검증합니다. 제거 미리보기는 아무것도 제거하지 않으면서 설치 범위의 모호성 검사를 유지합니다. TUI/ACP/RPC 슬래시 명령은 `--dry-run`을 받지 않습니다.

## 마켓플레이스 출처

`/marketplace add <source>`를 실행하면 시스템은 출처를 다음과 같이 분류합니다.

| 출처 형식 | 유형 | 예시 |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `owner/repo` | GitHub 축약형 | `anthropics/claude-plugins-official` |
| `https://...*.json` | 카탈로그 직접 URL | `https://example.com/marketplace.json` |
| `https://...` / `http://...` | URL 경로가 `.json`으로 끝나지 않으면 Git 저장소 | `https://github.com/org/repo` |
| `git@...` / `ssh://...` | Git 저장소 | `git@github.com:org/repo.git` |
| `./path`, `~/path` 또는 `/path` | 로컬 디렉터리 | `./my-marketplace` |

Git 및 로컬 출처에는 `.omp-plugin/marketplace.json`(권장) 또는 `.claude-plugin/marketplace.json`(Claude Code 호환 대체 경로)에 카탈로그가 있어야 합니다. 카탈로그 직접 URL은 JSON 카탈로그만 캐시하므로, URL 출처 카탈로그의 플러그인은 `"./plugins/foo"` 같은 상대 문자열 출처를 사용할 수 없습니다.

## 카탈로그 형식(marketplace.json)

마켓플레이스 카탈로그는 저장소 루트의 `.omp-plugin/marketplace.json`에 위치합니다. omp만 사용할 예정이면 이 경로를 권장합니다. Claude Code 호환성을 유지하려면 `.claude-plugin/marketplace.json`에 게시하세요(omp는 두 경로에서 같은 형식을 불러옵니다). omp는 `.omp-plugin/marketplace.json`이 없을 때 이 경로를 대신 사용합니다. 저장소에 둘 다 포함할 수도 있습니다. omp는 `.omp-plugin/` 복사본을, Claude Code는 `.claude-plugin/` 복사본을 읽습니다. 두 경우 모두 카탈로그 형식은 같습니다.

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### 필수 필드

| 필드 | 설명 |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name` | 마켓플레이스 이름. ASCII 영문자, 숫자, 하이픈, 마침표를 사용할 수 있습니다. 영문자나 숫자로 시작하고 끝나야 하며 최대 64자입니다. |
| `owner.name` | 마켓플레이스 소유자 이름 |
| `plugins` | 플러그인 항목 배열 |

최상위 `metadata.description`, `metadata.version`, `metadata.pluginRoot`는 선택 사항입니다. `metadata.pluginRoot`를 설정하면 플러그인의 상대 `source` 경로 앞에 붙입니다.

설치 버전은 카탈로그의 `version`, `.claude-plugin/plugin.json`, 루트의 `plugin.json`, `package.json` 순으로 확인하고, 모두 없으면 출처 정의의 SHA 앞 7자리 또는 `0.0.0`을 사용합니다. 캐시 경로에 쓰이는 버전은 ASCII 영문자/숫자 또는 `._+-`로 이루어진 1~128자여야 하며 `..`를 포함할 수 없습니다.

### 플러그인 항목 필드

| 필드 | 필수 | 설명 |
| ------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name` | 예 | 플러그인 이름(마켓플레이스 이름과 동일한 규칙) |
| `source` | 예 | 플러그인 위치(아래 참조) |
| `description` | 아니요 | 간략한 설명 |
| `version` | 아니요 | 버전 문자열. 설치 버전은 플러그인 매니페스트, 출처 SHA, `0.0.0` 순으로 대체 |
| `author` | 아니요 | `{ name, email? }` |
| `homepage` | 아니요 | URL |
| `repository` | 아니요 | 저장소 URL/문자열 |
| `license` | 아니요 | 라이선스 문자열 |
| `keywords` | 아니요 | 문자열 키워드 배열 |
| `category` | 아니요 | 분류 문자열(예: `development`, `productivity`, `security`) |
| `tags` | 아니요 | 문자열 태그 배열 |
| `strict` | 아니요 | 불리언 메타데이터 플래그. 보존되지만 설치/런타임 로직에서는 사용하지 않음 |
| `commands` | 아니요 | 명령 메타데이터. 보존되지만 런타임 명령은 설치된 플러그인 트리에서 탐색 |
| `agents` | 아니요 | 에이전트 메타데이터. 보존되지만 마켓플레이스 설치에서는 사용하지 않음 |
| `hooks` | 아니요 | 훅 메타데이터. 보존되지만 런타임 훅은 설치된 플러그인 트리에서 탐색 |
| `mcpServers` | 아니요 | MCP 메타데이터. 여기에 보존되며 런타임 MCP 설정은 플러그인 매니페스트/트리에서 가져옴 |
| `lspServers` | 아니요 | 인라인 맵 또는 플러그인 내부 경로. 설치 시 `.lsp.json`으로 복사 |
| `dapAdapters` | 아니요 | 인라인 맵 또는 플러그인 내부 JSON/YAML 경로. `.dap.json`, `.dap.yaml` 또는 `.dap.yml`로 복사 |

### 플러그인 출처 형식

`source` 필드는 다음 형식을 지원합니다. 문자열 출처는 `./`로 시작해야 하며, 선택적 `metadata.pluginRoot`를 앞에 붙인 뒤 마켓플레이스 루트 내부에서 해석합니다.

**상대 경로**(마켓플레이스 저장소 내부):

```json
"source": "./my-plugin"
```

**Git 저장소 URL**:

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub 축약형**:

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git 하위 디렉터리**(모노레포):

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm 패키지**(파싱은 지원하지만 아직 설치할 수 없음):

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

Current installer behavior rejects npm marketplace sources with `npm plugin sources are not yet supported`; use relative, GitHub, URL, or git-subdir sources.
현재 설치 프로그램은 npm 마켓플레이스 출처를 `npm plugin sources are not yet supported` 오류로 거부합니다. 상대 경로, GitHub, URL 또는 git-subdir 출처를 사용하세요.

카탈로그 JSON이 잘못되었거나 필수 최상위 필드가 유효하지 않으면 카탈로그를 거부합니다. 유효하지 않은 플러그인 항목은 로그에 기록하고 건너뛰므로 나머지 유효한 항목은 계속 사용할 수 있습니다. 대소문자를 구분하는 파일 시스템에서도 카탈로그 내 플러그인 이름과 설정된 마켓플레이스 이름은 대소문자를 무시했을 때 충돌하면 안 됩니다.

## 업데이트, 제거 및 범위

- `/marketplace update [name]`은 카탈로그만 갱신하며 플러그인을 다시 설치하지 않습니다.
- `omp plugin upgrade name@marketplace`는 `--scope`를 생략하면 설치된 모든 범위를 다시 설치합니다. `/marketplace upgrade name@marketplace`, 제거 및 활성화/비활성화는 플러그인이 두 범위 모두에 있으면 `--scope user|project`가 필요합니다.
- 모든 플러그인의 업그레이드는 `version`을 선언한 카탈로그 항목만 비교합니다. Semver 버전은 더 최신이어야 하며, semver가 아닌 버전은 서로 다르면 변경된 것으로 취급합니다. 설치된 범위를 각각 독립적으로 확인합니다. 플러그인별 실패는 건너뛰므로 전체 업그레이드가 일부만 성공할 수 있습니다. 전체 플러그인 업그레이드에서는 CLI의 `--scope`를 무시합니다.
- 재설치/업그레이드는 비활성 상태, 기능 선택, 설정을 유지합니다. 사용자 설치와 프로젝트 설치는 버전별 캐시 디렉터리를 공유하므로 같은 버전을 강제로 재설치하면 두 범위가 사용하는 콘텐츠가 모두 바뀝니다. 다른 플러그인과의 런타임 패키지 이름 및 캐시 경로 충돌은 거부합니다.
- `marketplace.autoUpdate`는 시작 시 검사를 제어합니다. 값은 `off`, `notify`(기본값), `auto`입니다. 버전 검사 전에 24시간보다 오래된 카탈로그를 가능한 경우 갱신합니다. 이름과 달리 현재 `notify` 모드는 업데이트 가능 여부를 디버그 로그에만 기록하며 사용자 알림은 표시하지 않습니다.
- 마켓플레이스를 제거하면 레지스트리 항목과 카탈로그 캐시가 제거되며, 이미 캐시되고 등록된 플러그인은 제거하지 않습니다.

## 디스크 저장 구조
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Runtime enable/feature state and plugin settings
    node_modules/<package>        # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Project runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
```

잠금 파일에는 플러그인이 `secret`으로 표시한 값을 비롯한 플러그인 설정도 저장되므로, 소유자만 접근할 수 있는 권한(`0600`)으로 기록합니다.

## 명명 규칙

마켓플레이스와 플러그인 이름은 다음 요건을 충족해야 합니다.

- ASCII 영문자나 숫자로 시작하고 끝나야 합니다.
- ASCII 영문자, 숫자, 하이픈, 마침표만 포함할 수 있습니다.
- 최대 64자여야 합니다.

플러그인 ID(`name@marketplace`)를 구성할 때 전체 길이는 128자로 제한됩니다. 이름의 대소문자는 유지되므로 플러그인을 참조할 때 카탈로그의 표기를 사용하세요.

유효한 예: `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify`, `MixedCase`
잘못된 예: `-bad`, `bad-`, `.bad`, `under_score`
