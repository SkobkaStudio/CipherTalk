/* CipherTalk — WebRTC аудио/видеозвонки.
   Сервер пересылает только SDP/ICE; медиа идёт P2P и шифруется DTLS-SRTP. */

// ICE-серверы по умолчанию. Сервер может отдать свои (STUN + TURN) через
// /api/ice-servers — тогда используются они, в т.ч. с одноразовыми
// учётными данными TURN (пароль TURN-сервера клиенту не передаётся).
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];
let CALL_ICE_SERVERS = DEFAULT_ICE_SERVERS;
let iceServersPromise = null;

async function loadIceServers() {
  if (iceServersPromise) return iceServersPromise;
  iceServersPromise = (async () => {
    try {
      const headers = { Accept: 'application/json' };
      if (typeof authToken !== 'undefined' && authToken) headers.Authorization = 'Bearer ' + authToken;
      const res = await fetch('/api/ice-servers', { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        CALL_ICE_SERVERS = data.iceServers;
      }
    } catch (e) {
      // Остаёмся на публичных STUN по умолчанию
    }
  })();
  return iceServersPromise;
}

let callState = null;
let callRingCtx = null;
let callRingTimer = null;

function newCallId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function callT(key, vars) {
  return I18N.t('call.' + key, vars);
}

function ensureCallUI() {
  if (document.getElementById('call-overlay')) return;
  const el = document.createElement('div');
  el.id = 'call-overlay';
  el.className = 'call-overlay';
  el.innerHTML = `
    <div class="call-card">
      <video id="call-remote" autoplay playsinline></video>
      <video id="call-local" autoplay playsinline muted></video>
      <div class="call-glow"></div>
      <div class="call-top">
        <div class="call-avatar" id="call-avatar">${Icons.svg('phone', { className: 'mq-icon--lg' })}</div>
        <div class="call-name" id="call-name"></div>
        <div class="call-status" id="call-status"></div>
      </div>
      <div class="call-actions">
        <button class="call-btn-circle" id="call-mute-btn" data-action="toggleCallMute" title="${callT('mic')}">${Icons.svg('mic', { className: 'mq-icon--md' })}</button>
        <button class="call-btn-circle" id="call-cam-btn" data-action="toggleCallCamera" title="${callT('cam')}">${Icons.svg('camera', { className: 'mq-icon--md' })}</button>
        <button class="call-btn-circle accept" id="call-accept-btn" data-action="acceptCall" title="${callT('accept')}">${Icons.svg('phone', { className: 'mq-icon--md' })}</button>
        <button class="call-btn-circle danger" id="call-end-btn" data-action="endCall" title="${callT('end')}">${Icons.svg('camera-off', { className: 'mq-icon--md' })}</button>
      </div>
    </div>`;
  document.body.appendChild(el);
}

function callUi() {
  ensureCallUI();
  return {
    overlay: document.getElementById('call-overlay'),
    remote: document.getElementById('call-remote'),
    local: document.getElementById('call-local'),
    avatar: document.getElementById('call-avatar'),
    name: document.getElementById('call-name'),
    status: document.getElementById('call-status'),
    mute: document.getElementById('call-mute-btn'),
    cam: document.getElementById('call-cam-btn'),
    accept: document.getElementById('call-accept-btn'),
    end: document.getElementById('call-end-btn')
  };
}

function setCallStatus(text) {
  const ui = callUi();
  ui.status.textContent = text || '';
}

function showCallOverlay(mode) {
  const ui = callUi();
  ui.overlay.className = 'call-overlay show ' + (mode || '');
  ui.accept.style.display = mode === 'incoming' ? '' : 'none';
  ui.mute.style.display = mode === 'incoming' ? 'none' : '';
  ui.cam.style.display = mode === 'incoming' ? 'none' : '';
  ui.local.style.display = (callState && callState.type === 'video' && mode !== 'incoming') ? '' : 'none';
}

function hideCallOverlay() {
  const el = document.getElementById('call-overlay');
  if (el) el.className = 'call-overlay';
  const remote = document.getElementById('call-remote');
  const local = document.getElementById('call-local');
  if (remote) remote.srcObject = null;
  if (local) local.srcObject = null;
}

function startCallTimer() {
  if (!callState || callState.timer) return;
  callState.connectedAt = Date.now();
  callState.timer = setInterval(() => {
    if (!callState) return;
    const sec = Math.floor((Date.now() - callState.connectedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    setCallStatus(mm + ':' + ss);
  }, 500);
}

function stopCallTimer() {
  if (callState && callState.timer) clearInterval(callState.timer);
  if (callState) callState.timer = null;
}

function playRing() {
  stopRing();
  try {
    callRingCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!callRingCtx) return;
      const osc = callRingCtx.createOscillator();
      const gain = callRingCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, callRingCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, callRingCtx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, callRingCtx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(callRingCtx.destination);
      osc.start();
      osc.stop(callRingCtx.currentTime + 0.5);
    };
    beep();
    callRingTimer = setInterval(beep, 1100);
  } catch (e) { /* звук не критичен */ }
}

function stopRing() {
  if (callRingTimer) clearInterval(callRingTimer);
  callRingTimer = null;
  if (callRingCtx) {
    try { callRingCtx.close(); } catch (e) { /* ignore */ }
  }
  callRingCtx = null;
}

async function getCallMedia(type) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(callT('notSupported'));
  }
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function attachLocalMedia(stream) {
  const ui = callUi();
  ui.local.srcObject = stream;
  ui.local.muted = true;
  if (callState && callState.type === 'video') ui.local.style.display = '';
}

