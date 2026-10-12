const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { formatTimestamp, calculateDirSize, ensureDir } = require('./utils');

/**
 * Checks if FFmpeg is installed and accessible in the system PATH.
 * @returns {boolean}
 */
function checkFfmpegInstalled() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function escapeRegexp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNextFilename(recordingsDir, username, dateStr) {
  try {
    if (!fs.existsSync(recordingsDir)) {
      return `${username}_${dateStr}_1.m4a`;
    }
    const files = fs.readdirSync(recordingsDir);
    const pattern = new RegExp(`^${escapeRegexp(username)}_${escapeRegexp(dateStr)}_(\\d+)\\.m4a$`, 'i');
    
    let maxIndex = 0;
    let foundAny = false;
    for (const file of files) {
      const match = file.match(pattern);
      if (match) {
        foundAny = true;
        const idx = parseInt(match[1], 10);
        if (idx > maxIndex) {
          maxIndex = idx;
        }
      }
    }
    
    // If we didn't find any file matching _STT format, but there might be a file without STT (e.g. username_date.m4a)
    // we still start from 1.
    return `${username}_${dateStr}_${maxIndex + 1}.m4a`;
  } catch (err) {
    logger.error(`Error calculating next filename: ${err.message}`, username);
    return `${username}_${dateStr}_1.m4a`;
  }
}

class ActiveRecording {
  /**
   * @param {string} username - TikTok username
   * @param {string} streamUrl - Stream source URL
   * @param {string} recordingsDir - Directory to store output file
   * @param {number} storageLimitGB - Total storage limit in GB
   * @param {Function} onProgress - Callback for progress updates
   * @param {Function} onEnd - Callback for recording completion
   */
  constructor(username, streamUrl, recordingsDir, storageLimitGB, onProgress, onEnd) {
    this.username = username;
    this.streamUrl = streamUrl;
    this.recordingsDir = path.resolve(recordingsDir);
    this.storageLimitGB = storageLimitGB;
    this.onProgress = onProgress;
    this.onEnd = onEnd;
    
    this.startTime = new Date();
    const dateStr = formatTimestamp(this.startTime);
    this.filename = getNextFilename(this.recordingsDir, this.username, dateStr);
    this.filePath = path.join(this.recordingsDir, this.filename);
    this.ffmpegProcess = null;
    this.sizeBytes = 0;
    this.durationSeconds = 0;
    this.isActive = false;
    this.progressInterval = null;
  }

