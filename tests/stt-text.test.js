'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sttText = require('../src/stt-text');

test('шум и титры отбрасываются', () => {
  assert.equal(sttText.isSttNoise('Редактор субтитров А.Силенко'), true);
  assert.equal(sttText.isSttNoise('suscríbete al canal'), true);
  assert.equal(sttText.isSttNoise('Расскажи про Docker'), false);
});

test('испанские галлюцинации отбрасываются', () => {
  assert.equal(sttText.isForeignText('Hola, ¿cómo estás?'), true);
  assert.equal(sttText.isForeignText('Gracias por ver el video, no olvides suscribirte'), true);
  assert.equal(sttText.isForeignText('este es un texto de prueba sobre la vida'), true);
});

test('английские технические вопросы не отбрасываются', () => {
  assert.equal(
    sttText.isForeignText('What is the difference between abstraction and encapsulation?'),
    false
  );
  assert.equal(sttText.isForeignText('Docker and Kubernetes in CI/CD'), false);
  assert.equal(sttText.isForeignText('Почему?'), false);
});

test('wordsOf нормализует слова', () => {
  assert.deepEqual(sttText.wordsOf('Hello, world! Java'), ['hell', 'worl', 'java']);
});

test('чтение ответа распознаётся по совпадению', () => {
  const shown = 'сегодня мы обсудим java коллекции и потоки';
  assert.equal(sttText.looksLikeReading('сегодня мы обсудим java коллекции', shown), true);
  assert.equal(sttText.looksLikeReading('расскажи про индексы в postgres', shown), false);
});
