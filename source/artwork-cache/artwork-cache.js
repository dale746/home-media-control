/* Home Media optional saved artwork. Only tagged same-origin Jellyfin images. */
(function () {
  'use strict';
  const MAX_BYTES=1000000000,MAX_IMAGE_BYTES=8*1024*1024;
  const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/avif']);
  function imageIdentity(raw,base) {
    try {
      const origin=new URL(base),url=new URL(raw,origin);
      if(!/^https?:$/.test(url.protocol)||url.origin!==origin.origin||url.username||url.password)return null;
      if(!/^\/(?:jellyfin\/)?Items\/[a-f\d]{32}\/Images\/(?:Primary|Backdrop|Thumb|Logo|Banner|Art|Disc|Box|BoxRear)(?:\/\d+)?$/i.test(url.pathname))return null;
      const tag=url.searchParams.get('tag');
      if(!/^[a-z\d_.-]{8,128}$/i.test(tag||''))return null;
      const permitted=new Set(['tag','quality','fillheight','fillwidth','maxheight','maxwidth','width','height','format','blur','foregroundlayer','backgroundcolor','enableimageenhancers','cropwhitespace']);
      const secret=new Set(['api_key','apikey','access_token','token']);
      const safe=new URLSearchParams();
      for(const [key,value] of url.searchParams) {
        const name=key.toLowerCase();
        if(secret.has(name))continue;
        if(!permitted.has(name))return null;
        if(/^(?:fill|max)?(?:height|width)$/.test(name)&&(!/^\d+$/.test(value)||Number(value)>4096))return null;
        safe.append(name,value);
      }
      safe.sort();
      return {key:url.pathname+'?'+safe.toString(),url:url.href};
    } catch(_){return null;}
  }
  function cacheableImage(type,size) {
    return IMAGE_TYPES.has(String(type||'').split(';')[0].toLowerCase())&&Number.isSafeInteger(size)&&size>0&&size<=MAX_IMAGE_BYTES;
  }
  function bytesToEvict(total,replaced,incoming,limit=MAX_BYTES) {
    return Math.max(0,Math.max(0,total)-Math.max(0,replaced)+Math.max(0,incoming)-Math.min(MAX_BYTES,Math.max(0,limit)));
  }
  function scopeKey(server,user) {
    return String(server||'')+'\n'+String(user||'');
  }
  if(typeof document==='undefined') {
    if(typeof module!=='undefined')module.exports={imageIdentity,cacheableImage,bytesToEvict,scopeKey,MAX_BYTES,MAX_IMAGE_BYTES};
    return;
  }
  if(window.HomeMediaArtworkCache)return;
  const config=window.HomeMediaArtworkCacheConfig||{};
  const limit=Math.min(MAX_BYTES,Math.max(0,Number(config.maxBytes)||MAX_BYTES));
  const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)&&!/VIDAA|SMART-TV|Android TV|AFT/i.test(navigator.userAgent);
  const configKey='hmc-saved-artwork-enabled-v1';
  let enabled=typeof config.enabledByDefault==='boolean'?config.enabledByDefault:mobile;
  try {const saved=localStorage.getItem(configKey);if(saved!==null)enabled=saved==='1';}catch(_){}
  let dbPromise=null,writeQueue=Promise.resolve(),scope='',epoch=0,storageProblem='',writesBlocked=false;
  let scrollUntil=0,workTimer=null,cleanTimer=null,running=0,dialog=null,hits=0,suspendCapture=false,opener=null;
  const queue=[],pending=new Set(),queued=new WeakMap(),states=new WeakMap(),active=new Set(),known=new Set(),inView=new Set();
  const isPlayer=()=>/^#!?\/(?:video|videoosd|player)(?:[/?]|$)/i.test(location.hash);
  function requestValue(request) {return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  function transactionDone(tx) {return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage transaction stopped'));});}
  function openDb() {
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB){reject(Error('Saved artwork is unavailable on this device.'));return;}
      const request=indexedDB.open('hmc-saved-artwork-v1',1);
      const timer=setTimeout(()=>reject(Error('Saved artwork storage is unavailable.')),4000);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('images',{keyPath:'key'});
        const meta=db.createObjectStore('meta',{keyPath:'key'});meta.createIndex('used','used');
        db.createObjectStore('totals');
      };
      request.onsuccess=()=>{clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result);};
      request.onerror=()=>{clearTimeout(timer);reject(request.error||Error('Saved artwork is unavailable.'));};
      request.onblocked=()=>{clearTimeout(timer);reject(Error('Close other Movies windows to enable saved artwork.'));};
    }).catch(error=>{storageProblem=error.message||'Saved artwork is unavailable on this device.';throw error;});
    return dbPromise;
  }
  function release(element,restore) {
    const state=states.get(element);if(!state)return;
    if(state.objectUrl) {
      // Only replace a value we still own; a React update may already have changed it.
      if(restore&&element.isConnected) {
        if(state.kind==='img'&&element.getAttribute('src')===state.objectUrl)element.setAttribute('src',state.original);
        if(state.kind==='background'&&element.style.backgroundImage.includes(state.objectUrl))element.style.backgroundImage=state.original;
      }
      URL.revokeObjectURL(state.objectUrl);
    }
    states.delete(element);active.delete(element);
  }
  function currentScope() {
    const api=window.ApiClient,user=api?.getCurrentUserId?.();
    if(!user||/login|signin|selectserver|quickconnect/i.test(location.hash))return '';
    let server=location.origin;
    try {if(typeof api.serverId==='function')server+='|'+api.serverId();}catch(_){}
    return scopeKey(server,user);
  }
  function checkScope() {
    const next=currentScope();
    if(next!==scope){scope=next;epoch++;queue.length=0;pending.clear();for(const element of [...active])release(element,true);}
    return scope;
  }
  async function readImage(key) {
    const db=await openDb(),tx=db.transaction('images','readonly');
    return requestValue(tx.objectStore('images').get(key));
  }
  function touch(key) {
    return serial(async()=>{
      const db=await openDb(),tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta'),request=store.get(key);
      request.onsuccess=()=>{if(request.result)store.put({...request.result,used:Date.now()});};
      await transactionDone(tx);
    });
  }
  function serial(job) {
    const result=writeQueue.then(job);writeQueue=result.catch(()=>{});return result;
  }
  function saveImage(key,owner,blob,version) {
    return serial(async()=>{
      if(writesBlocked||version!==epoch||owner!==scope||!enabled||blob.size>limit)return;
      const db=await openDb();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['images','meta','totals'],'readwrite'),images=tx.objectStore('images'),meta=tx.objectStore('meta'),totals=tx.objectStore('totals');
        let total,old,ready=0;
        const totalRequest=totals.get('bytes'),oldRequest=meta.get(key);
        totalRequest.onsuccess=()=>{total=Number(totalRequest.result)||0;finishRead();};
        oldRequest.onsuccess=()=>{old=oldRequest.result;finishRead();};
        function finishRead(){if(++ready<2)return;let needed=bytesToEvict(total,old?.size||0,blob.size,limit);
          if(needed) {
            const cursorRequest=meta.index('used').openCursor();
            cursorRequest.onsuccess=()=>{
              const cursor=cursorRequest.result;
              if(!cursor||needed<=0){store();return;}
              if(cursor.primaryKey!==key){const entry=cursor.value;needed-=entry.size;total-=entry.size;meta.delete(entry.key);images.delete(entry.key);}
              cursor.continue();
            };
          } else store();
        }
        function store(){
          const next=total-(old?.size||0)+blob.size;
          if(next>limit){tx.abort();return;}
          images.put({key,blob});meta.put({key,scope:owner,size:blob.size,used:Date.now()});totals.put(next,'bytes');
        }
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Artwork cache capacity reached'));
      });
    }).catch(error=>{
      if(error?.name==='QuotaExceededError'){writesBlocked=true;storageProblem='This device has no more artwork space. Existing saved pictures can still be reused.';}
      else if(!storageProblem)storageProblem='Some artwork could not be saved. Normal browsing still works.';
    });
  }
  function candidate(element) {
    if(!element?.isConnected||element.closest?.('#hmc-artwork-dialog'))return null;
    if(element.tagName==='IMG') {
      if(element.getAttribute('srcset'))return null;
      const original=element.getAttribute('src');
      if(!original||original.startsWith('blob:'))return null;
      const identity=imageIdentity(original,location.href);
      return identity?{kind:'img',original,...identity}:null;
    }
    const original=element.style?.backgroundImage||'';
    const match=/^url\(["']?([^"')]+)["']?\)$/.exec(original);
    const identity=match&&imageIdentity(match[1],location.href);
    return identity?{kind:'background',original,...identity}:null;
  }
  function visible(element) {const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>=0&&r.top<=innerHeight+100&&r.right>=0&&r.left<=innerWidth;}
  function enqueue(element) {
    if(!enabled||suspendCapture||isPlayer()||!checkScope())return;
    const item=candidate(element);if(!item)return;
    const old=states.get(element);
    if(old?.key===item.key&&old.scope===scope)return;
    if(old)release(element,false);
    const key=scope+'\n'+item.key;
    if(queued.get(element)===key)return;
    queued.set(element,key);queue.push({element,item,key,scope,epoch});schedule();
  }
  const intersection=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){inView.add(entry.target);enqueue(entry.target);}else inView.delete(entry.target);}},{rootMargin:'100px'}):null;
  function consider(element) {
    if(!element||element.nodeType!==1)return;
    if(!candidate(element))return;
    if(intersection){if(!known.has(element)){known.add(element);intersection.observe(element);}else if(inView.has(element))enqueue(element);}
    else enqueue(element);
  }
  function discover(root) {
    if(root.nodeType!==1&&root!==document)return;
    consider(root);
    root.querySelectorAll?.('img,[style*="url("]').forEach(consider);
  }
  function stillCurrent(job) {
    return enabled&&!suspendCapture&&!isPlayer()&&job.epoch===epoch&&job.scope===checkScope()&&job.element.isConnected&&candidate(job.element)?.key===job.item.key;
  }
  function apply(job,blob) {
    if(!stillCurrent(job)||!cacheableImage(blob.type,blob.size))return;
    const state={...job.item,scope:job.scope,objectUrl:null};states.set(job.element,state);active.add(job.element);
    // A completed native image already came from the ordinary HTTP cache; leave
    // its src and React load lifecycle alone. Blob fallback helps cold reloads.
    if(job.item.kind==='img'&&job.element.complete&&job.element.naturalWidth>0)return;
    const objectUrl=URL.createObjectURL(blob);state.objectUrl=objectUrl;
    if(job.item.kind==='img')job.element.setAttribute('src',objectUrl);
    else job.element.style.backgroundImage='url("'+objectUrl+'")';
  }
  function nativeLoaded(job) {
    if(job.item.kind!=='img'||job.element.complete)return Promise.resolve();
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);job.element.removeEventListener('load',finish);job.element.removeEventListener('error',finish);resolve();};
      const timer=setTimeout(finish,10000);job.element.addEventListener('load',finish,{once:true});job.element.addEventListener('error',finish,{once:true});
    });
  }
  async function fetchImage(job) {
    await nativeLoaded(job);
    if(!stillCurrent(job)||writesBlocked)return;
    if(job.item.kind==='img'&&(!job.element.complete||!job.element.naturalWidth))return;
    // No prefetch: use the browser's immutable image response whenever present.
    const token=window.ApiClient?.accessToken?.(),headers={};
    if(token)headers.Authorization='MediaBrowser Client="HomeMedia artwork", Device="Browser", DeviceId="hmc-artwork", Version="1.0", Token="'+String(token).replace(/["\\]/g,'')+'"';
    const controller=typeof AbortController==='function'?new AbortController():null;
    const timer=controller?setTimeout(()=>controller.abort(),12000):null;
    try {
      const response=await fetch(job.item.url,{credentials:'same-origin',cache:'force-cache',redirect:'error',headers,...(controller?{signal:controller.signal}:{})});
      const type=response.headers.get('Content-Type')||'',size=Number(response.headers.get('Content-Length'));
      if(!response.ok||!IMAGE_TYPES.has(type.split(';')[0].toLowerCase())||(size&&size>MAX_IMAGE_BYTES))return;
      const blob=await response.blob();
      if(cacheableImage(blob.type,blob.size)&&stillCurrent(job))await saveImage(job.key,job.scope,blob,job.epoch);
    } catch(_){}finally{if(timer)clearTimeout(timer);}
  }
  async function work(job) {
    if(!stillCurrent(job)||!visible(job.element))return;
    try {
      const saved=await readImage(job.key);
      if(!stillCurrent(job))return;
      if(saved?.blob&&cacheableImage(saved.blob.type,saved.blob.size)){hits++;apply(job,saved.blob);touch(job.key).catch(()=>{});return;}
      if(pending.has(job.key))return;
      pending.add(job.key);
      try {await fetchImage(job);}finally{pending.delete(job.key);}
      if(stillCurrent(job)){states.set(job.element,{...job.item,scope:job.scope,objectUrl:null});active.add(job.element);}
    } catch(_){}
  }
  function schedule() {
    if(workTimer||!queue.length)return;
    workTimer=setTimeout(()=>{workTimer=null;if(Date.now()<scrollUntil){schedule();return;}pump();},Math.max(50,scrollUntil-Date.now()));
  }
  function pump() {
    if(!enabled||isPlayer()){queue.length=0;return;}
    while(running<2&&queue.length) {
      const job=queue.shift();queued.delete(job.element);running++;
      work(job).finally(()=>{running--;schedule();});
    }
  }
  function cleanRemoved() {
    for(const element of [...known])if(!element.isConnected){intersection?.unobserve(element);known.delete(element);inView.delete(element);release(element,false);}
  }
  const observer=new MutationObserver(records=>{
    if(!enabled)return;
    checkScope();
    for(const record of records) {
      if(record.type==='attributes')consider(record.target);
      else for(const node of record.addedNodes)if(node.nodeType===1)discover(node);
    }
    if(records.some(record=>record.removedNodes?.length)&&!cleanTimer)cleanTimer=setTimeout(()=>{cleanTimer=null;cleanRemoved();},500);
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src','style']});
  document.addEventListener('scroll',()=>{scrollUntil=Date.now()+250;if(queue.length)schedule();},{capture:true,passive:true});
  window.addEventListener('hashchange',()=>{suspendCapture=false;checkScope();if(!isPlayer())setTimeout(()=>discover(document),150);});
  window.addEventListener('pagehide',()=>{epoch++;for(const element of [...active])release(element,false);});
  setInterval(()=>{checkScope();cleanRemoved();},15000);
  function formatBytes(bytes){return bytes<1000000?(bytes/1000).toFixed(0)+' KB':(bytes/1000000).toFixed(1)+' MB';}
  async function stats() {
    const owner=checkScope(),db=await openDb(),tx=db.transaction(['meta','totals'],'readonly');
    const [entries,total]=await Promise.all([requestValue(tx.objectStore('meta').getAll()),requestValue(tx.objectStore('totals').get('bytes'))]);
    const current=entries.filter(e=>e.scope===owner);
    return {enabled,count:current.length,bytes:current.reduce((n,e)=>n+e.size,0),totalBytes:Number(total)||0,maxBytes:limit,hits,error:storageProblem};
  }
  async function clear() {
    epoch++;suspendCapture=true;queue.length=0;for(const element of [...active])release(element,true);
    await serial(async()=>{const db=await openDb(),tx=db.transaction(['images','meta','totals'],'readwrite');for(const name of ['images','meta','totals'])tx.objectStore(name).clear();await transactionDone(tx);});
    writesBlocked=false;storageProblem='';hits=0;
  }
  function setEnabled(value) {
    enabled=!!value;epoch++;suspendCapture=false;queue.length=0;
    try {localStorage.setItem(configKey,enabled?'1':'0');}catch(_){}
    if(!enabled)for(const element of [...active])release(element,true);
    else discover(document);
  }
  function open() {
    opener=document.activeElement;
    if(dialog){dialog.hidden=false;dialog.querySelector('#hmc-artwork-close').focus();refreshStats();return;}
    const style=document.createElement('style');style.textContent='#hmc-artwork-dialog{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:#000b;padding:16px;color:#f5f5f7;font:16px/1.5 system-ui,sans-serif}#hmc-artwork-dialog[hidden]{display:none}#hmc-artwork-dialog .panel{background:#17171e;border:1px solid #777;border-radius:12px;padding:22px;max-width:470px;max-height:85vh;overflow:auto}#hmc-artwork-dialog button{min-height:44px;color:#fff;background:#30303b;border:1px solid #777;border-radius:7px;padding:8px 14px;margin:5px;cursor:pointer}#hmc-artwork-dialog button:focus-visible{outline:3px solid #ffd45b}#hmc-artwork-dialog label{display:flex;gap:12px;padding:10px 0}#hmc-artwork-dialog input{width:22px;height:22px}#hmc-artwork-dialog small{color:#c4c4ce}';document.head.appendChild(style);
    dialog=document.createElement('div');dialog.id='hmc-artwork-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','hmc-artwork-title');
    dialog.innerHTML='<div class="panel"><h2 id="hmc-artwork-title">Saved artwork</h2><p>Keep browsed posters and backgrounds on this device. Movies still stream when you press Play.</p><label><input type="checkbox" id="hmc-artwork-enabled">Save artwork on this device</label><p id="hmc-artwork-stats" role="status">Checking saved pictures…</p><p><small>Up to 1 GB, filled as you browse. Your device may provide less space or clear cached data. The normal browser image cache is managed separately.</small></p><button type="button" id="hmc-artwork-clear">Clear saved artwork</button><button type="button" id="hmc-artwork-close">Close</button></div>';
    document.body.appendChild(dialog);
    dialog.querySelector('#hmc-artwork-enabled').checked=enabled;
    dialog.querySelector('#hmc-artwork-enabled').onchange=event=>{setEnabled(event.target.checked);refreshStats();};
    dialog.querySelector('#hmc-artwork-clear').onclick=async event=>{event.target.disabled=true;try{await clear();await refreshStats();}catch(_){dialog.querySelector('#hmc-artwork-stats').textContent='Saved artwork is unavailable. Normal browsing still works.';}finally{event.target.disabled=false;}};
    const close=()=>{dialog.hidden=true;if(opener?.isConnected)opener.focus({preventScroll:true});};dialog.querySelector('#hmc-artwork-close').onclick=close;
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    dialog.addEventListener('keydown',event=>{
      if(['Escape','BrowserBack','GoBack'].includes(event.key)){event.preventDefault();event.stopPropagation();close();}
      if(event.key==='Tab'){
        const controls=[...dialog.querySelectorAll('input,button')].filter(e=>!e.disabled),at=controls.indexOf(document.activeElement);
        if((event.shiftKey&&at<=0)||(!event.shiftKey&&at===controls.length-1)){event.preventDefault();controls[event.shiftKey?controls.length-1:0]?.focus();}
      }
    });
    dialog.querySelector('#hmc-artwork-close').focus();refreshStats();
  }
  async function refreshStats() {
    if(!dialog||dialog.hidden)return;
    const output=dialog.querySelector('#hmc-artwork-stats');dialog.querySelector('#hmc-artwork-enabled').checked=enabled;
    try {const s=await stats();output.textContent=s.error||s.count+' saved pictures · '+formatBytes(s.bytes)+' on this account · '+formatBytes(s.totalBytes)+' of '+formatBytes(s.maxBytes)+' managed limit. '+s.hits+' local image matches this visit.';}
    catch(_){output.textContent=storageProblem||'Saved artwork is unavailable on this device. Normal browsing still works.';}
  }
  document.addEventListener('hmc-artwork-open',open);
  window.HomeMediaArtworkCache=Object.freeze({open,stats,clear,setEnabled,version:'1.0.0'});
  if(enabled){checkScope();setTimeout(()=>discover(document),500);}
}());
