const express = require('express');
const fs = require('fs').promises;
const { existsSync, mkdirSync } = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const os = require('os');
const { exec, spawn } = require('child_process');

let S3Client, PutObjectCommand;
try {
    const s3Package = require('@aws-sdk/client-s3');
    S3Client = s3Package.S3Client;
    PutObjectCommand = s3Package.PutObjectCommand;
} catch (e) {
    console.log("  [@aws-sdk/client-s3 not installed - Cloud storage fallback to local/tunnel]");
}

const app = express();
const PORT = process.env.PORT || 3000;
let globalTunnelUrl = "";

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

const BASE_DATA_DIR = path.join(__dirname, 'data', 'events');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!existsSync(BASE_DATA_DIR)) mkdirSync(BASE_DATA_DIR, { recursive: true });
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: TEMP_DIR, limits: { fieldSize: 200 * 1024 * 1024 } });
const adminUpload = multer({ dest: TEMP_DIR });

const defaultSettings = {
    cameraMode: "webcam",
    enable1x3: false,
    enable1x4: true,
    enable2x2: false,
    enable3x_grid: true,
    defaultCameraId: "",
    textColor: "#ff4d6d",
    bgImage: "",
    totalShots: 8,
    captureTimer: 5,
    frames1x3: [], frames1x4: [], frames2x2: [], frames3x_grid: [], stickers: [],
    marginPresets: {
        '1x3': [{ name: 'Default 1x3', top: 20, bot: 60, side: 20, gap: 15 }],
        '1x4': [{ name: 'Default 1x4', top: 20, bot: 70, side: 20, gap: 15 }],
        '2x2': [{ name: 'Default 2x2', top: 20, bot: 60, side: 20, gap: 15 }],
        '3x_grid': [{ name: 'Default 3-Shot', top: 20, bot: 60, side: 20, gap: 15 }]
    },
    layout1x3: { paddingTop: 20, paddingBottom: 60, paddingSide: 20, gap: 15 },
    layout1x4: { paddingTop: 20, paddingBottom: 70, paddingSide: 20, gap: 15 },
    layout2x2: { paddingTop: 20, paddingBottom: 60, paddingSide: 20, gap: 15 },
    layout3x_grid: { paddingTop: 20, paddingBottom: 60, paddingSide: 20, gap: 15 }
};

function sanitizeEventCode(code) {
    if (!code) return 'default';
    return code.toString().trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'default';
}

function getEventDir(eventCode) {
    return path.join(BASE_DATA_DIR, sanitizeEventCode(eventCode));
}

async function ensureEventDirs(eventCode) {
    const dir = getEventDir(eventCode);
    const assetsDir = path.join(dir, 'assets');
    const galleriesDir = path.join(dir, 'galleries');
    const settingsFile = path.join(dir, 'settings.json');

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(galleriesDir)) mkdirSync(galleriesDir, { recursive: true });

    if (!existsSync(settingsFile)) {
        await fs.writeFile(settingsFile, JSON.stringify(defaultSettings, null, 2));
    }
    return { dir, assetsDir, galleriesDir, settingsFile };
}

async function moveFile(oldPath, newPath) {
    try {
        await fs.copyFile(oldPath, newPath);
        await fs.unlink(oldPath);
    } catch (err) {
        console.error(`Failed to move file to ${newPath}:`, err);
    }
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

async function uploadToCloud(key, buffer, contentType) {
    if (!S3Client || !process.env.R2_ACCOUNT_ID) return null;
    try {
        const client = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });

        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType
        }));

        const publicDomain = process.env.R2_PUBLIC_DOMAIN ? process.env.R2_PUBLIC_DOMAIN.replace(/\/$/, '') : null;
        return publicDomain ? `https://${publicDomain}/${key}` : null;
    } catch (e) {
        return null;
    }
}

app.use('/events/:eventCode/assets', (req, res, next) => {
    express.static(path.join(getEventDir(req.params.eventCode), 'assets'))(req, res, next);
});
app.use('/events/:eventCode/galleries', (req, res, next) => {
    express.static(path.join(getEventDir(req.params.eventCode), 'galleries'))(req, res, next);
});
app.use('/assets', (req, res, next) => {
    express.static(path.join(getEventDir('default'), 'assets'))(req, res, next);
});
app.use('/galleries', (req, res, next) => {
    express.static(path.join(getEventDir('default'), 'galleries'))(req, res, next);
});

