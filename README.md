<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<p align="center">
  <strong>IDE가 내장된 코딩 에이전트.</strong>
  <strong><a href="https://omp.sh">omp.sh</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm 버전"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="변경 이력"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="라이선스"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://stencil.so">Stencil Labs</a> 제작 · <a href="https://github.com/mariozechner">@mariozechner</a>의 <a href="https://github.com/badlogic/pi-mono">Pi</a> 포크
</p>

실제로 출시된 가장 강력한 에이전트 환경. 실사용을 바탕으로 끊임없이 다듬어집니다. 설치 즉시 완전하게 사용할 수 있고, 가장 깊은 곳까지 열려 있습니다.

**60개 이상**의 제공업체 · **31개**의 내장 도구 · **14개**의 lsp 작업 · **28개**의 dap 작업 · **약 8만 줄**의 Rust 코어.

> [!NOTE]
> 시험적으로 **모든 사람에게 풀 리퀘스트를 일시 개방**합니다. 이전에는
> PR을 받기 전에 보증을 요구했지만, 공개 기여가 어떻게 진행되는지
> 평가하는 동안 이 요건을 해제합니다. 결과에 따라
> 보증 제도가 다시 도입될 수 있습니다.

## 한국어 언어팩 배포판

이 포크는 omp **18.13.0**의 기존 번역을 언어팩으로 분리합니다. 사용자 화면·도움말·오류 메시지·대시보드·협업 화면·브라우저 부속 화면은 언어팩을 사용하며, 사용 문서는 별도로 한국어를 유지합니다. 명령어, 설정 키, API와 세션 파일 형식은 바꾸지 않습니다. 모델 응답과 외부 도구·서비스 출력은 자동 번역하지 않습니다.

### 언어 선택과 번역 수정

- 기본 언어는 한국어입니다. `OMP_LANG=en`이면 영어, `OMP_LANG=ko` 또는 `ko-KR`이면 한국어를 사용합니다. 변경 후 omp를 다시 시작하세요.
- 설치된 번역은 `%LOCALAPPDATA%\omp-korean\locales\ko.json`에서 수정할 수 있습니다. 실행 파일을 다시 빌드하지 않아도 다음 실행부터 반영됩니다.
- `OMP_LOCALE_DIR`로 다른 언어팩 디렉터리를 지정할 수 있습니다. 외부 `ko.json`이 없으면 내장 한국어팩을 사용하고, 선택된 팩에 없는 항목은 영어 원문을 표시합니다. 잘못된 JSON이나 유효하지 않은 자리표시자는 오류로 보고합니다.
- 소스의 `packages/utils/src/locales/en.json`은 영어 원문 목록이고, `ko.json`은 한국어 번역입니다. 같은 원문이라도 뜻이 다르면 키의 `\u0004` 뒤 문맥으로 구분합니다. `{0}`, `{1}` 같은 자리표시자는 순서를 바꾸거나 언어별 복수형 접미사처럼 생략할 수 있지만 새 인수를 만들면 안 됩니다.

```powershell
$env:OMP_LANG = "en"
omp --help
$env:OMP_LANG = "ko"
omp --help
```

### 공식 설치와 분리

Windows x64 전용 설치기는 `%LOCALAPPDATA%\omp-korean\omp.exe`와 인접한 `omp-localized.json`을 만들고 사용자 PATH 앞에 배치합니다. 공식 `%LOCALAPPDATA%\omp\` 설치와 인증·설정·세션은 변경하지 않습니다. 설치 후 터미널을 새로 열고 `Get-Command omp`로 경로를 확인하세요.

```powershell
# 저장소 루트에서 실행합니다. Git, Bun 1.4.4 이상과 해당 버전의 네이티브 애드온이 필요합니다.
bun install --ignore-scripts --frozen-lockfile
bun scripts/install-localized.ts
```

네이티브 애드온은 `packages/natives/native/`에 있어야 합니다. 설치기는 기존 외부 언어팩 수정을 덮어쓰지 않습니다. 다른 설치 위치는 `--directory <절대 경로>`, PATH를 변경하지 않으려면 `--no-path`를 사용하세요.

### 언어팩을 보존하는 업데이트

이 배포판의 `omp update --check`는 최신 안정 버전을 확인합니다. `omp update`는 별도 후보 소스에 포크 변경을 병합하고, 정확한 버전의 네이티브 애드온·의존성을 준비한 뒤 빌드와 언어 전환·실행 검증을 통과한 실행 파일만 설치합니다. 외부 언어팩은 유지하며 새 항목은 번역 전까지 영어로 표시합니다.

개발용 소스 병합에서 실제 충돌이 확인되면 한글판 빌드를 중단하고 공식 안정 빌드를 SHA-256·크기·버전 검증 후 같은 실행 경로에 설치합니다. “현재 한글 버전이 원본 버전과 맞지 않아 공식판으로 실행합니다.”라는 안내 후 공식판을 바로 실행하며, 이전 한글판 메타데이터는 백업합니다. 네트워크·디스크·빌드 오류나 공식판 검증 실패는 충돌로 취급하지 않고 기존 설치를 유지합니다. 현재 안정 버전만 지원하며 `--canary`는 거부합니다. 개발용 `--force`는 같은 버전을 다시 빌드합니다.

소스·메타데이터·Bun 경로가 있는 개발용 설치는 활성 소스 폴더와 빌드 도구가 필요합니다. 소스가 없는 포터블 배포는 최신 공식 빌드와 한글판 버전을 비교하며, 더 새 공식판이 있으면 공식판으로 전환하고 실행합니다. 같은 버전이면 한글판을 유지하고 이전 버전으로 내리지 않습니다. `--check`는 조회·안내만 하며 설치하거나 앱을 실행하지 않습니다. Windows에서도 CLI는 업데이트 프로세스가 끝날 때까지 기다립니다. 실행 중인 이전 파일은 백업 이름으로 옮기며, 비정상 종료로 잠금 파일이 남으면 실행 중인 업데이트가 없는지 확인한 뒤 `<설치 경로>\omp-localized.json.update-lock`을 정리하세요. 외부 언어팩·인증·설정·세션은 유지하지만 공식판에는 한글 언어팩이 적용되지 않습니다. 한글판으로 돌아오려면 호환되는 새 한글 배포판을 설치하세요.

공식 설치 스크립트는 이 언어팩 기능을 포함하지 않습니다. 공식 설치를 명시적으로 실행하거나 PATH에서 공식 경로를 먼저 선택하면 영문판이 실행될 수 있습니다.

<a id="install"></a>
## 설치

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

사용 가능한 bun이 없거나 `--binary`를 지정하면 설치 스크립트가 `build.stencil.so`에서 사전 빌드된 바이너리를 가져와 SHA-256을 확인한 뒤 설치합니다. `curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v<version>`으로 릴리스를 고정할 수 있습니다(PowerShell: `-Binary -Ref v<version>`).

> **Alpine / musl:** 사전 빌드된 musl 바이너리는 `libstdc++`/`libgcc`를 동적으로 링크하며, 기본 Alpine에는 이 라이브러리들이 없습니다. 먼저 설치하세요: `apk add libstdc++ libgcc`.

**Homebrew**

```sh
brew install can1357/tap/omp
```

**Bun(권장)**

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

**Nix**

```sh
# 설치하지 않고 실행
nix run github:can1357/oh-my-pi

