const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {jellyfinRoute,nativeRouteChange,createBackNavigation,preferLogicalBack,isWindowPageHide}=require('./hmc-browse.js');
const source=fs.readFileSync(require.resolve('./hmc-browse.js'),'utf8');
const local='http://192.0.2.10:8096/web/#/details?id=film',remote='https://media-movies.example.invalid/web/index.html#/details?id=film';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
async function flush(){for(let i=0;i<8;i++)await Promise.resolve()}
function clock(){let now=0,id=0;const jobs=new Map();return {
  later(fn,delay){const token=++id;jobs.set(token,{fn,at:now+delay});return token},cancel(token){jobs.delete(token)},
  tick(to){for(;;){const first=[...jobs].filter(([,job])=>job.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;jobs.delete(first[0]);now=first[1].at;first[1].fn()}now=to},get size(){return jobs.size}}}

test('native router receives only a same-document route on LAN and Tailscale, including legacy bang hashes',()=>{
  for(const current of [local,remote]){
    assert.equal(jellyfinRoute('#/home',current),'/home');
    assert.equal(jellyfinRoute('#!/search?query=Iron%20Man',current),'/search?query=Iron%20Man');
    const target=new URL(current);target.hash='#/movies?topParentId=library&tab=1';
    assert.equal(jellyfinRoute(target.href,current),'/movies?topParentId=library&tab=1');
    target.pathname=current.includes('index.html')?'/web/':'/web/index.html';
    assert.equal(jellyfinRoute(target.href,current),'/movies?topParentId=library&tab=1');
  }
});
test('cross-document, foreign-origin, credentials and malformed absolute hash routes never reach native router',()=>{
  for(const target of [remote,'http://192.0.2.10:8096/status/#/home','http://192.0.2.10:8096/web/?new=true#/home',
    'http://'+'u:p'+'@192.0.2.10:8096/web/#/home','#//outside.example/home','#/http://outside.example/home','#/home#extra','/web/'])assert.equal(jellyfinRoute(target,local),null,target);
});
test('native route waits for the existing view then invokes show with a hash-only route',async()=>{
  const ready=deferred(),calls=[],time=clock();
  const result=nativeRouteChange({router:{ready:()=>ready.promise,show:route=>calls.push(['show',route])},target:'#/home',currentUrl:local,isCurrent:()=>true,
    onBeforeShow:()=>calls.push(['plan']),later:time.later,cancelLater:time.cancel});
  await flush();assert.deepEqual(calls,[]);ready.resolve();await flush();assert.equal(await result,'shown');assert.deepEqual(calls,[['plan'],['show','/home']]);assert.equal(time.size,0);
});
test('Back keeps its dedupe guard while native ready is delayed beyond the old700ms threshold',async()=>{
  const ready=deferred(),shown=deferred(),calls=[],time=clock();let state={key:'detail',url:local};
  const controller=createBackNavigation({read:()=>state,later:time.later,cancelLater:time.cancel,goBack:()=>assert.fail('No browser traversal'),
    goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>ready.promise,show:route=>{calls.push(route);return shown.promise}},
      target,currentUrl:state.url,isCurrent,later:time.later,cancelLater:time.cancel})});
  assert.equal(controller.request('home','#/home',true),true);await flush();time.tick(2000);
  assert.equal(controller.request('home','#/home',true),false);assert.deepEqual(calls,[]);
  ready.resolve();await flush();assert.deepEqual(calls,['/home']);assert.equal(controller.request('home','#/home',true),false);
  state={key:'home',url:new URL('#/home',local).href};controller.settled();shown.resolve();await flush();assert.equal(time.size,0);
});
test('Back supersedes an unfinished hero forward, while a forward press cannot interrupt Back',async()=>{
  for(const first of ['forward','back']){
    const ready=deferred(),calls=[],time=clock();
    const controller=createBackNavigation({read:()=>({key:'detail',url:local}),later:time.later,cancelLater:time.cancel,goBack(){},
      goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>ready.promise,show:route=>calls.push(route)},target,currentUrl:local,isCurrent,later:time.later,cancelLater:time.cancel})});
    const forward=()=>controller.request(null,'#/details?id=another',true,'forward'),back=()=>controller.request('home','#/home',true);
    assert.equal(first==='forward'?forward():back(),true);await flush();time.tick(2000);assert.equal(first==='forward'?back():forward(),first==='forward');
    ready.resolve();await flush();assert.deepEqual(calls,['/home']);assert.equal(time.size,0);
  }
});
test('Back during a forward show accepts the escape once and waits for that view lifecycle before returning Home',async()=>{
  const loading=deferred(),calls=[],time=clock();let pending=Promise.resolve();
  const router={ready:()=>pending,show:route=>{calls.push(route);if(route.startsWith('/details')){pending=loading.promise;return pending}return Promise.resolve()}};
  const controller=createBackNavigation({read:()=>({key:'detail',url:local}),later:time.later,cancelLater:time.cancel,goBack(){},
    goLogical:(_key,target,isCurrent)=>nativeRouteChange({router,target,currentUrl:local,isCurrent,later:time.later,cancelLater:time.cancel})});
  controller.request(null,'#/details?id=another',true,'forward');await flush();assert.deepEqual(calls,['/details?id=another']);
  assert.equal(controller.request('home','#/home',true),true);assert.equal(controller.request('home','#/home',true),false);await flush();assert.deepEqual(calls,['/details?id=another']);
  time.tick(2000);loading.resolve();await flush();assert.deepEqual(calls,['/details?id=another','/home']);assert.equal(time.size,0);
});
test('bubbling Jellyfin view pagehide does not cancel Back queued during details loading, but a real window unload does',async()=>{
  const start=source.indexOf("  window.addEventListener('pagehide', event => {"),end=source.indexOf("  document.addEventListener('scroll'",start),code=source.slice(start,end);
  for(const unload of [false,true]){
    const ready=deferred(),calls=[],time=clock();let snapshots=0,listener;
    const controller=createBackNavigation({read:()=>({key:'detail',url:local}),later:time.later,cancelLater:time.cancel,goBack(){},
      goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>ready.promise,show:route=>calls.push(route)},target,currentUrl:local,isCurrent,later:time.later,cancelLater:time.cancel})});
    const win={document:{},addEventListener:(_name,callback)=>{listener=callback}},context={window:win,backNavigation:controller,snapshot:()=>snapshots++,isWindowPageHide};
    vm.createContext(context);vm.runInContext(code,context);controller.request('home','#/home',true);await flush();
    listener({target:unload?win:{className:'page itemDetailPage',isConnected:true}});ready.resolve();await flush();
    assert.deepEqual(calls,unload?[]:['/home']);assert.equal(snapshots,unload?1:0);assert.equal(time.size,0);
  }
});
test('document-targeted native PageTransitionEvent is recognized without accepting synthetic view or document events',()=>{
  class PageTransitionEvent{constructor(target){this.target=target}}
  const win={document:{},PageTransitionEvent};
  assert.equal(isWindowPageHide(new PageTransitionEvent(win.document),win),true);
  assert.equal(isWindowPageHide({target:win.document},win),false);
  assert.equal(isWindowPageHide(new PageTransitionEvent({className:'view'}),win),false);
  assert.equal(isWindowPageHide({target:win},win),true);
});
test('navigation away while ready is pending cancels Back even if the user later returns to the same record',async()=>{
  const ready=deferred(),calls=[],time=clock();let state={key:'detail',url:local};
  const controller=createBackNavigation({read:()=>state,later:time.later,cancelLater:time.cancel,goBack(){},
    goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>ready.promise,show:route=>calls.push(route)},target,currentUrl:state.url,isCurrent,later:time.later,cancelLater:time.cancel})});
  controller.request('home','#/home',true);await flush();state={key:'search',url:new URL('#/search',local).href};controller.settled();state={key:'detail',url:local};
  ready.resolve();await flush();assert.deepEqual(calls,[]);assert.equal(time.size,0);
});
test('a same-key URL change cancels a pending native route',async()=>{
  const ready=deferred(),calls=[],time=clock();let state={key:'detail',url:local};
  const controller=createBackNavigation({read:()=>state,later:time.later,cancelLater:time.cancel,goBack(){},
    goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>ready.promise,show:route=>calls.push(route)},target,currentUrl:state.url,isCurrent,later:time.later,cancelLater:time.cancel})});
  controller.request('home','#/home',true);await flush();state={key:'detail',url:new URL('#/details?id=another',local).href};controller.settled();ready.resolve();await flush();assert.deepEqual(calls,[]);
});
test('timed-out ready cannot perform a late show and a failed Back can be retried',async()=>{
  const ready=deferred(),calls=[],failures=[],time=clock();let attempts=0;
  const controller=createBackNavigation({read:()=>({key:'detail',url:local}),later:time.later,cancelLater:time.cancel,goBack(){},
    goLogical:(_key,target,isCurrent)=>nativeRouteChange({router:{ready:()=>++attempts===1?ready.promise:Promise.resolve(),show:route=>calls.push(route)},
      target,currentUrl:local,isCurrent,onFailure:reason=>failures.push(reason),later:time.later,cancelLater:time.cancel})});
  controller.request('home','#/home',true);await flush();time.tick(5000);await flush();assert.deepEqual(failures,['timeout']);
  assert.equal(controller.request('home','#/home',true),true);await flush();ready.resolve();await flush();assert.deepEqual(calls,['/home']);assert.equal(time.size,0);
});
test('ready rejection, show rejection and synchronous show errors are contained without raw navigation',async()=>{
  for(const step of ['ready','show','throw']){
    const failures=[],time=clock(),router={ready:()=>step==='ready'?Promise.reject(Error('ready')):Promise.resolve(),
      show:()=>{if(step==='throw')throw Error('show');return Promise.reject(Error('show'))}};
    const result=nativeRouteChange({router,target:'#/home',currentUrl:local,isCurrent:()=>true,onFailure:reason=>failures.push(reason),later:time.later,cancelLater:time.cancel});
    assert.equal(await result,'error');assert.deepEqual(failures,['error']);assert.equal(time.size,0);
  }
});
test('late show completion or rejection after departure does not reopen a route or display a stale error',async()=>{
  for(const rejects of [false,true]){
    const shown=deferred(),calls=[],failures=[],time=clock();let active=true;
    const result=nativeRouteChange({router:{ready:()=>Promise.resolve(),show:route=>{calls.push(route);return shown.promise}},target:'#/home',currentUrl:local,isCurrent:()=>active,
      onFailure:reason=>failures.push(reason),later:time.later,cancelLater:time.cancel});
    await flush();active=false;rejects?shown.reject(Error('late')):shown.resolve();await result;assert.deepEqual(calls,['/home']);assert.deepEqual(failures,[]);assert.equal(time.size,0);
  }
});
test('show lifecycle timeout releases the guard and suppresses a late completion',async()=>{
  const shown=deferred(),calls=[],failures=[],time=clock();
  const result=nativeRouteChange({router:{show:route=>{calls.push(route);return shown.promise}},target:'#/home',currentUrl:local,isCurrent:()=>true,
    onFailure:reason=>failures.push(reason),later:time.later,cancelLater:time.cancel});
  await flush();time.tick(5000);assert.equal(await result,'timeout');shown.resolve();await flush();assert.deepEqual(calls,['/home']);assert.deepEqual(failures,['timeout']);assert.equal(time.size,0);
});
test('actual logicalBack handler plans restoration and uses native route lifecycle without replacing browser location',async()=>{
  const calls=[],stored=new Map(),state={usr:{keep:true},key:'router-detail',idx:1,__hmcBrowse:'detail'};
  const context={records:{home:{url:new URL('#/home',local).href}},current:'detail',movies:true,history:{state},window:{NativeShell:{},Emby:{Page:{ready:()=>Promise.resolve(),show:route=>calls.push(route)}}},
    document:{documentElement:{className:'layout-mobile'}},location:{href:local,replace:()=>assert.fail('Native route must not replace document location')},
    sessionStorage:{setItem:(key,value)=>stored.set(key,value),getItem:key=>stored.get(key),removeItem:key=>stored.delete(key)},persist(){},message:()=>assert.fail('No failure expected'),
    preferLogicalBack,nativeRouteChange,JSON,Date,URL};
  vm.createContext(context);const start=source.indexOf('  function logicalBack('),end=source.indexOf('  backNavigation=createBackNavigation',start);vm.runInContext(source.slice(start,end),context);
  await context.logicalBack('home',context.records.home.url);assert.deepEqual(calls,['/home']);assert.equal(JSON.parse(stored.get('hmc-back-target')).key,'home');assert.equal(context.history.state,state);assert.equal(state.idx,1);
});
test('native Back restoration plan matches the current document after bang-hash and index-path normalization',async()=>{
  const stored=new Map(),target='http://192.0.2.10:8096/web/index.html#!/home';
  const context={records:{home:{url:target}},current:'detail',movies:true,window:{NativeShell:{},Emby:{Page:{show:()=>Promise.resolve()}}},
    document:{documentElement:{className:'layout-mobile'}},location:{href:local,replace:()=>assert.fail('No raw document navigation')},
    sessionStorage:{setItem:(key,value)=>stored.set(key,value),getItem:key=>stored.get(key),removeItem:key=>stored.delete(key)},persist(){},message:()=>assert.fail('No failure expected'),
    preferLogicalBack,nativeRouteChange,JSON,Date,URL};
  vm.createContext(context);const start=source.indexOf('  function logicalBack('),end=source.indexOf('  backNavigation=createBackNavigation',start);vm.runInContext(source.slice(start,end),context);
  await context.logicalBack('home',target);assert.equal(context.records.home.url,'http://192.0.2.10:8096/web/#/home');assert.equal(JSON.parse(stored.get('hmc-back-target')).key,'home');
});
test('hero More info interception is limited to native mobile and leaves browser, TV and other links unchanged',()=>{
  const start=source.indexOf('    // The theme\'s hero is an ordinary hash link.'),end=source.indexOf('    let u;try{u=new URL(a.href);}',start),code=source.slice(start,end);
  for(const mode of ['native-mobile','browser','tv','other-link']){
    const calls=[],context={a:{href:new URL('#/details?id=film',local).href,matches:()=>mode!=='other-link'},location:{href:local},
      e:{preventDefault:()=>calls.push('prevent'),stopImmediatePropagation:()=>calls.push('stop')},window:{NativeShell:mode==='browser'?null:{},Emby:{Page:{show(){}}}},
      document:{documentElement:{className:mode==='tv'?'layout-tv':'layout-mobile'}},backNavigation:{request:(_key,url,logical)=>calls.push([url,logical])},preferLogicalBack,jellyfinRoute};
    vm.createContext(context);vm.runInContext('(function(){'+code+'})()',context);assert.equal(calls.length,mode==='native-mobile'?3:0,mode);
  }
});
test('reloaded native details with no saved parent returns through the router while browser and TV retain their fallback',()=>{
  const start=source.indexOf("  back.addEventListener('click', () => {"),end=source.indexOf('  function isNativeBack(',start),code=source.slice(start,end);
  for(const mode of ['native-mobile','browser','tv','discovery']){
    const calls=[],context={back:{addEventListener:(_type,callback)=>callback()},records:{},current:'reloaded',movies:mode!=='discovery',returnToMovies:local,
      window:{NativeShell:mode==='browser'?null:{},Emby:{Page:{show(){}}}},document:{documentElement:{className:mode==='tv'?'layout-tv':'layout-mobile'}},
      backNavigation:{request:(parent,target,logical)=>calls.push(['router',parent,target,logical])},location:{assign:target=>calls.push(['location',target])},preferLogicalBack};
    vm.createContext(context);vm.runInContext(code,context);
    assert.deepEqual(calls,mode==='native-mobile'?[['router',null,'#/home',true]]:[['location',mode==='discovery'?local:'#/home']],mode);
  }
});
