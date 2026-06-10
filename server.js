const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);
const app = express();

app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.tmpDir),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

function makeTmpDir(req, res, next) {
  req.tmpDir = path.join(os.tmpdir(), `sss-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(req.tmpDir, { recursive: true });
  next();
}

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
      '-preset', 'fast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-movflags', '+faststart',
      'out.mp4'
    ];

    await execFileAsync('ffmpeg', args, { cwd: tmpDir });

    res.download(path.join(tmpDir, 'out.mp4'), `${filename}.mp4`, () => {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (err) {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) {
      const msg = err.code === 'ENOENT'
        ? 'FFmpeg introuvable — installez-le et vérifiez le PATH.'
        : (err.stderr || err.message);
      res.status(500).json({ error: msg });
    }
  }
}

app.post('/export', makeTmpDir, upload.any(), runExport);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SSS Generator → http://localhost:${PORT}`));
