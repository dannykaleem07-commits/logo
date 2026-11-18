'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    setKey: (key) => ipcRenderer.invoke('ai:setKey', key),
    test: (p) => ipcRenderer.invoke('ai:test', p),
    analysePhotos: (p) => ipcRenderer.invoke('ai:analysePhotos', p),
    draftNarrative: (p) => ipcRenderer.invoke('ai:draftNarrative', p),
    valuation: (p) => ipcRenderer.invoke('ai:valuation', p)
  },
  data: {
    status: () => ipcRenderer.invoke('data:status'),
    setKeys: (patch) => ipcRenderer.invoke('data:setKeys', patch),
    dvla: (reg, env) => ipcRenderer.invoke('data:dvla', { reg, env }),
    mot: (id, by) => ipcRenderer.invoke('data:mot', { id, by: by === 'vin' ? 'vin' : 'registration' })
  },
  exportPdf: (p) => ipcRenderer.invoke('pdf:export', p),
  saveFile: (p) => ipcRenderer.invoke('file:save', p)
});
