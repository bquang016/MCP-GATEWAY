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
- Nếu có `pending_user_start`, trình bày objective và xin HITL Start. Chỉ gọi `approve_execution_start` sau xác nhận rõ ràng, rồi `claim_execution_request` đúng một lần.
- Chỉ sau khi claim thành công mới sửa code. Báo milestone bằng `report_execution_progress`; dùng `checkpoint_task` khi có thay đổi trạng thái có ý nghĩa, không gọi sau từng thao tác nhỏ.
- Review ngoài chỉ khi `route_external_review` yêu cầu. `completed` không đồng nghĩa archive; task completed cũ không được chặn task mới.
- `archive_completed_task`, restore, thao tác destructive và mọi quyền terminal/sandbox vẫn cần HITL tương ứng.

## Context và an toàn

- Khi Dual-Agent context suy giảm hoặc chuyển chat, dùng `prepare_context_handoff`; chat mới resume compact thay vì đọc toàn bộ file.
- Không ghi prompt, source code, canonical path hoặc secret vào telemetry/audit.
- Không trộn yêu cầu Normal mode vào task Dual-Agent đang claim. Nếu người dùng đổi mục tiêu, hỏi muốn tách task hay quay lại Normal mode.

## Ngoại lệ riêng tư cho Project Memory

- Agent và MCP được toàn quyền đọc, tạo, cập nhật và sử dụng Project Memory cho việc điều phối, tiếp nối context và handoff.
- Đây là vùng điều khiển riêng tư. Trong phản hồi cho người dùng, chỉ gọi chung là **Project Memory** hoặc **bộ nhớ nội bộ**; không nêu tên thư mục, đường dẫn, tên file hay trích nội dung của vùng này.
- Tuyệt đối không stage, commit, push, đưa vào diff/patch, đính kèm, upload, đồng bộ hoặc gửi dữ liệu của vùng này tới Git hay bất kỳ dịch vụ bên ngoài nào, kể cả khi dùng tùy chọn force.
- Trước thao tác Git, dùng đường dẫn source rõ ràng thay vì `git add -A`/`git add .`, và xác minh nội bộ rằng Project Memory không nằm trong staged changes. Không hiển thị các đường dẫn riêng tư trong báo cáo kiểm tra.
- Quy tắc loại trừ Git cục bộ do gateway cài đặt chỉ là lớp bảo vệ bổ sung; không được xem đó là quyền bỏ qua các giới hạn trên.
