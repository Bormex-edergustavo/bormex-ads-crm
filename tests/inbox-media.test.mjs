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
  const tables=Object.fromEntries(["conversations","messages","settings","sales","leads","spend","ads"].map(name=>[`bormex_${name}`,new Map()]));
  for(const channel of ['whatsapp','messenger','instagram'])tables.bormex_conversations.set(`${channel}_contact`,{id:`${channel}_contact`,channel,contactId:'contact',phone:'521234567890',name:'Prueba',tags:['keep'],unread:3,lastAt:'2026-10-27T12:00:00Z'});
  const calls=[];const errorLogs=[];const storedObjects=new Map();let handler,bucket=false,sequence=0;
  const response=(x,status=200,headers={})=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json',...headers}});
  const fetch=async(input,options={})=>{
    const url=new URL(input);const method=options.method||'GET';calls.push({url:String(url),method,options});
    if(url.hostname==='storage.test'&&url.pathname==='/rest/v1/rpc/bormex_store_whatsapp_messages'){
      const payload=JSON.parse(options.body);assert(Array.isArray(payload.p_messages));
      // SQL merge/race behavior is covered separately against Postgres.
      if(!payload.p_receipts)for(const item of payload.p_messages)tables.bormex_messages.set(item.id,item);
      return response(payload.p_receipts?[]:payload.p_messages);
    }
    if(url.hostname==='storage.test'&&url.pathname.startsWith('/rest/v1/')){
      const table=tables[url.pathname.split('/').at(-1)];assert(table,'Unknown table');
      if(method==='POST'){for(const row of JSON.parse(options.body))table.set(row.id||row.key,row.data||row.value);return response({});}
      const key=url.searchParams.get('id')||url.searchParams.get('key');let rows=[...table].filter(([k,v])=>!key||key.startsWith('in.')||key===`eq.${k}`);
      for(const [k,v]of url.searchParams)if(k.startsWith('data->>'))rows=rows.filter(([,r])=>v===`eq.${r[k.slice(7)]}`);
      if(url.searchParams.get('or')?.includes('adId.neq')) rows=rows.filter(([,r])=>r.adId||r.ad_id||r.metaAdId);
      const order=url.searchParams.get('order')||'';if(order.startsWith('data->>')){const [field,direction]=order.slice(7).split('.');rows.sort(([,a],[,b])=>String(a[field]||'').localeCompare(String(b[field]||''))*(direction==='desc'?-1:1));}
      const offset=Number(url.searchParams.get('offset')||0);const limit=Number(url.searchParams.get('limit')||rows.length);rows=rows.slice(offset,offset+limit);
      return response(rows.map(([id,data])=>url.pathname.endsWith('bormex_settings')?{key:id,value:data}:{id,data}));
    }
    if(url.hostname==='storage.test'&&url.pathname.startsWith('/storage/v1/')){
      if(url.pathname==='/storage/v1/bucket/bormex-crm-media')return response({},bucket?200:404);
      if(url.pathname==='/storage/v1/bucket'){assert.equal(JSON.parse(options.body).public,false);assert(JSON.parse(options.body).file_size_limit<=50*1024*1024);bucket=true;return response({});}
      if(url.pathname.includes('/object/sign/'))return response({signedURL:'/object/sign/bormex-crm-media/a?token=temporary'});
      if(url.pathname==='/storage/v1/object/sign/bormex-crm-media/a')return new Response('binary',{headers:{'content-type':'image/png'}});
      if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/')){const k=url.pathname.replace('/storage/v1/object/authenticated/','');return storedObjects.has(k)?new Response(storedObjects.get(k)):response({},404);}
      if(method==='DELETE'&&url.pathname==='/storage/v1/object/bormex-crm-media'){for(const k of JSON.parse(options.body).prefixes)storedObjects.delete('bormex-crm-media/'+k);return response({});}
      if(method==='POST'&&url.pathname.includes('/object/')){storedObjects.set(url.pathname.replace('/storage/v1/object/',''),options.body);return response({Key:'file'});}
    }
    if(url.hostname==='api.dualhook.com'){
      assert.equal(options.headers instanceof Headers?options.headers.get('authorization'):options.headers.authorization,`Bearer ${env.DUALHOOK_RUNTIME_API_KEY}`);
      assert(!url.searchParams.has('appsecret_proof'));assert(!url.searchParams.has('access_token'));assert.equal(options.redirect,'error');
      if(url.pathname.endsWith('/media')&&method==='POST'){assert(options.body instanceof FormData);assert.deepEqual([...options.body.keys()],['messaging_product','file']);return response({id:'123456789123456'});}
      if(url.pathname.endsWith('/messages')&&method==='POST')return response({messages:[{id:`dhmid${++sequence}`}]});
      if(url.pathname.endsWith('/content')&&method==='GET')return new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-3/8','accept-ranges':'bytes'}});
      throw new Error('Unexpected runtime operation');
    }
    if(['graph.facebook.com','graph.instagram.com'].includes(url.hostname)){
      if(url.pathname.endsWith('/messages')&&method==='POST'&&env.TEST_SEND_DENIED)return response({error:{code:10,message:'Application does not have permission for this action'}},403);
      if(url.pathname.endsWith('/messages')&&method==='POST'&&env.TEST_SEND_EMPTY)return response({});
      if(url.pathname.endsWith('/messages')&&method==='POST')return response({message_id:`mid${++sequence}`,messages:[{id:`mid${sequence}`} ]});
      if(url.pathname.endsWith('/media')&&method==='POST')return response({id:'wa-media-id'});
      if(url.pathname.endsWith('/subscribed_apps')&&method==='POST')return response({success:true});
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
  const c=vm.createContext({Deno:{env:{get:k=>env[k]},serve:f=>handler=f},fetch,URL,URLSearchParams,Request,Response,Headers,FormData,File,Blob,TextEncoder,TextDecoder,Uint8Array,ReadableStream,AbortSignal,crypto:webcrypto,atob,btoa,structuredClone,console:{error:(...args)=>errorLogs.push(args)}});
  vm.runInContext(stripTypeScriptTypes(source),c);
  const request=(path,method='GET',body,auth=true,extraHeaders={})=>handler(new Request('https://crm.test/bormex-crm'+path,{method,headers:{...(auth?{authorization:'Basic '+btoa('panel:test-password')}:{ }),...extraHeaders},body:body instanceof FormData?body:body?JSON.stringify(body):undefined}));
  const upload=async(channel,type='image/png',name='foto.png',size=10)=>{
    const f=new FormData();f.set('channel',channel);f.set('conversationId',`${channel}_contact`);f.set('file',new File([new Uint8Array(size)],name,{type}));return request('/api/media/upload','POST',f);
  };
  return{c,env,tables,calls,request,upload,storedObjects,errorLogs};
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

await test('Business contact sync reads nested contacts and ignores other state types',()=>{
  const h=harness();const payload=h.c.extractWhatsAppEvents({entry:[{changes:[{field:'smb_app_state_sync',value:{state_sync:[
    {type:'contact',action:'add',metadata:{timestamp:'1793188800'},contact:{phone_number:'521234567890',full_name:'Nombre de agenda'}},
    {type:'label',action:'add',contact:{phone_number:'529999999999',full_name:'No es contacto'}}
  ]}}]}]});
  assert.equal(payload.conversations.length,1);const contact=payload.conversations[0];
  assert.equal(contact.whatsappContactName,'Nombre de agenda');assert.equal(contact.whatsappContactUpdatedAt,new Date(1793188800000).toISOString());
  for(const field of ['lastMessage','lastAt','unread','unreadDelta'])assert(!Object.hasOwn(contact,field));
  const legacy=h.c.getWhatsAppContactSyncItems({contacts:[{wa_id:'521234567890',full_name:'Anterior'}]});assert.equal(legacy.length,1);
});
await test('Saved business names, lists and tags survive public profiles and numeric echoes',()=>{
  const h=harness();const saved={id:'whatsapp_521234567890',channel:'whatsapp',phone:'521234567890',name:'Mi cliente',whatsappContactName:'Mi cliente',tags:['crm-tag'],whatsappLists:['wa-list'],unread:2,lastAt:'2026-10-20T12:00:00Z',lastMessage:'Pedido'};
  for(const incoming of [{name:'521234567890',phone:saved.phone},{name:'Perfil público',whatsappProfileName:'Perfil público',unreadDelta:1}]){
    const merged=h.c.mergeConversationData(saved,incoming);assert.equal(merged.name,'Mi cliente');assert.equal(merged.tags[0],'crm-tag');assert.equal(merged.whatsappLists[0],'wa-list');
  }
  assert.equal(h.c.mergeConversationData({...saved,customName:'Nombre CRM'},{name:'Perfil público'}).name,'Nombre CRM');
  assert.equal(h.c.mergeConversationData({...saved,whatsappContactName:''},{name:saved.phone,phone:saved.phone}).name,'Mi cliente');
});
await test('Contact metadata updates preserve chat activity and removals keep history',()=>{
  const h=harness();const before={id:'whatsapp_521234567890',channel:'whatsapp',phone:'521234567890',name:'Nombre anterior',whatsappContactName:'Nombre anterior',whatsappProfileName:'Perfil',tags:['keep'],whatsappLists:['list'],unread:4,lastAt:'2026-10-20T12:00:00Z',lastMessage:'Cotización'};
  const updated=h.c.mergeConversationData(before,{whatsappContactName:'Nombre nuevo',whatsappContactUpdatedAt:'2026-10-28T12:00:00Z'});
  assert.equal(updated.name,'Nombre nuevo');for(const field of ['lastAt','lastMessage','unread'])assert.equal(updated[field],before[field]);
  const removed=h.c.mergeConversationData(before,{whatsappContactName:'',whatsappContactRemoved:true});assert.equal(removed.name,'Perfil');assert.equal(removed.lastMessage,'Cotización');assert.equal(removed.tags[0],'keep');
  const patched=h.c.normalizeConversationPatch({...updated,crmNote:'Nota'});assert.equal(patched.whatsappContactName,'Nombre nuevo');assert.equal(patched.whatsappLists[0],'list');
  const stale=h.c.mergeConversationData({...updated,whatsappContactUpdatedAt:'2026-10-28T12:00:00Z'},{name:'Anterior',whatsappContactName:'Anterior',whatsappContactUpdatedAt:'2026-10-27T12:00:00Z'});assert.equal(stale.name,'Nombre nuevo');
});

await test('Chunk upload routes require auth and permit the sales role',async()=>{
  const h=harness();for(const suffix of ['session','part','finish','cancel']){const path='/api/media/upload/'+suffix;assert.equal((await h.request(path,'POST',{},false)).status,401);assert(h.c.isPathAllowed(path,'POST','sales'));}
});
await test('Chunk sessions validate channel and provider limits before storage writes',async()=>{
  const h=harness();for(const body of [{channel:'whatsapp',conversationId:'whatsapp_contact',size:17*1024*1024,filename:'v.mp4',mimeType:'video/mp4'},{channel:'whatsapp',conversationId:'instagram_contact',size:10,filename:'v.mp4',mimeType:'video/mp4'}])assert.equal((await h.request('/api/media/upload/session','POST',body)).status,400);
  assert(!h.calls.some(c=>c.url.includes('/storage/v1/')));
});
await test('Chunk assembly preserves all bytes, uploads once and cleans private staging',async()=>{
  const h=harness();const size=1024*1024+7;
  const session=await(await h.request('/api/media/upload/session','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',filename:'complete.mp4',mimeType:'video/mp4',size})).json();assert.equal(session.parts,2);
  for(let i=0;i<2;i++){const form=new FormData();form.set('uploadId',session.uploadId);form.set('index',String(i));form.set('file',new File([new Uint8Array(i?7:1024*1024).fill(i+1)],'part.bin'));const r=await h.request('/api/media/upload/part','POST',form);assert.equal(r.status,200,await r.clone().text());}
  const one=await h.request('/api/media/upload/finish','POST',{uploadId:session.uploadId});assert.equal(one.status,200,await one.clone().text());const first=await one.json();
  const second=await(await h.request('/api/media/upload/finish','POST',{uploadId:session.uploadId})).json();assert.equal(first.mediaId,second.mediaId);
  assert.equal(h.calls.filter(c=>c.url.includes('graph.facebook.com')&&c.url.endsWith('/media')).length,1);
  assert(![...h.storedObjects.keys()].some(k=>k.includes('/staging/')));
  const file=h.storedObjects.get('bormex-crm-media/'+first.storagePath);const bytes=new Uint8Array(await file.arrayBuffer());assert.equal(bytes.length,size);assert.equal(bytes[0],1);assert.equal(bytes.at(-1),2);
});
await test('Incomplete or invalid chunks cannot reach Meta; cancellation removes staging',async()=>{
  const h=harness();const session=await(await h.request('/api/media/upload/session','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',filename:'v.mp4',mimeType:'video/mp4',size:1024*1024+7})).json();
  const f=new FormData();f.set('uploadId',session.uploadId);f.set('index','0');f.set('file',new File([new Uint8Array(5)],'bad.bin'));assert.equal((await h.request('/api/media/upload/part','POST',f)).status,400);
  assert.equal((await h.request('/api/media/upload/finish','POST',{uploadId:session.uploadId})).status,400);assert(!h.calls.some(c=>c.url.includes('graph.facebook.com')));
  assert.equal((await h.request('/api/media/upload/cancel','POST',{uploadId:session.uploadId})).status,200);assert.equal((await h.request('/api/media/upload/finish','POST',{uploadId:session.uploadId})).status,404);
  assert.equal((await h.request('/api/media/upload/finish','POST',{uploadId:'../../private'})).status,400);
});

