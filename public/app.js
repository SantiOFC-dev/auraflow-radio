/**
 * PTT + GPS v3.0 AuraFlow Radio — Tactical Walkie-Talkie & Real-Time GPS Radar Client
 * Author: Ing. Santiago Delgado Leiva · AuraFlow Tech Costa Rica (radio.auraflowtech.lat)
 */

const state = {
  token: localStorage.getItem('auraflow_radio_token') || '',
  loggedOutManually: localStorage.getItem('auraflow_radio_logged_out') === '1',
  user: null,
  activeChannel: {
    code: 'CH-01',
    name: 'General / Lobby',
    frequency_mhz: '462.5625 MHz',
    mode: 'MODO: VHF FILTRADO',
    is_private: false
  },
  channels: [],
  operators: [],
  transmissions: [],
  vhfFilterOn: true,
  rogerBeepOn: true,
  echoModeOn: false,
  handsFreeLocked: false,
  gpsActive: false,
  gpsWatching: false,
  gpsWatchId: null,
  mapPickMode: false,
  currentMapLayer: 'satellite',
  tileLayer: null,
  labelLayer: null,
  isTransmitting: false,
  txStartTime: 0,
  txTimerInterval: null,
  vuInterval: null,
  mediaStream: null,
  mediaRecorder: null,
  micAnalyser: null,
  audioChunks: [],
  audioCtx: null,
  sse: null,
  map: null,
  markers: {},
  accuracyCircles: {},
  incomingCall: null
};

// ============================================================================
// 1. Web Audio API Tactical Radio Synthesizer & VHF Voice Filter
// ============================================================================
function getAudioContext() {
  if (!state.audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      state.audioCtx = new AudioCtx();
    }
  }
  if (state.audioCtx && (state.audioCtx.state === 'suspended' || state.audioCtx.state === 'interrupted')) {
    state.audioCtx.resume().catch(() => {});
  }
  return state.audioCtx;
}

function getSharedAudioElement() {
  if (!state.sharedAudioEl) {
    const el = new Audio();
    el.setAttribute('playsinline', '');
    el.playsInline = true;
    el.preload = 'auto';
    state.sharedAudioEl = el;
  }
  return state.sharedAudioEl;
}

function unlockAudioSession() {
  const ctx = getAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
    }
    if (!state.audioCtxUnlocked) {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0);
        state.audioCtxUnlocked = true;
      } catch {}
    }
  }
  const el = getSharedAudioElement();
  if (el && !state.sharedAudioUnlocked) {
    state.sharedAudioUnlocked = true;
    el.muted = true;
    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    el.play().then(() => {
      el.pause();
      el.muted = false;
    }).catch(() => {
      el.muted = false;
      state.sharedAudioUnlocked = false;
    });
  }
}

function setupAudioUnlockListeners() {
  const unlock = () => unlockAudioSession();
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

function playPttStartChirp() {
  if (!state.rogerBeepOn) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1550, now);
  osc.frequency.setValueAtTime(2050, now + 0.045);

  gain.gain.setValueAtTime(0.14, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.095);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

function playCallAlertTone() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const freqs = [1200, 1800, 1200, 1800, 2200];
  freqs.forEach((f, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, now + idx * 0.07);
    gain.gain.setValueAtTime(0.1, now + idx * 0.07);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (idx + 1) * 0.068);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + idx * 0.07);
    osc.stop(now + (idx + 1) * 0.07);
  });
}

function playRogerBeepAndSquelch() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  if (state.rogerBeepOn) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1850, now);
    osc.frequency.setValueAtTime(1480, now + 0.06);
    osc.frequency.setValueAtTime(2150, now + 0.12);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.21);
  }

  // Short VHF white-noise squelch tail
  if (state.vhfFilterOn) {
    const bufferSize = Math.floor(ctx.sampleRate * 0.14);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.24;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1350;
    filter.Q.value = 1.4;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now + 0.12);
  }
}

function playSosSirenTone() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(680, now);
  osc.frequency.linearRampToValueAtTime(1320, now + 0.25);
  osc.frequency.linearRampToValueAtTime(680, now + 0.5);
  osc.frequency.linearRampToValueAtTime(1320, now + 0.75);

  gain.gain.setValueAtTime(0.16, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.86);
}

function getSupportedRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/aac'
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function createSyntheticCarrierWavDataUrl(durationSec = 1.4) {
  const sampleRate = 8000;
  const numSamples = Math.max(2000, Math.floor(sampleRate * Math.min(durationSec, 6)));
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const carrier =
      Math.sin(2 * Math.PI * 880 * t) * 0.25 +
      Math.sin(2 * Math.PI * 1320 * t) * 0.15 +
      (Math.random() * 2 - 1) * 0.06;
    const sample = Math.max(-1, Math.min(1, carrier));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// ============================================================================
// 2. Initialization & Auto-Session so Everything Works Out-of-the-Box
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  setupAudioUnlockListeners();
  setupPttButtonListeners();
  setupSpacebarPtt();
  await bootstrapRadio();
  connectRealtimeStream();
});

async function apiRequest(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
}

async function ensureAuthenticatedSession() {
  if (state.user && state.token) return true;
  try {
    const res = await apiRequest('/api/auth/quick', {
      method: 'POST',
      body: JSON.stringify({ callsign: 'AURA-01' })
    });
    state.token = res.token;
    state.loggedOutManually = false;
    localStorage.setItem('auraflow_radio_token', res.token);
    localStorage.removeItem('auraflow_radio_logged_out');
    setAuthenticatedUser(res.user);
    connectRealtimeStream();
    return true;
  } catch {
    openAuthModal();
    return false;
  }
}

async function bootstrapRadio() {
  try {
    // If no token yet and user didn't explicitly log out, auto-activate founder session so PTT & GPS work immediately
    if (!state.token && !state.loggedOutManually) {
      await ensureAuthenticatedSession();
    }

    const data = await apiRequest(`/api/bootstrap?channel=${encodeURIComponent(state.activeChannel.code)}`);
    state.channels = data.channels || [];
    state.operators = data.operators || [];
    state.transmissions = data.transmissions || [];

    if (data.user) {
      setAuthenticatedUser(data.user);
    } else {
      updateSessionHeader();
    }

    const foundCh = state.channels.find((c) => c.code === state.activeChannel.code);
    if (foundCh) {
      state.activeChannel = foundCh;
    }

    renderAllPanels();
  } catch (err) {
    console.error('Bootstrap error:', err);
  }
}

