// =====================================================================
// SwiftTrack API Gateway — Initial Scaffold
// SCS3208 Middleware Architecture | Assignment 4 | Phase 1, Step 1.3
// =====================================================================
// This is intentionally minimal for Phase 1. Later phases add:
//   Phase 3: SOAP client (CMS) + raw TCP bridge (WMS) route handlers
//   Phase 5: WebSocket dispatch + Saga transaction coordinator
// =====================================================================

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic request logging — helpful while multiple teammates are
// integrating against this gateway in parallel.
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------------------------------------------------------------------
// Health check
// Used by docker-compose / manual verification that the gateway is up.
// Phase 3+ can extend this to also report downstream service health.
// ---------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------
// Route placeholders for upcoming phases
// (kept here so teammates know where their work plugs in)
// ---------------------------------------------------------------------
// Phase 3.1 — REST -> SOAP adapter for CMS
// app.post('/api/auth/client/login', ...)

// Phase 3.2 — REST -> TCP bridge for WMS
// app.get('/api/packages/scan/:barcode', ...)

// Phase 5.1 — WebSocket live event dispatch
// (attached to the http server below, not the Express app directly)

// ---------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ---------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`SwiftTrack API Gateway listening on port ${PORT}`);
});

module.exports = app;
