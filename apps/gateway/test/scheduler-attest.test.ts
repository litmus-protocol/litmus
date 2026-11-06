import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/context";
import type { CreAttestSettings } from "../src/jobs/cre-attest";
import { Scheduler, type Attester } from "../src/jobs/scheduler";

const SETTINGS = { bin: "cre", workflowDir: "/x", hederaRpcUrl: "", sepoliaRpcUrl: "", gasLimit: "1", maxAttempts: 3, runTimeoutMs: 1 } as CreAttestSettings;

function setup(opts: { enabled?: boolean; tick?: () => Promise<void>; pending?: () => Promise<number[]> } = {}) {
  const logs: string[] = [];
  const calls = { tick: 0, pending: 0 };
  const attester: Attester = {
    tick: async () => {
      calls.tick++;
      await opts.tick?.();
    },
    pending: async () => {
      calls.pending++;
      return (await opts.pending?.()) ?? [];
    },
  };
  const ctx = { settings: { creAttest: opts.enabled === false ? null : SETTINGS }, log: (m: string) => logs.push(m) } as unknown as Ctx;
  const scheduler = new Scheduler(ctx, () => attester);
  return { scheduler, calls, logs };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("event-driven CRE auto-attest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing when auto-attest is off", async () => {
    const { scheduler, calls } = setup({ enabled: false });
    scheduler.attestSoon();
    await flush();
    expect(calls.tick).toBe(0);
  });

  it("runs the auditor when a finalization event arrives, and sets no retry when nothing is left", async () => {
    const { scheduler, calls, logs } = setup();
    scheduler.attestSoon();
    await flush();
    expect(calls.tick).toBe(1);
    expect(calls.pending).toBe(1);
    expect(logs.some((l) => l.includes("retrying"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no polling timer: it only runs on events
  });

  it("coalesces events that arrive during a run into exactly one more pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { scheduler, calls } = setup({ tick: () => (calls.tick === 1 ? gate : Promise.resolve()) });
    scheduler.attestSoon();
    scheduler.attestSoon();
    scheduler.attestSoon();
    await flush();
    expect(calls.tick).toBe(1);
    release();
    await flush();
    expect(calls.tick).toBe(2);
  });

  it("runs again for an event that arrives while the final pending check is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first pending() check is slow and reports nothing left, as if it read the table just before a finalize.
    const { scheduler, calls } = setup({ pending: async () => (calls.pending === 1 ? (await gate, []) : []) });
    scheduler.attestSoon();
    await flush();
    expect(calls.tick).toBe(1);
    scheduler.attestSoon(); // the finalize event
    release();
    await flush();
    expect(calls.tick).toBe(2);
  });

  it("schedules one backoff retry (30s, then 60s) while work is still pending, and an event cancels it", async () => {
    const { scheduler, calls, logs } = setup({ pending: async () => [9] });
    scheduler.attestSoon();
    await flush();
    expect(calls.tick).toBe(1);
    expect(logs.at(-1)).toContain("retrying in 30s");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(calls.tick).toBe(2);
    expect(logs.at(-1)).toContain("retrying in 60s");

    scheduler.attestSoon(); // a new event cancels the pending retry and runs now
    await flush();
    expect(calls.tick).toBe(3);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a thrown error and retries instead of dying", async () => {
    const { scheduler, calls, logs } = setup({
      tick: async () => {
        throw new Error("rpc down");
      },
    });
    scheduler.attestSoon();
    await flush();
    expect(logs.some((l) => l.includes("failed: rpc down"))).toBe(true);
    expect(logs.at(-1)).toContain("retrying in 30s");
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(calls.tick).toBe(2);
    scheduler.stop();
  });

  it("sweeps once at startup for contests finalized while the gateway was down", async () => {
    const { scheduler, calls } = setup();
    scheduler.start();
    await flush();
    expect(calls.tick).toBe(1);
    scheduler.stop();
  });
});
