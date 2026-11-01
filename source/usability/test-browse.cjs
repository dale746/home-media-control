const test = require('node:test');
const assert = require('node:assert/strict');
const {youtubeLink, markedState, safeMoviesReturn, isPlayerUrl, isDownloadProgressUrl, updateScrollRecord,readRemoteConfig,rewriteOwnedUrl,isDiscoveryUrl} = require('./hmc-browse.js');
const fs=require('node:fs'),vm=require('node:vm');
const remote={movieOrigin:'https://media-movies.example-tail.ts.net',discoverOrigin:'https://media-movies.example-tail.ts.net:8443',portalOrigin:'https://media-movies.example-tail.ts.net'};

test('remote origin configuration rejects credentials, paths and wildcard trust',()=>{
  assert.equal(readRemoteConfig(remote).movieOrigin,remote.movieOrigin);
  for(const value of ['javascript:alert(1)','https://secret@server.ts.net','https://*.ts.net','https://server.ts.net/path','https://server.ts.net/?token=x'])assert.equal(readRemoteConfig({...remote,movieOrigin:value}),null);
});
test('owned services use exact configured remote origins and preserve home links at home',()=>{
  const current=remote.movieOrigin+'/web/#/home';
  assert.equal(rewriteOwnedUrl('http://media-discover.local/movie/123',current,remote),remote.discoverOrigin+'/movie/123');
  assert.equal(rewriteOwnedUrl('http://192.0.2.10/status/#downloads',current,remote),remote.portalOrigin+'/status/#downloads');
  assert.equal(rewriteOwnedUrl('http://192.0.2.10/hmc-hold/move',current,remote),remote.portalOrigin+'/hmc-hold/move');
  assert.equal(rewriteOwnedUrl('http://media-movies.local/web/index.html#!/details?id=abc',remote.discoverOrigin,remote),remote.movieOrigin+'/web/index.html#/details?id=abc');
  const local='http://media-discover.local/movie/123';
  assert.equal(rewriteOwnedUrl(local,'http://media-movies.local/web/#/home',remote),local);
});
test('remote mapping never trusts arbitrary tailnet names, other ports or embedded credentials',()=>{
  const owned='http://media-discover.local/movie/123';
  assert.equal(rewriteOwnedUrl(owned,'https://unrelated.example-tail.ts.net/web/#/home',remote),owned);
  assert.equal(rewriteOwnedUrl(owned,remote.movieOrigin+':9443/web/#/home',remote),owned);
  for(const raw of ['http://secret@media-discover.local/movie/1','http://192.0.2.10:7878/','https://external.example/movie/1'])assert.equal(rewriteOwnedUrl(raw,remote.movieOrigin,remote),raw);
  assert.equal(new URL(rewriteOwnedUrl('http://media-discover.local//external.example/path',remote.movieOrigin,remote)).origin,remote.discoverOrigin);
});
test('remote Discovery round trip retains safe title/search context without tokens',()=>{
  const current=remote.movieOrigin+'/web/?api_key=secret#/search?query=holiday&api_key=secret';
  const back=safeMoviesReturn(current,remote);assert.equal(back,remote.movieOrigin+'/web/#/search?query=holiday');
  const discovery=new URL(rewriteOwnedUrl('http://media-discover.local/movie/157336',current,remote));
  discovery.searchParams.set('hmcReturn',back);
  assert.equal(safeMoviesReturn(discovery.searchParams.get('hmcReturn'),remote),back);
  for(const raw of [remote.discoverOrigin+'/web/#/home','https://another.ts.net/web/#/home','https://secret@media-movies.example-tail.ts.net/web/#/home'])assert.equal(safeMoviesReturn(raw,remote),null);
});
test('remote progress and Discovery handoffs match their exact configured services',()=>{
  assert.equal(isDownloadProgressUrl(remote.portalOrigin+'/status/#downloads',remote),true);
  assert.equal(isDownloadProgressUrl(remote.portalOrigin+'/status/api/action#downloads',remote),false);
  assert.equal(isDiscoveryUrl(remote.discoverOrigin+'/movie/1',remote),true);
  assert.equal(isDiscoveryUrl(remote.movieOrigin+'/movie/1',remote),false);
  assert.equal(isDiscoveryUrl('https://other.ts.net:8443/movie/1',remote),false);
});
test('direct private HTTP ports remain distinct across movie, Discovery and portal routing',()=>{
  const config={movieOrigin:'http://100.70.80.90:8096',discoverOrigin:'http://100.70.80.90:5055',portalOrigin:'http://100.70.80.90'};
  assert.equal(rewriteOwnedUrl('http://192.0.2.10/status/#downloads',config.movieOrigin,config),config.portalOrigin+'/status/#downloads');
  assert.equal(safeMoviesReturn(config.movieOrigin+'/web/#/details?id=abc',config),config.movieOrigin+'/web/#/details?id=abc');
  assert.equal(safeMoviesReturn(config.discoverOrigin+'/web/#/home',config),null);
});

