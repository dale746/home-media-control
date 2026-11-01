const test = require('node:test');
const assert = require('node:assert/strict');
const {youtubeId,remoteAction,commandAction,trailerError,createLifecycle,seekTarget,createOwnedKeys} = require('./tv-couch.js');

function clock() {
  let next = 0;
  const pending = new Map(), changes = [];
  const lifecycle = createLifecycle({timeoutMs:100,setTimeout:fn => {pending.set(++next,fn);return next;},clearTimeout:id => pending.delete(id),onChange:state => changes.push(state)});
  return {lifecycle,pending,changes,expire() { const work = [...pending.values()]; pending.clear(); work.forEach(fn => fn()); }};
}
test('supported YouTube URLs resolve only to a validated video ID',() => {
  for (const value of ['https://www.youtube.com/watch?v=LY19rHKAaAg&feature=share','https://youtu.be/LY19rHKAaAg?t=12','https://www.youtube-nocookie.com/embed/LY19rHKAaAg','plugin://plugin.video.youtube/play/?video_id=LY19rHKAaAg']) assert.equal(youtubeId(value),'LY19rHKAaAg');
  for (const value of ['https://youtube.com.evil.test/watch?v=LY19rHKAaAg','https://secret@youtube.com/watch?v=LY19rHKAaAg','javascript:alert(1)','https://youtube.com/results?search_query=trailer','https://youtu.be/invalid']) assert.equal(youtubeId(value),null);
});
test('Back and Select normalize the supported remote event variants',() => {
  for (const key of ['Back','Escape','BrowserBack','GoBack','Backspace']) assert.equal(remoteAction({key}),'back');
  for (const keyCode of [27,461,10009]) assert.equal(remoteAction({key:'Unidentified',keyCode}),'back');
  for (const key of ['Enter','Select']) assert.equal(remoteAction({key}),'select');
  for (const keyCode of [13,23]) assert.equal(remoteAction({key:'Unidentified',keyCode}),'select');
});
test('supported playback keys are distinct from directional focus movement',() => {
  for (const [key,wanted] of Object.entries({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',MediaPlayPause:'toggle',MediaPlay:'play',MediaPause:'pause',MediaStop:'stop',MediaFastForward:'forward',MediaRewind:'rewind'})) assert.equal(remoteAction({key}),wanted);
  for (const [keyCode,wanted] of [[179,'toggle'],[10252,'toggle'],[415,'play'],[19,'pause'],[413,'stop'],[417,'forward'],[412,'rewind']]) assert.equal(remoteAction({key:'Unidentified',keyCode}),wanted);
  assert.equal(remoteAction({key:'x'}),null);
});
test('Back during metadata resolution cancels the deadline and rejects late work',() => {
  const c = clock(), token = c.lifecycle.begin(); assert.equal(c.pending.size,1);
  c.lifecycle.close(); assert.equal(c.pending.size,0); assert.equal(c.lifecycle.getState().phase,'closed');
  assert.equal(c.lifecycle.update(token,'loading'),false); assert.equal(c.lifecycle.active(token),false); c.expire(); assert.equal(c.lifecycle.getState().phase,'closed');
});
test('Back during loading, buffering or playback invalidates late player events',() => {
  for (const phase of ['loading','buffering','playing','paused']) {
    const c = clock(), token = c.lifecycle.begin(); c.lifecycle.update(token,phase); c.lifecycle.close();
    for (const late of ['playing','error','ended']) assert.equal(c.lifecycle.update(token,late),false);
    assert.equal(c.lifecycle.getState().phase,'closed');
  }
});
test('every pending phase has a bounded deadline and a usable error instead of an endless spinner',() => {
  for (const phase of ['resolving','loading','buffering']) {
    const c = clock(), token = c.lifecycle.begin(); c.lifecycle.update(token,phase); c.expire();
    assert.equal(c.lifecycle.getState().phase,'error'); assert.match(c.lifecycle.getState().error,/go back or try again/i); assert.equal(c.pending.size,0);
  }
});
test('an error or timeout is terminal and a delayed success cannot reopen playback',() => {
  const c = clock(), token = c.lifecycle.begin(); c.expire();
  assert.equal(c.lifecycle.active(token),false); assert.equal(c.lifecycle.update(token,'playing'),false); assert.equal(c.lifecycle.getState().phase,'error');
});
test('explicit retry starts a new generation without accepting the old result',() => {
  const c = clock(), first = c.lifecycle.begin(); c.expire(); const second = c.lifecycle.begin();
  assert.notEqual(first,second); assert.equal(c.lifecycle.update(first,'playing'),false); assert.equal(c.lifecycle.update(second,'playing'),true); assert.equal(c.pending.size,0);
});
test('a rapid series of sessions keeps only the current deadline and current events',() => {
  const c = clock(), tokens = Array.from({length:25},() => c.lifecycle.begin());
  assert.equal(c.pending.size,1); for (const token of tokens.slice(0,-1)) assert.equal(c.lifecycle.update(token,'playing'),false);
  assert.equal(c.lifecycle.update(tokens.at(-1),'playing'),true); assert.equal(c.pending.size,0);
});
test('playing, paused and finished trailers have no unnecessary watchdog timer',() => {
  for (const phase of ['ready','playing','paused','ended']) {
    const c = clock(), token = c.lifecycle.begin(); assert.equal(c.lifecycle.update(token,phase),true); assert.equal(c.pending.size,0);
    c.expire(); assert.equal(c.lifecycle.getState().phase,phase);
  }
});
test('state snapshots cannot mutate the active lifecycle',() => {
  const c = clock(); c.lifecycle.begin(); const state = c.lifecycle.getState(); state.phase = 'playing'; assert.equal(c.lifecycle.getState().phase,'resolving');
});
test('unavailable and blocked trailer errors give a Back recovery path',() => {
  for (const code of [100,101,150,153,2,5]) assert.match(trailerError(code),/go back/i);
  assert.match(trailerError(153),/verify this player/i);
});
test('seek uses finite bounded positions and respects known duration',() => {
  assert.equal(seekTarget(3,-10,100),0); assert.equal(seekTarget(95,10,100),100); assert.equal(seekTarget(NaN,10,NaN),10); assert.equal(seekTarget(30,-10,100),20);
});
test('owned keyup remains consumed after a dialog closes, but unrelated releases remain native',()=>{
  const keys=createOwnedKeys();keys.own({key:'Escape',keyCode:27});
  assert.equal(keys.take({key:'ArrowLeft',keyCode:37}),false);
  assert.equal(keys.take({key:'Escape',keyCode:27}),true);
  assert.equal(keys.take({key:'Escape',keyCode:27}),false);
  assert.equal(keys.size,0);
});
test('key repeats own one release and blur/pagehide cleanup releases all ownership',()=>{
  const keys=createOwnedKeys();for(let i=0;i<20;i++)keys.own({key:'Back',keyCode:461});assert.equal(keys.size,1);
  assert.equal(keys.take({key:'Back',keyCode:461}),true);assert.equal(keys.size,0);
  keys.own({key:'Enter',code:'Enter'});keys.clear();assert.equal(keys.take({key:'Enter',code:'Enter'}),false);
});
test('emitted native command names map to the same trailer navigation and playback actions',()=>{
  for(const [value,wanted] of Object.entries({left:'left',right:'right',up:'up',down:'down',select:'select',back:'back',playpause:'toggle',play:'play',pause:'pause',stop:'stop',rewind:'rewind',fastforward:'forward'}))assert.equal(commandAction(value),wanted);
  assert.equal(commandAction('Back'),'back');assert.equal(commandAction('unknown'),null);assert.equal(commandAction({command:'back'}),null);
});