app.get('/api/events', async (req, res) => {
    try {
        await ensureEventDirs('default');
        const items = await fs.readdir(BASE_DATA_DIR, { withFileTypes: true });
        const events = items.filter(d => d.isDirectory()).map(d => d.name);
        res.json({ success: true, events });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/events', async (req, res) => {
    try {
        const eventCode = sanitizeEventCode(req.body.eventCode);
        await ensureEventDirs(eventCode);
        res.json({ success: true, eventCode });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/:eventCode/settings', async (req, res) => {
    const eventCode = sanitizeEventCode(req.params.eventCode);
    try {
        const { settingsFile } = await ensureEventDirs(eventCode);
        const data = await fs.readFile(settingsFile, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) { res.json(defaultSettings); }
});

app.post('/api/:eventCode/settings', async (req, res) => {
    const eventCode = sanitizeEventCode(req.params.eventCode);
    try {
        const { settingsFile } = await ensureEventDirs(eventCode);
        await fs.writeFile(settingsFile, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/:eventCode/upload-asset', adminUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const eventCode = sanitizeEventCode(req.params.eventCode);
    const { assetsDir } = await ensureEventDirs(eventCode);

    const ext = path.extname(req.file.originalname);
    const filename = `${req.body.assetType || 'asset'}_${Date.now()}${ext}`;
    const targetPath = path.join(assetsDir, filename);

    await moveFile(req.file.path, targetPath);
    res.json({ success: true, url: `/events/${eventCode}/assets/${filename}` });
});

app.post('/api/:eventCode/upload', upload.fields([
    { name: 'btsVideo', maxCount: 1 }, { name: 'finalStrip', maxCount: 1 },
    { name: 'rawPhoto0', maxCount: 1 }, { name: 'rawPhoto1', maxCount: 1 },
    { name: 'rawPhoto2', maxCount: 1 }, { name: 'rawPhoto3', maxCount: 1 }
]), async (req, res) => {
    const eventCode = sanitizeEventCode(req.params.eventCode);
    const sessionTime = Date.now();
    const { galleriesDir } = await ensureEventDirs(eventCode);
    const sessionFolder = `Session_${sessionTime}`;
    const galleryDir = path.join(galleriesDir, sessionFolder);

    try {
        await fs.mkdir(galleryDir, { recursive: true });

        if (req.files['finalStrip']) {
            const stripPath = path.join(galleryDir, 'photobooth_strip.jpg');
            await moveFile(req.files['finalStrip'][0].path, stripPath);
            const fileBuf = await fs.readFile(stripPath);
            await uploadToCloud(`events/${eventCode}/galleries/${sessionFolder}/photobooth_strip.jpg`, fileBuf, 'image/jpeg');
        }

        await fs.writeFile(path.join(galleryDir, 'layout.txt'), (req.body.layout || '1x4').trim());

        let rawPhotosHtml = '';
        for (let i = 0; i < 4; i++) {
            if (req.files[`rawPhoto${i}`]) {
                const rawFilename = `raw_photo_${i + 1}.jpg`;
                const rawPath = path.join(galleryDir, rawFilename);
                await moveFile(req.files[`rawPhoto${i}`][0].path, rawPath);
                const rawBuf = await fs.readFile(rawPath);
                await uploadToCloud(`events/${eventCode}/galleries/${sessionFolder}/${rawFilename}`, rawBuf, 'image/jpeg');

                rawPhotosHtml += `
                <div class="raw-item">
                    <img src="${rawFilename}" alt="Raw Photo ${i + 1}">
                    <a href="${rawFilename}" download="${rawFilename}" class="download-btn small-btn">Save Photo</a>
                </div>`;
            }
        }

        let videoFilename = '';
        if (req.files['btsVideo']) {
            videoFilename = req.files['btsVideo'][0].originalname || 'animated_strip.mp4';
            const vidPath = path.join(galleryDir, videoFilename);
            await moveFile(req.files['btsVideo'][0].path, vidPath);
            const vidBuf = await fs.readFile(vidPath);
            await uploadToCloud(`events/${eventCode}/galleries/${sessionFolder}/${videoFilename}`, vidBuf, req.files['btsVideo'][0].mimetype || 'video/mp4');
        }

        const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Photobooth Memories - ${eventCode.toUpperCase()}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap');
        body { margin: 0; padding: 20px; font-family: 'Nunito', sans-serif; background: linear-gradient(135deg, #fff0f3 0%, #ffccd5 100%); color: #4a4a4a; text-align: center; }
        h1 { color: #ff4d6d; margin-bottom: 5px; font-size: 2.3rem;}
        p.subtitle { margin-top: 0; margin-bottom: 25px; font-weight: bold; color: #777;}
        .container { max-width: 480px; margin: 0 auto; background: rgba(255,255,255,0.8); padding: 25px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        img, video { width: 100%; border-radius: 10px; margin-bottom: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.08); display: block;}
        .download-btn { display: inline-block; background: #ff4d6d; color: white; text-decoration: none; padding: 14px 0; width: 100%; border-radius: 30px; font-weight: 900; margin-bottom: 30px; font-size: 1rem; box-sizing: border-box; transition: 0.2s;}
        .download-btn:active { transform: scale(0.97); }
        .download-btn.small-btn { padding: 8px 0; font-size: 0.85rem; margin-bottom: 0; border-radius: 10px;}
        h3 { margin-top: 15px; color: #333; text-transform: uppercase; font-size: 0.9rem; letter-spacing: 1px;}
        .raw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
        .raw-item { background: white; padding: 10px; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between;}
        .raw-item img { margin-bottom: 8px; box-shadow: none; border-radius: 6px;}
        .ios-tip { font-size: 0.75rem; color: #888; margin-top: -15px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Your Photos!</h1>
        <p class="subtitle">Event: ${eventCode.toUpperCase()}</p>
        ${videoFilename ? `
        <h3>Animated Live Video</h3>
        <video src="${videoFilename}" autoplay loop muted playsinline></video>
        <a href="${videoFilename}" download="${videoFilename}" class="download-btn">Download Video</a>
        ` : ''}
        <h3>Photobooth Strip</h3>
        <img src="photobooth_strip.jpg" alt="Photobooth Strip">
        <a href="photobooth_strip.jpg" download="photobooth_strip.jpg" class="download-btn">Download Strip</a>
        <p class="ios-tip">iPhone users: Tap & hold the image to "Save to Photos"</p>
        ${rawPhotosHtml ? `
        <h3>Individual Shots</h3>
        <div class="raw-grid">${rawPhotosHtml}</div>
        ` : ''}
    </div>
</body>
</html>`;

        await fs.writeFile(path.join(galleryDir, 'index.html'), htmlTemplate);
        
        // ADDED: Uploads the HTML template directly to your Cloudflare R2 Bucket
        await uploadToCloud(`events/${eventCode}/galleries/${sessionFolder}/index.html`, Buffer.from(htmlTemplate, 'utf8'), 'text/html');

        // Default to the Render/Local URL
        const baseUrl = process.env.PUBLIC_URL || globalTunnelUrl || `http://${getLocalIp()}:${PORT}`;
        let galleryUrl = `${baseUrl.replace(/\/$/, '')}/events/${eventCode}/galleries/${sessionFolder}/index.html`;

        // OVERRIDE: If R2 is active, force the QR code to point directly to permanent Cloudflare storage
        if (process.env.R2_PUBLIC_DOMAIN) {
            galleryUrl = `https://${process.env.R2_PUBLIC_DOMAIN.replace(/\/$/, '')}/events/${eventCode}/galleries/${sessionFolder}/index.html`;
        }

        let qrCodeDataUrl = '';
        try { qrCodeDataUrl = await QRCode.toDataURL(galleryUrl, { color: { dark: '#ff4d6d', light: '#ffffff' }, width: 400 }); } 
        catch (qrErr) { qrCodeDataUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='; }

        res.json({ success: true, qrCodeUrl: qrCodeDataUrl, galleryUrl });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/:eventCode/sessions', async (req, res) => {
    const eventCode = sanitizeEventCode(req.params.eventCode);
    try {
        const { galleriesDir } = await ensureEventDirs(eventCode);
        if (!existsSync(galleriesDir)) return res.json({ success: true, sessions: [] });
        const dirs = await fs.readdir(galleriesDir);
        const sessions = [];

        for (const dir of dirs) {
            const fullPath = path.join(galleriesDir, dir);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                const stripPath = path.join(fullPath, 'photobooth_strip.jpg');
                if (existsSync(stripPath)) {
                    const rawPhotos = [];
                    for (let i = 1; i <= 4; i++) {
                        if (existsSync(path.join(fullPath, `raw_photo_${i}.jpg`))) {
                            rawPhotos.push(`/events/${eventCode}/galleries/${dir}/raw_photo_${i}.jpg`);
                        }
                    }
                    let layout = '1x4';
                    if (existsSync(path.join(fullPath, 'layout.txt'))) {
                        layout = (await fs.readFile(path.join(fullPath, 'layout.txt'), 'utf8')).trim();
                    }
                    sessions.push({
                        id: dir,
                        strip: `/events/${eventCode}/galleries/${dir}/photobooth_strip.jpg`,
                        rawPhotos: rawPhotos,
                        layout: layout
                    });
                }
            }
        }

        sessions.sort((a, b) => b.id.localeCompare(a.id));
        res.json({ success: true, sessions });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/capture-dslr', async (req, res) => {
    const filename = `dslr_${Date.now()}.jpg`;
    const targetPath = path.join(TEMP_DIR, filename);
    const cmd = `"C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe" /capture /filename "${targetPath}"`;
    exec(cmd, async (error) => {
        try {
            const stats = await fs.stat(targetPath);
            if (stats.size > 0) res.json({ success: true, imageUrl: `/temp/${filename}` });
            else throw new Error("File empty.");
        } catch (err) { res.status(500).json({ success: false, error: 'DSLR failed.' }); }
    });
});

app.use('/temp', express.static(TEMP_DIR));

// ==========================================
// Event-Aware Frontend Routing (Fixed for Express 5)
// ==========================================

app.get('/e/:eventCode/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/e/:eventCode/gallery', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));

const frontendRoutes = [
    '/e/:eventCode',
    '/e/:eventCode/start',
    '/e/:eventCode/layout',
    '/e/:eventCode/preframe',
    '/e/:eventCode/photo',
    '/e/:eventCode/edit',
    '/e/:eventCode/qr'
];
app.get(frontendRoutes, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/admin', (req, res) => res.redirect('/e/default/admin'));
app.get('/gallery', (req, res) => res.redirect('/e/default/gallery'));
app.get(['/', '/start', '/layout', '/preframe', '/photo', '/edit', '/qr'], (req, res) => res.redirect('/e/default'));

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`===================================================`);
    console.log(`  Photobooth running on port: ${PORT}`);
    console.log(`===================================================`);
});