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

  /* окно */
  setClickThrough: (value) => ipcRenderer.send('overlay:set-click-through', value),
  onClickThrough: (cb) => subscribe('overlay:click-through', cb),
  resizeStart: (dir) => ipcRenderer.send('overlay:resize-start', dir),
  resizeMove: (delta) => ipcRenderer.send('overlay:resize-move', delta),
  resizeEnd: () => ipcRenderer.send('overlay:resize-end'),
  setAnswerRegion: (region) => ipcRenderer.send('overlay:answer-region', region),
  noteWheelHandled: () => ipcRenderer.send('overlay:wheel-handled'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  openSettings: () => ipcRenderer.send('settings:open'),

  /* события из главного процесса */
  onAction: (name, cb) => subscribe(`action:${name}`, cb),
  getHotkeysStatus: () => ipcRenderer.invoke('hotkeys:get-status'),
  onHotkeysStatus: (cb) => subscribe('hotkeys:status', cb),

  /* модель */
  ask: (question) => ipcRenderer.invoke('llm:ask', { question }),
  abort: () => ipcRenderer.send('llm:abort'),
  onLlmStart: (cb) => subscribe('llm:start', cb),
  onLlmDelta: (cb) => subscribe('llm:delta', cb),
  onLlmDone: (cb) => subscribe('llm:done', cb),
  onLlmError: (cb) => subscribe('llm:error', cb),

  /* распознавание речи */
  transcribe: (audio) => ipcRenderer.invoke('stt:transcribe', { audio }),
  testStt: () => ipcRenderer.invoke('stt:test'),
  onSttNotice: (cb) => subscribe('stt:notice', cb),

  /* локальное распознавание (whisper.cpp) */
  localSttStatus: () => ipcRenderer.invoke('localStt:status'),
  localSttDownload: (model) => ipcRenderer.invoke('localStt:download', { model }),
  localSttCancel: () => ipcRenderer.invoke('localStt:cancel'),
  onLocalSttProgress: (cb) => subscribe('localStt:progress', cb),
  testConnection: () => ipcRenderer.invoke('llm:test'),

  /* системное */
  appInfo: () => ipcRenderer.invoke('app:info'),
  getProviders: () => ipcRenderer.invoke('providers:get'),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  onDisplaysChanged: (cb) => subscribe('displays:changed', cb),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
});
