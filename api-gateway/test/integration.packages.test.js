'use strict';

const request = require('supertest');

const { app, createAccessToken } = require('../app');
const {
  createFakeWms,
  createRawTcpServer,
  createSilentTcpServer,
  createChunkedTcpServer,
} = require('./helpers/fakeWms');

const PACKAGE = {
  success: true,
  package_id: 'pkg-1',
  order_code: 'ORD-0001',
  barcode: 'BC-ORD-0001',
  warehouse_zone: 'Zone A',
  bin_location: 'A1-1',
  status: 'received',
};

const NOT_FOUND = { success: false, message: 'Package not found' };

const runningServers = [];

/** Start `server`, point the TCP adapter at it for the duration of `fn`, then restore. */
async function withTcpServer(server, fn) {
  const port = await server.start();
  runningServers.push(server);

  const previous = process.env.WMS_TCP_PORT;
  process.env.WMS_TCP_PORT = String(port);

  try {
    await fn();
  } finally {
    process.env.WMS_TCP_PORT = previous;
  }
}

/** @type {ReturnType<typeof createFakeWms>} */
let wms;
let primaryPort;

function driverToken(id = 'DRV001') {
  return createAccessToken({ id, role: 'driver', email: 'kasun@swiftlogistics.lk', name: 'Kasun' });
}

function clientToken(id = 'CLT001') {
  return createAccessToken({ id, role: 'client', email: 'techmart@example.com', name: 'TechMart' });
}

beforeAll(async () => {
  wms = createFakeWms(() => PACKAGE);
  primaryPort = await wms.start();
  runningServers.push(wms);
  process.env.WMS_TCP_PORT = String(primaryPort);
});

afterAll(async () => {
  await Promise.all(runningServers.map((s) => s.stop()));
});

beforeEach(() => {
  process.env.WMS_TCP_PORT = String(primaryPort);
  wms.received.length = 0;
  wms.setResponder(() => PACKAGE);
});

describe('GET /api/packages/scan/:barcode (REST → TCP adapter)', () => {
  test('sends a GET_PACKAGE command keyed by barcode', async () => {
    const res = await request(app)
      .get('/api/packages/scan/BC-ORD-0001')
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, barcode: 'BC-ORD-0001' });
    expect(wms.received).toEqual([{ type: 'GET_PACKAGE', barcode: 'BC-ORD-0001' }]);
  });

  test('maps a WMS miss to 404', async () => {
    wms.setResponder(() => NOT_FOUND);

    const res = await request(app)
      .get('/api/packages/scan/BC-NOPE')
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: 'Package not found' });
  });

  test('rejects unauthenticated callers without touching WMS', async () => {
    const res = await request(app).get('/api/packages/scan/BC-ORD-0001');

    expect(res.status).toBe(401);
    expect(wms.received).toEqual([]);
  });

  test('rejects clients (driver-only route) without touching WMS', async () => {
    const res = await request(app)
      .get('/api/packages/scan/BC-ORD-0001')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(403);
    expect(wms.received).toEqual([]);
  });
});

describe('GET /api/packages/order/:orderCode', () => {
  test('sends a GET_PACKAGE command keyed by order code', async () => {
    const res = await request(app)
      .get('/api/packages/order/ORD-0001')
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(res.status).toBe(200);
    expect(wms.received).toEqual([{ type: 'GET_PACKAGE', order_code: 'ORD-0001' }]);
  });

  test('is callable by clients as well as drivers', async () => {
    const res = await request(app)
      .get('/api/packages/order/ORD-0001')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.order_code).toBe('ORD-0001');
  });
});

describe('PUT /api/packages/status', () => {
  test('forwards the status transition to WMS over TCP', async () => {
    const res = await request(app)
      .put('/api/packages/status')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ order_code: 'ORD-0001', status: 'picked' });

    expect(res.status).toBe(200);
    expect(wms.received).toEqual([
      expect.objectContaining({
        type: 'UPDATE_STATUS',
        order_code: 'ORD-0001',
        status: 'picked',
      }),
    ]);
  });

  test('maps a validator rejection to 400', async () => {
    wms.setResponder(() => ({
      success: false,
      message: "Invalid status. Use one of: ['dispatched', 'loaded', 'picked', 'received', 'stored']",
    }));

    const res = await request(app)
      .put('/api/packages/status')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ order_code: 'ORD-0001', status: 'exploded' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .put('/api/packages/status')
      .send({ order_code: 'ORD-0001', status: 'picked' });

    expect(res.status).toBe(401);
    expect(wms.received).toEqual([]);
  });
});

describe('TCP adapter resilience', () => {
  test('reassembles a response split across several TCP segments', async () => {
    const chunked = createChunkedTcpServer(JSON.stringify(PACKAGE));

    await withTcpServer(chunked, async () => {
      const res = await request(app)
        .get('/api/packages/scan/BC-ORD-0001')
        .set('Authorization', `Bearer ${driverToken()}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, barcode: 'BC-ORD-0001' });
    });
  });

  test('returns 502 when WMS never responds', async () => {
    const silent = createSilentTcpServer();

    await withTcpServer(silent, async () => {
      const res = await request(app)
        .get('/api/packages/scan/BC-ORD-0001')
        .set('Authorization', `Bearer ${driverToken()}`);

      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/downstream/i);
    });
  }, 5000);

  test('returns 502 when WMS replies with malformed JSON', async () => {
    const broken = createRawTcpServer('this is not json\n');

    await withTcpServer(broken, async () => {
      const res = await request(app)
        .get('/api/packages/scan/BC-ORD-0001')
        .set('Authorization', `Bearer ${driverToken()}`);

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
    });
  });

  test('returns 502 when the WMS host is unreachable', async () => {
    process.env.WMS_TCP_PORT = '1';

    const res = await request(app)
      .get('/api/packages/scan/BC-ORD-0001')
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/downstream/i);
  });
});
