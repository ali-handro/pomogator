'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureApi', {
  select: (rect) => ipcRenderer.send('capture:select', rect),
  cancel: () => ipcRenderer.send('capture:cancel'),
});
