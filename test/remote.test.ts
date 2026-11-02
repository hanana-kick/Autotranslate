import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { load, type ATNamespace } from './helpers.ts';

const host = globalThis as ATNamespace;
host.chrome = { runtime: { sendMessage: async () => undefined, onMessage: {addListener(){}}, getURL: (x:string)=>x },
  i18n: {detectLanguage: async()=>null} };
const AT = load('lib/constants.js','lib/browser.js','lib/gemma.js','lib/pagecontext.js',
  'lib/targets.js','lib/rules.js','lib/local.js','lib/settings.js','lib/remote.js','lib/engines.js');
const R = AT.remote;

const calls: {path:string;authorization:string;body:ATNamespace}[]=[];
let active=0, maxActive=0;
let serveError=0, delay=30;
let vllmInfo: 'ok' | 'denied' = 'ok';
let server:Server;
let base:string;

test.before(async()=>{
  server=createServer(async(req,res)=>{
    const parts:Buffer[]=[];
    for await(const part of req) parts.push(Buffer.isBuffer(part)?part:Buffer.from(part));
    const body = parts.length?JSON.parse(Buffer.concat(parts).toString('utf8')):{};
    const authorization=String(req.headers.authorization||'');
    calls.push({path:req.url??'',authorization,body});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/server_info?config_format=json'){
      if(vllmInfo === 'denied'){res.writeHead(403);res.end('{}');return;}
      res.end(JSON.stringify({vllm_config:{scheduler_config:{max_num_seqs:8,max_num_active_seqs:4}},system_env:{SECRET:'never-store-me'}}));return;
    }
    if(req.url==='/v1/models'){
      res.end(JSON.stringify({object:'list',data:[{id:'translategemma',max_model_len:2048,max_num_seqs:24}]}));return;
    }
    if(req.url!=='/v1/chat/completions') {res.writeHead(404);res.end('{}');return;}
    if(serveError){res.writeHead(serveError);res.end('{"error":"do not echo any secrets"}');return;}
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(r=>setTimeout(r,delay));
    active--;
    const content=body.messages?.[0]?.content;
    const text=typeof content==='string' ? content.split('<<<text>>>').at(-1) : content?.[0]?.text;
    res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'KO:'+text}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('port');
  base='http://127.0.0.1:'+address.port+'/v1';
});
after(()=>server?.close());
const cfg=(patch:ATNamespace={})=>({baseUrl:base,model:'translategemma',style:'delimiters',concurrency:2,maxOutputTokens:512,...patch});

test('custom reverse proxy path and URL sanitization',()=>{
  for(const [source,expected] of [
    ['https://example.org','https://example.org/v1'],
    ['http://127.0.0.1:8000/v1/','http://127.0.0.1:8000/v1'],
    ['https://example.org/proxy/translate/v1/models','https://example.org/proxy/translate/v1'],
    ['https://example.org/prefix/v1/chat/completions','https://example.org/prefix/v1']
  ])assert.equal(R.normalizeBaseUrl(source),expected);
  for(const source of ['ftp://example.org','https://secret:key@example.org/v1',
    'https://example.org/v1?token=secret', 'data:text/plain,x','file:///etc/passwd']){
    assert.equal(R.normalizeBaseUrl(source),'','unsafe URL must not be accepted: '+source);
  }
});

test('discover OpenAI models and vLLM-only scheduler capacity when server_info is available',async()=>{
  calls.length=0;
  const discovered=await R.discover(base,'token');
  assert.deepEqual(discovered.models,[{id:'translategemma',maxModelLen:2048}]);
  assert.equal(discovered.maxNumSeqs,8);
  assert.equal(discovered.maxNumActiveSeqs,4);
  assert.equal(calls.at(-1)?.path,'/server_info?config_format=json');
  assert.equal(calls.at(-1)?.authorization,'Bearer token');
  assert.ok(!JSON.stringify(discovered).includes('never-store-me'));
});

test('non-vLLM server_info failure is nonfatal and max_num_seqs stays unknown',async()=>{
  vllmInfo='denied';
  try {const result=await R.discover(base,'token');
    assert.equal(result.models[0].id,'translategemma');
    assert.equal(result.maxNumSeqs,null);
    assert.equal(result.maxNumActiveSeqs,null);
  } finally {vllmInfo='ok';}
});

test('official TranslateGemma, optimized delimiter and generic chat prompts are distinct',async()=>{
  const src=R.prompt('Hello','en','ko','official');
  assert.deepEqual(src,[{role:'user',content:[{type:'text',source_lang_code:'en',target_lang_code:'ko',text:'Hello'}]}]);
  assert.deepEqual(R.prompt('Hello','en','ko','delimiters'),[{role:'user',content:'<<<source>>>en<<<target>>>ko<<<text>>>Hello'}]);
  assert.match(R.prompt('Hello','en','ko','instruction')[0].content,/Respond only with the translation/);
  assert.throws(()=>R.prompt('Hello',null,'ko','official'),/requires a source language/);
});

test('pool preserves order, limits in-flight HTTP requests, and sends no local host command',async()=>{
  calls.length=0;active=0;maxActive=0;
  const result=await AT.engines.translate({engineMode:'remote',remoteConfig:cfg(),remoteKey:'secret',
    localModelId:'',localMaxTokens:128,target:'ko',source:'en',
    texts:['One','Two','One','Three','Four','Five']});
  assert.deepEqual(result.translations,['KO:One','KO:Two','KO:One','KO:Three','KO:Four','KO:Five']);
  assert.equal(result.requested,5);
  assert.equal(maxActive,2);
  assert.equal(calls.filter(x=>x.path.endsWith('chat/completions')).length,5);
  assert.ok(calls.every(x=>x.authorization==='Bearer secret'));
  assert.ok(calls.every(x=>x.body.temperature===0&&x.body.stream===false&&x.body.max_tokens===512));
});

test('remote failure does not invoke or fall back to on-device inference',async()=>{
  serveError=429;
  try{await assert.rejects(AT.engines.translate({engineMode:'remote',remoteConfig:cfg(),remoteKey:'secret',
    localModelId:'local-that-must-not-load',target:'ko',source:'en',texts:['Text']}),
    (error:ATNamespace)=>error.code==='rate-limit'&&!String(error.message).includes('secret'));
  } finally {serveError=0;}
});

test('remote API key is saved separately and never returned in page settings snapshots',async()=>{
  const stored:ATNamespace={};
  AT.storage={local:{get:async(k:string)=>({[k]:stored[k]}),set:async(v:ATNamespace)=>Object.assign(stored,v)}};
  await R.setKey('  very-private-token  ');
  assert.equal(await R.getKey(),'very-private-token');
  const config=AT.settings.normalize({engineMode:'remote',remoteBaseUrl:base,remoteModel:'translategemma',
    remoteConcurrency:128,remoteMaxTokens:100000});
  assert.equal(config.remoteConcurrency,32);
  assert.equal(config.remoteMaxTokens,4096);
  const snapshot=AT.settings.contentSnapshot(config);
  assert.equal('remoteKey' in snapshot,false);
  assert.equal(JSON.stringify(snapshot).includes('very-private-token'),false);
  assert.equal(JSON.stringify(config).includes('very-private-token'),false);
});
