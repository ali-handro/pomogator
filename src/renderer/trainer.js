'use strict';

const $ = (id) => document.getElementById(id);

const QUESTION_SECONDS = 120;

const state = {
  category: null,
  order: [],
  index: 0,
  timer: null,
  left: QUESTION_SECONDS,
};

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function renderTimer() {
  const minutes = Math.floor(state.left / 60);
  const seconds = state.left % 60;
  const timer = $('timer');
  timer.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  timer.classList.toggle('low', state.left > 0 && state.left <= 30);
  timer.classList.toggle('done', state.left === 0);
}

function startTimer() {
  clearInterval(state.timer);
  state.left = QUESTION_SECONDS;
  renderTimer();
  $('btnStart').textContent = 'Заново';

  state.timer = setInterval(() => {
    state.left -= 1;
    if (state.left <= 0) {
      state.left = 0;
      clearInterval(state.timer);
      $('btnStart').textContent = 'Старт';
    }
    renderTimer();
  }, 1000);
}

/** Таймер сбрасывается, но не идёт: отсчёт начинается по кнопке «Старт». */
function resetTimer() {
  clearInterval(state.timer);
  state.left = QUESTION_SECONDS;
  renderTimer();
  $('btnStart').textContent = 'Старт';
}

function showQuestion() {
  const category = state.category;
  if (!category) return;

  if (state.index >= state.order.length) {
    state.order = shuffle(category.questions.map((_, i) => i));
    state.index = 0;
  }

  const item = category.questions[state.order[state.index]];

  $('question').textContent = item.q;
  $('qnum').textContent = `Вопрос ${state.index + 1}`;
  $('progress').textContent = `Вопрос ${state.index + 1} из ${category.questions.length}`;

  const hints = $('hints');
  hints.innerHTML = '';
  for (const hint of item.hints) {
    const li = document.createElement('li');
    li.textContent = hint;
    hints.appendChild(li);
  }
  hints.hidden = true;
  $('btnHints').textContent = 'Показать опорные пункты';

  resetTimer();
}

function loadCategory(id) {
  const category =
    (window.TRAINER_CATEGORIES || []).find((item) => item.id === id) ||
    (window.TRAINER_CATEGORIES || [])[0];

  if (!category) return;

  state.category = category;
  state.order = shuffle(category.questions.map((_, i) => i));
  state.index = 0;
  showQuestion();
}

function boot() {
  const select = $('category');
  for (const category of window.TRAINER_CATEGORIES || []) {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.label;
    select.appendChild(option);
  }

  select.addEventListener('change', () => loadCategory(select.value));

  $('btnStart').addEventListener('click', startTimer);

  $('btnNext').addEventListener('click', () => {
    state.index += 1;
    showQuestion();
  });

  $('btnHints').addEventListener('click', () => {
    const hints = $('hints');
    hints.hidden = !hints.hidden;
    $('btnHints').textContent = hints.hidden
      ? 'Показать опорные пункты'
      : 'Скрыть опорные пункты';
  });

  $('btnClose').addEventListener('click', () => window.close());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
    if (event.key === 'ArrowRight') {
      state.index += 1;
      showQuestion();
    }
  });

  loadCategory(select.value);
}

window.addEventListener('DOMContentLoaded', boot);
