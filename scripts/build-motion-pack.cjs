// node scripts/build-motion-pack.cjs [game root] [output path]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
(async () => {
  const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  const { ROSTER, CLIPS } = await import('data:text/javascript;base64,' + Buffer.from(config).toString('base64'));
  const version = Number(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8').match(/const MOTION_VERSION = (\d+);/)[1]);
  const own = new Set();
  for (const def of ROSTER) {
    for (const c of Object.values(def.clips || {})) if (!CLIPS.includes(c)) own.add(c);
    for (const move of Object.values(def.moves || {})) if (move.clip) own.add(move.clip);
  }
  const entries = CLIPS.map(name => [name, `./assets/motions/${name}.glb`])
    .concat([...own].map(name => [name, `./assets/motions/chars/${name}.glb`]));
  const clips = [], data = [];
  let offset = 0;
  for (const [name, file] of entries) {
    const bytes = fs.readFileSync(path.join(root, file));
    clips.push({ name, path: file, offset, length: bytes.length });
    data.push(bytes); offset += bytes.length;
  }
  const manifest = Buffer.from(JSON.stringify({ version, clips }));
  const header = Buffer.alloc(8); header.write('SFMP'); header.writeUInt32LE(manifest.length, 4);
  const packed = Buffer.concat([header, manifest, ...data]);
  const compressed = zlib.gzipSync(packed, { level: 9 });
  const target = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, `assets/motions/startup.v${version}.pack.gz`);
  fs.writeFileSync(target, compressed);
  console.log(JSON.stringify({ clips: clips.length, originalBytes: offset, packedBytes: packed.length, downloadBytes: compressed.length, target }));
})().catch(error => { console.error(error); process.exitCode = 1; });
