// ============================================================
// 物流面单扫描工具 — 摄像头实时识别
// 双引擎：原生 BarcodeDetector (Chrome/Edge) + zxing-wasm (iOS Safari)
// ============================================================

'use strict';

// ---------- 常量 ----------

const STORAGE_KEY = 'labelScannerResults';
const SETTINGS_KEY = 'labelScannerSettings';
const FOCUS_WAIT_MS = 2000;      // 扫描前手动对焦等待
const IMAGE_MAX_SIDE = 1600;     // 本地图片识别时缩放长边上限（兼顾速度与识别率）
// AI 服务预设（设置里二选一自动填入；都支持浏览器直连 CORS）
const AI_SERVICES = {
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001' },
  groq: { base: 'https://api.groq.com/openai/v1', model: 'llama-3.2-11b-vision-preview' }
};
const DEFAULT_SETTINGS = { aiEnabled: false, aiBaseUrl: AI_SERVICES.openrouter.base, aiApiKey: '', aiModel: AI_SERVICES.openrouter.model, ocrEnabled: true };

// ---------- 状态 ----------

let engine = null;
let scanning = false;
let wakeLock = null;
let torchOn = false;
let torchTrack = null;
let scanRafId = null;
let scanTimer = null;
let slowMode = false;      // 帧率自适应：慢速模式
let slowStreak = 0;
let fastStreak = 0;
let focusWaiting = false;  // 对焦等待期（扫描循环不启动）
let focusWaitTimer = null;
let ocrBusy = false;       // OCR 运行中（暂停扫描循环）
let ocrWorkerPromise = null;
let imageBusy = false;     // 图片识别进行中（防重入 + 拦截扫描）
let paused = false;        // 扫描循环暂停（摄像头保留）

// 离屏 canvas（ROI 裁剪用）
const roiCanvas = document.createElement('canvas');
const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

const results = loadResults();

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const video = $('video');
const btnStart = $('btn-start');
const btnTorch = $('btn-torch-toggle');
const btnTorchIcon = $('btn-torch');
const checkAll = $('check-all');
const scanOverlay = $('scan-overlay');
const scanFrameEl = $('scan-frame');
const scanFlash = $('scan-flash');
const cameraPlaceholder = $('camera-placeholder');
const connStatus = $('conn-status');
const engineBadge = $('engine-badge');
const regionSelect = $('region-select');
const settingsModal = $('settings-modal');
const btnImage = $('btn-image');
const fileImage = $('file-image');
const btnPause = $('btn-pause');
const btnOcr = $('btn-ocr');
const toast = $('toast');

