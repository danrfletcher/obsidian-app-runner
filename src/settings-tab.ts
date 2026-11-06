import { Modal, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { ProjectManager } from "./manager";
import { ProjectForm } from "./project-form";
import type { Project } from "./project";
import type { SettingsStore } from "./settings-store";
import type { FieldErrors } from "./validation";

/** "Stop and delete" for a running project (G3). Resolves true only on the confirm button. */
export class ConfirmStopDeleteModal extends Modal {
  private resolve: (v: boolean) => void = () => {};
  private settled = false;
  readonly result: Promise<boolean>;

  constructor(app: App, private readonly project: Project) {
    super(app);
    this.result = new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: `Stop and delete ${this.project.name}?` });
    this.contentEl.createEl("p", { text: `${this.project.name} is running. Deleting it stops the app and removes it from App Runner.` });
    const stop = this.contentEl.createEl("button", { text: "Stop and delete", cls: "mod-warning" });
    stop.addEventListener("click", () => this.settle(true));
    const cancel = this.contentEl.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.settle(false));
  }

  onClose(): void {
    this.settle(false);
  }

  private settle(v: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(v);
    this.close();
  }
}

export class AppRunnerSettingTab extends PluginSettingTab {
  private readonly form: ProjectForm;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly store: SettingsStore,
    private readonly manager: ProjectManager,
  ) {
    super(app, plugin);
    this.form = new ProjectForm(manager);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Projects").setHeading();
    if (this.store.projects.length === 0) {
      containerEl.createDiv({ cls: "setting-item-description", text: "No projects yet. Add one below." });
    }
    for (const project of this.store.projects) this.renderRow(project);
    this.renderForm();
  }

  private renderRow(project: Project): void {
    new Setting(this.containerEl)
      .setName(project.name)
      .setDesc(`${project.folder}  ·  ${project.command}${project.urlOverride ? `  ·  ${project.urlOverride}` : ""}`)
      .addToggle((t) =>
        t
          .setTooltip("Kill when all tabs closed")
          .setValue(project.killOnClose)
          .onChange((v) => this.onRowToggle(project.slug, "killOnClose", v)),
      )
      .addToggle((t) =>
        t
          .setTooltip("Open in browser")
          .setValue(project.openInBrowser)
          .onChange((v) => this.onRowToggle(project.slug, "openInBrowser", v)),
      )
      .addButton((b) =>
        b.setButtonText("Edit").onClick(() => {
          // The row was drawn from an older copy if a toggle changed since: edit what is stored now.
          this.form.startEdit(this.store.get(project.slug) ?? project);
          this.display();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Delete")
          .setWarning()
          .onClick(async () => {
            await this.manager.delete(project.slug, (p) => {
              const modal = new ConfirmStopDeleteModal(this.app, p);
              modal.open();
              return modal.result;
            });
            this.display();
          }),
      );
  }

  /**
   * A row toggle is stored at once. If that project's Edit form is open, the form takes the new value too (and is
   * redrawn so its own toggle shows it), so Save does not write the old one back.
   */
  private onRowToggle(slug: string, key: "killOnClose" | "openInBrowser", value: boolean): void {
    void this.manager.setToggle(slug, key, value);
    if (this.form.editingSlug === slug) {
      this.form.values[key] = value;
      this.display();
    }
  }

  private renderForm(): void {
    const f = this.form;
    const { containerEl } = this;
    const editing = f.editingSlug !== null;
    new Setting(containerEl).setName(editing ? "Edit project" : "Add project").setHeading();

    const errorLine = (key: keyof FieldErrors) => {
      if (f.errors[key]) containerEl.createDiv({ cls: "app-runner-error", text: f.errors[key] });
    };
    // Typing never re-renders the form, so the field being typed in keeps focus.
    new Setting(containerEl)
      .setName("Name")
      .setDesc("Shown in the command palette and as the tab title.")
      .addText((t) => t.setPlaceholder("Live Captions").setValue(f.values.name).onChange((v) => (f.values.name = v)));
    errorLine("name");
    new Setting(containerEl)
      .setName("Folder")
      .setDesc("Absolute path of the project folder.")
      .addText((t) => t.setPlaceholder("/Users/you/Developer/live-captions").setValue(f.values.folder).onChange((v) => (f.values.folder = v)));
    errorLine("folder");
    new Setting(containerEl)
      .setName("Command")
      .setDesc("The one command that starts the app.")
      .addText((t) => t.setPlaceholder("npm run start").setValue(f.values.command).onChange((v) => (f.values.command = v)));
    errorLine("command");
    new Setting(containerEl)
      .setName("URL override (optional)")
      .setDesc("A loopback URL such as http://127.0.0.1:8957. A path is kept as the page to open.")
      .addText((t) => t.setPlaceholder("http://127.0.0.1:8957").setValue(f.values.urlOverride).onChange((v) => (f.values.urlOverride = v)));
    errorLine("urlOverride");
    new Setting(containerEl)
      .setName("Kill when all tabs closed")
      .addToggle((t) => t.setValue(f.values.killOnClose).onChange((v) => (f.values.killOnClose = v)));
    new Setting(containerEl)
      .setName("Open in browser")
      .setDesc("Open the app in the default browser instead of an Obsidian tab.")
      .addToggle((t) => t.setValue(f.values.openInBrowser).onChange((v) => (f.values.openInBrowser = v)));

    new Setting(containerEl)
      .addButton((b) =>
        b
          .setButtonText(editing ? "Save" : "Add project")
          .setCta()
          .onClick(async () => {
            await f.submit();
            this.display();
          }),
      )
      .addButton((b) =>
        b.setButtonText(editing ? "Cancel" : "Clear").onClick(() => {
          f.startAdd();
          this.display();
        }),
      );
  }
}
