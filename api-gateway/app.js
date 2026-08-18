// =====================================================================
// SwiftTrack API Gateway
// IS3208 Middleware Architecture | Assignment 4
// Phase 3 & Phase 5: Protocol Bridging, WebSockets & Saga Coordinator
// =====================================================================

const http = require('http');
const net = require('net');
const amqp = require('amqplib');
const axios = require('axios');
const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { parseStringPromise } = require('xml2js');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const CMS_SOAP_URL = process.env.CMS_SOAP_URL || 'http://localhost:8001/soap';
const CMS_REST_URL = process.env.CMS_REST_URL || CMS_SOAP_URL.replace(/\/soap\/?$/, '');
const ROS_REST_URL = process.env.ROS_REST_URL || 'http://localhost:8002';
const WMS_TCP_HOST = process.env.WMS_TCP_HOST || 'localhost';
const WMS_TCP_PORT = Number(process.env.WMS_TCP_PORT || 9000);
const DOWNSTREAM_TIMEOUT_MS = Number(process.env.DOWNSTREAM_TIMEOUT_MS || 5000);
const JWT_SECRET = process.env.JWT_SECRET || 'swiftlogistics-secret-key-2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const JWT_ISSUER = 'swifttrack-api-gateway';
const JWT_AUDIENCE = 'swifttrack-apps';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://swift_admin:swift_pw_dev_only@postgres:5432/swifttrack';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://swift_admin:swift_pw_dev_only@rabbitmq:5672';

const pool = new Pool({ connectionString: DATABASE_URL });

const demoDrivers = new Map([
  ['kasun@swiftlogistics.lk', {
    id: 'DRV001',
    name: 'Kasun Perera',
    email: 'kasun@swiftlogistics.lk',
    vehicle: 'WP-KA-1234',
  }],
  ['nimal@swiftlogistics.lk', {
    id: 'DRV002',
    name: 'Nimal Silva',
    email: 'nimal@swiftlogistics.lk',
    vehicle: 'WP-NB-5678',
  }],
]);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createAccessToken({ id, role, email, name }) {
  return jwt.sign(
    { role, email, name },
    JWT_SECRET,
    {
      subject: id,
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
  );
}

function authenticateToken(req, res, next) {
  const authorization = req.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      success: false,
      message: 'A Bearer access token is required',
    });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    return next();
  } catch (error) {
    const message = error.name === 'TokenExpiredError'
      ? 'Access token has expired'
      : 'Access token is invalid';
    return res.status(401).json({ success: false, message });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access this resource',
      });
    }
    return next();
  };
}

// =====================================================================
// WebSockets Dispatch & Connection Management (Phase 5)
// =====================================================================

const wss = new WebSocket.Server({ server, path: '/ws' });
const clientSockets = new Map(); // client_code -> Set of sockets
const driverSockets = new Map(); // driver_code -> Set of sockets

function registerSocket(map, key, socket) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(socket);
}

