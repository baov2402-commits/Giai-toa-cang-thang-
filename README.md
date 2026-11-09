# 🌿 Vườn Bình Yên — game giải tỏa căng thẳng, ôn KHTN 7 Vật lí (bài 8–20)

Game kiểu Blooket, giao diện "hacker xanh": học sinh trả lời câu hỏi Vật lí, mở hộp quà, trồng khu vườn của mình, nghỉ hít thở giữa chừng và chọn biểu cảm tâm trạng trước/sau khi chơi. Trả lời sai không bị trừ điểm.

| Trang | Đường dẫn | Dành cho |
|---|---|---|
| Người chơi | `/` | Học sinh: nhập mã phòng hoặc chơi một mình |
| Tạo tài khoản | `/dang-ki` | Giáo viên tạo tài khoản (cần mã giáo viên = `ADMIN_PASSWORD`) |
| Quản lí | `/admin` | Giáo viên đăng nhập, tạo phòng, xem lịch sử các ván, chọn bài và thời gian, bắt đầu/kết thúc ván, xem xếp hạng và tâm trạng của lớp, mời người chơi ra khỏi phòng |

Không cần cài thư viện nào, chỉ cần Node.js 18 trở lên.

## Cài trên Render
1. Tải các file này lên GitHub (cùng một chỗ, không cần thư mục con).
2. Render → New → Postgres → Plan Free → Create. Copy **Internal Database URL**.
3. Web Service → Environment: thêm `DATABASE_URL` (dán URL vừa copy) và `ADMIN_PASSWORD` (mã giáo viên).
4. Build: `npm install` · Start: `node server.js`.

Lưu ý: Postgres miễn phí của Render hết hạn sau 30 ngày; trước hạn hãy nâng cấp hoặc tạo database mới.
