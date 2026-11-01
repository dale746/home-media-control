const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const links=JSON.parse(fs.readFileSync(path.join(__dirname,'extra-links.json'),'utf8'));
const family=links.find(link=>link.label==='Family Memories');
test('Family Memories opens the supported native list rather than the failing homevideos page',()=>{
  assert.ok(family,'Family Memories must remain available in More links');
  const route=new URL(family.href,'http://media.local/web/');
  assert.equal(route.hash.split('?')[0],'#/list');
  assert.equal(route.origin,'http://media.local');
  assert.equal(route.pathname,'/web/');
});
test('the family video listing is scoped to its existing library and server',()=>{
  const query=new URLSearchParams(family.href.split('?')[1]);
  assert.equal(query.get('parentId'),family.libraryId);
  assert.equal(query.get('parentId'),'00000000000000000000000000000005');
  assert.equal(query.get('type'),'Video','native list uses type to recurse through family folders');
  assert.equal(query.get('serverId'),'00000000000000000000000000000003');
  assert.equal(query.has('tab'),false,'the fallback must not depend on unsupported home-video tabs');
  for(const name of ['parentId','type','serverId'])assert.equal(query.getAll(name).length,1);
});
