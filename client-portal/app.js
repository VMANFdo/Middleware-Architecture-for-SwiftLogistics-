const state = { token: localStorage.getItem('swifttrack_token'), client: readStoredClient(), orders: [], updates: [], unreadUpdates: 0, socket: null, reconnectTimer: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function readStoredClient() {
  try { return JSON.parse(localStorage.getItem('swifttrack_client') || 'null'); } catch { return null; }
}

function clientId() { return state.client?.id || state.client?.client_id || state.client?.client_code || localStorage.getItem('clientId'); }
function authHeaders() { return state.token ? { Authorization: `Bearer ${state.token}` } : {}; }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value ?? '—'; return node.innerHTML; }
function normaliseStatus(value) { return String(value || 'pending').toLowerCase().replaceAll(' ', '_'); }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/client/login') {
    logout();
    showToast('Your session has expired. Please sign in again.', 'error');
  }
  if (!response.ok) throw new Error(payload.message || payload.detail || payload.error || 'Request failed');
  return payload;
}

function showToast(message, kind = '') {
  const toast = document.createElement('div'); toast.className = `toast ${kind}`; toast.textContent = message;
  $('#toastRegion').append(toast); setTimeout(() => toast.remove(), 4200);
}

function setBusy(button, busy, label) {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = busy; button.innerHTML = busy ? label : button.dataset.label;
}

function showDashboard() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  const name = state.client?.company_name || state.client?.name || 'Client';
  $('#companyName').textContent = name; $('#clientGreeting').textContent = name.split(' ')[0];
  $('#clientAvatar').textContent = name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  loadOrders(); connectWebSocket();
}

function logout() {
  localStorage.removeItem('swifttrack_token'); localStorage.removeItem('swifttrack_client'); localStorage.removeItem('clientId');
  clearTimeout(state.reconnectTimer); state.socket?.close(); state.token = null; state.client = null;
  $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; $('#loginError').textContent = ''; setBusy(button, true, 'Signing in…');
  try {
    const result = await api('/api/auth/client/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }) });
    state.token = result.token || result.access_token || ''; state.client = result.client || result.data || { id: result.client_id || result.client_code, company_name: result.company_name, email: $('#email').value.trim() };
    if (!result.success && !clientId()) throw new Error(result.message || 'Invalid email or password');
    localStorage.setItem('swifttrack_token', state.token); localStorage.setItem('swifttrack_client', JSON.stringify(state.client)); localStorage.setItem('clientId', clientId() || '');
    showDashboard(); showToast('Welcome to SwiftTrack');
  } catch (error) { $('#loginError').textContent = error.message; } finally { setBusy(button, false); }
});

async function loadOrders() {
  $('#ordersLoading').classList.remove('hidden'); $('#ordersEmpty').classList.add('hidden');
  try {
    const query = clientId() ? `?client_code=${encodeURIComponent(clientId())}` : '';
    const result = await api(`/api/orders${query}`); state.orders = result.orders || result.data || [];
    renderOrders(); updateStats();
  } catch (error) { showToast(`Could not load orders: ${error.message}`, 'error'); state.orders = []; renderOrders(); }
  finally { $('#ordersLoading').classList.add('hidden'); }
}

function orderValue(order, ...keys) { for (const key of keys) if (order[key] !== undefined && order[key] !== null) return order[key]; return ''; }
function renderOrders() {
  const term = $('#orderSearch').value.toLowerCase();
  const orders = state.orders.filter((order) => JSON.stringify(order).toLowerCase().includes(term));
  $('#ordersEmpty').classList.toggle('hidden', orders.length > 0);
  $('#ordersBody').innerHTML = orders.map((order) => {
    const id = orderValue(order, 'order_id', 'order_code', 'id'); const pickup = orderValue(order, 'pickup_address', 'pickup'); const delivery = orderValue(order, 'delivery_address', 'delivery');
    const weight = orderValue(order, 'weight', 'weight_kg', 'package_weight'); const status = normaliseStatus(order.status); const created = orderValue(order, 'created_at', 'createdAt', 'date');
    return `<tr><td><span class="order-id">${escapeHtml(id)}</span></td><td class="route-cell"><strong>${escapeHtml(pickup)}</strong><span>to ${escapeHtml(delivery)}</span></td><td>${escapeHtml(weight)} kg</td><td>${formatDate(created)}</td><td><span class="badge ${status}">${escapeHtml(status.replaceAll('_', ' '))}</span></td><td><button class="row-action" data-order="${escapeHtml(id)}">Details</button></td></tr>`;
  }).join('');
  $$('.row-action').forEach((button) => button.addEventListener('click', () => showDetails(button.dataset.order)));
}

function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }
function updateStats() {
  const statuses = state.orders.map((order) => normaliseStatus(order.status));
  $('#totalOrders').textContent = state.orders.length; $('#activeOrders').textContent = statuses.filter((s) => !['delivered', 'completed', 'failed'].includes(s)).length;
  $('#transitOrders').textContent = statuses.filter((s) => s === 'in_transit').length; $('#deliveredOrders').textContent = statuses.filter((s) => ['delivered', 'completed'].includes(s)).length;
}