// ---------- 工具函数 ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 单号校验：0-3 字母 + ≥9 数字，总长 ≥12
function isValidTrackingNo(text) {
  if (!text) return false;
  return /^[A-Z]{0,3}\d{9,}$/.test(String(text).trim().toUpperCase());
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function formatLabel(fmt) {
  const map = {
    // ZXing JS / 原生 BarcodeDetector (大写下划线)
    'CODE_128': 'CODE128',
    'QR_CODE': 'QR',
    'CODE_39': 'CODE39',
    'ITF': 'ITF',
    'CODABAR': 'Codabar',
    'EAN_13': 'EAN13',
    'EAN_8': 'EAN8',
    // zxing-wasm (PascalCase 转大写)
    'CODE128': 'CODE128',
    'QRCODE': 'QR',
    'CODE39': 'CODE39',
    'CODABAR': 'Codabar',
    'EAN-13': 'EAN13',
    'EAN-8': 'EAN8'
  };
  return map[String(fmt)] || String(fmt);
}

// 识别方式：从条码格式推导（条形/二维/OCR/AI）
function recognitionMethod(fmt) {
  const f = String(fmt || '').toUpperCase();
  if (f === 'OCR') return 'OCR';
  if (f === 'AI') return 'AI';
  if (f === 'MANUAL') return '—';
  if (f.includes('QR')) return '二维';
  return '条形';
}

// ---------- 地区规则 ----------

// 通用规则：宽泛单号格式（无地区指定时用）
const GENERIC_CARRIERS = [
  { name: '字母数字', re: /^[A-Z]{0,3}\d{9,}$/, score: 60 },
  { name: '纯数字',   re: /^\d{8,16}$/,          score: 50 }
];

// 各地区承运商规则 —— 新增地区只需在此追加 + 下拉框加一项
const REGION_RULES = {
  PH: {
    name: '菲律宾',
    carriers: [
      { name: 'J&T',     re: /^JT\d{10,16}$/i,  score: 100 },
      { name: 'JD',      re: /^JD\d{10,16}$/i,  score: 95 },
      { name: 'LP',      re: /^LP\d{10,16}$/i,  score: 95 },
      { name: '纯数字',   re: /^\d{8,16}$/,      score: 70 },
      { name: '字母数字', re: /^[A-Z]{0,3}\d{9,}$/i, score: 60 }
    ]
  }
};

// 当前生效的规则（对应下拉框选择），返回 null 表示不启用规则
function getActiveRules() {
  const v = regionSelect.value;
  if (v === 'PH') return REGION_RULES.PH;
  if (v === 'generic') return { name: '通用', carriers: GENERIC_CARRIERS };
  return null;
}

// 候选打分：二维码优先 + 承运商格式匹配，返回 {score, carrier} 或 null
function scoreCandidate(text, fmt, rules) {
  const upper = String(text).trim().toUpperCase();
  if (!upper) return null;
  // PH 面单单号编码在二维码中，二维码优先；条形码低权重（重复/旧值靠规则排除）
  const isQR = /QR/.test(fmt);
  let score = isQR ? 100 : 30;
  let carrier = '';
  if (rules) {
    for (const c of rules.carriers) {
      if (c.re.test(upper)) { carrier = c.name; score += c.score; break; }
    }
    if (!carrier) score -= 200;   // 不匹配任何承运商格式 → 无关码（如公众号二维码）
  } else if (/^[A-Z]{0,3}\d{9,}$/.test(upper)) {
    score += 30;
  }
  return { score, carrier };
}

// 多候选点选弹窗（title 可自定义）
function askUserPick(cands, title = '识别到多个候选，请确认单号') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;padding:16px;max-width:340px;width:90%;max-height:80vh;overflow-y:auto;';
    box.innerHTML = `<div style="font-size:15px;font-weight:600;margin-bottom:10px">${escapeHTML(title)}</div>`;
    cands.forEach(c => {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;width:100%;padding:10px 12px;margin:6px 0;border:1px solid #e0e0e0;border-radius:8px;background:#fafafa;font-size:13px;text-align:left;cursor:pointer;';
      const tag = /QR/.test(c.format) ? '二维码' : '条形码';
      btn.innerHTML = `<div style="font-family:Consolas,monospace;font-weight:600;word-break:break-all">${escapeHTML(c.text)}</div>` +
        `<div style="color:#888;font-size:11px;margin-top:3px">${escapeHTML(formatLabel(c.format))} · ${tag}${c.carrier ? ' · ' + c.carrier : ''}</div>`;
      btn.addEventListener('click', () => { overlay.remove(); resolve(c); });
      box.appendChild(btn);
    });
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'display:block;width:100%;padding:9px;margin-top:8px;border:none;border-radius:8px;background:#f0f0f0;font-size:13px;cursor:pointer;';
    cancel.addEventListener('click', () => { overlay.remove(); resolve(null); });
    box.appendChild(cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function showToast(msg, ms) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = ms ? setTimeout(() => toast.classList.add('hidden'), ms) : null;
}
function hideToast() { toast.classList.add('hidden'); }

function setEngineBadge(name) {
  engineBadge.textContent = name ? `[${name}]` : '';
}

// 保存当前编辑中的输入框状态（render 重建 DOM 后恢复）
function preserveInputFocus() {
  const el = document.activeElement;
  if (!el || !(el.classList.contains('note-input') || el.classList.contains('tracking-input'))) return null;
  return { id: el.dataset.id, selStart: el.selectionStart, selEnd: el.selectionEnd };
}

function restoreInputFocus(state) {
  if (!state || !state.id) return;
  const tbody = $('result-body');
  const newEl = tbody.querySelector(`.note-input[data-id="${state.id}"], .tracking-input[data-id="${state.id}"]`);
  if (!newEl) return;
  newEl.focus();
  try { newEl.setSelectionRange(state.selStart, state.selEnd); } catch (e) {}
}

// 摄像头错误友好提示
function friendlyMediaError(e) {
  const name = e && e.name;
  const map = {
    NotAllowedError: '摄像头权限被拒绝，请在浏览器设置中允许访问',
    PermissionDeniedError: '摄像头权限被拒绝，请在浏览器设置中允许访问',
    NotFoundError: '未找到可用摄像头',
    DevicesNotFoundError: '未找到可用摄像头',
    NotReadableError: '摄像头被其他应用占用，请关闭后重试',
    OverconstrainedError: '无法满足摄像头设置，请换设备或刷新重试'
  };
  return map[name] || (e && e.message) || '启动失败';
}

// 帧率自适应统计
function updateFrameStats(ms) {
  if (slowMode) {
    if (ms < 80) { fastStreak++; slowStreak = 0; if (fastStreak >= 5) slowMode = false; }
    else fastStreak = 0;
  } else {
    if (ms > 150) { slowStreak++; fastStreak = 0; if (slowStreak >= 3) slowMode = true; }
    else slowStreak = 0;
  }
}

// ---------- 设置存储 ----------

function getSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) };
    // 旧数据兜底：空值补默认（AI 地址/模型预填）
    if (!s.aiBaseUrl) s.aiBaseUrl = DEFAULT_SETTINGS.aiBaseUrl;
    if (!s.aiModel) s.aiModel = DEFAULT_SETTINGS.aiModel;
    return s;
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function aiReady() {
  const s = getSettings();
  return s.aiEnabled && s.aiBaseUrl && s.aiApiKey && s.aiModel;
}

// 浏览器 CORS 拦截特征：跨域 fetch 失败时报 TypeError / Failed to fetch
function isCorsError(e) {
  return e instanceof TypeError || /networkerror|failed to fetch|load failed|fetch.*failed/i.test(e.message || '');
}

// 蜂鸣音效
let audioCtx = null;
function beep(freq, duration) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq || 800;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (duration || 0.15));
    osc.start();
    osc.stop(audioCtx.currentTime + (duration || 0.15));
  } catch (e) { /* AudioContext may not be ready */ }
}

function vibrate(ms) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {}
}

// ---------- 结果存储 ----------

function loadResults() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : [];
  } catch (e) { return []; }
}

function saveResults() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
}

function addResult(text, fmt, forceValid) {
  const trimmed = String(text).trim();
  const upper = trimmed.toUpperCase();
  const valid = forceValid ? true : isValidTrackingNo(upper);

  const item = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    trackingNo: valid ? upper : '',
    invalidTrackingNo: valid ? '' : upper,
    rawText: trimmed,
    format: String(fmt),
    timestamp: Date.now(),
    date: todayStr(),
    note: ''
  };
  // 扫描结果插入时保留用户正在编辑的输入框焦点
  const focusState = preserveInputFocus();
  results.unshift(item);
  saveResults();
  render();
  restoreInputFocus(focusState);
  return item;
}

// ---------- 渲染 ----------

