/* Controls are available from the main computer's local dashboard. */
let controlToken=null, controlsBuilt=false, settingsLoaded=false;
let settingsDirty=false, actionBusy=false, toastTimer;
let settingsSignature='';
let initialSectionPending=true;
function showInitialSection(){
  if(!initialSectionPending)return;
  const target=document.getElementById((location.hash||'#overview').slice(1));
  if(!target)return;
  initialSectionPending=false;
  requestAnimationFrame(()=>target.scrollIntoView({block:'start',behavior:'instant'}));
}
function updateNavigation(){
  document.querySelectorAll('.nav a').forEach(link=>link.classList.toggle('selected',link.getAttribute('href')===(location.hash||'#overview')));
}
window.addEventListener('hashchange',updateNavigation);

function tell(message,error=false){
  let node=document.getElementById('action-message');
  if(!node){node=document.createElement('div');node.id='action-message';node.setAttribute('role','status');document.body.append(node)}
  node.className='action-message'+(error?' error':'');node.textContent=message;node.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,9000);
}
async function action(body){
  if(actionBusy)return;
  actionBusy=true;
  try{
    if(!controlToken){
      let response=await fetch('api/control-token',{cache:'no-store'});
      if(!response.ok)throw Error('Use the desktop shortcut on the main computer to change settings.');
      controlToken=(await response.json()).token;
    }
    let response=await fetch('api/action',{method:'POST',headers:{'Content-Type':'application/json','X-HomeMedia-Control':controlToken},body:JSON.stringify(body)});
    let result=await response.json();
    if(!response.ok){if(response.status===403)controlToken=null;throw Error(result.message||'The action could not be applied.')}
    tell(result.message);await refresh();return result;
  }catch(error){tell(error.message,true)}finally{actionBusy=false}
}
function field(title,body,note=''){
  return `<label class="control-field">${title}${body}${note?`<small>${note}</small>`:''}</label>`;
}
function numberField(name,title,min,max,step='1',note=''){
  return field(title,`<input id="setting-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" required>`,note);
}
function choice(name,title,options,note=''){
  return field(title,`<select id="setting-${name}" name="${name}">${options.map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select>`,note);
}
function checkbox(name,title){return `<label><input type="checkbox" id="setting-${name}" name="${name}">${title}</label>`}
function createControls(){
  if(controlsBuilt||!document.querySelector('.stats'))return;
  controlsBuilt=true;
  let panel=document.createElement('section');panel.className='card control-panel';panel.id='controls';
  panel.innerHTML=`
    <div class="section-title"><h2>Download controls</h2><span class="control-badge" id="pi-settings-state"></span></div>
    <div id="control-lock" class="control-lock" hidden>Use the <strong>HomeMedia Server Status</strong> desktop shortcut on the main computer to change settings.</div>
    <div id="control-edit">
      <div class="control-buttons"><button class="button" id="toggle-pc"></button><button class="button" id="toggle-pi"></button><button class="button" id="toggle-copy"></button><button class="button" id="toggle-bulk"></button></div>
      <details class="control-destinations"><summary>Choose download machines, location and limits</summary>
        <form id="settings-form"><div class="control-settings">
          ${choice('bulkDestination','Bulk downloads go to',[['computer','Computer'],['pi','i7 media server']],'Changes apply to new downloads.')}
          ${choice('manualDestination','Discovery requests go to',[['pi','i7 media server'],['computer','Computer']])}
          ${choice('drive','New computer downloads saved to',[])}
          ${numberField('pcMax','Computer: downloads at once',1,500)}
          ${numberField('piMax','server: downloads at once',1,10)}
          ${numberField('copyMbps','Copy speed limit (MB/s)',1,120,'0.1','Actual speed is shown above.')}
        </div><div class="control-checks">
          ${checkbox('fallback','Use server backup if the computer is unavailable')}
          ${checkbox('pauseWhenWatching','Pause copying while someone is watching')}
        </div>
        <details class="control-advanced"><summary>More options: speed limits and collection rules</summary>
          <div class="control-settings">
            ${numberField('pcMbps','Computer download limit (MB/s)',0,500,'0.1','0 means no download limit.')}
            ${numberField('piMbps','server download limit (MB/s)',0,100,'0.1','0 means no download limit.')}
            ${numberField('score','Minimum Rotten Tomatoes critic score',0,100,'1','Applies to verified automatic selections.')}
          </div><div class="control-checks">
            ${checkbox('movies','Automatically select movies')}${checkbox('tv','Automatically select TV series')}${checkbox('sequels','Include sequels of qualifying movies')}
          </div>
          <p class="control-help">Horror stays excluded. Automatic TV selections use season one. Newest available titles come first.</p>
          <p class="control-help">Changing the drive affects new jobs. Personal videos and camera footage stay outside automatic cleanup. The 100 GB reserve always applies.</p>
          <p class="control-help">Pausing copying keeps finished files; the current file may restart when you resume.</p>
        </details>
        <div class="control-save"><button class="button primary" type="submit" id="save-settings">Save settings</button><small id="save-note">Existing downloads stay on their current machine.</small></div>
        </form>
      </details>
    </div>`;
  document.querySelector('.stats').after(panel);
  let nav=document.querySelector('.nav');
  for(let [href,title] of [['#controls','Controls'],['#apps','Apps']]){let link=document.createElement('a');link.href=href;link.textContent=title;nav.append(link)}
  updateNavigation();
  let th=document.createElement('th');th.textContent='Controls';document.querySelector('#downloads thead tr').append(th);
  document.getElementById('settings-form').oninput=()=>{settingsDirty=true;document.getElementById('save-note').textContent='Unsaved changes'};
  document.getElementById('settings-form').onsubmit=async event=>{
    event.preventDefault();let values={};
    for(let [key,value] of new FormData(event.target))values[key]=['pcMax','piMax','pcMbps','piMbps','copyMbps','score'].includes(key)?Number(value):value;
    for(let key of ['fallback','pauseWhenWatching','movies','tv','sequels'])values[key]=document.getElementById('setting-'+key).checked;
    let result=await action({action:'settings',settings:values});
    if(result){settingsDirty=false;loadSettings(result.settings);document.getElementById('save-note').textContent='Settings saved'}
  };
  for(let [id,machine] of [['toggle-pc','pc'],['toggle-pi','pi']])document.getElementById(id).onclick=()=>action({action:'queue',machine,operation:data.controls.state[machine+'Paused']?'resume':'pause'});
  document.getElementById('toggle-copy').onclick=()=>action({action:'copy',operation:data.controls.state.copyPaused?'resume':'pause'});
  document.getElementById('toggle-bulk').onclick=()=>action({action:'settings',settings:{bulkEnabled:!data.controls.settings.bulkEnabled}});
  document.getElementById('jobs').addEventListener('click',event=>{
    let button=event.target.closest('[data-job-operation]');
    if(button)action({action:'torrent',machine:button.dataset.machine,hash:button.dataset.hash,operation:button.dataset.jobOperation});
  });
}
function loadSettings(values){
  let drive=document.getElementById('setting-drive');
  drive.innerHTML=values.drives.map(value=>`<option value="${esc(value)}">${esc(value)}${value==='V:'?' - 12 TB video storage':''}</option>`).join('');
  for(let [key,value] of Object.entries(values)){let element=document.getElementById('setting-'+key);if(!element)continue;if(element.type==='checkbox')element.checked=Boolean(value);else element.value=value}
  settingsLoaded=true;
  settingsSignature=JSON.stringify(values);
}
function serviceTarget(d,key,fallback,currentOrigin=location.origin){
  const remote=d.remoteOrigins;
  if(!remote||currentOrigin!==remote.portalOrigin)return fallback;
  if(key==='jellyfin')return remote.movieOrigin+'/web/';
  if(key==='seerr')return remote.discoverOrigin+'/';
  return null;
}
function renderServiceLinks(d){
  let map=Object.fromEntries(d.pi?.services||[]),online=d.pi?.reachable;
  let links=[
    ['Jellyfin / all films','jellyfin','http://192.0.2.10:8096/web/'],
    ["Home Media Discovery",'seerr','http://media-discover.local/'],
    ['Movie organiser','radarr','http://media-movies.local:7878/'],
    ['TV organiser','sonarr','http://media-movies.local:8989/'],
    ['server downloader','qbittorrent','http://media-movies.local:8080/'],
    ['Computer downloader','computer','http://127.0.0.1:18080/'],
    ['Search sources','prowlarr','http://media-movies.local:9696/']
  ];
  let card=document.getElementById('services').closest('.card');card.id='apps';card.querySelector('h2').textContent='Apps & watching';card.querySelector('.section-title > div')?.remove();
  document.getElementById('services').innerHTML=links.map(([name,key,url])=>{
    const target=serviceTarget(d,key,url),homeOnly=target===null;
    let ready=key==='computer'?!d.download.error&&d.canControl:Boolean(online&&map[key]);
    let status=key==='computer'?(d.download.error?'Unavailable':d.canControl?'Running':'Open on main computer'):map[key]?'Running':online?'Waiting for drive setup':'Offline';
    if(homeOnly){ready=false;status='Home network only';}
    return `<div class="service"><span>${esc(name)}</span><span class="service-state">${status}</span>${ready?`<a class="button service-link" href="${esc(target)}" target="_blank" rel="noopener">Open &#8599;</a>`:`<span class="button service-link" aria-disabled="true">${homeOnly?'Home only':'Unavailable'}</span>`}</div>`;
  }).join('');
}
const originalRenderJobs=renderJobs;
renderJobs=function(){
  if(controlsBuilt&&!actionBusy&&document.getElementById('jobs')?.contains(document.activeElement))return;
  originalRenderJobs();if(!data||!controlsBuilt)return;
  let rows=[...document.querySelectorAll('#jobs tr')];
  let jobs=data.jobs.filter(job=>(!query||job.title.toLowerCase().includes(query))&&(filter!=='downloading'||job.speed>0)&&(filter!=='transfer'||job.progress>=1&&!job.copyDone)).slice(page*12,page*12+12);
  rows.forEach((row,index)=>{
    let job=jobs[index];if(!job){row.firstElementChild?.setAttribute('colspan','6');return}
    let cell=document.createElement('td');
    if(job.progress<1&&data.canControl){
      let prefix=`data-machine="${esc(job.machine||'pc')}" data-hash="${esc(job.hash)}"`;
      cell.innerHTML=`<div class="job-actions"><button class="button" ${prefix} data-job-operation="${job.paused?'resume':'pause'}">${job.paused?'Resume':'Pause'}</button><button class="button" ${prefix} data-job-operation="retry" title="Reconnect to existing torrent sources">Retry</button></div>`;
    }else cell.innerHTML='<span class="muted">-</span>';
    row.append(cell);let type=row.querySelector('.type');if(type)type.textContent=job.type+' - '+(job.machine==='pi'?'server':'Computer');
  });
};
const originalRender=render;
render=function(d){
  d.jobs=d.jobs||[];originalRender(d);if(d.starting||!d.controls)return;
  createControls();if(!settingsLoaded||(!settingsDirty&&settingsSignature!==JSON.stringify(d.controls.settings)))loadSettings(d.controls.settings);
  document.getElementById('control-edit').hidden=!d.canControl;document.getElementById('control-lock').hidden=d.canControl;
  document.getElementById('pi-settings-state').textContent=d.controls.piSettingsApplied?'server settings applied':d.pi?.upgrade?.phase==='complete'?'server settings pending':'server changes wait for drive setup';
  for(let [id,key,name] of [['toggle-pc','pcPaused','computer downloads'],['toggle-pi','piPaused','server downloads'],['toggle-copy','copyPaused','copying to server']]){
    let held=d.controls.state[key],button=document.getElementById(id);button.textContent=(held?'Resume ':'Pause ')+name;button.classList.toggle('held',held);
  }
  document.getElementById('toggle-bulk').textContent=(d.controls.settings.bulkEnabled?'Pause':'Resume')+' automatic requests';
  renderServiceLinks(d);renderJobs();renderTransferControls(d);
  createHolding();
  renderServerPower(d);
  showInitialSection();
  if(d.controls.state.copyPaused&&d.pi?.drive?.available){document.getElementById('transfer-pill').textContent='Paused by you';document.getElementById('transfer-pill').className='pill warn'}
};

