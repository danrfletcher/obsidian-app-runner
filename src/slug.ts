/**
 * The slug rule: lowercase the name, turn every run of non-alphanumerics into one hyphen, trim hyphens off both ends.
 * Accents are folded (Café becomes cafe); a name with nothing left (empty, only symbols, only non-Latin letters)
 * becomes `app`.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "app" : slug;
}

/** `base`, or `base-2`, `base-3`, ... the first one no existing slug uses. */
export function uniqueSlug(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The slug for a new project's name, suffixed when it clashes. A rename never calls this: slugs are fixed at creation. */
export function slugForNewProject(name: string, existingSlugs: Iterable<string>): string {
  return uniqueSlug(slugify(name), existingSlugs);
}

export function openCommandId(slug: string): string {
  return `open-${slug}`;
}

export function stopCommandId(slug: string): string {
  return `stop-${slug}`;
}
