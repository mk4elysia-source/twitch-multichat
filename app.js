const $=s=>document.querySelector(s);
const API='https://api.twitch.tv/helix',ID='https://id.twitch.tv/oauth2',WS='wss://eventsub.wss.twitch.tv/ws';
const SCOPES='user:read:chat user:write:chat';
const S=JSON.parse(localStorage.getItem('tmc')||'{}');S.accounts??=[];
const save=()=>localStorage.setItem('tmc',JSON.stringify(S));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hdr=t=>({Authorization:'Bearer '+t,'Client-Id':S.clientId});
const active=()=>S.accounts.find(a=>a.id===S.active&&!a.dead)||S.accounts.find(a=>!a.dead);
let bid,ws,authRun=0;

async function post(url,params){const r=await fetch(url,{method:'POST',body:new URLSearchParams(params)});return{ok:r.ok,j:await r.json().catch(()=>({}))};}

async function token(a){
  if(a.exp>Date.now()+60000)return a.access;
  const r=await post(ID+'/token',{client_id:S.clientId,grant_type:'refresh_token',refresh_token:a.refresh});
  if(!r.ok){a.dead=true;save();render();throw new Error('再認証が必要です: '+a.login);}
  Object.assign(a,{access:r.j.access_token,refresh:r.j.refresh_token,exp:Date.now()+r.j.expires_in*1000});
  save();return a.access;
}

