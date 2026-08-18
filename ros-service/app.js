const express = require('express');
const amqp = require('amqplib');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8002;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://swift_admin:swift_pw_dev_only@rabbitmq:5672';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://swift_admin:swift_pw_dev_only@postgres:5432/swifttrack';
const ORDER_EXCHANGE = 'order_events';
const ROUTE_EXCHANGE = 'route_events';
const ORDER_QUEUE = 'ros_order_events';

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: DATABASE_URL });

const vehicles = [
  {
    driver_code: 'DRV001',
    name: 'Kasun Perera',
    vehicle_id: 'WP-KA-1234',
    capacity_kg: 100,
    start_lat: 6.9271,
    start_lng: 79.8612,
  },
  {
    driver_code: 'DRV002',
    name: 'Nimal Silva',
    vehicle_id: 'WP-NB-5678',
    capacity_kg: 80,
    start_lat: 7.2906,
    start_lng: 80.6337,
  },
];

const routes = new Map();
let rabbitChannel = null;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function routeIdFor(driverCode) {
  return `ROUTE-${todayKey()}-${driverCode}`;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const radiusKm = 6371;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(h));
}

function getOrCreateRoute(driverCode = 'DRV001') {
  const routeId = routeIdFor(driverCode);
  if (!routes.has(routeId)) {
    routes.set(routeId, {
      route_id: routeId,
      driver_code: driverCode,
      date: todayKey(),
      status: 'planned',
      stops: [],
      updated_at: new Date().toISOString(),
    });
  }
  return routes.get(routeId);
}

