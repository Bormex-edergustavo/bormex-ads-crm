import { mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = join(root, 'vendor');
await mkdir(vendor, { recursive: true });
await cp(join(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), join(vendor, 'ffmpeg'), { recursive: true });
const core = join(vendor, 'ffmpeg-core');
await rm(core, { recursive: true, force: true });
await mkdir(core, { recursive: true });
await cp(join(root, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js'), join(core, 'ffmpeg-core.js'));
const wasm = await readFile(join(root, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm'));
const parts = [];
for (let offset = 0, index = 0; offset < wasm.length; offset += 4 * 1024 * 1024, index += 1) {
  const bytes = wasm.subarray(offset, offset + 4 * 1024 * 1024);
  const name = `${index}.wasm-part`;
  await writeFile(join(core, name), bytes);
  parts.push({ name, size: bytes.length });
}
await writeFile(join(core, 'manifest.json'), JSON.stringify({ size: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex'), parts }, null, 2) + '\n');
await writeFile(join(vendor, 'NOTICE.txt'), `@ffmpeg/ffmpeg 0.12.15 (MIT) and @ffmpeg/core 0.12.10 (GPL-2.0-or-later).\nJavaScript distributions are unmodified. The original WASM is split for delivery and reassembled byte for byte; manifest.json contains its size and SHA256.\nUpstream source, build recipes and dependency source locations:\nhttps://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15/packages\nhttps://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10/build\nhttps://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE\nFFmpeg source and license: https://ffmpeg.org/legal.html\nThese assets run only when preparing a video. No video content is sent to FFmpeg or a third-party conversion service.\n`);
console.log(`Same-origin video tools prepared in ${parts.length} byte-exact parts.`);
