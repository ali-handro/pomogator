(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SttText = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Whisper на тишине и шуме любит «додумывать» титры и подписи. Такие
     фразы не вопрос — не тратим на них модель. */
  const STT_NOISE = [
    'субтитр',
    'продолжение следует',
    'спасибо за просмотр',
    'подписывайтесь',
    'ставьте лайк',
    'amara.org',
    'dimatorzok',
    'редактор субтитров',
    'корректор',
    'продолжение в следующей',
    'subtítulos',
    'subtitulos',
    'gracias por ver',
    'suscríbete',
    'suscribete',
    'suscribirte',
    'dale like',
    'comparte el video',
    'no olvides suscribirte',
    'hasta la próxima',
    'hasta la proxima',
  ];

  function isSttNoise(text) {
    const low = String(text || '').toLowerCase();
    return STT_NOISE.some((fragment) => low.includes(fragment));
  }

  /**
   * Whisper на шуме иногда отвечает на другом языке — чаще всего испанским.
   * Отбрасываем только явно испанский текст: английские технические вопросы
   * и термины (Docker, Java, API) не трогаем.
   */
  function isForeignText(text) {
    const value = String(text || '').trim();
    if (value.length < 8) return false;

    const cyrillic = (value.match(/[а-яё]/gi) || []).length;
    if (cyrillic > 0) return false;

    const latin = (value.match(/[a-z]/gi) || []).length;
    if (!latin) return false;

    // Явные признаки испанского: перевёрнутые знаки и «ñ».
    if (/[¿¡ñ]/i.test(value)) return true;

    const spanish =
      /\b(el|la|los|las|del|que|una|es|por|con|para|como|pero|más|este|esta|esto|muy|también|porque|cuando|donde|hay|puede|todo|nada|gracias|hola|usted|ustedes|nosotros|ellos|ella|tiene|tienen|hacer|ahora|bien|mal|suscríbete|subtítulos)\b/gi;

    const hits = (value.match(spanish) || []).length;
    if (hits >= 3) return true;

    // Длинная фраза без единого русского слова и без английских
    // терминов-вопросов — почти наверняка галлюцинация.
    const englishQuestion =
      /\b(what|why|how|when|where|which|who|is|are|does|do|can|could|would|should|the|and|with|between)\b/gi;
    const englishHits = (value.match(englishQuestion) || []).length;

    return value.length > 40 && hits >= 2 && englishHits < 2;
  }

  function wordsOf(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .map((word) => word.slice(0, 4));
  }

  /**
   * Микрофон слышит и самого пользователя. Если распознанный текст почти
   * дословно совпадает с тем, что сейчас на экране, это чтение ответа, а не
   * новый вопрос — не запускаем по нему генерацию.
   */
  function looksLikeReading(text, shownText) {
    const spoken = wordsOf(text);
    if (spoken.length < 4) return false;

    const shown = wordsOf(shownText);
    if (shown.length < 4) return false;

    let best = 0;
    for (let i = 0; i < shown.length; i++) {
      for (let j = 0; j < spoken.length; j++) {
        let run = 0;
        while (
          i + run < shown.length &&
          j + run < spoken.length &&
          shown[i + run] === spoken[j + run]
        ) {
          run += 1;
        }
        if (run > best) best = run;
      }
    }

    return best >= 4;
  }

  return { STT_NOISE, isSttNoise, isForeignText, wordsOf, looksLikeReading };
});
