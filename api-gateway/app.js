// =====================================================================
// SwiftTrack API Gateway
// IS3208 Middleware Architecture | Assignment 4
// Phase 3: REST-to-SOAP and REST-to-TCP protocol bridging
// =====================================================================

const axios = require('axios');
const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const net = require('net');
const { parseStringPromise } = require('xml2js');

const app = express();
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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

// CMS adapter: browser-friendly REST/JSON in, legacy SOAP/XML out.
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

// WMS adapter: browser-friendly REST/JSON in, proprietary TCP message out.
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

  res.status(result.success ? 200 : 400).json(result);
}));

// ROS is already REST, so the gateway proxies these calls without protocol translation.
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

app.listen(PORT, () => {
  console.log(`SwiftTrack API Gateway listening on port ${PORT}`);
});

module.exports = app;
