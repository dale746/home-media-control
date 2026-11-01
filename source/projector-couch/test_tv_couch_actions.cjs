const test = require('node:test');
const assert = require('node:assert/strict');
const {enabled,isPrimary,actionLabel,backKey,commandAction,horizontalKeyTarget,createOwnedKeys,ownedService,tvServiceUrl} = require('./tv-couch-actions.js');

test('Search Left chooses the same visual row over an earlier DOM row at the same column',()=>{
  const current={x:986,y:268,width:52,height:52};
  const earlier={x:928,y:210,width:52,height:52,value:'L'};
  const sameRow={x:928,y:268,width:52,height:52,value:'Z'};
  assert.equal(horizontalKeyTarget(current,[earlier,sameRow],'left'),sameRow);
  assert.equal(horizontalKeyTarget(sameRow,[earlier,current],'right'),current);
});

test('Search horizontal row edges remain stable and hidden keys cannot win',()=>{
  const current={x:100,y:200,width:52,height:52};
  assert.equal(horizontalKeyTarget(current,[{x:42,y:140,width:52,height:52}],'left'),null);
  assert.equal(horizontalKeyTarget(current,[{x:42,y:200,width:0,height:52}],'left'),null);
});
test('simplified actions require explicit TV layout and exclude native player routes',()=>{
  assert.equal(enabled('layout-tv hmc-nav-ready','#/details?id=abc'),true);
  for(const classes of ['layout-mobile','layout-desktop','','almost-layout-tv']) assert.equal(enabled(classes,'#/details?id=abc'),false);
  for(const hash of ['#/video','#!/video?id=abc','#/videoosd','#/player?foo=bar']) assert.equal(enabled('layout-tv',hash),false);
});
test('primary detail actions preserve native Play/Resume, Trailer, heart and More',()=>{
  for(const value of ['btnPlay detailButton','btnResume','btnPlay btnResume','btnPlayTrailer','btnUserRating','btnMoreCommands'])assert.equal(isPrimary(value),true);
  for(const value of ['btnPlaystate','btnDownload','media-discovery-button','btnReplay','btnPlay btnReplay'])assert.equal(isPrimary(value),false);
});
test('secondary actions have readable state-dependent labels',()=>{
  assert.equal(actionLabel({className:'btnUserRating',isFavorite:false}),'Add to favourites');
  assert.equal(actionLabel({className:'btnUserRating',isFavorite:true}),'Remove from favourites');
  assert.equal(actionLabel({className:'btnPlaystate',isPlayed:false}),'Mark as watched');
  assert.equal(actionLabel({className:'btnPlaystate',isPlayed:true}),'Mark as unwatched');
  assert.equal(actionLabel({className:'media-discovery-button'}),'Find in Discovery');
  assert.equal(actionLabel({className:'btnReplay'}),'Play from start');
  assert.equal(actionLabel({className:'custom',ariaLabel:'Subtitles',title:'Other'}),'Subtitles');
});
test('action-menu Back covers named and vendor variants',()=>{
  for(const key of ['Escape','Back','BrowserBack','GoBack','Backspace'])assert.equal(backKey({key}),true);
  for(const keyCode of [27,461,10009])assert.equal(backKey({key:'Unidentified',keyCode}),true);
  assert.equal(backKey({key:'ArrowRight',keyCode:39}),false);
});
test('menu close retains ownership of only its consumed key release',()=>{
  const keys=createOwnedKeys();keys.own({key:'Unidentified',keyCode:10009});
  assert.equal(keys.take({key:'Enter',keyCode:13}),false);
  assert.equal(keys.take({key:'Unidentified',keyCode:10009}),true);
  assert.equal(keys.take({key:'Unidentified',keyCode:10009}),false);
  keys.own({key:'Select'});keys.clear();assert.equal(keys.take({key:'Select'}),false);
});
const local={discovery:'http://media-discover.local/',status:'http://192.0.2.10/status/'};
test('TV service handoff accepts only exact owned Discovery and Status pages',()=>{
  for(const value of ['http://media-discover.local/','http://media-discover.local/movie/123','http://media-discover.local/tv/45','http://media-discover.local/discover/trending','http://media-discover.local/login'])assert.equal(ownedService(value,local),'discovery');
  for(const value of ['http://192.0.2.10/status/','http://192.0.2.10/status/#downloads'])assert.equal(ownedService(value,local),'status');
  for(const value of ['http://media-discover.local.evil.test/movie/1','http://secret@media-discover.local/movie/1','http://media-discover.local:5055/movie/1','http://media-discover.local/api/v1/settings','http://192.0.2.10/status/api/action','http://192.0.2.10:8096/web/#/home','https://www.youtube.com/watch?v=LY19rHKAaAg','javascript:alert(1)'])assert.equal(ownedService(value,local),null);
});
test('TV flag is added only to owned services and preserves existing return context',()=>{
  const raw='http://media-discover.local/movie/123?hmcReturn=http%3A%2F%2Fmedia-movies.local%2Fweb%2F%23%2Fhome';
  const url=new URL(tvServiceUrl(raw,local));assert.equal(url.searchParams.get('tv'),'1');assert.equal(url.searchParams.get('hmcReturn'),'http://media-movies.local/web/#/home');
  assert.equal(new URL(tvServiceUrl('http://192.0.2.10/status/?tv=0#downloads',local)).hash,'#downloads');
  assert.equal(new URL(tvServiceUrl('http://192.0.2.10/status/?tv=0#downloads',local)).searchParams.get('tv'),'1');
  assert.equal(tvServiceUrl('http://192.0.2.10:8096/web/#/home',local),null);
});
test('remote service validation keeps exact configured ports separate',()=>{
  const remote={discovery:'https://movies.example.ts.net:8443/',status:'https://movies.example.ts.net:9443/status/'};
  assert.equal(ownedService('https://movies.example.ts.net:8443/movie/12',remote),'discovery');
  assert.equal(ownedService('https://movies.example.ts.net:9443/status/#downloads',remote),'status');
  assert.equal(ownedService('https://movies.example.ts.net/movie/12',remote),null);
  assert.equal(ownedService('https://movies.example.ts.net:8443/status/',remote),null);
});
test('emitted navigation commands map to existing More actions without taking over playback',()=>{
  for(const [value,wanted]of Object.entries({left:'back',right:'next',up:'previous',down:'next',select:'select',back:'back'}))assert.equal(commandAction(value),wanted);
  for(const value of ['play','pause','playpause','unknown'])assert.equal(commandAction(value),null);
});
