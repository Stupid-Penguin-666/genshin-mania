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
| `js/chartgen.js` | Kiểm tra beatmap, luật Hold, Beat Grid dự phòng |
| `js/smartchart.js`, `js/chartworker.js` | Tự tạo nốt từ âm thanh (3 mức), chạy trong Web Worker |
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

## Tự tạo nốt khi thêm bài

Khi thêm bài chỉ có file nhạc, hộp thoại Thêm Bài cho chọn mức tạo nốt, số phím (4, 6, 8), độ khó (Dễ, Vừa, Khó) và loại nốt. Để trống BPM và Offset thì game tự dò. Nhập số vào thì dùng số của bạn. Thanh % hiện khi đang phân tích, nút Hủy dừng việc đó.

| Mức | Làm gì | Thời gian thử trên bài 3 phút 25 giây (máy tính) |
| --- | --- | --- |
| 1 | Phân tích phổ âm, tự tìm BPM và vị trí nhịp, đặt nốt lên lưới 16 chỉ ở chỗ nhạc có điểm nhấn, Hold theo âm ngân, lane theo độ cao âm | khoảng 1 giây |
| 2 | Thêm: theo kịp đổi tempo, bắt điểm nhấn ở nhiều độ phân giải, dò giai điệu, nhận ra các ô nhịp lặp lại để dùng cùng một pattern, luật tránh bấm khó chịu | khoảng 2,5 giây |
| 3 | Thêm: thời gian chia nhỏ hơn, sinh nhiều bản chart ứng viên rồi chấm điểm (độ khớp điểm nhấn, độ dễ bấm, độ dày) và giữ bản tốt nhất, tối đa 30 giây tìm kiếm | khoảng 10 giây |

Điện thoại thường chậm hơn máy tính vài lần. Cùng một file nhạc luôn cho cùng một chart.

Nếu file im lặng, quá ngắn (dưới 8 giây), không có điểm nhấn hoặc không có nhịp đều, game báo và dùng Beat Grid thường (BPM bạn nhập, hoặc 120).

Các hằng số chỉnh chất lượng nằm đầu `js/smartchart.js`: `DIFFS` (độ khó: ngưỡng chọn nốt, khoảng cách tối thiểu, trần nốt mỗi giây, mức dùng Hold và nốt đôi), `TIER_THR` (ngưỡng theo vị trí trong nhịp), `LEVELS` (độ phân giải từng mức, `lag` là độ bù thời gian), `TUNE` (độ giống nhau để hai ô nhịp dùng chung pattern), `MIN_CONFIDENCE` (độ chắc chắn tối thiểu của nhịp).

## Cỡ nốt, độ đậm và độ khó chấm điểm

Cài đặt, tab Lối Chơi, phần Nốt:

- Cỡ Nốt (80% đến 150%) và Độ Đậm Nốt (30% đến 100%) chỉ đổi cách hiển thị.
- Độ Khó Chấm Điểm quy định cửa sổ lệch nhịp cho phép. Các mức nằm trong `JUDGE_PRESETS` ở đầu `js/engine.js`:

| Mức | Perfect | Great | Thả Hold giữ hạng | Thả Hold thành Great |
| --- | --- | --- | --- | --- |
| Chuẩn | ±45 ms | ±90 ms | 0,10 s | 0,18 s |
| Dễ | ±70 ms | ±130 ms | 0,15 s | 0,26 s |
| Rất Dễ | ±90 ms | ±160 ms | 0,18 s | 0,32 s |

Nốt bị tính Miss khi trễ quá cửa sổ Great của mức đang chọn. Điểm cao lưu kèm mức chấm điểm và hiển thị nhãn khi không phải Chuẩn.

## Dữ liệu lưu trên máy người chơi

Cài đặt, phím, điểm cao và độ hiệu chuẩn nằm trong `localStorage`. Bài tự tải lên (file nhạc và beatmap) nằm trong IndexedDB, nên vẫn còn sau khi tải lại trang. Không có gì được gửi lên server.

## Tải Beatmap từ cloud

Màn Tải Beatmap đọc danh sách từ Supabase. Chưa điền `js/config.js` thì game vẫn chạy bình thường và màn này báo chưa thiết lập. Làm theo `supabase/README.md` để bật. Mọi người tải được mà không cần tài khoản, chỉ tài khoản quản trị của bạn mới thêm, sửa, xoá được.
