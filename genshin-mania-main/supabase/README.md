# Thiết lập Supabase cho mục Tải Beatmap

Làm một lần. Mất khoảng 15 phút. Tên menu trong giao diện Supabase có thể hơi khác
tuỳ phiên bản, nhưng vị trí các mục vẫn tương tự.

## Bước 1. Tạo dự án

1. Vào https://supabase.com, đăng ký hoặc đăng nhập (có thể dùng tài khoản GitHub).
2. Bấm **New project**. Chọn tổ chức (organization) mặc định.
3. Điền:
   - **Name**: `genshin-mania`
   - **Database Password**: bấm nút tạo mật khẩu ngẫu nhiên và **lưu lại ở trình quản lý mật khẩu**. Game không dùng mật khẩu này, nhưng bạn cần nó nếu sau này muốn truy cập trực tiếp cơ sở dữ liệu.
   - **Region**: chọn vùng gần người chơi nhất, ví dụ Southeast Asia (Singapore).
   - **Plan**: Free.
4. Bấm **Create new project** và chờ khoảng 2 phút đến khi dự án sẵn sàng.

## Bước 2. Lấy địa chỉ và khoá công khai

1. Trong dự án, vào **Project Settings** (biểu tượng bánh răng) rồi **API**. Một số phiên bản đặt ở nút **Connect** phía trên.
2. Sao chép hai giá trị:
   - **Project URL**, dạng `https://abcdefghijkl.supabase.co`
   - **anon public key** (hoặc **publishable key**, dạng `sb_publishable_...`)
3. Mở file `js/config.js` của game và điền hai giá trị vào `supabaseUrl` và `supabaseKey`.

Hai giá trị này **công khai theo thiết kế**, ai cũng thấy được trong mã trang web. Quyền hạn thật sự do các quy tắc ở bước 4 quyết định.

> Tuyệt đối **không** đưa khoá `service_role` hay mật khẩu cơ sở dữ liệu vào `js/config.js` hoặc gửi cho ai. Game không cần chúng.

## Bước 3. Tạo tài khoản quản trị (chỉ một người)

1. Vào **Authentication** rồi **Users**, bấm **Add user** rồi **Create new user**.
2. Nhập email và mật khẩu của bạn. **Bật** tuỳ chọn **Auto Confirm User**.
3. Sau khi tạo, bấm vào dòng người dùng vừa tạo và **sao chép User UID** (một chuỗi dạng `xxxxxxxx-xxxx-...`). Bước 4 cần nó.
4. Chặn người lạ tự đăng ký: vào **Authentication** rồi **Sign In / Providers** (hoặc **Settings**), tắt **Allow new users to sign up**. Giữ nguyên phần Email được bật để bạn đăng nhập.

Sau bước này chỉ mình bạn có tài khoản. Người chơi bình thường không cần và không thể tạo tài khoản.

## Bước 4. Tạo bảng và quy tắc

1. Mở file `supabase/schema.sql` bằng trình soạn thảo văn bản.
2. Tìm đúng một chỗ có chữ `OWNER_USER_ID` và thay bằng User UID đã sao chép (giữ nguyên dấu nháy đơn quanh nó).
3. Trong Supabase vào **SQL Editor**, bấm **New query**, dán toàn bộ nội dung file, bấm **Run**.
4. Kết quả báo `Success`. Nếu báo lỗi `invalid input syntax for type uuid`, nghĩa là chưa thay `OWNER_USER_ID`.

Kiểm tra: **Table Editor** có bảng `beatmaps`, **Storage** có bucket `beatmap-audio` ở trạng thái Public.

Quy tắc đặt ra:

| Ai | Được làm gì |
| --- | --- |
| Mọi người, không đăng nhập | Xem danh sách, tải chart, tải nhạc |
| Chỉ tài khoản của bạn | Thêm, sửa, xoá beatmap và file nhạc |

## Bước 5. Thử

1. Mở game, vào **Tải Beatmap** (Download Beatmaps). Danh sách trống và báo "chưa có beatmap nào được đăng" là đúng.
2. Cuối trang bấm **Quản trị đăng nhập**, nhập email và mật khẩu ở bước 3.
3. Bấm **Thêm Beatmap**. Chọn một bài trong thư viện của bạn (hoặc chọn file nhạc và file beatmap .json), điền tên, nghệ sĩ, độ khó rồi bấm **Đăng**.
4. Đăng xuất, tải lại trang: bài vừa đăng vẫn hiện và bấm **Tải Về** được.

Nên đăng file nhạc dạng mp3 hoặc ogg, dưới khoảng 8 MB. File wav rất nặng so với mp3.

## Giữ dự án không bị tạm dừng

Gói miễn phí tạm dừng dự án nếu một tuần gần như không có hoạt động, khi đó mục Tải Beatmap sẽ báo lỗi cho đến khi bạn vào bảng điều khiển bấm khôi phục. Cách tránh: gọi định kỳ vào dự án, ví dụ ba ngày một lần.

Địa chỉ cần gọi (thay hai giá trị cho đúng với dự án của bạn):

```
GET https://<project-ref>.supabase.co/rest/v1/beatmaps?select=id&limit=1
Header: apikey: <anon public key>
```

Cách làm:

- **Dịch vụ đặt lịch gọi URL** như cron-job.org: tạo một job lặp mỗi 2 đến 3 ngày, dán địa chỉ trên và thêm header `apikey`. Hãy kiểm tra dịch vụ bạn chọn có hỗ trợ header tuỳ chỉnh ở gói miễn phí.
- **GitHub Actions** nếu bạn để mã game trên GitHub: dùng file mẫu `supabase/keepalive.yml`, chép vào `.github/workflows/keepalive.yml`, rồi thêm hai Repository secrets `SUPABASE_URL` và `SUPABASE_KEY`.

Chính sách tạm dừng có thể thay đổi, bạn nên đọc lại trang giá của Supabase khi cần.

## Giới hạn gói miễn phí cần nhớ

- Cơ sở dữ liệu 500 MB, kho file 1 GB, mỗi file tối đa 50 MB.
- Băng thông tải xuống hàng tháng có hạn mức. Nếu hết, lượt tải có thể bị chặn đến kỳ sau.
- Chỉ đăng nhạc bạn có quyền dùng. Mọi người đều tải được file nhạc đã đăng.
