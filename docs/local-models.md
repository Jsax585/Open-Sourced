<a id="local-model-catalog-and-experiments"></a>
# 로컬 모델 카탈로그 및 실험

이 문서는 `local` 카탈로그의 온디바이스 모델을 설명하고, 배포된 제목 및 메모리 권장 사항의 근거가 된 소형 모델 실험을 기록합니다. 모델은 역할을 기준으로 선택합니다. 기본 선택에는 `modelRoles.<role>`을, 순서가 있는 대안에는 `retry.fallbackChains.<role>`을 사용합니다. 카탈로그 항목은 `packages/catalog/src/compat/rules/providers/local.kdl`에서 작성하며, 텍스트 모델 내보내기는 `packages/coding-agent/src/tiny/models.ts`에 있습니다. 아래 벤치마크 시간은 과거의 측정값이며, 현재 런타임의 성능을 보장하지 않습니다.

```yaml
modelRoles:
  tiny: local/lfm2.5-230m
  memory: local/lfm2-1.2b
  speech: local/kokoro
  dictation: local/parakeet-tdt-0.6b-v3
  # 로컬 소형 모델은 타입이 지정된 판단에도 사용할 수 있습니다:
  judge: local/lfm2-1.2b

retry:
  fallbackChains:
    tiny: []
    memory: []
    speech: []
    dictation: []
    judge: []
```

빈 체인을 명시하면 각 워크로드가 로컬에서만 실행됩니다. 반면 모델 종류별 체인을 설정하지 않으면 해당 역할의 기본 제공 우선순위 목록을 사용합니다. `default` 폴백 체인은 `speech`, `dictation`, `judge`에 적용되지 않습니다.

`omp models --kind tiny`, `omp models --kind tts`, `omp models --kind stt`로 카탈로그를 확인할 수 있습니다. 소형 모델은 `omp tiny-models list`, `omp tiny-models download <model-id>`, `omp tiny-models download all`로 다운로드합니다. `omp setup speech`를 실행하면 각 역할에 사용할 로컬 음성 합성 및 받아쓰기 모델을 선택하고, 설정을 저장하고, 다운로드할 수 있습니다.

소형 모델 CLI와 소스 레지스트리는 **제목** 및 **메모리** 그룹을 유지합니다. 모델 크기를 벤치마크하고 권장하는 데 사용한 워크로드가 이 두 가지이기 때문입니다. 이 그룹은 런타임 모델 클래스가 아닙니다. 두 그룹의 모든 항목은 카탈로그 종류가 `tiny`이며, 호환되는 항목이라면 `tiny`, `memory`, `judge`에 할당할 수 있습니다. CLI 그룹만 보지 말고 품질과 리소스 요구 사항을 기준으로 선택하세요.

<a id="runtime--environment-findings"></a>
## 런타임 / 환경 관련 확인 사항

