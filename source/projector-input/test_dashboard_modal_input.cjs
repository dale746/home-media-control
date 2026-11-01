const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.resolve(__dirname,'../status-dashboard/dist/projector-input.js');
const source=fs.readFileSync(file,'utf8');
const {televisionUserAgent,removeLast}=require(file);
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
function input(readOnly=false,mode=null){
  const attributes=new Map([['aria-description','Original help']]);if(mode!==null)attributes.set('inputmode',mode);
  return {readOnly,disabled:false,dataset:{},getAttribute:key=>attributes.get(key)??null,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
}
test('TV bridge leaves physical typing enabled and repeated preparation preserves native attributes',()=>{
  const writable=input(),locked=input(true),context={handles:()=>true,editable:()=>true,navigator:{userAgent:'Windows Chrome'},televisionUserAgent,inputDescriptions:new WeakMap(),inputModes:new WeakMap(),document:{querySelectorAll:()=>[writable,locked]}};
  vm.createContext(context);vm.runInContext(section('  function prepareInputs()', '  function releaseControls()'),context);
  context.prepareInputs();context.prepareInputs();assert.equal(writable.readOnly,false);assert.equal(writable.dataset.hmcProjectorEditable,'1');assert.equal(locked.dataset.hmcProjectorEditable,undefined);
  context.document.querySelectorAll=()=>[writable];context.restoreInputs();assert.equal(writable.getAttribute('aria-description'),'Original help');assert.equal(writable.getAttribute('inputmode'),null);assert.equal(locked.readOnly,true);
});
test('projector native keyboard suppression is restored without changing readonly ownership',()=>{
  const writable=input(false,'text'),context={handles:()=>true,editable:()=>true,navigator:{userAgent:'Hisense VIDAA'},televisionUserAgent,inputDescriptions:new WeakMap(),inputModes:new WeakMap(),document:{querySelectorAll:()=>[writable]}};
  vm.createContext(context);vm.runInContext(section('  function prepareInputs()', '  function releaseControls()'),context);context.prepareInputs();assert.equal(writable.getAttribute('inputmode'),'none');assert.equal(writable.readOnly,false);
  context.restoreInputs();assert.equal(writable.getAttribute('inputmode'),'text');assert.equal(writable.readOnly,false);
});
function modalHarness(owner){
  const document={body:{children:[],appendChild(el){this.children.push(el);el.parent=this}},createElement:()=>({children:[],setAttribute(){},appendChild(el){this.children.push(el);el.parent=this},remove(){this.removed=true}})};
  let focusCalls=0,refreshes=0;
  const target={isConnected:true,closest:()=>owner};
  const context={document,overlay:null,edit:{target},overlayParent:null,overlayParentClose:null,focus:el=>{assert.equal(el,target);focusCalls++},initialFocus(){},clearFocus(){},scheduleRefresh(){refreshes++}};
  vm.createContext(context);vm.runInContext(section('  function modal(', '  function targetForEdit()'),context);
  return {context,document,get focusCalls(){return focusCalls},get refreshes(){return refreshes}};
}
function nativeOwner(){return {children:[],handlers:{},appendChild(el){this.children.push(el);el.parent=this},addEventListener(name,handler){this.handlers[name]=handler},removeEventListener(name,handler){if(this.handlers[name]===handler)delete this.handlers[name]}}}
test('remote keyboard is inside the native dialog top layer instead of inert body',()=>{
  const owner=nativeOwner(),h=modalHarness(owner);h.context.modal('Shutdown');assert.equal(h.context.overlay.parent,owner);assert.equal(h.document.body.children.length,0);
  h.context.closeModal();assert.equal(h.context.overlay,null);assert.equal(owner.handlers.close,undefined);assert.equal(h.focusCalls,1);
});
test('closing a parent native dialog removes its keyboard without refocusing a hidden input',()=>{
  const owner=nativeOwner(),h=modalHarness(owner);h.context.modal('Shutdown');const root=h.context.overlay;owner.handlers.close();
  assert.equal(root.removed,true);assert.equal(h.context.overlay,null);assert.equal(h.context.edit,null);assert.equal(h.focusCalls,0);assert.equal(h.refreshes,1);
});
test('ordinary page keyboard remains attached to body',()=>{
  const h=modalHarness(null);h.context.modal('Search');assert.equal(h.context.overlay.parent,h.document.body);assert.equal(h.context.overlayParent,null);
});
test('hardware typing and Backspace update the open keyboard buffer; modifiers remain native',()=>{
  let redraw=0,prevented=0;
  const context={overlay:{},edit:{buffer:'',maximum:8,redraw(){redraw++}},removeLast};vm.createContext(context);vm.runInContext(section('  function typeOnKeyboard(', '  function handleBack('),context);
  const event=key=>({key,preventDefault(){prevented++},stopImmediatePropagation(){}});
  for(const key of 'SHUTDOWN')assert.equal(context.typeOnKeyboard(event(key)),true);
  assert.equal(context.edit.buffer,'SHUTDOWN');context.typeOnKeyboard(event('x'));assert.equal(context.edit.buffer,'SHUTDOWN');context.typeOnKeyboard(event('Backspace'));assert.equal(context.edit.buffer,'SHUTDOW');
  assert.equal(context.typeOnKeyboard({...event('c'),ctrlKey:true}),false);assert.equal(context.typeOnKeyboard(event('Enter')),false);assert.equal(prevented,10);assert.equal(redraw,10);
});
test('Back closes keyboard first then dispatches a cancelable native-dialog close',()=>{
  let closed=0,cancelled=0,keyboardClosed=0;
  const owner={tagName:'DIALOG',open:true,dispatchEvent(event){cancelled++;assert.equal(event.type,'cancel');assert.equal(event.cancelable,true);return true},close(){closed++}};
  const context={overlay:{},document:{},scope:()=>owner,closeModal(){keyboardClosed++;context.overlay=null},Event};vm.createContext(context);vm.runInContext(section('  function handleBack(', '  function scheduleRefresh('),context);
  const event=()=>({preventDefault(){},stopImmediatePropagation(){}});context.handleBack(event());assert.equal(keyboardClosed,1);assert.equal(closed,0);context.handleBack(event());assert.equal(cancelled,1);assert.equal(closed,1);
  owner.dispatchEvent=()=>false;context.handleBack(event());assert.equal(closed,1,'Busy dialog may prevent cancellation');
  owner.requestClose=()=>{closed++};context.handleBack(event());assert.equal(closed,2);
});
test('desktop pointer clicks keep native text entry; remote Select and TV clicks can open keyboard',()=>{
  let listener,opened=0,prevented=0;
  const field={dataset:{hmcProjectorEditable:'1'}};
  const context={document:{addEventListener:(name,handler)=>{assert.equal(name,'click');listener=handler}},handles:()=>true,overlay:null,navigator:{userAgent:'Windows Chrome'},editable:el=>el===field,televisionUserAgent,openKeyboard(){opened++}};
  vm.createContext(context);vm.runInContext(section("    document.addEventListener('click'", "    document.addEventListener('focusin'"),context);
  const event=detail=>({detail,target:{closest:()=>field},preventDefault(){prevented++},stopImmediatePropagation(){}});
  listener(event(1));assert.equal(opened,0);assert.equal(prevented,0);listener(event(0));assert.equal(opened,1);context.navigator.userAgent='Hisense VIDAA';listener(event(1));assert.equal(opened,2);
});
test('TV remote UI can toggle off while existing enable-only events stay compatible',()=>{
  const attributes=new Map(),toggle={setAttribute:(key,value)=>attributes.set(key,value)};let handler,installed=0,released=0;
  const context={enabled:false,localStorage:{setItem(){}},storageKey:'fixture',document:{documentElement:{dataset:{}},getElementById:()=>toggle,addEventListener:(name,fn)=>{handler=fn}},window:{},install(){installed++},scheduleRefresh(){},releaseControls(){released++}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function setEnabled('),source.lastIndexOf('}());')),context);
  handler({detail:{toggle:true}});assert.equal(attributes.get('aria-pressed'),'true');assert.equal(toggle.title,'Disable directional remote controls');handler({detail:{toggle:true}});assert.equal(attributes.get('aria-pressed'),'false');assert.equal(toggle.title,'Enable directional remote controls');assert.equal(released,1);
  handler({});handler({});assert.equal(context.enabled,true);assert.equal(installed,3);
});
