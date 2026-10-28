// FFmpeg runs in a same-origin worker. The original stays on the user's device.
export const WHATSAPP_VIDEO_LIMIT = 16 * 1024 * 1024;
export const MAX_VIDEO_INPUT = 100 * 1024 * 1024;
const TARGET_VIDEO_BYTES = 14 * 1024 * 1024;

export function videoBitrate(duration, targetBytes = TARGET_VIDEO_BYTES) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('No se pudo leer la duración del video.');
  const total = Math.floor(targetBytes * 8 / duration * 0.94);
  const audio = total < 220000 ? 48000 : 96000;
  const video = Math.min(2500000, total - audio);
  if (video < 48000) throw new Error('Este video es demasiado largo para prepararlo como una sola pieza. Puedes enviarlo desde WhatsApp Web.');
  return { video, audio };
}

export async function prepareWhatsAppVideo(file, { onProgress = () => {}, signal } = {}) {
  if (file.size <= WHATSAPP_VIDEO_LIMIT) return file;
  if (file.size > MAX_VIDEO_INPUT) throw new Error('Selecciona un video de hasta 100 MB para optimizarlo.');
  if (signal?.aborted) throw new DOMException('Preparación cancelada', 'AbortError');
  onProgress('Preparando el video…');
  const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
  const ffmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal?.addEventListener('abort', abort, { once: true });
  let duration = 0;
  let wasmObjectUrl = "";
  ffmpeg.on('log', ({ message }) => {
    const match = message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  });
  ffmpeg.on('progress', ({ time }) => {
    if (duration) onProgress(`Optimizando video… ${Math.max(0, Math.min(99, Math.floor(Number(time || 0) / 1000000 / duration * 100)))} %`);
  });
  try {
    const base = new URL('./vendor/ffmpeg-core/', import.meta.url);
    onProgress('Cargando herramienta de video…');
    const manifestResponse = await fetch(new URL('manifest.json', base), { signal });
    if (!manifestResponse.ok) throw new Error('No se pudo cargar la herramienta de video. Intenta de nuevo.');
    const manifest = await manifestResponse.json();
    const chunks = await Promise.all(manifest.parts.map(async part => {
      if (!/^\d+\.wasm-part$/.test(part.name)) throw new Error('Herramienta de video no válida.');
      const response = await fetch(new URL(part.name, base), { signal });
      if (!response.ok) throw new Error('No se pudo cargar la herramienta de video. Intenta de nuevo.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== part.size) throw new Error('La descarga quedó incompleta. Intenta de nuevo.');
      return bytes;
    }));
    const wasm = new Blob(chunks, { type: 'application/wasm' });
    if (wasm.size !== manifest.size) throw new Error('La descarga quedó incompleta. Intenta de nuevo.');
    wasmObjectUrl = URL.createObjectURL(wasm);
    await ffmpeg.load({ coreURL: new URL('ffmpeg-core.js', base).href, wasmURL: wasmObjectUrl });
    if (signal?.aborted) throw new DOMException('Preparación cancelada', 'AbortError');
    const extension = (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'mp4').toLowerCase();
    const input = `input.${extension}`;
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
    // This probe intentionally has no output; its duration comes from FFmpeg's log.
    await ffmpeg.exec(['-i', input]);
    let { video, audio } = videoBitrate(duration);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = `ready-${attempt}.mp4`;
      const code = await ffmpeg.exec(['-i', input, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-level', '3.1',
        '-pix_fmt', 'yuv420p', '-b:v', String(video), '-c:a', 'aac', '-b:a', String(audio), '-ac', '2',
        '-ar', '48000', '-movflags', '+faststart', '-y', output]);
      if (signal?.aborted) throw new DOMException('Preparación cancelada', 'AbortError');
      if (code !== 0) throw new Error('No se pudo preparar este video. El archivo original se conserva; puedes abrir WhatsApp Web.');
      const bytes = await ffmpeg.readFile(output);
      if (bytes.length && bytes.length <= WHATSAPP_VIDEO_LIMIT) {
        onProgress('Video listo para enviar');
        return new File([bytes], file.name.replace(/\.[^.]+$/, '') + '-whatsapp.mp4', { type: 'video/mp4', lastModified: file.lastModified });
      }
      video = Math.floor(video * TARGET_VIDEO_BYTES / Math.max(1, bytes.length) * 0.88);
      if (video < 48000) break;
    }
    throw new Error('No se pudo reducir el video lo suficiente. El original sigue intacto. Puedes abrir WhatsApp Web.');
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Preparación cancelada', 'AbortError');
    throw error instanceof Error ? error : new Error('No se pudo preparar el video. Intenta de nuevo o abre WhatsApp Web.');
  } finally {
    signal?.removeEventListener('abort', abort);
    ffmpeg.terminate();
    if (wasmObjectUrl) URL.revokeObjectURL(wasmObjectUrl);
  }
}
