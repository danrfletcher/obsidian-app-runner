import { AppRunnerView, VIEW_TYPE_APP } from "../src/webview-view";
import { launch, type Launched, type LaunchOptions } from "./plugin-harness";
import { FakeWorld, project } from "./process-fakes";
import type { WorkspaceLeaf } from "./obsidian-mock";

export const SLUG = "live-captions";
export const RESULT = { history: false };

/** Electron's window can embed `<webview>` when the custom element exists; without it the tab opens the browser instead (E18). */
export function setWebviewAvailable(on: boolean): void {
  if (on) (globalThis as { customElements?: unknown }).customElements = { get: () => class {} };
  else delete (globalThis as { customElements?: unknown }).customElements;
}

/** The real plugin on a fake process world with one project. */
export async function plugin(projectOver: Parameters<typeof project>[0] = {}, opts: LaunchOptions = {}) {
  const w = new FakeWorld(project(projectOver));
  const l = await launch(w, opts);
  return { w, l };
}

/** Run the Open command and wait until it has finished: the app answers on 8957, and the tab (or browser) is open. */
export async function openApp(w: FakeWorld, l: Launched, port = 8957): Promise<void> {
  const opening = l.plugin.openProject(SLUG);
  await w.clock.settle();
  w.serve(port);
  await w.clock.run(opening);
}

/** The tab as Obsidian builds it for a leaf: the registered view creator, then onOpen and setState from the saved state. */
export async function mountTab(l: Launched, leaf?: WorkspaceLeaf): Promise<AppRunnerView> {
  const create = l.plugin.views.get(VIEW_TYPE_APP) as (leaf: unknown) => AppRunnerView;
  const target = leaf ?? l.leaves.find((x) => x.viewState?.type === VIEW_TYPE_APP)!;
  const view = create(target);
  target.view = view;
  await view.onOpen();
  await view.setState({ slug: SLUG }, RESULT);
  return view;
}

/** Another tab on the same app, restored from its saved state, with its view mounted. */
export async function addTab(l: Launched): Promise<{ leaf: WorkspaceLeaf; view: AppRunnerView }> {
  const leaf = l.workspace.getLeaf();
  await leaf.setViewState({ type: VIEW_TYPE_APP, state: { slug: SLUG } });
  l.layoutChange();
  return { leaf, view: await mountTab(l, leaf) };
}

/** Every app tab still in the workspace. */
export const appTabs = (l: Launched) => l.leaves.filter((x) => x.viewState?.type === VIEW_TYPE_APP);

/**
 * Like `openApp`, for a registry that does real file I/O. `clock.run` fires the next fake timer whenever the promise
 * chain is quiet, and a real write is quiet for a few milliseconds, so it would run the 15 s kill timer ahead of the
 * write. Here fake time moves in small steps, with real time between them, and never past the ready wait.
 */
export async function openAppRealIo(w: FakeWorld, l: Launched, port = 8957): Promise<void> {
  const opening = l.plugin.openProject(SLUG);
  await w.clock.settle();
  w.serve(port);
  let done = false;
  void opening.finally(() => (done = true));
  for (let i = 0; !done; i++) {
    if (i > 400) throw new Error("openAppRealIo: the open never finished");
    await w.clock.advance(200);
    await new Promise((r) => setTimeout(r, 5));
  }
  await opening;
}
