/* ══════════════════════════════════════════════════════════════════════
   SwiftTrack Driver Portal — app.js
   Handles: auth, route loading, delivery POD, WebSocket, push notifications, PWA
══════════════════════════════════════════════════════════════════════ */

const state = {
  token: localStorage.getItem('swifttrack_driver_token'),
  driver: readDriver(),
  route: null,
  selectedStop: null,
  outcome: 'delivered',
  signatureDirty: false,
  socket: null,
  reconnectTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function readDriver() {
  try { return JSON.parse(localStorage.getItem('swifttrack_driver') || 'null'); } catch { return null; }
}
function headers() { return state.token ? { Authorization: `Bearer ${state.token}` } : {}; }
function escapeHtml(value) { const n = document.createElement('span'); n.textContent = value ?? '—'; return n.innerHTML; }
function stopId(stop) { return stop.order_code || stop.order_id || stop.id; }
function statusOf(stop) { return String(stop.status || 'pending').toLowerCase(); }
function finished(stop) { return ['completed', 'delivered', 'failed'].includes(statusOf(stop)); }

/* ── API helper ─────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...headers(), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/driver/login') {
    logout(); toast('Your session expired. Please sign in again.', 'error');
  }
  if (!response.ok) throw new Error(payload.message || payload.detail || payload.error || 'Request failed');
  return payload;
}

/* ── Toast ──────────────────────────────────────────────────────────── */
function toast(message, kind = '') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  $('#toastRegion').append(item);
  setTimeout(() => item.remove(), 4200);
}

function busy(button, active, label) {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = active;
  button.innerHTML = active ? label : button.dataset.label;
}

/* ══════════════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS
══════════════════════════════════════════════════════════════════════ */

function showNotifBanner() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('swifttrack_notif_dismissed')) return;
  $('#notifBanner').classList.remove('hidden');
}

function hideNotifBanner() {
  $('#notifBanner').classList.add('hidden');
}

$('#notifAllow').addEventListener('click', async () => {
  hideNotifBanner();
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    toast('Notifications enabled — you\'ll be alerted on new route updates.');
    sendPushNotification('SwiftTrack', 'Push notifications are now active for your route.');
  }
});

$('#notifDismiss').addEventListener('click', () => {
  hideNotifBanner();
  localStorage.setItem('swifttrack_notif_dismissed', '1');
});

function sendPushNotification(title, body, tag = 'route-update') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notif = new Notification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      renotify: true,
    });
    notif.onclick = () => { window.focus(); notif.close(); };
  } catch { /* Safari may not support all options — silent fail */ }
}

/* ══════════════════════════════════════════════════════════════════════
   SERVICE WORKER / PWA
══════════════════════════════════════════════════════════════════════ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW not critical — silent fail */
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════════════ */

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  $('#loginError').textContent = '';
  busy(button, true, 'Signing in…');
  try {
    const result = await api('/api/auth/driver/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }),
    });
    state.token = result.token;
    state.driver = result.driver;
    localStorage.setItem('swifttrack_driver_token', state.token);
    localStorage.setItem('swifttrack_driver', JSON.stringify(state.driver));
    showDashboard();
    toast('Route access granted');
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally {
    busy(button, false);
  }
});

function showDashboard() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  const name = state.driver?.name || 'Driver';
  $('#driverGreeting').textContent = name.split(' ')[0];
  $('#vehicleNumber').textContent = state.driver?.vehicle || 'Assigned vehicle';
  $('#driverAvatar').textContent = name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  loadRoute();
  connectWebSocket();
  // Show notification permission banner after a short delay
  setTimeout(showNotifBanner, 1500);
}

function logout() {
  localStorage.removeItem('swifttrack_driver_token');
  localStorage.removeItem('swifttrack_driver');
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
  state.token = null; state.driver = null; state.route = null;
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  hideNotifBanner();
}

/* ══════════════════════════════════════════════════════════════════════
   ROUTE
══════════════════════════════════════════════════════════════════════ */

async function loadRoute() {
  $('#stopsLoading').classList.remove('hidden');
  $('#stopsEmpty').classList.add('hidden');
  try {
    const result = await api('/api/driver/route/today');
    state.route = result.route || result;
    renderRoute();
  } catch (error) {
    toast(`Could not load route: ${error.message}`, 'error');
  } finally {
    $('#stopsLoading').classList.add('hidden');
  }
}

