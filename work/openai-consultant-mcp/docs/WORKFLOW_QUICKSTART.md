# Dual-Agent Workflow Gateway — Quickstart

## 1. Purpose

`dual-agent-workflow-gateway` is a local MCP stdio server that coordinates a structured development lifecycle between a planning/review agent and an execution agent using deterministic Project Memory files stored under `<MCP_WORKSPACE_ROOT>/.ai/`.

---

## 2. Roles

- **ChatGPT Web**: High-level architecture, task planning, and conditional code/design review when complexity or risk warrants it.
- **Antigravity / Gemini**: Direct execution in the workspace (code edits, running `npm test` and `npm run build`, and updating Project Memory through MCP tools).
- **MCP Gateway (`dual-agent-workflow-gateway`)**: Shared Project Memory and workflow state coordination across `.ai/PROJECT_CONTEXT.md`, `.ai/APPROVED_PLAN.md`, `.ai/TASK_STATE.md`, `.ai/DECISIONS.md`, `.ai/HANDOFF.md`, and `.ai/archive/`.

---

## 3. Everyday Use (no tool names to memorize)

### Antigravity bình thường (nhanh, mặc định)

Mở folder và chat trực tiếp như trước khi cài MCP. Plugin chỉ đăng ký workspace một lần ở `SessionStart`; không gọi Project Memory, queue, checkpoint, review hoặc archive và không chạy hook trước mỗi invocation/tool.

### Dual-Agent qua ChatGPT

1. Open the desired folder in Antigravity and start a chat. The plugin registers that workspace automatically.
2. In a new ChatGPT chat, tag **Dual-Agent Workflow Gateway** once and say, for example: `Hãy tiếp tục dự án đang mở` or describe a new goal in Vietnamese.
3. ChatGPT starts/resumes the session, prepares an Intent Contract and plan, then asks for plan approval when needed.
4. After plan approval, ChatGPT calls `dispatch_execution_task`; each request gets an independent task ID and enters the queue even if an older completed task has not been archived.
5. In Antigravity, say `chạy task từ ChatGPT`. Antigravity asks for the separate **Start** HITL, claims the request, then executes. Terminal commands use Antigravity's native permission system.
6. Review is requested only when deterministic risk rules require it. Completion and archive remain separate user approvals.

Starting a new ChatGPT or Antigravity chat is safe: the next session resumes compact state from `.ai/` instead of relying on a long chat transcript.

---

## 4. Capabilities by Phase

- **Phase 1–1.5:** dynamic workspace binding, Project Memory, natural-language session start/resume.
- **Phase 2:** execution queue, claim/lease/revision protection, progress reporting, and mandatory HITL gates.
- **Phase 3:** Context Guardian, fact grounding, deterministic review routing, and privacy-safe token telemetry.
- **Phase 4:** multiple independent tasks/projects, dependency graph, and planned file-conflict detection.
- **Phase 5:** localhost dashboard, metadata-only audit, backup/restore with overwrite confirmation, background startup helper, and estimated token-savings report.
- **Phase 5.1:** opt-in Dual-Agent mode, zero per-invocation polling in normal chats, and independent atomic dispatch for every newly approved task.

---

## 5. Core MCP Tools

| Tool | Mode | Description |
| :--- | :--- | :--- |
| `gateway_health` | Read-only | Returns service health and current ISO timestamp. |
| `project_memory_status` | Read-only | Inspects workspace configuration, `.ai` file existence, active task status (`activeTask`, `activeTaskId`, `activeRevision`), and `archiveCount`. |
| `initialize_project_memory` | Idempotent | Creates `.ai/` and initializes the five template files without overwriting existing files. |
| `save_approved_plan` | Write | Renders and saves a user-approved structured plan into `.ai/APPROVED_PLAN.md` (`approvedByUser: true`). Refuses to overwrite an existing approved plan (`PLAN_ALREADY_EXISTS`). |
| `checkpoint_task` | Write | Updates `.ai/TASK_STATE.md` using optimistic concurrency (`expectedRevision`) when `taskId` matches the approved plan, incrementing `Revision` by `1`. |
| `resume_task` | Read-only | Recovers workflow state. Supports `detailLevel: "compact"` (default, structured summary capped at ~16,000 chars) and `detailLevel: "full"` (raw `.ai` files capped at 20,000 chars/file and 60,000 chars total). |
| `prepare_handoff` | Write | Generates `.ai/HANDOFF.md` snapshot from `APPROVED_PLAN.md` and `TASK_STATE.md` when `expectedRevision` matches the current revision. |
| `archive_completed_task` | Destructive | Archives `APPROVED_PLAN.md`, `TASK_STATE.md`, `HANDOFF.md`, and `COMPLETION_SUMMARY.md` into `.ai/archive/<timestamp>_<taskId>/`, then resets current task files to templates (`userConfirmed: true`). |