function connectRealtimeStream() {
  if (state.sse) {
    state.sse.close();
  }
  const url = state.token
    ? `/api/stream?token=${encodeURIComponent(state.token)}`
    : '/api/stream';

  const sse = new EventSource(url);
  state.sse = sse;

  sse.addEventListener('ptt_start', (e) => {
    const data = JSON.parse(e.data);
    if (state.user && data.userId === state.user.id) return;
    if (data.channel === state.activeChannel.code) {
      showReceivingState(data.callsign);
    }
  });

  sse.addEventListener('ptt_stop', (e) => {
    const data = JSON.parse(e.data);
    if (state.user && data.userId === state.user.id) return;
    if (data.channel === state.activeChannel.code) {
      clearReceivingState();
    }
  });

  sse.addEventListener('call_tone', (e) => {
    const data = JSON.parse(e.data);
    if (data.channel === state.activeChannel.code) {
      playCallAlertTone();
      showToast(`📡 Tono de llamada recibido de ${data.callsign} en ${data.channel}`);
    }
  });

  sse.addEventListener('transmission', (e) => {
    const { transmission, live_streamed } = JSON.parse(e.data);
    if (!transmission) return;
    if (transmission.channel_code === state.activeChannel.code) {
      const exists = state.transmissions.some((t) => t.id === transmission.id);
      if (!exists) {
        state.transmissions.unshift(transmission);
        renderTransmissions();
      }
      const isSelf = state.user && transmission.user_id === state.user.id;
      if ((!isSelf || state.echoModeOn) && !live_streamed) {
        playReceivedTransmission(transmission);
      }
    }
  });

  connectLiveAudioWs();

  sse.addEventListener('operators_update', (e) => {
    const data = JSON.parse(e.data);
    if (data.operators) state.operators = data.operators;
    if (data.channels) state.channels = data.channels;
    renderAllPanels();
  });

  sse.addEventListener('gps_update', (e) => {
    const data = JSON.parse(e.data);
    if (data.operators) {
      state.operators = data.operators;
      renderOperators();
      renderRadarMarkers();
    }
  });

  sse.addEventListener('direct_call', (e) => {
    const { call, channels } = JSON.parse(e.data);
    if (channels) {
      state.channels = channels;
      renderChannels();
    }
    if (!call) return;
    const isForMe =
      call.call_type === 'SOS' ||
      !call.to_user_id ||
      (state.user && call.to_user_id === state.user.id);

    const isFromMe = state.user && call.from_user_id === state.user.id;
    if (isForMe && !isFromMe) {
      showIncomingCallBanner(call);
    }
  });
}

// ============================================================================
// 3. UI Rendering (LCD, Channels, Operators, Radar Map, Audio History)
// ============================================================================
function setAuthenticatedUser(user) {
  state.user = user;
  if (user.current_channel) {
    const ch = state.channels.find((c) => c.code === user.current_channel);
    if (ch) state.activeChannel = ch;
  }
  updateSessionHeader();
  updateGpsUiState();
}

function updateSessionHeader() {
  const statusText = document.getElementById('session-status-text');
  const callsignPill = document.getElementById('callsign-pill');
  const headerCallsign = document.getElementById('header-callsign');
  const btnOpenAuth = document.getElementById('btn-open-auth');
  const btnLogout = document.getElementById('btn-logout');
  const carrierText = document.getElementById('carrier-text');
  const carrierDot = document.getElementById('carrier-dot');

  if (state.user) {
    statusText.textContent = `Operador: ${state.user.name}`;
    headerCallsign.textContent = state.user.callsign;
    callsignPill.classList.remove('hidden');
    btnOpenAuth.textContent = '🔄 Cambiar Callsign';
    btnOpenAuth.classList.remove('hidden');
    btnLogout.classList.remove('hidden');
    carrierDot.textContent = '●';
    carrierText.textContent = 'PORTADORA LIBRE • LISTO';
  } else {
    statusText.textContent = 'Sin sesión.';
    callsignPill.classList.add('hidden');
    btnOpenAuth.textContent = '🔑 Iniciar Sesión / Callsign';
    btnOpenAuth.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    carrierDot.textContent = '○';
    carrierText.textContent = 'STANDBY. ○ ESPERANDO LOGIN...';
  }
}

function renderAllPanels() {
  renderLcdDisplay();
  renderChannels();
  renderOperators();
  renderTransmissions();
  renderRadarMarkers();
  updateGpsUiState();
}

function renderLcdDisplay() {
  const ch = state.activeChannel;
  document.getElementById('lcd-channel-code').textContent = ch.code;
  document.getElementById('lcd-freq').textContent = ch.frequency_mhz || '462.5625 MHz';
  document.getElementById('lcd-mode').textContent = ch.mode || 'MODO: VHF FILTRADO';
  document.getElementById('lcd-room-name').textContent = ch.name || ch.code;
  document.getElementById('lcd-room-badge').textContent = ch.is_private ? 'PIN CIFRADO' : 'ABIERTO';
  document.getElementById('history-channel-label').textContent = ch.code;
}

