/* CipherTalk — расширенные возможности: ответы, пересылка, закрепление,
   реакции, участники, папки, профиль. Подключается после app.js. */

// ==================== СОСТОЯНИЕ ====================
let replyContext = null;      // { messageId, senderName, text }
let activeFolderId = null;    // null = все чаты
let folders = [];             // папки пользователя
let contextMenu = null;
let reactionBar = null;

const REACTION_EMOJI = ['👍', '❤️', '😂', '🔥', '🎉', '😢', '🙏', '👀'];

// ==================== КОНТЕКСТНОЕ МЕНЮ ====================
function closeContextMenu() {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
  if (reactionBar) {
    reactionBar.remove();
    reactionBar = null;
  }
}

function buildContextMenu(buttons, x, y) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  buttons.forEach(btn => {
    if (btn.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const item = document.createElement('button');
    item.className = 'ctx-item' + (btn.danger ? ' danger' : '');
    item.innerHTML = `<span class="ctx-emoji">${btn.emoji}</span><span>${escapeHtml(btn.label)}</span>`;
    item.addEventListener('click', () => {
      closeContextMenu();
      btn.action();
    });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 10);
  const top = Math.min(y, window.innerHeight - rect.height - 10);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  contextMenu = menu;
}

function openReactionBar(msg, x, y) {
  closeContextMenu();
  const bar = document.createElement('div');
  bar.className = 'react-bar';
  REACTION_EMOJI.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'react-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      closeContextMenu();
      sendReaction(msg.id, emoji);
    });
    bar.appendChild(btn);
  });
  document.body.appendChild(bar);
  const rect = bar.getBoundingClientRect();
  bar.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 10)) + 'px';
  bar.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 10)) + 'px';
  reactionBar = bar;
}

async function openMessageContextMenu(msg, x, y) {
  const isOwn = msg.sender_id === currentUser.id;
  const buttons = [];

  buttons.push({
    emoji: '↩️',
    label: I18N.t('msg.reply'),
    action: () => startReply(msg)
  });

  buttons.push({
    emoji: '🔁',
    label: I18N.t('msg.forward'),
    action: () => openForwardModal(msg)
  });

  buttons.push({
    emoji: '😊',
    label: I18N.t('msg.react'),
    action: () => openReactionBar(msg, x, y)
  });

  if (msg.pinned) {
    buttons.push({
      emoji: '📌',
      label: I18N.t('msg.unpin'),
      action: () => togglePin(msg, false)
    });
  } else {
    buttons.push({
      emoji: '📌',
      label: I18N.t('msg.pin'),
      action: () => togglePin(msg, true)
    });
  }

  if (isOwn && (msg.type === 'text' || !msg.type)) {
    buttons.push({ sep: true });
    buttons.push({
      emoji: '✏️',
      label: I18N.t('msg.edit'),
      action: () => editMessage(msg.id)
    });
  }

  if (isOwn) {
    buttons.push({
      emoji: '🗑️',
      label: I18N.t('msg.delete'),
      danger: true,
      action: () => deleteMessage(msg.id)
    });
  }

  buildContextMenu(buttons, x, y);
}

document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.message');
  if (!el || !currentChatId) return;
  const msgId = Number(el.dataset.msgId);
  const msg = (messages[currentChatId] || []).find(m => m.id === msgId);
  if (!msg) return;
  e.preventDefault();
  openMessageContextMenu(msg, e.clientX, e.clientY);
});

// Долгое нажатие (мобильные)
let longPressTimer = null;
document.addEventListener('touchstart', (e) => {
  const el = e.target.closest('.message');
  if (!el || !currentChatId) return;
  const touch = e.touches[0];
  longPressTimer = setTimeout(() => {
    const msgId = Number(el.dataset.msgId);
    const msg = (messages[currentChatId] || []).find(m => m.id === msgId);
    if (msg) openMessageContextMenu(msg, touch.clientX, touch.clientY);
  }, 550);
}, { passive: true });

document.addEventListener('touchend', () => {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
}, { passive: true });

document.addEventListener('click', (e) => {
  if (!e.target.closest('.ctx-menu') && !e.target.closest('.react-bar')) closeContextMenu();
});

