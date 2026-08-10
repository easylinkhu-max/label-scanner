// ============================================================
// 物流面单扫描工具 — 摄像头实时识别
// 双引擎：原生 BarcodeDetector (Chrome/Edge) + zxing-wasm (iOS Safari)
// ============================================================

'use strict';

// ---------- 常量 ----------

const STORAGE_KEY = 'labelScannerResults';
const COOLDOWN_MS = 3000; // 同一条码内容冷却时间

// ---------- 状态 ----------

let engine = null;
let scanning = false;
let lastScanText = '';
let lastScanTime = 0;
let wakeLock = null;
let torchOn = false;
let torchTrack = null;
let scanRafId = null;
let scanTimer = null;
let pauseUntil = 0;        // 扫描成功后暂停截止时间
let slowMode = false;      // 帧率自适应：慢速模式
let slowStreak = 0;
let fastStreak = 0;

// 离屏 canvas（ROI 裁剪用）
const roiCanvas = document.createElement('canvas');
const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

const results = loadResults();

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const video = $('video');
const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnTorch = $('btn-torch-toggle');
const btnTorchIcon = $('btn-torch');
const scanOverlay = $('scan-overlay');
const scanFrameEl = $('scan-frame');
const scanFlash = $('scan-flash');
const cameraPlaceholder = $('camera-placeholder');
const connStatus = $('conn-status');
const engineBadge = $('engine-badge');
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

