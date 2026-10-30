// Offline stand-in for the sample page. This is NOT a translation model: it is
// a phrase/word dictionary so the DOM engine can be exercised
// without a network. The real build sends the same `texts` array to
// AT.engines instead.
namespace AT.demo {
  const OPEN = '\uE000';
  const CLOSE = '\uE001';
  const MARKER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

  const PHRASES: Record<string, string | undefined> = {
    'autotranslate keeps the page, replaces the words': 'Autotranslate는 페이지는 그대로, 단어만 바꿉니다',
    'autotranslate style-safe engine sample': 'Autotranslate 스타일 보존 엔진 샘플',
    'today only:': '오늘 하루 한정:',
    'free shipping': '무료 배송',
    'on every order,': '모든 주문 대상,',
    'returns within 30 days': '30일 이내 반품',
    and: '그리고',
    'two-year warranty': '2년 보증',
    'open daily 9–18.': '매일 9–18시 운영.',
    'ask the': '자세한 내용은',
    team: '팀',
    'for details.': '에 문의하세요.',
    'batched requests per screen': '화면 단위 묶음 요청',
    'original text stays in memory': '원문은 메모리에 보관',
    'editable fields are never touched': '편집 영역은 건드리지 않음',
    run: '실행:',
    'to serve this page, then press': '로 이 페이지를 서빙한 뒤',
    'to reload.': '로 새로고침.',
    'plan comparison': '요금제 비교',
    plan: '요금제',
    price: '가격',
    support: '지원',
    free: '무료',
    '0 usd': '0원',
    '12 usd': '12달러',
    community: '커뮤니티',
    'next business day': '익영업일 응답',
    'autotranslate gmbh': 'Autotranslate GmbH',
    'hauptstraße 1': 'Hauptstraße 1',
    '10115 berlin': '10115 베를린',
    'must stay in english, and so must the editable draft below.':
      '은 영어로 남아야 하며, 아래 편집 초안도 마찬가지입니다.',
    'editable draft below.': '편집 초안도 마찬가지입니다.',
    'add to cart': '장바구니에 담기',
    'search products': '제품 검색'
  };

  const WORDS: Record<string, string | undefined> = {
    and: '그리고',
    the: '',
    for: '위한',
    with: '포함',
    per: '당',
    text: '문구',
    page: '페이지',
    words: '단어',
    keeps: '유지',
    replaces: '교체',
    engine: '엔진',
    sample: '샘플',
    'style-safe': '스타일 보존',
    daily: '매일',
    press: '키'
  };

  const normalise = (value: unknown): string => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const unknown = new Set<string>();

  function lookup(piece: string): string {
    const key = normalise(piece);
    if (!key) return piece;
    const phrase = PHRASES[key];
    if (phrase) return phrase;
    const translated = piece.split(/(\s+)/).map((token) => {
      const bare = normalise(token.replace(/[.,;:!?)("’'”]/g, ''));
      if (!bare) return token;
      const word = WORDS[bare];
      if (word) return word;
      unknown.add(key);
      return token;
    });
    const joined = translated.join('');
    return joined.trim() ? joined : piece;
  }

  export type TranslateOptions = {
    /** Drop the run markers, so the engine has to fall back to per-piece requests. */
    lossy?: boolean;
    latencyMs?: number;
  };

  export function translate(texts: readonly string[], options: TranslateOptions = {}): Promise<string[]> {
    const { lossy = false, latencyMs = 120 } = options;
    const { promise, resolve } = Promise.withResolvers<string[]>();
    setTimeout(() => {
      resolve(
        texts.map((text) => {
          let out = '';
          let cursor = 0;
          let match: RegExpExecArray | null;
          MARKER.lastIndex = 0;
          while ((match = MARKER.exec(text)) !== null) {
            out += lookup(text.slice(cursor, match.index));
            if (!lossy) out += match[0];
            cursor = MARKER.lastIndex;
          }
          out += lookup(text.slice(cursor));
          return out;
        })
      );
    }, latencyMs);
    return promise;
  }

  export function unknownCount(): number {
    return unknown.size;
  }

  export function reset(): void {
    unknown.clear();
  }
}
