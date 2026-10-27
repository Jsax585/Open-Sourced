# tts

> 음성 모델 역할을 사용하여 텍스트에서 음성 오디오 파일을 생성하고 `output_path`에 씁니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/tts.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/tts.md`
- 음성 역할 선택: `packages/coding-agent/src/config/model-resolver.ts`, 역할 기본값 체인은 `packages/catalog/src/compat/rules/runtime/behavior.kdl` (`roleDefaultModels()`)
- 클라우드 전송 계층: `packages/ai/src/speech/`
- 로컬 음성 카탈로그: `packages/coding-agent/src/tts/models.ts`
- 로컬 워커 클라이언트: `packages/coding-agent/src/tts/tts-client.ts`
- 세션 주입: `packages/coding-agent/src/sdk.ts` (`speechgen.enabled`)

SDK는 `speechgen.enabled=true`(기본값 `false`)일 때 쓰기 승인을 사용하는 이 사용자 정의 도구를 등록합니다. 단, 도구 등록이 제한되었거나 같은 이름의 도구가 이미 등록되어 있으면 등록하지 않습니다. 설정을 실시간으로 변경하면 SDK 소유 항목을 추가하거나 제거합니다. 이 도구는 `strict=false`입니다.

## 입력

| 필드 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| `text` | `string` | 예 | 합성할 텍스트. JavaScript 문자열 기준 `1..15000`자여야 합니다. |
| `voice_id` | `string` | 아니요 | 클라우드 음성 ID. xAI의 기본값은 `eve`이며, OpenAI 호환 음성에서는 명시적으로 설정한 경우에만 전달합니다. 로컬 합성은 대신 `tts.localVoice`를 사용합니다. |
| `language` | `string` | 아니요 | 스키마 기본값은 `en`입니다. 현재 xAI를 포함한 모든 실행 경로에서 사용하지 않습니다. |
| `output_path` | `string` | 예 | 세션 cwd를 기준으로 해석하는 대상 경로. 대소문자를 구분하지 않고 `.wav`이면 WAV를 요청하며, 그 외 접미사는 MP3를 요청합니다. |
| `sample_rate` | `number.integer` | 아니요 | xAI 샘플 레이트 재정의. 로컬 및 OpenAI 호환 음성에서는 무시합니다. |
| `bit_rate` | `number.integer` | 아니요 | xAI MP3 비트 레이트 재정의. WAV, 로컬 및 OpenAI 호환 음성에서는 무시합니다. |

## 출력
- 성공하면 텍스트 블록 하나와 `details = { bytes, voiceId, codec, backend }`를 반환합니다.
  - 클라우드: `Saved <bytes> bytes to <path> (model=<provider>/<model>, voice=<voice>, codec=<codec>).`
  - 로컬: 실제 WAV 경로, `<model>/<voice>`, 샘플 레이트 및 컨테이너 대체 여부를 표시합니다.
  - `backend`는 `"local-inference"`, `"xai-tts"` 또는 `"openai-speech"`입니다.
- 일치하는 음성 모델이 없거나, 키 누락/HTTP 실패로 모든 후보를 소진했거나, 로컬 워커 응답이 `null`이면 텍스트 블록 하나와 `isError: true`를 반환하며 `details`는 없습니다.
- 그 외 예외, 호출자 취소 및 전송 제한 시간 초과는 그대로 전파됩니다.

## 흐름
1. cwd, 대상 경로 및 요청한 코덱을 해석합니다.
2. 사용 가능한 `tts` 종류의 모델 풀을 구성하고 `modelRoles.speech`와 `retry.fallbackChains.speech`를 해석합니다. 명시적 구성이 없으면 우선순위 목록은 `local/kokoro`, `xai/grok-tts`, `xai-oauth/grok-tts`입니다.
3. MP3에서는 명시적으로 지정하지 않은 후보만 재정렬하여 클라우드 모델이 로컬 모델보다 앞에 오게 합니다. 명시적인 기본/대체 슬롯은 위치를 유지합니다. WAV는 해석된 체인 순서를 유지합니다.
4. 후보를 차례대로 시도합니다.
   - `local-inference`는 선택한 모델 ID, `tts.localVoice`, `tts.localSpeed`로 로컬 워커를 호출하고 PCM16 WAV로 인코딩하여 기록합니다. 호출별 음성, 언어, 샘플 레이트 및 비트 레이트는 무시합니다.
   - `xai-tts`는 모델 레지스트리의 자격 증명 해석기를 통해 선택한 모델의 `<baseUrl>/tts`를 호출합니다. 텍스트와 음성을 보내며, WAV 또는 기본값과 다른 샘플/MP3 비트 레이트로 인해 필요한 경우에만 명시적인 `output_format`을 보냅니다.
   - `openai-speech`는 `{ model, input, response_format, voice? }`로 선택한 모델의 `<baseUrl>/audio/speech`를 호출합니다. 음성은 명시적으로 제공한 경우에만 보냅니다. OpenAI뿐 아니라 DeepInfra 같은 호환 제공자도 포함합니다.
5. API 키 누락과 제공자 HTTP 오류가 발생하면 다음 후보로 넘어갑니다. 로컬 `null` 응답은 즉시 오류를 반환하며, 다른 실패는 대체 후보 전환을 유발하지 않습니다.

## 모드 / 변형
- 로컬: 기기 내 Kokoro-82M 추론. 항상 WAV/PCM16입니다. 로컬 추론을 실행하기 전에 모델 가중치를 다운로드해야 할 수 있습니다.
- xAI: Grok Voice 클라우드 합성. MP3 또는 WAV입니다.
- OpenAI 호환 음성: 선택한 클라우드 모델과 엔드포인트. MP3 또는 WAV입니다.
- 기존 `providers.tts` 값(`local`, `xai`, `deepinfra`)은 설정을 로드할 때 음성 역할 선택자로 마이그레이션합니다. `providers.tts`와 `tts.localModel`은 제거되며, 이제 음성 역할에서 로컬 모델을 선택합니다.

## 부수 효과
- 파일 시스템: 대상 파일을 쓰며, WAV가 아닌 대상에서 체인이 로컬 모델에 도달하면 같은 디렉터리의 `.wav` 파일을 씁니다.
- 네트워크: 클라우드 합성은 선택한 엔드포인트를 호출합니다. 로컬 모델 로드 중에는 가중치를 다운로드/캐시할 수 있습니다.
- 세션 상태: cwd, 모델 레지스트리, 세션 ID, 음성 역할 설정, `tts.localVoice`, `tts.localSpeed`를 읽습니다.
- 취소: 클라우드 요청은 호출자 신호와 60초 제한 시간을 결합합니다. 로컬 합성에는 호출자 신호를 전달합니다.
- 스트리밍: 단일 응답 방식이며 `onUpdate` 진행 상황을 제공하지 않습니다.

## 제한 및 상한
- 텍스트 제한: 모든 백엔드에서 JavaScript 문자열 기준 `1..15_000`자입니다.
- xAI 기본값: 음성 `eve`, 샘플 레이트 `24000`, MP3 비트 레이트 `128000`.
- 내장 xAI 음성: `ara`, `eve`, `leo`, `rex`, `sal`. 사용자 정의 음성 ID도 허용합니다.
- 기본 로컬 모델: `local/kokoro` (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8).
- 기본 로컬 음성: `af_heart`. 설정 카탈로그에는 `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, `bm_fable`도 포함됩니다.

## 오류
- 후보 체인이 비어 있음: `No available speech model matches the speech role.`
- 재시도 가능한 모든 후보 실패: `Speech synthesis failed for every candidate: <provider/model>: <error>; ...`.
- 클라우드 HTTP 오류에는 상태와 제공자 상세 정보의 처음 최대 300자가 포함됩니다.
- 로컬 워커의 `null` 응답은 모델 ID와 워커/모델 다운로드 문제 가능성을 알립니다.
- 호출자 취소, 클라우드 제한 시간 초과, 파일 시스템 쓰기 오류, 지원하지 않는 음성 API 및 로컬 워커가 던진 실패는 대체 결과로 변환하지 않고 그대로 전파합니다.

## 참고
- 로컬 MP3 인코더는 포함되어 있지 않습니다. 로컬에서 `speech.mp3`를 요청하면 `speech.wav`를 쓰고 대체 사실을 알립니다.
- 호출별 모델 선택자는 없습니다. 음성 역할과 대체 체인을 구성하세요. 로컬 음성 선택은 설정으로 유지됩니다.
