'use strict';

const REPO = 'ali-handro/pomogator';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const SHA = `https://github.com/${REPO}/releases/latest/download/SHA256.txt`;

function setHref(id, url) {
  const element = document.getElementById(id);
  if (element && url) element.href = url;
}

async function loadLatest() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) return;

    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];

    const setup = assets.find((asset) => /^Pomogator-Setup-.*\.exe$/i.test(asset.name));
    const portable = assets.find(
      (asset) => /^Pomogator-(?!Setup).*\.exe$/i.test(asset.name)
    );

    if (setup) {
      setHref('downloadSetup', setup.browser_download_url);
      setHref('downloadSetup2', setup.browser_download_url);
    }

    if (portable) {
      setHref('downloadPortable', portable.browser_download_url);
      setHref('downloadPortable2', portable.browser_download_url);
    }

    setHref('shaLink', SHA);
    setHref('shaLink2', SHA);

    const label = document.getElementById('versionLabel');
    if (label && release.tag_name) {
      label.textContent = `Версия v${release.tag_name.replace(/^v/i, '')}`;
    }
  } catch {
    // Если GitHub недоступен, кнопки ведут на страницу релизов.
    setHref('downloadSetup', RELEASES);
    setHref('downloadSetup2', RELEASES);
    setHref('downloadPortable', RELEASES);
    setHref('downloadPortable2', RELEASES);
  }
}

loadLatest();
