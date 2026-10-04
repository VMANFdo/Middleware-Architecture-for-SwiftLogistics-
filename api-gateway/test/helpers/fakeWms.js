'use strict';

const net = require('net');

/**
 * A minimal stand-in for the WMS service's proprietary TCP server
 * (wms-service/app.py::start_tcp_server): newline-delimited JSON in,
 * newline-delimited JSON out.
 *
 * Lets integration tests assert the exact wire commands the gateway's
 * channel adapter emits without needing the Python service running.
 *
 * The response behaviour is swappable per test via `setResponder`.
 */
function createFakeWms(initialResponder) {
  const received = [];
  const openSockets = new Set();
  let responder = initialResponder || (() => ({ success: false, message: 'no responder set' }));

  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line.trim()) continue;

        let response;
        try {
          const command = JSON.parse(line);
          received.push(command);
          response = responder(command);
        } catch (err) {
          response = { success: false, message: err.message };
        }

        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  return {
    server,
    received,
    setResponder(fn) {
      responder = fn;
    },
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}

/** A TCP server that always writes `payload` verbatim followed by a newline. */
function createRawTcpServer(payload) {
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.write(payload));
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP server that accepts the connection and then stays silent. */
function createSilentTcpServer() {
  const openSockets = new Set();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}

/** A TCP server that dribbles `payload` out in fixed-size slices. */
function createChunkedTcpServer(payload, sliceSize = 8, delayMs = 15) {
  const openSockets = new Set();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));

    socket.on('data', () => {
      const slices = [];
      for (let i = 0; i < payload.length; i += sliceSize) {
        slices.push(payload.slice(i, i + sliceSize));
      }

      let delay = 0;
      for (const slice of slices) {
        delay += delayMs;
        setTimeout(() => socket.write(slice), delay);
      }
      setTimeout(() => socket.write('\n'), delay + delayMs);
    });
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createFakeWms, createRawTcpServer, createSilentTcpServer, createChunkedTcpServer };
