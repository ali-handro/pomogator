'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProfiles,
  profileFields,
  syncFieldsFromProfile,
} = require('../src/profiles');

test('старые поля контекста становятся первым профилем', () => {
  const settings = {
    contextPrompt: 'Собеседование QA',
    terms: 'Kafka, Cucumber',
    resume: '6 лет опыта',
    job: 'Требования вакансии',
  };

  const changed = normalizeProfiles(settings, false);
  syncFieldsFromProfile(settings);

  assert.equal(changed, true);
  assert.equal(settings.profiles.length, 2);
  assert.equal(settings.activeProfile, 'profile-1');
  assert.equal(settings.profiles[0].name, 'Профиль 1');
  assert.equal(settings.profiles[0].contextPrompt, 'Собеседование QA');
  assert.equal(settings.profiles[0].terms, 'Kafka, Cucumber');
  assert.equal(settings.profiles[1].contextPrompt, '');
  assert.equal(settings.contextPrompt, 'Собеседование QA');
});

test('поля берутся из активного профиля', () => {
  const settings = {
    activeProfile: 'work',
    contextPrompt: 'старое значение',
    profiles: [
      {
        id: 'home',
        name: 'Профиль 1',
        contextPrompt: 'Домашний контекст',
        terms: 'React',
        resume: 'Frontend',
        job: 'Вакансия frontend',
      },
      {
        id: 'work',
        name: 'Профиль 2',
        contextPrompt: 'Рабочий контекст',
        terms: 'Kafka',
        resume: 'QA',
        job: 'Вакансия QA',
      },
    ],
  };

  assert.deepEqual(profileFields(settings), {
    contextPrompt: 'Рабочий контекст',
    terms: 'Kafka',
    resume: 'QA',
    job: 'Вакансия QA',
  });
});

test('несуществующий активный профиль заменяется первым', () => {
  const settings = {
    activeProfile: 'missing',
    profiles: [{ id: 'first', name: '', contextPrompt: 'Текст' }],
  };

  normalizeProfiles(settings, true);

  assert.equal(settings.activeProfile, 'first');
  assert.equal(settings.profiles[0].name, 'Профиль 1');
  assert.equal(settings.profiles[0].contextPrompt, 'Текст');
  assert.equal(settings.profiles[0].terms, '');
});