# 또는 활성 프로필에 설치(Nix < 2.30: `nix profile install`)
nix profile add github:can1357/oh-my-pi
```

Flake 사용자는 `packages.<system>.omp`, `overlays.default`, `nixosModules.default` 또는 `homeManagerModules.default`를 사용할 수 있습니다. Home Manager 구성으로 OMP를 설치하고 설정을 선언적으로 관리할 수 있습니다.

```nix
{
  inputs.omp.url = "github:can1357/oh-my-pi";

  # Home Manager 모듈 안에서:
  imports = [ inputs.omp.homeManagerModules.default ];
  programs.omp = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

**Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

**버전 고정(mise)**

```sh
mise use -g github:can1357/oh-my-pi
```

macOS · Linux · Windows · bun ≥ 1.3.14

<a id="shell-completions"></a>
### 셸 자동 완성

`omp`는 현재 명령/플래그 메타데이터에서 **bash**, **zsh**, **fish**용 자동 완성 스크립트를 직접 생성하므로 실제 CLI와 어긋나지 않습니다. 하위 명령, 플래그, 열거형 값은 정적으로 완성됩니다. 모델 이름(`--model`, `--smol`, `--slow`, `--plan`)은 번들 모델 카탈로그에서, `--resume`은 디스크에 저장된 세션에서 찾습니다.

```sh
# zsh — ~/.zshrc에 추가(또는 출력을 $fpath에 있는 파일에 저장)
eval "$(omp completions zsh)"

# bash — ~/.bashrc에 추가
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

<a id="every-tool-benchmaxxed"></a>
## 모든 도구, _벤치마크 성능을 극대화했습니다_.

첫 시도에 정확히 적용되는 편집. 파일 내용을 쏟아내는 대신 요약하는 읽기. 즉시 결과를 반환하는 검색. 어떤 모델을 선택하든 omp가 제대로 해냅니다.

| 모델             | 지표          | 설명                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | 편집 형식이 모델을 괴롭히지 않게 되는 순간 성능이 10배 향상됩니다. |
| Gemini 3 Flash   | +5%p         | str_replace 대비 향상 — 이 형식에 대한 Google 자체의 최선의 시도도 능가합니다. |
| Grok 4 Fast      | 토큰 −61%    | 잘못된 diff에 대한 재시도 루프가 사라지면 출력량이 급감합니다. |
| MiniMax          | 2.1×         | 동일한 가중치, 동일한 프롬프트로 통과율이 두 배 이상 증가합니다. |

- `read` : 요약된 스니펫 · 이상적인 기본값 · 선택자 적중률
- `grep` : 어디서도 뒤지지 않는 속도
- `lsp` : IDE가 아는 모든 것을 에이전트도 압니다
- `prompts` : 모델별로 끊임없이 조정

[전체 글 읽기 ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

<a id="the-pi-you-love-with-batteries-included"></a>
## _여러분이 사랑하는_ Pi, **필요한 모든 것을 갖췄습니다**.

[또한 Mario Zechner](https://github.com/mariozechner)의 훌륭한 [Pi](https://github.com/badlogic/pi-mono)를 기반으로 시작한 omp는 여러분에게 부족했던 모든 것을 더합니다.

<a id="01--code-execution-w-tool-calling"></a>
### 01 · 도구 호출을 지원하는 코드 실행

대부분의 하네스는 에이전트에 Python 샌드박스를 제공하는 것으로 끝납니다. omp는 영속적인 Python과 Bun 워커를 실행하며, 두 커널 모두 루프백 브리지를 통해 에이전트 자체 도구인 read, search, task를 다시 호출할 수 있습니다. 에이전트는 Python 안에서 tool.read로 CSV를 불러오고 JavaScript로 차트를 그리며, 그동안 셀을 벗어나지 않습니다.

![Python 코드를 실행하고 차트를 렌더링하는 omp TUI.](assets/python.webp)

<a id="02--lsp-wired-into-every-write"></a>
### 02 · 모든 쓰기에 연결된 LSP

이름 변경을 요청하면 제대로 된 이름 변경이 이뤄집니다. 호출이 workspace/willRenameFiles를 거치므로 파일을 이동하기 전에 재내보내기, 배럴 파일, 별칭 import가 업데이트됩니다. IDE가 아는 모든 것을 에이전트도 압니다.

![TypeScript와 Biome 언어 서버가 활성화된 omp TUI.](assets/lspv.webp)

_[LSP 구성 문서 읽기](docs/lsp-config.md)_

<a id="03--drives-a-real-debugger"></a>
### 03 · 실제 디버거를 구동

C 바이너리에서 세그멘테이션 오류가 발생하면 에이전트가 lldb를 연결하고, 문제가 있는 포인터까지 단계 실행한 뒤 프레임을 읽습니다. Go 서비스가 멈추면 dlv를 연결해 고루틴을 살펴봅니다. Python 프로세스가 먹통이 되면 debugpy로 일시 정지하고, 검사하고, 평가합니다. 대부분의 에이전트는 여전히 print 문을 뿌리고 있습니다.

![omp TUI: /tmp/omp-native/demo의 네이티브 바이너리에 연결된 실시간 lldb-dap 세션. 어댑터=lldb-dap, 상태=중지됨, 프레임=xorshift32, 명령어 포인터 0x10000055C, 위치 demo.c:6:10. 디버그 범위와 디버그 변수 카드에 지역 변수(x = 57351)가 표시되고 에이전트가 계산을 확인합니다. x가 7 → 57351(= 7 ^ (7<<13))로 바뀌었습니다.](https://omp.sh/clips/dap-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/dap.mp4)_

<a id="04--time-traveling-stream-rules"></a>
### 04 · 시간을 되돌리는 스트림 규칙

규칙은 모델이 지침을 벗어날 때까지 대기합니다. 정규식이 일치하면 토큰 생성 도중 스트림을 중단하고, 규칙을 시스템 알림으로 주입한 뒤 같은 지점부터 다시 시도합니다. 매 턴 컨텍스트 비용을 지불하지 않고도 방향을 바로잡을 수 있습니다. 주입된 내용은 컨텍스트 압축 후에도 유지되므로 수정 효과가 지속됩니다.

![omp TUI: 에이전트가 src.rs를 읽고 Box::leak를 쓰려는 순간 요청이 중단됩니다(빨간색 `오류: 요청이 중단되었습니다`). 호박색 `⚠ 규칙 주입 중: box-leak` 카드가 규칙 본문 `Don't reach for Box::leak in production code paths`를 주입하고, 에이전트는 `Arc<str>`을 제안하며 사용자에게 확인을 요청하는 방향으로 수정합니다.](https://omp.sh/clips/ttsr-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/ttsr.mp4)_

<a id="05--first-class-subagents"></a>
### 05 · 핵심 기능으로 통합된 하위 에이전트

작업을 워커들에 나누고 타입이 지정된 결과를 받으세요. task는 격리된 워크트리로 작업을 분산하고, 각 워커는 자체 도구 환경을 실행하며, 최종 결과는 부모가 직접 읽을 수 있는 스키마 검증 객체입니다. 해석해야 할 산문도, 형제 워커 간 병합 충돌도, 주인 없이 남은 편집도 없습니다.

![omp TUI에서 `task`가 두 하위 에이전트 `ComponentsExports`와 `RoutesExports`를 생성하는 모습. 제약 조건 블록은 동료 간 IRC DM을 요구하며, 각 하위 에이전트 상태 카드에는 비용과 소요 시간이 표시됩니다. 최종 발견 사항 섹션에는 두 내보내기 항목과 함께 한쪽만 수행한 핸드셰이크에 대한 솔직한 'IRC 조율 참고 사항'이 나열됩니다.](https://omp.sh/clips/irc-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/irc.mp4)_

실행 중에 작업 분산 현황을 확인하세요. `Alt+A`로 [Agent Hub](docs/agent-hub.md)를 열면 목록에 모든 하위 에이전트의 현재 활동과 사용량이 표시됩니다. 하나를 열어 실시간 대화 기록을 읽고, 방향을 제시하는 메시지를 입력하고, 대기 중인 워커를 다시 깨우거나, 멈춘 워커를 종료할 수 있습니다. 부모 세션을 중단할 필요가 없습니다.

<a id="06--a-second-model-watching-every-turn"></a>
### 06 · 매 턴을 지켜보는 두 번째 모델.

검토자 모델을 'advisor' 역할에 연결하면 주 에이전트의 모든 턴을 읽고 메모를 인라인으로 주입합니다. 조용한 한마디일 수도, 우려 사항이나 반드시 해결해야 할 장애물일 수도 있습니다. 자체 컨텍스트와 자체 모델로 실행되므로 실행자가 서둘러 지나친 부분을 포착합니다. 주 에이전트는 메모를 보고 방향을 수정하거나, 따르지 않는 이유를 알려줍니다.

![omp TUI: /advisor status에 advisor가 openai-codex/gpt-5.5에서 실행 중이라고 표시됩니다. 주 에이전트가 모든 오류를 무시하는 대신 catch 범위를 ENOENT로 한정하자, 호박색 'Advisor 1 메모(우려 사항)' 카드가 이제 수정 내용이 사용자가 명시한 수용 기준과 일치하지 않는다고 경고합니다.](https://omp.sh/clips/advisor-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/advisor.mp4)_

<a id="07--hand-someone-the-link-theyre-in"></a>
### 07 · 링크만 건네면 바로 참여.

/collab은 실시간 세션을 릴레이에 올리고 링크와 QR을 반환합니다. 팀원은 다른 터미널에서 omp join으로 참여하거나 브라우저에서 열기만 하면 됩니다. 읽기/쓰기로 공유해 같은 에이전트와 함께 작업하거나, /collab view로 누구나 볼 수 있지만 아무도 조작할 수 없는 읽기 전용 링크를 만드세요. 프레임은 클라이언트 측에서 암호화되며, 릴레이는 키를 절대 볼 수 없습니다.

![omp TUI: /collab view가 '협업 세션이 시작되었습니다!'와 함께 omp join 명령, my.omp.sh 브라우저 링크, '이 링크가 있는 누구나 세션을 볼 수 있지만 에이전트에 프롬프트를 보낼 수는 없습니다'라는 안내, 스캔 가능한 큰 QR 코드를 출력합니다.](https://omp.sh/clips/collab-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/collab.mp4)_

<a id="08--read-a-pdf-on-arxiv-why-not"></a>
### 08 · arxiv의 PDF 읽기, 안 될 게 있나요?

web_search는 순위가 매겨진 23개 제공업체를 체인으로 연결하고, 찾은 URL을 바로 read에 넘깁니다. Arxiv PDF, GitHub 페이지, Stack Overflow 스레드가 앵커를 유지한 구조화된 Markdown으로 반환됩니다. 로컬 파일에 사용하는 것과 동일한 도구 환경입니다. 출처를 인용하고, 링크를 따라가고, 내용을 인용해도 어디서 왔는지 잃지 않습니다.

![omp TUI: web_search가 추론 시점 연산량 확장에 대한 순위별 Perplexity 출처 10개를 반환합니다. 에이전트는 arxiv 논문을 골라 read https://arxiv.org/pdf/2604.10739v1을 호출하고 실제 수치로 논문의 핵심 결과를 요약합니다.](https://omp.sh/clips/web-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/web.mp4)_

<a id="09--unapologetically-native-even-on-windows"></a>
### 09 · 타협 없는 네이티브. Windows에서도.

다른 에이전트는 rg, grep, find, bash를 외부 프로세스로 실행합니다. 많은 컴퓨터에는 이런 바이너리가 없고, 있더라도 호출할 때마다 fork-exec 왕복 비용이 듭니다. omp는 실제 구현을 프로세스에 직접 링크합니다. ripgrep, glob, find 모두 프로세스 내부에서 실행됩니다. bash 역할은 brush가 맡으며, 호출 간에도 유지되는 세션과 builtins 크레이트로 포팅된 58개 명령줄 유틸리티(ls, sed, sort, xargs, 심지어 jq까지)를 프로세스 내부에서 실행합니다. fork/exec는 전혀 없습니다. 같은 omp 바이너리가 macOS, Linux, Windows에서 실행됩니다. WSL 브리지도 필요 없습니다.

<a id="10--code-review-with-priorities-and-a-verdict"></a>
### 10 · 우선순위와 최종 판단을 제공하는 코드 리뷰

변경 사항을 출시할 수 있는지 명확한 판단을 받고, 모든 문제에 P0부터 P3까지의 우선순위와 신뢰도 점수를 확인하세요. /review는 전담 검토자 하위 에이전트를 생성해 브랜치, 단일 커밋, 커밋하지 않은 작업을 병렬로 검토합니다. 출시를 막는 문제부터 해결할 수 있으며, 중요한 내용이 긴 산문 속에 묻히지 않습니다.

직접 리뷰 방향을 정하고 싶으신가요? `/annotate code-review`는 diff를 열어 검토자가 실행되기 전에 특정 줄에 메모를 붙일 수 있게 합니다. `/annotate`는 최신 응답, 세션 메시지, 파일 또는 인용문도 받아 메모를 프롬프트에 붙여 넣습니다. [`/annotate`](docs/slash-command-internals.md#12-bundled-command-note-annotate)를 참고하세요.

<a id="11--hashline-edit-by-content-hash"></a>
### 11 · Hashline: 콘텐츠 해시로 편집

완벽한 편집, 더 적은 토큰. 모델이 변경할 줄을 다시 입력하는 대신 앵커를 가리키므로 공백 문제나 문자열을 찾지 못해 반복하는 일이 사라집니다. 오래된 파일을 편집하면 앵커가 달라지므로, 무언가를 손상시키기 전에 패치를 거부합니다. Grok 4 Fast는 같은 작업에 출력 토큰을 61% 더 적게 사용합니다.

<a id="12--github-is-just-another-filesystem"></a>
### 12 · GitHub도 하나의 파일시스템

다른 하네스는 gh_issue_view, gh_pr_view, gh_search를 덧붙입니다. 각각 고유한 매개변수가 있어 에이전트는 이를 배워야 하고 여러분은 디버깅해야 합니다. 우리는 그렇게 하지 않았습니다. read는 이미 경로를 처리하고, PR도 경로입니다. 모델에 가르칠 인터페이스도 하나, 올바르게 유지할 환경도 하나입니다.

<a id="13--memory-the-agent-curates"></a>
### 13 · 에이전트가 직접 관리하는 메모리

에이전트는 세션 사이에도 코드베이스를 기억합니다. 실행 중 retain으로 사실을 기록하고, learn으로 재사용 가능한 교훈을 저장하며, recall로 다시 불러옵니다. 각 세션은 다음 세션의 첫 턴에 로드되는 이해 모델로 압축됩니다. `memory.backend`로 엔진을 선택하세요. local, Hindsight, Mnemopi를 사용할 수 있습니다. 기본적으로 프로젝트 범위이므로 이 저장소에서 배운 내용은 이 저장소에만 남습니다.

<a id="14--acp-editor-drivable-agent"></a>
### 14 · ACP: 에디터에서 제어하는 에이전트

Zed 안에서 omp를 실행하면 터미널에서 사용하던 것과 동일한 에이전트를 만날 수 있습니다. 실제로 보고 있는 버퍼를 읽고, 에디터의 저장 경로를 통해 쓰며, 에디터 터미널에서 셸을 생성합니다. 파괴적 도구는 권한 확인 프롬프트에서 멈추며, 한 번 응답하면 더는 신경 쓰지 않아도 됩니다. 브리지도, 플러그인도, 따로 동기화할 두 번째 두뇌도 없습니다.

<a id="15--inherits-what-your-other-tools-already-wrote"></a>
### 15 · 다른 도구가 이미 작성한 내용을 그대로 계승

다른 에이전트는 가져오기 도구를 제공하고 변환을 요구합니다. omp는 디스크에 이미 있는 8가지 형식을 원래 형태 그대로 읽습니다. Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo 등입니다. 마이그레이션 스크립트도, YAML에서 TOML로의 이식도, “일부만 지원”한다는 각주도 없습니다. 팀이 지난 분기에 작성한 구성이 오늘 밤에도 그대로 작동합니다.

<a id="16--omp-commit-atomic-splits-validated-messages"></a>
### 16 · omp commit: 원자적 분할, 검증된 메시지

omp는 git_overview, git_file_diff, git_hunk를 통해 작업 트리를 읽고, 서로 관련 없는 변경을 의존성 순서에 따른 원자적 커밋으로 나눕니다. 순환 의존성은 어떤 것도 기록하기 전에 거부됩니다. 소스 파일은 테스트, 문서, 구성보다 높은 점수를 받으므로 가장 중요한 커밋이 맨 앞에 옵니다. 잠금 파일은 분석에서 완전히 제외됩니다.

<a id="17--read-prs-walk-skills-pull-json-out-of-subagents"></a>
### 17 · PR 읽기. _스킬 탐색._ 하위 에이전트에서 JSON 추출.

`pr://`, `issue://`, `agent://`, `skill://`, `ssh://` 등을 포함한 16개 내부 스킴이 에이전트가 이미 호출하는 모든 파일시스템형 도구 안에서 투명하게 해석됩니다. `read pr://1428`은 `read src/foo.ts`와 같은 형태의 결과를 반환합니다. `grep`은 디렉터리처럼 diff를 탐색합니다. `agent://<id>/findings.0.path`는 경로를 통해 하위 에이전트 출력의 필드를 가져옵니다.

<a id="18--conflict-resolution-made-easy"></a>
### 18 · 손쉬운 충돌 해결.

각 병합 충돌은 하나의 URL이 됩니다. 에이전트가 `conflict://N`에 `@theirs`, `@ours` 또는 `@base`를 쓰면 파일의 충돌이 깔끔하게 해결됩니다. 일괄 처리 형식: `conflict://*`.

![omp TUI: ✓ 읽기 src/session.ts(⚠ 충돌 1개), 이어서 ✓ 쓰기 conflict://1 · 1줄에 내용 @theirs, 마지막으로 '해결되었습니다.'라는 확인 메시지.](https://omp.sh/clips/conflict-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/conflict.mp4)_

<a id="19--preview-then-accept"></a>
### 19 · 미리 보고, 수락하세요.

`ast_edit`는 교체 횟수가 담긴 _(제안됨)_ 카드를 반환합니다. 변경은 적용 대기 상태가 됩니다. 에이전트가 `xd://resolve`에 한 줄짜리 이유를 쓰면 TUI가 이를 **수락** 카드로 바꾸고 디스크 이동이 수행됩니다. 원자적으로, 전부 적용되거나 아무것도 적용되지 않습니다.

![omp TUI: ✓ AST 편집: console.log($X) (제안됨) 교체 3건 · 파일 1개, 이어서 ✓ 수락: 파일 1개에서 교체 3건(AST 편집), 마지막으로 'src/auth.ts에 교체 3건을 적용했습니다.'](https://omp.sh/clips/codemod-poster.webp)

_[녹화 보기 ↗](https://omp.sh/clips/codemod.mp4)_

<a id="20--drives-a-real-browser-or-your-slack"></a>
### 20 · _실제 브라우저_를 제어합니다. _Slack도요?_

Eval의 `browser.open(...)`은 직접 탐색, 검사, 상호작용, 요소 헬퍼를 제공하는 탭 핸들을 반환합니다. `tab.run(...)`은 사용자 지정 JavaScript를 처리합니다. 격리된 탭 런타임에서 Chromium이나 Electron을 제어합니다. 스텔스는 기본적으로 켜져 있으며, 브라우저 릴레이는 포커스를 빼앗지 않고 이미 열려 있는 Chrome 탭에 연결할 수 있습니다.

<a id="21--hands-on-the-desktop-itself"></a>
### 21 · 데스크톱 자체를 직접 조작

Eval의 `computer` 헬퍼인 `computer.window(...)`, `win.screenshot()`, `win.ax()`, `el.press()`와 다단계 스크립트용 `computer.run(fnOrCode, options)`는 실제 호스트를 제어합니다. 창과 디스플레이를 나열하고, 스크린샷을 캡처하고, 네이티브 입력을 보내고, OS 접근성 트리를 탐색하고, 클립보드를 사용합니다. 브라우저 DOM은 노출하지 않습니다.

<a id="whatever-the-task-needs-its-already-in-the-box"></a>
## 작업에 무엇이 필요하든, _이미 들어 있습니다_.

핵심 도구는 `read`, `bash`와 같은 네임스페이스에 있습니다. `--tools read,edit,bash,…`로 활성 도구 집합을 고정하세요. 사용 빈도가 낮은 검색 가능 도구는 `xd://` 장치 뒤에 있습니다. `read xd://`로 목록을 보고, `tools.xdev`가 활성화되어 있으면 `write xd://<tool>`로 실행합니다.

**파일 및 검색**

- `read` — 파일, 디렉터리, 압축 파일, SQLite, PDF, 노트북, URL, 원격 `ssh://` 경로, 내부 `://` 스킴을 하나의 경로로 처리합니다.
- `write` — 파일, 압축 파일 항목 또는 SQLite 행을 생성하거나 덮어씁니다.
- `edit` — 콘텐츠 해시 앵커와 오래된 앵커 복구를 지원하는 hashline 패치입니다.
- `ast_edit` — ast-grep을 통해 적용 전에 미리 보는 구조적 재작성입니다.
- `ast_grep` — 50개 이상의 tree-sitter 문법을 대상으로 구조적 코드 쿼리를 수행합니다.
- `grep` — 파일, glob, 내부 URL을 대상으로 정규식 검색을 수행합니다.
- `glob` — glob 기반 경로 검색입니다. 콘텐츠 일치 항목이 필요하면 `grep`을 사용하세요.

**런타임**

- `bash` — 프로세스 내부 coreutils 46개, 선택적 PTY, 백그라운드 작업 전달을 지원하는 워크스페이스 셸입니다.
- `eval` — 공통 프렐류드와 도구 재진입을 지원하는 영속적 Python 및 JavaScript 셀입니다.

**코드 인텔리전스**

- `lsp` — 진단, 탐색, 심볼, 이름 변경, 코드 액션, 원시 요청입니다.
- `debug` — 중단점, 단계 실행, 스레드, 스택, 변수를 통해 DAP 세션을 제어합니다.
- `security_scan` — 네이티브 보안 검토를 계획하고 실행하며 Codex Security 클라우드 스캔을 구동합니다.

**조율**

- `task` — 선택적으로 워크스페이스를 격리하여 하위 에이전트를 병렬로 분산 실행합니다.
- `wait` — 다음 백그라운드 결과, 동료 메시지 또는 방향 조정 인터럽트가 올 때까지 기다립니다. `agent://`와 `proc://`를 통해 동료에게 메시지를 보내고 작업을 제어합니다.
- `todo` — 단계 추적과 함께 세션 할 일 목록을 순서대로 변경합니다.
- `ask` — 대화형 실행을 위한 구조화된 후속 질문입니다.

**데스크톱 및 웹**

- `browser` — 헤드리스 Chromium, CDP로 연결된 앱 또는 릴레이를 통한 사용자 Chrome의 Puppeteer 탭입니다.
- `computer` — 호스트 데스크톱에서 영속적인 JS를 실행합니다. 창, 스크린샷, 네이티브 입력, AX 트리, 클립보드를 다룹니다.
- `web_search` — 구성된 제공업체에 하나의 쿼리를 보내 답변과 출처를 반환합니다.
- `github` — 저장소, PR, 이슈, 코드 검색, Actions 실행 모니터링 등의 GitHub CLI 작업입니다.
- `generate_image` — Gemini, GPT 또는 xAI Grok 이미지 모델로 래스터 이미지를 생성하거나 편집합니다.
- `tts` — xAI Grok Voice를 통한 텍스트 음성 변환입니다. 내장 음성 5개와 WAV 또는 MP3를 지원합니다.

**메모리 및 스킬**

- `checkpoint` — 나중에 축약하고 보고할 수 있도록 대화 상태를 표시합니다.
- `rewind` — 탐색 과정의 컨텍스트를 정리하고 간결한 보고서를 남깁니다.
- `retain` — 활성 메모리 뱅크에 영속적으로 저장할 사실을 대기열에 넣습니다.
- `recall` — 메모리 뱅크에서 원시 기억을 검색합니다.
- `reflect` — 메모리 뱅크를 바탕으로 답변을 종합합니다.
- `memory_edit` — id로 저장된 기억을 업데이트하거나, 잊거나, 무효화합니다.
- `learn` — 재사용 가능한 교훈을 저장하고, 선택적으로 관리형 스킬로 승격합니다.
- `manage_skill` — 격리된 관리형 스킬을 생성, 업데이트 또는 삭제합니다.

설정으로 활성화하며 기본적으로 꺼져 있는 도구: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind` 및 메모리 도구(`retain`/`recall`/`reflect`/`memory_edit`, `memory.backend`에 따라 결정).

[전체 참조 →](https://omp.sh/docs/tools)

<a id="prompt-controls"></a>
### 프롬프트 제어

독립된 소문자 단어 3개로 해당 턴에서 특수한 에이전트 동작을 활성화할 수 있습니다.

- `ultrathink` — 신중한 다단계 추론과 지원되는 최고 수준의 자동 추론 강도를 요청합니다.
- `orchestrate` — 상당한 규모의 독립 작업을 병렬 하위 에이전트로 실행하고 각 단계를 검증합니다.
- `workflowz` — 활성 `task` 도구로 결정적 다중 하위 에이전트 워크플로를 구성합니다.

이 단어들은 산문에서만 작동하며, 인라인 코드, 코드 펜스 블록, XML/HTML 섹션, 식별자 또는 경로 안에서는 작동하지 않습니다. 정확한 일치 규칙과 구성은 [매직 키워드](docs/magic-keywords.md)를 참고하세요.

<a id="session-controls"></a>
### 세션 제어

슬래시 명령은 세션 전체의 실행 방식을 바꿉니다.

- `/vibe` — [Vibe 모드](docs/vibe-mode.md)로 들어갑니다. `read` 전용 도구 집합으로 영속적인 `fast`/`good` 워커 세션을 지휘하는 감독 역할을 합니다.
- `/fresh` — 로컬 대화 기록을 변경하지 않고 제공업체 스트림 상태(오래된 프롬프트 캐시, 멈춘 스트림)를 초기화합니다. [세션 작업](docs/session-operations-export-share-fork-resume.md#fresh)을 참고하세요.

<a id="sixty-plus-providers-a-thousand-models-one-model-away"></a>
## 60개 이상의 제공업체, 천 개의 모델, _/model 하나면 충분합니다_.

9개 역할이 의도에 따라 작업을 라우팅합니다. 일반 턴에는 `default`, 저렴한 하위 에이전트 분산 실행에는 `smol`, 깊은 추론에는 `slow`, 계획 모드에는 `plan`, 변경 이력에는 `commit`을 사용합니다. 여기에 이름에 해당하는 용도의 `vision`, `task`, `advisor`, `tiny`가 있습니다. 실행 시 `--smol`, `--slow` 또는 `--plan`으로 재정의하고, `Ctrl+P`로 활성 역할에 구성된 모델을 순환하세요. 세션 도중 `/model` 슬래시 명령으로 활성 모델을 바꿀 수 있습니다.

아래 인증 태그에서 `oauth`는 제공업체 계정으로 로그인하고, `plan`은 코딩 플랜 구독을 통해 라우팅하며, `local`은 키 없이도 로컬 서버에 연결해 실행합니다.

<a id="frontier-apis"></a>
### 프런티어 API

직접 API와 게이트웨이입니다. 역할별로 제공업체를 혼합하세요.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · SambaNova · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Inception · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Code · Charm Hyper · StepFun · Helmcode · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

<a id="coding-plans"></a>
### 코딩 플랜

구독을 통해 라우팅됩니다. `/login`으로 세션을 연결합니다.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

<a id="run-it-yourself"></a>
### 직접 실행

OpenAI 호환 `/v1/models`를 사용합니다. 로컬 인스턴스는 키가 필요 없습니다.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

<a id="custom-openai-compatible-providers"></a>
### 사용자 지정 OpenAI 호환 제공업체

`~/.omp/agent/models.yml`에 사용자 지정 제공업체를 정의하세요.

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

`omp models spark`를 실행해 검색되는지 확인하세요. 그런 다음 `omp setup`을 실행하고 기본 모델 단계에서 모델을 선택하거나, 세션에서 `/model`을 열어 `default` 역할에 할당하세요.

선택기를 사용하지 않고 기본값을 미리 구성하려면 `~/.omp/agent/config.yml`에 선택자를 추가하세요.

```yaml
modelRoles:
  default: spark/minimax-m3
```

<a id="four-knobs-that-make-routing-useful"></a>
### 라우팅을 유용하게 만드는 네 가지 조절 장치

- **사용자 지정 제공업체** — `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `typesafe`, `openrouter-decisions`, `openai-decisions` 또는 `workers-ai-systemone`(판정 API)을 지원하는 무엇이든 `~/.omp/agent/models.yml`에 선언하세요.
- **대체 체인** — `retry.fallbackChains` 아래에 역할별 또는 모델별 체인을 구성합니다. 기본 모델이 429를 반환하거나 할당량 한도에 도달하면 다음 항목이 해당 턴의 나머지를 처리합니다. 쿨다운 후에는 복원됩니다.
- **경로 범위 모델** — `enabledModels`와 `disabledProviders` 항목의 범위를 `path:` 접두사로 지정하여 전역 구성을 건드리지 않고 특정 저장소에 다른 모델 집합을 고정합니다. 범위가 지정된 항목은 해당 경로와 그 아래 모든 항목에 적용됩니다.
- **라운드 로빈 자격 증명** — 제공업체마다 API 키를 여러 개 등록하면 런타임이 세션 친화성과 자격 증명별 백오프를 유지하며 순환합니다. 키 하나로는 점심 전에 할당량을 다 써버리는 경우 유용합니다.

제공업체와 라우팅에 대한 전체 참조는 [omp.sh/docs/providers](https://omp.sh/docs/providers)를 참고하세요.

<a id="twenty-three-backends-one-tool-the-agent-already-knows"></a>
## 23개의 백엔드. _에이전트가 이미 아는 하나의 도구_.

`web_search`는 덧붙인 기능이 아니라 내장 기능입니다. `auto`는 23개 제공업체 체인을 순회합니다. 이미 비용을 지불하는 제공업체가 있다면 이름으로 고정하세요. 각 검색 결과 뒤에서는 사이트별 추출 기능이 GitHub, 레지스트리, arXiv, Stack Overflow, 문서를 구조화된 Markdown으로 변환합니다. 앵커와 링크 대상도 유지됩니다.

<a id="search-providers"></a>
### 검색 제공업체

23개의 백엔드. 하나를 고정하거나 `auto`가 체인을 순서대로 순회하게 하세요.

| 제공업체     | 인증                                      |
| ------------ | ----------------------------------------- |
| `auto`       | 체인                                      |
| `perplexity` | `PERPLEXITY_API_KEY`(익명 대체 지원) |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth 또는 `XAI_API_KEY`                  |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY`(또는 mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY`(키 없는 대체 지원)    |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` 또는 검색 키          |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | 자체 호스팅                               |
| `duckduckgo` | 키 불필요                                 |
| `startpage`  | 키 불필요                                 |
| `google`     | 키 불필요(브라우저)                        |
| `ecosia`     | 키 불필요(브라우저)                        |
| `mojeek`     | 키 불필요(브라우저)                        |
| `public`     | 키 불필요(위 항목 모두 통합)               |

Exa는 `/login exa`를 통해 저장된 API 키도 사용할 수 있습니다. 키 없이 명시적으로 선택하면 공개 MCP 대체 경로를 사용합니다.

<a id="specialised-handlers"></a>
### 특화 핸들러

에이전트는 태그만 제거된 HTML이 아니라 구조화된 콘텐츠를 받습니다.

- **코드 호스트** — github, gitlab
- **패키지 레지스트리** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go 패키지
- **연구 자료** — arxiv, semantic scholar
- **포럼** — stack overflow, reddit, hn
- **문서** — mdn, readthedocs, docs.rs

페이지는 링크 구조를 유지한 채 Markdown으로 변환됩니다. 에이전트는 앵커를 잃지 않고 출처를 인용하고, 링크를 따라가고, 내용을 인용할 수 있습니다.

<a id="security-databases"></a>
### 보안 데이터베이스

취약점 조회는 블로그 요약이 아니라 공급업체 데이터로 답합니다.

- **NVD** — 국가 취약점 데이터베이스
- **OSV** — 오픈 소스 취약점 피드
- **CISA KEV** — 악용된 것으로 알려진 취약점

[`web_search` 참조 ↗](https://omp.sh/docs/tools#web_search)

<a id="roughly-80000-lines-of-rust-doing-the-work-other-harnesses-shell-out-for"></a>
## 약 **8만 줄**의 Rust가 다른 하네스는 외부 프로세스로 처리하는 일을 수행합니다.

크레이트 6개, 플랫폼 태그가 붙은 N-API 애드온 하나. 검색, 셸, AST, 구문 강조, PTY, 데스크톱 제어, 이미지 디코딩, BPE 계수까지 모두 libuv 풀의 프로세스 내부에서 실행됩니다. 핵심 실행 경로에는 fork/exec가 없습니다. 여기에 약 8만 줄의 벤더 코드가 함께 포함됩니다. brush bash 포크와 58개 명령줄 유틸리티(coreutils, findutils, sed, jq, ripgrep 기반 grep, fd, diff, moreutils)가 builtins 크레이트로 포팅되어 셸에 직접 컴파일됩니다.

- 크레이트: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-voice`, `pi-walker`
- 플랫폼: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — x64는 AVX2와 기본 바이너리를 모두 제공합니다

크레이트별 코드 줄 수만 집계:

| 크레이트      | 기능                                                                                   | 약 코드 줄 수 |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | 내장 bash 엔진 · 영속적 세션 · 프로세스 내부 coreutils 전달 · 최소화 도구 | 38,000 |
| pi-natives    | N-API 인터페이스 — 아래 표의 모든 모듈                                    | 25,000 |
| pi-walker     | 무시 규칙을 인식하는 병렬 탐색기 + grep · glob · workspace · shell이 공유하는 스캔 캐시 |  5,200 |
| pi-iso        | 워크스페이스 격리 · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep 매칭, 블록 해석, 구조적 요약                |  2,900 |
| pi-voice      | 오디오 캡처/재생 · Opus · 실시간 WebRTC                                            |  1,000 |

`pi-natives` 내부의 모듈별 상세 내역(연결 코드와 테스트 제외):

| 모듈          | 기능                                                                              | 기반 기술                                 | 약 코드 줄 수 |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | `computer`용 창/디스플레이 열거 · 스크린샷 · 네이티브 입력 · AX 트리   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | 정규식 검색 · 병렬/순차 · glob 및 유형 필터 · 퍼지 검색             | grep-regex · grep-searcher                |  3,280 |
| text          | ANSI 인식 너비 계산 · 잘라내기 · 열 단위 슬라이싱 · SGR을 보존하는 줄바꿈 | unicode-width · segmentation              |  2,070 |
| snapcompact   | 컨텍스트 압축용 비트맵 프레임 래스터화 + PNG 인코딩                   | image · png                               |  1,760 |
| keys          | xterm 대체 지원이 있는 Kitty 키보드 프로토콜 · PHF 완전 해시 조회             | phf                                       |  1,740 |
| ast           | ast-grep 패턴 매칭 및 구조적 재작성                                 | ast-grep-core                             |  1,510 |
| diff          | 도구와 미리보기를 위한 구조화된 파일 diff                                    | 트리 내부 구현                            |  1,030 |
| pty           | sudo · ssh 대화형 프롬프트용 네이티브 PTY 할당                          | portable-pty                              |    630 |
| crash_handler | 네이티브 크래시 캡처 및 보고                                                | 트리 내부 구현                            |    610 |
| highlight     | 구문 강조 · 11개 의미 범주 · 30개 이상의 별칭                        | syntect                                   |    550 |
| appearance    | Mode 2031 + CoreFoundation FFI를 통한 네이티브 macOS 다크/라이트 모드 | core-foundation                           |    450 |
| task          | libuv 스레드 풀의 블로킹 작업 · 취소 · 시간 제한 · 프로파일링           | tokio · napi                              |    440 |
| glob          | glob 검색 · 유형 필터 · mtime 정렬 · gitignore 준수               | ignore · globset                          |    430 |
| fd            | find 도구 대체용 파일시스템 탐색기                                       | ignore                                    |    385 |
| clipboard     | 시스템 클립보드에서 텍스트 복사 및 이미지 읽기 · xclip/pbcopy 불필요                  | arboard                                   |    370 |
| workspace     | 한 번의 순회로 gitignore와 AGENTS.md 검색을 수행하는 워크스페이스 탐색기 | ignore                                    |    275 |
| power         | 유휴/시스템/디스플레이 절전 방지용 macOS 전원 어설션 API                | IOKit FFI                                 |    270 |
| prof          | 접힌 스택 및 SVG 플레임 그래프 출력을 지원하는 순환 버퍼 프로파일러              | inferno                                   |    240 |
| file_lock     | 프로세스 간 권고적 파일 잠금                                               | 트리 내부 구현                            |    210 |
| ps            | 크로스 플랫폼 프로세스 트리 종료 및 하위 프로세스 나열                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE 토큰 계수 · 두 테이블 모두 내장                          | tiktoken-rs                               |     70 |
| html          | 선택적 콘텐츠 정리를 지원하는 HTML → Markdown 변환                                   | html-to-markdown-rs                       |     60 |
| sixel         | 터미널 이미지 렌더링 · PNG · JPEG · WebP · GIF 디코딩 · 크기 조정 · SIXEL 인코딩 | icy_sixel · image                         |     55 |

<a id="four-entry-points-interactive-one-shot-rpc-and-acp"></a>
## 네 가지 진입점: _대화형_, _단발 실행_, RPC, ACP.

같은 엔진에 네 가지 래퍼를 제공합니다. `omp`는 TUI를 실행합니다. `omp -p`는 단일 프롬프트에 답한 뒤 종료합니다. Node SDK는 세션을 프로세스에 내장합니다. `omp --mode rpc`와 `omp acp`는 stdio를 통해 다른 프로그램에 제어권을 넘깁니다.

<a id="interactive--when-in-doubt-the-agent-asks"></a>
### 대화형 — 확신이 없으면 에이전트가 묻습니다

TUI가 기본 인터페이스입니다. 도구 호출은 카드로 렌더링되고, 편집은 적용 전에 미리 표시되며, 모호한 점은 `ask` 도구로 처리됩니다. 이 도구는 에이전트가 턴 도중 호출할 수 있는 구조화된 옵션 선택기입니다. 나머지는 키보드로 처리합니다.

같은 질문 카드가 ACP에서도 제공되므로 에디터는 선택기를 직접 구현하지 않아도 됩니다.

![ask 도구의 다중 선택 질문을 보여주는 omp TUI.](assets/ask.webp)

<a id="sdk--embed-in-node"></a>
### SDK — Node에 내장

`@oh-my-pi/pi-coding-agent`

Node 및 TypeScript 호스트는 엔진을 직접 가져옵니다. 패키지는 `ModelRegistry`, `SessionManager`, `createAgentSession`, `discoverAuthStorage`를 제공하며, 세션은 구독할 수 있는 타입 지정 이벤트를 발생시킵니다.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

<a id="rpc--drive-over-stdio"></a>
### RPC — stdio를 통한 제어

`omp --mode rpc`

Node 외의 환경에 내장하거나 프로세스 격리가 필요할 때 사용합니다. NDJSON 명령을 입력하고 응답 및 이벤트 프레임을 출력합니다. 각 프롬프트는 자체 `prompt_result`로 끝납니다. `--mode rpc-ui`는 호스트가 응답해야 하는 `extension_ui_request` 프레임으로 도구 카드, 선택기, 대화 상자를 추가합니다. `--no-ui`는 UI가 없는 호스트를 위해 확장 기능 대화 상자까지 전송하지 않습니다.

```
$ omp --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

<a id="acp--speak-to-editors"></a>
### ACP — 에디터와 통신

`omp acp`

JSON-RPC 기반 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol)입니다. 에디터가 지원 기능을 알리면 도구 I/O가 에디터를 통해 라우팅되고, 쓰기는 `session/request_permission`의 승인을 거칩니다.

| omp 도구     | ACP 경로                            |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

전체 참조: [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

<a id="a-harness-worth-keeping-is-one-you-dont-outgrow"></a>
## 오래 쓸 만한 하네스는 여러분의 성장을 _가로막지 않는_ 하네스입니다.

**[omp.sh](https://omp.sh)**에서 시작하세요.

omp는 [Mario Zechner](https://github.com/mariozechner)의 [Pi](https://github.com/badlogic/pi-mono)를 포크하여 코딩 중심 환경으로 재작성한 프로젝트입니다. 세션, 하위 에이전트, 슬래시 명령, 확장 기능까지 모두 TypeScript로 작성되었고, 모두 MIT 라이선스이며, 모두 [GitHub](https://github.com/can1357/oh-my-pi)에 있습니다. 구성으로 원하는 형태를 만들고, 외부에서 훅을 연결하고, 필요하면 소스를 읽으세요.

<a id="primitives"></a>
### 기본 구성 요소

확장 기능은 TypeScript 모듈입니다. 내장 기능이 사용하는 것과 동일한 도구 API, 슬래시 명령 레지스트리, 단축키 테이블, TUI 기본 구성 요소를 사용합니다. 전용으로 묶어 둔 것은 없습니다.

<a id="discovery"></a>
### 자동 검색

첫 실행 시 omp는 디스크에 이미 있는 것을 그대로 이어받습니다. `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, `.vscode`의 규칙, 스킬, MCP 서버가 해당됩니다. 마이그레이션 스크립트는 필요 없습니다.

<a id="extensibility"></a>
### 확장성

omp에 부족한 기능을 작성해 달라고 요청한 뒤 `/reload-plugins`를 실행하세요. 로컬에서만 사용하거나, `marketplace`에 배포하거나, npm에 게시할 수 있습니다.

<a id="philosophy"></a>
## 철학

omp는 [Mario Zechner](https://github.com/mariozechner)의 [pi-mono](https://github.com/badlogic/pi-mono)를 포크하여, 필요한 기능을 모두 갖춘 코딩 워크플로를 더한 프로젝트입니다.

핵심 아이디어:

- 실제 코딩 작업을 위한 대화형 터미널 우선 UX 유지
- 실용적인 기능 내장(도구, 세션, 분기, 하위 에이전트, 확장성)
- 고급 동작을 숨기지 않고 구성할 수 있도록 제공

<a id="project-inputs-and-trust"></a>
### 프로젝트 입력과 신뢰

저장소를 열면 설계상 프로젝트 입력이 로드됩니다. 설정, 확장 기능, 훅, 도구, 명령, 스킬, 규칙, 프로젝트 MCP 구성이 포함됩니다. 한 번의 실행에서 프로젝트 `.mcp.json`을 제외하려면 중첩 키가 있는 YAML 오버레이를 가리키는 `--config <file>`을 전달하세요(평면적인 `mcp.enableProjectConfig: false` 줄은 무시됩니다).

```yaml
mcp:
  enableProjectConfig: false
```

`--no-extensions`로 주변 환경의 확장 기능 자동 검색을 건너뛰거나, `--trusted-extension /absolute/path/to/file.ts`로 정확한 확장 기능 허용 목록을 지정하세요. `--no-tools`는 내장 도구를 비활성화하지만, 프로젝트 도구 모듈은 별도의 검색 대상입니다. 이 플래그들은 저장소 신뢰 모델을 바꾸지 않고 입력 범위를 줄입니다.

---

<a id="development"></a>
## 개발

<a id="getting-started-from-source"></a>
### 소스에서 시작하기

새로 복제한 저장소에서 소스 CLI를 시작하려면 워크스페이스 의존성과 로컬 Rust/N-API 애드온이 모두 필요합니다.

```sh
bun setup
bun dev
```

`bun setup`은 Bun 워크스페이스를 설치하고 `@oh-my-pi/pi-natives`를 빌드합니다. Rust 크레이트나 `packages/natives`를 변경한 뒤에는 `bun run build:native`를 다시 실행하세요.

Nix 사용자는 고정된 Bun 및 Rust 도구 체인과 모든 네이티브 빌드 의존성을 제공받습니다.

```sh
nix develop
bun setup
bun dev
```

`nix build .#omp`로 배포용 Nix 패키지를 빌드하고 스모크 테스트하세요. Wayland 스크린캐스트 지원은 기본적으로 꺼져 있습니다(libpipewire를 링크하면 런타임 클로저에 약 750MB가 추가됩니다). `omp.override { withWaylandScreencast = true; }`로 활성화하세요. `nix/bun.nix`는 `bun.lock`이 변경될 때만 생성되며, 릴리스 과정에서 자동으로 다시 생성됩니다. 의존성을 변경했다면 다음을 실행하세요.

```sh
bun run gen:nix
```

이 명령은 `nix develop`의 `bun2nix`를 사용할 수 있으면 이를 사용하고, 그렇지 않으면 Nix를 통해 개발 셸에 들어간 뒤, 마지막 대안으로 고정된 `bunx bun2nix@2.1.2`를 사용합니다. `nix/bun.nix`를 직접 편집하지 마세요.

비대화형 스모크 확인:

```sh
bun dev -- --version
```

<a id="debug-command"></a>
### 디버그 명령

`/debug`는 디버깅, 보고, 프로파일링 도구를 엽니다.

아키텍처와 기여 지침은 [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md)를 참고하세요.

---

<a id="monorepo-packages"></a>
## 모노레포 패키지

| 패키지                                                                        | 설명                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[@oh-my-pi/collab-web](packages/collab-web)**                               | 협업 실시간 세션용 브라우저 게스트 클라이언트, 모의 호스트, 로컬 릴레이   |
| **[@oh-my-pi/pi-ai](packages/ai)**                                            | 스트리밍 및 모델/제공업체 통합을 지원하는 다중 제공업체 LLM 클라이언트     |
| **[@oh-my-pi/pi-catalog](packages/catalog)**                                  | 모델 카탈로그: 번들 모델 데이터베이스, 제공업체 설명자, 식별 정보   |
| **[@oh-my-pi/pi-agent-core](packages/agent)**                                 | 도구 호출과 상태 관리를 지원하는 에이전트 런타임                        |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**                        | 대화형 코딩 에이전트 CLI 및 SDK                                        |
| **[@oh-my-pi/pi-tui](packages/tui)**                                          | 차등 렌더링을 지원하는 터미널 UI 라이브러리                             |
| **[@oh-my-pi/pi-natives](packages/natives)**                                  | grep, 셸, 이미지, 텍스트, 구문 강조 등을 위한 N-API 바인딩  |
| **[@oh-my-pi/omp-stats](packages/stats)**                                     | AI 사용 통계를 위한 로컬 관측 대시보드                       |
| **[@oh-my-pi/omptype](packages/omptype)**                                     | 지연 JIT 컴파일을 사용하는 ArkType 호환 스키마 검증              |
| **[@oh-my-pi/pi-utils](packages/utils)**                                      | 공유 유틸리티(로깅, 스트림, 디렉터리/환경/프로세스 헬퍼)               |
| **[@oh-my-pi/pi-wire](packages/wire)**                                        | 공유 협업 실시간 세션 프로토콜 타입 및 릴레이 상수               |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)**                                  | omp 에이전트용 로컬 SQLite 메모리 엔진                                   |
| **[@oh-my-pi/snapcompact](packages/snapcompact)**                             | 비트맵 프레임 컨텍스트 압축 패키지 및 SQuAD 평가 제품군               |
| **[@oh-my-pi/browser-relay](packages/browser-relay)**                         | Eval 브라우저 API로 기존 탭을 제어할 수 있게 하는 Chrome 확장 프로그램    |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)**                          | 통합 벤치마크 실행기, Harbor 실행 저장소, REST/SSE API, 실시간 대시보드 |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | TypeScript 소스 변형을 기반으로 구축한 편집 벤치마크 제품군                   |

<a id="rust-crates"></a>
### Rust 크레이트

| 크레이트                                           | 설명                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | `@oh-my-pi/pi-natives`에서 사용하는 핵심 Rust 네이티브 애드온(N-API `cdylib`); 아래 크레이트들을 통합 |
| **[pi-shell](crates/pi-shell)**                    | `pi-natives`에서 분리한 내장 셸 / PTY / 프로세스 관리(`brush-*`를 래핑)               |
| **[pi-ast](crates/pi-ast)**                        | tree-sitter 기반 코드 요약기 및 AST 유틸리티(50개 이상의 언어 문법)                         |
| **[pi-iso](crates/pi-iso)**                        | 작업 격리 백엔드 해석기: APFS 클론, btrfs/zfs reflink, overlayfs, projfs, rcopy          |
| **[pi-voice](crates/pi-voice)**                    | 오디오 캡처/재생, Opus 코덱, 실시간 WebRTC 스트리밍 기본 요소                           |
| **[pi-walker](crates/pi-walker)**                  | 무시 규칙을 인식하는 병렬 파일시스템 탐색기, grep·glob·workspace가 스캔 캐시 공유     |
| **[pi-edit](crates/pi-edit)**                      | `edit` 도구의 편집 엔진: 줄 앵커 기반 patch/hashline 모드, 스트리밍 미리보기, 원자적 적용 |
| **[brush-core](crates/vendor/brush-core)**         | 내장 bash 실행을 위한 [brush-shell](https://github.com/reubeno/brush)의 벤더 포크        |
| **[pi-builtins](crates/pi-builtins)**              | Bash 내장 명령(cd, echo, test, printf, read, export, …)과 프로세스 내부 명령줄 유틸리티 67개 |

<a id="contributing"></a>
## 기여

이슈와 풀 리퀘스트는 누구나 제출할 수 있습니다. 현재 PR 개방은
**시험 운영**입니다. 진행 상황을 평가하는 동안 기존 보증 요건을 해제했으며,
추후 다시 도입될 수 있습니다. 기여 지침은
**[CONTRIBUTING.md](CONTRIBUTING.md)**를 참고하세요.

---

<a id="license"></a>
## 라이선스

OMP는 [MIT 라이선스](LICENSE)로 제공됩니다.

`crates/vendor/brush-core`와 `crates/pi-builtins/LICENSE`에 명시된
타사 부분을 포함한 타사 및 벤더 코드는 각각의
업스트림 라이선스를 유지합니다. 저작자 표시와 추가 조건은 `THIRD-PARTY-NOTICES.txt` 및
각 구성 요소의 고지 사항을 참고하세요.

© 2025 Mario Zechner  
© 2025-2026 Can Bölük  
© 2026 [Stencil Labs, Inc.](https://stencil.so)

_계속 열어 두는 터미널을 위해_

- [omp.sh](https://omp.sh)
- [Stencil Labs](https://stencil.so)
- [GitHub](https://github.com/can1357/oh-my-pi)
- [변경 이력](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)
