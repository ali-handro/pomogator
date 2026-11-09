'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cropRect } = require('../src/crop');

const image = { width: 3840, height: 2160 };

test('масштаб 2x пересчитывает выделение в пиксели снимка', () => {
  assert.deepEqual(cropRect({ x: 100, y: 50, width: 400, height: 300 }, image, 2, 2), {
    x: 200,
    y: 100,
    width: 800,
    height: 600,
  });
});

test('дробный масштаб 1.75x', () => {
  assert.deepEqual(cropRect({ x: 100, y: 100, width: 200, height: 100 }, image, 1.75, 1.75), {
    x: 175,
    y: 175,
    width: 350,
    height: 175,
  });
});

test('выделение обрезается по краю снимка', () => {
  assert.deepEqual(cropRect({ x: 1800, y: 1000, width: 400, height: 300 }, image, 2, 2), {
    x: 3600,
    y: 2000,
    width: 240,
    height: 160,
  });
});

test('отрицательные координаты не уходят за край', () => {
  assert.deepEqual(cropRect({ x: -50, y: -20, width: 100, height: 80 }, image, 2, 2), {
    x: 0,
    y: 0,
    width: 200,
    height: 160,
  });
});

test('слишком маленькое выделение даёт маленький прямоугольник', () => {
  const result = cropRect({ x: 10, y: 10, width: 4, height: 4 }, image, 1, 1);
  assert.equal(result.width, 4);
  assert.equal(result.height, 4);
});
