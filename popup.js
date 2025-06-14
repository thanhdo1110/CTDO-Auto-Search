// --- CONFIG & STATE ---
const CONFIG_KEY = 'asa_config';
const LOG_KEY = 'log';
const STATS_KEY = 'asa_stats';
let isRunning = false;

// --- UI ELEMENTS ---
const apikeyInput = document.getElementById('apikey');
const minDelayInput = document.getElementById('minDelay');
const maxDelayInput = document.getElementById('maxDelay');
const saveBtn = document.getElementById('saveConfig');
const searchBtn = document.getElementById('searchNow');
const stopBtn = document.getElementById('stopBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const logDiv = document.getElementById('log');
const statDiv = document.getElementById('statistic');

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize UI elements
  if (apikeyInput) apikeyInput.value = '';
  if (minDelayInput) minDelayInput.value = '10';
  if (maxDelayInput) maxDelayInput.value = '60';
  
  // Add event listeners
  if (saveBtn) saveBtn.addEventListener('click', saveConfigUI);
  if (searchBtn) searchBtn.addEventListener('click', startSearch);
  if (stopBtn) stopBtn.addEventListener('click', stopSearch);
  if (clearLogBtn) clearLogBtn.addEventListener('click', clearLog);
  
  // Add input validation
  if (minDelayInput) {
    minDelayInput.addEventListener('change', validateMinDelay);
  }
  if (maxDelayInput) {
    maxDelayInput.addEventListener('change', validateMaxDelay);
  }
  
  // Load initial state
  loadConfigUI();
  loadLog();
  updateStatsUI();
  updateStateUI();
});

// --- CONFIG ---
function saveConfigUI() {
  if (!apikeyInput || !minDelayInput || !maxDelayInput) return;
  
  const config = {
    apikey: apikeyInput.value.trim(),
    minDelay: parseInt(minDelayInput.value) || 10,
    maxDelay: parseInt(maxDelayInput.value) || 60
  };
  
  // Validate min/max delay
  if (config.minDelay > config.maxDelay) {
    const temp = config.minDelay;
    config.minDelay = config.maxDelay;
    config.maxDelay = temp;
    minDelayInput.value = config.minDelay;
    maxDelayInput.value = config.maxDelay;
  }
  
  chrome.storage.local.set({ [CONFIG_KEY]: config }, () => {
    log('Đã lưu cấu hình!');
    // Notify background script about config change
    chrome.runtime.sendMessage({ action: 'configUpdated', config: config });
  });
}

function loadConfigUI() {
  chrome.storage.local.get(CONFIG_KEY, (data) => {
    const config = data[CONFIG_KEY] || {};
    if (apikeyInput) apikeyInput.value = config.apikey || '';
    if (minDelayInput) minDelayInput.value = config.minDelay || 10;
    if (maxDelayInput) maxDelayInput.value = config.maxDelay || 60;
  });
}

function validateMinDelay() {
  if (!minDelayInput || !maxDelayInput) return;
  const min = parseInt(minDelayInput.value) || 10;
  const max = parseInt(maxDelayInput.value) || 60;
  if (min > max) {
    maxDelayInput.value = min;
  }
}

function validateMaxDelay() {
  if (!minDelayInput || !maxDelayInput) return;
  const min = parseInt(minDelayInput.value) || 10;
  const max = parseInt(maxDelayInput.value) || 60;
  if (max < min) {
    minDelayInput.value = max;
  }
}

// --- LOG ---
function log(msg) {
  if (!logDiv) return;
  logDiv.textContent += `\n${msg}`;
  logDiv.scrollTop = logDiv.scrollHeight;
  chrome.storage.local.get(LOG_KEY, (data) => {
    const arr = (data[LOG_KEY] || []);
    arr.push(msg);
    chrome.storage.local.set({ [LOG_KEY]: arr });
  });
}

function loadLog() {
  if (!logDiv) return;
  chrome.storage.local.get(LOG_KEY, (data) => {
    logDiv.textContent = (data[LOG_KEY] || []).join('\n');
    logDiv.scrollTop = logDiv.scrollHeight;
  });
}

function clearLog() {
  chrome.storage.local.set({ [LOG_KEY]: [] }, loadLog);
  log('Đã xóa log.');
}

// --- STOP ---
function stopSearch() {
  chrome.runtime.sendMessage({ action: 'stopSearch' });
  isRunning = false;
  updateStateUI();
  log('Đã gửi yêu cầu dừng tìm kiếm!');
}

// --- STATE ---
function updateStateUI() {
  if (!searchBtn || !stopBtn) return;
  
  if (isRunning) {
    searchBtn.disabled = true;
    stopBtn.disabled = false;
    searchBtn.textContent = 'Đang chạy...';
  } else {
    searchBtn.disabled = false;
    stopBtn.disabled = true;
    searchBtn.textContent = 'Tìm kiếm ngay';
  }
}

// --- STATISTICS ---
function updateStatsUI() {
  if (!statDiv) return;
  chrome.storage.local.get(STATS_KEY, (data) => {
    const stats = data[STATS_KEY] || { today: 0, total: 0, last: '' };
    statDiv.textContent = `Tìm kiếm hôm nay: ${stats.today} | Tổng: ${stats.total}`;
  });
}

// --- LOG REALTIME ---
const port = chrome.runtime.connect({ name: 'popup' });
port.onMessage.addListener((message) => {
  if (message.type === 'log') {
    log(message.msg);
  } else if (message.type === 'state') {
    isRunning = message.running;
    updateStateUI();
  } else if (message.type === 'stats') {
    updateStatsUI();
  }
});

function startSearch() {
  isRunning = true;
  updateStateUI();
  log('🔎 CTDO Auto Search - Bắt đầu quá trình tự động tìm kiếm...');
  log('⏳ Gửi yêu cầu tới background script...');
  chrome.runtime.sendMessage({ action: 'startSearch' });
}

function displayResults(results) {
  const resultsDiv = document.getElementById('searchResults');
  resultsDiv.innerHTML = '';

  if (results.length === 0) {
    resultsDiv.innerHTML = 'Không tìm thấy kết quả nào';
    return;
  }

  results.forEach(result => {
    const div = document.createElement('div');
    div.className = 'search-item';
    div.textContent = result.title;
    div.addEventListener('click', () => {
      chrome.tabs.create({ url: result.url });
    });
    resultsDiv.appendChild(div);
  });
}

// Có thể mở rộng để nhận log từ background script qua chrome.runtime.onMessage 