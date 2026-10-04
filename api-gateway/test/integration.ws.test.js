'use strict';

const WebSocket = require('ws');

const { server, wss, dispatchWebSocketMessage } = require('../app');

let port;
const openSockets = [];

function openSocket() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const socket = { ws, messages };

  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push({ type: 'unparseable', raw: raw.toString() });
    }
  });

  openSockets.push(socket);
  return socket;
}

async function waitFor(predicate, { timeout = 3000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function once(predicate, label) {
  return waitFor(predicate, { label });
}

async function openConnectedSocket() {
  const socket = openSocket();
  await once(() => socket.messages.some((m) => m.type === 'connected'), 'connected frame');
  return socket;
}

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.ws.terminate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

describe('WebSocket handshake', () => {
  test('greets a new connection with a connected frame', async () => {
    const socket = await openConnectedSocket();
    const connected = socket.messages.find((m) => m.type === 'connected');

    expect(connected).toMatchObject({
      type: 'connected',
      message: expect.stringContaining('SwiftTrack'),
    });
    expect(connected.timestamp).toEqual(expect.any(String));
  });

  test('register_client acknowledges the claimed id', async () => {
    const socket = await openConnectedSocket();
    socket.ws.send(JSON.stringify({ type: 'register_client', client_id: 'CLT001' }));

    await once(() => socket.messages.some((m) => m.type === 'registered'), 'registered frame');

    const registered = socket.messages.find((m) => m.type === 'registered');
    expect(registered).toMatchObject({ type: 'registered', role: 'client', id: 'CLT001' });
  });

  test('register_driver acknowledges the claimed id', async () => {
    const socket = await openConnectedSocket();
    socket.ws.send(JSON.stringify({ type: 'register_driver', driver_id: 'DRV001' }));

    await once(() => socket.messages.some((m) => m.type === 'registered'), 'registered frame');

    expect(socket.messages.find((m) => m.type === 'registered')).toMatchObject({
      role: 'driver',
      id: 'DRV001',
    });
  });

  test('responds to ping with pong', async () => {
    const socket = await openConnectedSocket();
    socket.ws.send(JSON.stringify({ type: 'ping' }));

    await once(() => socket.messages.some((m) => m.type === 'pong'), 'pong frame');
    expect(socket.messages.find((m) => m.type === 'pong').type).toBe('pong');
  });

  test('ignores malformed frames without dropping the connection', async () => {
    const socket = await openConnectedSocket();
    socket.ws.send('this is not json {{{');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);

    socket.ws.send(JSON.stringify({ type: 'ping' }));
    await once(() => socket.messages.some((m) => m.type === 'pong'), 'pong after garbage');
  });
});

describe('targeted event dispatch', () => {
  test('delivers only to sockets registered for that client', async () => {
    const alice = await openConnectedSocket();
    const bob = await openConnectedSocket();

    alice.ws.send(JSON.stringify({ type: 'register_client', client_id: 'CLT001' }));
    bob.ws.send(JSON.stringify({ type: 'register_client', client_id: 'CLT002' }));

    await once(() => alice.messages.some((m) => m.type === 'registered'), 'alice registered');
    await once(() => bob.messages.some((m) => m.type === 'registered'), 'bob registered');

    dispatchWebSocketMessage({
      target: 'client',
      recipientId: 'CLT001',
      eventType: 'ORDER_CREATED',
      orderCode: 'ORD-0001',
      payload: { status: 'pending', message: 'Order created' },
    });

    await once(() => alice.messages.some((m) => m.type === 'ORDER_CREATED'), 'alice event');

    const receivedByAlice = alice.messages.find((m) => m.type === 'ORDER_CREATED');
    expect(receivedByAlice).toMatchObject({
      event_type: 'ORDER_CREATED',
      order_code: 'ORD-0001',
      order_id: 'ORD-0001',
      status: 'pending',
      message: 'Order created',
    });
    expect(receivedByAlice.timestamp).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.messages.some((m) => m.type === 'ORDER_CREATED')).toBe(false);
  });

  test('delivers driver events only to driver sockets', async () => {
    const driver = await openConnectedSocket();
    const client = await openConnectedSocket();

    driver.ws.send(JSON.stringify({ type: 'register_driver', driver_id: 'DRV001' }));
    client.ws.send(JSON.stringify({ type: 'register_client', client_id: 'CLT001' }));

    await once(() => driver.messages.some((m) => m.type === 'registered'), 'driver registered');
    await once(() => client.messages.some((m) => m.type === 'registered'), 'client registered');

    dispatchWebSocketMessage({
      target: 'driver',
      recipientId: 'DRV001',
      eventType: 'NEW_ORDER_AVAILABLE',
      orderCode: 'ORD-0002',
      payload: { message: 'New order' },
    });

    await once(() => driver.messages.some((m) => m.type === 'NEW_ORDER_AVAILABLE'), 'driver event');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.messages.some((m) => m.type === 'NEW_ORDER_AVAILABLE')).toBe(false);
  });

  test('a broadcast with no target reaches every open socket', async () => {
    const one = await openConnectedSocket();
    const two = await openConnectedSocket();

    dispatchWebSocketMessage({
      eventType: 'SYSTEM_ANNOUNCEMENT',
      orderCode: null,
      payload: { message: 'maintenance window' },
    });

    await once(() => one.messages.some((m) => m.type === 'SYSTEM_ANNOUNCEMENT'), 'one');
    await once(() => two.messages.some((m) => m.type === 'SYSTEM_ANNOUNCEMENT'), 'two');
  });

  test('a target with no connected sockets is a no-op, not a crash', () => {
    expect(() => dispatchWebSocketMessage({
      target: 'client',
      recipientId: 'CLT-NOBODY',
      eventType: 'ORDER_CREATED',
      orderCode: 'ORD-0001',
      payload: {},
    })).not.toThrow();
  });

  test('a driver with several open tabs receives the event on each', async () => {
    const tabOne = await openConnectedSocket();
    const tabTwo = await openConnectedSocket();

    tabOne.ws.send(JSON.stringify({ type: 'register_driver', driver_id: 'DRV002' }));
    tabTwo.ws.send(JSON.stringify({ type: 'register_driver', driver_id: 'DRV002' }));

    await once(() => tabOne.messages.some((m) => m.type === 'registered'), 'tab one');
    await once(() => tabTwo.messages.some((m) => m.type === 'registered'), 'tab two');

    dispatchWebSocketMessage({
      target: 'driver',
      recipientId: 'DRV002',
      eventType: 'ROUTE_UPDATED',
      orderCode: 'ORD-0003',
      payload: { message: 're-sequenced' },
    });

    await once(() => tabOne.messages.some((m) => m.type === 'ROUTE_UPDATED'), 'tab one event');
    await once(() => tabTwo.messages.some((m) => m.type === 'ROUTE_UPDATED'), 'tab two event');
  });
});
