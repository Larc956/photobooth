const video = document.getElementById('webcam');
const timerDisplay = document.getElementById('timer-display');
const shotCounter = document.getElementById('shot-counter');
const previewStrip = document.getElementById('strip-preview');
const animatedStrip = document.getElementById('animated-strip');
const previewOverlay = document.getElementById('shot-preview-overlay');
const flashOverlay = document.getElementById('flash-overlay');
const recordingIndicator = document.getElementById('recording-indicator');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

let userLayout = '1x4';
let currentShotIndex = 0;
let totalShots = 8;
let shotsRequired = 4;
let photos = [];
let videoBlobs = []; 
let selectedPhotos = [];
let stream;
let timerInterval;
let currentMediaRecorder = null;
let currentFilter = 'none'; 
let outroTimer = null; 
let appSettings = {}; 
let currentStripColor = 'white';
let photoAdjustments = [];
let selectedPhotoIndex = null;
let activeFrameObj = 'none';
let captureMode = 'auto'; 

function getEventCode() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'e' && parts[1]) return parts[1].toLowerCase();
    return localStorage.getItem('photobooth_event_code') || 'default';
}

const currentEventCode = getEventCode();
localStorage.setItem('photobooth_event_code', currentEventCode);

function getApiPath(endpoint) {
    return `/api/${currentEventCode}/${endpoint.replace(/^\//, '')}`;
}

window.addEventListener('popstate', handleRoute);

function navigateTo(path) {
    window.history.pushState({}, '', `/e/${currentEventCode}${path}`);
    handleRoute();
}

function handleRoute() {
    const path = window.location.pathname;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    
    if (path.includes('/layout')) document.getElementById('layout-screen').classList.add('active');
    else if (path.includes('/preframe')) document.getElementById('preframe-screen').classList.add('active');
    else if (path.includes('/photo')) document.getElementById('capture-screen').classList.add('active');
    else if (path.includes('/edit')) document.getElementById('edit-screen').classList.add('active');
    else if (path.includes('/qr')) document.getElementById('qr-screen').classList.add('active');
    else document.getElementById('start-screen').classList.add('active');
}

window.onload = async () => {
    handleRoute();
    document.getElementById('event-badge').innerText = `Event: ${currentEventCode.toUpperCase()}`;

    try {
        const res = await fetch(getApiPath('settings'));
        let data = await res.json();
        
        ['1x3', '1x4', '2x2', '3x_grid'].forEach(mode => {
            let key = 'frames' + mode;
            if (data[key] && Array.isArray(data[key])) {
                data[key] = data[key].map(f => {
                    if (typeof f === 'string') return { layers: [{ type: 'overlay', url: f, x:0, y:0, w:100, h:100, r:0 }], coords: [] };
                    if (f.bg || f.overlay) {
                        let newLayers = [];
                        if (f.bg) newLayers.push({ type: 'bg', url: f.bg, x:0, y:0, w:100, h:100, r:0 });
                        if (f.overlay) newLayers.push({ type: 'overlay', url: f.overlay, x:0, y:0, w:100, h:100, r:0 });
                        return { layers: newLayers, coords: f.coords || [] };
                    }
                    return f;
                });
            }
        });

        appSettings = data;
        const root = document.documentElement;
        root.style.setProperty('--text-color', appSettings.textColor || '#ff4d6d');
        if (appSettings.bgImage) {
            document.body.style.backgroundImage = `url("${appSettings.bgImage}")`;
            document.body.style.backgroundSize = 'cover';
        }

        const enabledLayouts = [];
        if (appSettings.enable1x3) enabledLayouts.push('1x3');
        if (appSettings.enable1x4 !== false) enabledLayouts.push('1x4'); 
        if (appSettings.enable2x2) enabledLayouts.push('2x2');
        if (appSettings.enable3x_grid) enabledLayouts.push('3x_grid');
        if (enabledLayouts.length === 0) enabledLayouts.push('1x4');

        const card1x3 = document.getElementById('layout-card-1x3');
        const card1x4 = document.getElementById('layout-card-1x4');
        const card2x2 = document.getElementById('layout-card-2x2');
        const card3x_grid = document.getElementById('layout-card-3x_grid');

        if (card1x3) card1x3.style.display = enabledLayouts.includes('1x3') ? '' : 'none';
        if (card1x4) card1x4.style.display = enabledLayouts.includes('1x4') ? '' : 'none';
        if (card2x2) card2x2.style.display = enabledLayouts.includes('2x2') ? '' : 'none';
        if (card3x_grid) card3x_grid.style.display = enabledLayouts.includes('3x_grid') ? '' : 'none';

        const startBtn = document.getElementById('start-btn');
        if (startBtn) {
            startBtn.onclick = () => {
                if (enabledLayouts.length === 1) selectLayout(enabledLayouts[0]);
                else navigateTo('/layout');
            };
        }

        const urlParams = new URLSearchParams(window.location.search);
        const editSession = urlParams.get('session');
        const editLayout = urlParams.get('layout');

        if (editSession) {
            try {
                const resSession = await fetch(getApiPath('sessions'));
                const sessionData = await resSession.json();
                const session = sessionData.sessions.find(s => s.id === editSession);
                
                if (session && session.rawPhotos && session.rawPhotos.length > 0) {
                    photos = session.rawPhotos; 
                    shotsRequired = photos.length;
                    userLayout = editLayout || (shotsRequired === 3 ? '1x3' : '1x4');
                    document.getElementById('loading-overlay').classList.add('hidden');
                    setTimeout(() => { proceedToEdit(); }, 400);
                    return;
                }
            } catch (e) { console.error("Session load error:", e); }
        }
    } catch (e) { console.error("Settings load error:", e); }

    const cameraSelect = document.getElementById('camera-select');
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
        tempStream.getTracks().forEach(track => track.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        let targetDeviceId = appSettings.defaultCameraId || "";
        if (!targetDeviceId) {
            const canonOrCapture = videoDevices.find(d => 
                d.label.includes('EOS Webcam') || d.label.includes('USB Video') || d.label.includes('Capture')
            );
            if (canonOrCapture) targetDeviceId = canonOrCapture.deviceId;
            else if (videoDevices.length > 0) targetDeviceId = videoDevices[0].deviceId;
        }

        if (cameraSelect) {
            cameraSelect.innerHTML = videoDevices.map(d => 
                `<option value="${d.deviceId}" ${d.deviceId === targetDeviceId ? 'selected' : ''}>${d.label || 'Camera'}</option>`
            ).join('');
        }
    } catch (err) {
        if (cameraSelect) cameraSelect.innerHTML = '<option value="">Default Web Camera</option>';
    }
};

