const path = require('path');
const logger = require('./src/logger');
const { checkFfmpegInstalled } = require('./src/recorder');
const ChannelManager = require('./src/channel-manager');
const { startServer } = require('./src/server');
const TelegramBot = require('./src/telegram-bot');

// Đảm bảo pkg đóng gói các thư viện ESM phụ thuộc
if (false) {
  require('got');
  require('@sindresorhus/is');
}

async function main() {
  logger.info('=== Khởi động TikTok Live Audio Recorder ===');

  // 1. Kiểm tra FFmpeg
  const ffmpegInstalled = checkFfmpegInstalled();
  if (!ffmpegInstalled) {
    logger.warn('⚠️ CẢNH BÁO: Không tìm thấy FFmpeg trong hệ thống!');
    logger.warn('Vui lòng cài đặt FFmpeg trên VPS Windows và thêm nó vào biến môi trường PATH.');
    logger.warn('Nếu không có FFmpeg, ứng dụng sẽ không thể thực hiện ghi âm khi kênh trực tuyến.');
    logger.warn('Tải FFmpeg tại: https://ffmpeg.org/download.html');
  } else {
    logger.info('✅ FFmpeg đã được cài đặt và sẵn sàng.');
  }

  // 2. Khởi tạo ChannelManager (load danh sách kênh và cấu hình từ data.json)
  const dataPath = process.pkg
    ? path.join(path.dirname(process.execPath), 'data.json')
    : path.join(__dirname, 'data.json');
  const channelManager = new ChannelManager(dataPath);

  // 3. Khởi tạo Telegram Bot
  const telegramBot = new TelegramBot(channelManager);
  telegramBot.updateConfig(channelManager.telegramConfig);

  // Lắng nghe sự kiện livestream để gửi thông báo qua Telegram
  channelManager.on('live:start', ({ username, title }) => {
    const escapedUser = TelegramBot.escapeMarkdown(username);
    const escapedTitle = TelegramBot.escapeMarkdown(title);
    telegramBot.broadcast(
      `🔴 *ĐANG LIVE!*\n\n` +
      `📺 *Kênh:* @${escapedUser}\n` +
      `🏷️ *Tiêu đề:* ${escapedTitle || 'Không có tiêu đề'}\n\n` +
      `🔗 https://www.tiktok.com/@${escapedUser}/live`,
      'Markdown',
      {
        inline_keyboard: [
          [{ text: '🔴 Xem Live TikTok', url: `https://www.tiktok.com/@${escapedUser}/live` }]
        ]
      }
    );
  });

  channelManager.on('live:end', ({ username }) => {
    const escapedUser = TelegramBot.escapeMarkdown(username);
    telegramBot.broadcast(
      `⚪ *ĐÃ TẮT LIVE*\n\n` +
      `📺 *Kênh:* @${escapedUser}`
    );
  });

  // 4. Khởi chạy HTTP Server & REST API / SSE Dashboard
  startServer(channelManager, telegramBot);

  // 5. Bắt đầu theo dõi các kênh đang có
  channelManager.startMonitoringAll();

  // 6. Xử lý tắt ứng dụng an toàn (Graceful Shutdown)
  const shutdown = () => {
    logger.info('⚠️ Đang đóng ứng dụng an toàn...');
    telegramBot.stop();
    channelManager.stopAll();
    channelManager.saveData();
    logger.info('👋 Đã lưu dữ liệu và đóng tất cả luồng. Tạm biệt!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  logger.error(`Lỗi hệ thống nghiêm trọng: ${err.message || err}`);
  process.exit(1);
});
