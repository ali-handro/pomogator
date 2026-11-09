'use strict';

const os = require('os');
const { app, screen } = require('electron');
const logs = require('./log-buffer');

function yes(value) {
  return value ? 'да' : 'нет';
}

function collect({ settings, localStt, hotkeys }) {
  const ai = settings.ai || {};
  const stt = settings.stt || {};
  const keys = settings.keys || {};
  const displays = screen.getAllDisplays().map((display, index) => {
    const size = `${display.size.width}x${display.size.height}`;
    return `  ${index + 1}. ${size} @${display.scaleFactor}x` +
      `${display.id === screen.getPrimaryDisplay().id ? ' (основной)' : ''}`;
  });

  const local = localStt ? localStt.status(settings) : null;
  const hotkeyStatus = hotkeys ? hotkeys.getStatus() : null;

  const lines = [
    `Помогатор: ${app.getVersion()}`,
    `Windows: ${os.type()} ${os.release()} (${os.arch()})`,
    `Electron: ${process.versions.electron}, Chrome: ${process.versions.chrome}, Node: ${process.versions.node}`,
    `Память: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} ГБ`,
    'Экраны:',
    ...displays,
    '',
    `Модель: ${ai.baseUrl || 'не задан'}`,
    `  модель: ${ai.model || 'не задана'}, ключ: ${yes(keys.ai)}`,
    `Распознавание: режим=${stt.mode || 'api'}, формат=${stt.format || 'openai'}`,
    `  адрес: ${stt.baseUrl || 'не задан'}`,
    `  модель: ${stt.model || 'не задана'}, язык: ${stt.language || 'ru'}, ключ: ${yes(keys.stt)}`,
    `Звук: ${settings.audioSource === 'system' ? 'система' : 'микрофон'}, пауза ${settings.silenceMs || 450} мс`,
    `Оверлей: ${settings.overlayWidth || 980}x${settings.overlayHeight || 232}, экран ${settings.overlayDisplay || 0}, сквозные клики: ${yes(settings.clickThrough)}`,
    `Автоответ: ${settings.autoAnswer === false ? 'выключен' : 'включён'}`,
  ];

  if (local) {
    lines.push(
      `Локально: движок ${yes(local.engine)}, модель ${local.modelSize} ${yes(local.model)}, запущен: ${yes(local.running)}`
    );
  }

  if (hotkeyStatus && hotkeyStatus.failed && hotkeyStatus.failed.length) {
    lines.push(
      `Занятые горячие клавиши: ${hotkeyStatus.failed
        .map((item) => item.accelerator)
        .join(', ')}`
    );
  }

  lines.push('', '--- последние сообщения ---', ...logs.get());

  return lines.join('\n');
}

module.exports = { collect };
