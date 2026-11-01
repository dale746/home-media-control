/* Staged TV details-load recovery. Native browsing/player keys stay native. */
(function () {
  'use strict';
  function detailsId(hash) {
    if(!/^#!?\/details(?:\?|$)/i.test(hash||''))return null;
    const id=new URLSearchParams((hash||'').split('?')[1]||'').get('id');
    return /^[a-f\d]{32}$/i.test(id||'')?id:null;
  }
  function activeDetails(classes,hash) {return /(?:^|\s)layout-tv(?:\s|$)/.test(classes||'')&&!!detailsId(hash);}
  function routeSignature(classes,hash){return(/(?:^|\s)layout-tv(?:\s|$)/.test(classes||'')?'tv|':'other|')+(hash||'');}
  function createDeadline(options={}) {
    const later=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout,expire=options.onExpire||(()=>{});
    let state={generation:0,key:null,phase:'idle'},timer=null;
    function stop(){if(timer!==null)cancel(timer);timer=null;}
    return {
      begin(key){stop();state={generation:state.generation+1,key,phase:'waiting'};const generation=state.generation;timer=later(()=>{timer=null;if(state.generation!==generation||state.phase!=='waiting')return;state={...state,phase:'error'};expire({...state});},options.delayMs||15000);return generation;},
      ready(generation){if(state.generation!==generation||state.phase!=='waiting')return false;stop();state={...state,phase:'ready'};return true;},
      cancel(){stop();state={generation:state.generation+1,key:null,phase:'idle'};},
      state(){return {...state};}
    };
  }
  function keyAction(event) {
    const codes={13:'select',23:'select',27:'back',461:'back',10009:'back',37:'previous',38:'previous',39:'next',40:'next'};
    const keys={Enter:'select',Select:'select',Escape:'back',Back:'back',BrowserBack:'back',GoBack:'back',Backspace:'back',ArrowLeft:'previous',ArrowUp:'previous',ArrowRight:'next',ArrowDown:'next',Tab:'tab'};
    return keys[event.key]||codes[event.keyCode]||null;
  }
  function commandAction(value){if(typeof value!=='string')return null;return{left:'previous',right:'next',up:'previous',down:'next',select:'select',back:'back'}[value.toLowerCase()]||null;}
  function createOwnedKeys(){const held=new Set();const identity=e=>e.keyCode>0?'code:'+e.keyCode:e.code&&e.code!=='Unidentified'?'physical:'+e.code:e.key&&e.key!=='Unidentified'?'key:'+e.key:null;return{own(e){const k=identity(e);if(k)held.add(k);},take(e){const k=identity(e);return k?held.delete(k):false;},clear(){held.clear();}};}
  function backStrategy(hasVisibleControl,historyLength){return hasVisibleControl?'control':historyLength>1?'history':'home';}
  if(typeof document==='undefined'){if(typeof module!=='undefined')module.exports={detailsId,activeDetails,routeSignature,createDeadline,keyAction,commandAction,createOwnedKeys,backStrategy};return;}
  if(window.HomeMediaTVLoadRecovery)return;
  let key=null,generation=null,overlay=null,lastFocus=null,seenRoute=null,routeFrame=null;
  const ownedKeys=createOwnedKeys();
  const relevant=()=>activeDetails(document.documentElement.className,location.hash);
  function consume(event){if(event.type==='keydown')ownedKeys.own(event);event.preventDefault();event.stopImmediatePropagation();}
  function visible(node){if(!node?.isConnected||node.hidden||node.disabled||node.getAttribute('aria-disabled')==='true'||node.closest('[hidden],[inert],[aria-hidden="true"]'))return false;if(!node.getClientRects().length)return false;for(let part=node;part&&part!==document.body;part=part.parentElement){const style=getComputedStyle(part);if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;}return true;}
  function titleReady(){return [...document.querySelectorAll('h1.itemName,.itemDetailPage h1,.detailPagePrimaryContainer h1')].some(node=>visible(node)&&node.textContent.trim().length>0);}
  function focus(node){if(node?.isConnected){node.focus({preventScroll:true});lastFocus=node;}}
  function removeOverlay(){overlay?.remove();overlay=null;lastFocus=null;}
  const watch=createDeadline({onExpire(state){observer.disconnect();if(key!==state.key||!relevant()||titleReady())return;showError();}});
  const observer=new MutationObserver(()=>{if(watch.state().phase==='waiting'&&titleReady()){watch.ready(generation);observer.disconnect();}});
  function cancel(){observer.disconnect();watch.cancel();key=null;generation=null;removeOverlay();}
  function sync(){
    seenRoute=routeSignature(document.documentElement.className,location.hash);
    if(!relevant()){cancel();return;}
    if(key===location.hash)return;
    cancel();key=location.hash;
    if(titleReady())return;
    generation=watch.begin(key);observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  }
  function goBack(){
    const control=[...document.querySelectorAll('.headerBackButton,.hmc-back-button')].find(node=>!overlay?.contains(node)&&visible(node));
    const strategy=backStrategy(!!control,history.length);cancel();
    if(strategy==='control')control.click();else if(strategy==='history')history.back();else location.hash='#/home';
  }
  function retry(){cancel();location.reload();}
  function showError(){
    if(overlay||!relevant())return;
    if(!document.getElementById('hmc-tv-load-style')){const style=document.createElement('style');style.id='hmc-tv-load-style';style.textContent='#hmc-tv-load-error{position:fixed;inset:0;z-index:2147483550;display:flex;align-items:center;justify-content:center;background:#080d16fa;color:#fff;padding:5vw;box-sizing:border-box;font:24px/1.5 Arial,sans-serif}#hmc-tv-load-error .hmc-tv-load-panel{max-width:850px}#hmc-tv-load-error h2{font-size:36px;line-height:1.2;margin:0 0 20px}#hmc-tv-load-error p{margin:0 0 28px}#hmc-tv-load-error .hmc-tv-load-buttons{display:flex;gap:20px;flex-wrap:wrap}#hmc-tv-load-error button{min-height:60px;min-width:150px;border:2px solid #7c8da5;border-radius:10px;padding:14px 24px;color:#fff;background:#27354c;font:600 24px/1.2 Arial,sans-serif}#hmc-tv-load-error button:focus{outline:4px solid #ffd45b;outline-offset:5px;background:#41506b}';document.head.appendChild(style);}
    overlay=document.createElement('section');overlay.id='hmc-tv-load-error';overlay.setAttribute('role','alertdialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','hmc-tv-load-heading');overlay.setAttribute('aria-describedby','hmc-tv-load-description');overlay.innerHTML='<div class="hmc-tv-load-panel"><h2 id="hmc-tv-load-heading">This page could not load</h2><p id="hmc-tv-load-description">The server is taking too long to load this title. Go back to keep browsing, or try loading this page again.</p><div class="hmc-tv-load-buttons"><button type="button" data-tv-load-action="back">← Back</button><button type="button" data-tv-load-action="retry">Try again</button></div></div>';
    overlay.addEventListener('click',event=>{const action=event.target.closest('button[data-tv-load-action]')?.dataset.tvLoadAction;if(action){consume(event);if(action==='back')goBack();else retry();}});
    document.body.appendChild(overlay);if(ownsOverlay())focus(overlay.querySelector('button'));
  }
  function ownsOverlay(){return !!overlay&&relevant()&&!document.getElementById('hmc-tv-trailer');}
  function handleRemote(action,event={}){
    if(action==='back'){goBack();return;}
    if(action==='select'){if(!event.repeat)document.activeElement?.closest('#hmc-tv-load-error button')?.click();return;}
    const controls=[...overlay.querySelectorAll('button')],at=controls.indexOf(document.activeElement),direction=action==='previous'||action==='tab'&&event.shiftKey?-1:1;
    focus(controls[(Math.max(0,at)+direction+controls.length)%controls.length]);
  }
  window.addEventListener('keydown',event=>{
    if(!ownsOverlay())return;
    const action=keyAction(event);if(!action)return;consume(event);handleRemote(action,event);
  },true);
  // The client may suppress GeneralCommand emission when it has no native
  // listeners. This module handles emitted events only; it does not bypass that.
  window.addEventListener('command',event=>{if(!ownsOverlay())return;const action=commandAction(event.detail?.command);if(!action)return;consume(event);handleRemote(action);},true);
  window.addEventListener('keyup',event=>{if(ownedKeys.take(event))consume(event);},true);
  window.addEventListener('focusin',event=>{if(!ownsOverlay())return;if(overlay.contains(event.target)){lastFocus=event.target;return;}event.stopImmediatePropagation();focus(lastFocus?.isConnected?lastFocus:overlay.querySelector('button'));},true);
  window.addEventListener('hashchange',sync);window.addEventListener('popstate',sync);
  window.addEventListener('blur',()=>ownedKeys.clear());window.addEventListener('pagehide',()=>{if(routeFrame!==null)cancelAnimationFrame(routeFrame);routeFrame=null;cancel();ownedKeys.clear();});
  new MutationObserver(sync).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  // The installed client can pushState between TV views without hashchange.
  // Compare a cheap route/layout signature only; scan titles once next frame,
  // after the old view has had a chance to hide/remount. Same-route artwork or
  // other mutations never restart the deadline or trigger readiness scans here.
  new MutationObserver(()=>{
    if(routeFrame!==null||routeSignature(document.documentElement.className,location.hash)===seenRoute)return;
    routeFrame=requestAnimationFrame(()=>{routeFrame=null;if(routeSignature(document.documentElement.className,location.hash)!==seenRoute)sync();});
  }).observe(document.body,{childList:true,subtree:true});
  window.HomeMediaTVLoadRecovery={version:'0.1.2'};sync();
}());
