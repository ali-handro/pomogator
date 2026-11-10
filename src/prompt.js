'use strict';

const STYLES = {
  concise: '3 коротких пункта, каждый не длиннее 12 слов, каждый с новой строки.',
  star: '3 блока с новой строки: ситуация → действие → результат. Всего не больше 45 слов.',
  technical:
    '3 пункта с новой строки, с конкретными технологиями, цифрами и архитектурными решениями. До 60 слов.',
};

const LANGUAGES = {
  ru: 'русский',
  en: 'английский',
  auto: 'тот же, на котором задан вопрос',
};

function buildMessages({ question, settings, history = [] }) {
  const style = STYLES[settings.style] || STYLES.concise;
  const language = LANGUAGES[settings.language] || LANGUAGES.ru;
  const resume = (settings.resume || '').trim();
  const job = (settings.job || '').trim();
  const context = (settings.contextPrompt || '').trim().slice(0, 4000);
  const terms = (settings.terms || '').trim().slice(0, 1000);
  const words = Number(settings.answerWords) || 45;

  const system = [
    'Ты — суфлёр: подсказываешь, что ответить на заданный вопрос.',
    'Отвечай от первого лица, как будто это говорит сам пользователь.',
    'Пиши только то, что можно сразу произнести вслух: без markdown, заголовков, тире и пояснений.',
    'Пункты нумеруй «1.», «2.», «3.», каждый с новой строки.',
    `Структура ответа: ${style}`,
    `Объём: около ${words} слов.`,
    `Язык ответа: ${language}.`,
    'Не выдумывай факты, которых нет в контексте. Если опыта действительно нет — скажи это честно и предложи достойную формулировку.',
    'Не пересказывай вопрос и не начинай с «Отличный вопрос».',
    context ? `Контекст разговора:\n${context}` : '',
    context
      ? 'Если в вопросе есть слово, которое явно распознано с ошибкой, восстанови его по контексту разговора и ответь на предполагаемый вопрос, не переспрашивая.'
      : '',
    resume ? `Опыт пользователя:\n${resume}` : '',
    job ? `Контекст и требования:\n${job}` : '',
    terms ? `Термины и названия, которые важно знать:\n${terms}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [{ role: 'system', content: system }];

  for (const turn of history.slice(-4)) {
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: turn.answer });
  }

  messages.push({ role: 'user', content: question });
  return messages;
}

module.exports = { buildMessages, STYLES, LANGUAGES };
