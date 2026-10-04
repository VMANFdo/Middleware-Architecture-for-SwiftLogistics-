'use strict';

const nock = require('nock');
const request = require('supertest');

const { app, createAccessToken, pool } = require('../app');
const { soapResponse } = require('./helpers/soap');
const { installFakePool, rows } = require('./helpers/db');

const CMS = 'http://127.0.0.1:1';

let db;

afterEach(() => {
  nock.cleanAll();
  if (db) {
    db.restore();
    db = null;
  }
});

function clientToken(id = 'CLT001') {
  return createAccessToken({ id, role: 'client', email: 'techmart@example.com', name: 'TechMart' });
}

function driverToken(id = 'DRV001') {
  return createAccessToken({ id, role: 'driver', email: 'kasun@swiftlogistics.lk', name: 'Kasun' });
}

const ORDER_FIXTURE = {
  id: '11111111-1111-1111-1111-111111111111',
  order_code: 'ORD-0007',
  client_code: 'CLT001',
  company_name: 'TechMart Online',
  pickup_address: '45 Galle Road, Colombo 03',
  delivery_address: '10 Havelock Road, Colombo 05',
  status: 'assigned',
  weight_kg: '2.40',
  created_at: '2026-10-01T08:00:00.000Z',
  updated_at: '2026-10-01T09:00:00.000Z',
};

const ORDER_RELATIONSHIP_FIXTURES = [
  [/SELECT o\.id, o\.order_code, c\.client_code/, rows([ORDER_FIXTURE])],
  [/FROM packages WHERE order_id/, rows([{
    barcode: 'BC-ORD-0007',
    warehouse_zone: 'Zone B',
    bin_location: 'B2-1',
    status: 'stored',
  }])],
  [/FROM route_stops rs/, rows([{
    route_id: 'route-1',
    driver_code: 'DRV001',
    driver_name: 'Kasun Perera',
    sequence_index: 1,
    eta: '2026-10-01T10:00:00.000Z',
    stop_status: 'pending',
  }])],
  [/FROM transaction_logs WHERE order_id/, rows([
    { saga_step: 'CMS_CREATE', status: 'completed', created_at: '2026-10-01T08:00:01Z' },
    { saga_step: 'ROS_ASSIGN', status: 'completed', created_at: '2026-10-01T08:00:02Z' },
    { saga_step: 'WMS_ALLOCATE', status: 'completed', created_at: '2026-10-01T08:00:03Z' },
  ])],
];

describe('POST /api/orders', () => {
  test('creates an order through the SOAP adapter and returns 201', async () => {
    nock(CMS)
      .post('/soap')
      .reply(200, soapResponse('create_order', {
        success: true,
        order_code: 'ORD-0042',
        client_code: 'CLT001',
        status: 'pending',
        event_published: true,
      }), { 'Content-Type': 'text/xml' });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${clientToken()}`)
      .send({
        pickup_address: '45 Galle Road, Colombo 03',
        delivery_address: '10 Havelock Road, Colombo 05',
        weight_kg: 2.4,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      order_code: 'ORD-0042',
      status: 'pending',
      event_published: true,
    });
  });

  test('always stamps the order with the token subject, never a body-supplied client', async () => {
    let capturedBody = '';
    nock(CMS)
      .post('/soap', (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, soapResponse('create_order', { success: true, order_code: 'ORD-0043' }), {
        'Content-Type': 'text/xml',
      });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${clientToken('CLT003')}`)
      .send({
        pickup_address: 'A',
        delivery_address: 'B',
        weight_kg: 1,
        client_code: 'CLT001', // attacker-supplied, must be ignored
      });

    expect(res.status).toBe(201);
    expect(capturedBody).toContain('<tns:client_code>CLT003</tns:client_code>');
    expect(capturedBody).not.toContain('CLT001');
  });

  test('accepts the legacy "weight" field name used by the client portal', async () => {
    let capturedBody = '';
    nock(CMS)
      .post('/soap', (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, soapResponse('create_order', { success: true, order_code: 'ORD-0044' }), {
        'Content-Type': 'text/xml',
      });

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${clientToken()}`)
      .send({ pickup_address: 'A', delivery_address: 'B', weight: 5.5 });

    expect(capturedBody).toContain('<tns:weight_kg>5.5</tns:weight_kg>');
  });

  test('maps a CMS validation failure to 400', async () => {
    nock(CMS)
      .post('/soap')
      .reply(200, soapResponse('create_order', {
        success: false,
        message: 'Client not found',
      }), { 'Content-Type': 'text/xml' });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${clientToken()}`)
      .send({ pickup_address: 'A', delivery_address: 'B', weight_kg: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Client not found');
  });
});

describe('GET /api/orders/:orderCode', () => {
  test('joins order, package, route and saga log into one payload', async () => {
    db = installFakePool(pool, ORDER_RELATIONSHIP_FIXTURES);

    const res = await request(app)
      .get('/api/orders/ORD-0007')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      order: { order_code: 'ORD-0007', status: 'assigned' },
      package: { barcode: 'BC-ORD-0007', bin_location: 'B2-1' },
      route: { driver_code: 'DRV001', stop_status: 'pending' },
    });
    expect(res.body.saga_logs.map((l) => l.saga_step)).toEqual([
      'CMS_CREATE',
      'ROS_ASSIGN',
      'WMS_ALLOCATE',
    ]);
  });

  test('returns 404 when the order does not exist', async () => {
    db = installFakePool(pool, [[/SELECT o\.id, o\.order_code, c\.client_code/, rows([])]]);

    const res = await request(app)
      .get('/api/orders/ORD-9999')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: 'Order not found' });
  });

  test('nulls out absent relationships instead of failing the request', async () => {
    db = installFakePool(pool, [
      [/SELECT o\.id, o\.order_code, c\.client_code/, rows([ORDER_FIXTURE])],
      [/FROM packages WHERE order_id/, rows([])],
      [/FROM route_stops rs/, rows([])],
      [/FROM transaction_logs WHERE order_id/, rows([])],
    ]);

    const res = await request(app)
      .get('/api/orders/ORD-0007')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.package).toBeNull();
    expect(res.body.route).toBeNull();
    expect(res.body.saga_logs).toEqual([]);
  });

  test('requires authentication but allows both roles to read an order', async () => {
    const noToken = await request(app).get('/api/orders/ORD-0007');
    expect(noToken.status).toBe(401);

    db = installFakePool(pool, ORDER_RELATIONSHIP_FIXTURES);
    const withDriver = await request(app)
      .get('/api/orders/ORD-0007')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(withDriver.status).toBe(200);
  });
});
