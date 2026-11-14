# PLaMo 0.8B 페이지 번역: 즉시에 가까운 속도 계획

> 현재 배포는 **ONNX 전용**이다. 아래 계획과 GGUF 비교는 당시 기준선·실험 기록으로 보존한다. 현재 최적화 대상은 기존 ONNX q4f16이며, GGUF 로더·커널·비교 실행기는 제거했다. 고정 일본어 페이지의 후속 목표는 3초 이내이고, 아래 5초 수치는 과거 측정이다.

상태: 저위험 페이지/호스트 최적화 구현과 실제 확장 반복 검증 완료. **전체 페이지 5초 이내 목표는 부분 달성**이다. warm 30회 중 19회, 별도 nonresident-model 18회 중 18회가 충족했다. 서로 다른 실행군을 합쳐 보장으로 해석하지 않는다. 과거 upstream wllama 실험과 실패 기록은 보존한다.

## 1. 고정 조건

- 확장프로그램만으로 실행. 별도 앱, native messaging 추론 서버, 로컬 서버, 클라우드 추론에 의존하지 않는다.
- 모델은 현재 PLaMo-3 Translate 0.8B **GGUF Q4_K_M**과 **ONNX q4f16** 파일로 제한한다. 모델/토크나이저/템플릿 해시를 기준선과 후보에 기록한다.
- 다른 양자화 파일, 다른 모델, 별도 draft 모델, 재학습·증류는 제외한다.
- 두 모델을 항상 동시에 GPU에 올리지 않는다. 선택된 모델 한 개와 한 resident worker가 기본이다. 사용자 선택을 요청마다 임의로 바꾸지 않는다.
- 재양자화, activation/KV 정밀도 축소, 대규모 weight 전개는 기본 구현에 섞지 않는다. 아래 별도 연구 후보로 남기며 품질·메모리 정책 결정과 검증을 거쳐야 한다.
- 일반 사용자가 쓸 수 있는 브라우저 API만 기본 경로에 사용한다. unsafe/실험 플래그, 특정 native Metal 기능의 브라우저 노출을 가정하지 않는다.
- 속도 때문에 원문·출력·문맥을 몰래 줄이거나 긴 문단을 완료 처리하지 않는다. 번역 대상에서 제외된 텍스트, 실패, 보류를 구분한다.

## 2. 변경 전 기준선

### 이미 구현되어 있어 신규 개선으로 계산하지 않을 것

- 모델 파일의 로컬 저장, resident 모델 재사용, 기본 inference worker 한 개.
- GGUF/ONNX 모두 정상 경로는 custom WebGPU kernels. ONNX Runtime은 fallback이다. 파일 형식과 실행 엔진을 혼동하지 않는다.
- 커널은 최대 8개 요청 슬롯의 continuous batching, chunked prefill, 진행 중 decode 우선 처리, 요청별 취소를 지원한다.
- 페이지는 현재 기본 두 개/설정 한 개 또는 두 개의 admission을 사용한다. 커널의 8슬롯 지원이 페이지가 늘 8개를 공급한다는 뜻은 아니다.
- 화면·독서 영역 우선순위, 500ms 안정 후 한 개씩 forward prefetch, 480-character DOM quantum와 64-source-token 분할.
- 약 40ms 스트리밍 알림, 원문 순서에 따른 부분 표시, 로컬 결과 LRU와 일부 중복 제거.
- GEMV 폭별 특화, GGUF lossless repack, 일부 norm/RoPE/잔차 융합, 분할 argmax, 긴 context attention 분할.

근거: `src/hostworker.ts:174-227`, `src/lib/constants.ts:115-124`, `src/lib/kernels.ts:1174-1307`, `src/lib/onnxhost.ts:197-242`, `src/content.ts:210-224,500-535`, `src/lib/pipeline.ts:399,519-548`, `src/lib/dom.ts:230-258`.

### 현재 남아 있는 구체적인 경계

