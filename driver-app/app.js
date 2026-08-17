const state = { token: localStorage.getItem('swifttrack_driver_token'), driver: readDriver(), route: null, selectedStop: null, outcome: 'delivered', signatureDirty: false, socket: null, reconnectTimer: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function readDriver() { try { return JSON.parse(localStorage.getItem('swifttrack_driver') || 'null'); } catch { return null; } }
function headers() { return state.token ? { Authorization: `Bearer ${state.token}` } : {}; }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value ?? '—'; return node.innerHTML; }
function stopId(stop) { return stop.order_code || stop.order_id || stop.id; }
function statusOf(stop) { return String(stop.status || 'pending').toLowerCase(); }
function finished(stop) { return ['completed', 'delivered', 'failed'].includes(statusOf(stop)); }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...headers(), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/driver/login') { logout(); toast('Your session expired. Please sign in again.', 'error'); }
  if (!response.ok) throw new Error(payload.message || payload.detail || payload.error || 'Request failed');
  return payload;
}

function toast(message, kind = '') { const item = document.createElement('div'); item.className = `toast ${kind}`; item.textContent = message; $('#toastRegion').append(item); setTimeout(() => item.remove(), 4200); }
function busy(button, active, label) { if (!button.dataset.label) button.dataset.label = button.innerHTML; button.disabled = active; button.innerHTML = active ? label : button.dataset.label; }

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; $('#loginError').textContent = ''; busy(button, true, 'Signing in…');
  try {
    const result = await api('/api/auth/driver/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }) });
    state.token = result.token; state.driver = result.driver; localStorage.setItem('swifttrack_driver_token', state.token); localStorage.setItem('swifttrack_driver', JSON.stringify(state.driver)); showDashboard(); toast('Route access granted');
  } catch (error) { $('#loginError').textContent = error.message; } finally { busy(button, false); }
});

function showDashboard() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  const name = state.driver?.name || 'Driver'; $('#driverGreeting').textContent = name.split(' ')[0]; $('#vehicleNumber').textContent = state.driver?.vehicle || 'Assigned vehicle'; $('#driverAvatar').textContent = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  loadRoute(); connectWebSocket();
}

function logout() {
  localStorage.removeItem('swifttrack_driver_token'); localStorage.removeItem('swifttrack_driver'); clearTimeout(state.reconnectTimer); state.socket?.close(); state.token = null; state.driver = null; state.route = null;
  $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
}

async function loadRoute() {
  $('#stopsLoading').classList.remove('hidden'); $('#stopsEmpty').classList.add('hidden');
  try { const result = await api('/api/driver/route/today'); state.route = result.route || result; renderRoute(); }
  catch (error) { toast(`Could not load route: ${error.message}`, 'error'); }
  finally { $('#stopsLoading').classList.add('hidden'); }
}

function renderRoute() {
  const route = state.route || {}; const stops = Array.isArray(route.stops) ? route.stops : []; const completed = stops.filter((stop) => ['completed', 'delivered'].includes(statusOf(stop))); const failed = stops.filter((stop) => statusOf(stop) === 'failed');
  $('#routeId').textContent = route.route_id || 'No route assigned'; $('#routeBadge').textContent = `${stops.length} stop${stops.length === 1 ? '' : 's'}`; $('#totalStops').textContent = stops.length; $('#pendingStops').textContent = stops.filter((stop) => !finished(stop)).length; $('#completedStops').textContent = completed.length; $('#failedStops').textContent = failed.length;
  const date = route.date ? new Date(`${route.date}T12:00:00`) : new Date(); $('#routeDate').textContent = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); $('#dayName').textContent = date.toLocaleDateString(undefined, { weekday: 'long' }); $('#fullDate').textContent = date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const percent = stops.length ? Math.round(((completed.length + failed.length) / stops.length) * 100) : 0; $('#progressValue').textContent = `${percent}%`; $('#progressCircle').style.strokeDashoffset = String(301.6 - (301.6 * percent / 100));
  $('#stopsEmpty').classList.toggle('hidden', stops.length > 0); $('#stopsList').innerHTML = stops.map(stopTemplate).join('');
  $$('.complete-button').forEach((button) => button.addEventListener('click', () => openDelivery(button.dataset.order)));
  const finishedStops = stops.filter(finished); $('#completedList').innerHTML = finishedStops.length ? finishedStops.map((stop) => `<div class="completed-item"><div><strong>${escapeHtml(stopId(stop))}</strong><p>${escapeHtml(stop.delivery_address || stop.address)}</p></div><span class="status ${statusOf(stop)}">${escapeHtml(statusOf(stop))}</span></div>`).join('') : '<p class="empty-copy">No stops completed yet.</p>';
}