await test('WhatsApp video uses the uploaded media ID and records only a confirmed send',async()=>{
  const h=harness();const media=await(await h.upload('whatsapp','video/mp4','ready.mp4')).json();
  const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',mediaType:'video',mediaId:media.mediaId,mediaStoragePath:media.storagePath,mediaFilename:'ready.mp4',mediaMimeType:'video/mp4'});
  assert.equal(r.status,200,await r.clone().text());const call=h.calls.find(x=>x.url.includes('graph.facebook.com')&&x.url.endsWith('/messages'));const body=JSON.parse(call.options.body);assert.equal(body.type,'video');assert.equal(body.video.id,'wa-media-id');assert(!body.video.link);assert.equal(h.tables.bormex_messages.size,1);
});
await test('Meta permission rejection is explicit and never becomes an outgoing message',async()=>{
  const h=harness({TEST_SEND_DENIED:true});const before=h.tables.bormex_conversations.get('whatsapp_contact').lastAt;
  const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',text:'Pedido'});
  assert.equal(r.status,403);assert.match((await r.json()).error,/Meta no autorizó/);assert.equal(h.tables.bormex_messages.size,0);assert.equal(h.tables.bormex_conversations.get('whatsapp_contact').lastAt,before);
  const log=h.errorLogs.find(args=>args[0]==='whatsapp_send_rejected');assert(log);const metadata=JSON.parse(log[1]);assert.equal(metadata.code,10);assert(!JSON.stringify(log).includes('521234567890'));assert(!JSON.stringify(log).includes('wa-send'));
});
await test('An empty Meta success response cannot invent a sent message ID',async()=>{
  const h=harness({TEST_SEND_EMPTY:true});const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',text:'Pedido'});assert.equal(r.status,502);assert.equal(h.tables.bormex_messages.size,0);
});