function addResult(text, fmt) {
  const trimmed = String(text).trim();
  const upper = trimmed.toUpperCase();
  const valid = isValidTrackingNo(upper);

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

  // 统计
  const total = results.length;
  const ok = results.filter(r => r.trackingNo).length;
  const warn = results.filter(r => !r.trackingNo && r.invalidTrackingNo).length;
  $('stat-total').textContent = total;
  $('stat-ok').textContent = ok;
  $('stat-warn').textContent = warn;

  if (results.length === 0) {
    empty.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  // 重复统计
  const dupCount = {};
  results.forEach(r => {
    if (r.trackingNo) dupCount[r.trackingNo] = (dupCount[r.trackingNo] || 0) + 1;
  });

  tbody.innerHTML = results.map(r => {
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
    const statusTag = r.trackingNo
      ? '<span style="color:var(--ok);font-size:12px">✓</span>'
      : (r.invalidTrackingNo ? '<span class="tag tag-warn">⚠</span>' : '<span style="color:var(--muted);font-size:12px">—</span>');
    const time = new Date(r.timestamp);
    const timeStr = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
    return `<tr class="${rowCls}" data-id="${r.id}">
      <td><input type="checkbox" class="row-check" data-id="${r.id}"></td>
      <td style="white-space:nowrap;font-size:12px">${escapeHTML(r.date.slice(5))}<br><span style="color:var(--muted)">${timeStr}</span></td>
      <td>${trackingCell}${dupTag}</td>
      <td><input class="note-input" data-id="${r.id}" value="${escapeHTML(r.note)}" placeholder="备注"></td>
      <td>${statusTag}</td>
    </tr>`;
  }).join('');
}

// ---------- 扫描引擎 ----------

// 原生 BarcodeDetector 引擎（Chrome Android / Edge）
class NativeBarcodeDetectorEngine {
  constructor() { this.detector = null; this.formats = null; }
  get name() { return 'native'; }
  get useFullFrame() { return true; } // 原生快，直接检测全帧 video，省 canvas 拷贝

  async init() {
    const wanted = ['code_128', 'code_39', 'itf', 'qr_code', 'ean_13', 'ean_8', 'codabar'];
    const supported = await window.BarcodeDetector.getSupportedFormats();
    this.formats = wanted.filter(f => supported.includes(f));
    if (!this.formats.length) throw new Error('no supported formats');
    this.detector = new window.BarcodeDetector({ formats: this.formats });
  }

  async decode(source) {
    const results = await this.detector.detect(source);
    if (results && results.length > 0) {
      return { text: results[0].rawValue, format: String(results[0].format).toUpperCase() };
    }
    return null;
  }

  destroy() { this.detector = null; }
}

// zxing-wasm 引擎（iOS Safari 兜底，CDN 动态 import）
class ZxingWasmEngine {
  constructor() { this.mod = null; this.formats = null; this.frameCount = 0; }
  get name() { return 'wasm'; }
  get useFullFrame() { return false; } // 需要 ROI canvas 裁剪

  async init() {
    this.mod = await import('https://cdn.jsdelivr.net/npm/@sec-ant/zxing-wasm@2.2.0/+esm');
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
    const result = await this.mod.readBarcodeFromImageData(imageData, {
      tryHarder,
      formats: this.formats,
      maxSymbols: 1
    });
    if (result && result.text) {
      // 输出格式名也是 PascalCase，统一转大写供 formatLabel 使用
      return { text: result.text, format: String(result.format).toUpperCase() };
    }
    return null;
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

function getROI() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  // object-fit: cover 缩放换算
  const dispW = video.clientWidth, dispH = video.clientHeight;
  const scale = Math.max(dispW / vw, dispH / vh);
  const coveredW = vw * scale, coveredH = vh * scale;
  const offsetX = (dispW - coveredW) / 2;
  const offsetY = (dispH - coveredH) / 2;

  // 扫描框相对视频显示框的坐标
  const vr = video.getBoundingClientRect();
  const fr = scanFrameEl.getBoundingClientRect();
  let sx = (fr.left - vr.left - offsetX) / scale;
  let sy = (fr.top - vr.top - offsetY) / scale;
  let sw = fr.width / scale;
  let sh = fr.height / scale;

  // 外扩 10% margin：提升大二维码/条码边缘容错
  const M = 0.10;
  sw *= (1 + M);
  sh *= (1 + M);
  sx -= sw * M / 2;
  sy -= sh * M / 2;

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
  if (!scanning) return;
  // 扫描成功后的暂停窗口
  if (Date.now() < pauseUntil) {
    scanTimer = setTimeout(scheduleScan, pauseUntil - Date.now());
    return;
  }
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
  if (!scanning) return;
  scanRafId = null;
  scanTimer = null;
  const t0 = performance.now();
  try {
    // 原生引擎直接检测全帧 video（快），wasm 用 ROI canvas
    const source = engine.useFullFrame ? video : captureROI();
    if (source) {
      const r = await engine.decode(source);
      if (r && r.text) handleScanResult(r.text, r.format);
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
    btnStop.disabled = false;
    scanning = true;

    // 6) 启动扫描循环 + 外设
    scheduleScan();
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
    btnStop.disabled = true;
    scanning = false;
    setEngineBadge('');
  }
}

function stopScan() {
  if (!scanning) return;
  scanning = false;
  cancelScanLoop();
  pauseUntil = 0;
  slowMode = false;
  slowStreak = 0;
  fastStreak = 0;

  try { if (engine) engine.destroy(); } catch (e) {}
  engine = null;

  const stream = video.srcObject;
  if (stream) { stream.getTracks().forEach(t => t.stop()); }
  video.srcObject = null;

  scanOverlay.style.display = 'none';
  cameraPlaceholder.style.display = 'flex';
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnTorch.disabled = true;
  btnTorchIcon.style.display = 'none';
  connStatus.textContent = '已停止';
  connStatus.style.color = 'var(--muted)';
  torchTrack = null;
  torchOn = false;
  releaseWakeLock();
  setEngineBadge('');
}

function handleScanResult(text, fmt) {
  const now = Date.now();
  // 冷却期内忽略相同内容
  if (text === lastScanText && now - lastScanTime < COOLDOWN_MS) return;
  lastScanText = text;
  lastScanTime = now;

  // 添加结果
  const item = addResult(text, fmt);

  // 反馈：蜂鸣 + 震动 + 闪烁
  const valid = isValidTrackingNo(text);
  beep(valid ? 1000 : 600, valid ? 0.1 : 0.2);
  vibrate(valid ? 100 : 200);
  scanFlash.classList.add('active');
  setTimeout(() => scanFlash.classList.remove('active'), 300);

  // 扫描成功后暂停 800ms，便于用户确认，避免连续误扫
  pauseUntil = now + 800;

  showToast(valid ? `✓ ${item.trackingNo}` : `⚠ ${item.invalidTrackingNo}`, 2000);
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
  const header = '日期,时间,物流单号,候选单号,条码格式,条码内容,备注,状态\n';
  const rows = results.map(r => {
    const t = new Date(r.timestamp);
    const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    const status = r.trackingNo ? '有效' : (r.invalidTrackingNo ? '待校验' : '空');
    return [
      r.date, time,
      r.trackingNo || '',
      r.invalidTrackingNo || '',
      formatLabel(r.format),
      r.rawText || '',
      r.note || '',
      status
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

// ---------- 事件绑定 ----------

btnStart.addEventListener('click', startScan);
btnStop.addEventListener('click', stopScan);
btnTorch.addEventListener('click', toggleTorch);
btnTorchIcon.addEventListener('click', toggleTorch);
$('btn-copy').addEventListener('click', copyTrackingNos);
$('btn-export').addEventListener('click', exportCSV);
$('btn-clear').addEventListener('click', deleteSelected);
$('btn-add-manual').addEventListener('click', addNewRow);

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
  if (el.classList.contains('tracking-input')) {
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