const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'hmc-navigation.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'compact.css'),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end));}
function libraryContext(){
  const context={window:{ApiClient:{serverId:()=> 'server / &id=other'}},location:{hash:''},views:[],channelLinks:[]};
  vm.createContext(context);
  vm.runInContext(section('  function route(', '  function fetchViews('),context);
  vm.runInContext(section('  function activeSection(', '  function posterCards('),context);
  context.URLSearchParams=URLSearchParams;
  return context;
}
test('All titles resets a previously selected genre tab in either library',()=>{
  const c=libraryContext();
  for(const type of ['movies','tvshows']){
    const links=c.libraryMenuLinks({Id:'library',CollectionType:type});
    assert.equal(links[0][0],'All titles');
    assert.equal(new URLSearchParams(links[0][1].split('?')[1]).get('tab'),'0');
  }
});
test('Genres uses the actual native desktop and legacy tab positions',()=>{
  const c=libraryContext();
  assert.equal(c.libraryMenuLinks({Id:'films',CollectionType:'movies'})[1][1],
    '#/movies?topParentId=films&collectionType=movies&tab=4');
  assert.equal(c.libraryMenuLinks({Id:'shows',CollectionType:'tvshows'})[1][1],
    '#/tv?topParentId=shows&collectionType=tvshows&tab=3');
});
test('TV keeps direct Movies and TV Shows links while other layouts retain browse menus',()=>{
  const c=libraryContext();
  for(const type of ['movies','tvshows']){
    const view={Id:'library',CollectionType:type};
    const tv=c.libraryNavigation(view,true),mobile=c.libraryNavigation(view,false);
    assert.equal(tv.href,c.route(view));assert.equal(tv.links,null);
    assert.equal(mobile.href,null);assert.equal(mobile.links[1][0],'Genres');
    assert.equal(mobile.links[2][0],'Favourites');
  }
});
test('Movie favourites stays scoped to its library and TV favourites requests Series only',()=>{
  const c=libraryContext();
  assert.equal(c.libraryMenuLinks({Id:'films',CollectionType:'movies'})[2][1],
    '#/movies?topParentId=films&collectionType=movies&tab=2');
  const href=c.libraryMenuLinks({Id:'shows',CollectionType:'tvshows'})[2][1];
  const p=new URLSearchParams(href.split('?')[1]);
  assert.equal(p.get('type'),'Series');assert.equal(p.get('IsFavorite'),'true');
  assert.equal(p.has('parentId'),false,'native folder branch drops the favourite filter');
  assert.equal(p.get('hmcLibrary'),'shows');
});
test('Library and server identifiers cannot inject extra query parameters or a URL scheme',()=>{
  const c=libraryContext(),id='x&IsFavorite=false#javascript:alert(1)';
  for(const type of ['movies','tvshows']){
    const links=c.libraryMenuLinks({Id:id,CollectionType:type});
    for(const [,href] of links){
      assert.ok(href.startsWith('#/'));
      const p=new URLSearchParams(href.split('?')[1]);
      assert.equal(p.get('topParentId')||p.get('hmcLibrary'),id);
      assert.equal(p.getAll('IsFavorite').length,type==='tvshows'&&p.get('type')==='Series'?1:0);
      if(p.has('serverId'))assert.equal(p.get('serverId'),'server / &id=other');
    }
  }
});
test('TV favourites retains the TV Shows nav highlight while other list pages do not',()=>{
  const c=libraryContext();c.views=[{Id:'shows',CollectionType:'tvshows'}];
  c.location.hash='#/list?type=Series&IsFavorite=true&hmcLibrary=shows';
  assert.equal(c.activeSection(),'tvshows');
  c.location.hash='#/list?type=Movie';assert.equal(c.activeSection(),'');
});
function menuContext(tvLayout=false){
  const context={menu:null,trigger:null,document:{activeElement:null},isTvLayout:()=>tvLayout};
  const items=Array.from({length:3},(_,i)=>({i,scrolls:0,clicks:0,
    focus(){context.document.activeElement=this;},scrollIntoView(){this.scrolls++;},
    closest(){return this;},click(){this.clicks++;}}));
  let closes=[];
  context.closeMenu=restore=>{closes.push(restore);context.menu=null;context.trigger=null;};
  context.menu={contains:target=>items.includes(target),querySelectorAll:()=>items};
  const navButtons=Array.from({length:4},()=>({focus(){context.document.activeElement=this;},scrollIntoView(){}}));
  context.trigger=navButtons[1];context.trigger.closest=()=>({children:navButtons});
  vm.createContext(context);
  vm.runInContext(section('  function menuKeydown(', "  document.addEventListener('keydown', menuKeydown"),context);
  function press(key,target=items[0],keyCode=0){
    const event={key,keyCode,target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
    context.menuKeydown(event);return event;
  }
  return {context,items,closes,navButtons,press};
}
test('D-pad cycles through the complete menu and keeps the selected option visible',()=>{
  const m=menuContext();m.items[0].focus();
  assert.equal(m.press('ArrowUp').prevented,true);assert.equal(m.context.document.activeElement,m.items[2]);
  m.press('ArrowDown');assert.equal(m.context.document.activeElement,m.items[0]);
  m.press('End');assert.equal(m.context.document.activeElement,m.items[2]);
  m.press('Home');assert.equal(m.context.document.activeElement,m.items[0]);
  assert.equal(m.items[2].scrolls,2);assert.equal(m.items[0].scrolls,2);
});
test('Left and Right return to adjacent compact navigation controls',()=>{
  for(const [key,index] of [['ArrowLeft',0],['ArrowRight',2]]){
    const m=menuContext();assert.equal(m.press(key).stopped,true);
    assert.equal(m.context.document.activeElement,m.navButtons[index]);
    assert.equal(m.closes[0],false);
  }
});
test('Back returns to its trigger, Space activates a choice, and Tab is never trapped',()=>{
  for(const key of ['Escape','BrowserBack','GoBack','Backspace']){
    const m=menuContext();assert.equal(m.press(key).prevented,true);assert.equal(m.closes[0],true);
  }
  const m=menuContext();assert.equal(m.press(' ').prevented,true);assert.equal(m.items[0].clicks,1);
  assert.equal(m.press('Tab').prevented,false);assert.equal(m.closes[0],false);
});
test('TV popup restores previous key ownership and focus behavior',()=>{
  for(const key of ['ArrowLeft','ArrowRight',' ','Tab']){
    const m=menuContext(true),event=m.press(key);
    assert.equal(event.prevented,false);assert.equal(event.stopped,false);
    assert.equal(m.closes.length,0);assert.equal(m.items[0].clicks,0);
  }
  const m=menuContext(true);m.items[0].focus();m.press('ArrowDown');
  assert.equal(m.context.document.activeElement,m.items[1]);
  assert.equal(m.items[1].scrolls,0,'TV uses native focus scrolling as before');
  assert.equal(m.press('Escape').prevented,true);assert.equal(m.closes[0],true);
});

test('VIDAA and alternate remote Back close only the current custom menu',()=>{
  for(const code of [461,10009]){
    const m=menuContext(true),event=m.press('Unidentified',m.items[1],code);
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.deepEqual(m.closes,[true]);
  }
  const m=menuContext(true);assert.equal(m.press('Back').prevented,true);assert.deepEqual(m.closes,[true]);
});

test('native Jellyfin command Back closes a TV header menu and prevents fallback navigation',()=>{
  const m=menuContext(true),start=source.indexOf('  function menuCommand(');
  vm.runInContext(source.slice(start,source.indexOf("  document.addEventListener('command'",start)),m.context);
  let prevented=0,stopped=0;
  m.context.menuCommand({detail:{command:'back'},target:m.items[1],preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});
  assert.equal(prevented,1);assert.equal(stopped,1);assert.deepEqual(m.closes,[true]);
  m.context.menuCommand({detail:{command:'back'},target:m.items[1],preventDefault(){assert.fail('Closed menu must release native commands');},stopImmediatePropagation(){}});
});
test('Menus retain visible remote focus and fit short phone or projector screens',()=>{
  assert.match(css,/\.hmc-menu a:focus-visible/);
  assert.match(css,/overflow-y:auto; overscroll-behavior:contain/);
  assert.match(source,/popup\.style\.maxHeight = Math\.max\(96, innerHeight - rect\.bottom - 20\)/);
});
