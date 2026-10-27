---
name: authoring-marketplaces
description: 새 omp 마켓플레이스를 만들 때 사용합니다. marketplace.json 스키마, 소스 타입, 설치 명령, 배포를 다룹니다.
---

<a id="authoring-marketplaces"></a>
# 마켓플레이스 작성하기

마켓플레이스는 `.omp-plugin/marketplace.json`(omp 전용 카탈로그에 권장) 또는 `.claude-plugin/marketplace.json`(Claude Code 호환, 대체 경로로 사용)에 카탈로그 파일이 있는 Git 저장소나 로컬 디렉터리입니다. 누구나 만들 수 있습니다. 사용자는 `/marketplace add owner/repo`로 마켓플레이스를 추가한 뒤 그 안의 플러그인을 개별적으로 설치합니다.

<a id="minimum-viable-marketplace"></a>
## 최소 구성의 마켓플레이스

```
my-marketplace/
  .claude-plugin/
    marketplace.json
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
```

```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

GitHub에 푸시하세요. 사용자는 다음 명령으로 설치합니다.

```
/marketplace add your-github-username/my-marketplace
/marketplace install my-plugin@my-marketplace
```

<a id="marketplacejson-schema"></a>
## marketplace.json 스키마

카탈로그 파일은 저장소 루트의 `.omp-plugin/marketplace.json` 또는 `.claude-plugin/marketplace.json`에 둡니다. omp는 `.omp-plugin/` 경로를 우선 사용하며 없으면 Claude 경로를 사용합니다. 하나의 소스 트리에서 도구별 카탈로그를 제공하려면 두 파일을 모두 배포해도 됩니다.

<a id="top-level-fields"></a>
### 최상위 필드

| 필드 | 필수 여부 | 설명 |
|---|---|---|
| `name` | 예 | 마켓플레이스 이름. ASCII 영숫자, 하이픈, 점을 사용할 수 있습니다. 영숫자로 시작하고 끝나야 하며 최대 64자입니다. 대소문자만 다른 마켓플레이스 이름은 함께 존재할 수 없습니다. |
| `owner` | 예 | 최소한 `owner.name`(문자열)을 포함하는 객체 |
| `owner.name` | 예 | 마켓플레이스 소유자 이름 |
| `owner.email` | 아니요 | 소유자 연락 이메일 |
| `plugins` | 예 | 플러그인 항목 배열(아래 참고) |
| `metadata.description` | 아니요 | 마켓플레이스에 대한 짧은 설명 |
| `metadata.version` | 아니요 | 카탈로그 메타데이터 버전 문자열 |
| `metadata.pluginRoot` | 아니요 | 모든 상대 플러그인 소스 경로 앞에 붙일 문자열 |
| 추가 최상위 필드 | 아니요 | 파서가 보존하지만 마켓플레이스 설치/런타임 로직에서는 사용하지 않음 |

<a id="plugin-entry-fields"></a>
### 플러그인 항목 필드

| 필드 | 필수 여부 | 설명 |
|---|---|---|
| `name` | 예 | 플러그인 이름(마켓플레이스 이름과 같은 명명 규칙). 카탈로그에서 대소문자만 다른 중복은 건너뜁니다. |
| `source` | 예 | 플러그인 위치. 문자열 또는 객체(아래 소스 타입 참고) |
| `description` | 아니요 | 플러그인에 대한 짧은 설명 |
| `version` | 아니요 | 버전 문자열. 없으면 `.claude-plugin/plugin.json`, 루트 `plugin.json`, `package.json`, 소스에 명시된 SHA(앞 7자), `0.0.0` 순으로 대체합니다. |
| `author` | 아니요 | `{ name, email? }` |
| `homepage` | 아니요 | URL |
| `category` | 아니요 | 예: `development`, `productivity`, `security` |
| `tags` / `keywords` | 아니요 | 문자열 태그/키워드 배열 |
| `repository` | 아니요 | 저장소 URL |
| `license` | 아니요 | 라이선스 문자열 |
| `strict` | 아니요 | 불리언 메타데이터 플래그. 보존하지만 설치/런타임 로직에서는 사용하지 않음 |
| `commands`, `agents`, `hooks`, `mcpServers` | 아니요 | 파서가 보존하는 카탈로그 메타데이터. 런타임 검색은 설치된 플러그인 트리와 매니페스트를 사용합니다. |
| `skills` | 아니요 | 플러그인 소스가 정확히 `"./"`일 때 스킬 경로 선택에 사용하는 추가 카탈로그 필드. 그 외에는 런타임 스킬 검색이 플러그인 트리/매니페스트를 사용합니다. |
| `lspServers` | 아니요 | 인라인 서버 맵 또는 플러그인 내부 경로. 설치 시 `.lsp.json`을 기록합니다. |
| `dapAdapters` | 아니요 | 인라인 어댑터 맵 또는 플러그인 내부 JSON/YAML 경로. 설치 시 `.dap.json`, `.dap.yaml`, `.dap.yml` 중 하나를 기록합니다. |

<a id="full-catalog-example"></a>
### 전체 카탈로그 예제

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-plugins",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.example"
  },
  "metadata": {
    "description": "Official Acme plugins for omp"
  },
  "plugins": [
    {
      "name": "acme-linter",
      "description": "Enforce Acme coding standards",
      "category": "development",
      "source": "./plugins/linter"
    },
    {
      "name": "acme-deploy",
      "description": "One-command deploy to Acme cloud",
      "category": "devops",
      "source": {
        "source": "github",
        "repo": "acme-corp/omp-deploy-plugin",
        "ref": "main"
      }
    }
  ]
}
```

