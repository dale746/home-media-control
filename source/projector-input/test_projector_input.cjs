const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const bridgePath=process.env.HMC_PROJECTOR_INPUT_SOURCE||path.join(__dirname,'projector-input.js');
const source=fs.readFileSync(bridgePath,'utf8');
const {chooseNext,nearestTarget,keyFor,wantsControls,isPlayerUrl,nativeTvOwnsKeys,handlesLayout,nativeMenuOwnsKey,removeLast}=require(bridgePath);
const rect=(left,top,width=100,height=80)=>({left,top,width,height});

test('all four arrows prefer a control in the same row or column',()=>{
  const candidates=[{id:'left',rect:rect(-140,0)},{id:'right',rect:rect(140,0)},
    {id:'up',rect:rect(0,-120)},{id:'down',rect:rect(0,120)},{id:'diagonal',rect:rect(110,130)}];
  for(const direction of ['left','right','up','down'])assert.equal(chooseNext(rect(0,0),candidates,direction).id,direction);
  assert.equal(chooseNext(rect(0,0),[{rect:rect(-140,0)}],'right'),null);
});
test('hidden, disabled and zero-size controls cannot win spatial selection',()=>{
  const candidates=[{id:'hidden',hidden:true,rect:rect(110,0)},{id:'disabled',disabled:true,rect:rect(115,0)},
    {id:'empty',rect:rect(120,0,0,80)},{id:'live',rect:rect(160,0)}];
  assert.equal(chooseNext(rect(0,0),candidates,'right').id,'live');
});
test('a refreshed dashboard keeps focus near the replaced control',()=>{
  const a={id:'sidebar',rect:rect(0,0)},b={id:'replacement',rect:rect(510,402)},c={id:'hidden',hidden:true,rect:rect(500,400)};
  assert.equal(nearestTarget(rect(500,400),[a,b,c]).id,'replacement');
  assert.equal(nearestTarget(rect(500,400),[]),null);
});
test('phone and desktop arrow keys stay native unless explicitly enabled',()=>{
  assert.equal(wantsControls('Mozilla/5.0 iPhone','http://movies/web/',null,false),false);
  assert.equal(wantsControls('Mozilla/5.0 Chrome Windows','http://movies/web/',null,false),false);
  assert.equal(wantsControls('Mozilla/5.0 VIDAA Hisense','http://movies/web/',null,false),true);
  assert.equal(wantsControls('Mozilla/5.0','http://movies/web/?tv=1',null,false),true);
  assert.equal(wantsControls('Mozilla/5.0','http://movies/web/','1',false),true);
  assert.equal(wantsControls('Hisense VIDAA','http://movies/web/','0',false),false);
});
test('native Jellyfin TV layout owns keys while Mobile and dashboard use bridge',()=>{
  assert.equal(nativeTvOwnsKeys('/web/index.html',true,false),true);
  assert.equal(nativeTvOwnsKeys('/web/index.html',false,false),false);
  assert.equal(nativeTvOwnsKeys('/status/',true,false),false);
  assert.equal(nativeTvOwnsKeys('/web/index.html',true,true),true);
});
test('extra Jellyfin controls require Mobile mode; TV, Desktop and initial loading remain native',()=>{
  assert.equal(handlesLayout('/web/index.html',false,false),false);
  assert.equal(handlesLayout('/web/index.html',false,true),false);
  assert.equal(handlesLayout('/web/index.html',true,true),false);
  assert.equal(handlesLayout('/web/index.html',true,false),true);
  assert.equal(handlesLayout('/status/',false,false),true);
});
test('leaving Mobile mode releases only bridge-owned tab stops and never moves TV focus',()=>{
  let removed=0,focused=0,cleared=0;
  const own={getAttribute:()=> '0',removeAttribute:()=>removed++,focus:()=>focused++};
  const changed={getAttribute:()=> '-1',removeAttribute:()=>assert.fail('Native tabindex must be kept')};
  const context={refreshTimer:null,overlay:{remove(){removed++;}},overlayParent:null,overlayParentClose:null,edit:{},ownedTabStops:new Set([own,changed]),lastElement:own,lastRect:{},lastIdentity:{},restoreInputs(){cleared++;},clearFocus(){cleared++;}};
  vm.createContext(context);vm.runInContext(section('  function releaseControls()', '  function move('),context);
  context.releaseControls();assert.equal(removed,2);assert.equal(cleared,2);assert.equal(focused,0);assert.equal(context.ownedTabStops.size,0);assert.equal(context.overlay,null);assert.equal(context.lastElement,null);
});
test('shared menus and navigation keep their own key handlers',()=>{
  const element=classes=>({closest:selector=>classes.includes(selector)?{}:null});
  assert.equal(nativeMenuOwnsKey(element(['.hmc-menu']),'ArrowRight'),true);
  assert.equal(nativeMenuOwnsKey(element(['.hmc-menu']),'Back'),true);
  assert.equal(nativeMenuOwnsKey(element(['.hmc-main-nav']),'ArrowLeft'),true);
  assert.equal(nativeMenuOwnsKey(element(['.hmc-main-nav']),'ArrowDown'),false);
  assert.equal(nativeMenuOwnsKey(element(['.hmc-main-nav','.hmc-nav-trigger']),'ArrowDown'),true);
  assert.equal(nativeMenuOwnsKey(element([]),'ArrowDown'),false);
});
test('video routes never enter the browsing bridge',()=>{
  for(const route of ['#/video','#!/video','#/videoosd?x=1','#/player'])assert.equal(isPlayerUrl('http://movies/web/'+route),true);
  assert.equal(isPlayerUrl('http://movies/web/#/movies'),false);
});
test('remote hardware codes map to expected actions',()=>{
  for(const [code,key] of [[37,'ArrowLeft'],[38,'ArrowUp'],[39,'ArrowRight'],[40,'ArrowDown'],[23,'Enter'],[461,'Back'],[10009,'Back']])assert.equal(keyFor({key:'Unidentified',keyCode:code}),key);
  assert.equal(keyFor({key:'BrowserBack',keyCode:0}),'Back');
  assert.equal(keyFor({key:'Tab',keyCode:9}),'Tab');
  assert.equal(removeLast('Holiday 🎄'),'Holiday ');
});