- **텍스트/Whisper 스택**: Bun 워커에서 실행되는 `@huggingface/transformers`(transformers.js) v4이며, 기본적으로 네이티브 `onnxruntime-node` 백엔드를 사용합니다. Kokoro는 격리된 워커에서 별도의 `kokoro-js` 보조 런타임을 사용하고, Parakeet은 `sherpa-onnx-node`를 사용합니다.
- **비 FHS 배포판(NixOS 및 로더 경로에 `libstdc++.so.6`가 없는 모든 호스트)**: 필요할 때 로드되는 `onnxruntime-node` / `sherpa-onnx-node` / `sharp` 애드온은 `libstdc++.so.6`와 `libgcc_s.so.1`을 `dlopen`으로 여는 사전 빌드 바이너리입니다. 자체 `DT_RUNPATH`를 포함하므로 omp 실행 파일 자체의 RPATH로는 이 라이브러리를 찾을 수 없습니다. 해당 라이브러리가 있는 디렉터리를 콜론으로 구분하여 `OMP_NATIVE_LIBRARY_PATH`에 설정하세요. omp는 추론 워커 하위 프로세스에 대해서만 이를 `LD_LIBRARY_PATH`에 추가합니다(shell/eval/daemon 자식 프로세스에는 절대 적용하지 않음). Nix 패키지(`nix/package.nix`)는 이를 기본으로 설정합니다.
- **모델/백엔드당 텍스트 워커 하나, 영구 상주하지 않는 연결 유지**: 각 소형 텍스트 모델/백엔드 쌍은 `~/.omp/run/tiny/<model>-<backend>.sock`(Windows에서는 명명된 파이프)을 소유하는 시스템 전체 공용 워커 하나가 처리합니다.
  같은 모델의 ONNX 워커와 MLX 워커는 공존할 수 있습니다. 해당 쌍이 필요한 첫 omp 프로세스가 워커를 분리 실행합니다(로그는 소켓 옆의 `<model>-<backend>.log`에 저장).
  다른 omp 프로세스는 여기에 연결하므로 omp 인스턴스마다 가중치가 중복되지 않습니다.
  이를 감독하는 프로세스는 없습니다. 워커는 요청이 없는 상태로 15분이 지나면 스스로 종료하고(`OMP_TINY_WORKER_IDLE_MS`로 테스트용 대기 시간을 재정의할 수 있음), 소켓을 삭제합니다. 이후 어느 omp 프로세스에서든 다음 요청이 들어오면 새 워커를 실행합니다. 동시에 실행을 시도하면 `.bind.lock` 파일 잠금을 두고 경합합니다. 경합에서 진 쪽은 활성 소켓을 확인하고 종료하며, 그 부모 프로세스는 승자의 워커를 사용합니다.
  `ping`은 실행 태그(`<omp version>|onnx|<device>|<dtype>` 또는 `mlx|<mlx-lm version>|<script crc>`)를 반환하므로, omp를 업그레이드하거나 `providers.tinyModelDevice`/`providers.tinyModelDtype`을 변경하면 오래된 ONNX 워커가 교체됩니다.
  MLX 교체는 런타임 버전/스크립트 태그를 따릅니다. 장치/dtype 설정이 서로 다른 ONNX 클라이언트를 동시에 사용하면 서로의 워커를 교체할 수 있으므로 설정을 통일하세요.
  프로토콜은 메시지 수준입니다(`load`, 그리고 메시지 / 프리필 / 중지 / 최대 토큰을 지정하는 `chat`). 프롬프트 구성과 제목 추출은 클라이언트에서 처리하므로 두 종류의 워커를 서로 바꿔 사용할 수 있습니다.
- **장치 정책**: 로컬 소형 모델은 기본적으로 CPU 전용 추론을 사용하며, 명시적으로 지정한 가속 제공업체를 초기화할 수 없으면 CPU에서 한 번 재시도합니다.
  - `providers.tinyModelDevice` 설정으로 제공업체를 영구 지정하거나(`default`는 CPU 유지), 실행별로 `PI_TINY_DEVICE` 환경 변수를 사용하세요(설정값보다 우선).
  - 허용되는 값은 `cpu`, `gpu`, `mlx`/`metal`, `webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu`, `webnn-npu`입니다.
  - `coreml` 직접 사용은 여전히 `PI_TINY_DEVICE=coreml`로 명시적으로 선택해야 합니다. 캐시된 디코더 LLM ONNX 로드가 세션 초기화 중 실패할 수 있으므로 기본값에 포함되지 않습니다.
  - WebGPU/Metal은 단일 프로세스 평가 하네스에서는 작동하지만, 프로덕션 워커는 Darwin의 `gpu`/`webgpu`/`auto` 요청을 CPU로 되돌립니다. 현재 ONNX Runtime/Bun이 WebGPU 추론 후 워커 종료 처리 중 치명적으로 충돌하기 때문입니다.
  - 기본 CPU 사용을 명시적으로 해제할 때만 `providers.tinyModelDevice` 또는 `PI_TINY_DEVICE`를 사용하세요.
