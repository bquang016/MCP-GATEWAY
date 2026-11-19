import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

import {
  MEMORY_FILES,
  ARCHIVE_FILES,
  getWorkspaceConfig,
  resolveMemoryFilePath,
  resolveArchiveRootPath,
  resolveArchiveEntryDirPath,
} from "../src/config.js";
import {
  getProjectMemoryStatus,
  initializeProjectMemory,
  saveApprovedPlan,
  checkpointTask,
  resumeTask,
  prepareHandoff,
  archiveCompletedTask,
  ResumeTaskCompactOutput,
  ResumeTaskFullOutput,
} from "../src/memory/project-memory.js";
import { writeMemoryFileAtomic } from "../src/memory/safe-write.js";

function listTempFiles(memoryDir: string): string[] {
  if (!fs.existsSync(memoryDir)) {
    return [];
  }
  return fs
    .readdirSync(memoryDir)
    .filter((name) => name.startsWith(".tmp-") || name.endsWith(".tmp"));
}

test("Kiểm tra khi chưa cấu hình MCP_WORKSPACE_ROOT", async (t) => {
  const originalEnv = process.env.MCP_WORKSPACE_ROOT;
  delete process.env.MCP_WORKSPACE_ROOT;

  try {
    await t.test("config trả về configured: false", () => {
      const config = getWorkspaceConfig();
      assert.equal(config.configured, false);
      assert.ok(config.errorMessage);
    });

    await t.test("project_memory_status báo configured: false, đủ 5 files và trạng thái activeTask/archiveCount", () => {
      const status = getProjectMemoryStatus();
      assert.deepEqual(status, {
        configured: false,
        workspaceExists: false,
        memoryDirectoryExists: false,
        files: {
          projectContext: false,
          approvedPlan: false,
          taskState: false,
          decisions: false,
          handoff: false,
        },
        activeTask: false,
        activeTaskId: null,
        activeRevision: 0,
        archiveCount: 0,
        workspaceId: null,
        displayName: null,
        rootFingerprint: null,
        workspaceResolution: "environment",
      });
    });

    await t.test("initialize_project_memory bị từ chối an toàn", () => {
      const result = initializeProjectMemory();
      assert.equal(result.success, false);
      assert.equal(result.created.length, 0);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errorMessage);
    });
  } finally {
    if (originalEnv !== undefined) {
      process.env.MCP_WORKSPACE_ROOT = originalEnv;
    }
  }
});