/* Transfer controls use the existing pause/resume preference, never a new copy pipeline. */
let transferRequestBusy=false,transferAccepted=null;
function transferControlView(d){
  const observed=d.controls?.state||{};
  if(transferAccepted&&Number(observed.updated||0)>=transferAccepted.updated)transferAccepted=null;
  const paused=transferAccepted?transferAccepted.paused:!!observed.copyPaused;
  const current={...d,controls:{...d.controls,state:{...observed,copyPaused:paused}}};
  const view=transferView(current),active=!!d.copy?.active;
  let label=view.pill,note=view.note;
  if(transferRequestBusy){label='Saving transfer choice…';note='Please wait for the transfer worker to receive your choice.'}
  else if(paused){
    const stopping=/^Copying\b/i.test(d.status||'');
    label=stopping?'Stopping…':'Stopped by you';
    note=stopping?'The current transfer is stopping safely. Computer originals are kept.':'New transfers are stopped. Start transfers when you are ready.';
  }else if(view.pill==='Ready'){
    label='Transfers enabled';note='No completed downloads are ready to transfer. Copying starts automatically when one is ready.';
  }else if(active){label='Transferring';note='One completed download is copied at a time.'}
  return {label,note,paused,startDisabled:!d.canControl||transferRequestBusy||(!paused&&active),stopDisabled:!d.canControl||transferRequestBusy||paused};
}
async function setTransferPaused(paused){
  if(!data.canControl||transferRequestBusy||actionBusy)return;
  transferRequestBusy=true;renderTransferControls(data);
  try{
    const result=await action({action:'copy',operation:paused?'pause':'resume'});
    if(result&&typeof result.copyPaused==='boolean')transferAccepted={paused:result.copyPaused,updated:Number(result.controlUpdatedAt||0)};
  }finally{transferRequestBusy=false;renderTransferControls(data)}
}
function renderTransferControls(d){
  const title=document.getElementById('copy-title');if(!title)return;
  if(!document.getElementById('transfer-controls')){
    const card=title.closest('section');if(card)card.id='transfer';
    const panel=document.createElement('div');panel.id='transfer-controls';panel.className='transfer-controls';
    panel.innerHTML=`<div class="transfer-control-buttons"><button class="button primary" id="transfer-start">Start transfers</button><button class="button" id="transfer-stop">Stop transfers</button><span id="transfer-control-state" class="muted" role="status"></span></div>
      <p id="transfer-control-note" class="control-help"></p><p class="control-help">Transfers run one at a time. Stop keeps the computer originals; an unfinished file may restart when you resume.</p>
      <a class="button transfer-open-controls" id="transfer-open-controls" href="http://127.0.0.1:18090/#transfer" hidden>Open controls on the main computer</a>`;
    title.before(panel);
    document.getElementById('transfer-start').onclick=()=>setTransferPaused(false);
    document.getElementById('transfer-stop').onclick=()=>setTransferPaused(true);
  }
  const view=transferControlView(d);
  document.getElementById('transfer-start').disabled=view.startDisabled;
  document.getElementById('transfer-stop').disabled=view.stopDisabled;
  document.getElementById('transfer-control-state').textContent=d.canControl?view.label:'View only';
  document.getElementById('transfer-control-note').textContent=d.canControl?view.note:'Start and Stop are available on the main computer. The link below works there; this server view remains read-only.';
  document.getElementById('transfer-open-controls').hidden=!!d.canControl;
}

