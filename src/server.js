const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Helper to parse JSON body from incoming requests
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Serves a static file from the public directory
 */
function serveStaticFile(res, relativePath, contentType) {
  const filePath = path.resolve(__dirname, '../public', relativePath);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

function startServer(channelManager, telegramBot) {
  const sseClients = new Set();
  
  // Broadcast SSE event to all connected clients
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        sseClients.delete(client);
      }
    }
  };

  // Listen to channel manager updates
  channelManager.on('update', () => {
    broadcast('status_update', channelManager.getStatus());
  });

  // Listen to logger for console log broadcasts
  logger.on('log', (logData) => {
    broadcast('log', logData);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method;

    // --- Serve Web Front-End (Static Files) ---
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/style.css') {
      return serveStaticFile(res, 'style.css', 'text/css');
    }
    if (method === 'GET' && url.pathname === '/app.js') {
      return serveStaticFile(res, 'app.js', 'text/javascript');
    }

    // --- SSE Event Stream Endpoint ---
    if (method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('\n'); // keep connection alive
      
      sseClients.add(res);
      
      req.on('close', () => {
        sseClients.delete(res);
      });
      
      // Send initial status immediately on connection
      res.write(`event: status_update\ndata: ${JSON.stringify(channelManager.getStatus())}\n\n`);
      return;
    }

    // --- REST API Endpoints ---
    
    // GET /api/status - Get current system status
    if (method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(channelManager.getStatus()));
    }

    // POST /api/channels - Add a channel to monitor
    if (method === 'POST' && url.pathname === '/api/channels') {
      try {
        const body = await parseJsonBody(req);
        const username = body.username;
        if (!username) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Username is required' }));
        }
        
        const success = channelManager.addChannel(username);
        res.writeHead(success ? 200 : 409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success, username }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // DELETE /api/channels/:username - Remove a channel
    if (method === 'DELETE' && url.pathname.startsWith('/api/channels/')) {
      const parts = url.pathname.split('/');
      const username = decodeURIComponent(parts[parts.length - 1]);
      if (!username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Username is required' }));
      }

      const success = channelManager.removeChannel(username);
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success }));
    }

    // POST /api/settings - Update recordings directory and storage limit
    if (method === 'POST' && url.pathname === '/api/settings') {
      try {
        const body = await parseJsonBody(req);
        const { recordingsDir, storageLimitGB } = body;
        
        channelManager.updateSettings(recordingsDir, storageLimitGB);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/channels/:username/stop - Stop recording for a channel
    if (method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/stop$/)) {
      const parts = url.pathname.split('/');
      const username = decodeURIComponent(parts[3]);
      const success = channelManager.stopRecording(username);
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success }));
    }

    // POST /api/channels/:username/resume - Resume recording for a channel
    if (method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/resume$/)) {
      const parts = url.pathname.split('/');
      const username = decodeURIComponent(parts[3]);
      const success = channelManager.resumeRecording(username);
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success }));
    }

    // POST /api/history/reload - Scan and reload recordings history from disk
    if (method === 'POST' && url.pathname === '/api/history/reload') {
      try {
        channelManager.scanRecordingsDir();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, recordingsHistory: channelManager.getStatus().recordingsHistory }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/telegram/settings - Save Telegram configuration
    if (method === 'POST' && url.pathname === '/api/telegram/settings') {
      try {
        const body = await parseJsonBody(req);
        const { botToken, allowedChatIds, enabled } = body;
        
        channelManager.telegramConfig = {
          botToken: botToken || '',
          allowedChatIds: Array.isArray(allowedChatIds) ? allowedChatIds : [],
          enabled: !!enabled
        };
        
        channelManager.saveData();
        telegramBot.updateConfig(channelManager.telegramConfig);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/telegram/test - Send a test message to whitelisted chat IDs
    if (method === 'POST' && url.pathname === '/api/telegram/test') {
      try {
        if (!telegramBot.botToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Chưa cấu hình Bot Token!' }));
        }
        if (telegramBot.allowedChatIds.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Danh sách Chat ID được phép đang trống!' }));
        }
        
        await telegramBot.broadcast("🔔 *Tin nhắn thử nghiệm:* Kết nối giữa TikTok Recorder và Telegram Bot hoạt động hoàn hảo!");
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/telegram/status - Get Telegram Bot connection status
    if (method === 'GET' && url.pathname === '/api/telegram/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: telegramBot.enabled,
        pollingActive: telegramBot.pollingActive,
        allowedChatIds: telegramBot.allowedChatIds
      }));
    }

    // POST /api/shutdown - Gracefully stop the application
    if (method === 'POST' && url.pathname === '/api/shutdown') {
      logger.info('🔌 Nhận yêu cầu tắt server từ Dashboard...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      
      // Delay shutdown slightly so HTTP response completes
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM');
      }, 500);
      return;
    }

    // Route not found
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  // Attempt to listen on port 3456, increment on port collision (EADDRINUSE)
  let currentPort = 3456;
  const startListen = (port) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info(`Dashboard running at: http://localhost:${port}`);
    });
  };

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${currentPort} in use, trying next port...`);
      currentPort++;
      startListen(currentPort);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
  });

  startListen(currentPort);
  return server;
}

module.exports = {
  startServer
};
