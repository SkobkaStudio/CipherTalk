// =============================================================================
//  app.js — ВЕСЬ UI-СЛОЙ (View + часть ViewModel в терминах MVC)
// =============================================================================
//  Структура файла:
//    1. Состояние приложения (state) и короткие помощники по DOM
//    2. Авторизация (вход/регистрация + генерация E2EE-ключей)
//    3. Список чатов (левая колонка)
//    4. Открытие чата, история, расшифровка сообщений
//    5. Отправка текста / файлов, «печатает…», ответы, редактирование
//    6. Реакции, закрепление, удаление, галочки ✓/✓✓
//    7. Панель информации о чате (участники, роли, приглашение)
//    8. Модалки: новый чат, группа, канал, профиль, join по ссылке
//    9. Обработка WebSocket-событий (live)
//   10. Инициализация
//
//  ВСЕ сообщения хранятся на сервере в ЗАШИФРОВАННОМ виде (см. e2ee.js).
//  Сервер — «глупый почтальон»: он доставляет контейнеры, но не читает их.
// =============================================================================

/* ======================= 1. СОСТОЯНИЕ И ПОМОЩНИКИ ========================= */
const state = {
  me: null,             // текущий пользователь {id, username, name, ...}
  chats: [],            // список чатов с сервера
  currentChat: null,    // открытый чат (объект из /api/chats)
  members: [],          // участники открытого чата
  memberKeys: [],       // их публичные ключи (тот же порядок!)
  myIndex: 0,           // моя позиция в memberKeys (для расшифровки ek[myIndex])
  messages: [],         // объекты сообщений (как пришли с сервера)
  plain: {},            // кэш расшифрованного текста: msgId -> строка|null
  replyTo: 0,           // id сообщения, на которое отвечаем
  editingId: 0,         // id сообщения, которое редактируем
  onlineSet: new Set(), // id пользователей онлайн (по WS presence)
};

const $  = sel => document.querySelector(sel);        // один элемент
const $$ = sel => [...document.querySelectorAll(sel)];
const el = (tag, cls, html) => { const e=document.createElement(tag);
  if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; };
const esc = s => String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtTime = ts => new Date(ts*1000).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
const fmtDay = ts => new Date(ts*1000).toLocaleDateString('ru',{day:'numeric',month:'long'});
const fmtSize = n => n>1048576 ? (n/1048576).toFixed(1)+' МБ' : Math.max(1,Math.round(n/1024))+' КБ';

// Уведомление-«тост» внизу экрана
function toast(text){ const t=el('div','toast',esc(text)); document.body.appendChild(t);
  setTimeout(()=>t.remove(),2600); }