function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end));}
test('popup scope confines navigation to the visible menu or dialog',()=>{
  const one={id:'menu'},two={id:'dialog'},hidden={id:'hidden',hidden:true};
  const doc={querySelectorAll:()=>[one,hidden,two]};
  const context={overlay:null,document:doc,visible:el=>!el.hidden};vm.createContext(context);
  vm.runInContext(section('  function scope()', '  function targets('),context);
  assert.equal(context.scope(),two);
  context.overlay=one;assert.equal(context.scope(),one);
  context.overlay=null;doc.querySelectorAll=()=>[hidden];assert.equal(context.scope(),doc);
});
test('target selection removes nested actions, duplicate poster links and hidden buttons',()=>{
  const card={id:'card',matches:()=>false},parent={id:'parent'};
  const element=(id,opts={})=>({id,tagName:'A',matches:()=>false,parentElement:{closest:()=>opts.nested?parent:null},...opts});
  const a=element('picture',{primary:true}),duplicate=element('title',{primary:true}),nested=element('nested',{nested:true}),hidden=element('hidden',{hidden:true}),button=element('button',{tagName:'BUTTON'});
  const root={querySelectorAll:()=>[a,duplicate,nested,hidden,button],contains:()=>true};
  const context={scope:()=>root,selector:'fixture',visible:el=>!el.hidden,primaryCard:el=>el.primary,cardFor:()=>card};vm.createContext(context);
  vm.runInContext(section('  function targets(', '  function clearFocus('),context);
  assert.deepEqual(Array.from(context.targets()).map(e=>e.id),['picture','button']);
});
test('visible native poster root replaces transparent overlay anchors and keeps its heart',()=>{
  const parent={closest:()=>null};
  const card={id:'card',tagName:'DIV',matches:s=>s==='.card[data-id]',parentElement:parent};
  const link={id:'overlay-link',tagName:'A',primary:true,parentElement:parent,matches:()=>false};
  const heart={id:'heart',tagName:'BUTTON',parentElement:parent,matches:()=>false};
  const root={querySelectorAll:()=>[card,link,heart],contains:()=>true};
  const context={scope:()=>root,selector:'fixture',visible:()=>true,primaryCard:el=>el===card||el===link,cardFor:()=>card};vm.createContext(context);
  vm.runInContext(section('  function targets(', '  function clearFocus('),context);
  assert.deepEqual(Array.from(context.targets()).map(e=>e.id),['card','heart']);
  let clicked=0;card.querySelector=()=>({click:()=>clicked++});card.click=()=>assert.fail('Must activate existing details link');
  vm.runInContext(section('  function activateCard(', '  function box('),context);
  context.activateCard(card);assert.equal(clicked,1);
});
test('ordinary browser startup registers no keyboard interception',()=>{
  const events=[];
  const context={navigator:{userAgent:'Mozilla/5.0 iPhone'},location:{href:'http://movies/web/#/movies',pathname:'/web/'},
    localStorage:{getItem:()=>null},window:{},document:{addEventListener:name=>events.push(name)},URL,Set,Map,WeakMap,Date};
  vm.createContext(context);vm.runInContext(source,context);
  assert.equal(context.window.HomeMediaProjectorInput.isEnabled(),false);
  assert.deepEqual(events,['hmc-projector-controls']);
});
test('focus refresh first matches a stable ID or exact action identity',()=>{
  const context={lastIdentity:{id:'copy-toggle'},identity:e=>e};vm.createContext(context);
  vm.runInContext(section('  function replacement(', '  function focus('),context);
  const updated={id:'copy-toggle'},other={id:'downloader-toggle'};
  assert.equal(context.replacement([other,updated]),updated);
  context.lastIdentity={tag:'BUTTON',id:'',href:'',name:'Retry',hash:'movie-a',operation:'retry',card:'',region:'downloads'};
  const wrong={...context.lastIdentity,hash:'movie-b'},right={...context.lastIdentity};
  assert.equal(context.replacement([wrong,right]),right);
});

test('script contains no network, media or generic scroll interception',()=>{
  assert(!/\bfetch\(/.test(source));assert(!/addEventListener\(['"](?:wheel|scroll|touchmove)['"]/.test(source));
  assert(source.includes("el?.matches('input[type=range]')"));assert(source.includes('if(el?.isContentEditable)return'));
});
