import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POP_OUT_COMMAND_ID } from "../../src/commands";
import { HELD_OPENED_IN_BROWSER } from "../../src/held";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { appTabs, mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";
import type { FakeWorld } from "../process-fakes";
import type { Launched } from "../plugin-harness";

/**
 * Every Held transition in G12 for this PR, through the real plugin (instance manager, tabs, kill timer, registry):
 * what sets Held, what clears it, and that nothing else does. The registry is the FakeRegistry, which keeps the entry
 * through a JSON round trip, so `persisted` is what a relaunch would read.
 */

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

type Rig = { w: FakeWorld; l: Launched };

const held = ({ l }: Rig) => l.plugin.instances.isHeld(SLUG);
const persisted = ({ w }: Rig) => w.registry.entries.get(SLUG);

/** Each way an app gets started in a state to be Held (or not). */
const starts: Array<{ name: string; make: () => Promise<Rig> }> = [
  {
    name: "running with a tab",
    make: async () => {
      const r = await plugin({});
      await openApp(r.w, r.l);
      return r;
    },
  },
];

describe("what sets Held", () => {
  const setters: Array<{ name: string; make: () => Promise<Rig>; reason: string }> = [
    {
      name: "Pop out from the tab",
      reason: HELD_OPENED_IN_BROWSER,
      make: async () => {
        const r = await starts[0].make();
        await (await mountTab(r.l)).popOut();
        return r;
      },
    },
    {
      name: "Pop out through the global command",
      reason: HELD_OPENED_IN_BROWSER,
      make: async () => {
        const r = await starts[0].make();
        const view = await mountTab(r.l);
        r.l.workspace.activeView = view;
        r.l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
        await r.w.clock.settle();
        return r;
      },
    },
    {
      name: "Open in browser on a cold start",
      reason: HELD_OPENED_IN_BROWSER,
      make: async () => {
        const r = await plugin({ openInBrowser: true });
        await openApp(r.w, r.l);
        return r;
      },
    },
    {
      name: "Open in browser with the app already running",
      reason: HELD_OPENED_IN_BROWSER,
      make: async () => {
        const r = await starts[0].make();
        await r.l.plugin.manager.setToggle(SLUG, "openInBrowser", true);
        await r.l.plugin.openProject(SLUG);
        return r;
      },
    },
  ];

  for (const s of setters) {
    it(`${s.name}: Held, with the reason, saved in the registry entry, browser flag set`, async () => {
      const r = await s.make();
      expect(held(r)).toBe(true);
      expect(persisted(r)).toMatchObject({ held: true, heldReason: s.reason, browserSessionExpected: true });
      expect(r.l.plugin.instances.snapshots()[0]).toMatchObject({ held: true, heldReason: s.reason });
      expect(r.w.external).toHaveLength(1);
    });
  }

  it("a plain Open into a tab does not set Held, and the entry carries no Held fields", async () => {
    const r = await starts[0].make();
    expect(held(r)).toBe(false);
    expect(persisted(r)).toBeDefined();
    expect(persisted(r)).not.toHaveProperty("held");
    expect(persisted(r)).not.toHaveProperty("heldReason");
    expect(persisted(r)?.browserSessionExpected).toBe(false);
    expect(r.w.external).toEqual([]);
  });
});

describe("what clears Held", () => {
  const heldRig = async (): Promise<Rig> => {
    const r = await plugin({ openInBrowser: true });
    await openApp(r.w, r.l);
    expect(held(r)).toBe(true);
    return r;
  };

  const enders: Array<{ name: string; end: (r: Rig) => Promise<void> }> = [
    {
      name: "Stop (command)",
      end: async ({ w, l }) => {
        await w.clock.run(l.plugin.stopProject(SLUG));
      },
    },
    {
      name: "Stop (list button)",
      end: async ({ w, l }) => {
        l.tab.display();
        l.rows()[0].buttons.find((b) => b.text === "Stop")!.handler!();
        await w.clock.advance(2000);
      },
    },
    {
      name: "a crash",
      end: async ({ w }) => {
        w.procs = [];
        w.children.get(w.leaderPid())!.exit(1);
        await w.clock.settle();
      },
    },
    {
      name: "deleting the project",
      end: async ({ w, l }) => {
        const deleting = l.plugin.manager.delete(SLUG, async () => true);
        await w.clock.run(deleting);
      },
    },
  ];

  for (const e of enders) {
    it(`${e.name} ends the instance, drops its entry and clears Held`, async () => {
      const r = await heldRig();
      await e.end(r);
      expect(r.l.plugin.instances.stateOf(SLUG)).toBe("none");
      expect(held(r)).toBe(false);
      expect(persisted(r)).toBeUndefined();
      expect(r.l.plugin.instances.snapshots()).toEqual([]);
    });
  }

  it("a new instance after the end starts not Held", async () => {
    const r = await heldRig();
    await r.w.clock.run(r.l.plugin.stopProject(SLUG));
    await r.l.plugin.manager.setToggle(SLUG, "openInBrowser", false);
    await openApp(r.w, r.l);
    expect(held(r)).toBe(false);
    expect(persisted(r)).not.toHaveProperty("held");
  });
});

describe("what never clears Held (G14, no timer)", () => {
  const waits = [14_999, 15_000, 30_000, 45_000, 10 * 60_000, 60 * 60_000];
  for (const ms of waits) {
    it(`${ms} ms with zero tabs and Kill on: still running, still Held, nothing signalled, entry unchanged`, async () => {
      const r = await plugin({ openInBrowser: true });
      await openApp(r.w, r.l);
      const before = JSON.stringify(persisted(r));
      r.l.layoutReady();
      await r.w.clock.advance(ms);
      expect(r.l.plugin.instances.stateOf(SLUG)).toBe("running");
      expect(held(r)).toBe(true);
      expect(r.w.signals).toEqual([]);
      expect(JSON.stringify(persisted(r))).toBe(before);
      expect(r.l.plugin.killTimer.pendingCount).toBe(0);
    });
  }

  it("closing the last tab of a Held app, and opening and closing another, leaves it running and Held", async () => {
    const r = await plugin({});
    await openApp(r.w, r.l);
    await (await mountTab(r.l)).popOut();
    expect(appTabs(r.l)).toEqual([]);
    r.l.plugin.sessions.refresh();
    await openApp(r.w, r.l); // Open again: a tab (setting is off)
    expect(appTabs(r.l)).toHaveLength(1);
    r.l.leaves.splice(0);
    r.l.layoutChange();
    await r.w.clock.advance(5 * 60_000);
    expect(r.l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(held(r)).toBe(true);
    expect(r.w.signals).toEqual([]);
  });

  it("turning Open in browser off, or Kill on close on or off, does not clear it", async () => {
    const r = await plugin({ openInBrowser: true });
    await openApp(r.w, r.l);
    await r.l.plugin.manager.setToggle(SLUG, "openInBrowser", false);
    await r.l.plugin.manager.setToggle(SLUG, "killOnClose", false);
    await r.l.plugin.manager.setToggle(SLUG, "killOnClose", true);
    await r.w.clock.advance(60_000);
    expect(held(r)).toBe(true);
    expect(r.l.plugin.instances.stateOf(SLUG)).toBe("running");
  });

  it("setting Held again with the same reason changes nothing and writes nothing", async () => {
    const r = await plugin({ openInBrowser: true });
    await openApp(r.w, r.l);
    const sets = r.w.registry.sets;
    r.l.plugin.instances.setHeld(SLUG, true, HELD_OPENED_IN_BROWSER);
    await r.w.clock.settle();
    expect(r.w.registry.sets).toBe(sets);
  });

  it("Held on nothing running is ignored", async () => {
    const r = await plugin({});
    r.l.plugin.instances.setHeld(SLUG, true, HELD_OPENED_IN_BROWSER);
    await r.w.clock.settle();
    expect(held(r)).toBe(false);
    expect(persisted(r)).toBeUndefined();
  });
});