function renderChannels() {
  const container = document.getElementById('channels-list');
  document.getElementById('count-canales').textContent = state.channels.length || 6;

  container.innerHTML = state.channels
    .map((ch) => {
      const isActive = ch.code === state.activeChannel.code;
      return `
        <div class="channel-card ${isActive ? 'active-channel' : ''}" onclick="selectChannelCard('${ch.code}', ${ch.is_private})">
          <div class="ch-card-top">
            <span class="ch-code">${ch.code}</span>
            <span class="ch-freq">${ch.frequency_mhz}</span>
          </div>
          <div class="ch-name">${ch.name}</div>
          <div class="ch-meta">
            <span>👥 ${ch.operators_count || 0} en línea</span>
            <span class="ch-badge ${ch.is_private ? 'pin' : 'open'}">${ch.is_private ? '🔐 PIN' : 'ABIERTO'}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderOperators() {
  const list = document.getElementById('operators-list');
  const onlineOps = state.operators;
  document.getElementById('count-operadores').textContent = onlineOps.length;

  const gpsUnits = onlineOps.filter((o) => o.gps_enabled && o.latitude && o.longitude);
  document.getElementById('count-mapa').textContent = gpsUnits.length;

  list.innerHTML = onlineOps
    .map((op) => {
      const isMe = state.user && op.id === state.user.id;
      const gmapsUrl = `https://www.google.com/maps?q=${op.latitude},${op.longitude}`;
      const wazeUrl = `https://waze.com/ul?ll=${op.latitude},${op.longitude}&navigate=yes`;

      return `
        <div class="operator-card">
          <div class="op-left">
            <div class="op-avatar" style="background: ${op.avatar_color || '#06b6d4'};">
              ${op.callsign.slice(0, 3)}
            </div>
            <div>
              <div class="op-callsign-row">
                <span class="op-callsign">${op.callsign} ${isMe ? '(TÚ)' : ''}</span>
                <span class="op-channel-tag">📻 ${op.current_channel}</span>
              </div>
              <div class="op-name">${op.name}</div>
              <div class="op-sub">
                ${op.base_name || op.role} · ${
                  op.gps_enabled
                    ? `📍 ${Number(op.latitude).toFixed(5)}, ${Number(op.longitude).toFixed(5)}`
                    : 'GPS Apagado'
                }
              </div>
            </div>
          </div>

          <div class="op-actions">
            ${
              !isMe
                ? `<button class="btn-op btn-op-1to1" onclick="initiateDirectCall(${op.id}, '${op.callsign}')">📞 Llamar 1:1</button>`
                : ''
            }
            <button class="btn-op" onclick="focusOperatorOnMap(${op.id})">🎯 Ver en Radar</button>
            <a class="btn-op" href="${gmapsUrl}" target="_blank" rel="noopener">🗺️ Google Maps</a>
            <a class="btn-op" href="${wazeUrl}" target="_blank" rel="noopener">🚗 Waze</a>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderTransmissions() {
  const container = document.getElementById('transmissions-list');
  document.getElementById('count-historial').textContent = state.transmissions.length;

  if (!state.transmissions.length) {
    container.innerHTML = `<div class="empty-history">Aún no hay transmisiones grabadas en esta frecuencia</div>`;
    return;
  }

  container.innerHTML = state.transmissions
    .map((tx) => {
      const gmaps =
        tx.latitude && tx.longitude
          ? `<a class="btn-op" href="https://www.google.com/maps?q=${tx.latitude},${tx.longitude}" target="_blank" rel="noopener">📍 GPS</a>`
          : '';
      return `
        <div class="tx-item ${tx.is_sos ? 'tx-sos' : ''}">
          <div class="tx-left">
            <button class="btn-play-tx" onclick="playAudioUrl('${tx.audio_url}', '${tx.callsign}')">
              ▶ ESCUCHAR
            </button>
            <div>
              <div class="op-callsign-row">
                <span class="op-callsign">${tx.callsign}</span>
                <span class="op-channel-tag">${Number(tx.duration_sec || 1.2).toFixed(1)}s</span>
                ${tx.is_sos ? '<span class="ch-badge pin">🚨 SOS</span>' : ''}
              </div>
              <div class="op-sub">${tx.user_name} · ${tx.created_at}</div>
            </div>
          </div>
          <div class="op-actions">
            ${gmaps}
            <a class="btn-op" href="${tx.audio_url}" download="tx_${tx.callsign}_${tx.id}.webm">⬇ Audio</a>
          </div>
        </div>
      `;
    })
    .join('');
}

// ============================================================================
// 4. Push-To-Talk (PTT) Voice Capture & Real-Time Broadcast
// ============================================================================
function setupPttButtonListeners() {
  const btn = document.getElementById('btn-ptt');
  if (!btn) return;

  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!state.handsFreeLocked) startPttTransmission();
  });

  window.addEventListener('mouseup', () => {
    if (state.isTransmitting && !state.handsFreeLocked) {
      stopPttTransmission();
    }
  });

  btn.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      if (!state.handsFreeLocked) startPttTransmission();
    },
    { passive: false }
  );

  btn.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      if (state.isTransmitting && !state.handsFreeLocked) {
        stopPttTransmission();
      }
    },
    { passive: false }
  );

  btn.addEventListener(
    'touchcancel',
    (e) => {
      e.preventDefault();
      if (state.isTransmitting && !state.handsFreeLocked) {
        stopPttTransmission();
      }
    },
    { passive: false }
  );
}

function setupSpacebarPtt() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      if (!state.isTransmitting && !state.handsFreeLocked) {
        startPttTransmission();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.isTransmitting && !state.handsFreeLocked) {
        stopPttTransmission();
      }
    }
  });
}

async function startPttTransmission() {
  if (!state.user) {
    const ok = await ensureAuthenticatedSession();
    if (!ok) return;
  }
  if (state.isTransmitting) return;

  state.isTransmitting = true;
  state.txStartTime = Date.now();
  state.audioChunks = [];

  playPttStartChirp();
  setTransmittingUi(true);

  apiRequest('/api/ptt/state', {
    method: 'POST',
    body: JSON.stringify({ state: 'TX', channel: state.activeChannel.code })
  }).catch(() => {});

  // Request real microphone if available
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // If user released PTT while waiting for mic permission/stream, abort cleanly
      if (!state.isTransmitting) {
        state.mediaStream.getTracks().forEach((t) => t.stop());
        state.mediaStream = null;
        return;
      }

      // Connect live microphone stream to VU Meter Analyser & Real-Time WebSocket Streamer
      try {
        const ctx = getAudioContext();
        if (ctx) {
          const source = ctx.createMediaStreamSource(state.mediaStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          state.micAnalyser = analyser;
          startLiveAudioStreamer(source, ctx);
        }
      } catch {}

      const mimeType = getSupportedRecorderMimeType();
      state.mediaRecorder = mimeType
        ? new MediaRecorder(state.mediaStream, { mimeType })
        : new MediaRecorder(state.mediaStream);

      state.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          state.audioChunks.push(ev.data);
        }
      };
      state.mediaRecorder.start();
    }
  } catch {
    state.mediaRecorder = null;
  }
}

async function stopPttTransmission(isSos = false) {
  if (!state.isTransmitting) return;
  state.isTransmitting = false;
  state.micAnalyser = null;
  const wasLiveStreamed = stopLiveAudioStreamer();

  const durationSec = Math.max(0.6, (Date.now() - state.txStartTime) / 1000);
  setTransmittingUi(false);
  playRogerBeepAndSquelch();

  apiRequest('/api/ptt/state', {
    method: 'POST',
    body: JSON.stringify({ state: 'ONLINE', channel: state.activeChannel.code })
  }).catch(() => {});

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    const recorder = state.mediaRecorder;
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
      state.mediaStream = null;
    }

    if (state.audioChunks.length > 0) {
      const blobType = recorder.mimeType || getSupportedRecorderMimeType() || 'audio/webm';
      const blob = new Blob(state.audioChunks, { type: blobType });
      const reader = new FileReader();
      reader.onloadend = async () => {
        await uploadVoiceTransmission(reader.result, durationSec, isSos, wasLiveStreamed);
      };
      reader.readAsDataURL(blob);
      return;
    }
  }

  const wavDataUrl = createSyntheticCarrierWavDataUrl(durationSec);
  await uploadVoiceTransmission(wavDataUrl, durationSec, isSos, wasLiveStreamed);
}

async function uploadVoiceTransmission(audioDataUrl, durationSec, isSos = false, liveStreamed = false) {
  try {
    const res = await apiRequest('/api/transmissions', {
      method: 'POST',
      body: JSON.stringify({
        channel: state.activeChannel.code,
        audio_data: audioDataUrl,
        duration_sec: Number(durationSec.toFixed(1)),
        is_sos: isSos,
        live_streamed: liveStreamed
      })
    });
    if (res.transmission) {
      const exists = state.transmissions.some((t) => t.id === res.transmission.id);
      if (!exists) {
        state.transmissions.unshift(res.transmission);
        renderTransmissions();
      }
      if (state.echoModeOn && !liveStreamed) {
        playReceivedTransmission(res.transmission);
      } else {
        showToast(`🎙️ Transmisión enviada en ${state.activeChannel.code} (${durationSec.toFixed(1)}s)`);
      }
    }
  } catch (err) {
    showToast(`⚠️ Error al transmitir: ${err.message}`);
  }
}

function setTransmittingUi(isTx) {
  const lcd = document.getElementById('lcd-screen');
  const ring = document.getElementById('ptt-ring');
  const btn = document.getElementById('btn-ptt');
  const led = document.getElementById('global-led');
  const label = document.getElementById('ptt-main-label');
  const sub = document.getElementById('ptt-sub-label');
  const carrierText = document.getElementById('carrier-text');
  const carrierTimer = document.getElementById('carrier-timer');

  if (isTx) {
    lcd.classList.add('tx-active');
    ring.classList.add('tx-ring');
    btn.classList.add('transmitting');
    led.classList.add('tx');
    label.textContent = 'TRANSMITIENDO';
    sub.textContent = `TX EN ${state.activeChannel.code}`;
    carrierText.textContent = `TX AL AIRE • ${state.user ? state.user.callsign : 'PTT'}`;

    clearInterval(state.txTimerInterval);
    state.txTimerInterval = setInterval(() => {
      const elapsed = ((Date.now() - state.txStartTime) / 1000).toFixed(1);
      carrierTimer.textContent = `${elapsed}s`;
    }, 100);

    startVuMeterAnimation();
  } else {
    lcd.classList.remove('tx-active');
    ring.classList.remove('tx-ring');
    btn.classList.remove('transmitting');
    led.classList.remove('tx');
    label.textContent = 'PULSAR PTT';
    sub.textContent = 'PUSH TO TALK';
    carrierText.textContent = state.user ? 'PORTADORA LIBRE • LISTO' : 'STANDBY. ○ ESPERANDO LOGIN...';
    carrierTimer.textContent = '0.0s';

    clearInterval(state.txTimerInterval);
    stopVuMeterAnimation();
  }
}

function showReceivingState(fromCallsign) {
  const lcd = document.getElementById('lcd-screen');
  const ring = document.getElementById('ptt-ring');
  const led = document.getElementById('global-led');
  const carrierText = document.getElementById('carrier-text');

  lcd.classList.add('rx-active');
  ring.classList.add('rx-ring');
  led.classList.add('rx');
  carrierText.textContent = `RX RECIBIENDO DE ${fromCallsign}...`;
  startVuMeterAnimation();
}

function clearReceivingState() {
  const lcd = document.getElementById('lcd-screen');
  const ring = document.getElementById('ptt-ring');
  const led = document.getElementById('global-led');
  const carrierText = document.getElementById('carrier-text');

  lcd.classList.remove('rx-active');
  ring.classList.remove('rx-ring');
  led.classList.remove('rx');
  carrierText.textContent = state.user ? 'PORTADORA LIBRE • LISTO' : 'STANDBY. ○ ESPERANDO LOGIN...';
  stopVuMeterAnimation();
}

function playReceivedTransmission(tx) {
  showReceivingState(tx.callsign);
  playAudioUrl(tx.audio_url, tx.callsign, () => {
    clearReceivingState();
    playRogerBeepAndSquelch();
  });
}

function stopCurrentPlayback() {
  if (state.currentBufferSource) {
    try {
      state.currentBufferSource.onended = null;
      state.currentBufferSource.stop();
      state.currentBufferSource.disconnect();
    } catch {}
    state.currentBufferSource = null;
  }
  if (state.sharedAudioEl && !state.sharedAudioEl.paused) {
    try {
      state.sharedAudioEl.pause();
    } catch {}
  }
}

async function connectLiveAudioWs() {
  if (!state.token) return;
  if (state.liveWs && (state.liveWs.readyState === WebSocket.OPEN || state.liveWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(state.liveWsReconnectTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ch = state.activeChannel ? state.activeChannel.code : 'CH-01';
  const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}&channel=${encodeURIComponent(ch)}`);
  ws.binaryType = 'arraybuffer';
  state.liveWs = ws;

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'live_start') {
          if (msg.channel === state.activeChannel.code) {
            state.liveNextPlayTime = 0;
            showReceivingState(msg.callsign);
            playPttStartChirp();
          }
        } else if (msg.type === 'live_stop') {
          if (msg.channel === state.activeChannel.code) {
            clearReceivingState();
            playRogerBeepAndSquelch();
          }
        }
      } catch {}
      return;
    }

    // Binary PCM Int16 frame: [userId (uint32LE), sampleRate (uint32LE), ...int16Samples]
    if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 8) {
      const view = new DataView(ev.data);
      const sampleRate = view.getUint32(4, true) || 16000;
      const pcmInt16 = new Int16Array(ev.data, 8);
      playLivePcmChunk(sampleRate, pcmInt16);
    }
  };

  ws.onclose = () => {
    if (state.liveWs === ws) {
      state.liveWs = null;
      state.liveWsReconnectTimer = setTimeout(connectLiveAudioWs, 2000);
    }
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function playLivePcmChunk(sampleRate, pcmInt16) {
  const ctx = getAudioContext();
  if (!ctx || pcmInt16.length === 0) return;
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    ctx.resume().catch(() => {});
  }

  const float32 = new Float32Array(pcmInt16.length);
  for (let i = 0; i < pcmInt16.length; i++) {
    float32[i] = pcmInt16[i] / 32768;
  }

  const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
  audioBuffer.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  if (state.vhfFilterOn) {
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1450;
    bandpass.Q.value = 0.85;

    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.35;

    source.connect(bandpass);
    bandpass.connect(gainNode);
    gainNode.connect(ctx.destination);
  } else {
    source.connect(ctx.destination);
  }

  const now = ctx.currentTime;
  if (!state.liveNextPlayTime || state.liveNextPlayTime < now) {
    state.liveNextPlayTime = now + 0.045; // 45ms jitter buffer
  }
  source.start(state.liveNextPlayTime);
  state.liveNextPlayTime += audioBuffer.duration;
}