function render() {
  const tbody = $('result-body');
  const empty = $('empty-hint');

  if (results.length === 0) {
    empty.style.display = 'block';
    tbody.innerHTML = '';
    checkAll.checked = false;
    return;
  }
  empty.style.display = 'none';

  // 重复统计
  const dupCount = {};
  results.forEach(r => {
    if (r.trackingNo) dupCount[r.trackingNo] = (dupCount[r.trackingNo] || 0) + 1;
  });

  tbody.innerHTML = results.map((r, i) => {
    const isDup = r.trackingNo && dupCount[r.trackingNo] > 1;
    const rowCls = r.invalidTrackingNo && !r.trackingNo ? 'row-invalid' : '';
    // 物流单号三态
    let trackingCell;
    if (r.trackingNo) {
      trackingCell = `<span class="mono tracking-edit" data-id="${r.id}" title="点击编辑">${escapeHTML(r.trackingNo)}</span>`;
    } else if (r.invalidTrackingNo) {
      trackingCell = `<span class="mono" style="color:var(--warn)">⚠ ${escapeHTML(r.invalidTrackingNo)}</span><br><input class="tracking-input" data-id="${r.id}" placeholder="纠正单号" title="输入正确单号">`;
    } else {
      trackingCell = `<input class="tracking-input" data-id="${r.id}" placeholder="输入单号">`;
    }
    const dupTag = isDup ? ` <span class="tag tag-dup">×${dupCount[r.trackingNo]}</span>` : '';
    const methodTag = escapeHTML(recognitionMethod(r.format));
    const time = new Date(r.timestamp);
    const timeStr = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
    return `<tr class="${rowCls}" data-id="${r.id}">
      <td><input type="checkbox" class="row-check" data-id="${r.id}"></td>
      <td style="color:var(--muted);font-size:12px">${results.length - i}</td>
      <td style="white-space:nowrap;font-size:12px">${escapeHTML(r.date.slice(5))}<br><span style="color:var(--muted)">${timeStr}</span></td>
      <td>${trackingCell}${dupTag}</td>
      <td><input class="note-input" data-id="${r.id}" value="${escapeHTML(r.note)}" placeholder="备注"></td>
      <td style="white-space:nowrap;font-size:12px">${methodTag}</td>
    </tr>`;
  }).join('');

  // 同步全选框状态
  const checks = tbody.querySelectorAll('.row-check');
  checkAll.checked = checks.length > 0 && [...checks].every(cb => cb.checked);
}

// ---------- 扫描引擎 ----------

// 原生 BarcodeDetector 引擎（Chrome Android / Edge）
class NativeBarcodeDetectorEngine {
  constructor() { this.detector = null; this.formats = null; }
  get name() { return 'native'; }

  async init() {
    const wanted = ['code_128', 'code_39', 'itf', 'qr_code', 'ean_13', 'ean_8', 'codabar'];
    const supported = await window.BarcodeDetector.getSupportedFormats();
    this.formats = wanted.filter(f => supported.includes(f));
    if (!this.formats.length) throw new Error('no supported formats');
    this.detector = new window.BarcodeDetector({ formats: this.formats });
  }

  async decode(source) {
    const results = await this.detector.detect(source);
    // 返回全部候选（不再只取第一个）
    return (results || []).map(r => ({
      text: r.rawValue,
      format: String(r.format).toUpperCase()
    }));
  }

  destroy() { this.detector = null; }
}

// zxing-wasm 引擎（iOS Safari 兜底，CDN 动态 import）
class ZxingWasmEngine {
  constructor() { this.mod = null; this.formats = null; this.frameCount = 0; }
  get name() { return 'wasm'; }

  async init() {
    // 用原生 ESM 入口（含 readBarcodesFromImageData 复数版），reader 包比 full 小 ~300KB
    this.mod = await import('https://cdn.jsdelivr.net/npm/@sec-ant/zxing-wasm@2.2.0/dist/reader/index.js');
    // zxing-wasm 使用 PascalCase 格式名
    this.formats = ['Code128', 'QRCode', 'Code39', 'ITF', 'Codabar', 'EAN-13', 'EAN-8'];
    // 降采样用离屏 canvas
    this.scaleCanvas = document.createElement('canvas');
    this.scaleCtx = this.scaleCanvas.getContext('2d', { willReadFrequently: true });
  }

  async decode(source) {
    // 降采样到 ≤640px 宽，显著提速
    const MAX_W = 640;
    let src = source;
    if (source.width > MAX_W) {
      const ratio = MAX_W / source.width;
      const tw = Math.round(source.width * ratio);
      const th = Math.round(source.height * ratio);
      this.scaleCanvas.width = tw;
      this.scaleCanvas.height = th;
      this.scaleCtx.drawImage(source, 0, 0, tw, th);
      src = this.scaleCanvas;
    }
    const imageData = src.getContext('2d').getImageData(0, 0, src.width, src.height);
    // 每 5 帧启用一次 TRY_HARDER 兜底，其余帧快速扫描
    this.frameCount++;
    const tryHarder = (this.frameCount % 5 === 0);
    const results = await this.mod.readBarcodesFromImageData(imageData, {
      tryHarder,
      formats: this.formats,
      maxSymbols: 5
    });
    // 输出格式名是 PascalCase，统一转大写供 formatLabel 使用
    return (results || []).map(r => ({
      text: r.text,
      format: String(r.format).toUpperCase()
    }));
  }

  destroy() { this.mod = null; }
}

async function createEngine() {
  // 优先原生 BarcodeDetector
  if ('BarcodeDetector' in window) {
    try {
      const eng = new NativeBarcodeDetectorEngine();
      await eng.init();
      return eng;
    } catch (e) { /* 降级到 wasm */ }
  }
  // 兜底 wasm
  const eng = new ZxingWasmEngine();
  await eng.init();
  return eng;
}

// ---------- ROI 裁剪 ----------

// ROI 布局缓存：video/frame 相对偏移在 sticky 滚动中不变，仅分辨率/尺寸变化时重算
let roiLayout = null;

function getROI() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  const dispW = video.clientWidth, dispH = video.clientHeight;
  if (!roiLayout || roiLayout.vw !== vw || roiLayout.vh !== vh ||
      roiLayout.dispW !== dispW || roiLayout.dispH !== dispH) {
    // 布局相关量只在首帧/分辨率/尺寸变化时计算（含 getBoundingClientRect）
    const scale = Math.max(dispW / vw, dispH / vh);
    const vr = video.getBoundingClientRect();
    const fr = scanFrameEl.getBoundingClientRect();
    roiLayout = {
      vw, vh, dispW, dispH, scale,
      offX: (dispW - vw * scale) / 2,
      offY: (dispH - vh * scale) / 2,
      relX: fr.left - vr.left,   // frame 相对 video 偏移（滚动不变）
      relY: fr.top - vr.top,
      frameW: fr.width,
      frameH: fr.height
    };
  }
  const L = roiLayout;

  // 扫描框 + 10% margin（外扩提升大二维码/条码边缘容错）
  const M = 0.10;
  let sw = (L.frameW / L.scale) * (1 + M);
  let sh = (L.frameH / L.scale) * (1 + M);
  let sx = ((L.relX - L.offX) / L.scale) - sw * M / 2;
  let sy = ((L.relY - L.offY) / L.scale) - sh * M / 2;

  // clamp 到视频边界
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw);
  sh = Math.min(vh - sy, sh);
  if (sw < 8 || sh < 8) return null;
  return { sx, sy, sw, sh };
}

