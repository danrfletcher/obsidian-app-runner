import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "../../src/main";

/**
 * E18, F8: `openExternal` is the real opener the plugin hands to the instance manager. It tries Electron's shell first
 * and falls back to `window.open`. These run it against a stand-in `window`, so each branch is the real code.
 */
const URL_ = "http://127.0.0.1:8957/";

function stubWindow(w: { require?: (m: string) => unknown; open: (url: string, target: string) => unknown }) {
  vi.stubGlobal("window", w);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openExternal", () => {
  it("uses Electron's shell when window.require('electron') has one, and does not touch window.open", async () => {
    const opened: string[] = [];
    const winOpen = vi.fn();
    const requested: string[] = [];
    stubWindow({
      require: (m) => {
        requested.push(m);
        return { shell: { openExternal: async (u: string) => void opened.push(u) } };
      },
      open: winOpen,
    });
    await openExternal(URL_);
    expect(requested).toEqual(["electron"]);
    expect(opened).toEqual([URL_]);
    expect(winOpen).not.toHaveBeenCalled();
  });

  it("a shell that rejects rejects the call (the caller shows a notice) and does not fall back to window.open", async () => {
    const winOpen = vi.fn();
    stubWindow({
      require: () => ({ shell: { openExternal: () => Promise.reject(new Error("no default browser")) } }),
      open: winOpen,
    });
    await expect(openExternal(URL_)).rejects.toThrow("no default browser");
    expect(winOpen).not.toHaveBeenCalled();
  });

  it("a shell that throws synchronously also rejects the call", async () => {
    stubWindow({
      require: () => ({
        shell: {
          openExternal: () => {
            throw new Error("boom");
          },
        },
      }),
      open: vi.fn(),
    });
    await expect(openExternal(URL_)).rejects.toThrow("boom");
  });

  it("window.require throwing (electron not reachable) falls back to window.open in a new tab", async () => {
    const winOpen = vi.fn();
    stubWindow({
      require: () => {
        throw new Error("Cannot find module 'electron'");
      },
      open: winOpen,
    });
    await openExternal(URL_);
    expect(winOpen).toHaveBeenCalledTimes(1);
    expect(winOpen).toHaveBeenCalledWith(URL_, "_blank");
  });

  it("electron without a shell falls back to window.open", async () => {
    const winOpen = vi.fn();
    stubWindow({ require: () => ({}), open: winOpen });
    await openExternal(URL_);
    expect(winOpen).toHaveBeenCalledWith(URL_, "_blank");
  });

  it("no window.require at all falls back to window.open", async () => {
    const winOpen = vi.fn();
    stubWindow({ open: winOpen });
    await openExternal(URL_);
    expect(winOpen).toHaveBeenCalledWith(URL_, "_blank");
  });
});