test('scroll saves update only changed offsets and preserve search and navigation state',()=>{
  const page={window:[0,100],scroll:[['#list',0,40]],search:[['#search','holiday']],parent:'previous'};
  assert.equal(updateScrollRecord(page,[0,200],[['#list',0,80]]),true);
  assert.deepEqual(page.scroll,[['#list',0,80]]);
  assert.deepEqual(page.search,[['#search','holiday']]);assert.equal(page.parent,'previous');
});
test('unchanged scroll positions do not request history persistence or allocate replacement data',()=>{
  const page={window:[0,100],scroll:[['#list',0,40]]},previous=page.scroll;
  assert.equal(updateScrollRecord(page,[0,100],[['#list',0,40]]),false);
  assert.equal(page.scroll,previous);
});
test('returning a nested scroller to the start clears its saved offset',()=>{
  const page={window:[0,100],scroll:[['#list',0,40],['#row',20,0]]};
  assert.equal(updateScrollRecord(page,[0,100],[['#list',0,0]]),true);
  assert.deepEqual(page.scroll,[['#row',20,0]]);
});

function restoreFixture(page={window:[0,300],scroll:[['#list',0,600]]}) {
  const source=fs.readFileSync(require.resolve('./hmc-browse.js'),'utf8');
  const restoreSource=source.slice(source.indexOf('  function restore(key)'),source.indexOf('  function changed('));
  const pending=[],cleared=new Set(),writes={window:0,list:0,next:0};let id=0,contentReady=true;
  const list={scrollLeft:0,scrollTop:0,getClientRects:()=>[{}],scrollTo(x,y){writes.list++;this.scrollLeft=x;this.scrollTop=y;}};
  const header={textContent:'1-100 of 900',querySelectorAll:()=>[{disabled:false,title:'Next',getAttribute:()=> 'Next',click(){writes.next++;const start=Number(header.textContent.split('-')[0])+100;header.textContent=start+'-'+(start+99)+' of 900';}}]};
  const context={records:{page},current:'page',restoring:false,restoreTimer:null,
    clearTimeout:token=>cleared.add(token),setTimeout:callback=>{const token=++id;pending.push([token,callback]);return token;},
    isPlayerUrl:()=>false,focusRecord:()=>true,find:selector=>selector==='#list'?list:null,
    document:{querySelector:()=>page.paginationStart?header:null,querySelectorAll:()=>[]},
    window:{scrollX:0,scrollY:0,scrollTo(x,y){writes.window++;if(contentReady){this.scrollX=x;this.scrollY=y;}}}};
  vm.createContext(context);vm.runInContext(restoreSource,context);context.restore('page');
  return {context,writes,setReady(value){contentReady=value;},tick(){
    let next;while((next=pending.shift()))if(!cleared.has(next[0])){next[1]();return true;}return false;
  }};
}
test('Back stops restoring after positions settle instead of repeatedly writing scroll for 4.5 seconds',()=>{
  const fixture=restoreFixture();let steps=0;while(fixture.tick())steps++;
  assert.equal(steps,3);assert.equal(fixture.context.restoring,false);
  assert.equal(fixture.writes.window,1);assert.equal(fixture.writes.list,1);
});
test('Back waits for delayed content before settling its scroll position',()=>{
  const fixture=restoreFixture();fixture.setReady(false);
  fixture.tick();fixture.tick();assert.equal(fixture.context.restoring,true);
  fixture.setReady(true);let steps=0;while(fixture.tick())steps++;
  assert.equal(steps,3);assert.equal(fixture.context.window.scrollY,300);assert.equal(fixture.context.restoring,false);
});
test('Back restores the previous library page before considering restoration settled',()=>{
  const fixture=restoreFixture({window:[0,0],scroll:[],paginationStart:201});
  let steps=0;while(fixture.tick())steps++;
  assert.equal(fixture.writes.next,2);assert.equal(steps,5);assert.equal(fixture.context.restoring,false);
});
test('stable single-Back selection does not unhide and re-hide duplicate controls on every DOM update',()=>{
  const source=fs.readFileSync(require.resolve('./hmc-browse.js'),'utf8');
  const start=source.indexOf('  function navigationBack(host,needed)');
  const code=source.slice(start,source.indexOf("  document.addEventListener('click',e=>{",start));
  let writes=0;
  function control(duplicate=false){return {disabled:false,
    hasAttribute:()=>duplicate,getAttribute:()=>null,
    setAttribute(){writes++;duplicate=true;},removeAttribute(){writes++;duplicate=false;},
    getClientRects:()=>duplicate?[]:[{}]};}
  const primary=control(),duplicate=control(true),context={
    records:{page:{}},current:'page',movies:true,isNativeBack:()=>true,
    back:{hidden:true,title:'Back to where you were'},
    host:{querySelectorAll:()=>[primary,duplicate]}};
  vm.createContext(context);vm.runInContext(code,context);
  context.navigationBack(context.host,true);context.navigationBack(context.host,true);
  assert.equal(writes,0);assert.equal(context.back.hidden,true);
  primary.disabled=true;context.navigationBack(context.host,true);
  assert.equal(duplicate.hasAttribute('data-hmc-back-duplicate'),false);
  assert.equal(context.back.hidden,true);
});
test('download progress opens the shared queue and keeps the legacy downloader shortcut supported',()=>{
  assert.equal(isDownloadProgressUrl('http://192.0.2.10/status/#downloads'),true);
  assert.equal(isDownloadProgressUrl('http://media-movies.local:8080/'),true);
  for(const url of ['http://evil.example/status/#downloads','http://secret@192.0.2.10/status/#downloads','http://192.0.2.10:7878/status/#downloads','http://192.0.2.10/status/api/action#downloads'])assert.equal(isDownloadProgressUrl(url),false);
});
test('normalises supported trailer formats without retaining tracking queries', () => {
  for (const url of ['https://www.youtube.com/watch?v=LY19rHKAaAg&feature=share', 'https://youtu.be/LY19rHKAaAg?t=12',
    'https://www.youtube-nocookie.com/embed/LY19rHKAaAg', 'plugin://plugin.video.youtube/play/?video_id=LY19rHKAaAg']) {
    assert.equal(youtubeLink(url), 'https://www.youtube.com/watch?v=LY19rHKAaAg');
  }
});

