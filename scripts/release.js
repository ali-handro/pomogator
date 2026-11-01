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
console.log(`\n=== Версия ${version} ===\n`);

run('npm', ['run', 'build']);

const artifact = path.join(ROOT, 'dist', `Suflyor-${version}.exe`);
if (!fs.existsSync(artifact)) {
  console.error('Не найден артефакт сборки:', artifact);
  process.exit(1);
}

const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
const target = path.join(desktop, `Suflyor-${version}.exe`);
fs.copyFileSync(artifact, target);
console.log('\nСкопировано на рабочий стол:', target);

try {
  run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  run('git', ['commit', '-m', `release: v${version}`]);
  run('git', ['tag', `v${version}`]);
  console.log(`Тег v${version} создан`);
} catch (err) {
  console.warn('\nGit: коммит или тег не созданы —', err.message);
  console.warn('Сделайте коммит вручную, артефакт уже собран.');
}