function openOrderDialog() { $('#orderError').textContent = ''; $('#orderDialog').showModal(); }
$('#newOrderButton').addEventListener('click', openOrderDialog); $('#newOrderNav').addEventListener('click', openOrderDialog);
$$('[data-close]').forEach((button) => button.addEventListener('click', () => $('#orderDialog').close()));

function navigateTo(sectionSelector, navButton) {
  $$('.sidebar nav .nav-item').forEach((button) => button.classList.remove('active'));
  navButton.classList.add('active');
  $(sectionSelector).scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('.sidebar').classList.remove('open');
}

$('#ordersNav').addEventListener('click', () => navigateTo('#ordersSection', $('#ordersNav')));
$('#updatesNav').addEventListener('click', () => {
  state.unreadUpdates = 0;
  renderUpdateCount();
  navigateTo('#updatesSection', $('#updatesNav'));
});

$('#orderForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; const data = Object.fromEntries(new FormData(event.currentTarget));
  const payload = { ...data, client_code: clientId(), pickup_lat: Number(data.pickup_lat), pickup_lng: Number(data.pickup_lng), delivery_lat: Number(data.delivery_lat), delivery_lng: Number(data.delivery_lng), weight: Number(data.weight), weight_kg: Number(data.weight) };
  $('#orderError').textContent = ''; setBusy(button, true, 'Creating…');
  try { const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) }); $('#orderDialog').close(); event.currentTarget.reset(); showToast(`Order ${result.order?.order_id || result.order_id || result.order_code || ''} created successfully`); await loadOrders(); }
  catch (error) { $('#orderError').textContent = error.message; } finally { setBusy(button, false); }
});

async function showDetails(id) {
  $('#detailsTitle').textContent = id; $('#detailsContent').innerHTML = '<p class="details-message">Loading tracking information…</p>'; $('#detailsDialog').showModal();
  let result; try { result = await api(`/api/orders/${encodeURIComponent(id)}`); } catch { result = { order: state.orders.find((order) => [order.order_id, order.order_code, order.id].includes(id)) }; }
  const order = result.order || result.data || {}; const pack = result.package || result.packages?.[0] || {}; const route = result.route || {};
  const fields = [['Status', order.status], ['Pickup', order.pickup_address], ['Delivery', order.delivery_address], ['Package barcode', pack.barcode], ['Warehouse location', pack.warehouse_location || pack.location], ['Driver', route.driver_id || route.driver_code], ['Estimated arrival', route.estimated_arrival || route.eta], ['Transaction', result.transaction_id || order.transaction_id]];
  $('#detailsContent').innerHTML = `<div class="details-grid">${fields.map(([label, value]) => `<div class="detail-card"><span>${label}</span><strong>${escapeHtml(value || 'Awaiting update')}</strong></div>`).join('')}</div>`;
}
$$('[data-close-details]').forEach((button) => button.addEventListener('click', () => $('#detailsDialog').close()));

function connectWebSocket() {
  if (!clientId()) return; clearTimeout(state.reconnectTimer); const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket.addEventListener('open', () => { $('#connectionDot').classList.add('online'); $('#connectionText').textContent = 'Live updates connected'; state.socket.send(JSON.stringify({ type: 'register_client', client_id: clientId(), clientId: clientId() })); });
  state.socket.addEventListener('message', (event) => { try { handleSocketMessage(JSON.parse(event.data)); } catch { /* Ignore malformed backend events. */ } });
  state.socket.addEventListener('close', () => { $('#connectionDot').classList.remove('online'); $('#connectionText').textContent = 'Updates reconnecting…'; state.reconnectTimer = setTimeout(connectWebSocket, 4000); });
  state.socket.addEventListener('error', () => state.socket.close());
}

function handleSocketMessage(message) {
  if (['connected', 'registered', 'pong'].includes(message.type)) return;
  const id = message.order_id || message.data?.order_id || 'an order'; const status = message.status || message.data?.status || message.event_type || message.type;
  const text = `${id}: ${String(status).replaceAll('_', ' ').toLowerCase()}`; state.updates.unshift({ text, source: message.source || 'SwiftTrack', time: message.timestamp || new Date().toISOString() }); state.updates = state.updates.slice(0, 30); state.unreadUpdates += 1;
  renderUpdates(); showToast(text); loadOrders();
}

function renderUpdateCount() {
  $('#updateCount').textContent = state.unreadUpdates;
  $('#updateCount').hidden = state.unreadUpdates === 0;
}

function renderUpdates() {
  renderUpdateCount();
  $('#updatesList').innerHTML = state.updates.length ? state.updates.map((update) => `<div class="update-item"><i></i><div><strong>${escapeHtml(update.text)}</strong><p>Source: ${escapeHtml(update.source)}</p></div><time>${new Date(update.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<p class="empty-copy">No live updates received in this session.</p>';
}

$('#orderSearch').addEventListener('input', renderOrders); $('#refreshButton').addEventListener('click', loadOrders); $('#logoutButton').addEventListener('click', logout);
$('#clearUpdates').addEventListener('click', () => { state.updates = []; state.unreadUpdates = 0; renderUpdates(); }); $('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
document.addEventListener('click', (event) => { if (innerWidth <= 720 && !event.target.closest('.sidebar') && !event.target.closest('#menuButton')) $('.sidebar').classList.remove('open'); });

if (state.client && (state.token !== null || clientId())) showDashboard();
