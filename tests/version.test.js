'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer } = require('../src/version');

test('сравнение версий', () => {
  assert.equal(isNewer('0.27.0', '0.26.1'), true);
  assert.equal(isNewer('0.26.1', '0.26.1'), false);
  assert.equal(isNewer('0.26.0', '0.26.1'), false);
  assert.equal(isNewer('v0.27.0', '0.26.1'), true);
});

test('двузначные части версии сравниваются как числа', () => {
  assert.equal(isNewer('0.26.10', '0.26.9'), true);
  assert.equal(isNewer('0.26.9', '0.26.10'), false);
});