function selectLayout(layoutChoice) {
    userLayout = layoutChoice;
    shotsRequired = (userLayout === '1x3' || userLayout === '3x_grid') ? 3 : 4;
    totalShots = Math.max(shotsRequired, appSettings.totalShots || 8);
    buildPreframeSelector();
    navigateTo('/preframe');
}

function setCaptureMode(mode) {
    captureMode = mode;
    document.getElementById('mode-auto').classList.remove('active');
    document.getElementById('mode-manual').classList.remove('active');
    document.getElementById(`mode-${mode}`).classList.add('active');
}

function buildPreframeSelector() {
    const container = document.getElementById('preframe-options-container');
    container.innerHTML = '';

    const framesArray = appSettings['frames' + userLayout] || [];

    const noFrameCard = document.createElement('div');
    noFrameCard.className = 'preframe-card active';
    noFrameCard.innerHTML = `<div class="preframe-thumb" style="background:#eee; display:flex; align-items:center; justify-content:center; font-weight:bold;">No Frame</div><p>Minimal Plain</p>`;
    noFrameCard.onclick = () => {
        document.querySelectorAll('.preframe-card').forEach(c => c.classList.remove('active'));
        noFrameCard.classList.add('active');
        activeFrameObj = 'none';
    };
    container.appendChild(noFrameCard);

    if (framesArray && framesArray.length > 0) {
        framesArray.forEach((fObj, i) => {
            const card = document.createElement('div');
            card.className = 'preframe-card';
            let thumb = '';
            if (fObj.layers && fObj.layers.length > 0) {
                const top = fObj.layers.find(l => l.type === 'overlay') || fObj.layers[0];
                thumb = top.url;
            }
            card.innerHTML = `<div class="preframe-thumb" style="background-image:url('${thumb}');"></div><p>Frame ${i + 1}</p>`;
            card.onclick = () => {
                document.querySelectorAll('.preframe-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                activeFrameObj = fObj;
            };
            container.appendChild(card);
        });
        if (container.children[1]) container.children[1].click();
    }
}

function confirmFrameAndStartCamera() {
    navigateTo('/photo');
    renderCaptureLiveOverlay();
    startCamera();
}

function renderCaptureLiveOverlay() {
    const overlayContainer = document.getElementById('capture-live-overlay');
    overlayContainer.innerHTML = '';
    
    if (activeFrameObj && activeFrameObj !== 'none' && activeFrameObj.layers) {
        const topLayers = activeFrameObj.layers.filter(l => l.type === 'overlay');
        topLayers.forEach(l => {
            const img = document.createElement('img');
            img.src = l.url;
            overlayContainer.appendChild(img);
        });
    }
}

function updateLiveOverlayPosition() {
    const overlayImgs = document.querySelectorAll('#capture-live-overlay img');
    const cameraContainer = document.getElementById('camera-container');

    if (!overlayImgs.length || !activeFrameObj || activeFrameObj === 'none' || !activeFrameObj.coords) {
        cameraContainer.style.aspectRatio = "16 / 9";
        overlayImgs.forEach(img => img.style.display = 'none');
        return;
    }

    const shotsPerHole = Math.max(1, Math.floor(totalShots / shotsRequired));
    const currentHoleIndex = Math.min(shotsRequired - 1, Math.floor(currentShotIndex / shotsPerHole));
    const box = activeFrameObj.coords[currentHoleIndex];

    if (box) {
        let frameAspect = 2 / 6; 
        if (userLayout === '2x2') frameAspect = 4 / 6;
        if (userLayout === '3x_grid') frameAspect = 6 / 4;
        
        const holeAspect = frameAspect * (box.w / box.h);
        cameraContainer.style.aspectRatio = holeAspect;

        overlayImgs.forEach(img => {
            img.style.display = 'block';
            img.style.width = `${10000 / box.w}%`;
            img.style.height = `${10000 / box.h}%`;
            img.style.transform = `translate(${-box.x}%, ${-box.y}%)`;
        });
    }
}

async function startCamera() {
    try {
        if (typeof stream !== 'undefined' && stream) stream.getTracks().forEach(track => track.stop());
        
        const selectedCameraId = document.getElementById('camera-select').value;
        const constraints = {
            video: selectedCameraId ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
        };
        try { stream = await navigator.mediaDevices.getUserMedia(constraints); } 
        catch { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
        
        video.srcObject = stream;
        currentShotIndex = 0; 
        photos = []; 
        videoBlobs = []; 
        selectedPhotos = [];
        shotCounter.innerText = 1;
        document.getElementById('total-shots-counter').innerText = totalShots;
        
        updateLiveOverlayPosition();

        if (captureMode === 'auto') {
            document.getElementById('manual-capture-btn').classList.add('hidden');
            startTimer(appSettings.captureTimer || 5);
        } else {
            document.getElementById('timer-display').classList.add('hidden');
            document.getElementById('manual-capture-btn').classList.remove('hidden');
        }
    } catch (err) { alert(`Cannot access camera: ${err.message}`); }
}

function triggerManualShot() {
    document.getElementById('manual-capture-btn').classList.add('hidden');
    startTimer(3); 
}

function startTimer(seconds) {
    timerDisplay.innerText = seconds; 
    timerDisplay.classList.remove('hidden');
    if (video.paused) video.play();

    let chunks = [];
    currentMediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    currentMediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    
    const thisIndex = currentShotIndex; 
    currentMediaRecorder.onstop = () => { videoBlobs[thisIndex] = new Blob(chunks, { type: 'video/webm' }); };
    
    currentMediaRecorder.start();
    recordingIndicator.classList.remove('hidden');

    timerInterval = setInterval(() => {
        seconds--;
        if (seconds > 0) { 
            timerDisplay.innerText = seconds; 
        } else { 
            clearInterval(timerInterval); 
            takePhoto(); 
        }
    }, 1000);
}

async function takePhoto() {
    timerDisplay.classList.add('hidden');
    
    if (document.getElementById('flash-toggle').checked) {
        flashOverlay.classList.add('flash');
        setTimeout(() => flashOverlay.classList.remove('flash'), 150);
    }

    if (currentMediaRecorder && currentMediaRecorder.state === "recording") {
        currentMediaRecorder.stop();
        recordingIndicator.classList.add('hidden');
    }

    let webcamSnapshot = '';
    if (video.videoWidth > 0 && video.videoHeight > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; 
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        webcamSnapshot = canvas.toDataURL('image/jpeg', 0.95);
    } else {
        webcamSnapshot = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='; 
    }

    document.getElementById('total-shots-counter').innerText = "Processing...";
    if (appSettings.cameraMode === 'dslr') {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const response = await fetch('/api/capture-dslr', { method: 'POST', signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.success && data.imageUrl) {
                photos.push(data.imageUrl);
                previewOverlay.src = data.imageUrl;
            } else throw new Error("DSLR misfire");
        } catch (err) {
            photos.push(webcamSnapshot);
            previewOverlay.src = webcamSnapshot;
        }
    } else {
        photos.push(webcamSnapshot);
        previewOverlay.src = webcamSnapshot;
    }

    previewOverlay.classList.remove('hidden');
    currentShotIndex++;

    setTimeout(() => {
        previewOverlay.classList.add('hidden');
        if (currentShotIndex < totalShots) {
            shotCounter.innerText = currentShotIndex + 1;
            document.getElementById('total-shots-counter').innerText = totalShots;
            
            updateLiveOverlayPosition();

            if (captureMode === 'auto') {
                startTimer(appSettings.captureTimer || 5);
            } else {
                document.getElementById('manual-capture-btn').classList.remove('hidden');
            }
        } else {
            if (stream) stream.getTracks().forEach(track => track.stop());
            proceedToEdit();
        }
    }, 2500);
}

function proceedToEdit() {
    loadMarginPresets();
    
    selectedPhotos = [];
    const shotsPerHole = Math.max(1, Math.floor(totalShots / shotsRequired));
    for (let i = 0; i < shotsRequired; i++) {
        const rawIndex = i * shotsPerHole;
        if (photos[rawIndex]) selectedPhotos.push(rawIndex);
    }

    photoAdjustments = [];
    for (let i = 0; i < 4; i++) {
        photoAdjustments.push({ scale: 1, x: 0, y: 0, rotate: 0, flipH: true, flipV: false, shape: 'basic' });
    }
    
    if (shotsRequired === 3) {
        document.getElementById('slot-tab-3').style.display = 'none';
    } else {
        document.getElementById('slot-tab-3').style.display = '';
    }

    buildPhotoTray();

    selectedPhotos.forEach((photoIndex, uiIndex) => {
        document.getElementById(`preview-${uiIndex + 1}`).src = photos[photoIndex];
        const vidEl = document.getElementById(`vid-${uiIndex + 1}`);
        if (videoBlobs[photoIndex]) {
            vidEl.src = URL.createObjectURL(videoBlobs[photoIndex]);
            vidEl.play().catch(() => {});
        }
    });

    for (let i = 1; i <= 4; i++) {
        document.getElementById(`cell-${i}`).style.display = 'block';
        document.getElementById(`vid-cell-${i}`).style.display = 'block';
    }

    previewStrip.className = 'strip';
    animatedStrip.className = 'strip';
    if (userLayout === '1x3') {
        document.getElementById('cell-4').style.display = 'none';
        document.getElementById('vid-cell-4').style.display = 'none';
    } else if (userLayout === '2x2') {
        previewStrip.classList.add('grid-mode');
        animatedStrip.classList.add('grid-mode');
    } else if (userLayout === '3x_grid') {
        document.getElementById('cell-4').style.display = 'none';
        document.getElementById('vid-cell-4').style.display = 'none';
        previewStrip.classList.add('m-3x_grid');
        animatedStrip.classList.add('m-3x_grid');
    }

    document.querySelectorAll('.sticker-wrapper').forEach(el => el.remove());
    applyPhotoAdjustmentsUI();
    loadFrameOptions(); 
    loadStickers();
    selectPhoto(0);
    applyFrame(activeFrameObj); 
    navigateTo('/edit');
}

function buildPhotoTray() {
    const tray = document.getElementById('photo-tray');
    tray.innerHTML = '';
    photos.forEach((p, rawIndex) => {
        const img = document.createElement('img');
        img.src = p;
        img.className = 'tray-photo';
        if (selectedPhotos.includes(rawIndex)) img.classList.add('in-use');

        img.onclick = () => {
            if (selectedPhotoIndex !== null) {
                selectedPhotos[selectedPhotoIndex] = rawIndex;
                document.getElementById(`preview-${selectedPhotoIndex + 1}`).src = p;
                const vidEl = document.getElementById(`vid-${selectedPhotoIndex + 1}`);
                if (videoBlobs[rawIndex]) {
                    vidEl.src = URL.createObjectURL(videoBlobs[rawIndex]);
                    vidEl.play().catch(() => {});
                }
                document.querySelectorAll('.tray-photo').forEach((el, i) => {
                    if (selectedPhotos.includes(i)) el.classList.add('in-use');
                    else el.classList.remove('in-use');
                });
                adjustPhoto('reset', null);
            }
        };
        tray.appendChild(img);
    });
}

function loadMarginPresets() {
    const container = document.getElementById('margin-selector-container');
    const group = document.getElementById('margin-preset-group');
    container.innerHTML = '';

    let presets = appSettings.marginPresets ? appSettings.marginPresets[userLayout] : null;
    if (!presets || presets.length === 0) {
        const fallback = appSettings[`layout${userLayout}`] || { paddingTop: 20, paddingBottom: 60, paddingSide: 20, gap: 15 };
        presets = [{ name: 'Default', top: fallback.paddingTop, bot: fallback.paddingBottom, side: fallback.paddingSide, gap: fallback.gap }];
    }
    presets.forEach((preset, index) => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn margin-option-btn';
        btn.innerText = preset.name;
        btn.onclick = () => {
            document.querySelectorAll('.margin-option-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyMarginPreset(preset);
        };
        container.appendChild(btn);
        if (index === 0) btn.click();
    });
    group.style.display = presets.length > 0 ? 'block' : 'none';
}

function applyMarginPreset(preset) {
    const root = document.documentElement;
    root.style.setProperty('--strip-padding-top', `${preset.top}px`);
    root.style.setProperty('--strip-padding-bottom', `${preset.bot}px`);
    root.style.setProperty('--strip-padding-side', `${preset.side}px`);
    root.style.setProperty('--strip-gap', `${preset.gap}px`);
}

function selectPhoto(index) {
    selectedPhotoIndex = index;
    document.querySelectorAll('.photo-cell').forEach(c => c.classList.remove('selected'));
    
    if (index !== null) {
        document.getElementById(`cell-${index + 1}`).classList.add('selected');
        document.getElementById(`vid-cell-${index + 1}`).classList.add('selected');
        document.getElementById('photo-adjust-group').style.display = 'block';

        let currentRot = photoAdjustments[index].rotate;
        document.getElementById('custom-rot-slider').value = currentRot;
        document.getElementById('custom-rot-input').value = currentRot;

        document.querySelectorAll('.slot-tab-btn').forEach(btn => btn.classList.remove('active'));
        const tab = document.getElementById(`slot-tab-${index}`);
        if (tab) tab.classList.add('active');

        document.querySelectorAll('.shape-btn').forEach(btn => btn.classList.remove('active'));
        const currentShape = photoAdjustments[index].shape || 'basic';
        const shapeBtn = document.getElementById(`shape-btn-${currentShape}`);
        if (shapeBtn) shapeBtn.classList.add('active');
    } else {
        document.getElementById('photo-adjust-group').style.display = 'none';
    }
}

function setSlotShape(shape) {
    if (selectedPhotoIndex === null) return;
    photoAdjustments[selectedPhotoIndex].shape = shape;
    applyPhotoAdjustmentsUI();
    
    document.querySelectorAll('.shape-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`shape-btn-${shape}`).classList.add('active');
}

function adjustPhoto(action, value) {
    if (selectedPhotoIndex === null) return;
    let adj = photoAdjustments[selectedPhotoIndex];

    if (action === 'zoom') adj.scale = Math.max(0.2, adj.scale + value);
    if (action === 'panX') adj.x += value;
    if (action === 'panY') adj.y += value;
    if (action === 'rotate') adj.rotate = (adj.rotate + value) % 360;
    if (action === 'setRotate') adj.rotate = parseFloat(value) || 0;
    if (action === 'flipH') adj.flipH = !adj.flipH;
    if (action === 'flipV') adj.flipV = !adj.flipV;
    if (action === 'reset') {
        adj.scale = 1; adj.x = 0; adj.y = 0; adj.rotate = 0; adj.flipH = true; adj.flipV = false; adj.shape = 'basic';
        document.querySelectorAll('.shape-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById(`shape-btn-basic`).classList.add('active');
    }

    document.getElementById('custom-rot-slider').value = adj.rotate;
    document.getElementById('custom-rot-input').value = adj.rotate;
    applyPhotoAdjustmentsUI();
}

function applyPhotoAdjustmentsUI() {
    for (let i = 0; i < 4; i++) {
        let adj = photoAdjustments[i];
        let transformStr = `translate(${adj.x}%, ${adj.y}%) scale(${adj.scale}) rotate(${adj.rotate}deg) scaleX(${adj.flipH ? -1 : 1}) scaleY(${adj.flipV ? -1 : 1})`;
        
        let cell = document.getElementById(`cell-${i+1}`);
        let vidCell = document.getElementById(`vid-cell-${i+1}`);
        
        cell.className = `photo-cell ${selectedPhotoIndex === i ? 'selected' : ''}`;
        vidCell.className = `photo-cell ${selectedPhotoIndex === i ? 'selected' : ''}`;
        
        if (adj.shape && adj.shape !== 'basic') {
            cell.classList.add(`shape-${adj.shape}`);
            vidCell.classList.add(`shape-${adj.shape}`);
        }
        
        document.getElementById(`preview-${i+1}`).style.transform = transformStr;
        document.getElementById(`vid-${i+1}`).style.transform = transformStr;
    }
}

function loadFrameOptions() {
    const container = document.getElementById('frame-selector-container');
    container.innerHTML = '';

    const noFrameBtn = document.createElement('button');
    noFrameBtn.className = 'filter-btn frame-option-btn';
    noFrameBtn.innerText = 'No Frame';
    noFrameBtn.onclick = () => {
        document.querySelectorAll('.frame-option-btn').forEach(b => b.classList.remove('active'));
        noFrameBtn.classList.add('active');
        applyFrame('none');
    };
    container.appendChild(noFrameBtn);

    const framesArray = appSettings['frames' + userLayout] || [];
    if (framesArray && framesArray.length > 0) {
        framesArray.forEach((frameObj) => {
            const btn = document.createElement('button');
            btn.className = 'frame-option-btn';
            let thumbUrl = '';
            if (frameObj.layers && frameObj.layers.length > 0) {
                let topLayer = frameObj.layers.find(l => l.type === 'overlay') || frameObj.layers[0];
                thumbUrl = topLayer.url;
            }
            btn.style.backgroundImage = `url("${thumbUrl}")`;
            btn.style.backgroundSize = 'contain';
            btn.style.backgroundPosition = 'center';
            btn.style.backgroundRepeat = 'no-repeat';

            btn.onclick = () => {
                document.querySelectorAll('.frame-option-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyFrame(frameObj);
            };
            container.appendChild(btn);

            if (activeFrameObj === frameObj) {
                btn.classList.add('active');
            }
        });
    }
}

function loadStickers() {
    const container = document.getElementById('sticker-selector-container');
    container.innerHTML = '';
    if (appSettings.stickers && appSettings.stickers.length > 0) {
        appSettings.stickers.forEach(url => {
            const btn = document.createElement('button');
            btn.className = 'sticker-btn';
            btn.style.backgroundImage = `url("${url}")`;
            btn.style.backgroundSize = 'contain';
            btn.style.backgroundPosition = 'center';
            btn.style.backgroundRepeat = 'no-repeat';
            btn.onclick = () => addSticker(url);
            container.appendChild(btn);
        });
    }
}

function addSticker(url) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sticker-wrapper';
    wrapper.style.left = '20px'; 
    wrapper.style.top = '20px';
    wrapper.style.width = '80px';

    const img = document.createElement('img');
    img.src = url;
    img.className = 'sticker-img';

    wrapper.appendChild(img);
    document.getElementById('strip-preview').appendChild(wrapper);
    makeDraggableAndResizable(wrapper);
}

function makeDraggableAndResizable(el) {
    let isDragging = false, isResizing = false, isRotating = false;
    let startX, startY, startW, startLeft, startTop, startAngle = 0;

    const imgEl = el.querySelector('.sticker-img');
    let currentRotation = parseFloat(imgEl.getAttribute('data-rotation')) || 0;
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'sticker-delete';
    deleteBtn.innerHTML = '✕';
    deleteBtn.onclick = () => el.remove();
    el.appendChild(deleteBtn);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sticker-resize';
    el.appendChild(resizeHandle);

    const rotateHandle = document.createElement('div');
    rotateHandle.className = 'sticker-rotate';
    el.appendChild(rotateHandle);

    let centerX, centerY;
    el.addEventListener('pointerdown', (e) => {
        if (e.target === deleteBtn) return;
        e.preventDefault();
        startX = e.clientX; startY = e.clientY;
        startLeft = el.offsetLeft; startTop = el.offsetTop;
        startW = el.offsetWidth;

        if (e.target === resizeHandle) isResizing = true;
        else if (e.target === rotateHandle) {
            isRotating = true;
            const rect = el.getBoundingClientRect();
            centerX = rect.left + rect.width / 2;
            centerY = rect.top + rect.height / 2;
            startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) - (currentRotation * Math.PI / 180);
        } else isDragging = true;

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    });

    function onMove(e) {
        if (isDragging) {
            el.style.left = startLeft + (e.clientX - startX) + 'px';
            el.style.top = startTop + (e.clientY - startY) + 'px';
        } else if (isResizing) {
            el.style.width = startW + (e.clientX - startX) + 'px';
        } else if (isRotating) {
            const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
            currentRotation = (angle - startAngle) * 180 / Math.PI;
            imgEl.style.transform = `rotate(${currentRotation}deg)`;
            imgEl.setAttribute('data-rotation', currentRotation);
        }
    }

    function onUp() {
        isDragging = false; isResizing = false; isRotating = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
    }
}

function setStripColor(color) {
    currentStripColor = color; 
    previewStrip.style.backgroundColor = color;
    animatedStrip.style.backgroundColor = color;
}

function buildLayersInDOM(containerId, layersArray) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (!layersArray) return;
    layersArray.forEach(l => {
        let img = document.createElement('img');
        img.src = l.url;
        img.style = `position:absolute; left:${l.x}%; top:${l.y}%; width:${l.w}%; height:${l.h}%; transform:rotate(${l.r}deg); pointer-events:none; z-index: ${l.type === 'bg' ? 0 : 20}; border-radius:5px;`;
        container.appendChild(img);
    });
}

function applyFrame(frameObj) {
    activeFrameObj = frameObj;
    const shapeGroup = document.getElementById('frame-shape-group');
    if (frameObj === 'none' || !frameObj) {
        document.getElementById('static-frame-bg').innerHTML = '';
        document.getElementById('animated-frame-bg').innerHTML = '';
        
        // ADDED: Clear the overlays too
        document.getElementById('static-frame-overlay').innerHTML = '';
        document.getElementById('animated-frame-overlay').innerHTML = '';

        setStripColor(currentStripColor);
        previewStrip.classList.remove('absolute-mode');
        animatedStrip.classList.remove('absolute-mode');
        
        if (shapeGroup) shapeGroup.style.display = 'block';
        for (let i = 1; i <= 4; i++) {
            let p1 = document.getElementById(`cell-${i}`);
            let v1 = document.getElementById(`vid-cell-${i}`);
            p1.style.left = ''; p1.style.top = ''; p1.style.width = ''; p1.style.height = ''; p1.style.transform = '';
            v1.style.left = ''; v1.style.top = ''; v1.style.width = ''; v1.style.height = ''; v1.style.transform = '';
            p1.removeAttribute('data-cell-rot'); p1.removeAttribute('data-cell-x'); p1.removeAttribute('data-cell-y'); p1.removeAttribute('data-cell-w'); p1.removeAttribute('data-cell-h');
        }
    } else {
        if (shapeGroup) shapeGroup.style.display = 'none';
        photoAdjustments.forEach(adj => adj.shape = 'basic');
        applyPhotoAdjustmentsUI();

        // CHANGED: Filter layers and route them to the correct background or overlay DOM elements
        const bgLayers = frameObj.layers.filter(l => l.type === 'bg');
        const overlayLayers = frameObj.layers.filter(l => l.type === 'overlay');

        buildLayersInDOM('static-frame-bg', bgLayers);
        buildLayersInDOM('animated-frame-bg', bgLayers);
        
        buildLayersInDOM('static-frame-overlay', overlayLayers);
        buildLayersInDOM('animated-frame-overlay', overlayLayers);

        setStripColor(currentStripColor);
        if (frameObj.coords && frameObj.coords.length > 0) {
            previewStrip.classList.add('absolute-mode');
            animatedStrip.classList.add('absolute-mode');
            const coords = frameObj.coords;
            for (let i = 0; i < shotsRequired; i++) {
                const p1 = document.getElementById(`cell-${i+1}`);
                const v1 = document.getElementById(`vid-cell-${i+1}`);
                if (!coords[i]) {
                    p1.style.display = 'none'; v1.style.display = 'none';
                    continue;
                }
                p1.style.display = 'block'; v1.style.display = 'block';
                p1.style.left = `${coords[i].x}%`; p1.style.top = `${coords[i].y}%`; 
                p1.style.width = `${coords[i].w}%`; p1.style.height = `${coords[i].h}%`;
                v1.style.left = `${coords[i].x}%`; v1.style.top = `${coords[i].y}%`; 
                v1.style.width = `${coords[i].w}%`; v1.style.height = `${coords[i].h}%`;
                
                let rot = coords[i].r || 0;
                p1.style.transform = `rotate(${rot}deg)`;
                v1.style.transform = `rotate(${rot}deg)`;
                p1.setAttribute('data-cell-rot', rot);
                p1.setAttribute('data-cell-x', coords[i].x);
                p1.setAttribute('data-cell-y', coords[i].y);
                p1.setAttribute('data-cell-w', coords[i].w);
                p1.setAttribute('data-cell-h', coords[i].h);
            }
        } else {
            previewStrip.classList.remove('absolute-mode');
            animatedStrip.classList.remove('absolute-mode');
            for (let i = 1; i <= 4; i++) {
                let p1 = document.getElementById(`cell-${i}`);
                let v1 = document.getElementById(`vid-cell-${i}`);
                p1.style.left = ''; p1.style.top = ''; p1.style.width = ''; p1.style.height = ''; p1.style.transform = '';
                v1.style.left = ''; v1.style.top = ''; v1.style.width = ''; v1.style.height = ''; v1.style.transform = '';
                p1.removeAttribute('data-cell-rot'); p1.removeAttribute('data-cell-x');
            }
        }
    }
}

function applyFilter(f) { 
    currentFilter = f; 
    document.querySelectorAll('.shot-preview').forEach(el => el.style.filter = f); 
}

// -------------------------------------------------------------
// Proportional Canvas Shapes (Stretched Full width/height)
// -------------------------------------------------------------
function buildShapePath(ctx, shape, w, h) {
    const scaleX = (val) => (val - 50) * (w / 100);
    const scaleY = (val) => (val - 50) * (h / 100);

    ctx.beginPath();
    if (shape === 'circle') {
        ctx.ellipse(0, 0, 50 * (w/100), 50 * (h/100), 0, 0, Math.PI * 2);
    } else if (shape === 'star') {
        ctx.moveTo(scaleX(50), scaleY(0));
        ctx.lineTo(scaleX(63), scaleY(38)); 
        ctx.lineTo(scaleX(100), scaleY(38)); 
        ctx.lineTo(scaleX(69), scaleY(59));
        ctx.lineTo(scaleX(81), scaleY(100)); 
        ctx.lineTo(scaleX(50), scaleY(75)); 
        ctx.lineTo(scaleX(19), scaleY(100));
        ctx.lineTo(scaleX(31), scaleY(59)); 
        ctx.lineTo(scaleX(0), scaleY(38)); 
        ctx.lineTo(scaleX(37), scaleY(38));
    } else if (shape === 'heart') {
        ctx.moveTo(scaleX(50), scaleY(95));
        ctx.bezierCurveTo(scaleX(50), scaleY(95), scaleX(0), scaleY(60), scaleX(0), scaleY(30));
        ctx.bezierCurveTo(scaleX(0), scaleY(10), scaleX(25), scaleY(-5), scaleX(50), scaleY(15));
        ctx.bezierCurveTo(scaleX(75), scaleY(-5), scaleX(100), scaleY(10), scaleX(100), scaleY(30));
        ctx.bezierCurveTo(scaleX(100), scaleY(60), scaleX(50), scaleY(95), scaleX(50), scaleY(95));
    } else {
        ctx.rect(-w/2, -h/2, w, h);
    }
    ctx.closePath();
}

async function drawStickersToCanvas(ctx, scaleX, scaleY, stripRect) {
    const stickers = document.querySelectorAll('#strip-preview .sticker-wrapper');
    for (let st of stickers) {
        const imgEl = st.querySelector('img');
        const rect = st.getBoundingClientRect();
        const x = (rect.left - stripRect.left) * scaleX;
        const y = (rect.top - stripRect.top) * scaleY;
        const w = rect.width * scaleX;
        const h = rect.height * scaleY;
        const rotation = parseFloat(imgEl.getAttribute('data-rotation')) || 0;

        const htmlImg = new Image(); 
        htmlImg.crossOrigin = "Anonymous";
        await new Promise(r => { htmlImg.onload = r; htmlImg.onerror = r; htmlImg.src = imgEl.src; });

        ctx.save();
        ctx.translate(x + w/2, y + h/2);
        ctx.rotate(rotation * Math.PI / 180);
        try { ctx.drawImage(htmlImg, -w/2, -h/2, w, h); } catch (e) {}
        ctx.restore();
    }
}

async function preloadFrameLayers(frameObj) {
    if (!frameObj || frameObj === 'none' || !frameObj.layers) return [];
    return Promise.all(frameObj.layers.map(async (l) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = l.url; });
        return { ...l, img };
    }));
}