// ==================== ОТВЕТ ====================
async function startReply(msg) {
  const chat = getChatById(currentChatId);
  let text = '';
  try {
    const key = await getChatKey(currentChatId, chat);
    text = await decryptChatText(key, msg, currentChatId, msg.sender_id === currentUser.id);
  } catch (e) {
    text = I18N.t('chat.message');
  }
  replyContext = {
    messageId: msg.id,
    senderName: msg.sender_id === currentUser.id ? I18N.t('chat.you') : (msg.sender_name || I18N.t('chat.peer')),
    text: String(text).slice(0, 120)
  };
  renderReplyBar();
  document.getElementById('message-input')?.focus();
}

function cancelReply() {
  replyContext = null;
  renderReplyBar();
}

function renderReplyBar() {
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  if (!replyContext) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const title = document.getElementById('reply-bar-title');
  const text = document.getElementById('reply-bar-text');
  if (title) title.textContent = I18N.t('reply.for', { name: replyContext.senderName });
  if (text) text.textContent = replyContext.text;
}

// ==================== РЕАКЦИИ ====================
function sendReaction(messageId, emoji) {
  const sent = sendWs({
    type: 'react_message',
    chatId: currentChatId,
    messageId,
    reaction: emoji
  });
  if (!sent) return;
  const list = messages[currentChatId] || [];
  const msg = list.find(m => m.id === Number(messageId));
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  const idx = msg.reactions[emoji].indexOf(currentUser.id);
  if (idx >= 0) msg.reactions[emoji].splice(idx, 1);
  else msg.reactions[emoji].push(currentUser.id);
  if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
  renderMessages(currentChatId);
}

// ==================== ЗАКРЕПЛЕНИЕ ====================
function togglePin(msg, pin) {
  const sent = sendWs({
    type: pin ? 'pin_message' : 'unpin_message',
    chatId: currentChatId,
    messageId: msg.id
  });
  if (!sent) return;
  msg.pinned = pin ? 1 : 0;
  renderMessages(currentChatId);
}

async function openPinnedModal() {
  const chat = getChatById(currentChatId);
  const list = (messages[currentChatId] || []).filter(m => m.pinned);
  const key = await safeChatKey(currentChatId, chat);

  const items = [];
  for (const msg of list) {
    let text = I18N.t('chat.notDecrypted');
    try {
      text = await decryptChatText(key, msg, currentChatId, msg.sender_id === currentUser.id);
    } catch (e) { /* ignore */ }
    items.push(`
      <div class="pinned-item">
        <div class="pi-body">
          <div class="pi-author">${escapeHtml(msg.sender_name || getChatName(chat))}</div>
          <div class="pi-text">${escapeHtml(String(text).slice(0, 500))}</div>
          <div class="pi-date">${escapeHtml(formatMessageTime(msg.created_at))}</div>
        </div>
        <button class="mini-btn danger" data-action="unpinFromModal" data-id="${msg.id}">${I18N.t('msg.unpin')}</button>
      </div>`);
  }

  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('pinned.title')}</h2>
    ${items.length ? items.join('') : `<div class="empty-note">${I18N.t('pinned.empty')}</div>`}
  `);
}

function unpinFromModal(messageId) {
  const msg = (messages[currentChatId] || []).find(m => m.id === Number(messageId));
  if (!msg) return;
  togglePin(msg, false);
  openPinnedModal();
}

// ==================== ПЕРЕСЫЛКА ====================
function openForwardModal(msg) {
  const targets = chats.filter(c => c.id !== currentChatId || true);
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('forward.title')}</h2>
    <div id="forward-list">
      ${targets.map(c => `
        <div class="forward-item" data-action="forwardTo" data-id="${c.id}" data-msg="${msg.id}">
          <div class="fi-avatar">${escapeHtml(getChatAvatar(c))}</div>
          <div>
            <div class="fi-name">${escapeHtml(getChatName(c))}</div>
            <div class="fi-sub">${escapeHtml(c.type === 'private' ? I18N.t('forward.private') : (c.type === 'channel' ? I18N.t('forward.channel') : I18N.t('forward.group')))}</div>
          </div>
        </div>`).join('')}
    </div>
  `);
}

