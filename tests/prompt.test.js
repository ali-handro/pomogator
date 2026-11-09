'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMessages } = require('../src/prompt');

test('промпт содержит вопрос и системные правила', () => {
  const messages = buildMessages({
    question: 'Что такое HashMap?',
    settings: { style: 'concise', language: 'ru', answerWords: 45 },
  });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /суфлёр/);
  assert.match(messages[0].content, /3 коротких пункта/);
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.equal(messages[messages.length - 1].content, 'Что такое HashMap?');
});

test('контекст, опыт и вакансия попадают в системное сообщение', () => {
  const messages = buildMessages({
    question: 'Как дела с Kafka?',
    settings: {
      style: 'technical',
      language: 'ru',
      contextPrompt: 'Собеседование Senior QA',
      resume: '5 лет автоматизации',
      job: 'Java QA',
    },
  });

  const system = messages[0].content;
  assert.match(system, /Собеседование Senior QA/);
  assert.match(system, /5 лет автоматизации/);
  assert.match(system, /Java QA/);
});

test('история ограничена последними четырьмя парами', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    question: `Вопрос ${index}`,
    answer: `Ответ ${index}`,
  }));

  const messages = buildMessages({
    question: 'Новый вопрос',
    settings: {},
    history,
  });

  const users = messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 5);
  assert.equal(users[0].content, 'Вопрос 2');
  assert.equal(users[users.length - 1].content, 'Новый вопрос');
});