- `content.ts:218`은 항상 `readingWindow: true`. `pipeline.ts:524-528`은 visible 또는 다음 offscreen 본문 하나만 admission한다. **현재 일반 경로는 전체 페이지 완료 보장이 아니다.** stationary page 전체 완료는 별도 pending inventory와 완료 정의가 필요하다.
- `pipeline.ts:706-712`는 뒤쪽 독립 unit의 표시도 앞 unit 완료 뒤로 묶는다. 계산 완료와 실제 사용자 표시 사이에 head-of-line 대기가 생길 수 있다.
- 초기 요청 묶기 대기는 `ENGINE_COALESCE_MS=40`. kernel queue는 FIFO이며 host job에는 viewport priority/deadline이 없다.
- custom kernel READY는 pipeline/upload 준비 후이며 실제 첫 generation warmup은 없다. 모델은 10분 idle 후 해제된다.
- count/fragment planning과 generation은 별도 경로이며 텍스트를 재토큰화한다. tokenizer가 준비되어도 현재 count는 GPU 엔진 준비를 기다린다.
- KV slot을 새 요청에 배정할 때 `fed=0`으로 시작한다. exact prompt-prefix KV cache는 없다.

### 기존 수치와 해석 한계

`docs/translation-performance.md:3383-3417`의 같은 실험 내 installed request-to-final-output 중앙값:

| 모델 | 단일 요청 | 8개 요청 cohort |
| --- | ---: | ---: |
| ONNX q4f16 | 686.2ms | 1448.1ms |
| GGUF Q4_K_M | 763.4ms | 1607.9ms |

이는 페이지 DOM 완료나 모든 문장의 속도가 아니다. 당시 ONNX가 낮은 요청 지연의 기준선이다. GGUF가 일부 B8 pure-decode TPS에서 높아도, prefill·대기·완료를 포함한 승리를 뜻하지 않는다.

현재 GGUF 단일 decode 계측에서 quantized matrix가 GPU 시간의 약 78%, Q6_K head가 ONNX head의 약 1.9–2.0배였다. 이는 메모리 읽기와 bit/scale 처리 중 어느 쪽이 지배적인지 확정한 결과가 아니다. JS encode는 해당 계측 wall의 약 1–2%였다. host만 손봐 GPU decode가 수배 빨라질 것으로 보지 않는다.

## 3. 속도 개선 후보 전체 지도

P1은 먼저 검증할 경로, P2는 비용 계측 후 채택할 경로, P3은 고위험 연구다. 우선순위는 구현 순서이며 기대 배수를 뜻하지 않는다.

### A. 실제 추론 작업을 줄이거나 미리 준비하기

| ID | 후보 | 현재 대비 바꿀 것 | 효과 범위와 위험 |
| --- | --- | --- | --- |
| A1 / P1 | 정확한 결과 캐시·single-flight 범위 확대 | 한 `dom.run` 안의 중복 제거를 독립 unit 간까지 확장. 우선 동일 origin/extension session에서 동일 effective request 공유 | 중복 생성 자체 제거. 최초의 고유 문장은 빨라지지 않는다. 모델·토크나이저·템플릿·언어·문맥·원문·분할 정책이 key에 포함되어야 한다. subscriber별 취소 분리 |
| A2 / P1 | 선택 모델의 선제 준비와 준비 상태 분리 | 허용된 페이지의 번역 의도에서 tokenizer/GPU 준비 시작. 필요하면 대표 prefill/decode warmup. 사용 중인 foreground 페이지를 고려한 residency 정책 | cold/첫 실행 지연 이동·감소. warmup 비용을 숨기지 않는다. 브라우저 시작마다 무조건 로드하지 않고, unload·메모리 압력·idle 제한 유지 |
| A3 / P1 | tokenizer와 GPU 초기화 병행 | tokenizer-ready부터 정확한 count/분할을 수행하고 worker read/upload와 겹친다 | cold critical path 단축 후보. generation은 engine-ready 이후만 실행. 모델 교체 epoch로 오래된 plan 폐기 |
| A4 / P1 | count/분할/generation 토큰 작업 재사용 | exact rendered prompt ID를 bounded cache 또는 host-owned opaque plan handle로 재사용. count RPC에서 만든 작업을 다시 계산하지 않게 한다 | 반복 CPU·RPC 감소. source count와 full prompt encoding은 다르므로 token 배열을 임의로 이어 붙이지 않는다. Unicode byte fallback과 특수 토큰 유지 |
| A5 / P2 | exact prompt-prefix KV 재사용 | 실제 공통 leading token IDs의 KV만 immutable cache로 보관, 슬롯 시작 상태로 복사/공유 | prefill만 감소. 출력언어 framing이 source 뒤에 있으면 공통 prefix가 아니다. 실제 prefix 길이·hit rate·KV 복사 비용을 먼저 측정 |
| A6 / P2 | 동일 결정적 재시도 제거 | primary/retry의 prompt·backend·options가 완전히 같을 때만 동일 greedy generation 반복 생략 | 실패 경로의 낭비 제거. 문맥을 바꾸는 유효한 retry는 유지. 나쁜 출력을 성공 처리하지 않는다 |

