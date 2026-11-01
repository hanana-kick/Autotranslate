import fs from 'node:fs';
const file='test/native-extension/real-extension.mjs';let s=fs.readFileSync(file,'utf8');
const render="      const render = await bound(page.evaluate((selectors) => Object.fromEntries(selectors.map((s) => [s, document.querySelector(s).textContent])), selectors), 10000, 'rendered HTML');";
const state="      const state = await bound(options.evaluate((tabId) => AT.sendMessage({ type: 'at/get-state', tabId }), tabId), 10000, 'tab state');";
const old=render+'\n'+state;
if(s.split(old).length!==2)throw Error('nonunique snapshot ordering anchor');
s=s.replace(old,`      // Read the completion acknowledgement BEFORE its DOM snapshot. The old\n      // order could pair pre-translation text with a just-completed state and\n      // fail although the actual page was already translated (release QA).\n${state}\n${render}`);
fs.writeFileSync(file,s);
