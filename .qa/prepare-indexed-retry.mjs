import fs from 'node:fs';
const edit=(p,f)=>{let s=fs.readFileSync(p,'utf8');const r=(a,b)=>{if(s.split(a).length!==2)throw Error('nonunique anchor '+p+': '+a.slice(0,60));s=s.replace(a,b);};f(r);fs.writeFileSync(p,s);};
edit('src/lib/localhost.ts',r=>r('    if (parsed) return parsed;',`    if (parsed) {
      // A numbered response can preserve the shape while echoing an English
      // fragment unchanged. Re-ask only that fragment once, using the existing
      // single-input prompt. Names may legitimately stay unchanged, so this is
      // bounded validation, not a forced target-script rule or recursive retry.
      if (source !== target) {
        const normalized = (value: string) => value.replace(/\\s+/gu, ' ').trim();
        for (let i = 0; i < texts.length; i++) {
          const text = texts[i]!;
          if (!/\\p{L}/u.test(text) || normalized(parsed[i]!) !== normalized(text)) continue;
          AT.log('on-device unchanged batch segment, retrying individually', i);
          const single = await translateChunk(source, target, [text], null);
          parsed[i] = single[0] ?? '';
        }
      }
      return parsed;
    }`));
edit('test/localhost.test.ts',r=>{
 r('streamCorrupt?: boolean } = {})','streamCorrupt?: boolean; responses?: readonly string[] } = {})');
 r("          return options.empty ? '' : '검증된 응답';", "          if (options.responses) return options.responses[this.prompts.length - 2] ?? '검증된 응답';\n          return options.empty ? '' : '검증된 응답';");
});
fs.appendFileSync('test/localhost.test.ts', `

test('host: retry only an unchanged numbered segment without repeating valid peers', async () => {
  const { request, instances, AT } = host({ responses: ['1: 읽으세요\\n2: the installation guide\\n3: 계속하기 전에.', '설치 지침'] });
  const response = await request({ texts: ['Read', 'the installation guide', 'before continuing.'] });
  assert.deepEqual(response.translations, ['읽으세요', '설치 지침', '계속하기 전에.']);
  assert.equal(instances[0]!.prompts.length, 3, 'warmup + numbered batch + one missing fragment');
  assert.equal(instances[0]!.prompts.at(-1), AT.local.buildBatchPrompt('en', 'ko', ['the installation guide'], null));
});

test('host: accepted numbered translations use one generation', async () => {
  const { request, instances } = host({ responses: ['1: 읽으세요\\n2: 설치 지침'] });
  assert.deepEqual((await request({ texts: ['Read', 'the installation guide'] })).translations, ['읽으세요', '설치 지침']);
  assert.equal(instances[0]!.prompts.length, 2);
});

test('host: unchanged names get at most one fallback and numerals get none', async () => {
  const { request, instances } = host({ responses: ['1: OpenAI\\n2: 123', 'OpenAI'] });
  assert.deepEqual((await request({ texts: ['OpenAI', '123'] })).translations, ['OpenAI', '123']);
  assert.equal(instances[0]!.prompts.length, 3, 'no repeated fallback for a legitimate unchanged name');
});

test('host: single and same-language answers never enter unchanged-batch retry', async () => {
  const first = host({ responses: ['OpenAI'] });
  assert.deepEqual((await first.request({ texts: ['OpenAI'] })).translations, ['OpenAI']);
  assert.equal(first.instances[0]!.prompts.length, 2);
  first.AT.localhost.unload('next fixture');
  const second = host({ responses: ['1: OpenAI\\n2: Hello'] });
  assert.deepEqual((await second.request({ source: 'en', target: 'en', texts: ['OpenAI', 'Hello'] })).translations, ['OpenAI', 'Hello']);
  assert.equal(second.instances[0]!.prompts.length, 2);
});

test('host: unchanged-segment fallback still rejects corrupted native output', async () => {
  const { request, instances } = host({ responses: ['1: 읽으세요\\n2: the guide', '<pad>'] });
  await assert.rejects(() => request({ texts: ['Read', 'the guide'] }), /control-token/);
  assert.equal(instances[0]!.prompts.length, 3);
});
`);