- **MLX 백엔드(Apple silicon)**: `PI_TINY_DEVICE=mlx`(또는 `metal`)는 ONNX 제공업체가 아니라 워커 자체를 교체합니다. 모델별 워커는 고정 버전의 `mlx-lm` venv에서 실행되는 `mlx-server.py`입니다. omp는 최초 사용 시 이 환경을 `~/.omp/agent/cache/tiny-mlx-runtime/` 아래에 설치합니다(`uv`를 사용하고, 없으면 Python ≥ 3.10에서 `python3 -m venv` 사용). 모델의 사전 양자화된 4비트 MLX 내보내기(레지스트리의 `mlxRepo`)를 바이트 단위 진행률과 함께 `~/.omp/agent/cache/tiny-models/mlx/`에 다운로드하고, `mlx_lm.load`로 로드합니다. ONNX 워커와 정확히 같은 프로토콜을 사용하므로 제목, 메모리 완성, 로컬 타입 지정 판단이 같은 백엔드를 사용합니다. 추론은 Python 워커에서 실행됩니다. MLX는 `PI_TINY_DTYPE`을 무시합니다. venv 부트스트랩이 실패하면(Python 없음, 설치 오류, Apple 이외의 호스트) omp는 경고를 기록하고 해당 프로세스가 끝날 때까지 ONNX CPU 워커를 사용합니다. M4 Max에서 측정한 결과: 콜드 상태에서 venv 설치 + LFM2.5-230M 다운로드 + 로드에 15.7초, 두 번째 omp 인스턴스가 실행 중인 워커에 연결하는 데 1초 미만, 워밍업 후 제목 생성에 15~60ms가 걸렸습니다. Qwen3-1.7B(`onnxruntime-node`에서는 사용 불가)는 984MB를 다운로드하며 메모리 추출에 약 200ms 만에 응답합니다.
- **양자화: q4가 최적의 균형점** — 디스크 사용량이 더 적고, 로드가 더 빠르며, 추론도 빠릅니다.
  q8/int8은 CPU에서 로드도 더 느리고 추론도 더 느립니다. 배포되는 모든 모델은 기본적으로 `q4`를 사용합니다. `providers.tinyModelDtype` 설정으로 정밀도를 영구 재정의하거나(`default`는 `q4` 유지, 예: 더 높은 충실도를 원하면 `fp16`), 실행별로 `PI_TINY_DTYPE`을 사용하세요(설정값보다 우선). 허용되는 값은 `auto`, `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`입니다. 인식할 수 없는 값을 지정하면 워커 시작 시 명시적인 오류가 발생합니다.
- **로드 시간 정정(중요).** 이전에 “q4 1B 이상 모델은 로드에 몇 분이 걸린다”고 생각했던 것은 수 GB 규모의 HuggingFace 다운로드 약 5개를 병렬로 실행하면서 발생한 **측정 왜곡**(I/O 포화)이었습니다. 다른 작업 없이 격리해서 측정한 **웜** 로드 시간은 모두 3초 미만입니다.
  - TinyLlama-1.1B q4: 약 0.5초
  - Llama-3.2-1B q4: 약 2.8초(`graphOpt=all`) / 약 0.5초(`disabled`)
  - LFM2-1.2B q4: 약 0.36초
  - Qwen2.5-1.5B q4: 약 1.5초
  - Qwen3-1.7B q4: 약 1.6초
  - gemma-3-1b q4: 약 1.1초
  - 결론: **1B~1.7B 모델은 CPU에서 충분히 사용할 수 있습니다.**
- **`session_options.graphOptimizationLevel`**은 로드 속도와 추론 속도 사이의 절충을 제어합니다. `disabled`는 로드가 가장 빠르지만 추론이 약간 느리고, 기본값은 `all`입니다.
- **최초 실행** 시 HF Hub에서 가중치를 캐시 디렉터리로 다운로드합니다(q4 가중치는 모델에 따라 약 150MB~1.1GB). 이후 **웜** 로드는 1초 미만에서 약 3초가 걸립니다. 추론은 비동기이며 메모리 작업의 백그라운드 실행에 적합합니다. 제목 생성은 반대화형 작업입니다.