async function generateCompositeImage() {
    selectPhoto(null);
    const stripEl = document.getElementById('strip-preview');
    const canvas = document.createElement('canvas');
    if (userLayout === '3x_grid') { canvas.width = 1800; canvas.height = 1200; }
    else if (userLayout === '2x2') { canvas.width = 1200; canvas.height = 1800; }
    else { canvas.width = 600; canvas.height = 1800; }

    const ctx = canvas.getContext('2d');
    const scaleX = canvas.width / stripEl.offsetWidth;
    const scaleY = canvas.height / stripEl.offsetHeight;

    ctx.fillStyle = stripEl.style.backgroundColor || '#ffffff';
    if (ctx.fillStyle === 'transparent' || ctx.fillStyle === 'rgba(0, 0, 0, 0)') {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const preloadedLayers = await preloadFrameLayers(activeFrameObj);
    const bgLayers = preloadedLayers.filter(l => l.type === 'bg');
    const overlayLayers = preloadedLayers.filter(l => l.type === 'overlay');

    bgLayers.forEach(l => {
        ctx.save();
        ctx.translate((l.x/100)*canvas.width + (l.w/100)*canvas.width/2, (l.y/100)*canvas.height + (l.h/100)*canvas.height/2);
        ctx.rotate(l.r * Math.PI / 180);
        try { ctx.drawImage(l.img, -(l.w/100)*canvas.width/2, -(l.h/100)*canvas.height/2, (l.w/100)*canvas.width, (l.h/100)*canvas.height); } catch (e) {}
        ctx.restore();
    });

    const cells = document.querySelectorAll('#strip-preview .photo-cell');
    const stripRect = stripEl.getBoundingClientRect();
    const isAbsolute = previewStrip.classList.contains('absolute-mode');

    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const img = cell.querySelector('.shot-preview');
        if (!img.src || img.src === window.location.href || cell.style.display === 'none' || cell.classList.contains('hidden')) continue;

        let x, y, w, h, cellRot = 0;
        if (isAbsolute && cell.hasAttribute('data-cell-x')) {
            w = (parseFloat(cell.getAttribute('data-cell-w')) / 100) * canvas.width;
            h = (parseFloat(cell.getAttribute('data-cell-h')) / 100) * canvas.height;
            x = (parseFloat(cell.getAttribute('data-cell-x')) / 100) * canvas.width;
            y = (parseFloat(cell.getAttribute('data-cell-y')) / 100) * canvas.height;
            cellRot = parseFloat(cell.getAttribute('data-cell-rot')) || 0;
        } else {
            const rect = cell.getBoundingClientRect();
            x = (rect.left - stripRect.left) * scaleX;
            y = (rect.top - stripRect.top) * scaleY;
            w = rect.width * scaleX;
            h = rect.height * scaleY;
        }

        const rawImg = new Image(); 
        rawImg.crossOrigin = "Anonymous";
        await new Promise(r => { rawImg.onload = r; rawImg.onerror = r; rawImg.src = img.src; });

        // Bake filter into an offscreen canvas to prevent clipping bugs
        const offCanvas = document.createElement('canvas');
        offCanvas.width = rawImg.width;
        offCanvas.height = rawImg.height;
        const offCtx = offCanvas.getContext('2d');
        if (currentFilter && currentFilter !== 'none') offCtx.filter = currentFilter;
        offCtx.drawImage(rawImg, 0, 0);

        const htmlImg = offCanvas;
        let imgAspect = htmlImg.width / htmlImg.height;
        let cellAspect = w / h;
        let drawW, drawH, drawX, drawY;

        let isRotated = photoAdjustments[i].rotate % 180 !== 0;
        if (isRotated) imgAspect = htmlImg.height / htmlImg.width;

        if (imgAspect > cellAspect) {
            drawH = h; drawW = h * imgAspect;
            drawX = (w - drawW) / 2; drawY = 0;
        } else {
            drawW = w; drawH = w / imgAspect;
            drawX = 0; drawY = (h - drawH) / 2;
        }

        ctx.save();
        ctx.translate(x + w/2, y + h/2);
        ctx.rotate(cellRot * Math.PI / 180);
        
        // No stroke outline is drawn
        buildShapePath(ctx, photoAdjustments[i].shape, w, h);
        ctx.clip();

        let adj = photoAdjustments[i];
        ctx.translate((adj.x / 100) * w, (adj.y / 100) * h);
        ctx.scale(adj.scale, adj.scale);
        ctx.rotate(adj.rotate * Math.PI / 180);
        ctx.scale(adj.flipH ? -1 : 1, adj.flipV ? -1 : 1);
        try {
            ctx.drawImage(htmlImg, isRotated ? drawX - h/2 : drawX - w/2, isRotated ? drawY - w/2 : drawY - h/2, isRotated ? drawH : drawW, isRotated ? drawW : drawH);
        } catch (e) {}
        ctx.restore(); 

        ctx.filter = 'none';
    }

    overlayLayers.forEach(l => {
        ctx.save();
        ctx.translate((l.x/100)*canvas.width + (l.w/100)*canvas.width/2, (l.y/100)*canvas.height + (l.h/100)*canvas.height/2);
        ctx.rotate(l.r * Math.PI / 180);
        try { ctx.drawImage(l.img, -(l.w/100)*canvas.width/2, -(l.h/100)*canvas.height/2, (l.w/100)*canvas.width, (l.h/100)*canvas.height); } catch (e) {}
        ctx.restore();
    });

    await drawStickersToCanvas(ctx, scaleX, scaleY, stripRect);
    return canvas.toDataURL('image/jpeg', 0.95);
}