주요 위치: `dom.ts:616,828-889`, `engines.ts:370-406`, `onnxhost.ts:142-178,197-242,597-626,794-810,901-937,1065-1068`, `local.ts:552-617`, `kernels.ts:1200-1211`.

영속 번역 캐시는 별도 선택이다. 저장해도 될 원문/번역의 범위, origin 격리, incognito 제외, 삭제·만료를 결정하지 않고 넣지 않는다. “이미 번역한 페이지는 즉시”와 “새 페이지도 즉시”를 별도로 보고한다.

### B. 페이지 처리량과 첫 결과를 함께 개선하기

| ID | 후보 | 현재 대비 바꿀 것 | 효과 범위와 위험 |
| --- | --- | --- | --- |
| B1 / P1 | deadline-aware admission | foreground 첫 unit은 지연 최소, 이후 backlog에 따라 1/2/4/8 admission을 유한 비교. 준비된 요청이 충분하면 40ms 고정 대기 단축 | 8개 고정이 답은 아니다. 폭을 늘리면 각 문장의 지연도 늘 수 있다. 먼저 1/2 동적 정책을 검증하고, 4/8은 전체 페이지 처리량 단계에서 평가 |
| B2 / P1 | 확장 전체의 공정한 GPU admission | per-tab FIFO 위에 active-visible 우선, background aging/최소 진전, prefetch 최하위의 공유 예산 | 여러 tab의 체감 지연 개선 후보. 동의하지 않은 tab에는 작업 금지. 하나의 탭이 GPU를 독점하거나 나머지가 굶지 않게 한다 |
| B3 / P1 | fragment 경계에서 우선순위 재평가 | 스크롤 후 아직 시작하지 않은 64-token fragment를 보류하고 새 visible 요청을 admission. 완료 prefix와 미완료 plan 유지 | 큰 DOM quantum 전체가 끝날 때까지 기다리는 비용 감소. 커널 중간 강제 중단이 아니라 안전한 경계의 pause. 단순 cancel/restart로 같은 내용을 재생성하지 않는다 |
| B4 / P1 | 실제 전체-page drain | finite DOM snapshot의 pending/완료/실패/제외/보류 inventory. visible 우선 후 나머지 eligible source도 끝까지 진행 | 전체 페이지 목표의 필수 전제. infinite feed는 snapshot/새 viewport 단위로 정의. hidden/editable/protected 영역을 임의로 번역하지 않는다 |
| B5 / P2 | 토큰 기준 semantic segmentation 일원화 | 480문자 분할 뒤 64토큰 재분할하는 중복 경계를 줄이고 source offset을 보존. source 32/64/128-token 후보를 문장 경계 우선으로 비교 | 작은 조각은 첫 결과가 빠르지만 반복 prompt 증가·문맥 손실. 큰 조각은 첫 결과·스크롤 반응 악화. output budget/EOS 완결성 필수 |
| B6 / P2 | 짧은 inline unit의 제한적 묶음 | 같은 의미 단위의 link/span 텍스트를 mapping 계약과 함께 처리. unrelated 문단은 별도 sequence batching 유지 | prompt overhead 감소 후보이나 번호/분리자 생성과 fallback이 오히려 비쌀 수 있다. 잘못된 링크 대응·누락·재시도까지 총비용에 포함 |
| B7 / P2 | 지연 예산 기반 mixed prefill | 이미 존재하는 mixed budget32를 기준으로, decode deadline 여유 때만 후보 budget16/64를 선택 | 과거 64는 corpus가 빨라도 mixed step 지연이 증가했다. 처리량만 보고 전역64로 변경하지 않는다 |
| B8 / P2 | 완료·방향을 아는 bounded prefetch | 기존 500ms/forward 한 개 prefetch를 scroll 방향·안정도·visible backlog에 맞게 조절. 전체-page drain과 동일 inventory 사용 | 읽기 전 완료해 체감 지연을 숨긴다. 실제 계산 속도 상승은 아니다. 사용하지 않은 생성량·전력·visible 간섭까지 측정 |

