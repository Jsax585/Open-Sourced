# 테마 참조

이 문서는 현재 coding-agent의 테마 스키마, 로딩, 런타임 동작과 실패 방식을 설명합니다.

## 테마 시스템이 제어하는 요소

테마 시스템은 다음을 제어합니다.

- TUI 전반에서 사용하는 전경/배경 색상 토큰
- Markdown 스타일 어댑터(`getMarkdownTheme()`)
- 선택기/편집기/설정 목록 어댑터(`getSelectListTheme()`, `getEditorTheme()`, `getSettingsListTheme()`)
- 기호 프리셋과 개별 기호 재정의(`unicode`, `nerd`, `ascii`)
- 네이티브 구문 강조기(`@oh-my-pi/pi-natives`)의 색상
- 상태 줄 구간별 색상

주요 구현: `packages/tui/src/theme/theme.ts`.

## 테마 JSON 구조

사용자 지정 테마 파일은 `packages/tui/src/theme/schema-validation.ts`의 `validateThemeJson()`이 `@oh-my-pi/omptype`로 검증하는 JSON 객체입니다. 타입은 `schema.ts`에 있고, 편집기용 JSON 스키마는 `packages/tui/src/theme/theme-schema.json`입니다. 내장 테마는 런타임 검증을 건너뜁니다.

최상위 필드:

- `name`(필수)
- `colors`(필수, `thinkingMax`를 제외한 모든 토큰 필수)
- `vars`(선택, 재사용할 색상 변수)
- `export`(선택, HTML 내보내기 색상)
- `symbols`(선택)
  - `preset`(선택: `unicode | nerd | ascii`)
  - `overrides`(선택: `SymbolKey`의 키/값 재정의)

색상 값으로 다음을 사용할 수 있습니다.

- 16진수 문자열(`"#RRGGBB"`)
- 숫자로 지정한 256색 인덱스(`0..255` 사용, 런타임 스키마는 숫자에 이 범위를 강제하지 않음)
- 변수 참조 문자열(`vars`를 통해 해석)
- 터미널 기본값을 뜻하는 빈 문자열(`""`): 전경은 `\x1b[39m`, 배경은 `\x1b[49m`

## 필수 및 선택 색상 토큰

아래 토큰은 `thinkingMax`(`thinkingXhigh`로 대체)와 `assistantMessageText`(미설정/빈 값이면 터미널 기본 전경 유지)를 제외하고 모두 `colors`에 필요합니다.

### 기본 텍스트와 테두리(11개)

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`

### 배경 블록(7개)

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `statusLineBg`

### 메시지/도구 텍스트(필수 5개, 선택 1개)

`userMessageText`, `customMessageText`, `customMessageLabel`, `toolTitle`, `toolOutput`, 선택 항목 `assistantMessageText`

`assistantMessageText`는 어시스턴트 응답의 일반 문단 텍스트 색상을 지정합니다(Markdown 하위 요소는 자체 `md*` 토큰 유지). 어시스턴트 본문을 제어하는 토큰은 `text`가 아니라 이 토큰입니다. `text`는 명시적인 `theme.fg("text", …)` 호출 지점(편집기/대화 상자)에만 적용되며 어시스턴트 메시지 본문에는 적용되지 않습니다. `assistantMessageText`를 생략하거나 `""`로 설정하면 이 토큰이 없던 때와 동일하게 터미널 기본 전경으로 표시됩니다. 명시적으로 설치한 본문 색상 변환(실시간 명령 출력)은 여전히 이 토큰보다 우선합니다.

### Markdown (10)

`mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`

### 도구 diff와 구문 강조(12개)

`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`,
`syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`

### 모드/추론 테두리(필수 8개, 선택 1개)

`thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, 선택 항목 `thinkingMax`, `bashMode`, `pythonMode`

### 상태 줄 구간별 색상(13개)

`statusLineSep`, `statusLineModel`, `statusLinePath`, `statusLineGitClean`, `statusLineGitDirty`, `statusLineContext`, `statusLineSpend`, `statusLineStaged`, `statusLineDirty`, `statusLineUntracked`, `statusLineOutput`, `statusLineCost`, `statusLineSubagents`

