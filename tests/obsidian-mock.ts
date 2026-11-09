/** Minimal stand-in for the `obsidian` module: just what src/ touches. No real Obsidian, process or window is involved. */

export class Notice {
  static messages: string[] = [];
  constructor(public message: string, _timeout?: number) {
    Notice.messages.push(message);
  }
  static reset(): void {
    Notice.messages = [];
  }
}

/** Tests flip these to prove platform behaviour. */
export const Platform = { isDesktopApp: true, isMacOS: true };

/** A tiny DOM node: enough for views, modals and the settings tab to be driven in tests. */
export class FakeNode {
  children: FakeNode[] = [];
  text = "";
  cls?: string;
  attrs: Record<string, string> = {};
  /** Settings drawn into this element since it was last emptied: what a user would see there now. */
  settings: Setting[] = [];
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public tag: string) {}
  createEl(tag: string, o: { text?: string; cls?: string } = {}): FakeNode {
    const n = new FakeNode(tag);
    n.text = o.text ?? "";
    n.cls = o.cls;
    this.children.push(n);
    return n;
  }
  createDiv(o: { text?: string; cls?: string } = {}): FakeNode {
    return this.createEl("div", o);
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  empty(): void {
    this.children = [];
    this.settings = [];
    this.text = "";
  }
  addEventListener(name: string, fn: () => void): void {
    (this.listeners[name] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }
  all(): FakeNode[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent())].filter(Boolean).join("\n");
  }
}

export class WorkspaceLeaf {
  viewState: { type?: string; state?: unknown } | null = null;
  detached = false;
  /** The view this leaf holds, when a test attaches one. */
  view: unknown = null;
  async setViewState(s: { type: string; state?: unknown }): Promise<void> {
    this.viewState = s;
  }
  getViewState(): { type?: string; state?: unknown } {
    return this.viewState ?? {};
  }
  detach(): void {
    this.detached = true;
  }
}

export type ViewStateResult = Record<string, unknown>;

export class ItemView {
  contentEl = new FakeNode("div");
  /** Header actions added with `addAction`: what a user would see as buttons in the tab header. */
  actions: Array<{ icon: string; title: string; click: () => void }> = [];
  constructor(public leaf: WorkspaceLeaf) {}
  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  addAction(icon: string, title: string, callback: () => void): FakeNode {
    this.actions.push({ icon, title, click: callback });
    return new FakeNode("div");
  }
  onPaneMenu(_menu: unknown, _source: string): void {}
}

/** A menu that records its items, so a test can read the titles and click one. */
export class FakeMenu {
  items: Array<{ title: string; icon: string; section: string; click: () => void }> = [];
  addItem(cb: (item: unknown) => unknown): this {
    const item = { title: "", icon: "", section: "", click: () => {} };
    const api = {
      setTitle: (t: string) => ((item.title = t), api),
      setIcon: (i: string) => ((item.icon = i), api),
      setSection: (s: string) => ((item.section = s), api),
      onClick: (fn: () => void) => ((item.click = fn), api),
    };
    cb(api);
    this.items.push(item);
    return this;
  }
}

export class Modal {
  static opened: Modal[] = [];
  static reset(): void {
    Modal.opened = [];
  }
  contentEl = new FakeNode("div");
  closed = false;
  constructor(public app: unknown) {}
  open(): void {
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

interface MockControl {
  tooltip?: string;
  warning?: boolean;
  cta?: boolean;
  text: string;
  placeholder: string;
  value: string | boolean;
  disabled: boolean;
  handler: ((v?: any) => unknown) | null;
  [method: string]: unknown;
}

function control(kind: "text" | "toggle" | "button"): MockControl {
  const c: MockControl = { text: "", placeholder: "", value: kind === "toggle" ? false : "", disabled: false, handler: null };
  c.setPlaceholder = (v: string) => ((c.placeholder = v), c);
  c.setValue = (v: string | boolean) => ((c.value = v), c);
  c.setTooltip = (v: string) => ((c.tooltip = v), c);
  c.onChange = (fn: (v: any) => unknown) => ((c.handler = fn), c);
  c.setButtonText = (v: string) => ((c.text = v), c);
  c.setWarning = () => ((c.warning = true), c);
  c.setCta = () => ((c.cta = true), c);
  c.setDisabled = (v: boolean) => ((c.disabled = v), c);
  c.onClick = (fn: () => unknown) => ((c.handler = fn), c);
  return c;
}

export class Setting {
  static all: Setting[] = [];
  static reset(): void {
    Setting.all = [];
  }
  name = "";
  desc = "";
  heading = false;
  texts: MockControl[] = [];
  toggles: MockControl[] = [];
  buttons: MockControl[] = [];
  constructor(public containerEl: unknown) {
    Setting.all.push(this);
    if (containerEl instanceof FakeNode) containerEl.settings.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addText(cb: (t: unknown) => unknown): this {
    const c = control("text");
    cb(c);
    this.texts.push(c);
    return this;
  }
  addToggle(cb: (t: unknown) => unknown): this {
    const c = control("toggle");
    cb(c);
    this.toggles.push(c);
    return this;
  }
  addButton(cb: (b: unknown) => unknown): this {
    const c = control("button");
    cb(c);
    this.buttons.push(c);
    return this;
  }
}

export class PluginSettingTab {
  containerEl = new FakeNode("div");
  constructor(public app: unknown, public plugin: unknown) {}
}

export interface MockCommand {
  id: string;
  name: string;
  callback?: () => void;
}

export class Plugin {
  /** Commands as the plugin registered them, by bare id (Obsidian adds the `<plugin id>:` prefix itself). */
  commands = new Map<string, MockCommand>();
  views = new Map<string, unknown>();
  settingTabs: unknown[] = [];
  /** Every method name a test would use to detect forbidden surfaces being called. */
  forbiddenCalls: string[] = [];
  stored: unknown = null;
  constructor(public app: any, public manifest: { id: string; name?: string }) {}
  async loadData(): Promise<unknown> {
    return this.stored;
  }
  async saveData(data: unknown): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(data));
  }
  addCommand(c: MockCommand): MockCommand {
    this.commands.set(c.id, c);
    return c;
  }
  removeCommand(id: string): void {
    this.commands.delete(id);
  }
  registerEvent(): void {}
  registerView(type: string, creator: unknown): void {
    this.views.set(type, creator);
  }
  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }
  addRibbonIcon(): void {
    this.forbiddenCalls.push("addRibbonIcon");
  }
  addStatusBarItem(): void {
    this.forbiddenCalls.push("addStatusBarItem");
  }
  registerObsidianProtocolHandler(): void {
    this.forbiddenCalls.push("registerObsidianProtocolHandler");
  }
}

export type App = unknown;
