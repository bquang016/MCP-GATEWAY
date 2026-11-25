# Dual-Agent Bridge — Opt-in Policy

## Normal mode (default)

- Mọi chat Antigravity bắt đầu ở **Normal mode**. Làm việc như Agent Antigravity thông thường.
- Không gọi `start_work_session`, Project Memory, task registry, queue, checkpoint, handoff, review router, telemetry, backup hoặc archive chỉ vì plugin đang được cài.
- Yêu cầu trực tiếp như “sửa file”, “chạy test”, “làm tính năng này” là công việc Normal mode và không được ghi vào `.ai/`.
- Giữ nguyên cơ chế quyền terminal/sandbox native của Antigravity. Plugin không thay thế hoặc tự động chấp thuận quyền native.

## Khi nào bật Dual-Agent mode

Chỉ bật khi có ít nhất một điều kiện:

1. System message từ `dual-agent-bridge` nói rõ có execution request thực sự; hoặc
2. Người dùng nói rõ “chạy task từ ChatGPT”, “kiểm tra task Dual-Agent”, “bật Dual-Agent Workflow” hoặc ý nghĩa tương đương.

Không bật chỉ vì workspace có `.ai/`, có task completed cũ, hoặc người dùng nói “tiếp tục” trong một cuộc chat Normal mode.

## Dual-Agent mode

- Gọi `start_work_session` đúng một lần, sau đó kiểm tra `execution_queue_status`.
- Nếu không có request actionable, báo ngắn gọn “ChatGPT chưa dispatch task”; không đọc toàn bộ Project Memory, không sửa code và quay lại Normal mode.
- Nếu có `pending_user_start`, đọc `intentContract` do `execution_queue_status` trả về, trình bày objective/scope/nghiệm thu ở mức ngắn gọn và chỉ hỏi người dùng xác nhận Start. Không hỏi người dùng revision, không yêu cầu copy-paste đặc tả và không yêu cầu quay lại ChatGPT lấy nội dung.
- Task legacy đã `completed` nhưng chưa archive không được chặn request mới và không được biến thành điều kiện trước Start. Chỉ archive khi người dùng chủ động yêu cầu hoặc xác nhận archive riêng; tiếp tục xử lý request mới trước.
- Chỉ gọi `approve_execution_start` sau xác nhận Start rõ ràng, tự dùng request revision hiện có, rồi `claim_execution_request` đúng một lần. Claim phải dùng `intentContract` được hydrate tự động làm đặc tả thực thi.
- Chỉ sau khi claim thành công mới sửa code. Báo milestone bằng `report_execution_progress`; dùng `checkpoint_task` khi có thay đổi trạng thái có ý nghĩa, không gọi sau từng thao tác nhỏ.
- Review ngoài chỉ khi `route_external_review` yêu cầu. `completed` không đồng nghĩa archive; task completed cũ không được chặn task mới.
- `archive_completed_task`, restore, thao tác destructive và mọi quyền terminal/sandbox vẫn cần HITL tương ứng.

## Context và an toàn

- Trong Dual-Agent mode, dùng **graph-first** trước khi quét repository: đọc Context Capsule được gắn vào execution request để xác định symbol đích, dependency, test liên quan và danh sách file ưu tiên.
- Context Capsule là bản đồ định hướng, không phải bằng chứng thay thế source. Chỉ đọc các file được xếp hạng trước, rồi đọc source/test cần thiết để xác minh hành vi thực tế trước khi sửa.
- Không quét rộng bằng glob/search hoặc đọc hàng loạt file khi chưa dùng capsule. Nếu cần vượt `maxInitialFiles`, vẫn được phép nhưng phải báo `actualFilesRead` và `fileBudgetExceededReason` qua `report_execution_progress`.
- Khi Graphify không khả dụng, timeout hoặc cache lỗi, tiếp tục an toàn ở degraded/legacy mode; không treo phiên và không tự suy đoán cấu trúc code.
- Khi Dual-Agent context suy giảm hoặc chuyển chat, dùng `prepare_context_handoff`; chat mới resume compact thay vì đọc toàn bộ file.
- Không ghi prompt, source code, canonical path hoặc secret vào telemetry/audit.
- Không trộn yêu cầu Normal mode vào task Dual-Agent đang claim. Nếu người dùng đổi mục tiêu, hỏi muốn tách task hay quay lại Normal mode.

## Ngoại lệ riêng tư cho Project Memory

- Agent và MCP được toàn quyền đọc, tạo, cập nhật và sử dụng Project Memory cho việc điều phối, tiếp nối context và handoff.
- Đây là vùng điều khiển riêng tư. Trong phản hồi cho người dùng, chỉ gọi chung là **Project Memory** hoặc **bộ nhớ nội bộ**; không nêu tên thư mục, đường dẫn, tên file hay trích nội dung của vùng này.
- Tuyệt đối không stage, commit, push, đưa vào diff/patch, đính kèm, upload, đồng bộ hoặc gửi dữ liệu của vùng này tới Git hay bất kỳ dịch vụ bên ngoài nào, kể cả khi dùng tùy chọn force.
- Trước thao tác Git, dùng đường dẫn source rõ ràng thay vì `git add -A`/`git add .`, và xác minh nội bộ rằng Project Memory không nằm trong staged changes. Không hiển thị các đường dẫn riêng tư trong báo cáo kiểm tra.
- Quy tắc loại trừ Git cục bộ do gateway cài đặt chỉ là lớp bảo vệ bổ sung; không được xem đó là quyền bỏ qua các giới hạn trên.