주요 위치: `background.ts:175-179,537-556`, `content.ts:500-535,698-709`, `pipeline.ts:519-548,696-738`, `engines.ts:276-343`, `kernels.ts:1200-1251`. 과거 폭별 preview/throughput 상충은 `translation-performance.md:1842-1871`, mixed-budget 상충은 `:2454-2475` 참고.

### C. 이미 계산한 결과를 늦게 보여주지 않기

| ID | 후보 | 현재 대비 바꿀 것 | 효과 범위와 위험 |
| --- | --- | --- | --- |
| C1 / P1 | 독립 unit 간 표시 head-of-line 제거 | 한 semantic unit 내부 순서는 유지하되, 독립된 뒤 unit이 준비됐는데 앞 unit 때문에 안 보이는 대기를 제한 | 실제 생성 속도와 구분. 읽기 순서·접근성·레이아웃 이동을 검증하고, source 소유권이 겹치는 unit은 분리 금지 |
| C2 / P2 | delta transport, 안전한 누적 디코딩 | worker→host는 offset 포함 token ID delta, host는 누적 ID로 decode. port의 중복 문자열도 필요시 줄임 | GPU 병목 해결책은 아니다. 토큰 delta를 개별 문자열로 decode하면 Unicode가 깨질 수 있다. 최종 문자열과 취소/오래된 메시지 처리 동일 |
| C3 / P2 | incremental DOM planning | 기존 mutation subtree 처리 위에 revisioned pending index, geometry read batching, 변경 영역만 재측정 | 큰 페이지의 메인 스레드 지연 감소 후보. clipping/virtualized DOM/RTL/원문 복원 정확성 유지 |
| C4 / P2 | provisional와 확정 번역을 분리한 표시 | 현재 40ms+rAF streaming은 유지하며, 완료된 fragment/unit 정보를 명시. animation/commit 대기 시간 계측 | 첫 글자나 마침표를 “완결 번역”으로 세지 않는다. 첫 paint를 위해 잘못된 source-to-translation 정렬을 확정하지 않는다 |

주요 위치: `pipeline.ts:706-713`, `dom.ts:587-613,692-712`, `translationtext.ts:374-398`, `hostworker.ts:70-85`, `onnxhost.ts:456-464`.

### D. 모델 계산 자체 가속

D 계열은 A/B/C와 별개로 실제 uncached inference 비용을 줄이는 연구다. 단순히 UI만 빨라진 결과로 대체하지 않는다.