async function addAccount(){
  if(!S.clientId)return($('#auth').textContent='先にClient IDを入力してください');
  const run=++authRun;
  const d=await post(ID+'/device',{client_id:S.clientId,scopes:SCOPES});
  if(!d.ok)return($('#auth').textContent='認証を開始できません: '+(d.j.message||''));
  const{device_code,user_code,verification_uri,expires_in,interval}=d.j;
  $('#auth').innerHTML=`追加したいアカウントでTwitchにログインした状態(または別のプライベートタブ)で開き、コードを入力します。<br><a href="${verification_uri}" target="_blank" rel="noopener">認証ページを開く</a><br><code>${user_code}</code>`;
  const end=Date.now()+expires_in*1000;
  while(Date.now()<end&&run===authRun){
    await sleep((interval||5)*1000);
    const t=await post(ID+'/token',{client_id:S.clientId,scopes:SCOPES,device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
    if(t.ok){await register(t.j);$('#auth').textContent='追加しました';return;}
    if(t.j.message!=='authorization_pending'&&t.j.message!=='slow_down')return($('#auth').textContent='認証に失敗しました: '+(t.j.message||''));
  }
}

async function register(t){
  const v=await(await fetch(ID+'/validate',{headers:{Authorization:'OAuth '+t.access_token}})).json();
  const a={id:v.user_id,login:v.login,access:t.access_token,refresh:t.refresh_token,exp:Date.now()+t.expires_in*1000};
  const u=await(await fetch(API+'/users',{headers:hdr(a.access)})).json();
  a.img=u.data?.[0]?.profile_image_url;
  S.accounts=S.accounts.filter(x=>x.id!==a.id);S.accounts.push(a);
  S.active??=a.id;save();render();
}

function sys(t){const d=document.createElement('div');d.className='sys';d.textContent=t;pushLog(d);}
function pushLog(el){
  const log=$('#log'),near=log.scrollHeight-log.scrollTop-log.clientHeight<80;
  log.append(el);while(log.children.length>200)log.firstChild.remove();
  if(near)log.scrollTop=log.scrollHeight;
}
function addMsg(ev){
  const d=document.createElement('div');d.className='m';
  const n=document.createElement('b');n.textContent=ev.chatter_user_name;if(ev.color)n.style.color=ev.color;d.append(n);
  for(const f of ev.message.fragments){
    if(f.type==='emote'){const i=document.createElement('img');i.src=`https://static-cdn.jtvnw.net/emoticons/v2/${f.emote.id}/default/dark/1.0`;i.alt=f.text;d.append(i);}
    else d.append(f.text);
  }
  pushLog(d);
}

async function join(login){
  login=(login||'').trim().toLowerCase();if(!login)return;
  S.channel=login;save();$('#ch').value=login;
  $('#player').src=`https://player.twitch.tv/?channel=${login}&parent=${location.hostname}`;
  const a=active();if(!a)return sys('アカウントを追加してください(設定)');
  try{
    const tk=await token(a);
    const u=await(await fetch(`${API}/users?login=${login}`,{headers:hdr(tk)})).json();
    if(!u.data?.[0])return sys('チャンネルが見つかりません');
    bid=u.data[0].id;$('#log').replaceChildren();connect(a,WS,true);
  }catch(e){sys(e.message);}
}

function connect(a,url,resub){
  const old=ws,w=ws=new WebSocket(url);
  w.onmessage=async e=>{
    if(w!==ws)return;
    const m=JSON.parse(e.data),t=m.metadata.message_type;
    if(t==='session_welcome'){
      if(old&&old!==w)old.close();
      if(!resub)return;
      try{
        const tk=await token(a);
        const r=await fetch(API+'/eventsub/subscriptions',{method:'POST',headers:{...hdr(tk),'Content-Type':'application/json'},
          body:JSON.stringify({type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:bid,user_id:a.id},transport:{method:'websocket',session_id:m.payload.session.id}})});
        if(!r.ok)sys('チャット受信に失敗: '+((await r.json()).message||r.status));
        else sys('接続しました');
      }catch(err){sys(err.message);}
    }else if(t==='session_reconnect')connect(a,m.payload.session.reconnect_url,false);
    else if(t==='notification')addMsg(m.payload.event);
  };
  w.onclose=()=>{if(w===ws)setTimeout(()=>w===ws&&join(S.channel),5000);};
}

async function send(){
  const a=active(),box=$('#msg'),text=box.value.trim();
  if(!a||!text||!bid)return;
  try{
    const tk=await token(a);
    const r=await fetch(API+'/chat/messages',{method:'POST',headers:{...hdr(tk),'Content-Type':'application/json'},body:JSON.stringify({broadcaster_id:bid,sender_id:a.id,message:text})});
    const j=await r.json(),d=j.data?.[0];
    if(!r.ok||(d&&!d.is_sent))sys('送信できません: '+(j.message||d?.drop_reason?.message||r.status));
    else box.value='';
  }catch(e){sys(e.message);}
}

function render(){
  const a=active(),chips=$('#chips'),list=$('#list');
  chips.replaceChildren();list.replaceChildren();
  for(const x of S.accounts){
    const b=document.createElement('button');
    b.className='chip'+(a&&x.id===a.id?' on':'')+(x.dead?' dead':'');b.title=x.login;
    if(x.img){const i=document.createElement('img');i.src=x.img;i.alt=x.login;b.append(i);}else b.textContent=x.login[0].toUpperCase();
    b.onclick=()=>{if(x.dead)return sys(x.login+' は再認証が必要です(設定から追加)');S.active=x.id;save();render();$('#msg').focus();};
    chips.append(b);
    const li=document.createElement('li');li.className=x.dead?'dead':'';
    const s=document.createElement('span');s.textContent=x.login+(x.dead?'(再認証が必要)':'');
    const del=document.createElement('button');del.textContent='削除';
    del.onclick=()=>{S.accounts=S.accounts.filter(y=>y.id!==x.id);if(S.active===x.id)S.active=null;save();render();};
    li.append(s,del);list.append(li);
  }
  $('#msg').placeholder=a?`${a.login} として送信`:'アカウントを追加してください';
}

$('#jf').onsubmit=e=>{e.preventDefault();join($('#ch').value);};
$('#sf').onsubmit=e=>{e.preventDefault();send();};
$('#gear').onclick=()=>{$('#cid').value=S.clientId||'';$('#dlg').showModal();};
$('#close').onclick=()=>{authRun++;$('#auth').textContent='';$('#dlg').close();};
$('#cid').onchange=e=>{S.clientId=e.target.value.trim();save();};
$('#add').onclick=addAccount;
render();
if(!S.clientId)$('#gear').click();
else if(S.channel)join(S.channel);
