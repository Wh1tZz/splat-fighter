const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=process.argv[2] || path.join(__dirname,'..');
const source=(name)=>fs.readFileSync(path.join(root,fs.existsSync(path.join(root,'src',name))?'src/'+name:name),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
(async()=>{
 const {MatchLoader}=await import('data:text/javascript;base64,'+Buffer.from(source('match-loader.js')).toString('base64'));
 const disposed=[],loader=new MatchLoader(v=>disposed.push(v));
 const a=deferred();let b=0,c=0;
 loader.prepare('a',()=>a.promise);
 loader.prepare('b',async()=>{b++;return'b'});
 loader.prepare('c',async()=>{c++;return'c'});
 a.resolve('a');await loader.running;
 assert.equal(b,0);assert.equal(c,1);assert.deepEqual(disposed,['a']);
 assert.equal(await loader.take('c',()=>{throw Error('must reuse ready pair')}),'c');
 assert.equal(loader.ready,null);assert.equal(loader.wanted,null);
 loader.prepare('d',async()=>'d');await loader.running;
 loader.prepare('e',async()=>'e');await loader.running;assert(disposed.includes('d'));
 const broken=new MatchLoader(()=>{});broken.prepare('x',async()=>{throw Error('network')});await broken.running;
 assert.equal(await broken.take('x',async()=>'retry'), 'retry');
 // Exercise the actual fighter loading methods against the engine API boundary.
 const src=source('fighter.js');
 const load=src.slice(src.indexOf('  async load('),src.indexOf('  // ---- procedural flinch'));
 const quality=src.slice(src.indexOf('  setQuality(q)'),src.indexOf('\n  get splatCount()'));
 const destroy=src.slice(src.indexOf('  destroy() {'),src.indexOf('  setQuality(q)'));
 let calls=[],failGhost=false;
 const makeChar=()=>({splats:[{}],level:0,active:true,destroyed:false,
  disableRenderLod(){},prepareReveal(){},setReveal(){},setActive(v){this.active=v},
  setRenderLevel(v){this.level=v},async addLodLevel(){await Promise.resolve();this.splats.push({})},destroy(){this.destroyed=true}});
 const context=vm.createContext({console,Character:{async load(scene,urls,opts){calls.push(urls);if(failGhost&&opts.name.endsWith('ghost1'))throw Error('ghost download');return makeChar()}},GHOSTS:3});
 const methods=vm.runInContext('({'+[load,quality,destroy].map(s=>s.trim()).join(',')+'})',context);
 function actor(q){return Object.assign({game:{quality:q,input:{touch:true},toast(){}},def:{id:'test',high:'high.vsplat',perf:'perf.vsplat'},slot:0,ghosts:[],installFlinch(){},play(){},applyTransform(){}},methods)}
 let f=actor('low');await f.load({}, {inactive:true});assert.equal(calls.length,3);assert(calls.every(x=>x==='perf.vsplat'));assert.equal(f.character.active,false);assert(f.ghosts.every(g=>!g.active));
 let upgrade=f.setQuality('high');f.setQuality('low');await upgrade;assert.equal(f.character.level,0);f.setQuality('high');assert.equal(f.character.level,1);f.setQuality('perf');assert.equal(f.character.level,0);
 calls=[];f=actor('high');await f.load({});assert.deepEqual(Array.from(calls[0]),['high.vsplat','perf.vsplat']);assert.equal(f.ghosts.length,3);assert.equal(f.character.level,0);f.setQuality('perf');assert.equal(f.character.level,1);
 calls=[];failGhost=true;f=actor('low');await assert.rejects(f.load({}),/ghost download/);const successful=f.ghosts.slice();f.destroy();assert(f.character.destroyed);assert(successful.every(g=>g.destroyed));
 // A slow phone must keep menu characters visible until the ready pair exists.
 const main=source('main.js'),begin=main.indexOf('  async startMatch() {');
 const startMethod=main.slice(begin,main.indexOf('\n  startRound() {',begin)).trim();
 const nodes=new Map();
 const node=(id)=>{if(!nodes.has(id))nodes.set(id,{textContent:'开始战斗',disabled:false,inert:false,style:{},classList:{hidden:false,add(c){if(c==='hidden')this.hidden=true},remove(c){if(c==='hidden')this.hidden=false}}});return nodes.get(id)};
 const startErrors=[];
 const startContext=vm.createContext({console:{error(...args){startErrors.push(args)}},clearTimeout(){},$:node,AI:class{}});
 const startMatch=vm.runInContext('({'+startMethod+'})',startContext).startMatch;
 function gameFor(promise){let takes=0;return{phase:'menu',clearMatch(){this.fighters=[]},toast(){},previews:[{active:true,setActive(v){this.active=v}}],camera:{},matchRequest:()=>({key:'pair',create(){}}),matchLoader:{take(){takes++;return promise}},get takes(){return takes},startRound(){this.phase='intro'},enterMenu(){this.phase='menu'},startMatch};}
 const pending=deferred(),game=gameFor(pending.promise);
 const transition=game.startMatch();await game.startMatch();assert.equal(game.takes,1);assert.equal(node('menu').classList.hidden,false);assert.equal(game.previews[0].active,true);assert.equal(node('start').disabled,true);
 const pair=[0,1].map(()=>({def:{name:'test',color:'#fff',portrait:'test.png'},character:{active:false,setActive(v){this.active=v}}}));
 pending.resolve(pair);await transition;assert.equal(game.phase,'intro');assert.equal(startErrors.length,0);assert.equal(node('menu').classList.hidden,true);assert.equal(game.previews[0].active,false);assert(pair.every(f=>f.character.active));assert.equal(node('start').disabled,false);assert.equal(node('menu').inert,false);
 const failedGame=gameFor(Promise.reject(Error('offline')));await failedGame.startMatch();assert.equal(failedGame.phase,'menu');assert.equal(node('start').disabled,false);assert.equal(node('menu').inert,false);
 console.log('PASS: bounded/coalesced menu preparation, ready-pair reuse, replacement disposal, retry, mobile perf-only loading, lazy high quality, hidden ghosts and failed-load cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1});