async function forwardToChat(msgId, toChatId) {
  const fromChatId = currentChatId;
  const source = getChatById(fromChatId);
  const target = getChatById(toChatId);
  const msg = (messages[fromChatId] || []).find(m => m.id === Number(msgId));
  if (!msg || !target) return;

  try {
    const sourceKey = await getChatKey(fromChatId, source);
    const targetKey = await getChatKey(toChatId, target);

    let content;
    let iv;
    let header;
    let msgType = msg.type;

    if (msg.type === 'text' || !msg.type) {
      const plain = await decryptChatText(sourceKey, msg, fromChatId, msg.sender_id === currentUser.id);
      const envelope = await encryptChatText(targetKey, plain, toChatId);
      content = envelope.content;
      iv = envelope.iv;
      header = envelope.header;
    } else {
      // Медиа: расшифровываем локально и перешифровываем ключом целевого чата
      const plain = await decryptChatText(sourceKey, msg, fromChatId, msg.sender_id === currentUser.id);
      const payload = JSON.parse(plain);
      const res = await fetch(SERVER_URL + payload.url, {
        headers: authToken ? { Authorization: 'Bearer ' + authToken } : {}
      });
      if (!res.ok) throw new Error(I18N.t('err.downloadAttachment'));
      const raw = await res.arrayBuffer();
      const decrypted = await decryptBlob(raw, sourceKey);
      const encrypted = await encryptBlob(decrypted, targetKey);

      const form = new FormData();
      form.append('file', new Blob([encrypted], { type: 'application/octet-stream' }), 'encrypted.bin');
      const uploadRes = await fetch(SERVER_URL + '/api/upload', {
        method: 'POST',
        headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
        body: form
      });
      const uploaded = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok) throw new Error(uploaded.error || I18N.t('err.uploadShort'));

      payload.url = uploaded.url;
      payload.fileId = uploaded.fileId;
      const envelope = await encryptChatText(targetKey, JSON.stringify(payload), toChatId);
      content = envelope.content;
      iv = envelope.iv;
      header = envelope.header;
      msgType = msg.type;
    }

    const sent = sendWs({
      type: 'forward_message',
      fromChatId,
      toChatId,
      messageId: msg.id,
      content,
      iv,
      header,
      msgType
    });
    if (sent) {
      closeModal();
      showToast(I18N.t('forward.done', { name: getChatName(target) }), 'success');
    }
  } catch (err) {
    showToast(I18N.t('forward.failed', { error: err.message }), 'error');
  }
}

async function safeChatKey(chatId, chat) {
  try {
    return await getChatKey(chatId, chat);
  } catch (e) {
    return null;
  }
}

// ==================== ПАПКИ ====================
function setFolders(list) {
  folders = Array.isArray(list) ? list : [];
  renderFolderBar();
}

function renderFolderBar() {
  const bar = document.getElementById('folder-bar');
  if (!bar) return;
  const counts = {};
  folders.forEach(f => (f.chat_ids || []).forEach(id => { counts[id] = (counts[id] || 0) + 1; }));

  bar.innerHTML = `
    <button class="folder-chip ${activeFolderId === null ? 'active' : ''}" data-action="filterFolder" data-id="">${I18N.t('folder.all')}</button>
    ${folders.map(f => `
      <button class="folder-chip ${activeFolderId === Number(f.id) ? 'active' : ''}" data-action="filterFolder" data-id="${f.id}">
        <span>${escapeHtml(f.emoji || '📁')}</span>
        <span>${escapeHtml(f.name)}</span>
        <span class="fcount">${(f.chat_ids || []).length}</span>
      </button>`).join('')}
    <button class="folder-chip add" data-action="createFolder">${I18N.t('folder.add')}</button>`;
}

function filterFolder(folderId) {
  activeFolderId = folderId === '' || folderId === null ? null : Number(folderId);
  renderFolderBar();
  renderChatList(document.getElementById('sidebar-search')?.value || '');
}