function createAnimatedStripVideo() {
    return new Promise(async (resolve) => {
        const stripEl = document.getElementById('animated-strip');
        const printStripEl = document.getElementById('strip-preview'); 
        const canvas = document.createElement('canvas');

        if (userLayout === '3x_grid') { canvas.width = 1800; canvas.height = 1200; }
        else if (userLayout === '2x2') { canvas.width = 1200; canvas.height = 1800; }
        else { canvas.width = 600; canvas.height = 1800; }

        canvas.style.position = 'fixed'; 
        canvas.style.top = '-9999px';
        canvas.style.opacity = '0.01'; 
        canvas.style.pointerEvents = 'none';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const scaleX = canvas.width / printStripEl.offsetWidth;
        const scaleY = canvas.height / printStripEl.offsetHeight;
        const isAbsolute = previewStrip.classList.contains('absolute-mode');

        if (!canvas.captureStream) {
            document.body.removeChild(canvas);
            return resolve({ blob: null, extension: 'mp4' });
        }

        const videos = [
            document.getElementById('vid-1'),
            document.getElementById('vid-2'),
            document.getElementById('vid-3'),
            document.getElementById('vid-4')
        ];

        const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
        const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const stream = canvas.captureStream(30);
        let recorder;

        try { recorder = new MediaRecorder(stream, { mimeType: mimeType }); } 
        catch (e) {
            try { recorder = new MediaRecorder(stream); }
            catch (e2) { 
                document.body.removeChild(canvas); 
                return resolve({ blob: null, extension: 'mp4' }); 
            }
        }

        let chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => { 
            document.body.removeChild(canvas); 
            resolve({ blob: new Blob(chunks, { type: mimeType }), extension: extension }); 
        };

        const preloadedLayers = await preloadFrameLayers(activeFrameObj);
        const bgLayers = preloadedLayers.filter(l => l.type === 'bg');
        const overlayLayers = preloadedLayers.filter(l => l.type === 'overlay');

        videos.forEach(v => { v.currentTime = 0; v.play().catch(() => {}); });

        const stickerData = [];
        const stickerNodes = document.querySelectorAll('#strip-preview .sticker-wrapper');
        const printStripRect = printStripEl.getBoundingClientRect();

        stickerNodes.forEach(st => {
            const imgEl = st.querySelector('img');
            const rect = st.getBoundingClientRect();
            const preloadedImg = new Image(); 
            preloadedImg.crossOrigin = "Anonymous";
            preloadedImg.src = imgEl.src;
            const rotation = parseFloat(imgEl.getAttribute('data-rotation')) || 0;
            stickerData.push({
                img: preloadedImg,
                x: (rect.left - printStripRect.left) * scaleX,
                y: (rect.top - printStripRect.top) * scaleY,
                w: rect.width * scaleX,
                h: rect.height * scaleY,
                r: rotation * Math.PI / 180
            });
        });

        const cells = document.querySelectorAll('#animated-strip .photo-cell');
        let isRecording = true;

        function draw() {
            if (!isRecording) return;
            if (stripEl.style.backgroundColor === 'transparent') ctx.clearRect(0, 0, canvas.width, canvas.height);
            else {
                ctx.fillStyle = stripEl.style.backgroundColor || '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            bgLayers.forEach(l => {
                ctx.save();
                ctx.translate((l.x/100)*canvas.width + (l.w/100)*canvas.width/2, (l.y/100)*canvas.height + (l.h/100)*canvas.height/2);
                ctx.rotate(l.r * Math.PI / 180);
                try { ctx.drawImage(l.img, -(l.w/100)*canvas.width/2, -(l.h/100)*canvas.height/2, (l.w/100)*canvas.width, (l.h/100)*canvas.height); } catch (e) {}
                ctx.restore();
            });

            const stripRect = printStripEl.getBoundingClientRect();

            cells.forEach((cell, i) => {
                const vid = cell.querySelector('.shot-preview');
                let sourceToDraw = null;
                let isVideo = false;
                if (vid && vid.readyState >= 2) {
                    sourceToDraw = vid;
                    isVideo = true;
                } else {
                    const staticImg = document.getElementById(`preview-${i+1}`);
                    if (staticImg && staticImg.src) sourceToDraw = staticImg;
                }

                if (sourceToDraw && cell.style.display !== 'none' && !cell.classList.contains('hidden')) {
                    let x, y, w, h, cellRot = 0;
                    if (isAbsolute && cell.hasAttribute('data-cell-x')) {
                        w = (parseFloat(cell.getAttribute('data-cell-w')) / 100) * canvas.width;
                        h = (parseFloat(cell.getAttribute('data-cell-h')) / 100) * canvas.height;
                        x = (parseFloat(cell.getAttribute('data-cell-x')) / 100) * canvas.width;
                        y = (parseFloat(cell.getAttribute('data-cell-y')) / 100) * canvas.height;
                        cellRot = parseFloat(cell.getAttribute('data-cell-rot')) || 0;
                    } else {
                        const rect = document.getElementById(`cell-${i+1}`).getBoundingClientRect();
                        x = (rect.left - stripRect.left) * scaleX;
                        y = (rect.top - stripRect.top) * scaleY;
                        w = rect.width * scaleX;
                        h = rect.height * scaleY;
                    }

                    let imgW = isVideo ? vid.videoWidth : sourceToDraw.naturalWidth;
                    let imgH = isVideo ? vid.videoHeight : sourceToDraw.naturalHeight;
                    if (!imgW || !imgH) { imgW = 4; imgH = 3; }

                    // Bake filter for the current video frame
                    const offCanvas = document.createElement('canvas');
                    offCanvas.width = imgW;
                    offCanvas.height = imgH;
                    const offCtx = offCanvas.getContext('2d');
                    if (currentFilter && currentFilter !== 'none') offCtx.filter = currentFilter;
                    offCtx.drawImage(sourceToDraw, 0, 0, imgW, imgH);

                    sourceToDraw = offCanvas;

                    let imgAspect = imgW / imgH;
                    let cellAspect = w / h;
                    let drawW, drawH, drawX, drawY;

                    let isRotated = photoAdjustments[i].rotate % 180 !== 0;
                    if (isRotated) imgAspect = imgH / imgW;
                    if (imgAspect > cellAspect) {
                        drawH = h; drawW = h * imgAspect;
                        drawX = (w - drawW) / 2; drawY = 0;
                    } else {
                        drawW = w; drawH = w / imgAspect;
                        drawX = 0; drawY = (h - drawH) / 2;
                    }

                    ctx.save();
                    ctx.translate(x + w/2, y + h/2);
                    ctx.rotate(cellRot * Math.PI / 180);
                    
                    buildShapePath(ctx, photoAdjustments[i].shape, w, h);
                    ctx.clip();

                    let adj = photoAdjustments[i];
                    ctx.translate((adj.x / 100) * w, (adj.y / 100) * h);
                    ctx.scale(adj.scale, adj.scale);
                    ctx.rotate(adj.rotate * Math.PI / 180);
                    ctx.scale(adj.flipH ? -1 : 1, adj.flipV ? -1 : 1);
                    try { ctx.drawImage(sourceToDraw, isRotated ? drawX - h/2 : drawX - w/2, isRotated ? drawY - w/2 : drawY - h/2, isRotated ? drawH : drawW, isRotated ? drawW : drawH); } catch (e){}
                    ctx.restore(); 

                    ctx.filter = 'none';
                }
            });

            overlayLayers.forEach(l => {
                ctx.save();
                ctx.translate((l.x/100)*canvas.width + (l.w/100)*canvas.width/2, (l.y/100)*canvas.height + (l.h/100)*canvas.height/2);
                ctx.rotate(l.r * Math.PI / 180);
                try { ctx.drawImage(l.img, -(l.w/100)*canvas.width/2, -(l.h/100)*canvas.height/2, (l.w/100)*canvas.width, (l.h/100)*canvas.height); } catch (e) {}
                ctx.restore();
            });

            stickerData.forEach(st => {
                if (st.img.complete) {
                    ctx.save();
                    ctx.translate(st.x + st.w/2, st.y + st.h/2);
                    ctx.rotate(st.r);
                    try { ctx.drawImage(st.img, -st.w/2, -st.h/2, st.w, st.h); } catch (e) {}
                    ctx.restore();
                }
            });

            requestAnimationFrame(draw);
        }

        recorder.start(); 
        draw();
        setTimeout(() => { isRecording = false; recorder.stop(); }, 5000);
    });
}

