# mini-marketplace

`marketplace.json` 형식을 보여 주는 최소 구성의 `omp` 마켓플레이스 카탈로그입니다. 상대 경로 소스를 사용하는 플러그인 하나(`my-plugin`)가 포함되어 있습니다.

<a id="install-command"></a>
## 설치 명령

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

또는 CLI에서 다음 명령을 실행하세요.

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install my-plugin@example-marketplace
```

이 경로를 사용하는 명령은 저장소 루트에서 실행하세요. CLI 설치 뒤에는 확장을 불러오도록 `omp`를 시작하거나 다시 불러오세요. 대화형 모드에서 `session_start` 핸들러가 알림을 표시합니다.

<a id="what-it-demonstrates"></a>
## 예제에서 보여 주는 기능

- `marketplace.json`의 최소 필수 필드: `name`, `owner.name`, `plugins`
- `./` 접두사를 사용하는 상대 경로 플러그인 소스(`"source": "./my-plugin"`)
- 마켓플레이스 카탈로그와 같은 디렉터리 트리에 함께 제공되는 플러그인
- `metadata.description`의 마켓플레이스 설명
- 설치 후 함께 제공된 TypeScript 팩터리를 불러오는, `omp.extensions`가 있는 `package.json`

<a id="structure"></a>
## 구조

```
mini-marketplace/
  .claude-plugin/
    marketplace.json      ← 카탈로그
  README.md
  my-plugin/
    package.json          ← omp.extensions 매니페스트
    index.ts              ← 확장 진입점
```

배포된 마켓플레이스와 로컬 마켓플레이스는 같은 카탈로그 위치를 사용합니다. omp는 마켓플레이스 루트 안의 `.omp-plugin/marketplace.json`을 먼저 불러오고, 없으면 `.claude-plugin/marketplace.json`(이 예제가 제공하는 Claude Code 호환 경로)을 사용합니다. 예제를 불러오려면 `/marketplace add`에 이 폴더를 지정하세요.
