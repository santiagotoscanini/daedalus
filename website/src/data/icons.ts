/** The vendored marks, by service id: URLs only, so importing this costs nothing until one is fetched. */
const urls = import.meta.glob("../assets/icons/*", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

const byId = new Map<string, string>();
for (const [path, url] of Object.entries(urls)) {
  const file = path.split("/").pop() ?? "";
  byId.set(file.replace(/\.[^.]+$/, ""), url);
}

export function iconUrl(id: string): string {
  const u = byId.get(id);
  if (!u) throw new Error(`no icon vendored for ${id}`);
  return u;
}
