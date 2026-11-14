# Genshin Mania

Game nhịp điệu chạy hoàn toàn trên trình duyệt, không cần server hay bước build.

## Chạy thử

Mở bằng một web server tĩnh bất kỳ, ví dụ:

```bash
python -m http.server 8765
```

rồi vào `http://localhost:8765`. Mở trực tiếp bằng `file://` không chạy được vì game tải catalog bằng `fetch`.

## Cấu trúc

| Thư mục | Nội dung |
| --- | --- |
| `js/engine.js` | Vòng lặp vẽ canvas, chấm điểm, nốt Tap/Hold, hiệu ứng |
| `js/audio.js` | Đồng hồ âm thanh, phát nhạc, hiệu chuẩn độ trễ |
| `js/main.js` | Điều hướng màn hình, thư viện bài, phiên chơi, cài đặt |
| `js/editor.js` | Trình soạn beatmap |
| `js/chartgen.js` | Kiểm tra beatmap, tự tạo nốt theo BPM hoặc theo phân tích âm thanh |
| `js/ui.js` | Toast, hộp thoại |
| `js/i18n.js` | Chữ giao diện tiếng Anh (mặc định) và tiếng Việt |
| `js/cloud.js`, `js/beatmaps.js`, `js/config.js` | Màn Tải Beatmap và kết nối Supabase |
| `supabase/` | SQL tạo bảng, quy tắc truy cập và hướng dẫn thiết lập |
| `beatmaps/` | Bài có sẵn: `catalog.json` và các file beatmap |
| `audio/` | File nhạc của bài có sẵn |
| `skins/` | Skin nốt, xem `skins/README.md` |
| `images/` | Ảnh nền, xem `images/README.md` |

## Thêm bài có sẵn

1. Đặt file nhạc vào `audio/`, beatmap vào `beatmaps/`.
2. Khai báo trong `beatmaps/catalog.json`:

```json
{
  "id": "builtin_ten_bai",
  "title": "Tên Bài",
  "artist": "Nghệ sĩ",
  "bpm": 120,
  "difficulty": "normal",
  "laneCount": 6,
  "audioUrl": "audio/ten-bai.mp3",
  "beatmapUrl": "beatmaps/ten-bai.json"
}
```

`difficulty` dùng mã `easy`, `normal`, `hard` hoặc `expert` để được dịch theo ngôn ngữ; chữ khác sẽ hiển thị nguyên văn.

Trình soạn nhạc có nút Export JSON để xuất beatmap và sinh sẵn đoạn khai báo này.

## Định dạng beatmap

```json
{
  "songTitle": "Tên Bài",
  "bpm": 120,
  "offset": 0,
  "laneCount": 6,
  "notes": [
    { "time": 1.5, "lane": 0, "type": "tap" },
    { "time": 2.0, "lane": 3, "type": "hold", "duration": 0.8 }
  ]
}
```

`time` và `duration` tính bằng giây. `lane` đếm từ 0. Các nốt có cùng `time` được nối ngang với nhau khi bật Nối Nốt Ngang.

Quy tắc khi nạp beatmap:

- Chỉ nhận 4, 6 hoặc 8 phím. `laneCount` khác các giá trị này bị từ chối.
- Sau khi một nốt Hold kết thúc, cùng lane phải để trống ít nhất 0,5 giây. Hold vi phạm được rút ngắn hoặc đổi thành Tap, và game báo số nốt đã điều chỉnh.

## Dữ liệu lưu trên máy người chơi

Cài đặt, phím, điểm cao và độ hiệu chuẩn nằm trong `localStorage`. Bài tự tải lên (file nhạc và beatmap) nằm trong IndexedDB, nên vẫn còn sau khi tải lại trang. Không có gì được gửi lên server.

## Tải Beatmap từ cloud

Màn Tải Beatmap đọc danh sách từ Supabase. Chưa điền `js/config.js` thì game vẫn chạy bình thường và màn này báo chưa thiết lập. Làm theo `supabase/README.md` để bật. Mọi người tải được mà không cần tài khoản, chỉ tài khoản quản trị của bạn mới thêm, sửa, xoá được.
