'use strict';

const {
  todayKey,
  routeIdFor,
  toRadians,
  haversineKm,
  optimiseStops,
  databaseStopStatus,
} = require('../app');

const COLOMBO = { lat: 6.9271, lng: 79.8612 };
const KANDY = { lat: 7.2906, lng: 80.6337 };
const GALLE = { lat: 6.0535, lng: 80.221 };

function stop(orderCode, lat, lng, extra = {}) {
  return {
    order_code: orderCode,
    client_code: 'CLT001',
    pickup_address: 'pickup',
    delivery_address: `delivery for ${orderCode}`,
    pickup_lat: COLOMBO.lat,
    pickup_lng: COLOMBO.lng,
    delivery_lat: lat,
    delivery_lng: lng,
    weight_kg: 1,
    status: 'pending',
    ...extra,
  };
}

describe('todayKey / routeIdFor', () => {
  test('todayKey returns an ISO calendar date', () => {
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayKey()).toBe(new Date().toISOString().slice(0, 10));
  });

  test('routeIdFor composes a stable, driver-specific id', () => {
    const id = routeIdFor('DRV002');
    expect(id).toBe(`ROUTE-${todayKey()}-DRV002`);
    expect(routeIdFor('DRV002')).toBe(id);
    expect(routeIdFor('DRV001')).not.toBe(id);
  });
});

describe('toRadians', () => {
  test('converts degrees to radians', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
    expect(toRadians(0)).toBe(0);
    expect(toRadians(360)).toBeCloseTo(2 * Math.PI, 10);
  });
});

describe('haversineKm', () => {
  test('is zero for identical coordinates', () => {
    expect(haversineKm(COLOMBO.lat, COLOMBO.lng, COLOMBO.lat, COLOMBO.lng)).toBe(0);
  });

  test('matches the known Colombo → Kandy great-circle distance', () => {
    const km = haversineKm(COLOMBO.lat, COLOMBO.lng, KANDY.lat, KANDY.lng);
    expect(km).toBeCloseTo(94.34, 1);
  });

  test('matches the known Colombo → Galle great-circle distance', () => {
    const km = haversineKm(COLOMBO.lat, COLOMBO.lng, GALLE.lat, GALLE.lng);
    expect(km).toBeCloseTo(104.96, 1);
  });

  test('one degree of latitude is roughly 111.2 km', () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0);
  });

  test('is symmetric', () => {
    const forward = haversineKm(COLOMBO.lat, COLOMBO.lng, KANDY.lat, KANDY.lng);
    const backward = haversineKm(KANDY.lat, KANDY.lng, COLOMBO.lat, COLOMBO.lng);
    expect(forward).toBeCloseTo(backward, 10);
  });
});

describe('optimiseStops — nearest-neighbour ordering', () => {
  const cityStop = stop('ORD-CITY', 6.8916, 79.8567);
  const kandyStop = stop('ORD-KANDY', 7.2932, 80.635);
  const galleStop = stop('ORD-GALLE', 6.0276, 80.2199);

  test('orders stops by proximity to the vehicle start (Colombo)', () => {
    // Deliberately shuffled input.
    const ordered = optimiseStops('DRV001', [galleStop, kandyStop, cityStop]);

    expect(ordered.map((s) => s.order_code)).toEqual([
      'ORD-CITY',   // ~4 km from the Colombo depot
      'ORD-KANDY',  // then north
      'ORD-GALLE',  // then south
    ]);
  });

  test('emits a contiguous 1-based sequence', () => {
    const ordered = optimiseStops('DRV001', [galleStop, kandyStop, cityStop]);
    expect(ordered.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  test('measures the first leg from the depot, not from a previous stop', () => {
    const ordered = optimiseStops('DRV001', [cityStop]);
    expect(ordered[0].distance_from_previous_km).toBeCloseTo(3.98, 1);
    expect(ordered[0].distance_from_previous_km).toBeLessThan(5);
  });

  test('reports distance from the immediately preceding stop', () => {
    const ordered = optimiseStops('DRV001', [cityStop, kandyStop]);
    expect(ordered[0].distance_from_previous_km).toBeCloseTo(3.98, 1);
    expect(ordered[1].distance_from_previous_km).toBeGreaterThan(90);
    expect(ordered[1].distance_from_previous_km).toBeLessThan(100);
  });

  test('produces monotonically increasing ISO arrival times', () => {
    const ordered = optimiseStops('DRV001', [cityStop, kandyStop, galleStop]);

    const timestamps = ordered.map((s) => Date.parse(s.estimated_arrival));
    expect(ordered.every((s) => Number.isNaN(Date.parse(s.estimated_arrival)) === false)).toBe(true);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  test('returns an empty list for an empty route', () => {
    expect(optimiseStops('DRV001', [])).toEqual([]);
  });

  test('does not mutate the caller\'s stop array', () => {
    const input = [galleStop, kandyStop, cityStop];
    const before = input.map((s) => s.order_code);

    optimiseStops('DRV001', input);

    expect(input.map((s) => s.order_code)).toEqual(before);
  });

  test('preserves every field of the original stop', () => {
    const [ordered] = optimiseStops('DRV001', [{ ...kandyStop, note: 'fragile' }]);
    expect(ordered).toMatchObject({
      order_code: 'ORD-KANDY',
      client_code: 'CLT001',
      delivery_address: 'delivery for ORD-KANDY',
      weight_kg: 1,
      status: 'pending',
      note: 'fragile',
    });
  });

  test('an unknown driver falls back to the first configured vehicle', () => {
    // vehicles[0] is DRV001, which starts in Colombo.
    const fallback = optimiseStops('DRV-NOT-CONFIGURED', [cityStop]);
    expect(fallback[0].distance_from_previous_km).toBeCloseTo(3.98, 1);
  });

  test('a single stop still yields a valid sequence and ETA', () => {
    const ordered = optimiseStops('DRV001', [cityStop]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].sequence).toBe(1);
    expect(ordered[0].estimated_arrival).toEqual(expect.any(String));
  });
});

describe('databaseStopStatus', () => {
  test.each([
    ['delivered', 'completed'],
    ['completed', 'completed'],
    ['failed', 'skipped'],
    ['skipped', 'skipped'],
    ['arrived', 'arrived'],
    ['pending', 'pending'],
  ])('maps %s → %s', (input, expected) => {
    expect(databaseStopStatus(input)).toBe(expected);
  });

  test('unknown statuses degrade to pending rather than raising', () => {
    expect(databaseStopStatus('something-new')).toBe('pending');
    expect(databaseStopStatus(undefined)).toBe('pending');
    expect(databaseStopStatus('')).toBe('pending');
  });
});