  start() {
    try {
      ensureDir(this.recordingsDir);
    } catch (err) {
      const errMsg = `Failed to create recordings directory: ${err.message}`;
      logger.error(errMsg, this.username);
      if (this.onEnd) this.onEnd(new Error(errMsg));
      return;
    }

    // 1. Check storage space
    const currentTotalBytes = calculateDirSize(this.recordingsDir);
    const limitBytes = this.storageLimitGB * 1024 * 1024 * 1024;
    if (currentTotalBytes >= limitBytes) {
      const errMsg = `Storage limit reached (${this.storageLimitGB} GB). Cannot start recording for @${this.username}.`;
      logger.error(errMsg, this.username);
      if (this.onEnd) this.onEnd(new Error(errMsg));
      return;
    }

    // 2. Spawn FFmpeg
    // -y: overwrite output files without asking
    // -i: input stream URL
    // -vn: disable video recording
    // -c:a copy: copy audio stream without re-encoding (lossless + CPU friendly)
    // -movflags +faststart: optimize container structure for playback
    const args = [
      '-y',
      '-timeout', '10000000',        // 10s connection timeout
      '-reconnect', '1',             // auto reconnect on disconnect
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',   // max 5s delay between reconnects
      '-i', this.streamUrl,
      '-vn',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      this.filePath
    ];

    logger.info(`Starting FFmpeg recording for @${this.username} -> ${this.filename}`, this.username);
    this.ffmpegProcess = spawn('ffmpeg', args);
    this.isActive = true;

    // Monitor progress
    this.progressInterval = setInterval(() => {
      if (!this.isActive) return;
      
      try {
        if (fs.existsSync(this.filePath)) {
          const stats = fs.statSync(this.filePath);
          this.sizeBytes = stats.size;
          this.durationSeconds = Math.floor((new Date() - this.startTime) / 1000);
          
          if (this.onProgress) {
            this.onProgress({
              filename: this.filename,
              filePath: this.filePath,
              sizeBytes: this.sizeBytes,
              durationSeconds: this.durationSeconds,
              startTime: this.startTime
            });
          }

          // Enforce storage limit on the fly
          const totalBytes = calculateDirSize(this.recordingsDir);
          if (totalBytes >= limitBytes) {
            logger.warn(`Storage limit reached during recording. Stopping stream for @${this.username}...`, this.username);
            this.stop();
          }
        }
      } catch (e) {
        // Ignore stats failures
      }
    }, 5000);

    this.ffmpegProcess.on('close', (code) => {
      this.isActive = false;
      clearInterval(this.progressInterval);
      if (this.forceKillTimeout) {
        clearTimeout(this.forceKillTimeout);
      }
      
      // Update actual file size one last time
      try {
        if (fs.existsSync(this.filePath)) {
          const finalFileStats = fs.statSync(this.filePath);
          this.sizeBytes = finalFileStats.size;
        }
      } catch (e) {}
      
      this.durationSeconds = Math.max(0, Math.floor((new Date() - this.startTime) / 1000));
      
      logger.info(`FFmpeg process for @${this.username} exited with code ${code}. Final size: ${this.sizeBytes} bytes`, this.username);
      
      const finalStats = {
        filename: this.filename,
        filePath: this.filePath,
        sizeBytes: this.sizeBytes,
        durationSeconds: this.durationSeconds,
        startTime: this.startTime,
        endTime: new Date()
      };

      // If the file is too small (e.g. less than 1KB), it's just a blank container or metadata header without actual stream audio data.
      if (this.sizeBytes < 1024) {
        logger.warn(`Recording file for @${this.username} is too small (${this.sizeBytes} bytes). Deleting empty file.`, this.username);
        try {
          if (fs.existsSync(this.filePath)) {
            fs.unlinkSync(this.filePath);
          }
        } catch (err) {
          logger.error(`Failed to delete small empty file: ${err.message}`, this.username);
        }
        if (this.onEnd) {
          this.onEnd(new Error('Recording file too small / empty'), finalStats);
        }
        return;
      }

      if (this.onEnd) {
        this.onEnd(null, finalStats);
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error(`FFmpeg process error: ${err.message}`, this.username);
      // 'close' event will trigger shortly and execute cleanup
    });
  }

  stop() {
    if (this.ffmpegProcess && this.isActive) {
      logger.info(`Stopping recording gracefully for @${this.username}`, this.username);
      try {
        // Send 'q' to FFmpeg standard input to tell it to quit gracefully
        this.ffmpegProcess.stdin.write('q');
      } catch (e) {
        // If stdin is closed/error, send SIGINT signal
        try {
          this.ffmpegProcess.kill('SIGINT');
        } catch (killErr) {
          logger.error(`Failed to kill process: ${killErr.message}`, this.username);
        }
      }

      // Kích hoạt Watchdog 8s
      this.forceKillTimeout = setTimeout(() => {
        if (this.isActive && this.ffmpegProcess) {
          logger.warn(`FFmpeg process for @${this.username} did not exit gracefully within 8s. Force killing...`, this.username);
          try {
            this.ffmpegProcess.kill('SIGKILL');
          } catch (killErr) {
            logger.error(`Failed to force kill process: ${killErr.message}`, this.username);
          }
        }
      }, 8000);
    }
  }
}

module.exports = {
  checkFfmpegInstalled,
  ActiveRecording
};