function renderRoute() {
  const route = state.route || {};
  const stops = Array.isArray(route.stops) ? route.stops : [];
  const completed = stops.filter((s) => ['completed', 'delivered'].includes(statusOf(s)));
  const failed = stops.filter((s) => statusOf(s) === 'failed');

  $('#routeId').textContent = route.route_id || 'No route assigned';
  $('#routeBadge').textContent = `${stops.length} stop${stops.length === 1 ? '' : 's'}`;
  $('#totalStops').textContent = stops.length;
  $('#pendingStops').textContent = stops.filter((s) => !finished(s)).length;
  $('#completedStops').textContent = completed.length;
  $('#failedStops').textContent = failed.length;

  const date = route.date ? new Date(`${route.date}T12:00:00`) : new Date();
  $('#routeDate').textContent = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#dayName').textContent = date.toLocaleDateString(undefined, { weekday: 'long' });
  $('#fullDate').textContent = date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  const percent = stops.length ? Math.round(((completed.length + failed.length) / stops.length) * 100) : 0;
  $('#progressValue').textContent = `${percent}%`;
  $('#progressCircle').style.strokeDashoffset = String(301.6 - (301.6 * percent / 100));

  $('#stopsEmpty').classList.toggle('hidden', stops.length > 0);
  $('#stopsList').innerHTML = stops.map(stopTemplate).join('');
  $$('.complete-button').forEach((btn) => btn.addEventListener('click', () => openDelivery(btn.dataset.order)));

  const finishedStops = stops.filter(finished);
  $('#completedList').innerHTML = finishedStops.length
    ? finishedStops.map((s) => `<div class="completed-item"><div><strong>${escapeHtml(stopId(s))}</strong><p>${escapeHtml(s.delivery_address || s.address)}</p></div><span class="status ${statusOf(s)}">${escapeHtml(statusOf(s))}</span></div>`).join('')
    : '<p class="empty-copy">No stops completed yet.</p>';
}

