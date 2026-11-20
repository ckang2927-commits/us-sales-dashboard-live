/* 基础与扩展压缩包分别校验、缓存和恢复。 */
(() => {
  'use strict';
  const get = id => document.getElementById(id);
  const panel = get('loading'), status = get('status'), detail = get('detail');
  const progress = get('progress'), retry = get('retry'), cancel = get('cancel'), frame = get('dashboard');
  const controller = new AbortController();
  const signal = controller.signal;
  const diagnostic = window.dashboardTransport = {
    phase:'manifest',ready:false,verifiedParts:0,networkParts:0,cacheHits:[],transport:'legacy',gzipFallback:false
  };
  const cacheName = 'us-sales-dashboard-compressed-v1';
  const cacheDirectory = new URL('./.dashboard-cache/v1/', location.href);
  const transfers = {base:{read:0,total:0},extension:{read:0,total:0}};
  const cap = 536870912;
  const hashPattern = /^[a-f0-9]{64}$/;
  let objectUrl = '', timer, lastPercent = -1, currentInterval;
  const hex = buffer => Array.from(new Uint8Array(buffer), item => item.toString(16).padStart(2,'0')).join('');
  const hash = async blob => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const partsValid = parts => Array.isArray(parts) && parts.length > 0 && parts.every(part => {
    if (typeof part?.url !== 'string' || !part.url) return false;
    try {
      const url = new URL(part.url, location.href);
      return url.origin === location.origin && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= 20971520 && hashPattern.test(part.sha256);
    } catch (_) { return false; }
  });
  const partsSize = parts => parts.reduce((sum,part) => sum + part.bytes, 0);
  const shownSize = value => (value / 1024 / 1024).toFixed(1) + ' MiB';
  function setState(phase, name, text, value) {
    diagnostic.phase = phase;
    status.textContent = name;
    detail.textContent = text;
    if (value == null) progress.removeAttribute('value'); else progress.value = value;
  }
  function stopWaiting() { clearTimeout(timer); clearInterval(currentInterval); }
  function fail(error) {
    if (diagnostic.ready || diagnostic.phase === 'error') return;
    stopWaiting();
    controller.abort();
    frame.style.visibility = 'hidden';
    if (objectUrl) {frame.src = 'about:blank'; URL.revokeObjectURL(objectUrl); objectUrl = '';}
    status.textContent = error.name === 'AbortError' ? '已取消打开明细' : '暂时无法打开完整明细';
    detail.textContent = error.name === 'AbortError' ? '可返回老板首页或重新打开明细。' : String(error.message || '网络连接异常，请重试。');
    diagnostic.phase = 'error';
    progress.hidden = true;
    cancel.hidden = true;
    retry.hidden = false;
  }
  function validate(m) {
    const e = m?.extension;
    if (m?.schema !== 'complete-html-gzip-parts.v1' || m.compression !== 'gzip' ||
        !partsValid(m.parts) || !partsValid(e?.parts) ||
        partsSize(m.parts) !== m.compressedBytes || partsSize(e.parts) !== e.bytes ||
        ![m.compressedSha256,m.htmlSha256,m.renderedHtmlSha256,e.sha256].every(value => hashPattern.test(value)) ||
        !Number.isSafeInteger(m.htmlBytes) || m.htmlBytes < 1 || m.htmlBytes > cap ||
        !Number.isSafeInteger(m.renderedHtmlBytes) || m.renderedHtmlBytes < 1 || m.renderedHtmlBytes > cap ||
        !Number.isSafeInteger(e.insertAt) || e.insertAt < 0 || e.insertAt > m.htmlBytes) {
      throw Error('发布清单校验失败。');
    }
    const edits = m.baseEdits || [];
    if (!Array.isArray(edits) || edits.length > 100) throw Error('明细补丁格式无效。');
    let cursor = 0, totalReplacementBytes = 0;
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) ||
          edit.start < cursor || edit.end <= edit.start || edit.end > e.insertAt ||
          typeof edit.replacement !== 'string' || !hashPattern.test(edit.originalSha256)) throw Error('明细补丁范围无效。');
      totalReplacementBytes += new TextEncoder().encode(edit.replacement).byteLength - (edit.end - edit.start);
      cursor = edit.end;
    }
    if (m.htmlBytes + totalReplacementBytes + e.bytes !== m.renderedHtmlBytes) throw Error('明细补丁长度不匹配。');
    return m;
  }
  function updateProgress(group, bytes) {
    transfers[group].read += bytes;
    const received = transfers.base.read + transfers.extension.read;
    const total = transfers.base.total + transfers.extension.total;
    const percent = Math.floor(100 * received / total);
    if (percent === lastPercent) return;
    lastPercent = percent;
    setState('downloading','正在读取明细 '+percent+'%','已读取 '+shownSize(received)+' / '+shownSize(total),percent);
  }
  async function download(part, group, transferSignal) {
    const response = await fetch(part.url, {credentials:'same-origin',cache:'force-cache',signal:transferSignal});
    if (!response.ok || !response.body) throw Error('数据文件暂不可用（HTTP '+response.status+'）。');
    diagnostic.networkParts++;
    const reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        transferSignal.throwIfAborted();
        count += value.byteLength;
        if (count > part.bytes) throw Error('数据文件大小不一致。');
        chunks.push(value);
        updateProgress(group,value.byteLength);
      }
    } finally { reader.releaseLock(); }
    if (count !== part.bytes) throw Error('数据文件传输不完整。');
    const blob = new Blob(chunks);
    if (await hash(blob) !== part.sha256) throw Error('数据文件校验不一致，请重新加载。');
    diagnostic.verifiedParts++;
    return blob;
  }
  async function parallelDownload(parts, group, limit) {
    signal.throwIfAborted();
    const transfer = new AbortController();
    const abort = () => transfer.abort(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    let next = 0;
    const results = new Array(parts.length);
    const workers = Array.from({length:Math.min(limit,parts.length)}, async () => {
      while (next < parts.length && !transfer.signal.aborted) {
        const index = next++;
        results[index] = await download(parts[index],group,transfer.signal);
      }
    });
    try {
      await Promise.all(workers);
      signal.throwIfAborted();
      return new Blob(results);
    } finally {
      transfer.abort();
      signal.removeEventListener('abort',abort);
    }
  }
  const isExpected = async (blob, descriptor) => blob.size === descriptor.bytes && await hash(blob) === descriptor.sha256;
  async function openCache() {
    try { return await window.caches?.open(cacheName); } catch (_) { return null; }
  }
  async function saveCached(cache, key, prefix, blob) {
    if (!cache) return;
    try {
      await cache.put(key,new Response(blob,{headers:{'Content-Type':'application/gzip'}}));
      const older = (await cache.keys()).filter(request => request.url.startsWith(prefix) && request.url !== key);
      await Promise.all(older.slice(0,-1).map(request => cache.delete(request)));
    } catch (_) { /* 缓存不可用时，明细仍通过网络读取。 */ }
  }
  async function readCached(cache, key, descriptor) {
    if (!cache) return null;
    try {
      const saved = await cache.match(key);
      if (!saved) return null;
      const blob = await saved.blob();
      if (await isExpected(blob,descriptor)) return blob;
      void cache.delete(key).catch(() => {});
    } catch (_) { /* 缓存缺失或读失败，继续取线上分片。 */ }
    return null;
  }
  async function readCompressed(descriptor, group, limit, cache, unpack = blob => blob) {
    const prefix = new URL(group+'-',cacheDirectory).href;
    const key = prefix + descriptor.sha256;
    const cached = await readCached(cache,key,descriptor);
    if (cached) {
      signal.throwIfAborted();
      const restored = await unpack(cached);
      signal.throwIfAborted();
      diagnostic.cacheHits.push(group);
      updateProgress(group,cached.size);
      return restored;
    }
    const blob = await parallelDownload(descriptor.parts,group,limit);
    if (!await isExpected(blob,descriptor)) throw Error('压缩数据合并校验失败。');
    signal.throwIfAborted();
    const restored = await unpack(blob);
    signal.throwIfAborted();
    void saveCached(cache,key,prefix,blob);
    return restored;
  }
  function validTransport(extension) {
    const transport = extension.transport;
    return transport?.compression === 'gzip' && Number.isSafeInteger(transport.bytes) && transport.bytes > 0 &&
      transport.bytes <= cap && hashPattern.test(transport.sha256) &&
      partsValid(transport.parts) && partsSize(transport.parts) === transport.bytes ? transport : null;
  }
  async function inflate(compressed, expectedBytes) {
    const decompressor = new DecompressionStream('gzip');
    let decoded = 0;
    const countBytes = new TransformStream({transform(chunk,stream) {
      signal.throwIfAborted();
      decoded += chunk.byteLength;
      if (decoded > expectedBytes) throw Error('解压数据大小超出发布清单。');
      stream.enqueue(chunk);
    }});
    const restored = await new Response(compressed.stream().pipeThrough(decompressor).pipeThrough(countBytes)).blob();
    if (restored.size !== expectedBytes) throw Error('解压后的明细数据不完整。');
    return restored;
  }
  async function readExtension(extension, transport, cache) {
    if (transport) try {
      const restored = await readCompressed(transport,'extension',2,cache,async compressed => {
        const extensionBlob = await inflate(compressed,extension.bytes);
        if (!await isExpected(extensionBlob,extension)) throw Error('明细更新数据校验失败。');
        return extensionBlob;
      });
      diagnostic.transport = 'gzip';
      return restored;
    } catch (_) {
      signal.throwIfAborted();
      diagnostic.gzipFallback = true;
      transfers.extension = {read:0,total:extension.bytes};
      updateProgress('extension',0);
    }
    const restored = await parallelDownload(extension.parts,'extension',2);
    if (!await isExpected(restored,extension)) throw Error('明细更新数据校验失败。');
    return restored;
  }
  async function assemble(base, extensions, manifest) {
    const chunks = [];
    let cursor = 0;
    for (const edit of manifest.baseEdits || []) {
      const section = base.slice(edit.start,edit.end);
      if (await hash(section) !== edit.originalSha256) throw Error('明细补丁与基础数据不符。');
      chunks.push(base.slice(cursor,edit.start), edit.replacement);
      cursor = edit.end;
    }
    const offset = manifest.extension.insertAt;
    chunks.push(base.slice(cursor,offset), ...extensions, base.slice(offset));
    return new Blob(chunks,{type:'text/html;charset=utf-8'});
  }
  function navigate() {
    const view = new URLSearchParams(location.search).get('view') || 'sales';
    let sku;
    if (view === 'query') try {
      sku = sessionStorage.getItem('bossPendingSku');
      sessionStorage.removeItem('bossPendingSku');
    } catch (_) { /* Details still open to SKU query. */ }
    frame.contentWindow.bossOpenDetail(view, sku);
  }
  function launch(app, manifest) {
    objectUrl = URL.createObjectURL(app);
    const selectors = [...(manifest.readySelectors || []), ...(manifest.extension.readySelectors || [])];
    function revealIfReady() {
      if (signal.aborted || diagnostic.ready) return;
      try {
        if (frame.contentWindow.location.href !== objectUrl) return;
        const doc = frame.contentDocument;
        if (!doc || selectors.some(selector => !doc.querySelector(selector))) return;
        if (typeof frame.contentWindow.bossOpenDetail !== 'function') return;
        navigate();
        stopWaiting();
        diagnostic.ready = true;
        diagnostic.phase = 'ready';
        frame.style.visibility = 'visible';
        panel.hidden = true;
        window.dispatchEvent(new Event('dashboard-ready'));
      } catch (error) {
        fail(error);
      }
    }
    frame.addEventListener('load',revealIfReady);
    currentInterval = setInterval(revealIfReady,500);
    timer = setTimeout(() => fail(Error('明细启动超时。可使用老板首页，或在桌面浏览器重试完整明细。')),180000);
    frame.src = objectUrl;
  }
  async function start() {
    if (!window.isSecureContext || !crypto.subtle || typeof DecompressionStream !== 'function') {
      throw Error('请在支持数据解压的新版浏览器中打开明细。');
    }
    const response = await fetch('./dashboard-manifest.json?updated='+Date.now(),{cache:'no-store',credentials:'same-origin',signal});
    if (!response.ok) throw Error('暂时无法读取发布版本（HTTP '+response.status+'）。');
    const manifest = validate(await response.json());
    diagnostic.version = manifest.version;
    const transport = validTransport(manifest.extension);
    const baseDescriptor = {parts:manifest.parts,bytes:manifest.compressedBytes,sha256:manifest.compressedSha256};
    transfers.base.total = baseDescriptor.bytes;
    transfers.extension.total = transport?.bytes ?? manifest.extension.bytes;
    const cache = await openCache();
    const [compressed,extension] = await Promise.all([
      readCompressed(baseDescriptor,'base',4,cache),
      readExtension(manifest.extension,transport,cache)
    ]);
    setState('decompressing','正在恢复明细','分片校验完成，正在本机解压。',null);
    const base = await inflate(compressed,manifest.htmlBytes);
    const app = await assemble(base,[extension],manifest);
    if (app.size !== manifest.renderedHtmlBytes) throw Error('最终明细大小与发布清单不符。');
    signal.throwIfAborted();
    setState('starting-app','正在启动经营明细','启动后会直接进入所选模块。',null);
    launch(app,manifest);
  }
  retry.addEventListener('click',() => location.reload());
  cancel.addEventListener('click',() => fail(new DOMException('已取消','AbortError')));
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopWaiting();
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
  start().catch(fail);
})();