test("Workspace path guard và bảo vệ path traversal / symlink", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-test-"));
  const memoryDir = path.join(tempDir, ".ai");
  fs.mkdirSync(memoryDir, { recursive: true });

  try {
    await t.test("Cho phép 5 file hợp lệ (bao gồm APPROVED_PLAN.md)", () => {
      const allFiles = Object.values(MEMORY_FILES);
      assert.equal(allFiles.length, 5);
      assert.ok(allFiles.includes("APPROVED_PLAN.md"));

      for (const fileName of allFiles) {
        const resolved = resolveMemoryFilePath(memoryDir, fileName);
        assert.equal(resolved, path.join(memoryDir, fileName));
      }
    });

    await t.test("Chặn tên file tùy ý ngoài danh mục", () => {
      assert.throws(() => {
        // @ts-expect-error Testing invalid filename runtime guard
        resolveMemoryFilePath(memoryDir, "malicious.js");
      }, /không nằm trong danh sách/);
    });

    await t.test("Chặn path traversal chứa ..", () => {
      assert.throws(() => {
        // @ts-expect-error Testing path traversal runtime guard
        resolveMemoryFilePath(memoryDir, "../PROJECT_CONTEXT.md");
      }, /không nằm trong danh sách/);
    });

    await t.test("Archive path guard chặn archiveId chứa .. hoặc path separator", () => {
      for (const badArchiveId of ["../escape", "sub/dir", "sub\\dir", "bad:name"]) {
        assert.throws(() => {
          resolveArchiveEntryDirPath(memoryDir, badArchiveId);
        }, /không hợp lệ/);
      }
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Mở rộng Project Memory và initialize_project_memory", async (t) => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workspace-test-"));
  const memoryDir = path.join(tempWorkspace, ".ai");

  try {
    await t.test(
      "1. Khi đã có 4 file cũ, initialize tạo thêm APPROVED_PLAN.md mà không ghi đè 4 file cũ",
      () => {
        fs.mkdirSync(memoryDir, { recursive: true });
        const legacyFiles = [
          { name: MEMORY_FILES.PROJECT_CONTEXT, content: "# Custom Project Context\nKeep me" },
          { name: MEMORY_FILES.TASK_STATE, content: "# Custom Task State\nKeep me" },
          { name: MEMORY_FILES.DECISIONS, content: "# Custom Decisions\nKeep me" },
          { name: MEMORY_FILES.HANDOFF, content: "# Custom Handoff\nKeep me" },
        ];

        for (const lf of legacyFiles) {
          fs.writeFileSync(path.join(memoryDir, lf.name), lf.content, "utf-8");
        }

        const result = initializeProjectMemory(tempWorkspace);
        assert.equal(result.success, true);
        assert.deepEqual(result.created, [MEMORY_FILES.APPROVED_PLAN]);
        assert.equal(result.alreadyExisted.length, 4);
        assert.equal(result.errors.length, 0);

        for (const lf of legacyFiles) {
          const actual = fs.readFileSync(path.join(memoryDir, lf.name), "utf-8");
          assert.equal(actual, lf.content, `File ${lf.name} không được bị ghi đè`);
        }

        const approvedPlanPath = path.join(memoryDir, MEMORY_FILES.APPROVED_PLAN);
        assert.ok(fs.existsSync(approvedPlanPath), "APPROVED_PLAN.md phải được tạo");
      }
    );

    await t.test("2. Kiểm tra project_memory_status có approvedPlan: true và activeTask: false", () => {
      const status = getProjectMemoryStatus(tempWorkspace);
      assert.equal(status.configured, true);
      assert.equal(status.workspaceExists, true);
      assert.equal(status.memoryDirectoryExists, true);
      assert.deepEqual(status.files, {
        projectContext: true,
        approvedPlan: true,
        taskState: true,
        decisions: true,
        handoff: true,
      });
      assert.equal(status.activeTask, false);
      assert.equal(status.activeTaskId, null);
      assert.equal(status.activeRevision, 0);
      assert.equal(status.archiveCount, 0);
    });

    await t.test("3. Khởi tạo tiếp là idempotent (alreadyExisted = 5)", () => {
      const result = initializeProjectMemory(tempWorkspace);
      assert.equal(result.success, true);
      assert.equal(result.created.length, 0);
      assert.equal(result.alreadyExisted.length, 5);
    });

    await t.test("4. Tự động bảo vệ Project Memory bằng Git exclude cục bộ và idempotent", () => {
      const gitInfoDir = path.join(tempWorkspace, ".git", "info");
      const excludePath = path.join(gitInfoDir, "exclude");
      fs.mkdirSync(gitInfoDir, { recursive: true });
      fs.writeFileSync(excludePath, "# local excludes\n*.local\n", "utf-8");

      const first = initializeProjectMemory(tempWorkspace);
      const second = initializeProjectMemory(tempWorkspace);
      assert.equal(first.success, true);
      assert.equal(second.success, true);

      const excludeText = fs.readFileSync(excludePath, "utf-8");
      assert.match(excludeText, /# local excludes/);
      assert.match(excludeText, /\*\.local/);
      assert.equal(
        excludeText.split(/\r?\n/u).filter((line) => line.trim() === "/.ai/").length,
        1
      );
      assert.equal(fs.existsSync(path.join(tempWorkspace, ".gitignore")), false);
    });
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }
});

test("Workflow tools: save_approved_plan, checkpoint_task, resume_task (compact/full), prepare_handoff, archive_completed_task", async (t) => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workflow-test-"));
  const memoryDir = path.join(tempWorkspace, ".ai");

  try {
    initializeProjectMemory(tempWorkspace);

    // Customize PROJECT_CONTEXT.md and DECISIONS.md to verify they are never touched by archive/reset
    const customProjectContext = "# Project Context\n\nCustom architecture context - MUST PRESERVE.";
    const customDecisions = "# Decisions\n\n- 2026-11-10: Use atomic file replacement - MUST PRESERVE.";
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILES.PROJECT_CONTEXT),
      customProjectContext,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILES.DECISIONS),
      customDecisions,
      "utf-8"
    );

    await t.test("1. archive_completed_task bị từ chối nếu chưa có approved plan (NO_APPROVED_PLAN)", () => {
      const res = archiveCompletedTask(
        {
          taskId: "TASK-100",
          expectedRevision: 0,
          userConfirmed: true,
          completionSummary: "Thử archive khi chưa có plan",
        },
        tempWorkspace
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "NO_APPROVED_PLAN");
      }
    });

    await t.test("2. checkpoint_task bị từ chối nếu chưa có approved plan (NO_APPROVED_PLAN)", () => {
      const res = checkpointTask(
        {
          taskId: "TASK-100",
          expectedRevision: 0,
          status: "in_progress",
          objective: "Build workflow tools",
          acceptanceCriteria: ["Tests pass"],
          completed: [],
          currentState: "Starting implementation",
          nextSteps: ["Write unit tests"],
          changedFiles: ["src/index.ts"],
          tests: [],
          blockers: [],
          openQuestions: [],
        },
        tempWorkspace
      );

      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "NO_APPROVED_PLAN");
      }
    });

    await t.test("3. save_approved_plan từ chối khi approvedByUser khác true", () => {
      const res = saveApprovedPlan(
        {
          taskId: "TASK-100",
          objective: "Triển khai workflow tools",
          planSteps: ["Bước 1", "Bước 2"],
          acceptanceCriteria: ["Tiêu chí 1"],
          constraints: ["Không dùng DB"],
          approvedByUser: false,
        },
        tempWorkspace
      );

      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "PLAN_NOT_APPROVED");
      }
    });

    await t.test("4. save_approved_plan từ chối taskId chứa path separator hoặc '..'", () => {
      for (const badId of ["../TASK-1", "foo/bar", "foo\\bar", "TASK..1", "bad:id"]) {
        const res = saveApprovedPlan(
          {
            taskId: badId,
            objective: "Triển khai workflow tools",
            planSteps: ["Bước 1"],
            acceptanceCriteria: ["Tiêu chí 1"],
            constraints: [],
            approvedByUser: true,
          },
          tempWorkspace
        );
        assert.equal(res.ok, false, `Phải từ chối taskId: ${badId}`);
        if (!res.ok) {
          assert.equal(res.errorCode, "INVALID_TASK_ID");
        }
      }
    });

    await t.test("5. save_approved_plan thành công khi APPROVED_PLAN.md đang là template", () => {
      const res = saveApprovedPlan(
        {
          taskId: "TASK-100",
          objective: "Triển khai workflow tools cho Project Memory",
          planSteps: ["Mở rộng Project Memory", "Thêm workflow tools"],
          acceptanceCriteria: ["Toàn bộ unit & stdio test pass", "Build sạch"],
          constraints: ["Không ghi ra ngoài .ai"],
          approvedByUser: true,
        },
        tempWorkspace
      );

      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.data.saved, true);
        assert.equal(res.data.taskId, "TASK-100");
        assert.equal(res.data.approved, true);
        assert.ok(res.data.approvedAt);
      }
    });

    await t.test("6. Gọi save_approved_plan lần hai bị từ chối (PLAN_ALREADY_EXISTS) và không ghi đè", () => {
      const planPath = path.join(memoryDir, MEMORY_FILES.APPROVED_PLAN);
      const beforeContent = fs.readFileSync(planPath, "utf-8");

      const res = saveApprovedPlan(
        {
          taskId: "TASK-999",
          objective: "Ghi đè kế hoạch cũ",
          planSteps: ["Bước khác"],
          acceptanceCriteria: ["Tiêu chí khác"],
          constraints: [],
          approvedByUser: true,
        },
        tempWorkspace
      );

      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "PLAN_ALREADY_EXISTS");
      }

      const afterContent = fs.readFileSync(planPath, "utf-8");
      assert.equal(afterContent, beforeContent, "APPROVED_PLAN.md không được bị thay đổi");
    });

    await t.test("7. checkpoint_task bị từ chối nếu taskId không khớp APPROVED_PLAN.md", () => {
      const res = checkpointTask(
        {
          taskId: "TASK-WRONG",
          expectedRevision: 0,
          status: "in_progress",
          objective: "Triển khai workflow tools",
          acceptanceCriteria: ["Toàn bộ unit & stdio test pass"],
          completed: [],
          currentState: "Đang code",
          nextSteps: ["Bước tiếp"],
          changedFiles: ["src/index.ts"],
          tests: [],
          blockers: [],
          openQuestions: [],
        },
        tempWorkspace
      );

      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "TASK_ID_MISMATCH");
      }
    });

    await t.test("8. checkpoint_task chặn absolute path và '..' trong changedFiles", () => {
      const invalidPaths = [
        "/etc/passwd",
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "\\Windows\\System32",
        "../outside.ts",
        "src/../../outside.ts",
        "..",
      ];

      for (const badPath of invalidPaths) {
        const res = checkpointTask(
          {
            taskId: "TASK-100",
            expectedRevision: 0,
            status: "in_progress",
            objective: "Triển khai workflow tools",
            acceptanceCriteria: ["Tests pass"],
            completed: [],
            currentState: "Đang kiểm tra path",
            nextSteps: ["Tiếp tục"],
            changedFiles: [badPath],
            tests: [],
            blockers: [],
            openQuestions: [],
          },
          tempWorkspace
        );

        assert.equal(res.ok, false, `Phải chặn đường dẫn không hợp lệ: ${badPath}`);
        if (!res.ok) {
          assert.equal(res.errorCode, "INVALID_CHANGED_FILES");
        }
      }
    });

    await t.test("9. checkpoint_task với revision 0 thành công và trả về revision 1", () => {
      const res = checkpointTask(
        {
          taskId: "TASK-100",
          expectedRevision: 0,
          status: "in_progress",
          objective: "Triển khai workflow tools cho Project Memory",
          acceptanceCriteria: ["Toàn bộ unit & stdio test pass", "Build sạch"],
          completed: ["Đã mở rộng Project Memory", "Đã cài save_approved_plan"],
          currentState: "Đang hoàn thiện resume_task và prepare_handoff",
          nextSteps: ["Viết kiểm thử tích hợp cho prepare_handoff", "Chạy npm run build"],
          changedFiles: ["src/config.ts", "src/memory/workflow.ts", "deleted-legacy-file.ts"],
          tests: [
            {
              command: "npm test",
              status: "passed",
              result: "Unit tests passed",
            },
            {
              command: "npm run lint",
              status: "failed",
              result: "Unused variable in temp draft",
            },
          ],
          blockers: ["Cần kiểm tra kỹ hành vi rename trên Windows"],
          openQuestions: ["Có cần giới hạn thêm số lượng test entries không?"],
        },
        tempWorkspace
      );

      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.data.taskId, "TASK-100");
        assert.equal(res.data.previousRevision, 0);
        assert.equal(res.data.revision, 1);
        assert.equal(res.data.status, "in_progress");
        assert.ok(res.data.updatedAt);
      }
    });

    await t.test(
      "10. checkpoint_task với stale revision (expectedRevision: 0) bị từ chối và không thay đổi file",
      () => {
        const taskStatePath = path.join(memoryDir, MEMORY_FILES.TASK_STATE);
        const beforeContent = fs.readFileSync(taskStatePath, "utf-8");

        const res = checkpointTask(
          {
            taskId: "TASK-100",
            expectedRevision: 0,
            status: "completed",
            objective: "Cập nhật từ stale revision",
            acceptanceCriteria: ["Tests pass"],
            completed: ["Mọi thứ"],
            currentState: "Hoàn tất",
            nextSteps: [],
            changedFiles: ["src/index.ts"],
            tests: [],
            blockers: [],
            openQuestions: [],
          },
          tempWorkspace
        );

        assert.equal(res.ok, false);
        if (!res.ok) {
          assert.equal(res.errorCode, "REVISION_CONFLICT");
          assert.equal(res.currentRevision, 1);
        }

        const afterContent = fs.readFileSync(taskStatePath, "utf-8");
        assert.equal(afterContent, beforeContent, "TASK_STATE.md không được thay đổi khi conflict");
      }
    );

    await t.test("11. prepare_handoff từ chối stale revision và thành công với đúng revision", () => {
      const staleRes = prepareHandoff(
        {
          expectedRevision: 0,
          reason: "context_switch",
          nextExactAction: "Chạy test",
          doNotRedo: ["Không sửa lại config"],
        },
        tempWorkspace
      );
      assert.equal(staleRes.ok, false);
      if (!staleRes.ok) {
        assert.equal(staleRes.errorCode, "REVISION_CONFLICT");
        assert.equal(staleRes.currentRevision, 1);
      }

      const okRes = prepareHandoff(
        {
          expectedRevision: 1,
          reason: "context_switch",
          nextExactAction: "Chạy toàn bộ stdio integration tests và kiểm tra kết quả",
          doNotRedo: [
            "Không tạo lại cấu trúc .ai",
            "Không ghi đè APPROVED_PLAN.md",
          ],
        },
        tempWorkspace
      );
      assert.equal(okRes.ok, true);
      if (okRes.ok) {
        assert.equal(okRes.data.taskId, "TASK-100");
        assert.equal(okRes.data.basedOnRevision, 1);
        assert.equal(okRes.data.handoffUpdated, true);
      }
    });

    await t.test(
      "12. resume_task mặc định dùng compact, không chứa toàn bộ raw Markdown, trả đầy đủ structured state",
      () => {
        const res = resumeTask(tempWorkspace);
        assert.equal(res.ok, true);
        if (res.ok) {
          const data = res.data as ResumeTaskCompactOutput;
          assert.equal(data.hasApprovedPlan, true);
          assert.equal(data.taskId, "TASK-100");
          assert.equal(data.revision, 1);
          assert.equal(data.status, "in_progress");
          assert.equal(data.objective, "Triển khai workflow tools cho Project Memory");
          assert.deepEqual(data.acceptanceCriteria, [
            "Toàn bộ unit & stdio test pass",
            "Build sạch",
          ]);
          assert.deepEqual(data.completed, [
            "Đã mở rộng Project Memory",
            "Đã cài save_approved_plan",
          ]);
          assert.equal(
            data.currentState,
            "Đang hoàn thiện resume_task và prepare_handoff"
          );
          assert.equal(
            data.handoffNextAction,
            "Chạy toàn bộ stdio integration tests và kiểm tra kết quả"
          );
          assert.deepEqual(data.doNotRedo, [
            "Không tạo lại cấu trúc .ai",
            "Không ghi đè APPROVED_PLAN.md",
          ]);
          assert.equal(
            data.recommendedNextAction,
            "Viết kiểm thử tích hợp cho prepare_handoff"
          );
          assert.equal(data.truncated, false);
          assert.deepEqual(data.truncatedFields, []);

          // Must NOT contain raw Markdown of the 5 files
          assert.equal("projectContext" in data, false);
          assert.equal("approvedPlan" in data, false);
          assert.equal("taskState" in data, false);
          assert.equal("handoff" in data, false);
          assert.equal("decisions" in data, false);
        }
      }
    );

    await t.test("13. archive_completed_task bị từ chối khi status chưa phải 'completed' (TASK_NOT_COMPLETED)", () => {
      const res = archiveCompletedTask(
        {
          taskId: "TASK-100",
          expectedRevision: 1,
          userConfirmed: true,
          completionSummary: "Thử archive khi đang in_progress",
        },
        tempWorkspace
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "TASK_NOT_COMPLETED");
      }
    });

    await t.test("14. Chuyển task sang status 'completed' ở revision 2", () => {
      const cp = checkpointTask(
        {
          taskId: "TASK-100",
          expectedRevision: 1,
          status: "completed",
          objective: "Triển khai workflow tools cho Project Memory",
          acceptanceCriteria: ["Toàn bộ unit & stdio test pass", "Build sạch"],
          completed: [
            "Đã mở rộng Project Memory",
            "Đã cài save_approved_plan",
            "Đã hoàn thiện toàn bộ tests",
          ],
          currentState: "Tất cả hạng mục đã hoàn tất",
          nextSteps: [],
          changedFiles: ["src/config.ts", "src/memory/workflow.ts", "src/index.ts"],
          tests: [
            {
              command: "npm test",
              status: "passed",
              result: "All tests pass",
            },
          ],
          blockers: [],
          openQuestions: [],
        },
        tempWorkspace
      );
      assert.equal(cp.ok, true);
      if (cp.ok) {
        assert.equal(cp.data.revision, 2);
      }

      const status = getProjectMemoryStatus(tempWorkspace);
      assert.equal(status.activeTask, true);
      assert.equal(status.activeTaskId, "TASK-100");
      assert.equal(status.activeRevision, 2);
      assert.equal(status.archiveCount, 0);
    });

    await t.test("15. archive_completed_task từ chối nếu userConfirmed khác true (USER_CONFIRMATION_REQUIRED)", () => {
      const res = archiveCompletedTask(
        {
          taskId: "TASK-100",
          expectedRevision: 2,
          userConfirmed: false,
          completionSummary: "Chưa được user confirm",
        },
        tempWorkspace
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "USER_CONFIRMATION_REQUIRED");
      }
    });

    await t.test("16. archive_completed_task từ chối nếu revision stale (REVISION_CONFLICT)", () => {
      const res = archiveCompletedTask(
        {
          taskId: "TASK-100",
          expectedRevision: 1,
          userConfirmed: true,
          completionSummary: "Stale revision",
        },
        tempWorkspace
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.errorCode, "REVISION_CONFLICT");
        assert.equal(res.currentRevision, 2);
      }
    });

    await t.test("17. Archive destination hiện hữu bị từ chối (ARCHIVE_ALREADY_EXISTS), không ghi đè và không reset task", () => {
      const fixedDate = new Date("2026-11-10T12:00:00.000Z");
      const collidingArchiveId = "2026-11-10T12-00-00-000Z_TASK-100";
      const archiveRoot = resolveArchiveRootPath(memoryDir);
      fs.mkdirSync(archiveRoot, { recursive: true });
      const collidingDir = path.join(archiveRoot, collidingArchiveId);
      fs.mkdirSync(collidingDir, { recursive: true });
      const markerPath = path.join(collidingDir, "EXISTING_MARKER.txt");
      fs.writeFileSync(markerPath, "DO NOT OVERWRITE", "utf-8");

      try {
        const res = archiveCompletedTask(
          {
            taskId: "TASK-100",
            expectedRevision: 2,
            userConfirmed: true,
            completionSummary: "Collision test",
          },
          tempWorkspace,
          { now: fixedDate }
        );
        assert.equal(res.ok, false);
        if (!res.ok) {
          assert.equal(res.errorCode, "ARCHIVE_ALREADY_EXISTS");
        }

        // Verify marker untouched and current task still active at revision 2
        assert.equal(fs.readFileSync(markerPath, "utf-8"), "DO NOT OVERWRITE");
        const status = getProjectMemoryStatus(tempWorkspace);
        assert.equal(status.activeTask, true);
        assert.equal(status.activeTaskId, "TASK-100");
        assert.equal(status.activeRevision, 2);
      } finally {
        fs.rmSync(collidingDir, { recursive: true, force: true });
      }
    });

    await t.test(
      "18. archive_completed_task thành công, tạo đủ 4 file trong archive, đúng summary, reset current task và giữ nguyên PROJECT_CONTEXT + DECISIONS",
      () => {
        const archiveDate = new Date("2026-11-10T15:30:45.500Z");
        const res = archiveCompletedTask(
          {
            taskId: "TASK-100",
            expectedRevision: 2,
            userConfirmed: true,
            completionSummary:
              "Đã hoàn thành toàn bộ workflow tools và kiểm thử an toàn trên Windows.",
          },
          tempWorkspace,
          { now: archiveDate }
        );

        assert.equal(res.ok, true);
        if (res.ok) {
          assert.equal(res.data.archived, true);
          assert.equal(res.data.taskId, "TASK-100");
          assert.equal(res.data.archivedRevision, 2);
          assert.equal(res.data.archiveId, "2026-11-10T15-30-45-500Z_TASK-100");
          assert.equal(res.data.resetCurrentTask, true);
          assert.equal(res.data.completedAt, "2026-11-10T15:30:45.500Z");
        }

        const archiveDir = path.join(
          memoryDir,
          "archive",
          "2026-11-10T15-30-45-500Z_TASK-100"
        );
        assert.ok(fs.existsSync(archiveDir));

        // Archive contains all 4 required files
        for (const fileName of Object.values(ARCHIVE_FILES)) {
          const archivedFile = path.join(archiveDir, fileName);
          assert.ok(fs.existsSync(archivedFile), `Archive phải chứa ${fileName}`);
          assert.ok(fs.statSync(archivedFile).size > 0);
        }

        // Verify COMPLETION_SUMMARY.md has accurate taskId and archived revision
        const summaryContent = fs.readFileSync(
          path.join(archiveDir, ARCHIVE_FILES.COMPLETION_SUMMARY),
          "utf-8"
        );
        assert.match(summaryContent, /- \*\*Task ID\*\*: TASK-100/);
        assert.match(summaryContent, /- \*\*Archived Revision\*\*: 2/);
        assert.match(summaryContent, /- \*\*User Confirmed\*\*: true/);
        assert.match(
          summaryContent,
          /Đã hoàn thành toàn bộ workflow tools và kiểm thử an toàn trên Windows\./
        );

        // Verify PROJECT_CONTEXT.md and DECISIONS.md were NOT modified
        assert.equal(
          fs.readFileSync(path.join(memoryDir, MEMORY_FILES.PROJECT_CONTEXT), "utf-8"),
          customProjectContext
        );
        assert.equal(
          fs.readFileSync(path.join(memoryDir, MEMORY_FILES.DECISIONS), "utf-8"),
          customDecisions
        );

        // Verify current task files were reset and project_memory_status reflects archiveCount = 1, activeTask = false
        const status = getProjectMemoryStatus(tempWorkspace);
        assert.equal(status.activeTask, false);
        assert.equal(status.activeTaskId, null);
        assert.equal(status.activeRevision, 0);
        assert.equal(status.archiveCount, 1);

        const resumedAfterArchive = resumeTask(tempWorkspace);
        assert.equal(resumedAfterArchive.ok, true);
        if (resumedAfterArchive.ok) {
          assert.equal(resumedAfterArchive.data.hasApprovedPlan, false);
          assert.equal(resumedAfterArchive.data.taskId, null);
          assert.equal(resumedAfterArchive.data.revision, 0);
        }
      }
    );

    await t.test("19. Sau khi archive, có thể lưu approved plan mới thành công", () => {
      const newPlanRes = saveApprovedPlan(
        {
          taskId: "TASK-200",
          objective: "Triển khai giai đoạn tiếp theo sau khi archive TASK-100",
          planSteps: ["Bước A", "Bước B"],
          acceptanceCriteria: ["Tests mới pass"],
          constraints: [],
          approvedByUser: true,
        },
        tempWorkspace
      );

      assert.equal(newPlanRes.ok, true);
      if (newPlanRes.ok) {
        assert.equal(newPlanRes.data.taskId, "TASK-200");
      }

      const status = getProjectMemoryStatus(tempWorkspace);
      assert.equal(status.activeTask, true);
      assert.equal(status.activeTaskId, "TASK-200");
      assert.equal(status.activeRevision, 0);
      assert.equal(status.archiveCount, 1);
    });

    await t.test("20. Không còn temporary file sau các thao tác", () => {
      assert.deepEqual(listTempFiles(memoryDir), []);
      assert.throws(() => {
        writeMemoryFileAtomic(memoryDir, MEMORY_FILES.HANDOFF, "# Should fail", {
          beforeReplace: () => {
            throw new Error("Simulated failure before replace");
          },
        });
      }, /Simulated failure before replace/);
      assert.deepEqual(listTempFiles(memoryDir), []);
    });
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }
});

