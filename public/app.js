// Utility Formatting Functions
function formatDuration(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00:00';
  const pad = (num) => String(num).padStart(2, '0');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(isoString) {
  try {
    const date = new Date(isoString);
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  } catch (e) {
    return isoString;
  }
}

// DOM Elements
const settingsForm = document.getElementById('settings-form');
const recordingsDirInput = document.getElementById('recordings-dir');
const storageText = document.getElementById('storage-text');
const storageProgress = document.getElementById('storage-progress');

const addChannelForm = document.getElementById('add-channel-form');
const channelUsernameInput = document.getElementById('channel-username');
const channelsContainer = document.getElementById('channels-container');

const historyBody = document.getElementById('history-body');
const reloadHistoryBtn = document.getElementById('reload-history-btn');

const logsContainer = document.getElementById('logs-container');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const shutdownBtn = document.getElementById('shutdown-btn');

// Telegram Bot DOM Elements
const telegramForm = document.getElementById('telegram-form');
const tgEnabledCheckbox = document.getElementById('tg-enabled');
const tgTokenInput = document.getElementById('tg-token');
const tgChatIdInput = document.getElementById('tg-chat-id-input');
const tgAddChatIdBtn = document.getElementById('tg-add-chat-id-btn');
const tgChatIdsList = document.getElementById('tg-chat-ids-list');
const tgTestBtn = document.getElementById('tg-test-btn');

let whitelistedChatIds = [];

// Sidebar Navigation
const navItems = document.querySelectorAll('.nav-item');
const sections = document.querySelectorAll('.content-section');

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    // Remove active class from all navs and sections
    navItems.forEach(n => n.classList.remove('active'));
    sections.forEach(s => s.classList.remove('active'));
    
    // Add active class to clicked nav and target section
    item.classList.add('active');
    const targetId = item.getAttribute('data-target');
    const targetSection = document.getElementById(targetId);
    if (targetSection) {
      targetSection.classList.add('active');
    }
  });
});

// SSE Connection
let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  appendLog('system', '🔄 Đang kết nối tới server...');
  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('status_update', (event) => {
    try {
      const status = JSON.parse(event.data);
      updateUI(status);
    } catch (err) {
      console.error('Failed to parse status_update data', err);
    }
  });

  eventSource.addEventListener('log', (event) => {
    try {
      const logData = JSON.parse(event.data);
      appendLog(logData.level, logData.formatted);
    } catch (err) {
      console.error('Failed to parse log data', err);
    }
  });

  eventSource.onopen = () => {
    appendLog('system', '🟢 Kết nối thành công!');
    document.querySelector('.status-dot').className = 'status-dot green';
    document.querySelector('.status-text').textContent = 'Đang chạy';
  };

  eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    appendLog('error', '🔴 Mất kết nối tới server. Đang thử kết nối lại...');
    document.querySelector('.status-dot').className = 'status-dot';
    document.querySelector('.status-text').textContent = 'Mất kết nối';
    
    // SSE naturally retries, but we print status
  };
}

