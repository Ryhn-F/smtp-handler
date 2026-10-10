'use strict';

// DentisAI mailer: HTTPS receiver for the Supabase Auth "Send Email" hook.
// See README.md. The old contact-form relay (/api/send-email) was removed on
// purpose: it was an open, unauthenticated mail relay.
//
// Runs both as a long-lived server (`node index.js`, e.g. a VPS/Docker) and as a Vercel
// serverless function: Vercel needs the Express app to be the module's export and must
// NOT call listen(), otherwise the invocation fails (FUNCTION_INVOCATION_FAILED).

require('dotenv').config();

const { createApp } = require('./src/app');

const { app, config, logger } = createApp();

if (!config.ok) {
  // Names only, never values. The hook endpoint answers 503 until fixed.
  logger.error('config_incomplete', { missing: config.missing.join(':') });
}

if (require.main === module && !process.env.VERCEL) {
  const server = app.listen(config.port, () => {
    logger.info('listening', { port: config.port, node: process.version });
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
