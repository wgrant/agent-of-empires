// Structured view prompt lifecycle over REST: prompts, approvals, cancel, steering, and the event store.

import { test, expect } from "../helpers/liveTest";
import { listSessions } from "../helpers/aoeServe";
import {
  HOLD,
  chunk,
  endTurn,
  postAcp,
  postPrompt,
  replayFrames,
  replayJson,
  script,
  seedAcpSession,
  startAcpSession,
  waitForReplayContains,
} from "../helpers/acp";

const expect2xx = (res: Response) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

test("structured view spawn + prompt round-trip emits an agent_message_chunk", async ({ spawnServe }) => {
  // Enable spawns the worker itself; an explicit /acp/spawn would 409.
  const { serve, sessionId } = await startAcpSession(spawnServe, { title: "acp-trace" });
  expect2xx(await postPrompt(serve.baseUrl, sessionId, "hello structured view"));
  await waitForReplayContains(serve.baseUrl, sessionId, ["agent_message_chunk", "AgentMessageChunk"]);
});

type ApprovalFrame = {
  seq?: number;
  event?: {
    ApprovalRequested?: { approval?: { nonce?: string; tool_call?: { args_preview?: string } } };
    ToolCallStarted?: { tool_call?: { id?: string } };
    ToolCallCompleted?: { tool_call_id?: string; is_error?: boolean };
  };
};

/** Prompt a turn that requests permission and return the server-generated approval nonce. */
async function requestApproval(spawnServe: Parameters<typeof startAcpSession>[0], title: string) {
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title,
    fakeAcpScript: script(
      endTurn(chunk("Considering write..."), {
        sessionUpdate: "permission_request",
        toolCall: { toolCallId: "fake-tool-call-1", title: "Write file", kind: "edit" },
      }),
    ),
  });
  await postPrompt(serve.baseUrl, sessionId, "write a file");
  const frames = async () => (await replayFrames(serve.baseUrl, sessionId)) as ApprovalFrame[];
  const nonceOf = async () => (await frames()).find((f) => f.event?.ApprovalRequested?.approval?.nonce);
  await expect.poll(nonceOf, { timeout: 15_000, intervals: [100, 200, 500, 1000] }).toBeDefined();
  const approvalFrame = (await nonceOf())!;
  const nonce = approvalFrame.event!.ApprovalRequested!.approval!.nonce!;
  const resolve = (decision: "Allow" | "Deny") =>
    // ApprovalDecisionWire is PascalCase; "allow" is a 422.
    postAcp(serve.baseUrl, sessionId, `/approvals/${nonce}`, { decision });
  return { frames, approvalFrame, resolve };
}

test("permission_request flows through to the server", async ({ spawnServe }) => {
  const { frames, approvalFrame, resolve } = await requestApproval(spawnServe, "acp-approval");
  // #1713: no raw_input means an empty preview, not the string "null".
  expect(approvalFrame.event?.ApprovalRequested?.approval?.tool_call?.args_preview).toBe("");
  // #1713: the tool card starts before the approval so it exists when the tool completes.
  const startFrame = (await frames()).find((f) => f.event?.ToolCallStarted?.tool_call?.id === "fake-tool-call-1");
  expect(startFrame).toBeDefined();
  expect(startFrame!.seq!).toBeLessThan(approvalFrame.seq!);
  expect2xx(await resolve("Allow"));
});

test("denied permission closes the tool card with an error completion (#1713)", async ({ spawnServe }) => {
  const { frames, resolve } = await requestApproval(spawnServe, "acp-approval-deny");
  expect2xx(await resolve("Deny"));
  // The denied tool never runs, so its started card must get a terminal error completion.
  await expect
    .poll(
      async () =>
        (await frames()).some(
          (f) =>
            f.event?.ToolCallCompleted?.tool_call_id === "fake-tool-call-1" &&
            f.event?.ToolCallCompleted?.is_error === true,
        ),
      { timeout: 15_000, intervals: [100, 200, 500, 1000] },
    )
    .toBe(true);
});

test("structured view/cancel publishes Stopped reason:cancelled mid-turn", async ({ spawnServe }) => {
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "acp-cancel",
    fakeAcpScript: script(endTurn(chunk("Thinking..."), HOLD, chunk("MUST_NOT_COMPLETE"))),
  });
  await postPrompt(serve.baseUrl, sessionId, "long-running thought");
  await waitForReplayContains(serve.baseUrl, sessionId, "Thinking...");
  expect((await postAcp(serve.baseUrl, sessionId, "/cancel")).status).toBe(202);
  await waitForReplayContains(serve.baseUrl, sessionId, '"reason":"cancelled"');
  expect(await replayJson(serve.baseUrl, sessionId)).not.toContain("MUST_NOT_COMPLETE");
});