test('return links keep a safe browsing location and remove tokens and foreign destinations',()=>{
  assert.equal(safeMoviesReturn('http://192.0.2.10:8096/web/?api_key=secret#/search?query=holiday&api_key=secret'),'http://192.0.2.10:8096/web/#/search?query=holiday');
  for(const raw of ['https://evil.example/web/#/home','http://secret@192.0.2.10/web/#/home','javascript:alert(1)','http://192.0.2.10:7878/web/#/home'])assert.equal(safeMoviesReturn(raw),null);
  assert.equal(safeMoviesReturn('http://media-movies.local/web/#/video?id=abc'),'http://media-movies.local/web/#/home?id=abc');
});
test('playback is excluded from browsing scroll restoration',()=>{
  assert.equal(isPlayerUrl('http://media-movies.local/web/#/video'),true);
  assert.equal(isPlayerUrl('http://media-movies.local/web/#/video?id=123'),true);
  assert.equal(isPlayerUrl('http://media-movies.local/web/#/details?id=123'),false);
});
test('does not turn unexpected hosts or credentials into external trailer links', () => {
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.example/watch?v=LY19rHKAaAg',
    'https://secret@youtube.com/watch?v=LY19rHKAaAg', 'https://youtube.com/watch?v=invalid']) assert.equal(youtubeLink(url), null);
});
test('navigation marker preserves router state and does not mutate its input', () => {
  const state = {__N:true, idx:3, options:{scroll:false}};
  const marked = markedState(state, 'entry-4');
  assert.equal(marked.__N,true); assert.equal(marked.idx,3); assert.equal(marked.options,state.options);
  assert.equal(marked.__hmcBrowse,'entry-4'); assert.equal(state.__hmcBrowse,undefined);
});
