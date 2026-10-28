import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const source = fs.readFileSync(new URL('../supabase/functions/bormex-crm/index.ts', import.meta.url),'utf8');
const checks=[];
async function test(name,fn){try{await fn();checks.push({name,pass:true});}catch(e){checks.push({name,pass:false,error:e.stack});}}
function fn(source,name){const start=source.indexOf(`function ${name}(`);assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
function harness(overrides={}) {
  const env={PANEL_PASSWORD:'test-password',SUPABASE_URL:'https://storage.test',SUPABASE_SERVICE_ROLE_KEY:'test-service',MESSENGER_PAGE_ACCESS_TOKEN:'page-token',MESSENGER_PAGE_ID:'page123',INSTAGRAM_ACCOUNT_ID:'ig123',INSTAGRAM_ACCESS_TOKEN:'ig-token',WHATSAPP_SEND_ACCESS_TOKEN:'wa-send',WHATSAPP_PHONE_NUMBER_ID:'wa123',...overrides};
  const tables={bormex_conversations:new Map(),bormex_messages:new Map(),bormex_settings:new Map()};
  for(const channel of ['whatsapp','messenger','instagram'])tables.bormex_conversations.set(`${channel}_contact`,{id:`${channel}_contact`,channel,contactId:'contact',phone:'521234567890',name:'Prueba',tags:['keep'],unread:3,lastAt:'2026-10-27T12:00:00Z'});
  const calls=[];let handler,bucket=false,sequence=0;
  const response=(x,status=200,headers={})=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json',...headers}});
  const fetch=async(input,options={})=>{
    const url=new URL(input);const method=options.method||'GET';calls.push({url:String(url),method,options});
    if(url.hostname==='storage.test'&&url.pathname.startsWith('/rest/v1/')){
      const table=tables[url.pathname.split('/').at(-1)];assert(table,'Unknown table');
      if(method==='POST'){for(const row of JSON.parse(options.body))table.set(row.id||row.key,row.data||row.value);return response({});}
      const key=url.searchParams.get('id')||url.searchParams.get('key');let rows=[...table].filter(([k,v])=>!key||key.startsWith('in.')||key===`eq.${k}`);
      for(const [k,v]of url.searchParams)if(k.startsWith('data->>'))rows=rows.filter(([,r])=>v===`eq.${r[k.slice(7)]}`);
      return response(rows.map(([id,data])=>url.pathname.endsWith('bormex_settings')?{key:id,value:data}:{id,data}));
    }
    if(url.hostname==='storage.test'&&url.pathname.startsWith('/storage/v1/')){
      if(url.pathname==='/storage/v1/bucket/bormex-crm-media')return response({},bucket?200:404);
      if(url.pathname==='/storage/v1/bucket'){assert.equal(JSON.parse(options.body).public,false);assert(JSON.parse(options.body).file_size_limit<=50*1024*1024);bucket=true;return response({});}
      if(url.pathname.includes('/object/sign/'))return response({signedURL:'/object/sign/bormex-crm-media/a?token=temporary'});
      if(url.pathname==='/storage/v1/object/sign/bormex-crm-media/a')return new Response('binary',{headers:{'content-type':'image/png'}});
      if(method==='POST'&&url.pathname.includes('/object/'))return response({Key:'file'});
    }
    if(['graph.facebook.com','graph.instagram.com'].includes(url.hostname)){
      if(url.pathname.endsWith('/messages')&&method==='POST')return response({message_id:`mid${++sequence}`,messages:[{id:`mid${sequence}`} ]});
      if(url.pathname.endsWith('/media')&&method==='POST')return response({id:'wa-media-id'});
      if(url.pathname.endsWith('/conversations'))return response({data:[{id:'thread123',participants:{data:[{id:'page123'},{id:'ig123'},{id:'contact',name:'Persona'}]}}],paging:{cursors:{after:'next'},next:'https://graph.facebook.com/next'}});
      if(url.pathname.endsWith('/thread123/messages'))return response({data:[{id:'history1',message:'Mensaje histórico',from:{id:'contact'},to:{data:[{id:'page123'}]},created_time:'2026-10-28T12:00:00Z',attachments:{data:[{id:'attachment123',video_data:{url:'https://video.xx.fbcdn.net/video.mp4'}}]}}]});
      if(url.searchParams.get('fields')==='attachments')return response({attachments:{data:[{image_data:{url:'https://scontent.xx.fbcdn.net/fresh.jpg'}}]}});
    }
    if(url.hostname.endsWith('.fbcdn.net')){
      if(url.pathname==='/expired.jpg')return response({},403);
      return new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-3/8','accept-ranges':'bytes'}});
    }
    throw new Error('Unexpected network request: '+url);
  };
  const c=vm.createContext({Deno:{env:{get:k=>env[k]},serve:f=>handler=f},fetch,URL,URLSearchParams,Request,Response,Headers,FormData,File,Blob,TextEncoder,TextDecoder,Uint8Array,ReadableStream,AbortSignal,crypto:webcrypto,atob,btoa,structuredClone,console:{error:()=>{}}});
  vm.runInContext(stripTypeScriptTypes(source),c);
  const request=(path,method='GET',body,auth=true)=>handler(new Request('https://crm.test/bormex-crm'+path,{method,headers:{...(auth?{authorization:'Basic '+btoa('panel:test-password')}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined}));
  const upload=async(channel,type='image/png',name='foto.png',size=10)=>{
    const f=new FormData();f.set('channel',channel);f.set('conversationId',`${channel}_contact`);f.set('file',new File([new Uint8Array(size)],name,{type}));return request('/api/media/upload','POST',f);
  };
  return{c,env,tables,calls,request,upload};
}
await test('Protected upload, media and inbox reject unauthenticated requests',async()=>{
  const h=harness();for(const [path,method]of [['/api/media/upload','POST'],['/api/media/message/id/0/photo.jpg','GET'],['/api/meta/inbox/sync','POST']])assert.equal((await h.request(path,method,undefined,false)).status,401);
});
await test('Sales role can use the three new protected routes',()=>{const h=harness();for(const [p,m]of [['/api/media/upload','POST'],['/api/media/message/x/0/x.jpg','GET'],['/api/meta/inbox/sync','POST']])assert(h.c.isPathAllowed(p,m,'sales'));});
await test('Messages decode webhook URLs and Graph image/video/file responses',()=>{
  const h=harness();const a=h.c.extractMetaMessageAttachments({attachments:{data:[{image_data:{url:'https://scontent.xx.fbcdn.net/a'}},{video_data:{url:'https://video.xx.fbcdn.net/b'}},{name:'p.pdf',file_url:'https://x.fbsbx.com/c'}]}});assert.deepEqual(Array.from(a,a=>a.type),['image','video','document']);assert(a.every(a=>a.url));
});
for(const channel of ['whatsapp','messenger','instagram'])await test(`${channel}: upload archives the original in private storage`,async()=>{
  const h=harness();const r=await h.upload(channel);assert.equal(r.status,200,await r.clone().text());const media=await r.json();assert(media.storagePath.startsWith('uploads/'));const stored=h.calls.find(x=>x.url.includes('/object/bormex-crm-media/'));assert.equal(new Headers(stored.options.headers).get('content-type'),'image/png');assert(h.calls.some(x=>x.url.includes('/bucket')&&x.method==='POST'));
});
await test('Instagram rejects documents before creating an object',async()=>{const h=harness();assert.equal((await h.upload('instagram','application/pdf','test.pdf')).status,400);assert(!h.calls.some(x=>x.url.includes('/object/')));});
await test('Oversized photo is rejected before provider or storage calls',async()=>{const h=harness();assert.equal((await h.upload('whatsapp','image/png','large.png',5*1024*1024+1)).status,400);assert(!h.calls.some(x=>x.url.includes('graph.facebook.com')));});
await test('Messenger and Instagram send to their own account endpoint and keep private attachment references',async()=>{
  for(const channel of ['messenger','instagram']){
    const h=harness();const media=await(await h.upload(channel)).json();const r=await h.request('/api/messages','POST',{channel,conversationId:`${channel}_contact`,to:'contact',mediaType:'image',mediaStoragePath:media.storagePath});assert.equal(r.status,200,await r.clone().text());const body=await r.json();assert.equal(body.messages[0].attachments[0].url,'');assert.equal(body.messages[0].attachments[0].storagePath,media.storagePath);const call=h.calls.find(x=>x.url.includes('graph.facebook.com')&&x.method==='POST');assert(call.url.endsWith(`/${channel==='messenger'?'page123':'ig123'}/messages`));assert.equal(JSON.parse(call.options.body).message.attachment.type,'image');
  }
});
await test('Instagram Login uses graph.instagram.com for photo sends',async()=>{const h=harness({INSTAGRAM_LOGIN_MODE:'instagram'});await h.c.sendInstagramMessage('contact','',{type:'image',url:'https://temporary.test/x'});assert(h.calls.at(-1).url.startsWith('https://graph.instagram.com/'));});
await test('Stored file cannot be reused in another channel/conversation',async()=>{const h=harness();const media=await(await h.upload('messenger')).json();const r=await h.request('/api/messages','POST',{channel:'instagram',conversationId:'instagram_contact',to:'contact',mediaStoragePath:media.storagePath});assert.equal(r.status,400);});
await test('Incomplete social connection fails explicitly and does not send',async()=>{const h=harness({MESSENGER_PAGE_ID:'',INSTAGRAM_ACCOUNT_ID:''});for(const channel of ['messenger','instagram']){const r=await h.request('/api/meta/inbox/sync','POST',{channel});assert.equal(r.status,503);}assert(!h.calls.some(x=>x.url.includes('graph.')));});
await test('Conversation import deduplicates, preserves tags/unread and exposes cursor',async()=>{const h=harness();for(let i=0;i<2;i++){const r=await h.request('/api/meta/inbox/sync','POST',{channel:'messenger'});assert.equal(r.status,200,await r.clone().text());const body=await r.json();assert.equal(body.imported,i?0:1);assert.equal(body.nextAfter,'next');}assert.equal(h.tables.bormex_messages.size,1);assert.equal(h.tables.bormex_conversations.get('messenger_contact').unread,3);assert.equal(h.tables.bormex_conversations.get('messenger_contact').tags[0],'keep');});
await test('Media proxy forwards byte ranges and renews expired Meta links',async()=>{const h=harness();h.tables.bormex_messages.set('message1',{id:'message1',channel:'messenger',attachments:[{url:'https://scontent.xx.fbcdn.net/expired.jpg',type:'image'}]});const r=await h.request('/api/media/message/message1/0/photo.jpg');assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/8');assert.equal(h.tables.bormex_messages.get('message1').attachments[0].url,'https://scontent.xx.fbcdn.net/fresh.jpg');});
await test('Media proxy does not fetch arbitrary/private server URLs',async()=>{const h=harness();for(const url of ['http://127.0.0.1/a','https://evil.test/a','https://fbcdn.net.evil.test/a','https://user@x.fbcdn.net/a']){h.tables.bormex_messages.set('bad',{id:'bad',channel:'instagram',attachments:[{url}]});assert.equal((await h.request('/api/media/message/bad/0/x')).status,404);}assert(!h.calls.some(x=>x.url.includes('evil.test')));});
await test('Channel filter queries server-side instead of only 300 recent rows',async()=>{const h=harness();const r=await h.request('/api/conversations/search?channel=instagram');assert.equal(r.status,200);assert.equal((await r.json()).conversations.length,1);});
await test('Sending proof uses the explicit paired secret and keeps webhook secret unchanged',async()=>{const h=harness({WHATSAPP_SEND_APP_SECRET:'send-secret'});const url=await h.c.whatsappSendEndpoint('wa123','media','wa-send');assert(url.searchParams.get('appsecret_proof'));assert.equal(h.env.META_APP_SECRET,undefined);});
await test('An unrelated read token never supplies the sending app secret',()=>{const h=harness({WHATSAPP_MEDIA_ACCESS_TOKEN:'different-token',WHATSAPP_MEDIA_APP_SECRET:'read-secret'});assert.equal(h.c.whatsappSendAppSecret(),'');});
await test('The dedicated media secret is reusable only for an exactly matching token',()=>{const h=harness({WHATSAPP_MEDIA_ACCESS_TOKEN:'wa-send',WHATSAPP_MEDIA_APP_SECRET:'same-app-secret'});assert.equal(h.c.whatsappSendAppSecret(),'same-app-secret');});
await test('An explicit owner-selected credential source uses the verified pair',()=>{const h=harness({WHATSAPP_SEND_CREDENTIALS_SOURCE:'paired_media',WHATSAPP_MEDIA_ACCESS_TOKEN:'verified-pair-token',WHATSAPP_MEDIA_APP_SECRET:'verified-pair-secret'});assert.equal(h.c.whatsappSendAccessToken(),'verified-pair-token');assert.equal(h.c.whatsappSendAppSecret(),'verified-pair-secret');});
await test('An incomplete explicitly selected pair fails without another token',()=>{const h=harness({WHATSAPP_SEND_CREDENTIALS_SOURCE:'paired_media'});assert.throws(()=>h.c.whatsappSendAccessToken());});
await test('Messenger webhook accepts only the configured business page',()=>{const h=harness();const event={sender:{id:'customer'},recipient:{id:'page123'},timestamp:1793200000000,message:{mid:'business-msg',text:'Cotización'}};const r=h.c.extractMetaMessagingEvents({object:'page',entry:[{id:'page123',messaging:[event]},{id:'personal-eder',messaging:[{...event,message:{mid:'personal-msg',text:'Personal'}}]}]});assert.equal(r.messages.length,1);assert.equal(r.messages[0].id,'business-msg');assert.equal(r.conversations[0].businessAccountId,'page123');});
await test('Instagram webhook rejects a different Instagram account',()=>{const h=harness();const r=h.c.extractMetaMessagingEvents({object:'instagram',entry:[{id:'personal-instagram',messaging:[{sender:{id:'customer'},recipient:{id:'personal-instagram'},message:{mid:'personal',text:'Personal'}}]}]});assert.equal(r.messages.length,0);});

for(const check of checks)console.log(check.pass?'PASS':'FAIL',check.name,check.error||'');
if(checks.some(c=>!c.pass))process.exitCode=1;