function openCreateFolder() {
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('folder.new.title')}</h2>
    <div class="input-group">
      <label>${I18N.t('folder.name')}</label>
      <input type="text" id="folder-name-input" placeholder="${I18N.t('folder.placeholder')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('folder.icon')}</label>
      <input type="text" id="folder-emoji-input" placeholder="📁" maxlength="4" value="📁">
    </div>
    <button class="btn" data-action="createFolderSubmit">${I18N.t('folder.create')}</button>
  `);
}

function createFolderSubmit() {
  const name = document.getElementById('folder-name-input')?.value.trim();
  const emoji = document.getElementById('folder-emoji-input')?.value.trim() || '📁';
  if (!name) {
    showToast(I18N.t('err.folderName'), 'error');
    return;
  }
  const sent = sendWs({ type: 'create_folder', name, emoji });
  if (sent) {
    closeModal();
    showToast(I18N.t('folder.created'), 'success');
  }
}

function deleteFolder(folderId) {
  if (!confirm(I18N.t('folder.deleteConfirm'))) return;
  sendWs({ type: 'delete_folder', id: Number(folderId) });
}

function openFolderAssignModal(chatId) {
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('folder.assign.title')}</h2>
    <div class="forward-item" data-action="assignFolder" data-chat="${chatId}" data-id="">
      <div class="fi-avatar">💬</div><div><div class="fi-name">${I18N.t('folder.none')}</div></div>
    </div>
    ${folders.map(f => `
      <div class="forward-item" data-action="assignFolder" data-chat="${chatId}" data-id="${f.id}">
        <div class="fi-avatar">${escapeHtml(f.emoji || '📁')}</div>
        <div><div class="fi-name">${escapeHtml(f.name)}</div></div>
      </div>`).join('')}
  `);
}

function assignFolder(chatId, folderId) {
  const id = folderId === '' ? null : Number(folderId);
  sendWs({ type: 'set_chat_folder', chatId: Number(chatId), folderId: id });
  closeModal();
}

// ==================== УЧАСТНИКИ ====================
async function openAddMemberModal() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('member.add.title')}</h2>
    <div class="input-group">
      <label>${I18N.t('member.search')}</label>
      <input type="text" id="member-search-input" placeholder="${I18N.t('member.searchPlaceholder')}" data-action="memberSearch">
    </div>
    <div id="member-search-results"></div>
  `);
}

async function memberSearch(query) {
  const box = document.getElementById('member-search-results');
  if (!box) return;
  const q = query.trim();
  if (!q) {
    box.innerHTML = '';
    return;
  }
  try {
    const res = await api('/api/search-users?query=' + encodeURIComponent(q));
    const users = (Array.isArray(res.data) ? res.data : []).filter(u => u.id !== currentUser.id);
    box.innerHTML = users.length ? users.map(u => `
      <div class="forward-item" data-action="addMemberToChat" data-id="${u.id}">
        <div class="fi-avatar">${escapeHtml((u.name || '?')[0].toUpperCase())}</div>
        <div>
          <div class="fi-name">${escapeHtml(u.name || '')}</div>
          <div class="fi-sub">@${escapeHtml(u.username || '')}</div>
        </div>
      </div>`).join('') : `<div class="empty-note">${I18N.t('member.notFound')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-note">${I18N.t('member.searchError')}</div>`;
  }
}

async function addMemberToChat(userId) {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  const member = chat.members?.find(m => m.id === Number(userId));
  const sent = sendWs({ type: 'add_member', chatId: currentChatId, userId: Number(userId) });
  if (!sent) return;
  closeModal();

  // Ждём обновления состава и делимся ключом группы с новым участником
  setTimeout(async () => {
    try {
      const updated = getChatById(currentChatId);
      const newMember = updated?.members?.find(m => m.id === Number(userId));
      if (newMember && updated.type !== 'private' && updated.type !== 'saved') {
        if (!newMember.public_key) {
          const key = await waitForPublicKey(Number(userId)).catch(() => null);
          if (key) newMember.public_key = key;
        }
        if (newMember.public_key) {
          await shareGroupKeyWithMember(updated, newMember);
        }
      }
    } catch (e) { /* не критично */ }
  }, 700);
}

function changeMemberRole(userId, role) {
  sendWs({ type: 'set_role', chatId: currentChatId, userId: Number(userId), role });
}

