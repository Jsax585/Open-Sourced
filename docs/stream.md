# Stream: 터미널 라이브 방송

`omp stream`은 omp 세션을 `live.omp.sh/<username>`으로 방송합니다. 이 페이지는 실시간 터미널과 채팅 열이 있는 Twitch 스타일의 페이지입니다. 시청자는 비밀 정보를 제외하고 터미널에 표시되는 내용을 그대로 볼 수 있지만, 세션에 입력할 수는 없습니다.

Stream은 [Collab](collab.md)과 독립적입니다. Collab은 에이전트를 조작할 수 있는 게스트에게 세션 자체(항목, 이벤트, 프롬프트)를 복제합니다. 반면 Stream은 렌더링된 화면 행만 시청자에게 단방향으로 전송합니다.

## 빠른 시작

방송하려면 stencil.so 계정이 필요합니다. 아무 omp 세션에서 `/login` → **Stencil (invite only)**로 한 번 로그인하세요. 자격 증명은 다른 로그인 정보와 함께 저장되며 자동으로 갱신됩니다. 스크립트와 로컬 개발에서는 `STENCIL_API_KEY=<token>`으로 저장된 자격 증명을 재정의할 수 있습니다. `STENCIL_AUTH_URL`은 로그인 주소(`auth.stencil.so`)를, `STENCIL_BASE_URL`은 Stencil API 주소(`api.stencil.so`)를 로컬 서버로 변경합니다.

Stencil 사용자 이름이 곧 채널입니다. 서버가 Bearer 토큰에서 이를 추출하므로 `omp stream`에는 채널 인수가 없습니다.

작업 디렉터리에서 다음을 실행합니다.

```
omp stream --title "Refactoring the parser"
```

출력은 다음과 같습니다.

```
● live.omp.sh/your_username  "Refactoring the parser"
  waiting for sessions in /work/proj …
```

그런 다음 다른 터미널에서 같은 디렉터리의 대화형 omp를 시작하세요. 원하는 만큼 여러 번 시작해도 됩니다. `omp stream`이 실행 중일 때 시작한 각 대화형 세션은 자동으로 연결되고 바닥글에 `● LIVE 3`을 표시합니다(`3` = 현재 시청자 수). 시청자 페이지에서는 각 세션이 별도 창으로 표시되며, 세션이 종료되면 해당 창이 사라집니다. 방송 프로세스에서 Ctrl-C를 누르면 방송이 끝나고 연결된 모든 세션의 배지가 사라집니다.

`omp stream`이 시작되기 전에 이미 실행 중이던 세션은 연결되지 않습니다. 해당 세션을 다시 시작하세요.

특정 디렉터리에서는 하나의 `omp stream` 프로세스만 수신 대기할 수 있으며, 서버는 같은 채널의 두 번째 라이브 호스트를 거부합니다. 원격 연결이 끊어지면 방송 프로세스는 다시 연결한 뒤 각 창의 현재 뷰포트와 제한된 분량의 기록을 재전송합니다. 놓친 채팅은 재전송하지 않습니다.

### 방송 콘솔

터미널에서 `omp stream`은 전체 화면 채팅 콘솔로 실행됩니다. 헤더에는 라이브 배지, 채널, 제목, stencil.so 사용자 이름, 시청자 URL, 시청자 수, 연결된 창이 표시됩니다. 그 아래에는 채팅 및 이벤트 로그가 있고, 맨 아래에는 입력 줄이 있습니다.

| 입력 | 동작 |
| ---------------- | ------------------------------------------------------- |
| `<text>` + Enter | 채널 소유자로 채팅 메시지 보내기 |
| `/title <text>` | 방송 제목 변경 |
| `/quit`, Ctrl-C | 방송 중지(세션 연결이 해제되고 채널이 오프라인으로 전환됨) |
| 위 / 아래 화살표 | 이전 메시지 불러오기 |

`--no-tui`를 사용하거나 stdout/stdin이 TTY가 아니면 줄 단위 로그로 전환되며, stdin의 각 줄이 채팅으로 전송됩니다(`/title`은 계속 인식하지만 `/quit`은 TUI 전용입니다). 어느 콘솔에서든 Ctrl-C로 중지할 수 있습니다.

### 옵션과 설정

