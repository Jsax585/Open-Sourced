<a id="eval-tool-python-backend"></a>
# Eval 도구 Python 백엔드

이 문서는 `packages/coding-agent`의 Python 실행 스택을 설명합니다.
도구 동작, 실행기 수명 주기, 환경 처리, 실행 의미론, 출력 렌더링, 지원하는 매직 명령, 운영 중 발생할 수 있는 오류를 다룹니다.

<a id="scope-and-key-files"></a>
## 범위와 주요 파일

- 도구 인터페이스: `src/tools/eval.ts`
- 세션별/호출별 커널 조정: `src/eval/py/executor.ts`
- 하위 프로세스 커널 클라이언트: `src/eval/py/kernel.ts`
- 공통 IPC/취소 클라이언트: `src/eval/kernel-base.ts`
- 공통 세션/초기화 소유권 관리: `src/eval/kernel-session-registry.ts`
- 독립형 `%load` 준비: `src/eval/input.ts`
- Python 래퍼 / NDJSON 서버: `src/eval/py/runner.py`
- 모든 커널에 로드되는 프렐류드 헬퍼: `src/eval/py/prelude.py`
- 호스트 측 하위 에이전트 헬퍼 브리지: `src/eval/agent-bridge.ts`
- 도구 출력 렌더러와 뷰 분리: `packages/tui/src/tools/eval.ts`
- 공통 출력 캡처: `packages/tui/src/tools/streaming-output.ts`
- 사용자가 실행한 Python 코드의 대화형 모드 렌더러: `packages/tui/src/chat/eval-execution.ts`
- 런타임/환경 필터링 및 Python 탐색: `src/eval/py/runtime.ts`

<a id="what-evals-python-backend-is"></a>
## eval의 Python 백엔드란