await test('CRM sale preview detects the chat ad and saving preserves its ID and referral',async()=>{
  const h=harness();Object.assign(h.tables.bormex_conversations.get('whatsapp_contact'),{adId:'120123456789001',ad:'Imanes',ctwaClid:'click-origin',attributionSource:'whatsapp_referral'});
  const r=await h.request('/api/sales/attribution?conversationId=whatsapp_contact');assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).attribution.adId,'120123456789001');assert.equal(h.tables.bormex_sales.size,0);assert(!h.calls.some(c=>c.url.includes('graph.facebook.com')));
  const saved=await h.request('/api/sales','POST',{id:'sale-test',phone:'521234567890',sourceConversationId:'whatsapp_contact',products:['Imán'],amount:100,date:'2026-10-28'});assert.equal(saved.status,200,await saved.clone().text());const sale=h.tables.bormex_sales.get('sale-test');assert.equal(sale.adId,'120123456789001');assert.equal(sale.ctwaClid,'click-origin');assert.equal(sale.attributionSource,'whatsapp_referral');
});
await test('Partial chat metadata cannot hide an old ad referral beyond the last 100 messages',async()=>{
  const h=harness();h.tables.bormex_conversations.get('whatsapp_contact').campaign='Click-to-WhatsApp';
  h.tables.bormex_messages.set('origin',{id:'origin',conversationId:'whatsapp_contact',adId:'120123456789002',at:'2026-01-01T00:00:00Z',attributionSource:'whatsapp_referral'});
  for(let i=0;i<120;i++)h.tables.bormex_messages.set(`later${i}`,{id:`later${i}`,conversationId:'whatsapp_contact',at:`2026-10-28T12:${String(i%60).padStart(2,'0')}:00Z`});
  h.tables.bormex_leads.set('other-ad',{id:'other-ad',phone:'521234567890',adId:'120123456789099',date:'2026-10-28'});
  const r=await h.request('/api/sales/attribution?conversationId=whatsapp_contact');assert.equal(r.status,200);assert.equal((await r.json()).attribution.adId,'120123456789002');
  assert(h.calls.some(c=>c.url.includes('/bormex_messages?')&&new URL(c.url).searchParams.get('or')?.includes('adId.neq')));
});
await test('A lead ad ID wins over partial chat information and a newer empty lead',async()=>{
  const h=harness();h.tables.bormex_conversations.get('whatsapp_contact').campaign='Parcial';h.tables.bormex_leads.set('older',{id:'older',phone:'521234567890',adId:'120123456789003',date:'2026-10-01'});h.tables.bormex_leads.set('newer',{id:'newer',phone:'521234567890',campaign:'Sin ID',date:'2026-10-28'});
  const r=await h.request('/api/sales/attribution?conversationId=whatsapp_contact');assert.equal((await r.json()).attribution.adId,'120123456789003');
});
await test('Organic chat stays without an invented ad and explicit manual IDs survive',async()=>{
  const h=harness();const preview=await h.request('/api/sales/attribution?conversationId=whatsapp_contact');assert.equal((await preview.json()).attribution,null);
  const r=await h.request('/api/sales','POST',{id:'organic',phone:'521234567890',sourceConversationId:'whatsapp_contact',amount:100,products:['Pin']});assert.equal(r.status,200);assert.equal(h.tables.bormex_sales.get('organic').adId,'');
  const manual=await h.request('/api/sales','POST',{id:'manual',phone:'521234567890',sourceConversationId:'whatsapp_contact',adId:'120123456789004',attributionSource:'manual_ad_id',amount:100});assert.equal(manual.status,200);assert.equal(h.tables.bormex_sales.get('manual').adId,'120123456789004');
});
await test('Explicit source chat excludes a different chat referral and rejects a changed phone',async()=>{
  const h=harness();h.tables.bormex_messages.set('wrong',{id:'wrong',conversationId:'messenger_contact',from:'521234567890',adId:'120123456789999'});
  const r=await h.request('/api/sales/attribution?conversationId=whatsapp_contact');assert.equal((await r.json()).attribution,null);
  const mismatch=await h.request('/api/sales','POST',{id:'wrong-phone',phone:'529876543210',sourceConversationId:'whatsapp_contact',amount:100});assert.equal(mismatch.status,400);assert.equal(h.tables.bormex_sales.size,0);
});
await test('Social ad conversation can be previewed without a WhatsApp number',async()=>{
  const h=harness();Object.assign(h.tables.bormex_conversations.get('instagram_contact'),{phone:'',adId:'120123456789005',attributionSource:'instagram_referral'});const r=await h.request('/api/sales/attribution?conversationId=instagram_contact');assert.equal(r.status,200);assert.equal((await r.json()).attribution.adId,'120123456789005');
});
await test('An explicit different ad cannot inherit another ad name or click ID',async()=>{
  const h=harness();Object.assign(h.tables.bormex_conversations.get('whatsapp_contact'),{adId:'120123456789001',ad:'Otro anuncio',ctwaClid:'other-click'});
  const r=await h.request('/api/sales','POST',{id:'manual-override',phone:'521234567890',sourceConversationId:'whatsapp_contact',adId:'120123456789777',attributionSource:'manual_ad_id',amount:100});assert.equal(r.status,200);const sale=h.tables.bormex_sales.get('manual-override');assert.equal(sale.adId,'120123456789777');assert.equal(sale.ad,'');assert.equal(sale.ctwaClid,'');
});
await test('Sale attribution preview is protected and available to the sales role',async()=>{
  const h=harness();assert.equal((await h.request('/api/sales/attribution?conversationId=whatsapp_contact','GET',undefined,false)).status,401);assert(h.c.isPathAllowed('/api/sales/attribution','GET','sales'));assert.equal((await h.request('/api/sales/attribution?conversationId=missing')).status,404);assert.equal((await h.request('/api/sales/attribution')).status,400);
});

