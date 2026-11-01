/* Staged TV-only action menu; native actions remain intact on other layouts. */
(function () {
  'use strict';
  function enabled(classes,hash) { return /(?:^|\s)layout-tv(?:\s|$)/.test(classes || '') && !/^#!?\/(?:video|videoosd|player)(?:[/?]|$)/i.test(hash || ''); }
  function isPrimary(classes) {
    const values = new Set((classes || '').split(/\s+/));
    return values.has('btnUserRating') || values.has('btnMoreCommands') || values.has('btnPlayTrailer') || values.has('btnResume') || values.has('btnPlay') && !values.has('btnReplay');
  }
  function actionLabel(info) {
    const classes = new Set((info.className || '').split(/\s+/));
    if (classes.has('btnUserRating')) return info.isFavorite ? 'Remove from favourites' : 'Add to favourites';
    if (classes.has('btnPlaystate')) return info.isPlayed ? 'Mark as unwatched' : 'Mark as watched';
    if (classes.has('media-discovery-button')) return 'Find in Discovery';
    if (classes.has('btnDownload')) return 'Download';
    if (classes.has('btnReplay')) return 'Play from start';
    return String(info.ariaLabel || info.title || info.text || '').trim();
  }
  function backKey(event) { return ['Escape','Back','BrowserBack','GoBack','Backspace'].includes(event.key) || [27,461,10009].includes(event.keyCode); }
  function commandAction(value){if(typeof value!=='string')return null;return{left:'back',right:'next',up:'previous',down:'next',select:'select',back:'back'}[value.toLowerCase()]||null;}
  function horizontalKeyTarget(current, candidates, direction) {
    const center = current.x + current.width / 2;
    const row = candidates.filter(box => box.width > 0 && box.height > 0 && Math.abs(box.y - current.y) < Math.min(box.height,current.height) / 2);
    return row.filter(box => direction === 'left' ? box.x + box.width / 2 < center - 1 : box.x + box.width / 2 > center + 1)
      .sort((a,b) => Math.abs(a.x+a.width/2-center)-Math.abs(b.x+b.width/2-center))[0] || null;
  }
  function ownedService(raw,roots) {
    try {
      const target=new URL(raw),discovery=new URL(roots.discovery),status=new URL(roots.status);
      for(const value of [target,discovery,status]) if(!/^https?:$/.test(value.protocol)||value.username||value.password)return null;
      if(target.origin===discovery.origin && /^(?:\/(?:login|search|requests)?\/?|\/(?:movie|tv)\/\d+\/?|\/discover(?:\/[A-Za-z0-9_-]+)*\/?)$/.test(target.pathname))return 'discovery';
      const statusPath=status.pathname.replace(/\/$/,'');
      if(target.origin===status.origin && [statusPath,statusPath+'/'].includes(target.pathname))return 'status';
    }catch(_){}
    return null;
  }
  function tvServiceUrl(raw,roots) {
    if(!ownedService(raw,roots))return null;
    const url=new URL(raw);url.searchParams.set('tv','1');return url.href;
  }
  function createOwnedKeys() {
    const held = new Set();
    function identity(event) {
      if (Number.isFinite(event.keyCode) && event.keyCode > 0) return 'code:' + event.keyCode;
      if (event.code && event.code !== 'Unidentified') return 'physical:' + event.code;
      return event.key && event.key !== 'Unidentified' ? 'key:' + event.key : null;
    }
    return {
      own(event) { const key = identity(event); if (key) held.add(key); },
      take(event) { const key = identity(event); return key ? held.delete(key) : false; },
      clear() { held.clear(); },
      get size() { return held.size; }
    };
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = {enabled,isPrimary,actionLabel,backKey,commandAction,horizontalKeyTarget,createOwnedKeys,ownedService,tvServiceUrl};
    return;
  }
  if (window.HomeMediaTVCouchActions) return;
  let menu = null, trigger = null, originalAction = null, scheduled = false;
  const marked = new WeakMap();
  const serviceTargets = new Map();
  const ownedKeys = createOwnedKeys();
  const active = () => enabled(document.documentElement.className,location.hash);
  function consume(event) { if (event.type === 'keydown') ownedKeys.own(event); event.preventDefault(); event.stopImmediatePropagation(); }
  function focus(node) { if (node?.isConnected) node.focus({preventScroll:true}); }
  function close(restore = true) { const previous = trigger; menu?.remove(); menu = null; trigger = null; previous?.setAttribute('aria-expanded','false'); if (restore && active()) focus(previous); }
  function available(node) {
    if (!node.isConnected || node.hidden || node.disabled || node.classList.contains('hide') || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('aria-disabled') === 'true' || node.style.display === 'none') return false;
    return marked.has(node) ? marked.get(node) : getComputedStyle(node).display !== 'none';
  }
  function label(node) { return actionLabel({className:node.className,ariaLabel:node.getAttribute('aria-label'),title:node.title,text:node.textContent,isFavorite:node.dataset.isfavorite === 'true' || node.getAttribute('aria-pressed') === 'true',isPlayed:node.dataset.isplayed === 'true'}); }
  function serviceRoots() {
    const rewrite=raw=>window.HomeMediaRemoteLinks?.url(raw)||raw;
    return {discovery:rewrite('http://media-discover.local/'),status:rewrite('http://192.0.2.10/status/')};
  }
  function restoreServiceTargets(all) {
    for(const [node,original] of serviceTargets)if(all||!node.isConnected){if(original.target===null)node.removeAttribute('target');else node.setAttribute('target',original.target);if(original.href===null)node.removeAttribute('href');else node.setAttribute('href',original.href);serviceTargets.delete(node);}
  }
  function serviceHandoff(node) {
    if(!node)return;
    const mapped=window.HomeMediaRemoteLinks?.url(node.href)||node.href,href=tvServiceUrl(mapped,serviceRoots());
    if(!href)return;
    if(!serviceTargets.has(node))serviceTargets.set(node,{target:node.getAttribute('target'),href:node.getAttribute('href')});
    node.href=href;node.target='_self';
  }
  function update() {
    scheduled = false;
    const value = active();
    if (value) document.documentElement.dataset.hmcCouchActions = '1';
    else { delete document.documentElement.dataset.hmcCouchActions; close(false);restoreServiceTargets(true);return; }
    restoreServiceTargets(false);
    for (const bar of document.querySelectorAll('.mainDetailButtons')) {
      for (const node of bar.children) {
        if (!node.matches('button,a')) continue;
        if (node.classList.contains('btnPlay') && node.dataset.hmcTvPlayLabel !== node.title) node.dataset.hmcTvPlayLabel = node.title || 'Play';
        if (isPrimary(node.className)) { delete node.dataset.hmcTvSecondary; continue; }
        if (!marked.has(node)) {
          // A native .hide/hidden/style flag may later be removed (for example
          // Play from start becomes available after a resume point is added).
          const explicitlyHidden = node.hidden || node.classList.contains('hide') || node.style.display === 'none';
          marked.set(node,explicitlyHidden || available(node));
        }
        if (node.dataset.hmcTvSecondary !== '1') node.dataset.hmcTvSecondary = '1';
      }
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(update,60); } }
  function choices(button) {
    const bar = button.closest('.mainDetailButtons');
    const items = [...bar.children].filter(node => node !== button && node.matches('button,a') && !isPrimary(node.className) && available(node)).map(node => ({node,label:label(node)})).filter(item => item.label);
    items.push({node:button,label:'More options'}); return items;
  }
  function select(item) {
    const previous = trigger;
    close(false); focus(previous);
    // The original handler owns the action and any native submenu it opens.
    // The bypass applies only to this one synchronous native click.
    originalAction = item.node;
    try { item.node.click(); } finally { originalAction = null; }
  }
  function open(button) {
    if (trigger === button && menu) { close(); return; }
    close(false); trigger = button;
    menu = document.createElement('div'); menu.id = 'hmc-tv-actions-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','More movie actions');
    for (const item of choices(button)) {
      const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role','menuitem'); option.textContent = item.label;
      option.addEventListener('click',event => { consume(event); select(item); }); menu.appendChild(option);
    }
    document.body.appendChild(menu);
    const rect = button.getBoundingClientRect(); menu.style.top = Math.min(rect.bottom + 10,Math.max(12,innerHeight - menu.offsetHeight - 16)) + 'px'; menu.style.left = Math.max(16,Math.min(rect.left,innerWidth - menu.offsetWidth - 16)) + 'px'; menu.style.maxHeight = Math.max(120,innerHeight - 32) + 'px';
    button.setAttribute('aria-expanded','true'); focus(menu.querySelector('button'));
  }
  const style = document.createElement('style'); style.id = 'hmc-tv-couch-actions-style';
  style.textContent = 'html.layout-tv[data-hmc-couch-actions="1"] .mainDetailButtons [data-hmc-tv-secondary="1"],html.layout-tv[data-hmc-couch-actions="1"] .hmc-favourite,html.layout-tv[data-hmc-couch-actions="1"] .hmc-native-favourite,html.layout-tv[data-hmc-couch-actions="1"] .cardOverlayButton-br button[is="emby-ratingbutton"]{display:none!important}html.layout-tv[data-hmc-couch-actions="1"] .mainDetailButtons .btnPlayTrailer::after{content:"Trailer"!important}html.layout-tv[data-hmc-couch-actions="1"] .mainDetailButtons .btnMoreCommands::after{content:"More"!important}html.layout-tv[data-hmc-couch-actions="1"] .mainDetailButtons .detailButton{font-size:22px!important;min-height:56px;min-width:86px}#hmc-tv-actions-menu{position:fixed;z-index:2147483500;min-width:300px;max-width:90vw;background:#151d2b;border:2px solid #738099;border-radius:10px;padding:10px;overflow:auto;box-shadow:0 10px 30px #0009}#hmc-tv-actions-menu button{display:block;width:100%;min-height:56px;padding:12px 20px;border:0;border-radius:6px;color:#fff;background:transparent;text-align:left;font:600 22px/1.35 Arial,sans-serif}#hmc-tv-actions-menu button:focus{outline:4px solid #ffd45b;outline-offset:-2px;background:#38445b}';
  // Keep the installed keyboard's entry, Select, Up/Down and Back handlers.
  // Fixed aligned columns keep Jellyfin's spatial Left/Right on the same row.
  // Native flex-grow previously stretched the last line and made Left jump up.
  style.textContent += 'html.layout-tv[data-hmc-couch-actions="1"] #searchPage .alphaPickerRow{display:grid!important;grid-template-columns:repeat(auto-fill,52px)!important;justify-content:center!important;gap:6px!important;width:100%;max-width:812px;margin-left:auto!important;margin-right:auto!important}html.layout-tv[data-hmc-couch-actions="1"] #searchPage .alphaPickerButton{min-width:52px!important;width:52px!important;max-width:52px!important;flex:0 0 52px!important;min-height:52px!important;height:52px!important;padding:0!important;font-size:24px!important;line-height:1.2!important}html.layout-tv[data-hmc-couch-actions="1"] #searchPage .alphaPickerButton:focus{outline:4px solid #ffd45b!important;outline-offset:2px!important}';
  style.textContent += 'html.layout-tv[data-hmc-couch-actions="1"] .mainDetailButtons .btnPlay::after{content:attr(data-hmc-tv-play-label)!important}';
  document.head.appendChild(style);
  window.addEventListener('click',event => {
    if (!active()) {restoreServiceTargets(true);return;}
    // Keep owned services in the projector's current window. Existing native
    // handlers still run, including the saved Movies return context.
    serviceHandoff(event.target.closest?.('a[href]'));
    const button = event.target.closest?.('.mainDetailButtons .btnMoreCommands');
    if (button && button !== originalAction) { consume(event); update(); open(button); }
    else if (menu && !menu.contains(event.target)) close(false);
  },true);
  function ownsOverlay(){return !!menu&&active()&&!document.getElementById('hmc-tv-trailer')&&!document.getElementById('hmc-tv-load-error');}
  function keyboardHorizontal(direction,event) {
    if (!active() || !/^#!?\/search(?:\?|$)/i.test(location.hash) || !['left','right'].includes(direction) || menu || document.getElementById('hmc-tv-trailer') || document.getElementById('hmc-tv-load-error')) return false;
    const current = document.activeElement?.closest('#searchPage .alphaPickerButton');
    if (!current || !current.getClientRects().length) return false;
    const rect = current.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#searchPage .alphaPickerButton')].filter(node => !node.disabled && node.getClientRects().length).map(node => {
      const box = node.getBoundingClientRect();return {node,x:box.x,y:box.y,width:box.width,height:box.height};
    });
    const target = horizontalKeyTarget(rect,boxes,direction);
    // At a row edge retain focus; Up/Down and Back still leave the row natively.
    consume(event);if(target)focus(target.node);return true;
  }
  function handleMenu(action,event={}) {
    if(action==='back'){close();return;}
    if(action==='select'){if(!event.repeat)document.activeElement?.closest('#hmc-tv-actions-menu button')?.click();return;}
    const buttons = [...menu.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
    const before=action==='previous'||action==='tab'&&event.shiftKey;
    const next=action==='first'?0:action==='last'?buttons.length-1:(Math.max(0,at)+(before?-1:1)+buttons.length)%buttons.length;
    focus(buttons[next]);buttons[next]?.scrollIntoView({block:'nearest'});
  }
  window.addEventListener('keydown',event => {
    const horizontal=event.key==='ArrowLeft'||event.keyCode===37?'left':event.key==='ArrowRight'||event.keyCode===39?'right':null;
    if(horizontal&&keyboardHorizontal(horizontal,event))return;
    if(!ownsOverlay())return;
    const key=event.key,code=event.keyCode;
    const action=backKey(event)||key==='ArrowLeft'||code===37?'back':key==='ArrowUp'||code===38?'previous':['ArrowDown','ArrowRight'].includes(key)||[39,40].includes(code)?'next':key==='Home'?'first':key==='End'?'last':key==='Tab'?'tab':['Enter','Select',' '].includes(key)||[13,23].includes(code)?'select':null;
    if(!action)return;consume(event);handleMenu(action,event);
  },true);
  // No private inputManager registration: only already-emitted DOM commands.
  window.addEventListener('command',event=>{const name=typeof event.detail?.command==='string'?event.detail.command.toLowerCase():null;if(keyboardHorizontal(name,event))return;if(!ownsOverlay())return;const action=commandAction(name);if(!action)return;consume(event);handleMenu(action);},true);
  window.addEventListener('keyup',event => { if (ownedKeys.take(event)) consume(event); },true);
  window.addEventListener('blur',() => ownedKeys.clear());
  window.addEventListener('pagehide',() => { close(false); ownedKeys.clear(); });
  window.addEventListener('hashchange',() => { close(false); update(); });
  window.addEventListener('popstate',() => { close(false); update(); });
  window.addEventListener('resize',() => close());
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  window.HomeMediaTVCouchActions = {version:'0.1.6',close:() => close()};
  update();
}());
