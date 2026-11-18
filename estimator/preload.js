'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The bridge exists only on the app's own page (app/index.html). The main process also refuses IPC from any other page
// or frame; this keeps the API out of anything else the window might ever show.
const onAppPage = location.protocol === 'file:' && /\/app\/index\.html$/i.test(location.pathname);

// Every call resolves to an object with `ok`; failures carry a user-readable `error` and never throw.
if (onAppPage) {
  contextBridge.exposeInMainWorld('desktop', {
    ai: {
      status: () => ipcRenderer.invoke('ai:status'), // {hasKey, encrypted, protection, error?}
      setKey: (key) => ipcRenderer.invoke('ai:setKey', key), // '' or null removes the key
      test: (p) => ipcRenderer.invoke('ai:test', p),
      analysePhotos: (p) => ipcRenderer.invoke('ai:analysePhotos', p),
      draftNarrative: (p) => ipcRenderer.invoke('ai:draftNarrative', p),
      valuation: (p) => ipcRenderer.invoke('ai:valuation', p)
    },
    data: {
      status: () => ipcRenderer.invoke('data:status'), // {dvla, mot, motTokenUrl, encrypted, protection, unreadable?, error?}
      setKeys: (patch) => ipcRenderer.invoke('data:setKeys', patch),
      clearKeys: () => ipcRenderer.invoke('data:clearKeys'), // remove ALL saved DVLA / MOT credentials
      dvla: (reg, env) => ipcRenderer.invoke('data:dvla', { reg, env }),
      mot: (id, by) => ipcRenderer.invoke('data:mot', { id, by: by === 'vin' ? 'vin' : 'registration' })
    },
    exportPdf: (p) => ipcRenderer.invoke('pdf:export', p), // {html, header, footer, fileName, marginsMm?}
    saveFile: (p) => ipcRenderer.invoke('file:save', p), // {content, fileName}: saved as a .json file
    // Streaming backup to a .ersbackup file: begin, then write the text in pieces (await each one), then end. On any
    // error call abort. Nothing replaces the chosen file until end succeeds; closing or reloading the window cancels it.
    backup: {
      begin: (p) => ipcRenderer.invoke('backup:begin', p), // {fileName} → {ok:true, id} | {ok:false, canceled:true} | {ok:false, error}
      write: (id, chunk) => ipcRenderer.invoke('backup:write', id, chunk), // chunk: a string of at most 64 Mi characters, split anywhere → {ok} | {ok:false, error}
      end: (id) => ipcRenderer.invoke('backup:end', id), // → {ok:true, filePath} | {ok:false, error}; opens nothing
      abort: (id) => ipcRenderer.invoke('backup:abort', id) // → {ok:true}: the temporary file is deleted
    },
    app: {
      info: () => ipcRenderer.invoke('app:info') // {ok, dataFolder}: where jobs, settings and keys are stored
    }
  });
}
