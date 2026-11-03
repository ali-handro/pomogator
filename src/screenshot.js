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
  let captureWins = [];
  let captureShots = new Map();
  let captureDisplayBySender = new Map();
  let captureResolve = null;
  let pendingRect = null;
  let captureRevealed = false;
  let warming = null;
  let lastWarmAt = 0;

  /**
   * Первый захват экрана в сеансе занимает 2+ секунды: Windows поднимает
   * композитор. Греем его заранее, чтобы окно выделения появлялось сразу.
   */
  async function warmUp() {
    if (warming) return warming;

    const now = Date.now();
    if (now - lastWarmAt < 12000) return undefined;
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

    for (const win of captureWins) {
      if (!win.isDestroyed()) win.close();
    }

    captureWins = [];
    captureShots = new Map();
    captureDisplayBySender = new Map();
    captureRevealed = false;

    if (resolve) resolve(result);
  }

  /**
   * Выделение показываем на всех экранах сразу. Снимок делается до показа
   * окон: иначе видео в аппаратном оверлее (YouTube, плееры) сереет.
   */
  async function captureArea() {
    if (captureWins.length) return { ok: false, cancelled: true };

    const displays = screen.getAllDisplays();
    if (!displays.length) return { ok: false, cancelled: true };

    const selection = new Promise((resolve) => {
      captureResolve = resolve;
    });

    captureRevealed = false;
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    for (const display of displays) {
      captureWins.push(createCaptureWindow(display, cursorDisplay));
    }

    const maxWidth = Math.max(
      ...displays.map((d) => Math.round(d.size.width * (d.scaleFactor || 1)))
    );
    const maxHeight = Math.max(
      ...displays.map((d) => Math.round(d.size.height * (d.scaleFactor || 1)))
    );

    desktopCapturer
      .getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight },
      })
      .then((sources) => {
        if (!captureResolve) return;

        const shots = new Map();

        for (const display of displays) {
          const source = sources.find(
            (item) => String(item.display_id) === String(display.id)
          );
          if (!source || source.thumbnail.isEmpty()) continue;

          const size = source.thumbnail.getSize();
          shots.set(String(display.id), {
            image: source.thumbnail,
            scaleX: size.width / display.bounds.width,
            scaleY: size.height / display.bounds.height,
          });
        }

        if (!shots.size) {
          finishCapture({ ok: false, cancelled: true });
          return;
        }

        captureShots = shots;
        revealCaptureWindows();

        if (pendingRect) {
          const rect = pendingRect;
          pendingRect = null;
          applySelection(rect);
        }
      })
      .catch(() => {
        if (captureResolve) finishCapture({ ok: false, cancelled: true });
      });

    return selection;
  }

  function revealCaptureWindow(win) {
    if (win.isDestroyed() || win.isVisible()) return;

    if (win.__focus) {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
  }

  function revealCaptureWindows() {
    captureRevealed = true;
    for (const win of captureWins) {
      if (win.__ready) revealCaptureWindow(win);
    }
  }

  function createCaptureWindow(display, cursorDisplay) {
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
        backgroundThrottling: false,
      },
    });

    captureDisplayBySender.set(win.webContents.id, String(display.id));
    const senderId = win.webContents.id;

    try {
      win.setContentProtection(true);
    } catch {
      /* защита недоступна */
    }

    win.__focus = String(display.id) === String(cursorDisplay.id);
    win.__ready = false;

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'capture.html'));

    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;

      win.__ready = true;

      // Пока не сделан снимок, окно не показываем: иначе аппаратный
      // оверлей видео (YouTube) попадает в кадр серым прямоугольником.
      if (captureRevealed) revealCaptureWindow(win);
    });

    win.on('closed', () => {
      captureDisplayBySender.delete(senderId);
      captureWins = captureWins.filter((item) => item !== win);

      // Закрыли окно выделения (Esc) — отменяем весь захват.
      if (captureResolve) finishCapture({ ok: false, cancelled: true });
    });

    return win;
  }

  function applySelection(rect) {
    const base64 = rect ? cropSelection(rect) : null;
    finishCapture(base64 ? { ok: true, base64 } : { ok: false, cancelled: true });
  }

  function cropSelection(rect) {
    if (!captureShots.size) return null;

    const displayId = String((rect && rect.displayId) || '');
    const shot =
      captureShots.get(displayId) ||
      (displayId ? null : captureShots.values().next().value);
    if (!shot) return null;

    const size = shot.image.getSize();
    const x = Math.max(0, Math.round(rect.x * shot.scaleX));
    const y = Math.max(0, Math.round(rect.y * shot.scaleY));
    const width = Math.min(size.width - x, Math.round(rect.width * shot.scaleX));
    const height = Math.min(size.height - y, Math.round(rect.height * shot.scaleY));

    if (width < 8 || height < 8) return null;

    let image = shot.image.crop({ x, y, width, height });
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
    displayFor: (webContentsId) => captureDisplayBySender.get(webContentsId) || '',
    select: (rect) => {
      if (!rect) {
        finishCapture({ ok: false, cancelled: true });
        return;
      }

      // Снимок может быть ещё не готов — досчитаем, когда он появится.
      if (!captureShots.size) {
        pendingRect = rect;
        return;
      }

      applySelection(rect);
    },
    cancel: () => finishCapture({ ok: false, cancelled: true }),
    isOpen: () => captureWins.length > 0,
  };
}

module.exports = { createScreenshotService, VISION_MODES };
