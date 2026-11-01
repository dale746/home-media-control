const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'hmc-navigation.js'),'utf8');
new vm.Script(source);
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end));}
function button(pressed){
  const attributes={'aria-pressed':String(pressed)};
  let writes=0;
  return {dataset:{hmcFavouriteId:'film'},getAttribute:key=>attributes[key]??null,
    setAttribute(key,value){attributes[key]=value;writes++;},
    set textContent(value){this.text=value;writes++;},set title(value){this.label=value;writes++;},
    addEventListener(){},get writes(){return writes;}};
}
function favouriteContext(elements=[]){
  let queries=0;
  const context={document:{querySelectorAll(){queries++;return elements;},createElement(){return button(false);}},window:{},user:'mediaadmin'};
  vm.createContext(context);
  vm.runInContext(section('  function addFavourite(', '  function exposeNativeFavourites('),context);
  return {context,queries:()=>queries};
}
function card(existing){
  return {classList:{contains:()=>false,add(){}},matches:()=>false,
    querySelector(selector){return selector.startsWith('button[is=')?null:existing;},
    appendChild(element){this.child=element;}};
}

test('100 existing hearts do not cause 100 document scans or DOM rewrites',()=>{
  const b=button(false),f=favouriteContext([b]);
  for(let i=0;i<100;i++)f.context.addFavourite(card(b),{Id:'film',Name:'Film',UserData:{IsFavorite:false}});
  assert.equal(f.queries(),0);
  assert.equal(b.writes,0);
});

test('a newly inserted heart is initialised locally and explicit changes sync duplicates',()=>{
  const a=button(false),b=button(false),f=favouriteContext([a,b]);
  const c=card(null);
  f.context.addFavourite(c,{Id:'film',Name:'Film',UserData:{IsFavorite:true}});
  assert.equal(c.child.getAttribute('aria-pressed'),'true');
  assert.equal(f.queries(),0);
  f.context.syncFavourite({Id:'film',Name:'Film',UserData:{IsFavorite:true}});
  assert.equal(f.queries(),1);
  assert.equal(a.getAttribute('aria-pressed'),'true');
  assert.equal(b.getAttribute('aria-pressed'),'true');
  const writes=a.writes+b.writes;
  f.context.syncFavourite({Id:'film',Name:'Film',UserData:{IsFavorite:true}});
  assert.equal(a.writes+b.writes,writes);
});

function playerContext(){
  let reads=0,styleScans=0;
  const own={id:'hmc-navigation-style',tagName:'STYLE',isConnected:true,sheet:{disabled:false}};
  function style(text){return {tagName:'STYLE',isConnected:true,sheet:{disabled:false},get textContent(){reads++;return text;}};}
  const theme=style('GENERATED FROM PLUGIN SETTINGS'+'x'.repeat(69000));
  const other=style('x'.repeat(150000));
  const context={style:own,lastPlaying:null,location:{hash:'#/movies'},closeMenu(){},
    document:{documentElement:{dataset:{},classList:{remove(){}}},querySelectorAll(selector){
      if(selector==='style'){styleScans++;return [own,theme,other];}return [];
    }}};
  vm.createContext(context);
  vm.runInContext(section('  const playerStyles=', '  const playerGuard='),context);
  return {context,theme,other,style,reads:()=>reads,scans:()=>styleScans};
}

test('ordinary observer passes do not reread large theme stylesheets',()=>{
  const p=playerContext();const initial=p.reads();
  for(let i=0;i<100;i++)p.context.playerMode();
  assert.equal(p.reads(),initial);
  assert.equal(p.scans(),1);
});

test('player isolation follows routes and newly injected or rebuilt theme sheets',()=>{
  const p=playerContext();
  p.context.location.hash='#/video';p.context.playerMode();
  assert.equal(p.theme.sheet.disabled,true);
  assert.equal(p.other.sheet.disabled,false);
  const late=p.style('GENERATED FROM PLUGIN SETTINGS late');
  p.context.registerPlayerStyle(late);
  assert.equal(late.sheet.disabled,true);
  p.theme.sheet={disabled:false};const reads=p.reads();
  p.context.registerPlayerStyle(p.theme);
  assert.equal(p.theme.sheet.disabled,true);
  assert.equal(p.reads(),reads);
  p.context.location.hash='#/movies';p.context.playerMode();
  assert.equal(p.theme.sheet.disabled,false);
  assert.equal(late.sheet.disabled,false);
});

