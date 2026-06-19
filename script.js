/**
 * ZOLL X Series 生理監視儀器模擬器 - 核心邏輯
 */

// ==========================================================================
// 1. 全域狀態管理
// ==========================================================================
const state = {
    // 裝置開關
    deviceOn: false,
    soundEnabled: true,
    
    // 生命徵象 (目前設定值 - 來自控制台)
    targetHR: 75,
    targetSpO2: 98,
    targetCO2: 38,
    targetRR: 14,
    targetBPSys: 120,
    targetBPDia: 80,
    rhythm: 'NSR', // NSR, SB, ST, AF, VT, VF, ASYST, PEA
    
    // 裝置實際顯示值 (部分數值如 NIBP 需要測量才會更新)
    displayHR: '---',
    displaySpO2: '---',
    displayCO2: '---',
    displayRR: '---',
    displayBPSys: '---',
    displayBPDia: '---',
    displayBPMean: '---',
    displayBPTime: '--:--',
    
    // NIBP (非侵入式血壓) 測量狀態
    bpMeasuring: false,
    bpTimer: null,
    bpMeasureDuration: 2000, // 兩秒量測等待時間 (如使用者要求)
    
    // 起搏器 (Pacer) 狀態
    pacerActive: false,
    pacerRate: 70, // ppm (30 - 180)
    pacerOutput: 0, // mA (0 - 140)
    pacerCaptureThreshold: 40, // 超過 40mA 開始起搏捕獲 (ECG顯示變寬)
    pacerFocus: 'none', // 'none', 'rate', 'output' 用方向鍵/Select調整
    
    // 去顫器 (Defibrillator) 狀態
    defibEnergy: 150, // 焦耳 J
    defibCharging: false,
    defibCharged: false,
    defibChargeProgress: 0,
    syncActive: false,
    autoConvertOnShock: true, // 電擊後自動轉 NSR

    // 時間軸 (Timeline) 狀態
    timelineRunning: false,
    timelineSeconds: 0,
    timelineInterval: null,
    timelineSteps: [
        { time: 0, rhythm: 'NSR', hr: 75, spo2: 98, bpSys: 120, bpDia: 80, co2: 38, rr: 14, desc: '初始穩定狀態' },
        { time: 30, rhythm: 'VT', hr: 165, spo2: 90, bpSys: 90, bpDia: 55, co2: 25, rr: 20, desc: '患者突發心室頻脈' },
        { time: 60, rhythm: 'VF', hr: 0, spo2: 0, bpSys: 0, bpDia: 0, co2: 12, rr: 0, desc: '惡化為心室顫動 (Arrest)' },
        { time: 120, rhythm: 'ASYST', hr: 0, spo2: 0, bpSys: 0, bpDia: 0, co2: 0, rr: 0, desc: '心搏停止 (Asystole)' }
    ],
    
    // 時間計數
    elapsedSeconds: 0,
    elapsedTimer: null,
    
    // 警報狀態
    alarmActive: false,
    alarmType: 'none', // none, warning, critical
    alarmMuted: false,
    alarmMuteTimer: null,
    
    // 新增狀態
    co2Active: false,
    twelveLeadActive: false,
    logActive: false,
    logs: []
};

// 去顫能量階梯 (ZOLL 標準雙相波能量設定)
const ENERGY_LEVELS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 75, 100, 120, 150, 200];

// 心律預設行為對照表 (當選擇心律時，自動變更預設心率與生理值)
const RHYTHM_PRESETS = {
    NSR:   { hr: 75,  spo2: 98, co2: 38, rr: 14, bpSys: 120, bpDia: 80 },
    SB:    { hr: 38,  spo2: 95, co2: 36, rr: 10, bpSys: 95,  bpDia: 55 },
    ST:    { hr: 135, spo2: 96, co2: 34, rr: 20, bpSys: 110, bpDia: 70 },
    STEMI: { hr: 85,  spo2: 94, co2: 35, rr: 18, bpSys: 105, bpDia: 65 },
    AF:    { hr: 150, spo2: 94, co2: 37, rr: 16, bpSys: 115, bpDia: 75 },
    VT:    { hr: 175, spo2: 85, co2: 20, rr: 22, bpSys: 80,  bpDia: 45 },
    VF:    { hr: 0,   spo2: 0,  co2: 10, rr: 0,  bpSys: 0,   bpDia: 0  },
    ASYST: { hr: 0,   spo2: 0,  co2: 0,  rr: 0,  bpSys: 0,   bpDia: 0  },
    PEA:   { hr: 55,  spo2: 0,  co2: 8,  rr: 8,  bpSys: 0,   bpDia: 0  }
};

// ==========================================================================
// 2. Web Audio API 音效合成器
// ==========================================================================
let audioCtx = null;
let chargeOsc = null;
let chargeGain = null;
let pacerBeepInterval = null;

function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        console.error("Web Audio API 未被瀏覽器支援", e);
    }
}

// 播放短嗶聲 (QRS 偵測心率音)
// 音頻頻率隨血氧飽和度(SpO2)降低而降低 (臨床真實表現)
function playHeartBeep(spo2Val) {
    if (!state.deviceOn || !state.soundEnabled || state.alarmMuted) return;
    initAudio();
    if (!audioCtx) return;

    // 正常血氧 95-100% 嗶聲高亢 (約 700Hz)，缺氧時音調變低 (SpO2=70% 時約 450Hz)
    const currentSpO2 = isNaN(spo2Val) ? 98 : spo2Val;
    const baseFreq = 350;
    const freq = baseFreq + (Math.max(60, Math.min(100, currentSpO2)) - 60) * 8.75; // 350Hz 到 700Hz

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    
    // 快速淡入淡出，產生乾淨的嗶聲
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.09);
}

// 播放起搏點擊聲 (Pacer Click)
function playPacerClick() {
    if (!state.deviceOn || !state.soundEnabled) return;
    initAudio();
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1000, audioCtx.currentTime); // 乾淨短促的千赫茲點擊音

    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.04);
}

// 播放警報聲 (高優先級：連續快速雙嗶音；中優先級：緩慢嗶音)
let alarmInterval = null;
function startAlarmSound() {
    if (alarmInterval) return;
    initAudio();
    if (!audioCtx) return;

    alarmInterval = setInterval(() => {
        if (!state.deviceOn || !state.soundEnabled || state.alarmMuted || state.alarmType === 'none') return;
        
        const now = audioCtx.currentTime;
        // 模擬高優先級警報 (例如 VF / VT / Asystole 或極端心率血氧)
        if (state.alarmType === 'critical') {
            // 五音階警報嗶聲
            playBeep(650, 0.1, 0);
            playBeep(650, 0.1, 0.15);
            playBeep(650, 0.1, 0.3);
            playBeep(550, 0.15, 0.55);
            playBeep(650, 0.15, 0.8);
        } else if (state.alarmType === 'warning') {
            // 中級警報：三聲嗶音
            playBeep(500, 0.2, 0);
            playBeep(500, 0.2, 0.3);
            playBeep(500, 0.2, 0.6);
        }
    }, 2500);
}

function stopAlarmSound() {
    if (alarmInterval) {
        clearInterval(alarmInterval);
        alarmInterval = null;
    }
}

function playBeep(freq, duration, delay) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
    
    gain.gain.setValueAtTime(0, audioCtx.currentTime + delay);
    gain.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
    
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + duration + 0.05);
}

// 去顫器充電聲音 (頻率上升音)
function playChargeSound() {
    initAudio();
    if (!audioCtx || !state.soundEnabled) return;
    
    chargeOsc = audioCtx.createOscillator();
    chargeGain = audioCtx.createGain();
    chargeOsc.connect(chargeGain);
    chargeGain.connect(audioCtx.destination);
    
    chargeOsc.type = 'sine';
    // 從 400Hz 上升至 1600Hz，模擬高壓電容充電聲
    chargeOsc.frequency.setValueAtTime(400, audioCtx.currentTime);
    chargeOsc.frequency.exponentialRampToValueAtTime(1600, audioCtx.currentTime + 1.5);
    
    chargeGain.gain.setValueAtTime(0, audioCtx.currentTime);
    chargeGain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.1);
    
    chargeOsc.start(audioCtx.currentTime);
}

function stopChargeSound() {
    if (chargeOsc) {
        try {
            chargeOsc.stop();
        } catch(e){}
        chargeOsc = null;
    }
    if (chargeGain) {
        chargeGain = null;
    }
}

