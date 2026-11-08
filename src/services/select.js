'use strict';
// Chooses real vs mock implementation for a service, with the same interface either way.
//  - MOCK_MODE=true             -> mock
//  - keys present               -> real
//  - keys missing + DEV_MODE    -> mock (with a warning)
//  - keys missing, no DEV_MODE  -> stub that throws a clear "not configured" error on use
const config = require('../config');
const log = require('../logger');
const { instrument } = require('../lib/telemetry');

const modes = {};

function unconfigured(name, missing) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // not a promise
      if (prop === 'kind') return 'missing';
      return () => {
        throw new Error(`${name} is not configured (missing ${missing.join(', ')}). Set them in .env or enable DEV_MODE.`);
      };
    },
  });
}

function select(name, { required, real, mock }) {
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (config.mockMode) {
    modes[name] = 'mock';
    log.info(`${name}: using MOCK (MOCK_MODE=true)`);
    return instrument(name, mock());
  }
  if (!missing.length) {
    modes[name] = 'real';
    return instrument(name, real());
  }
  if (config.devMode) {
    modes[name] = 'mock';
    log.warn(`${name}: missing ${missing.join(', ')} -> falling back to MOCK (DEV_MODE=true)`);
    return instrument(name, mock());
  }
  modes[name] = 'missing';
  log.error(`${name}: missing ${missing.join(', ')} and DEV_MODE=false -> calls will fail`);
  return unconfigured(name, missing);
}

module.exports = { select, modes, unconfigured };
