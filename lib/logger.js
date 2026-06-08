import crypto from 'crypto';

function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (v === undefined) return defaultVal;
  return String(v).toLowerCase() === 'true' || v === '1' || v === 'yes';
}

const ENABLE_DEBUG = envBool('LOG_DEBUG', false);

export function getLogger(context = '') {
  const prefix = context ? `[${context}]` : '[app]';

  function base(level, msg, meta) {
    const id = crypto.randomBytes(4).toString('hex');
    const line = {
      ts: new Date().toISOString(),
      level,
      prefix,
      id,
      msg,
      ...(meta && typeof meta === 'object' ? meta : {}),
    };

    // Keep it simple: output single line for easy parsing.
    // Never throw from logger.
    try {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(line));
    } catch (_) {
      // eslint-disable-next-line no-console
      console.log(`${level} ${prefix} ${msg}`);
    }
  }

  return {
    info: (msg, meta) => base('info', msg, meta),
    warn: (msg, meta) => base('warn', msg, meta),
    error: (msg, meta) => base('error', msg, meta),
    debug: (msg, meta) => {
      if (!ENABLE_DEBUG) return;
      base('debug', msg, meta);
    },
  };
}