## 선택 토큰

### `export` 섹션(선택)

HTML 내보내기 테마 도우미에 사용합니다.

- `export.pageBg`
- `export.cardBg`
- `export.infoBg`

생략하면 내보내기 코드가 해석된 테마 색상에서 기본값을 계산합니다.

### `symbols` 섹션(선택)

- `symbols.preset`은 테마 수준의 기본 기호 집합을 설정합니다.
- `symbols.overrides`로 개별 `SymbolKey` 값을 재정의할 수 있습니다.
- `symbols.spinnerFrames`는 로딩 스피너 프레임을 재정의합니다. 두 스피너 유형에 모두 적용되는 단일 `string[]` 또는 유형별로 재정의하는 객체 `{ "status"?: string[], "activity"?: string[] }`를 받습니다. 지정하지 않은 유형은 기호 프리셋의 기본 프레임을 사용합니다. `status`는 로더와 도구 실행 표시기의 약 12.5fps 스피너를, `activity`는 Markdown 진행률 표시줄 등 고빈도 UI의 약 30fps 스피너를 제어합니다.

런타임 우선순위:

1. 설정의 `symbolPreset` 재정의(설정된 경우)
2. 테마 JSON의 `symbols.preset`
3. 기본값 `"unicode"`

대화형 모드에서 Glyph Protocol 핸드셰이크가 성공하면 설정 출처가 `default`인 Unicode 프리셋을 저장된 설정을 바꾸지 않고 Nerd Font 아이콘으로 업그레이드합니다. `unicode`를 포함해 명시적으로 설정한 프리셋은 업그레이드하지 않습니다. Tern 네이티브 화면이 열려 있는 동안에는 현재 프로세스에서 Nerd 프리셋을 강제하고 닫히면 사용자 프리셋을 복원합니다.

잘못된 재정의 키는 무시하고 로그에 기록합니다(`logger.debug`).

#### 상자 그리기 테두리

도구 결과 프레임, 오버레이, 코드 블록, 편집기, 환영 배너 등 윤곽선이 있는 모든 UI는 `boxRound.*` 토큰으로 그립니다. 둥근 모서리(`╭╮╰╯`)와 T자/십자 연결부(`├┤┬┴┼`)를 사용하며, 연결부는 둥근 Unicode 형태가 없어 `boxSharp.*` 토큰에서 가져옵니다. 유일한 예외인 Markdown 표는 완전히 각진 `boxSharp.*` 집합(`┌┐└┘`)을 유지합니다.

이 구분에 따른 재정의 동작은 다음과 같습니다.

- `boxRound.{topLeft,topRight,bottomLeft,bottomRight,horizontal,vertical}`은 모든 테두리의 모서리와 변 스타일을 바꿉니다.
- `boxSharp.{cross,teeDown,teeUp,teeRight,teeLeft}`는 둥근 프레임과 표 모두의 구분선/연결부 스타일을 바꿉니다.
- `boxSharp.{topLeft,topRight,bottomLeft,bottomRight}`는 이제 Markdown 표 모서리에만 영향을 줍니다.

## 내장 및 사용자 지정 테마 소스

테마 조회 순서(`loadThemeJson`):

1. 내장 테마(`dark.json`, `light.json`, `defaultThemes`에 컴파일된 모든 `defaults/*.json`)
2. 사용자 지정 테마 파일: `<customThemesDir>/<name>.json`

사용자 지정 테마 디렉터리는 `getCustomThemesDir()`에서 결정합니다.

- 기본값: `~/.omp/agent/themes`
- 기본 프로필 재정의: `PI_CODING_AGENT_DIR`(`$PI_CODING_AGENT_DIR/themes`)
- 이름 있는 프로필: 설정된 루트 아래 `~/.omp/profiles/<name>/agent/themes`. 이름 있는 프로필은 자체 에이전트 디렉터리를 사용합니다.

`getAvailableThemes()`는 내장 및 사용자 지정 이름을 합쳐 정렬해 반환하며, 이름이 충돌하면 내장 테마가 우선합니다.

