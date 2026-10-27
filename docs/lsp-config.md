# OMP의 LSP 설정

이 안내서는 OMP 코딩 에이전트의 언어 서버 설정 방법을 설명합니다.

기준이 되는 코드:

- 서버 설정 타입: `packages/coding-agent/src/lsp/types.ts` (`ServerConfig`)
- 설정 로더: `packages/coding-agent/src/lsp/config.ts`
- 내장 서버 정의: `packages/coding-agent/src/lsp/defaults.json`

## 자동 감지

OMP는 내장 서버 정의에 설정 재정의를 적용한 뒤, 다음 두 조건을 모두 만족하는 활성 서버를 사용합니다.

1. 현재 작업 디렉터리에 서버의 `rootMarkers` 중 하나 이상이 있습니다.
2. 서버 실행 파일을 사용할 수 있습니다. 지원하는 프로젝트 로컬 실행 파일 디렉터리(예: `node_modules/.bin/`, Python 가상 환경, Ruby binstub, Go의 프로젝트 `bin/`)를 먼저 확인하고, 이어서 `$PATH`를 확인합니다.

시작 시 루트 마커는 cwd 안에서만 감지하며 상위 디렉터리를 검색하지 않습니다. `*.cabal` 같은 와일드카드는 cwd 바로 아래 항목에만 일치하며 재귀적으로 검색하지 않습니다. 일반적인 구성에는 별도 설정이 필요하지 않습니다. 전체 내장 목록은 [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json)을 참조하세요.

## 설정 파일 위치

OMP는 여러 출처의 LSP 설정을 다음과 같이 낮은 우선순위부터 병합합니다.

| 우선순위 | 위치 |
| ---------: | ------------------------------------------------------------------------------------------------------------ |
| 가장 낮음 | `~/lsp.json`, `~/.lsp.json`, `~/lsp.yaml`, `~/.lsp.yaml`, `~/lsp.yml`, `~/.lsp.yml` |
| | 플러그인 LSP 설정(마켓플레이스 / `--plugin-dir` 루트) |
| | 사용자 설정 디렉터리: 활성 네이티브 에이전트 디렉터리, 이어서 `~/.claude/lsp.*`, `~/.codex/lsp.*`, `~/.gemini/lsp.*` |
| | cwd 설정 디렉터리: `<cwd>/.omp/lsp.*`, `<cwd>/.claude/lsp.*`, `<cwd>/.codex/lsp.*`, `<cwd>/.gemini/lsp.*` |
| 가장 높음 | cwd 루트: `<cwd>/lsp.*` 및 `<cwd>/.lsp.*` |

각 설정 디렉터리 행 안에서는 높은 우선순위부터 나열합니다. 각 위치는 숨김 파일을 포함한 `.json`, `.yaml`, `.yml`을 지원합니다. 한 위치에 여러 형식이 있으면 높은 우선순위부터 `lsp.json`, `.lsp.json`, `lsp.yaml`, `.lsp.yaml`, `lsp.yml`, `.lsp.yml` 순입니다. 읽을 수 있는 모든 파일을 병합하며 첫 번째 파일만 사용하는 방식이 아닙니다.

서버별 병합은 얕은 병합입니다. 우선순위가 높은 서버 객체는 최상위 필드만 덮어쓰지만, `settings`, `initOptions`, `capabilities`, `workspaceReadyTimings` 같은 객체 필드는 깊이 병합하지 않고 전체를 대체합니다. 재정의 파일에 없는 서버는 내장 기본값을 유지합니다.

네이티브 사용자 설정 디렉터리는 `PI_CONFIG_DIR`과 활성 프로필을 따릅니다. `~/.omp/agent/lsp.json`은 기본 프로필의 경로입니다. 이 공통 설정 검색은 `PI_CODING_AGENT_DIR`를 임의의 대체 기준 경로로 사용하지 않습니다. Claude 사용자 디렉터리는 `CLAUDE_CONFIG_DIR`를 따릅니다. 외부 사용자 설정(Claude, Codex, Gemini)은 활성 제공업체 설정에서 명시적으로 선택해야 합니다. `CLAUDE_CONFIG_DIR`를 설정하면 명시적으로 비활성화하지 않는 한 Claude도 선택됩니다. 프로젝트 및 cwd 출처는 상위 디렉터리를 탐색하지 않으며 이 사용자 출처 선택 조건의 영향을 받지 않습니다.

**권장 위치:**

- 사용자 공통 환경설정 → 활성 네이티브 에이전트 디렉터리의 `lsp.json`
- 프로젝트별 재정의 → `<cwd>/.omp/lsp.json`

> **참고:** 별도의 설정 서버 모드는 없습니다. 내장 기본값, 부분 재정의, 새 사용자 지정 서버는 모두 동일한 루트 마커/실행 파일/`disabled` 필터를 거칩니다. `idleTimeoutMs`만 설정하면 서버 선택은 바뀌지 않습니다.

