# 비밀 정보 난독화

LLM 제공자에게 전송하는 대화 메시지에서 민감한 값(API 키, 토큰, 비밀번호)을 가립니다. 이 기능을 활성화하면 지원되는 메시지 및 재전송 텍스트 필드에서 설정된 비밀 정보와 내장 자격 증명 형태의 토큰 패턴을 대체합니다. 정적 시스템 프롬프트, 정적 도구 정의, 바이너리 페이로드에는 이 하위 시스템의 가림 처리가 적용되지 않습니다. 복원 가능한 자리표시자는 모델이 작성한 도구 인수에서 실행 전에 복원되며, 로컬 세션 컨텍스트를 표시하거나 재개하기 위해 재구성할 때도 복원됩니다.

## 활성화

기본적으로 비활성화되어 있습니다. `/settings` UI에서 전환하거나 `config.yml`에 직접 설정할 수 있습니다.

```yaml
secrets:
  enabled: true
```

## 작동 방식

1. 세션 시작 시 다음 소스에서 비밀 정보를 수집합니다.
   - 이름이 일반적인 비밀 정보 패턴(`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`)에 일치하고 값의 길이가 8자 이상인 **환경 변수**
   - **`secrets.yml` 파일**(아래 참조)
   - 세션 내용이나 도구 결과에만 나타나는 일반적인 자격 증명 형태를 탐지하는 내장 복원 가능 정규식: GitHub, GitLab, OpenAI, Anthropic 토큰, AWS 액세스 키, Google API 키, Slack 토큰, npm 토큰, Stripe 비밀 키 및 제한된 키와 웹훅 비밀 값, Hugging Face 토큰, SendGrid 키, JWT, Bearer 헤더 토큰, PEM 개인 키 블록
   - 연결 URL 환경 변수 값에 포함된 비밀번호 — `scheme://user:password@host` 형태의 값이 있는 모든 변수(예: `DATABASE_URL`)는 변수 이름과 관계없이 비밀번호 길이가 8자 이상이면 등록됩니다. 원본과 퍼센트 디코딩된 형태 모두 이 길이 조건을 충족하면 수집됩니다.

2. 제공자에게 보이는 텍스트에서 일치하는 값을 `$$3P8W5JH1TK2Q$$`, `$$3P8W5JH1TK2Q:L$$`, `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$` 같은 결정적 자리표시자로 대체합니다.

3. 모델이 실시간으로 작성한 도구 인수의 중첩 구조를 모두 순회하며 도구 실행 전에 자리표시자를 복원합니다. 세션 컨텍스트는 로컬 표시 및 재개를 위해 자리표시자를 복원하고, 제공자에게 재전송하기 전에 다시 난독화합니다. replace 모드의 치환은 단방향이며 복원되지 않습니다.

각 비밀 정보의 처리 방식은 두 가지 모드로 제어합니다.

| 모드                  | 동작                                                                                      | 복원 가능 |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate` (기본값) | 결정적 `$$HASH(:hint)$$` 또는 `$$FRIENDLY_HASH(:hint)$$` 자리표시자로 대체 | 예 |
| `replace` | 설정된 `replacement`로 대체하며, 생략하면 길이가 같은 결정적 값으로 대체 | 아니요 |

일반적인 짧은 단어를 가리지 않도록 obfuscate 모드에서는 8자 미만의 일반 값과 정규식 일치를 무시합니다. replace 모드는 짧은 값도 처리할 수 있습니다. 사용자 지정 대체 값이 없는 replace 모드 정규식은 가능한 모든 1~2자 일치를 서로 구별되는 안정적인 값으로 가릴 수 없는 경우에만 거부됩니다.

## secrets.yml

YAML로 사용자 지정 비밀 정보 항목을 정의합니다. 다음 두 위치를 확인합니다.

| 수준 | 경로 | 용도 |
| ------- | -------------------------- | --------------------------- |
| 전역 | `<active-agent-dir>/secrets.yml` (일반적으로 `~/.omp/agent/secrets.yml`) | 해당 에이전트 디렉터리를 사용하는 프로젝트 전반의 비밀 정보 |
| 프로젝트 | `<cwd>/.omp/secrets.yml` | 프로젝트별 비밀 정보 |

프로젝트 항목은 `content`가 일치하는 전역 항목을 덮어씁니다. 전역 위치는 이름 있는 프로필과 SDK의 명시적 에이전트 디렉터리 재정의를 포함하여 세션의 에이전트 디렉터리를 따릅니다.

### 스키마

배열의 각 항목에는 다음 필드가 있습니다.

| 필드 | 타입 | 필수 | 설명 |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type` | `"plain"` 또는 `"regex"` | 예 | 일치 전략 |
| `content` | string | 예 | 비밀 값(plain) 또는 정규식 패턴(regex) |
| `mode` | `"obfuscate"` 또는 `"replace"` | 아니요 | 기본값: `"obfuscate"` |
| `replacement` | string | 아니요 | 사용자 지정 대체 값(replace 모드 전용) |
| `flags` | string | 아니요 | 정규식 플래그(regex 타입 전용) |
| `friendlyName` | string | 아니요 | obfuscate 모드 자리표시자에서 모델에 표시할 정제된 레이블 |