function unregisterSocket(socket) {
  for (const [key, sockets] of clientSockets.entries()) {
    sockets.delete(socket);
    if (sockets.size === 0) clientSockets.delete(key);
  }
  for (const [key, sockets] of driverSockets.entries()) {
    sockets.delete(socket);
    if (sockets.size === 0) driverSockets.delete(key);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to SwiftTrack API Gateway WebSocket',
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }
      if (msg.type === 'register_client') {
        const clientCode = msg.client_id || msg.clientId || msg.client_code;
        if (clientCode) {
          registerSocket(clientSockets, clientCode, ws);
          ws.clientCode = clientCode;
          ws.send(JSON.stringify({
            type: 'registered',
            role: 'client',
            id: clientCode,
            timestamp: new Date().toISOString(),
          }));
        }
      }
      if (msg.type === 'register_driver') {
        const driverCode = msg.driver_id || msg.driverId || msg.driver_code;
        if (driverCode) {
          registerSocket(driverSockets, driverCode, ws);
          ws.driverCode = driverCode;
          ws.send(JSON.stringify({
            type: 'registered',
            role: 'driver',
            id: driverCode,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    } catch (err) {
      // Ignore malformed incoming socket payloads
    }
  });

  ws.on('close', () => unregisterSocket(ws));
  ws.on('error', () => unregisterSocket(ws));
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

function dispatchWebSocketMessage({ target, recipientId, eventType, orderCode, payload }) {
  const data = JSON.stringify({
    type: eventType || 'update',
    event_type: eventType,
    order_code: orderCode,
    order_id: orderCode,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  if (target === 'client' && recipientId) {
    const sockets = clientSockets.get(recipientId);
    if (sockets) {
      sockets.forEach((s) => s.readyState === WebSocket.OPEN && s.send(data));
    }
  } else if (target === 'driver' && recipientId) {
    const sockets = driverSockets.get(recipientId);
    if (sockets) {
      sockets.forEach((s) => s.readyState === WebSocket.OPEN && s.send(data));
    }
  } else {
    // Broadcast to all active sockets
    wss.clients.forEach((s) => {
      if (s.readyState === WebSocket.OPEN) {
        s.send(data);
      }
    });
  }
}

// =====================================================================
// Saga Transaction Coordinator & Distributed Transaction Monitoring
// =====================================================================

const activeSagas = new Map();

async function getOrderIdByCode(orderCode) {
  try {
    const res = await pool.query('SELECT id, client_id FROM orders WHERE order_code = $1', [orderCode]);
    return res.rows[0] || null;
  } catch (err) {
    console.error(`DB query error for order ${orderCode}:`, err.message);
    return null;
  }
}

async function getClientCodeById(clientId) {
  try {
    const res = await pool.query('SELECT client_code FROM clients WHERE id = $1', [clientId]);
    return res.rows[0]?.client_code || null;
  } catch (err) {
    return null;
  }
}

async function logSagaStep(orderCode, sagaStep, status, payload = {}, errorMessage = null) {
  try {
    const order = await getOrderIdByCode(orderCode);
    if (!order) {
      console.warn(`[SAGA] Order ${orderCode} not found in DB yet.`);
      return null;
    }

    const res = await pool.query(
      `INSERT INTO transaction_logs (order_id, saga_step, status, payload, error_message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [order.id, sagaStep, status, JSON.stringify(payload), errorMessage]
    );

    console.log(`[SAGA LOG] Order: ${orderCode} | Step: ${sagaStep} | Status: ${status}`);
    return res.rows[0];
  } catch (err) {
    console.error(`[SAGA ERROR] Failed to write transaction log for ${orderCode}:`, err.message);
    return null;
  }
}

async function handleSagaEvent(eventType, eventData) {
  const data = eventData.data || eventData;
  const orderCode = data.order_code || data.order_id || eventData.order_code;
  if (!orderCode) return;

  const orderRecord = await getOrderIdByCode(orderCode);
  const clientCode = data.client_code || (orderRecord ? await getClientCodeById(orderRecord.client_id) : null);

  if (!activeSagas.has(orderCode)) {
    activeSagas.set(orderCode, {
      order_code: orderCode,
      client_code: clientCode,
      steps: {
        CMS_CREATE: 'pending',
        ROS_ASSIGN: 'pending',
        WMS_ALLOCATE: 'pending',
      },
      status: 'in_progress',
      started_at: new Date().toISOString(),
    });
  }

  const saga = activeSagas.get(orderCode);
  if (clientCode) saga.client_code = clientCode;

  if (eventType === 'ORDER_CREATED') {
    saga.steps.CMS_CREATE = 'completed';
    await logSagaStep(orderCode, 'CMS_CREATE', 'completed', data);
    dispatchWebSocketMessage({
      target: 'client',
      recipientId: saga.client_code,
      eventType: 'ORDER_CREATED',
      orderCode,
      payload: {
        status: 'pending',
        message: `Order ${orderCode} registered in CMS. Saga transaction initiated.`,
        data,
      },
    });
    dispatchWebSocketMessage({
      target: 'driver',
      eventType: 'NEW_ORDER_AVAILABLE',
      orderCode,
      payload: {
        message: `New order ${orderCode} added to system.`,
        data,
      },
    });
  } else if (eventType === 'ROS_PROCESSING_COMPLETE') {
    saga.steps.ROS_ASSIGN = 'completed';
    await logSagaStep(orderCode, 'ROS_ASSIGN', 'completed', data);
    dispatchWebSocketMessage({
      target: 'client',
      recipientId: saga.client_code,
      eventType: 'ROS_PROCESSING_COMPLETE',
      orderCode,
      payload: {
        status: 'assigned',
        message: `Order ${orderCode} route optimized and assigned by ROS.`,
        data,
      },
    });
    dispatchWebSocketMessage({
      target: 'driver',
      eventType: 'ROUTE_UPDATED',
      orderCode,
      payload: {
        message: `Route updated for order ${orderCode}.`,
        data,
      },
    });
  } else if (eventType === 'WMS_PROCESSING_COMPLETE') {
    saga.steps.WMS_ALLOCATE = 'completed';
    await logSagaStep(orderCode, 'WMS_ALLOCATE', 'completed', data);
    dispatchWebSocketMessage({
      target: 'client',
      recipientId: saga.client_code,
      eventType: 'WMS_PROCESSING_COMPLETE',
      orderCode,
      payload: {
        status: 'ready',
        message: `Order ${orderCode} package allocated in zone ${data.warehouse_zone || 'warehouse'} by WMS.`,
        data,
      },
    });
  }

  if (
    saga.steps.CMS_CREATE === 'completed' &&
    saga.steps.ROS_ASSIGN === 'completed' &&
    saga.steps.WMS_ALLOCATE === 'completed' &&
    saga.status !== 'completed'
  ) {
    saga.status = 'completed';
    await logSagaStep(orderCode, 'SAGA_COMPLETE', 'completed', { saga });
    dispatchWebSocketMessage({
      target: 'client',
      recipientId: saga.client_code,
      eventType: 'SAGA_TRANSACTION_SUCCESS',
      orderCode,
      payload: {
        status: 'ready',
        message: `Distributed transaction for ${orderCode} successfully completed across CMS, ROS, and WMS.`,
      },
    });
  }
}

async function executeSagaCompensation(orderCode, failedStep, reason) {
  console.log(`[SAGA COMPENSATION] Triggered for ${orderCode} on step ${failedStep}: ${reason}`);

  const orderRecord = await getOrderIdByCode(orderCode);
  const clientCode = orderRecord ? await getClientCodeById(orderRecord.client_id) : null;

  await logSagaStep(orderCode, failedStep, 'failed', { reason }, reason);

  if (orderRecord) {
    try {
      await pool.query("UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1", [orderRecord.id]);
    } catch (err) {
      console.error('Failed to update order status to failed:', err.message);
    }
  }

  await logSagaStep(
    orderCode,
    'SAGA_COMPENSATION',
    'compensated',
    {
      failed_step: failedStep,
      reason,
      rollback_actions: ['orders.status = failed', 'broadcast_client_alert'],
    },
    `Rollback compensation executed for ${orderCode}`
  );

  if (activeSagas.has(orderCode)) {
    const saga = activeSagas.get(orderCode);
    saga.status = 'failed';
    saga.steps[failedStep] = 'failed';
  }

  dispatchWebSocketMessage({
    target: 'client',
    recipientId: clientCode,
    eventType: 'SAGA_COMPENSATED',
    orderCode,
    payload: {
      status: 'failed',
      failed_step: failedStep,
      message: `Transaction for order ${orderCode} failed at step ${failedStep}: ${reason}. Compensation executed.`,
    },
  });

  return {
    success: true,
    order_code: orderCode,
    failed_step: failedStep,
    status: 'compensated',
    reason,
  };
}

let rabbitChannel = null;

async function connectRabbitWithRetry() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();

    const exchanges = ['order_events', 'route_events', 'wms_events'];
    for (const ex of exchanges) {
      await rabbitChannel.assertExchange(ex, 'fanout', { durable: true });
    }

    const q = await rabbitChannel.assertQueue('gateway_event_queue', { durable: true });
    for (const ex of exchanges) {
      await rabbitChannel.bindQueue(q.queue, ex, '');
    }

    await rabbitChannel.prefetch(1);
    await rabbitChannel.consume(q.queue, async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString());
        const eventType = content.event_type || content.event;

        await handleSagaEvent(eventType, content);

        rabbitChannel.ack(msg);
      } catch (err) {
        console.error('[GATEWAY RABBITMQ] Event error:', err.message);
        rabbitChannel.nack(msg, false, false);
      }
    });

    connection.on('close', () => {
      rabbitChannel = null;
      console.log('Gateway RabbitMQ disconnected. Retrying in 5s...');
      setTimeout(connectRabbitWithRetry, 5000);
    });

    console.log('API Gateway connected to RabbitMQ (gateway_event_queue)');
  } catch (err) {
    console.error('Gateway RabbitMQ connection failed:', err.message);
    setTimeout(connectRabbitWithRetry, 5000);
  }
}

// =====================================================================
// Protocol Bridging Helpers (SOAP, TCP)
// =====================================================================

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSoapEnvelope(methodName, params) {
  const paramXml = Object.entries(params)
    .map(([key, value]) => `<tns:${key}>${escapeXml(value)}</tns:${key}>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="swifttrack.cms">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${methodName}>${paramXml}</tns:${methodName}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function findSoapResult(node, resultKey) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith(resultKey)) {
      return value;
    }

    const nested = Array.isArray(value)
      ? value.map((item) => findSoapResult(item, resultKey)).find(Boolean)
      : findSoapResult(value, resultKey);

    if (nested) {
      return nested;
    }
  }

  return null;
}

async function callCmsSoap(methodName, params) {
  const response = await axios.post(CMS_SOAP_URL, buildSoapEnvelope(methodName, params), {
    timeout: DOWNSTREAM_TIMEOUT_MS,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: methodName,
    },
  });

  const parsed = await parseStringPromise(response.data, {
    explicitArray: false,
    trim: true,
  });
  const resultText = findSoapResult(parsed, `${methodName}Result`);

  if (!resultText) {
    throw new Error(`CMS SOAP response did not include ${methodName}Result`);
  }

  return JSON.parse(resultText);
}

function sendWmsTcpCommand(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host: WMS_TCP_HOST, port: WMS_TCP_PORT },
      () => socket.write(`${JSON.stringify(command)}\n`),
    );
    let buffer = '';
    let settled = false;

    const finish = (error, payload) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(payload);
      }
    };

    socket.setTimeout(DOWNSTREAM_TIMEOUT_MS, () => {
      finish(new Error('WMS TCP request timed out'));
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) {
        return;
      }

      const [line] = buffer.split('\n');
      try {
        finish(null, JSON.parse(line));
      } catch (error) {
        finish(error);
      }
    });

    socket.on('error', finish);
  });
}

