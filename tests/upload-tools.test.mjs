import assert from 'node:assert/strict';
import { uploadInParts } from '../upload-tools.js';

const file = new File([new Uint8Array([1,2,3,4,5,6,7,8,9,10])], 'test.mp4', { type:'video/mp4' });
const calls = [], bytes = [], progress = [];
const result = await uploadInParts(file, {
  channel:'whatsapp', conversationId:'business-contact', onProgress:s=>progress.push(s),
  requestJson:async(path,body)=>{calls.push(path);if(path.endsWith('/session')){assert.equal(body.size,file.size);return{uploadId:'test',chunkSize:4,parts:3};}return{mediaId:'accepted'};},
  requestForm:async(path,form)=>{calls.push(path);bytes.push(...new Uint8Array(await form.get('file').arrayBuffer()));},
});
assert.equal(result.mediaId,'accepted');assert.deepEqual(bytes,[1,2,3,4,5,6,7,8,9,10]);
assert(progress.some(p=>p.includes('100 %')));assert(!calls.includes('/api/messages'));
console.log('PASS Multipart uploader preserves bytes, reports progress and never sends a message');

const failedCalls = [];
await assert.rejects(()=>uploadInParts(file,{
  channel:'whatsapp',conversationId:'business-contact',
  requestJson:async path=>{failedCalls.push(path);return{uploadId:'bad',chunkSize:4,parts:3};},
  requestForm:async()=>{const error=new Error('invalid part');error.status=400;throw error;},
}),/invalid part/);
assert(failedCalls.includes('/api/media/upload/cancel'));assert(!failedCalls.includes('/api/media/upload/finish'));
console.log('PASS A rejected part cancels private staging and cannot complete or send');
