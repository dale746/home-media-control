const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createBackNavigation,preferLogicalBack}=require('./hmc-browse.js');
const source=fs.readFileSync(require.resolve('./hmc-browse.js'),'utf8');

function clock(){
  let now=0,id=0;const jobs=new Map();
  return {later(fn,delay){const token=++id;jobs.set(token,{fn,at:now+delay});return token},cancel(token){jobs.delete(token)},
    tick(to){for(;;){const entry=[...jobs].filter(([,job])=>job.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;jobs.delete(entry[0]);now=entry[1].at;entry[1].fn()}now=to},get size(){return jobs.size}};
}
function fixture({delay=900,logical=false,commit=true}={}){
  const time=clock(),entries=[{key:'landing',url:'login'},{key:'home',url:'home'},{key:'details',url:'details'}];
  let index=2,state={...entries[index]},backs=0,replacements=0,controller;
  function changed(){state={...entries[index]};controller?.settled()}
  controller=createBackNavigation({read:()=>state,later:time.later,cancelLater:time.cancel,
    goBack(){backs++;time.later(()=>{index=Math.max(0,index-1);changed()},delay)},
    goLogical(parent,target){replacements++;if(commit){entries[index]={key:parent,url:target};changed()}}});
  return {time,entries,controller,request:()=>controller.request('home','home',logical),get state(){return state},get backs(){return backs},get replacements(){return replacements},
    navigate(key,url){state={key,url};controller.settled()}};
}

test('old timed assign fallback can rebound Home to details after a delayed traversal',()=>{
  const time=clock(),entries=['login','home','details'];let index=2;
  time.later(()=>{index=Math.max(0,index-1)},900);
  time.later(()=>{if(entries[index]==='details'){entries.push('home');index=entries.length-1}},700);
  time.tick(1000);assert.equal(entries[index],'details');
});
test('delayed browser traversal cannot rebound after the replacement fallback',()=>{
  const f=fixture();f.request();f.time.tick(750);assert.equal(f.state.url,'home');assert.equal(f.replacements,1);assert.equal(f.entries.length,3);
  f.time.tick(1000);assert.equal(f.state.url,'home');assert.equal(f.replacements,1);assert.equal(f.backs,1);
});
test('fast native browser Back cancels fallback and preserves normal TV/browser history',()=>{
  const f=fixture({delay:80});f.request();f.time.tick(1000);assert.equal(f.state.key,'home');assert.equal(f.backs,1);assert.equal(f.replacements,0);assert.equal(f.time.size,0);
});
test('rapid Back presses issue only one pending browser traversal',()=>{
  const f=fixture();assert.equal(f.request(),true);assert.equal(f.request(),false);assert.equal(f.request(),false);f.time.tick(1000);assert.equal(f.backs,1);assert.equal(f.state.key,'home');
});
test('native mobile app restores the known parent without traversing the WebView stack',()=>{
  const f=fixture({logical:true});f.request();assert.equal(f.state.key,'home');assert.equal(f.backs,0);assert.equal(f.replacements,1);f.time.tick(1000);assert.equal(f.state.key,'home');
});
test('an unrelated navigation or explicit cancel prevents a stale fallback',()=>{
  for(const cancel of [false,true]){const f=fixture({commit:false});f.request();if(cancel)f.controller.cancel();else f.navigate('different','other-details');f.time.tick(750);assert.equal(f.replacements,0)}
});
test('pending logical navigation blocks rapid taps but a failed route can be retried',()=>{
  const f=fixture({logical:true,commit:false});assert.equal(f.request(),true);assert.equal(f.request(),false);f.time.tick(750);assert.equal(f.request(),true);assert.equal(f.replacements,2);assert.equal(f.backs,0);
});
test('mobile native Back preference never takes over projector TV or ordinary browsers',()=>{
  for(const classes of ['layout-mobile','layout-desktop','']){assert.equal(preferLogicalBack({},null,classes),true);assert.equal(preferLogicalBack(null,{},classes),true);assert.equal(preferLogicalBack(null,null,classes),false)}
  assert.equal(preferLogicalBack({}, {},'extra layout-tv more'),false);assert.equal(preferLogicalBack({},null,'layout-tv'),false);
});
test('logical fallback records the intended parent and uses replacement, never a new entry',()=>{
  const calls=[],stored=new Map(),context={records:{home:{url:'home'}},movies:false,sessionStorage:{setItem:(key,value)=>stored.set(key,value)},persist(){},location:{replace:url=>calls.push(url),assign:()=>assert.fail('Must not add a new browser entry')},JSON,Date};
  vm.createContext(context);const start=source.indexOf('  function logicalBack('),end=source.indexOf('  backNavigation=createBackNavigation',start);vm.runInContext(source.slice(start,end),context);
  context.logicalBack('home','home');assert.equal(context.records.home.browserBackUnsafe,true);assert.equal(JSON.parse(stored.get('hmc-back-target')).key,'home');assert.deepEqual(calls,['home']);
});
test('same-URL logical parent settles immediately without waiting for a missing hashchange',()=>{
  const calls=[],context={records:{home:{url:'same'},detail:{url:'same',parent:'home'}},current:'detail',sessionStorage:{removeItem:key=>calls.push(['remove',key]),setItem:()=>assert.fail('No pending hash return should remain')},
    location:{href:'same',replace:()=>assert.fail('No navigation needed')},history:{state:{native:true}},markedState:(state,key)=>({...state,__hmcBrowse:key}),replace:(state,_unused,url)=>calls.push(['replace',state,url]),
    backNavigation:{settled:()=>calls.push(['settled'])},restore:key=>calls.push(['restore',key]),persist(){},schedule(){},JSON,Date};
  vm.createContext(context);const start=source.indexOf('  function logicalBack('),end=source.indexOf('  backNavigation=createBackNavigation',start);vm.runInContext(source.slice(start,end),context);
  context.logicalBack('home','same');assert.equal(context.current,'home');assert.equal(context.records.home.browserBackUnsafe,true);assert.equal(calls[1][1].__hmcBrowse,'home');assert.ok(calls.some(call=>call[0]==='restore'&&call[1]==='home'));
});

test('mobile native shell uses one logical arrow while TV retains its native arrow',()=>{
  const start=source.indexOf('  function navigationBack(host,needed)'),end=source.indexOf("  document.addEventListener('click',e=>{",start),code=source.slice(start,end);
  for(const tv of [false,true]){
    let hidden=false;const native={disabled:false,hasAttribute:()=>hidden,getClientRects:()=>hidden?[]:[{}],getAttribute:()=>null,setAttribute(){hidden=true},removeAttribute(){hidden=false}};
    const context={records:{detail:{parent:'home'},home:{}},current:'detail',movies:true,isNativeBack:()=>true,back:{hidden:true,title:'Back to where you were'},host:{querySelectorAll:()=>[native]},
      preferLogicalBack,window:{NativeShell:{}},document:{documentElement:{className:tv?'layout-tv':'layout-mobile'}}};
    vm.createContext(context);vm.runInContext(code,context);context.navigationBack(context.host,true);assert.equal(context.back.hidden,tv);assert.equal(hidden,!tv);
  }
});
