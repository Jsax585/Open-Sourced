# generate_image

> 이미지를 생성하거나 편집하고 생성된 이미지 파일을 임시 경로에 저장합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/image-gen.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/image-gen.md`
- 세션 주입: `packages/coding-agent/src/sdk.ts` (`imageGenTool`)
- 공급자 전송 계층: `packages/ai/src/images/`
- 이미지 역할/후보 결정: `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/model-resolver.ts`

이 사용자 정의 도구는 `generate_image.enabled=true`(기본값 `false`)이고 세션에 명시적인 도구 필터가 있다면 그 필터가 `generate_image`를 요청할 때만 등록됩니다. 설정을 전환하면 실행 중인 세션에도 반영되며, 이름이 같은 확장 도구가 우선합니다. `write` 승인을 요청하고 엄격 모드는 사용하지 않으며 진행 상황을 내보내지 않습니다.

## 입력

| 필드 | 유형 | 필수 | 설명 |
|---|---|---:|---|
| `subject` | `string` | 예 | 기본 이미지 프롬프트. 편집할 때는 원하는 결과와 각 입력 이미지의 역할을 설명합니다. |
| `action` | `string` | 아니요 | 피사체가 하는 동작. |
| `scene` | `string` | 아니요 | 장소 또는 환경. |
| `composition` | `string` | 아니요 | 카메라 각도와 구도. |
| `lighting` | `string` | 아니요 | 조명 설정. |
| `style` | `string` | 아니요 | 예술적 스타일. |
| `text` | `string` | 아니요 | 이미지에 렌더링할 텍스트. 짧게 작성하고 필요하면 가독성을 명시합니다. |
| `changes` | `string[]` | 아니요 | 입력 이미지의 편집 지시. |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | 아니요 | 요청할 출력 종횡비. |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | 아니요 | 선택한 모델의 전송 계층이 지원하는 경우 요청할 출력 크기. |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | 아니요 | 로컬 경로나 인라인 base64 데이터로 제공하는 입력 이미지. |
| `model` | `string` | 아니요 | 이 요청에 사용할 이미지 모델 선택자. 예: `openrouter/google/gemini-3-pro-image`, `xai/grok-imagine-image`. 생략하면 설정된 `image` 역할 체인을 사용합니다. |

## 출력
- 이미지 데이터가 있는 성공 응답:
  - `content[0].type = "text"`
  - `content[0].text`는 공급자/모델과 저장된 이미지 경로를 요약하며, 공급자가 반환한 경우 각 이미지의 크기/품질도 표시합니다.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, usage? }`; 각 이미지에는 base64 `data`와 `mimeType`이 포함됩니다.
  - `model`은 공급자가 실행한 모델을 응답에 명시하는 경우 그 이미지 모델(호스팅된 OpenAI 전송 계층)이며, 그렇지 않으면 선택한 카탈로그 모델 ID입니다. 둘이 다르면 텍스트에 모두 표시합니다. 예: `Model: gpt-image-2-codex (catalog entry openai-codex/gpt-image-2)`. 각 `images[]` 항목에는 공급자가 보고한 `size`와 `quality`가 포함될 수 있습니다.
- 이미지 데이터가 없는 모델 응답은 `No image data returned.`, `imageCount: 0`, 빈 `imagePaths` / `images`, 그리고 제공된 응답 텍스트/사용량을 반환합니다. 이미지 콘텐츠 블록은 반환하지 않으므로 저장된 경로를 `read`로 여세요.

