const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  listFiles: (dirPath) => ipcRenderer.invoke('fs:listFiles', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  applyDiff: (filePath, targetContent, replacementContent) => ipcRenderer.invoke('fs:applyDiff', filePath, targetContent, replacementContent),
  runCommand: (command, cwd) => ipcRenderer.invoke('exec:runCommand', command, cwd),
  openPath: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),
  isElectron: true,
  getPlatform: () => process.platform
});