<a id="plugin-source-types"></a>
## 플러그인 소스 타입

<a id="1-relative-path-string"></a>
### 1. 상대 경로 문자열

마켓플레이스 저장소 자체의 하위 디렉터리를 가리킵니다. `./`로 시작해야 합니다.

```json
"source": "./plugins/my-plugin"
```

경로는 마켓플레이스 저장소 루트를 기준으로 해석합니다. 저장소 루트 밖으로 나가는 경로 탐색은 거부됩니다.

공통 접두사를 반복하지 않으려면 `metadata.pluginRoot`를 사용하세요.

```json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "plugin-a", "source": "./plugin-a" },
    { "name": "plugin-b", "source": "./plugin-b" }
  ]
}
```

<a id="2-git-url"></a>
### 2. Git URL

전체 Git 저장소 URL입니다. 선택적으로 브랜치/태그(`ref`)나 정확한 커밋(`sha`)에 고정할 수 있습니다.

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/my-plugin.git",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

<a id="3-github-shorthand"></a>
### 3. GitHub 축약 표기

GitHub 저장소의 축약 표기입니다. 기능은 Git URL과 같지만 더 간결합니다.

```json
"source": {
  "source": "github",
  "repo": "org/my-plugin",
  "ref": "v2.1.0",
  "sha": "a1b2c3d4..."
}
```

<a id="4-git-subdirectory-monorepo"></a>
### 4. Git 하위 디렉터리(모노레포)

더 큰 저장소의 하위 디렉터리에 있는 플러그인에 사용합니다. `url`은 전체 HTTPS URL 또는 GitHub `owner/repo` 축약 표기를 받습니다.

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "packages/my-plugin",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

`path`는 복제된 저장소 내부로 해석되어야 하며 디렉터리 밖으로 벗어나면 거부됩니다.

<a id="5-npm-package"></a>
### 5. NPM 패키지

플러그인을 npm 패키지로 선언합니다. `version`은 선택 사항입니다.

```json
"source": {
  "source": "npm",
  "package": "@acme/omp-plugin",
  "version": "1.2.0"
}
```

> 참고: 카탈로그 파서는 npm 플러그인 소스를 허용하지만 설치 시에는 `npm plugin sources are not yet supported` 오류로 거부합니다. 현재는 상대 경로나 Git 기반 소스를 사용하세요.

<a id="plugin-structure"></a>
## 플러그인 구조

플러그인 디렉터리는 소스 타입과 관계없이 정해진 위치에 콘텐츠를 제공하며, 모두 선택 사항입니다.

```
my-plugin/
  skills/<name>/SKILL.md         ← 스킬
  commands/*.md                  ← 슬래시 명령
  agents/*.md                    ← 하위 에이전트 정의
  hooks/pre/, hooks/post/        ← 훅
  tools/                         ← 사용자 지정 도구
  .mcp.json                      ← MCP 서버 정의(기본 위치)
  .claude-plugin/plugin.json     ← 선택적 스킬/명령 경로 및 기타 매니페스트 메타데이터
  package.json                   ← 선택적 버전 및 `omp.extensions`
  README.md                      ← 권장: 설명 + 사용법
```

> 참고: MCP 서버는 매니페스트의 `mcpServers` 필드로 선언할 수도 있습니다. 인라인 서버 맵 또는 플러그인 루트 내부 구성 파일 경로(`{ "mcpServers": "./mcp-omp.json" }`)를 지정하세요. omp는 `.omp-plugin/plugin.json`을 먼저 읽고 그다음 `.claude-plugin/plugin.json`을 읽습니다. 매니페스트 선언은 기본 `.mcp.json`과 병합되지 않고 이를 대체하므로, 하나의 배포 트리에서 하네스별 MCP 구성을 제공할 수 있습니다.

> 참고: `package.json`의 `omp.extensions`로 선언한 확장 모듈도 마켓플레이스 설치에서 **불러옵니다**. 설치 시 캐시된 플러그인을 해당 범위의 `node_modules`에 심볼릭 링크로 연결하고 `omp-plugins.lock.json`에 기록합니다. 이는 npm으로 설치하거나 `omp plugin link`로 연결한 플러그인과 같은 런타임 경로를 사용합니다.

<a id="install-command"></a>
## 설치 명령

```
/marketplace install name@marketplace-name
/marketplace install --force name@marketplace-name     # 다시 설치
/marketplace install --scope project name@marketplace  # 프로젝트 범위
```