async function createCallPeer(peerId, callId, type) {
  await loadIceServers();
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate && callState && callState.callId === callId) {
      sendWs({
        type: 'call_ice',
        targetUserId: peerId,
        callId,
        candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate
      });
    }
  };
  pc.ontrack = (e) => {
    const ui = callUi();
    ui.remote.srcObject = e.streams[0];
    if (type === 'video') ui.remote.style.display = '';
  };
  pc.onconnectionstatechange = () => {
    if (!callState || callState.callId !== callId) return;
    if (pc.connectionState === 'connected') {
      setCallStatus(callT('connected'));
      startCallTimer();
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      endCall(false, 'connection');
    } else if (pc.connectionState === 'disconnected') {
      setCallStatus(callT('reconnecting'));
    }
  };
  return pc;
}

async function flushPendingIce() {
  if (!callState || !callState.pc || !callState.pc.remoteDescription) return;
  const list = callState.pendingCandidates || [];
  callState.pendingCandidates = [];
  for (const candidate of list) {
    try { await callState.pc.addIceCandidate(candidate); } catch (e) { /* ignore */ }
  }
}

function cleanupCall(sendSignal, reason) {
  stopRing();
  stopCallTimer();
  if (callState) {
    if (callState.timeout) clearTimeout(callState.timeout);
    if (callState.localStream) {
      callState.localStream.getTracks().forEach(t => t.stop());
    }
    if (callState.pc) {
      try { callState.pc.close(); } catch (e) { /* ignore */ }
    }
    if (sendSignal && callState.peerId) {
      sendWs({
        type: 'call_end',
        targetUserId: callState.peerId,
        callId: callState.callId,
        reason: reason || 'ended'
      });
    }
  }
  callState = null;
  hideCallOverlay();
}

function getCallPeer(chat) {
  if (!chat || chat.type !== 'private') return null;
  return (chat.members || []).find(m => m.id !== currentUser.id) || null;
}

async function startCall(type) {
  if (callState) {
    showToast(callT('busy'), 'error');
    return;
  }
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }
  const chat = getChatById(currentChatId);
  const peer = getCallPeer(chat);
  if (!peer) {
    showToast(callT('onlyPrivate'), 'error');
    return;
  }
  const callId = newCallId();
  callState = {
    callId,
    peerId: peer.id,
    type,
    role: 'caller',
    pc: null,
    localStream: null,
    pendingCandidates: [],
    timer: null,
    timeout: null,
    connectedAt: 0,
    muted: false,
    camOff: false
  };
  const ui = callUi();
  ui.name.textContent = peer.name || peer.username || getChatName(chat);
  ui.avatar.textContent = (peer.name || '?')[0].toUpperCase();
  ui.overlay.classList.toggle('audio', type !== 'video');
  ui.remote.style.display = type === 'video' ? '' : 'none';
  showCallOverlay('outgoing');
  setCallStatus(callT('calling'));
  callState.timeout = setTimeout(() => {
    if (!callState || callState.callId !== callId) return;
    if (callState.pc && callState.pc.remoteDescription) return;
    showToast(callT('noAnswer'), 'error');
    cleanupCall(true, 'timeout');
  }, 45000);

  try {
    const stream = await getCallMedia(type);
    if (!callState || callState.callId !== callId) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    callState.localStream = stream;
    attachLocalMedia(stream);
    const pc = await createCallPeer(peer.id, callId, type);
    callState.pc = pc;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sent = sendWs({
      type: 'call_offer',
      targetUserId: peer.id,
      callId,
      callType: type,
      sdp: offer.sdp
    });
    if (!sent) cleanupCall(false);
  } catch (err) {
    showToast(callT('mediaError') + (err && err.message ? ' ' + err.message : ''), 'error');
    cleanupCall(false);
  }
}

function handleCallRinging(msg) {
  if (callState && callState.callId === msg.callId && callState.role === 'caller') {
    setCallStatus(callT('ringing'));
  }
}

