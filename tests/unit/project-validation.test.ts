import { describe, expect, it } from "vitest";
import type { Project } from "../../src/project";
import { isLoopbackUrl, loopbackUrlError, MAX_NAME_LENGTH, resolveFolder, validateProject } from "../../src/validation";
import { fakeFs, input } from "../helpers";

const existing: Project[] = [
  { name: "Build Dashboard", slug: "build-dashboard", folder: "/work/build-dashboard", command: "npm run start", urlOverride: "", killOnClose: true, openInBrowser: false },
];
const ctx = (over = {}) => ({ fs: fakeFs(["/work/live-captions", "/work/build-dashboard"], ["/work/a-file.txt"]), existing, homeDir: "/work", ...over });

function errorsOf(over: Parameters<typeof input>[0], c = ctx()) {
  const r = validateProject(input(over), c);
  return r.ok ? {} : r.errors;
}

describe("G1 name", () => {
  it.each([
    ["empty", "", "Enter a name"],
    ["spaces only", "   ", "Enter a name"],
    ["duplicate", "Build Dashboard", "A project with this name already exists"],
    ["duplicate differing only in case", "build DASHBOARD", "A project with this name already exists"],
    ["duplicate with surrounding spaces", "  Build Dashboard  ", "A project with this name already exists"],
    ["too long", "x".repeat(MAX_NAME_LENGTH + 1), `Use ${MAX_NAME_LENGTH} characters or fewer`],
  ])("rejects %s", (_l, name, message) => {
    expect(errorsOf({ name }).name).toBe(message);
  });

  it.each([
    ["only symbols", "!!!"],
    ["unicode", "Zoë 日本語"],
    ["exactly the maximum length", "y".repeat(MAX_NAME_LENGTH)],
  ])("accepts %s", (_l, name) => {
    expect(errorsOf({ name }).name).toBeUndefined();
  });

  it("trims leading and trailing spaces from the stored name", () => {
    const r = validateProject(input({ name: "  Live Captions  " }), ctx());
    expect(r.ok && r.value.name).toBe("Live Captions");
  });

  it("an edited project is not a duplicate of itself", () => {
    const r = validateProject(input({ name: "build dashboard", folder: "/work/build-dashboard" }), ctx({ editingSlug: "build-dashboard" }));
    expect(r.ok).toBe(true);
  });
});

describe("G1 folder", () => {
  it("accepts an existing directory", () => {
    expect(errorsOf({ folder: "/work/live-captions" }).folder).toBeUndefined();
  });
  it("accepts a trailing slash and normalises it", () => {
    const r = validateProject(input({ folder: " /work/live-captions/ " }), ctx());
    expect(r.ok && r.value.folder).toBe("/work/live-captions");
  });
  it("expands ~/", () => {
    const r = validateProject(input({ folder: "~/live-captions" }), ctx({ fs: fakeFs(["/work/live-captions"]) }));
    expect(r.ok && r.value.folder).toBe("/work/live-captions");
  });
  it.each([
    ["empty", "", "Enter the project folder"],
    ["missing", "/work/nope", "This folder does not exist"],
    ["a file, not a directory", "/work/a-file.txt", "This path is a file, not a folder"],
    ["relative", "live-captions", "Enter an absolute path (or one starting with ~/)"],
  ])("rejects %s", (_l, folder, message) => {
    expect(errorsOf({ folder }).folder).toBe(message);
  });
});

describe("G1 command", () => {
  it.each([
    ["empty", ""],
    ["only whitespace", "   \t "],
  ])("rejects %s", (_l, command) => {
    expect(errorsOf({ command }).command).toBe("Enter the start command");
  });
  it("rejects a command spread over several lines (one start command per project)", () => {
    expect(errorsOf({ command: "npm install\nnpm run start" }).command).toBe("Use a single-line command");
  });
  it("trims and keeps a normal command", () => {
    const r = validateProject(input({ command: "  npm run start " }), ctx());
    expect(r.ok && r.value.command).toBe("npm run start");
  });
});

describe("G1 / F6 URL override", () => {
  it.each([
    "http://localhost:8957/x",
    "http://[::1]:8957",
    "http://127.0.0.1:8957",
    "https://127.0.0.1:8957/",
    "HTTP://LOCALHOST:3000",
    "http://127.0.0.1",
  ])("accepts %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
    expect(errorsOf({ urlOverride: url }).urlOverride).toBeUndefined();
  });

  it.each([
    ["http://example.com", "Only loopback"],
    ["ftp://127.0.0.1", "http:// or https://"],
    ["http://127.0.0.1.evil.com", "Only loopback"],
    ["http://127.0.0.1@evil.com", "Only loopback"],
    ["http://user:pw@127.0.0.1:8957", "user name or password"],
    ["javascript:alert(1)", "http:// or https://"],
    ["file:///etc/passwd", "http:// or https://"],
    ["//127.0.0.1:8957", "full URL"],
    ["/just/a/path", "full URL"],
    ["not a url", "full URL"],
    ["http://0.0.0.0:8957", "Only loopback"],
    ["http://192.168.1.5:8957", "Only loopback"],
  ])("rejects %s", (url, fragment) => {
    expect(isLoopbackUrl(url)).toBe(false);
    expect(loopbackUrlError(url)).toContain(fragment);
    expect(errorsOf({ urlOverride: url }).urlOverride).toContain(fragment);
  });

  it("an empty override is allowed (it is optional) and keeps the path of a set one", () => {
    expect(errorsOf({ urlOverride: "" }).urlOverride).toBeUndefined();
    const r = validateProject(input({ urlOverride: " http://localhost:8957/x?a=1 " }), ctx());
    expect(r.ok && r.value.urlOverride).toBe("http://localhost:8957/x?a=1");
  });
});

describe("validateProject as a whole", () => {
  it("reports every failing field at once", () => {
    const r = validateProject(input({ name: "", folder: "/nope", command: " ", urlOverride: "http://example.com" }), ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["command", "folder", "name", "urlOverride"]);
  });
  it("passes the toggles through", () => {
    const r = validateProject(input({ killOnClose: false, openInBrowser: true }), ctx());
    expect(r.ok && [r.value.killOnClose, r.value.openInBrowser]).toEqual([false, true]);
  });
});

describe("resolveFolder", () => {
  it.each([
    ["~", "/h", "/h"],
    ["~/x", "/h", "/h/x"],
    ["/a/b/../c", "/h", "/a/c"],
    ["rel/x", "/h", null],
    ["~other/x", "/h", null],
  ])("%s", (raw, home, expected) => {
    expect(resolveFolder(raw, home)).toBe(expected);
  });
});