function stopTemplate(stop) {
  const id = stopId(stop);
  const status = statusOf(stop);
  const lat = stop.delivery_lat ?? stop.lat;
  const lng = stop.delivery_lng ?? stop.lng;
  const eta = stop.estimated_arrival || stop.eta;
  const mapUrl = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}`
    : '#';
  return `<article class="stop-card">
    <div class="sequence">${escapeHtml(stop.sequence || stop.sequence_number || '•')}</div>
    <div class="stop-main">
      <h4>${escapeHtml(stop.delivery_address || stop.address || id)}</h4>
      <p class="pickup">Pickup: ${escapeHtml(stop.pickup_address || 'SwiftLogistics warehouse')}</p>
      <div class="stop-meta">
        <span>${escapeHtml(id)}</span>
        <span>ETA ${formatTime(eta)}</span>
        <span>${escapeHtml(stop.distance_from_previous_km ?? '—')} km</span>
        <span>${escapeHtml(stop.weight_kg ?? stop.weight ?? '—')} kg</span>
      </div>
    </div>
    <div class="stop-actions">
      <span class="status ${status}">${escapeHtml(status.replaceAll('_', ' '))}</span>
      ${finished(stop) ? '' : `<button class="complete-button" data-order="${escapeHtml(id)}">Update stop</button>`}
      <a class="map-link" href="${mapUrl}" target="_blank" rel="noopener">Directions ↗</a>
    </div>
  </article>`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ══════════════════════════════════════════════════════════════════════
   DELIVERY DIALOG
══════════════════════════════════════════════════════════════════════ */

function openDelivery(orderId) {
  state.selectedStop = state.route.stops.find((s) => stopId(s) === orderId);
  setOutcome('delivered');
  $('#deliveryForm').reset();
  $('#deliveryError').textContent = '';
  $('#deliveryTitle').textContent = `Complete ${orderId}`;
  $('#selectedStopSummary').innerHTML = `<strong>${escapeHtml(state.selectedStop.delivery_address || orderId)}</strong><span>Stop ${escapeHtml(state.selectedStop.sequence || '—')} · ${escapeHtml(orderId)}</span>`;
  $('#deliveryDialog').showModal();
  requestAnimationFrame(resizeCanvas);
}

function setOutcome(mode) {
  state.outcome = mode;
  $$('[data-mode]').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  $('#deliveredFields').classList.toggle('hidden', mode !== 'delivered');
  $('#failedFields').classList.toggle('hidden', mode !== 'failed');
}

$$('[data-mode]').forEach((btn) => btn.addEventListener('click', () => setOutcome(btn.dataset.mode)));
$('#closeDialog').addEventListener('click', () => $('#deliveryDialog').close());
$('#cancelDelivery').addEventListener('click', () => $('#deliveryDialog').close());

/* ── Signature canvas ───────────────────────────────────────────────── */
const canvas = $('#signatureCanvas');
const context = canvas.getContext('2d');
let drawing = false;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.lineWidth = 2.5;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#173f33';
  state.signatureDirty = false;
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  const src = event.touches ? event.touches[0] : event;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  drawing = true; state.signatureDirty = true;
  canvas.setPointerCapture(e.pointerId);
  const p = point(e); context.beginPath(); context.moveTo(p.x, p.y);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return; const p = point(e); context.lineTo(p.x, p.y); context.stroke();
});
canvas.addEventListener('pointerup', () => { drawing = false; });
canvas.addEventListener('pointercancel', () => { drawing = false; });
$('#clearSignature').addEventListener('click', () => {
  context.clearRect(0, 0, canvas.width, canvas.height); state.signatureDirty = false;
});

$('#deliveryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const fields = new FormData(event.currentTarget);
  const recipient = String(fields.get('recipient_name') || '').trim();
  const reason = fields.get('reason');
  if (state.outcome === 'delivered' && (!recipient || !state.signatureDirty)) {
    $('#deliveryError').textContent = 'Recipient name and signature are required.'; return;
  }
  if (state.outcome === 'failed' && !reason) {
    $('#deliveryError').textContent = 'Select a failure reason.'; return;
  }
  const payload = {
    status: state.outcome,
    recipient_name: recipient,
    signature: state.outcome === 'delivered' ? canvas.toDataURL('image/png') : null,
    reason: state.outcome === 'failed' ? reason : null,
    notes: fields.get('notes'),
  };
  $('#deliveryError').textContent = '';
  busy(button, true, 'Submitting…');
  try {
    await api(`/api/driver/delivery/${encodeURIComponent(stopId(state.selectedStop))}`, {
      method: 'POST', body: JSON.stringify(payload),
    });
    $('#deliveryDialog').close();
    toast(`Delivery ${state.outcome} recorded`);
    await loadRoute();
  } catch (error) {
    $('#deliveryError').textContent = error.message;
  } finally {
    busy(button, false);
  }
});

/* ══════════════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════════════ */

function navigate(sectionId, activeButton) {
  $$('.sidebar nav .nav-item').forEach((item) => item.classList.remove('active'));
  $$('.bottom-nav-item').forEach((item) => item.classList.remove('active'));
  activeButton.classList.add('active');
  // Also highlight matching bottom-nav item
  const map = { '#routeSection': '#bottomRouteNav', '#completedSection': '#bottomCompletedNav' };
  if (map[sectionId]) $(map[sectionId])?.classList.add('active');

  $(sectionId).scrollIntoView({ behavior: 'smooth', block: 'start' });
  closeSidebar();
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebarOverlay').classList.remove('hidden');
  $('#sidebarOverlay').classList.add('open');
  $('#menuButton').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.remove('open');
  setTimeout(() => $('#sidebarOverlay').classList.add('hidden'), 250);
  $('#menuButton').setAttribute('aria-expanded', 'false');
}

$('#routeNav').addEventListener('click', () => navigate('#routeSection', $('#routeNav')));
$('#completedNav').addEventListener('click', () => navigate('#completedSection', $('#completedNav')));
$('#menuButton').addEventListener('click', () => {
  $('#sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
});
$('#sidebarOverlay').addEventListener('click', closeSidebar);
$('#refreshButton').addEventListener('click', loadRoute);
$('#logoutButton').addEventListener('click', logout);

// Bottom nav
$('#bottomRouteNav').addEventListener('click', () => {
  $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
  $('#bottomRouteNav').classList.add('active');
  navigate('#routeSection', $('#routeNav'));
});
$('#bottomCompletedNav').addEventListener('click', () => {
  $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
  $('#bottomCompletedNav').classList.add('active');
  navigate('#completedSection', $('#completedNav'));
});
$('#bottomLogoutNav').addEventListener('click', logout);

/* ══════════════════════════════════════════════════════════════════════
   WEBSOCKET + PUSH NOTIFICATIONS
══════════════════════════════════════════════════════════════════════ */

function connectWebSocket() {
  if (!state.driver?.id) return;
  clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.socket = new WebSocket(`${protocol}//${location.host}/ws`);

  state.socket.addEventListener('open', () => {
    $('#connectionDot').classList.add('online');
    $('#connectionText').textContent = 'Live route connected';
    state.socket.send(JSON.stringify({
      type: 'register_driver',
      driver_id: state.driver.id,
      driverId: state.driver.id,
    }));
  });

  state.socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (['connected', 'registered', 'pong'].includes(message.type)) return;

      // Determine notification body from message type
      let notifBody = 'Route update received.';
      if (message.type === 'route_updated' || message.type === 'new_stop') {
        notifBody = 'A new stop has been added to your route.';
      } else if (message.type === 'order_created') {
        notifBody = `New delivery order assigned: ${message.order_id || ''}`.trim();
      } else if (message.type === 'stop_updated') {
        notifBody = `Stop ${message.order_id || ''} status updated.`.trim();
      }

      toast(notifBody);
      sendPushNotification('SwiftTrack Route Update', notifBody);
      loadRoute();
    } catch { /* Ignore malformed events */ }
  });

  state.socket.addEventListener('close', () => {
    $('#connectionDot').classList.remove('online');
    $('#connectionText').textContent = 'Updates reconnecting…';
    state.reconnectTimer = setTimeout(connectWebSocket, 4000);
  });

  state.socket.addEventListener('error', () => state.socket.close());
}

/* ══════════════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════════════ */

if (state.token && state.driver) showDashboard();
