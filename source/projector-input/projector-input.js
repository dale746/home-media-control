/* Home Media Mobile-layout projector controls; Jellyfin owns normal TV navigation. */
(function () {
  'use strict';
  function isPlayerUrl(raw) {
    try{return /^#!?\/(?:video|videoosd|player)(?:[/?]|$)/i.test(new URL(raw).hash);}catch(_){return false;}
  }
  function wantsControls(ua,url,remembered,forced) {
    let query=false;
    try{query=new URL(url).searchParams.get('tv')==='1';}catch(_){}
    if(forced===true||query)return true;
    if(remembered!==null&&remembered!==undefined)return remembered==='1';
    return /VIDAA|Hisense|WebExplorer|WebViewer|Smart.?TV|HbbTV|Tizen|Web0S|NetCast/i.test(ua||'');
  }
  function keyFor(event) {
    const map={13:'Enter',23:'Enter',27:'Back',37:'ArrowLeft',38:'ArrowUp',39:'ArrowRight',40:'ArrowDown',461:'Back',10009:'Back'};
    if(['BrowserBack','GoBack','Back','Escape'].includes(event.key))return 'Back';
    return map[event.keyCode]||event.key||'';
  }
  function chooseNext(origin,candidates,direction) {
    const horizontal=direction==='left'||direction==='right',sign=direction==='left'||direction==='up'?-1:1;
    const cx=origin.left+origin.width/2,cy=origin.top+origin.height/2;
    let best=null,score=Infinity;
    for(const item of candidates) {
      const r=item.rect;
      if(item.hidden||item.disabled||!r||r.width<=1||r.height<=1)continue;
      const forward=((horizontal?r.left+r.width/2-cx:r.top+r.height/2-cy)*sign);
      if(forward<2)continue;
      const side=Math.abs(horizontal?r.top+r.height/2-cy:r.left+r.width/2-cx);
      const overlap=horizontal?Math.min(origin.top+origin.height,r.top+r.height)-Math.max(origin.top,r.top):Math.min(origin.left+origin.width,r.left+r.width)-Math.max(origin.left,r.left);
      const next=forward+side*(overlap>0?.35:2.3)+(overlap>0?0:80);
      if(next<score){best=item;score=next;}
    }
    return best;
  }
  function nativeTvOwnsKeys(path,nativeTv,overlayOpen) {
    return path.startsWith('/web')&&nativeTv;
  }
  function handlesLayout(path,mobile,nativeTv) {
    // Jellyfin owns its normal TV/Desktop navigation. Wait for an explicit
    // Mobile layout instead of taking focus during its initial loading screen.
    return !path.startsWith('/web') || mobile&&!nativeTv;
  }
  function removeLast(value){return Array.from(value).slice(0,-1).join('');}
  function nativeMenuOwnsKey(element,key) {
    if(!element?.closest)return false;
    if(element.closest('.hmc-menu'))return ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Back','Enter','Select',' '].includes(key);
    if(element.closest('.hmc-main-nav')&&['ArrowLeft','ArrowRight','Home','End'].includes(key))return true;
    return !!element.closest('.hmc-nav-trigger')&&['ArrowUp','ArrowDown'].includes(key);
  }
  function nearestTarget(origin,candidates) {
    const cx=origin.left+origin.width/2,cy=origin.top+origin.height/2;
    let best=null,distance=Infinity;
    for(const candidate of candidates) {
      const r=candidate.rect;if(!r||candidate.hidden||candidate.disabled||r.width<=1||r.height<=1)continue;
      const d=Math.hypot(r.left+r.width/2-cx,r.top+r.height/2-cy);
      if(d<distance){best=candidate;distance=d;}
    }
    return best;
  }
  if(typeof document==='undefined') {
    if(typeof module!=='undefined')module.exports={chooseNext,nearestTarget,keyFor,wantsControls,isPlayerUrl,nativeTvOwnsKeys,handlesLayout,nativeMenuOwnsKey,removeLast};
    return;
  }
  if(window.HomeMediaProjectorInput)return;
  const storageKey='hmc-projector-controls-v1';
  let remembered=null;
  try{remembered=localStorage.getItem(storageKey);}catch(_){}
  let enabled=wantsControls(navigator.userAgent,location.href,remembered,window.HomeMediaProjectorForce===true);
  let overlay=null,edit=null,caps=false,lastMove=0,lastElement=null,lastRect=null,lastIdentity=null,refreshTimer=null,installed=false;
  const selector='.card[data-id],a[href],button,input:not([type=hidden]),textarea,select,summary,[role=link],[role=button],[role=checkbox],[role=menuitem],[role=option],[tabindex="0"]';
  const textTypes=new Set(['text','password','email','search','tel','url','number']);
  const inputDescriptions=new WeakMap();
  const ownedTabStops=new Set();
  const editable=el=>!!el&&(el.tagName==='TEXTAREA'||(el.tagName==='INPUT'&&textTypes.has(el.type)));
  const movies=()=>location.pathname.startsWith('/web');
  const nativeTv=()=>movies()&&document.documentElement.classList.contains('layout-tv');
  const handles=()=>enabled&&!isPlayerUrl(location.href)&&handlesLayout(location.pathname,document.documentElement.classList.contains('layout-mobile'),nativeTv());
  const cardFor=el=>el?.closest?.('.card,.nf-cw-card,[data-testid="title-card"]');
  function primaryCard(el) {
    if(!el)return false;
    if(el.matches('.card[data-id],button.card,.nf-cw-card'))return true;
    return el.tagName==='A'&&!!cardFor(el)&&!el.matches('.hmc-favourite,.hmc-native-favourite')&&!el.closest('.cardOverlayButton-br');
  }
  function activateCard(el) {
    // Jellyfin keeps the real poster link in a transparent hover overlay. The
    // visible card owns focus, but its existing details link owns activation.
    const link=el.matches('a[href]')?el:el.querySelector('a[href*="details"],a.cardImageContainer[href],a.cardTextAction[href]');
    if(link)link.click();else el.click();
  }
  function box(el) {
    const label=el.matches('input[type=checkbox],input[type=radio]')&&el.closest('label');
    if(label)return label.getBoundingClientRect();
    if(primaryCard(el)) {
      const picture=cardFor(el)?.querySelector('.cardScalable,.nf-cw-thumb');
      if(picture?.getClientRects().length)return picture.getBoundingClientRect();
    }
    return el.getBoundingClientRect();
  }
  function visible(el) {
    if(!el?.isConnected||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[hidden],[inert],[aria-hidden=true]'))return false;
    const r=box(el);if(r.width<=1||r.height<=1)return false;
    const label=el.matches('input[type=checkbox],input[type=radio]')&&el.closest('label');
    for(let node=label||el;node&&node!==document.body;node=node.parentElement) {
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;
    }
    return true;
  }
  function scope() {
    if(overlay)return overlay;
    const dialogs=[...document.querySelectorAll('[role=dialog],[role=menu],[role=listbox],dialog[open]')].filter(visible);
    return dialogs[dialogs.length-1]||document;
  }
  function targets(root) {
    const chosen=root||scope(),seenCards=new Set();
    return [...chosen.querySelectorAll(selector)].filter(el=>{
      if(!visible(el)||el.tagName==='MAIN'||el.matches('input[type=range]')&&el.disabled)return false;
      const card=cardFor(el);
      if(card?.matches('.card[data-id]')&&el!==card&&primaryCard(el))return false;
      const parentButton=el.parentElement?.closest('button,a,[role=link],[role=button]');
      if(parentButton&&chosen.contains(parentButton))return false;
      if(primaryCard(el)) {
        const card=cardFor(el);if(seenCards.has(card))return false;seenCards.add(card);
      }
      return true;
    });
  }
  function clearFocus() {
    document.querySelectorAll('.hmc-projector-focus,.hmc-projector-card-focus').forEach(el=>el.classList.remove('hmc-projector-focus','hmc-projector-card-focus'));
  }
  function identity(el) {
    return {tag:el.tagName,id:el.id,href:el.getAttribute('href')||'',name:el.getAttribute('aria-label')||el.title||el.textContent.trim(),
      hash:el.dataset.hash||'',operation:el.dataset.jobOperation||'',card:cardFor(el)?.dataset.id||'',region:el.parentElement?.closest('[id]')?.id||''};
  }
  function remember(el) {lastElement=el;lastRect=box(el);lastIdentity=identity(el);}
  function replacement(options) {
    if(!lastIdentity)return null;
    return options.find(el=>{
      const next=identity(el),old=lastIdentity;
      if(old.id)return next.id===old.id;
      return next.tag===old.tag&&next.href===old.href&&next.name===old.name&&next.hash===old.hash&&next.operation===old.operation&&next.card===old.card&&next.region===old.region;
    });
  }
  function focus(el) {
    if(!handles()||!visible(el))return;
    clearFocus();
    const label=el.matches('input[type=checkbox],input[type=radio]')&&el.closest('label');
    (label||el).classList.add('hmc-projector-focus');
    if(primaryCard(el))cardFor(el)?.classList.add('hmc-projector-card-focus');
    if(!el.matches('a[href],button,input,textarea,select,summary,[tabindex]')){el.tabIndex=0;ownedTabStops.add(el);}
    el.focus({preventScroll:true});
    const visual=primaryCard(el)?cardFor(el):el;
    visual.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});
    remember(el);
  }
  function initialFocus() {
    const options=targets();if(!options.length)return;
    const visibleOptions=options.filter(el=>{const r=box(el);return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;});
    focus(visibleOptions[0]||options[0]);
  }
  function prepareInputs() {
    if(!handles())return;
    document.querySelectorAll('input,textarea').forEach(el=>{
      if(editable(el)&&!el.readOnly&&!el.disabled) {
        inputDescriptions.set(el,el.getAttribute('aria-description'));
        el.readOnly=true;el.dataset.hmcProjectorEditable='1';
        el.setAttribute('aria-description','Press OK to open the on-screen keyboard');
      }
    });
  }
  function restoreInputs() {
    document.querySelectorAll('[data-hmc-projector-editable]').forEach(el=>{
      el.readOnly=false;delete el.dataset.hmcProjectorEditable;
      const description=inputDescriptions.get(el);
      if(description===null||description===undefined)el.removeAttribute('aria-description');else el.setAttribute('aria-description',description);
      inputDescriptions.delete(el);
    });
  }
  function releaseControls() {
    if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null;}
    if(overlay){overlay.remove();overlay=null;edit=null;}
    restoreInputs();clearFocus();
    for(const el of ownedTabStops)if(el.getAttribute('tabindex')==='0')el.removeAttribute('tabindex');
    ownedTabStops.clear();
    lastElement=null;lastRect=null;lastIdentity=null;
  }
  function move(direction) {
    const now=Date.now();if(now-lastMove<80)return;lastMove=now;
    const options=targets(),current=document.activeElement;
    if(!options.includes(current)){initialFocus();return;}
    const origin=box(current);let candidates=options.filter(el=>el!==current);
    // Left/right from a poster stays in the poster row; Up reaches its quick
    // heart, while Down can visit the next row's heart and poster in turn.
    if(primaryCard(current)&&(direction==='left'||direction==='right')) {
      const lane=candidates.filter(el=>primaryCard(el)&&Math.min(box(el).top+box(el).height,origin.top+origin.height)>Math.max(box(el).top,origin.top));
      const next=chooseNext(origin,lane.map(element=>({element,rect:box(element)})),direction);
      if(next){focus(next.element);return;}
      candidates=candidates.filter(el=>cardFor(el)!==cardFor(current));
    }
    const next=chooseNext(origin,candidates.map(element=>({element,rect:box(element)})),direction);
    if(next)focus(next.element);
    else if(!overlay&&(direction==='up'||direction==='down'))window.scrollBy({top:direction==='down'?innerHeight*.55:-innerHeight*.55,behavior:'auto'});
  }
  function button(label, action, className) {
    const el = document.createElement('button');
    el.type = 'button'; el.textContent = label; el.className = className || '';
    el.addEventListener('click', action);
    return el;
  }
  function modal(title) {
    const root = document.createElement('div');
    root.id = 'hmc-projector-keyboard'; root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title);
    const panel = document.createElement('div'); panel.className = 'hmc-projector-keyboard-panel';
    const heading = document.createElement('h2'); heading.textContent = title;
    panel.appendChild(heading); root.appendChild(panel); document.body.appendChild(root);
    overlay = root;
    return panel;
  }
  function closeModal() {
    const target = edit && edit.target;
    if (overlay) overlay.remove();
    overlay = null; edit = null;
    if (target && target.isConnected) focus(target); else initialFocus();
  }
  function targetForEdit() {
    if (edit.target.isConnected) return edit.target;
    if (edit.id) {
      const found = document.getElementById(edit.id);
      if (editable(found)) return found;
    }
    if (edit.name) {
      const found = Array.from(document.getElementsByName(edit.name)).find(el => editable(el) && el.type === edit.type);
      if (found) return found;
    }
    return null;
  }
  function writeControlledValue(target, value) {
    const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : target.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function openKeyboard(target) {
    if (overlay || !target.dataset.hmcProjectorEditable) return;
    const label = target.getAttribute('aria-label') || (target.labels && target.labels[0] && target.labels[0].textContent.trim()) || target.placeholder || (target.type === 'password' ? 'Password' : target.type === 'search' ? 'Search' : 'Enter text');
    edit = { target, id: target.id, name: target.name, type: target.type, buffer: target.value || '', secret: target.type === 'password', maximum: target.maxLength > 0 ? Math.min(target.maxLength, 1024) : 1024 };
    caps = false;
    const panel = modal(label);
    const display = document.createElement('div'); display.className = 'hmc-projector-entry'; display.setAttribute('aria-label', 'Text being entered');
    panel.appendChild(display);
    const redraw = () => { display.textContent = edit.secret ? '•'.repeat(Array.from(edit.buffer).length) : edit.buffer || ' '; };
    const append = value => { if (Array.from(edit.buffer).length < edit.maximum) { edit.buffer += value; redraw(); } };
    const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '@._-!?#/:\''];
    const letters = [];
    for (const row of rows) {
      const group = document.createElement('div'); group.className = 'hmc-projector-key-row';
      for (const character of Array.from(row)) {
        const key = button(character, () => append(caps ? character.toUpperCase() : character));
        if (/[a-z]/.test(character)) letters.push([key, character]);
        group.appendChild(key);
      }
      panel.appendChild(group);
    }
    const controls = document.createElement('div'); controls.className = 'hmc-projector-key-row hmc-projector-actions';
    const capsKey = button('ABC', () => { caps = !caps; capsKey.setAttribute('aria-pressed', String(caps)); for (const [key, character] of letters) key.textContent = caps ? character.toUpperCase() : character; });
    capsKey.setAttribute('aria-label', 'Uppercase letters'); capsKey.setAttribute('aria-pressed', 'false');
    controls.append(capsKey, button('Space', () => append(' ')), button('⌫ Delete', () => { edit.buffer = removeLast(edit.buffer); redraw(); }), button('Clear', () => { edit.buffer = ''; redraw(); }));
    panel.appendChild(controls);
    const finish = document.createElement('div'); finish.className = 'hmc-projector-key-row hmc-projector-actions';
    finish.append(button('Cancel', closeModal), button('Done', () => {
      const destination = targetForEdit(), value = edit.buffer;
      closeModal();
      if (destination) { writeControlledValue(destination, value); setTimeout(() => { if (destination.isConnected) focus(destination); }, 30); }
    }, 'hmc-projector-primary'));
    panel.appendChild(finish); redraw();
    focus(letters.length ? letters[0][0] : panel.querySelector('button'));
  }
  function openSelect(target) {
    if (overlay) return;
    edit = { target };
    const panel = modal(target.getAttribute('aria-label') || 'Choose an option');
    const list = document.createElement('div'); list.className = 'hmc-projector-options';
    let selected;
    for (const option of Array.from(target.options)) {
      if (option.disabled) continue;
      const choice = button(option.textContent, () => { closeModal(); writeControlledValue(target, option.value); });
      if (option.selected) { selected = choice; choice.setAttribute('aria-current', 'true'); }
      list.appendChild(choice);
    }
    panel.append(list, button('Cancel', closeModal));
    focus(selected || list.querySelector('button'));
  }
  function activate() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) { initialFocus(); return; }
    if (editable(el)) openKeyboard(el);
    else if (el.tagName === 'SELECT') openSelect(el);
    else if (primaryCard(el)) activateCard(el);
    else if (el.getAttribute('role') === 'link' && el.tagName !== 'A') {
      const link = el.querySelector('a[href]');
      if (link) link.click(); else el.click();
    }
    else el.click();
  }

  function handleBack(event) {
    if(overlay){event.preventDefault();event.stopImmediatePropagation();closeModal();return;}
    const current=scope();
    if(current!==document) {
      event.preventDefault();event.stopImmediatePropagation();
      const close=targets(current).find(el=>/^(close|cancel|back)$/i.test(el.getAttribute('aria-label')||el.textContent.trim()));
      if(close)close.click();
      else {
        const escape=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true});
        Object.defineProperty(escape,'hmcProjectorPass',{value:true});(document.activeElement||current).dispatchEvent(escape);
      }
      return;
    }
    const back=[...document.querySelectorAll('.hmc-back-button,.headerBackButton,.btnBack,.btnGoBack,button[aria-label="Back"]')].find(visible);
    if(back){event.preventDefault();event.stopImmediatePropagation();back.click();}
    else if(history.length>1){event.preventDefault();event.stopImmediatePropagation();history.back();}
  }
  function scheduleRefresh() {
    if(!handles()||refreshTimer)return;
    refreshTimer=setTimeout(()=>{
      refreshTimer=null;if(!handles())return;prepareInputs();
      if(!document.activeElement||document.activeElement===document.body||!document.activeElement.isConnected||document.activeElement.tagName==='MAIN') {
        if(visible(lastElement))focus(lastElement);
        else {
          const options=targets(),same=replacement(options);
          const near=!same&&lastRect?nearestTarget(lastRect,options.map(element=>({element,rect:box(element)}))):null;
          if(same||near)focus(same||near.element);else initialFocus();
        }
      }
    },150);
  }
  function install() {
    if(installed)return;installed=true;
    const style=document.createElement('style');style.id='hmc-projector-input-style';
    style.textContent='html .hmc-projector-focus{outline:3px solid #ffd45b!important;outline-offset:3px!important}html .hmc-projector-card-focus .cardScalable,html .hmc-projector-card-focus .nf-cw-thumb{outline:3px solid #ffd45b!important;outline-offset:-3px!important}#hmc-projector-keyboard{position:fixed;inset:0;z-index:2147483600;background:#050713ec;display:flex;align-items:center;justify-content:center;padding:18px;color:#fff;font:22px/1.3 Arial,sans-serif}#hmc-projector-keyboard *{box-sizing:border-box}.hmc-projector-keyboard-panel{width:min(960px,94vw);max-height:96vh;overflow:auto;background:#111827;border:2px solid #71809b;border-radius:16px;padding:20px}.hmc-projector-keyboard-panel h2{margin:0 0 12px;font-size:25px}.hmc-projector-entry{min-height:48px;border:2px solid #8994ac;background:#060b17;border-radius:8px;padding:9px;margin-bottom:14px;overflow-wrap:anywhere}.hmc-projector-key-row{display:flex;gap:8px;justify-content:center;margin:9px 0}#hmc-projector-keyboard button{flex:1 1 0;max-width:78px;min-height:44px;padding:8px 4px;color:#fff;background:#2e3d58;border:1px solid #7c8ca8;border-radius:7px;font:21px Arial}#hmc-projector-keyboard .hmc-projector-actions button{max-width:none}#hmc-projector-keyboard .hmc-projector-primary{background:#3859d8}#hmc-projector-keyboard button.hmc-projector-focus{color:#101828;background:#ffe08a}';
    document.head.appendChild(style);
    document.addEventListener('keydown',event=>{
      if(event.hmcProjectorPass||!handles())return;
      const key=keyFor(event),el=document.activeElement;
      if(el?.isContentEditable)return;
      if(nativeMenuOwnsKey(el,key)) {
        // Leave our shared menu's native navigation in charge even if this
        // capture listener was installed first. Normalize old remote codes.
        const nativeKey=key==='Back'?'Escape':key==='Select'?'Enter':key;
        if(event.key!==nativeKey) {
          event.preventDefault();event.stopImmediatePropagation();
          const delegated=new KeyboardEvent('keydown',{key:nativeKey,bubbles:true,cancelable:true});
          Object.defineProperty(delegated,'hmcProjectorPass',{value:true});el.dispatchEvent(delegated);
        }
        return;
      }
      if(el?.matches('input[type=range]')&&(key==='ArrowLeft'||key==='ArrowRight'))return;
      if(/^Arrow(?:Left|Right|Up|Down)$/.test(key)){event.preventDefault();event.stopImmediatePropagation();move(key.slice(5).toLowerCase());}
      else if(key==='Enter'||key==='Select'){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)activate();}
      else if(key==='Back'||key==='Backspace'&&!editable(el))handleBack(event);
    },true);
    document.addEventListener('click',event=>{
      if(!handles()||overlay)return;
      const target=event.target.closest?.('input,textarea,select');
      if(editable(target)&&target.dataset.hmcProjectorEditable){event.preventDefault();event.stopImmediatePropagation();openKeyboard(target);}
      else if(target?.tagName==='SELECT'){event.preventDefault();event.stopImmediatePropagation();openSelect(target);}
    },true);
    document.addEventListener('focusin',event=>{
      if(!handles()||!event.target.matches?.(selector)||!visible(event.target))return;
      clearFocus();event.target.classList.add('hmc-projector-focus');if(primaryCard(event.target))cardFor(event.target)?.classList.add('hmc-projector-card-focus');
      remember(event.target);
    });
    new MutationObserver(scheduleRefresh).observe(document.body,{childList:true,subtree:true});
    new MutationObserver(()=>{
      if(!handles())releaseControls();else scheduleRefresh();
    }).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
    window.addEventListener('hashchange',()=>{clearFocus();if(overlay)closeModal();scheduleRefresh();});
    prepareInputs();scheduleRefresh();
  }
  function setEnabled(value) {
    enabled=!!value;
    try{localStorage.setItem(storageKey,enabled?'1':'0');}catch(_){}
    document.documentElement.dataset.hmcProjectorInput=enabled?'1.1.0':'off';
    if(enabled){install();scheduleRefresh();}
    else {
      releaseControls();
    }
  }
  window.HomeMediaProjectorInput=Object.freeze({enable:()=>setEnabled(true),disable:()=>setEnabled(false),isEnabled:()=>enabled,version:'1.1.0'});
  document.addEventListener('hmc-projector-controls',()=>setEnabled(true));
  if(enabled){document.documentElement.dataset.hmcProjectorInput='1.1.0';install();}
}());