## 처리 흐름
1. SDK는 기능 게이트와 도구 필터가 허용할 때만 `imageGenTool`을 `generate_image` 사용자 정의 도구로 주입합니다.
2. 요청에 `model`이 있으면 사용 가능한 `image` 종류 카탈로그 모델에서 해당 선택자를 해석하고 선택된 모델만 시도합니다. 없으면 명시적으로 설정한 이미지 역할/폴백 항목, 활성 모델에 설정된 `imageModel` 대상과 호스팅 이미지를 지원하는 활성 모델 자체, 명시적이지 않은 역할 체인 기본값 순서로 후보를 정렬합니다. 중복된 공급자/모델 항목은 제거합니다. `retry.fallbackChains.image: []`는 역할 체인의 폴백 선택자를 제거하지만 활성 모델의 이미지 후보는 제외하지 않습니다.
3. 지원하지 않는 API 전송 계층, 사용할 수 없는 자격 증명 또는 호스팅 전달 모델을 가진 후보는 건너뜁니다. 공급자 HTTP 실패 시 결정된 체인의 다음 모델로 넘어가지만, 검증·파싱·로컬 I/O·취소·시간 초과 실패 시에는 넘어가지 않습니다.
4. 첫 번째 사용 가능한 모델을 찾은 뒤 입력 이미지를 한 번만 해석합니다. `path`는 세션 cwd를 기준으로 해석하고 일반 파일 여부와 크기를 검사하며 내용으로 유형을 판별합니다. 인라인 `data`는 원시 base64(`mime_type` 필수) 또는 `data:<mime>;base64,...` URL일 수 있습니다.
5. 선택한 카탈로그 모델의 `api`에 따라 전송 계층을 결정합니다.
   - `openai-images`: xAI/xAI OAuth와 DeepInfra를 포함한 OpenAI 호환 `/images/generations` 및 `/images/edits` 요청. OpenAI 편집은 multipart 이미지 업로드를 사용하고 다른 공급자는 JSON 참조를 사용합니다. 편집 엔드포인트가 `404`를 반환하면 편집 페이로드로 생성 엔드포인트에 재시도합니다.
   - `openrouter-images`: 채팅 완성이 아닌 OpenRouter의 네이티브 `/images` 엔드포인트. 카탈로그의 요청 모델 ID를 그대로 전송합니다. 예를 들어 선택자 `openrouter/google/gemini-3-pro-image`에는 `google/gemini-3-pro-image`를 보냅니다.
   - `google-generative-ai`: `responseModalities: ["IMAGE"]`를 사용하는 Gemini `:generateContent`.
   - `google-gemini-cli`: Google Antigravity의 내부 SSE 이미지 엔드포인트. 검색 결과에 계정이 알린 이미지 모델이 있으면 이를 사용합니다.
   - `openai-responses`: OpenAI 호스팅 Responses 이미지 생성.
   - `openai-codex-responses`: 연결된 구독을 통한 ChatGPT/Codex 호스팅 Responses 이미지 생성.
   - `factory-droid-agent`: 채팅과 같은 클라이언트 식별자로 Factory 프록시를 통해 Factory Droid 이미지 모델을 사용합니다. GPT Image 모델은 Factory의 `/images/generations` 또는 참조 이미지를 JSON에 인라인으로 넣은 `/images/edits`를 사용합니다. Gemini 3 Pro Image는 `responseModalities: ["TEXT", "IMAGE"]`와 Factory의 생성/편집 지침을 사용해 Factory Gemini 경로로 요청합니다.
6. 호스팅 Responses 전송 계층은 카탈로그의 `hostedImage` 기능이 있는 모델을 전달 모델로 사용합니다. 선택한 모델이 호스팅을 지원하면 자신의 요청을 전달합니다. 그렇지 않으면 같은 공급자이고 해당 기능이 있는 활성 모델을 우선하며, 그다음 입력 비용이 가장 낮은 사용 가능한 동일 공급자 전달 모델을 사용합니다. `openai-responses` 이미지 종류 항목에서는 이미지 도구가 선택된 이미지 모델을 지정합니다. Codex 또는 자신의 이미지 요청을 전달하는 채팅 모델에서는 호스트가 이미지 모델을 선택합니다. 요청은 항상 `image_generation`을 선택하고 WebP를 요청하며, 두 호스팅 전송 계층 모두 결정된 크기를 전송합니다.
7. 성공 응답의 인라인 이미지는 임시 파일에 저장하고 경로와 base64/MIME 이미지 메타데이터를 반환합니다. 이미지 데이터가 없으면 `isError`가 아닌 일반적인 이미지 0개 결과를 반환합니다.

## 모드 / 변형
- 텍스트에서 이미지 생성: `subject`와 선택적인 스타일/구도 필드를 제공하고 `input`은 제공하지 않습니다.
- 이미지 편집: 하나 이상의 `input` 이미지와 `changes`, 각 이미지 역할을 식별하는 주제를 제공합니다.
- 텍스트 렌더링: `text`를 사용합니다. 프롬프트는 호출자에게 선명하고 읽기 쉬우며 철자가 정확한 짧은 텍스트를 요청하도록 지시합니다.
- 모델 선택: `model`을 설정하면 요청에 사용할 수 있는 이미지 카탈로그 모델 하나를 고정합니다. 생략하면 `image` 역할과 폴백 체인을 사용합니다.

## 부수 효과
- 파일시스템: 로컬 입력 이미지를 읽고 생성된 출력 이미지를 OS 임시 디렉터리의 `omp-image-<snowflake>.<ext>` 파일에 씁니다.
- 네트워크: 선택한 카탈로그 모델의 API 전송 계층으로 프롬프트와 선택적 이미지를 보냅니다. 응답의 OpenRouter/xAI 이미지 URL은 저장 전에 다운로드합니다.
- 세션 상태: 활성 모델과 이미지 기능/대상, 세션 ID, cwd, 자격 증명, `modelRoles.image`, `retry.fallbackChains.image`, 모델 엔드포인트/헤더, 선택적으로 주입된 `fetch`를 읽습니다.
- 백그라운드 작업 / 취소: 공급자 호출은 호출자의 중단 신호와 3분 제한 시간을 결합해 사용합니다.

