# Dual-Agent Workflow Gateway

MCP Gateway này giúp **ChatGPT/Codex lập kế hoạch** và **Antigravity thực thi code** trên cùng một trạng thái công việc. Mục tiêu là giảm việc copy-paste prompt, hạn chế quên context khi chat dài và vẫn giữ các bước phê duyệt quan trọng cho người dùng.

## Dùng hằng ngày — chỉ cần nhớ 3 bước

- Bước 1: Mở folder dự án trong Antigravity.
- Bước 2: Mở ChatGPT hoặc Codex, bật/tag **Dual-Agent Workflow Gateway** một lần rồi mô tả việc cần làm bằng tiếng Việt.
- Bước 3: Nhắn 1 câu gì đó cho Antigravity, ví dụ: "Kiểm tra workspace hiện tại" hoặc gửi lại *task_id để Antigravity tự động đăng ký workspace thông qua MCP.
- Bước 4: Khi Antigravity nhận task, kiểm tra phạm vi và bấm/nhắn xác nhận trước khi bắt đầu (nhớ chuyển sang model mạnh cho tác vụ nặng hoặc hoàn thiện 1 tính năng cụ thể để tránh sai sót, phải sửa lại code nhiều)

Bạn không cần nhớ tên từng MCP tool. Agent tự chọn tool phù hợp dựa trên trạng thái workflow.

## Hệ thống làm gì?

```text
ChatGPT / Codex                 MCP Gateway                  Antigravity
Lập kế hoạch, phản biện   <->   Đồng bộ task/context   <->  Sửa code, chạy test
         |                         |                            |
         +---- Bạn duyệt plan -----+---- Bạn duyệt Start ------+
```

- Giữ context ngắn gọn giữa nhiều cửa sổ chat và nhiều phiên làm việc.
- Chuyển task đã duyệt sang Antigravity thay vì để ChatGPT tự trả code như thể đã thực thi.
- Quản lý hàng đợi, claim độc quyền, revision và handoff.
- Chỉ yêu cầu review ngoài khi thay đổi có rủi ro; thay đổi nhỏ có thể bỏ qua review.
- Có dashboard localhost và thống kê token tiết kiệm (được ghi rõ là số chính xác hay ước tính).
- Graphify là tùy chọn: khi có, gateway ưu tiên context theo symbol/dependency; khi không có, hệ thống tự fallback.

## Hai chế độ làm việc

### Normal mode

Chat trực tiếp với Antigravity như bình thường. Gateway chỉ duy trì đăng ký workspace nhẹ, không chạy toàn bộ workflow ở mỗi prompt.

### Dual-Agent mode

Dùng khi muốn ChatGPT/Codex lập kế hoạch rồi giao Antigravity thực thi. Chế độ này có kiểm soát phạm vi, hàng đợi, checkpoint, review routing và handoff.

## Các bước HITL bắt buộc

HITL (Human in the Loop) nghĩa là hệ thống phải dừng để bạn xác nhận:

1. **Duyệt kế hoạch** trước khi dispatch task.
2. **Duyệt Start** trước khi Antigravity claim và thực thi.
3. **Duyệt lệnh nhạy cảm** bằng sandbox/permission gốc của Antigravity hoặc Codex.
4. **Duyệt ghi đè/khôi phục** trước thao tác restore.
5. **Duyệt archive** sau khi task đã hoàn thành.

Gateway không tự cấp quyền chạy lệnh nguy hiểm và không thay thế sandbox của IDE.

## Cài đặt nhanh

### Yêu cầu

- Node.js 20.6 trở lên
- npm
- Antigravity nếu dùng execution bridge
- Codex CLI/Desktop nếu muốn dùng MCP trực tiếp trong Codex
- Tunnel client và runtime key riêng nếu kết nối ChatGPT Web từ máy local

### 1. Cài và build

```powershell
git clone https://github.com/bquang016/MCP-GATEWAY.git
cd MCP-GATEWAY\work\openai-consultant-mcp
npm ci
npm run build
npm test
```

### 2. Kết nối Antigravity

```powershell
node .\integrations\antigravity\dual-agent-bridge\scripts\install-plugin.js
```

Sau đó reload Antigravity. Plugin tự nhận folder đang mở; không cần cấu hình lại từng project.

