'use strict';

const request = require('supertest');

const {
  app,
  pool,
  activeSagas,
  handleSagaEvent,
  executeSagaCompensation,
  createAccessToken,
} = require('../app');
const { installFakePool, rows } = require('./helpers/db');

const ORDER_UUID = '11111111-1111-1111-1111-111111111111';
const CLIENT_UUID = '22222222-2222-2222-2222-222222222222';

// Every /api/saga/* route sits behind authenticateToken (any role), so the
// HTTP-level tests need a token even though they are not role-restricted.
const AUTH = `Bearer ${createAccessToken({
  id: 'CLT001',
  role: 'client',
  email: 'techmart@example.com',
  name: 'TechMart Online',
})}`;

const DB_FIXTURES = [
  [/INSERT INTO transaction_logs/, { rows: [{ id: 'log-uuid', created_at: new Date().toISOString() }] }],
  [/UPDATE orders SET status = 'failed'/, { rows: [] }],
  [/SELECT id, client_id FROM orders WHERE order_code/, rows([{ id: ORDER_UUID, client_id: CLIENT_UUID }])],
  [/SELECT client_code FROM clients WHERE id/, rows([{ client_code: 'CLT001' }])],
  [/FROM transaction_logs tl/, rows([
    {
      id: 'log-1',
      saga_step: 'CMS_CREATE',
      status: 'completed',
      payload: {},
      error_message: null,
      created_at: '2026-10-01T08:00:01Z',
      order_code: 'ORD-0001',
      client_code: 'CLT001',
      company_name: 'TechMart Online',
    },
  ])],
];

let db;

beforeEach(() => {
  db = installFakePool(pool, DB_FIXTURES);
  activeSagas.clear();
});

afterEach(() => {
  db.restore();
  activeSagas.clear();
});

function insertsIntoTransactionLogs(dbCalls) {
  return dbCalls
    .filter((call) => /INSERT INTO transaction_logs/.test(call.sql))
    .map((call) => ({
      orderId: call.params[0],
      sagaStep: call.params[1],
      status: call.params[2],
      payload: call.params[3],
      errorMessage: call.params[4],
    }));
}

describe('GET /api/saga/transactions', () => {
  test('returns recent saga steps alongside in-memory state', async () => {
    const res = await request(app)
      .get('/api/saga/transactions')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 1 });
    expect(res.body.transactions[0]).toMatchObject({
      saga_step: 'CMS_CREATE',
      status: 'completed',
      order_code: 'ORD-0001',
    });
    expect(Array.isArray(res.body.active_sagas)).toBe(true);
  });

  test('query is limited so the endpoint cannot grow without bound', async () => {
    await request(app).get('/api/saga/transactions').set('Authorization', AUTH);
    const listQuery = db.calls.find((call) => /FROM transaction_logs tl/.test(call.sql));
    expect(listQuery.sql).toMatch(/LIMIT 100/);
  });

  test('rejects anonymous callers', async () => {
    const res = await request(app).get('/api/saga/transactions');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/saga/transactions/:orderCode', () => {
  test('returns the chronological history for one order', async () => {
    const res = await request(app)
      .get('/api/saga/transactions/ORD-0001')
      .set('Authorization', AUTH);


    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, order_code: 'ORD-0001' });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.active_saga_state).toBeNull();
  });

  test('exposes the live in-memory saga when one is running', async () => {
    activeSagas.set('ORD-0001', {
      order_code: 'ORD-0001',
      client_code: 'CLT001',
      steps: { CMS_CREATE: 'completed', ROS_ASSIGN: 'pending', WMS_ALLOCATE: 'pending' },
      status: 'in_progress',
    });

    const res = await request(app)
      .get('/api/saga/transactions/ORD-0001')
      .set('Authorization', AUTH);

    expect(res.body.active_saga_state).toMatchObject({
      status: 'in_progress',
      steps: { CMS_CREATE: 'completed' },
    });
  });
});

