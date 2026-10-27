# 설치 ID

세션과 프로필 간에 공유되는 설치별 영구 UUID입니다. 제공업체 호환 프로토콜, 계정별 기기 메타데이터, 인증 브로커 사용량 보고, 중복 제거 진단 전송에 필요한 안정적인 설치 식별자를 제공합니다. UUID 자체는 무작위이며 호스트 이름, 사용자 이름, 하드웨어 또는 계정 데이터에서 파생되지 않습니다.

## API

`@oh-my-pi/pi-utils`에서 내보냅니다(`packages/utils/src/dirs.ts`).

| 심볼 | 용도 |
| --- | --- |
| `getInstallId(): string` | 설치 ID를 반환하며, 처음 호출할 때 생성하여 저장합니다. 결과는 런타임이 유지되는 동안 프로세스 내부에 캐시됩니다. |
| `__resetInstallIdCacheForTests(): void` | 프로세스 내부 캐시를 지웁니다. 테스트 전용이며 프로덕션 코드에서 호출하면 안 됩니다. |

생성되는 ID는 소문자 UUID v4 값입니다. 기존 저장값은 앞뒤 공백을 제거한 뒤 정규식 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`에 `i` 플래그를 적용해 대소문자 구분 없이 검증하며, 원래 대소문자는 유지합니다. 읽기 검증에서는 UUID 버전이나 변형을 제한하지 않습니다.

## 저장

- 경로: `<base-config-root>/install-id`. 기본값은 `~/.omp/install-id`이며 `PI_CONFIG_DIR`를 따릅니다. 활성 프로필이나 XDG 데이터/상태/캐시 경로와 관계없이 기본 구성 루트(`getBaseConfigRoot()`)를 기준으로 결정되므로, 같은 기본 루트를 사용하는 모든 프로필이 설치 ID 하나를 공유합니다.
- 형식: UUID 한 줄(끝에 `\n`).
- 권한: 파일은 `0o600` 모드로 생성됩니다.
- 수명 주기: `~/.omp/agent/`와 독립적입니다. 에이전트 상태(세션, 설정, DB)를 지워도 설치 ID는 다시 생성되지 않습니다. `install-id` 파일 자체를 삭제해야 다시 생성됩니다.

## 생성과 수명 주기

1. `getInstallId()`를 처음 호출하면 파일을 읽습니다. 내용이 유효한 UUID로 해석되면 해당 값을 캐시하고 반환합니다.
2. 그렇지 않으면 도우미가 `crypto.randomUUID()`(Node의 CSPRNG 기반 UUID v4)를 호출해 새 ID를 생성합니다.
3. 새 값은 `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)`로 기록합니다. 배타적 생성은 경쟁 중인 생성자가 파일을 덮어쓰지 못하도록 합니다. `EEXIST`로 실패한 쪽은 파일을 다시 읽고 이미 유효한 UUID이면 그 값을 사용합니다.
4. 기존 파일에 비어 있지 않은 잘못된 내용(UUID 정규식 검증 실패)이 있으면 배타적 생성 전에 `unlink`로 삭제하여 오래된 데이터 때문에 `O_EXCL`이 실패하지 않도록 합니다.
5. 쓰기 실패(읽기 전용 파일 시스템, 권한 오류)나 `EEXIST` 이후 읽을 수 없거나 잘못된 값은 무시합니다. 새 UUID는 메모리에 캐시되므로 나머지 프로세스에서는 안정적인 값을 사용합니다. 이후 실행에서 다시 시도합니다. 기존 빈 파일은 삭제하지 않으므로, 프로세스를 새로 실행할 때마다 서로 다른 메모리 내 ID를 사용할 수 있습니다.
6. 이후 같은 프로세스에서 호출하면 디스크에 접근하지 않고 캐시된 값을 반환합니다. 첫 호출 이후 디스크의 파일을 변경해도 프로세스를 재시작하거나 테스트에서 `__resetInstallIdCacheForTests`를 호출하기 전까지는 영향을 주지 않습니다.

## 사용처

| 사용처 | 용도 |
| --- | --- |
| `packages/ai/src/providers/openai-codex-responses.ts` | 세션/스레드/창별 ID와 함께 OpenAI Codex 호환 `installationId`로 전송합니다. |
| `packages/ai/src/providers/anthropic-identity.ts` 및 `packages/coding-agent/src/session/session-metadata.ts` | 설치 ID에서 Claude 호환 `device_id` 메타데이터를 파생하며, Anthropic 계정 UUID가 있으면 계정 범위로 한정합니다. 원본 설치 ID를 기기 ID로 사용하지 않습니다. |
| `packages/ai/src/auth-broker/remote-store.ts` | 호스트 이름 및 애플리케이션 이름과 함께 인증 브로커에 전송하는 기본 관측 사용량 귀속 정보에 사용합니다. 보고서에 원래 클라이언트의 식별 정보를 대신 넣을 수도 있습니다. |
| `packages/ai/src/providers/pi-native-client.ts` 및 `packages/ai/src/auth-gateway/http.ts` | 원래 클라이언트의 사용량 귀속을 위해 `x-omp-install-id`, `x-omp-hostname`, `x-omp-app`을 게이트웨이에 전송합니다. 없으면 게이트웨이는 자체 설치 ID를 사용하며 이 헤더를 업스트림에 전달하지 않습니다. |
| `packages/ai/src/usage/opencode-go.ts` 및 `packages/catalog/src/provider-models/openai-compat.ts` | 각각 OpenCode Go 사용량 조회와 OpenCode 모델 검색에서 `x-opencode-session`으로 전송합니다. |
| `packages/coding-agent/src/tools/report-tool-issue.ts` | 같은 설치에서 보낸 보고서를 백엔드가 연관 지을 수 있도록 자동 QA 문제 보고에 `installId`로 포함합니다. |

새 사용처는 이 값을 불투명한 식별자로 취급해야 합니다. 도우미 자체는 개인 식별 정보를 제공하지 않지만 전송 시 다른 메타데이터와 함께 보낼 수 있습니다. 각 사용처는 전체 페이로드를 문서화하고 최소화할 책임이 있습니다.

## 관련 문서

- [environment-variables.md](environment-variables.md) — `PI_CONFIG_DIR`는 `install-id`의 저장 위치를 제어합니다.
- [config-usage.md](config-usage.md) — 전체 구성 루트 구조.
