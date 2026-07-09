const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const rateLimit = require('express-rate-limit');

const execFileAsync = promisify(execFile);
const app = express();

const BACKGROUNDS_DIR = path.join(__dirname, 'public', 'backgrounds');

let isProcessing = false;
let _bgCache = null;
function getBackgroundFiles() {
  if (!_bgCache) {
    _bgCache = fs.readdirSync(BACKGROUNDS_DIR)
      .filter(f => f.toLowerCase().endsWith('.jpg'));
  }
  return _bgCache;
}

// ── CORS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/backgrounds', express.static(BACKGROUNDS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.tmpDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 600 } });

function makeTmpDir(req, res, next) {
  req.tmpDir = path.join(os.tmpdir(), `sss-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(req.tmpDir, { recursive: true });
  next();
}

function checkProcessing(req, res, next) {
  if (isProcessing) {
    return res.status(503).json({ error: 'Serveur occupé — un encodage est en cours. Réessaie dans 30 secondes.' });
  }
  isProcessing = true;
  next();
}

function handleUploadError(err, req, res, next) {
  isProcessing = false;
  if (req.tmpDir) fs.rm(req.tmpDir, { recursive: true, force: true }, () => {});
  res.status(500).json({ error: 'Erreur upload : ' + err.message });
}

const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite atteinte — max 30 générations par heure par IP.' }
});

async function runExport(req, res) {
  const { tmpDir } = req;
  try {
    const fps = req.body.fps || '24';
    const filename = (req.body.filename || 'output').replace(/[^\w\-]/g, '_');
    const hasAudio = req.files.some(f => f.fieldname === 'audio');

    const args = [
      '-framerate', fps,
      '-i', 'f%05d.jpg',
      ...(hasAudio ? ['-i', 'audio.wav', '-shortest'] : []),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-movflags', '+faststart',
      'out.mp4'
    ];

    await execFileAsync('ffmpeg', args, { cwd: tmpDir, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });

    res.download(path.join(tmpDir, 'out.mp4'), `${filename}.mp4`, (err) => {
      if (err) console.error('[download error]', err.message);
      fs.rm(tmpDir, { recursive: true, force: true }, (err) => {
        if (err) console.error('[cleanup error]', err.message);
      });
    });
  } catch (err) {
    console.error('[export error]', err.message);
    fs.rm(tmpDir, { recursive: true, force: true }, (err) => {
      if (err) console.error('[cleanup error]', err.message);
    });
    if (!res.headersSent) {
      const msg = err.killed
        ? 'Encodage annulé — délai dépassé.'
        : err.code === 'ENOENT'
        ? 'FFmpeg introuvable — installez-le et vérifiez le PATH.'
        : (err.stderr || err.message);
      res.status(500).json({ error: msg });
    }
  } finally {
    isProcessing = false;
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/status', (req, res) => {
  if (isProcessing) return res.json({ status: 'busy', processing: true });
  res.json({ status: 'idle', processing: false });
});

app.get('/backgrounds/random', (req, res) => {
  try {
    const files = getBackgroundFiles();
    if (!files.length) return res.status(404).json({ error: 'Aucun background disponible.' });
    const filtered = req.query.mode
      ? files.filter(f => f.startsWith(req.query.mode + '_'))
      : files;
    if (!filtered.length) return res.status(404).json({ error: 'Aucun background disponible.' });
    const filename = filtered[Math.floor(Math.random() * filtered.length)];
    res.json({ filename, url: `/backgrounds/${filename}` });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lecture backgrounds.' });
  }
});

app.get('/backgrounds/list', (req, res) => {
  try {
    const backgrounds = getBackgroundFiles();
    if (!backgrounds.length) return res.status(404).json({ error: 'Aucun background disponible.' });
    res.json({ backgrounds, total: backgrounds.length });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lecture backgrounds.' });
  }
});

app.post('/export', exportLimiter, checkProcessing, makeTmpDir, upload.any(), handleUploadError, runExport);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SSS Generator → http://localhost:${PORT}`));
