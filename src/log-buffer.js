'use strict';

const MAX_LINES = 300;
const lines = [];
let installed = false;

function push(line) {
  const text = String(line || '').trim();
  if (!text) return;

  lines.push(`${new Date().toISOString()} ${text}`);
  if (lines.length > MAX_LINES) lines.shift();
}

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function install() {
  if (installed) return;
  installed = true;

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        push(`[${level}] ${args.map(formatArg).join(' ')}`);
      } catch {
        /* лог не должен ломать приложение */
      }
      original(...args);
    };
  }
}

function get() {
  return lines.slice();
}

module.exports = { install, push, get };