<a id="task-1-session-title-generation-modelrolestiny"></a>
## 작업 1: 세션 제목 생성(`modelRoles.tiny`)

**작업**: 첫 번째 사용자 메시지를 3~7단어 제목으로 변환합니다. 소형 모델(1B 미만)로 충분합니다.

**가장 효과적인 구성**:

- 단순한 시스템 프롬프트(few-shot 없음).
- 어시스턴트 턴을 `<title>`로 **프리필**하고 **`</title>`에서 중지**한 뒤, 첫 줄을 사용합니다.
- 탐욕적 디코딩(`do_sample:false`), 채팅 템플릿의 `enable_thinking:false`.

**확인한 사항**:

- **Few-shot 예시는 0.6B 미만 모델의 제목을 오염시킵니다.** 예시의 주제가 그대로 복사됩니다. 현재 로컬 제목 시스템 프롬프트에는 예시가 없습니다.
- 가장 작은 모델에서는 **대소문자 표기 지침이 출력에 포함됩니다.** [`normalizeGeneratedTitle`](../packages/coding-agent/src/tiny/text.ts)이 생성 후 대소문자 표기를 조정하므로 프롬프트에서는 해당 규칙을 생략합니다.
- 여기서는 **토큰 바이어싱(`bad_words_ids`)이 아무 효과도 없음을 확인했습니다.** 프리필이 이미 시작 부분을 제어하기 때문입니다.

**교체 벤치마크**(최근 첫 세션 프롬프트 30개, q4 CPU, 예시 없음):

| 모델              | 캐시 | 웜 평균 / p95 | 3~7단어 | 관찰된 장단점                               |
| ------------------ | ----: | --------------: | ----------: | ----------------------------------------------- |
| LFM2.5-230M        | 214MB |      93 / 194ms |       21/28 | 의미적 균형이 가장 좋음. 때때로 일반적인 제목 생성 |
| Falcon-H1-Tiny-90M | 147MB |     117 / 174ms |       17/29 | 가장 작음. 복잡한 입력에서는 충실도가 낮음       |
| LFM2.5-350M        | 292MB |     166 / 266ms |        4/30 | 지나치게 간결하며 한 단어짜리 레이블을 자주 생성       |

**배포되는 로컬 옵션**: `lfm2.5-230m`, `lfm2.5-350m`, `falcon-h1-90m`.
`modelRoles.tiny`가 설정되지 않으면 제목 생성은 기본 제공 온라인 역할 경로로 해석되며, 로컬 가중치를 자동으로 다운로드하지 않습니다. 로컬 모델을 기본 모델로 지정하면 명시적인 무과금 경계가 설정됩니다. 워커가 실패하거나 제목을 반환하지 않아도 온라인 모델로 넘어가지 않고 세션을 제목 없는 상태로 유지합니다. 인수 없이 `omp tiny-models` 명령을 실행할 때의 기본 다운로드 모델은 `lfm2.5-230m`입니다.

<a id="task-2-mnemopi-memory-modelrolesmemory"></a>
## 작업 2: Mnemopi 메모리(`modelRoles.memory`)

Mnemopi는 두 가지 소형 LLM 작업을 실행합니다.

1. **추출** — 단일 메시지에서 장기적으로 유효한 구조화된 항목을 추출합니다.
2. **통합** — 메모리 목록을 원문에 충실한 1~3개 문장으로 요약합니다.

이 작업에는 **제목보다 큰 모델인 1B~1.7B가 필요합니다.** LFM2-1.2B, Qwen2.5-1.5B, Qwen3-1.7B, gemma-3-1b(q4, CPU)를 테스트했으며, 병렬 에이전트 4개가 각각 27~31개의 실험을 실행했습니다.

<a id="extraction-findings"></a>
### 추출 관련 확인 사항

실험을 통해 기존 5개 범주 JSON 프롬프트의 두 가지 문제가 드러났습니다.

1. 모든 항목이 비어 있는 예시 `{"facts":[],...}`가 **그대로 복사**되어 사실이 생성되지 않았습니다.
2. 이전에는 값이 객체인 범주 항목이 `[object Object]`로 변환되었습니다.