## 로딩, 검증, 값 해석

사용자 지정 테마 파일은 다음 순서로 처리합니다.

1. JSON 읽기
2. JSON 파싱
3. `validateThemeJson()`으로 검증(필수 필드와 문자열/숫자 타입, 스피너 프레임 배열은 비어 있으면 안 됨)
4. `vars` 참조를 재귀적으로 해석
5. 터미널 기능 모드에 따라 해석된 값을 ANSI로 변환

검증 동작:

- 필수 색상 토큰 누락: 누락 항목을 묶어 명시적인 오류 메시지 표시
- 잘못된 토큰 타입: 런타임 스키마 오류. 문자열 색상 값과 변수 참조는 해석/변환 중 검사
- 알 수 없는 테마 파일: `Theme not found: <name>`

변수 참조 동작:

- 중첩 참조 지원
- 없는 변수 참조 시 예외 발생
- 순환 참조 시 예외 발생

## 터미널 색상 모드 동작

색상 모드 감지(`theme/color.ts`의 `detectColorMode`):

- `WT_SESSION` => 트루컬러
- 그 외에는 공유 터미널 기능 모델의 `detectTerminalId()`와 `getTerminalInfo()`를 사용하며, `TerminalInfo.trueColor`가 참일 때만 트루컬러 선택

변환 동작:

- 16진수 -> `Bun.color(..., "ansi-16m" | "ansi-256")`
- 숫자 -> `38;5` / `48;5` ANSI
- `""` -> 기본 전경/배경으로 재설정

## 런타임 전환 동작

내보낸 `theme`는 번들된 확장 기능에서도 실시간 바인딩입니다. 전환 전후로 테마 인스턴스를 보관하지 말고 렌더링 콜백 내부에서 읽으세요. 확장 기능 렌더러 콜백은 전달받은 테마 인수를 사용해도 됩니다.

```ts
import { theme } from "@oh-my-pi/pi-coding-agent";

const renderStatus = () => theme.fg("accent", "Ready");
```

### 초기 테마(`initThemeSync` / `initTheme`)

시작 시 입력창은 첫 화면을 그리기 전에 캐시된 테마를 동기적으로 초기화합니다. 이후 `main.ts`가 다음 설정으로 실제 적용할 테마를 초기화합니다.

- `symbolPreset`
- `colorBlindMode`
- `theme.dark`
- `theme.light`

자동 테마 슬롯 선택은 다음 순서로 터미널 외관을 판단합니다.

1. macOS/Zellij 대체 경로가 활성화되지 않았다면 터미널이 OSC 11로 보고한 배경 휘도
2. `COLORFGBG` 배경 인덱스(`< 8`이면 어두운 테마, `>= 8`이면 밝은 테마)
3. 문제가 알려진 macOS/Zellij OSC 11 경로에서만 macOS 외관 대체 감지
4. 어두운 테마 슬롯으로 대체

현재 기본값(`packages/coding-agent/src/modes/settings.ts`에 정의):

- `theme.dark = "titanium"`
- `theme.light = "light"`
- `symbolPreset = "unicode"`
- `colorBlindMode = false`

### 명시적 전환(`setTheme`)

- 선택한 테마 로드
- 실시간 `theme` 내보내기 갱신
- 선택적으로 파일 감시 시작
- `onThemeChange` 콜백 호출

실패 시:

- 내장 `dark`로 대체
- `{ success: false, error }` 반환

### 미리보기 전환(`previewTheme`)

- 실시간 `theme` 내보내기에 미리보기 적용
- 자체적으로 저장된 설정을 바꾸지는 **않음**
- 대체 테마로 바꾸지 않고 성공/오류 반환

설정 UI는 이를 실시간 미리보기에 사용하고 취소 시 이전 테마를 복원합니다.

## 파일 감시와 실시간 다시 로드

파일 감시가 활성화되면(`setTheme(..., true)` / 대화형 초기화):

