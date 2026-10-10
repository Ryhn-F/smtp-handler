'use strict';

// DentisAI mailer: HTTPS receiver for the Supabase Auth "Send Email" hook.
// See README.md. The old contact-form relay (/api/send-email) was removed on
// purpose: it was an open, unauthenticated mail relay.

require('dotenv').config();

const { createApp } = require('./src/app');

const { app, config, logger } = createApp();

if (!config.ok) {
  // Names only, never values. The hook endpoint answers 503 until fixed.
  logger.error('config_incomplete', { missing: config.missing.join(':') });
}

const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port, node: process.version });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
