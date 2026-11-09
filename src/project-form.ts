import { DEFAULT_INPUT, type Project, type ProjectInput } from "./project";
import type { ProjectManager } from "./manager";
import type { FieldErrors } from "./validation";

/** The state behind the Add / Edit project form, apart from the widgets that show it. */
export class ProjectForm {
  values: ProjectInput = { ...DEFAULT_INPUT };
  errors: FieldErrors = {};
  /** The slug being edited, or null when adding. */
  editingSlug: string | null = null;
  private submitting = false;

  constructor(private readonly manager: ProjectManager) {}

  startAdd(): void {
    this.values = { ...DEFAULT_INPUT };
    this.errors = {};
    this.editingSlug = null;
  }

  /** A project was deleted: if it is the one being edited the form goes back to Add, so Save cannot target a project that is gone. */
  projectDeleted(slug: string): void {
    if (this.editingSlug === slug) this.startAdd();
  }

  startEdit(project: Project): void {
    this.values = {
      name: project.name,
      folder: project.folder,
      command: project.command,
      urlOverride: project.urlOverride,
      killOnClose: project.killOnClose,
      openInBrowser: project.openInBrowser,
    };
    this.errors = {};
    this.editingSlug = project.slug;
  }

  /**
   * Add or save. Returns true when the project was stored (the form is then reset); false with `errors` filled in
   * otherwise. A call made while an earlier one is still being saved is ignored.
   */
  async submit(): Promise<boolean> {
    if (this.submitting) return false;
    this.submitting = true;
    try {
      const result =
        this.editingSlug === null
          ? await this.manager.add(this.values)
          : await this.manager.edit(this.editingSlug, this.values);
      if (!result.ok) {
        this.errors = result.errors;
        return false;
      }
      this.startAdd();
      return true;
    } finally {
      this.submitting = false;
    }
  }
}
