const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {enabled,isBlockedControl,recoverFocus,css} = require('./tv-playback-controls.js');

test('simplifier requires explicit TV layout and a native player route', () => {
  for (const hash of ['#/video','#!/video?id=abc','#/videoosd','#/player?x=1']) assert.equal(enabled('layout-tv extra',hash),true);
  for (const classes of ['layout-mobile','layout-desktop','','almost-layout-tv']) assert.equal(enabled(classes,'#/video'),false);
  for (const hash of ['#/details?id=abc','#/movies','#/videographer','#/videoerror','']) assert.equal(enabled('layout-tv',hash),false);
});

test('only the five exact unwanted playback controls are targeted', () => {
  for (const id of ['enhancedSettingsBtn','jeBookmarkBtn']) assert.equal(isBlockedControl({id}),true);
  for (const className of ['btnUserRating','btnFullscreen hide autoSize','btnPip']) assert.equal(isBlockedControl({className}),true);
  for (const className of ['btnVideoOsdSettings','btnSubtitles','btnAudio','btnPause','btnRewind','btnFastForward','btnMoreCommands','notbtnFullscreen']) assert.equal(isBlockedControl({className}),false);
  assert.equal(isBlockedControl({id:'otherEnhancedSettingsBtn'}),false);
  assert.equal(css.split(',').length,5);
  for (const selector of css.replace('{display:none!important}','').split(',')) assert.match(selector,/^html\.layout-tv\[data-hmc-tv-playback-simple="1"\] #videoOsdPage /);
});

test('focus recovery ignores unfocused, ordinary, mobile and desktop controls', () => {
  let changes = 0;
  const focused = {blur:() => changes++}, pause = {focus:() => changes++};
  const options = {enabled:true,focused,blocked:{},pause,canFocus:() => true};
  for (const override of [{enabled:false},{focused:null},{blocked:null}]) assert.equal(recoverFocus({...options,...override}),false);
  assert.equal(changes,0);
});

test('focused hidden extra moves once to visible native Play/Pause without scrolling', () => {
  let active, calls = 0;
  const focused = {blur:() => assert.fail('Visible native Play/Pause should own focus')};
  const pause = {focus:options => { assert.equal(options.preventScroll,true); calls++; active=pause; }};
  active=focused;
  assert.equal(recoverFocus({enabled:true,focused,blocked:{},pause,canFocus:() => true,current:() => active}),true);
  assert.equal(active,pause);assert.equal(calls,1);
  assert.equal(recoverFocus({enabled:true,focused:active,blocked:null,pause,canFocus:() => true}),false);
  assert.equal(calls,1);
});

test('hidden OSD blurs unwanted focus without showing controls or changing playback', () => {
  let blurred = 0, focused = 0;
  recoverFocus({enabled:true,focused:{blur:() => blurred++},blocked:{},pause:{focus:() => focused++},canFocus:() => false});
  assert.equal(blurred,1);assert.equal(focused,0);
});

test('a failed native focus attempt cannot leave focus trapped on the hidden extra', () => {
  let blurred = 0;
  const focused = {blur:() => blurred++};
  recoverFocus({enabled:true,focused,blocked:{},pause:{focus:() => {}},canFocus:() => true,current:() => focused});
  assert.equal(blurred,1);
});

function harness() {
  const source = fs.readFileSync(path.join(__dirname,'tv-playback-controls.js'),'utf8');
  const events={}, callbacks=[], observers=[];
  const root={className:'layout-mobile',dataset:{}};
  const body={}, head={appendChild:node => {h.style=node;}};
  const h={style:null,queries:0,root,events,observers,flush:() => {while(callbacks.length)callbacks.shift()();}};
  const document={documentElement:root,body,head,activeElement:null,
    createElement:tag => ({tagName:tag.toUpperCase()}),
    addEventListener:(type,fn) => {events[type]=fn;},
    querySelector:selector => {h.queries++;return h.pause;}};
  const window={addEventListener:(type,fn) => {events[type]=fn;},requestAnimationFrame:fn => callbacks.push(fn)};
  function MutationObserver(callback) {this.callback=callback;this.observe=(target,options) => observers.push({target,options,callback});}
  const context={document,window,location:{hash:'#/video'},MutationObserver,setTimeout,
    getComputedStyle:node => node.computed || {display:'block',visibility:'visible',opacity:'1'}};
  h.context=context;h.document=document;
  vm.runInNewContext(source,context);
  return h;
}

test('late plugin insertion remains CSS-hidden without removing nodes or stealing ordinary focus', () => {
  const h=harness();h.root.className='layout-tv';
  let removed=0, focusChanges=0;
  const extra={id:'enhancedSettingsBtn',className:'',closest:selector => selector==='#videoOsdPage'?{}:null,remove:() => removed++};
  const focused={closest:() => extra,blur:() => {h.document.activeElement=null;}};
  h.pause={isConnected:true,disabled:false,parentElement:null,classList:{contains:() => false},getAttribute:() => null,getClientRects:() => [{}],focus:() => {focusChanges++;h.document.activeElement=h.pause;},closest:() => null};
  h.document.activeElement=focused;
  for(const observer of h.observers)observer.callback([{type:'childList',addedNodes:[extra]}]);
  h.flush();
  assert.equal(h.root.dataset.hmcTvPlaybackSimple,'1');
  assert.equal(h.document.activeElement,h.pause);assert.equal(focusChanges,1);assert.equal(removed,0);
  for(const observer of h.observers)observer.callback([{type:'childList',addedNodes:[{}]}]);
  h.flush();assert.equal(focusChanges,1);
  assert.match(h.style.textContent,/#enhancedSettingsBtn/);
});

test('TV-to-mobile and leaving playback remove the CSS flag without changing native controls', () => {
  const h=harness();h.root.className='layout-tv';h.events.hashchange();h.flush();
  assert.equal(h.root.dataset.hmcTvPlaybackSimple,'1');
  h.root.className='layout-mobile';h.events.popstate();h.flush();
  assert.equal(h.root.dataset.hmcTvPlaybackSimple,undefined);
  h.root.className='layout-tv';h.context.location.hash='#/details?id=abc';h.events.hashchange();h.flush();
  assert.equal(h.root.dataset.hmcTvPlaybackSimple,undefined);assert.equal(h.queries,0);
});

test('hidden parent and native OSD auto-hide prevent focus recovery from reopening controls', () => {
  for(const hiddenType of ['videoOsdBottom-hidden','hide','hidden','aria-hidden','opacity']) {
    const h=harness();h.root.className='layout-tv';let blurs=0,focusCalls=0;
    const extra={id:'jeBookmarkBtn',closest:selector => selector==='#videoOsdPage'?{}:null};
    h.document.activeElement={closest:() => extra,blur:() => {blurs++;h.document.activeElement=null;}};
    const parent={parentElement:null,hidden:hiddenType==='hidden',classList:{contains:value => value===hiddenType},getAttribute:name => name==='aria-hidden'&&hiddenType==='aria-hidden'?'true':null,
      computed:{display:'block',visibility:'visible',opacity:hiddenType==='opacity'?'0':'1'}};
    h.pause={isConnected:true,parentElement:parent,classList:{contains:() => false},getAttribute:() => null,getClientRects:() => [{}],focus:() => focusCalls++};
    h.events.hashchange();h.flush();assert.equal(blurs,1);assert.equal(focusCalls,0);
  }
});
