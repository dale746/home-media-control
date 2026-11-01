/* Home Media browsing controls: previous place, and trailers as ordinary links. */
(function () {
  'use strict';
  function youtubeLink(raw) {
    try {
      const u = new URL(raw);
      if (u.username || u.password) return null;
      let id = null;
      if (u.protocol === 'plugin:' && u.hostname === 'plugin.video.youtube') {
        id = u.searchParams.get('video_id') || u.searchParams.get('videoid');
      } else if (/^https?:$/.test(u.protocol)) {
        const host = u.hostname.toLowerCase();
        if (host === 'youtu.be') id = u.pathname.split('/')[1];
        else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
          id = u.searchParams.get('v');
          if (!id && /^\/(embed|shorts|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
        }
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? 'https://www.youtube.com/watch?v=' + id : null;
    } catch (_) { return null; }
  }
  function markedState(state, key) {
    return Object.assign({}, state && typeof state === 'object' ? state : {}, { __hmcBrowse: key });
  }
  function preferLogicalBack(nativeShell,reactNativeWebView,classes) {
    return !!(nativeShell||reactNativeWebView)&&!/(?:^|\s)layout-tv(?:\s|$)/.test(classes||'');
  }
  function isWindowPageHide(event,win) {
    if(event.target===win)return true;
    return event.target===win.document&&typeof win.PageTransitionEvent==='function'&&event instanceof win.PageTransitionEvent;
  }
  function jellyfinRoute(raw,currentUrl) {
    try {
      const current=new URL(currentUrl),target=new URL(raw,current);
      const webPath=path=>/^\/web\/(?:index\.html)?$/.test(path);
      if(target.origin!==current.origin||target.username||target.password||!webPath(target.pathname)||!webPath(current.pathname)||target.search!==current.search)return null;
      const route=target.hash.replace(/^#!?\//,'/');
      return /^\/(?!\/)[^#]*$/.test(route)&&!route.includes('://')?route:null;
    }catch(_){return null;}
  }
  function nativeRouteChange({router,target,currentUrl,isCurrent,onBeforeShow=()=>{},onFailure=()=>{},later=setTimeout,cancelLater=clearTimeout,timeout=5000}) {
    const route=jellyfinRoute(target,currentUrl);
    return new Promise(resolve=>{
      let finished=false,showStarted=false;
      const timer=later(()=>finish('timeout'),timeout);
      function finish(result,error) {
        if(finished)return;finished=true;cancelLater(timer);
        if((result==='timeout'||result==='error'||result==='invalid')&&isCurrent())try{onFailure(result,error);}catch(_){}
        resolve(result);
      }
      if(!route){finish('invalid');return;}
      // show() also waits for ready internally. Check first so a late view-load
      // completion cannot issue an abandoned Back after the user goes elsewhere.
      Promise.resolve().then(()=>typeof router.ready==='function'?router.ready():null).then(()=>{
        if(finished)return;
        if(!isCurrent()){finish('cancelled');return;}
        onBeforeShow(route);showStarted=true;
        return router.show(route);
      }).then(()=>{if(!finished)finish(showStarted?'shown':'cancelled');},error=>finish('error',error));
    });
  }
  function createBackNavigation({read,goBack,goLogical,later=setTimeout,cancelLater=clearTimeout,delay=700}) {
    let pending=null;
    function cancel(){if(pending?.timer!==undefined)cancelLater(pending.timer);pending=null;}
    function settled(){if(pending&&(read().key!==pending.key||read().url!==pending.url))cancel();}
    function logicalAttempt(parent,target,attempt){
      const work=goLogical(parent,target,()=>pending===attempt&&read().key===attempt.key&&read().url===attempt.url);
      if(work&&typeof work.then==='function'){
        // The native route adapter bounds its own async wait. Keep one Back
        // owner throughout that wait instead of reopening the guard at 700ms.
        Promise.resolve(work).then(()=>{if(pending===attempt)cancel();},()=>{if(pending===attempt)cancel();});
        return;
      }
      // A failed navigation may be retried, but rapid taps must not traverse
      // multiple entries before the WebView has delivered its route event.
      if(pending===attempt)attempt.timer=later(()=>{if(pending===attempt)cancel();},delay);
    }
    return {cancel,settled,request(parent,target,logical=false,intent='back'){
      settled();
      // Back is an escape, including while a hero's forward route is still
      // loading. Replace that pending intent instead of swallowing the press.
      if(pending&&intent==='back'&&pending.intent==='forward')cancel();
      if(pending)return false;
      const before=read(),attempt={...before,intent};pending=attempt;
      if(logical){
        logicalAttempt(parent,target,attempt);
      }else{
        goBack();
        if(pending===attempt)attempt.timer=later(()=>{
          if(pending!==attempt)return;
          const value=read();attempt.timer=undefined;
          if(value.key===before.key&&value.url===before.url)logicalAttempt(parent,target,attempt);else cancel();
        },delay);
      }
      return true;
    }};
  }
  function settledWithin(work, milliseconds) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), milliseconds);
      Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
    });
  }
  function updateScrollRecord(page, position, offsets) {
    let changed=!page.window||page.window[0]!==position[0]||page.window[1]!==position[1];
    const saved=new Map((page.scroll||[]).map(([selector,x,y])=>[selector,[x,y]]));
    for(const [selector,x,y] of offsets) {
      const old=saved.get(selector);
      if(x||y) {
        if(!old||old[0]!==x||old[1]!==y){saved.set(selector,[x,y]);changed=true;}
      } else if(saved.delete(selector))changed=true;
    }
    if(changed){page.window=position;page.scroll=[...saved].map(([selector,[x,y]])=>[selector,x,y]);}
    return changed;
  }
  function readRemoteConfig(raw) {
    if(!raw||typeof raw!=='object')return null;
    const config={};
    for(const key of ['movieOrigin','discoverOrigin','portalOrigin']) {
      try {
        if(typeof raw[key]!=='string')return null;
        const u=new URL(raw[key]);
        if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.hostname.includes('*'))return null;
        config[key]=u.origin;
      } catch(_){return null;}
    }
    return Object.freeze(config);
  }
  const REMOTE=readRemoteConfig(typeof window!=='undefined'?window.HomeMediaRemoteConfig:null);
  function isRemoteContext(currentUrl,config) {
    if(!config)return false;
    try {const u=new URL(currentUrl);return !u.username&&!u.password&&Object.values(config).includes(u.origin);}catch(_){return false;}
  }
  function rewriteOwnedUrl(raw,currentUrl,rawConfig) {
    const config=rawConfig?readRemoteConfig(rawConfig):REMOTE;
    if(!isRemoteContext(currentUrl,config))return raw;
    try {
      const u=new URL(raw);
      if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return raw;
      let origin=null;
      if((u.hostname==='media-discover.local'&&['','80'].includes(u.port))||(u.hostname==='192.0.2.10'&&u.port==='5055'))origin=config.discoverOrigin;
      else if(['192.0.2.10','media-movies.local'].includes(u.hostname)) {
        if(['','80'].includes(u.port)&&/^\/(?:status|hmc-hold)(?:\/|$)/.test(u.pathname))origin=config.portalOrigin;
        else if(['','80','8096'].includes(u.port)&&/^\/web(?:\/|$)/.test(u.pathname))origin=config.movieOrigin;
      }
      if(!origin)return raw;
      const target=new URL(origin);target.pathname=u.pathname;target.search=u.search;target.hash=u.hash;
      if(origin===config.movieOrigin)target.hash=target.hash.replace(/^#!\/?/,'#/');
      return target.href;
    }catch(_){return raw;}
  }
  function isDiscoveryUrl(raw,rawConfig) {
    const config=rawConfig?readRemoteConfig(rawConfig):REMOTE;
    try {
      const u=new URL(raw);
      if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return false;
      return u.origin===config?.discoverOrigin||(u.hostname==='media-discover.local'&&['','80'].includes(u.port))||(u.hostname==='192.0.2.10'&&u.port==='5055');
    }catch(_){return false;}
  }
  function isDownloadProgressUrl(raw,rawConfig) {
    const config=rawConfig?readRemoteConfig(rawConfig):REMOTE;
    try {
      const u=new URL(raw);
      if(u.username||u.password||!['http:','https:'].includes(u.protocol))return false;
      if(u.origin===config?.portalOrigin)return ['/status','/status/'].includes(u.pathname)&&u.hash==='#downloads';
      if(!['192.0.2.10','media-movies.local','media-server.local'].includes(u.hostname))return false;
      return u.port==='8080'||(['','80','443'].includes(u.port)&&['/status','/status/'].includes(u.pathname)&&u.hash==='#downloads');
    } catch(_){return false;}
  }
  function isPlayerUrl(raw) {
    try { return /^#\/(?:video|videoosd|player)(?:[/?]|$)/i.test(new URL(raw).hash); } catch (_) { return false; }
  }
  function safeMoviesReturn(raw,rawConfig) {
    const config=rawConfig?readRemoteConfig(rawConfig):REMOTE;
    try {
      const u=new URL(raw);
      const local=['192.0.2.10','media-movies.local'].includes(u.hostname)&&['','80','8096'].includes(u.port);
      if (!['http:','https:'].includes(u.protocol) || u.username || u.password || (!local&&u.origin!==config?.movieOrigin) || !/^\/web(?:\/|$)/.test(u.pathname)) return null;
      u.hash=u.hash.replace(/^#!\/?/,'#/');
      const query=new URLSearchParams(u.hash.split('?')[1]||'');
      for (const key of [...query.keys()]) if (!['id','topParentId','parentId','collectionType','query','tab','serverId','type','genreId','personId','tag','year','startIndex'].includes(key)) query.delete(key);
      let route=u.hash.split('?')[0];
      if (!/^#\/(?:home|movies|tv|details|search|boxsets|homevideos|list|livetv)(?:$|\/)/.test(route)) route='#/home';
      const suffix=query.toString();u.search='';u.hash=route+(suffix?'?'+suffix:'');return u.href;
    } catch (_) { return null; }
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Object.assign(module.exports || {}, { youtubeLink, markedState, preferLogicalBack, isWindowPageHide, jellyfinRoute, nativeRouteChange, createBackNavigation, settledWithin, isPlayerUrl, safeMoviesReturn, isDownloadProgressUrl, updateScrollRecord, readRemoteConfig, rewriteOwnedUrl, isDiscoveryUrl });
    return;
  }
  window.HomeMediaRemoteLinks={url:raw=>rewriteOwnedUrl(raw,location.href)};
  if (document.documentElement.dataset.hmcBrowse) return;
  document.documentElement.dataset.hmcBrowse = '1.3.4';
  const movies = location.pathname.startsWith('/web');
  const storageKey = 'hmc-browse-v1';
  const push = history.pushState.bind(history), replace = history.replaceState.bind(history);
  const freshKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  let records = {}, current, restoring = false, restoreTimer, scrollTimer, updateTimer,backNavigation=null;
  let cancelIdleScroll=null,scrollOwner=null,scrollSelectors=new WeakMap();
  const scrollNodes=new Set();
  let outbound=null,returnToMovies=rewriteOwnedUrl('http://192.0.2.10:8096/web/#/home',location.href);
  try { outbound=JSON.parse(sessionStorage.getItem('hmc-outbound')||'null'); } catch (_) {}
  if (!movies) {
    try {
      const incoming=safeMoviesReturn(rewriteOwnedUrl(new URL(location.href).searchParams.get('hmcReturn'),location.href));
      returnToMovies=incoming||safeMoviesReturn(rewriteOwnedUrl(sessionStorage.getItem('media-movies-return'),location.href))||returnToMovies;
      sessionStorage.setItem('media-movies-return',returnToMovies);
    } catch (_) {}
  }
  try { records = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch (_) {}
  function persist() {
    const keys = Object.keys(records);
    while (keys.length > 60) delete records[keys.shift()];
    try { sessionStorage.setItem(storageKey, JSON.stringify(records)); } catch (_) {}
  }
  function plannedBack() {
    try {
      const plan=JSON.parse(sessionStorage.getItem('hmc-back-target')||'null');
      if(!plan)return null;
      if(Date.now()-plan.time>30000){sessionStorage.removeItem('hmc-back-target');return null;}
      if(records[plan.key]?.url!==location.href)return null;
      sessionStorage.removeItem('hmc-back-target');return plan.key;
    } catch (_) { return null; }
  }
  current = history.state && history.state.__hmcBrowse;
  let resumeOutbound=movies&&outbound&&Date.now()-outbound.time<43200000&&outbound.url===location.href&&records[outbound.key];
  if (resumeOutbound) { current=outbound.key;records[current].browserBackUnsafe=true;replace(markedState(history.state,current),'',location.href);sessionStorage.removeItem('hmc-outbound'); }
  const resumeBack=plannedBack();
  if(resumeBack){current=resumeBack;records[current].browserBackUnsafe=true;replace(markedState(history.state,current),'',location.href);}
  if (!current || !records[current] || records[current].url !== location.href) {
    current = freshKey();
    records[current] = { url: location.href, parent: null };
    replace(markedState(history.state, current), '', location.href);
  }
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 8; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const siblings = n.parentElement ? [...n.parentElement.children].filter(x => x.tagName === n.tagName) : [n];
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')');
    }
    return parts.join(' > ');
  }
  function find(selector) { try { return document.querySelector(selector); } catch (_) { return null; } }
  function cancelScrollSave() {
    clearTimeout(scrollTimer);scrollTimer=null;
    if(cancelIdleScroll){cancelIdleScroll();cancelIdleScroll=null;}
  }
  function saveScroll() {
    cancelIdleScroll=null;
    if(restoring||scrollOwner!==current||!records[current]||isPlayerUrl(location.href)){scrollNodes.clear();return;}
    const offsets=[];
    for(const element of scrollNodes)if(element.isConnected) {
      let selector=scrollSelectors.get(element);
      if(!selector){selector=selectorFor(element);scrollSelectors.set(element,selector);}
      if(selector)offsets.push([selector,element.scrollLeft,element.scrollTop]);
    }
    scrollNodes.clear();
    if(updateScrollRecord(records[current],[window.scrollX,window.scrollY],offsets))persist();
  }
  function queueScrollSave(event) {
    if(restoring||isPlayerUrl(location.href))return;
    cancelScrollSave();
    if(scrollOwner!==current){scrollNodes.clear();scrollSelectors=new WeakMap();scrollOwner=current;}
    const target=event.target;
    if(target?.nodeType===1&&target!==document.body&&target!==document.documentElement)scrollNodes.add(target);
    // Save positions after a pause in scrolling, without scanning the full page
    // or writing session storage in the touch/scroll event itself.
    scrollTimer=setTimeout(()=>{
      scrollTimer=null;
      if(typeof window.requestIdleCallback==='function'&&typeof window.cancelIdleCallback==='function') {
        const id=window.requestIdleCallback(saveScroll,{timeout:1000});
        cancelIdleScroll=()=>window.cancelIdleCallback(id);
      } else {
        const id=setTimeout(saveScroll,0);cancelIdleScroll=()=>clearTimeout(id);
      }
    },350);
  }
  function snapshot(target) {
    if (restoring || !records[current] || isPlayerUrl(location.href)) return;
    cancelScrollSave();scrollNodes.clear();
    const page = records[current];
    page.window = [window.scrollX, window.scrollY];
    const pageCount = document.querySelector('#reactRoot header')?.textContent.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+\d+/);
    if (pageCount) page.paginationStart = Number(pageCount[1]);
    page.scroll = [...document.querySelectorAll('main,[data-role="page"],.scrollContainer,.mainAnimatedPages,.emby-scroller,[class*="overflow-y-auto"],[class*="overflow-x-auto"]')]
      .filter(e => e.getClientRects().length && (e.scrollTop || e.scrollLeft))
      .map(e => [selectorFor(e), e.scrollLeft, e.scrollTop]);
    page.search = [...document.querySelectorAll('input[type="search"],input#search_field,input[placeholder*="Search"],input[aria-label*="Search"]')]
      .filter(e => e.getClientRects().length).map(e => [selectorFor(e), e.value]);
    const origin = target || document.activeElement;
    const card = origin?.closest?.('button.card[data-id]');
    if (card) page.focusCard = { id: card.getAttribute('data-id'), server: card.getAttribute('data-serverid') };
    const link = origin?.closest?.('a[href]');
    if (link) page.focus = link.getAttribute('href');
    persist();
  }
  function focusRecord(page) {
    let target;
    if (page?.focusCard) target = [...document.querySelectorAll('button.card[data-id]')].find(card =>
      card.getAttribute('data-id') === page.focusCard.id && (!page.focusCard.server || card.getAttribute('data-serverid') === page.focusCard.server) && card.getClientRects().length);
    if (!target && page?.focus) target = [...document.querySelectorAll('a[href]')].find(link => link.getAttribute('href') === page.focus && link.getClientRects().length);
    if (target) target.focus({ preventScroll: true });
    return !!target || !(page?.focusCard || page?.focus);
  }
  function restore(key) {
    const page = records[key];
    if (!page || isPlayerUrl(page.url)) return;
    clearTimeout(restoreTimer);
    restoring = true;
    const searches = new Set();
    let requestedPage = null;
    let attempts = 0,settled=0;
    function finish() {
      focusRecord(page);
      restoring=false;
    }
    function step() {
      if (!restoring || current !== key) return;
      const header = document.querySelector('#reactRoot header');
      const count = header?.textContent.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+\d+/);
      let ready=!page.paginationStart||!!(count&&Number(count[1])===page.paginationStart);
      if (count && page.paginationStart && Number(count[1]) !== page.paginationStart && requestedPage !== Number(count[1])) {
        const name = Number(count[1]) < page.paginationStart ? 'Next' : 'Previous';
        const button = [...header.querySelectorAll('button')].find(b => !b.disabled && (b.getAttribute('aria-label') === name || b.title === name));
        if (button) { requestedPage = Number(count[1]); button.click(); }
      }
      for (const [selector, value] of page.search || []) {
        const input = find(selector);
        if(!input||!input.getClientRects().length){ready=false;continue;}
        if(input.value!==value)ready=false;
        if (input && input.getClientRects().length && input.value !== value && !searches.has(selector)) {
          ready=false;
          searches.add(selector);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      for (const [selector, x, y] of page.scroll || []) {
        const element = find(selector);
        if (!element || !element.getClientRects().length){ready=false;continue;}
        if(Math.abs(element.scrollLeft-x)>1||Math.abs(element.scrollTop-y)>1)element.scrollTo(x,y);
        if(Math.abs(element.scrollLeft-x)>1||Math.abs(element.scrollTop-y)>1)ready=false;
      }
      if (page.window) {
        const [x,y]=page.window;
        if(Math.abs(window.scrollX-x)>1||Math.abs(window.scrollY-y)>1)window.scrollTo(x,y);
        if(Math.abs(window.scrollX-x)>1||Math.abs(window.scrollY-y)>1)ready=false;
      }
      if (ready && settled === 0) ready = focusRecord(page);
      settled=ready?settled+1:0;
      if(++attempts<30&&settled<3)restoreTimer=setTimeout(step,150);
      else finish();
    }
    restoreTimer = setTimeout(step, 80);
  }
  function changed(isPush, key) {
    backNavigation?.settled();
    const target=plannedBack();
    if(target){current=target;records[current].browserBackUnsafe=true;replace(markedState(history.state,current),'',location.href);backNavigation?.settled();restore(current);persist();schedule();return;}
    const known = key && records[key] && records[key].url === location.href;
    if (known && key !== current) {
      current = key; restore(key);
    } else if (!known || (records[current] && records[current].url !== location.href)) {
      restoring=false;clearTimeout(restoreTimer);cancelScrollSave();scrollNodes.clear();
      const parent = current;
      current = isPush && key ? key : freshKey();
      records[current] = { url: location.href, parent };
      replace(markedState(history.state, current), '', location.href);
    }
    backNavigation?.settled();persist(); schedule();
  }
  history.pushState = function (state, unused, url) {
    snapshot();
    const key = freshKey();
    const result = push(markedState(state, key), unused, url);
    changed(true, key);
    return result;
  };
  history.replaceState = function (state, unused, url) {
    const result = replace(markedState(state, current), unused, url);
    if (records[current]) records[current].url = location.href;
    backNavigation?.settled();persist(); schedule();
    return result;
  };
  window.addEventListener('popstate', e => changed(false, e.state && e.state.__hmcBrowse));
  window.addEventListener('hashchange', () => changed(false, history.state && history.state.__hmcBrowse));
  window.addEventListener('pagehide', event => {
    // Jellyfin also bubbles a synthetic pagehide from its cached view nodes.
    // That is a screen transition, not an unload of this WebView/document.
    if(!isWindowPageHide(event,window))return;
    backNavigation?.cancel();snapshot();
  });
  document.addEventListener('scroll',queueScrollSave,{capture:true,passive:true});
  for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown']) document.addEventListener(event, e => {
    // A rapid Select after Back may arrive before the TV list has re-mounted.
    // Keep restoration alive rather than stranding focus on the document body.
    if (event === 'keydown' && restoring && document.documentElement.classList.contains('layout-tv') &&
        (!document.activeElement || document.activeElement === document.body)) {
      if (!focusRecord(records[current])) return;
    }
    restoring = false; clearTimeout(restoreTimer);
  }, { capture: true, passive: true });
  document.addEventListener('click',e=>{
    if(e.target.closest?.('a[href],button.card,.hmc-back-button,.headerBackButton,.btnBack,.btnGoBack,button[aria-label="Back"]'))snapshot(e.target);
  },true);

  const style = document.createElement('style');
  style.textContent = `
    .hmc-back-button { display:inline-flex!important; align-items:center; justify-content:center; flex-shrink:0;
      width:44px; min-width:44px; height:44px; padding:10px; margin-right:4px; border:0;
      border-radius:50%; background:transparent; box-shadow:none; color:#fff!important; font:inherit; cursor:pointer; }
    .hmc-back-button svg { display:block; width:24px; height:24px; fill:currentColor; pointer-events:none; }
    .hmc-back-button[hidden] { display:none!important; }
    [data-hmc-back-duplicate] { display:none!important; }
    .hmc-back-floating { position:fixed;top:max(12px,env(safe-area-inset-top));left:12px;z-index:10000; }
    .hmc-back-button:hover { background:#ffffff14; }
    .hmc-back-button:focus-visible { outline:3px solid #ffd45b; outline-offset:2px; }
    a[data-hmc-trailer] { text-decoration:none!important; color:inherit; }
    .mainDetailButtons .media-discovery-button { display:inline-flex!important;align-items:center;justify-content:center;min-width:44px;min-height:44px;color:inherit; }
    .itemExternalLinks .seerr-link { display:none!important; }
    #hmc-browse-message { position:fixed; bottom:calc(24px + env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%);
      z-index:2147483000; max-width:85vw; padding:12px 18px; border:1px solid #8291aa; border-radius:12px; background:#18202ef5; color:white; }
  `;
  document.head.appendChild(style);
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'hmc-back-button';
  back.setAttribute('aria-label', 'Back'); back.title = 'Back to where you were';
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"></path></svg>';
  function logicalBack(parent,target,isCurrent=()=>true) {
    records[parent].browserBackUnsafe=true;
    if(target===location.href){
      // Router-only state entries may share a URL, so no hashchange will arrive.
      sessionStorage.removeItem('hmc-back-target');current=parent;
      replace(markedState(history.state,current),'',target);backNavigation?.settled();
      restore(current);persist();schedule();return;
    }
    const router=movies&&preferLogicalBack(window.NativeShell,window.ReactNativeWebView,document.documentElement.className)&&window.Emby?.Page;
    if(router&&typeof router.show==='function')return nativeRouteChange({router,target,currentUrl:location.href,isCurrent,
      onBeforeShow(route){
        const expected=new URL(location.href);expected.hash='#'+route;records[parent].url=expected.href;
        sessionStorage.setItem('hmc-back-target',JSON.stringify({key:parent,time:Date.now()}));persist();
      },
      onFailure(){
        try{const plan=JSON.parse(sessionStorage.getItem('hmc-back-target')||'null');if(plan?.key===parent)sessionStorage.removeItem('hmc-back-target');}catch(_){}
        message('This screen is still loading. Please try Back again.');
      }
    });
    sessionStorage.setItem('hmc-back-target',JSON.stringify({key:parent,time:Date.now()}));
    persist();location.replace(target);
  }
  backNavigation=createBackNavigation({read:()=>({key:current,url:location.href}),goBack:()=>history.back(),
    goLogical:(parent,target,isCurrent)=>parent===null?
      nativeRouteChange({router:window.Emby.Page,target,currentUrl:location.href,isCurrent,onFailure:()=>message('This title is still loading. Please try again.')}):
      logicalBack(parent,target,isCurrent)});
  back.addEventListener('click', () => {
    const parent = records[current] && records[current].parent;
    if (parent && records[parent]) {
      // The iPhone WebView's browser history can differ from Jellyfin's route
      // history. Restore its known parent directly instead of racing a late
      // browser traversal. Browser and TV navigation keep their normal path.
      const logical=records[current].browserBackUnsafe||movies&&preferLogicalBack(window.NativeShell,window.ReactNativeWebView,document.documentElement.className);
      backNavigation.request(parent,records[parent].url,logical);
    } else if(movies&&preferLogicalBack(window.NativeShell,window.ReactNativeWebView,document.documentElement.className)&&typeof window.Emby?.Page?.show==='function') {
      backNavigation.request(null,'#/home',true);
    } else location.assign(movies ? '#/home' : returnToMovies);
  });
  function isNativeBack(node) {
    if(node===back)return false;
    const label=(node.getAttribute('aria-label')||node.title||node.textContent||'').trim();
    return /^(?:go\s+)?back(?:\s+to\b.*)?$/i.test(label)||node.matches('.headerBackButton,.btnBack,.btnGoBack')||
      !!node.querySelector('svg[data-testid="ArrowBackIcon"],svg[data-testid="ArrowBackIosIcon"]')||
      [...node.querySelectorAll('.material-icons')].some(icon=>icon.textContent.trim()==='arrow_back');
  }
  function navigationBack(host,needed) {
    // React may rebuild its header. Re-evaluate the existing control instead of
    // leaving both the native arrow and our history-aware fallback visible.
    const candidates=host?[...host.querySelectorAll('button,a')].filter(isNativeBack):[];
    const logical=!!records[current]?.browserBackUnsafe||movies&&!!records[records[current]?.parent]&&preferLogicalBack(window.NativeShell,window.ReactNativeWebView,document.documentElement.className);
    // When returning from Discovery the logical arrow already owns Back. Do
    // not unhide/re-hide native arrows and force another layout on every update.
    let native=[];
    if(!logical) {
      native=candidates.filter(node=>!node.hasAttribute('data-hmc-back-duplicate')&&node.getClientRects().length&&!node.disabled&&node.getAttribute('aria-disabled')!=='true');
      // Probe a previously hidden alternative only if the old primary vanished
      // or became disabled. Usually no attributes or layout styles change.
      if(!native.length)for(const node of candidates)if(node.hasAttribute('data-hmc-back-duplicate')&&!node.disabled&&node.getAttribute('aria-disabled')!=='true') {
        node.removeAttribute('data-hmc-back-duplicate');
        if(node.getClientRects().length){native=[node];break;}
      }
    }
    for(const node of candidates)if((logical||node!==native[0])&&!node.hasAttribute('data-hmc-back-duplicate'))node.setAttribute('data-hmc-back-duplicate','1');
    const hidden=!needed||(!logical&&native.length>0);
    if(back.hidden!==hidden)back.hidden=hidden;
    const parent=records[current]&&records[records[current].parent];
    const title=!movies&&!parent?'Back to Movies':'Back to where you were';
    if(back.title!==title)back.title=title;
  }
  document.addEventListener('click',e=>{
    const a=e.target.closest?.('a[href]');if(!a)return;
    const oldHref=a.href,rewritten=rewriteOwnedUrl(oldHref,location.href);
    if(rewritten!==oldHref) {
      a.href=rewritten;
      if(!movies) {
        // Discovery's server-provided Play/Available links can retain a LAN
        // address in their React handler. Follow our exact trusted mapping.
        e.stopImmediatePropagation();
        if(window.ReactNativeWebView||window.NativeShell){e.preventDefault();location.assign(rewritten);}
        return;
      }
    }
    if(!movies)return;
    // The theme's hero is an ordinary hash link. On native iOS that drops the
    // router's history state before Back is used, so keep this journey inside
    // Jellyfin's route lifecycle in both directions. Browser/TV links stay native.
    if(a.matches('.nf-hero-info')&&preferLogicalBack(window.NativeShell,window.ReactNativeWebView,document.documentElement.className)&&
        typeof window.Emby?.Page?.show==='function'&&jellyfinRoute(a.href,location.href)) {
      e.preventDefault();e.stopImmediatePropagation();backNavigation.request(null,a.href,true,'forward');return;
    }
    let u;try{u=new URL(a.href);}catch(_){return;}
    if(isDownloadProgressUrl(u.href)) {
      a.target=document.documentElement.classList.contains('layout-tv')?'_self':'_blank';a.rel='noopener noreferrer';
      if(window.NativeShell&&typeof window.NativeShell.openUrl==='function') {
        e.preventDefault();e.stopImmediatePropagation();window.NativeShell.openUrl(u.href,'_blank');
      }
      return;
    }
    if(!isDiscoveryUrl(u.href))return;
    const backUrl=safeMoviesReturn(location.href);if(!backUrl)return;
    snapshot(a);const resumeKey=freshKey();records[resumeKey]=Object.assign({},records[current],{url:backUrl});persist();
    sessionStorage.setItem('hmc-outbound',JSON.stringify({url:backUrl,key:resumeKey,time:Date.now()}));
    u.searchParams.set('hmcReturn',backUrl);a.href=u.href;
    // Keep both local apps in the same native WebView and storage partition.
    // A target=_blank handoff uses Safari's separate browser context on iOS.
    if(window.ReactNativeWebView || window.NativeShell) {
      e.preventDefault();e.stopImmediatePropagation();location.assign(u.href);return;
    }
    a.target=document.documentElement.classList.contains('layout-tv')?'_self':'_blank';a.rel='noopener noreferrer';
    if(a.dataset.hmcDiscovery)e.stopImmediatePropagation();
  },true);
  function message(text) {
    let node = document.getElementById('hmc-browse-message');
    if (!node) { node = document.createElement('div'); node.id = 'hmc-browse-message'; node.setAttribute('role', 'status'); document.body.appendChild(node); }
    node.textContent = text;
    clearTimeout(message.timer); message.timer = setTimeout(() => node.remove(), 4000);
  }
  const trailerCache = new Map();
  const discoverTrailers=new Map();
  function discoverTrailer() {
    const match=location.pathname.match(/^\/(movie|tv)\/(\d+)\/?$/);
    const bar=document.querySelector('.media-actions'),heading=document.querySelector('h1');
    if(!match||!bar||!heading||bar.querySelector('[data-media-discover-trailer]'))return;
    const path=location.pathname,link=document.createElement('a');
    link.className='inline-flex items-center justify-center border font-medium rounded-md text-white bg-transparent border-gray-600 px-4 py-2 text-sm button-md ml-2';
    link.textContent='▶ Trailer';link.setAttribute('aria-label','Trailer');link.dataset.hmcDiscoverTrailer='1';
    link.href='https://www.youtube.com/results?search_query='+encodeURIComponent(heading.textContent+' official trailer');link.target='_blank';link.rel='noopener noreferrer';
    const old=[...bar.querySelectorAll('button')].find(b=>/trailer/i.test(b.textContent+' '+(b.getAttribute('aria-label')||'')+' '+b.title));
    if(old)old.replaceWith(link);else bar.appendChild(link);
    if(!discoverTrailers.has(path))discoverTrailers.set(path,fetch('/api/v1/'+match[1]+'/'+match[2]+'?language=en',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(item=>{
      const videos=(item?.relatedVideos||[]).filter(v=>v.type==='Trailer'&&youtubeLink(v.url||('https://www.youtube.com/watch?v='+v.key)));
      const video=videos.find(v=>/official/i.test(v.name||''))||videos[0];
      return video?youtubeLink(video.url||('https://www.youtube.com/watch?v='+video.key)):null;
    }).catch(()=>null));
    discoverTrailers.get(path).then(url=>{if(url&&link.isConnected&&location.pathname===path)link.href=url;});
  }
  function itemId() {
    const query = location.hash.split('?')[1] || '';
    const id = new URLSearchParams(query).get('id');
    return /^[a-f\d]{32}$/i.test(id || '') ? id : null;
  }
  function trailer(id) {
    const cached = trailerCache.get(id);
    if (cached && (cached.url || Date.now() - cached.time < 15000)) return cached.promise;
    const api = window.ApiClient;
    if (!api || !api.getItem || !api.getCurrentUserId) return Promise.resolve(null);
    const entry = { time: Date.now(), url: null };
    entry.promise = settledWithin(Promise.resolve().then(() => api.getItem(api.getCurrentUserId(), id)), 8000).then(item => {
      if (!item) return null;
      entry.item=item;
      entry.url = (item.RemoteTrailers || []).map(t => youtubeLink(t.Url)).find(Boolean) ||
        (['Movie','Series','Episode'].includes(item.Type)?'https://www.youtube.com/results?search_query='+encodeURIComponent((item.SeriesName||item.Name)+' '+(item.ProductionYear||'')+' official trailer'):null);
      return entry.url;
    }).catch(() => null);
    trailerCache.set(id, entry);
    return entry.promise;
  }
  function externalButton(button, url) {
    if (!button.isConnected || button.dataset.hmcTrailer) return;
    const focused = button === document.activeElement || button.contains(document.activeElement);
    const link = document.createElement('a');
    for (const attr of button.attributes) if (!['is', 'disabled', 'aria-busy'].includes(attr.name)) link.setAttribute(attr.name, attr.value);
    link.innerHTML = button.innerHTML;
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.hmcTrailer = 'youtube';
    link.setAttribute('role', 'button'); link.setAttribute('aria-label', button.getAttribute('aria-label') || button.title || 'Trailer');
    link.addEventListener('keydown', e => { if (e.key === ' ') { e.preventDefault(); link.click(); } });
    button.replaceWith(link);
    if (focused) link.focus({ preventScroll: true });
  }
  function discoveryButton(item) {
    const tmdb=item?.ProviderIds?.Tmdb;
    if(!/^\d+$/.test(tmdb||'')||!['Movie','Series'].includes(item?.Type))return;
    const bar=[...document.querySelectorAll('.mainDetailButtons')].find(e=>e.getClientRects().length);
    if(!bar)return;
    let link=bar.querySelector('.media-discovery-button');
    if(!link) {
      link=document.createElement('a');link.className='button-flat detailButton emby-button show-focus media-discovery-button';
      link.dataset.hmcDiscovery='1';link.target='_blank';link.rel='noopener noreferrer';
      link.setAttribute('role','button');link.setAttribute('aria-label',"Home Media Discovery");link.title="Find or request in Home Media Discovery";
      link.innerHTML='<div class="detailButton-content"><span class="material-icons detailButton-icon explore" aria-hidden="true"></span></div>';
      link.addEventListener('keydown',e=>{if(e.key===' '){e.preventDefault();link.click();}});
      bar.insertBefore(link,bar.querySelector('.btnMoreCommands'));
    }
    const href=rewriteOwnedUrl('http://media-discover.local/'+(item.Type==='Movie'?'movie/':'tv/')+tmdb,location.href);
    if(link.href!==href)link.href=href;
  }
  function installHolding() {
    const client=window.ApiClient;
    if(!client || typeof client.deleteItem!=='function')return;
    if(!client.__hmcHolding) {
      const original=client.deleteItem;
      client.deleteItem=function(id) {
        return Promise.resolve(client.getItem(client.getCurrentUserId(),id)).then(item=>{
          if(['BoxSet','Playlist'].includes(item.Type))return original.call(client,id);
          if(!['Movie','Series'].includes(item.Type))throw Error('Open a movie or whole TV series to move it into holding.');
          return fetch(rewriteOwnedUrl('http://192.0.2.10/hmc-hold/move',location.href),{
            method:'POST',headers:{'Content-Type':'application/json','X-Emby-Token':client.accessToken()},
            body:JSON.stringify({id}),credentials:'omit'
          }).then(async response=>{
            const value=await response.json();
            if(!response.ok)throw Error(value.message||'The title could not be moved. No files were permanently deleted.');
            message(value.message);return value;
          });
        }).catch(error=>{message(error.message||'Could not move this title into holding.');throw error;});
      };
      client.__hmcHolding=true;
    }
    for(const dialog of document.querySelectorAll('.dialog:not([data-hmc-holding])')) {
      const title=dialog.querySelector('.formDialogHeaderTitle'),button=dialog.querySelector('.button-delete'),text=dialog.querySelector('.dialogContentInner .text');
      if(!title||!button||!text||!/^Delete (Item|Series)$/i.test(title.textContent.trim()))continue;
      dialog.dataset.hmcHolding='1';title.textContent='Move to holding?';
      text.textContent='This removes the title from Movies and keeps its files in Media holding. You can restore it, or confirm permanent deletion later in Media Control on the main computer. Nothing is automatically erased.';
      button.textContent='Move to holding';
    }
  }
  function update() {
    const host = movies ? (document.querySelector('#reactRoot header .MuiToolbar-root') || document.querySelector('.skinHeader .headerLeft')) : document.querySelector('.searchbar > div');
    if (host && back.parentElement !== host) host.prepend(back);
    if(!movies) {
      back.classList.toggle('hmc-back-floating',!host);
      if(!host&&back.parentElement!==document.body)document.body.appendChild(back);
    }
    const route = movies ? location.hash.replace(/^#!\/?/, '#/') : location.pathname;
    const landing = movies ? /^#?\/?(?:home)?(?:\?|$)/.test(route) : route === '/';
    const login = /login|signin|selectserver|quickconnect/i.test(route);
    navigationBack(host,!movies||(!isPlayerUrl(location.href)&&!login&&(!landing||!!(records[current]&&records[records[current].parent]))));
    if (movies) {
      installHolding();
      const id = itemId();
      if (id) {
        const buttons = [...document.querySelectorAll('button.btnPlayTrailer')].filter(b => b.closest('.mainDetailButtons')?.getClientRects().length);
        if (buttons.length) trailer(id).then(url => { if (url && itemId() === id) buttons.forEach(b => {b.classList.remove('hide');b.hidden=false;externalButton(b, url);}); });
        trailer(id).then(()=>{if(itemId()===id)discoveryButton(trailerCache.get(id)?.item);});
      }
    } else {
      discoverTrailer();
      for (const link of document.querySelectorAll('a[href*="youtu"]')) {
        const url = youtubeLink(link.href);
        if (url) {
          if(link.href!==url)link.href=url;
          if(link.target!=='_blank')link.target='_blank';
          if(link.rel!=='noopener noreferrer')link.rel='noopener noreferrer';
        }
      }
    }
  }
  document.addEventListener('click', e => {
    const external=e.target.closest?.('a[data-hmc-trailer],a[data-media-discover-trailer]');
    if(external&&window.NativeShell&&typeof window.NativeShell.openUrl==='function') {
      e.preventDefault();e.stopImmediatePropagation();window.NativeShell.openUrl(external.href,'_blank');return;
    }
    const button = e.target.closest && e.target.closest('button.btnPlayTrailer');
    if (!movies || !button) return;
    const id = itemId();
    if (!id) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const cached = trailerCache.get(id);
    if (cached && cached.url) {
      externalButton(button, cached.url);
      const link = document.querySelector('a[data-hmc-trailer]');
      if (link) link.click();
    } else {
      message('Finding the trailer link…');
      trailer(id).then(url => {
        if (itemId() !== id || !button.isConnected || isPlayerUrl(location.href)) return;
        if (url) { externalButton(button, url); message('Trailer ready—tap Trailer again.'); }
        else message('The trailer link is unavailable. Please try again shortly.');
      });
    }
  }, true);
  function schedule() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => { updateTimer = null; update(); }, 80);
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize',schedule,{passive:true});
  persist(); schedule();
  if(resumeOutbound||resumeBack)restore(current);
}());
