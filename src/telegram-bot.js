const https = require('https');
const logger = require('./logger');
const { checkLiveStatus } = require('./tiktok-checker');

class TelegramBot {
  static escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/([_*\[`])/g, '\\$1');
  }

  static getMainKeyboard() {
    return {
      keyboard: [
        [{ text: '📋 Danh sách kênh' }, { text: '📊 Trạng thái' }],
        [{ text: '➕ Thêm kênh' }, { text: '🔍 Kiểm tra live' }],
        [{ text: '❓ Hướng dẫn' }]
      ],
      resize_keyboard: true,
      is_persistent: true
    };
  }

  constructor(channelManager) {
    this.channelManager = channelManager;
    this.botToken = '';
    this.allowedChatIds = [];
    this.enabled = false;
    this.pollingActive = false;
    this.lastUpdateId = 0;
    this.pollingTimeout = null;
    this.startTime = new Date();

    // Reuse TCP connections to Telegram API
    this._agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 3,
      timeout: 60000
    });
  }

  updateConfig(config) {
    const oldEnabled = this.enabled;
    const oldToken = this.botToken;

    if (config.botToken !== undefined) this.botToken = config.botToken.trim();
    if (config.allowedChatIds !== undefined) this.allowedChatIds = config.allowedChatIds.map(id => String(id).trim());
    if (config.enabled !== undefined) this.enabled = !!config.enabled;

    logger.info(`Telegram Bot config updated: enabled=${this.enabled}, allowedChatIds=[${this.allowedChatIds.join(', ')}]`);

    // Handle bot polling state transitions
    if (this.enabled) {
      if (this.botToken && (oldToken !== this.botToken || !oldEnabled)) {
        this.stop();
        this.start();
      }
    } else {
      this.stop();
    }
  }

  async setMyCommands() {
    if (!this.botToken) return;
    try {
      await this._request('setMyCommands', {
        commands: [
          { command: 'list', description: '📋 Xem danh sách kênh theo dõi' },
          { command: 'status', description: '📊 Xem trạng thái server & dung lượng' },
          { command: 'check', description: '🔍 Kiểm tra trực tiếp 1 kênh live' },
          { command: 'add', description: '➕ Thêm kênh TikTok theo dõi' },
          { command: 'remove', description: '❌ Xóa kênh khỏi danh sách' },
          { command: 'interval', description: '⚙️ Đổi tần suất quét live (giây)' },
          { command: 'help', description: '❓ Xem menu & hướng dẫn sử dụng' }
        ]
      }, 15000);
      logger.info('✅ Telegram Bot: Đã đăng ký danh sách lệnh (Menu) thành công.');
    } catch (err) {
      logger.warn(`⚠️ Telegram Bot: Không thể đăng ký lệnh menu (${err.message}).`);
    }
  }

  async start() {
    if (!this.enabled || !this.botToken) {
      logger.info('Telegram Bot is disabled or missing token. Not starting.');
      return;
    }

    logger.info('Starting Telegram Bot polling...');

    // Verify bot token and connectivity before starting
    try {
      const me = await this._request('getMe', {}, 10000);
      logger.info(`✅ Telegram Bot đã kết nối: @${me.username} (${me.first_name})`);
      await this.setMyCommands();
    } catch (err) {
      logger.warn(`⚠️ Telegram Bot không thể kết nối (${err.message}). Vẫn khởi động polling, sẽ tự thử lại...`);
    }

    this.pollingActive = true;
    this.lastUpdateId = 0;
    this.poll();
  }

  stop() {
    if (this.pollingActive) {
      logger.info('Stopping Telegram Bot polling...');
      this.pollingActive = false;
    }
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
  }

  // HTTP helper to call Telegram Bot API
  _request(methodName, payload = {}, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
      if (!this.botToken) {
        return reject(new Error('Bot token is missing'));
      }

      const postData = JSON.stringify(payload);
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.botToken}/${methodName}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs,
        agent: this._agent
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) {
              resolve(parsed.result);
            } else {
              reject(new Error(parsed.description || 'API Error'));
            }
          } catch (err) {
            reject(new Error(`Failed to parse JSON response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request Timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  async answerCallbackQuery(callbackQueryId, text = null, showAlert = false) {
    try {
      const payload = { callback_query_id: callbackQueryId };
      if (text) {
        payload.text = text;
        payload.show_alert = showAlert;
      }
      await this._request('answerCallbackQuery', payload, 10000);
      return true;
    } catch (e) {
      return false;
    }
  }

  async sendMessage(chatId, text, parseMode = 'Markdown', replyMarkup = null) {
    const maxRetries = 3;
    const isAllowed = this.allowedChatIds.includes(String(chatId));

    // Default to main reply keyboard if no markup provided for allowed user
    const finalMarkup = replyMarkup || (isAllowed ? TelegramBot.getMainKeyboard() : undefined);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const payload = {
          chat_id: String(chatId),
          text: text,
          parse_mode: parseMode
        };
        if (finalMarkup) {
          payload.reply_markup = finalMarkup;
        }

        await this._request('sendMessage', payload, 15000);
        return true;
      } catch (err) {
        const isRetryable = ['Request Timeout', 'Bad Gateway', 'socket hang up', 'ECONNRESET', 'ETIMEDOUT']
          .some(keyword => err.message.includes(keyword));

        if (isRetryable && attempt < maxRetries) {
          const delay = attempt * 5000;
          logger.warn(`Telegram gửi tin nhắn thất bại (lần ${attempt}/${maxRetries}): ${err.message}. Thử lại sau ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error(`Telegram Bot failed to send message to ${chatId}: ${err.message}${attempt > 1 ? ` (sau ${attempt} lần thử)` : ''}`);
          return false;
        }
      }
    }
    return false;
  }

  async broadcast(text, parseMode = 'Markdown', replyMarkup = null) {
    if (!this.enabled || !this.botToken || this.allowedChatIds.length === 0) return;

    logger.info(`Broadcasting message to Telegram whitelist...`);
    for (const chatId of this.allowedChatIds) {
      await this.sendMessage(chatId, text, parseMode, replyMarkup);
    }
  }

  // Polling loop
  async poll() {
    if (!this.pollingActive) return;

    try {
      const updates = await this._request('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30, // 30s long polling
        allowed_updates: ['message', 'callback_query']
      }, 35000);

      // Reset backoff on success
      this._pollRetryDelay = 5000;
      this._pollErrorCount = 0;

      if (this._consecutiveTimeouts >= 3) {
        logger.info('✅ Telegram Bot: Đã khôi phục kết nối thành công!');
      }
      this._consecutiveTimeouts = 0;

      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        if (update.message) {
          await this.handleMessage(update.message);
        } else if (update.callback_query) {
          await this.handleCallbackQuery(update.callback_query);
        }
      }
    } catch (err) {
      const isTransientTimeout = err.message === 'Request Timeout' || err.message === 'socket hang up';

      if (isTransientTimeout) {
        this._consecutiveTimeouts = (this._consecutiveTimeouts || 0) + 1;
        if (this._consecutiveTimeouts === 3) {
          logger.warn('⚠️ Telegram Bot: Mất kết nối đến Telegram API. Đang thử kết nối lại...');
        }
      } else {
        this._pollErrorCount = (this._pollErrorCount || 0) + 1;

        if (this._pollErrorCount === 1) {
          logger.warn(`Telegram Bot poll error: ${err.message}. Sẽ tự động thử kết nối lại...`);
        } else if (this._pollErrorCount % 10 === 0) {
          logger.warn(`Telegram Bot vẫn đang gặp lỗi kết nối (lần thứ ${this._pollErrorCount}): ${err.message}`);
        }

        this._pollRetryDelay = Math.min((this._pollRetryDelay || 5000) * 2, 30000);
      }

      if (this.pollingActive) {
        const delay = isTransientTimeout ? 5000 : (this._pollRetryDelay || 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (this.pollingActive) {
      this.poll();
    }
  }

  // Handle Callback Queries (inline button clicks)
  async handleCallbackQuery(cq) {
    const chatId = String(cq.message ? cq.message.chat.id : cq.from.id);
    const data = cq.data || '';
    const isAllowed = this.allowedChatIds.includes(chatId);

    if (!isAllowed) {
      await this.answerCallbackQuery(cq.id, 'Bạn không có quyền thực hiện thao tác này.', true);
      return;
    }

    await this.answerCallbackQuery(cq.id);

    try {
      if (data === 'cmd_list') {
        await this.showList(chatId);
      } else if (data === 'cmd_status') {
        await this.showStatus(chatId);
      } else if (data === 'cmd_help') {
        await this.showHelp(chatId);
      } else if (data.startsWith('check:')) {
        const username = data.split(':')[1];
        await this.sendMessage(chatId, `🔍 Đang kiểm tra trạng thái live của *@${TelegramBot.escapeMarkdown(username)}*...`);
        const liveRes = await checkLiveStatus(username);
        if (liveRes.isLive) {
          await this.sendMessage(
            chatId,
            `🔴 *@${TelegramBot.escapeMarkdown(username)}* đang *LIVE*!\n\n🏷️ *Tiêu đề:* "${TelegramBot.escapeMarkdown(liveRes.title || 'Không có tiêu đề')}"`,
            'Markdown',
            {
              inline_keyboard: [
                [{ text: '🔴 Xem Live TikTok', url: `https://www.tiktok.com/@${username}/live` }]
              ]
            }
          );
        } else {
          await this.sendMessage(
            chatId,
            `⚪ *@${TelegramBot.escapeMarkdown(username)}* hiện đang *OFFLINE*.\n${liveRes.error ? `⚠️ Chi tiết: ${TelegramBot.escapeMarkdown(liveRes.error)}` : ''}`
          );
        }
      } else if (data.startsWith('ask_del:')) {
        const username = data.split(':')[1];
        await this.sendMessage(
          chatId,
          `⚠️ Bạn có chắc muốn dừng theo dõi và xóa kênh *@${TelegramBot.escapeMarkdown(username)}* không?`,
          'Markdown',
          {
            inline_keyboard: [
              [
                { text: `✅ Xác nhận xóa @${username}`, callback_data: `do_del:${username}` },
                { text: '❌ Hủy', callback_data: 'cancel_del' }
              ]
            ]
          }
        );
      } else if (data.startsWith('do_del:')) {
        const username = data.split(':')[1];
        const delSuccess = this.channelManager.removeChannel(username);
        if (delSuccess) {
          await this.sendMessage(chatId, `🗑️ Đã xóa theo dõi kênh *@${TelegramBot.escapeMarkdown(username)}*!`);
          await this.showList(chatId);
        } else {
          await this.sendMessage(chatId, `❌ Không tìm thấy kênh *@${TelegramBot.escapeMarkdown(username)}* trong danh sách.`);
        }
      } else if (data === 'cancel_del') {
        await this.sendMessage(chatId, 'Đã hủy thao tác xóa.');
      }
    } catch (err) {
      logger.error(`Error handling callback query: ${err.message}`);
    }
  }

  async showList(chatId) {
    const status = this.channelManager.getStatus();
    if (status.channels.length === 0) {
      await this.sendMessage(
        chatId,
        '📋 *Danh sách kênh theo dõi đang trống.*\n\nHãy thêm bằng cách gửi: `/add <username>`',
        'Markdown',
        TelegramBot.getMainKeyboard()
      );
      return;
    }

    let reply = '📋 *DANH SÁCH KÊNH THEO DÕI:*\n\n';
    const inlineButtons = [];

    status.channels.forEach((c, index) => {
      let statusEmoji = '⚪ *[OFFLINE]*';
      if (c.status === 'recording') statusEmoji = '🔴 *[ĐANG GHI ÂM]*';
      else if (c.status === 'paused') statusEmoji = '⏸️ *[TẠM DỪNG]*';

      reply += `${index + 1}. *@${TelegramBot.escapeMarkdown(c.username)}* — ${statusEmoji}\n`;

      // Add quick action buttons for each channel
      inlineButtons.push([
        { text: `🔍 Check @${c.username}`, callback_data: `check:${c.username}` },
        { text: `❌ Xóa @${c.username}`, callback_data: `ask_del:${c.username}` }
      ]);
    });

    inlineButtons.push([
      { text: '🔄 Làm mới', callback_data: 'cmd_list' },
      { text: '📊 Trạng thái', callback_data: 'cmd_status' }
    ]);

    await this.sendMessage(chatId, reply, 'Markdown', { inline_keyboard: inlineButtons });
  }

  async showStatus(chatId) {
    const stats = this.channelManager.getStatus();
    const uptimeSec = Math.floor((new Date() - this.startTime) / 1000);
    const uptimeStr = this.formatSeconds(uptimeSec);
    const usedGB = (stats.storageUsedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const recCount = stats.channels.filter(c => c.status === 'recording').length;

    const reply = 
      `📊 *TRẠNG THÁI SERVER:*\n\n` +
      `🤖 *Bot:* Đang chạy bình thường\n` +
      `⏱️ *Uptime:* ${uptimeStr}\n` +
      `📺 *Tổng số kênh:* ${stats.channels.length}\n` +
      `🎙️ *Đang ghi âm:* ${recCount}\n` +
      `💾 *Dung lượng:* ${usedGB} GB / ${stats.storageLimitGB} GB\n` +
      `⚙️ *Chu kỳ quét:* ${this.channelManager.checkIntervalMs / 1000} giây\n` +
      `📁 *Thư mục lưu:* \`${stats.recordingsDir}\``;

    await this.sendMessage(chatId, reply, 'Markdown', {
      inline_keyboard: [
        [
          { text: '🔄 Làm mới', callback_data: 'cmd_status' },
          { text: '📋 Danh sách kênh', callback_data: 'cmd_list' }
        ]
      ]
    });
  }

  async showHelp(chatId) {
    const helpText = 
      `💡 *HƯỚNG DẪN SỬ DỤNG BOT:*\n\n` +
      `Bạn có thể sử dụng các *nút bấm ở bàn phím bên dưới* hoặc nhập lệnh:\n\n` +
      `• \`/list\` — Xem danh sách các kênh & thao tác nhanh\n` +
      `• \`/status\` — Xem thông số server & dung lượng ổ cứng\n` +
      `• \`/add <tên_kênh>\` — Thêm kênh TikTok theo dõi\n` +
      `• \`/remove <tên_kênh>\` — Xóa kênh khỏi danh sách\n` +
      `• \`/check <tên_kênh>\` — Kiểm tra trực tiếp xem kênh có đang live không\n` +
      `• \`/interval <giây>\` — Thay đổi tần suất quét live (tối thiểu 10s)\n` +
      `• \`/help\` — Hiển thị hướng dẫn này`;

    await this.sendMessage(chatId, helpText, 'Markdown', {
      inline_keyboard: [
        [
          { text: '📋 Danh sách kênh', callback_data: 'cmd_list' },
          { text: '📊 Trạng thái', callback_data: 'cmd_status' }
        ]
      ]
    });
  }

  // Whitelist auth and message router
  async handleMessage(message) {
    const chatId = String(message.chat.id);
    const rawText = message.text ? message.text.trim() : '';
    if (!rawText) return;

    const fromUser = message.from ? `@${message.from.username || ''} (${message.from.first_name || ''})` : 'Unknown';
    logger.info(`Received Telegram message from ${chatId} [${fromUser}]: ${rawText}`);

    const isAllowed = this.allowedChatIds.includes(chatId);

    // Normalize command / button text
    const textLower = rawText.toLowerCase();

    if (textLower === '/start') {
      if (isAllowed) {
        await this.sendMessage(
          chatId,
          `👋 *Xin chào ${TelegramBot.escapeMarkdown(message.from ? message.from.first_name : '')}!*\n\n` +
          `Bạn đã được cấp quyền quản trị ứng dụng ghi âm TikTok Live.\n` +
          `Sử dụng các nút menu bên dưới hoặc gõ lệnh để điều khiển.`,
          'Markdown',
          TelegramBot.getMainKeyboard()
        );
        await this.showHelp(chatId);
      } else {
        await this.sendMessage(
          chatId,
          `👋 *Xin chào!*\n\n` +
          `🆔 *Chat ID của bạn:* \`${chatId}\`\n\n` +
          `⚠️ Bạn chưa được cấp quyền sử dụng bot này.\n` +
          `Vui lòng copy Chat ID trên và dán vào phần cấu hình Telegram trên web Dashboard để được phê duyệt.`
        );
      }
      return;
    }

    // Ignore commands from non-whitelisted users
    if (!isAllowed) {
      logger.warn(`Unauthorized command attempt from Chat ID: ${chatId} (${fromUser})`);
      return;
    }

    try {
      // 1. Check Button text matches
      if (textLower === '📋 danh sách kênh' || textLower === 'danh sách' || textLower === '/list') {
        await this.showList(chatId);
        return;
      }

      if (textLower === '📊 trạng thái' || textLower === 'trạng thái' || textLower === '/status') {
        await this.showStatus(chatId);
        return;
      }

      if (textLower === '❓ hướng dẫn' || textLower === 'trợ giúp' || textLower === '/help') {
        await this.showHelp(chatId);
        return;
      }

      if (textLower === '➕ thêm kênh') {
        await this.sendMessage(
          chatId,
          `👉 Để thêm kênh mới, vui lòng gửi lệnh theo cú pháp:\n\n\`/add <tên_kênh>\`\n\n*Ví dụ:* \`/add thayhuannro111\``
        );
        return;
      }

      if (textLower === '🔍 kiểm tra live' || textLower === '🔍 kiểm tra') {
        await this.sendMessage(
          chatId,
          `👉 Để kiểm tra nhanh 1 kênh, vui lòng gửi lệnh theo cú pháp:\n\n\`/check <tên_kênh>\`\n\n*Ví dụ:* \`/check thayhuannro111\``
        );
        return;
      }

      // 2. Check Slash commands
      const parts = rawText.split(/\s+/);
      const command = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      switch (command) {
        case '/help':
          await this.showHelp(chatId);
          break;

        case '/list':
          await this.showList(chatId);
          break;

        case '/status':
          await this.showStatus(chatId);
          break;

        case '/add':
          if (!arg) {
            await this.sendMessage(chatId, '⚠️ Vui lòng nhập tên kênh.\n*Ví dụ:* `/add thayhuannro111`');
            return;
          }
          const addSuccess = this.channelManager.addChannel(arg);
          if (addSuccess) {
            await this.sendMessage(chatId, `✅ Đã thêm và bắt đầu theo dõi kênh *@${TelegramBot.escapeMarkdown(arg)}*!`);
            await this.showList(chatId);
          } else {
            await this.sendMessage(chatId, `❌ Thêm kênh *@${TelegramBot.escapeMarkdown(arg)}* thất bại (có thể kênh đã có sẵn trong danh sách).`);
          }
          break;

        case '/remove':
          if (!arg) {
            await this.sendMessage(chatId, '⚠️ Vui lòng nhập tên kênh để xóa.\n*Ví dụ:* `/remove thayhuannro111`');
            return;
          }
          const delSuccess = this.channelManager.removeChannel(arg);
          if (delSuccess) {
            await this.sendMessage(chatId, `🗑️ Đã xóa theo dõi kênh *@${TelegramBot.escapeMarkdown(arg)}*!`);
            await this.showList(chatId);
          } else {
            await this.sendMessage(chatId, `❌ Không tìm thấy kênh *@${TelegramBot.escapeMarkdown(arg)}* trong danh sách.`);
          }
          break;

        case '/check':
          if (!arg) {
            await this.sendMessage(chatId, '⚠️ Vui lòng nhập tên kênh để kiểm tra.\n*Ví dụ:* `/check thayhuannro111`');
            return;
          }
          await this.sendMessage(chatId, `🔍 Đang kiểm tra trạng thái live của *@${TelegramBot.escapeMarkdown(arg)}*...`);
          const liveRes = await checkLiveStatus(arg);
          if (liveRes.isLive) {
            await this.sendMessage(
              chatId,
              `🔴 *@${TelegramBot.escapeMarkdown(arg)}* đang *LIVE*!\n\n🏷️ *Tiêu đề:* "${TelegramBot.escapeMarkdown(liveRes.title || 'Không có tiêu đề')}"`,
              'Markdown',
              {
                inline_keyboard: [
                  [{ text: '🔴 Xem Live TikTok', url: `https://www.tiktok.com/@${arg}/live` }]
                ]
              }
            );
          } else {
            await this.sendMessage(chatId, `⚪ *@${TelegramBot.escapeMarkdown(arg)}* hiện đang *OFFLINE*.\n${liveRes.error ? `⚠️ Chi tiết: ${TelegramBot.escapeMarkdown(liveRes.error)}` : ''}`);
          }
          break;

        case '/interval':
          const seconds = parseInt(arg, 10);
          if (isNaN(seconds) || seconds < 10) {
            await this.sendMessage(chatId, '⚠️ Vui lòng nhập số giây hợp lệ (tối thiểu 10 giây).\n*Ví dụ:* `/interval 30`');
            return;
          }
          this.channelManager.checkIntervalMs = seconds * 1000;
          await this.sendMessage(chatId, `⚙️ Đã thay đổi tần suất quét thành *${seconds} giây*!`);
          break;

        default:
          await this.sendMessage(
            chatId,
            '⚠️ Lệnh hoặc tin nhắn không nhận dạng được.\nVui lòng chọn các nút bấm bên dưới hoặc gõ `/help`.',
            'Markdown',
            TelegramBot.getMainKeyboard()
          );
          break;
      }
    } catch (e) {
      logger.error(`Error executing command ${rawText}: ${e.message}`);
      await this.sendMessage(chatId, `❌ Lỗi khi thực hiện lệnh: ${TelegramBot.escapeMarkdown(e.message)}`);
    }
  }

  // Format helper
  formatSeconds(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h > 0) parts.push(`${h} giờ`);
    if (m > 0) parts.push(`${m} phút`);
    parts.push(`${s} giây`);
    return parts.join(' ');
  }
}

module.exports = TelegramBot;
