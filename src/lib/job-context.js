'use strict';
// Carries the current job id through async calls (AsyncLocalStorage), so low-level code such as
// the HTTP retry helper can report "job X is waiting for a rate limit" without extra parameters.
const { AsyncLocalStorage } = require('async_hooks');
const { EventEmitter } = require('events');

const als = new AsyncLocalStorage();
const events = new EventEmitter(); // 'wait' | 'recovered'  ({ jobId, label, status, attempt, retries, delayMs })

const runWithJob = (jobId, fn) => als.run({ jobId }, fn);
const currentJobId = () => als.getStore()?.jobId || null;

module.exports = { runWithJob, currentJobId, events };
