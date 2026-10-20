// Transport only: GLB bytes are recovered verbatim, then parsed by the same
// Animation.fromGlb implementation as Animation.loadGlb uses.
export function unpackMotions(buffer, version, expected) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) throw new Error('Invalid motion pack');
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'SFMP') throw new Error('Invalid motion pack signature');
  const length = new DataView(buffer).getUint32(4, true), start = 8 + length;
  if (!length || length > 1048576 || start > buffer.byteLength) throw new Error('Invalid motion manifest length');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, start)));
  if (manifest.version !== version || !Array.isArray(manifest.clips) || manifest.clips.length !== expected.length) throw new Error('Motion pack version or clip count mismatch');
  const wanted = new Map(expected.map(([name, url]) => [name, url.split('?')[0]]));
  if (wanted.size !== expected.length) throw new Error('Duplicate motion names');
  let end = 0;
  const clips = [];
  for (const clip of manifest.clips) {
    if (!wanted.has(clip.name) || wanted.get(clip.name) !== clip.path) throw new Error('Unexpected motion in pack');
    wanted.delete(clip.name);
    if (!Number.isSafeInteger(clip.offset) || clip.offset !== end || !Number.isSafeInteger(clip.length) || clip.length < 12 || start + clip.offset + clip.length > buffer.byteLength) throw new Error('Invalid motion bounds');
    const offset = start + clip.offset;
    if (new DataView(buffer).getUint32(offset, true) !== 0x46546c67) throw new Error('Invalid GLB in motion pack');
    clips.push({ name: clip.name, offset, length: clip.length });
    end += clip.length;
  }
  if (wanted.size || start + end !== buffer.byteLength) throw new Error('Incomplete motion pack');
  return clips;
}

export async function loadMotions({ entries, version, fetcher, register, loadFile, progress = () => {}, onFallback = () => {},
  decompressor = globalThis.DecompressionStream, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) }) {
  try {
    if (!decompressor) throw new Error('Native gzip decompression unavailable');
    const response = await fetcher(`./assets/motions/startup.v${version}.pack.gz?v=${version}`);
    if (!response.ok) throw new Error(`Motion pack HTTP ${response.status}`);
    let compressed;
    if (response.body) {
      const reader = response.body.getReader(), chunks = [];
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); received += value.byteLength;
        progress({ phase: 'download', fraction: total ? Math.min(1, received / total) : 0 });
      }
      compressed = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.byteLength; }
    } else compressed = new Uint8Array(await response.arrayBuffer());
    const downloadBytes = compressed.byteLength;
    // Some hosts apply Content-Encoding themselves. Accept both representations.
    const buffer = compressed[0] === 0x1f && compressed[1] === 0x8b
      ? await new Response(new Blob([compressed]).stream().pipeThrough(new decompressor('gzip'))).arrayBuffer()
      : compressed.buffer;
    const clips = unpackMotions(buffer, version, entries);
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      register(clip.name, buffer.slice(clip.offset, clip.offset + clip.length));
      progress({ phase: 'parse', fraction: (i + 1) / clips.length });
      if ((i + 1) % 8 === 0) await yieldTask();
    }
    return { source: 'pack', clips: clips.length, downloadBytes };
  } catch (error) {
    // Preserve the existing path for older browsers, stale deployments or any
    // corrupt/missing pack. Partial registrations are overwritten by originals.
    onFallback(error);
    let done = 0;
    await Promise.all(entries.map(async ([name, url]) => {
      await loadFile(name, url);
      progress({ phase: 'parse', fraction: ++done / entries.length });
    }));
    return { source: 'files', clips: entries.length };
  }
}