// Буквы для аватара: «Вася Пупкин» -> «ВП»
const initials = name => (name||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();

// Цветной круглый аватар как в Telegram
function avatarEl(name, color, size='', online=false){
  const a = el('div','avatar '+size+(online?' online':''), esc(initials(name)));
  a.style.background = /^#[0-9a-f]{6}$/i.test(color||'') ? color : '#576e88';
  return a;
}

/* ========================== 2. АВТОРИЗАЦИЯ ================================= */
let authMode = 'login';

$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');
function setAuthMode(m){
  authMode = m;
  $('#tab-login').classList.toggle('active', m==='login');
  $('#tab-register').classList.toggle('active', m==='register');
  $('#a-name').classList.toggle('hidden', m==='login');
  $('#a-submit').textContent = m==='login' ? 'Войти' : 'Создать аккаунт';
  $('#a-error').textContent='';
}

$('#auth-form').onsubmit = async ev => {
  ev.preventDefault();
  const username=$('#a-username').value.trim().toLowerCase();
  const password=$('#a-password').value;
  const name=$('#a-name').value.trim();
  $('#a-error').textContent='...';
  try{
    if(authMode==='register'){
      // Генерируем пару RSA-ключей прямо в браузере (E2EE identity)
      const pubJwk = await E2EE.generateIdentity();
      await API.register(username,password,name,pubJwk);
    } else {
      await API.login(username,password);
      // Если ключей нет (вход с нового браузера) — создаём новые и загружаем на сервер.
      // Старые переписки с этого устройства будут показаны как 🔒 (честная цена E2EE).
      if(!E2EE.hasIdentity()){
        const pubJwk = await E2EE.generateIdentity();
        await API.saveProfile({e2ee_pub:pubJwk});
      }
    }
    startApp();
  }catch(e){ $('#a-error').textContent = e.message; }
};

/* ===================== 3. СПИСОК ЧАТОВ (сайдбар) =========================== */
async function loadChats(){
  const r = await API.chats();
  state.chats = r.chats;
  renderChatList();
}

function chatDisplay(c){
  if(c.type==='private') return {title:c.display_title||c.peer_name||'Чат',
      avatar:c.peer_avatar||'#576e88', online:state.onlineSet.has(c.peer_id)||c.peer_online};
  return {title:c.title, avatar:c.avatar||'#576e88', online:false};
}

function renderChatList(){
  const box=$('#chat-list'); box.innerHTML='';
  for(const c of state.chats){
    const d=chatDisplay(c);
    const item=el('div','chat-item'+(state.currentChat&&state.currentChat.id===c.id?' active':''));
    item.appendChild(avatarEl(d.title,d.avatar,'',d.online));
    const body=el('div','ci-body');
    body.innerHTML =
      `<div class="ci-top"><span class="ci-title">${esc(d.title)}</span>
        <span class="ci-time">${c.last_time?fmtTime(c.last_time):''}</span></div>
       <div class="ci-bottom"><span class="ci-preview">🔒 ${c.unread?'':''}${esc(previewKind(c))}</span>
        ${c.unread?`<span class="badge">${c.unread}</span>`:''}</div>`;
    item.appendChild(body);
    item.onclick=()=>openChat(c);
    box.appendChild(item);
  }
}
// Превью всегда «🔒» — сервер не знает содержимое (E2EE), это нормально
const previewKind = c => c.last_time ? 'Зашифровано' : 'Нет сообщений';

/* =================== 4. ОТКРЫТИЕ ЧАТА И РАСШИФРОВКА ======================== */
async function openChat(c){
  state.currentChat=c; state.replyTo=0; state.editingId=0;
  $('#empty-state').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#reply-bar').classList.add('hidden');
  renderChatList();

  // Шапка чата
  const d=chatDisplay(c);
  $('#ch-title').textContent=d.title;
  const av=$('#ch-avatar'); av.outerHTML=''; // пересоздадим
  $('.chat-head').prepend(avatarEl(d.title,d.avatar,'',false));
  $('.chat-head .avatar').id='ch-avatar';
  updateChatStatus();

  // Участники + публичные ключи (нужны для E2EE)
  const m=await API.members(c.id);
  state.members=m.members; state.memberKeys=m.member_keys; state.myIndex=m.my_index;
  c.my_role=m.my_role;

  // История
  const h=await API.history(c.id,0,50);
  state.messages=h.messages.reverse();          // сервер отдаёт новые первыми
  await decryptAll(state.messages);
  renderMessages();

  // Закреплённое сообщение сверху
  const p=await API.pinnedList(c.id);
  if(p.pinned.length){
    await decryptAll(p.pinned);
    $('#pinned-bar').classList.remove('hidden');
    $('#pinned-text').textContent=(state.plain[p.pinned[0].id]||'🔒').slice(0,80);
  } else $('#pinned-bar').classList.add('hidden');

  // Отмечаем прочитанным (сброс бейджа + ✓✓ у собеседника)
  API.markRead(c.id); API.notifyRead(c.id);
  c.unread=0; renderChatList();
  $('#msg-input').focus();
}

// Расшифровать список сообщений: plain[id] = текст | null (если ключ не наш)
async function decryptAll(msgs){
  for(const m of msgs){
    if(m.deleted){ state.plain[m.id]=''; continue; }
    if(m.content_type==='text'||m.content_type==='service'){ state.plain[m.id]=m.content; continue; }
    state.plain[m.id]=await E2EE.decrypt(m.content,state.myIndex);
  }
}

function updateChatStatus(){
  const c=state.currentChat; if(!c) return;
  const st=$('#ch-status');
  if(c.type==='private'){
    const on = state.onlineSet.has(c.peer_id)||c.peer_online;
    st.textContent = on?'в сети':'был(а) недавно';
    st.classList.toggle('on',on);
  } else if(c.type==='group'){
    st.textContent = state.members.length+' участников';
  } else st.textContent='канал';
}

/* ============================ 5. РЕНДЕР ЛЕНТЫ ============================== */
function renderMessages(){
  const box=$('#messages'); box.innerHTML='';
  let lastDay='';
  for(const m of state.messages){
    const day=fmtDay(m.created_at);
    if(day!==lastDay){ box.appendChild(el('div','day-sep',esc(day))); lastDay=day; }
    box.appendChild(renderBubble(m));
  }
  box.scrollTop=box.scrollHeight;
}

function renderBubble(m){
  const out = m.sender_id===state.me.id;
  const row = el('div','msg-row '+(out?'out':'in'));
  const b   = el('div','bubble b');

  // имя отправителя — только в группах/каналах и только у чужих
  if(!out && state.currentChat.type!=='private')
    b.appendChild(el('span','sender',esc(m.sender_name||'???')));

  if(m.deleted){
    b.classList.add('deleted');
    b.insertAdjacentHTML('beforeend','🗑 Сообщение удалено');
  } else {
    // цитата «ответ на…»
    if(m.reply_to){
      const src=state.messages.find(x=>x.id===m.reply_to);
      const ref=el('div','reply-ref','↩ '+(src?esc((state.plain[src.id]||'🔒').slice(0,50)):'сообщение'));
      ref.onclick=()=>scrollToMsg(m.reply_to);
      b.appendChild(ref);
    }
    // вложение (картинка или файл)
    if(m.attachment){
      const a=m.attachment;
      if(m.content_type==='image'){
        const img=el('img','att-img'); img.src=a.url; b.appendChild(img);
      } else {
        const chip=el('div','file-chip',
          `<span class="fi">📄</span><div><div class="fc-name">${esc(a.filename)}</div>
           <div class="fc-size">${fmtSize(a.size)}</div></div>`);
        chip.onclick=()=>location.href=a.url;
        b.appendChild(chip);
      }
    }
    // текст (расшифрованный или 🔒 если ключ не подошёл)
    const txt=state.plain[m.id];
    const span=el('span','txt');
    span.innerHTML = (m.content_type==='encrypted'&&txt==null)?'🔒 <i>нет доступа к ключу</i>'
                    : linkify(esc(txt||''));
    b.appendChild(span);
  }

  // мета: время + «изменено» + галочки
  const meta=el('span','meta', fmtTime(m.created_at)+(m.edited_at?' <span class="edited">✎</span>':''));
  if(out&&!m.deleted){
    const viewers=state.messages.find(x=>x.id===m.id)?.views||m.views||0;
    const read = state.currentChat.type==='private'
        ? (viewers>0)
        : (viewers>=state.members.length-1);
    meta.insertAdjacentHTML('beforeend',` <span class="ticks">${read?'✓✓':'✓'}</span>`);
  }
  b.insertBefore(meta,b.firstChild.nextSibling);

  // реакции 👍❤️🔥
  if(m.reactions&&m.reactions.length){
    const rx=el('div','reactions');
    for(const r of m.reactions){
      const chip=el('span','rx'+(r.mine?' mine':''),`${r.emoji} ${r.count}`);
      chip.onclick=()=>API.react(m.id,r.emoji).then(loadHistorySoft);
      rx.appendChild(chip);
    }
    b.appendChild(rx);
  }

  // контекстное меню по правому клику (или долгому тапу)
  row.oncontextmenu=e=>{e.preventDefault();showCtxMenu(e,m);};
  row.appendChild(b);
  return row;
}
// Превращаем URL в кликабельные ссылки (мини-форматирование)
const linkify=s=>s.replace(/(https?:\/\/[^\s<]+)/g,u=>`<a href="${u}" target="_blank" style="color:#7be0ff">${u}</a>`);
function scrollToMsg(id){
  const rows=$$('.msg-row'); const idx=state.messages.findIndex(m=>m.id===id);
  if(idx>=0&&rows[idx]){rows[idx].scrollIntoView({behavior:'smooth',block:'center'});
    rows[idx].querySelector('.bubble').style.outline='2px solid var(--accent)';
    setTimeout(()=>rows[idx].querySelector('.bubble').style.outline='',1200);}
}

/* ==================== 6. ОТПРАВКА / РЕДАКТИРОВАНИЕ ========================= */
// Собрать публичные ключи всех участников в правильном порядке + вернуть мой индекс
function pubsForChat(){ return state.memberKeys.filter(k=>k); }

async function sendMessage(){
  const inp=$('#msg-input'); const text=inp.value.trim();
  if(!text||!state.currentChat) return;
  inp.value='';

  if(state.editingId){                        // ---- режим РЕДАКТИРОВАНИЯ ----
    const enc=await E2EE.encrypt(text, pubsForChat());
    await API.editMsg(state.editingId,enc);
    state.editingId=0;
    await loadHistorySoft();
    return;
  }
  const enc=await E2EE.encrypt(text, pubsForChat());
  const r=await API.send(state.currentChat.id,enc,state.replyTo,'encrypted');
  state.replyTo=0; $('#reply-bar').classList.add('hidden');
  state.messages.push(r.message);
  await decryptAll([r.message]);
  renderMessages();
  bumpChatTop(r.message);
}
$('#btn-send').onclick=sendMessage;
$('#msg-input').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}
});
$('#msg-input').addEventListener('input',()=>{
  API.notifyTyping(state.currentChat?.id);
  const t=$('#msg-input'); t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,140)+'px';
});

