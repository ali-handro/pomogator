'use strict';

/**
 * Глобальный хук колеса мыши.
 *
 * Оверлей почти всегда не в фокусе, а Windows отдаёт колесо активному окну.
 * Поэтому ловим его низкоуровневым хуком и листаем историю сами.
 */

const LOCK_MS = 140;

let started = false;
let lockUntil = 0;
let handler = null;

function startWheelHook({ isActive, onStep }) {
  if (started) return;

  try {
    const { uIOhook } = require('uiohook-napi');

    handler = (event) => {
      const rotation = Number(event && event.rotation) || 0;
      if (!rotation) return;
      if (!isActive()) return;

      const now = Date.now();
      if (now < lockUntil) return;

      lockUntil = now + LOCK_MS;
      onStep(rotation < 0 ? -1 : 1);
    };

    uIOhook.on('wheel', handler);
    uIOhook.start();
    started = true;
    console.log('[wheel] global hook started');
  } catch (err) {
    console.warn('[wheel] global hook unavailable:', err.message);
  }
}

function stopWheelHook() {
  if (!started) return;

  try {
    const { uIOhook } = require('uiohook-napi');
    if (handler) uIOhook.off('wheel', handler);
    uIOhook.stop();
  } catch {
    /* хук уже остановлен */
  }

  started = false;
  handler = null;
}

module.exports = { startWheelHook, stopWheelHook };
