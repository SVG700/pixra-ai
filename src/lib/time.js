'use strict';
const config = require('../config');

const tz = () => config.business.timezone;
const tzLabel = () => (tz() === 'Asia/Kolkata' ? 'IST' : tz());

function dayKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// "4:35 pm IST", or "4:35 pm IST, Fri 24 Oct" when not today (in the display timezone)
function formatDue(date, now = new Date()) {
  const d = new Date(date);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: tz(), hour: 'numeric', minute: '2-digit', hour12: true }).format(d).toUpperCase();
  if (dayKey(d) === dayKey(now)) return `${time} ${tzLabel()}`;
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${time} ${tzLabel()}, ${day}`;
}

function formatDateTime(date) {
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: tz(), day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(date))} ${tzLabel()}`;
}

// "2h 15m left" / "12m left" / "overdue 40m"; urgent when under 30 minutes.
function timeLeft(deadline, now = Date.now()) {
  if (!deadline) return { label: '-', urgent: false, overdue: false, minutes: null };
  const minutes = Math.round((new Date(deadline) - now) / 60000);
  const abs = Math.abs(minutes);
  const span = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs}m`;
  return {
    minutes,
    overdue: minutes < 0,
    urgent: minutes < 30,
    label: minutes < 0 ? `overdue ${span}` : `${span} left`,
  };
}

// "4:35:10 PM" in the display timezone (for short-lived things like retry times)
function formatClock(date) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz(), hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
    .format(new Date(date)).toUpperCase();
}

module.exports = { formatDue, formatDateTime, formatClock, timeLeft };
