# Tạo skin nốt

Mỗi skin được khai báo một mục trong `skins/catalog.json`. Phần vẽ nốt nằm hoàn
toàn trong `note-renderer.js` của skin, không cần sửa `js/engine.js`.

```json
{
  "id": "my-skin",
  "name": "My Skin",
  "rendererFile": "skins/my-skin/note-renderer.js",
  "noteColor": "#ffb04a",
  "noteColorActive": "#fff0c4",
  "noteCenterColor": "#fff1a8",
  "holdColor": "#ff7468",
  "particleColor": "#ffd76b",
  "cssFile": "skins/my-skin/theme.css",
  "default": false
}
```

- `noteColor`: màu nốt Tap.
- `holdColor`: màu đầu và đuôi nốt Hold, cũng là màu thanh Hold.
- `noteColorActive`: màu sáng hơn khi nốt Hold đang được giữ.
- `noteCenterColor`: màu điểm sáng ở giữa nốt.
- `particleColor`: màu hạt, vòng sóng và cột sáng khi bấm.
- `cssFile`: tuỳ chọn, đổi màu giao diện và nền màn chơi (xem bên dưới).

## note-renderer.js

Đăng ký renderer với đúng `id` và cung cấp hàm `draw`. Engine tạo sẵn context,
đã dịch gốc toạ độ về giữa nốt, và tự cache kết quả thành sprite.

```js
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  registry["my-skin"] = {
    draw(ctx, { radius, color, centerColor, useGlow, variant, active }) {
      // Vẽ quanh (0, 0). `radius` là bán kính thiết kế (26), engine tự thu nhỏ
      // khi màn hình hẹp. `variant` là "tap" hoặc "hold". `color` đã là màu
      // đúng cho variant đó. `useGlow` là false khi bật "Ít Giật Lag".
    },
  };
})();
```

Giữ mọi nét vẽ trong khoảng `radius * 1.1` quanh tâm để không bị cắt.

## theme.css

Tuỳ chọn. Chỉ khai báo các biến màu, giao diện tự đổi theo:

```css
:root {
  --accent: #ff9bb0;      /* màu nhấn chính */
  --accent-hi: #ffd1dc;   /* màu nhấn sáng: chữ, viền được chọn */
  --accent-lo: #c64a73;   /* màu nhấn tối: bóng nút */
  --accent-ink: #40111f;  /* màu chữ trên nút nhấn */
  --stage-top: #222a55;   /* nền màn chơi, từ trên xuống dưới */
  --stage-mid: #4a2f66;
  --stage-bottom: #e5667a;
}
```

Nền màn chơi chỉ hiện khi không chọn ảnh nền trong Cài Đặt.
