'use strict';

const { globalShortcut } = require('electron');

/** Стрелки над текстом ответа: перемотка истории. */
const ANSWER_KEYS = [
  ['Left', 'history-prev'],
  ['Right', 'history-next'],
  ['Down', 'history-latest'],
];

function createHotkeys({ getSettings, actions, onStatus }) {
  let status = { failed: [] };
  let answerKeysBound = false;

  const bind = (accelerator, handler, label, failed) => {
    if (!accelerator) return false;

    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) {
        failed.push({ accelerator, label });
        console.warn('[hotkey] busy:', accelerator);
        return false;
      }
      return true;
    } catch (err) {
      failed.push({ accelerator, label });
      console.warn('[hotkey] invalid:', accelerator, err.message);
      return false;
    }
  };

  /** Занимаем первую свободную комбинацию из списка и возвращаем её. */
  const bindFirst = (accelerators, handler, label, failed) => {
    for (const accelerator of accelerators) {
      if (accelerator && bind(accelerator, handler, label, failed)) return accelerator;
    }
    return null;
  };

  function setAnswerKeysBound(value) {
    if (value === answerKeysBound) return;
    answerKeysBound = value;

    for (const [accelerator, action] of ANSWER_KEYS) {
      try {
        if (value) globalShortcut.register(accelerator, () => actions.history(action));
        else globalShortcut.unregister(accelerator);
      } catch (err) {
        console.warn('[history-keys]', accelerator, err.message);
      }
    }
  }

  function register() {
    setAnswerKeysBound(false);
    globalShortcut.unregisterAll();

    const settings = getSettings();
    const keys = settings.hotkeys || {};
    const failed = [];

    bind(keys.toggle, actions.toggleOverlay, 'Показать / скрыть', failed);
    bind(keys.interactive, actions.toggleInteractive, 'Режим кликов', failed);
    bind(keys.answer, actions.answer, 'Ответить', failed);
    bind(keys.regenerate, actions.regenerate, 'Перегенерировать', failed);
    bind(keys.clear, actions.clear, 'Очистить', failed);
    bind(keys.listen, actions.listen, 'Пауза / слушать', failed);

    // Запасная комбинация — если выбранную заняла система.
    if (keys.listen !== 'Control+Shift+M') {
      bind('Control+Shift+M', actions.listen, 'Пауза / слушать (резерв)', failed);
    }

    bind(keys.settings, actions.createSettings, 'Настройки', failed);

    const capture = bindFirst(
      [keys.capture, 'Alt+C', 'Control+Shift+C'],
      actions.capture,
      'Скриншот задачи',
      failed
    );

    const review = bindFirst(
      [keys.review, 'Alt+R', 'Control+Alt+R', 'Control+Shift+Alt+R'],
      actions.review,
      'Код-ревью по скриншоту',
      failed
    );

    // Перемотка ответов работает всегда, независимо от положения курсора.
    bind(
      keys.historyPrev || 'Control+Shift+Left',
      () => actions.history('history-prev'),
      'Прошлый ответ',
      failed
    );
    bind(
      keys.historyNext || 'Control+Shift+Right',
      () => actions.history('history-next'),
      'Следующий ответ',
      failed
    );
    bind(
      keys.historyLatest || 'Control+Shift+Down',
      () => actions.history('history-latest'),
      'К актуальному ответу',
      failed
    );

    status = { failed, listen: keys.listen, capture, review };
    if (onStatus) onStatus(status);
  }

  return {
    register,
    setAnswerKeysBound,
    getStatus: () => status,
  };
}

module.exports = { createHotkeys, ANSWER_KEYS };