`eval` 도구는 stdin/stdout으로 NDJSON을 주고받는 지속 실행 Python 하위 프로세스 안에서 호출당 Python 셀 하나를 실행합니다. 실행기 자체에는 Jupyter 게이트웨이나 추가 pip 의존성이 필요하지 않습니다. 선택적 라이브러리(pandas, polars, matplotlib, PIL)는 별도로 설치하세요. 가용성 검사는 `python -c "import sys;sys.exit(0)"`를 실행하며, 인터프리터가 시작되는지만 확인하고 버전이나 모든 실행기 기능을 검사하지는 않습니다. `display()`는 없습니다. 출력 API는 `print`와 마지막 표현식의 자동 출력입니다([풍부한 print 출력](#rich-print) 참조).

현재 도구 입력:

```ts
{
  language: "py";
  code: string;    // inline source or a standalone %load / %pip install
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

세션 범위의 통신 스키마에는 활성화된 런타임("py", "js")만 표시됩니다. Python과 JavaScript는 기본적으로 활성화됩니다. 이 도구는 포그라운드 스케줄링에 `concurrency = "exclusive"`를 사용합니다. 자동 백그라운드 전환은 셀이 아직 실행 중일 때도 반환할 수 있으며, 커널에서 정의한 도구 요청에는 별도의 디스패치 경로가 있습니다. 따라서 배타적 도구 스케줄링은 전역 커널 잠금이 아닙니다. `session` 모드에서는 호출 간에 상태가 유지됩니다.

<a id="kernel-lifecycle"></a>
## 커널 수명 주기

각 Python 커널은 `<resolved-python> -u <runner.py>`라는 단일 하위 프로세스입니다. 실행기는 호스트 바이너리에 번들로 포함되며(Bun 텍스트 임포트), 스크립트 해시당 한 번씩 OS 임시 디렉터리 아래 사용자별 `omp-python-runner-<uid>` 캐시에 기록됩니다. 이후 프로세스를 시작할 때 재사용됩니다.

커널 시작 순서:

1. 가용성 검사(`checkPythonKernelAvailability`) — Python 인터프리터를 찾고 실행할 수 있는지 확인합니다.
2. 필터링한 환경과 `cwd`로 `python -u runner.py`를 시작합니다.
3. `os.chdir(cwd)`를 실행하고, 환경 항목을 주입하고, `cwd`를 `sys.path`에 추가하는 초기화 요청을 보냅니다.
4. `PYTHON_PRELUDE`를 실행합니다(멱등적이며 프로세스당 한 번만 초기화합니다).

커널 종료:

- stdin으로 `{"type": "exit"}`를 보냅니다.
- `SHUTDOWN_GRACE_MS` 시간 동안 프로세스 종료를 기다립니다.
- 제시간에 종료되지 않으면 `SIGTERM`, 마지막으로 `SIGKILL`로 단계적으로 강제 종료합니다.

<a id="wire-protocol-ndjson-host--runner"></a>
## 통신 프로토콜(NDJSON, 호스트 ↔ 실행기)

줄마다 JSON 객체 하나를 UTF-8로 보내며, 각 줄은 `\n`으로 끝납니다.

호스트 → 실행기:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "filename": "<optional source path>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

실행기 → 호스트:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "view",     "id": "<reqId>", "text": "...", "view": {"kind": "table"|"json"|"markdown", ...}}
{"type": "image",    "id": "<reqId>", "image": {"mimeType": "...", "data": "<base64>", "detail"?: "...", "url"?: "...", "providerFile"?: {...}}}
{"type": "status",   "id": "<reqId>", "event": {"op": "...", ...}}
{"type": "reply",    "id": "<reqId>", "value": {"ok": true, ...}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

- `view`에는 셀이 이미 `stdout`으로 출력한 `text`를 보기 좋게 렌더링한 결과가 담깁니다. 호스트는 `text`를 출력 스트림에 다시 추가하지 않습니다. 실행기는 `view`나 `image`를 보내기 전에 버퍼링된 stdout을 비우므로 텍스트가 먼저 전달됩니다.
- `image`는 모델과 사용자 모두에게 전달됩니다.
- `status`에는 프렐류드 헬퍼와 매직 명령이 TUI 상태 렌더러를 위해 내보내는 구조화된 이벤트(`_emit_status("find", count=…)`)가 담깁니다.
- `reply`는 도구 요청에 응답합니다([도구 가용성과 모드 선택](#tool-availability-and-mode-selection) 참조). `kernel-base.ts`는 이를 `KernelExecuteResult.reply`로 반환합니다.

<a id="magics"></a>
## 매직 명령

실행기의 소스 변환기는 파싱 전에 IPython 스타일 매직 명령을 일반 Python 호출로 변환합니다. 지원하는 명령은 다음과 같습니다.

| 매직 명령 | 효과 |
| --- | --- |
| `%pip <args>` | `python -m pip <args>`를 실행하고 출력을 실시간 스트리밍하며, 셀 감시 타이머를 일시 중지합니다. pip가 없는 인터프리터(`uv venv` 환경)에서는 먼저 `ensurepip`로 pip를 설치하고, 실패하면 `PATH`에 있는 `uv`로 설치합니다. 새로 설치한 패키지는 `sys.modules`에서 제거하여 다음 `import`가 새 설치본을 사용하게 합니다. |
| `%cd <path>` | `os.chdir(path)`를 실행하고(`~` 확장 지원), 상태 이벤트를 내보냅니다. |
| `%pwd` | `os.getcwd()`를 반환합니다. |
| `%ls [path]` | `sorted(os.listdir(path))`를 반환합니다. |
| `%env [KEY[=VAL]]` | 환경 변수를 나열하거나 읽거나 설정합니다(프렐류드 `env()`와 같은 의미론). |
| `%set_env KEY VALUE` | `os.environ[KEY]`를 설정합니다. |
| `%time <expr>` / `%timeit <stmt>` | `%time`은 한 번 평가합니다. `%timeit`은 `timeit.Timer.autorange()`를 사용하여 반복당 시간을 보고합니다. 둘 다 상태 이벤트를 내보냅니다. |
| `%who` / `%whos` | 사용자 네임스페이스의 이름을 나열합니다. |
| `%reset` | 사용자 전역을 지우고 실행기의 매직 내장 기능을 복원하지만 호스트 프렐류드는 복원하지 않습니다. 완전히 초기화된 새 커널이 필요하면 도구 입력 `reset: true`를 권장합니다. |
| `%load <path>` | 따옴표로 감싼 파일 경로를 유지된 네임스페이스에서 실행하며, 최상위 await와 파일명을 반영한 트레이스백을 지원합니다. 소스는 출력하지 않습니다. 독립형 `%load` 셀은 대신 호스트가 읽습니다(`local://` 지원). |
| `%run <path>` | `runpy.run_path`를 실행하고 전역을 다시 병합합니다. |
| `%%bash` | 셀 본문을 `bash`로 실행합니다. 등록된 유일한 셸 셀 매직입니다. `%%sh`는 없으며 등록되지 않은 이름은 `Cell magic function '%%<name>' not found` 오류를 발생시킵니다. |
| `%%capture [name]` | 본문을 실행하고 stdout/stderr를 `name`에 캡처합니다. |
| `%%timeit` | 셀 본문의 실행 시간을 측정합니다. |
| `%%writefile <path>` | 본문을 파일에 씁니다. |
| `!cmd` / `var = !cmd` | 하위 프로세스 셸로 명령을 실행하며, `.n` / `.s` 헬퍼가 있는 SList 스타일 결과를 반환합니다. |
| `var = %name args` | 줄 매직과 `!cmd`는 대입 형식을 지원합니다. |

알 수 없는 매직 이름은 셀 안에서 `NameError: UsageError: ...`를 발생시킵니다.

<a id="session-persistence-semantics"></a>
## 세션 상태 유지 의미론

`python.kernelMode`는 유지되는 커널의 재사용을 제어합니다.

- `session`(기본값)
  - 네임스페이스가 지정된 eval 세션 ID, 정규화된 cwd, 인터프리터를 키로 커널 세션을 재사용합니다.
  - 여러 소유자가 같은 키의 유지된 커널을 공유할 수 있습니다.
  - 도구를 통한 포그라운드 호출은 배타적으로 스케줄링되며, 백그라운드 셀과 커널에서 정의한 도구 요청은 별개입니다.
  - 종료된 하위 프로세스는 실행 전에 교체합니다.
  - 실행 중 하위 프로세스가 종료되면 완료 여부가 불확실하므로 셀을 재실행하지 않습니다. 다음 호출은 새 커널을 시작합니다.
- `per-call`
  - 호출마다 새 하위 프로세스를 시작합니다.
  - 호출 후 하위 프로세스를 종료합니다.
  - 호출 간에 상태를 유지하지 않습니다.

<a id="state-across-eval-calls"></a>
### eval 호출 간 상태

각 도구 호출에는 셀 하나가 들어 있으며, `session` 모드의 후속 호출은 선택된 유지 커널을 재사용합니다. 자동으로 백그라운드 전환된 셀의 변경 사항에 의존하기 전에 해당 셀이 완료될 때까지 기다리세요. 같은 유지 세션 키에 대한 동시 초기화는 하나로 합쳐지며, 초기화 뒤에 대기 중인 호출은 초기화가 끝날 때까지 기다립니다.

셀이 실패하더라도 오류 전에 완료된 정의와 변경 사항은 커널 메모리에 남을 수 있습니다. `reset: true`는 해당 호출 전에 선택한 언어 런타임만 초기화하며, 다른 언어 런타임에는 영향을 주지 않습니다.

호스트는 셀마다 세션 cwd를 다시 적용하고 `sys.path`의 맨 앞에 둡니다. `%cd`나 `os.chdir()`는 해당 셀의 나머지 실행에 영향을 주지만, 다음 도구 호출의 시작 cwd에는 영향을 주지 않습니다. 파일 기반 `%load`는 `__file__`도 설정하고 스크립트 디렉터리를 `sys.path`에 추가합니다.

셀은 지속되는 asyncio 이벤트 루프에서 최상위 `await`, `async for`, `async with`를 지원합니다. 같은 스레드에서 두 번째 루프를 시작할 수 없는 `asyncio.run()` 대신 최상위 `await`를 사용하세요. 마지막 표현식이 `None`이 아니면 `repr`을 출력하는 것처럼 자동 출력되며, `print`와 동일하게 이미지와 뷰를 제공합니다.

<a id="environment-filtering-and-runtime-resolution"></a>
## 환경 필터링과 런타임 탐색

실행기를 시작하기 전에 환경을 필터링합니다.

- 허용 목록에는 `PATH`, `HOME`, 로캘 변수, `VIRTUAL_ENV`, `PYTHONPATH` 등의 핵심 변수가 포함됩니다.
- 허용 접두사: `LC_`, `XDG_`, `PI_`
- 차단 목록은 일반적인 API 키(OpenAI/Anthropic/Gemini 등)를 제거합니다.

런타임 선택 순서(`python.interpreter` 설정이 실행 파일을 명시하면 이 과정 전체를 건너뜁니다):

1. 활성화되었거나 탐색된 venv(`VIRTUAL_ENV`, `CONDA_PREFIX`, `<cwd>/.venv`, `<cwd>/venv` 순)
2. `~/.omp/python-env`의 관리형 venv
3. PATH의 `python` 또는 `python3`

실행 가능한 후보를 찾을 때까지 순서대로 검사합니다. 고장 난 venv가 뒤에 있는 정상 후보보다 무조건 우선하지는 않습니다. 선택한 정상 런타임은 해당 cwd/인터프리터 키로 캐시합니다. 명시적 인터프리터는 PATH에서 찾는 명령 이름이 아니라 경로입니다(`~`를 확장하며 상대 경로는 세션 cwd를 기준으로 해석).

venv를 선택하면 해당 bin/Scripts 경로를 `PATH` 앞에 추가합니다. 관리형 venv 경로는 설정된 OMP 데이터 루트를 따르며, 기본값은 `~/.omp/python-env`입니다.

스트리밍 출력이 호스트에 신속하게 도달하도록 실행기에 `PYTHONUNBUFFERED=1`과 `PYTHONIOENCODING=utf-8`도 전달합니다.

각 셀 실행 전에 `PI_SESSION_FILE`, `PI_ARTIFACTS_DIR`, `PI_TOOL_BRIDGE_URL`, `PI_TOOL_BRIDGE_TOKEN`, `PI_TOOL_BRIDGE_SESSION`, `PI_EVAL_LOCAL_ROOTS`를 통해 세션/브리지 컨텍스트를 갱신합니다. 값이 없는 관리 대상 항목은 `os.environ`에서 제거하며, 관련 없는 환경 변경 사항은 유지합니다.

<a id="tool-availability-and-mode-selection"></a>
## 도구 가용성과 모드 선택

백엔드 설정 `eval.py` / `eval.js`의 기본값은 `true`입니다. 선택적 불리언 환경 플래그 `PI_PY`와 `PI_JS`는 대응하는 설정을 각각 독립적으로 재정의합니다. `eval.tools.enabled`도 기본값이 `true`이며, 끄면 `tools` 생성 필드와 커널 정의 도구 안내가 제거됩니다.

도구의 세션 범위 스키마에는 활성화된 런타임만 나열됩니다. 다른 런타임이 활성화된 상태에서 Python 사전 검사가 실패해도 해당 런타임으로 `eval`을 계속 사용할 수 있습니다. 이때 `py` 호출은 활성화된 대안을 포함한 Python 백엔드 가용성 오류를 보고합니다.

Python 프렐류드 헬퍼에는 `agent(prompt, *, agent=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, tools=None)`가 포함됩니다. 이 함수는 백그라운드 하위 에이전트 작업을 등록하고 `AgentHandle`을 반환합니다(`.id`, `.handle` = `agent://<id>`, `.status`, `.done()`, `.wait(timeout=None)`, `.send()`, `.cancel()`, `.output()` 제공, await 가능). `completion(...)`도 마찬가지로 `CompletionHandle`을 반환합니다. `wait(handles, timeout=None, raise_errors=True)`는 입력 순서대로 핸들의 완료를 기다리는 배리어입니다. `workpool(...)`은 `WorkPool`(`push`, `status`, `peek`, `close`)을 반환합니다. 그 이름은 통합 비동기 작업 ID이며, 결과는 자동 전달되고 인자 없는 `wait` 도구는 더 할 일이 없을 때만 대기합니다. `tool.<name>(args)`는 코루틴입니다(`await tool.read({...})`). `eval.tools.enabled`가 켜져 있으면 `@tool`은 커널 로컬 함수를 하위 에이전트용 도구로 등록합니다(스키마는 타입 힌트에서 추론).

실행기는 셀 요청과 함께 `{"type": "tool", "id", "op": "describe"|"call", ...}` 요청도 받습니다. 이 요청은 커널의 `__omp_tools__` 레지스트리를 대상으로 전용 데몬 스레드에서 처리되며(POSIX, Windows에서는 셀 사이에 처리), `reply` 프레임(`{ok, tools, missing}` 또는 `{ok, value}`)으로 응답합니다. 도구가 예외를 발생시키면 실행 중인 셀에 영향을 주지 않고 `error` 프레임으로 보고합니다. 호출자 관점의 계약은 [Eval 도구](./tools/eval.md)를 참조하세요.

<a id="execution-flow-and-cancellationtimeout"></a>
## 실행 흐름과 취소/시간 초과

<a id="cell-timeout"></a>
### 셀 시간 제한

`timeout`의 단위는 초이며 기본값은 30입니다. `0`은 셀 시간 제한을 비활성화합니다. 0이 아닌 값은 `IdleTimeout`에 전달하기 전에 `1..3600`초 범위와 양수인 `tools.maxTimeout` 상한으로 제한됩니다. `agent()` / `completion()` 핸들에 대한 호스트 측 `wait()`가 진행되는 동안 시간 제한은 일시 중지됩니다. 이 호출은 `withBridgeTimeoutPause`를 통해 참조 횟수로 관리되는 일시 중지/재개 이벤트를 내보내며, 제어가 돌아오면 새 시간 제한 구간이 시작됩니다.

일시 중지/재개 이벤트만이 제한 시간 측정을 멈출 수 있습니다. `%pip`도 pip가 실행되는 동안 이 이벤트를 내보냅니다. 연산, `stdout`/`stderr`, `log()`/`phase()`, 일반 도구 호출은 모두 제한 시간에 포함됩니다. 도구는 `AbortSignal.any(...)`로 호출자, 세션, 감시 타이머의 중단 신호를 결합하며, 백엔드는 별도로 경쟁하는 기한을 설정하지 않습니다. 백엔드 가용성 탐색도 셀에 확정된 시간 제한과 취소 신호의 적용을 받습니다.

<a id="auto-backgrounding"></a>
### 자동 백그라운드 전환

`eval.autoBackground.enabled`(기본값 `false`)를 켜면 `eval.autoBackground.thresholdMs`(기본값 60,000ms) 이후, 또는 그 전에 조정 메시지가 도착했을 때 셀을 관리형 eval 작업으로 전환할 수 있습니다. 포그라운드 대기 시간 안에 끝난 셀은 정상적으로 반환됩니다. 작업 관리자가 최대 용량에 도달하면 실행은 포그라운드에 남습니다. 백그라운드 전환은 셀 감시 타이머를 연장하거나 비활성화하지 않습니다.

<a id="kernel-execution-cancellation"></a>
### 커널 실행 취소

중단/시간 초과 시:

- 호스트는 실행기 하위 프로세스에 `kill("SIGINT")`를 보냅니다.
- 실행기의 실행 중 신호 핸들러는 사용자 코드 안에서 `KeyboardInterrupt`를 발생시킵니다.
- 결과에는 `cancelled=true`가 포함됩니다. 커널 시간 초과에는 `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`라는 주석이 붙습니다.
- 요청 사이에는 실행기가 SIGINT에 `SIG_IGN`을 설정하므로 뒤늦은 취소가 커널을 종료하지 않습니다.

인터럽트 후 5초 안에 실행기가 `done`을 내보내지 않으면(`INTERRUPT_ESCALATION_MS` — 예: GIL을 점유한 C 코드에서 멈춘 경우), 호스트는 하위 프로세스를 종료합니다(`exit` → `SIGTERM` → `SIGKILL` 순으로 단계적 종료). 셀에는 커널이 강제 종료되었다는 주석이 붙으며, 다음 호출에서 커널을 다시 생성합니다.

<a id="stdin-behavior"></a>
### stdin 동작

대화형 stdin은 지원하지 않습니다. 호스트의 NDJSON 제어 채널은 실행기의 원래 stdin으로 들어오며, 실행기는 시작할 때 이를 비공개 파일 디스크립터로 옮긴 뒤 fd 0을 널 장치에 연결합니다. 사용자 코드의 `input()`과 `sys.stdin` 읽기는 즉시 EOF를 받습니다. stdin을 명시하지 않고 시작한 모든 프로세스도 마찬가지이므로 제어 프레임을 소비할 수 없습니다. 내장 pip 및 셸 매직도 명시적으로 `DEVNULL`을 전달합니다.

<a id="output-capture-and-rendering"></a>
## 출력 캡처와 렌더링

<a id="captured-output-classes"></a>
### 캡처하는 출력 유형

실행기 프레임 기준:

- `stdout` / `stderr` → 일반 텍스트 청크(모델이 텍스트로 보는 내용 전체)
- `view` → 스트림에 이미 있는 텍스트를 사용자에게 렌더링한 결과
- `image` → 모델과 사용자를 위한 이미지 페이로드
- `error` → 트레이스백 텍스트
- `status` → 구조화된 상태 이벤트

<a id="rich-print"></a>
### 풍부한 print 출력

실행기는 `builtins.print`를 대체합니다. 셀의 stdout으로 출력할 때는 각 인자를 분류합니다. 다른 `file`(예: `sys.stderr` 또는 리디렉션된 `sys.stdout`)에는 기본 `print`를 사용합니다. 마지막 표현식의 자동 출력도 `repr(value)`에 같은 분류를 적용합니다.

| 값 | 출력에 포함되는 텍스트 | 추가 프레임 |
| --- | --- | --- |
| `{"type": "image", "mimeType", "data": str\|bytes, "detail"?, "url"?, "providerFile"?}` | `<image MIME>` | `image` |
| matplotlib `Figure`(PNG, `bbox_inches="tight"`), `PIL.Image.Image`, `_repr_png_` / `_repr_jpeg_`가 있는 객체 | `str` / `repr` | `image` |
| `_repr_markdown_`이 있는 객체(클래스 제외) | Markdown 소스 | `markdown` 뷰 |
| pandas `DataFrame` / `Series`, polars `DataFrame` / `Series` | `str` / `repr` | `table` 뷰 |
| 텍스트가 80자를 넘거나 여러 줄인 `dict` / `list` / `tuple` | `str` / `repr` | `json` 뷰 |

- 테이블 뷰는 라이브러리 자체의 생략 규칙(pandas의 터미널 너비 맞춤을 포함한 `display.max_rows` / `min_rows` / `max_columns`, polars의 `tbl_rows` / `tbl_cols`)을 따르므로 텍스트에 나오는 행과 열을 그대로 보여 줍니다. 생략된 행과 열은 `…` 셀이 됩니다. 인덱스 수준은 앞쪽 열로 표시되며, MultiIndex 열 레이블은 ` / `로 연결됩니다. 열은 dtype에 따라 `numeric`으로 표시됩니다(bool은 숫자형이 아님). pandas와 polars는 임포트하지 않고 `sys.modules`를 통해 감지합니다.
- JSON 뷰는 ±2^53을 벗어나는 정수를 10진수 문자열로 변환하고, JSON으로 표현할 수 없는 다른 말단 값은 `str()`로 변환합니다. 텍스트 표현을 사용자 지정한 하위 클래스(namedtuple, `OrderedDict`)에는 뷰를 만들지 않습니다.
- 탐지 과정에서 예외가 발생해도 출력은 중단되지 않으며, 해당 값은 텍스트로만 출력됩니다.

<a id="matplotlib"></a>
### Matplotlib

실행기는 환경 기본값으로 `MPLBACKEND=Agg`를 설정하여 화면 밖에서 그림을 렌더링합니다. 각 셀 실행 후 남은 그림은 텍스트 없이 PNG `image` 프레임으로 내보낸 뒤 닫습니다. 해당 셀에서 이미 print 또는 자동 출력한 그림은 중복 이미지를 만들지 않고 닫습니다.

<a id="storage-and-truncation"></a>
### 저장과 출력 생략

출력은 `packages/tui/src/tools/streaming-output.ts`의 `OutputSink`를 통해 스트리밍됩니다. 인라인 본문의 기본 한도는 50KiB이며 보존되는 앞부분과 뒷부분이 이를 공유합니다. 중간 부분은 생략되며 줄마다 바이트 상한(`tools.outputMaxColumns`)이 적용됩니다. 정제된 전체 텍스트는 용량 제한 없는 아티팩트에 저장될 수 있습니다. 도구 결과에는 생략 메타데이터가 포함되며, 저장에 성공하면 `artifact://<id>`도 포함됩니다. 아티팩트 I/O 실패는 별도로 보고하며 이 경우 해당 ID를 표시하지 않습니다.

<a id="renderer-behavior"></a>
### 렌더러 동작

- 도구 렌더러(`packages/tui/src/tools/eval.ts`):
  - 셀별 상태와 함께 코드 셀 블록을 표시합니다.
  - 접힌 미리보기의 기본값은 10줄입니다.
  - 도구 결과에 보존된 모든 출력을 볼 수 있는 펼친 모드를 지원합니다.
- 대화형 렌더러(`eval-execution.ts`):
  - TUI에서 사용자가 실행한 Python 코드에 사용합니다.
  - 접힌 미리보기의 기본값은 20줄입니다.
  - 안전한 표시를 위해 매우 긴 개별 줄을 화면상 4000열로 제한합니다.
  - 취소/오류/출력 생략 안내를 표시합니다.

<a id="operational-troubleshooting"></a>
## 운영 문제 해결

- **Python 백엔드를 사용할 수 없음** — `eval.py`, `PI_PY`, 그리고 `python`/`python3`가 PATH에 있는지 확인하세요. 다른 백엔드가 활성화되어 있으면 해당 백엔드가 안내하는 언어 토큰을 사용하세요.
- **실행 가능한 Python이 없음** — 최신 Python 3 인터프리터를 설치하거나, `python.interpreter`를 설정하거나, 관리형 Python 경로(기본값 `~/.omp/python-env`)에 호환되는 venv를 배치하세요. `omp setup python --check`는 탐색된 인터프리터를 보고합니다.
- **실행이 멈춘 뒤 시간 초과됨** — 정상적으로 오래 걸리는 작업이면 `timeout`을 늘리거나 `0`으로 설정하여 감시 타이머를 비활성화하세요. 네이티브 코드가 멈춘 경우 취소는 먼저 `SIGINT`를 보낸 뒤 단계적으로 강제 종료합니다. 세션 모드에서는 강제 종료가 필요했던 커널을 다음 요청에서 다시 생성합니다.
- **Python 코드의 stdin/input 입력 요청** — `input()`은 지원하지 않습니다. 데이터를 프로그램 방식으로 전달하세요.
- **작업 디렉터리 오류** — Python은 각 셀을 세션 cwd에서 시작합니다. 필요하면 셀 안에서 `%cd`나 `os.chdir()`를 사용하세요. 다음 호출은 다시 호스트 세션 cwd에서 시작합니다.

<a id="relevant-environment-variables"></a>
## 관련 환경 변수

- `PI_PY` / `PI_JS` — 백엔드별 노출 여부 재정의
- `PI_PYTHON_SKIP_CHECK=1` — Python 사전 검사/준비 검사 건너뛰기
- `PI_PYTHON_INTEGRATION=1` — 실제 Python을 시작하는 조건부 통합 테스트 활성화
- `PI_PYTHON_IPC_TRACE=1` — 실행기 하위 프로세스와 주고받는 NDJSON 프레임 기록
