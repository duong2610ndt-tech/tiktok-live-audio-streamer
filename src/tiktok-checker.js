const { TikTokLiveConnection } = require('tiktok-live-connector');

/**
 * Checks the live status of a TikTok channel and retrieves the stream URL if online.
 * @param {string} username - TikTok username (without @)
 * @returns {Promise<{isLive: boolean, roomId: string|null, streamUrl: string|null, title: string|null, error: string|null}>}
 */
async function checkLiveStatus(username) {
  try {
    const options = {
      processInitialData: false,
      enableWebcastResponseMap: false
    };
    const connection = new TikTokLiveConnection(username, options);
    
    const roomInfo = await connection.fetchRoomInfo();
    
    if (roomInfo && roomInfo.data) {
      // status === 2 means the channel is currently live
      const isLive = roomInfo.data.status === 2 || roomInfo.data.status === '2';
      let streamUrl = null;
      
      if (isLive && roomInfo.data.stream_url) {
        // Prefer RTMP (FLV) pull URL, fallback to HLS (m3u8)
        streamUrl = roomInfo.data.stream_url.rtmp_pull_url || roomInfo.data.stream_url.hls_pull_url;
      }
      
      return {
        isLive,
        roomId: roomInfo.data.id_str || String(roomInfo.data.id) || null,
        streamUrl,
        title: roomInfo.data.title || null,
        error: null
      };
    }
    
    return {
      isLive: false,
      roomId: null,
      streamUrl: null,
      title: null,
      error: 'Invalid response from TikTok API'
    };
  } catch (err) {
    return {
      isLive: false,
      roomId: null,
      streamUrl: null,
      title: null,
      error: err.message || String(err)
    };
  }
}

module.exports = {
  checkLiveStatus
};
