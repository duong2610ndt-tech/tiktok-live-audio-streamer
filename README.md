# TikTok Live Audio Recorder 🎙️

> **Công cụ tự động hóa theo dõi trạng thái phát trực tiếp (Livestream) của các kênh TikTok và ghi âm luồng âm thanh theo thời gian thực (Real-time Stream Processing).**

---

## 🌟 Tính Năng Nổi Bật

- ⚡ **Giám sát thời gian thực (Real-time Monitoring):** Kết nối trực tiếp với giao thức mạng và sự kiện của TikTok thông qua `tiktok-live-connector` để phát hiện phòng live ngay khi streamer bắt đầu phát sóng.
- 🎧 **Tự động bắt luồng & Ghi âm (Stream Recording):** Điều khiển tiến trình FFmpeg để thu nhận luồng âm thanh nền với chất lượng cao (M4A/AAC), tiêu hao cực ít tài nguyên CPU/RAM.
- 📲 **Cảnh báo qua Telegram Bot:** Tự động gửi tin nhắn thông báo (Push Notifications) khi kênh bắt đầu live và khi phiên ghi âm hoàn tất.
- 📊 **Web Dashboard Quản Trị:** Giao diện điều khiển trực quan chạy trên cổng cục bộ (Local Server) giúp thêm/xóa kênh theo dõi, kiểm tra danh sách file ghi âm và dung lượng lưu trữ.
- 📦 **Đóng gói Portable:** Hỗ trợ bundle qua `esbuild` và compile ra file chạy độc lập `.exe` bằng `@yao-pkg/pkg` cho môi trường Windows VPS.

---

## 🛠️ Tech Stack

- **Ngôn ngữ:** JavaScript / Node.js (CommonJS, Node 20+)
- **Thư viện kết nối live:** `tiktok-live-connector`
- **Xử lý đa phương tiện:** FFmpeg (Subprocess execution)
- **Thông báo & Tương tác:** Telegram Bot API
- **Web UI & Server:** Express / Vanilla HTML, CSS, JavaScript
- **Build Tool:** `esbuild`, `@yao-pkg/pkg`

---

## 📁 Cấu Trúc Dự Án

```
├── public/                 # Giao diện Web Dashboard (HTML/CSS/JS)
├── src/
│   ├── channel-manager.js  # Quản lý danh sách kênh và tệp ghi âm
│   ├── logger.js           # Ghi log chuẩn định dạng
│   ├── recorder.js         # Tiến trình điều khiển FFmpeg ghi âm luồng
│   ├── server.js           # Web Server phục vụ Dashboard
│   ├── telegram-bot.js     # Tích hợp Bot Telegram gửi thông báo
│   ├── tiktok-checker.js   # Kiểm tra trạng thái phát sóng
│   └── utils.js            # Các hàm tiện ích
├── data.example.json       # Mẫu cấu hình cấu trúc lưu trữ và bot token
├── index.js                # Điểm vào chính của ứng dụng
└── package.json            # Khai báo dependency và build scripts
```

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy

### 1. Yêu cầu hệ thống
- Node.js >= 20.x
- [FFmpeg](https://ffmpeg.org/download.html) đã được cài đặt và thêm vào biến môi trường `PATH`.

### 2. Cài đặt thư viện
```bash
git clone https://github.com/<your-username>/tiktok-live-audio-recorder.git
cd tiktok-live-audio-recorder
npm install
```

### 3. Cấu hình
Sao chép tệp cấu hình mẫu và cập nhật thông tin:
```bash
cp data.example.json data.json
```
Cấu hình token bot Telegram và kênh TikTok muốn theo dõi trong `data.json`.

### 4. Khởi chạy
```bash
npm start
```
Mở trình duyệt tại `http://localhost:3000` để truy cập Web Dashboard.

---

## ⚖️ Giấy phép
Dự án được phát triển cho mục đích học tập và nghiên cứu công nghệ xử lý luồng dữ liệu thời gian thực.
