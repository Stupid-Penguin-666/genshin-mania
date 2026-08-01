# Ảnh nền (Background)

Bỏ file ảnh (`.jpg` / `.webp` / `.png`) vào thư mục này, rồi khai báo trong
`images/catalog.json`. Trang web không tự "quét" thư mục — mọi ảnh muốn
hiển thị cho người chơi chọn đều phải có 1 dòng khai báo ở đây, giống
cách `beatmaps/catalog.json` khai báo danh sách bài hát.

## Định dạng `catalog.json`

```json
[
  { "id": "bg1", "name": "Hoàng Hôn", "file": "bg-1.jpg", "default": true },
  { "id": "bg2", "name": "Đêm Sao",   "file": "bg-2.jpg", "default": false }
]
```

- `id`: định danh duy nhất, tuỳ đặt.
- `name`: tên hiển thị trong ô chọn ở màn Cài Đặt.
- `file`: tên file ảnh đúng trong thư mục `images/` này.
- `default`: `true` trên đúng 1 ảnh sẽ là ảnh mặc định khi người chơi
  chưa từng tự chọn ảnh nào. Nếu không có ảnh nào đánh dấu `default`,
  hoặc `catalog.json` rỗng (`[]`), web tự dùng lại nền gradient trơn.

## Lưu ý

- Mỗi người chơi chỉ tải đúng 1 ảnh họ đang chọn — không tải hết cả kho
  cùng lúc — nên có up bao nhiêu ảnh cũng không tốn thêm băng thông cho
  người không chọn xem ảnh đó.
- Nên dùng ảnh đã nén (webp hoặc jpg chất lượng vừa phải), tránh PNG
  dung lượng lớn không cần thiết.
- Overlay tối phủ lên ảnh là trung tính (không nhuộm màu cố định), nên
  hợp với bất kỳ tông màu ảnh nào — không cần chỉnh gì thêm riêng cho
  từng ảnh.