test('scrolling defers decoration, and own decorations do not create another update',()=>{
  let now=100,updates=0,observing=true,disconnects=0,observes=0;
  const frames=[],timers=new Map();let timerId=0;
  const context={queued:false,scrollUntil:240,quietTimer:null,Date:{now:()=>now},
    requestAnimationFrame:callback=>frames.push(callback),
    setTimeout(callback){const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),
    document:{body:{}},bodyObserver:{disconnect(){observing=false;disconnects++;},observe(){observing=true;observes++;}},
    update(){updates++;if(observing)context.schedule();}};
  vm.createContext(context);
  vm.runInContext(section('  function schedule() {',"  document.addEventListener('pointerdown'"),context);
  for(let i=0;i<100;i++)context.schedule();
  assert.equal(frames.length,1);
  frames.shift()();assert.equal(updates,0);assert.equal(timers.size,1);
  now=300;const callback=[...timers.values()][0];timers.clear();callback();frames.shift()();
  assert.equal(updates,1);assert.equal(frames.length,0);
  assert.equal(disconnects,1);assert.equal(observes,1);
});

test('metadata timer also waits for scrolling to finish before scanning cards',()=>{
  let pending=null;
  const context={posterTimer:null,scrollUntil:240,Date:{now:()=>100},
    setTimeout(callback,delay){pending={callback,delay};return 123;}};
  vm.createContext(context);
  vm.runInContext(section('  function fetchHomePosters() {','  function translateTheme() {'),context);
  context.fetchHomePosters();
  assert.equal(context.posterTimer,123);
  assert.equal(pending.delay,160);
  assert.equal(pending.callback,context.fetchHomePosters);
});

function artworkFixture(id,classes=[],year='2001'){
  const image={style:{backgroundImage:'native-lazy-artwork'}},title={textContent:'Native title'};
  const yearBox=year==null?null:{textContent:year};
  const element={dataset:{id},classList:{contains:name=>classes.includes(name)},
    querySelector(selector){
      if(selector==='.nf-cw-thumb,.cardImageContainer')return image;
      if(selector==='.nf-cw-title,.cardText-first bdi')return title;
      if(selector==='.hmc-card-year,.cardText-secondary bdi')return this.yearBox;
      throw Error('Unexpected artwork selector '+selector);
    },yearBox,appendChild(node){this.yearBox=node;}};
  return {element,image,title};
}
function artworkContext(cards,items){
  const images=[],hearts=[];
  const context={posterCards:()=>cards.map(x=>x.element),cardId:card=>card.dataset.id,
    posterCache:new Map(items.map(x=>[x.Id,x])),posterRequested:new Set(),posterBusy:false,posterTimer:null,
    addFavourite(card,item){hearts.push({card:card.dataset.id,item:item.Id});},
    window:{ApiClient:{getScaledImageUrl(id,options){images.push({id,options});return '/art/'+id+'?width='+options.maxWidth;}}},
    document:{createElement(){return {textContent:''};}}};
  vm.createContext(context);
  vm.runInContext(section('  function decorateHomeCards() {','  function addFavourite('),context);
  return {context,images,hearts};
}

test('100 native movie/series cards keep their lazy artwork and labels while receiving hearts',()=>{
  const cards=Array.from({length:100},(_,i)=>artworkFixture('native-'+i));
  const items=cards.map((c,i)=>({Id:c.element.dataset.id,Type:i%2?'Series':'Movie',Name:'Metadata title',ProductionYear:2014,ImageTags:{Primary:'tag'}}));
  const f=artworkContext(cards,items);
  f.context.decorateHomeCards();f.context.decorateHomeCards();
  assert.equal(f.images.length,0);
  assert.equal(f.hearts.length,200);
  for(const c of cards){
    assert.equal(c.image.style.backgroundImage,'native-lazy-artwork');
    assert.equal(c.title.textContent,'Native title');
    assert.equal(c.element.yearBox.textContent,'2001');
  }
});