function removeMemberFromChat(userId) {
  if (!confirm(I18N.t('chatinfo.removeConfirm'))) return;
  sendWs({ type: 'remove_member', chatId: currentChatId, userId: Number(userId) });
}

function leaveChat() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  if (!confirm(I18N.t('chatinfo.leaveConfirm', { name: getChatName(chat) }))) return;
  sendWs({ type: 'remove_member', chatId: currentChatId, userId: currentUser.id });
  closeModal();
  closeChat();
}

function roleLabel(role) {
  if (role === 'owner') return I18N.t('role.owner');
  if (role === 'admin') return I18N.t('role.admin');
  return I18N.t('role.member');
}

// Расширенная информация о чате
async function showChatInfoFull() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  const isGroup = chat.type !== 'private' && chat.type !== 'saved';
  const key = await safeChatKey(currentChatId, chat);

  const members = (chat.members || []).map(m => {
    const online = onlineUsers.has(m.id);
    const canManage = isGroup && (chat.owner_id === currentUser.id || chat.role === 'owner' || chat.role === 'admin');
    return `
      <div class="member-row">
        <div class="member-avatar">${escapeHtml((m.name || '?')[0].toUpperCase())}${online ? '<span class="dot"></span>' : ''}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.name || I18N.t('chat.user'))}</div>
          <div class="member-sub">@${escapeHtml(m.username || '')} ${m.public_key ? '· ' + I18N.t('chatinfo.hasKey') : '· ' + I18N.t('chatinfo.noKey')}</div>
        </div>
        ${isGroup ? `<span class="member-role ${m.role || 'member'}">${escapeHtml(roleLabel(m.role))}</span>` : ''}
        ${canManage && m.id !== currentUser.id ? `
          <div class="member-actions">
            <button class="mini-btn" data-action="toggleRole" data-id="${m.id}" data-role="${m.role || 'member'}">
              ${m.role === 'admin' ? I18N.t('chatinfo.removeAdmin') : I18N.t('chatinfo.makeAdmin')}
            </button>
            <button class="mini-btn danger" data-action="removeMember" data-id="${m.id}">${I18N.t('msg.delete')}</button>
          </div>` : ''}
      </div>`;
  }).join('');

  const pinned = (messages[currentChatId] || []).filter(m => m.pinned).length;
  const folder = folders.find(f => (f.chat_ids || []).includes(currentChatId));

  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <div style="text-align:center;margin-bottom:14px;">
      <div class="chat-avatar" style="width:72px;height:72px;font-size:28px;margin:0 auto 10px;">${escapeHtml(getChatAvatar(chat))}</div>
      <div class="encryption-badge">🔒 E2EE · AES-256-GCM</div>
    </div>

    <div class="section-title">${I18N.t('chatinfo.members', { count: (chat.members || []).length })}</div>
    ${members || `<div class="empty-note">${I18N.t('chatinfo.none')}</div>`}
    ${isGroup ? `<button class="btn btn-secondary" style="margin-top:10px;width:100%" data-action="openAddMember">${I18N.t('chatinfo.addMember')}</button>` : ''}

    <div class="section-title">${I18N.t('chatinfo.actions')}</div>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button class="mini-btn" data-action="openPinnedModal">${I18N.t('chatinfo.pinned', { count: pinned })}</button>
      <button class="mini-btn" data-action="openFolderAssign" data-id="${currentChatId}">${I18N.t('chatinfo.folder', { name: escapeHtml(folder ? folder.name : I18N.t('chatinfo.folderNone')) })}</button>
      ${isGroup ? `<button class="mini-btn danger" data-action="leaveChat">${I18N.t('chatinfo.leave')}</button>` : ''}
    </div>
  `);
}

// ==================== ПРОФИЛЬ ====================
function openProfileEditor() {
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${I18N.t('profile.title')}</h2>
    <div style="text-align:center;margin-bottom:14px;">
      <img id="profile-avatar-preview" src="${escapeHtml(currentUser.avatar || '')}"
           style="width:96px;height:96px;border-radius:50%;object-fit:cover;background:var(--bg-message-in)" alt="avatar">
      <div style="margin-top:8px">
        <button class="mini-btn" data-action="pickAvatar">${I18N.t('profile.photo')}</button>
      </div>
      <input type="file" id="avatar-file-input" accept="image/*" style="display:none" data-action="uploadAvatar">
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.firstname')}</label>
      <input type="text" id="profile-firstname" value="${escapeHtml(currentUser.firstName || '')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.lastname')}</label>
      <input type="text" id="profile-lastname" value="${escapeHtml(currentUser.lastName || '')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.username')}</label>
      <input type="text" id="profile-username" value="${escapeHtml(currentUser.username || '')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.email')}</label>
      <input type="email" id="profile-email" value="${escapeHtml(currentUser.email || '')}" placeholder="you@example.com">
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.bio')}</label>
      <textarea id="profile-bio" rows="3" placeholder="${I18N.t('profile.bioPlaceholder')}">${escapeHtml(currentUser.bio || '')}</textarea>
    </div>
    <button class="btn" data-action="saveProfile">${I18N.t('profile.save')}</button>
  `);
}