function stopTemplate(stop) {
  const id = stopId(stop); const status = statusOf(stop); const lat = stop.delivery_lat ?? stop.lat; const lng = stop.delivery_lng ?? stop.lng; const eta = stop.estimated_arrival || stop.eta; const mapUrl = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}` : '#';
  return `<article class="stop-card"><div class="sequence">${escapeHtml(stop.sequence || stop.sequence_number || '•')}</div><div class="stop-main"><h4>${escapeHtml(stop.delivery_address || stop.address || id)}</h4><p class="pickup">Pickup: ${escapeHtml(stop.pickup_address || 'SwiftLogistics warehouse')}</p><div class="stop-meta"><span>${escapeHtml(id)}</span><span>ETA ${formatTime(eta)}</span><span>${escapeHtml(stop.distance_from_previous_km ?? '—')} km</span><span>${escapeHtml(stop.weight_kg ?? stop.weight ?? '—')} kg</span></div></div><div class="stop-actions"><span class="status ${status}">${escapeHtml(status.replaceAll('_', ' '))}</span>${finished(stop) ? '' : `<button class="complete-button" data-order="${escapeHtml(id)}">Update stop</button>`}<a class="map-link" href="${mapUrl}" target="_blank" rel="noopener">Open directions ↗</a></div></article>`;
}

function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function openDelivery(orderId) {
  state.selectedStop = state.route.stops.find((stop) => stopId(stop) === orderId); setOutcome('delivered'); $('#deliveryForm').reset(); $('#deliveryError').textContent = ''; $('#deliveryTitle').textContent = `Complete ${orderId}`; $('#selectedStopSummary').innerHTML = `<strong>${escapeHtml(state.selectedStop.delivery_address || orderId)}</strong><span>Stop ${escapeHtml(state.selectedStop.sequence || '—')} · ${escapeHtml(orderId)}</span>`; $('#deliveryDialog').showModal(); requestAnimationFrame(resizeCanvas);
}

function setOutcome(mode) { state.outcome = mode; $$('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode)); $('#deliveredFields').classList.toggle('hidden', mode !== 'delivered'); $('#failedFields').classList.toggle('hidden', mode !== 'failed'); }
$$('[data-mode]').forEach((button) => button.addEventListener('click', () => setOutcome(button.dataset.mode)));
$('#closeDialog').addEventListener('click', () => $('#deliveryDialog').close()); $('#cancelDelivery').addEventListener('click', () => $('#deliveryDialog').close());

const canvas = $('#signatureCanvas'); const context = canvas.getContext('2d'); let drawing = false;
function resizeCanvas() { const ratio = window.devicePixelRatio || 1; const rect = canvas.getBoundingClientRect(); canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio)); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.lineWidth = 2; context.lineCap = 'round'; context.strokeStyle = '#173f33'; state.signatureDirty = false; }
function point(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
canvas.addEventListener('pointerdown', (event) => { drawing = true; state.signatureDirty = true; canvas.setPointerCapture(event.pointerId); const p = point(event); context.beginPath(); context.moveTo(p.x, p.y); });
canvas.addEventListener('pointermove', (event) => { if (!drawing) return; const p = point(event); context.lineTo(p.x, p.y); context.stroke(); });
canvas.addEventListener('pointerup', () => { drawing = false; }); canvas.addEventListener('pointercancel', () => { drawing = false; });
$('#clearSignature').addEventListener('click', () => { context.clearRect(0, 0, canvas.width, canvas.height); state.signatureDirty = false; });

$('#deliveryForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; const fields = new FormData(event.currentTarget); const recipient = String(fields.get('recipient_name') || '').trim(); const reason = fields.get('reason');
  if (state.outcome === 'delivered' && (!recipient || !state.signatureDirty)) { $('#deliveryError').textContent = 'Recipient name and signature are required.'; return; }
  if (state.outcome === 'failed' && !reason) { $('#deliveryError').textContent = 'Select a failure reason.'; return; }
  const payload = { status: state.outcome, recipient_name: recipient, signature: state.outcome === 'delivered' ? canvas.toDataURL('image/png') : null, reason: state.outcome === 'failed' ? reason : null, notes: fields.get('notes') };
  $('#deliveryError').textContent = ''; busy(button, true, 'Submitting…');
  try { await api(`/api/driver/delivery/${encodeURIComponent(stopId(state.selectedStop))}`, { method: 'POST', body: JSON.stringify(payload) }); $('#deliveryDialog').close(); toast(`Delivery ${state.outcome} recorded`); await loadRoute(); }
  catch (error) { $('#deliveryError').textContent = error.message; } finally { busy(button, false); }
});

function navigate(section, button) { $$('.sidebar nav .nav-item').forEach((item) => item.classList.remove('active')); button.classList.add('active'); $(section).scrollIntoView({ behavior: 'smooth', block: 'start' }); $('.sidebar').classList.remove('open'); }
$('#routeNav').addEventListener('click', () => navigate('#routeSection', $('#routeNav'))); $('#completedNav').addEventListener('click', () => navigate('#completedSection', $('#completedNav'))); $('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open')); $('#refreshButton').addEventListener('click', loadRoute); $('#logoutButton').addEventListener('click', logout);
document.addEventListener('click', (event) => { if (innerWidth <= 720 && !event.target.closest('.sidebar') && !event.target.closest('#menuButton')) $('.sidebar').classList.remove('open'); });

function connectWebSocket() {
  if (!state.driver?.id) return; clearTimeout(state.reconnectTimer); const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; state.socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket.addEventListener('open', () => { $('#connectionDot').classList.add('online'); $('#connectionText').textContent = 'Live route connected'; state.socket.send(JSON.stringify({ type: 'register_driver', driver_id: state.driver.id, driverId: state.driver.id })); });
  state.socket.addEventListener('message', (event) => { try { const message = JSON.parse(event.data); if (!['connected', 'registered', 'pong'].includes(message.type)) { toast('Route update received'); loadRoute(); } } catch { /* Ignore malformed events. */ } });
  state.socket.addEventListener('close', () => { $('#connectionDot').classList.remove('online'); $('#connectionText').textContent = 'Updates reconnecting…'; state.reconnectTimer = setTimeout(connectWebSocket, 4000); }); state.socket.addEventListener('error', () => state.socket.close());
}

if (state.token && state.driver) showDashboard();
