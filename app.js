// ============================================================
// 物流面单扫描工具 — 摄像头实时识别
// 使用 @zxing/library BrowserMultiFormatReader
// ============================================================

'use strict';

// ---------- 常量 ----------

const STORAGE_KEY = 'labelScannerResults';
const COOLDOWN_MS = 3000; // 同一条码内容冷却时间

// 物流面单常见条码格式
const COMMON_FORMATS = [
  ZXing.BarcodeFormat.CODE_128,
  ZXing.BarcodeFormat.QR_CODE,
  ZXing.BarcodeFormat.CODE_39,
  ZXing.BarcodeFormat.ITF,
  ZXing.BarcodeFormat.CODABAR,
  ZXing.BarcodeFormat.EAN_13,
  ZXing.BarcodeFormat.EAN_8
];

// ---------- 状态 ----------

let reader = null;
let scanning = false;
let lastScanText = '';
let lastScanTime = 0;
let wakeLock = null;
let torchOn = false;
let torchTrack = null;

const results = loadResults();

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const video = $('video');
const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnTorch = $('btn-torch-toggle');
const btnTorchIcon = $('btn-torch');
const scanOverlay = $('scan-overlay');
const scanFlash = $('scan-flash');
const cameraPlaceholder = $('camera-placeholder');
const connStatus = $('conn-status');
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
    'CODE_128': 'CODE128',
    'QR_CODE': 'QR',
    'CODE_39': 'CODE39',
    'ITF': 'ITF',
    'CODABAR': 'Codabar',
    'EAN_13': 'EAN13',
    'EAN_8': 'EAN8'
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
  results.unshift(item);
  saveResults();
  render();
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
      <td style="white-space:nowrap;font-size:12px">${escapeHTML(r.date.slice(5))}<br><span style="color:var(--muted)">${timeStr}</span></td>
      <td>${trackingCell}${dupTag}</td>
      <td style="white-space:nowrap">${escapeHTML(formatLabel(r.format))}</td>
      <td><input class="note-input" data-id="${r.id}" value="${escapeHTML(r.note)}" placeholder="备注"></td>
      <td>${statusTag}</td>
    </tr>`;
  }).join('');
}

// ---------- 摄像头控制 ----------

async function startScan() {
  if (scanning) return;
  try {
    if (!reader) {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, COMMON_FORMATS);
      reader = new ZXing.BrowserMultiFormatReader(hints, 200);
    }

    cameraPlaceholder.style.display = 'none';
    scanOverlay.style.display = 'flex';
    btnStart.disabled = true;
    btnStop.disabled = false;

    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    reader.decodeFromConstraints(constraints, video, (result, err) => {
      if (result) {
        const text = result.getText();
        const fmt = result.getBarcodeFormat();
        handleScanResult(text, fmt);
      }
    });

    scanning = true;

    // 检测手电筒支持
    await detectTorch();

    // 屏幕常亮
    await requestWakeLock();

    connStatus.textContent = '扫描中';
    connStatus.style.color = 'var(--ok)';
  } catch (e) {
    console.error('[扫描] 启动失败:', e);
    showToast('摄像头启动失败: ' + e.message, 3000);
    cameraPlaceholder.style.display = 'flex';
    scanOverlay.style.display = 'none';
    btnStart.disabled = false;
    btnStop.disabled = true;
    scanning = false;
  }
}

function stopScan() {
  if (!scanning) return;
  try {
    reader.reset();
  } catch (e) {}
  scanning = false;
  scanOverlay.style.display = 'none';
  cameraPlaceholder.style.display = 'flex';
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnTorch.disabled = true;
  btnTorchIcon.style.display = 'none';
  connStatus.textContent = '已停止';
  connStatus.style.color = 'var(--muted)';
  releaseWakeLock();
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

  showToast(valid ? `✓ ${item.trackingNo}` : `⚠ ${item.invalidTrackingNo}`, 2000);
}

// ---------- 手电筒 ----------

async function detectTorch() {
  try {
    const stream = video.srcObject;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    torchTrack = track;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps && 'torch' in caps) {
      btnTorchIcon.style.display = 'block';
      btnTorch.disabled = false;
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

function clearAll() {
  if (results.length === 0) { showToast('无数据', 1500); return; }
  if (!confirm(`确定清空 ${results.length} 条结果？此操作不可撤销。`)) return;
  results.length = 0;
  saveResults();
  render();
  showToast('已清空', 1500);
}

// 手动添加
function addManual() {
  const input = prompt('输入物流单号：');
  if (!input) return;
  const trimmed = input.trim().toUpperCase();
  const valid = isValidTrackingNo(trimmed);
  addResult(trimmed, 'MANUAL');
  showToast(valid ? `✓ 已添加: ${trimmed}` : `⚠ 已添加(待校验): ${trimmed}`, 2000);
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
$('btn-clear').addEventListener('click', clearAll);
$('btn-add-manual').addEventListener('click', addManual);

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