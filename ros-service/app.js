const express = require('express');
const amqp = require('amqplib');

const PORT = process.env.PORT || 8002;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://swift_admin:swift_pw_dev_only@rabbitmq:5672';
const ORDER_EXCHANGE = 'order_events';
const ROUTE_EXCHANGE = 'route_events';
const ORDER_QUEUE = 'ros_order_events';

const app = express();
app.use(express.json());

const vehicles = [
  {
    driver_code: 'DRV001',
    name: 'Kasun Jayasuriya',
    vehicle_id: 'WP-CAB-4521',
    capacity_kg: 100,
    start_lat: 6.9271,
    start_lng: 79.8612,
  },
  {
    driver_code: 'DRV002',
    name: 'Ishara Wickramasinghe',
    vehicle_id: 'WP-CAB-7789',
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
    });
  }

  return ordered;
}

async function publishRouteUpdated(route) {
  if (!rabbitChannel) {
    return;
  }

  await rabbitChannel.assertExchange(ROUTE_EXCHANGE, 'fanout', { durable: true });
  rabbitChannel.publish(
    ROUTE_EXCHANGE,
    '',
    Buffer.from(JSON.stringify({
      event_type: 'ROUTE_UPDATED',
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
  await publishRouteUpdated(route);
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
  await publishRouteUpdated(route);
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

app.listen(PORT, () => {
  console.log(`ROS service listening on port ${PORT}`);
  connectRabbitWithRetry();
});