- `<customThemesDir>/<currentTheme>.json` 파일이 있을 때만 감시합니다.
- 내장 테마는 사실상 감시하지 않습니다. 같은 이름의 사용자 지정 파일보다 내장 테마 조회가 우선합니다.
- 해당 파일이 바뀌면 디바운스된 다시 로드를 예약합니다. 다시 로드 오류나 일시적인 파일 부재 시 마지막으로 성공적으로 로드한 테마를 유지합니다.
- 파일 삭제/이름 변경 시 대체 테마로 전환하지 않으며, 이후 다시 로드가 성공하거나 명시적으로 테마를 전환할 때까지 기다립니다.

자동 모드는 터미널 외관 변경, `SIGWINCH`, 활성화된 macOS 대체 감시기를 통해 어두운/밝은 테마 슬롯 매핑도 다시 평가합니다.

## 색각 이상 지원 모드 동작

`colorBlindMode`는 런타임에 토큰 하나만 바꿉니다.

- `toolDiffAdded`를 HSV로 조정합니다(초록색을 파란색 쪽으로 이동).
- 해석된 값이 16진수 문자열일 때만 조정합니다.

다른 토큰은 바뀌지 않습니다.

## 테마 설정 저장 위치

테마 관련 설정은 `Settings`가 전역 구성 YAML에 저장합니다.

- 경로: `<agentDir>/config.yml`
- 기본 에이전트 디렉터리: `~/.omp/agent`
- 기본 파일 위치: `~/.omp/agent/config.yml`

저장되는 키:

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`

이전 형식 마이그레이션도 지원합니다. 단일 사용자 지정 값 `theme: "name"`은 휘도 감지에 따라 중첩된 `theme.dark` 또는 `theme.light`로 옮깁니다. 단일 값 `"dark"`/`"light"`는 삭제하여 현재 기본값을 적용합니다.

## 사용자 지정 테마 만들기

1. 사용자 지정 테마 디렉터리에 파일을 만드세요. 예: `~/.omp/agent/themes/my-theme.json`.
2. `name`, 선택적인 `vars`, **모든 필수** `colors` 토큰을 포함하세요.
3. 필요하면 `symbols`와 `export`를 포함하세요.
4. 원하는 자동 슬롯에 따라 설정의 `모양 -> 어두운 테마` 또는 `모양 -> 밝은 테마`에서 선택하세요.

최소 구성 예시:

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",
    "thinkingMax": "#ff007c",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## 사용자 지정 테마 테스트

다음 순서로 확인하세요.

1. 대화형 모드를 시작합니다(시작할 때 파일 감시 활성화).
2. 설정을 열고 테마 값을 미리 봅니다(실시간 `previewTheme`).
3. 사용자 지정 테마 파일은 실행 중 JSON을 편집하고 저장 시 자동으로 다시 로드되는지 확인합니다.
4. 주요 화면 요소를 확인합니다.
   - Markdown 렌더링
   - 도구 블록(대기/성공/오류)
   - diff 렌더링(추가/삭제/문맥)
   - 상태 줄 가독성
   - 추론 수준에 따른 테두리 변경
   - bash/python 모드 테두리 색상
5. 테마가 글리프 폭이나 모양에 의존한다면 두 기호 프리셋 모두 검증합니다.

## 제약과 주의 사항

- 사용자 지정 테마에는 선택 항목인 `thinkingMax`(`thinkingXhigh`로 대체)와 `assistantMessageText`(미설정 시 터미널 기본 전경 유지)를 제외한 모든 `colors` 토큰이 필요합니다.
- `export`와 `symbols`는 선택 사항입니다.
- 테마 JSON의 `$schema`는 정보 제공용입니다. 사용자 지정 테마의 런타임 검증은 `packages/tui/src/theme/schema-validation.ts`에서 `@oh-my-pi/omptype`로 수행합니다.
- `setTheme`가 실패하면 `dark`로 대체하지만 `previewTheme`가 실패하면 현재 테마를 바꾸지 않습니다.
- 파일 감시 중 다시 로드 오류나 일시적인 파일 부재가 발생하면 다시 로드가 성공하거나 명시적으로 테마를 전환할 때까지 현재 로드된 테마를 유지합니다.