| ID | 후보 | 구체적 방법 | 채택 전 확인 |
| --- | --- | --- | --- |
| D1 / P1 조사→조건부 실험 | 실제 병목 커널 microbenchmark | Q4_K_M의 Q6 head와 Q4/Q6 FFN, ONNX 대응 행렬을 실제 N/K·weights·activation으로 측정. cold/반복 hot-cache와 model-step을 구분하고 layout/산술 ablation은 진단용으로만 사용 | GPU timestamp·buffer byte inventory·동일 조건 read probe로 비용을 좁힌다. 읽기량을 곧 DRAM 트래픽이라 하거나 pass-splitting wall을 채택 기준으로 쓰지 않는다 |
| D2 / P2 | hardware-aware packed GEMV/GEMM | D1이 지목한 load coalescing, register pressure, coefficient 공유, vectorization, subgroup sum/broadcast만 수정. adapter feature·실제 lane mapping을 검증 | 원래 모델값 보존. subgroup이라는 이름만으로 가속을 가정하지 않는다. 기존 실패 후보는 새로운 차별 가설 없이는 반복하지 않는다 |
| D3 / P2 | 측정된 dispatch/중간 버퍼 비용의 추가 융합 | 기존 융합을 유지하고, head projection+부분 argmax 또는 작은 elementwise 경계처럼 남은 비용만 평가 | 정확한 argmax tie/NaN 규칙과 모든 vocabulary 후보 보존. 78% 행렬 자체가 없어지는 효과는 아니다. register pressure 증가를 포함해 비교 |
| D4 / P3 | GPU-resident token feedback와 bounded multi-step submit | GPU embedding lookup·선택 token·position·EOS 상태를 유지하고 2~4 step 묶음 뒤 host 통지. 한 shader에 GPU 전체 barrier를 구현하지 않음 | per-token CPU feedback 제거와 단순 GPU embedding은 다른 실험이다. 기존 embedding만 옮긴 실험은 무효과였다. EOS 후 work, cancellation/refill 지연·stream 주기·추가 GPU embedding 메모리를 포함. 현재 host 비용이 작아 우선순위 낮음 |
| D5 / P3 | 추가 모델 없는 exact multi-token verification | prompt/output n-gram lookup 초안 또는 same-model lookahead 후보를 본 모델이 causal 검증. greedy 일치하는 longest prefix만 채택하고 실패 branch KV 롤백 | 번역에서 복사/반복 hit rate가 낮을 수 있다. target verification·추가 attention/KV 비용을 포함한 accepted-tokens/ms로 판단. 단순히 다음 토큰 여러 개를 독립 계산하는 것은 잘못된 알고리즘 |
| D6 / P3, 별도 품질 결정 | W4/W6 코드 + activation INT8 내적 | 기존 모델 code를 integer-dot 배치로 해석하고 activation을 동적 양자화. 블록별 scale/min 보정 수행 | 원본 모델 파일은 유지해도 새로운 수치오차가 생긴다. 실제 packed integer dot의 하드웨어 가속 여부부터 검사. API 노출만으로 native 속도를 주장하지 않음 |
| D7 / P3, 별도 메모리·품질 결정 | 특정 비싼 행렬만 미리 복원 | Q6 head 등 선택 범위를 load 시 FP32 또는 FP16으로 복원해 비교. 전체 weight 전개는 기본안 아님 | FP32는 읽기량·메모리가 증가. FP16은 추가 반올림. 현재 head 약136.8MB가 FP16 약330.3MB로 증가하며, 다른 버퍼가 같으면 matrix resident 약486.4→680.0MB여서 기존 35% repack 예산도 넘는다. 예산을 몰래 올리지 않음 |
| D8 / P3, 별도 품질 결정 | FP16 activation/KV 또는 attention staging | matrix와 별도로 attention traffic·작업 버퍼가 실제 병목일 때만 제한 실험 | 새 반올림·장문 drift 발생. 단일 짧은 decode의 주병목을 해결한다고 가정하지 않음 |
| D9 / P2 capability 조사 | 일반 브라우저의 추가 가속 경로 | 지원 대상 브라우저/adapter에서 실제 노출된 matrix 기능·정수 내적 등을 조사. 현 custom 경로와 동일 파일을 사용하는 대안 엔진은 마지막 검증 후보 | 측정된 Chrome143 Apple 환경에는 shader-f16/subgroups는 있으나 subgroup-matrix는 없었다. 기존 ONNX matrix branch는 이미 존재하고 GGUF는 적용되지 않음. WebNN/NPU·새 브라우저에서의 연산 지원과 fallback 비용은 미검증이며 기본 성능 약속에 넣지 않음 |

