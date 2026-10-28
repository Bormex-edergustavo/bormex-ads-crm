// Small requests prevent a slow connection from timing out the whole video.
export async function uploadInParts(file, { channel, conversationId, requestJson, requestForm, onProgress = () => {} }) {
  const session = await requestJson('/api/media/upload/session', {
    channel, conversationId, filename: file.name, mimeType: file.type, size: file.size,
  });
  const retry = async action => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 2 || (error.status && error.status < 500)) throw error;
        onProgress('Reintentando la parte pendiente…');
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  };
  try {
    for (let index = 0; index < session.parts; index += 1) {
      const form = new FormData();
      form.set('uploadId', session.uploadId); form.set('index', String(index));
      form.set('file', file.slice(index * session.chunkSize, (index + 1) * session.chunkSize), 'parte.bin');
      await retry(() => requestForm('/api/media/upload/part', form, { signal: AbortSignal.timeout(90000) }));
      onProgress(`Subiendo archivo… ${Math.min(100, Math.round((index + 1) / session.parts * 100))} %`);
    }
    onProgress('Comprobando archivo…');
    return await retry(() => requestJson('/api/media/upload/finish', { uploadId: session.uploadId }));
  } catch (error) {
    await requestJson('/api/media/upload/cancel', { uploadId: session.uploadId }).catch(() => {});
    throw error;
  }
}
