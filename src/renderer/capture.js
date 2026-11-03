'use strict';

const sel = document.getElementById('sel');
const hint = document.getElementById('hint');
const shot = document.getElementById('shot');

let start = null;
let rect = null;

if (shot && window.captureApi && window.captureApi.onImage) {
  let readySent = false;
  const signalReady = () => {
    if (readySent) return;
    readySent = true;
    window.captureApi.imageReady();
  };

  shot.addEventListener('load', signalReady, { once: true });
  shot.addEventListener('error', signalReady, { once: true });

  window.captureApi.onImage((url) => {
    shot.src = url;
    if (shot.complete && shot.naturalWidth) signalReady();
  });
}

function draw() {
  if (!rect) {
    sel.hidden = true;
    return;
  }

  const x = Math.min(rect.x1, rect.x2);
  const y = Math.min(rect.y1, rect.y2);
  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);

  sel.hidden = false;
  sel.style.left = `${x}px`;
  sel.style.top = `${y}px`;
  sel.style.width = `${width}px`;
  sel.style.height = `${height}px`;
}

function cancel() {
  if (window.captureApi) window.captureApi.cancel();
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) {
    cancel();
    return;
  }
  start = { x: event.clientX, y: event.clientY };
  rect = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
  hint.hidden = true;
  draw();
});

window.addEventListener('mousemove', (event) => {
  if (!start) return;
  rect.x2 = event.clientX;
  rect.y2 = event.clientY;
  draw();
});

window.addEventListener('mouseup', (event) => {
  if (!start) return;

  const x = Math.min(rect.x1, event.clientX);
  const y = Math.min(rect.y1, event.clientY);
  const width = Math.abs(event.clientX - rect.x1);
  const height = Math.abs(event.clientY - rect.y1);

  start = null;

  // Случайный клик без выделения — считаем отменой.
  if (width < 12 || height < 12) {
    cancel();
    return;
  }

  if (window.captureApi) {
    window.captureApi.select({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancel();
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  cancel();
});
