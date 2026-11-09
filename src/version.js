'use strict';

function parts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((value) => Number.parseInt(value, 10) || 0);
}

function isNewer(remote, current) {
  const a = parts(remote);
  const b = parts(current);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }

  return false;
}

module.exports = { parts, isNewer };