// =====================================================================
// Gateway REST Routes
// =====================================================================

app.get('/health', asyncRoute(async (req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.status(200).json({
    status: 'ok',
    service: 'api-gateway',
    database: dbOk ? 'connected' : 'disconnected',
    rabbitmq: rabbitChannel ? 'connected' : 'disconnected',
    websocket_clients: wss.clients.size,
    timestamp: new Date().toISOString(),
  });
}));

// CMS adapter: REST/JSON in, legacy SOAP/XML out
app.post('/api/auth/client/login', asyncRoute(async (req, res) => {
  if (!req.body.email || !req.body.password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  const result = await callCmsSoap('authenticate_client', {
    email: req.body.email,
    password: req.body.password,
  });

  if (!result.success) {
    return res.status(401).json(result);
  }

  const client = {
    id: result.client_id || result.client_code,
    client_id: result.client_id || result.client_code,
    client_code: result.client_code || result.client_id,
    company_name: result.company_name,
    email: result.email,
  };
  const token = createAccessToken({
    id: client.id,
    role: 'client',
    email: client.email,
    name: client.company_name,
  });

  return res.status(200).json({
    success: true,
    token,
    token_type: 'Bearer',
    expires_in: JWT_EXPIRES_IN,
    client,
  });
}));

app.post('/api/auth/driver/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const driver = demoDrivers.get(email);
  const expectedPassword = process.env.DEMO_DRIVER_PASSWORD || 'password123';

  if (!driver || req.body.password !== expectedPassword) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const token = createAccessToken({
    id: driver.id,
    role: 'driver',
    email: driver.email,
    name: driver.name,
  });
  return res.status(200).json({
    success: true,
    token,
    token_type: 'Bearer',
    expires_in: JWT_EXPIRES_IN,
    driver,
  });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.auth.sub,
      role: req.auth.role,
      email: req.auth.email,
      name: req.auth.name,
    },
  });
});