// обновить ленту без перезагрузки чата (после edit/delete/reaction)
async function loadHistorySoft(){
  const h=await API.history(state.currentChat.id,0,50);
  state.messages=h.messages.reverse();
  await decryptAll(state.messages);
  renderMessages();
}
// поднять чат наверх списка (последнее сообщение)
function bumpChatTop(m){
  const c=state.currentChat; c.last_time=m.created_at;
  state.chats.sort((a,b)=>(b.last_time||0)-(a.last_time||0));
  renderChatList();
}

/* ------------------------- ФАЙЛЫ (загрузка) -------------------------------- */
$('#btn-attach').onclick=()=>$('#file-input').click();
$('#file-input').onchange=async ()=>{
  const f=$('#file-input').files[0]; $('#file-input').value='';
  if(!f||!state.currentChat) return;
  // Метаданные файла (имя) тоже шифруем — сервер не видит даже имён!
  const meta=await E2EE.encrypt(JSON.stringify({name:f.name,size:f.size}),pubsForChat());
  toast('Загрузка '+f.name+'…');
  const r=await API.upload(state.currentChat.id,f,meta,state.replyTo);
  state.replyTo=0; $('#reply-bar').classList.add('hidden');
  await loadHistorySoft();
};

/* --------------- КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ (правый клик) ------------------ */
function showCtxMenu(e,m){
  const menu=$('#ctx-menu'); menu.innerHTML=''; menu.classList.remove('hidden');
  menu.style.left=Math.min(e.clientX,innerWidth-220)+'px';
  menu.style.top =Math.min(e.clientY,innerHeight-260)+'px';

  // быстрые реакции
  const em=el('div','ctx-emojis');
  ['👍','❤️','🔥','🎉','😂','😢'].forEach(x=>{
    const s=el('span',null,x);
    s.onclick=()=>{API.react(m.id,x).then(loadHistorySoft);hideCtx();};
    em.appendChild(s);
  });
  menu.appendChild(em);

  const item=(label,fn)=>{const i=el('div','ctx-item',label);i.onclick=()=>{fn();hideCtx();};menu.appendChild(i);};

  item('↩ Ответить',()=>{
    state.replyTo=m.id;
    $('#reply-preview').textContent=(state.plain[m.id]||'🔒').slice(0,60);
    $('#reply-bar').classList.remove('hidden'); $('#msg-input').focus();
  });
  if(m.sender_id===state.me.id){
    item('✎ Редактировать',()=>{
      $('#msg-input').value=state.plain[m.id]||'';
      state.editingId=m.id; $('#msg-input').focus();
    });
    item('🗑 Удалить',async()=>{
      await API.delMsg(m.id); m.deleted=true; renderMessages();
    });
  }
  const role=state.currentChat.my_role;
  if(role==='owner'||role==='admin'){
    item('📌 Закрепить',async()=>{
      await API.pin(state.currentChat.id,m.id);
      $('#pinned-bar').classList.remove('hidden');
      $('#pinned-text').textContent=(state.plain[m.id]||'🔒').slice(0,80);
    });
    if(state.currentChat.type!=='private')
      item('📌 Открепить',()=>API.unpin(state.currentChat.id,m.id));
  }
  setTimeout(()=>document.addEventListener('click',hideCtx,{once:true}),0);
}
function hideCtx(){$('#ctx-menu').classList.add('hidden');}
$('#reply-cancel').onclick=()=>{state.replyTo=0;$('#reply-bar').classList.add('hidden');};