| 플래그 / 설정 | 의미 |
| ------------------------- | -------------------------------------------------------------------------------- |
| 채널 | 서버가 Bearer 토큰에서 추출한 Stencil 사용자 이름 |
| `--title <text>` | 방송 제목(기본값: 디렉터리 이름, 최대 120자) |
| `--server <url>` | 방송 서버 기본 주소(기본값: `stream.serverUrl`) |
| `--no-tui` | 전체 화면 채팅 대신 줄 단위 로그 콘솔 사용 |
| `STENCIL_API_KEY` | Bearer 토큰 재정의. 지정하지 않으면 `/login`의 Stencil 자격 증명 사용 |
| `stream.serverUrl` | 기본 서버, `https://live.omp.sh` |
| `stream.redactPatterns` | 방송되는 모든 행에서 가릴 추가 정규식 |

## 컴퓨터 밖으로 전송되는 내용

화면 피드에는 세션 항목이 아니라 터미널 행과 창 메타데이터(제목 및 크기)가 포함됩니다. 채팅은 별도의 메시지 채널입니다. 세션 프로세스는 다음과 같이 동작합니다.

1. TUI가 방금 그린 행(스크롤백에 확정된 내용과 현재 뷰포트)을 가져옵니다.
2. 텍스트 스타일(SGR)과 하이퍼링크(OSC 8)를 제외한 모든 이스케이프 시퀀스를 제거합니다. 인라인 이미지는 `[image]`로 바뀝니다.
3. 행의 민감한 정보를 **가립니다**(아래 참조).
4. 마지막으로 전송한 뷰포트와 비교하여 행 패치를 보냅니다. 세션 항목, 프롬프트, 도구 인수, 파일 내용을 데이터로 전송하지는 않습니다.

행은 비공개 로컬 Unix 소켓(권한 `0600`, 디렉터리별 omp 런타임 디렉터리 아래에 위치하며 Windows에서는 명명된 파이프)을 통해 `omp stream` 프로세스로 전달됩니다. 이 프로세스는 여러 세션을 창으로 다중화하고, 기본적으로 WSS를 통해 JSON 화면 프레임을 서버로 전달합니다. 사용자 지정 `http`/`ws` 서버는 암호화되지 않은 WS를 사용합니다. 서버는 늦게 접속한 시청자에게 스냅샷을 제공하기 위해 각 창의 뷰포트와 최근 기록 2000행을 메모리에 유지하며, 영구 저장하지는 않습니다.

### 민감한 정보 가리기

가림 처리는 복원할 수 없으며 의도적으로 넓은 범위를 일치시킵니다. 일치한 문자열 구간은 `••••••`로 대체되고, 일치 항목이 있는 행은 스타일 없이 전송됩니다. 가림 처리 소스는 다음과 같습니다.

