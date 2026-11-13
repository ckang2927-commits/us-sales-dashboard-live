/* 仅恢复完整离线页面的传输外壳；不修改看板脚本、数据或业务状态。 */
(() => {
 'use strict';
 const panel=document.getElementById('loading'),status=document.getElementById('status'),detail=document.getElementById('detail'),progress=document.getElementById('progress'),retry=document.getElementById('retry'),cancel=document.getElementById('cancel'),frame=document.getElementById('dashboard');
 const controller=new AbortController();let objectUrl='',received=0,decoded=0,manifest=null,ready=false,startTimer=null;
 const diagnostic={phase:'starting',verifiedParts:0,compressedBytes:0,decodedBytes:0,ready:false,htmlHashComputed:false};
 window.dashboardTransport=diagnostic;
 const bytes=value=>(value/1024/1024).toFixed(1)+' MB';
 const abort=()=>{throw new DOMException('加载已取消','AbortError');};
 function state(phase,message,description,value){diagnostic.phase=phase;status.textContent=message;detail.textContent=description;if(value==null)progress.removeAttribute('value');else progress.value=Math.max(0,Math.min(100,value));}
 function fail(error){
  if(ready)return;
  if(startTimer)clearTimeout(startTimer);
  controller.abort();
  if(objectUrl){const unused=objectUrl;objectUrl='';frame.src='about:blank';URL.revokeObjectURL(unused);}
  diagnostic.error=String(error.message||error);diagnostic.phase='error';
  panel.hidden=false;frame.style.visibility='hidden';status.textContent=error.name==='AbortError'?'加载已取消':'暂时无法打开看板';
  detail.textContent=error.name==='AbortError'?'点击重新加载可以再次打开。':error.name==='TypeError'&&/fetch|network/i.test(error.message)?'网络连接中断，请检查网络后重新加载。':String(error.message||'连接异常，请稍后重新加载。');
  progress.hidden=true;cancel.hidden=true;retry.hidden=false;
 }
 function supported(){
  if(!window.isSecureContext||!window.crypto?.subtle)throw new Error('请通过HTTPS打开此网址，或在本机预览中使用localhost。');
  if(typeof DecompressionStream!=='function'||typeof ReadableStream!=='function'||typeof TransformStream!=='function'||!Blob.prototype.stream)throw new Error('当前浏览器不支持完整看板加载。请更新Chrome、Edge或Safari后重试。');
  try{new DecompressionStream('gzip');}catch(_){throw new Error('当前浏览器不支持gzip数据恢复，请更新浏览器后重试。');}
 }
 function validate(value){
  if(value?.schema!=='complete-html-gzip-parts.v1'||value.compression!=='gzip'||!Array.isArray(value.parts)||!value.parts.length)throw new Error('版本信息不完整，请重新加载。');
  if(!Number.isSafeInteger(value.htmlBytes)||value.htmlBytes<1||value.htmlBytes>536870912||!Number.isSafeInteger(value.compressedBytes)||value.compressedBytes<1||!/^[a-f0-9]{64}$/.test(value.htmlSha256))throw new Error('版本校验信息异常，请重新加载。');
  if(value.parts.some(part=>!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>20971520||!/^[a-f0-9]{64}$/.test(part.sha256)||new URL(part.url,location.href).origin!==location.origin)||value.parts.reduce((sum,part)=>sum+part.bytes,0)!==value.compressedBytes)throw new Error('数据分片信息异常，请重新加载。');
  return value;
 }
 async function hash(blob){const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');}
 async function download(part,index){
  if(controller.signal.aborted)abort();
  const response=await fetch(new URL(part.url,location.href),{credentials:'same-origin',cache:'force-cache',signal:controller.signal});
  if(!response.ok)throw new Error('数据暂时无法读取（HTTP '+response.status+'），请重新加载；若需要登录，请先完成登录。');
  if(!response.body)throw new Error('浏览器未返回完整数据流，请重新加载。');
  const reader=response.body.getReader(),chunks=[];let count=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;received+=value.byteLength;if(count>part.bytes)throw new Error('数据大小与版本不一致，请重新加载最新版本。');chunks.push(value);diagnostic.compressedBytes=received;state('downloading','正在读取看板 '+Math.floor(received/manifest.compressedBytes*100)+'%','第 '+(index+1)+' / '+manifest.parts.length+' 部分 · '+bytes(received)+' / '+bytes(manifest.compressedBytes),received/manifest.compressedBytes*100);}}finally{reader.releaseLock();}
  if(count!==part.bytes)throw new Error('数据传输中断，请检查网络后重新加载。');
  const blob=new Blob(chunks,{type:'application/octet-stream'});chunks.length=0;
  if(await hash(blob)!==part.sha256)throw new Error('数据校验未通过，可能是网络缓存或登录页面替代了数据，请重新加载。');
  diagnostic.verifiedParts++;return blob;
 }
 async function start(){
  supported();
  state('manifest','正在读取最新版本','固定网址会在每次刷新时检查当前版本。',null);
  const response=await fetch('./dashboard-manifest.json?updated='+Date.now(),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error('暂时无法读取版本信息（HTTP '+response.status+'），请重新加载。');
  try{manifest=validate(await response.json());}catch(error){if(error instanceof SyntaxError)throw new Error('版本信息无法读取，请先完成网站登录，再重新加载。');throw error;}
  diagnostic.version=manifest.version;diagnostic.expectedHtmlSha256=manifest.htmlSha256;document.title=manifest.title||'美国站经营数据看板';
  const parts=[];
  for(let index=0;index<manifest.parts.length;index++)parts.push(await download(manifest.parts[index],index));
  if(controller.signal.aborted)abort();
  state('decompressing','正在恢复完整看板','下载校验已完成，正在浏览器本地恢复页面。',0);
  const compressed=new Blob(parts,{type:'application/octet-stream'});parts.length=0;
  const counter=new TransformStream({transform(chunk,stream){if(controller.signal.aborted)abort();decoded+=chunk.byteLength;if(decoded>manifest.htmlBytes)throw new Error('页面恢复大小异常，加载已停止。');diagnostic.decodedBytes=decoded;state('decompressing','正在恢复完整看板 '+Math.floor(decoded/manifest.htmlBytes*100)+'%','恢复和校验在当前浏览器本地完成。',decoded/manifest.htmlBytes*100);stream.enqueue(chunk);}});
  let html;
  try{html=await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(counter)).blob();}catch(error){if(error.name==='AbortError')throw error;throw new Error('完整页面恢复失败，请重新加载；持续失败时请联系看板维护人员。');}
  if(html.size!==manifest.htmlBytes)throw new Error('完整页面大小校验未通过，请重新加载。');
  if(controller.signal.aborted)abort();
  state('starting-app','正在启动看板','数据已完整恢复，正在启动图表和查询模块。',null);
  objectUrl=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  frame.addEventListener('load',()=>{
   try{
    if(controller.signal.aborted)return;
    if(frame.contentWindow.location.href!==objectUrl)return;
    for(const selector of manifest.readySelectors||[])if(!frame.contentDocument.querySelector(selector))throw new Error('看板尚未正常启动，可能被浏览器策略阻止，请重新加载或更新浏览器。');
    if(startTimer)clearTimeout(startTimer);diagnostic.frameOrigin=frame.contentWindow.origin;diagnostic.ready=true;diagnostic.phase='ready';ready=true;frame.style.visibility='visible';panel.hidden=true;cancel.hidden=true;
   }catch(error){fail(error);}
  });
  frame.addEventListener('error',()=>fail(new Error('浏览器未能打开完整页面，请重新加载或联系维护人员。')));
  frame.src=objectUrl;
  startTimer=setTimeout(()=>{if(!ready)fail(new Error('看板启动时间较长，或被浏览器策略阻止。请重新加载或联系维护人员。'));},90000);
 }
 retry.addEventListener('click',()=>location.reload());
 cancel.addEventListener('click',()=>{controller.abort();fail(new DOMException('加载已取消','AbortError'));});
 window.addEventListener('pagehide',()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);});
 start().catch(fail);
})();
