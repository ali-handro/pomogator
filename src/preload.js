'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  /* настройки */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),

  /* аккаунт */
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountRequestCode: (email) => ipcRenderer.invoke('account:request-code', email),
  accountVerify: (email, code) => ipcRenderer.invoke('account:verify', { email, code }),
  accountRefresh: () => ipcRenderer.invoke('account:refresh'),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  accountRemoveDevice: (id) => ipcRenderer.invoke('account:remove-device', id),
  accountQuote: (kind) => ipcRenderer.invoke('account:quote', kind),
  onAccountChanged: (cb) => subscribe('account:changed', cb),
  openLogin: () => ipcRenderer.send('account:open-login'),

  /* окно */
  setClickThrough: (value) => ipcRenderer.send('overlay:set-click-through', value),
  onClickThrough: (cb) => subscribe('overlay:click-through', cb),
  resizeStart: (dir) => ipcRenderer.send('overlay:resize-start', dir),
  resizeMove: (delta) => ipcRenderer.send('overlay:resize-move', delta),
  resizeEnd: () => ipcRenderer.send('overlay:resize-end'),
  setAnswerRegion: (region) => ipcRenderer.send('overlay:answer-region', region),
  noteWheelHandled: () => ipcRenderer.send('overlay:wheel-handled'),
  onWheelConsumed: (cb) => subscribe('overlay:wheel-consumed', cb),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  openSettings: () => ipcRenderer.send('settings:open'),
  openOverlay: () => ipcRenderer.send('overlay:open'),
  openTrainer: () => ipcRenderer.send('trainer:open'),
  openQuiz: () => ipcRenderer.send('quiz:open'),
  openMeeting: () => ipcRenderer.send('meeting:open'),

  /* запись встречи */
  meetingSave: (data) => ipcRenderer.invoke('meeting:save', data),
  meetingExport: (data) => ipcRenderer.invoke('meeting:export', data),
  meetingSummary: (data) => ipcRenderer.invoke('meeting:summary', data),
  meetingsList: () => ipcRenderer.invoke('meetings:list'),
  meetingRead: (name) => ipcRenderer.invoke('meetings:read', name),
  meetingRemove: (name) => ipcRenderer.invoke('meetings:remove', name),
  setMeetingRecording: (value) => ipcRenderer.send('meeting:recording', value),
  onMeetingRecording: (cb) => subscribe('meeting:recording', cb),

  /* события из главного процесса */
  onAction: (name, cb) => subscribe(`action:${name}`, cb),
  getHotkeysStatus: () => ipcRenderer.invoke('hotkeys:get-status'),
  onHotkeysStatus: (cb) => subscribe('hotkeys:status', cb),

  /* модель */
  ask: (question) => ipcRenderer.invoke('llm:ask', { question }),
  captureSolve: (mode) => ipcRenderer.invoke('vision:capture', { mode }),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  abort: () => ipcRenderer.send('llm:abort'),
  onLlmStart: (cb) => subscribe('llm:start', cb),
  onLlmDelta: (cb) => subscribe('llm:delta', cb),
  onLlmDone: (cb) => subscribe('llm:done', cb),
  onLlmError: (cb) => subscribe('llm:error', cb),
  onCloudUsage: (cb) => subscribe('cloud:usage', cb),

  /* распознавание речи */
  transcribe: (audio, override) => ipcRenderer.invoke('stt:transcribe', { audio, override }),
  testStt: () => ipcRenderer.invoke('stt:test'),
  onSttNotice: (cb) => subscribe('stt:notice', cb),

  /* локальное распознавание (whisper.cpp) */
  localSttStatus: () => ipcRenderer.invoke('localStt:status'),
  localSttDownload: (model) => ipcRenderer.invoke('localStt:download', { model }),
  localSttCancel: () => ipcRenderer.invoke('localStt:cancel'),
  onLocalSttProgress: (cb) => subscribe('localStt:progress', cb),
  testConnection: () => ipcRenderer.invoke('llm:test'),
  listModels: (kind) => ipcRenderer.invoke('models:list', kind),

  /* системное */
  appInfo: () => ipcRenderer.invoke('app:info'),
  getProviders: () => ipcRenderer.invoke('providers:get'),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  onDisplaysChanged: (cb) => subscribe('displays:changed', cb),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
});