await test('WhatsApp app subscription uses only the configured business and paired sending proof',async()=>{
  const h=harness({WHATSAPP_BUSINESS_ACCOUNT_ID:'bormex-waba',WHATSAPP_SEND_CREDENTIALS_SOURCE:'paired_media',WHATSAPP_MEDIA_ACCESS_TOKEN:'paired-token',WHATSAPP_MEDIA_APP_SECRET:'paired-secret'});
  assert.equal((await h.request('/api/meta/whatsapp/subscribe','POST',{},false)).status,401);assert(!h.c.isPathAllowed('/api/meta/whatsapp/subscribe','POST','sales'));
  const r=await h.request('/api/meta/whatsapp/subscribe','POST',{});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
  const calls=h.calls.filter(call=>call.url.includes('graph.facebook.com'));assert.equal(calls.length,1);const url=new URL(calls[0].url);assert(url.pathname.endsWith('/bormex-waba/subscribed_apps'));assert(url.searchParams.get('appsecret_proof'));assert.equal(calls[0].options.headers.authorization,'Bearer paired-token');assert(!url.searchParams.has('access_token'));
});

await test('Official provider transport uploads and sends without forwarding Meta tokens or proofs',async()=>{
  const h=harness({WHATSAPP_SEND_TRANSPORT:'dualhook',DUALHOOK_RUNTIME_API_KEY:'dh_live_runtime_test_123456789'});const media=await(await h.upload('whatsapp','video/mp4','video.mp4')).json();
  const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',mediaType:'video',mediaId:media.mediaId,mediaStoragePath:media.storagePath});assert.equal(r.status,200,await r.clone().text());assert.equal(h.tables.bormex_messages.size,1);
  const runtime=h.calls.filter(c=>c.url.includes('api.dualhook.com'));assert.equal(runtime.length,2);const body=JSON.parse(runtime[1].options.body);assert.equal(body.video.id,'123456789123456');assert(!body.phone_number_id);assert(!body.access_token);assert(!h.calls.some(c=>c.url.includes('graph.facebook.com')));
});
await test('Provider downloads keep range headers and never expose a key to Meta or a media URL',async()=>{
  const h=harness({WHATSAPP_SEND_TRANSPORT:'dualhook',DUALHOOK_RUNTIME_API_KEY:'dh_live_runtime_test_123456789'});const r=await h.c.downloadWhatsAppMedia('123456789',new Request('https://crm.test/file',{headers:{range:'bytes=0-3'}}),'video.mp4');assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/8');assert.equal((await r.arrayBuffer()).byteLength,4);
  const calls=h.calls.filter(c=>c.url.includes('dualhook'));assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).pathname,'/v25.0/123456789/content');assert.equal(calls[0].options.headers.get('range'),'bytes=0-3');assert(!h.calls.some(c=>c.url.includes('graph.facebook.com')));
  await assert.rejects(()=>h.c.downloadWhatsAppMedia('https://other.test',new Request('https://crm.test/file'),'file'),e=>e.status===400);assert.equal(h.calls.length,1);
});
await test('Missing provider key cannot fall back to a configured Meta token',async()=>{
  const h=harness({WHATSAPP_SEND_TRANSPORT:'dualhook'});const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',text:'Hola'});assert.equal(r.status,503);assert(!h.calls.some(c=>c.url.includes('graph.facebook.com')||c.url.includes('api.dualhook.com')));
});
await test('An archived upload made with the old app is sent by its private signed file URL',async()=>{
  const h=harness();const media=await(await h.upload('whatsapp','video/mp4','video.mp4')).json();h.env.WHATSAPP_SEND_TRANSPORT='dualhook';h.env.DUALHOOK_RUNTIME_API_KEY='dh_live_runtime_test_123456789';const before=h.calls.length;
  const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',mediaType:'video',mediaId:media.mediaId,mediaStoragePath:media.storagePath});assert.equal(r.status,200,await r.clone().text());const call=h.calls.slice(before).find(c=>c.url.includes('api.dualhook.com'));const body=JSON.parse(call.options.body);assert(body.video.link.startsWith('https://storage.test/'));assert(!body.video.id);assert(!h.calls.slice(before).some(c=>c.url.includes('graph.facebook.com')));
});
await test('A saved video survives a change of native sending app through its private file link',async()=>{
  const h=harness({WHATSAPP_SEND_CREDENTIALS_SOURCE:'paired_media',WHATSAPP_MEDIA_ACCESS_TOKEN:'old-token',WHATSAPP_MEDIA_APP_SECRET:'old-secret'});
  const media=await(await h.upload('whatsapp','video/mp4','video.mp4')).json();h.env.WHATSAPP_SEND_CREDENTIALS_SOURCE='send';h.env.WHATSAPP_SEND_ACCESS_TOKEN='new-token';h.env.WHATSAPP_SEND_APP_SECRET='new-secret';
  const r=await h.request('/api/messages','POST',{channel:'whatsapp',conversationId:'whatsapp_contact',to:'521234567890',mediaType:'video',mediaId:media.mediaId,mediaStoragePath:media.storagePath});assert.equal(r.status,200,await r.clone().text());
  const call=h.calls.findLast(c=>c.url.includes('graph.facebook.com')&&c.url.includes('/messages'));const body=JSON.parse(call.options.body);assert(body.video.link.startsWith('https://storage.test/'));assert(!body.video.id);assert.equal(new Headers(call.options.headers).get('authorization'),'Bearer new-token');
});
await test('An inaccessible sending phone is reported as a credential problem without blaming the recipient',()=>{
  const h=harness();const error=h.c.formatWhatsAppSendError({error:{code:100,error_subcode:33,message:'Unsupported post request'}},{to:'521234567890'});
  assert(error.includes('emisor'));assert(error.includes('credencial'));assert(!error.includes('521234567890'));assert(!error.includes('numero personal'));
});
await test('Text and media explicitly use the configured Messaging Account without caller overrides',async()=>{
  const h=harness({WHATSAPP_BUSINESS_ACCOUNT_ID:'363434497629717'});
  for(const media of [{type:'',url:''},{type:'video',url:'',id:'123456789'}]){
    await h.c.sendWhatsAppMessage('521234567890','Prueba',media);
    const call=h.calls.at(-1);assert.equal(JSON.parse(call.options.body).messaging_account_id,'363434497629717');
  }
  await h.c.postWhatsAppMessage('wa123','wa-send',{messaging_account_id:'other',type:'text'});
  assert.equal(JSON.parse(h.calls.at(-1).options.body).messaging_account_id,'363434497629717');
});
await test('Provider key is excluded from Meta diagnostics and webhook-management requests',async()=>{
  const h=harness({WHATSAPP_SEND_TRANSPORT:'dualhook',DUALHOOK_RUNTIME_API_KEY:'dh_live_runtime_test_123456789'});const d=await h.c.metaMessagingCredentialStatus();assert.equal(d.whatsapp_send.transport,'dualhook');assert.equal(d.whatsapp_send.configured,true);
  assert(!h.calls.some(c=>c.url.includes(h.env.DUALHOOK_RUNTIME_API_KEY)||[...new Headers(c.options.headers).values()].some(value=>value.includes(h.env.DUALHOOK_RUNTIME_API_KEY))));
  const before=h.calls.length;const r=await h.request('/api/meta/whatsapp/subscribe','POST',{});assert.equal(r.status,400);assert.equal(h.calls.length,before);
});

