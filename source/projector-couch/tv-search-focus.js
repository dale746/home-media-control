/* Preserve a selected native TV Search result across late client rendering.
   No key interception, query rewriting, or changes to mobile/desktop focus. */
(function () {
  'use strict';
  function searchKey(classes, hash, inputValue) {
    if (!/(?:^|\s)layout-tv(?:\s|$)/.test(classes || '') || !/^#!?\/search(?:\?|$)/i.test(hash || '')) return null;
    const params = new URLSearchParams((hash || '').split('?')[1] || '');
    const query = inputValue == null ? params.get('query') || '' : String(inputValue);
    if (!query.trim()) return null;
    // Include both the address and current input: the box can change before
    // React commits its URL update and debounced request.
    params.sort();
    return JSON.stringify([params.toString(), query]);
  }
  function createRecovery(options) {
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const limit = options.maxAttempts || 12, interval = options.retryMs || 100;
    let record = null, timer = null, deadline = null, attempts = 0;
    function stop() {
      if (timer !== null) cancel(timer);
      if (deadline !== null) cancel(deadline);
      timer = deadline = null; record = null; attempts = 0;
      options.unwatch?.();
    }
    function contextMatches() {
      const context = options.context();
      return !!record && !!context && !context.blocked && context.key === record.key;
    }
    function queue(delay) {
      if (!record || timer !== null) return;
      timer = later(attempt, delay);
    }
    function attempt() {
      timer = null;
      if (!record) return;
      if (!contextMatches() || !options.isBody(options.active())) { stop(); return; }
      // A reinserted original node is outside this narrow replacement repair.
      if (record.node.isConnected) { stop(); return; }
      const target = options.find(record.identity);
      if (target && target !== record.node && target.isConnected) {
        record.node = target; attempts = 0;
        options.focus(target);
        return;
      }
      if (++attempts >= limit) { stop(); return; }
      queue(interval);
    }
    return {
      remember(node, identity) {
        stop();
        const context = options.context();
        if (!node?.isConnected || !identity || !context || context.blocked) return false;
        record = { node, identity, key: context.key };
        options.watch?.(node);
        deadline = later(stop, options.watchMs || 5000);
        return true;
      },
      mutated() {
        // Constant-time check for ordinary result insertion/decoration. Only a
        // disconnected selection schedules a scoped replacement lookup.
        if (record && !record.node.isConnected) queue(0);
      },
      sync() { if (record && !contextMatches()) stop(); },
      clear: stop,
      state() { return { armed: !!record, attempts, identity: record?.identity || null }; }
    };
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { searchKey, createRecovery };
    return;
  }
  if (window.HomeMediaTVSearchFocus) return;
  function visible(node) {
    if (!node?.isConnected || node.hidden || node.disabled || node.getAttribute('aria-disabled') === 'true' ||
        node.closest('[hidden],[inert],[aria-hidden="true"]') || !node.getClientRects().length) return false;
    for (let part = node; part && part !== document.body; part = part.parentElement) {
      const css = getComputedStyle(part);
      if (css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return false;
    }
    return true;
  }
  function identity(node) {
    if (!node?.matches('button.card[data-id]') || !node.closest('#searchPage') || node.closest('.jellyseerr-section')) return null;
    const id = node.getAttribute('data-id'), server = node.getAttribute('data-serverid') || '';
    if (!/^[a-f\d]{32}$/i.test(id || '')) return null;
    return { id, server };
  }
  function context() {
    const input = document.querySelector('#searchPage #searchTextInput');
    const key = searchKey(document.documentElement.className, location.hash, input?.value);
    if (!key) return null;
    const blocked = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],.dialogContainer,#hmc-tv-actions-menu,#hmc-tv-trailer,#hmc-tv-load-error')].some(visible);
    return { key, blocked };
  }
  const observer = new MutationObserver(() => recovery.mutated());
  const recovery = createRecovery({
    context,
    active: () => document.activeElement,
    isBody: node => !node || node === document.body || node === document.documentElement,
    watch: node => {
      const page = node.closest('#searchPage');
      if (page) observer.observe(page, { childList: true, subtree: true });
    },
    unwatch: () => observer.disconnect(),
    find: wanted => {
      const page = document.getElementById('searchPage');
      if (!page) return null;
      for (const node of page.querySelectorAll('button.card[data-id]')) {
        const candidate = identity(node);
        if (candidate && candidate.id === wanted.id && candidate.server === wanted.server && visible(node)) return node;
      }
      return null;
    },
    focus: node => node.focus({ preventScroll: true })
  });
  document.addEventListener('focusin', event => {
    const card = event.target.closest?.('#searchPage button.card[data-id]');
    const value = identity(card);
    if (value && visible(card)) recovery.remember(card, value);
    else recovery.clear();
  }, true);
  // An edit cancels the previous selection before the native 500 ms debounce.
  document.addEventListener('input', event => {
    if (event.target.matches?.('#searchPage #searchTextInput')) recovery.clear();
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('#searchPage button.card[data-id]')) recovery.clear();
  }, { capture: true, passive: true });
  window.addEventListener('hashchange', () => recovery.sync());
  window.addEventListener('popstate', () => recovery.sync());
  window.addEventListener('pagehide', () => recovery.clear());
  // Class changes are infrequent and do not scan search results.
  new MutationObserver(() => recovery.sync()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.HomeMediaTVSearchFocus = { version: '1.0.0' };
}());
