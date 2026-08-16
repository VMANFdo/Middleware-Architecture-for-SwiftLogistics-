// =====================================================================
// SwiftTrack API Gateway
// SCS3208 Middleware Architecture | Assignment 4
// Phase 3: REST-to-SOAP and REST-to-TCP protocol bridging
// =====================================================================

const axios = require('axios');
const cors = require('cors');
const express = require('express');
const net = require('net');
const { parseStringPromise } = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;
const CMS_SOAP_URL = process.env.CMS_SOAP_URL || 'http://localhost:8001/soap';
const ROS_REST_URL = process.env.ROS_REST_URL || 'http://localhost:8002';
const WMS_TCP_HOST = process.env.WMS_TCP_HOST || 'localhost';
const WMS_TCP_PORT = Number(process.env.WMS_TCP_PORT || 9000);
const DOWNSTREAM_TIMEOUT_MS = Number(process.env.DOWNSTREAM_TIMEOUT_MS || 5000);

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
  const result = await callCmsSoap('authenticate_client', {
    email: req.body.email,
    password: req.body.password,
  });

  res.status(result.success ? 200 : 401).json(result);
}));

app.post('/api/orders', asyncRoute(async (req, res) => {
  const result = await callCmsSoap('create_order', {
    client_code: req.body.client_code,
    pickup_address: req.body.pickup_address,
    delivery_address: req.body.delivery_address,
    weight_kg: req.body.weight_kg,
  });

  res.status(result.success ? 201 : 400).json(result);
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const result = await callCmsSoap('get_client_orders', {
    client_code: req.query.client_code,
  });

  res.status(result.success ? 200 : 400).json(result);
}));

// WMS adapter: browser-friendly REST/JSON in, proprietary TCP message out.
app.get('/api/packages/scan/:barcode', asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'GET_PACKAGE',
    barcode: req.params.barcode,
  });

  res.status(result.success ? 200 : 404).json(result);
}));

app.get('/api/packages/order/:orderCode', asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'GET_PACKAGE',
    order_code: req.params.orderCode,
  });

  res.status(result.success ? 200 : 404).json(result);
}));

app.put('/api/packages/status', asyncRoute(async (req, res) => {
  const result = await sendWmsTcpCommand({
    type: 'UPDATE_STATUS',
    order_code: req.body.order_code,
    barcode: req.body.barcode,
    status: req.body.status,
  });

  res.status(result.success ? 200 : 400).json(result);
}));

// ROS is already REST, so the gateway proxies these calls without protocol translation.
app.get('/api/driver/route/today', asyncRoute(async (req, res) => {
  const driverCode = req.query.driver_code || 'DRV001';
  const response = await axios.get(`${ROS_REST_URL}/api/routes/driver/${driverCode}/today`, {
    timeout: DOWNSTREAM_TIMEOUT_MS,
  });

  res.status(response.status).json(response.data);
}));

app.get('/api/routes', asyncRoute(async (req, res) => {
  const response = await axios.get(`${ROS_REST_URL}/api/routes`, {
    timeout: DOWNSTREAM_TIMEOUT_MS,
  });

  res.status(response.status).json(response.data);
}));

app.put('/api/routes/:routeId/stops/:orderCode', asyncRoute(async (req, res) => {
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
