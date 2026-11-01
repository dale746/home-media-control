/* Staged TV-only trailer controls. No server configuration or media is changed. */
(function () {
  'use strict';
  const VERSION = '0.1.2';
  const PENDING = new Set(['resolving', 'loading', 'buffering']);
  function youtubeId(raw) {
    try {
      const url = new URL(raw);
      if (url.username || url.password) return null;
      let id;
      if (url.protocol === 'plugin:' && url.hostname === 'plugin.video.youtube') id = url.searchParams.get('video_id') || url.searchParams.get('videoid');
      else if (/^https?:$/.test(url.protocol)) {
        if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
        else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
          id = url.searchParams.get('v');
          if (!id && /^\/(embed|shorts|live)\//.test(url.pathname)) id = url.pathname.split('/')[2];
        }
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch (_) { return null; }
  }
  function remoteAction(event) {
    const codes = {13:'select',23:'select',27:'back',461:'back',10009:'back',37:'left',38:'up',39:'right',40:'down',179:'toggle',10252:'toggle',415:'play',19:'pause',413:'stop',417:'forward',412:'rewind'};
    const keys = {Enter:'select',Select:'select',Escape:'back',Back:'back',BrowserBack:'back',GoBack:'back',Backspace:'back',ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',MediaPlayPause:'toggle',PlayPause:'toggle',MediaPlay:'play',MediaPause:'pause',MediaStop:'stop',MediaFastForward:'forward',MediaRewind:'rewind',Tab:'tab'};
    return keys[event.key] || codes[event.keyCode] || null;
  }
  function commandAction(value) {
    if(typeof value!=='string')return null;
    return {left:'left',right:'right',up:'up',down:'down',select:'select',back:'back',playpause:'toggle',play:'play',pause:'pause',stop:'stop',rewind:'rewind',fastforward:'forward'}[value.toLowerCase()]||null;
  }
  function trailerError(code) {
    if ([100,101,150].includes(Number(code))) return 'This trailer is unavailable or cannot play here. You can go back or try again.';
    if (Number(code) === 153) return 'YouTube could not verify this player. You can go back or try again.';
    return 'The trailer could not play. You can go back or try again.';
  }
  function createLifecycle(options = {}) {
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const notify = options.onChange || (() => {}), timeout = options.timeoutMs || 18000;
    let state = {generation:0, phase:'closed', error:null}, timer = null;
    function clear() { if (timer !== null) cancel(timer); timer = null; }
    // Error is terminal for this generation. A delayed success must not revive
    // a timed-out session; only an explicit retry starts a new generation.
    function active(generation) { return generation === state.generation && !['closed','error'].includes(state.phase); }
    function publish() { notify({...state}); }
    function update(generation, phase, error = null) {
      if (!active(generation)) return false;
      clear(); state = {...state, phase, error};
      if (PENDING.has(phase)) timer = later(() => update(generation, 'error', 'The trailer took too long to respond. You can go back or try again.'), timeout);
      publish(); return true;
    }
    return {
      begin() { clear(); state = {generation:state.generation + 1, phase:'resolving', error:null}; update(state.generation, 'resolving'); return state.generation; },
      update, active,
      close() { clear(); state = {generation:state.generation + 1, phase:'closed', error:null}; publish(); },
      getState() { return {...state}; }
    };
  }
  function seekTarget(current, delta, duration) {
    const time = Number.isFinite(current) ? current : 0;
    return Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : Infinity, time + delta));
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
    if (typeof module !== 'undefined') module.exports = {youtubeId,remoteAction,commandAction,trailerError,createLifecycle,seekTarget,createOwnedKeys};
    return;
  }
  if (window.HomeMediaTVCouch) return;
  const isTv = () => document.documentElement.classList.contains('layout-tv');
  const trailerSelector = 'button.btnPlayTrailer,a[data-hmc-trailer]';
  let dialog = null, player = null, playerReady = false, opener = null, openerRoute = null;
  let requestedLink = null, requestedItem = null, requestedTitle = '', apiPromise = null, oldOverflow = null;
  const lifecycle = createLifecycle({onChange:render});
  const ownedKeys = createOwnedKeys();
  function consume(event) { if (event.type === 'keydown') ownedKeys.own(event); event.preventDefault(); event.stopImmediatePropagation(); }
  function visibleButtons() { return dialog ? [...dialog.querySelectorAll('button')].filter(button => !button.disabled && !button.closest('[hidden]')) : []; }
  function focus(button) { if (button?.isConnected) button.focus({preventScroll:true}); }
  function safePlayer(method, ...args) {
    try { return player && typeof player[method] === 'function' ? player[method](...args) : undefined; } catch (_) { return undefined; }
  }
  function stopPlayer() {
    // Both calls are public IFrame API methods. Removing the frame also stops
    // audio when the API never becomes ready or a network request is pending.
    safePlayer('stopVideo'); safePlayer('destroy'); player = null; playerReady = false;
    dialog?.querySelector('[data-tv-player]')?.replaceChildren();
  }
  function close(restoreFocus = true) {
    if (!dialog) return;
    lifecycle.close(); stopPlayer(); dialog.remove(); dialog = null;
    if (oldOverflow !== null) document.body.style.overflow = oldOverflow;
    oldOverflow = null;
    if (restoreFocus && isTv() && location.hash === openerRoute) {
      const target = opener?.isConnected ? opener : document.querySelector(trailerSelector);
      focus(target);
    }
    opener = null;
  }
  function loadYoutube() {
    if (window.YT && typeof window.YT.Player === 'function') return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      let completed = false, script = document.querySelector('script[src="https://www.youtube.com/iframe_api"]'), owned = false;
      function finish(error) {
        if (completed) return; completed = true; clearTimeout(timer);
        if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
        script?.removeEventListener('error', failed);
        if (error) { if (owned) script?.remove(); reject(error); }
        else resolve(window.YT);
      }
      function ready() {
        try { if (typeof previous === 'function') previous(); }
        finally { finish(window.YT && typeof window.YT.Player === 'function' ? null : new Error('Player unavailable')); }
      }
      function failed() { finish(new Error('Player connection failed')); }
      const timer = setTimeout(() => finish(new Error('Player connection timed out')), 12000);
      window.onYouTubeIframeAPIReady = ready;
      if (!script) { script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true; owned = true; }
      script.addEventListener('error', failed, {once:true});
      if (owned) document.head.appendChild(script);
    }).catch(error => { apiPromise = null; throw error; });
    return apiPromise;
  }
  function mount() {
    if (dialog) return;
    if (!document.getElementById('hmc-tv-couch-style')) {
      const style = document.createElement('style'); style.id = 'hmc-tv-couch-style';
      style.textContent = '#hmc-tv-trailer{position:fixed;inset:0;z-index:2147483600;background:#05070bf5;color:#fff;display:flex;align-items:center;justify-content:center;padding:3vh 4vw;box-sizing:border-box;font:22px/1.4 Arial,sans-serif}#hmc-tv-trailer *{box-sizing:border-box}#hmc-tv-trailer [hidden]{display:none!important}.hmc-tv-trailer-panel{width:min(1120px,92vw);max-height:94vh;overflow:auto}.hmc-tv-trailer-heading{font-size:clamp(24px,2.4vw,34px);margin:0 0 12px}.hmc-tv-trailer-player{position:relative;background:#000;width:100%;aspect-ratio:16/9;max-height:62vh;overflow:hidden}.hmc-tv-trailer-player>div,.hmc-tv-trailer-player iframe{width:100%!important;height:100%!important;position:absolute;inset:0;border:0}.hmc-tv-trailer-player iframe{pointer-events:none}.hmc-tv-trailer-status{min-height:2.8em;margin:12px 0;color:#f1f2f6;overflow-wrap:anywhere}.hmc-tv-trailer-buttons{display:flex;flex-wrap:wrap;gap:14px}#hmc-tv-trailer button{color:#fff;background:#263247;border:2px solid #758198;border-radius:9px;min-height:56px;min-width:118px;padding:12px 22px;font:600 22px/1.2 Arial,sans-serif}#hmc-tv-trailer button:focus{outline:4px solid #ffd45b;outline-offset:4px;background:#414c5e}#hmc-tv-trailer button[data-tv-action=back]{background:#131b29}';
      document.head.appendChild(style);
    }
    dialog = document.createElement('section'); dialog.id = 'hmc-tv-trailer'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','hmc-tv-trailer-heading');
    dialog.innerHTML = '<div class="hmc-tv-trailer-panel"><h2 id="hmc-tv-trailer-heading" class="hmc-tv-trailer-heading"></h2><div class="hmc-tv-trailer-player" data-tv-player></div><p class="hmc-tv-trailer-status" data-tv-status role="status" aria-live="polite"></p><div class="hmc-tv-trailer-buttons"><button type="button" data-tv-action="back" aria-label="Back">← Back</button><button type="button" data-tv-action="toggle" hidden>Pause</button><button type="button" data-tv-action="rewind" hidden>−10 seconds</button><button type="button" data-tv-action="forward" hidden>+10 seconds</button><button type="button" data-tv-action="retry" hidden>Try again</button></div></div>';
    dialog.querySelector('h2').textContent = 'Trailer — ' + (requestedTitle || 'Movie');
    dialog.addEventListener('click', event => { const action = event.target.closest('button[data-tv-action]')?.dataset.tvAction; if (action) { consume(event); act(action); } });
    dialog.addEventListener('focusin', event => { if (event.target.tagName === 'IFRAME') focus(dialog.querySelector('[data-tv-action=back]')); });
    oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; document.body.appendChild(dialog);
    focus(dialog.querySelector('[data-tv-action=back]'));
  }
  function render(state) {
    if (!dialog || state.phase === 'closed') return;
    dialog.dataset.phase = state.phase;
    dialog.setAttribute('aria-busy', PENDING.has(state.phase) ? 'true' : 'false');
    const messages = {resolving:'Finding the trailer… Back is always available.',loading:'Loading the trailer… Back is always available.',buffering:'The trailer is buffering… Back is always available.',playing:'Playing trailer',paused:'Paused. Select Play to continue.',ended:'Trailer finished. Select Play to watch again.',ready:'Select Play to start.'};
    dialog.querySelector('[data-tv-status]').textContent = state.error || messages[state.phase] || '';
    const showControls = playerReady && state.phase !== 'error';
    for (const button of dialog.querySelectorAll('button')) {
      const action = button.dataset.tvAction;
      button.hidden = action === 'retry' ? state.phase !== 'error' : action !== 'back' && !showControls;
      if (action === 'toggle') button.textContent = state.phase === 'playing' || state.phase === 'buffering' ? 'Pause' : 'Play';
    }
    if (state.phase === 'error') { stopPlayer(); if (document.activeElement?.closest('[hidden]')) focus(dialog.querySelector('[data-tv-action=back]')); }
  }
  function fail(generation, message) { if (lifecycle.active(generation)) lifecycle.update(generation,'error',message); }
  function resolveVideo() {
    const direct = youtubeId(requestedLink); if (direct) return Promise.resolve(direct);
    const api = window.ApiClient;
    if (!requestedItem || !api?.getItem || !api?.getCurrentUserId) return Promise.resolve(null);
    return Promise.resolve().then(() => api.getItem(api.getCurrentUserId(), requestedItem)).then(item => (item.RemoteTrailers || []).map(video => youtubeId(video.Url)).find(Boolean) || null);
  }
  function start() {
    stopPlayer(); const generation = lifecycle.begin();
    resolveVideo().then(id => {
      if (!lifecycle.active(generation) || !isTv() || !dialog) return;
      if (!id) { fail(generation,'No playable trailer is available for this title. You can go back.'); return; }
      lifecycle.update(generation,'loading');
      return loadYoutube().then(YT => {
        if (!lifecycle.active(generation) || !isTv() || !dialog) return;
        const host = document.createElement('iframe'); host.id = 'hmc-tv-trailer-frame-' + generation;
        // Configure the frame before its first request, including the referrer
        // required by YouTube. The public API supports an existing iframe.
        const params = new URLSearchParams({enablejsapi:'1',origin:location.origin,playsinline:'1',autoplay:'1',controls:'0',disablekb:'1',rel:'0'});
        host.src = 'https://www.youtube.com/embed/' + id + '?' + params;
        host.tabIndex = -1; host.setAttribute('aria-hidden','true'); host.setAttribute('title','Trailer video');
        host.setAttribute('referrerpolicy','strict-origin-when-cross-origin'); host.setAttribute('allow','autoplay; encrypted-media');
        dialog.querySelector('[data-tv-player]').appendChild(host);
        const instance = new YT.Player(host, {videoId:id,events:{
          onReady(event) {
            if (!lifecycle.active(generation) || !dialog) { try { event.target.stopVideo(); event.target.destroy(); } catch (_) {} return; }
            player = event.target; playerReady = true;
            const iframe = safePlayer('getIframe'); if (iframe) { iframe.tabIndex = -1; iframe.setAttribute('aria-hidden','true'); iframe.setAttribute('title','Trailer video'); iframe.setAttribute('referrerpolicy','strict-origin-when-cross-origin'); }
            lifecycle.update(generation,'loading'); safePlayer('playVideo');
          },
          onStateChange(event) {
            if (!lifecycle.active(generation)) return;
            const phases = {0:'ended',1:'playing',2:'paused',3:'buffering',5:'ready'};
            if (phases[event.data]) lifecycle.update(generation,phases[event.data]);
          },
          onError(event) { fail(generation,trailerError(event.data)); },
          onAutoplayBlocked() { if (lifecycle.active(generation)) lifecycle.update(generation,'paused'); }
        }});
        if (!lifecycle.active(generation)) { try { instance.stopVideo(); instance.destroy(); } catch (_) {} }
        else player = instance;
      });
    }).catch(() => fail(generation,'The trailer connection failed. You can go back or try again.'));
  }
  function open(button) {
    if (dialog) return;
    opener = button; openerRoute = location.hash; requestedLink = button.getAttribute('href');
    requestedItem = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
    requestedTitle = document.querySelector('.itemName,.detailPagePrimaryContainer h1,h1')?.textContent.trim() || '';
    mount(); start();
  }
  function act(action) {
    if (action === 'back' || action === 'stop') { close(); return; }
    if (action === 'retry') { start(); focus(dialog.querySelector('[data-tv-action=back]')); return; }
    if (!playerReady || lifecycle.getState().phase === 'error') return;
    if (action === 'toggle') action = ['playing','buffering'].includes(lifecycle.getState().phase) ? 'pause' : 'play';
    if (action === 'play') { lifecycle.update(lifecycle.getState().generation,'loading'); safePlayer('playVideo'); }
    else if (action === 'pause') { safePlayer('pauseVideo'); lifecycle.update(lifecycle.getState().generation,'paused'); }
    else if (action === 'rewind' || action === 'forward') safePlayer('seekTo',seekTarget(safePlayer('getCurrentTime'),action === 'forward' ? 10 : -10,safePlayer('getDuration')),true);
  }
  function handleRemote(action,event={}) {
    if (action === 'back' || action === 'stop') { close(); return; }
    if (action === 'select') { if (!event.repeat) document.activeElement?.closest('#hmc-tv-trailer button')?.click(); return; }
    const buttons = visibleButtons(), at = buttons.indexOf(document.activeElement);
    if (['left','right','tab'].includes(action)) {
      const direction = action === 'left' || action === 'tab' && event.shiftKey ? -1 : 1;
      focus(buttons[(Math.max(0,at) + direction + buttons.length) % buttons.length]);
    } else if (action === 'up') focus(buttons[0]);
    else if (action === 'down') focus(buttons[1] || buttons[0]);
    else if (!event.repeat) act(action);
  }
  function keydown(event) {
    if (!dialog) return;
    if (!isTv()) { close(false); return; }
    const action = remoteAction(event); if (!action) return;
    consume(event);handleRemote(action,event);
  }
  window.addEventListener('click', event => {
    if (!isTv()) return;
    const button = event.target.closest?.(trailerSelector); if (!button) return;
    consume(event); open(button);
  },true);
  window.addEventListener('keydown',keydown,true);
  // This receives only command events that the installed client actually emits;
  // it does not register with or bypass its native listener-count gate.
  window.addEventListener('command',event=>{if(!dialog||!isTv())return;const action=commandAction(event.detail?.command);if(!action)return;consume(event);handleRemote(action);},true);
  // Closing a dialog during keydown must still consume that key's release.
  // Never intercept a keyup whose keydown belonged to the native client.
  window.addEventListener('keyup',event => { if (ownedKeys.take(event)) consume(event); },true);
  window.addEventListener('hashchange',() => close(false));
  window.addEventListener('popstate',() => close(false));
  window.addEventListener('blur',() => ownedKeys.clear());
  window.addEventListener('pagehide',() => { close(false); ownedKeys.clear(); });
  new MutationObserver(() => { if (dialog && !isTv()) close(false); }).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  window.HomeMediaTVCouch = {version:VERSION,close:() => close()};
}());