- 이름이 비밀 정보처럼 보이는 환경 변수(`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, …)의 값과, 이름에 관계없이 해당 디렉터리의 `.env` 파일에서 로드한 모든 값(8자 이상).
- `.omp/secrets.yml` 및 `~/.omp/agent/secrets.yml` 항목.
- 자격 증명 형태(GitHub/GitLab/OpenAI/Anthropic/AWS/Slack/Stripe/npm/HF 토큰, JWT, PEM 블록, `Bearer …`). 토큰을 입력 중이거나 한 글자씩 스트리밍하는 동안에도 가릴 수 있도록 공급업체 접두사는 길이 제한 **없이** 일치시킵니다.
- `NAME=value`, `NAME: value`, `"NAME": "value"`에서 `NAME`이 비밀 정보처럼 보이면 값을 가립니다(화면의 `read .env` 및 설정 파일에도 적용됨).
- 연결 URL의 비밀번호(`scheme://user:password@host`).
- `stream.redactPatterns`.

알려진 일반 값은 접두사(6자 이상)로도 일치시키므로 비밀 값을 완전히 입력하기 전에도 가릴 수 있습니다.

가림 처리는 한 번도 접하지 못한 비밀 정보를 알 수 없습니다. 다른 곳에서 붙여 넣은 토큰이 어떤 형태나 설정된 값에도 일치하지 않으면 그대로 표시됩니다. 특이한 형식에는 `stream.redactPatterns`나 `secrets.yml`을 사용하세요. 라이브 세션 중에 `stream.redactPatterns`를 수정하면 가림 처리기를 다시 로드하고 뷰포트를 다시 그리지만, 이미 전송한 행을 회수할 수는 없습니다. 채팅 메시지는 별도로 전송되며 터미널 행 가림 처리를 거치지 않습니다.

## 녹화

대화형 세션에서 `/record`를 실행하면 해당 세션 하나의 화면을 같은 파이프라인으로 캡처합니다. 정규화되고 민감한 정보가 가려진 행, 뷰포트 패치, 스크롤백 확정 내용을 소켓 대신 로컬 파일에 기록합니다. 계정이나 방송 프로세스가 필요 없으며 라이브 방송과 동시에 사용할 수도 있습니다. 녹화 중에는 바닥글에 `● REC`가 표시됩니다. `/record`를 다시 실행하면 녹화를 중지하고 경로를 출력합니다.

녹화는 `<tmpdir>/omp-recordings/<utc-time>-<session>.ompcast`에 기록됩니다. 이는 asciicast와 비슷한 JSON Lines 파일로, 헤더 줄 `{"ompcast":1,"cols":…,"rows":…,"title":…,"createdAt":…}` 다음에 화면 프레임(`reset`, `history`, `resize`, `viewport`, `patch`)마다 `[ms, frame]` 줄이 하나씩 이어집니다.

```
omp play                      # newest recording
omp play <file> -s 2 -i 1     # 2× speed, pauses capped at 1s
```

재생에는 대화형 터미널이 필요하며 일반 화면에서 실행됩니다. 녹화된 뷰포트는 터미널 하단을 차지하고, 녹화된 스크롤백은 터미널의 스크롤백으로 들어가므로 재생이 끝난 뒤에도 출력이 남습니다. Space로 일시 정지하거나 재개하고, `q`, Esc 또는 Ctrl-C로 종료합니다.

### 클립

```
omp clip                                          # newest recording
omp clip <file> -t "Streaming the lexer" -d "…"   # title and description
```

`omp clip`은 `omp stream`과 같은 Stencil 자격 증명으로 녹화 파일을 `live.omp.sh`에 업로드하고 해당 페이지 주소인 `live.omp.sh/c/<id>`를 출력합니다. `--server <url>`은 `stream.serverUrl`을 재정의합니다. 제목은 120자, 설명은 5000자로 제한됩니다. 페이지는 라이브 시청자의 터미널 창에서 클립을 재생하며, 아래에 제목, 설명, 댓글 스레드가 표시됩니다. Stencil로 로그인하면 시청자는 댓글을 달 수 있고 소유자는 제목과 설명을 수정할 수 있습니다. 행은 녹화 시 이미 가림 처리되었으며, 업로드할 때 컴퓨터에서 내용을 다시 읽지 않습니다.

## 서버

`live.omp.sh`는 작은 Go 서비스(stencil `apps/live`)입니다. 채널 목록(`GET /api/channels`, `GET /api/channels/<name>`), 홈페이지 미리보기(`GET /api/channels/<name>/preview` — 첫 번째 창의 뷰포트이며 시청자 수에 포함되지 않음), 인증된 신원에서 채널을 결정하는 호스트 소켓(`/ws/host`), 시청자 소켓(`/ws/watch/<name>`), 시청자별 전송 빈도 제한이 있는 채팅, 웹 UI(터미널 행은 `/fonts/`에서 제공되는 전체 Berkeley Mono Nerd Font로 렌더링됨)를 제공합니다. 통신 데이터 형식은 `@oh-my-pi/pi-wire/stream`에 정의되어 있습니다.

호스트는 stencil.so Bearer 토큰(호스트 소켓의 `Authorization: Bearer …`)으로 인증합니다. 서버는 발급자의 JWKS(`LIVE_ISSUER`, `LIVE_TOKEN_AUDIENCE`)로 이를 검증하며, 로컬 개발에서는 `STENCIL_API_KEY`와 짝을 이루는 정적 `LIVE_DEBUG_TOKENS` 목록으로 검증할 수도 있습니다. 각 호스트 채널은 인증된 Stencil 사용자 이름에서 직접 결정되므로 시청자는 항상 `live.omp.sh/<username>`에서 계정을 찾을 수 있습니다. 시청자는 익명으로 유지됩니다.
