# hello-extension

가장 흔한 두 가지 작성 패턴을 보여 주는 최소 구성의 `omp` 확장입니다. `session_start`를 구독해 불러올 때 알림을 표시하고, 대화에 인사를 보내는 `/hello` 슬래시 명령을 등록합니다. 의도적으로 작게 만들었으므로 복사해서 자신의 확장을 만드는 출발점으로 사용하세요.

<a id="install"></a>
## 설치

**방법 A — 사용자 확장 디렉터리에 넣기:**

```
cp -r . ~/.omp/agent/extensions/hello-extension
```

`omp`를 다시 시작하세요. 시작 알림이 즉시 표시됩니다.

`omp --profile <name>`을 사용할 때 기본 레이아웃에서는 `~/.omp/profiles/<name>/agent/extensions/hello-extension`을 사용하세요. `PI_CODING_AGENT_DIR`는 기본 프로필의 에이전트 디렉터리만 바꾸며 이름 있는 프로필에는 적용되지 않습니다. 초기화된 XDG 루트에 따라 이 위치가 달라질 수 있습니다.

**방법 B — 설정의 `extensions` 배열에 경로 지정:**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**방법 C — CLI 플래그로 한 번만 불러오기:**

```
omp --extension ./hello-extension
```

<a id="usage"></a>
## 사용법

불러온 뒤 omp 프롬프트에 `/hello` 또는 `/hello Ada`를 입력하세요. 이 명령은 표시되는 인사 사용자 지정 메시지를 대화에 보내고 "Message sent!" 알림을 표시합니다.

<a id="what-it-demonstrates"></a>
## 예제에서 보여 주는 기능

- `ExtensionAPI`를 받는 기본 내보내기 팩터리
- `pi.on("session_start", ...)` — 세션 수명 주기 훅
- `pi.registerCommand(...)` — 슬래시 명령 등록
- `ctx.ui.notify(...)` — 사용자에게 표시하는 알림
- `omp.extensions` 매니페스트 필드가 있는 `package.json`
