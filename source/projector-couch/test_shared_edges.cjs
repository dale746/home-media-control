const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'../usability/hmc-browse.js');
const source=fs.readFileSync(file,'utf8');
const {settledWithin}=require(file);

for(const tv of [true,false])test(`${tv?'TV':'mobile browser'} service handoff preserves its intended browsing context`,()=>{
  let handler;
  const helpers=require(file);
  const context={document:{documentElement:{classList:{contains:()=>tv}},addEventListener(_name,callback){handler=callback;}},
    window:{},movies:true,location:{href:'http://media-movies.local/web/#/search?query=BUNNY'},
    rewriteOwnedUrl:raw=>raw,isDownloadProgressUrl:helpers.isDownloadProgressUrl,isDiscoveryUrl:helpers.isDiscoveryUrl,
    safeMoviesReturn:helpers.safeMoviesReturn,snapshot(){},freshKey:()=> 'resume',records:{page:{}},current:'page',persist(){},sessionStorage:{setItem(){}},URL,Date,JSON};
  vm.createContext(context);
  const start=source.indexOf("  document.addEventListener('click',e=>{\n    const a=e.target.closest?.('a[href]');");
  vm.runInContext(source.slice(start,source.indexOf('  function message(',start)),context);
  for(const href of ['http://media-discover.local/movie/1','http://192.0.2.10/status/#downloads']){
    const anchor={href,target:'_blank',dataset:{hmcDiscovery:'1'},matches:()=>false};
    handler({target:{closest:()=>anchor},preventDefault(){assert.fail('Normal browser handoff must remain native');},stopImmediatePropagation(){}});
    assert.equal(anchor.target,tv?'_self':'_blank');
    if(href.includes('discover'))assert.equal(new URL(anchor.href).searchParams.get('hmcReturn'),'http://media-movies.local/web/#/search?query=BUNNY');
  }
});

test('TV restoration resolves the same native poster identity and server, ignoring hidden duplicates',()=>{
  let chosen;
  const card=(id,server,visible=true)=>({getAttribute:key=>key==='data-id'?id:server,getClientRects:()=>visible?[{}]:[],focus(options){assert.equal(options.preventScroll,true);chosen=this;}});
  const hidden=card('movie','server',false),wrong=card('movie','other'),wanted=card('movie','server');
  const context={document:{querySelectorAll:()=>[hidden,wrong,wanted]}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function focusRecord('),source.indexOf('  function restore(')),context);
  assert.equal(context.focusRecord({focusCard:{id:'movie',server:'server'}}),true);assert.equal(chosen,wanted);
  chosen=null;assert.equal(context.focusRecord({focusCard:{id:'not-mounted',server:'server'}}),false);assert.equal(chosen,null);
});

test('trailer lookup has a bounded timeout and ignores a late result',async()=>{
  let complete;
  const pending=new Promise(resolve=>complete=resolve);
  assert.equal(await settledWithin(pending,5),null);
  complete('late-trailer');
  assert.equal(await settledWithin(Promise.resolve('ready'),100),'ready');
  assert.equal(await settledWithin(Promise.reject(Error('offline')),100),null);
});

for(const focused of [true,false])test(`replacing a ${focused?'focused':'background'} Trailer preserves focus ownership`,()=>{
  let focus=0,replaced;
  const link={dataset:{},setAttribute(){},addEventListener(){},focus(options){assert.equal(options.preventScroll,true);focus++;}};
  const button={isConnected:true,dataset:{},attributes:[],innerHTML:'Trailer',title:'Trailer',getAttribute:()=>null,contains:()=>false,replaceWith(el){replaced=el;}};
  const context={document:{activeElement:focused?button:{},createElement:()=>link}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function externalButton('),source.indexOf('  function discoveryButton(')),context);
  context.externalButton(button,'https://www.youtube.com/watch?v=tP1G0VeqfVA');
  assert.equal(replaced,link);assert.equal(focus,focused?1:0);
});

for(const leave of ['route','disconnect','playback'])test(`late trailer lookup after ${leave} cannot decorate or notify`,async()=>{
  let callback,complete,current='old',player=false,decorated=0;
  const messages=[];
  const button={isConnected:true};
  const context={window:{},document:{addEventListener(_event,handler){callback=handler;}},movies:true,
    itemId:()=>current,trailerCache:new Map(),externalButton:()=>decorated++,message:text=>messages.push(text),
    trailer:()=>new Promise(resolve=>complete=resolve),isPlayerUrl:()=>player,location:{href:'http://test/web/#/details?id=old'}};
  vm.createContext(context);
  const start=source.indexOf("  document.addEventListener('click', e => {\n    const external=");
  vm.runInContext(source.slice(start,source.indexOf('  function schedule()',start)),context);
  callback({target:{closest:selector=>selector==='button.btnPlayTrailer'?button:null},preventDefault(){},stopImmediatePropagation(){}});
  if(leave==='route')current='new';if(leave==='disconnect')button.isConnected=false;if(leave==='playback')player=true;
  complete('https://www.youtube.com/watch?v=tP1G0VeqfVA');await Promise.resolve();
  assert.equal(decorated,0);assert.deepEqual(messages,['Finding the trailer link…']);
});