// Update UI Components
function updateUI(status) {
  if (document.activeElement !== recordingsDirInput) {
    recordingsDirInput.value = status.recordingsDir;
  }

  // 2. Storage info
  const usedGB = (status.storageUsedBytes / (1024 * 1024 * 1024)).toFixed(2);
  storageText.textContent = `${usedGB} GB / ${status.storageLimitGB} GB`;
  
  const percentage = Math.min(100, (status.storageUsedBytes / (status.storageLimitGB * 1024 * 1024 * 1024)) * 100);
  storageProgress.style.width = `${percentage}%`;
  
  if (percentage > 95) {
    storageProgress.style.background = 'var(--danger-color)';
  } else if (percentage > 80) {
    storageProgress.style.background = 'var(--warning-color)';
  } else {
    storageProgress.style.background = 'linear-gradient(90deg, var(--secondary-color), var(--primary-color))';
  }

  // 3. Channels list
  if (status.channels.length === 0) {
    channelsContainer.innerHTML = '<div class="empty-state">Chưa theo dõi kênh nào. Nhập tên kênh ở trên để bắt đầu!</div>';
  } else {
    // Sort channels so active recording ones are on top
    const sortedChannels = [...status.channels].sort((a, b) => {
      const order = { 'recording': 1, 'live': 2, 'paused': 3, 'checking': 4, 'offline': 5 };
      return (order[a.status] || 99) - (order[b.status] || 99);
    });

    channelsContainer.innerHTML = sortedChannels.map(channel => {
      const isRecording = channel.status === 'recording';
      const isPaused = channel.status === 'paused';
      const badgeClass = `badge ${channel.status}`;
      
      let badgeLabel = channel.status;
      if (channel.status === 'offline') badgeLabel = 'Offline';
      if (channel.status === 'checking') badgeLabel = 'Đang kiểm tra';
      if (channel.status === 'live') badgeLabel = 'Đang live';
      if (channel.status === 'recording') badgeLabel = '● REC';
      if (channel.status === 'paused') badgeLabel = 'Tạm dừng ghi';

      let detailsHtml = '';
      if (isRecording && channel.stats) {
        detailsHtml = `
          <div class="recording-stats">
            <div class="stat-item"><span class="stat-icon">📁</span> ${channel.stats.filename || ''}</div>
            <div class="stat-row">
              <div class="stat-item"><span class="stat-icon">⏱️</span> ${formatDuration(channel.stats.durationSeconds)}</div>
              <div class="stat-item"><span class="stat-icon">💾</span> ${formatFileSize(channel.stats.sizeBytes)}</div>
            </div>
          </div>
        `;
      } else if (channel.error) {
        detailsHtml = `<div class="channel-error">⚠️ ${channel.error}</div>`;
      } else if (channel.lastChecked) {
        detailsHtml = `<div class="channel-last-check">Lần kiểm tra cuối: ${new Date(channel.lastChecked).toLocaleTimeString()}</div>`;
      }

      return `
        <div class="channel-item ${isRecording ? 'is-recording' : ''} ${isPaused ? 'is-paused' : ''}">
          <div class="channel-info">
            <div class="channel-header-row">
              <span class="channel-name">@${channel.username}</span>
              <span class="${badgeClass}">${badgeLabel}</span>
            </div>
            ${channel.title ? `<div class="stream-title">🎬 ${channel.title}</div>` : ''}
            ${detailsHtml}
          </div>
          <div class="channel-actions">
            ${isRecording ? `<button class="btn warning btn-sm btn-stop-recording" data-username="${channel.username}" title="Dừng ghi âm">⏹</button>` : ''}
            ${isPaused ? `<button class="btn success btn-sm btn-resume-recording" data-username="${channel.username}" title="Tiếp tục ghi âm">▶</button>` : ''}
            <button class="btn danger btn-sm btn-delete-channel" data-username="${channel.username}" title="Xóa kênh">✕</button>
          </div>
        </div>
      `;
    }).join('');

    // Attach stop recording listeners
    document.querySelectorAll('.btn-stop-recording').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const username = e.target.dataset.username;
        if (confirm(`Bạn có chắc muốn dừng ghi âm kênh @${username}?`)) {
          stopRecording(username);
        }
      });
    });

    // Attach resume recording listeners
    document.querySelectorAll('.btn-resume-recording').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const username = e.target.dataset.username;
        resumeRecording(username);
      });
    });

    // Attach delete listeners
    document.querySelectorAll('.btn-delete-channel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const username = e.target.dataset.username;
        if (confirm(`Bạn có chắc muốn xóa kênh @${username}?`)) {
          deleteChannel(username);
        }
      });
    });
  }

  // 4. History table
  if (status.recordingsHistory.length === 0) {
    historyBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-table">Chưa có tệp tin nào được ghi.</td>
      </tr>
    `;
  } else {
    historyBody.innerHTML = status.recordingsHistory.map(rec => {
      return `
        <tr>
          <td><strong>@${rec.username}</strong></td>
          <td style="font-family: monospace;">${rec.filename}</td>
          <td>${formatDuration(rec.duration)}</td>
          <td>${formatFileSize(rec.size)}</td>
          <td>${formatDate(rec.timestamp)}</td>
        </tr>
      `;
    }).join('');
  }

  // 5. Telegram Bot Config
  if (status.telegram) {
    tgEnabledCheckbox.checked = !!status.telegram.enabled;
    if (document.activeElement !== tgTokenInput) {
      tgTokenInput.value = status.telegram.botToken || '';
    }
    
    // Check if whitelistedChatIds array has changed
    const currentIdsStr = JSON.stringify(whitelistedChatIds.map(String).sort());
    const serverIdsStr = JSON.stringify((status.telegram.allowedChatIds || []).map(String).sort());
    if (currentIdsStr !== serverIdsStr) {
      whitelistedChatIds = status.telegram.allowedChatIds || [];
      renderChatIds();
    }
  }
}

function renderChatIds() {
  if (whitelistedChatIds.length === 0) {
    tgChatIdsList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 10px 0;">Danh sách trống</div>';
    return;
  }
  
  tgChatIdsList.innerHTML = whitelistedChatIds.map(id => `
    <div class="chat-id-item">
      <span>${id}</span>
      <button type="button" class="remove-id-btn" data-id="${id}">✕</button>
    </div>
  `).join('');

  // Attach delete click handlers
  tgChatIdsList.querySelectorAll('.remove-id-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idToRemove = e.target.dataset.id;
      whitelistedChatIds = whitelistedChatIds.filter(id => String(id) !== String(idToRemove));
      renderChatIds();
    });
  });
}

// Log Append to console box
function appendLog(level, message) {
  const div = document.createElement('div');
  div.className = `log-entry ${level}`;
  div.textContent = message;
  logsContainer.appendChild(div);
  
  // Auto-scroll
  logsContainer.scrollTop = logsContainer.scrollHeight;
  
  // Limit log count
  while (logsContainer.childNodes.length > 500) {
    logsContainer.removeChild(logsContainer.firstChild);
  }
}

// API Calls
async function saveTelegramSettings(botToken, allowedChatIds, enabled) {
  try {
    const res = await fetch('/api/telegram/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken, allowedChatIds, enabled })
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `⚙️ Đã cập nhật cấu hình Telegram Bot thành công!`);
    } else {
      appendLog('error', `❌ Cập nhật cấu hình Telegram Bot thất bại: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi lưu cấu hình Telegram Bot: ${err.message}`);
  }
}

async function sendTelegramTestMessage() {
  try {
    tgTestBtn.disabled = true;
    tgTestBtn.textContent = '📨 Đang gửi...';
    const res = await fetch('/api/telegram/test', {
      method: 'POST'
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `🔔 Đã gửi tin nhắn test qua Telegram Bot.`);
    } else {
      appendLog('error', `❌ Gửi tin nhắn test thất bại: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi gửi tin nhắn test: ${err.message}`);
  } finally {
    tgTestBtn.disabled = false;
    tgTestBtn.textContent = '📨 Gửi thử';
  }
}

async function saveSettings(recordingsDir, storageLimitGB) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingsDir, storageLimitGB })
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `⚙️ Đã cập nhật cài đặt thành công!`);
    } else {
      appendLog('error', `❌ Cập nhật cài đặt thất bại: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi lưu cài đặt: ${err.message}`);
  }
}

async function addChannel(username) {
  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `➕ Đã thêm theo dõi kênh @${username}`);
      channelUsernameInput.value = '';
    } else {
      appendLog('error', `❌ Thêm kênh @${username} thất bại. Kênh có thể đã tồn tại.`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi thêm kênh: ${err.message}`);
  }
}