function downsampleToInt16(float32Input, inputRate, targetRate = 16000) {
  if (inputRate === targetRate) {
    const out = new Int16Array(float32Input.length);
    for (let i = 0; i < float32Input.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputRate / targetRate;
  const outLength = Math.floor(float32Input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(idx0 + 1, float32Input.length - 1);
    const frac = idx - idx0;
    const sample = float32Input[idx0] * (1 - frac) + float32Input[idx1] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function startLiveAudioStreamer(source, ctx) {
  stopLiveAudioStreamer();
  const ws = state.liveWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const targetRate = 16000;
  ws.send(JSON.stringify({
    type: 'live_start',
    channel: state.activeChannel.code,
    sampleRate: targetRate,
    echo: Boolean(state.echoModeOn)
  }));

  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;

  processor.onaudioprocess = (ev) => {
    if (!state.isTransmitting || !state.liveWs || state.liveWs.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm16 = downsampleToInt16(input, ctx.sampleRate, targetRate);
    if (pcm16.length > 0) {
      state.liveWs.send(pcm16.buffer);
    }
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);

  state.liveProcessor = processor;
  state.liveSilentGain = silentGain;
  state.liveStreamedActive = true;
  return true;
}

function stopLiveAudioStreamer() {
  if (state.liveProcessor) {
    try {
      state.liveProcessor.onaudioprocess = null;
      state.liveProcessor.disconnect();
    } catch {}
    state.liveProcessor = null;
  }
  if (state.liveSilentGain) {
    try { state.liveSilentGain.disconnect(); } catch {}
    state.liveSilentGain = null;
  }
  if (state.liveStreamedActive && state.liveWs && state.liveWs.readyState === WebSocket.OPEN) {
    state.liveWs.send(JSON.stringify({
      type: 'live_stop',
      channel: state.activeChannel.code
    }));
  }
  const wasStreamed = Boolean(state.liveStreamedActive);
  state.liveStreamedActive = false;
  return wasStreamed;
}

async function playAudioUrl(url, callsign = 'OPERADOR', onEnded = null) {
  stopCurrentPlayback();
  showReceivingState(callsign);

  const ctx = getAudioContext();
  if (ctx) {
    try {
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        await ctx.resume().catch(() => {});
      }
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      state.currentBufferSource = source;

      if (state.vhfFilterOn) {
        const bandpass = ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = 1450;
        bandpass.Q.value = 0.85;

        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.35;

        source.connect(bandpass);
        bandpass.connect(gainNode);
        gainNode.connect(ctx.destination);
      } else {
        source.connect(ctx.destination);
      }

      source.onended = () => {
        if (state.currentBufferSource === source) {
          state.currentBufferSource = null;
        }
        clearReceivingState();
        if (onEnded) onEnded();
      };
      source.start(0);
      return;
    } catch (err) {
      console.warn('[AuraFlow Audio] WebAudio decode fallback to <audio>:', err);
    }
  }

  // Fallback to pre-unlocked <audio> element (without createMediaElementSource for iOS compatibility)
  const audio = getSharedAudioElement();
  audio.muted = false;
  audio.src = url;
  audio.onended = () => {
    clearReceivingState();
    if (onEnded) onEnded();
  };
  audio.onerror = () => {
    clearReceivingState();
  };
  audio.play().catch(() => {
    clearReceivingState();
  });
}

function startVuMeterAnimation() {
  stopVuMeterAnimation();
  const bars = document.querySelectorAll('#vu-meter .vu-bar');
  const freqData = new Uint8Array(16);

  state.vuInterval = setInterval(() => {
    if (state.micAnalyser) {
      state.micAnalyser.getByteFrequencyData(freqData);
    }
    bars.forEach((bar, idx) => {
      const pct = state.micAnalyser
        ? Math.max(18, Math.min(100, Math.round((freqData[idx] / 255) * 100)))
        : Math.floor(22 + Math.random() * 76);
      bar.style.height = `${pct}%`;
      bar.classList.remove('lit', 'lit-high', 'lit-peak');
      if (pct > 25) {
        if (idx >= 13) bar.classList.add('lit-peak');
        else if (idx >= 9) bar.classList.add('lit-high');
        else bar.classList.add('lit');
      }
    });
  }, 75);
}

function stopVuMeterAnimation() {
  clearInterval(state.vuInterval);
  const bars = document.querySelectorAll('#vu-meter .vu-bar');
  bars.forEach((bar) => {
    bar.style.height = '22%';
    bar.classList.remove('lit', 'lit-high', 'lit-peak');
  });
}

// ============================================================================
// 5. Tactical Controls (Hands-Free, Echo Test, VHF, Roger Beep, Channels, PIN)
// ============================================================================
async function toggleHandsFree() {
  if (!state.user) {
    const ok = await ensureAuthenticatedSession();
    if (!ok) return;
  }
  state.handsFreeLocked = !state.handsFreeLocked;
  const btn = document.getElementById('btn-handsfree');
  if (state.handsFreeLocked) {
    btn.classList.add('active-toggle');
    btn.textContent = '🔓 Destrabar Manos Libres';
    await startPttTransmission();
    showToast('🔒 Manos Libres activado: transmitiendo continuamente.');
  } else {
    btn.classList.remove('active-toggle');
    btn.textContent = '🔒 Trabar Manos Libres';
    await stopPttTransmission();
    showToast('🔓 Manos Libres desactivado.');
  }
}

function toggleEchoMode() {
  state.echoModeOn = !state.echoModeOn;
  const btn = document.getElementById('btn-echotest');
  if (state.echoModeOn) {
    btn.classList.add('active-toggle');
    showToast('🔊 Modo Eco (Test) ACTIVADO: escucharás tu propia transmisión al soltar PTT.');
  } else {
    btn.classList.remove('active-toggle');
    showToast('🔇 Modo Eco (Test) desactivado.');
  }
}

function toggleVhfFilter() {
  state.vhfFilterOn = !state.vhfFilterOn;
  const flag = document.getElementById('flag-vhf');
  flag.textContent = state.vhfFilterOn ? 'VHF ON' : 'VHF OFF';
  flag.classList.toggle('active', state.vhfFilterOn);
  showToast(state.vhfFilterOn ? '📻 Filtro de Radio VHF ACTIVADO' : '📻 Filtro VHF desactivado');
}

function toggleRogerBeep() {
  state.rogerBeepOn = !state.rogerBeepOn;
  const flag = document.getElementById('flag-beep');
  flag.textContent = state.rogerBeepOn ? 'BEEP ON' : 'BEEP OFF';
  flag.classList.toggle('active', state.rogerBeepOn);
  showToast(state.rogerBeepOn ? '🔊 Roger Beep ACTIVADO' : '🔇 Roger Beep silenciado');
}

async function triggerCallTone() {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  playCallAlertTone();
  apiRequest('/api/ptt/call-tone', {
    method: 'POST',
    body: JSON.stringify({ channel: state.activeChannel.code })
  }).catch(() => {});
  showToast(`📡 Tono de llamada enviado en ${state.activeChannel.code}`);
}

async function selectChannelCard(code, isPrivate) {
  if (!state.user) {
    const ok = await ensureAuthenticatedSession();
    if (!ok) return;
  }
  let pin = null;
  if (isPrivate) {
    const roomInput = document.getElementById('private-room-code');
    const pinInput = document.getElementById('private-room-pin');
    if (code === 'CH-06') {
      pin = '1234';
    } else if (pinInput && pinInput.value.trim()) {
      pin = pinInput.value.trim();
    } else {
      pin = window.prompt(`🔐 Ingresa el PIN secreto para ${code} (por defecto 1234):`, '1234') || '1234';
    }
    if (roomInput) roomInput.value = code;
  }
  await tuneToChannel(code, pin);
}

async function handlePrivateRoomSubmit(e) {
  e.preventDefault();
  if (!state.user) {
    const ok = await ensureAuthenticatedSession();
    if (!ok) return;
  }
  const code = document.getElementById('private-room-code').value.trim().toUpperCase();
  const pin = document.getElementById('private-room-pin').value.trim();
  await tuneToChannel(code, pin);
}

async function tuneToChannel(code, pin = null) {
  try {
    const res = await apiRequest('/api/channels/tune', {
      method: 'POST',
      body: JSON.stringify({ code, pin })
    });
    state.activeChannel = res.channel;
    if (state.liveWs && state.liveWs.readyState === WebSocket.OPEN) {
      state.liveWs.send(JSON.stringify({ type: 'channel', channel: res.channel.code }));
    }
    state.transmissions = res.transmissions || [];
    state.channels = res.channels || state.channels;
    state.operators = res.operators || state.operators;
    playPttStartChirp();
    renderAllPanels();
    showToast(`📻 Sintonizado en ${res.channel.code} (${res.channel.frequency_mhz})`);
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  }
}

// ============================================================================
// 6. Real-Time GPS Satellite Radar, Live Geolocation Watch & Base CR
// ============================================================================
function initRadarMapIfNeeded() {
  if (state.map) {
    setTimeout(() => state.map.invalidateSize(), 120);
    return;
  }
  const mapEl = document.getElementById('radar-map');
  if (!mapEl || typeof L === 'undefined') return;

  const initialLat = (state.user && state.user.latitude) || 9.3712;
  const initialLng = (state.user && state.user.longitude) || -83.7029;

  state.map = L.map('radar-map', {
    center: [initialLat, initialLng],
    zoom: 12,
    zoomControl: true
  });

  setRadarMapLayer(state.currentMapLayer);

  // Allow clicking on map to set position when mapPickMode is enabled
  state.map.on('click', async (ev) => {
    if (!state.mapPickMode) return;
    const { lat, lng } = ev.latlng;
    state.mapPickMode = false;
    const pickBtn = document.getElementById('btn-map-pick');
    if (pickBtn) {
      pickBtn.classList.remove('active-pick');
      pickBtn.textContent = '📌 Fijar en Mapa';
    }
    await applyNewUserCoordinates(lat, lng, 4.0, 0, 0, 'Ubicación Fijada en Radar');
    showToast(`📍 Posición fijada en el radar: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  });

  renderRadarMarkers();
}

function setRadarMapLayer(mode) {
  state.currentMapLayer = mode;
  document.querySelectorAll('.layer-pill').forEach((b) => b.classList.remove('active'));
  const activeBtn = document.getElementById(
    mode === 'satellite' ? 'layer-sat' : mode === 'dark' ? 'layer-dark' : 'layer-osm'
  );
  if (activeBtn) activeBtn.classList.add('active');

  if (!state.map || typeof L === 'undefined') return;

  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  if (state.labelLayer) state.map.removeLayer(state.labelLayer);

  if (mode === 'satellite') {
    state.tileLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Tiles &copy; Esri &mdash; Radar Satelital AuraFlow CR',
        maxZoom: 19
      }
    ).addTo(state.map);
    state.labelLayer = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      {
        maxZoom: 19,
        opacity: 0.85
      }
    ).addTo(state.map);
  } else if (mode === 'dark') {
    state.tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &amp; CartoDB Radar',
      maxZoom: 19
    }).addTo(state.map);
  } else {
    state.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(state.map);
  }
}

function toggleMapPickMode() {
  switchTab('mapa');
  state.mapPickMode = !state.mapPickMode;
  const pickBtn = document.getElementById('btn-map-pick');
  if (state.mapPickMode) {
    if (pickBtn) {
      pickBtn.classList.add('active-pick');
      pickBtn.textContent = '🎯 Haz clic en el mapa...';
    }
    showToast('📌 Haz clic en cualquier punto del mapa para fijar tu ubicación exacta.');
  } else if (pickBtn) {
    pickBtn.classList.remove('active-pick');
    pickBtn.textContent = '📌 Fijar en Mapa';
  }
}

function renderRadarMarkers() {
  const unitsContainer = document.getElementById('telemetry-units-list');
  const gpsOps = state.operators.filter((o) => o.gps_enabled && o.latitude && o.longitude);

  if (unitsContainer) {
    unitsContainer.innerHTML = gpsOps
      .map(
        (op) => `
        <div class="telemetry-card" onclick="focusOperatorOnMap(${op.id})">
          <div class="op-callsign-row">
            <span class="op-callsign">🛰️ ${op.callsign}</span>
            <span class="op-channel-tag">${op.current_channel}</span>
          </div>
          <div class="op-name">${op.name}</div>
          <div class="op-sub">${op.base_name || 'Costa Rica'} · ${Number(op.latitude).toFixed(5)}, ${Number(op.longitude).toFixed(5)}</div>
          <div class="op-actions" style="margin-top: 6px;">
            <a class="btn-op" href="https://www.google.com/maps?q=${op.latitude},${op.longitude}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🗺️ Maps</a>
            <a class="btn-op" href="https://waze.com/ul?ll=${op.latitude},${op.longitude}&navigate=yes" target="_blank" rel="noopener" onclick="event.stopPropagation()">🚗 Waze</a>
          </div>
        </div>
      `
      )
      .join('');
  }

  if (!state.map || typeof L === 'undefined') return;

  Object.values(state.markers).forEach((m) => state.map.removeLayer(m));
  Object.values(state.accuracyCircles).forEach((c) => state.map.removeLayer(c));
  state.markers = {};
  state.accuracyCircles = {};

  gpsOps.forEach((op) => {
    const isMe = state.user && op.id === state.user.id;
    const color = op.avatar_color || '#06b6d4';

    // Accuracy radius circle
    const accCircle = L.circle([op.latitude, op.longitude], {
      radius: Math.max(15, Number(op.accuracy || 15)),
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.14
    }).addTo(state.map);
    state.accuracyCircles[op.id] = accCircle;

    const icon = L.divIcon({
      className: 'tactical-gps-marker',
      html: `
        <div class="tactical-gps-dot" style="background: ${color}; color: ${color};"></div>
        <div class="tactical-gps-label">${op.callsign}${isMe ? ' • TÚ' : ''}</div>
      `,
      iconSize: [90, 42],
      iconAnchor: [45, 12]
    });

    const marker = L.marker([op.latitude, op.longitude], { icon }).addTo(state.map);

    marker.bindPopup(`
      <div style="font-family: sans-serif; color: #0f172a; min-width: 200px;">
        <strong>🛰️ ${op.callsign}</strong> — ${op.name}<br/>
        <small>Frecuencia: <b>${op.current_channel}</b> · Precisión: ±${Number(op.accuracy || 6).toFixed(0)}m</small><br/>
        <small>${op.base_name || 'Costa Rica'}</small><br/>
        <small>Coord: <code>${Number(op.latitude).toFixed(5)}, ${Number(op.longitude).toFixed(5)}</code></small><br/>
        <div style="margin-top: 8px; display: flex; gap: 8px;">
          <a href="https://www.google.com/maps?q=${op.latitude},${op.longitude}" target="_blank" rel="noopener" style="font-weight:bold;color:#0284c7;">🗺️ Google Maps</a>
          <a href="https://waze.com/ul?ll=${op.latitude},${op.longitude}&navigate=yes" target="_blank" rel="noopener" style="font-weight:bold;color:#059669;">🚗 Abrir Waze</a>
        </div>
      </div>
    `);

    state.markers[op.id] = marker;
  });
}

function updateGpsUiState() {
  const flagGps = document.getElementById('flag-gps');
  const btnQuickGps = document.getElementById('btn-quick-gps');
  const btnMapGps = document.getElementById('btn-map-gps');
  const banner = document.getElementById('gps-status-banner');
  const tmStatus = document.getElementById('tm-status');
  const tmCoords = document.getElementById('tm-coords');
  const tmAcc = document.getElementById('tm-acc');
  const tmSpeed = document.getElementById('tm-speed');

  const lat = state.user ? Number(state.user.latitude || 9.3712) : 9.3712;
  const lng = state.user ? Number(state.user.longitude || -83.7029) : -83.7029;
  const acc = state.user ? Number(state.user.accuracy || 6.0) : 6.0;
  const spd = state.user ? Number(state.user.speed || 0.0) : 0.0;

  if (tmCoords) tmCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (tmAcc) tmAcc.textContent = `±${acc.toFixed(1)} m`;
  if (tmSpeed) tmSpeed.textContent = `${(spd * 3.6).toFixed(1)} km/h`;

  if (state.gpsActive) {
    flagGps.textContent = 'GPS ON';
    flagGps.classList.add('active');
    btnQuickGps.classList.add('gps-on');
    btnQuickGps.textContent = state.gpsWatching ? '🛰️ GPS En Vivo (Activo)' : '🛰️ Activar Sensor GPS';
    if (btnMapGps) {
      btnMapGps.textContent = state.gpsWatching ? '🛰️ GPS Satelital Activo' : '📍 Activar Mi GPS En Vivo';
    }
    if (tmStatus) {
      tmStatus.textContent = state.gpsWatching ? '🛰️ SATÉLITE EN VIVO' : '📍 BASE ACTIVA';
      tmStatus.style.color = '#34d399';
    }
    if (banner && state.user) {
      banner.classList.add('gps-active');
      banner.textContent = `🛰️ GPS ACTIVO (${state.user.callsign}): ${lat.toFixed(5)}, ${lng.toFixed(5)} (±${acc.toFixed(0)}m) · ${state.user.base_name || 'Costa Rica'}`;
    }
  } else {
    flagGps.textContent = 'GPS OFF';
    flagGps.classList.remove('active');
    btnQuickGps.classList.remove('gps-on');
    btnQuickGps.textContent = '📍 Activar Mi GPS';
    if (btnMapGps) btnMapGps.textContent = '📍 Activar Mi GPS';
    if (tmStatus) {
      tmStatus.textContent = 'DESACTIVADO';
      tmStatus.style.color = '#f59e0b';
    }
    if (banner) {
      banner.classList.remove('gps-active');
      banner.textContent = 'Tu GPS está desactivado. Puedes activarlo con el botón "📍 Activar Mi GPS".';
    }
  }
}

// Reverse geocode coordinates into a readable place name via OpenStreetMap Nominatim
async function reverseGeocodePlaceName(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
      { headers: { 'Accept-Language': 'es' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.address) {
      const parts = [
        data.address.road || data.address.neighbourhood || data.address.suburb || data.address.village,
        data.address.city || data.address.town || data.address.county,
        data.address.state || data.address.country
      ].filter(Boolean);
      if (parts.length > 0) return parts.slice(0, 3).join(', ');
    }
    return data.display_name ? data.display_name.split(',').slice(0, 3).join(',') : null;
  } catch {
    return null;
  }
}

// Fallback IP Geolocation if device lacks a hardware GPS chip or permission is blocked
async function fetchIpLocationFallback() {
  try {
    const res = await fetch('https://ipwho.is/');
    const data = await res.json();
    if (data && data.success && data.latitude && data.longitude) {
      return {
        latitude: Number(data.latitude),
        longitude: Number(data.longitude),
        accuracy: 250,
        label: `${data.city || 'Ubicación Red'}, ${data.region || data.country || 'CR'}`
      };
    }
  } catch {}
  return null;
}

async function applyNewUserCoordinates(lat, lng, accuracy = 8, speed = 0, heading = 0, customLabel = null) {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  state.gpsActive = true;
  if (state.user) {
    state.user.latitude = lat;
    state.user.longitude = lng;
    state.user.accuracy = accuracy;
    state.user.speed = speed;
    state.user.heading = heading;
  }

  let baseLabel = customLabel;
  if (!baseLabel) {
    baseLabel = (await reverseGeocodePlaceName(lat, lng)) || (state.user && state.user.base_name) || 'Ubicación GPS en Vivo';
  }
  if (state.user) {
    state.user.base_name = baseLabel;
  }

  await sendGpsTelemetry(true, lat, lng, accuracy, speed, heading, baseLabel);

  if (state.map) {
    state.map.flyTo([lat, lng], Math.max(state.map.getZoom(), 14), { duration: 0.9 });
  }
}

async function toggleMyGps() {
  if (!state.user) {
    const ok = await ensureAuthenticatedSession();
    if (!ok) return;
  }

  // Always switch to the Mapa GPS tab so the user immediately sees the live radar map working!
  switchTab('mapa');

  // If real GPS watch is not running yet, start real continuous GPS tracking!
  if (!state.gpsWatching) {
    await startRealBrowserGps();
  } else {
    stopRealBrowserGps();
    state.gpsActive = false;
    await sendGpsTelemetry(false, state.user.latitude, state.user.longitude);
    updateGpsUiState();
    showToast('📍 Telemetría GPS en tiempo real detenida.');
  }
}

async function locateMeNow() {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  switchTab('mapa');
  await startRealBrowserGps();
}

async function startRealBrowserGps() {
  state.gpsWatching = true;
  state.gpsActive = true;
  updateGpsUiState();
  showToast('🛰️ Obteniendo coordenadas satelitales GPS de tu dispositivo...');

  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, accuracy, speed, heading } = pos.coords;
        await applyNewUserCoordinates(
          latitude,
          longitude,
          accuracy || 8,
          speed || 0,
          heading || 0
        );
        showToast(`🛰️ GPS En Vivo conectado: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy || 8)}m)`);
      },
      async () => {
        // Fallback to IP geolocation or Costa Rica base so GPS map always locks onto a valid position
        const ipLoc = await fetchIpLocationFallback();
        if (ipLoc) {
          await applyNewUserCoordinates(ipLoc.latitude, ipLoc.longitude, ipLoc.accuracy, 0, 0, ipLoc.label);
          showToast(`🛰️ GPS conectado vía Red (${ipLoc.label}): ${ipLoc.latitude.toFixed(4)}, ${ipLoc.longitude.toFixed(4)}`);
        } else {
          await applyNewUserCoordinates(
            state.user.latitude || 9.3712,
            state.user.longitude || -83.7029,
            10,
            0,
            0,
            'Base Operaciones CR · Zona Sur'
          );
          showToast('🛰️ Radar GPS activo en Base Operaciones Costa Rica.');
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
    }
    state.gpsWatchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude, longitude, accuracy, speed, heading } = pos.coords;
        if (state.user) {
          state.user.latitude = latitude;
          state.user.longitude = longitude;
          state.user.accuracy = accuracy || 8;
          state.user.speed = speed || 0;
        }
        await sendGpsTelemetry(
          true,
          latitude,
          longitude,
          accuracy || 8,
          speed || 0,
          heading || 0,
          state.user ? state.user.base_name : undefined
        );
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  } else {
    const ipLoc = await fetchIpLocationFallback();
    if (ipLoc) {
      await applyNewUserCoordinates(ipLoc.latitude, ipLoc.longitude, ipLoc.accuracy, 0, 0, ipLoc.label);
    }
  }
}

function stopRealBrowserGps() {
  state.gpsWatching = false;
  if (state.gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
}

async function sendGpsTelemetry(enabled, lat, lng, accuracy = 8, speed = 0, heading = 0, baseName = undefined) {
  try {
    const res = await apiRequest('/api/gps/update', {
      method: 'POST',
      body: JSON.stringify({
        gps_enabled: enabled,
        latitude: lat,
        longitude: lng,
        accuracy,
        speed,
        heading,
        base_name: baseName
      })
    });
    if (res.operators) {
      state.operators = res.operators;
      renderOperators();
      renderRadarMarkers();
      updateGpsUiState();
    }
  } catch (err) {
    console.error('GPS update error:', err);
  }
}

async function setBaseCostaRica() {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  switchTab('mapa');
  const lat = 9.3712;
  const lng = -83.7029;
  state.gpsActive = true;
  await applyNewUserCoordinates(
    lat,
    lng,
    5.0,
    0,
    0,
    'Base Operaciones CR · San Isidro de El General, PZ'
  );
  showToast('🇨🇷 Base CR fijada en San Isidro de El General, Pérez Zeledón (9.3712, -83.7029)');
}

function focusOperatorOnMap(operatorId) {
  switchTab('mapa');
  const op = state.operators.find((o) => o.id === operatorId);
  if (!op || !state.map) return;
  state.map.flyTo([op.latitude, op.longitude], 15, { duration: 0.8 });
  const marker = state.markers[op.id];
  if (marker) marker.openPopup();
}

// ============================================================================
// 7. Direct 1:1 Calls & SOS Emergency Alert
// ============================================================================
async function initiateDirectCall(targetUserId, targetCallsign) {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  try {
    const res = await apiRequest('/api/calls/direct', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: targetUserId,
        call_type: '1:1',
        message: `Enlace directo 1:1 solicitado por ${state.user.callsign}`
      })
    });
    if (res.room_code) {
      await tuneToChannel(res.room_code);
      showToast(`📞 Llamada 1:1 enviada a ${targetCallsign}. Sintonizado en ${res.room_code}`);
    }
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  }
}

async function triggerSosAlert() {
  if (!state.user) {
    await ensureAuthenticatedSession();
  }
  playSosSirenTone();
  try {
    await apiRequest('/api/calls/direct', {
      method: 'POST',
      body: JSON.stringify({
        call_type: 'SOS',
        latitude: state.user.latitude,
        longitude: state.user.longitude,
        message: `🚨 ALERTA SOS GEOLOCALIZADA de ${state.user.callsign} (${state.user.name})`
      })
    });
    showToast('🚨 Alerta SOS Geolocalizada transmitida con tus coordenadas GPS a toda la red.');
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  }
}

function showIncomingCallBanner(call) {
  state.incomingCall = call;
  playSosSirenTone();
  const banner = document.getElementById('incoming-call-banner');
  const title = document.getElementById('incoming-banner-title');
  const desc = document.getElementById('incoming-banner-desc');

  title.textContent =
    call.call_type === 'SOS'
      ? `🚨 ALERTA SOS GEOLOCALIZADA DE ${call.from_callsign}`
      : `LLAMADA DIRECTA 1:1 ENTRANTE DE ${call.from_callsign}.`;
  desc.textContent = `${call.message} · Sala: ${call.room_code}`;
  banner.classList.remove('hidden');
}

function viewIncomingLocation() {
  if (!state.incomingCall) return;
  switchTab('mapa');
  if (state.map && state.incomingCall.latitude && state.incomingCall.longitude) {
    state.map.flyTo([state.incomingCall.latitude, state.incomingCall.longitude], 15);
  }
}

async function respondIncomingCall() {
  if (!state.incomingCall) return;
  const roomCode = state.incomingCall.room_code;
  dismissIncomingCall();
  await tuneToChannel(roomCode);
}

function dismissIncomingCall() {
  state.incomingCall = null;
  document.getElementById('incoming-call-banner').classList.add('hidden');
}

// ============================================================================
// 8. Tabs & Authentication / Password Recovery (support@auraflowtech.lat)
// ============================================================================
function switchTab(tabName) {
  document.querySelectorAll('.console-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tab-${tabName}`);
  });
  if (tabName === 'mapa') {
    initRadarMapIfNeeded();
  }
}

function openAuthModal() {
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.authtab === tab);
  });
  document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
  document.getElementById('form-recover').classList.toggle('hidden', tab !== 'recover');
  hideAuthFeedback();
}