function pickAvatar() {
  document.getElementById('avatar-file-input')?.click();
}

async function uploadAvatar(el) {
  const file = el.files && el.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    showToast(I18N.t('profile.tooBig'), 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const preview = document.getElementById('profile-avatar-preview');
    if (preview) preview.src = reader.result;
    const res = await api('/api/update-profile', { method: 'POST', body: { avatar: reader.result } });
    if (res.ok) {
      const user = res.data?.user || res.data;
      if (user) {
        currentUser = normalizeUser(user);
        localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
      }
      updateUserUI();
      showToast(I18N.t('profile.photoSaved'), 'success');
    } else {
      showToast(res.error || I18N.t('profile.uploadFailed'), 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function saveProfile() {
  const payload = {
    firstName: document.getElementById('profile-firstname')?.value.trim(),
    lastName: document.getElementById('profile-lastname')?.value.trim(),
    username: document.getElementById('profile-username')?.value.trim().replace(/^@/, ''),
    email: document.getElementById('profile-email')?.value.trim(),
    bio: document.getElementById('profile-bio')?.value.trim()
  };
  const res = await api('/api/update-profile', { method: 'POST', body: payload });
  if (res.ok && res.data) {
    currentUser = normalizeUser(res.data.user || res.data);
    localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
    updateUserUI();
    closeModal();
    showToast(I18N.t('profile.saved'), 'success');
  } else {
    showToast(res.error || I18N.t('err.save'), 'error');
  }
}

// ==================== РЕГИСТРАЦИЯ ДЕЙСТВИЙ ====================
Object.assign(CLICK_ACTIONS, {
  cancelReply: () => cancelReply(),
  openPinnedModal: () => openPinnedModal(),
  unpinFromModal: (el) => unpinFromModal(parseInt(el.dataset.id, 10)),
  forwardTo: (el) => forwardToChat(parseInt(el.dataset.msg, 10), parseInt(el.dataset.id, 10)),
  filterFolder: (el) => filterFolder(el.dataset.id),
  createFolder: () => openCreateFolder(),
  createFolderSubmit: () => createFolderSubmit(),
  assignFolder: (el) => assignFolder(parseInt(el.dataset.chat, 10), el.dataset.id),
  openFolderAssign: (el) => openFolderAssignModal(parseInt(el.dataset.id, 10)),
  showChatInfo: () => showChatInfoFull(),
  openAddMember: () => openAddMemberModal(),
  addMemberToChat: (el) => addMemberToChat(parseInt(el.dataset.id, 10)),
  toggleRole: (el) => changeMemberRole(parseInt(el.dataset.id, 10), el.dataset.role === 'admin' ? 'member' : 'admin'),
  removeMember: (el) => removeMemberFromChat(parseInt(el.dataset.id, 10)),
  leaveChat: () => leaveChat(),
  openProfileEditor: () => openProfileEditor(),
  pickAvatar: () => pickAvatar(),
  saveProfile: () => saveProfile()
});

Object.assign(INPUT_ACTIONS, {
  memberSearch: (el) => memberSearch(el.value)
});

Object.assign(CHANGE_ACTIONS, {
  uploadAvatar: (el) => uploadAvatar(el)
});
