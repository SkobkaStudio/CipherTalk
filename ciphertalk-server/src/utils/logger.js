const pino = require('pino');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: isProd ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.authorization', 'authorization', 'password', 'code', 'phone'],
    remove: true
  }
}, isProd ? pino.destination(path.join(logDir, 'app.log')) : undefined);

module.exports = logger;