### 예제

#### 일반 비밀 값

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### 알기 쉬운 이름

`friendlyName`은 비밀 값을 노출하지 않으면서 복원 가능한 난독화 자리표시자에 의미적 맥락을 더합니다.

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

이렇게 하면 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$` 형태의 자리표시자가 생성됩니다. 알기 쉬운 이름은 대문자와 숫자만 남도록 정제되고 최대 32자로 제한되며, 정제 후 빈 값이 되면 생략됩니다. 선택적 `friendlyName` 메타데이터가 잘못되어도 비밀 정보 항목은 비활성화되지 않으며, 레이블 없는 자리표시자로 계속 난독화됩니다. 특정 자리표시자의 레이블이 설정된 리터럴 비밀 값을 노출하거나 설정된 비밀 정보 정규식에 일치하는 경우에도 해당 레이블은 제거됩니다.

네이티브 Responses 재전송의 평문도 난독화됩니다. 여기에는 메시지 텍스트, 도구 인수 및 결과, 파일 및 웹 검색 텍스트가 포함됩니다. `mcp_list_tools`, `tool_search_output`, `additional_tools`의 동적 정의에서도 도구 및 네임스페이스 설명, 셸 스킬 설명, MCP 주석, 스키마의 설명용 주석과 예제를 가립니다. 스키마 제약 조건(`enum`/`const` 포함), 실행 기본값, 알 수 없는 스키마 확장, 식별자, 인증 및 라우팅 설정, 문법은 변경되지 않으며 텍스트 가림 처리 대상이 아닙니다. 정적 `context.tools`, 시스템 프롬프트, 이미지 및 파일 바이트도 변경되지 않습니다.

네이티브 충돌 값은 가림 처리 전에 동일한 필드 순회를 통해 수집되므로, 동적 정의나 검색 항목에만 있는 값도 기록이나 대기 중인 어드바이저 업데이트의 기존 알기 쉬운 접두사를 무효화할 수 있습니다. 어드바이저는 유지 관리 커밋 후 새로 발견된 값이 포함된 스냅샷까지 포함하여 재전송 내용과 다음 압축의 원본을 다시 정제합니다. 암호화된 재전송과 알 수 없는 프로토콜 변형은 내부를 볼 수 없는 상태로 유지됩니다. 암호화된 기록은 소급하여 검사하거나 다시 쓸 수 없습니다.

12자 해시 본문은 설치별 비공개 키를 사용하여 정확한 비밀 값에 대해 계산한 HMAC입니다. 이 키는 `~/.omp/agent/secret-placeholder.key`에 저장되며, XDG가 활성화된 설치에서는 `$XDG_STATE_HOME/omp/secret-placeholder.key`에 저장됩니다. 모델에는 절대 전송되지 않습니다. 따라서 대화 기록을 읽는 사람이 사전의 후보 값을 해싱하여 자리표시자에서 비밀 값을 역추적할 수 없습니다. 대소문자만 다른 비밀 값에도 독립적인 해시 본문이 부여되므로, 제공자는 자리표시자 하나를 보고 대소문자 힌트만 바꾸어 다른 자리표시자를 만들어 낼 수 없습니다. 지연 처리되는 내장 토큰 경로에서 키를 영구 저장할 수 없으면 세션은 경고를 표시하고 프로세스 수명 동안만 유지되는 임시 키를 사용합니다. 해당 프로세스 안에서는 난독화를 계속 복원할 수 있지만, 재시작 후에는 자리표시자가 동일하게 유지되지 않습니다. 대소문자 힌트 접미사는 가려진 값의 대소문자 형태를 나타냅니다.

| 힌트 | 의미 |
| ---- | ---------------------------------------------- |
| `:U` | 대소문자 구분이 있는 모든 ASCII 문자가 대문자 |
| `:L` | 대소문자 구분이 있는 모든 ASCII 문자가 소문자 |
| `:C` | 대소문자 구분이 있는 첫 ASCII 문자는 대문자, 나머지는 소문자 |
| `:M` | ASCII 대소문자가 혼합됨 |

정규식 항목의 `friendlyName`은 일치한 값이 아니라 설정된 정규식 항목을 나타냅니다. 모든 일치 결과에 적용될 수 있도록 정규식 레이블을 충분히 포괄적으로 지정하세요.

#### 정규식 비밀 정보

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

정규식 항목은 항상 전체를 검색합니다(`g` 플래그가 자동으로 적용됩니다). `content`와 `flags` 필드를 따로 지정하는 대신 `/pattern/flags` 정규식 리터럴 구문도 사용할 수 있습니다. 패턴 안의 이스케이프된 슬래시(`\\/`)도 올바르게 처리됩니다.

#### 정규식을 사용하는 replace 모드

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## 잘못된 항목과 파일

- `secrets.yml`이 없으면 항목이 없는 것으로 처리합니다.
- 파싱에 실패하거나 문서가 배열이 아니면 경고와 함께 무시합니다.
- 잘못된 항목은 각각 경고와 함께 건너뜁니다. `type`은 `plain` 또는 `regex`여야 하고, `content`는 비어 있지 않은 문자열이어야 합니다. `mode`, `replacement`, `flags`, 정규식 구문은 위 설명에 따라 검증됩니다.
- 선택적 `friendlyName` 메타데이터가 잘못되었으면 이를 제거하되, 나머지가 유효한 항목 자체는 유지합니다.

## 자동 탐지와의 상호 작용

환경 변수를 먼저 수집하고 파일에 정의된 항목을 그다음에 수집하며, 내장 자격 증명 정규식은 마지막에 실행됩니다. 따라서 일반 탐지기보다 설정된 항목이 일치하는 내용을 먼저 처리합니다. 환경 변수 검색 중 중복 값은 하나로 합쳐집니다. 환경 변수 항목과 파일 항목 사이에서는 중복을 제거하지 않으므로, 양쪽에 있는 일반 값은 두 번 등록됩니다. 두 자리표시자 모두 같은 비밀 값으로 복원되므로 난독화 해제에는 영향이 없습니다.

## 주요 파일

- `packages/coding-agent/src/secrets/index.ts` -- 로드, 병합, 환경 변수 수집
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` 클래스, 자리표시자 생성, 메시지 난독화
- `packages/coding-agent/src/secrets/regex.ts` -- 정규식 리터럴 파싱 및 컴파일
- `packages/coding-agent/src/secrets/message-transform.ts` -- 제공자 컨텍스트 및 로컬 컨텍스트 변환
- `packages/coding-agent/src/secrets/patterns.ts` -- 내장 자격 증명 패턴
- `packages/coding-agent/src/secrets/settings.ts` -- `secrets.enabled` 설정 정의

## 함께 보기

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- 제공자 OAuth 갱신 토큰과 액세스 토큰을 개발자 호스트에 전혀 두지 않도록 하는 원격 자격 증명 저장소 및 정방향 프록시(프로세스 내부 난독화를 보완).