test("Kiểm tra bảo vệ Symlink escape trong .ai và .ai/archive", async (t) => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-symlink-ws-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-outside-secret-"));
  const memoryDir = path.join(tempWorkspace, ".ai");

  try {
    initializeProjectMemory(tempWorkspace);
    saveApprovedPlan(
      {
        taskId: "TASK-SYM",
        objective: "Test symlink protection",
        planSteps: ["Step 1"],
        acceptanceCriteria: ["Criterion 1"],
        constraints: [],
        approvedByUser: true,
      },
      tempWorkspace
    );
    checkpointTask(
      {
        taskId: "TASK-SYM",
        expectedRevision: 0,
        status: "completed",
        objective: "Test symlink protection",
        acceptanceCriteria: ["Criterion 1"],
        completed: ["Step 1"],
        currentState: "Completed",
        nextSteps: [],
        changedFiles: ["src/index.ts"],
        tests: [],
        blockers: [],
        openQuestions: [],
      },
      tempWorkspace
    );

    await t.test("Chặn khi .ai/archive là symlink/junction trỏ ra ngoài .ai", () => {
      const archiveLinkPath = path.join(memoryDir, "archive");
      let symlinkCreated = false;

      try {
        // On Windows, 'junction' works without elevated privileges and is detected by lstat.isSymbolicLink()
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(outsideDir, archiveLinkPath, symlinkType);
        symlinkCreated = true;
      } catch {
        symlinkCreated = false;
      }

      if (symlinkCreated) {
        try {
          const res = archiveCompletedTask(
            {
              taskId: "TASK-SYM",
              expectedRevision: 1,
              userConfirmed: true,
              completionSummary: "Should be blocked by symlink guard",
            },
            tempWorkspace
          );
          assert.equal(res.ok, false, "Phải chặn archive khi .ai/archive là symlink");
          if (!res.ok) {
            assert.equal(res.errorCode, "ARCHIVE_FAILED");
          }

          // Ensure nothing was written to outsideDir
          assert.deepEqual(fs.readdirSync(outsideDir), []);
        } finally {
          fs.unlinkSync(archiveLinkPath);
        }
      }
    });
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("resume_task áp dụng giới hạn cho cả compact (16.000) và full (20.000/file, 60.000/total)", async (t) => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-truncate-test-"));
  const memoryDir = path.join(tempWorkspace, ".ai");

  try {
    initializeProjectMemory(tempWorkspace);

    await t.test("Chế độ compact: tuân thủ giới hạn phần tử, độ dài chuỗi và tổng kích thước <= 16.000 ký tự", () => {
      saveApprovedPlan(
        {
          taskId: "TASK-COMPACT",
          objective: "O".repeat(1800),
          planSteps: ["Step 1"],
          acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `Crit-${i}-${"C".repeat(500)}`),
          constraints: [],
          approvedByUser: true,
        },
        tempWorkspace
      );

      checkpointTask(
        {
          taskId: "TASK-COMPACT",
          expectedRevision: 0,
          status: "in_progress",
          objective: "O".repeat(1800),
          acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `Crit-${i}-${"C".repeat(500)}`),
          completed: Array.from({ length: 30 }, (_, i) => `Done-${i}-${"D".repeat(500)}`),
          currentState: "S".repeat(2500),
          nextSteps: Array.from({ length: 25 }, (_, i) => `Next-${i}-${"N".repeat(500)}`),
          changedFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}-${"F".repeat(300)}.ts`),
          tests: Array.from({ length: 25 }, (_, i) => ({
            command: `npm test --suite=${i}`,
            status: "passed" as const,
            result: "R".repeat(500),
          })),
          blockers: Array.from({ length: 25 }, (_, i) => `Blocker-${i}-${"B".repeat(500)}`),
          openQuestions: Array.from({ length: 25 }, (_, i) => `Question-${i}-${"Q".repeat(500)}`),
        },
        tempWorkspace
      );

      const res = resumeTask(tempWorkspace, { detailLevel: "compact" });
      assert.equal(res.ok, true);
      if (res.ok) {
        const data = res.data as ResumeTaskCompactOutput;
        const serializedLen = JSON.stringify(data).length;
        assert.ok(
          serializedLen <= 16_000,
          `Kích thước compact (${serializedLen}) phải <= 16.000 ký tự`
        );
        assert.equal(data.truncated, true);
        assert.ok(data.truncatedFields.length > 0);
        assert.equal("projectContext" in data, false);
        assert.equal("taskState" in data, false);
      }
    });

    await t.test("Chế độ full: truncate khi 1 file vượt quá 20.000 ký tự", () => {
      const hugeDecisions = "# Decisions\n" + "A".repeat(25_000);
      fs.writeFileSync(
        path.join(memoryDir, MEMORY_FILES.DECISIONS),
        hugeDecisions,
        "utf-8"
      );

      const res = resumeTask(tempWorkspace, { detailLevel: "full" });
      assert.equal(res.ok, true);
      if (res.ok) {
        const data = res.data as ResumeTaskFullOutput;
        assert.equal(data.decisions.length, 20_000);
        assert.equal(data.truncated, true);
        assert.ok(data.truncatedFiles?.includes(MEMORY_FILES.DECISIONS));
      }
    });

    await t.test("Chế độ full: truncate khi tổng dung lượng 5 file vượt quá 60.000 ký tự", () => {
      for (const fileName of Object.values(MEMORY_FILES)) {
        fs.writeFileSync(
          path.join(memoryDir, fileName),
          `# ${fileName}\n` + "B".repeat(19_000),
          "utf-8"
        );
      }

      const res = resumeTask(tempWorkspace, { detailLevel: "full" });
      assert.equal(res.ok, true);
      if (res.ok) {
        const data = res.data as ResumeTaskFullOutput;
        const totalChars =
          data.projectContext.length +
          data.approvedPlan.length +
          data.taskState.length +
          data.handoff.length +
          data.decisions.length;

        assert.ok(totalChars <= 60_000, `Tổng số ký tự (${totalChars}) phải <= 60.000`);
        assert.equal(data.truncated, true);
        assert.ok(data.truncatedFiles && data.truncatedFiles.length > 0);
      }
    });
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }
});

test("Kiểm tra không có console.log trong source code (src/)", () => {
  const srcDir = path.resolve("src");

  function scanDir(dir: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...scanDir(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = scanDir(srcDir);
  assert.ok(tsFiles.length >= 5, "Phải tìm thấy ít nhất 5 file trong src");

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
        assert.doesNotMatch(
          line,
          /\bconsole\.log\b/,
          `Phát hiện console.log tại ${path.relative(process.cwd(), file)}:${index + 1}`
        );
      }
    });
  }
});
