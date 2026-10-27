# @oh-my-pi/pi-coding-agent

`omp` 모노레포에 있는 `omp` 코딩 에이전트의 핵심 구현 패키지입니다.

설치, 설정, 제공업체 구성, 모델 역할, 슬래시 명령어, 전체 CLI 참조는 다음을 확인하세요.
- [모노레포 README (로컬)](../../README.md)
- [모노레포 README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

패키지별 참고 문서:
- [변경 이력](./CHANGELOG.md)
- [MCP 구성 가이드](../../docs/mcp-config.md)
- [MCP 런타임 수명 주기](../../docs/mcp-runtime-lifecycle.md)
- [MCP 서버/도구 작성](../../docs/mcp-server-tool-authoring.md)
- [개발 안내](./DEVELOPMENT.md)

<a id="memory-backends"></a>
## 메모리 백엔드

에이전트는 서로 배타적인 세 가지 메모리 백엔드를 지원하며, `memory.backend` 설정(설정 → 메모리 탭 또는 `~/.omp/config.yml`)으로 선택합니다.

- `off` (기본값) — 메모리 하위 시스템을 실행하지 않습니다.
- `local` — 기존 실행 기록 요약 파이프라인을 사용하며, 에이전트 디렉터리 아래에 `memory_summary.md`와 통합된 산출물을 기록합니다.
- `hindsight` — [Hindsight](https://hindsight.vectorize.io) 서버(클라우드 또는 자체 호스팅 Docker)와 통신하며, 사용자 턴 N회마다 대화 기록을 저장하고, 세션의 첫 번째 턴에 메모리를 회상하며, `retain`, `recall`, `reflect`를 제공합니다.

<a id="hindsight-quickstart"></a>
### Hindsight 빠른 시작

1. Hindsight 서버를 실행합니다(클라우드 또는 `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. `memory.backend = "hindsight"`와 `hindsight.apiUrl = "http://localhost:8888"`(또는 클라우드 URL)을 설정합니다.
3. 필요에 따라 환경 변수로 설정을 재정의합니다(환경 변수가 설정보다 우선합니다).
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — 연결
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — 뱅크 주소 지정
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — 수명 주기
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — 회상 규모
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

세션 도중 백엔드를 전환하면 현재 실행 중인 백엔드, 메모리 도구, 리스너, 시스템 프롬프트 컨텍스트가 즉시 교체됩니다. `memories.enabled = true|false`를 사용하는 기존 사용자의 설정은 첫 실행 시 정확히 한 번 `memory.backend = "local"|"off"`로 마이그레이션됩니다. 이후에는 `memory.backend`만이 런타임 백엔드를 선택하는 설정으로 사용됩니다.
