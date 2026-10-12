const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./utils');

class Logger extends EventEmitter {
  constructor() {
    super();
    this.logDir = process.pkg
      ? path.resolve(path.dirname(process.execPath), 'logs')
      : path.resolve(__dirname, '../logs');
    ensureDir(this.logDir);
  }

  _getLogFilePath() {
    const pad = (num) => String(num).padStart(2, '0');
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    return path.join(this.logDir, `${yyyy}-${mm}-${dd}.log`);
  }

  log(level, message, context = '') {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const contextStr = context ? ` [${context}]` : '';
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}]${contextStr} ${message}`;
    
    // Log to console
    console.log(formattedMessage);
    
    // Log to file
    try {
      fs.appendFileSync(this._getLogFilePath(), formattedMessage + '\n', 'utf8');
    } catch (e) {
      console.error('Failed to write log to file:', e.message);
    }
    
    // Emit log event
    this.emit('log', {
      timestamp,
      level,
      context,
      message,
      formatted: formattedMessage
    });
  }

  info(message, context) { this.log('info', message, context); }
  warn(message, context) { this.log('warn', message, context); }
  error(message, context) { this.log('error', message, context); }
  debug(message, context) { this.log('debug', message, context); }
}

const logger = new Logger();
module.exports = logger;