/* ================ 7. ПАНЕЛЬ ИНФОРМАЦИИ О ЧАТЕ (кнопка ⋮) =================== */
$('#btn-chat-info').onclick=async()=>{
  const panel=$('#info-panel');
  if(!panel.classList.contains('hidden')){panel.classList.add('hidden');return;}
  const c=state.currentChat; if(!c)return;
  panel.classList.remove('hidden');
  const d=chatDisplay(c);
  panel.innerHTML=`<div class="ip-head"><button class="icon-btn" id="ip-close">✕</button>
     <div class="ip-title">Информация</div></div>`;
  panel.querySelector('#ip-close').onclick=()=>panel.classList.add('hidden');

  const head=el('div'); head.style.textAlign='center'; head.style.marginBottom='10px';
  head.appendChild(avatarEl(d.title,d.avatar,'',''));
  head.querySelector('.avatar').style.margin='0 auto';
  head.insertAdjacentHTML('beforeend',
    `<h3 style="margin-top:8px">${esc(d.title)}</h3>
     <div style="color:var(--text2);font-size:13px;margin-top:4px">${esc(c.about||'')}</div>`);
  panel.appendChild(head);

  if(c.type!=='private'){
    panel.insertAdjacentHTML('beforeend',
      `<div class="ip-section">Приглашение: <code>${esc(c.invite_link)}</code>
        <button class="mini-btn" id="copy-inv">Копировать</button></div>`);
    panel.querySelector('#copy-inv').onclick=()=>{navigator.clipboard?.writeText(c.invite_link);toast('Скопировано');};
    panel.insertAdjacentHTML('beforeend',`<div class="ip-section">Участники (${state.members.length})</div>`);
    for(const mm of state.members){
      const row=el('div','member');
      row.appendChild(avatarEl(mm.name,mm.avatar,'sm',state.onlineSet.has(mm.id)||mm.online));
      row.insertAdjacentHTML('beforeend',
        `<div><div style="font-size:14px">${esc(mm.name)}</div>
         <div style="font-size:12px;color:var(--text2)">@${esc(mm.username)}</div></div>`);
      const act=el('div','m-actions');
      const role=c.my_role;
      if((role==='owner'||role==='admin')&&mm.id!==state.me.id){
        if(mm.role==='member'){
          mk('Назначить админом',()=>API.setRole(c.id,mm.id,'admin').then(refreshMembers(panel)));
          mk('Удалить',()=>API.removeMember(c.id,mm.id).then(refreshMembers(panel)));
        } else if(mm.role==='admin'&&role==='owner')
          mk('Снять админа',()=>API.setRole(c.id,mm.id,'member').then(refreshMembers(panel)));
      }
      function mk(t,fn){const btn=el('button','mini-btn',t);btn.onclick=fn;act.appendChild(btn);}
      row.appendChild(act);
      panel.appendChild(row);
    }
    // кнопки добавления
    const addBox=el('div');
    const addBtn=el('button','btn-primary','➕ Добавить участника');
    addBtn.style.marginTop='10px';
    addBtn.onclick=()=>modalAddMember(c);
    addBox.appendChild(addBtn); panel.appendChild(addBox);
    if(c.my_role==='owner'){
      const del=el('button','btn-primary','🗑 Удалить группу');
      del.style.marginTop='8px'; del.style.background='#c0392b';
      del.onclick=async()=>{await API.deleteChat(c.id);closeChat();loadChats();};
      panel.appendChild(del);
    }
  } else {
    // личка: bio собеседника + кнопка удалить диалог
    const peer=state.members.find(x=>x.id!==state.me.id);
    if(peer) panel.insertAdjacentHTML('beforeend',
      `<div class="ip-section">${esc(peer.bio||'')}<br>был(а): ${peer.online?'в сети':fmtTime(peer.last_seen)}</div>`);
    const leave=el('button','btn-primary','🗑 Удалить диалог');
    leave.style.background='#c0392b';
    leave.onclick=async()=>{await API.deleteChat(c.id);closeChat();loadChats();};
    panel.appendChild(leave);
  }
};
async function refreshMembers(panel){
  const m=await API.members(state.currentChat.id);
  state.members=m.members; state.memberKeys=m.member_keys; state.myIndex=m.my_index;
  $('#btn-chat-info').click(); $('#btn-chat-info').click();  // перерисовать панель
}
function closeChat(){
  state.currentChat=null;
  $('#chat-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  $('#info-panel').classList.add('hidden');
}

/* ============================ 8. МОДАЛКИ =================================== */
function openModal(title,bodyNode){
  $('#modal-title').textContent=title;
  const b=$('#modal-body'); b.innerHTML=''; b.appendChild(bodyNode);
  $('#modal').classList.remove('hidden');
}
$('#modal-close').onclick=()=>$('#modal').classList.add('hidden');
$('#modal').onclick=e=>{if(e.target.id==='modal')$('#modal').classList.add('hidden');};

// Меню ☰ — список действий
$('#btn-menu').onclick=e=>{
  e.stopPropagation();
  let d=$('.dropdown'); if(d){d.remove();return;}
  d=el('div','dropdown');
  const items=[
    ['👤 Мой профиль',modalProfile],
    ['➕ Новый личный чат',modalNewPrivate],
    ['👥 Создать группу',modalNewGroup],
    ['📢 Создать канал',modalNewChannel],
    ['🔗 Войти по ссылке',modalJoin],
    ['🚪 Выйти',async()=>{await API.logout();location.reload();}],
  ];
  for(const [t,fn] of items){const i=el('div','ctx-item',t);i.onclick=()=>{d.remove();fn();};d.appendChild(i);}
  $('.sidebar').appendChild(d);
  setTimeout(()=>document.addEventListener('click',()=>d.remove(),{once:true}),0);
};

// --- поиск людей в шапке сайдбара (открывает личку по клику) ---
$('#chat-search').oninput=async()=>{
  const q=$('#chat-search').value.trim(); const box=$('#search-results');
  if(!q){box.classList.add('hidden');return;}
  const r=await API.searchUsers(q);
  box.innerHTML=''; box.classList.remove('hidden');
  if(!r.users.length)box.innerHTML='<div class="sr-item"><span class="sr-sub">Никого не найдено</span></div>';
  for(const u of r.users){
    const it=el('div','sr-item');
    it.appendChild(avatarEl(u.name,u.avatar,'sm',state.onlineSet.has(u.id)||u.online));
    it.insertAdjacentHTML('beforeend',
      `<div><div class="sr-name">${esc(u.name)}</div><div class="sr-sub">@${esc(u.username)}</div></div>`);
    it.onclick=async()=>{
      box.classList.add('hidden'); $('#chat-search').value='';
      await API.addContact(u.id);
      await loadChats();
      const pr=await API.openPrivate(u.id);
      const chat=state.chats.find(c=>c.id===pr.chat_id)||
                 {...(await API.chats()).chats.find(c=>c.id===pr.chat_id)};
      await loadChats();
      const c=state.chats.find(x=>x.id===pr.chat_id);
      if(c)openChat(c);
    };
    box.appendChild(it);
  }
};

// --- новая личка: тот же поиск, но в модалке ---
function modalNewPrivate(){
  const wrap=el('div');
  const inp=el('input'); inp.placeholder='Имя или @логин';
  const res=el('div');
  wrap.append(inp,res); openModal('Новый чат',wrap);
  inp.oninput=async()=>{
    res.innerHTML=''; const r=await API.searchUsers(inp.value.trim());
    for(const u of r.users){
      const it=el('div','chip-pick',`<b>${esc(u.name)}</b> <span class="sr-sub">@${esc(u.username)}</span>`);
      it.onclick=async()=>{
        const pr=await API.openPrivate(u.id); await loadChats();
        $('#modal').classList.add('hidden');
        const c=state.chats.find(x=>x.id===pr.chat_id); if(c)openChat(c);
      };
      res.appendChild(it);
    }
  };
}

// --- создание группы/канала: название + выбор участников из поиска ---
function modalNewGroup(isChannel=false){
  const wrap=el('div');
  const title=el('input'); title.placeholder=isChannel?'Название канала':'Название группы';
  const about=el('input'); about.placeholder='Описание (необязательно)';
  const search=el('input'); search.placeholder='Добавить участников: имя или @логин';
  const picked=el('div'); const chosen=new Map();
  const res=el('div');
  const btn=el('button','btn-primary',isChannel?'Создать канал':'Создать группу');
  wrap.append(title,about,search,picked,res,btn); openModal(isChannel?'Новый канал':'Новая группа',wrap);

  search.oninput=async()=>{
    res.innerHTML=''; const r=await API.searchUsers(search.value.trim());
    for(const u of r.users){
      const it=el('div','chip-pick','<b>'+esc(u.name)+'</b> <span class="sr-sub">@'+esc(u.username)+'</span>');
      it.onclick=()=>{
        if(chosen.has(u.id)){chosen.delete(u.id);it.classList.remove('sel');}
        else{chosen.set(u.id,u);it.classList.add('sel');}
        picked.innerHTML=[...chosen.values()].map(x=>'👤 '+esc(x.name)).join(' · ');
      };
      res.appendChild(it);
    }
  };
  btn.onclick=async()=>{
    if(!title.value.trim())return toast('Введите название');
    let cid;
    if(isChannel){cid=(await API.createChannel(title.value,about.value)).chat_id;}
    else {cid=(await API.createGroup(title.value,about.value,[...chosen.keys()])).chat_id;}
    $('#modal').classList.add('hidden');
    await loadChats();
    const c=state.chats.find(x=>x.id===cid); if(c)openChat(c);
  };
}

// --- войти по invite-ссылке ---
function modalJoin(){
  const wrap=el('div');
  const inp=el('input'); inp.placeholder='Ссылка-приглашение (например inv-xxxx)';
  const btn=el('button','btn-primary','Вступить');
  wrap.append(inp,btn); openModal('Присоединиться к группе',wrap);
  btn.onclick=async()=>{
    try{
      const r=await API.joinChat(inp.value.trim());
      $('#modal').classList.add('hidden'); await loadChats();
      const c=state.chats.find(x=>x.id===r.chat_id); if(c)openChat(c);
    }catch(e){toast(e.message);}
  };
}

// --- мой профиль: имя, bio, цвет аватара ---
function modalProfile(){
  const wrap=el('div');
  const name=el('input'); name.value=state.me.name; name.placeholder='Имя';
  const bio =el('input'); bio.value=state.me.bio||'';  bio.placeholder='О себе';
  const colors=['#e17076','#eda86c','#a58ac9','#6fb1e0','#7bc862','#6ec9cb','#ee7aae'];
  const pal=el('div'); pal.style.display='flex'; pal.style.gap='8px';
  let chosenColor=state.me.avatar;
  colors.forEach(c=>{const dot=el('div');dot.style.cssText=`width:32px;height:32px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c===chosenColor?'#fff':'transparent'}`;
    dot.onclick=()=>{chosenColor=c;[...pal.children].forEach(d=>d.style.borderColor='transparent');dot.style.borderColor='#fff';};
    pal.appendChild(dot);});
  const btn=el('button','btn-primary','Сохранить');
  wrap.append(name,bio,pal,btn); openModal('Мой профиль (@'+state.me.username+')',wrap);
  btn.onclick=async()=>{
    await API.saveProfile({name:name.value,bio:bio.value,avatar:chosenColor});
    state.me.name=name.value; state.me.bio=bio.value; state.me.avatar=chosenColor;
    $('#modal').classList.add('hidden'); toast('Профиль сохранён'); loadChats();
  };
}

// --- добавить участника в существующую группу ---
function modalAddMember(c){
  const wrap=el('div');
  const search=el('input'); search.placeholder='Имя или @логин';
  const res=el('div'); wrap.append(search,res); openModal('Добавить в «'+c.title+'»',wrap);
  search.oninput=async()=>{
    res.innerHTML=''; const r=await API.searchUsers(search.value.trim());
    const ids=new Set(state.members.map(x=>x.id));
    for(const u of r.users){
      if(ids.has(u.id))continue;
      const it=el('div','chip-pick','<b>'+esc(u.name)+'</b> <span class="sr-sub">@'+esc(u.username)+'</span>');
      it.onclick=async()=>{await API.addMember(c.id,u.id);toast('Добавлен '+u.name);
        const m=await API.members(c.id);state.members=m.members;state.memberKeys=m.member_keys;state.myIndex=m.my_index;};
      res.appendChild(it);
    }
  };
}

/* ==================== 9. WEBSOCKET-СОБЫТИЯ (LIVE) ========================== */
API.on(async ev=>{
  switch(ev.type){
    case 'message': case 'message_edited': {
      const m=ev.message;
      if(state.currentChat&&m.chat_id===state.currentChat.id){
        const exist=state.messages.findIndex(x=>x.id===m.id);
        if(exist>=0)state.messages[exist]=m; else state.messages.push(m);
        await decryptAll([m]);
        renderMessages();
        // сразу отмечаем прочитанным, если чат открыт
        if(ev.type==='message'&&!state.messages.find(x=>x.id===m.id&&x.sender_id===state.me.id))
          API.viewMsg(m.id);
      }
      loadChats();                      // обновим превью/сортировку слева
      break;
    }
    case 'message_deleted':
      if(state.currentChat&&ev.chat_id===state.currentChat.id){
        const m=state.messages.find(x=>x.id===ev.message_id);
        if(m){m.deleted=true;renderMessages();}
      }
      loadChats(); break;
    case 'reactions':
      if(state.currentChat&&ev.chat_id===state.currentChat.id){
        const m=state.messages.find(x=>x.id===ev.message_id);
        if(m){m.reactions=ev.reactions;renderMessages();}
      } break;
    case 'read': {                       // собеседник прочитал -> ✓✓
      if(state.currentChat&&ev.chat_id===state.currentChat.id&&ev.user_id!==state.me.id){
        state.messages.forEach(m=>{if(m.sender_id!==ev.user_id)m.views=(m.views||0)+1;});
        renderMessages();
      }
      loadChats(); break;
    }
    case 'message_viewed':               // кто-то посмотрел конкретное сообщение
      if(state.currentChat&&ev.chat_id===state.currentChat.id){
        const m=state.messages.find(x=>x.id===ev.message_id);
        if(m){m.views=(m.views||0)+1;renderMessages();}
      } break;
    case 'typing':
      if(state.currentChat&&ev.chat_id===state.currentChat.id&&ev.user_id!==state.me.id){
        const t=$('#typing'); t.textContent=ev.user_name+' печатает…'; t.classList.remove('hidden');
        clearTimeout(window._typH); window._typH=setTimeout(()=>t.classList.add('hidden'),2500);
      } break;
    case 'presence':
      ev.online?state.onlineSet.add(ev.user_id):state.onlineSet.delete(ev.user_id);
      renderChatList(); if(state.currentChat)updateChatStatus(); break;
    case 'chat_updated': case 'chat_deleted': case 'service': case 'hello':
      loadChats();
      if(ev.type==='service')toast(ev.text);
      if(ev.type==='chat_deleted'&&state.currentChat&&ev.chat_id===state.currentChat.id)closeChat();
      break;
  }
});

/* ========================== 10. ИНИЦИАЛИЗАЦИЯ ============================== */
async function startApp(){
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  API.wsConnect();                       // live-канал
  await loadChats();                     // список диалогов
}

(async function init(){
  try{
    const r=await API.me();              // есть ли валидная cookie sid?
    state.me=r.user;
    if(!E2EE.hasIdentity()){             // вход с чистого браузера — создадим ключи
      const pub=await E2EE.generateIdentity();
      await API.saveProfile({e2ee_pub:pub});
    }
    startApp();
  }catch(_){
    $('#auth-screen').classList.remove('hidden');   // не авторизован — показываем вход
  }
})();