function showAuthFeedback(msg, isError = false) {
  const el = document.getElementById('auth-feedback');
  el.textContent = msg;
  el.className = `auth-feedback ${isError ? 'err' : 'ok'}`;
  el.classList.remove('hidden');
}

function hideAuthFeedback() {
  document.getElementById('auth-feedback').classList.add('hidden');
}

async function quickLoginFounder() {
  try {
    const res = await apiRequest('/api/auth/quick', {
      method: 'POST',
      body: JSON.stringify({ callsign: 'AURA-01' })
    });
    await completeAuthSuccess(res, true);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function submitLogin(e) {
  e.preventDefault();
  try {
    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;
    const enableGps = document.getElementById('login-gps-check').checked;
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password, enable_gps: enableGps })
    });
    await completeAuthSuccess(res, enableGps);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function submitRegister(e) {
  e.preventDefault();
  try {
    const callsign = document.getElementById('reg-callsign').value.trim().toUpperCase();
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const enableGps = document.getElementById('reg-gps-check').checked;
    const res = await apiRequest('/api/auth/register-request', {
      method: 'POST',
      body: JSON.stringify({ callsign, name, email, password, enable_gps: enableGps })
    });
    if (res.verification_required) {
      document.getElementById('reg-verify-box').classList.remove('hidden');
      if (res.code_6) {
        document.getElementById('reg-code').value = res.code_6;
      }
      showAuthFeedback(res.message, false);
      return;
    }
    await completeAuthSuccess(res, enableGps);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function verifyRegistrationCode() {
  try {
    const email = document.getElementById('reg-email').value.trim();
    const code6 = document.getElementById('reg-code').value.trim();
    const enableGps = document.getElementById('reg-gps-check').checked;
    const res = await apiRequest('/api/auth/register-verify', {
      method: 'POST',
      body: JSON.stringify({ email, code_6: code6 })
    });
    await completeAuthSuccess(res, enableGps);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function requestRecoveryCode() {
  try {
    const identifier = document.getElementById('rec-identifier').value.trim();
    const res = await apiRequest('/api/auth/recover-request', {
      method: 'POST',
      body: JSON.stringify({ identifier })
    });
    if (res.code_6) {
      document.getElementById('rec-code').value = res.code_6;
    }
    showAuthFeedback(res.message, false);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function verifyRecoveryCode() {
  try {
    const identifier = document.getElementById('rec-identifier').value.trim();
    const code6 = document.getElementById('rec-code').value.trim();
    const newPassword = document.getElementById('rec-newpass').value;
    const res = await apiRequest('/api/auth/recover-verify', {
      method: 'POST',
      body: JSON.stringify({ identifier, code_6: code6, new_password: newPassword })
    });
    await completeAuthSuccess(res, true);
  } catch (err) {
    showAuthFeedback(err.message, true);
  }
}

async function completeAuthSuccess(res, autoStartGps = false) {
  state.token = res.token;
  state.loggedOutManually = false;
  localStorage.setItem('auraflow_radio_token', res.token);
  localStorage.removeItem('auraflow_radio_logged_out');
  setAuthenticatedUser(res.user);
  closeAuthModal();
  playPttStartChirp();
  connectRealtimeStream();
  await bootstrapRadio();
  if (autoStartGps) {
    startRealBrowserGps();
  }
  showToast(`🎙️ Conectado al Radio como ${res.user.callsign} (${res.user.name})`);
}

async function logoutRadio() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch {}
  stopRealBrowserGps();
  state.token = '';
  state.user = null;
  state.loggedOutManually = true;
  localStorage.removeItem('auraflow_radio_token');
  localStorage.setItem('auraflow_radio_logged_out', '1');
  updateSessionHeader();
  renderAllPanels();
  showToast('Sesión cerrada. Radio en modo STANDBY.');
}

function showToast(message) {
  const toast = document.getElementById('radio-toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3800);
}
