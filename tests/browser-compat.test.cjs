const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const code=fs.readFileSync(__dirname+'/../src/compat.js','utf8').replace(/import\('\.\/main\.js\?v=\d+'\)\.catch\(fatal\);/,'');
function env(search='',stored,blocked=false) {
 const key='splatFighter.renderer.v9:/splat-fighter/';
 const elements=new Map(),handlers={},storage=new Map(stored?[[key,stored]]:[]),appEvents={};
 let replaced,now=10000,bright=true,copyError=false;
 const el=()=>({classList:{remove(){}},appendChild(){},addEventListener(){},textContent:''});
 elements.set('loading',el());elements.set('loadText',el());
 const store={getItem(k){if(blocked)throw Error();return storage.get(k)},setItem(k,v){if(blocked)throw Error();storage.set(k,v)}};
 const ctx={URL,URLSearchParams,Error,Date:{now:()=>now},console:{error(){},warn(){}},setInterval(){return 1},clearInterval(){},
 HTMLScriptElement:{supports:()=>true},location:{search,pathname:'/splat-fighter/',origin:'https://example.com',protocol:'https:',href:'https://example.com/splat-fighter/'+search,replace(v){replaced=v},reload(){}},
 sessionStorage:store,localStorage:store,
 document:{hidden:false,documentElement:{dataset:{}},getElementById:id=>elements.get(id),createElement(type){
  if(type!=='canvas')return el();
  return {getContext:()=>({clearRect(){},drawImage(){if(copyError)throw Error('SecurityError')},getImageData(){const data=new Uint8ClampedArray(24*24*4);if(bright)data.fill(128);return{data}}})};
 },querySelectorAll:()=>[],addEventListener(){}},addEventListener(e,fn){handlers[e]=fn}};
 ctx.window=ctx;vm.runInNewContext(code,ctx);
 const scene={graphicsDevice:{isWebGPU:true,canvas:{width:800,height:600},on(){},wgpu:{addEventListener(){}}},app:{on(e,fn){appEvents[e]=fn},off(e){delete appEvents[e]}}};
 return {api:ctx.splatCompatibility,ctx,elements,handlers,scene,
 get replaced(){return replaced},get saved(){return storage.get(key)},get sampling(){return !!appEvents.frameend},
 frames(count){for(let i=0;i<count;i++){now+=400;appEvents.frameend?.()}},
 setBright(v){bright=v},setCopyError(){copyError=true}};
}
let x=env();assert.equal(x.api.mode,'raster');x.api.recover(Error('GPU validation'));assert.equal(x.saved,'webgl');assert.equal(new URL(x.replaced).searchParams.has('renderer'),false);
x=env('',undefined,true);x.api.recover(Error('GPU validation'));assert.equal(new URL(x.replaced).searchParams.get('renderer'),'webgl');
x=env('?renderer=webgl');x.api.recover(Error('GPU unavailable'));assert.equal(x.replaced,undefined);assert(x.elements.get('loadText').textContent.includes('图形渲染失败'));
x=env('','webgl');assert.equal(x.api.mode,'webgl');
x=env('?renderer=auto','webgl');assert.equal(x.api.mode,'raster');
x=env('?webgl');assert.equal(x.api.mode,'webgl');
x=env();x.api.bootFailed(Error('Failed to fetch'),'./assets/a.glb');assert.equal(x.replaced,undefined);
x=env();assert.throws(()=>x.api.watch({graphicsDevice:{isWebGPU:false,isWebGL2:false}}),/WebGPU/);
x=env();x.handlers.error({filename:'chrome-extension://abc/script.js',message:'GPU error'});assert.equal(x.replaced,undefined);
// A real visible frame verifies the selected backend, then removes the hook.
x=env();x.api.watch(x.scene);x.api.ready();x.frames(6);assert.equal(x.ctx.document.documentElement.dataset.graphicsStatus,'verified');assert.equal(x.sampling,false);assert.equal(x.saved,'raster');
// Three genuinely black samples trigger recovery without a user click.
x=env();x.setBright(false);x.api.watch(x.scene);x.api.ready();x.frames(8);assert.equal(x.saved,'webgl');assert(x.replaced);assert.equal(x.sampling,false);
// Hidden tabs and copy restrictions must never trigger a false recovery.
x=env();x.setBright(false);x.ctx.document.hidden=true;x.api.watch(x.scene);x.api.ready();x.frames(20);assert.equal(x.replaced,undefined);
x.ctx.document.hidden=false;x.setBright(true);x.frames(6);assert.equal(x.saved,'raster');
x=env();x.setCopyError();x.api.watch(x.scene);x.api.ready();x.frames(6);assert.equal(x.replaced,undefined);assert.equal(x.sampling,false);
// WebGL2 actually selected by the engine is remembered as WebGL2.
x=env();x.scene.graphicsDevice.isWebGPU=false;x.scene.graphicsDevice.isWebGL2=true;x.api.watch(x.scene);x.api.ready();x.frames(6);assert.equal(x.saved,'webgl');

// All ResizeObserver shapes must size the drawing buffer at the same pixel density.
const engine=fs.readFileSync(__dirname+'/../vendor/splat-engine/package/dist/index.js','utf8');
const start=engine.indexOf('          const cap = device.maxPixelRatio;');
const end=engine.indexOf('if (w > 0 && h > 0) pendingSize = { w, h };',start)+'if (w > 0 && h > 0) pendingSize = { w, h };'.length;
const resize=new Function('entry','device','window','let pendingSize;'+engine.slice(start,end)+'return pendingSize;');
for(const entry of [
  {devicePixelContentBoxSize:[{inlineSize:800,blockSize:400}]},
  {contentBoxSize:[{inlineSize:400,blockSize:200}]},
  {contentBoxSize:{inlineSize:400,blockSize:200}},
  {contentRect:{width:400,height:200}}
]) assert.deepEqual(resize(entry,{maxPixelRatio:1.5},{devicePixelRatio:2}),{w:600,h:300});

console.log('PASS: automatic selection, stored recovery, real-frame verification, black-frame fallback, hidden tabs, copy restrictions, asset errors and browser resize formats.');