이제 관리형 메모리 경로는 로컬 모델과 온라인 모델 모두에서 추출 지침을 시스템 턴에, 원본 메시지를 사용자 턴에 배치합니다. **한 줄에 일반 텍스트 사실 하나**를 요청하며, 인사말이나 기타 지속성이 없는 콘텐츠에는 정확히 `NO_FACTS`를 반환하도록 합니다.
현재 파서는 문자열 항목이나 인식 가능한 텍스트 필드가 있는 구조화된 범주 객체도 허용합니다. 더 이상 임의의 객체를 문자열로 강제 변환하지 않습니다.

<a id="technique-polarity-flips-vs-titles"></a>
### 제목 생성과 정반대의 효과를 보이는 기법

- 1B 이상에서는 **few-shot이 품질을 좌우하는 가장 중요한 수단입니다.** 예를 들어 예시를 1개에서 3개로 늘리면 Qwen2.5-1.5B의 추출 F1이 0.52 → 0.83으로 향상되고, 예시 2개를 사용하면 gemma의 재현율이 0.65 → 0.92로 향상됩니다.
- **프리필은 추출에 해롭습니다.** 잡담에도 출력을 강제하여 거짓 양성을 만듭니다.
- **시스템 분리**(지침을 시스템 역할에 배치)는 시스템 역할이 있는 모델에 도움이 됩니다.
- 두 작업 모두 **탐욕적 디코딩 >= temperature 기반 샘플링**입니다.
- **토큰 바이어싱**은 여기서도 효과가 없습니다.

<a id="per-model-verdicts-head-to-head-16-fixture-set"></a>
### 모델별 평가(직접 비교, 픽스처 16개 세트)

- **Qwen3-1.7B** — 가장 절제된 추출: 잡담에는 빈 결과를 반환하고, 묻혀 있는 사실의 누출이 없으며, 언어를 유지하고, 깔끔한 평면 JSON을 생성합니다. 약점: 세분성이 낮고, 여러 턴에 걸친 값 갱신을 놓쳤습니다.
- **Qwen2.5-1.5B** — 추출 세분성이 가장 좋고(원자적 사실), 값 갱신을 포착했으며, 잡담 누출이 없었습니다. 약점: 통합이 가장 약하고(장황하게 이어지는 문장, 중복 제거 없음), 묻혀 있는 사실에 대한 출력이 한 번 비정상적으로 퇴화했습니다.
- **gemma-3-1b** — 통합이 가장 좋습니다(중복 제거가 작동하고, 원문에 충실하며, 단일 메모리를 깔끔하게 처리). 약점: 잡담이 누출되고 독일어를 번역했습니다.
- **LFM2-1.2B** — 안정적이며 로드가 가장 빠릅니다. 약점: `Label: value` 잡음, 잡담 및 묻혀 있는 사실의 누출, 내용이 빈약한 단일 메모리 요약이 있었습니다.

<a id="recommendation-and-current-availability"></a>
### 권장 사항 및 현재 사용 가능 여부

실험에서는 추출 정밀도 측면에서 **Qwen3-1.7B**가 가장 좋은 평가를 받았습니다. 배포되는 ONNX 내보내기는 `onnxruntime-node`가 해당 모델의 RotaryEmbedding 캐시 갱신을 지원하지 않아 비활성화되어 있습니다. ONNX 워커는 런타임을 로드하기 전에 이 모델을 거부합니다. Apple silicon에서는 MLX 백엔드로 사용할 수 있습니다(`providers.tinyModelDevice: mlx` 또는 `PI_TINY_DEVICE=mlx`).
`omp tiny-models download all`은 MLX가 활성화되어 있지 않으면 ONNX가 비활성화된 모델을 건너뜁니다.

실행 가능한 옵션 중 `lfm2-1.2b`는 로드가 가장 빠르고 전반적으로 안정적이지만, 자동으로 선택되지는 않습니다.
`gemma-3-1b`는 통합 품질에, `qwen2.5-1.5b`는 세밀한 추출에 강점이 있습니다.

