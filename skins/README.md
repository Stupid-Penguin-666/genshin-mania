# Tạo skin nốt

Mỗi skin được đăng ký một dòng trong `skins/catalog.json`. Phần vẽ hình nốt
nằm hoàn toàn trong `note-renderer.js` của skin; không cần sửa `js/engine.js`.

Ví dụ cấu hình:

```json
{
  "id": "my-skin",
  "name": "My Skin",
  "rendererFile": "skins/my-skin/note-renderer.js",
  "noteColor": "#ff9f6b",
  "noteColorActive": "#ffe6d6",
  "noteCenterColor": "#ffe6d6",
  "holdColor": "#ff8a3d",
  "particleColor": "#ffd76b",
  "cssFile": "skins/my-skin/theme.css",
  "default": false
}
```

`note-renderer.js` cần đăng ký renderer với đúng `id` và cung cấp hàm `draw`:

```js
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  registry["my-skin"] = {
    draw(ctx, { radius, color, centerColor, useGlow }) {
      // Vẽ canvas tại tọa độ (0, 0). Engine đã tạo context và xử lý cache.
    },
  };
})();
```

`theme.css` là tùy chọn và chỉ dùng khi muốn đổi màu accent giao diện. Không
thêm file này nếu skin chỉ thay đổi nốt.