function handleCallOffer(msg) {
  if (callState) {
    sendWs({
      type: 'call_reject',
      targetUserId: msg.fromUserId,
      callId: msg.callId,
      reason: 'busy'
    });
    return;
  }
  callState = {
    callId: msg.callId,
    peerId: msg.fromUserId,
    type: msg.callType === 'video' ? 'video' : 'audio',
    role: 'callee',
    offerSdp: msg.sdp,
    callerName: msg.fromName || '',
    pc: null,
    localStream: null,
    pendingCandidates: [],
    timer: null,
    muted: false,
    camOff: false
  };
  const ui = callUi();
  ui.name.textContent = msg.fromName || I18N.t('chat.peer');
  ui.avatar.textContent = (msg.fromName || '?')[0].toUpperCase();
  ui.overlay.classList.toggle('audio', callState.type !== 'video');
  ui.remote.style.display = callState.type === 'video' ? '' : 'none';
  showCallOverlay('incoming');
  setCallStatus(callState.type === 'video' ? callT('incomingVideo') : callT('incomingAudio'));
  playRing();
}

async function acceptCall() {
  if (!callState || callState.role !== 'callee' || !callState.offerSdp) return;
  const state = callState;
  stopRing();
  setCallStatus(callT('connecting'));
  showCallOverlay('active');
  try {
    const stream = await getCallMedia(state.type);
    if (!callState || callState.callId !== state.callId) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    state.localStream = stream;
    attachLocalMedia(stream);
    const pc = await createCallPeer(state.peerId, state.callId, state.type);
    state.pc = pc;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    await pc.setRemoteDescription({ type: 'offer', sdp: state.offerSdp });
    await flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({
      type: 'call_answer',
      targetUserId: state.peerId,
      callId: state.callId,
      sdp: answer.sdp
    });
  } catch (err) {
    showToast(callT('mediaError') + (err && err.message ? ' ' + err.message : ''), 'error');
    rejectCall('media_error');
  }
}

async function handleCallAnswer(msg) {
  if (!callState || msg.callId !== callState.callId || !callState.pc) return;
  if (callState.timeout) {
    clearTimeout(callState.timeout);
    callState.timeout = null;
  }
  try {
    await callState.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    await flushPendingIce();
    setCallStatus(callT('connecting'));
  } catch (e) {
    showToast(callT('failed'), 'error');
    cleanupCall(true, 'failed');
  }
}

async function handleCallIce(msg) {
  if (!callState || msg.callId !== callState.callId || !msg.candidate) return;
  if (callState.pc && callState.pc.remoteDescription) {
    try { await callState.pc.addIceCandidate(msg.candidate); } catch (e) { /* ignore */ }
  } else {
    callState.pendingCandidates.push(msg.candidate);
  }
}

function handleCallReject(msg) {
  if (!callState || msg.callId !== callState.callId) return;
  cleanupCall(false);
  showToast(msg.reason === 'busy' ? callT('busy') : callT('rejected'), 'error');
}

function handleCallEnd(msg) {
  if (!callState || msg.callId !== callState.callId) return;
  cleanupCall(false);
  showToast(callT('ended'), 'info');
}

function handleCallUnavailable(msg) {
  if (!callState || msg.callId !== callState.callId) return;
  cleanupCall(false);
  showToast(msg.reason === 'busy' ? callT('busy') : callT('offline'), 'error');
}

function endCall(fromRemote, reason) {
  if (!callState) return;
  const wasIncoming = callState.role === 'callee' && !callState.pc;
  if (wasIncoming) {
    rejectCall('rejected');
    return;
  }
  cleanupCall(!fromRemote, reason || 'ended');
}

function rejectCall(reason) {
  if (!callState) return;
  const state = callState;
  if (state.peerId) {
    sendWs({
      type: 'call_reject',
      targetUserId: state.peerId,
      callId: state.callId,
      reason: reason || 'rejected'
    });
  }
  cleanupCall(false);
}

function toggleCallMute() {
  if (!callState || !callState.localStream) return;
  const track = callState.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  callState.muted = !track.enabled;
  const ui = callUi();
  ui.mute.classList.toggle('off', callState.muted);
  ui.mute.innerHTML = callState.muted ? Icons.svg('mic-off', { className: 'mq-icon--md' }) : Icons.svg('mic', { className: 'mq-icon--md' });
}

function toggleCallCamera() {
  if (!callState || !callState.localStream) return;
  const track = callState.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  callState.camOff = !track.enabled;
  const ui = callUi();
  ui.cam.classList.toggle('off', callState.camOff);
  ui.cam.innerHTML = callState.camOff ? Icons.svg('camera-off', { className: 'mq-icon--md' }) : Icons.svg('camera', { className: 'mq-icon--md' });
  ui.local.style.opacity = callState.camOff ? '0' : '1';
}

if (typeof CLICK_ACTIONS !== 'undefined') {
  Object.assign(CLICK_ACTIONS, {
    startAudioCall: () => startCall('audio'),
    startVideoCall: () => startCall('video'),
    acceptCall: () => acceptCall(),
    endCall: () => endCall(false, 'ended'),
    toggleCallMute: () => toggleCallMute(),
    toggleCallCamera: () => toggleCallCamera()
  });
}
