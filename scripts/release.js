'use strict';

/**
 * Релиз новой версии: поднять номер, собрать portable exe, положить его на
 * рабочий стол под версионным именем, закоммитить и поставить тег.
 *
 *   npm run release          → patch (0.2.0 → 0.2.1)
 *   npm run release minor    → minor (0.2.0 → 0.3.0)
 *   npm run release major    → major (0.2.0 → 1.0.0)
 *
 * Старые сборки на рабочем столе не перезаписываются: у каждой свой номер.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

const kind = (process.argv[2] || 'patch').toLowerCase();
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('usage: npm run release [patch|minor|major]');
  process.exit(1);
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: true });
}

// npm version обновляет и package.json, и package-lock.json, но не трогает git.
run('npm', ['version', kind, '--no-git-tag-version']);

const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
const productName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).productName || 'Pomogator';
console.log(`\n=== ${productName} ${version} ===\n`);

run('npm', ['run', 'build']);

const artifact = path.join(ROOT, 'dist', `${productName}-${version}.exe`);
if (!fs.existsSync(artifact)) {
  console.error('Не найден portable-артефакт сборки:', artifact);
  process.exit(1);
}

const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
const target = path.join(desktop, `${productName}-${version}.exe`);
fs.copyFileSync(artifact, target);
console.log('\nСкопировано на рабочий стол:', target);

// Установщик тоже кладём рядом — его удобнее отправлять пользователям.
const setup = path.join(ROOT, 'dist', `${productName}-Setup-${version}.exe`);
if (fs.existsSync(setup)) {
  const setupTarget = path.join(desktop, `${productName}-Setup-${version}.exe`);
  fs.copyFileSync(setup, setupTarget);
  console.log('Установщик на рабочем столе:', setupTarget);
}

// Уборка мусора после сборки и тестовых запусков.
cleanup();

function cleanup() {
  // Распакованная сборка нужна только на время упаковки — это ~400 МБ.
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });

  // Portable-exe распаковывается в %TEMP%\nsXXXX.tmp (~400 МБ). При штатном
  // выходе он удаляет папку сам, но после принудительных перезапусков они
  // копятся. Чистим только старые (>1 часа) и только свои (с app-64.7z).
  const temp = process.env.TEMP || '';
  if (!temp) return;

  let removed = 0;
  const now = Date.now();
  for (const entry of fs.readdirSync(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^ns.*\.tmp$/i.test(entry.name)) continue;
    const full = path.join(temp, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < 60 * 60 * 1000) continue;
      if (!fs.existsSync(path.join(full, 'app-64.7z'))) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* папка занята — пропускаем */
    }
  }

  if (removed) console.log(`Убрано временных папок запуска: ${removed}`);
  console.log('Уборка завершена.');
}

try {
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', `"release: v${version}"`]);
  run('git', ['tag', `v${version}`]);
  console.log(`Тег v${version} создан`);
} catch (err) {
  console.warn('\nGit: коммит или тег не созданы —', err.message);
  console.warn('Сделайте коммит вручную, артефакт уже собран.');
}