await test('WhatsApp receipts accept only the configured business phone/account and valid provider states',()=>{
  const h=harness({WHATSAPP_BUSINESS_ACCOUNT_ID:'waba-test'});
  const payload={entry:[{id:'waba-test',changes:[{field:'messages',value:{metadata:{phone_number_id:'wa123'},statuses:[
    {id:'valid',status:'delivered',timestamp:'1793290000'},
    {id:'failure',status:'failed',timestamp:'1793290001',errors:[{code:131047,message:'untrusted provider text'}]},
    {id:'bad-time',status:'read',timestamp:'not-a-time'},{id:'bad-state',status:'deleted',timestamp:'1793290000'}
  ]}}]}]};
  const receipts=h.c.extractWhatsAppReceipts(payload);assert.equal(receipts.length,2);assert.equal(receipts[0].deliveredAt,'2026-10-29T16:06:40.000Z');assert.match(receipts[1].deliveryError.message,/24 horas/);assert(!JSON.stringify(receipts).includes('untrusted provider text'));
  payload.entry[0].id='another-business';assert.equal(h.c.extractWhatsAppReceipts(payload).length,0);
  payload.entry[0].id='waba-test';payload.entry[0].changes[0].value.metadata.phone_number_id='another-phone';assert.equal(h.c.extractWhatsAppReceipts(payload).length,0);
});
await test('Signed delivery callbacks persist receipts without creating conversations, leads, or sending another message',async()=>{
  const h=harness({WHATSAPP_SEND_APP_SECRET:'new-app-secret'});
  const body={entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'wa123'},statuses:[{id:'message-from-api',status:'read',timestamp:'1793290000'}]}}]}]};
  const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('new-app-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await webcrypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(body)));const signature='sha256='+Buffer.from(digest).toString('hex');
  const unsigned=await h.request('/webhooks/whatsapp','POST',body,false);assert.equal(unsigned.status,200);assert.equal((await unsigned.json()).receipts,0);
  const r=await h.request('/webhooks/whatsapp','POST',body,false,{'x-hub-signature-256':signature});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).receipts,1);
  const rpc=h.calls.find(x=>x.url.endsWith('/rpc/bormex_store_whatsapp_messages'));assert(rpc);const sent=JSON.parse(rpc.options.body);assert.equal(sent.p_receipts,true);assert.equal(sent.p_messages[0].id,'message-from-api');assert.equal(sent.p_messages[0].status,'read');
  assert.equal(h.tables.bormex_conversations.size,3);assert.equal(h.tables.bormex_messages.size,0);assert.equal(h.tables.bormex_leads.size,0);assert(!h.calls.some(x=>x.url.includes('graph.facebook.com')));
});

for(const check of checks)console.log(check.pass?'PASS':'FAIL',check.name,check.error||'');
if(checks.some(c=>!c.pass))process.exitCode=1;
