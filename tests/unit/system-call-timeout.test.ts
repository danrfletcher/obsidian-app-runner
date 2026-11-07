import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ file: string; options: Record<string, unknown> }> = [];

vi.mock("node:child_process", () => ({
  execFile: (file: string, _args: string[], options: Record<string, unknown>, cb: (err: Error | null, stdout?: string) => void) => {
    calls.push({ file, options });
    cb(null, "");
  },
}));

beforeEach(() => {
  calls.length = 0;
});

/** A hung `ps` or `lsof` would hold a start or a stop for ever: both are run with a timeout, which kills the child and rejects. */
describe("ps and lsof are run with a timeout", () => {
  it("realLsof", async () => {
    const { realLsof, SYSTEM_CALL_TIMEOUT_MS } = await import("../../src/port-discovery");
    await realLsof([123]);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("lsof");
    expect(calls[0].options.timeout).toBe(SYSTEM_CALL_TIMEOUT_MS);
    expect(SYSTEM_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SYSTEM_CALL_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("realProcessTable", async () => {
    const { realProcessTable } = await import("../../src/process-group");
    const { SYSTEM_CALL_TIMEOUT_MS } = await import("../../src/port-discovery");
    await realProcessTable.snapshotScoped({ pids: [123], pgids: [123] });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("ps");
    expect(calls[0].options.timeout).toBe(SYSTEM_CALL_TIMEOUT_MS);
  });
});
