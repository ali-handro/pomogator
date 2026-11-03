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

function createScreenshotService({
  getSettings,
  sendToOverlay,
  streamChat,
  providerConfig,
  visionModel,
  cloudChat,
}) {
  let captureWin = null;
  let captureShot = null;
  let captureScale = 1;
  let captureResolve = null;
  let pendingRect = null;
  let warming = null;
  let lastWarmAt = 0;

  /**
   * Первый захват экрана в сеансе занимает 2+ секунды: Windows поднимает
   * композитор. Греем его заранее, чтобы окно выделения появлялось сразу.
   */
  async function warmUp() {
    if (warming) return warming;

    const now = Date.now();
    if (now - lastWarmAt < 8000) return undefined;
    lastWarmAt = now;

    warming = desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => undefined)
      .finally(() => {
        warming = null;
      });

    return warming;
  }

  function finishCapture(result) {
    const resolve = captureResolve;
    captureResolve = null;
    pendingRect = null;

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

    const selection = new Promise((resolve) => {
      captureResolve = resolve;
    });

    // Окно выделения показываем сразу, а снимок делаем параллельно. Окно
    // защищено от захвата, поэтому в кадр не попадает.
    const win = new BrowserWindow({
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

    captureWin = win;
    try {
      win.setContentProtection(true);
    } catch {
      /* защита недоступна */
    }
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'capture.html'));

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });

    win.on('closed', () => {
      if (captureWin !== win) return;
      captureWin = null;
      captureShot = null;
      pendingRect = null;
      const pending = captureResolve;
      captureResolve = null;
      if (pending) pending({ ok: false, cancelled: true });
    });

    desktopCapturer
      .getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.size.width * scale),
          height: Math.round(display.size.height * scale),
        },
      })
      .then((sources) => {
        if (captureWin !== win) return;

        const source =
          sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
        if (!source || source.thumbnail.isEmpty()) {
          finishCapture({ ok: false, cancelled: true });
          return;
        }

        captureShot = source.thumbnail;
        captureScale = scale;

        if (pendingRect) {
          const rect = pendingRect;
          pendingRect = null;
          applySelection(rect);
        }
      })
      .catch(() => {
        if (captureWin === win) finishCapture({ ok: false, cancelled: true });
      });

    return selection;
  }

  function applySelection(rect) {
    const base64 = rect ? cropSelection(rect) : null;
    finishCapture(base64 ? { ok: true, base64 } : { ok: false, cancelled: true });
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

    const jpeg = image.toJPEG(88);
    if (process.env.POMOGATOR_DEBUG_CAPTURE) {
      try {
        require('fs').writeFileSync(process.env.POMOGATOR_DEBUG_CAPTURE, jpeg);
      } catch {
        /* отладка не критична */
      }
    }

    return jpeg.toString('base64');
  }

  async function solve(base64, controller, mode) {
    const settings = getSettings();
    const ai = settings.ai || {};
    const baseUrl = String(ai.baseUrl || '').trim();
    const accountId = String(ai.accountId || '').trim();
    const model = String(ai.model || '').trim();
    const apiKey = (settings.keys && settings.keys.ai) || '';
    const variant = VISION_MODES[mode] || VISION_MODES.solve;

    const messages = [
      { role: 'system', content: variant.prompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: variant.ask },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ];

    // Облако Помогатора: скриншот уходит на наш сервер, ключи не нужны.
    if (cloudChat) {
      try {
        const text = await cloudChat(messages, 900);
        if (text != null) {
          if (text) sendToOverlay('llm:delta', text);
          return;
        }
      } catch (err) {
        console.warn('[vision] облако не ответило:', err.message);
      }
    }

    if (!baseUrl) throw new Error('Не указан адрес API модели');
    if (!model) throw new Error('Не указана модель');

    await streamChat({
      providerId: 'custom',
      baseUrl,
      accountId,
      apiKey,
      model,
      messages,
      maxTokens: 900,
      temperature: 0.2,
      signal: controller.signal,
      onDelta: (text) => sendToOverlay('llm:delta', text),
    });
  }

  /** Показывает выделение области и решает задачу/делает ревью. */
  async function captureAndSolve(controller, mode, onCaptured) {
    const shot = await captureArea();
    if (!shot.ok) return { ok: false, cancelled: true };

    // Снимок уже сделан — оверлей можно вернуть, не дожидаясь ответа модели.
    if (onCaptured) {
      try {
        onCaptured();
      } catch {
        /* оверлей уже закрыт */
      }
    }

    await solve(shot.base64, controller, mode);
    return { ok: true };
  }

  return {
    captureAndSolve,
    warmUp,
    select: (rect) => {
      if (!rect) {
        finishCapture({ ok: false, cancelled: true });
        return;
      }

      // Снимок может быть ещё не готов — досчитаем, когда он появится.
      if (!captureShot) {
        pendingRect = rect;
        return;
      }

      applySelection(rect);
    },
    cancel: () => finishCapture({ ok: false, cancelled: true }),
    isOpen: () => !!captureWin,
  };
}

module.exports = { createScreenshotService, VISION_MODES };