async function stopRecording(username) {
  try {
    const res = await fetch(`/api/channels/${encodeURIComponent(username)}/stop`, {
      method: 'POST'
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `⏹ Đã dừng ghi âm kênh @${username} (Tạm dừng)`);
    } else {
      appendLog('error', `❌ Kênh @${username} hiện không đang ghi âm.`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi dừng ghi âm: ${err.message}`);
  }
}

async function resumeRecording(username) {
  try {
    const res = await fetch(`/api/channels/${encodeURIComponent(username)}/resume`, {
      method: 'POST'
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `▶ Đã tiếp tục ghi âm kênh @${username}`);
    } else {
      appendLog('error', `❌ Kênh @${username} không bị tạm dừng.`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi tiếp tục ghi âm: ${err.message}`);
  }
}

async function deleteChannel(username) {
  try {
    const res = await fetch(`/api/channels/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `🗑️ Đã xóa theo dõi kênh @${username}`);
    } else {
      appendLog('error', `❌ Xóa kênh @${username} thất bại.`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi xóa kênh: ${err.message}`);
  }
}

async function reloadHistory() {
  try {
    reloadHistoryBtn.disabled = true;
    reloadHistoryBtn.textContent = '🔄 Đang tải...';
    
    const res = await fetch('/api/history/reload', {
      method: 'POST'
    });
    const result = await res.json();
    if (result.success) {
      appendLog('system', `🔄 Đã cập nhật danh sách file từ thư mục ghi âm.`);
    } else {
      appendLog('error', `❌ Cập nhật danh sách file thất bại: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', `❌ Lỗi kết nối khi tải lại lịch sử: ${err.message}`);
  } finally {
    reloadHistoryBtn.disabled = false;
    reloadHistoryBtn.textContent = '🔄 Tải lại';
  }
}

// Form Handlers
settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dir = recordingsDirInput.value.trim();
  if (dir) {
    // Keep storageLimitGB as currently displayed or default 50
    const limit = parseFloat(storageText.textContent.split('/')[1]) || 50;
    saveSettings(dir, limit);
  }
});

addChannelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = channelUsernameInput.value.trim();
  if (username) {
    addChannel(username);
  }
});

clearLogsBtn.addEventListener('click', () => {
  logsContainer.innerHTML = '';
  appendLog('system', '🧹 Đã xóa logs.');
});

shutdownBtn.addEventListener('click', async () => {
  if (confirm('⚠️ Bạn có chắc chắn muốn TẮT SERVER?\nHành động này sẽ dừng toàn bộ quá trình ghi âm đang diễn ra và đóng ứng dụng.')) {
    try {
      appendLog('system', '🔌 Đang gửi yêu cầu tắt server...');
      const res = await fetch('/api/shutdown', { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        appendLog('system', '🔴 Server đang tắt. Bạn có thể đóng tab trình duyệt này.');
        document.querySelector('.status-dot').className = 'status-dot';
        document.querySelector('.status-text').textContent = 'Đã tắt';
        shutdownBtn.disabled = true;
        
        // Close EventSource connection to prevent auto-reconnect logs
        if (eventSource) {
          eventSource.close();
        }
      }
    } catch (err) {
      appendLog('error', `❌ Không thể gửi yêu cầu tắt server: ${err.message}`);
    }
  }
});

// Telegram Event Handlers
telegramForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const token = tgTokenInput.value.trim();
  const enabled = tgEnabledCheckbox.checked;
  saveTelegramSettings(token, whitelistedChatIds, enabled);
});

tgAddChatIdBtn.addEventListener('click', () => {
  const newId = tgChatIdInput.value.trim();
  if (!newId) return;
  
  if (whitelistedChatIds.map(String).includes(String(newId))) {
    appendLog('error', `⚠️ Chat ID ${newId} đã tồn tại trong danh sách whitelist!`);
    return;
  }
  
  whitelistedChatIds.push(newId);
  tgChatIdInput.value = '';
  renderChatIds();
});

tgTestBtn.addEventListener('click', () => {
  sendTelegramTestMessage();
});

// Register Event Listeners
reloadHistoryBtn.addEventListener('click', reloadHistory);

// Startup Initialization
connectSSE();
