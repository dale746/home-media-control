const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {imageIdentity,cacheableImage,bytesToEvict,scopeKey,MAX_BYTES}=require('./artwork-cache.js');
const source=fs.readFileSync(require.resolve('./artwork-cache.js'),'utf8');
const base='https://movies.tail.example/web/#/home',image='/Items/'+'a'.repeat(32)+'/Images/Primary?tag=12345678&maxWidth=300';

test('only tagged same-origin Jellyfin artwork is eligible, never streams or API data',()=>{
  assert(imageIdentity(image,base));
  for(const path of [image.replace('tag=12345678&',''),image.replace('/Images/Primary','/Download'),'/Videos/'+'a'.repeat(32)+'/stream.mp4?tag=12345678','/Users/me?tag=12345678','https://foreign.example'+image,'https://secret@movies.tail.example'+image,'data:image/png;base64,abcd',image+'&height=999999'])assert.equal(imageIdentity(path,base),null,path);
});
test('image identity removes authentication and preserves version/size identity',()=>{
  const plain=imageIdentity(image,base),secret=imageIdentity(image+'&api_key=secret&access_token=private',base);
  assert.equal(secret.key,plain.key);assert(!secret.key.includes('secret'));assert(!secret.key.includes('private'));
  assert.notEqual(imageIdentity(image.replace('12345678','abcdefgh'),base).key,plain.key);
  assert.notEqual(imageIdentity(image.replace('300','600'),base).key,plain.key);
  assert.equal(imageIdentity(image+'&unknownCredential=secret',base),null);
});
test('only bounded raster image payloads are accepted',()=>{
  assert(cacheableImage('image/jpeg',20000));assert(cacheableImage('image/webp',100000));
  for(const [type,size] of [['video/mp4',100],['text/html',100],['image/svg+xml',100],['image/jpeg',0],['image/png',9*1024*1024]])assert.equal(cacheableImage(type,size),false);
});
test('byte budget accounts for replacements and cannot exceed one gigabyte',()=>{
  assert.equal(MAX_BYTES,1000000000);assert.equal(bytesToEvict(80,20,40,100),0);
  assert.equal(bytesToEvict(90,0,40,100),30);assert.equal(bytesToEvict(90,30,50,100),10);
  assert.equal(bytesToEvict(999999999,0,2,9e12),1);
  assert.notEqual(scopeKey('server-a','user-a'),scopeKey('server-a','user-b'));
});