function captureROI() {
  const roi = getROI();
  if (!roi) return null;
  const w = Math.round(roi.sw), h = Math.round(roi.sh);
  if (roiCanvas.width !== w) roiCanvas.width = w;
  if (roiCanvas.height !== h) roiCanvas.height = h;
  roiCtx.drawImage(video, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, w, h);
  return roiCanvas;
}

// ---------- 扫描循环 ----------

function scheduleScan() {
  if (!scanning || focusWaiting || ocrBusy || paused) return;
  if (slowMode) {
    // 帧率自适应：解码慢时降低频率
    scanTimer = setTimeout(scanTick, 250);
  } else if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    scanRafId = video.requestVideoFrameCallback(scanTick);
  } else {
    scanTimer = setTimeout(scanTick, 100);
  }
}

async function scanTick() {
  if (!scanning || focusWaiting || ocrBusy || paused) return;
  scanRafId = null;
  scanTimer = null;
  const t0 = performance.now();
  try {
    // 两引擎统一：只解码扫描框区域（含 10% margin）
    const source = captureROI();
    if (source) {
      const cands = await engine.decode(source);
      if (cands && cands.length) await handleScanResult(cands);
    }
  } catch (e) {
    // 单帧失败不中断循环
  }
  updateFrameStats(performance.now() - t0);
  scheduleScan();
}

function cancelScanLoop() {
  if (scanRafId !== null && 'cancelVideoFrameCallback' in video) {
    video.cancelVideoFrameCallback(scanRafId);
  }
  scanRafId = null;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
}

// ---------- 摄像头控制 ----------

