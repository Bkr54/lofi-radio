const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Create the logs directory if it does not exist
const logDir = path.join(__dirname, '../logs');
const fs = require('fs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Daily rotation configuration
const dailyRotateFileTransport = new DailyRotateFile({
  filename: path.join(logDir, 'lofi-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '1d',  // Keep only 1 day (24h)
  maxSize: '20m',  // Rotate if file exceeds 20MB
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  )
});

const logger = winston.createLogger({
  level: 'info',
  transports: [
    dailyRotateFileTransport,
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      )
    })
  ]
});

module.exports = logger;