---

The complete server exposes 32 tools. Agents should use the natural-language workflow entry points and select lower-level tools automatically; the user does not need to memorize this catalog.

---

## 6. End-to-End Workflow

1. **Start**: ChatGPT calls `start_work_session` once after the plugin is tagged.
2. **Plan & Approve**: ChatGPT drafts a compact Intent Contract and obtains explicit user approval.
3. **Dispatch**: ChatGPT calls `dispatch_execution_task`; it must not return source files as if it had executed the task.
4. **Start HITL**: Antigravity checks the queue, presents the objective and waits for explicit Start approval.
5. **Claim & Execute**: Antigravity activates/claims the independent task, implements it, and reports meaningful milestones only.
6. **Review**: Run external review only when the deterministic risk router requires it.
7. **Complete**: Completion never requires immediate archive. A new task may start while older completed tasks remain unarchived.

---

## 7. Checkpoint and Context Recovery

- **Optimistic Revision Tracking**: `TASK_STATE.md` starts at `Revision: 0`. Each `checkpoint_task` call must pass `expectedRevision` matching the current revision and increments it by `1`.
- **Context Recovery (`resume_task`)**:
  - Always prefer `detailLevel: "compact"` (default) to recover `taskId`, `revision`, `status`, `objective`, `completed`, `nextSteps`, `handoffNextAction`, `doNotRedo`, and `recommendedNextAction` without loading full raw Markdown files.
  - Use `detailLevel: "full"` only when explicitly requested by the user, investigating state inconsistencies, or when `compact` output is insufficient.

---

## 8. Review Policy

- **Skip external review** for small, deterministic, low-risk changes (such as documentation updates, minor config adjustments, or straightforward unit tests).
- **Perform external review** only when changes involve:
  - Architecture or workflow design changes
  - Security, path guards, or permission boundaries
  - Data integrity or atomic file persistence
  - Concurrency or revision-control logic
  - Public APIs or MCP tool schemas
  - Unresolved test/build failures
  - Explicit user requests for review

---

## 9. Dashboard and Background Mode

- Run `npm run dashboard`; it listens on localhost only.
- Optional per-user Startup launchers require the explicit `-ConfirmInstall` switch. Use `install-dashboard-startup.ps1` for the dashboard and `install-tunnel-startup.ps1 -UseClipboard` for a DPAPI-protected tunnel key; neither requires administrator rights.
- Token savings are clearly labelled as exact, estimated, or baseline-estimated; they are not presented as billing facts.
- Dashboard and audit data exclude prompts, source code, secrets, and canonical workspace paths.

---

## 10. Configuration

- **Environment Variable**: Set `MCP_WORKSPACE_ROOT` to the absolute path of the target project workspace. The gateway never guesses or falls back to the current working directory.
- **Direct Node Launch for Stdio**:
  - Build the server first with `npm run build`.
  - Configure the MCP client to launch `node dist/index.js` directly.
  - **Do not** launch via `npm start` or `npm run`, because `npm` writes banner text to `stdout`, which corrupts the MCP JSON-RPC stdio stream.

---

## 11. Safety Rules

- **Never overwrite an approved plan**: Once `.ai/APPROVED_PLAN.md` holds an approved plan, `save_approved_plan` rejects overwrites with `PLAN_ALREADY_EXISTS`.
- **Always use `expectedRevision`**: Never bypass revision checks when calling `checkpoint_task`, `prepare_handoff`, or `archive_completed_task`. On `REVISION_CONFLICT`, call `resume_task` (`detailLevel: "compact"`) to inspect the current state instead of retrying blindly.
- **Archive only after completion and confirmation**: Call `archive_completed_task` only when `TASK_STATE.md` has `status: "completed"` and the user has explicitly confirmed (`userConfirmed: true`).
- **Never store secrets in Project Memory**: Do not write API keys, tokens, credentials, or sensitive personal data into `.ai/` files.

