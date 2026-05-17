const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const APP_DIR = process.env.APP_DIR || '/app';
const PARENT_PID = Number(process.env.PARENT_PID || '0');
const REPO_ZIP_URL = process.env.REPO_ZIP_URL || 'https://codeload.github.com/jcreglin/cable-drum-register-v2/zip/refs/heads/master';
const TMP_DIR = '/tmp/cable-drum-update';
const ZIP_PATH = path.join(TMP_DIR, 'repo.zip');
const LOG_PATH = '/tmp/self-update.log';
const UPDATE_STATUS_FILE = process.env.UPDATE_STATUS_FILE || path.join(APP_DIR, 'data', 'update-status.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeStatus(status) {
  try {
    ensureDir(path.dirname(UPDATE_STATUS_FILE));
    fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    log('Failed to write status: ' + (e && e.message || e));
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Cable-Drum-Register/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      try { file.close(); } catch {}
      reject(err);
    });
  });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const name of fs.readdirSync(src)) {
      if (['.git', 'node_modules', 'uploads', 'data'].includes(name)) continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

(async () => {
  try {
    log('Starting self-update');
    writeStatus({ state: 'running', message: 'Downloading update...', startedAt: new Date().toISOString() });
    rmrf(TMP_DIR);
    ensureDir(TMP_DIR);
    await download(REPO_ZIP_URL, ZIP_PATH);
    log('Downloaded repo zip');
    writeStatus({ state: 'running', message: 'Extracting update...', startedAt: new Date().toISOString() });

    const zip = new AdmZip(ZIP_PATH);
    zip.extractAllTo(TMP_DIR, true);
    const extractedRoot = fs.readdirSync(TMP_DIR)
      .map(name => path.join(TMP_DIR, name))
      .find(p => fs.existsSync(p) && fs.statSync(p).isDirectory() && path.basename(p) !== 'node_modules');

    if (!extractedRoot) throw new Error('Could not find extracted repo root');
    log(`Extracted root: ${extractedRoot}`);

    for (const name of fs.readdirSync(extractedRoot)) {
      if (['.git', 'node_modules', 'uploads', 'data'].includes(name)) continue;
      const src = path.join(extractedRoot, name);
      const dest = path.join(APP_DIR, name);
      copyRecursive(src, dest);
    }
    log('Copied files into app dir');
    writeStatus({ state: 'running', message: 'Installing dependencies...', startedAt: new Date().toISOString() });

    const npm = spawnSync('npm', ['install', '--omit=dev'], {
      cwd: APP_DIR,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    log(`npm install exit=${npm.status}`);
    if (npm.stdout) log(npm.stdout.slice(-4000));
    if (npm.stderr) log(npm.stderr.slice(-4000));
    if (npm.status !== 0) throw new Error('npm install failed');

    let version = 'unknown';
    try {
      version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || 'unknown';
    } catch {}
    writeStatus({
      state: 'completed',
      message: 'Updated successfully to ' + version,
      version,
      completedAt: new Date().toISOString()
    });

    log('Update complete, restarting app');
    // Try multiple restart methods
    try {
      if (PARENT_PID > 1) {
        process.kill(PARENT_PID, 'SIGTERM');
        log('Sent SIGTERM to parent PID');
      }
    } catch(e) { log('Could not kill parent: ' + e.message); }
    // Fallback: use docker restart if available
    try {
      const { execSync } = require('child_process');
      execSync('pkill -f "node server.js" || true', { stdio: 'ignore' });
    } catch(e) { log('pkill failed: ' + e.message); }
  } catch (e) {
    const message = 'Update failed: ' + ((e && e.message) || e);
    writeStatus({ state: 'failed', message, failedAt: new Date().toISOString() });
    log('Update failed: ' + (e && e.stack || e));
  }
})();
