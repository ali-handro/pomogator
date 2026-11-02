'use strict';

const ADMIN_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Помогатор — админка</title>
<style>
  :root { --bg:#0b0f16; --panel:#111825; --line:#223047; --text:#e7eefb; --muted:#8b96ab; --accent:#6ea8ff; --ok:#35d399; --err:#f87171; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:"Segoe UI",system-ui,sans-serif; font-size:14px; color:var(--text); background:var(--bg); padding:24px; }
  h1 { font-size:18px; margin-bottom:16px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
  input, button { font-family:inherit; font-size:13px; }
  input { padding:8px 10px; color:var(--text); background:#0a0f17; border:1px solid var(--line); border-radius:8px; outline:none; }
  input:focus { border-color:var(--accent); }
  button { padding:8px 12px; color:var(--text); background:#16202f; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
  button:hover { background:#1d293b; }
  button.primary { background:rgba(110,168,255,.16); border-color:rgba(110,168,255,.5); }
  button.danger { color:#ffb4b4; border-color:rgba(248,113,113,.4); }
  .stats { display:flex; gap:20px; margin-bottom:18px; color:var(--muted); font-size:12.5px; }
  .stats b { color:var(--text); font-size:15px; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:9px 10px; text-align:left; border-bottom:1px solid var(--line); font-size:13px; }
  th { color:var(--muted); font-weight:500; font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; }
  td.num { font-variant-numeric:tabular-nums; }
  .row-actions { display:flex; gap:6px; }
  .row-actions button { padding:4px 8px; font-size:11.5px; }
  .status { font-size:11.5px; }
  .status.active { color:var(--ok); }
  .status.blocked { color:var(--err); }
  #msg { min-height:20px; margin:10px 0; font-size:12.5px; color:var(--muted); }
  .muted { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
  <h1>Помогатор — админка</h1>

  <div class="bar">
    <input id="token" type="password" placeholder="ADMIN_TOKEN" style="min-width:280px" />
    <button class="primary" id="saveToken">Применить</button>
    <input id="search" type="search" placeholder="Поиск по email" style="min-width:220px" />
    <button id="reload">Обновить</button>
  </div>

  <div class="stats" id="stats"></div>
  <div id="msg"></div>

  <div class="bar">
    <input id="creditEmail" type="email" placeholder="Почта пользователя" style="min-width:240px" />
    <input id="creditAmount" type="number" min="1" placeholder="Сумма, ₽" style="width:130px" />
    <input id="creditComment" type="text" placeholder="Комментарий" style="min-width:200px" />
    <button class="primary" id="creditBtn">Зачислить</button>
  </div>
  <p class="muted" style="margin-bottom:14px">
    Пользователи появляются сами после первого входа по коду на почту. Здесь можно только
    найти их и зачислить баланс.
  </p>

  <table>
    <thead>
      <tr><th>Email</th><th>Баланс</th><th>Пробные</th><th>Статус</th><th>Действия</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

<script>
  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem('adminToken') || '';
  $('token').value = token;

  function say(text, ok) {
    $('msg').textContent = text || '';
    $('msg').style.color = ok ? 'var(--ok)' : 'var(--err)';
  }

  async function call(path, options) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        ...(options && options.headers),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }

  async function loadStats() {
    try {
      const data = await call('/admin/api/stats');
      $('stats').innerHTML =
        '<span>Пользователей: <b>' + data.users + '</b></span>' +
        '<span>Активных: <b>' + data.active + '</b></span>' +
        '<span>На балансах: <b>' + data.balancesRub + ' ₽</b></span>' +
        '<span>Пополнений: <b>' + data.topupsRub + ' ₽</b></span>';
    } catch (err) {
      say(err.message);
    }
  }

  async function loadUsers() {
    try {
      const data = await call('/admin/api/users?q=' + encodeURIComponent($('search').value));
      const rows = $('rows');
      rows.innerHTML = '';

      if (!data.items.length) {
        rows.innerHTML = '<tr><td colspan="5" class="muted">Никого не нашли</td></tr>';
        return;
      }

      for (const user of data.items) {
        const tr = document.createElement('tr');

        const email = document.createElement('td');
        email.textContent = user.email;

        const balance = document.createElement('td');
        balance.className = 'num';
        balance.textContent = user.balanceRub + ' ₽';

        const trial = document.createElement('td');
        trial.className = 'num';
        trial.textContent = user.trialMinutesLeft + ' мин';

        const status = document.createElement('td');
        status.className = 'status ' + user.status;
        status.textContent = user.status === 'active' ? 'активен' : 'заблокирован';

        const actions = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'row-actions';

        for (const amount of [100, 500, 1000]) {
          const btn = document.createElement('button');
          btn.textContent = '+' + amount;
          btn.onclick = async () => {
            try {
              const result = await call('/admin/api/credit', {
                method: 'POST',
                body: JSON.stringify({ email: user.email, amountRub: amount, comment: 'Быстрое зачисление' }),
              });
              say('Зачислено ' + amount + ' ₽, баланс ' + result.balanceRub + ' ₽', true);
              loadUsers();
              loadStats();
            } catch (err) {
              say(err.message);
            }
          };
          wrap.appendChild(btn);
        }

        const block = document.createElement('button');
        block.className = user.status === 'active' ? 'danger' : '';
        block.textContent = user.status === 'active' ? 'Блок' : 'Разблок';
        block.onclick = async () => {
          try {
            await call('/admin/api/status', {
              method: 'POST',
              body: JSON.stringify({
                email: user.email,
                status: user.status === 'active' ? 'blocked' : 'active',
              }),
            });
            say('Статус обновлён', true);
            loadUsers();
          } catch (err) {
            say(err.message);
          }
        };
        wrap.appendChild(block);

        actions.appendChild(wrap);
        tr.append(email, balance, trial, status, actions);
        rows.appendChild(tr);
      }
    } catch (err) {
      say(err.message);
    }
  }

  $('saveToken').onclick = () => {
    token = $('token').value.trim();
    localStorage.setItem('adminToken', token);
    say('Токен сохранён', true);
    loadStats();
    loadUsers();
  };

  $('reload').onclick = () => {
    loadStats();
    loadUsers();
  };

  $('search').addEventListener('input', () => loadUsers());

  $('creditBtn').onclick = async () => {
    const email = $('creditEmail').value.trim();
    const amount = Number($('creditAmount').value);
    const comment = $('creditComment').value.trim();

    if (!email || !amount) {
      say('Укажите почту и сумму');
      return;
    }

    try {
      const result = await call('/admin/api/credit', {
        method: 'POST',
        body: JSON.stringify({ email, amountRub: amount, comment }),
      });
      say('Зачислено ' + amount + ' ₽, баланс ' + result.balanceRub + ' ₽', true);
      $('creditAmount').value = '';
      loadUsers();
      loadStats();
    } catch (err) {
      say(err.message);
    }
  };

  if (token) {
    loadStats();
    loadUsers();
  }
</script>
</body>
</html>`;

module.exports = { ADMIN_HTML };
