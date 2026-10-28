import assert from 'node:assert/strict';
import { videoBitrate, prepareWhatsAppVideo, MAX_VIDEO_INPUT, WHATSAPP_VIDEO_LIMIT } from '../video-tools.js';

const original = new File(['small video'], 'small.mp4', { type: 'video/mp4' });
assert.equal(await prepareWhatsAppVideo(original), original);
console.log('PASS Small videos keep the original without loading the converter');

const rate = videoBitrate(149.54);
assert((rate.video + rate.audio) * 149.54 / 8 < WHATSAPP_VIDEO_LIMIT);
assert.equal(rate.audio, 96000);
for (const duration of [0, NaN, Infinity, 100000]) assert.throws(() => videoBitrate(duration));
console.log('PASS A complete video has a bounded bitrate and invalid durations fail explicitly');

await assert.rejects(() => prepareWhatsAppVideo({ size: MAX_VIDEO_INPUT + 1 }), /100 MB/);
console.log('PASS Inputs above the conversion limit fail before loading the worker');

const controller = new AbortController(); controller.abort();
await assert.rejects(() => prepareWhatsAppVideo({ size: WHATSAPP_VIDEO_LIMIT + 1 }, { signal: controller.signal }), { name: 'AbortError' });
console.log('PASS A cancelled conversion cannot continue to upload');
