'use strict';

const path = require('path');
const { BrowserWindow, screen, desktopCapturer } = require('electron');

const VISION_MODES = {
  solve: {
    prompt: [
      'Ты — помощник на техническом собеседовании.',
      'На скриншоте условие задачи и, возможно, уже начатый код.',
      'Сначала одной строкой скажи, что требуется.',
      'Затем дай рабочее решение с отступами.',
      'В конце одной строкой укажи сложность.',
      'Не используй markdown, заголовки и обратные кавычки.',
      'Пиши по-русски, кратко, без воды.',
    ].join('\n'),
    ask: 'Реши задачу со скриншота.',
  },
  review: {
    prompt: [
      'Ты — опытный ревьюер на техническом собеседовании.',
      'На скриншоте чужой код, который просят разобрать.',
      'Дай 3–5 замечаний, каждое с новой строки: что не так и как исправить.',
      'Смотри на баги, edge-cases, производительность и читаемость.',
      'Где можешь — назови функцию или строку, к которой относится замечание.',
      'В конце одной строкой — общий вердикт: можно ли принимать код.',
      'Не используй markdown, заголовки и обратные кавычки. По-русски, кратко.',
    ].join('\n'),
    ask: 'Сделай код-ревью по скриншоту.',
  },
};

function createScreenshotService({ getSettings, sendToOverlay, streamChat, providerConfig, visionModel }) {
  let captureWin = null;
  let captureShot = null;
  let captureScale = 1;
  let captureResolve = null;

  function finishCapture(result) {
    const resolve = captureResolve;
    captureResolve = null;

    if (captureWin && !captureWin.isDestroyed()) captureWin.close();
    captureWin = null;
    captureShot = null;

    if (resolve) resolve(result);
  }

  /**
   * Снимаем экран ДО показа окна выделения, поэтому рамка не попадает
   * в картинку. Координаты выделения пересчитываем в пиксели снимка.
   */
  async function captureArea() {
    if (captureWin) return { ok: false, cancelled: true };

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });

    const source =
      sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return { ok: false, cancelled: true };

    captureShot = source.thumbnail;
    captureScale = scale;

    return new Promise((resolve) => {
      captureResolve = resolve;

      captureWin = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'capture-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      captureWin.setAlwaysOnTop(true, 'screen-saver');
      captureWin.setMenuBarVisibility(false);
      captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));

      captureWin.once('ready-to-show', () => {
        if (!captureWin || captureWin.isDestroyed()) return;
        captureWin.show();
        captureWin.focus();
      });

      captureWin.on('closed', () => {
        captureWin = null;
        const pending = captureResolve;
        captureResolve = null;
        captureShot = null;
        if (pending) pending({ ok: false, cancelled: true });
      });
    });
  }

  function cropSelection(rect) {
    if (!captureShot) return null;

    const scale = captureScale || 1;
    const size = captureShot.getSize();
    const x = Math.max(0, Math.round(rect.x * scale));
    const y = Math.max(0, Math.round(rect.y * scale));
    const width = Math.min(size.width - x, Math.round(rect.width * scale));
    const height = Math.min(size.height - y, Math.round(rect.height * scale));

    if (width < 8 || height < 8) return null;

    let image = captureShot.crop({ x, y, width, height });
    // Больше 1600 px по ширине vision-модели всё равно ужимают.
    if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: 'good' });
    return image.toJPEG(88).toString('base64');
  }

  async function solve(base64, controller, mode) {
    const settings = getSettings();
    const providerId = settings.provider || 'cloudflare';
    const provider = providerConfig(providerId);
    const apiKey = provider.noKey ? '' : (settings.keys && settings.keys[providerId]) || '';
    const model = visionModel(providerId, settings.model);
    const variant = VISION_MODES[mode] || VISION_MODES.solve;

    if (!provider.noKey && !apiKey) throw new Error('Нет ключа для модели');
    if (provider.needsAccount && !settings.cloudflareAccount) {
      throw new Error('Не указан Account ID Cloudflare');
    }

    await streamChat({
      providerId,
      apiKey,
      accountId: settings.cloudflareAccount || '',
      model,
      messages: [
        { role: 'system', content: variant.prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: variant.ask },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          ],
        },
      ],
      maxTokens: 900,
      temperature: 0.2,
      signal: controller.signal,
      onDelta: (text) => sendToOverlay('llm:delta', text),
    });
  }

  /** Показывает выделение области и решает задачу/делает ревью. */
  async function captureAndSolve(controller, mode) {
    const shot = await captureArea();
    if (!shot.ok) return { ok: false, cancelled: true };

    await solve(shot.base64, controller, mode);
    return { ok: true };
  }

  return {
    captureAndSolve,
    select: (rect) => {
      const base64 = rect ? cropSelection(rect) : null;
      finishCapture(base64 ? { ok: true, base64 } : { ok: false, cancelled: true });
    },
    cancel: () => finishCapture({ ok: false, cancelled: true }),
    isOpen: () => !!captureWin,
  };
}

module.exports = { createScreenshotService, VISION_MODES };