test('custom Home rows retain portrait artwork, names and years',()=>{
  const c=artworkFixture('movie',['nf-card']);
  const f=artworkContext([c],[{Id:'movie',Type:'Movie',Name:'Home Movie',ProductionYear:2014,ImageTags:{Primary:'poster'}}]);
  f.context.decorateHomeCards();f.context.decorateHomeCards();
  assert.equal(f.images.length,1);
  assert.equal(f.images[0].id,'movie');
  assert.equal(f.images[0].options.maxWidth,420);
  assert.equal(c.image.style.backgroundImage,'url("/art/movie?width=420")');
  assert.equal(c.title.textContent,'Home Movie');
  assert.equal(c.element.yearBox.textContent,'2014');
});

test('Continue Watching converts an episode to its series portrait and series heart',()=>{
  const c=artworkFixture('episode',['nf-cw-card'],null);
  const f=artworkContext([c],[
    {Id:'episode',Type:'Episode',Name:'Pilot',SeriesName:'Family Series',SeriesId:'series',SeriesPrimaryImageTag:'series-poster',ProductionYear:2018},
    {Id:'series',Type:'Series',Name:'Family Series',UserData:{IsFavorite:true}}
  ]);
  f.context.decorateHomeCards();
  assert.equal(f.images.length,1);
  assert.equal(f.images[0].id,'series');
  assert.equal(c.title.textContent,'Family Series');
  assert.equal(c.element.yearBox.textContent,'2018');
  assert.equal(c.element.title,'Family Series — Pilot');
  assert.equal(f.hearts[0].item,'series');
});

function tvReparentFixture(whichFocused,connected=true){
  const focusedCalls=[],body={name:'BODY'},external={name:'external',isConnected:true};
  const classes=new Set(['card','portraitCard']);classes.contains=classes.has.bind(classes);
  const document={activeElement:body};
  function focus(options){focusedCalls.push({target:this,options});document.activeElement=this;}
  const descendant={name:'descendant',isConnected:true,focus};
  const card={name:'card',isConnected:true,focus,classList:classes,
    parentElement:{classList:{contains:()=>false}},
    contains:node=>node===descendant,matches:selector=>selector==='button.card',
    closest:selector=>selector==='.itemsContainer-tv'?{}:null,
    querySelector:()=>null,before(wrap){wrap.isConnected=true;}};
  const wrapper={className:'',classList:{add(){}},querySelector:()=>null,
    appendChild(node){
      if(node!==card)return;
      if(document.activeElement===card||card.contains(document.activeElement))document.activeElement=body;
      card.parentElement=this;card.isConnected=descendant.isConnected=connected;
    }};
  document.createElement=tag=>tag==='div'?wrapper:button(false);
  document.querySelectorAll=()=>[];
  document.activeElement=whichFocused==='card'?card:whichFocused==='descendant'?descendant:external;
  const before=document.activeElement;
  const context={document,window:{},user:'mediaadmin'};
  vm.createContext(context);
  vm.runInContext(section('  function addFavourite(', '  function exposeNativeFavourites('),context);
  context.addFavourite(card,{Id:'film',Name:'Film',UserData:{IsFavorite:false}});
  return {document,before,card,descendant,focusedCalls};
}

test('wrapping the focused TV card restores that exact native button without scrolling',()=>{
  const f=tvReparentFixture('card');
  assert.equal(f.document.activeElement,f.card);
  assert.equal(f.focusedCalls.length,1);
  assert.equal(f.focusedCalls[0].target,f.before);
  assert.equal(f.focusedCalls[0].options.preventScroll,true);
});

test('wrapping a TV card preserves focus on an existing descendant',()=>{
  const f=tvReparentFixture('descendant');
  assert.equal(f.document.activeElement,f.descendant);
  assert.equal(f.focusedCalls.length,1);
  assert.equal(f.focusedCalls[0].target,f.before);
  assert.equal(f.focusedCalls[0].options.preventScroll,true);
});

test('decorating an unfocused TV card never steals focus',()=>{
  const f=tvReparentFixture('external');
  assert.equal(f.document.activeElement,f.before);
  assert.equal(f.focusedCalls.length,0);
});

test('a focused TV node removed during reparent is not refocused',()=>{
  const f=tvReparentFixture('card',false);
  assert.equal(f.focusedCalls.length,0);
});