function base64ToBlob(base64Str) {
    const parts = base64Str.split(';base64,');
    const mime = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) { uInt8Array[i] = raw.charCodeAt(i); }
    return new Blob([uInt8Array], { type: mime });
}

async function processFinalWorkflow() {
    loadingText.innerText = "Generating Layout & Video (5s)...";
    loadingOverlay.classList.remove('hidden');

    try {
        const finalStripBase64 = await generateCompositeImage();
        let animatedVideoBlob = null; 
        let videoExt = 'webm';

        try {
            const videoRes = await createAnimatedStripVideo();
            animatedVideoBlob = videoRes.blob; 
            videoExt = videoRes.extension;
        } catch (err) { console.warn("Video render skipped:", err); }

        document.getElementById('final-print-display').src = finalStripBase64;
        if (animatedVideoBlob) {
            document.getElementById('final-video-display').src = URL.createObjectURL(animatedVideoBlob);
            document.getElementById('video-column').classList.remove('hidden');
        } else {
            document.getElementById('video-column').classList.add('hidden');
        }

        if (userLayout === '3x_grid' || userLayout === '2x2') {
            document.getElementById('qr-media-column').classList.add('stacked');
        } else {
            document.getElementById('qr-media-column').classList.remove('stacked');
        }

        loadingText.innerText = "Uploading to Cloud Gallery...";
        const formData = new FormData();
        const finalStripBlob = base64ToBlob(finalStripBase64);
        formData.append('finalStrip', finalStripBlob, 'final_strip.jpg');
        formData.append('layout', userLayout);

        let selectedRawPhotos = selectedPhotos.map(index => photos[index]);
        for (let i = 0; i < selectedRawPhotos.length; i++) {
            let rawBlob;
            if (selectedRawPhotos[i].startsWith('data:')) {
                rawBlob = base64ToBlob(selectedRawPhotos[i]);
            } else {
                const imgRes = await fetch(selectedRawPhotos[i]);
                rawBlob = await imgRes.blob();
            }
            formData.append(`rawPhoto${i}`, rawBlob, `raw_${i}.jpg`);
        }

        if (animatedVideoBlob) {
            formData.append('btsVideo', animatedVideoBlob, `animated_strip.${videoExt}`);
        }

        const response = await fetch(getApiPath('upload'), { method: 'POST', body: formData });
        const data = await response.json();

        if (!data.success) throw new Error(data.error || "Backend failed to save files.");

        const printArea = document.getElementById('print-area');
        printArea.innerHTML = '';
        const printImg1 = document.createElement('img'); 
        printImg1.src = finalStripBase64;

        if (userLayout === '1x4' || userLayout === '1x3') {
            const printImg2 = document.createElement('img'); 
            printImg2.src = finalStripBase64;
            printArea.appendChild(printImg1); 
            printArea.appendChild(printImg2); 
            printArea.className = `print-${userLayout}`;
        } else {
            printArea.appendChild(printImg1); 
            printArea.className = `print-${userLayout}`;
        }

        document.getElementById('qr-code-image').src = data.qrCodeUrl;
        loadingOverlay.classList.add('hidden');
        navigateTo('/qr');

        startOutroTimer(30);
        requestAnimationFrame(() => {
            setTimeout(() => { window.print(); }, 1200);
        });
    } catch (error) {
        console.error("Workflow Error:", error);
        loadingOverlay.classList.add('hidden');
        alert(`Upload Error: ${error.message}`);
        navigateTo('/edit');
    }
}

function startOutroTimer(seconds) {
    const btn = document.getElementById('done-btn');
    btn.innerText = `Touch to Finish (${seconds}s)`;
    if (outroTimer) clearInterval(outroTimer);
    outroTimer = setInterval(() => {
        seconds--; 
        btn.innerText = `Touch to Finish (${seconds}s)`;
        if (seconds <= 0) { 
            clearInterval(outroTimer); 
            restartBooth(); 
        }
    }, 1000);
}

function restartBooth() {
    window.location.href = `/e/${currentEventCode}`;
}