async function startScan() {
  if (scanning) return;
  if (imageBusy) { showToast('正在识别图片，请稍候', 1500); return; }
  try {
    // 1) 引擎初始化（wasm 可能需下载，先给反馈避免误以为卡死）
    showToast('正在加载扫描引擎…', 0);
    engine = await createEngine();
    hideToast();
    setEngineBadge(engine.name);

    // 2) 摄像头：1280×720 后置
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    // 3) 连续对焦 + 曝光/白平衡自动（提升近距离扫描识别率）
    try {
      const track = stream.getVideoTracks()[0];
      await track.applyConstraints({
        advanced: [
          { focusMode: 'continuous' },
          { exposureMode: 'continuous' },
          { whiteBalanceMode: 'continuous' }
        ]
      });
    } catch (e) { /* 设备不支持时忽略 */ }

    // 4) 等待拿到真实分辨率
    if (!video.videoWidth) {
      await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
    }

    // 5) UI
    cameraPlaceholder.style.display = 'none';
    scanOverlay.style.display = 'flex';
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnOcr.disabled = false;
    paused = false;
    btnPause.textContent = '暂停';
    scanning = true;

    // 6) 对焦等待：3 秒后再启动扫描循环（等手动对焦，所有模式生效）
    showToast('摄像头已开启，请将面单对准扫描框，可轻触画面辅助对焦', FOCUS_WAIT_MS);
    focusWaiting = true;
    focusWaitTimer = setTimeout(() => {
      focusWaiting = false;
      focusWaitTimer = null;
      if (scanning) scheduleScan();
    }, FOCUS_WAIT_MS);

    // 7) 外设
    await detectTorch();
    await requestWakeLock();

    connStatus.textContent = '扫描中';
    connStatus.style.color = 'var(--ok)';
  } catch (e) {
    console.error('[扫描] 启动失败:', e);
    showToast(engine ? friendlyMediaError(e) : '扫描引擎加载失败，请检查网络后重试', 3000);
    // 回收资源
    if (engine) { try { engine.destroy(); } catch (_) {} engine = null; }
    const stream = video.srcObject;
    if (stream) { stream.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    cameraPlaceholder.style.display = 'flex';
    scanOverlay.style.display = 'none';
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnOcr.disabled = true;
    paused = false;
    scanning = false;
    if (focusWaitTimer) { clearTimeout(focusWaitTimer); focusWaitTimer = null; }
    focusWaiting = false;
    setEngineBadge('');
  }
}

function stopScan() {
  if (!scanning) return;
  scanning = false;
  cancelScanLoop();
  slowMode = false;
  slowStreak = 0;
  fastStreak = 0;
  if (focusWaitTimer) { clearTimeout(focusWaitTimer); focusWaitTimer = null; }
  focusWaiting = false;
  // 注意：不 terminate OCR worker —— 页面加载时已后台预载，保留供手动 OCR 即点即用

  try { if (engine) engine.destroy(); } catch (e) {}
  engine = null;

  const stream = video.srcObject;
  if (stream) { stream.getTracks().forEach(t => t.stop()); }
  video.srcObject = null;

  scanOverlay.style.display = 'none';
  cameraPlaceholder.style.display = 'flex';
  btnStart.disabled = false;
  btnTorch.disabled = true;
  btnTorchIcon.style.display = 'none';
  btnPause.disabled = true;
  btnOcr.disabled = true;
  paused = false;
  btnPause.textContent = '暂停';
  connStatus.textContent = '已停止';
  connStatus.style.color = 'var(--muted)';
  torchTrack = null;
  torchOn = false;
  releaseWakeLock();
  setEngineBadge('');
}

// 暂停/继续扫描循环（摄像头画面保留）
function togglePause() {
  if (!scanning) return;
  paused = !paused;
  if (paused) {
    cancelScanLoop();
    btnPause.textContent = '继续';
    connStatus.textContent = '已暂停';
  } else {
    btnPause.textContent = '暂停';
    connStatus.textContent = '扫描中';
    if (!focusWaiting && !ocrBusy) scheduleScan();
  }
}

// 手动 OCR：对当前扫描框画面执行 OCR/AI 识别，结果弹窗展示（点击即复制）
async function manualOCR() {
  if (!scanning) { showToast('请先开始扫描', 2000); return; }
  if (ocrBusy || imageBusy) return;
  ocrBusy = true;
  showToast('正在识别文字…', 0);
  try {
    const canvas = captureROI();
    if (!canvas) return;
    const r = await recognizeText(canvas);
    hideToast();
    if (!r) {
      showToast('未识别到文字，请对准文字后重试', 3000);
      return;
    }
    showRecognitionDialog(r);   // 手动场景：总是弹窗展示全文，可点击复制 / 录入单号
  } catch (e) {
    hideToast();
    if (scanning) showToast('OCR 失败：' + (e.message || e), 4000);
  } finally {
    ocrBusy = false;
    if (scanning && !paused) scheduleScan();
  }
}

// 添加扫描结果并反馈（accepted=true 表示规则已确认是有效单号）
function addScanItem(text, fmt, accepted) {
  const item = addResult(text, fmt, accepted);
  const valid = accepted || isValidTrackingNo(text);
  beep(valid ? 1000 : 600, valid ? 0.1 : 0.2);
  vibrate(valid ? 100 : 200);
  scanFlash.classList.add('active');
  setTimeout(() => scanFlash.classList.remove('active'), 300);
  showToast(valid ? `✓ ${item.trackingNo}` : `⚠ ${item.invalidTrackingNo}`, 2000);
  // 扫描成功获得值后自动停止，避免重复扫描
  stopScan();
}

// 处理解码候选，返回是否出现合格候选（供 OCR 节流统计）
async function handleScanResult(cands) {
  const rules = getActiveRules();

  // 去重（相同内容只保留一个；若同时有二维码和条形码版，保留二维码版）
  const seen = new Map();
  for (const c of cands) {
    const k = String(c.text).trim().toUpperCase();
    if (!k) continue;
    const isQR = /QR/.test(c.format);
    const old = seen.get(k);
    if (!old || (isQR && !/QR/.test(old.format))) seen.set(k, c);
  }
  const unique = [...seen.values()];

  // 打分并筛选合格候选
  const scored = unique
    .map(c => { const r = scoreCandidate(c.text, c.format, rules); return r ? { ...c, ...r } : null; })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return false;   // 无合格候选：静默忽略，继续扫描

  // 通用模式：一律手动确认（即使唯一候选）
  if (regionSelect.value === 'generic') {
    stopScan();
    const picked = await askUserPick(scored, '识别到单号，请确认后录入');
    if (picked) addScanItem(picked.text, picked.format, true);
    else showToast('已取消录入，可重新扫描', 2000);
    return true;                            // 已出现合格候选（含用户取消）
  }

  // PH 模式：唯一/分差≥60 自动，否则弹窗
  const top = scored[0];
  const second = scored[1];
  const autoPick = scored.length === 1 || !second || (top.score - second.score >= 60);
  if (autoPick) {
    addScanItem(top.text, top.format, true);
  } else {
    stopScan();
    const picked = await askUserPick(scored);
    if (picked) addScanItem(picked.text, picked.format, true);
    else showToast('已取消录入，可重新扫描', 2000);
  }
  return true;
}

// ---------- 手电筒 ----------

async function detectTorch() {
  try {
    const stream = video.srcObject;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    torchTrack = track;
    // 无条件启用控制栏闪光灯按钮，不依赖 getCapabilities 检测
    btnTorch.disabled = false;
    // 浮动图标仅在设备报告 torch 能力时显示
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps && 'torch' in caps) {
      btnTorchIcon.style.display = 'block';
    }
  } catch (e) {}
}

async function toggleTorch() {
  if (!torchTrack) return;
  try {
    torchOn = !torchOn;
    await torchTrack.applyConstraints({
      advanced: [{ torch: torchOn }]
    });
    btnTorchIcon.style.opacity = torchOn ? '1' : '0.5';
  } catch (e) {
    showToast('手电筒不可用', 2000);
  }
}

// ---------- 屏幕常亮 ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {}
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); wakeLock = null; } catch (e) {}
  }
}

// ---------- OCR（Tesseract.js，手动触发）+ AI 视觉 API ----------

// 懒加载 Tesseract worker 单例（失败自动复位，下次可重试）
async function ensureOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js');
      return createWorker('eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
        langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        logger: () => {}
      });
    })();
    // CDN/网络抖动导致加载失败时复位，允许下次重试
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

// 自由识别文字：整块文字（PSM 6）+ 不设白名单，返回完整识别文本（字母/数字/标点均可）
async function ocrRecognize(canvas) {
  const worker = await ensureOcrWorker();
  const { data } = await worker.recognize(canvas, {
    tessedit_pageseg_mode: '6'   // 假定为统一文本块，保留多行与标点
  });
  return (data.text || '').trim();
}

// OCR/AI 统一识别入口：优先本地 OCR，无结果且已配置 AI 时用 AI。
// 返回 { tracking, fullText, method }；两者都无结果返回 null
async function recognizeText(canvas) {
  let text = '';
  let method = 'OCR';
  if (getSettings().ocrEnabled) {
    text = await ocrRecognize(canvas);
  }
  if (!text && aiReady()) {
    showToast('本地 OCR 无结果，正在 AI 识别…', 0);
    method = 'AI';
    text = await aiRecognize(canvas);
  }
  if (!text) return null;
  return parseRecognition(text, method);
}