### 3. Kết nối Codex trực tiếp qua stdio

```powershell
npm run install:codex
```

Lệnh này đăng ký gateway vào cấu hình MCP dùng chung của Codex. Mở chat Codex mới hoặc refresh MCP tools sau khi cài.

Nếu muốn khóa gateway vào một workspace cụ thể:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex-mcp.ps1 `
  -ConfirmInstall `
  -WorkspaceRoot "C:\duong-dan\toi\project"
```

Khi không truyền `-WorkspaceRoot`, Codex dùng workspace đang hoạt động do bridge đăng ký. Đây là lựa chọn phù hợp cho cách làm “mở folder rồi chat”.

### 4. Kết nối ChatGPT Web

ChatGPT Web không thể gọi trực tiếp tiến trình stdio trên máy. Bạn cần:

1. Tạo tunnel và runtime key trong tài khoản OpenAI của chính bạn.
2. Cấu hình tunnel client để chạy `node <duong-dan-tuyet-doi>/dist/index.js`.
3. Chạy tunnel client.
4. Tạo/refresh custom MCP app trong ChatGPT.

Không commit runtime key, tunnel profile hoặc thông tin đăng nhập vào Git.

## Prompt mẫu

Trong ChatGPT/Codex:

```text
Hãy tiếp tục dự án đang mở. Tôi muốn thêm chức năng đăng nhập bằng email.
Hãy phân tích, đưa kế hoạch ngắn để tôi duyệt, rồi giao Antigravity thực thi.
```

Trong Antigravity:

```text
Chạy task mới từ ChatGPT. Trước khi bắt đầu, hãy tóm tắt phạm vi và xin tôi xác nhận Start.
```

## Nhóm công cụ chính

| Nhóm | Công dụng |
| --- | --- |
| Session & workspace | Kết nối đúng project, bắt đầu hoặc tiếp tục phiên làm việc |
| Planning & dispatch | Lưu kế hoạch đã duyệt và tạo execution request độc lập |
| Queue & execution | Xem hàng đợi, duyệt Start, claim task, báo tiến độ |
| Context & handoff | Phục hồi context compact, checkpoint và chuẩn bị bàn giao |
| Review & safety | Đánh giá sức khỏe context, quyết định khi nào cần review |
| Graph context | Tạo/đọc Context Capsule theo symbol và dependency |
| Operations | Health check, audit metadata, backup/restore có HITL |
| Telemetry | Báo token đã dùng/tiết kiệm và mức độ ước tính |

Danh mục đầy đủ được công bố qua MCP `tools/list`; agent tự chọn công cụ, người dùng không cần gọi bằng tay.

## Dashboard localhost

```powershell
npm run dashboard
```

Dashboard chỉ bind vào `127.0.0.1`. Có thể cài chế độ khởi động cùng Windows sau khi xem và xác nhận script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-dashboard-startup.ps1 -ConfirmInstall
```

## Bảo mật và riêng tư

- Project Memory là vùng nội bộ, được `.gitignore` loại trừ và không được commit/push/upload.
- Không lưu API key, token, credential, prompt đầy đủ hoặc source code trong telemetry/audit.
- Không chạy MCP stdio qua `npm start`; hãy chạy trực tiếp `node dist/index.js` để stdout chỉ chứa JSON-RPC.
- Không chia sẻ runtime key. Mỗi người cài đặt phải tạo key riêng.
- Các thao tác ghi đè, restore, archive và execution Start đều có cổng xác nhận.

## Lệnh dành cho phát triển

```powershell
npm run dev        # chạy MCP server bằng tsx
npm run build      # biên dịch TypeScript
npm test           # chạy test
npm run check      # build + test
npm run dashboard  # mở dashboard localhost
```

Tài liệu kỹ thuật chi tiết nằm trong [`work/openai-consultant-mcp/docs`](work/openai-consultant-mcp/docs). Hướng dẫn bridge Antigravity nằm trong [`integrations/antigravity/dual-agent-bridge`](work/openai-consultant-mcp/integrations/antigravity/dual-agent-bridge).

## Phiên bản

Phiên bản hiện tại: **5.3.0** — bổ sung hướng dẫn chia sẻ, bộ cài Codex và đồng bộ metadata package.