function optimiseStops(driverCode, stops) {
  const vehicle = vehicles.find((item) => item.driver_code === driverCode) || vehicles[0];
  let currentLat = vehicle.start_lat;
  let currentLng = vehicle.start_lng;
  const remaining = [...stops];
  const ordered = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    remaining.forEach((stop, index) => {
      const distance = haversineKm(currentLat, currentLng, stop.delivery_lat, stop.delivery_lng);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    const [nextStop] = remaining.splice(bestIndex, 1);
    currentLat = nextStop.delivery_lat;
    currentLng = nextStop.delivery_lng;
    ordered.push({
      ...nextStop,
      sequence: ordered.length + 1,
      distance_from_previous_km: Number(bestDistance.toFixed(2)),
      estimated_arrival: new Date(
        `${todayKey()}T08:00:00.000Z`,
      ).getTime() + (ordered.length * 30 * 60 * 1000),
    });
  }

  return ordered.map((stop) => ({
    ...stop,
    estimated_arrival: new Date(stop.estimated_arrival).toISOString(),
  }));
}

function databaseStopStatus(status) {
  if (['delivered', 'completed'].includes(status)) return 'completed';
  if (['failed', 'skipped'].includes(status)) return 'skipped';
  if (status === 'arrived') return 'arrived';
  return 'pending';
}

// ---------------------------------------------------------------------
// Postgres persistence — mirrors the in-memory route into routes /
// route_stops so assignments survive a container restart, and updates
// orders.status so the rest of the system sees the order as assigned.
// This is best-effort: a DB failure here is logged but does not crash
// the consumer or block the in-memory flow other endpoints rely on.
// ---------------------------------------------------------------------
async function getDriverIdByCode(driverCode) {
  const { rows } = await pool.query('SELECT id FROM drivers WHERE driver_code = $1', [driverCode]);
  return rows[0]?.id || null;
}

async function getOrderIdByCode(orderCode) {
  const { rows } = await pool.query('SELECT id FROM orders WHERE order_code = $1', [orderCode]);
  return rows[0]?.id || null;
}

async function upsertRouteRow(driverId, routeDate) {
  const { rows } = await pool.query(
    `INSERT INTO routes (driver_id, route_date, status)
     VALUES ($1, $2, 'planned')
     ON CONFLICT (driver_id, route_date)
     DO UPDATE SET status = routes.status
     RETURNING id`,
    [driverId, routeDate],
  );
  return rows[0].id;
}

async function upsertRouteStopRow(routeDbId, orderId, stop) {
  const existing = await pool.query(
    'SELECT id FROM route_stops WHERE route_id = $1 AND order_id = $2',
    [routeDbId, orderId],
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE route_stops
       SET sequence_index = $1, latitude = $2, longitude = $3,
           eta = $4, stop_status = $5
       WHERE id = $6`,
      [
        stop.sequence,
        stop.delivery_lat,
        stop.delivery_lng,
        stop.estimated_arrival,
        databaseStopStatus(stop.status),
        existing.rows[0].id,
      ],
    );
    return;
  }

  // sequence_index has a UNIQUE(route_id, sequence_index) constraint, and
  // re-optimising can reassign an index another stop already holds — retry
  // once with a temporary offset if that happens, rather than failing the
  // whole persistence pass over one collision.
  try {
    await pool.query(
      `INSERT INTO route_stops (route_id, order_id, sequence_index, latitude, longitude, eta, stop_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [routeDbId, orderId, stop.sequence, stop.delivery_lat, stop.delivery_lng, stop.estimated_arrival, databaseStopStatus(stop.status)],
    );
  } catch (error) {
    if (error.code === '23505') {
      await pool.query(
        `UPDATE route_stops SET sequence_index = $1 + 1000
         WHERE route_id = $2 AND sequence_index = $1 AND order_id != $3`,
        [stop.sequence, routeDbId, orderId],
      );
      await pool.query(
        `INSERT INTO route_stops (route_id, order_id, sequence_index, latitude, longitude, eta, stop_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [routeDbId, orderId, stop.sequence, stop.delivery_lat, stop.delivery_lng, stop.estimated_arrival, databaseStopStatus(stop.status)],
      );
    } else {
      throw error;
    }
  }
}

async function persistRouteToDb(route) {
  try {
    const driverId = await getDriverIdByCode(route.driver_code);
    if (!driverId) {
      console.error(`ROS persistence: no driver found for code ${route.driver_code}`);
      return;
    }

    const routeDbId = await upsertRouteRow(driverId, route.date);

    for (const stop of route.stops) {
      const orderId = await getOrderIdByCode(stop.order_code);
      if (!orderId) {
        console.error(`ROS persistence: no order found for code ${stop.order_code}`);
        continue;
      }
      await upsertRouteStopRow(routeDbId, orderId, stop);
      await pool.query(
        `UPDATE orders SET status = 'assigned', updated_at = now() WHERE id = $1 AND status = 'pending'`,
        [orderId],
      );
    }
  } catch (error) {
    console.error('ROS persistence failed (route stays in-memory only for now):', error.message);
  }
}

async function publishRouteProcessingComplete(route) {
  if (!rabbitChannel) {
    return;
  }

  await rabbitChannel.assertExchange(ROUTE_EXCHANGE, 'fanout', { durable: true });
  rabbitChannel.publish(
    ROUTE_EXCHANGE,
    '',
    Buffer.from(JSON.stringify({
      event_type: 'ROS_PROCESSING_COMPLETE',
      timestamp: new Date().toISOString(),
      data: route,
    })),
    { contentType: 'application/json', persistent: true },
  );
}

async function addOrderToRoute(order) {
  const driverCode = 'DRV001';
  const route = getOrCreateRoute(driverCode);
  const exists = route.stops.some((stop) => stop.order_code === order.order_code);

  if (!exists) {
    route.stops.push({
      order_code: order.order_code,
      client_code: order.client_code,
      pickup_address: order.pickup_address,
      delivery_address: order.delivery_address,
      pickup_lat: Number(order.pickup_lat),
      pickup_lng: Number(order.pickup_lng),
      delivery_lat: Number(order.delivery_lat),
      delivery_lng: Number(order.delivery_lng),
      weight_kg: Number(order.weight_kg),
      status: 'pending',
    });
  }

  route.stops = optimiseStops(driverCode, route.stops);
  route.updated_at = new Date().toISOString();
  await publishRouteProcessingComplete(route);
  await persistRouteToDb(route);
  return route;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ros-service' });
});

app.get('/api/vehicles/available', (req, res) => {
  res.json(vehicles);
});

app.post('/api/routes/optimize', (req, res) => {
  const driverCode = req.body.driver_code || 'DRV001';
  const stops = Array.isArray(req.body.stops) ? req.body.stops : [];
  const normalisedStops = stops.map((stop) => ({
    order_code: stop.order_code,
    client_code: stop.client_code || 'manual',
    pickup_address: stop.pickup_address || '',
    delivery_address: stop.delivery_address,
    pickup_lat: Number(stop.pickup_lat || stop.lat || 6.9271),
    pickup_lng: Number(stop.pickup_lng || stop.lng || 79.8612),
    delivery_lat: Number(stop.delivery_lat || stop.lat || 6.9271),
    delivery_lng: Number(stop.delivery_lng || stop.lng || 79.8612),
    weight_kg: Number(stop.weight_kg || 0),
    status: stop.status || 'pending',
  }));

  res.json({
    route_id: routeIdFor(driverCode),
    driver_code: driverCode,
    date: todayKey(),
    stops: optimiseStops(driverCode, normalisedStops),
  });
});

app.get('/api/routes', (req, res) => {
  res.json(Array.from(routes.values()));
});

app.get('/api/routes/driver/:driverCode/today', (req, res) => {
  const route = getOrCreateRoute(req.params.driverCode);
  res.json(route);
});

app.put('/api/routes/:routeId/stops/:orderCode', async (req, res) => {
  const route = routes.get(req.params.routeId);
  if (!route) {
    return res.status(404).json({ success: false, message: 'Route not found' });
  }

  const stop = route.stops.find((item) => item.order_code === req.params.orderCode);
  if (!stop) {
    return res.status(404).json({ success: false, message: 'Stop not found' });
  }

  stop.status = req.body.status || stop.status;
  route.updated_at = new Date().toISOString();
  await publishRouteProcessingComplete(route);
  await persistRouteToDb(route);
  return res.json({ success: true, route });
});

async function connectRabbitWithRetry() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();
    await rabbitChannel.assertExchange(ORDER_EXCHANGE, 'fanout', { durable: true });
    await rabbitChannel.assertExchange(ROUTE_EXCHANGE, 'fanout', { durable: true });
    const queue = await rabbitChannel.assertQueue(ORDER_QUEUE, { durable: true });
    await rabbitChannel.bindQueue(queue.queue, ORDER_EXCHANGE, '');
    await rabbitChannel.prefetch(1);
    await rabbitChannel.consume(queue.queue, async (message) => {
      if (!message) {
        return;
      }

      try {
        const event = JSON.parse(message.content.toString());
        if (event.event_type === 'ORDER_CREATED') {
          await addOrderToRoute(event.data);
        }
        rabbitChannel.ack(message);
      } catch (error) {
        console.error('Failed to process order event', error);
        rabbitChannel.nack(message, false, false);
      }
    });

    connection.on('close', () => {
      rabbitChannel = null;
      setTimeout(connectRabbitWithRetry, 5000);
    });
    console.log('ROS connected to RabbitMQ');
  } catch (error) {
    console.error('ROS RabbitMQ connection failed:', error.message);
    setTimeout(connectRabbitWithRetry, 5000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup: Restore today's routes from PostgreSQL into in-memory store.
// This ensures data survives container restarts.
// ─────────────────────────────────────────────────────────────────────────────
async function loadRoutesFromDb() {
  try {
    const today = todayKey();
    const { rows } = await pool.query(
      `SELECT
         r.id         AS db_route_id,
         d.driver_code,
         r.route_date::TEXT AS route_date,
         r.status     AS route_status,
         rs.sequence_index,
         rs.stop_status,
         rs.latitude,
         rs.longitude,
         rs.eta,
         o.order_code,
         o.pickup_address,
         o.delivery_address,
         o.pickup_lat,
         o.pickup_lng,
         o.delivery_lat,
         o.delivery_lng,
         o.weight_kg,
         c.client_code
       FROM routes r
       JOIN drivers d ON d.id = r.driver_id
       JOIN route_stops rs ON rs.route_id = r.id
       JOIN orders o ON o.id = rs.order_id
       JOIN clients c ON c.id = o.client_id
       WHERE r.route_date = $1
       ORDER BY d.driver_code, rs.sequence_index`,
      [today]
    );

    if (rows.length === 0) {
      console.log('ROS startup: no existing routes found in DB for today.');
      return;
    }

    for (const row of rows) {
      const routeId = routeIdFor(row.driver_code);
      if (!routes.has(routeId)) {
        routes.set(routeId, {
          route_id: routeId,
          driver_code: row.driver_code,
          date: row.route_date,
          status: row.route_status,
          stops: [],
          updated_at: new Date().toISOString(),
        });
      }
      const route = routes.get(routeId);
      // Avoid duplicates
      const alreadyLoaded = route.stops.some((s) => s.order_code === row.order_code);
      if (!alreadyLoaded) {
        route.stops.push({
          order_code: row.order_code,
          client_code: row.client_code,
          pickup_address: row.pickup_address,
          delivery_address: row.delivery_address,
          pickup_lat: Number(row.pickup_lat),
          pickup_lng: Number(row.pickup_lng),
          delivery_lat: Number(row.latitude ?? row.delivery_lat),
          delivery_lng: Number(row.longitude ?? row.delivery_lng),
          weight_kg: Number(row.weight_kg),
          status: row.stop_status === 'completed' ? 'delivered'
                : row.stop_status === 'skipped'   ? 'failed'
                : 'pending',
          sequence: row.sequence_index,
          distance_from_previous_km: 0,
          estimated_arrival: row.eta ? new Date(row.eta).toISOString() : null,
        });
      }
    }

    console.log(`ROS startup: restored ${rows.length} stop(s) across ${routes.size} route(s) from DB.`);
  } catch (err) {
    console.error('ROS startup DB load failed (in-memory will be empty):', err.message);
  }
}

app.listen(PORT, async () => {
  console.log(`ROS service listening on port ${PORT}`);
  await loadRoutesFromDb();
  connectRabbitWithRetry();
});
