/** The registry's data model. One start command per project: there is no env, Docker or multi-command field. */
export interface Project {
  name: string;
  /** Fixed at creation (see slug.ts); command ids derive from it and a rename never changes it. */
  slug: string;
  folder: string;
  command: string;
  /** An http(s) loopback URL, optionally with a path. Empty string means none. */
  urlOverride: string;
  killOnClose: boolean;
  openInBrowser: boolean;
}

/** What the Add / Edit form submits. */
export interface ProjectInput {
  name: string;
  folder: string;
  command: string;
  urlOverride: string;
  killOnClose: boolean;
  openInBrowser: boolean;
}

export const FORM_FIELDS = ["name", "folder", "command", "urlOverride", "killOnClose", "openInBrowser"] as const;

export const DEFAULT_INPUT: ProjectInput = {
  name: "",
  folder: "",
  command: "",
  urlOverride: "",
  killOnClose: true,
  openInBrowser: false,
};
