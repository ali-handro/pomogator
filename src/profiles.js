'use strict';

/** Поля, которые у каждого профиля свои. */
const PROFILE_FIELDS = ['contextPrompt', 'terms', 'resume', 'job'];

function createProfile(source, id, name) {
  const input = source && typeof source === 'object' ? source : {};
  const profile = {
    id: String(id || ''),
    name: String(name || ''),
  };

  for (const key of PROFILE_FIELDS) {
    profile[key] = String(input[key] || '');
  }

  return profile;
}

function profileList(settings) {
  return Array.isArray(settings && settings.profiles) ? settings.profiles : [];
}

function activeProfile(settings) {
  const list = profileList(settings);
  const id = settings && settings.activeProfile;

  return list.find((profile) => profile && profile.id === id) || list[0] || null;
}

/** Контекст активного профиля с запасным вариантом для старых настроек. */
function profileFields(settings) {
  const profile = activeProfile(settings);
  const source = profile || settings || {};
  const fields = {};

  for (const key of PROFILE_FIELDS) {
    fields[key] = String(source[key] || '');
  }

  return fields;
}

/**
 * Приводит список профилей к рабочему виду.
 * hadProfiles = false означает настройки старой версии: первый профиль
 * создаётся из уже заполненных полей контекста.
 */
function normalizeProfiles(settings, hadProfiles) {
  let changed = false;
  const list = profileList(settings);

  if (!hadProfiles || !list.length) {
    settings.profiles = [
      createProfile(settings, 'profile-1', 'Профиль 1'),
      createProfile({}, 'profile-2', 'Профиль 2'),
    ];
    settings.activeProfile = 'profile-1';
    changed = true;
  } else {
    const seen = new Set();

    settings.profiles = list.map((item, index) => {
      const raw = item && typeof item === 'object' ? item : {};
      let id = String(raw.id || '').trim();

      if (!id || seen.has(id)) {
        const base = id || `profile-${index + 1}`;
        id = base;

        let suffix = 2;
        while (seen.has(id)) {
          id = `${base}-${suffix}`;
          suffix += 1;
        }
      }

      seen.add(id);

      const name = String(raw.name || '').trim() || `Профиль ${index + 1}`;
      const profile = createProfile(raw, id, name);

      if (profile.id !== raw.id || profile.name !== raw.name) changed = true;
      for (const key of PROFILE_FIELDS) {
        if (profile[key] !== raw[key]) changed = true;
      }

      return profile;
    });
  }

  if (!settings.profiles.some((profile) => profile.id === settings.activeProfile)) {
    settings.activeProfile = settings.profiles[0].id;
    changed = true;
  }

  return changed;
}

/** Переносит поля из формы настроек в активный профиль. */
function syncProfileFromFields(settings) {
  const profile = activeProfile(settings);
  if (!profile) return;

  for (const key of PROFILE_FIELDS) {
    profile[key] = String(settings[key] || '');
  }
}

/** Показывает поля активного профиля в старых полях настроек. */
function syncFieldsFromProfile(settings) {
  const profile = activeProfile(settings);
  const source = profile || settings || {};

  for (const key of PROFILE_FIELDS) {
    settings[key] = String(source[key] || '');
  }
}

module.exports = {
  PROFILE_FIELDS,
  createProfile,
  activeProfile,
  profileFields,
  normalizeProfiles,
  syncProfileFromFields,
  syncFieldsFromProfile,
};
