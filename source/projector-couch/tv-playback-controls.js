/* TV playback keeps native watching controls and hides only the unwanted extras. */
(function () {
  'use strict';
  const targetSelector = '#enhancedSettingsBtn,#jeBookmarkBtn,.btnUserRating,.btnFullscreen,.btnPip';
  const targetIds = new Set(['enhancedSettingsBtn','jeBookmarkBtn']);
  const targetClasses = new Set(['btnUserRating','btnFullscreen','btnPip']);
  function enabled(classes,hash) {
    return /(?:^|\s)layout-tv(?:\s|$)/.test(classes || '') && /^#!?\/(?:video|videoosd|player)(?:[/?]|$)/i.test(hash || '');
  }
  function isBlockedControl(info) {
    return targetIds.has(info?.id) || (info?.className || '').split(/\s+/).some(value => targetClasses.has(value));
  }
  function recoverFocus(options) {
    if (!options.enabled || !options.focused || !options.blocked) return false;
    if (options.pause && options.canFocus(options.pause)) {
      options.pause.focus({preventScroll:true});
      if (options.current && options.current() !== options.pause) options.focused.blur?.();
    } else options.focused.blur?.();
    return true;
  }
  const prefix = 'html.layout-tv[data-hmc-tv-playback-simple="1"] #videoOsdPage ';
  const css = targetSelector.split(',').map(selector => prefix + selector).join(',') + '{display:none!important}';
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = {enabled,isBlockedControl,recoverFocus,targetSelector,css};
    return;
  }
  if (window.HomeMediaTVPlaybackControls) return;
  let scheduled = false;
  const html = document.documentElement;
  const style = document.createElement('style');
  style.id = 'hmc-tv-playback-controls-style';
  style.textContent = css;
  document.head.appendChild(style);

  function visible(node) {
    if (!node?.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true' || !node.getClientRects().length) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true' || parent.classList.contains('hide') || parent.classList.contains('videoOsdBottom-hidden')) return false;
      const computed = getComputedStyle(parent);
      if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse' || computed.opacity === '0') return false;
    }
    return true;
  }
  function update() {
    scheduled = false;
    const active = enabled(html.className,location.hash);
    const focused = document.activeElement;
    if (active) {
      if (html.dataset.hmcTvPlaybackSimple !== '1') html.dataset.hmcTvPlaybackSimple = '1';
    } else {
      if (html.dataset.hmcTvPlaybackSimple !== undefined) delete html.dataset.hmcTvPlaybackSimple;
      return;
    }
    const blocked = focused?.closest?.(targetSelector);
    if (!blocked || !blocked.closest('#videoOsdPage') || !isBlockedControl(blocked)) return;
    recoverFocus({enabled:true,focused,blocked,pause:document.querySelector('#videoOsdPage .btnPause'),
      canFocus:visible,current:() => document.activeElement});
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(update);
    else setTimeout(update,0);
  }
  // CSS also covers plugin controls inserted later. Observation only repairs
  // actual focus on a newly hidden control; it never opens or pins the OSD.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['id','class','hidden','aria-hidden']});
  const layoutObserver = new MutationObserver(schedule);
  layoutObserver.observe(html,{attributes:true,attributeFilter:['class']});
  document.addEventListener('focusin',schedule,true);
  window.addEventListener('hashchange',schedule);
  window.addEventListener('popstate',schedule);
  window.HomeMediaTVPlaybackControls = {version:'0.1.0',refresh:schedule};
  update();
}());
