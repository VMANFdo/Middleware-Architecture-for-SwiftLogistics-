'use strict';

// Runs before the test framework and before any test file imports app.js,
// so app.js reads these values when it evaluates its module-level config.
//
// Everything points at port 1 so an accidental real connection fails fast
// (ECONNREFUSED) instead of hanging the suite.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-secret-do-not-use-in-production';
process.env.JWT_EXPIRES_IN = '1h';

process.env.DATABASE_URL = 'postgresql://swift_test:swift_test@127.0.0.1:1/swifttrack';
process.env.RABBITMQ_URL = 'amqp://swift_test:swift_test@127.0.0.1:1';

process.env.CMS_SOAP_URL = 'http://127.0.0.1:1/soap';
process.env.CMS_REST_URL = 'http://127.0.0.1:1';
process.env.ROS_REST_URL = 'http://127.0.0.1:1';
process.env.WMS_TCP_HOST = '127.0.0.1';
process.env.WMS_TCP_PORT = '1';

process.env.DOWNSTREAM_TIMEOUT_MS = '500';
process.env.DEMO_DRIVER_PASSWORD = 'password123';
