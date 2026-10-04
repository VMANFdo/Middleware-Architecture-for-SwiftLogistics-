'use strict';

const nock = require('nock');
const request = require('supertest');

const { app, createAccessToken } = require('../app');
const { soapResponse } = require('./helpers/soap');

const CMS = 'http://127.0.0.1:1';

afterEach(() => {
  nock.cleanAll();
});

function clientToken(id = 'CLT001') {
  return createAccessToken({ id, role: 'client', email: 'techmart@example.com', name: 'TechMart' });
}

function driverToken(id = 'DRV001') {
  return createAccessToken({ id, role: 'driver', email: 'kasun@swiftlogistics.lk', name: 'Kasun' });
}

describe('POST /api/auth/client/login (REST → SOAP adapter)', () => {
  const credentials = { email: 'techmart@example.com', password: 'password123' };

  test('returns a JWT and the client profile on a successful SOAP round-trip', async () => {
    nock(CMS)
      .post('/soap')
      .reply(200, soapResponse('authenticate_client', {
        success: true,
        client_code: 'CLT001',
        company_name: 'TechMart Online',
        email: 'techmart@example.com',
      }), { 'Content-Type': 'text/xml' });

    const res = await request(app).post('/api/auth/client/login').send(credentials);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN,
      client: {
        client_code: 'CLT001',
        company_name: 'TechMart Online',
      },
    });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.token.split('.')).toHaveLength(3);
  });

  test('rejects with 401 when CMS reports authentication failure', async () => {
    nock(CMS)
      .post('/soap')
      .reply(200, soapResponse('authenticate_client', {
        success: false,
        message: 'Invalid password',
      }), { 'Content-Type': 'text/xml' });

    const res = await request(app)
      .post('/api/auth/client/login')
      .send({ ...credentials, password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, message: 'Invalid password' });
  });

  test('rejects with 400 when email or password is missing', async () => {
    const res = await request(app).post('/api/auth/client/login').send({ email: 'a@b.c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  test('surfaces a 502 when the CMS downstream is unreachable', async () => {
    // No nock interceptor + nock's default net.connect blocking → ECONNREFUSED.
    const res = await request(app).post('/api/auth/client/login').send(credentials);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.message).toMatch(/downstream/i);
  });

  test('the SOAP envelope sent to CMS carries the submitted credentials', async () => {
    let capturedBody = '';
    nock(CMS)
      .post('/soap', (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, soapResponse('authenticate_client', { success: false, message: 'nope' }), {
        'Content-Type': 'text/xml',
      });

    await request(app).post('/api/auth/client/login').send(credentials);

    expect(capturedBody).toContain('<tns:authenticate_client>');
    expect(capturedBody).toContain('<tns:email>techmart@example.com</tns:email>');
    expect(capturedBody).toContain('<tns:password>password123</tns:password>');
  });
});

describe('POST /api/auth/driver/login', () => {
  test('authenticates a seeded driver', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: 'kasun@swiftlogistics.lk', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      token_type: 'Bearer',
      driver: { id: 'DRV001', vehicle: 'WP-KA-1234' },
    });
  });

  test('rejects an unknown email with 401', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: 'nobody@swiftlogistics.lk', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('rejects a wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: 'kasun@swiftlogistics.lk', password: 'not-the-password' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  test('returns the claims embedded in a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: 'CLT001',
      role: 'client',
      email: 'techmart@example.com',
      name: 'TechMart',
    });
  });

  test('returns 401 without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('returns 401 with a garbage token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token is invalid');
  });
});

describe('role-based access control', () => {
  test('GET /api/orders rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
  });

  test('GET /api/orders rejects drivers (client-only route)', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(res.status).toBe(403);
  });

  test('GET /api/orders proxies the CMS SOAP call for a client', async () => {
    nock(CMS)
      .post('/soap')
      .reply(200, soapResponse('get_client_orders', {
        success: true,
        client_code: 'CLT001',
        orders: [{ order_code: 'ORD-0001', status: 'assigned' }],
      }), { 'Content-Type': 'text/xml' });

    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${clientToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].order_code).toBe('ORD-0001');
  });

  test('POST /api/orders rejects drivers', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ pickup_address: 'A', delivery_address: 'B', weight_kg: 1 });

    expect(res.status).toBe(403);
  });

  test('unknown routes return a 404 JSON body', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
