const fs=require('fs'),path=require('path'),zlib=require('zlib'),assert=require('assert/strict');
const root=path.resolve(process.argv[2] || path.join(__dirname,'..'));
const moduleFile=process.argv[4] || path.join(root,'src/motion-pack.js');
(async()=>{
 const {unpackMotions,loadMotions}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(moduleFile,'utf8')).toString('base64'));
 const config=fs.readFileSync(path.join(root,'src/config.js'),'utf8');
 const {ROSTER,CLIPS}=await import('data:text/javascript;base64,'+Buffer.from(config).toString('base64'));
 const version=Number(fs.readFileSync(path.join(root,'src/main.js'),'utf8').match(/const MOTION_VERSION = (\d+);/)[1]);
 const own=new Set();for(const d of ROSTER){for(const c of Object.values(d.clips||{}))if(!CLIPS.includes(c))own.add(c);for(const m of Object.values(d.moves||{}))if(m.clip)own.add(m.clip)}
 const entries=CLIPS.map(n=>[n,`./assets/motions/${n}.glb?v=${version}`]).concat([...own].map(n=>[n,`./assets/motions/chars/${n}.glb?v=${version}`]));
 const pack=fs.readFileSync(process.argv[3] || path.join(root,`assets/motions/startup.v${version}.pack.gz`));
 const raw=zlib.gunzipSync(pack),buffer=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
 const clips=unpackMotions(buffer,version,entries);
 const files=new Map(entries.map(([n,url])=>[n,fs.readFileSync(path.join(root,url.split('?')[0]))]));
 let originals=0;
 for(const c of clips){const bytes=Buffer.from(buffer,c.offset,c.length);assert.deepEqual(bytes,files.get(c.name),c.name+' changed');originals+=bytes.length;}
 let fetched=0,registered=0,fallbacks=0;
 const options={entries,version,fetcher:async()=>{fetched++;return new Response(pack,{headers:{'content-length':String(pack.length)}})},register:(n,b)=>{assert.deepEqual(Buffer.from(b),files.get(n));registered++},loadFile:async()=>{throw Error('unexpected fallback')},yieldTask:async()=>{}};
 let result=await loadMotions(options);assert.equal(result.source,'pack');assert.equal(fetched,1);assert.equal(registered,entries.length);assert.equal(result.downloadBytes,pack.length);
 result=await loadMotions({...options,fetcher:async()=>new Response(raw),register:(n,b)=>assert.deepEqual(Buffer.from(b),files.get(n))});assert.equal(result.source,'pack');
 const fallback=async overrides=>{
  let loaded=0;const result=await loadMotions({...options,loadFile:async(n,url)=>{assert(files.has(n));assert(url.includes('?v='+version));loaded++},onFallback:()=>fallbacks++,...overrides});
  assert.equal(result.source,'files');assert.equal(loaded,entries.length);
 };
 await fallback({decompressor:null,fetcher:async()=>{throw Error('must not fetch without decoder')}});
 await fallback({fetcher:async()=>new Response('',{status:404})});
 await fallback({fetcher:async()=>{throw Error('network')}});
 await fallback({fetcher:async()=>new Response(pack.subarray(0,100))});
 await fallback({register:()=>{throw Error('clip parser failure')}});
 await assert.rejects(loadMotions({...options,decompressor:null,loadFile:async()=>{throw Error('original missing')}}),/original missing/);
 assert.throws(()=>unpackMotions(buffer,version+1,entries),/version/);
 assert.throws(()=>unpackMotions(buffer.slice(0,buffer.byteLength-1),version,entries),/bounds/);
 const headerLength=raw.readUInt32LE(4),manifest=JSON.parse(raw.subarray(8,8+headerLength)),data=raw.subarray(8+headerLength);
 function corrupt(edit){const m=structuredClone(manifest);edit(m);const js=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(8);h.write('SFMP');h.writeUInt32LE(js.length,4);const p=Buffer.concat([h,js,data]);return p.buffer.slice(p.byteOffset,p.byteOffset+p.byteLength)}
 assert.throws(()=>unpackMotions(corrupt(m=>m.clips[1].name=m.clips[0].name),version,entries),/Unexpected/);
 assert.throws(()=>unpackMotions(corrupt(m=>m.clips[0].offset=1),version,entries),/bounds/);
 assert.equal(fallbacks,5);
 console.log(JSON.stringify({verifiedClips:clips.length,byteIdentical:true,originalBytes:originals,downloadBytes:pack.length,reduction:1-pack.length/originals,normalRequests:1,fallbackCases:5}));
})().catch(e=>{console.error(e);process.exitCode=1});