// 从识别文本解析 { tracking, fullText }：AI 输出 JSON 优先；OCR 全文原样保留 + 正则抽单号
function parseRecognition(text, method) {
  const fullText = String(text).trim();
  let tracking = '';
  const jm = fullText.match(/\{[\s\S]*\}/);
  if (jm) {
    try {
      const p = JSON.parse(jm[0]);
      tracking = String(p.trackingNo || p.tracking_no || p.tracking || '').trim().toUpperCase();
      const ft = String(p.fullText || '').trim();
      if (!tracking) {
        // JSON 里没有单号字段时，对全文兜底正则提取
        const m = ft.match(/[A-Z]{0,3}\d{9,}/i) || ft.match(/\b\d{8,16}\b/);
        tracking = m ? m[0].toUpperCase() : '';
      }
      return { tracking, fullText: ft || fullText, method };
    } catch (e) {}
  }
  const m = fullText.match(/[A-Z]{0,3}\d{9,}/i) || fullText.match(/\b\d{8,16}\b/);
  return { tracking: m ? m[0].toUpperCase() : '', fullText, method };
}

// 识别结果弹窗：全文点击即复制（提示「已复制」）；提取到单号时可一键录入
function showRecognitionDialog(r) {
  const copyFullText = async () => {
    try {
      await navigator.clipboard.writeText(r.fullText);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = r.fullText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast('已复制 ✓', 2000);
  };
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:12px;padding:16px;max-width:360px;width:90%;max-height:80vh;display:flex;flex-direction:column;';
  box.innerHTML = `<div style="font-size:15px;font-weight:600;margin-bottom:6px">识别结果 <span style="font-size:11px;color:#888;font-weight:400">(${r.method === 'AI' ? 'AI 识别' : 'OCR 识别'} · 点击文字即可复制)</span></div>`;
  if (r.tracking) {
    box.innerHTML += `<div style="margin:6px 0;padding:8px 10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px">
      <div style="font-size:11px;color:#2e7d32">检测到单号（可一键录入）</div>
      <div style="font-family:Consolas,monospace;font-weight:600;font-size:14px;word-break:break-all">${escapeHTML(r.tracking)}</div>
    </div>`;
  }
  const pre = document.createElement('pre');
  pre.textContent = r.fullText;
  pre.style.cssText = 'flex:1;overflow-y:auto;white-space:pre-wrap;word-break:break-all;font-family:Consolas,monospace;font-size:12px;line-height:1.5;background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;user-select:text;-webkit-user-select:text;';
  pre.title = '点击复制全文';
  pre.addEventListener('click', copyFullText);
  box.appendChild(pre);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;';
  const mkBtn = (label, style, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;cursor:pointer;${style || ''}`;
    b.addEventListener('click', fn);
    return b;
  };
  actions.appendChild(mkBtn('复制全文', 'background:#4a90d9;color:#fff;border-color:#4a90d9;', copyFullText));
  if (r.tracking) {
    actions.appendChild(mkBtn('录入单号', 'background:#4caf50;color:#fff;border-color:#4caf50;', () => {
      overlay.remove();
      addScanItem(r.tracking, r.method, true);
    }));
  }
  actions.appendChild(mkBtn('关闭', '', () => overlay.remove()));
  box.appendChild(actions);
  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ---------- OCR 引擎预载（打开网页即后台下载，首次约 10MB，之后即点即用） ----------

function setOcrStatus(state) {
  const el = $('ocr-status');
  if (!el) return;
  if (state === 'loading') {
    el.innerHTML = '⏳ OCR 引擎下载中…（约 10MB，仅首次，后台进行）';
    el.className = 'ocr-status loading';
  } else if (state === 'ready') {
    el.innerHTML = '✓ OCR 引擎已就绪 —— 对准面单点「OCR」识别文字，识别结果点击即复制';
    el.className = 'ocr-status ready';
  } else if (state === 'error') {
    el.innerHTML = '⚠ OCR 引擎下载失败，点此重试';
    el.className = 'ocr-status error';
  } else {
    el.innerHTML = 'OCR 引擎未启用（可在设置中开启）';
    el.className = 'ocr-status';
  }
}

async function preloadOcrEngine() {
  if (!getSettings().ocrEnabled) { setOcrStatus('off'); return; }
  setOcrStatus('loading');
  try {
    await ensureOcrWorker();
    setOcrStatus('ready');
  } catch (e) {
    setOcrStatus('error');
  }
}

// 图片压缩为 data URL
function compressCanvas(canvas, maxSide = 1280, quality = 0.9) {
  let src = canvas;
  if (Math.max(canvas.width, canvas.height) > maxSide) {
    const scale = maxSide / Math.max(canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    src = c;
  }
  return src.toDataURL('image/jpeg', quality);
}

// AI 视觉提示词：按当前地区规则生成，要求输出完整文字（供全文复制）与单号
function buildVisionPrompt() {
  const ph = regionSelect.value === 'PH';
  return ph
    ? '这是菲律宾物流面单（shipping label）图片。请识别图中所有可见文字。物流单号特征：0-3 个字母开头（如 JT、JD、LP）后接 9 位以上纯数字，总长 ≥12，无连字符/空格/标点。输出严格 JSON：{"trackingNo":"单号（没有则空字符串）","orderNo":"订单号","name":"收件人姓名","phone":"电话","fullText":"整张面单上所有可见文字，按行原样拼接，包含单号/姓名/地址等，不要省略也不要杜撰"}，不要输出 JSON 以外的内容。'
    : '这是物流面单图片。请识别图中所有可见文字。物流单号特征：可选 0-3 个字母开头 + 至少 9 位数字（总长 ≥12），也可能是 8-16 位纯数字。输出严格 JSON：{"trackingNo":"单号（没有则空字符串）","orderNo":"订单号","name":"收件人姓名","phone":"电话","fullText":"整张面单上所有可见文字，按行原样拼接，包含单号/姓名/地址等，不要省略也不要杜撰"}，不要输出 JSON 以外的内容。';
}

// AI 视觉提示词：按当前地区规则生成
function buildVisionPrompt() {
  const ph = regionSelect.value === 'PH';
  return ph
    ? '这是菲律宾物流面单（shipping label）图片。请识别条码/二维码附近的人类可读单号。物流单号特征：0-3 个字母开头（如 JT、JD、LP）后接 9 位以上纯数字，总长 ≥12，无连字符/空格/标点。输出严格 JSON：{"trackingNo":"...","orderNo":"...","name":"...","phone":"..."}，没有的填空字符串，不要输出 JSON 以外的内容。'
    : '这是物流面单图片。请识别条码/二维码附近印刷的单号。单号特征：可选 0-3 个字母开头 + 至少 9 位数字（总长 ≥12），也可能是 8-16 位纯数字。输出严格 JSON：{"trackingNo":"...","orderNo":"...","name":"..."}，没有的填空字符串，不要输出 JSON 以外的内容。';
}

async function aiRecognize(canvas) {
  const s = getSettings();
  const body = {
    model: s.aiModel,
    messages: [{ role: 'user', content: [
      { type: 'text', text: buildVisionPrompt() },
      { type: 'image_url', image_url: { url: compressCanvas(canvas) } }
    ]}],
    max_tokens: 500,
    temperature: 0.1
  };
  const base = s.aiBaseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.aiApiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`AI API ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 请求超时(30s)');
    if (isCorsError(e)) throw new Error('目标服务不支持跨域（CORS），浏览器无法直连；请使用支持 CORS 的服务（默认 OpenRouter / Groq）');
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- 本地图片 / 截图识别 ----------

// 统一 File → canvas：等比缩放，长边 ≤ IMAGE_MAX_SIDE
async function loadImageToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片加载失败，可能已损坏或格式不支持'));
      el.src = url;
    });
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
    return canvas;   // drawImage 自动应用 EXIF 方向
  } finally {
    URL.revokeObjectURL(url);   // 释放大图内存（失败也回收）
  }
}

