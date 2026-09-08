const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { exec } = require('child_process');
const dns = require('dns').promises;
const net = require('net');

let mainWindow = null;

// Helper: recursively list files ignoring clutter
async function listDirectoryRecursive(dir, maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  const entries = [];
  const IGNORED = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.idea', '.vscode', '.gemini']);
  
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (IGNORED.has(item.name)) continue;
      const fullPath = path.join(dir, item.name);
      const isDir = item.isDirectory();
      entries.push({
        name: item.name,
        path: fullPath,
        isDirectory: isDir
      });
      if (isDir && currentDepth < maxDepth) {
        const sub = await listDirectoryRecursive(fullPath, maxDepth, currentDepth + 1);
        entries.push(...sub);
      }
    }
  } catch (e) {}
  return entries;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false, // Frameless for modern custom titlebar
    titleBarStyle: 'hidden',
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // Allows fetching from local Pi cluster IP seamlessly
    }
  });

  // Load the static frontend
  const indexPath = path.join(__dirname, '..', 'static', 'index.html');
  mainWindow.loadFile(indexPath);

  // Smooth appearance when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Native directory picker IPC handler
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder'
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Workspace File System IPC Handlers
  ipcMain.handle('fs:listFiles', async (event, dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) return [];
    return await listDirectoryRecursive(dirPath, 2);
  });

  ipcMain.handle('fs:readFile', async (event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { error: 'File not found' };
      const content = await fsp.readFile(filePath, 'utf-8');
      return { content };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('fs:applyDiff', async (event, filePath, targetContent, replacementContent) => {
    try {
      if (!fs.existsSync(filePath)) return { error: 'File not found' };
      let existing = await fsp.readFile(filePath, 'utf-8');
      if (!existing.includes(targetContent)) {
        return { error: 'Target snippet not found in file' };
      }
      existing = existing.replace(targetContent, replacementContent);
      await fsp.writeFile(filePath, existing, 'utf-8');
      return { success: true, path: filePath };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('exec:runCommand', async (event, command, cwd) => {
    return new Promise((resolve) => {
      exec(command, { cwd: cwd || process.cwd(), timeout: 30000 }, (error, stdout, stderr) => {
        resolve({
          exitCode: error ? error.code || 1 : 0,
          stdout: stdout || '',
          stderr: stderr || (error ? error.message : '')
        });
      });
    });
  });

  ipcMain.handle('shell:openPath', async (event, folderPath) => {
    if (folderPath && fs.existsSync(folderPath)) {
      await shell.openPath(folderPath);
      return true;
    }
    return false;
  });

  // Cluster .local DNS Scanning & Packet Probing IPC Handler
  function probeNodeSocket(host, id) {
    return new Promise((resolve) => {
      const start = Date.now();
      let finished = false;

      // 1. Probe Port 11434 (Ollama)
      const socket = net.createConnection({ host, port: 11434, timeout: 1200 });
      
      socket.on('connect', () => {
        if (finished) return;
        finished = true;
        const latency = Date.now() - start;
        socket.destroy();
        resolve({ online: true, latencyMs: latency, name: id, probe: 'ollama' });
      });

      socket.on('timeout', () => {
        socket.destroy();
        if (!finished) trySsh();
      });

      socket.on('error', () => {
        socket.destroy();
        if (!finished) trySsh();
      });

      // 2. Fallback Probe to Port 22 (SSH Handshake packet)
      function trySsh() {
        if (finished) return;
        const sshSocket = net.createConnection({ host, port: 22, timeout: 1200 });
        
        sshSocket.on('connect', () => {
          if (finished) return;
          finished = true;
          const latency = Date.now() - start;
          sshSocket.destroy();
          resolve({ online: true, latencyMs: latency, name: id, probe: 'ssh' });
        });

        sshSocket.on('data', () => {
          if (finished) return;
          finished = true;
          const latency = Date.now() - start;
          sshSocket.destroy();
          resolve({ online: true, latencyMs: latency, name: id, probe: 'ssh' });
        });

        sshSocket.on('timeout', () => {
          sshSocket.destroy();
          if (!finished) {
            finished = true;
            resolve({ online: false, latencyMs: 999, name: id, probe: 'none' });
          }
        });

        sshSocket.on('error', () => {
          sshSocket.destroy();
          if (!finished) {
            finished = true;
            resolve({ online: false, latencyMs: 999, name: id, probe: 'none' });
          }
        });
      }
    });
  }

  ipcMain.handle('cluster:scanLocalNodes', async () => {
    const nodes = [
      { id: 'cst1', dns: 'cst1.local', defaultIp: '10.11.16.36' },
      { id: 'cst5', dns: 'cst5.local', defaultIp: '10.11.2.22' },
      { id: 'cst6', dns: 'cst6.local', defaultIp: '10.11.16.29' },
      { id: 'cst7', dns: 'cst7.local', defaultIp: '10.11.2.12' }
    ];

    const results = await Promise.all(nodes.map(async (node) => {
      let resolvedIp = node.defaultIp;
      try {
        const lookup = await dns.lookup(node.dns);
        if (lookup && lookup.address) {
          resolvedIp = lookup.address;
        }
      } catch (e) {}

      const probe = await probeNodeSocket(resolvedIp, node.id);
      return {
        id: node.id,
        name: node.id,
        dns: node.dns,
        ip: resolvedIp,
        isGateway: false,
        online: probe.online,
        latencyMs: probe.latencyMs,
        latency: probe.online ? `${probe.latencyMs}ms` : 'offline',
        gpuCount: 2,
        gpuSummary: '2x Quadro P2000 (10GB)',
        available: probe.online
      };
    }));

    return results;
  });

  // Window control IPC handlers
  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window:close', () => {
    if (mainWindow) mainWindow.close();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
