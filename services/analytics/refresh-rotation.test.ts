import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resetRefreshRotation, runNextRefresh } from "@/services/analytics/refresh-rotation";

describe("background refresh rotation", () => {
  beforeEach(() => {
    resetRefreshRotation();
  });

  const task = (name: string, log: string[]) =>
    [name, async () => { log.push(name); }] as const;

  it("runs exactly one task per call", async () => {
    const log: string[] = [];
    await runNextRefresh("r", [task("a", log), task("b", log), task("c", log)]);
    // The whole point: a single call must not run the rest, because together they exceed
    // the prerender budget that `after` shares.
    assert.deepEqual(log, ["a"]);
  });

  it("advances through every task before repeating", async () => {
    const log: string[] = [];
    const tasks = [task("a", log), task("b", log), task("c", log)];
    for (let i = 0; i < 7; i++) await runNextRefresh("r", tasks);
    assert.deepEqual(log, ["a", "b", "c", "a", "b", "c", "a"]);
  });

  it("reports which task it ran", async () => {
    const log: string[] = [];
    const tasks = [task("a", log), task("b", log)];
    assert.equal(await runNextRefresh("r", tasks), "a");
    assert.equal(await runNextRefresh("r", tasks), "b");
    assert.equal(await runNextRefresh("r", tasks), "a");
  });

  it("keeps separate rotations independent", async () => {
    const log: string[] = [];
    await runNextRefresh("one", [task("one-a", log), task("one-b", log)]);
    await runNextRefresh("two", [task("two-a", log), task("two-b", log)]);
    await runNextRefresh("one", [task("one-a", log), task("one-b", log)]);
    assert.deepEqual(log, ["one-a", "two-a", "one-b"]);
  });

  it("does nothing when there is nothing to run", async () => {
    assert.equal(await runNextRefresh("r", []), null);
  });

  it("lets a failure reach the caller rather than swallowing it", async () => {
    // The page decides what a failed background refresh means; this must not decide for it.
    const boom = ["boom", () => Promise.reject(new Error("tick failed"))] as const;
    await assert.rejects(() => runNextRefresh("r", [boom]), /tick failed/);
  });

  it("still advances after a failure, so one broken task cannot block the rest", async () => {
    const log: string[] = [];
    const boom = ["boom", () => Promise.reject(new Error("x"))] as const;
    const tasks = [boom, task("b", log)];
    await assert.rejects(() => runNextRefresh("r", tasks));
    await runNextRefresh("r", tasks);
    assert.deepEqual(log, ["b"]);
  });
});