// #2805: a prompt during a running turn is steered when the agent supports it, otherwise queued.
test.describe("mid-turn prompts", () => {
  const heldTurn = script(endTurn(chunk("working"), HOLD));

  test("a mid-turn prompt is steered into the running turn instead of rejected", async ({ spawnServe }) => {
    const { serve, sessionId } = await startAcpSession(spawnServe, {
      title: "acp-steering",
      fakeAcpScript: heldTurn,
      extraEnv: { FAKE_ACP_STEERING: "1" },
    });
    // Without the capability on the stream the daemon would take the reject path.
    await waitForReplayContains(serve.baseUrl, sessionId, '"steering":true');
    await postPrompt(serve.baseUrl, sessionId, "start the turn");
    await waitForReplayContains(serve.baseUrl, sessionId, "working");

    expect((await postPrompt(serve.baseUrl, sessionId, "also check the tests")).ok).toBe(true);
    // The fake echoes an accepted steer back into the running turn.
    await waitForReplayContains(serve.baseUrl, sessionId, "steered: also check the tests");
    expect(await replayJson(serve.baseUrl, sessionId)).not.toContain("agent_busy");
  });

  test("a mid-turn prompt is queued, not rejected, when the agent cannot be steered", async ({ spawnServe }) => {
    const { serve, sessionId } = await startAcpSession(spawnServe, {
      title: "acp-no-steering",
      fakeAcpScript: heldTurn,
    });
    await postPrompt(serve.baseUrl, sessionId, "start the turn");
    await waitForReplayContains(serve.baseUrl, sessionId, "working");

    const res = await postPrompt(serve.baseUrl, sessionId, "also check the tests");
    expect(res.status).toBe(202);
    const dispatch = (await res.json()) as { disposition?: string; reason?: string; queued_id?: string };
    expect(dispatch.disposition).toBe("queued");
    expect(dispatch.reason).toBe("turn_active");

    const queue = (await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/queue`).then((r) => r.json())) as Array<{
      id: string;
      text: string;
    }>;
    expect(queue.map((q) => q.text)).toEqual(["also check the tests"]);
    expect(queue[0]!.id).toBe(dispatch.queued_id);
    expect(await replayJson(serve.baseUrl, sessionId)).not.toContain("agent_busy");
  });

  test("a prompt reaching the daemon mid-compaction is queued, not steered", async ({ spawnServe }) => {
    // #3219: steering is on, so the compaction phase is the only reason to park it.
    const { serve, sessionId } = await startAcpSession(spawnServe, {
      title: "acp-compaction-rest",
      fakeAcpScript: script(endTurn(chunk("Compacting..."), HOLD, chunk("\n\nCompacting completed."))),
      extraEnv: { FAKE_ACP_STEERING: "1" },
    });
    await waitForReplayContains(serve.baseUrl, sessionId, '"steering":true');
    await postPrompt(serve.baseUrl, sessionId, "/compact");
    await waitForReplayContains(serve.baseUrl, sessionId, "ConversationCompactionStarted");

    const res = await postPrompt(serve.baseUrl, sessionId, "also check the tests");
    expect(res.status).toBe(202);
    const dispatch = (await res.json()) as { disposition?: string; reason?: string };
    expect(dispatch.disposition).toBe("queued");
    expect(dispatch.reason).toBe("compacting");
    expect(await replayJson(serve.baseUrl, sessionId)).not.toContain("steered: also check the tests");
  });
});

test("notices, structured compaction, a truncated turn, and turn usage reach the event store through the runner", async ({
  spawnServe,
}) => {
  // The ACP crate cannot decode these kinds; ingress tunnels them through `session_info_update`.
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "acp-extension-updates",
    fakeAcpScript: script({
      ...endTurn(
        { sessionUpdate: "notice", severity: "warning", title: "Config deprecated", description: "Use the new key" },
        { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" },
        {
          sessionUpdate: "compaction_update",
          compactionId: "c1",
          status: "completed",
          summary: [{ type: "text", text: "KEPT_THE_PLAN" }],
        },
      ),
      stopReason: "max_tokens",
      response: {
        usage: { totalTokens: 1310, inputTokens: 10, outputTokens: 300, cachedReadTokens: 1000 },
        _meta: {
          quota: {
            model_usage: [{ model: "claude-haiku-4-5", token_count: { inputTokens: 2, outputTokens: 50 } }],
          },
        },
      },
    }),
  });
  await postPrompt(serve.baseUrl, sessionId, "/compact");
  await waitForReplayContains(serve.baseUrl, sessionId, "Reply cut off");
  const replay = await replayJson(serve.baseUrl, sessionId);
  for (const needle of [
    "Config deprecated",
    "KEPT_THE_PLAN",
    "TurnTokenUsage",
    "claude-haiku-4-5",
    "ConversationCompactionStarted",
    "ConversationCompacted",
  ]) {
    expect(replay, needle).toContain(needle);
  }
});

const asyncLaunch = (agentId: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: `launch-${agentId}`,
  _meta: {
    claudeCode: {
      toolName: "Agent",
      toolResponse: { isAsync: true, status: "async_launched", agentId, description: "d", prompt: "p" },
    },
  },
});

test("native subagent sessions reach the event store apart from the main reply", async ({ spawnServe }) => {
  const child = "fake-child-session";
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "acp-native-subagents",
    fakeAcpScript: script(
      endTurn(
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: child,
          name: "Explorer",
          task: "Find it",
          capabilities: {},
        },
        { ...chunk("CHILD_TEXT"), onSession: child },
        {
          sessionUpdate: "permission_request",
          onSession: child,
          echoDecision: true,
          toolCall: { toolCallId: "child-tool", title: "Child edit", kind: "edit" },
        },
        // claude-agent-acp also reports a native subagent as an async launch; only the other one is tailed.
        asyncLaunch(child),
        asyncLaunch("tailed-agent"),
        { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "completed" },
        // Never announced, so refused.
        { ...chunk("STRANGER_TEXT"), onSession: "stranger-session" },
        chunk("MAIN_TEXT"),
      ),
    ),
  });
  await postPrompt(serve.baseUrl, sessionId, "delegate");
  const frames = async () => (await replayFrames(serve.baseUrl, sessionId)) as ApprovalFrame[];
  const nonceOf = async () => (await frames()).find((f) => f.event?.ApprovalRequested?.approval?.nonce);
  await expect.poll(nonceOf, { timeout: 15_000, intervals: [100, 200, 500, 1000] }).toBeDefined();
  const nonce = (await nonceOf())!.event!.ApprovalRequested!.approval!.nonce!;
  expect2xx(await postAcp(serve.baseUrl, sessionId, `/approvals/${nonce}`, { decision: "Allow" }));
  await waitForReplayContains(serve.baseUrl, sessionId, "MAIN_TEXT");

  const events = (await replayFrames(serve.baseUrl, sessionId)).map((f) => (f as { event: object }).event);
  const top = (kind: string) => events.filter((e) => kind in e).map((e) => JSON.stringify(e));
  const nested = events.flatMap((e) =>
    "SubagentUpdate" in e
      ? [JSON.stringify((e as { SubagentUpdate: { id: string; event: object } }).SubagentUpdate)]
      : [],
  );
  expect(top("SubagentSpawned").map((e) => JSON.parse(e).SubagentSpawned)).toEqual([
    expect.objectContaining({ id: child, name: "Explorer", task: "Find it" }),
  ]);
  expect(top("SubagentStateChanged").map((e) => JSON.parse(e).SubagentStateChanged.state)).toEqual(["completed"]);
  expect(top("BackgroundAgentLaunched").map((e) => JSON.parse(e).BackgroundAgentLaunched.agent_id)).toEqual([
    "tailed-agent",
  ]);
  // The child's text, permission tool card, and its echoed decision stay inside the child.
  expect(nested.some((e) => e.includes("CHILD_TEXT"))).toBe(true);
  expect(nested.some((e) => e.includes("child-tool") && e.includes("ToolCallStarted"))).toBe(true);
  expect(nested.some((e) => e.includes("permission_option="))).toBe(true);
  const mainText = top("AgentMessageChunk").join("");
  expect(mainText).toContain("MAIN_TEXT");
  for (const leaked of ["CHILD_TEXT", "STRANGER_TEXT", "permission_option="]) expect(mainText).not.toContain(leaked);
});

test("a background workflow keeps the session running until its task is stopped", async ({ spawnServe }) => {
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "acp-async-task",
    fakeAcpScript: script(
      endTurn(
        chunk("Launched."),
        {
          sessionUpdate: "async_task_spawned",
          asyncTaskId: "wf1",
          name: "calc-bug-check",
          taskType: "workflow",
          canStop: true,
        },
        { sessionUpdate: "async_task_progress", asyncTaskId: "wf1", description: "Review: review:average" },
      ),
    ),
  });
  await postPrompt(serve.baseUrl, sessionId, "run a workflow");
  await waitForReplayContains(serve.baseUrl, sessionId, "prompt_complete");
  const status = async () => (await listSessions(serve.baseUrl)).find((s) => s.id === sessionId)?.status;
  // The turn ended, but the workflow is still working.
  await expect.poll(status, { timeout: 15_000 }).toBe("Running");

  expect2xx(await postAcp(serve.baseUrl, sessionId, "/async-tasks/wf1/stop"));
  await waitForReplayContains(serve.baseUrl, sessionId, "AsyncTaskStateChanged");
  const replay = await replayJson(serve.baseUrl, sessionId);
  expect(replay).toContain('"state":"stopped"');
  expect(replay).toContain("Review: review:average");
  await expect.poll(status, { timeout: 15_000 }).toBe("Idle");
});

test("a workflow's agents' unlinked tool calls and approvals are kept inside its run", async ({ spawnServe }) => {
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "acp-workflow-attribution",
    fakeAcpScript: script({
      ...endTurn(
        { sessionUpdate: "tool_call", toolCallId: "launch", title: "Workflow", kind: "other", rawInput: {} },
        {
          sessionUpdate: "async_task_spawned",
          asyncTaskId: "wf1",
          name: "calc-bug-check",
          taskType: "workflow",
          canStop: true,
        },
        { sessionUpdate: "tool_call_update", toolCallId: "launch", status: "completed" },
        chunk("MAIN_LAUNCHED"),
      ),
      afterTurn: [
        { sessionUpdate: "tool_call", toolCallId: "agent-tool", title: "AGENT_BASH", kind: "execute", rawInput: {} },
        {
          sessionUpdate: "permission_request",
          toolCall: { toolCallId: "agent-tool", title: "AGENT_BASH", kind: "execute" },
        },
        { sessionUpdate: "tool_call_update", toolCallId: "agent-tool", status: "completed" },
        { sessionUpdate: "async_task_state_update", asyncTaskId: "wf1", state: "completed" },
      ],
    }),
  });
  await postPrompt(serve.baseUrl, sessionId, "run a workflow");
  const frames = async () => (await replayFrames(serve.baseUrl, sessionId)) as ApprovalFrame[];
  const nonceOf = async () => (await frames()).find((f) => f.event?.ApprovalRequested?.approval?.nonce);
  await expect.poll(nonceOf, { timeout: 15_000, intervals: [100, 200, 500, 1000] }).toBeDefined();
  const nonce = (await nonceOf())!.event!.ApprovalRequested!.approval!.nonce!;
  expect2xx(await postAcp(serve.baseUrl, sessionId, `/approvals/${nonce}`, { decision: "Allow" }));
  await waitForReplayContains(serve.baseUrl, sessionId, "AsyncTaskStateChanged");

  const events = (await replayFrames(serve.baseUrl, sessionId)).map((f) =>
    JSON.stringify((f as { event: object }).event),
  );
  const scoped = events.filter((e) => e.startsWith('{"SubagentUpdate":{"id":"wf1"'));
  expect(scoped.some((e) => e.includes("AGENT_BASH") && e.includes("ToolCallStarted"))).toBe(true);
  expect(scoped.some((e) => e.includes("ToolCallCompleted") && e.includes("agent-tool"))).toBe(true);
  // Neither the agent's tool nor the main agent's own Workflow call leaks the wrong way.
  expect(events.some((e) => e.startsWith('{"ToolCallStarted"') && e.includes("AGENT_BASH"))).toBe(false);
  expect(events.some((e) => e.startsWith('{"ToolCallStarted"') && e.includes('"launch"'))).toBe(true);
  expect(events.some((e) => e.startsWith('{"AgentTurnStarted'))).toBe(false);
});

test("an agent-generated title renames a default-named session", async ({ spawnServe }) => {
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "Franks",
    fakeAcpScript: script(
      endTurn(chunk("Looking."), { sessionUpdate: "session_info_update", title: "Fix flaky login test" }),
    ),
  });
  await postPrompt(serve.baseUrl, sessionId, "why is login flaky");
  await expect
    .poll(async () => (await listSessions(serve.baseUrl)).find((s) => s.id === sessionId)?.title, { timeout: 15_000 })
    .toBe("Fix flaky login test");
});

// force_end_turn and user prompts are published straight to the event store, so these need no live worker.
test.describe("event store", () => {
  test("structured view/force_end_turn publishes a synthetic Stopped event", async ({ spawnServe }) => {
    const { serve, sessionId } = await seedAcpSession(spawnServe, { title: "acp-force-end" });
    expect((await postAcp(serve.baseUrl, sessionId, "/enable")).ok).toBeTruthy();
    expect((await postAcp(serve.baseUrl, sessionId, "/force_end_turn")).status).toBe(202);
    await waitForReplayContains(serve.baseUrl, sessionId, "user_forced");
  });

  test("structured view/context-primer renders the seeded turn", async ({ spawnServe }) => {
    const primerText = "primer-fixture-prompt-1224";
    const { serve, sessionId } = await seedAcpSession(spawnServe, { title: "acp-primer" });
    await postAcp(serve.baseUrl, sessionId, "/enable");
    await postPrompt(serve.baseUrl, sessionId, primerText);
    // The synthetic Stopped closes the turn so the primer renders it complete.
    await postAcp(serve.baseUrl, sessionId, "/force_end_turn");

    let highestSeq = 0;
    await expect
      .poll(
        async () => {
          const replay = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/replay?since=0`).then((r) =>
            r.json(),
          );
          const json = JSON.stringify(replay.frames);
          if (!json.includes(primerText) || !json.includes("user_forced") || replay.highest_seq === null) return false;
          highestSeq = replay.highest_seq;
          return true;
        },
        { timeout: 15_000, intervals: [100, 200, 500, 1000] },
      )
      .toBe(true);
    expect(highestSeq).toBeGreaterThan(0);

    const primerRes = await fetch(
      `${serve.baseUrl}/api/sessions/${sessionId}/acp/context-primer?before_seq=${highestSeq + 1}`,
    );
    expect(primerRes.ok).toBeTruthy();
    const primer = (await primerRes.json()) as {
      primer: string;
      included_event_count: number;
      included_turn_count: number;
      max_chars: number;
    };
    expect(primer.included_event_count).toBeGreaterThan(0);
    expect(primer.included_turn_count).toBeGreaterThanOrEqual(1);
    expect(primer.primer).toContain(primerText);
    expect(primer.max_chars).toBeGreaterThan(0);
  });

  test("structured view/replay surfaces seeded events and signals lost frames", async ({ spawnServe }) => {
    const seedEvents = 5;
    // Keep the worker stopped so startup frames cannot land between head snapshot and tail probe.
    const { serve, sessionId } = await seedAcpSession(spawnServe, { title: "acp-replay" });
    for (let i = 0; i < seedEvents; i++) {
      expect((await postAcp(serve.baseUrl, sessionId, "/force_end_turn")).status).toBe(202);
    }

    type Replay = { frames: { seq: number }[]; lost: boolean; highest_seq: number | null; lowest_seq: number | null };
    const replay = (query: string) =>
      fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/replay?${query}`).then((r) => r.json());
    let body: Replay | null = null;
    await expect
      .poll(
        async () => {
          body = (await replay("since=0")) as Replay;
          return JSON.stringify(body.frames).split('"user_forced"').length - 1;
        },
        { timeout: 15_000, intervals: [100, 200, 500, 1000] },
      )
      .toBeGreaterThanOrEqual(seedEvents);
    const full = body as Replay | null;
    expect(full).not.toBeNull();
    expect(full!.frames.length).toBeGreaterThanOrEqual(seedEvents);
    expect(full!.lowest_seq).not.toBeNull();
    expect(full!.highest_seq).not.toBeNull();
    expect(full!.lost).toBe(false);
    for (let i = 1; i < full!.frames.length; i++) {
      expect(full!.frames[i]!.seq).toBeGreaterThan(full!.frames[i - 1]!.seq);
    }

    const highest = full!.highest_seq!;
    const tail = await replay(`since=${highest}`);
    expect(tail.frames.length).toBe(0);
    expect(tail.highest_seq).toBe(highest);
    expect(tail.lost).toBe(false);

    // Following next_cursor with a small limit reassembles the unbounded transcript, capped at the snapshot head.
    const fullSeqs = full!.frames.map((f) => f.seq).filter((s) => s <= highest);
    const pageSize = 2;
    const pagedSeqs: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = (await replay(`since=${cursor}&limit=${pageSize}`)) as Replay & {
        next_cursor: number | null;
        has_more: boolean;
      };
      pages++;
      expect(page.frames.length).toBeLessThanOrEqual(pageSize);
      pagedSeqs.push(...page.frames.map((f) => f.seq).filter((s) => s <= highest));
      const next = page.next_cursor;
      if (!(page.has_more && next != null && next > cursor && next < highest)) break;
      cursor = next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(pagedSeqs).toEqual(fullSeqs);
  });
});