app.post('/api/orders', authenticateToken, requireRole('client'), asyncRoute(async (req, res) => {
  const result = await callCmsSoap('create_order', {
    client_code: req.auth.sub,
    pickup_address: req.body.pickup_address,
    delivery_address: req.body.delivery_address,
    weight_kg: req.body.weight_kg ?? req.body.weight,
  });

  res.status(result.success ? 201 : 400).json(result);
}));

app.get('/api/orders', authenticateToken, requireRole('client'), asyncRoute(async (req, res) => {
  const result = await callCmsSoap('get_client_orders', {
    client_code: req.auth.sub,
  });

  res.status(result.success ? 200 : 400).json(result);
}));

app.get('/api/orders/:orderCode', authenticateToken, asyncRoute(async (req, res) => {
  const { orderCode } = req.params;
  const orderRes = await pool.query(
    `SELECT o.id, o.order_code, c.client_code, c.company_name, o.pickup_address,
            o.delivery_address, o.status, o.weight_kg, o.created_at, o.updated_at
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.order_code = $1`,
    [orderCode]
  );

  if (orderRes.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const order = orderRes.rows[0];

  const pkgRes = await pool.query(
    `SELECT barcode, warehouse_zone, bin_location, status
     FROM packages WHERE order_id = $1 ORDER BY warehouse_event_at DESC LIMIT 1`,
    [order.id]
  );

  const routeRes = await pool.query(
    `SELECT r.id as route_id, d.driver_code, d.name as driver_name, rs.sequence_index, rs.eta, rs.stop_status
     FROM route_stops rs
     JOIN routes r ON r.id = rs.route_id
     JOIN drivers d ON d.id = r.driver_id
     WHERE rs.order_id = $1 LIMIT 1`,
    [order.id]
  );

  const sagaRes = await pool.query(
    `SELECT saga_step, status, created_at FROM transaction_logs WHERE order_id = $1 ORDER BY created_at ASC`,
    [order.id]
  );

  res.json({
    success: true,
    order,
    package: pkgRes.rows[0] || null,
    route: routeRes.rows[0] || null,
    saga_logs: sagaRes.rows,
  });
}));

// WMS adapter: REST/JSON in, proprietary TCP message out
app.get('/api/packages/scan/:barcode', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'GET_PACKAGE',
    barcode: req.params.barcode,
  });

  res.status(result.success ? 200 : 404).json(result);
}));