설정은 cwd별로 캐시됩니다. LSP 파일, 루트 마커 또는 설치된 실행 파일을 변경한 뒤에는 `lsp` 도구를 `action: "reload", file: "*"`로 호출하거나 `file`을 생략하여 설정을 다시 읽고 더 이상 최신 설정을 사용하지 않는 클라이언트를 종료하세요.

## 파일 구조

JSON과 YAML을 모두 지원합니다. 최상위 객체는 `servers` 래퍼 키 또는 직접적인 평면 맵을 사용할 수 있습니다.

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

또는 다음과 같이 `servers` 래퍼 없이 평면 구조를 사용합니다.

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

최상위 키:

- `servers` — 서버 이름을 `ServerConfig`에 연결하는 맵(선택적 래퍼이며 평면 형식과 동등)
- `idleTimeoutMs` — 지정한 밀리초 동안 유휴 상태인 언어 서버 종료. 생략하거나 0 또는 음수이면 유휴 종료를 사용하지 않음

래퍼 형식과 평면 서버 항목을 섞지 마세요. `servers`가 객체이면 `idleTimeoutMs` 이외의 형제 키는 서버로 처리하지 않습니다.

## ServerConfig 필드

| 필드 | 타입 | 새 서버에 필수 | 설명 |
| ----------------------- | ---------- | ------------------------: | -------------------------------------------------------------------------------------------------------- |
| `command` | `string` | 예 | 실행 파일 이름(로컬 실행 파일 디렉터리 / PATH에서 확인) 또는 절대 경로 |
| `args` | `string[]` | 아니요 | 실행 파일에 전달할 인수 |
| `fileTypes` | `string[]` | 예 | 확장자 또는 파일 이름. 예: `[".ts", ".tsx", "Dockerfile"]`. 대소문자를 구분하지 않으며 앞의 점은 있어도 없어도 됨 |
| `languageId` | `string` | 아니요 | `textDocument/didOpen`에 전달할 LSP 언어 ID. 생략하면 파일 경로에서 추론 |
| `rootMarkers` | `string[]` | 예 | 프로젝트 루트를 나타내는 파일/디렉터리. `*.cabal` 같은 단일 단계 와일드카드 지원 |
| `initOptions` | `object` | 아니요 | LSP 핸드셰이크에서 `initializationOptions`로 전달 |
| `settings` | `object` | 아니요 | `workspace/didChangeConfiguration`으로 전달 |
| `disabled` | `boolean` | 아니요 | `true`이면 이 서버 비활성화 |
| `warmupTimeoutMs` | `number` | 아니요 | 준비 초기화 제한 시간(밀리초). 기본값 5000, 내장 marksman은 2000 |
| `isLinter` | `boolean` | 아니요 | 전용 린터/포매터 서버로 표시. 타입 분석에서는 제외하지만 `formatOnWrite` 포매터 선택 시 타입 검사 서버보다 우선 |
| `capabilities` | `object` | 아니요 | 서버별 선택 기능. [기능](#capabilities) 참조 |
| `workspaceReadyTimings` | `object` | 아니요 | 고급 rust-analyzer 워크스페이스 준비 시간 재정의. 아래 참조 |

내장 서버 재정의에서는 검증 전에 필수 필드를 상속하므로 생략할 수 있습니다. 완전히 새로운 서버는 일반적으로 세 필드가 모두 필요합니다. `resolvedCommand`와 `createClient`는 런타임이 관리하는 필드이므로 설정하지 마세요.

플러그인 호환 정의에서는 `initOptions`가 객체가 아니면 `initializationOptions`를 허용합니다. `extensionToLanguage`의 키로 `fileTypes`를 제공할 수 있으며, `rootMarkers`가 없으면 `["."]`를 사용합니다. 그 값은 확장자별 언어 ID를 설정하지 않습니다. 마켓플레이스 항목은 인라인 `lspServers` 맵 또는 플러그인 루트 안의 설정 파일 경로를 제공할 수 있습니다.

<a id="capabilities"></a>
### 기능

`capabilities` 객체는 OMP가 서버별로 지원하는 선택 기능을 활성화합니다.

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

모든 필드는 선택적 불리언 값입니다. 현재 `rust-analyzer`에서 사용합니다.

### 고급 rust-analyzer 준비 시간

`workspaceReadyTimings`는 rust-analyzer의 워크스페이스 준비 상태 폴링을 조정합니다.

```json
{
  "servers": {
    "rust-analyzer": {
      "workspaceReadyTimings": {
        "timeoutMs": 30000,
        "pollMs": 250,
        "settleMs": 2000,
        "statusRequestTimeoutMs": 2000
      }
    }
  }
}
```

네 필드는 모두 선택적인 밀리초 값입니다. 기본값은 `timeoutMs: 5000`, `pollMs: 100`, `settleMs: 2000`, `statusRequestTimeoutMs: 1000`입니다. 고급 조정용 설정이므로 일반적인 구성에서는 기본값을 사용하세요.

## 자주 사용하는 구성

### 내장 서버 설정 재정의

부분 재정의는 내장 기본값에 병합됩니다. 바꾸려는 필드만 지정하면 됩니다.

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### 내장 서버 비활성화

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### 사용자 지정 서버 등록

새 네이티브 형식 서버는 비어 있지 않은 `command`, `fileTypes`, `rootMarkers`가 필요합니다. 잘못된 새 정의는 경고와 함께 무시하며, 잘못된 재정의는 이전 서버 정의를 유지합니다. 읽을 수 없는 파일이나 잘못된 JSON/YAML은 무시하고 나머지 출처를 계속 읽습니다.

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### 전역 유휴 제한 시간 설정

5분 이상 사용하지 않은 언어 서버를 종료합니다.

```json
{
  "idleTimeoutMs": 300000
}
```

### 전역 설정을 유지하면서 한 프로젝트에서만 서버 비활성화

재정의를 `<project>/.omp/lsp.json`에 넣습니다.

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

`~/.omp/agent/lsp.json`의 사용자 설정에는 영향이 없습니다. pylsp는 이 프로젝트에서만 비활성화됩니다.

## 내장 서버 목록

다음 서버는 `defaults.json`에 포함되며 자동 감지 대상입니다.

| 서버 키 | 언어 | 실행 파일 |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC, CUDA            | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript (≤ 6)  | `typescript-language-server`      |
| `typescript-native`           | TypeScript, JavaScript (7+)   | `tsc --lsp --stdio`               |
| `denols`                      | TypeScript, JavaScript (Deno) | `deno`                            |
| `biome` | TS/JS/JSON/CSS (린터) | `biome` |
| `eslint` | TS/JS/Vue/Svelte (린터) | `vscode-eslint-language-server` |
| `vscode-html-language-server` | HTML                          | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS, SCSS, Less               | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                          | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML, CSS, TS/JS              | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                        | `svelteserver`                    |
| `vue-language-server`         | Vue                           | `vue-language-server`             |
| `astro`                       | Astro                         | `astro-ls`                        |
| `pyright`                     | Python                        | `pyright-langserver`              |
| `basedpyright`                | Python                        | `basedpyright-langserver`         |
| `pylsp`                       | Python                        | `pylsp`                           |
| `ty`                          | Python                        | `ty`                              |
| `ruff` | Python (린터) | `ruff` |
| `jdtls`                       | Java                          | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                        | `kotlin-lsp`                      |
| `metals`                      | Scala                         | `metals`                          |
| `hls`                         | Haskell                       | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                         | `ocamllsp`                        |
| `elixirls`                    | Elixir                        | `elixir-ls`                       |
| `expert`                      | Elixir                        | `expert`                          |
| `erlangls`                    | Erlang                        | `erlang_ls`                       |
| `gleam`                       | Gleam                         | `gleam`                           |
| `solargraph`                  | Ruby                          | `solargraph`                      |
| `ruby-lsp`                    | Ruby                          | `ruby-lsp`                        |
| `rubocop` | Ruby (린터) | `rubocop` |
| `bashls`                      | Bash, Zsh                     | `bash-language-server`            |
| `lua-language-server`         | Lua                           | `lua-language-server`             |
| `intelephense`                | PHP                           | `intelephense`                    |
| `phpactor`                    | PHP                           | `phpactor`                        |
| `omnisharp`                   | C#                            | `omnisharp`                       |
| `yamlls`                      | YAML                          | `yaml-language-server`            |
| `terraformls`                 | Terraform                     | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                    | `docker-langserver`               |
| `helm-ls`                     | Helm                          | `helm_ls`                         |
| `nixd`                        | Nix                           | `nixd`                            |
| `nil`                         | Nix                           | `nil`                             |
| `ols`                         | Odin                          | `ols`                             |
| `dartls`                      | Dart                          | `dart`                            |
| `marksman`                    | Markdown                      | `marksman`                        |
| `texlab`                      | LaTeX                         | `texlab`                          |
| `graphql`                     | GraphQL                       | `graphql-lsp`                     |
| `prismals`                    | Prisma                        | `prisma-language-server`          |
| `vimls`                       | Vim script                    | `vim-language-server`             |
| `emmet-language-server`       | HTML, CSS, JSX                | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                         | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift (linter)                | `swiftlint`                       |
| `tlaplus`                     | TLA+                          | `tlapm_lsp`                       |

프로젝트마다 TypeScript 서버는 하나만 유지합니다. 확인된 `tsc`가 `lib/tsserver.js`가 없는 TypeScript 설치(TypeScript 7+)에 속하면 해당 설치를 구동할 수 없는 `typescript-language-server` 대신 `typescript-native`를 사용합니다. 그 외에는 이전 `tsc`가 `--lsp`를 거부하므로 `typescript-native`를 제외합니다.