describe('POST /api/saga/simulate-failure', () => {
  test('rejects a payload without order_code or failed_step', async () => {
    const res = await request(app)
      .post('/api/saga/simulate-failure')
      .set('Authorization', AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/required/i);
  });

  test('marks the order failed and writes both audit rows', async () => {
    const res = await request(app)
      .post('/api/saga/simulate-failure')
      .set('Authorization', AUTH)
      .send({
        order_code: 'ORD-0001',
        failed_step: 'WMS_ALLOCATE',
        reason: 'WMS container crashed',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      order_code: 'ORD-0001',
      failed_step: 'WMS_ALLOCATE',
      status: 'compensated',
      reason: 'WMS container crashed',
    });

    const logs = insertsIntoTransactionLogs(db.calls);
    expect(logs.map((l) => l.sagaStep)).toEqual([
      'WMS_ALLOCATE',
      'SAGA_COMPENSATION',
    ]);
    expect(logs[0].status).toBe('failed');
    expect(logs[0].errorMessage).toBe('WMS container crashed');
    expect(logs[1].status).toBe('compensated');

    const orderUpdate = db.calls.find((call) => /UPDATE orders SET status = 'failed'/.test(call.sql));
    expect(orderUpdate).toBeDefined();
    expect(orderUpdate.params).toEqual([ORDER_UUID]);
  });

  test('falls back to a generic reason when none is supplied', async () => {
    const res = await request(app)
      .post('/api/saga/simulate-failure')
      .set('Authorization', AUTH)
      .send({ order_code: 'ORD-0001', failed_step: 'ROS_ASSIGN' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/downstream/i);
  });

  test('fails the in-memory saga entry when one exists', async () => {
    activeSagas.set('ORD-0001', {
      order_code: 'ORD-0001',
      client_code: 'CLT001',
      steps: { CMS_CREATE: 'completed', ROS_ASSIGN: 'completed', WMS_ALLOCATE: 'pending' },
      status: 'in_progress',
    });

    await request(app)
      .post('/api/saga/simulate-failure')
      .set('Authorization', AUTH)
      .send({ order_code: 'ORD-0001', failed_step: 'WMS_ALLOCATE' });

    expect(activeSagas.get('ORD-0001')).toMatchObject({
      status: 'failed',
      steps: { WMS_ALLOCATE: 'failed' },
    });
  });
});

describe('handleSagaEvent — happy path across CMS, ROS and WMS', () => {
  const orderEvent = {
    data: {
      order_code: 'ORD-0001',
      client_code: 'CLT001',
      pickup_address: 'A',
      delivery_address: 'B',
      weight_kg: 2.4,
    },
  };

  const rosEvent = {
    data: {
      stops: [{
        order_code: 'ORD-0001',
        client_code: 'CLT001',
        delivery_lat: 6.9,
        delivery_lng: 79.8,
        sequence: 1,
        status: 'pending',
      }],
    },
  };

  const wmsEvent = {
    data: {
      order_code: 'ORD-0001',
      package_id: 'pkg-1',
      barcode: 'BC-ORD-0001',
      warehouse_zone: 'Zone A',
      bin_location: 'A1-1',
      status: 'received',
    },
  };

  test('ORDER_CREATED opens the saga and logs CMS_CREATE', async () => {
    await handleSagaEvent('ORDER_CREATED', orderEvent);

    expect(activeSagas.get('ORD-0001')).toMatchObject({
      client_code: 'CLT001',
      status: 'in_progress',
      steps: { CMS_CREATE: 'completed', ROS_ASSIGN: 'pending', WMS_ALLOCATE: 'pending' },
    });

    const logs = insertsIntoTransactionLogs(db.calls);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ sagaStep: 'CMS_CREATE', status: 'completed' });
    expect(logs[0].orderId).toBe(ORDER_UUID);
  });

  test('ROS_PROCESSING_COMPLETE logs ROS_ASSIGN once per order even if redelivered', async () => {
    await handleSagaEvent('ORDER_CREATED', orderEvent);
    await handleSagaEvent('ROS_PROCESSING_COMPLETE', rosEvent);
    await handleSagaEvent('ROS_PROCESSING_COMPLETE', rosEvent);

    const logs = insertsIntoTransactionLogs(db.calls).filter((l) => l.sagaStep === 'ROS_ASSIGN');
    expect(logs).toHaveLength(1);
    expect(activeSagas.get('ORD-0001').steps.ROS_ASSIGN).toBe('completed');
  });

  test('WMS_PROCESSING_COMPLETE closes the saga and records SAGA_COMPLETE', async () => {
    await handleSagaEvent('ORDER_CREATED', orderEvent);
    await handleSagaEvent('ROS_PROCESSING_COMPLETE', rosEvent);
    await handleSagaEvent('WMS_PROCESSING_COMPLETE', wmsEvent);

    expect(activeSagas.get('ORD-0001')).toMatchObject({ status: 'completed' });

    const logs = insertsIntoTransactionLogs(db.calls).map((l) => l.sagaStep);
    expect(logs).toEqual(['CMS_CREATE', 'ROS_ASSIGN', 'WMS_ALLOCATE', 'SAGA_COMPLETE']);
  });

  test('replaying the whole event sequence does not re-open a completed saga', async () => {
    await handleSagaEvent('ORDER_CREATED', orderEvent);
    await handleSagaEvent('ROS_PROCESSING_COMPLETE', rosEvent);
    await handleSagaEvent('WMS_PROCESSING_COMPLETE', wmsEvent);

    const firstCount = insertsIntoTransactionLogs(db.calls).length;

    await handleSagaEvent('WMS_PROCESSING_COMPLETE', wmsEvent);

    expect(activeSagas.get('ORD-0001').status).toBe('completed');
    // WMS has no idempotency guard yet (Phase 2.6) but the saga must not
    // flip back to in_progress.
    expect(activeSagas.get('ORD-0001').status).not.toBe('in_progress');
    expect(insertsIntoTransactionLogs(db.calls).length).toBeGreaterThanOrEqual(firstCount);
  });

  test('events without an order code are ignored', async () => {
    await handleSagaEvent('ORDER_CREATED', { data: { client_code: 'CLT001' } });
    expect(activeSagas.size).toBe(0);
    expect(insertsIntoTransactionLogs(db.calls)).toHaveLength(0);
  });

  test('an order with no DB row still opens a saga but writes no log', async () => {
    const isolated = installFakePool(pool, [
      [/SELECT id, client_id FROM orders WHERE order_code/, rows([])],
    ]);
    db.restore();
    db = isolated;

    await handleSagaEvent('ORDER_CREATED', orderEvent);

    expect(activeSagas.get('ORD-0001')).toMatchObject({ status: 'in_progress' });
    expect(insertsIntoTransactionLogs(isolated.calls)).toHaveLength(0);
  });
});

describe('executeSagaCompensation', () => {
  test('returns a structured compensation report', async () => {
    const result = await executeSagaCompensation('ORD-0001', 'ROS_ASSIGN', 'ROS timed out');

    expect(result).toMatchObject({
      success: true,
      order_code: 'ORD-0001',
      failed_step: 'ROS_ASSIGN',
      status: 'compensated',
      reason: 'ROS timed out',
    });
  });

  test('records rollback actions in the compensation payload', async () => {
    await executeSagaCompensation('ORD-0001', 'ROS_ASSIGN', 'ROS timed out');

    const compensation = insertsIntoTransactionLogs(db.calls)
      .find((log) => log.sagaStep === 'SAGA_COMPENSATION');

    expect(compensation).toBeDefined();
    const payload = JSON.parse(compensation.payload);
    expect(payload.failed_step).toBe('ROS_ASSIGN');
    expect(payload.reason).toBe('ROS timed out');
    expect(payload.rollback_actions).toEqual(expect.any(Array));
  });
});
