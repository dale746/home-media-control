const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'dist/controls.js'),'utf8').split('let holdingData=')[1];
const item=(n,state='held')=>({id:n.toString(16).padStart(32,'0'),title:'Test film '+n,year:2024,bytes:1e9,state,type:'Movie',created:'2026-11-01'});

function harness(items=[item(1),item(2)],canControl=true){
  const elements=new Map(),calls=[],messages=[];
  let live=items.map(x=>({...x})),reply=null,fetcher=null;
  class Element{
    constructor(){this.listeners={};this.disabled=false;this.checked=false;this.isConnected=true;this.dataset={};this.value='';}
    set id(value){this._id=value;elements.set(value,this)}get id(){return this._id}
    set innerHTML(value){this.html=value;for(const match of value.matchAll(/\bid="([^"]+)"/g))if(!elements.has(match[1])){const e=new Element();e.id=match[1]}}
    get innerHTML(){return this.html||''}
    append(){}after(){}setAttribute(){}
    addEventListener(name,fn){this.listeners[name]=fn}
    focus(){document.activeElement=this}
    showModal(){this.open=true}
    close(){this.open=false;this.listeners.close?.()}
  }
  const document={activeElement:null,createElement:()=>new Element(),getElementById:id=>elements.get(id)||null,body:new Element(),querySelector:()=>new Element(),querySelectorAll:()=>[]};
  const controls=new Element();controls.id='controls';
  const context=vm.createContext({document,data:{canControl},location:{hash:'#overview'},window:{addEventListener(){}},Set,Map,Date,Array,actionBusy:false,
    updateNavigation(){},esc:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    tell:(message,error)=>messages.push({message,error}),
    fetch:async()=>fetcher?fetcher():({ok:true,json:async()=>({items:live,bytes:live.reduce((s,x)=>s+x.bytes,0)})}),
    action:async body=>{calls.push(JSON.parse(JSON.stringify(body)));if(reply)return reply(body);const deletedIds=body.ids||[];live=live.filter(x=>!deletedIds.includes(x.id));return {deletedIds,failed:[]}}
  });
  vm.runInContext('let holdingData='+source,context);
  context.seed=items;
  vm.runInContext('holdingData={items:seed};createHolding();updateHoldingSelection()',context);
  return {context,document,elements,calls,messages,run:code=>vm.runInContext(code,context),
    setLive:value=>{live=value},setReply:value=>{reply=value},setFetch:value=>{fetcher=value},
    submit:()=>elements.get('holding-confirm-form').onsubmit({preventDefault(){}})};
}

test('Select all selects held items only, supports clear and mixed state',()=>{
  const h=harness([item(1),item(2),item(3,'moving')]);
  h.run('toggleAllHolding(true)');
  assert.equal(h.run('holdingSelection.size'),2);assert.equal(h.elements.get('holding-select-all').checked,true);
  h.run('holdingSelection.delete(seed[0].id);updateHoldingSelection()');
  assert.equal(h.elements.get('holding-select-all').indeterminate,true);
  assert.match(h.elements.get('holding-selection-summary').textContent,/1 selected/);
  h.run('toggleAllHolding(false)');assert.equal(h.run('holdingSelection.size'),0);assert.equal(h.elements.get('holding-delete-selected').disabled,true);
});

test('refresh preserves remaining selections but never selects newly held titles',async()=>{
  const h=harness();h.run('toggleAllHolding(true)');h.setLive([item(2),item(3)]);await h.run('loadHolding(true)');
  assert.equal(h.run('holdingSelection.size'),1);assert.equal(h.run('holdingSelection.has(seed[1].id)'),true);assert.equal(h.elements.get('holding-select-all').indeterminate,true);
});

test('confirmation freezes explicit IDs; later titles cannot join deletion',async()=>{
  const h=harness();h.run('toggleAllHolding(true);openPurge(selectedHolding())');
  h.setLive([item(1),item(2),item(3)]);await h.run('loadHolding(true)');
  h.elements.get('holding-confirm-text').value='DELETE';await h.submit();
  assert.deepEqual(h.calls[0].ids,[item(1).id,item(2).id]);assert.equal(h.calls[0].operation,'purge-selected');
  assert.match(h.elements.get('holding-summary').textContent,/1 held title/);
});

test('wrong or missing typed confirmation sends no deletion request',async()=>{
  const h=harness();h.run('openPurge(seed)');
  for(const value of ['','delete',' DELETE','DELETE ']){h.elements.get('holding-confirm-text').value=value;await h.submit()}
  assert.equal(h.calls.length,0);
});

test('one confirmation handles more than 200 titles in bounded batches',async()=>{
  const h=harness(Array.from({length:205},(_,i)=>item(i+1)));h.run('toggleAllHolding(true);openPurge(selectedHolding())');
  h.elements.get('holding-confirm-text').value='DELETE';await h.submit();
  assert.deepEqual(h.calls.map(x=>x.ids.length),[200,5]);assert.equal(new Set(h.calls.flatMap(x=>x.ids)).size,205);
  assert.equal(h.run('holdingSelection.size'),0);assert.equal(h.elements.get('holding-confirm').open,false);
});

test('partial failures keep failed titles selected and require another confirmation',async()=>{
  const h=harness();h.run('toggleAllHolding(true);openPurge(selectedHolding())');
  h.setReply(body=>{h.setLive([item(2)]);return {deletedIds:[body.ids[0]],failed:[{id:body.ids[1],message:'Temporary test failure'}]}});
  h.elements.get('holding-confirm-text').value='DELETE';await h.submit();
  assert.equal(h.run('holdingSelection.size'),1);assert.equal(h.run('holdingSelection.has(seed[1].id)'),true);assert.equal(h.elements.get('holding-confirm-text').value,'');
  assert.match(h.elements.get('holding-items').innerHTML,/Temporary test failure/);
  assert.ok(h.messages.some(x=>x.error&&x.message.includes('confirmed deleted')));
});

test('uncertain request outcome stops subsequent batches and keeps remaining selection',async()=>{
  const h=harness(Array.from({length:201},(_,i)=>item(i+1)));h.run('toggleAllHolding(true);openPurge(selectedHolding())');
  h.setReply(()=>undefined);h.elements.get('holding-confirm-text').value='DELETE';await h.submit();
  assert.equal(h.calls.length,1);assert.equal(h.run('holdingSelection.size'),201);assert.equal(h.elements.get('holding-cancel').disabled,false);
});

test('read-only clients cannot select or submit and empty holding disables Select all',async()=>{
  const h=harness(undefined,false);h.run('toggleAllHolding(true);openPurge(seed)');h.elements.get('holding-confirm-text').value='DELETE';await h.submit();
  assert.equal(h.calls.length,0);assert.equal(h.run('holdingSelection.size'),0);assert.equal(h.elements.get('holding-bulk').hidden,true);
  const empty=harness([]);assert.equal(empty.elements.get('holding-select-all').disabled,true);
});

test('confirmation escapes titles and cancel restores the originating focus without deleting',()=>{
  const record={...item(1),title:'<script>Test & "film"</script>'};const h=harness([record]);
  h.elements.get('holding-delete-selected').focus();h.run('openPurge(seed)');
  assert.match(h.elements.get('holding-confirm-list').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.elements.get('holding-confirm-list').innerHTML,/<script>/);
  h.elements.get('holding-cancel').onclick();assert.equal(h.document.activeElement,h.elements.get('holding-delete-selected'));assert.equal(h.calls.length,0);
});

test('post-deletion refresh waits for an older GET then fetches a fresh list',async()=>{
  const h=harness();let release,gets=0;
  h.setFetch(()=>++gets===1?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({items:[item(1),item(2)],bytes:2e9})})}):Promise.resolve({ok:true,json:async()=>({items:[],bytes:0})}));
  const oldRefresh=h.run('loadHolding(true)');h.run('openPurge(seed)');h.elements.get('holding-confirm-text').value='DELETE';
  const submission=h.submit();await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([oldRefresh,submission]);
  assert.equal(gets,2);assert.match(h.elements.get('holding-summary').textContent,/Holding is empty/);assert.equal(h.run('holdingSelection.size'),0);
});
