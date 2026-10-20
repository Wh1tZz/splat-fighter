const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const code=fs.readFileSync(__dirname+'/../src/compat.js','utf8').replace("import('./main.js?v=8').catch(fatal);",'');
function env(search='', stored, blocked=false) {
  const elements=new Map(), handlers={}, storage=new Map(stored?[['splatFighter.renderer.v8:/splat-fighter/',stored]]:[]);
  const buttonEvents={}; let replaced, interval;
  const el=()=>({classList:{remove(){}},appendChild(){},addEventListener(){},textContent:''});
  elements.set('loading',el());elements.set('loadText',el());
  const ctx={URL,URLSearchParams,Date,Error,console:{error(){},warn(){}},setInterval(fn){interval=fn;return 1},clearInterval(){},
    HTMLScriptElement:{supports:()=>true},location:{search,pathname:'/splat-fighter/',origin:'https://example.com',protocol:'https:',href:'https://example.com/splat-fighter/'+search,replace(v){replaced=v},reload(){}},
    sessionStorage:{getItem(k){if(blocked)throw Error();return storage.get(k)},setItem(k,v){if(blocked)throw Error();storage.set(k,v)}},
    document:{hidden:false,getElementById:id=>elements.get(id),createElement:el,querySelectorAll:()=>[{dataset:{renderer:'compat'},addEventListener(e,fn){buttonEvents[e]=fn}}],addEventListener(){}},
    addEventListener(e,fn){handlers[e]=fn}};
  ctx.window=ctx;vm.runInNewContext(code,ctx);
  return {api:ctx.splatCompatibility,ctx,elements,handlers,buttonEvents,get replaced(){return replaced}};
}
let x=env();assert.equal(x.api.mode,'auto');x.api.recover(Error('GPU validation'));assert.equal(new URL(x.replaced).searchParams.get('renderer'),'raster');
x=env('?renderer=raster');x.api.recover(Error('GPU validation'));assert.equal(new URL(x.replaced).searchParams.get('renderer'),'webgl');
x=env('?renderer=webgl');x.api.recover(Error('GPU unavailable'));assert.equal(x.replaced,undefined);assert(x.elements.get('loadText').textContent.includes('图形渲染失败'));
x=env('',undefined,true);x.buttonEvents.click();assert.equal(new URL(x.replaced).searchParams.get('renderer'),'raster');
x=env('?renderer=raster');x.buttonEvents.click();assert.equal(new URL(x.replaced).searchParams.get('renderer'),'webgl');
x=env('?renderer=auto','webgl');assert.equal(x.api.mode,'auto');
x=env('?webgl');assert.equal(x.api.mode,'webgl');
x=env();x.api.bootFailed(Error('Failed to fetch'),'./assets/a.glb');assert.equal(x.replaced,undefined);assert(x.elements.get('loadText').textContent.includes('Failed to fetch'));
x=env();assert.throws(()=>x.api.watch({graphicsDevice:{isWebGPU:false,isWebGL2:false}}),/WebGPU/);
x=env();let gpuEvent,deviceEvent;x.api.watch({graphicsDevice:{isWebGPU:true,on(e,fn){deviceEvent=fn},wgpu:{addEventListener(e,fn){gpuEvent=fn}}}});gpuEvent({preventDefault(){},error:Error('validation')});assert(x.replaced.includes('renderer=raster'));
x=env();x.handlers.error({filename:'chrome-extension://abc/script.js',message:'GPU error'});assert.equal(x.replaced,undefined);
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
console.log('PASS: bounded fallback, blocked storage, manual recovery, explicit mode, asset errors, null device, GPU errors, extension isolation and four ResizeObserver shapes.');