app.get('/api/packages/order/:orderCode', authenticateToken, requireRole('client', 'driver'), asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'GET_PACKAGE',
    order_code: req.params.orderCode,
  });

  res.status(result.success ? 200 : 404).json(result);
}));

app.put('/api/packages/status', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'UPDATE_STATUS',
    order_code: req.body.order_code,
    barcode: req.body.barcode,
    status: req.body.status,
  });

  if (result.success && req.body.order_code) {
    dispatchWebSocketMessage({
      target: 'client',
      eventType: 'PACKAGE_STATUS_UPDATED',
      orderCode: req.body.order_code,
      payload: { status: req.body.status, message: `Package status updated to ${req.body.status}` },
    });
  }

  res.status(result.success ? 200 : 400).json(result);
}));

// ROS proxies
app.get('/api/driver/route/today', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const driverCode = req.auth.sub;
  const response = await axios.get(`${ROS_REST_URL}/api/routes/driver/${driverCode}/today`, {
    timeout: DOWNSTREAM_TIMEOUT_MS,
  });

  res.status(response.status).json(response.data);
}));

app.post('/api/driver/delivery/:orderCode', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const deliveryStatus = req.body.status;
  if (!['delivered', 'failed'].includes(deliveryStatus)) {
    return res.status(400).json({ success: false, message: 'Status must be delivered or failed' });
  }
  if (deliveryStatus === 'delivered' && (!req.body.recipient_name || !req.body.signature)) {
    return res.status(400).json({ success: false, message: 'Recipient name and signature are required' });
  }
  if (deliveryStatus === 'failed' && !req.body.reason) {
    return res.status(400).json({ success: false, message: 'Failure reason is required' });
  }

  const routeResponse = await axios.get(
    `${ROS_REST_URL}/api/routes/driver/${req.auth.sub}/today`,
    { timeout: DOWNSTREAM_TIMEOUT_MS },
  );
  const route = routeResponse.data.route || routeResponse.data;
  const stop = route.stops?.find((item) => (
    item.order_code || item.order_id
  ) === req.params.orderCode);

  if (!stop) {
    return res.status(404).json({ success: false, message: 'Order is not assigned to this driver' });
  }

  const routeStatus = deliveryStatus === 'delivered' ? 'completed' : 'failed';
  await axios.put(
    `${ROS_REST_URL}/api/routes/${route.route_id}/stops/${req.params.orderCode}`,
    { status: routeStatus },
    { timeout: DOWNSTREAM_TIMEOUT_MS },
  );
  const deliveryResponse = await axios.post(
    `${CMS_REST_URL}/api/deliveries/${req.params.orderCode}`,
    {
      status: deliveryStatus,
      driver_code: req.auth.sub,
      recipient_name: req.body.recipient_name,
      signature: req.body.signature,
      reason: req.body.reason,
      notes: req.body.notes,
    },
    { timeout: DOWNSTREAM_TIMEOUT_MS },
  );

  dispatchWebSocketMessage({
    target: 'broadcast',
    eventType: 'DELIVERY_COMPLETED',
    orderCode: req.params.orderCode,
    payload: {
      status: deliveryStatus,
      driver_code: req.auth.sub,
      message: `Delivery ${deliveryStatus} for order ${req.params.orderCode}`,
    },
  });

  return res.status(200).json({
    success: true,
    delivery: deliveryResponse.data,
    route_status: routeStatus,
  });
}));

