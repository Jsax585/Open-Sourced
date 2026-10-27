# safety-hook

`tool_call` 차단을 보여 주는 `omp` 확장입니다. `bash` 도구 호출을 가로채고, 명령이 `rm -rf` 뒤에 절대 경로가 오는 패턴과 일치하면 `{ block: true, reason: "..." }`를 반환하여 도구 실행을 막습니다.

의도적으로 범위를 좁힌 이 정규식은 `/tmp/example` 같은 대상도 차단합니다. 셸 구문을 파싱하지 않으며 플래그 순서 변경, 인용, 별칭, 다른 삭제 도구, 직접 eval 헬퍼를 처리하지 못합니다. 완전한 안전 경계로 취급하지 마세요.

<a id="what-it-demonstrates"></a>
## 예제에서 보여 주는 기능

- `pi.on("tool_call", ...)` — 실행 전 가로채기
- `return { block: true, reason: "..." }` — 차단 계약
- bash 입력에 대한 정규식 검사(`/\brm\s+-rf\s+\//`)

<a id="install"></a>
## 설치

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

`omp`를 다시 시작하세요. 이 확장을 불러오는 세션에서 훅이 활성화됩니다.

이름 있는 프로필에서는 해당 프로필의 에이전트 확장 디렉터리를 사용하세요. `PI_CODING_AGENT_DIR`는 기본 프로필의 에이전트 디렉터리만 재정의하며 이름 있는 프로필에는 적용되지 않습니다. 초기화된 XDG 루트에 따라 이 위치가 달라질 수 있습니다.

또는 한 번만 불러올 수 있습니다.

```
omp --extension ./safety-hook
```

<a id="how-it-works"></a>
## 동작 방식

```
LLM이 bash 도구 호출
       │
       ▼
tool_call 핸들러 실행
       │
       ├─ 명령이 /\brm\s+-rf\s+\//에 일치하는가?
       │       예     → { block: true, reason: "..." }  ← 실행 중단, reason을 LLM에 전달
       │       아니요 → undefined                       ← 정상적으로 실행 계속
       ▼
도구 실행(차단되지 않은 경우)
```

LLM은 `reason` 텍스트를 도구 오류로 받으므로 호출이 거절된 이유를 이해하고 다른 접근법을 시도할 수 있습니다.