## 제한 및 상한
- 로컬 경로 입력은 `35 * 1024 * 1024`바이트(`MAX_IMAGE_SIZE`)로 제한됩니다. 인라인 base64 입력에는 별도의 도구 수준 크기 제한이 없습니다.
- 경로 입력은 존재하는 일반 파일이어야 하며 내용으로 판별한 이미지 유형이 지원되어야 합니다. 각 입력 객체에는 `path` 또는 `data`가 있어야 하며 둘 다 있으면 `path`가 우선합니다.
- 원시 base64 `data`에는 `mime_type`이 필요하며 데이터 URL은 자체 MIME 유형을 제공합니다.
- 요청 제한 시간은 `3 * 60 * 1000`ms입니다.
- OpenAI 호스팅 출력은 WebP로 요청합니다. 다른 응답 파일에는 MIME에서 얻은 확장자(`png`, `jpg`, `gif`, `webp`; 알 수 없는 MIME 유형은 `.png`)를 사용합니다.
- 스키마는 `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `3:2`, `2:3`을 허용하며 업스트림 지원 여부는 선택된 모델 전송 계층에 따라 다릅니다. xAI/xAI OAuth는 비율을 그대로 받고 기본값은 `1:1`입니다.
- `image_size`는 `1024x1024`, `1536x1024`, `1024x1536`을 허용합니다. xAI에서는 각각 `1k`, `2k`, `2k`에 대응하며 생략 시 `1k`입니다.
- OpenAI 호환 및 호스팅 전송 계층은 명시적인 `image_size`를 우선합니다. 없으면 `1:1`은 `1024x1024`, `3:4` / `9:16`은 `1024x1536`, `4:3` / `16:9`는 `1536x1024`에 대응합니다. `3:2` / `2:3`에는 추론된 OpenAI 크기가 없습니다. OpenRouter와 Gemini에는 요청한 비율/크기를 직접 전달합니다. 업스트림의 수락 여부와 실제 크기는 공급자에 따라 다릅니다.
- ChatGPT/Codex 구독 백엔드가 이미지 모델을 선택합니다. 도구는 요청한/결정된 크기를 버리지 않고 전송합니다. 결과에는 제공된 경우 백엔드가 반환한 모델, 크기, 품질을 표시합니다.
- xAI/xAI OAuth 편집 요청은 입력 이미지 3개로 제한됩니다.
- Factory Droid GPT Image 편집은 PNG, JPEG, WebP 참조 1–16개를 받습니다. 모든 Factory 참조는 5 MiB로 제한됩니다. Factory Images 경로는 크기를 받지 않으므로 `aspect_ratio`와 `image_size`는 Gemini 모델에만 전달됩니다.

## 오류
- 결정된 체인에 사용 가능한 모델이 없는 경우: 집계 오류에 시도한 모델과 지원하지 않는 전송 계층, 사용할 수 없는 자격 증명, 잘못된 자격 증명 또는 사용할 수 없는 호스팅 전달 모델 때문에 건너뛴 후보를 표시합니다.
- 잘못된 입력: 파일 없음, 일반 파일이 아님, 35 MiB 초과, 지원하지 않는 내용 판별 이미지 유형, `path`/`data` 누락, 빈 이미지 데이터, `mime_type` 없는 원시 base64.
- 같은 공급자의 사용 가능한 `hostedImage` 전달 모델이 없는 호스팅 이미지 모델은 `hosted chat carrier unavailable`로 건너뜁니다. 사용 가능한 자격 증명이 없는 전달 모델은 `carrier credentials unavailable`로 건너뜁니다.
- 액세스 토큰과 `projectId`가 모두 없는 Antigravity 자격 증명은 해당 후보를 `invalid credentials`로 건너뛰게 합니다.
- xAI/xAI OAuth 편집 참조가 3개를 초과하는 경우: `<provider> image edits accept up to 3 reference images; got <N>`.
- Factory Droid 편집 참조가 16개를 넘거나 참조 하나가 5 MiB를 넘거나 GPT Image 참조가 PNG, JPEG, WebP가 아니면 전송 전에 거부합니다.
- 이미지가 없는 Factory Droid 응답(예: Gemini 프롬프트 차단)은 이유와 함께 예외를 던지고 체인을 끝냅니다. Factory HTTP 거부는 다른 제공자처럼 다음 후보로 넘어갑니다.
- 자격 증명이 있는 모델의 HTTP 실패는 이미지 체인의 다음 후보로 넘어갑니다. 모든 후보가 실패하거나 건너뛰어지면 시도한 모델 이름과 수집된 공급자 HTTP 오류를 담은 `AggregateError`를 던집니다.
- 취소, 3분 시간 초과, 잘못된 공급자 응답, 로컬 I/O 오류는 직접 던집니다.

## 참고
- 이 도구는 내장 `AgentTool` 클래스가 아닌 사용자 정의 도구이므로 모델용 프롬프트가 `src/prompts/tools/image-gen.md`에 있어도 기본 문서는 여기에 있습니다.
- 입력 이미지가 여러 개면 공급자가 모호하지 않은 편집 지시를 받도록 `subject`에서 `Image 1`, `Image 2` 등으로 이름을 지정해야 합니다.