/* Server power controls: opening or cancelling this dialog never sends a command. */
let powerSubmitting=false,powerAccepted=null,powerReturnFocus=null;
function shutdownTextMatches(value){return typeof value==='string'&&value.trim().toUpperCase()==='SHUTDOWN'}
function serverPowerView(d){
  const observed=d.serverPower||{phase:'unavailable',canShutdown:false};
  const observedBoot=d.pi?.bootId||observed.bootId;
  if(powerAccepted&&powerAccepted.bootId&&observedBoot&&powerAccepted.bootId!==observedBoot)powerAccepted=null;
  if(!powerAccepted&&observedBoot&&['pending','unconfirmed'].includes(observed.phase))powerAccepted={...observed,bootId:observedBoot};
  // Keep the accepted latch through intermediate status responses: an older
  // online response must never re-enable shutdown on the same server boot.
  const value=powerAccepted&&!['offline','pending','unconfirmed'].includes(observed.phase)?powerAccepted:observed;
  const labels={online:'Server online',offline:'Server is not responding',pending:'Shutdown requested',unconfirmed:'Shutdown could not be confirmed',unverified:'Server identity not confirmed',unavailable:'Checking server connection…'};
  return {value,label:labels[value.phase]||'Checking server connection…',enabled:!!d.canControl&&value.phase==='online'&&value.canShutdown===true&&!powerSubmitting};
}
function renderServerPower(d){
  if(!document.getElementById('server-power')){
    const panel=document.createElement('section');panel.id='server-power';panel.className='card server-power-panel';
    panel.innerHTML=`<div class="section-title"><h2>Server power</h2><span id="server-power-state" class="muted" role="status"></span></div>
      <p>Safely shut down the i7 media server before moving it or disconnecting its drives. Your main computer stays on.</p>
      <p class="control-help">Turn the server back on using its physical power button.</p>
      <div class="server-power-actions"><button class="button danger" id="server-shutdown" disabled>Shut down server</button><a class="button" id="server-power-full-controls" href="http://127.0.0.1:18090/#server-power" target="_blank" rel="noopener" hidden>Open full controls on the main computer</a><span id="server-power-note" class="muted" role="status"></span></div>`;
    document.getElementById('controls').after(panel);
    const dialog=document.createElement('dialog');dialog.id='server-shutdown-confirm';dialog.className='holding-confirm';dialog.setAttribute('aria-labelledby','server-shutdown-heading');
    dialog.innerHTML=`<form id="server-shutdown-form"><h2 id="server-shutdown-heading">Shut down the i7 server?</h2>
      <p>Movies, Discovery and server downloads will stop. Transfers from the main computer may be interrupted; their original files are kept.</p>
      <p>Wait until the server has physically powered off before unplugging any drives. A lost connection alone does not confirm it is off.</p>
      <p>To turn it on again, press the server’s power button.</p>
      <label class="control-field" for="server-shutdown-text">Type SHUTDOWN to confirm<input id="server-shutdown-text" placeholder="SHUTDOWN" aria-describedby="server-shutdown-help" autocomplete="off" spellcheck="false" required></label>
      <p id="server-shutdown-help" class="control-help">Enter just the word SHUTDOWN. Uppercase or lowercase is fine.</p>
      <div class="holding-dialog-actions"><button class="button" type="button" id="server-shutdown-cancel">Keep server on</button><button class="button danger" type="submit" id="server-shutdown-submit" disabled>Confirm shutdown</button></div></form>`;
    document.body.append(dialog);
    document.getElementById('server-shutdown').onclick=()=>{
      if(!serverPowerView(data).enabled||actionBusy)return;
      powerReturnFocus=document.activeElement;
      document.getElementById('server-shutdown-text').value='';document.getElementById('server-shutdown-submit').disabled=true;
      dialog.showModal();document.getElementById('server-shutdown-text').focus();
    };
    document.getElementById('server-shutdown-cancel').onclick=()=>dialog.close();
    dialog.addEventListener('cancel',event=>{if(powerSubmitting)event.preventDefault()});
    dialog.addEventListener('close',()=>{document.getElementById('server-shutdown-text').value='';if(powerReturnFocus?.isConnected)powerReturnFocus.focus()});
    document.getElementById('server-shutdown-text').oninput=event=>document.getElementById('server-shutdown-submit').disabled=powerSubmitting||!shutdownTextMatches(event.target.value)||!serverPowerView(data).enabled;
    document.getElementById('server-shutdown-form').onsubmit=async event=>{
      event.preventDefault();if(powerSubmitting||actionBusy||!shutdownTextMatches(document.getElementById('server-shutdown-text').value)||!serverPowerView(data).enabled)return;
      powerSubmitting=true;document.getElementById('server-shutdown-submit').disabled=true;document.getElementById('server-shutdown-cancel').disabled=true;document.getElementById('server-shutdown-text').disabled=true;
      renderServerPower(data);
      try{
        const result=await action({action:'server-power',operation:'shutdown',confirmation:'SHUTDOWN'});
        if(result?.accepted)powerAccepted={...(result.serverPower||{}),phase:'pending',canShutdown:false,bootId:result.serverPower?.bootId||data.pi?.bootId||data.serverPower?.bootId};
      }finally{
        powerSubmitting=false;document.getElementById('server-shutdown-cancel').disabled=false;document.getElementById('server-shutdown-text').disabled=false;
        dialog.close();renderServerPower(data);
      }
    };
  }
  const state=serverPowerView(d);
  document.getElementById('server-power-state').textContent=state.label;
  document.getElementById('server-shutdown').disabled=!state.enabled;
  document.getElementById('server-shutdown').hidden=false;
  document.getElementById('server-power-full-controls').hidden=!!d.canControl;
  document.getElementById('server-power-note').textContent=!d.canControl?'This server-address page is view-only. Open the full controls link on your main computer to shut down the server.':powerSubmitting?'Sending shutdown request…':state.value.phase==='pending'?'Shutdown is starting. Wait for the server to power off before disconnecting anything.':state.value.phase==='unconfirmed'?'Do not unplug it yet. Check the server and refresh this page.':state.value.phase==='offline'?'Check its power light before disconnecting drives. Press its power button to turn it on again.':state.value.message||'';
}

