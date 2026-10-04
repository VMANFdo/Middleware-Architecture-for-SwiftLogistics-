'use strict';

// Runs before the ROS test files load app.js so the module-level config
// points at guaranteed-dead endpoints. Port 1 fails fast (ECONNREFUSED)
// instead of hanging.

process.env.NODE_ENV = 'test';
process.env.PORT = '8002';
process.env.DATABASE_URL = 'postgresql://swift_test:swift_test@127.0.0.1:1/swifttrack';
process.env.RABBITMQ_URL = 'amqp://swift_test:swift_test@127.0.0.1:1';