동일한 CLI 명령:

```
omp plugin marketplace add owner/repo
omp plugin install name@marketplace-name
```

범위별 동작:

- **user**(기본값) — 사용자 플러그인 데이터 루트의 `installed_plugins.json`에 설치되며(기본값 `~/.omp/plugins/installed_plugins.json`), 모든 프로젝트에서 사용할 수 있습니다. Linux와 macOS에서 `omp config init-xdg`는 XDG 루트를 초기화하지만 기존 데이터를 이전하지는 않습니다. XDG 변수가 설정되어 있으면 초기화된 루트는 새 사용자 상태를 `$XDG_DATA_HOME/omp/plugins/installed_plugins.json`에 저장합니다.
- **project** — `<project>/.omp/plugins/installed_plugins.json`에 설치되며 해당 프로젝트에서만 사용할 수 있습니다.

활성화된 프로젝트 범위 설치는 같은 `name@marketplace` ID의 활성화된 사용자 범위 설치보다 우선합니다. 프로젝트 복사본이 비활성화되어 있으면 사용자 복사본이 활성 상태로 유지됩니다.

설치와 검색의 세부 동작:

- 유효하지 않은 플러그인 항목은 로그를 남기고 건너뜁니다. JSON이나 필수 최상위 필드가 유효하지 않으면 카탈로그를 거부합니다.
- `.claude-plugin/plugin.json`에서 `skills/`와 `commands/` 경로를 바꿀 수 있습니다. 선언된 스킬 경로는 일반적으로 기본 경로에 추가되지만, 카탈로그 소스가 정확히 `"./"`인 플러그인에서는 기본 경로를 대체합니다. 선언된 `commands`(권장) 또는 `slash-commands`는 `./commands`를 명시적으로 포함하지 않는 한 기본 경로를 대체합니다. 플러그인 루트 밖의 경로는 경고와 함께 무시합니다.
- 카탈로그의 `lspServers`와 `dapAdapters` 값은 설치 중 실제 구성 파일로 기록됩니다. 그 외 카탈로그의 `commands`, `agents`, `hooks`, `mcpServers`는 메타데이터이며 런타임 검색 경로를 바꾸지 않습니다.
- 표준 루트 `plugin.json`이 있는 Portable Agent Plugins 패키지는 레거시 스킬/MCP 매니페스트 대신 고정된 `skills/<name>/SKILL.md`와 `mcp.json` 위치를 사용합니다. 스킬 프런트매터는 엄격히 검증되며 모든 스킬/MCP 리소스는 패키지 루트 안으로 해석되어야 합니다. 유효한 이식 가능 패키지에서는 다른 OMP 전용 구성 요소도 계속 사용할 수 있습니다. 표준 매니페스트에 치명적인 오류가 있으면 패키지를 거부합니다.

<a id="naming-rules"></a>
## 명명 규칙

마켓플레이스 이름과 플러그인 이름은 다음 조건을 충족해야 합니다.

- ASCII 영문자(대소문자 모두), 숫자, 하이픈(`-`), 점(`.`)만 포함
- ASCII 영문자나 숫자로 시작하고 끝남
- 최대 64자

플러그인 ID(`name@marketplace`)의 전체 길이는 최대 128자입니다.

유효한 이름: `my-plugin`, `code-review`, `acme.tools`, `ai-v2`, `HAS-CAPS`
유효하지 않은 이름: `-bad-start`, `bad-end-`, `.dot-start`, `Under_score`

이름의 표기는 그대로 유지하지만 충돌 검사는 대소문자를 구분하지 않습니다. `My-Plugin`과 `my-plugin`은 같은 카탈로그의 별도 항목이 될 수 없습니다. 예측 가능한 ID를 위해 소문자를 권장합니다.

<a id="publishing-workflow"></a>
## 배포 절차

1. 새 Git 저장소의 `.omp-plugin/marketplace.json`(omp 전용) 또는 `.claude-plugin/marketplace.json`(Claude Code와 공유)에 `marketplace.json`을 만듭니다.
2. 하위 디렉터리 또는 외부 소스를 가리키는 플러그인 항목을 추가합니다.
3. GitHub에 푸시합니다.
4. `owner/repo` 문자열을 공유합니다. 사용자는 `/marketplace add owner/repo`로 추가합니다.
5. 카탈로그를 갱신하면 사용자는 `/marketplace update your-marketplace-name`으로 최신 버전을 가져옵니다.

배포 전에 로컬에서 테스트하려면 다음 명령을 사용하세요.

```
/marketplace add ./path/to/my-marketplace
```

로컬 경로 소스는 `~/`와 절대 경로도 허용합니다.

<a id="further-reading"></a>
## 더 읽어보기

- `docs/marketplace.md` — 마켓플레이스 시스템 내부 구조, 디스크 레이아웃, 명령 참조
- `docs/skills/authoring-extensions.md` — 플러그인 내부 확장 모듈 작성법
- `docs/skills/examples/mini-marketplace/` — 최소 구성으로 작동하는 마켓플레이스 예제
