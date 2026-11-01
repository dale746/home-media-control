const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'dist/controls.js'),'utf8').split('/* Server power controls:')[1].split('let holdingData=')[0];
function harness(overrides={}){
  const elements=new Map(),calls=[];let reply;
  class Element{
    constructor(){this.listeners={};this.disabled=false;this.isConnected=true;this.value='';}
    set id(value){this._id=value;elements.set(value,this)}get id(){return this._id}
    set innerHTML(value){this.html=value;for(const m of value.matchAll(/\bid="([^"]+)"/g))if(!elements.has(m[1])){const e=new Element();e.id=m[1]}}
    append(){}after(){}setAttribute(){}addEventListener(name,fn){this.listeners[name]=fn}
    focus(){document.activeElement=this}showModal(){this.open=true}close(){this.open=false;this.listeners.close?.()}
  }
  const document={activeElement:null,getElementById:id=>elements.get(id)||null,createElement:()=>new Element(),body:new Element()};new Element().id='controls';
  const data={canControl:true,serverPower:{phase:'online',canShutdown:true,bootId:'boot-a'},...overrides};
  const context=vm.createContext({document,data,actionBusy:false,action:async body=>{calls.push(JSON.parse(JSON.stringify(body)));return reply?reply(body):{accepted:true,serverPower:{phase:'pending',canShutdown:false,bootId:'boot-a'}}}});
  vm.runInContext('/* Server power controls:'+source,context);vm.runInContext('renderServerPower(data)',context);
  return {context,data,elements,document,calls,run:code=>vm.runInContext(code,context),setReply:fn=>{reply=fn},open:()=>elements.get('server-shutdown').onclick(),submit:()=>elements.get('server-shutdown-form').onsubmit({preventDefault(){}})};
}
test('rendering, opening and cancelling never issue a shutdown and restore focus',()=>{
  const h=harness();h.elements.get('server-shutdown').focus();h.open();assert.equal(h.elements.get('server-shutdown-confirm').open,true);
  assert.equal(h.elements.get('server-shutdown-submit').disabled,true);h.elements.get('server-shutdown-text').value='SHUTDOWN';h.elements.get('server-shutdown-cancel').onclick();
  assert.equal(h.elements.get('server-shutdown-text').value,'');assert.equal(h.document.activeElement,h.elements.get('server-shutdown'));assert.equal(h.calls.length,0);
});
test('only the confirmation word allows an explicit fixed server-power request',async()=>{
  const h=harness();h.open();for(const value of ['','shut down','shutdown server','YES']){h.elements.get('server-shutdown-text').value=value;await h.submit()}
  assert.equal(h.calls.length,0);h.elements.get('server-shutdown-text').value='SHUTDOWN';await h.submit();
  assert.deepEqual(h.calls,[{action:'server-power',operation:'shutdown',confirmation:'SHUTDOWN'}]);assert.equal(h.elements.get('server-shutdown').disabled,true);
});
test('natural typed case and surrounding spaces normalize to the strict backend confirmation',async()=>{
  for(const value of ['shutdown','Shutdown',' SHUTDOWN ']){const h=harness();h.open();h.elements.get('server-shutdown-text').value=value;await h.submit();assert.equal(h.calls.length,1);assert.equal(h.calls[0].confirmation,'SHUTDOWN')}
});
test('read-only, offline, unverified and pending states cannot submit even with typed confirmation',async()=>{
  for(const value of [{canControl:false},{serverPower:{phase:'offline',canShutdown:false}},{serverPower:{phase:'unverified',canShutdown:false}},{serverPower:{phase:'pending',canShutdown:false}}]){
    const h=harness(value);h.open();assert.notEqual(h.elements.get('server-shutdown-confirm').open,true);h.elements.get('server-shutdown-text').value='SHUTDOWN';await h.submit();assert.equal(h.calls.length,0);
  }
});
test('read-only view keeps shutdown visible and links to full controls without granting actions',async()=>{
  const h=harness({canControl:false});assert.equal(h.elements.get('server-shutdown').hidden,false);assert.equal(h.elements.get('server-shutdown').disabled,true);
  assert.equal(h.elements.get('server-power-full-controls').hidden,false);assert.match(h.elements.get('server-power-note').textContent,/view-only/);
  assert.match(source,/href="http:\/\/127\.0\.0\.1:18090\/#server-power"/);h.open();h.elements.get('server-shutdown-text').value='SHUTDOWN';await h.submit();assert.equal(h.calls.length,0);
  h.data.canControl=true;h.run('renderServerPower(data)');assert.equal(h.elements.get('server-power-full-controls').hidden,true);assert.equal(h.elements.get('server-shutdown').disabled,false);
});
test('accepted shutdown stays disabled across an older online snapshot and new boot clears it',async()=>{
  const h=harness({serverPower:{phase:'online',canShutdown:true},pi:{bootId:'boot-a'}});h.open();h.elements.get('server-shutdown-text').value='SHUTDOWN';await h.submit();h.run('renderServerPower(data)');
  assert.equal(h.elements.get('server-shutdown').disabled,true);h.data.pi.bootId='boot-b';h.run('renderServerPower(data)');assert.equal(h.elements.get('server-shutdown').disabled,false);
});
test('offline and unconfirmed messages never claim it is safe to disconnect',()=>{
  const h=harness({serverPower:{phase:'offline',canShutdown:false}});assert.match(h.elements.get('server-power-note').textContent,/Check its power light/);
  h.data.serverPower={phase:'unconfirmed',canShutdown:false};h.run('renderServerPower(data)');assert.match(h.elements.get('server-power-note').textContent,/Do not unplug/);
});
test('pending then an older online response cannot re-enable a confirmed shutdown',async()=>{
  const h=harness({pi:{bootId:'boot-a'}});h.open();h.elements.get('server-shutdown-text').value='SHUTDOWN';await h.submit();
  h.data.serverPower={phase:'pending',canShutdown:false};h.run('renderServerPower(data)');h.data.serverPower={phase:'online',canShutdown:true};h.run('renderServerPower(data)');
  assert.equal(h.elements.get('server-shutdown').disabled,true);assert.equal(h.elements.get('server-power-state').textContent,'Shutdown requested');
  const reloaded=harness({serverPower:{phase:'pending',canShutdown:false},pi:{bootId:'boot-a'}});reloaded.data.serverPower={phase:'online',canShutdown:true};reloaded.run('renderServerPower(data)');assert.equal(reloaded.elements.get('server-shutdown').disabled,true);
});
test('rapid confirmation and cancel cannot duplicate a pending command',async()=>{
  const h=harness();let finish;h.setReply(()=>new Promise(resolve=>{finish=resolve}));h.open();h.elements.get('server-shutdown-text').value='SHUTDOWN';const first=h.submit();await h.submit();
  let prevented=false;h.elements.get('server-shutdown-confirm').listeners.cancel({preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(h.calls.length,1);
  finish({accepted:true,serverPower:{phase:'pending',canShutdown:false,bootId:'boot-a'}});await first;assert.equal(h.elements.get('server-shutdown-confirm').open,false);
});