**구성된 로컬 옵션**: `llama3.2:3b`, `qwen3-1.7b`(위에서 설명한 대로 ONNX 비활성화), `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`.
`modelRoles.memory`가 설정되지 않으면 실제 적용되는 `tiny` 역할을 거친 다음 기본 제공 smol 우선순위 목록을 통해 모델을 결정하며, 로컬 가중치를 자동으로 다운로드하지 않습니다.

<a id="mnemopi-parser-behavior"></a>
### Mnemopi 파서 동작

`packages/mnemopi/src/core/extraction.ts`는 구조화된 사실, 지침, 선호도, 타임라인, 지식 그래프 트리플을 보존합니다. 값이 객체인 항목에서 `[object Object]`를 반환하는 대신 인식 가능한 텍스트 필드를 추출합니다. 일반 텍스트 줄 폴백은 여전히 10자 이하인 줄을 무시하므로 `Name: Can`과 같은 짧은 사실은 버려집니다. 구조화된 문자열 항목에는 이러한 길이 제한이 없습니다.

<a id="local-speech-and-dictation-models"></a>
## 로컬 음성 합성 및 받아쓰기 모델

`speech` 역할은 TTS 카탈로그 모델을, `dictation` 역할은 STT 카탈로그 모델을 허용합니다. `omp setup speech`는 해당 역할에서 허용하는 로컬 항목을 제시하고, 선택한 `modelRoles.speech` 및 `modelRoles.dictation` 값을 저장한 뒤 모델/런타임 파일을 다운로드합니다.

<a id="text-to-speech"></a>
### 텍스트 음성 변환

| 선택자       | 저장소                                | 정밀도 | 다운로드 | 참고                                  |
| -------------- | ----------------------------------------- | --------- | -------- | -------------------------------------- |
| `local/kokoro` | `onnx-community/Kokoro-82M-v1.0-ONNX`    | q8        | ~100 MB  | 24 kHz Kokoro-82M, 완전한 로컬 ONNX TTS |

Kokoro 음성 선택은 모델 역할과 계속 독립적으로 유지됩니다. `tts` 도구에는 `tts.localVoice`를, 어시스턴트 출력의 음성 재생에는 `speech.voice`를 설정하세요. 사용 가능한 로컬 음성 ID는 `af_heart`(기본값), `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, `bm_fable`입니다. 음성을 변경해도 다른 모델을 다운로드하지 않습니다. 말하기 속도도 마찬가지로 나뉩니다. `tts` 도구와 `omp say`에는 `tts.localSpeed`를, 음성 재생에는 `speech.speed`를 사용합니다(둘 다 기본값은 `1`이며, `0.5`~`2.5` 범위로 제한됨).

<a id="speech-to-text"></a>
### 음성 텍스트 변환

다음 정식 카탈로그 모델 ID를 사용하세요.

| 선택자                         | 저장소                                                    | 런타임 / 정밀도 | 다운로드 | 참고                                      |
| -------------------------------- | ------------------------------------------------------------- | ------------------- | -------- | ------------------------------------------ |
| `local/whisper-base`             | `onnx-community/whisper-base`                                 | transformers.js q8  | ~60 MB   | 가장 작은 다국어 Whisper 옵션       |
| `local/whisper-small`            | `onnx-community/whisper-small`                                | transformers.js q8  | ~190 MB  | 균형 잡힌 다국어 Whisper 옵션       |
| `local/whisper-large-v3-turbo`   | `onnx-community/whisper-large-v3-turbo`                       | transformers.js q4  | ~600 MB  | Whisper large-v3-turbo, 99개 언어       |
| `local/parakeet-tdt-0.6b-v3`     | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`      | sherpa-onnx int8    | ~680 MB  | 기본값. 빠른 다국어 Parakeet TDT v3 |
| `local/nemotron-streaming-en-0.6b` | `csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25` | sherpa-onnx int8 | ~630 MB | 네이티브 스트리밍, 영어 전용 |

