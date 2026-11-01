/* Home Media compact navigation, alongside Custom Theme and Jellyfin Enhanced. */
(function () {
  'use strict';
  if (document.getElementById('hmc-navigation-style')) return;
  const style = document.createElement('style');
  style.id = 'hmc-navigation-style';
  style.textContent = __HMC_CSS__;
  document.head.appendChild(style);
  const channelLinks = [
    ['Australian TV', '#/details?id=00000000000000000000000000000006'],
    ['World TV', '#/details?id=00000000000000000000000000000004'],
    ['All channels & guide', '#/livetv?collectionType=livetv']
  ];
  const toolsLinks = [
    ['Favourites', '#/home?tab=1'],
    ['Saved artwork', '#hmc-artwork'],
    ['TV remote controls', '#hmc-projector-controls'],
    ["Home Media Discovery", 'http://media-discover.local/'],
    ['Download progress', 'http://192.0.2.10/status/#downloads'],
    ['Server Status', 'http://192.0.2.10/status/']
  ];
  const extraLinks = __HMC_EXTRA_LINKS__;
  function serviceUrl(raw) {return window.HomeMediaRemoteLinks?.url(raw)||raw;}
  let views = null, user = null, fetching = false, retryAt = 0;
  let queued = false, menu = null, trigger = null;
  let scrollUntil = 0, quietTimer = null, lastPlaying = null;
  let enhancedLoading = false, enhancedRetryAt = 0;
  let observedHero = null, heroObserver = null;
  let observedHeader = null, headerObserver = null, headerDirty = true;
  const posterCache = new Map(), posterRequested = new Set();
  let posterTimer = null, posterBusy = false;
  const playerStyles=new Set([style]);
  function registerPlayerStyle(sheet) {
    if(!sheet || sheet.tagName!=='STYLE')return;
    if(playerStyles.has(sheet)) {
      if(sheet.sheet&&sheet.sheet.disabled!==(lastPlaying===true))sheet.sheet.disabled=lastPlaying===true;
      return;
    }
    if(sheet.id==='hmc-navigation-style'||sheet.textContent.includes('GENERATED FROM PLUGIN SETTINGS')) {
      playerStyles.add(sheet);
      if(sheet.sheet)sheet.sheet.disabled=lastPlaying===true;
    }
  }
  function registerPlayerStyles(root) {
    if(root.nodeType===3)registerPlayerStyle(root.parentElement);
    else {
      registerPlayerStyle(root);
      root.querySelectorAll?.('style').forEach(registerPlayerStyle);
    }
  }
  function changedStyles(records) {
    for(const record of records) {
      registerPlayerStyle(record.target);
      for(const node of record.addedNodes)registerPlayerStyles(node);
    }
  }
  document.querySelectorAll('style').forEach(registerPlayerStyle);
  function playerMode() {
    const playing=/^#\/(?:video|videoosd|player)(?:[/?]|$)/i.test(location.hash);
    if(playing!==lastPlaying) {
      lastPlaying=playing;
      document.documentElement.dataset.hmcPlaying=playing?'1':'0';
      for(const node of document.querySelectorAll('.hmc-main-nav,.hmc-tools-trigger'))if(node.hidden!==playing)node.hidden=playing;
      if(playing){closeMenu(false);document.documentElement.classList.remove('hmc-nav-ready');}
    }
    for(const sheet of playerStyles) {
      if(!sheet.isConnected)playerStyles.delete(sheet);
      else if(sheet.sheet&&sheet.sheet.disabled!==playing)sheet.sheet.disabled=playing;
    }
    return playing;
  }
  const playerGuard=document.createElement('style');playerGuard.id='hmc-player-guard';
  playerGuard.textContent='#pause-screen-overlay{display:none!important;pointer-events:none!important}[data-hmc-playing="1"] .hmc-main-nav,[data-hmc-playing="1"] .hmc-tools-trigger{display:none!important}';
  document.head.appendChild(playerGuard);

  function ensureEnhanced() {
    // Custom Theme can serve the shell before Enhanced's response middleware runs.
    // Use Enhanced's documented script tag, and dedupe against its native injection.
    if (document.querySelector('script[plugin="Jellyfin Enhanced"]') || enhancedLoading || Date.now() < enhancedRetryAt) return;
    enhancedLoading = true;
    const endpoint = new URL('../JellyfinEnhanced/version', document.baseURI);
    if (endpoint.origin !== location.origin) return;
    fetch(endpoint, {credentials:'same-origin'}).then(response => {
      if (!response.ok) throw new Error('Enhanced is not ready');
      return response.text();
    }).then(text => {
      const version = text.trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Unexpected Enhanced version');
      if (document.querySelector('script[plugin="Jellyfin Enhanced"]')) return;
      const script = document.createElement('script');
      script.id = 'hmc-enhanced-loader'; script.setAttribute('plugin','Jellyfin Enhanced');
      script.setAttribute('version',version); script.setAttribute('dev','false');
      script.src = new URL('../JellyfinEnhanced/script?v='+encodeURIComponent(version), document.baseURI).href;
      script.async = false; document.body.appendChild(script);
    }).catch(() => { enhancedRetryAt = Date.now()+60000; })
      .finally(() => { enhancedLoading = false; });
  }

  function closeMenu(restoreFocus) {
    if (menu) menu.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }
    menu = null; trigger = null;
  }
  function toggleMenu(button, links, focusFirst) {
    if (trigger === button) {
      if (focusFirst) menu?.querySelector('a')?.focus();
      else closeMenu(false);
      return;
    }
    closeMenu(false);
    let popup = document.getElementById(button.getAttribute('aria-controls'));
    if (!popup) {
      popup = document.createElement('div');
      popup.id = button.getAttribute('aria-controls'); popup.className = 'hmc-menu';
      popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', button.getAttribute('aria-label') || button.textContent);
      for (const [title, href] of links) {
        const a = document.createElement('a'); a.textContent = title; a.href = serviceUrl(href);
        a.setAttribute('role', 'menuitem'); popup.appendChild(a);
      }
      popup.addEventListener('click', e => {
        const link=e.target.closest('a');
        if(link?.getAttribute('href')==='#hmc-artwork') {
          e.preventDefault();e.stopPropagation();closeMenu(false);
          window.HomeMediaArtworkCache?.open();return;
        }
        if(link?.getAttribute('href')==='#hmc-projector-controls') {
          e.preventDefault();e.stopPropagation();closeMenu(false);
          document.dispatchEvent(new CustomEvent('hmc-projector-controls'));return;
        }
        if(link)closeMenu(false);
      });
      document.body.appendChild(popup);
    }
    popup.hidden = false;
    const rect = button.getBoundingClientRect();
    popup.style.top = Math.round(rect.bottom + 5) + 'px';
    popup.style.left = Math.max(12, Math.min(rect.left, innerWidth - popup.offsetWidth - 12)) + 'px';
    popup.style.maxHeight = Math.max(96, innerHeight - rect.bottom - 20) + 'px';
    button.setAttribute('aria-expanded', 'true');
    menu = popup; trigger = button;
    if (focusFirst) popup.querySelector('a')?.focus();
  }
  function menuButton(text, id, links, className) {
    const b = document.createElement('button'); b.type = 'button'; b.className = className;
    b.textContent = text; b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', id);
    b.addEventListener('click', () => {
      toggleMenu(b, links, false);
      if(!isTvLayout()&&trigger===b)menu?.querySelector('a')?.focus();
    });
    b.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); toggleMenu(b, links, true);
        if (e.key === 'ArrowUp') menu?.querySelector('a:last-child')?.focus();
      }
    });
    return b;
  }
  function isTvLayout() {
    return document.documentElement.classList.contains('layout-tv');
  }
  function route(view) {
    const q = '?topParentId=' + encodeURIComponent(view.Id) + '&collectionType=' + encodeURIComponent(view.CollectionType);
    return ({movies:'#/movies',tvshows:'#/tv',boxsets:'#/boxsets'}[view.CollectionType] || '#/list') + q;
  }
  function libraryMenuLinks(view) {
    // These tab indices are shared by the installed desktop and legacy clients.
    // TV has no native Favourites tab. The native list route must omit parentId:
    // Jellyfin's folder branch otherwise drops its IsFavorite URL filter.
    const base=route(view), movies=view.CollectionType==='movies';
    const favourites=movies ? base+'&tab=2' : '#/list?type=Series&IsFavorite=true'
      +'&serverId='+encodeURIComponent(window.ApiClient?.serverId?.()||'')
      +'&hmcLibrary='+encodeURIComponent(view.Id);
    return [['All titles',base+'&tab=0'],['Genres',base+'&tab='+(movies?4:3)],['Favourites',favourites]];
  }
  function libraryNavigation(view,tvLayout) {
    // The TV client's native navigation already worked before the Mobile fix.
    // Keep its one-click library links; other layouts retain their browse menus.
    return tvLayout ? {href:route(view),links:null} : {href:null,links:libraryMenuLinks(view)};
  }
  function fetchViews() {
    const api = window.ApiClient;
    const id = api?.getCurrentUserId?.();
    if (!id) return;
    if (user !== id) {
      user = id; views = null; posterCache.clear(); posterRequested.clear(); closeMenu(false);
      document.querySelectorAll('.hmc-main-nav,.hmc-tools-trigger,.hmc-menu').forEach(e=>e.remove());
    }
    if (views || fetching || Date.now() < retryAt) return;
    fetching = true;
    api.getUserViews({UserId:id}).then(result => {
      if (user === id) views = result.Items || [];
      fetching = false; schedule();
    }).catch(() => { fetching = false; retryAt = Date.now() + 30000; });
  }
  function buildNav(host) {
    const tvLayout=isTvLayout(),layoutMode=tvLayout?'tv':'browsing';
    let nav = host.querySelector('.hmc-main-nav');
    if (nav&&nav.dataset.layoutMode===layoutMode) return nav;
    if(nav) {
      closeMenu(false);
      host.querySelectorAll('.hmc-main-nav,.hmc-tools-trigger').forEach(node=>node.remove());
      document.querySelectorAll('.hmc-menu').forEach(node=>node.remove());
    }
    nav = document.createElement('nav'); nav.className = 'hmc-main-nav'; nav.setAttribute('aria-label', 'Main navigation');
    nav.dataset.layoutMode=layoutMode;
    const items = [['Home', '#/home', 'home']];
    for (const [type, title] of [['movies','Movies'],['tvshows','TV Shows']]) {
      const v = views.find(v => v.CollectionType === type);
      if (v) {
        const entry=libraryNavigation(v,tvLayout);
        items.push([title,entry.href,type,entry.links]);
      }
    }
    const hasLiveTv = views.some(v => v.CollectionType === 'livetv');
    if (hasLiveTv) items.push(['Live TV', null, 'livetv']);
    const collections = views.find(v => v.CollectionType === 'boxsets');
    if (collections) items.push(['Collections', route(collections), 'boxsets']);
    items.push(['Search', '#/search', 'search']);
    for (const [title, href, key, links] of items) {
      let a;
      if (href) { a = document.createElement('a'); a.href = href; a.textContent = title; a.className = 'hmc-nav-link'; }
      else {
        a = menuButton(title+' ▾', key==='livetv'?'hmc-live-menu':'hmc-'+key+'-menu', links||channelLinks, 'hmc-nav-trigger');
        a.setAttribute('aria-label',title);
      }
      a.dataset.section = key; nav.appendChild(a);
    }
    nav.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key) || !e.target.matches('a,button')) return;
      const links = [...nav.children], at = links.indexOf(e.target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length-1 : at + (e.key==='ArrowRight'?1:-1);
      if (next < 0 || next >= links.length) return;
      e.preventDefault(); e.stopPropagation(); closeMenu(false); links[next].focus();
      links[next].scrollIntoView({block:'nearest',inline:'nearest'});
    });
    const native = host.querySelector('.MuiStack-root');
    if (native) {
      native.classList.add('hmc-native-nav');
      native.querySelector('a')?.classList.add('hmc-brand');
      native.after(nav);
    } else host.appendChild(nav);
    const permitted = extraLinks.filter(x=>views.some(v=>v.Id===x.libraryId)).map(x=>[x.label,x.href]);
    const visibleTools=tvLayout?toolsLinks.filter(([,href])=>href!=='#hmc-projector-controls'):toolsLinks;
    const tools = menuButton('⋯', 'hmc-tools-menu', [...permitted,...visibleTools], 'hmc-tools-trigger');
    tools.setAttribute('aria-label','More links'); tools.title = 'Family, Favourites, Discovery and server tools';
    nav.after(tools);
    return nav;
  }
  function activeSection() {
    const hash = location.hash.toLowerCase();
    if (channelLinks.some(([,href]) => hash === href.toLowerCase()) || hash.startsWith('#/livetv')) return 'livetv';
    if (/^#\/movies/.test(hash)) return 'movies';
    if (/^#\/tv(?:[?/.]|$)/.test(hash)) return 'tvshows';
    if (hash.startsWith('#/list?')) {
      const params=new URLSearchParams(location.hash.split('?')[1]);
      const library=views?.find(view=>view.Id===params.get('hmcLibrary'));
      if(library&&['movies','tvshows'].includes(library.CollectionType))return library.CollectionType;
    }
    if (hash.startsWith('#/boxsets')) return 'boxsets';
    if (hash.startsWith('#/search')) return 'search';
    if (hash === '' || hash === '#/' || hash.startsWith('#/home')) return 'home';
    return '';
  }
  function posterCards() {
    const home=[...document.querySelectorAll('#homeTab.is-active .nf-cw-card,#homeTab.is-active .nf-genre-section .nf-card')];
    const missing=[...document.querySelectorAll('.itemsContainer .card[data-type="Movie"],.itemsContainer .card[data-type="Series"]')]
      .filter(card=>card.getClientRects().length&&!card.querySelector('button[is="emby-ratingbutton"]'));
    return [...new Set([...home,...missing])];
  }
  function cardId(card) {
    if (card.dataset.id) return card.dataset.id;
    try { return new URLSearchParams(new URL(card.href,location.href).hash.split('?')[1]).get('id'); }
    catch (_) { return null; }
  }
  function decorateHomeCards() {
    let missing = false;
    for (const card of posterCards()) {
      const id = cardId(card), item = posterCache.get(id);
      if (!item) { if (id && !posterRequested.has(id)) missing = true; continue; }
      const episode = item.Type === 'Episode';
      const favouriteItem=episode&&item.SeriesId?posterCache.get(item.SeriesId):item;
      if (!favouriteItem) missing=true;
      if (card.dataset.hmcPoster === id) {if(favouriteItem)addFavourite(card,favouriteItem);continue;}
      // Native library cards already own correctly sized, lazy-loaded artwork.
      // Only the custom Home rows need landscape/episode → portrait conversion.
      if(episode || card.classList.contains('nf-cw-card') || card.classList.contains('nf-card')) {
        const artId = episode && item.SeriesId && item.SeriesPrimaryImageTag ? item.SeriesId : item.Id;
        const tag = artId === item.SeriesId ? item.SeriesPrimaryImageTag : item.ImageTags?.Primary;
        const image = card.querySelector('.nf-cw-thumb,.cardImageContainer');
        if (image && tag) image.style.backgroundImage = 'url("'+window.ApiClient.getScaledImageUrl(artId,{type:'Primary',maxWidth:420,tag})+'")';
        const title = episode ? item.SeriesName || item.Name : item.Name;
        const titleBox = card.querySelector('.nf-cw-title,.cardText-first bdi');
        if (titleBox && title && titleBox.textContent!==title) titleBox.textContent = title;
        const year = item.ProductionYear || (item.PremiereDate ? item.PremiereDate.slice(0,4) : '');
        let yearBox = card.querySelector('.hmc-card-year,.cardText-secondary bdi');
        if (!yearBox && year && card.classList.contains('nf-cw-card')) {
          yearBox = document.createElement('div'); yearBox.className = 'hmc-card-year'; card.appendChild(yearBox);
        }
        if (yearBox && year && yearBox.textContent!==String(year)) yearBox.textContent = String(year);
        if (episode) card.title = (item.SeriesName || '')+' — '+item.Name;
      }
      if(favouriteItem)addFavourite(card,favouriteItem);
      card.dataset.hmcPoster = id;
    }
    if (missing && !posterBusy && !posterTimer) posterTimer = setTimeout(fetchHomePosters,120);
  }
  function addFavourite(card,item) {
    if(card.querySelector('button[is="emby-ratingbutton"]'))return;
    let host=card;
    if(card.classList.contains('nf-cw-card')) {
      if(!card.parentElement.classList.contains('hmc-cw-wrap')) {
        const wrap=document.createElement('div');wrap.className='hmc-cw-wrap';card.before(wrap);wrap.appendChild(card);
      }
      host=card.parentElement;
    }
    if(card.matches('button.card')&&card.closest('.itemsContainer-tv')) {
      if(!card.parentElement.classList.contains('hmc-tv-card-wrap')) {
        const active=document.activeElement;
        const focused=active&&(active===card||card.contains(active))?active:null;
        const wrap=document.createElement('div');
        wrap.className='hmc-tv-card-wrap '+[...card.classList].filter(x=>/^(?:portrait|square|backdrop|smallBackdrop|overflowPortrait)Card$/.test(x)).join(' ');
        card.before(wrap);wrap.appendChild(card);
        // Moving the native TV button clears focus in browsers without moveBefore.
        if(focused?.isConnected)focused.focus({preventScroll:true});
      }
      host=card.parentElement;
    }
    const existing=host.querySelector('.hmc-favourite');
    if(existing&&existing.dataset.hmcFavouriteId===item.Id){setFavourite(existing,item);return;}
    existing?.remove();
    host.classList.add('hmc-favourite-host');
    const button=document.createElement('button');button.type='button';button.className='hmc-favourite';
    button.dataset.hmcFavouriteId=item.Id;
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();if(button.disabled)return;button.disabled=true;
      const wanted=!item.UserData?.IsFavorite;
      window.ApiClient.updateFavoriteStatus(user,item.Id,wanted).then(()=>{item.UserData=item.UserData||{};item.UserData.IsFavorite=wanted;syncFavourite(item);}).catch(()=>{button.title='Could not save favourite. Please try again.';}).finally(()=>{button.disabled=false;});
    });host.appendChild(button);setFavourite(button,item);
  }
  function setFavourite(button,item) {
    const favourite=!!item.UserData?.IsFavorite;
    if(button.getAttribute('aria-pressed')===String(favourite))return;
    const label=favourite?'Remove from favourites':'Add to favourites';
    button.textContent=favourite?'♥':'♡';button.setAttribute('aria-pressed',String(favourite));button.setAttribute('aria-label',label);button.title=label+' — '+item.Name;
  }
  function syncFavourite(item) {
    for(const button of document.querySelectorAll('.hmc-favourite[data-hmc-favourite-id="'+item.Id+'"]')) {
      setFavourite(button,item);
    }
  }
  function exposeNativeFavourites(){
    // React owns these controls; leave their nodes in place while exposing one heart.
    for(const b of document.querySelectorAll('.card button.cardOverlayButton')) {
      if(!b.classList.contains('hmc-superseded-favourite')&&b.querySelector('svg[data-testid="FavoriteIcon"]')&&b.closest('.card')?.querySelector('.hmc-favourite'))b.classList.add('hmc-superseded-favourite');
    }
    for(const b of document.querySelectorAll('.card button[is="emby-ratingbutton"]')) {
      const host=b.closest('.cardBox');if(!host||b.classList.contains('hmc-native-favourite'))continue;
      b.closest('.card')?.querySelector('.hmc-favourite')?.remove();
      b.classList.add('hmc-native-favourite');host.classList.add('hmc-favourite-host');host.appendChild(b);
    }
  }
  function fetchHomePosters() {
    posterTimer = null;
    if(Date.now()<scrollUntil) {
      posterTimer=setTimeout(fetchHomePosters,scrollUntil-Date.now()+20);return;
    }
    const id = user;
    const visibleIds=posterCards().map(cardId);
    const seriesIds=visibleIds.map(x=>posterCache.get(x)).filter(x=>x?.Type==='Episode'&&x.SeriesId).map(x=>x.SeriesId);
    const ids = [...new Set([...visibleIds,...seriesIds].filter(x=>x && !posterCache.has(x) && !posterRequested.has(x)))];
    if (!ids.length || !id) return;
    ids.forEach(x=>posterRequested.add(x)); posterBusy = true;
    window.ApiClient.getItems(id,{Ids:ids.join(','),Recursive:true,Fields:'SeriesPrimaryImage',ImageTypeLimit:1,EnableImageTypes:'Primary'}).then(result => {
      if (user !== id) return;
      for (const item of result.Items || []) posterCache.set(item.Id,item);
    }).catch(() => {
      // Retry transient metadata failures after a quiet interval, never on every mutation.
      setTimeout(() => { ids.forEach(x=>posterRequested.delete(x)); schedule(); },30000);
    }).finally(() => { posterBusy = false; schedule(); });
  }
  function translateTheme() {
    for (const heading of document.querySelectorAll('h2')) {
      for (const node of heading.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim() === 'Discover on Seerr') node.textContent = "From Home Media Discovery ";
      }
    }
    const hero = document.querySelector('.nf-hero');
    if (hero && hero !== observedHero) {
      heroObserver?.disconnect(); observedHero = hero;
      heroObserver = new MutationObserver(schedule);
      heroObserver.observe(hero,{attributes:true,subtree:true,attributeFilter:['class']});
      const pauseCarousel = () => {
        const b = hero.querySelector('.nf-hero-pause');
        if (b?.querySelector('.material-icons')?.textContent.trim() === 'pause') b.click();
      };
      hero.addEventListener('focusin',e => { if (!e.target.closest('.nf-hero-pause')) pauseCarousel(); });
      if (matchMedia('(prefers-reduced-motion:reduce)').matches) pauseCarousel();
    }
    for (const slide of document.querySelectorAll('.nf-hero-slide')) {
      const active = slide.classList.contains('active');
      if (slide.getAttribute('aria-hidden') !== String(!active)) slide.setAttribute('aria-hidden',String(!active));
      if(slide.inert!==!active)slide.inert = !active;
      for (const link of slide.querySelectorAll('a,button')) {
        if (!Object.prototype.hasOwnProperty.call(link.dataset,'hmcTabIndex')) link.dataset.hmcTabIndex = link.getAttribute('tabindex') || '';
        if (!active) {if(link.tabIndex!==-1)link.tabIndex = -1;}
        else if (link.dataset.hmcTabIndex) {if(link.getAttribute('tabindex')!==link.dataset.hmcTabIndex)link.setAttribute('tabindex',link.dataset.hmcTabIndex);}
        else if(link.hasAttribute('tabindex'))link.removeAttribute('tabindex');
      }
    }
    // The upstream hero calls a community star rating a percentage "Match".
    // Show the same rating on its actual 0–10 scale instead.
    for (const rating of document.querySelectorAll('.nf-hero-match')) {
      const match = rating.textContent.trim().match(/^(\d+)% Match$/);
      if (match) {
        const score = (Number(match[1])/10).toFixed(1);
        rating.textContent = '★ '+score+'/10'; rating.title = 'Community rating';
        rating.setAttribute('aria-label','Community rating '+score+' out of 10');
      }
    }
    for (const a of document.querySelectorAll('.nf-hero-info')) {
      for (const n of a.childNodes) if (n.nodeType === 3 && n.textContent.trim() === 'Mehr Infos') n.textContent = ' More info';
    }
    for (const b of document.querySelectorAll('.nf-hero-pause')) {
      const paused = b.querySelector('.material-icons')?.textContent.trim() !== 'pause';
      const label=paused?'Resume featured titles':'Pause featured titles';
      if(b.getAttribute('aria-label')!==label)b.setAttribute('aria-label',label);
    }
    for (const title of document.querySelectorAll('.nf-cw-section .sectionTitle')) {
      if (title.textContent === 'Weiterschauen') title.textContent = 'Continue Watching';
    }
    for (const b of document.querySelectorAll('.nf-genre-section button[title="Abspielen"]')) b.title = 'Play';
    for (const [index,dot] of [...document.querySelectorAll('.nf-hero-dot')].entries()) {
      if (dot.dataset.hmcKeyboard) continue;
      dot.dataset.hmcKeyboard = '1'; dot.tabIndex = 0; dot.setAttribute('role','button');
      dot.setAttribute('aria-label','Show featured title '+(index+1));
      dot.addEventListener('keydown',e => {
        if (e.key==='Enter' || e.key===' ') { e.preventDefault(); e.stopPropagation(); dot.click(); }
      });
    }
  }
  function update() {
    // Keep the original drawer shortcut consistent with the shared More menu.
    for (const a of document.querySelectorAll('a[href]')) {
      if (['http://media-movies.local:8080','http://media-movies.local:8080/','http://192.0.2.10:8080','http://192.0.2.10:8080/'].includes(a.href) && a.textContent.includes('Download progress')) {
        a.href = serviceUrl(toolsLinks.find(([title]) => title === 'Download progress')[1]);
        a.target = '_blank'; a.rel = 'noopener';
      }
    }
    if(playerMode())return;
    fetchViews();
    const host = document.querySelector('#reactRoot header .MuiToolbar-root') || document.querySelector('.skinHeader .headerTop');
    if (!host || !views || !window.ApiClient?.getCurrentUserId?.()) {
      document.documentElement.classList.remove('hmc-nav-ready'); return;
    }
    const nav = buildNav(host);
    ensureEnhanced();
    if(!document.documentElement.classList.contains('hmc-nav-ready'))document.documentElement.classList.add('hmc-nav-ready');
    const legacyHeader=host.closest('.skinHeader');
    if(legacyHeader) {
      if(legacyHeader!==observedHeader) {
        observedHeader=legacyHeader;headerDirty=true;headerObserver?.disconnect();
        if(typeof ResizeObserver==='function') {
          headerObserver=new ResizeObserver(()=>{headerDirty=true;schedule();});headerObserver.observe(legacyHeader);
        }
      }
      if(headerDirty||!headerObserver) {
        headerDirty=false;
        const height=Math.ceil(legacyHeader.getBoundingClientRect().height)+'px';
        if(document.documentElement.style.getPropertyValue('--hmc-header-height')!==height)document.documentElement.style.setProperty('--hmc-header-height',height);
      }
    }
    for (const a of nav.children) {
      const active = a.dataset.section === activeSection();
      if (active && a.getAttribute('aria-current') !== 'page') a.setAttribute('aria-current','page');
      else if (!active && a.hasAttribute('aria-current')) a.removeAttribute('aria-current');
    }
    for (const a of host.querySelectorAll('a[aria-label="Search"],.headerSearchButton')) {
      if(!a.classList.contains('hmc-original-search'))a.classList.add('hmc-original-search');
      if (a.tagName==='A' && a.getAttribute('href') !== '#/search') a.setAttribute('href','#/search');
    }
    translateTheme();
    decorateHomeCards();
    exposeNativeFavourites();
  }
  function schedule() {
    if (queued) return; queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if(Date.now()<scrollUntil) {
        clearTimeout(quietTimer);quietTimer=setTimeout(schedule,scrollUntil-Date.now()+20);return;
      }
      // Decorations add buttons/text; those writes must not queue another full pass.
      bodyObserver.disconnect();
      try {update();} finally {bodyObserver.observe(document.body,{childList:true,subtree:true});}
    });
  }
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !trigger?.contains(e.target)) closeMenu(false); });
  function menuKeydown(e) {
    if (!menu) return;
    const tvLayout=isTvLayout();
    if (['Escape','Back','BrowserBack','GoBack','Backspace'].includes(e.key) || [461,10009].includes(e.keyCode)) { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (menu.contains(e.target) && ['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
      const links=[...menu.querySelectorAll('a')], at=links.indexOf(document.activeElement);
      if(!links.length)return;
      const next=e.key==='Home'?0:e.key==='End'?links.length-1:(at+(e.key==='ArrowDown'?1:-1)+links.length)%links.length;
      e.preventDefault(); e.stopPropagation(); links[next].focus();
      if(!tvLayout)links[next].scrollIntoView({block:'nearest',inline:'nearest'});
    }
    else if(!tvLayout && menu.contains(e.target) && ['ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();e.stopPropagation();
      const button=trigger,nav=button?.closest('.hmc-main-nav');
      const next=nav&&[...nav.children][[...nav.children].indexOf(button)+(e.key==='ArrowRight'?1:-1)];
      closeMenu(!next);
      if(next){next.focus();next.scrollIntoView({block:'nearest',inline:'nearest'});}
    }
    else if(!tvLayout && menu.contains(e.target) && e.key===' ') {e.preventDefault();e.stopPropagation();e.target.closest('a')?.click();}
    else if(!tvLayout && e.key==='Tab')closeMenu(false);
  }
  document.addEventListener('keydown', menuKeydown, true);
  function menuCommand(event) {
    if (!menu || !isTvLayout()) return;
    const keys={left:'ArrowLeft',right:'ArrowRight',up:'ArrowUp',down:'ArrowDown',back:'Escape'};
    const key=keys[event.detail?.command];if(!key)return;
    menuKeydown({key,target:event.target,preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopImmediatePropagation()});
  }
  document.addEventListener('command',menuCommand,true);
  window.addEventListener('hashchange', () => { closeMenu(false);scrollUntil=0;playerMode();posterCache.clear();posterRequested.clear();schedule(); });
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', () => { closeMenu(false);headerDirty=true;schedule(); });
  // Native touch/momentum scrolling stays on the compositor; DOM decoration waits
  // for a short quiet interval rather than competing with every image insertion.
  document.addEventListener('scroll',()=>{scrollUntil=Date.now()+140;},{capture:true,passive:true});
  const bodyObserver=new MutationObserver(records=>{changedStyles(records);schedule();});
  bodyObserver.observe(document.body,{childList:true,subtree:true});
  const styleObserver=new MutationObserver(changedStyles);
  styleObserver.observe(document.head,{childList:true,subtree:true});
  let lastNavTvLayout=isTvLayout();
  new MutationObserver(()=>{
    const tvLayout=isTvLayout();
    if(tvLayout!==lastNavTvLayout){lastNavTvLayout=tvLayout;closeMenu(false);schedule();}
  }).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  schedule();
}());
