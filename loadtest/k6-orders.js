// =====================================================================
// SwiftTrack load test — Phase 1, task 1.8
//
//   60 VUs x 60 s hammering POST /api/orders through the API gateway.
//
// Every request walks the full middleware path:
//   gateway -> CMS (SOAP/XML) -> Postgres -> RabbitMQ fanout -> WMS + ROS
//
// Acceptance thresholds (from IMPLEMENTATION_PLAN.md):
//   p95 latency < 1500 ms      error rate < 1 %      checks > 99 %
//
// Run it with:
//   ./scripts/loadtest.sh                 # auto-detects k6 or Docker
//   k6 run loadtest/k6-orders.js          # if k6 is on PATH
// =====================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CLIENT_EMAIL = __ENV.CLIENT_EMAIL || 'techmart@example.com';
const CLIENT_PASSWORD = __ENV.CLIENT_PASSWORD || 'password123';
const VUS = Number(__ENV.VUS || 60);
const DURATION = __ENV.DURATION || '60s';
// A tiny pause keeps a fast machine from drowning the broker in writes while
// still leaving the VUs effectively saturated.
const PAUSE = Number(__ENV.PAUSE || 0.05);

const orderLatency = new Trend('order_create_duration', true);
const orderErrors = new Rate('order_create_errors');

export const options = {
  scenarios: {
    order_create: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '30s',
      tags: { scenario: 'order_create' },
    },
  },
  thresholds: {
    // Plan requirement: p95 < 1500 ms, error rate < 1 %.
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
    http_req_failed: ['rate<0.01'],
    order_create_duration: ['p(95)<1500'],
    order_create_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

// A realistic spread of Sri Lankan pickup/delivery pairs; the CMS resolves
// each one to coordinates before the saga fans out.
const ADDRESSES = [
  '45 Galle Road, Colombo 03',
  '10 Havelock Road, Colombo 05',
  'Temple Road, Gampaha',
  'Beach Road, Galle',
  'Peradeniya Road, Kandy',
  'Negombo Lagoon, Negombo',
  'Main Street, Kurunegala',
  'Fort Road, Matara',
];

export function setup() {
  const response = http.post(
    `${BASE_URL}/api/auth/client/login`,
    JSON.stringify({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'setup_login' },
    },
  );

  let token = null;
  try {
    token = response.json('token');
  } catch (error) {
    // handled below by the status/token assertions
  }

  const healthy = check(response, {
    'setup: login returned 200': (r) => r.status === 200,
    'setup: issued a bearer token': () => Boolean(token),
  });

  if (!healthy) {
    throw new Error(
      `setup failed — cannot authenticate against ${BASE_URL} ` +
        `(status=${response.status}, body=${response.body}). ` +
        'Is the stack running?',
    );
  }

  return { token };
}

export default function (data) {
  const pickup = ADDRESSES[Math.floor(Math.random() * ADDRESSES.length)];
  let delivery = ADDRESSES[Math.floor(Math.random() * ADDRESSES.length)];
  if (delivery === pickup) {
    delivery = ADDRESSES[(ADDRESSES.indexOf(pickup) + 1) % ADDRESSES.length];
  }

  const response = http.post(
    `${BASE_URL}/api/orders`,
    JSON.stringify({
      pickup_address: pickup,
      delivery_address: delivery,
      weight_kg: Number((1 + Math.random() * 9).toFixed(2)),
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.token}`,
      },
      tags: { name: 'create_order', scenario: 'order_create' },
    },
  );

  const passed = check(response, {
    'order created with 201': (r) => r.status === 201,
    'order code returned': (r) => {
      try {
        return Boolean(r.json('order_code'));
      } catch (error) {
        return false;
      }
    },
    'order marked event_published': (r) => {
      try {
        return r.json('event_published') === true;
      } catch (error) {
        return false;
      }
    },
  });

  orderLatency.add(response.timings.duration);
  orderErrors.add(!passed);

  if (response.status !== 201) {
    console.error(`create_order failed: ${response.status} ${response.body}`);
  }

  sleep(PAUSE);
}

export function teardown(data) {
  console.log(`finished: ${data.token ? 'authenticated run' : 'unauthenticated'}`);
}
