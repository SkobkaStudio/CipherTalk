// =============================================================================
//  api.js — сетевой слой: REST-запросы к серверу + WebSocket-события
// =============================================================================
//  Здесь НЕТ логики чатов — только «сходить на сервер и вернуть JSON».
//  Все запросы идут с cookie sid (браузер добавляет сам, credentials:'include').
//  WS-соединение одно на всё приложение; события рассылаются подписчикам.
// =============================================================================

const API = (() => {
  const BASE = '';                        // тот же origin, что и страница

  // ---------- базовая обёртка fetch ----------
  async function req(method, path, body) {
    const opt = { method, credentials:'same-origin', headers:{} };
    if (body !== undefined) {
      if (body instanceof FormData) opt.body = body;             // multipart (файлы)
      else { opt.headers['Content-Type']='application/json';
             opt.body = JSON.stringify(body); }
    }
    const r = await fetch(BASE+path, opt);
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j.error || ('HTTP '+r.status));
    return j;
  }

  // ---------- AUTH ----------
  const register = (username,password,name,e2ee_pub) =>
      req('POST','/api/register',{username,password,name,e2ee_pub});
  const login    = (username,password) => req('POST','/api/login',{username,password});
  const logout   = () => req('POST','/api/logout',{});
  const me       = () => req('GET','/api/me');
  const saveProfile = data => req('POST','/api/profile',data);

  // ---------- ЧАТЫ ----------
  const chats        = () => req('GET','/api/chats');
  const openPrivate  = user_id => req('POST','/api/chats/private',{user_id});
  const createGroup  = (title,about,user_ids) => req('POST','/api/chats/group',{title,about,user_ids});
  const createChannel= (title,about) => req('POST','/api/chats/channel',{title,about});
  const joinChat     = invite => req('POST','/api/chats/join',{invite});
  const members      = chat_id => req('GET','/api/chats/members?chat_id='+chat_id);
  const addMember    = (chat_id,user_id) => req('POST','/api/chats/add-member',{chat_id,user_id});
  const removeMember = (chat_id,user_id) => req('POST','/api/chats/remove-member',{chat_id,user_id});
  const setRole      = (chat_id,user_id,role) => req('POST','/api/chats/set-role',{chat_id,user_id,role});
  const updateChat   = (chat_id,title,about) => req('POST','/api/chats/update',{chat_id,title,about});
  const deleteChat   = chat_id => req('POST','/api/chats/delete',{chat_id});
  const markRead     = chat_id => req('POST','/api/chats/read',{chat_id});
  const pinnedList   = chat_id => req('GET','/api/chats/pinned?chat_id='+chat_id);
  const pin          = (chat_id,message_id) => req('POST','/api/chats/pin',{chat_id,message_id});
  const unpin        = (chat_id,message_id) => req('POST','/api/chats/unpin',{chat_id,message_id});

  // ---------- ЛЮДИ / КОНТАКТЫ ----------
  const searchUsers  = q => req('GET','/api/users/search?q='+encodeURIComponent(q));
  const contacts     = () => req('GET','/api/contacts');
  const addContact   = user_id => req('POST','/api/contacts/add',{user_id});

  // ---------- СООБЩЕНИЯ ----------
  const history = (chat_id,before_id=0,limit=50) =>
      req('GET',`/api/messages?chat_id=${chat_id}&before_id=${before_id}&limit=${limit}`);
  const send    = (chat_id,content,reply_to=0,content_type='encrypted') =>
      req('POST','/api/messages/send',{chat_id,content,reply_to,content_type});
  const editMsg = (message_id,content) => req('POST','/api/messages/edit',{message_id,content});
  const delMsg  = message_id => req('POST','/api/messages/delete',{message_id});
  const react   = (message_id,emoji) => req('POST','/api/messages/react',{message_id,emoji});
  const viewMsg = message_id => req('POST','/api/messages/view',{message_id});

  // ---------- ФАЙЛЫ ----------
  // chat_id, reply_to, file (Blob), meta — уже зашифрованный контейнер с именем файла
  function upload(chat_id, file, meta, reply_to=0) {
    const fd = new FormData();
    fd.append('chat_id', chat_id);
    fd.append('reply_to', reply_to);
    fd.append('meta', meta);
    fd.append('file', file, file.name);
    return req('POST','/api/upload',fd);
  }

  // ============================ WEBSOCKET =====================================
  let ws = null, listeners = [], reconnectT = null, typingTimer = null;

  function wsConnect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen   = () => emit({type:'_ws_open'});
    ws.onmessage= e => { try { emit(JSON.parse(e.data)); } catch(_){} };
    ws.onclose  = () => { emit({type:'_ws_close'});
                          // переподключение через 2 секунды (устойчивость к рестарту сервера)
                          clearTimeout(reconnectT); reconnectT=setTimeout(wsConnect,2000); };
  }
  function on(fn){ listeners.push(fn); }              // подписка на WS-события
  function emit(ev){ listeners.forEach(f=>{try{f(ev)}catch(e){console.error(e)}}); }
  function sendRaw(obj){ if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  // «печатает…» — не чаще одного раза в 3 секунды
  function notifyTyping(chat_id){
    if (typingTimer) return;
    sendRaw({type:'typing',chat_id});
    typingTimer = setTimeout(()=>{typingTimer=null;},3000);
  }
  // «прочитано» через WS — мгновенные ✓✓
  function notifyRead(chat_id){ sendRaw({type:'read',chat_id}); }

  return { register,login,logout,me,saveProfile,
           chats,openPrivate,createGroup,createChannel,joinChat,members,
           addMember,removeMember,setRole,updateChat,deleteChat,markRead,
           pinnedList,pin,unpin,searchUsers,contacts,addContact,
           history,send,editMsg,delMsg,react,viewMsg,upload,
           wsConnect,on,sendRaw,notifyTyping,notifyRead };
})();
