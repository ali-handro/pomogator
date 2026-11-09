'use strict';

/**
 * Пересчитывает выделение в пиксели снимка. Координаты выделения заданы
 * в CSS-пикселях окна, снимок может быть в другом масштабе.
 */
function cropRect(rect, imageSize, scaleX, scaleY) {
  const sx = Number(scaleX) > 0 ? Number(scaleX) : 1;
  const sy = Number(scaleY) > 0 ? Number(scaleY) : 1;

  const x = Math.max(0, Math.round(Number(rect.x || 0) * sx));
  const y = Math.max(0, Math.round(Number(rect.y || 0) * sy));
  const width = Math.min(
    Math.max(0, imageSize.width - x),
    Math.round(Number(rect.width || 0) * sx)
  );
  const height = Math.min(
    Math.max(0, imageSize.height - y),
    Math.round(Number(rect.height || 0) * sy)
  );

  return { x, y, width, height };
}

module.exports = { cropRect };
