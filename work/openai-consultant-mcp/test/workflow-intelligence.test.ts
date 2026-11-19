import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorkspaceFromHook, attachActiveWorkspace } from "../src/memory/project-memory.js";
import {
  assessContextHealth,
  routeReview,
  getTelemetrySummary,
  recordTelemetryEvent,
} from "../src/intelligence/workflow-intelligence.js";

test("Phase 3 intelligence: Context Guardian, Review Router và telemetry labels", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-intelligence-test-"));
  const workspace = path.join(tempRoot, "project");
  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(workspace, { recursive: true });
  const options = { dataDir, now: new Date("2026-11-12T05:00:00.000Z") };
  try {
    registerWorkspaceFromHook({ conversationId: "intel", workspacePaths: [workspace], hookEventName: "SessionStart" }, options);
    const attached = attachActiveWorkspace({ initializeIfMissing: true }, options);
    assert.equal(attached.ok, true);
    if (!attached.ok) return;
    const bindingId = attached.data.bindingId;

    await t.test("Context Guardian handoff khi có dấu hiệu quên/mâu thuẫn", () => {
      const healthy = assessContextHealth({ workspaceBindingId: bindingId, conversationTurns: 5, repeatedQuestion: false, contradictedDecision: false, forgotAcceptanceCriteria: false }, options);
      assert.equal(healthy.ok, true);
      if (healthy.ok) assert.equal(healthy.data.recommendation, "continue");

      const risky = assessContextHealth({ workspaceBindingId: bindingId, conversationTurns: 31, estimatedContextTokens: 90_000, repeatedQuestion: true, contradictedDecision: true, forgotAcceptanceCriteria: true }, options);
      assert.equal(risky.ok, true);
      if (risky.ok) {
        assert.equal(risky.data.recommendation, "handoff_now");
        assert.ok(risky.data.riskScore >= 4);
        assert.match(risky.data.factPolicy.historical, /revision/i);
      }
    });

    await t.test("Review Router required cho auth và skip thay đổi nhỏ deterministic", () => {
      const required = routeReview({ workspaceBindingId: bindingId, changedFileCount: 1, changedLineCount: 5, testsPassed: true, deterministicChange: true, touchesAuth: true, touchesSecurity: false, touchesPayment: false, touchesDatabaseMigration: false, touchesConcurrency: false, touchesProduction: false }, options);
      assert.equal(required.ok, true);
      if (required.ok) assert.equal(required.data.decision, "required");

      const skipped = routeReview({ workspaceBindingId: bindingId, changedFileCount: 1, changedLineCount: 4, testsPassed: true, deterministicChange: true, touchesAuth: false, touchesSecurity: false, touchesPayment: false, touchesDatabaseMigration: false, touchesConcurrency: false, touchesProduction: false, estimatedReviewTokens: 3000 }, options);
      assert.equal(skipped.ok, true);
      if (skipped.ok) {
        assert.equal(skipped.data.decision, "skip");
        assert.equal(skipped.data.estimatedTokensAvoided, 3000);
      }
    });

    await t.test("Telemetry phân biệt exact và estimated, không chứa nội dung prompt", () => {
      recordTelemetryEvent({ workspaceId: attached.data.workspaceId, eventType: "api_usage", measurementKind: "exact", usedTokens: 120, baselineTokens: 120 }, options);
      recordTelemetryEvent({ workspaceId: attached.data.workspaceId, eventType: "clarification_round", measurementKind: "estimated", usedTokens: 300, baselineTokens: 0 }, options);
      const summary = getTelemetrySummary(bindingId, options);
      assert.equal(summary.ok, true);
      if (summary.ok) {
        assert.equal(summary.data.exactUsedTokens, 120);
        assert.ok(summary.data.estimatedUsedTokens >= 300);
        assert.equal(summary.data.clarificationRounds, 1);
        assert.match(summary.data.disclaimer, /estimated/i);
      }
      const raw = fs.readFileSync(path.join(dataDir, "telemetry.json"), "utf-8");
      assert.doesNotMatch(raw, /prompt|source code|secret/i);
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