// Small asynchronous IndexedDB transaction fixture exercises the actual cache
// write routine, including its serial writer and indexed LRU cursor.
function storageFixture(limit=100) {
  const stores={images:new Map(),meta:new Map(),totals:new Map()},context={
    MAX_BYTES:1000000000,limit,epoch:1,scope:'current-user',enabled:true,writesBlocked:false,storageProblem:'',
    writeQueue:Promise.resolve(),Promise,Date,Error,Math,Number,bytesToEvict};
  const db={transaction(names){
    const tx={pending:0,aborted:false,completed:false,objectStore(name){
      const store=stores[name];return {
        get(key){return request(()=>store.get(key));},
        put(value,key){
          if(tx.aborted)return;
          if(context.failNextWrite){context.failNextWrite=false;tx.aborted=true;tx.error={name:'QuotaExceededError'};queueMicrotask(()=>tx.onerror?.());return;}
          store.set(key??value.key,value);
        },delete(key){store.delete(key);},
        index(){return {openCursor(){const entries=[...store.values()].sort((a,b)=>a.used-b.used);let index=0;const req={};function advance(){enqueue(()=>{const value=entries[index++];req.result=value?{key:value.used,primaryKey:value.key,value,continue:advance}:null;req.onsuccess?.();});}advance();return req;}};}
      };
    },abort(){tx.aborted=true;queueMicrotask(()=>tx.onabort?.());}};
    function enqueue(callback){tx.pending++;queueMicrotask(()=>{if(tx.aborted)return;callback();tx.pending--;if(tx.pending===0)queueMicrotask(()=>{if(!tx.pending&&!tx.aborted&&!tx.completed){tx.completed=true;tx.oncomplete?.();}});});}
    function request(operation){const req={};enqueue(()=>{req.result=operation();req.onsuccess?.();});return req;}
    return tx;
  }};
  context.openDb=async()=>db;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function serial(job)'),source.indexOf('  function candidate(element)')),context);
  return {stores,context,async put(key,size,owner='current-user',version=1){await context.saveImage(key,owner,{size,type:'image/jpeg'},version);}};
}
test('LRU eviction removes enough old bytes and both data/metadata records',async()=>{
  const f=storageFixture();await f.put('old',30);f.stores.meta.get('old').used=1;
  await f.put('newer',40);f.stores.meta.get('newer').used=2;
  await f.put('incoming',50);
  assert(!f.stores.images.has('old'));assert(!f.stores.meta.has('old'));
  assert(f.stores.images.has('newer'));assert(f.stores.images.has('incoming'));
  assert.equal(f.stores.totals.get('bytes'),90);
});
test('replacement does not evict or subtract its own previous record twice',async()=>{
  const f=storageFixture();await f.put('replace',20);f.stores.meta.get('replace').used=1;
  await f.put('other',70);f.stores.meta.get('other').used=2;
  await f.put('replace',40);
  assert(f.stores.images.has('replace'));assert(!f.stores.images.has('other'));
  assert.equal(f.stores.totals.get('bytes'),40);
});
test('concurrent incoming pictures share one serial writer and one global cap',async()=>{
  const f=storageFixture();await Promise.all([f.put('a',60),f.put('b',60),f.put('c',60)]);
  assert.equal(f.stores.images.size,1);assert.equal(f.stores.totals.get('bytes'),60);
});
test('logout/scope change, disabled writes and oversize pictures cannot save new data',async()=>{
  const f=storageFixture();await f.put('wrong-user',20,'another-user');await f.put('old-page',20,'current-user',0);await f.put('too-large',101);
  f.context.enabled=false;await f.put('disabled',20);
  assert.equal(f.stores.images.size,0);
});
test('device quota failure stops new writes without breaking normal browsing',async()=>{
  const f=storageFixture();f.context.failNextWrite=true;
  await f.put('quota',20);
  assert.equal(f.context.writesBlocked,true);assert.match(f.context.storageProblem,/no more artwork space/);
  await f.put('later',20);assert.equal(f.stores.images.size,0);
});
test('storage unavailable is handled without rejecting the image pipeline',async()=>{
  const f=storageFixture();f.context.openDb=async()=>{throw Error('Private storage disabled');};
  await assert.doesNotReject(f.put('unavailable',20));
  assert.match(f.context.storageProblem,/Normal browsing still works/);
});
test('active scrolling defers cache work and the quiet queue runs only two jobs',()=>{
  const pending=[],started=[],context={enabled:true,isPlayer:()=>false,queue:[{element:{}},{element:{}},{element:{}}],
    workTimer:null,scrollUntil:2000,running:0,queued:{delete(){}},Date:{now:()=>1000},Math,
    setTimeout(callback,delay){pending.push({callback,delay});return pending.length;},
    work(job){started.push(job);return new Promise(()=>{});}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function schedule()'),source.indexOf('  function cleanRemoved()')),context);
  context.schedule();assert.equal(pending[0].delay,1000);pending.shift().callback();assert.equal(started.length,0);
  context.Date.now=()=>2100;pending.shift().callback();assert.equal(started.length,2);
  context.pump();assert.equal(started.length,2);assert.equal(context.queue.length,1);
});
test('integration remains image-only, passive and does not install a fetch interceptor',()=>{
  assert(source.includes("cache:'force-cache'"));assert(source.includes("redirect:'error'"));
  assert(source.includes("attributeFilter:['src','style']"));assert(source.includes('running<2'));
  assert(!source.includes('navigator.serviceWorker.register'));assert(!source.includes('window.fetch='));
  assert(source.includes('suspendCapture=true'));assert(source.includes('URL.revokeObjectURL'));
});