// 图片/截图识别主流程（图片按钮 + 剪贴板粘贴共用）
async function recognizeImageFile(file) {
  if (imageBusy) { showToast('正在识别上一张图片，请稍候', 1500); return; }
  imageBusy = true;
  ocrBusy = true;   // 与扫描互斥
  try {
    // 1) 摄像头若在扫描先停止（stopScan 会销毁 engine，故随后需重建）
    if (scanning) stopScan();

    // 2) 加载并缩放图片
    showToast('正在加载图片…', 0);
    const canvas = await loadImageToCanvas(file);

    // 3) 确保引擎存在（wasm 首次需下载，先给进度反馈）
    showToast('正在识别图片…', 0);
    if (!engine) {
      showToast('正在加载识别引擎…', 0);
      engine = await createEngine();
      setEngineBadge(engine.name);
    }

    // 4) 双引擎条码解码 → 沿用现有规则（PH 自动/竞争弹窗，通用一律弹窗）
    const cands = await engine.decode(canvas);
    if (cands && cands.length) {
      const ok = await handleScanResult(cands);
      if (ok) return;   // 已弹窗/入库，成功 toast 由 addScanItem 设置
    }

    // 5) 无合格候选：OCR/AI 识别文字
    showToast('正在识别图片文字…', 0);
    const r = await recognizeText(canvas);
    hideToast();
    if (!r) {
      showToast('未识别到条码或文字，请尝试更清晰的图片', 3000);
      return;
    }
    if (r.tracking) {
      // 提取到合格单号：沿用确认入库流程
      const scored = scoreCandidate(r.tracking, r.method, getActiveRules());
      if (scored && scored.score > 0) {
        const picked = await askUserPick([{ text: r.tracking, format: r.method, ...scored }], '识别到单号，请确认后录入');
        if (picked) addScanItem(picked.text, r.method, true);
        return;
      }
    }
    // 无合格单号：弹窗展示全文，点击复制
    showRecognitionDialog(r);
  } catch (e) {
    console.error('[图片识别] 失败:', e);
    showToast('图片识别失败：' + (e.message || e), 3000);
  } finally {
    imageBusy = false;
    ocrBusy = false;
    // 不 hideToast：每条结束路径都已 showToast(带时长)，避免清掉 addScanItem 的 ✓ 反馈
  }
}

// ---------- 复制 / 导出 / 清空 ----------

function copyTrackingNos() {
  const nos = results.filter(r => r.trackingNo).map(r => `${r.date}\t${r.trackingNo}`);
  if (nos.length === 0) { showToast('没有可复制的单号', 2000); return; }
  const text = nos.join('\n');
  navigator.clipboard.writeText(text).then(
    () => showToast(`已复制 ${nos.length} 个单号`, 2000),
    () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast(`已复制 ${nos.length} 个单号`, 2000);
    }
  );
}