// 播放放電電擊聲
function playShockDischarge() {
    initAudio();
    if (!audioCtx || !state.soundEnabled) return;
    
    // 模擬巨大啪聲與瞬間雜音
    const bufferSize = audioCtx.sampleRate * 0.25; // 0.25秒
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    // 填充白噪音
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(10, audioCtx.currentTime + 0.2);
    
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    
    noise.start(audioCtx.currentTime);
    
    // 伴隨一個低沉的 thud 聲
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(80, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(20, audioCtx.currentTime + 0.15);
    oscGain.gain.setValueAtTime(0.6, audioCtx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.2);
}

// 播放開機聲 (經典三音符和弦嗶)
function playPowerOnSound() {
    initAudio();
    if (!audioCtx || !state.soundEnabled) return;
    
    const now = audioCtx.currentTime;
    playBeep(440, 0.08, 0);   // A4
    playBeep(554, 0.08, 0.085); // C#5
    playBeep(659, 0.12, 0.17);  // E5
}

// 播放 LINE 群組傳送通知聲 (快速雙音)
function playLINENotification() {
    if (!state.deviceOn || !state.soundEnabled) return;
    initAudio();
    if (!audioCtx) return;
    
    // 兩聲快速輕脆高音
    playBeep(988, 0.08, 0);     // B5
    playBeep(1318, 0.15, 0.08);  // E6
}

// 記錄歷史操作紀錄並同步至 Log 頁面
function logEvent(message) {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const logMsg = { time: timeStr, text: message };
    state.logs.push(logMsg);
    
    // 同步到 DOM 中的 logList
    const logList = document.getElementById('logList');
    if (logList) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="log-time">[${timeStr}]</span> ${message}`;
        logList.appendChild(li);
        
        // 自動捲動到最底部
        const logBody = document.querySelector('.log-screen .log-body');
        if (logBody) logBody.scrollTop = logBody.scrollHeight;
    }
}


// ==========================================================================
// 3. 生理波形生成與 Canvas 繪製 (60fps)
// ==========================================================================
const canvases = {
    ecg: { el: null, ctx: null, x: 0, prevY: 0 },
    art: { el: null, ctx: null, x: 0, prevY: 0 },
    co2: { el: null, ctx: null, x: 0, prevY: 0 },
    spo2: { el: null, ctx: null, x: 0, prevY: 0 }
};

// 初始化畫布
function initCanvases() {
    const ids = ['canvasECG', 'canvasART', 'canvasCO2', 'canvasSpO2'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const ctx = el.getContext('2d');
        const key = id.replace('canvas', '').toLowerCase();
        
        canvases[key].el = el;
        canvases[key].ctx = ctx;
        
        // 處理 Retina 高解析度螢幕
        const dpr = window.devicePixelRatio || 1;
        const rect = el.getBoundingClientRect();
        el.width = rect.width * dpr;
        el.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        
        canvases[key].width = rect.width;
        canvases[key].height = rect.height;
        canvases[key].x = 0;
        canvases[key].prevY = rect.height / 2;
    });
}

// 十二導程畫布群
const twelveLeadCanvases = {
    l1: { el: null, ctx: null, x: 0, prevY: 0 },
    l2: { el: null, ctx: null, x: 0, prevY: 0 },
    l3: { el: null, ctx: null, x: 0, prevY: 0 },
    laVR: { el: null, ctx: null, x: 0, prevY: 0 },
    laVL: { el: null, ctx: null, x: 0, prevY: 0 },
    laVF: { el: null, ctx: null, x: 0, prevY: 0 },
    lv1: { el: null, ctx: null, x: 0, prevY: 0 },
    lv2: { el: null, ctx: null, x: 0, prevY: 0 },
    lv3: { el: null, ctx: null, x: 0, prevY: 0 },
    lv4: { el: null, ctx: null, x: 0, prevY: 0 },
    lv5: { el: null, ctx: null, x: 0, prevY: 0 },
    lv6: { el: null, ctx: null, x: 0, prevY: 0 }
};

// 初始化十二導程小畫布
function initTwelveLeadCanvases() {
    const leadIds = {
        l1: 'canvasL1', l2: 'canvasL2', l3: 'canvasL3',
        laVR: 'canvasLaVR', laVL: 'canvasLaVL', laVF: 'canvasLaVF',
        lv1: 'canvasLV1', lv2: 'canvasLV2', lv3: 'canvasLV3',
        lv4: 'canvasLV4', lv5: 'canvasLV5', lv6: 'canvasLV6'
    };
    
    for (const [key, id] of Object.entries(leadIds)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const ctx = el.getContext('2d');
        twelveLeadCanvases[key].el = el;
        twelveLeadCanvases[key].ctx = ctx;
        
        const dpr = window.devicePixelRatio || 1;
        const rect = el.getBoundingClientRect();
        el.width = rect.width * dpr;
        el.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        
        twelveLeadCanvases[key].width = rect.width;
        twelveLeadCanvases[key].height = rect.height;
        twelveLeadCanvases[key].x = 0;
        twelveLeadCanvases[key].prevY = rect.height / 2;
    }
}

// 生命徵象計時器與波形動態變數
let lastEcgBeatTime = 0;
let lastCo2BreathTime = 0;
let animationFrameId = null;

// 用於 AF (心房顫動) 的隨機不規則間隔
let currentAFInterval = 0.8;

// 通用的 12 導程掃描式波形繪製函數
function drawSweepWaveTwelveLead(leadKey, dt, speed, signalFunc, color) {
    const channel = twelveLeadCanvases[leadKey];
    if (!channel || !channel.ctx) return;
    
    const ctx = channel.ctx;
    const w = channel.width;
    const h = channel.height;
    
    // 每一幀掃描線向右移動的距離
    const dx = speed * dt;
    const nextX = channel.x + dx;
    
    // 振幅映射
    const amp = signalFunc(channel.x);
    const targetY = (h / 2) - (amp * (h * 0.35));
    
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // 擦除前方舊波形 (使用 clearRect 保持背景網格透出)
    const eraseWidth = 15;
    
    if (nextX + eraseWidth < w) {
        ctx.clearRect(nextX, 0, eraseWidth, h);
    } else {
        ctx.clearRect(nextX, 0, w - nextX, h);
        ctx.clearRect(0, 0, (nextX + eraseWidth) - w, h);
    }
    
    ctx.beginPath();
    ctx.moveTo(channel.x, channel.prevY);
    ctx.lineTo(nextX > w ? w : nextX, targetY);
    ctx.stroke();
    
    if (nextX >= w) {
        channel.x = 0;
        channel.prevY = targetY;
    } else {
        channel.x = nextX;
        channel.prevY = targetY;
    }
}

// 核心動畫渲染迴圈
function renderWaveforms(timestamp) {
    if (!state.deviceOn) return;
    
    // 計算每幀時間增量
    const dt = 1/60; // 假定穩定 60fps
    
    // 獲取目前生理數值 (若在去顫/心搏停止下做特別判斷)
    const hasPulse = (state.rhythm !== 'VF' && state.rhythm !== 'ASYST' && state.rhythm !== 'PEA');
    const hasBreathing = (state.targetRR > 0 && state.rhythm !== 'VF' && state.rhythm !== 'ASYST' && state.rhythm !== 'PEA');
    
    const hr = hasPulse ? state.targetHR : 0;
    const rr = hasBreathing ? state.targetRR : 0;
    
    // ----------------------------------------------------------------------
    // A. 心率與 ECG 週期的時間追蹤
    // ----------------------------------------------------------------------
    let secondsPerBeat = hr > 0 ? 60 / hr : Infinity;
    
    // 如果是心房顫動 AF，節律不規則
    if (state.rhythm === 'AF' && hr > 0) {
        secondsPerBeat = currentAFInterval;
    }
    
    lastEcgBeatTime += dt;
    
    // 判斷是否需要觸發一次新的心跳
    if (hr > 0 && lastEcgBeatTime >= secondsPerBeat) {
        lastEcgBeatTime = 0;
        
        // 觸發心跳嗶聲與螢幕閃動
        triggerHeartbeat();
        
        // 如果是心房顫動，隨機計算下一個 R-R 間期
        if (state.rhythm === 'AF') {
            // 平均在 secondsPerBeat 左右，但上下浮動 35%
            const baseInterval = 60 / hr;
            currentAFInterval = baseInterval * (0.65 + Math.random() * 0.7);
        }
    }
    
    // ----------------------------------------------------------------------
    // B. 呼吸次數與 etCO2 週期的時間追蹤
    // ----------------------------------------------------------------------
    const secondsPerBreath = rr > 0 ? 60 / rr : Infinity;
    lastCo2BreathTime += dt;
    if (rr > 0 && lastCo2BreathTime >= secondsPerBreath) {
        lastCo2BreathTime = 0;
    }
    
    // ----------------------------------------------------------------------
    // C. 繪製 ECG 波形 (掃描線模式 Sweep Mode)
    // ----------------------------------------------------------------------
    drawSweepWave('ecg', dt, 130, (t) => {
        return getECGSignalValue(lastEcgBeatTime, secondsPerBeat);
    }, varColorECG());
    
    // ----------------------------------------------------------------------
    // D. 繪製 ART 波形
    // ----------------------------------------------------------------------
    drawSweepWave('art', dt, 90, (t) => {
        if (!hasPulse) return 0;
        let delayTime = lastEcgBeatTime - 0.15;
        if (delayTime < 0) {
            const prevBeatDuration = (state.rhythm === 'AF') ? currentAFInterval : (60/hr);
            delayTime = prevBeatDuration + delayTime;
        }
        return getSpO2SignalValue(delayTime, secondsPerBeat);
    }, '#ff1744');
    
    // ----------------------------------------------------------------------
    // E. 繪製 etCO2 二氧化碳波形 (僅在開啟 etCO2 監測且有呼吸時繪製，否則平線)
    // ----------------------------------------------------------------------
    drawSweepWave('co2', dt, 50, (t) => {
        if (!state.co2Active || !hasBreathing) return 0;
        return getCO2SignalValue(lastCo2BreathTime, secondsPerBreath);
    }, '#ff4081');
    
    // ----------------------------------------------------------------------
    // F. 繪製 SpO2 脈搏波形
    // ----------------------------------------------------------------------
    drawSweepWave('spo2', dt, 90, (t) => {
        if (!hasPulse) return 0;
        let delayTime = lastEcgBeatTime - 0.15;
        if (delayTime < 0) {
            const prevBeatDuration = (state.rhythm === 'AF') ? currentAFInterval : (60/hr);
            delayTime = prevBeatDuration + delayTime;
        }
        return getSpO2SignalValue(delayTime, secondsPerBeat);
    }, '#ffea00');
    
    // ----------------------------------------------------------------------
    // G. 繪製 12 導程波形 (當 12 導程頁面開啟時)
    // ----------------------------------------------------------------------
    if (state.twelveLeadActive) {
        const leadColor = '#00e676';
        for (const leadKey of Object.keys(twelveLeadCanvases)) {
            drawSweepWaveTwelveLead(leadKey, dt, 100, (t) => {
                return getECGSignalValue(lastEcgBeatTime, secondsPerBeat, leadKey);
            }, leadColor);
        }
    }
    
    animationFrameId = requestAnimationFrame(renderWaveforms);
}

// 獲取目前 ECG 連線的顏色 (起搏時會有不同標記)
function varColorECG() {
    return '#00e676';
}

// 觸發心跳的 UI 回饋
function triggerHeartbeat() {
    // 播放嗶聲
    if (state.rhythm !== 'PEA') {
        playHeartBeep(state.targetSpO2);
    }
    
    // 綠色愛心與數值框閃一下
    const heartIcon = document.getElementById('heartIcon');
    const boxHR = document.getElementById('boxHR');
    if (heartIcon && boxHR) {
        heartIcon.classList.add('beat');
        boxHR.classList.add('pulse-glow');
        setTimeout(() => {
            heartIcon.classList.remove('beat');
            boxHR.classList.remove('pulse-glow');
        }, 80);
    }
    
    // SpO2 脈搏柱狀圖彈跳
    const plethBar = document.getElementById('plethBar');
    if (plethBar && state.targetSpO2 > 0) {
        const amp = (state.targetSpO2 / 100) * 85 + Math.random() * 10;
        plethBar.style.height = `${Math.min(100, amp)}%`;
        setTimeout(() => {
            plethBar.style.height = '15%';
        }, 200);
    }
}

// 通用的掃描式波形繪製函數 (Sweep Display Mode)
function drawSweepWave(type, dt, speed, signalFunc, color) {
    const channel = canvases[type];
    if (!channel || !channel.ctx) return;
    
    const ctx = channel.ctx;
    const w = channel.width;
    const h = channel.height;
    
    // 每一幀掃描線向右移動的距離
    const dx = speed * dt;
    const nextX = channel.x + dx;
    
    // 計算目前的生理數值振幅 (介於 -1 與 1 之間)
    const amp = signalFunc(channel.x);
    // 映射至 Canvas 坐標系 (反轉 Y 軸並置中)
    const targetY = (h / 2) - (amp * (h * 0.38));
    
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // 擦除前方舊波形：在掃描線前端畫一個黑色遮罩矩形
    ctx.fillStyle = varColorBG();
    const eraseWidth = 25; // 橡皮擦寬度
    
    if (nextX + eraseWidth < w) {
        ctx.fillRect(nextX, 0, eraseWidth, h);
    } else {
        // 當掃描線接近最右側時，同時擦除最左側 (準備折返)
        ctx.fillRect(nextX, 0, w - nextX, h);
        ctx.fillRect(0, 0, (nextX + eraseWidth) - w, h);
    }
    
    // 繪製二氧化碳波形的實心填充 (Phase II/III/IV under curve)
    const hasBreathing = (state.targetRR > 0 && state.rhythm !== 'VF' && state.rhythm !== 'ASYST' && state.rhythm !== 'PEA');
    if (type === 'co2' && state.co2Active && hasBreathing) {
        const baselineY = h - 2;
        ctx.fillStyle = 'rgba(255, 64, 129, 0.35)'; // 半透明粉紅色填充
        ctx.beginPath();
        ctx.moveTo(channel.x, baselineY);
        ctx.lineTo(channel.x, channel.prevY);
        ctx.lineTo(nextX > w ? w : nextX, targetY);
        ctx.lineTo(nextX > w ? w : nextX, baselineY);
        ctx.closePath();
        ctx.fill();
    }
    
    // 畫線段
    ctx.beginPath();
    ctx.moveTo(channel.x, channel.prevY);
    ctx.lineTo(nextX > w ? w : nextX, targetY);
    ctx.stroke();
    
    // 更新掃描位置
    if (nextX >= w) {
        channel.x = 0;
        // 折返時不連線，直接記錄起始點
        channel.prevY = targetY;
    } else {
        channel.x = nextX;
        channel.prevY = targetY;
    }
}

function varColorBG() {
    return '#090a0f';
}

// ----------------------------------------------------------------------
// 4. 生理波形數學模型 (模擬真實心電圖與呼吸圖)
// ----------------------------------------------------------------------

// A. ECG 訊號產生器 (P-QRS-T 連續曲線)
function getECGSignalValue(t, beatDuration, leadKey = 'l2') {
    let finalVal = 0;

    // 1. 心室顫動 (VF) - 完全雜亂無章的隨機正弦波
    if (state.rhythm === 'VF') {
        const f1 = 4.5, f2 = 8.2, f3 = 14.7; // 三種頻率相加
        finalVal = (
            Math.sin(t * Math.PI * 2 * f1) * 0.4 +
            Math.sin(t * Math.PI * 2 * f2) * 0.35 +
            Math.sin(t * Math.PI * 2 * f3) * 0.15 +
            (Math.random() * 0.1 - 0.05)
        );
        return leadKey === 'laVR' ? finalVal * -1 : finalVal;
    }
    
    // 2. 心搏停止 (Asystole) - 近乎直線，帶有極輕微微雜訊
    if (state.rhythm === 'ASYST') {
        finalVal = (Math.random() * 0.03 - 0.015);
        return leadKey === 'laVR' ? finalVal * -1 : finalVal;
    }
    
    // 3. 心室頻脈 (VT) - 快速、寬大且規則的鋸齒波 (無 P/T 波)
    if (state.rhythm === 'VT') {
        // 單形性寬 QRS 波群
        const vtCycle = 0.35; // VT 的單個波寬度
        const phase = (t % vtCycle) / vtCycle;
        // 使用正弦波加上三次諧波調製出類似寬大畸形的 QRS
        finalVal = Math.sin(phase * Math.PI * 2) * 0.7 + Math.sin(phase * Math.PI * 4) * 0.25;
        return leadKey === 'laVR' ? finalVal * -1 : finalVal;
    }
    
    // 4. 起搏器 (Pacer) 作用下的 ECG 訊號
    // 如果起搏開啟，且有起搏釘 (Pacing spike)
    let pacerSpike = 0;
    
    if (state.pacerActive) {
        // 計算起搏間期 (秒/次)
        const pacerInterval = 60 / state.pacerRate;
        const pacerTime = t % pacerInterval;
        
        // 在每個起搏週期起點放一個極窄的超高幅脈衝 (Pacer Spike)
        if (pacerTime < 0.015) {
            pacerSpike = 1.6; // 起搏釘
        }
        
        // 如果起搏電流大於閾值 (40mA)，起搏捕獲：心臟產生寬大畸形 QRS
        if (state.pacerOutput >= state.pacerCaptureThreshold) {
            const capTime = pacerTime - 0.015; // 釘子之後緊跟波形
            if (capTime > 0 && capTime < 0.4) {
                // 寬大 QRS
                if (capTime < 0.12) {
                    const progress = capTime / 0.12;
                    finalVal = pacerSpike + (Math.sin(progress * Math.PI * 1.5 - Math.PI/2) * -0.9);
                } else if (capTime < 0.4) {
                    // 慢而高的 T 波
                    const progress = (capTime - 0.12) / 0.28;
                    finalVal = Math.sin(progress * Math.PI) * 0.35;
                }
            } else {
                finalVal = pacerSpike;
            }
            return leadKey === 'laVR' ? finalVal * -1 : finalVal;
        }
    }
    
    // 若起搏未捕獲，或沒開心搏起搏，則繪製原本的心律 (NSR, SB, ST, AF, PEA)
    // 正常心電週期各區段時間定義 (以總時間 0.8秒 的 NSR 為例，按比例伸縮)
    const base = 0.8;
    const factor = Math.min(1.5, Math.max(0.4, beatDuration / base));
    
    const pStart = 0.0 * factor;
    const pEnd = 0.09 * factor;
    const qrsStart = 0.12 * factor;
    const qrsEnd = 0.22 * factor;
    const tStart = 0.26 * factor;
    const tEnd = 0.50 * factor;
    
    const time = t;
    
    // 如果是 STEMI，根據導程顯示 ST段上升 (Tombstone pattern) 或 相對應壓低 (Reciprocal depression)
    let stElevation = 0;
    if (state.rhythm === 'STEMI') {
        let stShift = 0;
        // 下壁+前壁 STEMI 組合：II, III, aVF, V3, V4, V5 上升，I, aVL 壓低
        if (leadKey === 'l2' || leadKey === 'l3' || leadKey === 'laVF' || leadKey === 'lv3' || leadKey === 'lv4' || leadKey === 'lv5') {
            stShift = 0.35; // ST段上升
        } else if (leadKey === 'l1' || leadKey === 'laVL') {
            stShift = -0.22; // ST段壓低 (Reciprocal Depression)
        }
        
        if (stShift !== 0 && time >= qrsEnd && time < tEnd) {
            const p = (time - qrsEnd) / (tEnd - qrsEnd);
            stElevation = Math.sin(p * Math.PI) * stShift + (1 - p) * (stShift * 0.35);
        }
    }
    
    // 如果起搏開啟但未捕獲，會在正常心電圖上疊加起搏釘，但心臟不被驅動
    let signal = pacerSpike + stElevation;
    
    // 繪製 P 波 (心房去極化)
    // 心房顫動 AF 無 P 波，而是代之以不規則的細顫 f 波
    if (state.rhythm === 'AF') {
        // 細微顫動波
        if (time < qrsStart) {
            signal += (Math.sin(time * Math.PI * 2 * 18) * 0.07 + Math.random() * 0.03 - 0.015);
        }
    } else {
        // 正常 P 波 (平滑的正弦拱形)
        if (time >= pStart && time < pEnd) {
            const progress = (time - pStart) / (pEnd - pStart);
            signal += Math.sin(progress * Math.PI) * 0.12;
        }
    }
    
    // 繪製 QRS 波群 (心室去極化 - 經典尖銳折線)
    if (time >= qrsStart && time < qrsEnd) {
        const qrsTime = time - qrsStart;
        const qrsDur = qrsEnd - qrsStart;
        const p = qrsTime / qrsDur;
        
        if (p < 0.15) {
            // Q 波 (小下沉)
            finalVal = signal - (p / 0.15) * 0.18;
        } else if (p < 0.5) {
            // R 波 (陡峭上升)
            const rProgress = (p - 0.15) / 0.35;
            finalVal = signal - 0.18 + rProgress * 1.38;
        } else if (p < 0.8) {
            // S 波 (深下沉)
            const sProgress = (p - 0.5) / 0.3;
            finalVal = signal + 1.2 - sProgress * 1.5;
        } else {
            // 回歸基線
            const endProgress = (p - 0.8) / 0.2;
            finalVal = signal - 0.3 + endProgress * 0.3;
        }
    } else {
        // 繪製 T 波 (心室再極化)
        if (time >= tStart && time < tEnd) {
            const progress = (time - tStart) / (tEnd - tStart);
            signal += Math.sin(progress * Math.PI) * 0.22;
        }
        
        // 心房顫動在 TP 段依然有細微顫動
        if (state.rhythm === 'AF' && time >= tEnd) {
            signal += (Math.sin(time * Math.PI * 2 * 15) * 0.05 + Math.random() * 0.02 - 0.01);
        }
        
        finalVal = signal;
    }
    
    return leadKey === 'laVR' ? finalVal * -1 : finalVal;
}

// B. SpO2 脈搏波訊號產生器
function getSpO2SignalValue(t, beatDuration) {
    if (beatDuration === Infinity || beatDuration === 0) return 0;
    
    // 脈搏波主要由快速上升支、潮汐波、重搏迪多克凹口 (Dicrotic notch) 與緩慢下降支組成
    const cycle = t % beatDuration;
    
    // 只在心跳前半段繪製搏動波 (約佔 0.5 秒)，後半段回到基線
    const activeDur = Math.min(0.55, beatDuration * 0.8);
    if (cycle > activeDur) {
        return Math.random() * 0.01; // 基線微弱噪音
    }
    
    const p = cycle / activeDur;
    
    if (p < 0.22) {
        // 陡峭上升支 (收縮期充血)
        return Math.sin(p / 0.22 * Math.PI / 2) * 0.85;
    } else if (p < 0.42) {
        // 重搏前短暫下降
        const p2 = (p - 0.22) / 0.20;
        return 0.85 - Math.sin(p2 * Math.PI / 2) * 0.25;
    } else if (p < 0.52) {
        // 重搏凹口 (Dicrotic Notch) 與小回彈波
        const p3 = (p - 0.42) / 0.10;
        return 0.60 + Math.sin(p3 * Math.PI) * 0.08;
    } else {
        // 舒張期緩慢下降支
        const p4 = (p - 0.52) / 0.48;
        return 0.60 * Math.cos(p4 * Math.PI / 2);
    }
}

// C. etCO2 二氧化碳波形產生器 (梯形波)
function getCO2SignalValue(t, breathDuration) {
    if (breathDuration === Infinity || breathDuration === 0) return 0;
    
    const cycle = t % breathDuration;
    
    // 呼氣期上升與高原佔週期的 45%
    const expStart = 0;
    const expPlateau = breathDuration * 0.10; // 呼氣上升支 (0.1秒)
    const inspStart = breathDuration * 0.40;  // 呼氣高原段結束
    const inspEnd = breathDuration * 0.52;    // 吸氣下降支結束 (0.12秒)
    
    if (cycle < expPlateau) {
        // 1. 呼氣陡峭上升相 (Phase II)
        const p = cycle / expPlateau;
        return Math.sin(p * Math.PI / 2) * 0.85;
    } else if (cycle >= expPlateau && cycle < inspStart) {
        // 2. 呼氣高原相 (Phase III - etCO2 高值)
        const progress = (cycle - expPlateau) / (inspStart - expPlateau);
        // 高原期尾端稍微上升，反映肺泡氣體 (Tension rise)
        return 0.85 + progress * 0.07;
    } else if (cycle >= inspStart && cycle < inspEnd) {
        // 3. 吸氣急劇下降相 (Phase IV)
        const p = (cycle - inspStart) / (inspEnd - inspStart);
        return 0.92 * (1 - Math.sin(p * Math.PI / 2));
    } else {
        // 4. 吸氣基線相 (Phase I - 吸入純氧無 CO2)
        return 0;
    }
}


// ==========================================================================
// 5. 側邊欄控制與預設情境
// ==========================================================================

// 初始化控制面板的監聽
function initControlPanel() {
    // 獲取 DOM
    const inputHR = document.getElementById('inputHR');
    const inputSpO2 = document.getElementById('inputSpO2');
    const inputCO2 = document.getElementById('inputCO2');
    const inputRR = document.getElementById('inputRR');
    const inputBPSys = document.getElementById('inputBPSys');
    const inputBPDia = document.getElementById('inputBPDia');
    const inputRhythm = document.getElementById('inputRhythm');
    
    const valHR = document.getElementById('valHR');
    const valSpO2 = document.getElementById('valSpO2');
    const valCO2 = document.getElementById('valCO2');
    const valRR = document.getElementById('valRR');

    // 數值連動監聽
    inputHR.addEventListener('input', (e) => {
        state.targetHR = parseInt(e.target.value);
        valHR.textContent = state.targetHR;
        updateScreenNumerics();
    });
    inputHR.addEventListener('change', () => {
        logEvent(`後台手動調整心率為: ${state.targetHR} bpm`);
    });

    inputSpO2.addEventListener('input', (e) => {
        state.targetSpO2 = parseInt(e.target.value);
        valSpO2.textContent = state.targetSpO2;
        updateScreenNumerics();
    });
    inputSpO2.addEventListener('change', () => {
        logEvent(`後台手動調整血氧為: ${state.targetSpO2}%`);
    });

    inputCO2.addEventListener('input', (e) => {
        state.targetCO2 = parseInt(e.target.value);
        valCO2.textContent = state.targetCO2;
        updateScreenNumerics();
    });
    inputCO2.addEventListener('change', () => {
        logEvent(`後台手動調整 etCO2 為: ${state.targetCO2} mmHg`);
    });

    inputRR.addEventListener('input', (e) => {
        state.targetRR = parseInt(e.target.value);
        valRR.textContent = state.targetRR;
        updateScreenNumerics();
    });
    inputRR.addEventListener('change', () => {
        logEvent(`後台手動調整呼吸率為: ${state.targetRR} 次/分`);
    });

    inputBPSys.addEventListener('change', (e) => {
        state.targetBPSys = parseInt(e.target.value);
        logEvent(`後台手動調整血壓收縮壓為: ${state.targetBPSys} mmHg`);
        updateScreenNumerics();
    });
    
    inputBPDia.addEventListener('change', (e) => {
        state.targetBPDia = parseInt(e.target.value);
        logEvent(`後台手動調整血壓舒張壓為: ${state.targetBPDia} mmHg`);
        updateScreenNumerics();
    });

    // Pacer sidebar controls
    const inputPacerRate = document.getElementById('inputPacerRate');
    const inputPacerOutput = document.getElementById('inputPacerOutput');
    if (inputPacerRate) {
        inputPacerRate.addEventListener('input', (e) => {
            state.pacerRate = parseInt(e.target.value);
            syncPacerValues();
            restartPacerSoundLoop();
        });
        inputPacerRate.addEventListener('change', () => {
            logEvent(`後台調整起搏速率為: ${state.pacerRate} ppm`);
        });
    }
    if (inputPacerOutput) {
        inputPacerOutput.addEventListener('input', (e) => {
            state.pacerOutput = parseInt(e.target.value);
            syncPacerValues();
        });
        inputPacerOutput.addEventListener('change', () => {
            logEvent(`後台調整起搏輸出電流為: ${state.pacerOutput} mA`);
        });
    }

    // 心律切換邏輯 (有開心率，則脈搏配合調整)
    inputRhythm.addEventListener('change', (e) => {
        const rhythmType = e.target.value;
        state.rhythm = rhythmType;
        
        // 載入該心律對應的生理數值預設
        if (RHYTHM_PRESETS[rhythmType]) {
            const p = RHYTHM_PRESETS[rhythmType];
            
            // 特別處理使用者提到的 AF 範例：原本設定 75，選擇 AF 後變 150
            if (rhythmType === 'AF' && state.targetHR === 75) {
                state.targetHR = 150;
            } else {
                state.targetHR = p.hr;
            }
            
            state.targetSpO2 = p.spo2;
            state.targetCO2 = p.co2;
            state.targetRR = p.rr;
            state.targetBPSys = p.bpSys;
            state.targetBPDia = p.bpDia;
            
            // 同步更新控制面板的 Slider 位置
            inputHR.value = state.targetHR;
            valHR.textContent = state.targetHR;
            inputSpO2.value = state.targetSpO2;
            valSpO2.textContent = state.targetSpO2;
            inputCO2.value = state.targetCO2;
            valCO2.textContent = state.targetCO2;
            inputRR.value = state.targetRR;
            valRR.textContent = state.targetRR;
            inputBPSys.value = state.targetBPSys;
            inputBPDia.value = state.targetBPDia;
        }
        
        logEvent(`後台變更心律為: ${rhythmType} (目前設定心率 ${state.targetHR} bpm)`);
        updateScreenNumerics();
        checkAlarms();
    });

    // 臨床案例按鈕事件
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const presetType = e.target.dataset.preset;
            if (presetType) loadPresetCase(presetType);
        });
    });

    // 側邊欄隱藏與開啟
    const sidebar = document.getElementById('instructorSidebar');
    const closeBtn = document.getElementById('closeSidebarBtn');
    const openBtn = document.getElementById('openSidebarBtn');
    
    closeBtn.addEventListener('click', () => {
        sidebar.classList.add('collapsed');
        openBtn.classList.remove('hidden');
        // 重繪 Canvas 適應寬度
        setTimeout(initCanvases, 450);
    });
    
    openBtn.addEventListener('click', () => {
        sidebar.classList.remove('collapsed');
        openBtn.classList.add('hidden');
        setTimeout(initCanvases, 450);
    });

    // 設定選項
    document.getElementById('toggleSound').addEventListener('change', (e) => {
        state.soundEnabled = e.target.checked;
        if (!state.soundEnabled) stopAlarmSound();
        else if (state.deviceOn && state.alarmType !== 'none') startAlarmSound();
    });
    
    document.getElementById('toggleShockConvert').addEventListener('change', (e) => {
        state.autoConvertOnShock = e.target.checked;
    });

    // 後台去顫控制連動
    const inputDefibEnergy = document.getElementById('inputDefibEnergy');
    const sidebarBtnCharge = document.getElementById('sidebarBtnCharge');
    const sidebarBtnShock = document.getElementById('sidebarBtnShock');
    
    inputDefibEnergy.addEventListener('change', (e) => {
        if (!state.deviceOn) return;
        state.defibEnergy = parseInt(e.target.value);
        const screenDefibEnergy = document.getElementById('screenDefibEnergy');
        if (screenDefibEnergy) screenDefibEnergy.textContent = state.defibEnergy;
        playBeep(800, 0.05, 0);
    });

    sidebarBtnCharge.addEventListener('click', () => {
        if (!state.deviceOn) return;
        document.getElementById('btnCharge').click();
    });

    sidebarBtnShock.addEventListener('click', () => {
        if (!state.deviceOn) return;
        document.getElementById('btnShock').click();
    });
}

// 載入預設臨床案例
function loadPresetCase(type) {
    let preset = {};
    let rhythmName = 'NSR';
    
    switch (type) {
        case 'normal':
            rhythmName = 'NSR';
            preset = RHYTHM_PRESETS.NSR;
            break;
        case 'copd':
            rhythmName = 'NSR'; // 患者為正常節律但喘且低血氧
            preset = { hr: 112, spo2: 89, co2: 54, rr: 28, bpSys: 142, bpDia: 88 };
            break;
        case 'shock':
            rhythmName = 'ST'; // 竇性頻脈
            preset = { hr: 138, spo2: 91, co2: 30, rr: 24, bpSys: 78, bpDia: 42 };
            break;
        case 'arrest-vt':
            rhythmName = 'VT';
            preset = RHYTHM_PRESETS.VT;
            break;
        case 'arrest-vf':
            rhythmName = 'VF';
            preset = RHYTHM_PRESETS.VF;
            break;
        case 'asystole':
            rhythmName = 'ASYST';
            preset = RHYTHM_PRESETS.ASYST;
            break;
    }
    
    // 設定狀態
    state.rhythm = rhythmName;
    state.targetHR = preset.hr;
    state.targetSpO2 = preset.spo2;
    state.targetCO2 = preset.co2;
    state.targetRR = preset.rr;
    state.targetBPSys = preset.bpSys;
    state.targetBPDia = preset.bpDia;
    
    // 更新控制面板介面
    document.getElementById('inputRhythm').value = rhythmName;
    document.getElementById('inputHR').value = preset.hr;
    document.getElementById('valHR').textContent = preset.hr;
    document.getElementById('inputSpO2').value = preset.spo2;
    document.getElementById('valSpO2').textContent = preset.spo2;
    document.getElementById('inputCO2').value = preset.co2;
    document.getElementById('valCO2').textContent = preset.co2;
    document.getElementById('inputRR').value = preset.rr;
    document.getElementById('valRR').textContent = preset.rr;
    document.getElementById('inputBPSys').value = preset.bpSys;
    document.getElementById('inputBPDia').value = preset.bpDia;
    
    updateScreenNumerics();
    checkAlarms();
    logEvent(`後台載入案例: ${type} (心律: ${state.rhythm}, HR: ${state.targetHR}, BP: ${state.targetBPSys}/${state.targetBPDia}, SpO2: ${state.targetSpO2}%, etCO2: ${state.targetCO2} mmHg)`);
}


// ==========================================================================
// 6. 裝置螢幕數值渲染與警報系統
// ==========================================================================
function updateScreenNumerics() {
    if (!state.deviceOn) return;
    
    const screenHR = document.getElementById('screenHR');
    const screenSpO2 = document.getElementById('screenSpO2');
    const screenCO2 = document.getElementById('screenCO2');
    const screenRR = document.getElementById('screenRR');
    
    const hasPulse = (state.rhythm !== 'VF' && state.rhythm !== 'ASYST' && state.rhythm !== 'PEA');
    
    // 心率顯示判斷
    if (state.rhythm === 'VF' || state.rhythm === 'ASYST') {
        state.displayHR = '0';
        screenHR.textContent = '0';
        screenHR.classList.add('flash-danger');
    } else {
        state.displayHR = state.targetHR;
        screenHR.textContent = state.targetHR;
        screenHR.classList.remove('flash-danger');
    }
    
    // 血氧顯示判斷
    if (state.rhythm === 'VF' || state.rhythm === 'ASYST' || state.targetSpO2 === 0) {
        state.displaySpO2 = '---';
        screenSpO2.textContent = '---';
    } else {
        state.displaySpO2 = state.targetSpO2;
        screenSpO2.textContent = state.targetSpO2;
    }
    
    // etCO2與呼吸次數顯示
    if (!state.co2Active) {
        screenCO2.textContent = '---';
        screenRR.textContent = '---';
    } else if (state.rhythm === 'VF' || state.rhythm === 'ASYST') {
        screenCO2.textContent = state.targetCO2 > 10 ? 10 : state.targetCO2;
        screenRR.textContent = '0';
    } else {
        screenCO2.textContent = state.targetCO2;
        screenRR.textContent = state.targetRR;
    }

    // 動態更新 ART 壓力數值
    const bottomValART = document.getElementById('bottomValART');
    if (bottomValART) {
        if (!hasPulse) {
            bottomValART.textContent = "0/0 (0)";
        } else {
            const sys = state.targetBPSys;
            const dia = state.targetBPDia;
            const mean = Math.round(dia + (sys - dia) / 3);
            bottomValART.textContent = `${sys}/${dia} (${mean})`;
        }
    }
}

// 警報狀態檢測
function checkAlarms() {
    if (!state.deviceOn) return;
    
    const alarmBanner = document.getElementById('alarmBanner');
    const alarmLedBar = document.getElementById('alarmLedBar');
    
    let isCritical = false;
    let isWarning = false;
    let alarmMsg = "NO ACTIVE ALARMS";
    
    // 1. 去顫致命心律檢測
    if (state.rhythm === 'VF') {
        isCritical = true;
        alarmMsg = "【CRITICAL】VENTRICULAR FIBRILLATION";
    } else if (state.rhythm === 'VT' && state.targetHR > 150) {
        isCritical = true;
        alarmMsg = "【CRITICAL】VENTRICULAR TACHYCARDIA";
    } else if (state.rhythm === 'ASYST') {
        isCritical = true;
        alarmMsg = "【CRITICAL】ASYSTOLE (心搏停止)";
    }
    // 2. 生命徵象異常檢測
    else if (state.targetSpO2 < 90 && state.targetSpO2 > 0) {
        isCritical = true;
        alarmMsg = "【CRITICAL】LOW SpO2 SATE < 90%";
    } else if (state.targetHR < 40 && state.targetHR > 0) {
        isWarning = true;
        alarmMsg = "【WARNING】SEVERE BRADYCARDIA";
    } else if (state.targetHR > 140) {
        isWarning = true;
        alarmMsg = "【WARNING】SEVERE TACHYCARDIA";
    } else if (state.targetCO2 < 30 || state.targetCO2 > 45) {
        isWarning = true;
        alarmMsg = "【WARNING】etCO2 OUT OF LIMITS";
    }
    
    // 更新 UI 警報指示
    if (isCritical) {
        state.alarmType = 'critical';
        alarmBanner.textContent = alarmMsg;
        alarmBanner.className = 'alarm-banner active-alarm';
        alarmLedBar.className = 'alarm-led-bar critical';
        if (state.soundEnabled && !state.alarmMuted) startAlarmSound();
    } else if (isWarning) {
        state.alarmType = 'warning';
        alarmBanner.textContent = alarmMsg;
        alarmBanner.className = 'alarm-banner active-alarm';
        alarmLedBar.className = 'alarm-led-bar warning';
        if (state.soundEnabled && !state.alarmMuted) startAlarmSound();
    } else {
        state.alarmType = 'none';
        alarmBanner.textContent = "SYSTEM OK";
        alarmBanner.className = 'alarm-banner';
        alarmLedBar.className = 'alarm-led-bar stable';
        stopAlarmSound();
    }
}


// ==========================================================================
// 7. 去顫器與起搏器實體操作邏輯
// ==========================================================================

function initTherapyControls() {
    // ----------------去顫器 (Defib) 相關邏輯----------------
    const btnEnergyUp = document.getElementById('btnEnergyUp');
    const btnEnergyDown = document.getElementById('btnEnergyDown');
    const btnCharge = document.getElementById('btnCharge');
    const btnShock = document.getElementById('btnShock');
    const btnSync = document.getElementById('lblSync') || document.getElementById('btnSync');
    
    const screenDefibEnergy = document.getElementById('screenDefibEnergy');
    const screenDefibMsg = document.getElementById('screenDefibMsg');
    
    // 去顫能量升降
    if (btnEnergyUp) {
        btnEnergyUp.addEventListener('click', () => {
            if (!state.deviceOn) return;
            let idx = ENERGY_LEVELS.indexOf(state.defibEnergy);
            if (idx < ENERGY_LEVELS.length - 1) {
                state.defibEnergy = ENERGY_LEVELS[idx + 1];
                if (screenDefibEnergy) screenDefibEnergy.textContent = state.defibEnergy;
                document.getElementById('inputDefibEnergy').value = state.defibEnergy;
                playBeep(800, 0.05, 0);
                logEvent(`去顫能量設定為: ${state.defibEnergy} J`);
            }
        });
    }

    if (btnEnergyDown) {
        btnEnergyDown.addEventListener('click', () => {
            if (!state.deviceOn) return;
            let idx = ENERGY_LEVELS.indexOf(state.defibEnergy);
            if (idx > 0) {
                state.defibEnergy = ENERGY_LEVELS[idx - 1];
                if (screenDefibEnergy) screenDefibEnergy.textContent = state.defibEnergy;
                document.getElementById('inputDefibEnergy').value = state.defibEnergy;
                playBeep(800, 0.05, 0);
                logEvent(`去顫能量設定為: ${state.defibEnergy} J`);
            }
        });
    }

    // 充電按鈕
    if (btnCharge) {
        btnCharge.addEventListener('click', () => {
            if (!state.deviceOn || state.defibCharging || state.defibCharged) return;
            
            state.defibCharging = true;
            if (screenDefibMsg) {
                screenDefibMsg.textContent = "CHARGING...";
                screenDefibMsg.className = "defib-status-lbl charging";
            }
            logEvent(`去顫器啟動充電: ${state.defibEnergy} J`);
            
            // 播放充電音
            playChargeSound();
            
            // 模擬 1.5 秒充電過程
            setTimeout(() => {
                if (!state.deviceOn) return;
                state.defibCharging = false;
                state.defibCharged = true;
                stopChargeSound();
                
                // 充電完成，啟動衝擊按鈕閃爍，播放警示 Ready 音
                if (screenDefibMsg) {
                    screenDefibMsg.textContent = "SHOCK READY";
                    screenDefibMsg.className = "defib-status-lbl ready";
                }
                logEvent(`去顫器充電完成 (${state.defibEnergy} J) - READY`);
                
                btnShock.classList.remove('disabled');
                btnShock.classList.add('flashing');
                btnShock.disabled = false;
                document.getElementById('sidebarBtnShock').disabled = false;
                
                // 持續發出 Shock Ready 的高頻嗶聲
                pacerBeepInterval = setInterval(() => {
                    if (state.defibCharged && state.deviceOn && state.soundEnabled) {
                        playBeep(1200, 0.1, 0);
                    }
                }, 800);
                
            }, 1500);
        });
    }

    // 電擊放電按鈕
    if (btnShock) {
        btnShock.addEventListener('click', () => {
            if (!state.deviceOn || !state.defibCharged) return;
            
            // 清理 Ready 提示音
            if (pacerBeepInterval) {
                clearInterval(pacerBeepInterval);
                pacerBeepInterval = null;
            }
            
            // 播放放電音效
            playShockDischarge();
            logEvent(`⚡ 執行電擊放電 - 釋放能量: ${state.defibEnergy} J ⚡`);
            
            // 螢幕瞬間閃白
            const screen = document.getElementById('monitorScreen');
            screen.style.backgroundColor = '#ffffff';
            setTimeout(() => {
                screen.style.backgroundColor = '';
            }, 120);
            
            // 重設去顫充電狀態
            state.defibCharged = false;
            btnShock.classList.add('disabled');
            btnShock.classList.remove('flashing');
            btnShock.disabled = true;
            document.getElementById('sidebarBtnShock').disabled = true;
            if (screenDefibMsg) {
                screenDefibMsg.textContent = "DELIVERED";
                screenDefibMsg.className = "defib-status-lbl";
            }
            
            // 電擊事件後的心律轉換邏輯 (如果開啟自動轉，且原本是 shockable 心律)
            if (state.autoConvertOnShock && (state.rhythm === 'VF' || state.rhythm === 'VT')) {
                setTimeout(() => {
                    logEvent("電擊後成功轉復 (轉為 NSR 心律)");
                    // 自動跳回正常心律 NSR
                    document.getElementById('inputRhythm').value = 'NSR';
                    document.getElementById('inputRhythm').dispatchEvent(new Event('change'));
                }, 1000);
            } else {
                setTimeout(() => {
                    if (screenDefibMsg) screenDefibMsg.textContent = "SELECTED";
                }, 2000);
            }
        });
    }

    // 同步 (Sync) 切換
    if (btnSync) {
        btnSync.addEventListener('click', () => {
            if (!state.deviceOn) return;
            state.syncActive = !state.syncActive;
            btnSync.classList.toggle('active', state.syncActive);
            playBeep(900, 0.05, 0);
            
            logEvent(state.syncActive ? "開啟同步去顫模式 (SYNC)" : "關閉同步去顫模式 (SYNC)");
        });
    }

    // ----------------起搏器 (Pacer) 相關邏輯----------------
    const btnPacerToggle = document.getElementById('btnPacerToggle');
    const screenPacerStatus = document.getElementById('screenPacerStatus');
    
    if (btnPacerToggle) {
        btnPacerToggle.addEventListener('click', () => {
            if (!state.deviceOn) return;
            state.pacerActive = !state.pacerActive;
            
            btnPacerToggle.classList.toggle('active', state.pacerActive);
            playBeep(700, 0.08, 0);
            
            logEvent(state.pacerActive ? "開啟心臟起搏器 (Pacer)" : "關閉心臟起搏器 (Pacer)");
            
            if (state.pacerActive) {
                if (screenPacerStatus) screenPacerStatus.style.display = 'flex';
                state.pacerFocus = 'rate'; // 啟動後預設聚焦 Rate 調整
                syncPacerValues();
                updatePacerFocusUI();
                startPacerSoundLoop();
            } else {
                if (screenPacerStatus) screenPacerStatus.style.display = 'none';
                state.pacerFocus = 'none';
                updatePacerFocusUI();
                stopPacerSoundLoop();
            }
        });
    }

    // 點選螢幕上的 Rate 或 Output 直接聚焦
    const pacerRateWrapper = document.getElementById('pacerRateWrapper');
    const pacerOutputWrapper = document.getElementById('pacerOutputWrapper');
    if (pacerRateWrapper) {
        pacerRateWrapper.addEventListener('click', () => {
            if (!state.deviceOn || !state.pacerActive) return;
            state.pacerFocus = 'rate';
            playBeep(900, 0.02, 0);
            updatePacerFocusUI();
            logEvent("點選螢幕：聚焦於起搏速率調整");
        });
    }
    if (pacerOutputWrapper) {
        pacerOutputWrapper.addEventListener('click', () => {
            if (!state.deviceOn || !state.pacerActive) return;
            state.pacerFocus = 'output';
            playBeep(900, 0.02, 0);
            updatePacerFocusUI();
            logEvent("點選螢幕：聚焦於起搏電流調整");
        });
    }
}

// 同步 Pacer 的 Rate 和 Output 顯示值到畫面上
function syncPacerValues() {
    const valPacerRate = document.getElementById('valPacerRate');
    const valPacerOutput = document.getElementById('valPacerOutput');
    const screenPacerRate = document.getElementById('screenPacerRate');
    const screenPacerOutput = document.getElementById('screenPacerOutput');
    
    if (valPacerRate) valPacerRate.textContent = state.pacerRate;
    if (valPacerOutput) valPacerOutput.textContent = state.pacerOutput;
    if (screenPacerRate) screenPacerRate.textContent = state.pacerRate;
    if (screenPacerOutput) screenPacerOutput.textContent = state.pacerOutput;
}

// 更新起搏設定項目聚焦的 UI 狀態
function updatePacerFocusUI() {
    const rateWrapper = document.getElementById('pacerRateWrapper');
    const outputWrapper = document.getElementById('pacerOutputWrapper');
    
    if (rateWrapper) {
        rateWrapper.classList.toggle('focused', state.pacerFocus === 'rate');
    }
    if (outputWrapper) {
        outputWrapper.classList.toggle('focused', state.pacerFocus === 'output');
    }
}

// 起搏點擊音排程
let pacerAudioIntervalId = null;
function startPacerSoundLoop() {
    stopPacerSoundLoop();
    pacerAudioIntervalId = setInterval(() => {
        if (state.deviceOn && state.pacerActive) {
            playPacerClick();
        }
    }, 60000 / state.pacerRate);
}

function stopPacerSoundLoop() {
    if (pacerAudioIntervalId) {
        clearInterval(pacerAudioIntervalId);
        pacerAudioIntervalId = null;
    }
}

function restartPacerSoundLoop() {
    if (state.pacerActive) {
        startPacerSoundLoop();
    }
}


// ==========================================================================
// 8. NIBP 測量模擬 (2秒延遲)
// ==========================================================================
function triggerNIBPMeasurement() {
    if (!state.deviceOn || state.bpMeasuring) return;
    
    state.bpMeasuring = true;
    logEvent("開始 NIBP 血壓量測 (充氣中...)");
    
    // UI 反饋：開始閃動袖帶圖示與顯示破折號
    const cuffIcon = document.getElementById('cuffIcon');
    const screenBP = document.getElementById('screenBP');
    const screenBPMean = document.getElementById('screenBPMean');
    
    if (cuffIcon) cuffIcon.classList.add('inflating');
    screenBP.textContent = '---/---';
    screenBPMean.textContent = '---';
    
    // 播放一個短嗶聲與袖帶充氣的低沉嗡嗡聲 (模擬量血壓啟動)
    playBeep(500, 0.1, 0);
    initAudio();
    if (audioCtx && state.soundEnabled) {
        // 低頻震盪模擬充氣泵
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.setValueAtTime(65, audioCtx.currentTime);
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.08, audioCtx.currentTime + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.8);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 2.0);
    }
    
    // 2秒後顯示測量數值 (滿足 "等待時間在按鈕點選後兩秒出現")
    state.bpTimer = setTimeout(() => {
        state.bpMeasuring = false;
        if (cuffIcon) cuffIcon.classList.remove('inflating');
        
        // 若此時裝置已關閉，則不寫入數值
        if (!state.deviceOn) return;
        
        // 計算 Mean BP (平均動脈壓 = 舒張壓 + 1/3 * (收縮壓 - 舒張壓))
        const sys = state.targetBPSys;
        const dia = state.targetBPDia;
        const mean = Math.round(dia + (sys - dia) / 3);
        
        // 寫入實際顯示狀態
        state.displayBPSys = sys;
        state.displayBPDia = dia;
        state.displayBPMean = mean;
        
        // 獲取目前時間作為量測時間戳記
        const d = new Date();
        const hrs = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        state.displayBPTime = `${hrs}:${mins}`;
        
        // 渲染到螢幕
        screenBP.textContent = `${sys}/${dia}`;
        screenBPMean.textContent = `${mean}`;
        document.getElementById('screenBPTime').textContent = state.displayBPTime;
        
        // 播放量測完成短嗶音 (兩聲)
        playBeep(880, 0.08, 0);
        playBeep(880, 0.08, 0.12);
        
        logEvent(`NIBP 量測完成: ${sys}/${dia} mmHg (MAP: ${mean} mmHg)`);
        
    }, state.bpMeasureDuration);
}


// ==========================================================================
// 9. 裝置主電源開關
// ==========================================================================
function togglePower() {
    const chassis = document.querySelector('.zoll-chassis');
    const monitor = document.getElementById('monitorScreen');
    
    if (!state.deviceOn) {
        // 開機
        state.deviceOn = true;
        chassis.classList.add('power-on');
        monitor.classList.remove('off');
        
        // 播放開機和弦音
        playPowerOnSound();
        
        // 啟動運作計時器
        state.elapsedSeconds = 0;
        document.getElementById('screenElapsed').textContent = '00:00:00';
        state.elapsedTimer = setInterval(() => {
            state.elapsedSeconds++;
            const hrs = String(Math.floor(state.elapsedSeconds / 3600)).padStart(2, '0');
            const mins = String(Math.floor((state.elapsedSeconds % 3600) / 60)).padStart(2, '0');
            const secs = String(state.elapsedSeconds % 60).padStart(2, '0');
            document.getElementById('screenElapsed').textContent = `${hrs}:${mins}:${secs}`;
        }, 1000);
        
        // 啟動螢幕時鐘
        updateClock();
        
        // 載入當前狀態數值
        updateScreenNumerics();
        checkAlarms();
        
        // 記錄日誌
        logEvent("裝置電源已開啟");
        
        // 啟動波形動畫渲染
        initCanvases();
        renderWaveforms();
        
    } else {
        // 關機
        state.deviceOn = false;
        chassis.classList.remove('power-on');
        monitor.classList.add('off');
        
        // 記錄日誌
        logEvent("裝置電源已關閉");
        
        // 清理狀態與螢幕遮罩
        state.co2Active = false;
        state.twelveLeadActive = false;
        state.logActive = false;
        state.pacerActive = false;
        state.pacerFocus = 'none';
        updatePacerFocusUI();
        
        const lblCO2 = document.getElementById('lblCO2');
        if (lblCO2) lblCO2.classList.remove('active');
        
        const btnPhysicalCO2 = document.getElementById('btnPhysicalCO2');
        if (btnPhysicalCO2) btnPhysicalCO2.classList.remove('active');
        
        const btnPacerToggle = document.getElementById('btnPacerToggle');
        if (btnPacerToggle) btnPacerToggle.classList.remove('active');
        
        const screenPacerStatus = document.getElementById('screenPacerStatus');
        if (screenPacerStatus) screenPacerStatus.style.display = 'none';

        document.getElementById('twelveLeadScreen').style.display = 'none';
        document.getElementById('logScreen').style.display = 'none';
        document.getElementById('acquiringScreen').style.display = 'none';
        
        // 清理計時器
        clearInterval(state.elapsedTimer);
        state.elapsedTimer = null;
        
        // 關閉聲音與起搏音
        stopAlarmSound();
        stopPacerSoundLoop();
        if (pacerBeepInterval) {
            clearInterval(pacerBeepInterval);
            pacerBeepInterval = null;
        }
        
        // 取消動畫幀
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        
        // 重設治療按鈕狀態
        const btnShock = document.getElementById('btnShock');
        btnShock.classList.add('disabled');
        btnShock.classList.remove('flashing');
        btnShock.disabled = true;
        document.getElementById('sidebarBtnShock').disabled = true;
        
        // 清除 NIBP 測量
        if (state.bpTimer) {
            clearTimeout(state.bpTimer);
            state.bpTimer = null;
        }
        state.bpMeasuring = false;
        const cuffIcon = document.getElementById('cuffIcon');
        if (cuffIcon) cuffIcon.classList.remove('inflating');
    }
}

function updateClock() {
    if (!state.deviceOn) return;
    const d = new Date();
    const hrs = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');
    document.getElementById('screenClock').textContent = `${hrs}:${mins}:${secs}`;
    setTimeout(updateClock, 1000);
}


// ==========================================================================
// 10. 自動化時間軸情境 (Timeline Engine)
// ==========================================================================

function initTimeline() {
    renderTimelineTable();
    
    const btnPlay = document.getElementById('btnPlayTimeline');
    const btnPause = document.getElementById('btnPauseTimeline');
    const btnReset = document.getElementById('btnResetTimeline');
    const btnAdd = document.getElementById('btnAddTimelineStep');
    
    // 啟動情境
    btnPlay.addEventListener('click', () => {
        if (state.timelineRunning) return;
        state.timelineRunning = true;
        
        btnPlay.disabled = true;
        btnPause.disabled = false;
        document.getElementById('timelineStatusIndicator').textContent = "執行中";
        document.getElementById('timelineStatusIndicator').className = "status-indicator active";
        logEvent("啟動時間軸情境");
        
        // 核心計時迴圈
        state.timelineInterval = setInterval(() => {
            state.timelineSeconds++;
            
            // 更新時間顯示
            const mins = String(Math.floor(state.timelineSeconds / 60)).padStart(2, '0');
            const secs = String(state.timelineSeconds % 60).padStart(2, '0');
            document.getElementById('timelineTimer').textContent = `${mins}:${secs}`;
            
            // 檢查是否有匹配的步驟
            checkTimelineStep(state.timelineSeconds);
        }, 1000);
    });

    // 暫停情境
    btnPause.addEventListener('click', () => {
        if (!state.timelineRunning) return;
        state.timelineRunning = false;
        
        btnPlay.disabled = false;
        btnPause.disabled = true;
        document.getElementById('timelineStatusIndicator').textContent = "暫停";
        document.getElementById('timelineStatusIndicator').className = "status-indicator";
        logEvent("暫停時間軸情境");
        
        clearInterval(state.timelineInterval);
    });

    // 重設情境
    btnReset.addEventListener('click', () => {
        state.timelineRunning = false;
        state.timelineSeconds = 0;
        
        btnPlay.disabled = false;
        btnPause.disabled = true;
        document.getElementById('timelineTimer').textContent = "00:00";
        document.getElementById('timelineStatusIndicator').textContent = "停止中";
        document.getElementById('timelineStatusIndicator').className = "status-indicator";
        logEvent("重設時間軸情境");
        
        clearInterval(state.timelineInterval);
        
        // 取消所有高亮行
        document.querySelectorAll('#timelineTable tbody tr').forEach(tr => {
            tr.classList.remove('active');
        });
    });

    // 新增步驟
    btnAdd.addEventListener('click', () => {
        const time = parseInt(document.getElementById('addStepTime').value);
        const rhythm = document.getElementById('addStepRhythm').value;
        const hr = parseInt(document.getElementById('addStepHR').value);
        const spo2 = parseInt(document.getElementById('addStepSpO2').value);
        const bpSys = parseInt(document.getElementById('addStepBPSys').value);
        const bpDia = parseInt(document.getElementById('addStepBPDia').value);
        const co2 = parseInt(document.getElementById('addStepCO2').value);
        const rr = parseInt(document.getElementById('addStepRR').value);
        
        if (isNaN(time) || time < 0) {
            alert("請輸入有效的時間！");
            return;
        }

        // 新增進陣列
        state.timelineSteps.push({
            time, rhythm, hr, spo2, bpSys, bpDia, co2, rr,
            desc: `自訂階段 (${rhythm})`
        });
        
        // 重新排序 (時間從小到大)
        state.timelineSteps.sort((a, b) => a.time - b.time);
        
        renderTimelineTable();
    });
}

// 繪製時間軸表格
function renderTimelineTable() {
    const tbody = document.querySelector('#timelineTable tbody');
    tbody.innerHTML = '';
    
    state.timelineSteps.forEach((step, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.time = step.time;
        tr.innerHTML = `
            <td>${step.time}s</td>
            <td>${step.rhythm}</td>
            <td>${step.hr}</td>
            <td>${step.spo2}%</td>
            <td>${step.bpSys}/${step.bpDia}</td>
            <td>${step.co2}</td>
            <td>${step.rr}</td>
            <td><button class="btn-del-step" data-idx="${idx}">×</button></td>
        `;
        
        // 刪除按鈕
        tr.querySelector('.btn-del-step').addEventListener('click', (e) => {
            const i = parseInt(e.target.dataset.idx);
            state.timelineSteps.splice(i, 1);
            renderTimelineTable();
            e.stopPropagation();
        });
        
        tbody.appendChild(tr);
    });
}

// 檢查並觸發時間軸步驟
function checkTimelineStep(seconds) {
    // 找出所有時間相符的步驟
    const steps = state.timelineSteps.filter(s => s.time === seconds);
    if (steps.length === 0) return;
    
    const step = steps[0];
    logEvent(`時間軸自動觸發步驟 (${step.time}秒): 變更心律為 ${step.rhythm}, HR: ${step.hr}, SpO2: ${step.spo2}%, BP: ${step.bpSys}/${step.bpDia}, etCO2: ${step.co2}, RR: ${step.rr}`);
    
    // 高亮顯示表格中的該行
    document.querySelectorAll('#timelineTable tbody tr').forEach(tr => {
        if (parseInt(tr.dataset.time) === step.time) {
            tr.classList.add('active');
            tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            tr.classList.remove('active');
        }
    });

    // 觸發生命徵象改變 (後台數值同步變更，並連動螢幕)
    state.rhythm = step.rhythm;
    state.targetHR = step.hr;
    state.targetSpO2 = step.spo2;
    state.targetBPSys = step.bpSys;
    state.targetBPDia = step.bpDia;
    state.targetCO2 = step.co2;
    state.targetRR = step.rr;
    
    // 更新控制面板介面
    document.getElementById('inputRhythm').value = step.rhythm;
    document.getElementById('inputHR').value = step.hr;
    document.getElementById('valHR').textContent = step.hr;
    document.getElementById('inputSpO2').value = step.spo2;
    document.getElementById('valSpO2').textContent = step.spo2;
    document.getElementById('inputCO2').value = step.co2;
    document.getElementById('valCO2').textContent = step.co2;
    document.getElementById('inputRR').value = step.rr;
    document.getElementById('valRR').textContent = step.rr;
    document.getElementById('inputBPSys').value = step.bpSys;
    document.getElementById('inputBPDia').value = step.bpDia;

    updateScreenNumerics();
    checkAlarms();
    
    // 去顫放電準備重設 (如果突然心跳停止)
    if (step.rhythm === 'ASYST' || step.rhythm === 'VF') {
        const btnShock = document.getElementById('btnShock');
        state.defibCharged = false;
        btnShock.classList.add('disabled');
        btnShock.classList.remove('flashing');
        btnShock.disabled = true;
        document.getElementById('sidebarBtnShock').disabled = true;
        document.getElementById('screenDefibMsg').textContent = "SELECTED";
        document.getElementById('screenDefibMsg').className = "defib-status-lbl";
    }
}


// ==========================================================================
// 11. 實體旋鈕、警報暫停等一般按鈕事件
// ==========================================================================
function initGeneralButtons() {
    // 電源開關
    document.getElementById('btnPower').addEventListener('click', () => {
        togglePower();
    });

    // 警報暫停鈕 (暫停音效 90 秒)
    const btnAlarmSuspend = document.getElementById('btnAlarmSuspend');
    if (btnAlarmSuspend) {
        btnAlarmSuspend.addEventListener('click', () => {
            if (!state.deviceOn) return;
            
            playBeep(1000, 0.05, 0);
            state.alarmMuted = !state.alarmMuted;
            
            const alarmBanner = document.getElementById('alarmBanner');
            
            if (state.alarmMuted) {
                // Muted state
                btnAlarmSuspend.style.backgroundColor = '#fbc02d'; // 黃亮提示
                if (state.alarmType !== 'none') {
                    alarmBanner.textContent = "【SUSPENDED】" + alarmBanner.textContent.replace("【CRITICAL】", "").replace("【WARNING】", "");
                }
                stopAlarmSound();
                logEvent("警報音效已暫停 (90秒)");
                
                // 90秒後自動解除靜音
                state.alarmMuteTimer = setTimeout(() => {
                    state.alarmMuted = false;
                    btnAlarmSuspend.style.backgroundColor = '';
                    checkAlarms();
                    logEvent("警報暫停時效已過，恢復警報偵測");
                }, 90000);
            } else {
                // Unmuted state
                btnAlarmSuspend.style.backgroundColor = '';
                if (state.alarmMuteTimer) {
                    clearTimeout(state.alarmMuteTimer);
                    state.alarmMuteTimer = null;
                }
                checkAlarms();
                logEvent("手動解除警報暫停");
            }
        });
    }

    // 實體機上的 NIBP 量測按鈕
    const btnPhysicalNIBP = document.getElementById('btnPhysicalNIBP');
    if (btnPhysicalNIBP) {
        btnPhysicalNIBP.addEventListener('click', () => {
            triggerNIBPMeasurement();
        });
    }

    // 螢幕上的 NIBP Start 快捷標籤
    const lblNIBPStart = document.getElementById('lblNIBPStart');
    if (lblNIBPStart) {
        lblNIBPStart.addEventListener('click', () => {
            triggerNIBPMeasurement();
        });
    }

    // 實體/螢幕 etCO2 開關按鈕 (lblCO2 & btnPhysicalCO2)
    const lblCO2 = document.getElementById('lblCO2');
    const btnPhysicalCO2 = document.getElementById('btnPhysicalCO2');
    
    function toggleCO2Monitoring() {
        if (!state.deviceOn) return;
        
        state.co2Active = !state.co2Active;
        
        if (lblCO2) lblCO2.classList.toggle('active', state.co2Active);
        if (btnPhysicalCO2) btnPhysicalCO2.classList.toggle('active', state.co2Active);
        
        playBeep(900, 0.05, 0);
        logEvent(state.co2Active ? "開啟 etCO2 監測" : "關閉 etCO2 監測");
        updateScreenNumerics();
        
        // 重新初始化波形 Canvas，確保 CO2 波形狀態正常
        setTimeout(initCanvases, 50);
    }
    
    if (lblCO2) lblCO2.addEventListener('click', toggleCO2Monitoring);
    if (btnPhysicalCO2) btnPhysicalCO2.addEventListener('click', toggleCO2Monitoring);

    // 12 導程 (12-Lead) 相關事件與獲取流程
    const lblTwelveLead = document.getElementById('lblTwelveLead');
    const btnExitTwelveLead = document.getElementById('btnExitTwelveLead');
    const acquiringScreen = document.getElementById('acquiringScreen');
    const acquiringProgressBar = document.getElementById('acquiringProgressBar');
    const twelveLeadScreen = document.getElementById('twelveLeadScreen');
    const twelveLeadReportText = document.getElementById('twelveLeadReportText');
    const twelveLeadTime = document.getElementById('twelveLeadTime');

    function acquireTwelveLead() {
        if (!state.deviceOn || state.twelveLeadActive || state.bpMeasuring) return;
        
        // 暫時隱藏 log 頁面如果打開的話
        if (state.logActive) {
            closeLogScreen();
        }

        playBeep(1000, 0.1, 0);
        logEvent("觸發 12 導程擷取 - 訊號讀取中...");
        
        // 顯示讀取中畫面，進度條跑 2 秒
        acquiringScreen.style.display = 'flex';
        acquiringProgressBar.style.width = '0%';
        
        let progress = 0;
        const intervalTime = 50; 
        const duration = 2000;   
        const steps = duration / intervalTime;
        const stepInc = 100 / steps;
        
        const progressInterval = setInterval(() => {
            if (!state.deviceOn) {
                clearInterval(progressInterval);
                acquiringScreen.style.display = 'none';
                return;
            }
            
            progress += stepInc;
            acquiringProgressBar.style.width = `${Math.min(100, progress)}%`;
            
            // 讀取中的點擊短音
            if (Math.round(progress) % 25 === 0) {
                playBeep(1100, 0.03, 0);
            }
            
            if (progress >= 100) {
                clearInterval(progressInterval);
                acquiringScreen.style.display = 'none';
                
                // 進入 12 導程畫面
                state.twelveLeadActive = true;
                twelveLeadScreen.style.display = 'flex';
                
                // 初始化 12 導程波形小畫布
                initTwelveLeadCanvases();
                
                // 播放完成 chime
                playLINENotification();
                logEvent("12 導程擷取完成 - 進入診斷報告畫面");
                
                // 更新診斷文字與時間
                updateTwelveLeadReport();
            }
        }, intervalTime);
    }
    
    function updateTwelveLeadReport() {
        const d = new Date();
        twelveLeadTime.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        
        if (state.rhythm === 'STEMI') {
            twelveLeadReportText.textContent = "★ ACUTE MI / INFERIOR-ANTERIOR STEMI DETECTED ★";
            twelveLeadReportText.className = "report-text critical-report";
        } else if (state.rhythm === 'VT') {
            twelveLeadReportText.textContent = "★ MONOMORPHIC VENTRICULAR TACHYCARDIA (VT) ★";
            twelveLeadReportText.className = "report-text critical-report";
        } else if (state.rhythm === 'VF') {
            twelveLeadReportText.textContent = "★ VENTRICULAR FIBRILLATION (VF) - ARREST ★";
            twelveLeadReportText.className = "report-text critical-report";
        } else if (state.rhythm === 'ASYST') {
            twelveLeadReportText.textContent = "★ ASYSTOLE - CHECK PULSE AND CAPNOGRAPHY ★";
            twelveLeadReportText.className = "report-text critical-report";
        } else if (state.rhythm === 'PEA') {
            twelveLeadReportText.textContent = "★ PEA - PULSELESS ELECTRICAL ACTIVITY ★";
            twelveLeadReportText.className = "report-text critical-report";
        } else if (state.rhythm === 'AF') {
            twelveLeadReportText.textContent = "ATRIAL FIBRILLATION (AF) - UNCONTROLLED RESPONSE";
            twelveLeadReportText.className = "report-text";
        } else if (state.rhythm === 'SB') {
            twelveLeadReportText.textContent = "SINUS BRADYCARDIA (SB) - SLOW ECG RATE";
            twelveLeadReportText.className = "report-text";
        } else if (state.rhythm === 'ST') {
            twelveLeadReportText.textContent = "SINUS TACHYCARDIA (ST) - ELEVATED ECG RATE";
            twelveLeadReportText.className = "report-text";
        } else {
            twelveLeadReportText.textContent = "NORMAL SINUS RHYTHM (NSR) - NO SIGNIFICANT ST SHIFT";
            twelveLeadReportText.className = "report-text";
        }
    }

    if (lblTwelveLead) lblTwelveLead.addEventListener('click', acquireTwelveLead);
    
    if (btnExitTwelveLead) {
        btnExitTwelveLead.addEventListener('click', () => {
            state.twelveLeadActive = false;
            twelveLeadScreen.style.display = 'none';
            if (state.deviceOn) {
                playBeep(800, 0.05, 0);
                logEvent("返回監測畫面 (HOME)");
                // 重新初始化主波形畫布，確保主頁繪圖正常
                setTimeout(initCanvases, 50);
            }
        });
    }

    // LOG 歷史紀錄相關事件
    const lblLog = document.getElementById('lblLog');
    const btnExitLog = document.getElementById('btnExitLog');
    const btnClearLog = document.getElementById('btnClearLog');
    const logScreen = document.getElementById('logScreen');
    
    function toggleLogScreen() {
        if (!state.deviceOn) return;
        
        state.logActive = !state.logActive;
        playBeep(900, 0.05, 0);
        
        if (state.logActive) {
            // 隱藏 12 導程畫面
            if (state.twelveLeadActive) {
                state.twelveLeadActive = false;
                twelveLeadScreen.style.display = 'none';
            }
            logScreen.style.display = 'flex';
            logEvent("開啟歷史紀錄頁面 (檢視操作 Log)");
            
            // 捲動至底部
            const logBody = document.querySelector('.log-screen .log-body');
            if (logBody) {
                setTimeout(() => {
                    logBody.scrollTop = logBody.scrollHeight;
                }, 50);
            }
        } else {
            closeLogScreen();
        }
    }
    
    function closeLogScreen() {
        state.logActive = false;
        logScreen.style.display = 'none';
        if (state.deviceOn) {
            logEvent("返回監測畫面 (HOME)");
            setTimeout(initCanvases, 50);
        }
    }
    
    if (lblLog) lblLog.addEventListener('click', toggleLogScreen);
    if (btnExitLog) {
        btnExitLog.addEventListener('click', () => {
            playBeep(800, 0.05, 0);
            closeLogScreen();
        });
    }
    if (btnClearLog) {
        btnClearLog.addEventListener('click', () => {
            state.logs = [];
            const logList = document.getElementById('logList');
            if (logList) logList.innerHTML = '';
            playBeep(600, 0.08, 0);
            logEvent("歷史操作紀錄已清除");
        });
    }

    // 飛梭旋鈕旋轉與按鍵效果 (支援起搏器設定方向鍵/Select調整)
    document.getElementById('btnNavUp').addEventListener('click', () => {
        if (!state.deviceOn) return;
        
        if (state.pacerActive && state.pacerFocus !== 'none') {
            playBeep(900, 0.015, 0);
            if (state.pacerFocus === 'rate') {
                state.pacerRate = Math.min(180, state.pacerRate + 5);
                const inputPacerRate = document.getElementById('inputPacerRate');
                if (inputPacerRate) inputPacerRate.value = state.pacerRate;
                syncPacerValues();
                restartPacerSoundLoop();
                logEvent(`方向鍵 ▲ 調整起搏速率: ${state.pacerRate} ppm`);
            } else if (state.pacerFocus === 'output') {
                state.pacerOutput = Math.min(140, state.pacerOutput + 5);
                const inputPacerOutput = document.getElementById('inputPacerOutput');
                if (inputPacerOutput) inputPacerOutput.value = state.pacerOutput;
                syncPacerValues();
                logEvent(`方向鍵 ▲ 調整起搏電流: ${state.pacerOutput} mA`);
            }
        } else {
            playBeep(900, 0.015, 0);
            logEvent("方向鍵 ▲ 被點選");
        }
    });

    document.getElementById('btnNavDown').addEventListener('click', () => {
        if (!state.deviceOn) return;
        
        if (state.pacerActive && state.pacerFocus !== 'none') {
            playBeep(900, 0.015, 0);
            if (state.pacerFocus === 'rate') {
                state.pacerRate = Math.max(30, state.pacerRate - 5);
                const inputPacerRate = document.getElementById('inputPacerRate');
                if (inputPacerRate) inputPacerRate.value = state.pacerRate;
                syncPacerValues();
                restartPacerSoundLoop();
                logEvent(`方向鍵 ▼ 調整起搏速率: ${state.pacerRate} ppm`);
            } else if (state.pacerFocus === 'output') {
                state.pacerOutput = Math.max(0, state.pacerOutput - 5);
                const inputPacerOutput = document.getElementById('inputPacerOutput');
                if (inputPacerOutput) inputPacerOutput.value = state.pacerOutput;
                syncPacerValues();
                logEvent(`方向鍵 ▼ 調整起搏電流: ${state.pacerOutput} mA`);
            }
        } else {
            playBeep(900, 0.015, 0);
            logEvent("方向鍵 ▼ 被點選");
        }
    });
    
    document.getElementById('btnNavLeft').addEventListener('click', () => {
        if (!state.deviceOn) return;
        
        if (state.pacerActive) {
            playBeep(900, 0.015, 0);
            state.pacerFocus = 'rate';
            updatePacerFocusUI();
            logEvent("方向鍵 ◀ 選擇起搏速率調整 (RATE)");
        } else {
            playBeep(900, 0.015, 0);
            logEvent("方向鍵 ◀ 被點選");
        }
    });

    document.getElementById('btnNavRight').addEventListener('click', () => {
        if (!state.deviceOn) return;
        
        if (state.pacerActive) {
            playBeep(900, 0.015, 0);
            state.pacerFocus = 'output';
            updatePacerFocusUI();
            logEvent("方向鍵 ▶ 選擇起搏電流調整 (OUTPUT)");
        } else {
            playBeep(900, 0.015, 0);
            logEvent("方向鍵 ▶ 被點選");
        }
    });

    document.getElementById('btnNavSelect').addEventListener('click', () => {
        if (!state.deviceOn) return;
        
        if (state.pacerActive) {
            playBeep(800, 0.04, 0);
            // SELECT 循環切換：none -> rate -> output -> none
            if (state.pacerFocus === 'none') {
                state.pacerFocus = 'rate';
            } else if (state.pacerFocus === 'rate') {
                state.pacerFocus = 'output';
            } else {
                state.pacerFocus = 'none';
            }
            updatePacerFocusUI();
            logEvent(`按下 SELECT 選擇鍵，切換起搏焦點為: ${state.pacerFocus}`);
        } else {
            playBeep(800, 0.04, 0);
            logEvent("按下 SELECT 選擇鍵");
        }
    });

    // 實體 Home 按鈕
    const btnPhysicalHome = document.getElementById('btnPhysicalHome');
    if (btnPhysicalHome) {
        btnPhysicalHome.addEventListener('click', () => {
            if (!state.deviceOn) return;
            playBeep(800, 0.05, 0);
            if (state.twelveLeadActive) {
                state.twelveLeadActive = false;
                twelveLeadScreen.style.display = 'none';
            }
            if (state.logActive) {
                state.logActive = false;
                logScreen.style.display = 'none';
            }
            logEvent("返回監測畫面 (HOME)");
            setTimeout(initCanvases, 50);
        });
    }

    // 螢幕截圖儲存函數
    function takeScreenShot() {
        if (!state.deviceOn) return;
        const monitor = document.getElementById('monitorScreen');
        if (!monitor) return;
        
        logEvent("啟動畫面截圖並儲存至電腦...");
        
        if (typeof html2canvas !== 'undefined') {
            html2canvas(monitor, {
                backgroundColor: '#000000',
                scale: 2,
                logging: false,
                useCORS: true
            }).then(canvas => {
                const dataUrl = canvas.toDataURL('image/png');
                const link = document.createElement('a');
                const d = new Date();
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const hrs = String(d.getHours()).padStart(2, '0');
                const mins = String(d.getMinutes()).padStart(2, '0');
                const secs = String(d.getSeconds()).padStart(2, '0');
                
                link.download = `ZOLL_Simulator_${year}${month}${day}_${hrs}${mins}${secs}.png`;
                link.href = dataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                logEvent("螢幕截圖已成功存檔");
            }).catch(err => {
                console.error("html2canvas screenshot error:", err);
                logEvent("螢幕截圖失敗: " + err.message);
            });
        } else {
            console.error("未載入 html2canvas.min.js");
            logEvent("螢幕截圖失敗 (未載入 html2canvas)");
            alert("系統錯誤：未偵測到截圖套件 (html2canvas.min.js)，無法完成截圖。");
        }
    }

    // 實體 Camera/Snapshot/Print 按鈕
    const btnPhysicalCamera = document.getElementById('btnPhysicalCamera');
    if (btnPhysicalCamera) {
        btnPhysicalCamera.addEventListener('click', () => {
            if (!state.deviceOn) return;
            playBeep(1000, 0.08, 0);
            takeScreenShot();
        });
    }

    // 實體/螢幕 Lead Select
    const lblLeadSelect = document.getElementById('lblLeadSelect');
    if (lblLeadSelect) {
        lblLeadSelect.addEventListener('click', () => {
            if (!state.deviceOn) return;
            const leads = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
            const leadEl = document.querySelector('.lead-select');
            if (leadEl) {
                let currentLead = leadEl.textContent.trim();
                let nextIdx = (leads.indexOf(currentLead) + 1) % leads.length;
                leadEl.textContent = leads[nextIdx];
                playBeep(900, 0.05, 0);
                logEvent(`切換 ECG 顯示導程為: ${leads[nextIdx]}`);
            }
        });
    }

    // 實體/螢幕 Treatment Menu
    const lblRx = document.getElementById('lblRx');
    if (lblRx) {
        lblRx.addEventListener('click', () => {
            if (!state.deviceOn) return;
            playBeep(900, 0.05, 0);
            logEvent("開啟治療選單 (Rx Menu)");
        });
    }

    // 實體/螢幕 Print Menu
    const lblPrint = document.getElementById('lblPrint');
    if (lblPrint) {
        lblPrint.addEventListener('click', () => {
            if (!state.deviceOn) return;
            playBeep(1000, 0.08, 0);
            takeScreenShot();
        });
    }

    // 綁定左側實體軟鍵 (skey1 - skey8) 到螢幕對應選單
    const softkeyMappings = {
        skey1: 'lblMenu1',
        skey2: 'lblLeadSelect',
        skey3: 'lblTwelveLead',
        skey4: 'lblCO2',
        skey5: 'lblRx',
        skey6: 'lblSync',
        skey7: 'lblPrint',
        skey8: 'lblLog'
    };
    
    for (const [skeyId, lblId] of Object.entries(softkeyMappings)) {
        const skey = document.getElementById(skeyId);
        const lbl = document.getElementById(lblId);
        if (skey && lbl) {
            skey.addEventListener('click', () => {
                lbl.click();
            });
        }
    }

    // LINE 群組傳送按鈕與 Modal 控制
    const btnLINE = document.getElementById('btnLINE');
    const lineModal = document.getElementById('lineModal');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const lineReportImg = document.getElementById('lineReportImg');

    if (btnLINE) {
        btnLINE.addEventListener('click', () => {
            if (!state.deviceOn) return;

            // 依據目前的心律載入對應圖檔
            if (state.rhythm === 'STEMI') {
                lineReportImg.src = 'Stemi.png';
            } else if (state.rhythm === 'VT') {
                lineReportImg.src = 'VT.png';
            } else {
                lineReportImg.src = '無明顯.png';
            }

            // 開啟彈出視窗
            lineModal.classList.add('open');
            playLINENotification();
            logEvent(`傳送 LINE 12導程回報，目前心律: ${state.rhythm}`);
        });
    }

    // 關閉 Modal
    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => {
            lineModal.classList.remove('open');
            if (state.deviceOn) playBeep(800, 0.05, 0);
        });
    }

    // 點選遮罩背景也可關閉
    if (lineModal) {
        lineModal.addEventListener('click', (e) => {
            if (e.target === lineModal) {
                lineModal.classList.remove('open');
                if (state.deviceOn) playBeep(800, 0.05, 0);
            }
        });
    }
}


// ==========================================================================
// 12. 網頁載入完成初始化
// ==========================================================================
window.addEventListener('DOMContentLoaded', () => {
    initControlPanel();
    initGeneralButtons();
    initTherapyControls();
    initTimeline();
    
    // 當視窗縮放時，重新調整 Canvas 尺寸避免圖像拉伸
    window.addEventListener('resize', () => {
        if (state.deviceOn) {
            initCanvases();
        }
    });
});
