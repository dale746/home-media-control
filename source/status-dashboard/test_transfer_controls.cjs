const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'dist/index.html'),'utf8');
const viewSource=html.slice(html.indexOf('function transferView('),html.indexOf('function serverView('));
const controls=fs.readFileSync(path.join(__dirname,'dist/controls.js'),'utf8');
const source=controls.split('/* Transfer controls use')[1].split('/* Server power controls:')[0];
function harness(overrides={}){
  const elements=new Map(),calls=[];let reply;
  const card={};
  class Element{
    constructor(){this.disabled=false;this.hidden=false;this.textContent=''}
    set id(value){this._id=value;elements.set(value,this)}get id(){return this._id}
    set innerHTML(value){this.html=value;for(const m of value.matchAll(/\bid="([^"]+)"/g))if(!elements.has(m[1])){const e=new Element();e.id=m[1]}}
    before(){}closest(){return card}
  }
  new Element().id='copy-title';
  const data={canControl:true,controls:{state:{copyPaused:false,updated:1}},copy:{active:false,waitingTransfers:0},pi:{reachable:true,drive:{available:true}},status:'Running',download:{error:null},...overrides};
  const document={getElementById:id=>elements.get(id)||null,createElement:()=>new Element()};
  const context=vm.createContext({data,document,actionBusy:false,action:async body=>{calls.push(JSON.parse(JSON.stringify(body)));return reply?reply(body):{copyPaused:body.operation==='pause',controlUpdatedAt:100}}});
  vm.runInContext(viewSource+'\n/* Transfer controls use'+source,context);vm.runInContext('renderTransferControls(data)',context);
  return {context,data,calls,elements,run:code=>vm.runInContext(code,context),setReply:fn=>{reply=fn},start:()=>elements.get('transfer-start').onclick(),stop:()=>elements.get('transfer-stop').onclick()};
}
test('Start and Stop use only existing copy resume/pause operations',async()=>{
  const h=harness();await h.stop();assert.deepEqual(h.calls,[{action:'copy',operation:'pause'}]);
  assert.equal(h.elements.get('transfer-control-state').textContent,'Stopped by you');await h.start();assert.deepEqual(h.calls[1],{action:'copy',operation:'resume'});
  assert.equal(h.elements.get('transfer-control-state').textContent,'Transfers enabled');
});
test('Stop during a transfer shows stopping until worker acknowledgment, preserving originals',async()=>{
  const h=harness({status:'Copying completed download to media server',copy:{active:true,title:'Test film'}});assert.equal(h.elements.get('transfer-start').disabled,true);
  await h.stop();assert.equal(h.elements.get('transfer-control-state').textContent,'Stopping…');assert.match(h.elements.get('transfer-control-note').textContent,/originals are kept/);
  h.data.controls.state={copyPaused:true,updated:100};h.data.status='Transfers paused while the media server catches up';h.data.copy.active=false;h.run('renderTransferControls(data)');assert.equal(h.elements.get('transfer-control-state').textContent,'Stopped by you');
});
test('old status snapshots cannot undo an accepted pause preference',async()=>{
  const h=harness();await h.stop();h.run('renderTransferControls(data)');assert.equal(h.elements.get('transfer-stop').disabled,true);
  h.data.controls.state={copyPaused:true,updated:100};h.run('renderTransferControls(data)');assert.equal(h.run('transferAccepted'),null);
});
test('pending requests disable both controls and rapid presses send only one request',async()=>{
  const h=harness();let done;h.setReply(()=>new Promise(resolve=>{done=resolve}));const stop=h.stop();assert.equal(h.elements.get('transfer-start').disabled,true);assert.equal(h.elements.get('transfer-stop').disabled,true);await h.start();assert.equal(h.calls.length,1);
  done({copyPaused:true,controlUpdatedAt:100});await stop;assert.equal(h.elements.get('transfer-start').disabled,false);
});
test('failed control request never claims that copying has stopped',async()=>{
  const h=harness({copy:{active:true},status:'Copying completed download to media server'});h.setReply(()=>undefined);await h.stop();assert.equal(h.elements.get('transfer-control-state').textContent,'Transferring');assert.equal(h.elements.get('transfer-stop').disabled,false);
});
test('read-only portal keeps visible disabled controls and never sends actions',async()=>{
  const h=harness({canControl:false});await h.start();await h.stop();assert.equal(h.calls.length,0);assert.equal(h.elements.get('transfer-start').disabled,true);assert.equal(h.elements.get('transfer-stop').disabled,true);assert.equal(h.elements.get('transfer-control-state').textContent,'View only');assert.equal(h.elements.get('transfer-open-controls').hidden,false);
});
test('unavailable computer downloader is shown instead of an empty ready queue',()=>{
  const h=harness({download:{error:'URLError'},status:'Connection unavailable; retrying safely'});assert.equal(h.elements.get('transfer-control-state').textContent,'Downloader unavailable');assert.match(h.elements.get('transfer-control-note').textContent,/Start the computer downloader/);
});
test('Start does not override storage, load, playback, maintenance or separate holds',async()=>{
  const cases=[
    [{pi:{reachable:true,drive:{available:false}}},'Unavailable'],
    [{status:'Transfers paused while the media server catches up'},'Server catching up'],
    [{copy:{active:false,pauseWhilePlaying:true},sessions:[{paused:false}]},'Paused for viewing'],
    [{maintenance:{message:'Maintenance test hold'}},'Maintenance'],
    [{pauseReason:'Separate maintenance hold'},'Transfer hold']
  ];
  for(const [fields,label] of cases){const h=harness(fields);await h.start();assert.equal(h.elements.get('transfer-control-state').textContent,label);assert.deepEqual(h.calls,[{action:'copy',operation:'resume'}]);}
});
