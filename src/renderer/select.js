'use strict';

/**
 * Свои выпадающие списки для всех окон.
 *
 * Нативные <select> на Windows выглядят полупрозрачно и наезжают на поля.
 * Здесь вместо них — кнопка и плотное меню с отступами.
 *
 * Подключать до скрипта окна. После заполнения <select> опциями вызвать
 * enhanceSelects(). После программного изменения значения — syncAllSelects().
 */

const selectBindings = new WeakMap();

function syncSelect(select) {
  const binding = selectBindings.get(select);
  if (!binding) return;

  const option = select.options[select.selectedIndex];
  binding.label.textContent = option ? option.textContent : '';
}

function syncAllSelects() {
  document.querySelectorAll('select').forEach(syncSelect);
}

function enhanceSelects() {
  document.querySelectorAll('select').forEach((select) => {
    if (selectBindings.has(select)) return;

    const wrap = document.createElement('div');
    wrap.className = 'select';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-button';

    const label = document.createElement('span');
    label.className = 'select-label';

    const chevron = document.createElement('span');
    chevron.className = 'select-chevron';
    chevron.textContent = '▾';

    button.append(label, chevron);

    const menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.append(select, button, menu);
    select.classList.add('select-native');

    const binding = { label, menu, button };
    selectBindings.set(select, binding);

    const renderMenu = () => {
      menu.innerHTML = '';

      for (const option of select.options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'select-option';
        item.textContent = option.textContent;
        if (option.value === select.value) item.classList.add('active');

        if (option.disabled) {
          item.disabled = true;
          item.classList.add('disabled');
        } else {
          item.addEventListener('click', () => {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            syncSelect(select);
            close();
          });
        }

        menu.appendChild(item);
      }
    };

    const close = () => {
      menu.hidden = true;
      button.classList.remove('open');
    };

    const open = () => {
      document.querySelectorAll('.select-menu').forEach((other) => {
        if (other !== menu) other.hidden = true;
      });

      renderMenu();
      menu.hidden = false;
      button.classList.add('open');
    };

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu.hidden) open();
      else close();
    });

    menu.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    syncSelect(select);
  });
}

window.enhanceSelects = enhanceSelects;
window.syncAllSelects = syncAllSelects;
window.syncSelect = syncSelect;
