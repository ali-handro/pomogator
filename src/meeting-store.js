'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

const SUMMARY_SYSTEM = [
  'Ты делаешь выжимку деловой встречи по транскрипту.',
  'Пиши по-русски, кратко, без воды и без markdown.',
  'Структура строго такая:',
  '1. О чём встреча — 1–2 предложения.',
  '2. Договорённости — списком, каждая с новой строки.',
  '3. Решения — списком.',
  '4. Задачи — кто и что делает, если названо; иначе просто задача.',
  '5. Открытые вопросы и риски — списком.',
  'Если чего-то на встрече не было — так и напиши: «не обсуждалось».',
].join('\n');

const SUMMARY_PART = [
  'Сделай короткую выжимку фрагмента встречи: о чём говорили, что решили,',
  'какие задачи и вопросы прозвучали. 3–6 пунктов, без воды, по-русски.',
].join(' ');

function stampOf(timestamp) {
  return new Date(timestamp).toLocaleString('sv-SE').replace(/[: ]/g, '-');
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(Math.floor(safe % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

function createMeetingStore({ getSettings, streamChat, providerConfig }) {
  function save(payload) {
    try {
      const dir = path.join(app.getPath('userData'), 'meetings');
      fs.mkdirSync(dir, { recursive: true });

      const startedAt = Number(payload && payload.startedAt) || Date.now();
      const file = path.join(dir, `${stampOf(startedAt)}.json`);

      const data = {
        startedAt,
        endedAt: Date.now(),
        duration: Number(payload && payload.duration) || 0,
        summary: String((payload && payload.summary) || ''),
        entries: Array.isArray(payload && payload.entries) ? payload.entries : [],
      };

      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function summarize(payload) {
    const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
    if (!entries.length) return { ok: false, error: 'Пустой транскрипт' };

    const settings = getSettings();
    const providerId = settings.provider || 'cloudflare';
    const provider = providerConfig(providerId);
    const apiKey = provider.noKey ? '' : (settings.keys && settings.keys[providerId]) || '';

    if (!provider.noKey && !apiKey) return { ok: false, error: 'Нет ключа для модели' };
    if (provider.needsAccount && !settings.cloudflareAccount) {
      return { ok: false, error: 'Не указан Account ID Cloudflare' };
    }

    const transcript = entries
      .map((entry) => `${formatTime(entry.t)} ${entry.speaker}: ${entry.text}`)
      .join('\n');

    const ask = async (messages, maxTokens, signal) => {
      let out = '';
      await streamChat({
        providerId,
        apiKey,
        accountId: settings.cloudflareAccount || '',
        model: settings.model,
        messages,
        maxTokens,
        temperature: 0.2,
        signal,
        onDelta: (text) => {
          out += text;
        },
      });
      return out.trim();
    };

    const signal = AbortSignal.timeout(120000);

    try {
      let summary = '';

      if (transcript.length > 14000) {
        const chunks = [];
        let current = '';

        for (const row of transcript.split('\n')) {
          if ((current + row).length > 10000) {
            if (current) chunks.push(current);
            current = row;
          } else {
            current += `${row}\n`;
          }
        }
        if (current.trim()) chunks.push(current);

        const parts = [];
        for (const chunk of chunks) {
          parts.push(
            await ask(
              [
                { role: 'system', content: SUMMARY_PART },
                { role: 'user', content: chunk },
              ],
              400,
              signal
            )
          );
        }

        summary = await ask(
          [
            { role: 'system', content: SUMMARY_SYSTEM },
            {
              role: 'user',
              content: parts.map((part, index) => `Часть ${index + 1}:\n${part}`).join('\n\n'),
            },
          ],
          700,
          signal
        );
      } else {
        summary = await ask(
          [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: transcript },
          ],
          700,
          signal
        );
      }

      if (!summary) return { ok: false, error: 'Модель не вернула выжимку' };
      return { ok: true, summary };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return { ok: false, error: 'Модель не ответила вовремя' };
      }
      return { ok: false, error: err.message };
    }
  }

  async function exportMarkdown(payload) {
    const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
    if (!entries.length) return { ok: false, error: 'Нечего экспортировать' };

    const startedAt = Number(payload && payload.startedAt) || Date.now();

    const result = await dialog.showSaveDialog({
      title: 'Экспорт расшифровки',
      defaultPath: path.join(app.getPath('documents'), `meeting-${stampOf(startedAt)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

    const lines = [
      `# Встреча ${new Date(startedAt).toLocaleString('ru-RU')}`,
      '',
      `Длительность: ${Math.round((Number(payload && payload.duration) || 0) / 60)} мин`,
      '',
    ];

    const summary = String((payload && payload.summary) || '').trim();
    if (summary) lines.push('## Выжимка', '', summary, '');

    lines.push('## Расшифровка', '');

    for (const entry of entries) {
      lines.push(`**${formatTime(entry.t)} · ${entry.speaker}:** ${entry.text}`);
      lines.push('');
    }

    try {
      fs.writeFileSync(result.filePath, lines.join('\n'), 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { save, summarize, exportMarkdown };
}

module.exports = { createMeetingStore };
