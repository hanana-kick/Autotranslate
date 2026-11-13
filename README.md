# Autotranslate

브라우저 탭을 선택해 페이지 안에서 번역하고 원문을 복원하는 Manifest V3 TypeScript 확장. 번역 엔진은 **온디바이스 PLaMo 3** 또는 **OpenAI 호환 서버** 중 선택.

## 사용법

### 설치
```sh
npm install
npm run build   # build/chrome, build/firefox, dist/*.zip 생성
```
Chrome: `chrome://extensions` → 개발자 모드 → 압축해제된 확장 프로그램 로드 → `build/chrome`
Firefox: `about:debugging` → 임시 추가 기능 로드 → `build/firefox/manifest.json`

Node 24+, WebGPU with `shader-f16` 필요. Chrome 121+, Firefox 121+ 지원.

### 첫 실행
설치 후 온보딩이 열림.

1. 번역 대상 언어 선택: en / ko / ja
2. 모델 설치: 다운로드 또는 로컬 파일 선택 → OPFS에 저장
3. Start translating 클릭

모델은 최초 1회만 다운로드. 기본은 `TeamFlaxia/plamo-3-translate-0.8b-onnx` q4f16, 약 705 MB. 토크나이저와 config 함께 저장.

### 번역 켜기/끄기
팝업의 스위치로 탭 단위 제어.
- ON: 해당 탭만 번역, 새 DOM도 추적
- OFF: 원문 복원, 대기 요청 취소

Options에서 엔진 선택.
- **OpenAI 호환 서버**: Base URL, API key, Model ID 입력 후 Save. `POST /chat/completions` 지원 필요. 테스트는 Test provider 버튼.
- **온디바이스**: 모델이 로컬에 있으면 네트워크 없이 동작.

사이트 규칙은 Options 또는 컨텍스트 메뉴에서 `never/always` 설정 가능. 탭을 닫으면 선택이 사라지고, 세션 저장으로 서비스 워커 정지 시 유지.

## 기술 요약

### 모델
- 기본: PFN PLaMo 3 Translate 0.8B ONNX q4f16, Transformers.js + onnxruntime-web, WebGPU 실행
- 무압축 fp16 버전도 지원
- 언어: 카드 기준 53개. UI 제공은 en / ko / ja
- 프롬프트는 모델의 `chat_template.jinja`를 사용. `dataset → context → input → output` 순서. 페이지 정보는 한 줄 컨텍스트로만 전달.

온디바이스 모드에서는 페이지 텍스트가 브라우저를 벗어나지 않음. 서버 모드에서는 선택 탭 텍스트와 제한된 컨텍스트만 전송.

### 번역 대상 결정
- 탭 단위 명시적 제어. 콘텐츠 스크립트는 `at/content-translate` 메시지로 주입 후 실행.
- DOM 수집: 텍스트 노드 워커 → run 병합. `<code>`, `pre`, contenteditable 등은 무시.
- 페이지 컨텍스트 수집: Open Graph, JSON-LD, microdata, 랜드마크, lang 속성 → 종류, 사이트, 섹션, 엔티티 추출.
- 영역 및 가시성 분류:
  comment > navigation > form > footer > aside > heading > article > list > metadata
  가시성: visible → near → far
- 계획은 읽는 순서 기반. 렌더된 위치로 정렬, 스크롤/리사이즈 시 재정렬. MutationObserver로 동적 삽입 추적.

### 최적화
- **읽는 순서 우선**: 보이는 콘텐츠 먼저, 그 다음 스크린 연속 부분. DOM 순회 아님.
- **진행형 결과**: 첫 문단 단독 전송, 이후 짧은 이웃 4개 묶음, 480자 제한. 긴 문단은 문장 단위 스트리밍.
- **메모리 안전 쓰기**: `Text.nodeValue`만 변경. 원본은 Map에 보관, 정확 복원 가능.
- **배치 디코딩**: `hostworker.js`에서 1개 WebGPU 세션, `C.ENGINE_BATCH` 시퀀스 동시 디코딩. 토큰 카운트로 패킹, `localMaxTokens` 128~8192.
- **커널**: WGSL 기반 q4 GEMV, RMSNorm, RoPE, Attention, SwiGLU. 참조 ONNX 대비 ~13.6ms/토큰.
- **프롬프트 비용 절감**: 컨텍스트 최대 240자, 페이지 라인 + 영역 라인은 선택적. 글러스는 일관성용 수집만.
- **문장 분할**: `Intl.Segmenter` 기반, 분리 후 번호 매긴 프롬프트로 전송, 답변을 노드 비중으로 분배.
- **공유 세션**: 탭 간 요청은 동일 세션 공유, 중복 로드 없음. 모델 로드 후 10분 유휴 시 해제.

번역은 실패 시 원문 유지, 진행 표시기 없이 실패 처리. Reduced motion/forced colors 시 애니메이션 비활성화.

개인정보: 온디바이스 모드는 네트워크 사용 없음. 서버 모드는 API 키가 확장 로컬 저장소에 보관, 쿠키/Referrer 미전송, 리다이렉트 거부.
