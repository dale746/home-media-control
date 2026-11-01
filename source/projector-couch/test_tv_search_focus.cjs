const test=require('node:test'),assert=require('node:assert/strict');
const {searchKey,createRecovery}=require('./tv-search-focus.js');
const movie={id:'00000000000000000000000000000001',server:'server-one'};
function fixture(extra={}){
  let key=searchKey('layout-tv','#/search?query=BUNNY','BUNNY'),blocked=false,active='body';
  let target=null,lookups=0,watches=0,unwatches=0,next=0,now=0;
  const tasks=new Map(),focused=[];
  const recovery=createRecovery({
    context:()=>key?{key,blocked}:null,active:()=>active,isBody:node=>node==='body',
    find(identity){lookups++;return target&&target.id===identity.id&&target.server===identity.server&&target.visible!==false?target:null;},
    focus(node){active=node;focused.push(node);},watch(){watches++;},unwatch(){unwatches++;},
    setTimeout(fn,delay){tasks.set(++next,{fn,at:now+delay});return next;},clearTimeout:id=>tasks.delete(id),...extra
  });
  function advance(ms){const end=now+ms;let safety=100;
    while(safety--){const pending=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!pending)break;
      const [id,task]=pending;tasks.delete(id);now=task.at;task.fn();}
    now=end;
  }
  const old={isConnected:true,...movie};
  return{recovery,old,focused,tasks,advance,
    arm(){active=old;return recovery.remember(old,movie);},
    replace(node={isConnected:true,...movie}){old.isConnected=false;active='body';target=node;recovery.mutated();return node;},
    set active(value){active=value;},set key(value){key=value;},set blocked(value){blocked=value;},set target(value){target=value;},
    get lookups(){return lookups;},get watches(){return watches;},get unwatches(){return unwatches;}};
}
test('a late native replacement restores the same movie after focus drops to BODY',()=>{
  const f=fixture();assert.equal(f.arm(),true);const replacement=f.replace();f.advance(0);
  assert.deepEqual(f.focused,[replacement]);assert.equal(f.recovery.state().armed,true);assert.equal(f.lookups,1);
});
test('ordinary plugin insertion while the selected card remains connected performs no lookup',()=>{
  const f=fixture();f.arm();for(let i=0;i<100;i++)f.recovery.mutated();f.advance(400);
  assert.equal(f.lookups,0);assert.equal(f.focused.length,0);assert.equal(f.tasks.size,1);
});
test('intentional focus on the keyboard, navigation or overlay is never overridden',()=>{
  for(const active of ['keyboard','back-button','dialog']){
    const f=fixture();f.arm();f.replace();f.active=active;f.advance(0);
    assert.equal(f.focused.length,0);assert.equal(f.lookups,0);assert.equal(f.recovery.state().armed,false);
  }
});
test('query change, query edit and route leave invalidate a captured movie',()=>{
  for(const key of [searchKey('layout-tv','#/search?query=OTHER','OTHER'),null,
      searchKey('layout-tv','#/search?query=BUNNY','BUNNY NEW')]){
    const f=fixture();f.arm();f.replace();f.key=key;f.recovery.sync();f.advance(2000);
    assert.equal(f.focused.length,0);assert.equal(f.recovery.state().armed,false);assert.equal(f.tasks.size,0);
  }
  const f=fixture();f.arm();f.replace();f.recovery.clear();f.advance(0);assert.equal(f.focused.length,0);
});
test('mobile, desktop and player routes are inert; meaningful TV query identity is required',()=>{
  for(const mode of ['layout-mobile','layout-desktop',''])assert.equal(searchKey(mode,'#/search?query=BUNNY','BUNNY'),null);
  for(const route of ['#/video?query=BUNNY','#/searching?query=BUNNY','#/search'])assert.equal(searchKey('layout-tv',route),null);
  const f=fixture();f.key=null;assert.equal(f.arm(),false);assert.equal(f.watches,0);assert.equal(f.tasks.size,0);
});
test('same route accepts reordered parameters but never conflates parent libraries or typed query',()=>{
  assert.equal(searchKey('layout-tv','#/search?query=BUNNY&parentId=films','BUNNY'),searchKey('layout-tv','#/search?parentId=films&query=BUNNY','BUNNY'));
  assert.notEqual(searchKey('layout-tv','#/search?query=BUNNY&parentId=films','BUNNY'),searchKey('layout-tv','#/search?query=BUNNY&parentId=shows','BUNNY'));
  assert.notEqual(searchKey('layout-tv','#/search?query=BUNNY','BUNNY'),searchKey('layout-tv','#/search?query=BUNNY','BUNNYX'));
});
test('a result focused after the new query URL still matches only its exact item and server',()=>{
  for(const mismatch of [{id:'different',server:movie.server},{id:movie.id,server:'other-server'}]){
    const f=fixture({maxAttempts:2});f.arm();f.replace({isConnected:true,...mismatch});f.advance(500);
    assert.equal(f.focused.length,0);assert.equal(f.lookups,2);assert.equal(f.recovery.state().armed,false);
  }
});
test('multiple late replacements recover successively without a permanent polling loop',()=>{
  const f=fixture();f.arm();const first=f.replace();f.advance(0);
  first.isConnected=false;f.active='body';const second={isConnected:true,...movie};f.target=second;
  f.recovery.mutated();f.advance(0);assert.deepEqual(f.focused,[first,second]);assert.equal(f.lookups,2);
  f.advance(5000);assert.equal(f.recovery.state().armed,false);assert.equal(f.tasks.size,0);
});
test('a temporarily missing visible match is retried only within the bounded recovery window',()=>{
  const f=fixture({maxAttempts:3});f.arm();f.replace({isConnected:true,visible:false,...movie});f.advance(1000);
  assert.equal(f.lookups,3);assert.equal(f.focused.length,0);assert.equal(f.tasks.size,0);assert.equal(f.recovery.state().armed,false);
  const g=fixture();g.arm();g.replace(null);g.advance(100);const late={isConnected:true,...movie};g.target=late;g.recovery.mutated();g.advance(100);
  assert.deepEqual(g.focused,[late]);
});
test('a newly visible dialog cancels recovery and a connected reparented card is left alone',()=>{
  const f=fixture();f.arm();f.replace();f.blocked=true;f.advance(0);assert.equal(f.focused.length,0);assert.equal(f.lookups,0);
  const g=fixture();g.arm();g.active='body';g.recovery.mutated();g.advance(1000);assert.equal(g.lookups,0);assert.equal(g.focused.length,0);
});