function exportCSV() {
  if (results.length === 0) { showToast('无数据可导出', 2000); return; }
  const header = '序号,日期,时间,物流单号,候选单号,条码格式,识别,条码内容,备注\n';
  // 按扫描顺序正序导出（序号 1 = 最早扫描，在第一行）
  const rows = [...results].reverse().map((r, i) => {
    const t = new Date(r.timestamp);
    const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    return [
      i + 1, r.date, time,
      r.trackingNo || '',
      r.invalidTrackingNo || '',
      formatLabel(r.format),
      recognitionMethod(r.format),
      r.rawText || '',
      r.note || ''
    ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',');
  }).join('\n');
  const csv = '\ufeff' + header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `面单扫描_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`已导出 ${results.length} 条`, 2000);
}

function deleteSelected() {
  if (results.length === 0) { showToast('无数据', 1500); return; }
  const checked = [...document.querySelectorAll('.row-check:checked')].map(cb => cb.dataset.id);
  if (checked.length === 0) { showToast('未选择任何行', 1500); return; }
  if (!confirm(`确定删除选中的 ${checked.length} 条？此操作不可撤销。`)) return;
  const idSet = new Set(checked);
  for (let i = results.length - 1; i >= 0; i--) {
    if (idSet.has(results[i].id)) results.splice(i, 1);
  }
  saveResults();
  render();
  showToast(`已删除 ${checked.length} 条`, 1500);
}

// 新建空行
function addNewRow() {
  addResult('', 'MANUAL');
  // 自动聚焦新行输入框（新行在列表最前）
  const input = $('result-body').querySelector('.tracking-input');
  if (input) input.focus();
}

// 更新单号（手动编辑）
function updateTracking(id, value) {
  const r = results.find(x => x.id === id);
  if (!r) return;
  const trimmed = value.trim().toUpperCase();
  if (trimmed && isValidTrackingNo(trimmed)) {
    r.trackingNo = trimmed;
    r.invalidTrackingNo = '';
  } else {
    r.trackingNo = '';
    r.invalidTrackingNo = trimmed;
  }
  saveResults();
  render();
}

// 更新备注
function updateNote(id, value) {
  const r = results.find(x => x.id === id);
  if (!r) return;
  r.note = value;
  saveResults();
}

// ---------- 设置模态 ----------

function openSettings() {
  const s = getSettings();
  $('set-ocr').checked = s.ocrEnabled;
  $('set-ai').checked = s.aiEnabled;
  $('set-base').value = s.aiBaseUrl;
  $('set-key').value = s.aiApiKey;
  $('set-model').value = s.aiModel;
  // 服务下拉与当前地址同步（识别不出则默认 OpenRouter）
  const base = (s.aiBaseUrl || '').replace(/\/+$/, '');
  const cur = Object.entries(AI_SERVICES).find(([, v]) => v.base === base);
  $('set-service').value = cur ? cur[0] : 'openrouter';
  settingsModal.classList.remove('hidden');
}
function closeSettings() {
  settingsModal.classList.add('hidden');
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-cancel').addEventListener('click', closeSettings);
// 选择 AI 服务自动填入 Base URL 与模型（支持浏览器直连 CORS），用户只需填 Key
$('set-service').addEventListener('change', e => {
  const svc = AI_SERVICES[e.target.value];
  if (!svc) return;
  $('set-base').value = svc.base;
  $('set-model').value = svc.model;
});
$('btn-settings-save').addEventListener('click', () => {
  const s = {
    ocrEnabled: $('set-ocr').checked,
    aiEnabled: $('set-ai').checked,
    aiBaseUrl: $('set-base').value.trim(),
    aiApiKey: $('set-key').value.trim(),
    aiModel: $('set-model').value.trim()
  };
  if (s.aiEnabled && (!s.aiBaseUrl || !s.aiApiKey || !s.aiModel)) {
    showToast('启用 AI 兜底需填全 Base URL / Key / 模型', 2500);
    return;
  }
  saveSettings(s);
  closeSettings();
  showToast('设置已保存', 1500);
});
$('btn-settings-test').addEventListener('click', async () => {
  const base = $('set-base').value.trim().replace(/\/+$/, '');
  const key = $('set-key').value.trim();
  const model = $('set-model').value.trim();
  if (!base || !key || !model) { showToast('请先填写 Base URL / Key / 模型', 2000); return; }
  const btn = $('btn-settings-test');
  btn.disabled = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    showToast(resp.ok ? '连接成功 ✓' : `连接失败 (${resp.status})`, 4000);
  } catch (e) {
    showToast(isCorsError(e) ? '连接失败：目标服务不支持跨域（CORS），请使用支持 CORS 的服务（默认 OpenRouter / Groq）' : '连接失败：' + (e.message || e), 4000);
  } finally {
    btn.disabled = false;
  }
});

// 点击视频画面"唤醒"自动对焦（低风险增强，不支持设备自动忽略）
video.addEventListener('click', () => {
  if (!torchTrack) return;
  try {
    torchTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (e) {}
});

// ---------- 事件绑定 ----------

btnStart.addEventListener('click', startScan);
btnTorch.addEventListener('click', toggleTorch);
btnTorchIcon.addEventListener('click', toggleTorch);
btnPause.addEventListener('click', togglePause);
btnOcr.addEventListener('click', manualOCR);
$('btn-copy').addEventListener('click', copyTrackingNos);
$('btn-export').addEventListener('click', exportCSV);
$('btn-clear').addEventListener('click', deleteSelected);
$('btn-add-manual').addEventListener('click', addNewRow);

// 图片按钮 → 隐藏 file input
btnImage.addEventListener('click', () => fileImage.click());

// 文件选择（允许重复选同一文件：change 后重置 value）
fileImage.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) recognizeImageFile(file);
  e.target.value = '';
});

// 剪贴板粘贴截图（document 级，页面聚焦即生效；输入框内粘贴文本不拦截）
document.addEventListener('paste', e => {
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) { e.preventDefault(); recognizeImageFile(file); return; }   // 多图只取第一张
    }
  }
});

// 全选/取消全选
checkAll.addEventListener('change', e => {
  const checked = e.target.checked;
  document.querySelectorAll('.row-check').forEach(cb => cb.checked = checked);
});

// 结果表事件委托
$('result-body').addEventListener('click', e => {
  const el = e.target;
  if (el.classList.contains('tracking-edit')) {
    const id = el.dataset.id;
    const r = results.find(x => x.id === id);
    if (!r) return;
    const input = document.createElement('input');
    input.className = 'tracking-input';
    input.value = r.trackingNo;
    input.dataset.id = id;
    el.replaceWith(input);
    input.focus();
    input.select();
  }
});

$('result-body').addEventListener('change', e => {
  const el = e.target;
  if (el.classList.contains('row-check')) {
    // 行勾选后同步全选框状态
    const checks = document.querySelectorAll('.row-check');
    checkAll.checked = checks.length > 0 && [...checks].every(cb => cb.checked);
  } else if (el.classList.contains('tracking-input')) {
    updateTracking(el.dataset.id, el.value);
  } else if (el.classList.contains('note-input')) {
    updateNote(el.dataset.id, el.value);
  }
});

$('result-body').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('tracking-input')) {
    e.target.blur();
  }
});

// 页面失焦时停止扫描（节省电量）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scanning) {
    stopScan();
  }
});

// ---------- 初始化 ----------

render();

// 打开网页即后台预载 OCR 引擎；下载失败可点击状态条重试
preloadOcrEngine();
$('ocr-status').addEventListener('click', () => {
  if ($('ocr-status').classList.contains('error')) preloadOcrEngine();
});
