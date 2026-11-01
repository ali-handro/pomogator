'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  category: null,
  order: [],
  index: 0,
  correct: 0,
  answered: false,
};

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Большие банки QA и Java подключаются отдельными файлами. */
function getCategories() {
  const base = (window.QUIZ_CATEGORIES || []).filter(
    (item) => item.id !== 'qa' && item.id !== 'java'
  );

  const big = [];
  if (window.QUIZ_QA) big.push({ id: 'qa', label: 'Тестировщик (QA)', questions: window.QUIZ_QA });
  if (window.QUIZ_JAVA) big.push({ id: 'java', label: 'Java', questions: window.QUIZ_JAVA });

  return [...big, ...base];
}

function loadCategory(id) {
  const categories = getCategories();
  const category = categories.find((item) => item.id === id) || categories[0];
  if (!category) return;

  state.category = category;
  state.order = shuffle(category.questions.map((_, i) => i));
  state.index = 0;
  state.correct = 0;

  $('result').hidden = true;
  $('card').hidden = false;
  showQuestion();
}

function showQuestion() {
  const category = state.category;
  if (state.index >= state.order.length) {
    finish();
    return;
  }

  const item = category.questions[state.order[state.index]];
  state.answered = false;

  $('qnum').textContent = `Вопрос ${state.index + 1}`;
  $('question').textContent = item.q;
  $('progress').textContent = `Вопрос ${state.index + 1} из ${category.questions.length}`;
  $('score').textContent = `Верно: ${state.correct}`;
  $('barFill').style.width = `${Math.round((state.index / category.questions.length) * 100)}%`;

  const options = $('options');
  options.innerHTML = '';

  // Перемешиваем варианты, чтобы верный не стоял всегда первым.
  state.current = shuffle(
    item.options.map((text, index) => ({ text, correct: index === item.correct }))
  );

  state.current.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.textContent = option.text;
    button.addEventListener('click', () => choose(index));
    options.appendChild(button);
  });

  const explain = $('explain');
  explain.hidden = true;
  explain.textContent = '';

  const next = $('btnNext');
  next.hidden = true;
  next.textContent =
    state.index + 1 >= state.order.length ? 'Показать результат' : 'Следующий вопрос';
}

function choose(index) {
  if (state.answered) return;
  state.answered = true;

  const item = state.category.questions[state.order[state.index]];
  const buttons = Array.from($('options').children);
  const correctIndex = state.current.findIndex((option) => option.correct);

  buttons.forEach((button, i) => {
    button.disabled = true;
    if (i === correctIndex) button.classList.add('correct');
    else if (i === index) button.classList.add('wrong');
  });

  if (index === correctIndex) state.correct += 1;

  $('score').textContent = `Верно: ${state.correct}`;

  const explain = $('explain');
  explain.textContent = item.explain;
  explain.hidden = false;

  $('btnNext').hidden = false;
}

function next() {
  state.index += 1;
  showQuestion();
}

function finish() {
  const total = state.category.questions.length;
  const percent = total ? Math.round((state.correct / total) * 100) : 0;

  $('barFill').style.width = '100%';
  $('card').hidden = true;
  $('result').hidden = false;
  $('resultTitle').textContent = `Верно ${state.correct} из ${total}`;

  let text = 'Стоит повторить тему — разберите вопросы, где ошиблись.';
  if (percent >= 80) text = 'Отличный результат — тема закрыта, можно идти дальше.';
  else if (percent >= 50) text = 'Неплохо: половина и больше верно, но есть что подтянуть.';

  $('resultText').textContent = `${text} Точность: ${percent}%.`;
}

function boot() {
  const select = $('category');
  for (const category of getCategories()) {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.label;
    select.appendChild(option);
  }

  select.addEventListener('change', () => loadCategory(select.value));
  $('btnNext').addEventListener('click', next);
  $('btnRestart').addEventListener('click', () => loadCategory(select.value));
  $('btnClose').addEventListener('click', () => window.close());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  loadCategory(select.value);
}

window.addEventListener('DOMContentLoaded', boot);