let holdingData=null, holdingLoading=false, holdingChecked=0, holdingSelected=null, holdingRequest=null;
const holdingSelection=new Set();
const holdingFailures=new Map();
let holdingDeleting=false, holdingReturnFocus=null;
function holdingBytes(value){return value>=1e9?(value/1e9).toFixed(1)+' GB':value>=1e6?(value/1e6).toFixed(1)+' MB':value>=1000?(value/1000).toFixed(1)+' KB':value+' B'}
function selectableHolding(){return data.canControl?(holdingData?.items||[]).filter(item=>item.state==='held'):[]}
function selectedHolding(){return selectableHolding().filter(item=>holdingSelection.has(item.id))}
function updateHoldingSelection(){
  const available=selectableHolding(),allowed=new Set(available.map(item=>item.id));
  for(const id of holdingSelection)if(!allowed.has(id))holdingSelection.delete(id);
  for(const id of holdingFailures.keys())if(!allowed.has(id))holdingFailures.delete(id);
  const selected=selectedHolding(),all=document.getElementById('holding-select-all');
  document.getElementById('holding-bulk').hidden=!data.canControl;
  all.checked=available.length>0&&selected.length===available.length;
  all.indeterminate=selected.length>0&&selected.length<available.length;
  all.disabled=!available.length||holdingDeleting;
  document.getElementById('holding-delete-selected').disabled=!selected.length||holdingDeleting;
  document.getElementById('holding-selection-summary').textContent=selected.length?selected.length+' selected · '+holdingBytes(selected.reduce((sum,item)=>sum+item.bytes,0)):'No titles selected';
  document.querySelectorAll('[data-holding-select]').forEach(input=>{input.checked=holdingSelection.has(input.dataset.id);input.disabled=holdingDeleting});
}
function toggleAllHolding(checked){
  holdingSelection.clear();
  if(checked)for(const item of selectableHolding())holdingSelection.add(item.id);
  updateHoldingSelection();
}
function createHolding(){
  if(!document.getElementById('holding')){
    let section=document.createElement('section');section.id='holding';section.className='card holding-panel';
    section.innerHTML=`<div class="section-title"><h2>Media holding</h2><button class="button" id="holding-refresh">Refresh</button></div>
      <p class="holding-intro">Delete media in Movies moves a film or whole TV series here. You can restore it, or review it before permanently deleting it.</p>
      <p class="control-help">Nothing is deleted automatically. Held titles stay out of Movies and automatic downloads. Holding still uses space on the server drive.</p>
      <p id="holding-summary" class="muted" role="status">Loading holding area…</p>
      <div id="holding-bulk" class="holding-bulk" hidden><label class="holding-select-all"><input type="checkbox" id="holding-select-all">Select all</label><span id="holding-selection-summary" class="muted" role="status">No titles selected</span><button class="button danger" id="holding-delete-selected" disabled>Delete selected</button></div>
      <div id="holding-items"></div>`;
    document.getElementById('controls').after(section);
    let link=document.createElement('a');link.href='#holding';link.textContent='Media holding';document.querySelector('.nav').append(link);updateNavigation();
    document.getElementById('holding-refresh').onclick=()=>loadHolding(true);
    document.getElementById('holding-select-all').onchange=event=>toggleAllHolding(event.target.checked);
    document.getElementById('holding-delete-selected').onclick=()=>openPurge(selectedHolding());
    section.addEventListener('change',event=>{
      const input=event.target.closest('[data-holding-select]');if(!input||!data.canControl||holdingDeleting)return;
      if(input.checked)holdingSelection.add(input.dataset.id);else holdingSelection.delete(input.dataset.id);
      updateHoldingSelection();
    });
    section.addEventListener('click',async event=>{
      let button=event.target.closest('[data-holding-action]');if(!button||!data.canControl||holdingDeleting)return;
      let item=holdingData?.items.find(x=>x.id===button.dataset.id);if(!item)return;
      if(button.dataset.holdingAction==='restore'){
        button.disabled=true;
        let result=await action({action:'holding',operation:'restore',id:item.id});
        if(result)await loadHolding(true);else button.disabled=false;
      }else openPurge(item);
    });
    let dialog=document.createElement('dialog');dialog.id='holding-confirm';dialog.className='holding-confirm';
    dialog.setAttribute('aria-labelledby','holding-confirm-heading');
    dialog.innerHTML=`<form id="holding-confirm-form"><h2 id="holding-confirm-heading">Permanently delete?</h2><p id="holding-confirm-title"></p>
      <details id="holding-confirm-details"><summary>Selected titles</summary><ul id="holding-confirm-list"></ul></details>
      <p>This removes the selected held files from the server drive. It cannot be undone. Automatic downloads will continue to exclude these titles.</p>
      <p id="holding-delete-progress" class="muted" role="status"></p>
      <label class="control-field" for="holding-confirm-text">Type DELETE to confirm<input id="holding-confirm-text" autocomplete="off" spellcheck="false" required></label>
      <div class="holding-dialog-actions"><button class="button" type="button" id="holding-cancel">Keep in holding</button><button class="button danger" type="submit" id="holding-permanent" disabled>Delete permanently</button></div></form>`;
    document.body.append(dialog);
    document.getElementById('holding-cancel').onclick=()=>dialog.close();
    dialog.addEventListener('cancel',event=>{if(holdingDeleting)event.preventDefault()});
    dialog.addEventListener('close',()=>{holdingSelected=null;(holdingReturnFocus?.isConnected?holdingReturnFocus:document.getElementById('holding-refresh')).focus()});
    document.getElementById('holding-confirm-text').oninput=event=>document.getElementById('holding-permanent').disabled=holdingDeleting||event.target.value!=='DELETE';
    document.getElementById('holding-confirm-form').onsubmit=async event=>{
      event.preventDefault();if(!holdingSelected?.length||!data.canControl||document.getElementById('holding-confirm-text').value!=='DELETE'||actionBusy||holdingDeleting)return;
      // Freeze explicit IDs now: newly held titles never join an existing confirmation.
      const ids=holdingSelected.map(item=>item.id),deleted=new Set();
      holdingDeleting=true;document.getElementById('holding-permanent').disabled=true;
      document.getElementById('holding-cancel').disabled=true;document.getElementById('holding-confirm-text').disabled=true;updateHoldingSelection();
      let failed=false;
      try{
        for(let start=0;start<ids.length;start+=200){
          document.getElementById('holding-delete-progress').textContent='Deleting selected titles… '+start+' of '+ids.length+' checked';
          const result=await action({action:'holding',operation:'purge-selected',ids:ids.slice(start,start+200),confirmation:'DELETE'});
          if(!result){failed=true;break}
          for(const id of result.deletedIds||[]){deleted.add(id);holdingFailures.delete(id)}
          for(const item of result.failed||[])holdingFailures.set(item.id,item.message||'Deletion could not finish. Review this title before trying again.');
          if(result.failed?.length){failed=true;break}
        }
        for(const id of deleted)holdingSelection.delete(id);
        if(failed)tell(deleted.size+' confirmed deleted. Some selected titles could not be confirmed deleted. Refresh and review the remaining items before trying again.',true);
        else tell(deleted.size+' selected '+(deleted.size===1?'title':'titles')+' permanently deleted.');
      }finally{
        holdingDeleting=false;document.getElementById('holding-cancel').disabled=false;document.getElementById('holding-confirm-text').disabled=false;
        document.getElementById('holding-confirm-text').value='';dialog.close();await loadHolding(true);updateHoldingSelection();
      }
    };
  }
  if(!holdingData || location.hash==='#holding')loadHolding();
}
function openPurge(items){
  if(!data.canControl||holdingDeleting)return;
  const requested=Array.isArray(items)?items:[items],allowed=new Map(selectableHolding().map(item=>[item.id,item]));
  holdingSelected=[...new Set(requested.filter(Boolean).map(item=>item.id))].filter(id=>allowed.has(id)).map(id=>({...allowed.get(id)}));
  if(!holdingSelected.length){holdingSelected=null;return}
  holdingReturnFocus=document.activeElement;
  document.getElementById('holding-confirm-heading').textContent=holdingSelected.length===1?'Permanently delete?':'Permanently delete '+holdingSelected.length+' titles?';
  document.getElementById('holding-confirm-title').textContent=holdingSelected.length===1?holdingSelected[0].title+(holdingSelected[0].year?' ('+holdingSelected[0].year+')':'')+' · '+holdingBytes(holdingSelected[0].bytes):holdingSelected.length+' selected titles · '+holdingBytes(holdingSelected.reduce((sum,item)=>sum+item.bytes,0));
  document.getElementById('holding-confirm-list').innerHTML=holdingSelected.map(item=>'<li>'+esc(item.title)+(item.year?' ('+esc(item.year)+')':'')+'</li>').join('');
  document.getElementById('holding-confirm-details').open=false;document.getElementById('holding-delete-progress').textContent='';
  document.getElementById('holding-confirm-text').value='';document.getElementById('holding-permanent').disabled=true;
  document.getElementById('holding-confirm').showModal();document.getElementById('holding-confirm-text').focus();
}
async function loadHolding(force=false){
  // A refresh started before a deletion may contain the old list. A forced
  // post-action refresh must wait for it, then fetch again rather than skip.
  if(holdingLoading){if(force){await holdingRequest;return loadHolding(true)}return holdingRequest}
  if(!force&&Date.now()-holdingChecked<15000)return;
  holdingLoading=true;holdingChecked=Date.now();
  holdingRequest=(async()=>{
  try{
    let response=await fetch('api/holding',{cache:'no-store'});
    if(!response.ok)throw Error('The holding list is temporarily unavailable. Existing media is safe; please refresh.');
    let value=await response.json();
    if(!response.ok)throw Error(value.message||'Holding is temporarily unavailable.');
    holdingData=value;
    document.getElementById('holding-summary').textContent=value.items.length?value.items.length+' held '+(value.items.length===1?'title':'titles')+' · '+holdingBytes(value.bytes):'Holding is empty. No media is waiting for deletion.';
    document.getElementById('holding-items').innerHTML=value.items.map(item=>`<article class="holding-item"><div class="holding-item-main">${data.canControl&&item.state==='held'?`<label class="holding-check"><input type="checkbox" data-holding-select data-id="${esc(item.id)}" aria-label="Select ${esc(item.title)}"></label>`:''}<div><h3>${esc(item.title)}${item.year?' <span class="muted">('+esc(item.year)+')</span>':''}</h3><p class="muted">${item.type==='Series'?'TV series':'Movie'} · ${holdingBytes(item.bytes)} · Held ${new Date(item.created).toLocaleDateString()}</p>${item.error||holdingFailures.get(item.id)?'<p class="holding-error">'+esc(item.error||holdingFailures.get(item.id))+'</p>':''}</div></div><div class="holding-actions">${data.canControl?`<button class="button" data-holding-action="restore" data-id="${esc(item.id)}">Restore</button>${item.state==='held'?`<button class="button danger" data-holding-action="purge" data-id="${esc(item.id)}">Review deletion</button>`:''}`:'<span class="muted">Review on the main computer</span>'}</div></article>`).join('');
    updateHoldingSelection();
  }catch(error){document.getElementById('holding-summary').textContent=error.message}
  finally{holdingLoading=false}
  })();
  return holdingRequest;
}
window.addEventListener('hashchange',()=>{if(location.hash==='#holding')loadHolding(true)});