Kokoro와 transformers.js Whisper 모델은 `providers.tinyModelDevice` / `PI_TINY_DEVICE` 및 `providers.tinyModelDtype` / `PI_TINY_DTYPE`을 읽습니다. 기본 정밀도는 텍스트 모델의 기본값인 q4가 아니라 각 음성 모델의 명세에서 가져옵니다. Kokoro는 장치 선호 설정을 더 제한적인 CPU/WASM/WebGPU 집합에 매핑합니다. MLX는 텍스트 모델 백엔드이므로 이를 선택해도 음성 추론은 CPU에서 실행됩니다. Parakeet과 Nemotron은 배포되는 sherpa-onnx int8 파일을 CPU에서 사용합니다. 동작 설정에는 계속 `stt.language`, `stt.submitTrigger`, `tts.localVoice` 및 기타 음성/실시간 설정을 사용하세요. 역할로 이동한 것은 모델 선택뿐입니다.

실시간 영어 받아쓰기에는 Nemotron을 선택하세요. 새 오디오를 160ms 청크 단위로 처리하고 녹음 중에 초안을 갱신하며, 전체 구절을 반복해서 디코딩하지 않습니다. 청크 크기가 단어 표시 지연 시간을 보장하지는 않습니다. 첫 녹음에서는 인식기가 로드될 때까지 기다리며, 이후 녹음에서는 이를 재사용합니다. 오디오는 사용자 기기 안에만 보관됩니다. 다국어 기본 모델은 계속 Parakeet입니다.

Tern에서는 보내기 옆의 마이크를 클릭하고, **녹음 중 · 중지**가 나타나면 말한 다음, 중지를 클릭하여 초안을 마무리하세요. 이 버튼은 자동으로 제출하지 않습니다. 키보드 받아쓰기는 계속 `stt.submitTrigger`를 따릅니다.

<a id="integration-notes"></a>
## 통합 참고 사항

- 제목, 메모리, 판단 워크로드에 사용할 로컬 소형 추론은 `local/<model-id>` 역할 할당으로 선택합니다. `tiny` 역할이 설정되지 않으면 온라인 기본값을 유지합니다. `memory` 역할이 설정되지 않으면 실제 적용되는 `tiny` 역할을 따르므로, `tiny`가 로컬이면 메모리도 로컬이 될 수 있습니다. 설정되지 않은 `speech` 및 `dictation` 역할은 자체 기본 제공 우선순위 목록을 사용하며, 이 목록의 첫 번째 후보는 로컬입니다.
- 로컬 추론은 **워커에서** 실행됩니다(메인 스레드 외부). 가중치는 로컬 후보가 사용되거나 `omp tiny-models` 또는 `omp setup speech`로 명시적으로 미리 가져오는 경우에만 다운로드되며, 이후 디스크에 캐시됩니다.
- 세션 제목 생성은 `modelRoles.tiny`를 사용하고, Mnemopi 추출 및 통합은 LLM 모드가 활성화되어 있을 때 `modelRoles.memory`를 사용합니다. 서로 다른 프롬프트와 벤치마크 그룹이 별도의 런타임 모델 유형을 강제하는 것은 아닙니다.
- 자동 추론, Smart의 예기치 않은 중지 감지, 타입 지정 Eval 판단, AI 지원 git 스테이징은 `judge` 역할을 사용합니다. TypeSafe를 사용하려면 `typesafe/jev-1.14.0`을, 온디바이스 판단을 사용하려면 호환되는 로컬 소형 모델을 할당하세요. 대안의 순서는 `retry.fallbackChains.judge` 아래에 지정합니다.
- 관리형 메모리 추출은 로컬 및 온라인 전송 경로 모두에서 잡담 방지 기능이 있는 공통 줄 형식 시스템 프롬프트를 사용합니다. 로컬 모델을 기본 모델로 지정하면 로컬 통합 프롬프트도 선택됩니다. 명시적인 외부 Mnemopi 엔드포인트는 메모리 역할로 대체되지 않고 계속 우선 적용됩니다.