정확성 보존 다중 토큰 방법의 외부 근거: [Lookahead Decoding, ICML 2024](https://proceedings.mlr.press/v235/fu24a.html). 논문의 다른 GPU/모델 속도 배수를 이 확장에 적용하지 않는다. [WebGPU packed integer dot](https://developer.chrome.com/blog/new-in-webgpu-123), [subgroup matrix/Metal 노출 차이](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroup-matrix.md#mslmetal).

### E. 로딩·메모리·예외 경로

- **E1 / P2:** full Blob→ArrayBuffer 파싱의 working set부터 계측한다. GPU upload 이후 불필요한 backing file 보유를 줄이고 CPU embedding·필수 metadata만 유지한다. range/staged loading은 단순 lifetime 개선 이후 평가한다. 작은 read를 너무 많이 쪼개 cold start가 더 느려지지 않게 한다.
- **E2 / P2:** lossless repack 결과의 OPFS 캐시는 반복 준비 비용이 실제 유의할 때만 검토한다. 원본 해시·layout version·endianness·무결성 검증으로 묶고 quota/저장 증가·invalid cache 폐기를 포함한다. GPU pipeline 객체를 일반 파일로 저장할 수 있다고 가정하지 않는다.
- **E3 / P2:** ONNX timeout fallback 이후 worker와 document pipeline의 중복 residency를 제어한다. 정상 경로가 이미 한 worker인 것을 새 최적화로 포장하지 않는다. 요청 취소만으로 공유 worker를 폐기하지 않는다.
- **E4 / 기본 원칙:** 사용자 모델 선택은 존중하면서, 속도 비교의 1차 기준선은 현재 request latency가 낮은 ONNX q4f16로 둔다. GGUF도 같은 페이지 검증을 수행한다. 두 모델을 요청마다 전환해 load 비용을 만들지 않는다.

근거: `hostworker.ts:177-217`, `onnxweights.ts:6-8`, `ggufweights.ts:80-132,252-253`, `onnxhost.ts:256-277,302-339,637-657`, `kernels.ts:580-617,1063-1072`.

## 4. 다시 하지 않을 것과 과장하지 않을 것

- GGUF single-row scalar reduction, 32 K lanes, Q6 factorization, Q6 output-group16, two-stage reduction은 이미 안정적인 양쪽 context 개선에 실패했다. `test-results/browser/gguf-single-decode-vtpS5R/decision.json` 참고.
- ONNX의 K split, scale packing/subgroup broadcast, static shape specialization, activation transpose, nibble bitcast 등도 기존 채택 기준을 넘지 못했다. `translation-performance.md:2404-2449` 참고.
- subgroup 적용을 무조건 다음 정답으로 보지 않는다. 앞선 대화의 추천보다 기존 거절 근거를 우선한다.
- worker 수 증가, 고정 batch8, mixed budget64, FP16 전체 전개, output cap 축소는 자동 해법이 아니다.
- `max_new_tokens` 상한을 줄여 출력이 잘렸는데 빨라졌다고 보고하지 않는다. EOS 전에 임의 종료하거나 vocabulary를 줄이는 방법도 제외한다.
- 현재 모델에서 초기의 고유한 장문 페이지 전체가 수십 ms에 완료될 것으로 약속하지 않는다. autoregressive 출력량·prefill·가중치 읽기는 여전히 필요하다. 캐시/선행 작업은 이 비용을 없애는 경우와 다른 시점에 지불하는 경우를 구분한다.

## 5. 실행 순서

1. **E2E 기준선 확정:** 두 고정 모델과 현재 build를 보존. 아래 latency trace와 finite-page coverage를 계측한다. 제품 코드 최적화 전에 실제 queue/계산/표시 비율과 GPU occupancy를 확보한다.
2. **중복·불필요 대기 제거:** A1/A3/A4/A6, B1의 coalescing, C1. A2는 cold/ready 상태를 분리해서 평가한다. 실제 빈도가 낮으면 우선순위를 내린다.
3. **페이지 처리량:** B2/B3/B4 및 B1의 1/2/4/8 정책. 이후 B5/B6/B7/B8을 각각 분리 비교. 핵심 목표는 visible latency를 지키며 finite page 전체를 끝내는 것.
4. **계산 가속:** D1로 가설을 좁힌 뒤 D2/D3. 각 모델별 microkernel 승자가 model/페이지에서 실패하면 기각한다. 기존 실패의 전체 parameter sweep을 다시 돌리지 않는다.
5. **고위험 연구:** D4/D5는 앞 단계로 목표가 부족할 때. D6/D7/D8은 별도 품질·메모리 tradeoff 결정 이후에만 실행한다. D9는 지원 capability가 실제 있을 때만 분기한다.
6. 각 독립 후보를 검증한 뒤 winner만 조합하고, 조합 자체도 재검증한다. CPU 최적화·GPU 최적화·cache 효과를 더해 가짜 총배수를 계산하지 않는다.

## 6. 측정 계약과 초기 목표

### 분리할 상태

- C0: 모델 미설치 → 다운로드/설치. 네트워크 조건과 별도 보고.
- C1: 파일만 로컬 저장, GPU 모델 미상주 → cold load부터 완료까지.
- W0: GPU 준비됐으나 첫 실행 전 → 첫 generation 비용 포함.
- W1: resident/warm 모델, 번역 결과 cache miss → 핵심 실제 생성 비교.
- H: 정확한 결과 cache hit 또는 viewport 진입 전 prefetch 완료 → 별도 재방문/선행 완료 지표.

브라우저 process를 새로 띄우고 profile만 재사용한 것은 resident warm이 아니다. GPU/CPU, 여러 요청의 겹치는 시간을 단순 합산하지 않는다.

### 모든 요청에 남길 구간

사용자 동작 또는 마지막 scroll event → 대상 발견 → count/token plan → admission queue → prefill/mixed/decode → 첫 provisional DOM paint → 첫 완료 unit paint → visible-at-rest 전체 완료 → finite-page 전체 완료.

`requestId/tabId/unitId/sourceVersion/modelHash/backend`로 연결하고 source/output tokens, 생성 횟수, retry, 캐시 여부, cancelled/wasted tokens, pending/failed/deferred/ignored source 수를 남긴다. DOM mutation 시간은 실제 paint 시간과 다르므로 rAF 관측과 화면 증거를 함께 확보한다. 성공한 요청만 모으지 않는다.

### 제품 목표 — 실측 성과나 보장 아님

| 조건 | 목표 |
| --- | --- |
| 정확한 cache hit | 실제 완료 번역 표시 p95 ≤100ms |
| W1, source ≤64-token의 짧은 unit | 첫 의미 있는 provisional 표시 p95 ≤300ms, 첫 unit 최종 완료 p95 ≤1s |
| W1, visible 짧은 unit 8개 동시 도착 | 전부 최종 완료 p95 ≤2s를 도전 목표로 설정; 미달 시 미달 그대로 보고 |
| 전체 finite page | 사용자 번역 시작부터 모든 eligible source의 최종 번역 표시까지 **≤5초**. W1과 C1을 별도 측정하며, 일부 표시·viewport 완료·원문 축소로 대체하지 않음 |
| scrolling/multi-tab | visible p95를 유지하며 background도 진전. 첫 글자 표시만으로 whole-visible 성공 처리 금지 |

위 목표는 특히 생성 출력 길이에 민감하다. fixture와 output 분포를 공개하고 긴 출력·실패를 제외해 맞추지 않는다. 화면의 일부만 빨리 보여주는 것과 전체 페이지 완료는 둘 다 측정하며 서로 대체하지 않는다.

### 워크로드

- 짧은 제목/문장, link/span이 섞인 문장, 긴 본문, 부정·수치·고유명사, CJK/영어/RTL 및 byte fallback.
- 1/2/4/8 도착 폭, source 32/64/128/512 token, 짧고 긴 unit 혼합, refill/drain.
- finite article snapshot, 댓글 burst, 접힌 내용 확장, virtualized 목록, 새 visible 도착, 동시 enabled tab.
- 출력은 정상 EOS 또는 기존 안전 정책까지. max-token 도달·누락은 성공으로 감추지 않는다.
- uncached 고유 원문, 정확히 반복된 원문, 문맥만 다른 동일 문자열을 각각 포함한다.

### 채택 기준

- 실제 installed extension, 보통의 headed browser, GPU 작업 직렬 A/B. 같은 workload·도착 trace·모델 파일·설정으로 순서를 교대한다.
- screening은 3 paired rounds, 채택 확인은 최소 5 paired rounds. p95를 주장할 조건은 최소 100 unit 관측을 여러 page/round에 분산하고 표본 수·range·실패율을 같이 공개한다. 상관된 요청을 독립 실험처럼 취급하지 않는다.
- 대상 primary latency 중앙값 ≥10% 감소, 최종 5쌍 중 4쌍 이상 개선을 우선 채택 기준으로 한다. visible p95 또는 whole-page 완료가 재현 가능하게 5% 넘게 나빠지면 조합의 기본값으로 채택하지 않는다. 작은 개선은 측정 변동을 넘는 근거가 있을 때만 별도 표기한다.
- exact-layout/계산 최적화는 기존 독립 수치 oracle·허용오차를 유지하고 같은 모델 기준 토큰/logit·출력 guard 검증을 통과한다. GGUF와 ONNX 서로의 토큰 일치는 요구하지 않는다.
- prompt/분할 변경은 출력 문자열 동일성 대신 번역 내용 누락·수치·부정·링크 대응·용어를 별도 평가한다. 자동 nonempty/script 검사는 의미 품질 증거가 아니다. activation/FP16 변경도 같은 원칙으로 별도 품질 gate를 둔다.
- 잘못된 언어 제외, stale DOM write, 원문 복원 실패, 취소 누수, WebGPU/page/device-loss 오류, source 누락이 있으면 성능 후보에서 탈락한다.
- JS backing buffer, GPU resident/peak, cold/warmup time, 전력/사용하지 않은 prefetch 작업을 기록한다. 현재 35% GGUF repack 예산은 동의 없이 확대하지 않는다.

### 기존 검증 도구 재사용

- `test/onnx-live/run-onnx.mjs`: real installed model과 DOM/stream/두 tab 측정을 확장.
- `test/sites-live/gguf-comparison.mjs`: GGUF 실제 import/model 선택 재사용. 반드시 `GGUF_QUANTS=Q4_K_M`. 기존 cohort timing은 DOM/page 완료가 아니므로 DOM observer를 결합.
- `test/engine-spike/run-kernels.mjs`, `check-gguf.mjs`: 고정 workload·full-vocabulary logits·독립 quantized reference. GPU pass splitting은 attribution에만 사용.
- mock 기반 browser/functional suite는 계약 검증용이며 속도 증거로 사용하지 않는다.

결론: 가장 먼저 노릴 것은 **고유 요청의 불필요 대기 제거 + 페이지 admission/완료 정책 + 중복 추론 제거**다. 동시에 실제 커널 병목을 더 좁혀 계산 자체의 개선을 검증한다. 어느 후보도 목표를 달성하지 못하면 모델/품질 조건을 몰래 바꾸지 않고 미달 원인과 수치를 보고한다.

## 7. 실행한 변경과 채택 경계

- **A1/A3/A4/A6:** translator 세션 내 정확히 같은 요청 배열의 in-flight 작업 공유,
  subscriber별 취소, tokenizer/worker 초기화 병행, bounded count/prompt/byte-expansion
  memo, prompt·budget·backend가 같은 결정적 재시도만 생략. 실패를 성공 처리하지 않는다.
- **B1/B2:** 1/2/4/8 선택과 기본 8개, 확장 전체의 실제 generation 상한,
  탭별 FIFO/탭 간 round-robin. 기존에 저장한 1/2개 선택은 보존한다.
  deadline-aware/adaptive policy나 foreground 우선 GPU 큐를 구현한 것은 아니다.
- **B4/C1:** production은 전체 문서의 eligible source를 계속 처리한다.
  독립 unit은 먼저 완료된 것부터 표시하고, 같은 unit 내부는 원문 순서를 유지한다.
  숨김·편집·보호·clipped source 및 실패는 완료로 위장하지 않는다.
- **B5:** production은 문자 수/문장 수 기반의 중복 분할을 제거하고 기존 호스트의
  정확한 64-source-token plan을 사용한다. 원문·출력 budget을 줄이지 않으며,
  source coverage와 의미 품질을 별도로 비교한다.

첫 whole-document 후보는 영어 기술 문장의 “느린 경험을 가릴 수 있다”를
“방지할 수 있다”로 바꿨다. 5초 안에 끝나더라도 거절했다.
기존 480-character partition을 보존한 대조군은 모든 기준선 출력이 같았지만
영어 페이지에서 직렬 continuation이 남았다. 최종 후보는 두 중복 분할 대신
호스트 token plan 하나를 사용한다. 초기 비교에서 변경된 것은 긴 영어 댓글뿐이며,
수치·재시작·첫 로드/후속 실행 구분·최종 질문의 누락은 관찰되지 않았다.
이는 전체 모델의 의미 정확성 보증이 아니다.

GPU 커널, 모델 weight, activation/KV 정밀도, 출력 상한은 변경하지 않았다.
따라서 “양자화 행렬의 78% 비용을 제거했다”는 결론이 아니다.
이미 존재하던 continuous batching에 페이지 작업을 충분히 공급하고,
직렬 대기·중복 준비·독립 결과의 표시 대기를 줄이는 변경이다.
조건부 GPU/정밀도/추측 디코딩 후보를 일괄 채택하지 않는다.

실험 원자료는 `test-results/browser/page5-S35gTt/`,
실행 방법과 검증 경계는 [testing.md](testing.md#whole-page-five-second-benchmark),
최종 수치는 [성능 기록](translation-performance.md)에 기록한다.

최종 warm 비교에서는 모든 페이지가 기준선보다 빨랐고 완료 중앙값이 45.7–61.6%
감소했다. 다만 긴 페이지의 5초 초과와 첫 preview 지연 증가를 그대로 남겼다.
모델 비상주 별도 측정은 unload/zero-resident 상태를 확인한 뒤 시작하며 설치·다운로드는
제외한다. 이 측정이 더 빨랐다는 이유로 앞선 warm 미달을 삭제하지 않는다.
**임의 크기 페이지·모든 하드웨어의 5초 완료를 약속하지 않는다.**