app.get('/api/routes', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const response = await axios.get(`${ROS_REST_URL}/api/routes`, {
    timeout: DOWNSTREAM_TIMEOUT_MS,
  });

  res.status(response.status).json(response.data);
}));

app.put('/api/routes/:routeId/stops/:orderCode', authenticateToken, requireRole('driver'), asyncRoute(async (req, res) => {
  const response = await axios.put(
    `${ROS_REST_URL}/api/routes/${req.params.routeId}/stops/${req.params.orderCode}`,
    req.body,
    { timeout: DOWNSTREAM_TIMEOUT_MS },
  );

  res.status(response.status).json(response.data);
}));

// =====================================================================
// Saga Transaction Monitoring & Testing APIs (Phase 5)
// =====================================================================

app.get('/api/saga/transactions', authenticateToken, asyncRoute(async (req, res) => {
  const query = `
    SELECT tl.id, tl.saga_step, tl.status, tl.payload, tl.error_message, tl.created_at,
           o.order_code, c.client_code, c.company_name
    FROM transaction_logs tl
    JOIN orders o ON o.id = tl.order_id
    JOIN clients c ON c.id = o.client_id
    ORDER BY tl.created_at DESC
    LIMIT 100
  `;
  const result = await pool.query(query);
  res.json({
    success: true,
    count: result.rows.length,
    active_sagas: Array.from(activeSagas.values()),
    transactions: result.rows,
  });
}));

app.get('/api/saga/transactions/:orderCode', authenticateToken, asyncRoute(async (req, res) => {
  const { orderCode } = req.params;
  const query = `
    SELECT tl.id, tl.saga_step, tl.status, tl.payload, tl.error_message, tl.created_at,
           o.order_code, o.status as order_status
    FROM transaction_logs tl
    JOIN orders o ON o.id = tl.order_id
    WHERE o.order_code = $1
    ORDER BY tl.created_at ASC
  `;
  const result = await pool.query(query, [orderCode]);
  const activeState = activeSagas.get(orderCode) || null;

  res.json({
    success: true,
    order_code: orderCode,
    active_saga_state: activeState,
    history: result.rows,
  });
}));

app.post('/api/saga/simulate-failure', authenticateToken, asyncRoute(async (req, res) => {
  const { order_code, failed_step, reason } = req.body;
  if (!order_code || !failed_step) {
    return res.status(400).json({
      success: false,
      message: 'order_code and failed_step (e.g. ROS_ASSIGN or WMS_ALLOCATE) are required.',
    });
  }

  const result = await executeSagaCompensation(
    order_code,
    failed_step,
    reason || 'Simulated downstream service processing failure'
  );

  res.json(result);
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

app.use((error, req, res, next) => {
  console.error('Gateway adapter error:', error.message);
  res.status(502).json({
    success: false,
    message: 'Gateway could not complete downstream request',
    detail: error.message,
  });
});

// =====================================================================
// Start Gateway Server & Connect RabbitMQ
// =====================================================================

server.listen(PORT, () => {
  console.log(`SwiftTrack API Gateway listening on port ${PORT} (HTTP + WebSockets on /ws)`);
  connectRabbitWithRetry();
});

module.exports = app;
