const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

function getAudioDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8', timeout: 3000 }
    );
    const duration = parseFloat(output.trim());
    return isNaN(duration) ? 0 : Math.round(duration);
  } catch (e) {
    return 0;
  }
}
const { checkLiveStatus } = require('./tiktok-checker');
const { ActiveRecording } = require('./recorder');
const { sleep, calculateDirSize, ensureDir } = require('./utils');

class InterruptibleSleep {
  constructor() {
    this.promise = null;
    this.rejectFn = null;
    this.timeoutId = null;
  }

  sleep(ms) {
    this.cancel();
    this.promise = new Promise((resolve, reject) => {
      this.rejectFn = reject;
      this.timeoutId = setTimeout(() => {
        resolve();
        this.promise = null;
        this.rejectFn = null;
        this.timeoutId = null;
      }, ms);
    });
    return this.promise.catch(() => {});
  }

  cancel() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.rejectFn) {
      this.rejectFn(new Error('cancelled'));
      this.rejectFn = null;
      this.promise = null;
    }
  }
}

class ChannelManager extends EventEmitter {
  constructor(dataPath = './data.json') {
    super();
    this.dataPath = path.resolve(dataPath);
    
    // Default values
    this.recordingsDir = './recordings';
    this.storageLimitGB = 50;
    this.checkIntervalMs = 60000; // 60 seconds
    this.channels = {}; // Managed channel objects
    this.recordingsHistory = []; // History of completed recordings
    this.telegramConfig = { botToken: '', allowedChatIds: [], enabled: false };
    
    this.loadData();
    this.scanRecordingsDir();
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const data = JSON.parse(raw);
        this.recordingsDir = data.recordingsDir || './recordings';
        this.storageLimitGB = data.storageLimitGB || 50;
        this.recordingsHistory = data.recordings || [];
        this.telegramConfig = data.telegram || { botToken: '', allowedChatIds: [], enabled: false };
        
        // Channels list loaded as keys
        const channelList = data.channels || [];
        for (const username of channelList) {
          this.initChannelObject(username);
        }
      } else {
        this.telegramConfig = { botToken: '', allowedChatIds: [], enabled: false };
        this.saveData();
      }
    } catch (e) {
      logger.error(`Failed to load data.json: ${e.message}`);
    }
  }

  saveData() {
    const data = {
      recordingsDir: this.recordingsDir,
      storageLimitGB: this.storageLimitGB,
      channels: Object.keys(this.channels),
      recordings: this.recordingsHistory,
      telegram: this.telegramConfig || { botToken: '', allowedChatIds: [], enabled: false }
    };
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      logger.error(`Failed to save data.json: ${e.message}`);
    }
  }

  initChannelObject(username) {
    if (this.channels[username]) return;
    
    this.channels[username] = {
      username,
      status: 'offline', // 'offline', 'checking', 'live', 'recording', 'paused'
      roomId: null,
      title: null,
      currentRecording: null,
      lastChecked: null,
      error: null,
      isMonitoring: false,
      isPaused: false,
      pausedRoomId: null,
      sleepHelper: new InterruptibleSleep(),
      stats: {
        sizeBytes: 0,
        durationSeconds: 0,
        filename: null
      }
    };
  }

  startMonitoringAll() {
    for (const username of Object.keys(this.channels)) {
      this.monitorChannel(username);
    }
  }

  async monitorChannel(username) {
    const channel = this.channels[username];
    if (!channel || channel.isMonitoring) return;
    
    channel.isMonitoring = true;
    logger.info(`Started monitoring @${username}`, username);

    while (this.channels[username]) {
      try {
        if (channel.status === 'offline') {
          channel.status = 'checking';
          this.emit('update');
        }

        const result = await checkLiveStatus(username);
        channel.lastChecked = new Date();
        channel.error = result.error;

        if (result.error) {
          logger.warn(`Error checking @${username}: ${result.error}`, username);
        }

        if (result.isLive) {
          // If a new live room is detected, auto-resume
          if (channel.isPaused && channel.pausedRoomId && result.roomId !== channel.pausedRoomId) {
            logger.info(`♻️ Phát hiện phiên live mới của @${username} (Room ID khác). Tự động bỏ tạm dừng.`, username);
            channel.isPaused = false;
            channel.pausedRoomId = null;
          }

          channel.roomId = result.roomId;
          channel.title = result.title;
          
          if (channel.isPaused) {
            // User manually paused — don't auto-record, just update status
            channel.status = 'paused';
            this.emit('update');
          } else if (channel.status !== 'recording' && channel.status !== 'live') {
            // Transition from offline to live
            this.emit('live:start', { username, title: result.title });
            channel.status = 'live';
            this.emit('update');
            
            logger.info(`@${username} is LIVE! Stream Title: "${result.title || 'No Title'}"`, username);
            this.startRecordingForChannel(username, result.streamUrl);
          }
        } else {
          channel.roomId = null;
          channel.title = null;
          
          // Transition from live/recording/paused to offline
          if (channel.status === 'recording' || channel.status === 'live' || channel.status === 'paused') {
            this.emit('live:end', { username });
          }
          
          if (channel.status === 'recording' || channel.status === 'live') {
            if (channel.currentRecording) {
              channel.currentRecording.stop();
              if (channel.recordingEndPromise) {
                await channel.recordingEndPromise;
              }
            }
          }
          
          channel.status = 'offline';
          channel.stats = { sizeBytes: 0, durationSeconds: 0, filename: null };
          this.emit('update');
        }
      } catch (err) {
        logger.error(`Unexpected error in monitor loop for @${username}: ${err.message}`, username);
        channel.status = 'offline';
        channel.error = err.message;
        this.emit('update');
      }

      // Always sleep for checkIntervalMs to continue periodic checking
      await channel.sleepHelper.sleep(this.checkIntervalMs);
    }
    
    logger.info(`Stopped monitoring @${username}`, username);
  }

  startRecordingForChannel(username, streamUrl) {
    const channel = this.channels[username];
    if (!channel) return;

    let resolveEndPromise;
    channel.recordingEndPromise = new Promise((resolve) => {
      resolveEndPromise = resolve;
    });

    const recording = new ActiveRecording(
      username,
      streamUrl,
      this.recordingsDir,
      this.storageLimitGB,
      (progress) => {
        // progress callback
        channel.status = 'recording';
        channel.stats.sizeBytes = progress.sizeBytes;
        channel.stats.durationSeconds = progress.durationSeconds;
        channel.stats.filename = progress.filename;
        
        this.emit('recording:progress', { username, ...progress });
        this.emit('update');
      },
      (err, finalStats) => {
        // end callback
        channel.currentRecording = null;
        channel.status = channel.isPaused ? 'paused' : 'offline';
        channel.stats = { sizeBytes: 0, durationSeconds: 0, filename: null };
        
        if (!err && finalStats && finalStats.sizeBytes > 0) {
          const record = {
            username,
            filename: finalStats.filename,
            duration: finalStats.durationSeconds,
            size: finalStats.sizeBytes,
            timestamp: finalStats.startTime.toISOString()
          };
          this.recordingsHistory.unshift(record); // Add to beginning of history
          this.saveData();
        }
        
        this.emit('recording:end', {
          username,
          error: err ? err.message : null,
          stats: finalStats
        });
        this.emit('update');
        
        resolveEndPromise();
      }
    );

    channel.currentRecording = recording;
    channel.status = 'recording';
    
    this.emit('recording:start', {
      username,
      filename: recording.filename,
      startTime: recording.startTime
    });
    this.emit('update');
    
    recording.start();
  }

  addChannel(username) {
    username = username.trim().toLowerCase().replace(/^@/, '');
    if (!username) return false;
    
    if (this.channels[username]) return false;
    
    this.initChannelObject(username);
    this.saveData();
    this.monitorChannel(username);
    this.emit('update');
    return true;
  }

  stopRecording(username) {
    username = username.trim().toLowerCase();
    const channel = this.channels[username];
    if (!channel) return false;
    
    if (channel.currentRecording) {
      logger.info(`⏹ Dừng ghi âm @${username} theo yêu cầu.`, username);
      channel.isPaused = true;
      channel.status = 'paused';
      channel.pausedRoomId = channel.roomId; // Keep track of the current room ID we paused
      channel.currentRecording.stop();
      this.emit('update');
      return true;
    }
    return false;
  }

  resumeRecording(username) {
    username = username.trim().toLowerCase();
    const channel = this.channels[username];
    if (!channel) return false;
    
    if (channel.isPaused) {
      logger.info(`▶ Tiếp tục ghi âm @${username} theo yêu cầu.`, username);
      channel.isPaused = false;
      channel.pausedRoomId = null; // Clear the paused room ID
      channel.status = 'checking';
      this.emit('update');
      
      // Cancel the wait timer to trigger check loop immediately
      if (channel.sleepHelper) {
        channel.sleepHelper.cancel();
      }
      return true;
    }
    return false;
  }

  removeChannel(username) {
    username = username.trim().toLowerCase();
    const channel = this.channels[username];
    if (!channel) return false;
    
    // Stop recording if active
    if (channel.currentRecording) {
      channel.currentRecording.stop();
    }
    
    delete this.channels[username];
    this.saveData();
    this.emit('update');
    return true;
  }

  updateSettings(recordingsDir, storageLimitGB) {
    if (recordingsDir) this.recordingsDir = recordingsDir;
    if (storageLimitGB !== undefined) this.storageLimitGB = Number(storageLimitGB);
    this.saveData();
    
    // Update all active recordings with new folder and limit if applicable
    // (Active recordings already spawned will continue, but future ones will use new settings)
    this.emit('update');
  }

  stopAll() {
    for (const username of Object.keys(this.channels)) {
      const channel = this.channels[username];
      if (channel.currentRecording) {
        channel.currentRecording.stop();
      }
    }
  }

  getStatus() {
    const channelsData = Object.values(this.channels).map(c => ({
      username: c.username,
      status: c.status,
      roomId: c.roomId,
      title: c.title,
      lastChecked: c.lastChecked,
      error: c.error,
      stats: c.stats,
      isPaused: c.isPaused
    }));

    const storageUsedBytes = calculateDirSize(this.recordingsDir);
    
    return {
      channels: channelsData,
      recordingsDir: this.recordingsDir,
      storageLimitGB: this.storageLimitGB,
      storageUsedBytes,
      recordingsHistory: this.recordingsHistory,
      telegram: this.telegramConfig
    };
  }

  scanRecordingsDir() {
    try {
      const resolvedDir = path.resolve(this.recordingsDir);
      if (!fs.existsSync(resolvedDir)) {
        ensureDir(resolvedDir);
      }
      
      // Get filenames of active recordings
      const activeFilenames = new Set(
        Object.values(this.channels)
          .filter(c => c.currentRecording && c.currentRecording.filename)
          .map(c => c.currentRecording.filename)
      );

      // Filter out active recording files from scan
      const files = fs.readdirSync(resolvedDir)
        .filter(f => f.toLowerCase().endsWith('.m4a') && !activeFilenames.has(f));
        
      const newHistory = [];
      const cachedMap = new Map(this.recordingsHistory.map(item => [item.filename, item]));
      
      for (const file of files) {
        const filePath = path.join(resolvedDir, file);
        let stats;
        try {
          stats = fs.statSync(filePath);
        } catch (e) {
          continue;
        }
        
        if (cachedMap.has(file)) {
          const cached = cachedMap.get(file);
          cached.size = stats.size;
          // If cached duration is 0 or missing, read it using ffprobe
          if (!cached.duration || cached.duration === 0) {
            cached.duration = getAudioDuration(filePath);
          }
          newHistory.push(cached);
        } else {
          // Parse filename
          const nameWithoutExt = file.substring(0, file.length - 4);
          const parts = nameWithoutExt.split('_');
          
          let username = 'unknown';
          let timestampStr = stats.mtime.toISOString();
          
          let dateIndex = -1;
          for (let i = 0; i < parts.length - 2; i++) {
            const isDD = /^\d{2}$/.test(parts[i]);
            const isMM = /^\d{2}$/.test(parts[i+1]);
            const isYYYY = /^\d{4}$/.test(parts[i+2]);
            if (isDD && isMM && isYYYY) {
              dateIndex = i;
              break;
            }
          }
          
          if (dateIndex !== -1) {
            username = parts.slice(0, dateIndex).join('_');
            const dd = parts[dateIndex];
            const mm = parts[dateIndex+1];
            const yyyy = parts[dateIndex+2];
            const dateObj = new Date(yyyy, mm - 1, dd, 12, 0, 0);
            if (stats.mtime.getFullYear() === dateObj.getFullYear() &&
                stats.mtime.getMonth() === dateObj.getMonth() &&
                stats.mtime.getDate() === dateObj.getDate()) {
              timestampStr = stats.mtime.toISOString();
            } else {
              timestampStr = dateObj.toISOString();
            }
          } else {
            username = parts[0] || 'unknown';
          }
          
          // Get duration of new file using ffprobe
          const duration = getAudioDuration(filePath);
          
          newHistory.push({
            username: username,
            filename: file,
            duration: duration,
            size: stats.size,
            timestamp: timestampStr
          });
        }
      }
      
      newHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      this.recordingsHistory = newHistory;
      this.saveData();
      this.emit('update');
      return true;
    } catch (err) {
      logger.error(`Error scanning recordings directory: ${err.message}`);
      return false;
    }
  }
}

module.exports = ChannelManager;
