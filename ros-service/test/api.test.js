'use strict';

const request = require('supertest');

const { app, routes, addOrderToRoute } = require('../app');

const ORDER = {
  order_code: 'ORD-0001',
  client_code: 'CLT001',
  pickup_address: '45 Galle Road, Colombo 03',
  delivery_address: '10 Havelock Road, Colombo 05',
  pickup_lat: 6.9271,
  pickup_lng: 79.8612,
  delivery_lat: 6.8916,
  delivery_lng: 79.8567,
  weight_kg: 2.4,
};

beforeEach(() => {
  routes.clear();
});

describe('GET /health', () => {
  test('reports the service as healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'ros-service' });
  });
});

describe('GET /api/vehicles/available', () => {
  test('lists every configured vehicle with its capacity and depot', async () => {
    const res = await request(app).get('/api/vehicles/available');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver_code: 'DRV001',
          capacity_kg: 100,
          start_lat: expect.any(Number),
          start_lng: expect.any(Number),
        }),
        expect.objectContaining({
          driver_code: 'DRV002',
          capacity_kg: 80,
        }),
      ]),
    );
  });
});

describe('POST /api/routes/optimize', () => {
  test('optimises a stop list and stamps a route id', async () => {
    const res = await request(app)
      .post('/api/routes/optimize')
      .send({
        driver_code: 'DRV001',
        stops: [
          { order_code: 'ORD-GALLE', delivery_lat: 6.0276, delivery_lng: 80.2199 },
          { order_code: 'ORD-CITY', delivery_lat: 6.8916, delivery_lng: 79.8567 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.route_id).toBe(`ROUTE-${new Date().toISOString().slice(0, 10)}-DRV001`);
    expect(res.body.driver_code).toBe('DRV001');
    expect(res.body.stops.map((s) => s.order_code)).toEqual(['ORD-CITY', 'ORD-GALLE']);
    expect(res.body.stops.map((s) => s.sequence)).toEqual([1, 2]);
  });

  test('defaults the driver to DRV001 when omitted', async () => {
    const res = await request(app)
      .post('/api/routes/optimize')
      .send({ stops: [{ order_code: 'ORD-1', delivery_lat: 6.9, delivery_lng: 79.86 }] });

    expect(res.body.driver_code).toBe('DRV001');
  });

  test('falls back to Colombo coordinates when a stop carries no location', async () => {
    const res = await request(app)
      .post('/api/routes/optimize')
      .send({ driver_code: 'DRV001', stops: [{ order_code: 'ORD-1' }] });

    expect(res.status).toBe(200);
    expect(res.body.stops[0]).toMatchObject({
      pickup_lat: 6.9271,
      pickup_lng: 79.8612,
      delivery_lat: 6.9271,
      delivery_lng: 79.8612,
      status: 'pending',
      client_code: 'manual',
    });
  });

  test('accepts the shorthand lat/lng fields', async () => {
    const res = await request(app)
      .post('/api/routes/optimize')
      .send({ stops: [{ order_code: 'ORD-1', lat: 7.2906, lng: 80.6337 }] });

    expect(res.body.stops[0]).toMatchObject({ delivery_lat: 7.2906, delivery_lng: 80.6337 });
  });

  test('returns an empty stop list for an empty body', async () => {
    const res = await request(app).post('/api/routes/optimize').send({});
    expect(res.status).toBe(200);
    expect(res.body.stops).toEqual([]);
  });

  test('does not persist optimisation requests into the route store', async () => {
    await request(app)
      .post('/api/routes/optimize')
      .send({ stops: [{ order_code: 'ORD-1', delivery_lat: 6.9, delivery_lng: 79.86 }] });

    expect(routes.size).toBe(0);
  });
});

describe('GET /api/routes', () => {
  test('starts empty', async () => {
    const res = await request(app).get('/api/routes');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('lists routes that have been materialised', async () => {
    await request(app).get('/api/routes/driver/DRV001/today');

    const res = await request(app).get('/api/routes');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ driver_code: 'DRV001' });
  });
});

describe('GET /api/routes/driver/:driverCode/today', () => {
  test('creates a stub route for a driver with none today', async () => {
    const res = await request(app).get('/api/routes/driver/DRV002/today');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      driver_code: 'DRV002',
      date: new Date().toISOString().slice(0, 10),
      status: 'planned',
      stops: [],
    });
    expect(res.body.route_id).toContain('DRV002');
  });

  test('returns the same route object on subsequent calls', async () => {
    const first = await request(app).get('/api/routes/driver/DRV001/today');
    const second = await request(app).get('/api/routes/driver/DRV001/today');

    expect(second.body.route_id).toBe(first.body.route_id);
    expect(routes.size).toBe(1);
  });
});

describe('addOrderToRoute', () => {
  test('appends and optimises a new order', async () => {
    const route = await addOrderToRoute(ORDER);

    expect(route.stops).toHaveLength(1);
    expect(route.stops[0]).toMatchObject({
      order_code: 'ORD-0001',
      sequence: 1,
      status: 'pending',
      weight_kg: 2.4,
    });
    expect(Date.parse(route.updated_at)).not.toBeNaN();
  });

  test('never adds the same order code twice', async () => {
    await addOrderToRoute(ORDER);
    await addOrderToRoute(ORDER);
    await addOrderToRoute({ ...ORDER, weight_kg: 9 });

    const route = await addOrderToRoute(ORDER);
    expect(route.stops).toHaveLength(1);
    expect(routes.size).toBe(1);
  });

  test('re-optimises the whole route when a second order arrives', async () => {
    await addOrderToRoute(ORDER);
    const route = await addOrderToRoute({
      ...ORDER,
      order_code: 'ORD-GALLE',
      delivery_lat: 6.0276,
      delivery_lng: 80.2199,
    });

    expect(route.stops).toHaveLength(2);
    expect(route.stops.map((s) => s.sequence)).toEqual([1, 2]);
    // Colombo 05 is much closer to the depot than Galle.
    expect(route.stops[0].order_code).toBe('ORD-0001');
    expect(route.stops[1].order_code).toBe('ORD-GALLE');
  });

  test('routes orders to DRV001 (current behaviour: single-driver assignment)', async () => {
    const route = await addOrderToRoute(ORDER);
    expect(route.driver_code).toBe('DRV001');
  });
});

describe('PUT /api/routes/:routeId/stops/:orderCode', () => {
  test('returns 404 for an unknown route', async () => {
    const res = await request(app)
      .put('/api/routes/ROUTE-1999-01-01-DRV001/stops/ORD-0001')
      .send({ status: 'arrived' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: 'Route not found' });
  });

  test('returns 404 when the order is not on the route', async () => {
    await addOrderToRoute(ORDER);
    const routeId = [...routes.keys()][0];

    const res = await request(app)
      .put(`/api/routes/${routeId}/stops/ORD-DOES-NOT-EXIST`)
      .send({ status: 'arrived' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: 'Stop not found' });
  });

  test('updates the stop status and refreshes the route timestamp', async () => {
    await addOrderToRoute(ORDER);
    const routeId = [...routes.keys()][0];

    const res = await request(app)
      .put(`/api/routes/${routeId}/stops/ORD-0001`)
      .send({ status: 'arrived' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.route.stops[0].status).toBe('arrived');
    expect(Date.parse(res.body.route.updated_at)).not.toBeNaN();
  });

  test('keeps the previous status when none is supplied', async () => {
    await addOrderToRoute(ORDER);
    const routeId = [...routes.keys()][0];

    const res = await request(app)
      .put(`/api/routes/${routeId}/stops/ORD-0001`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.route.stops[0].status).toBe('pending');
  });
});
