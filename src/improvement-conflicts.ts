import type { Page, Task } from "./types.js";
import { entityKey } from "./sources.js";
const clean = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
/** Conservative SUUMO cross-listing check; uncertain duplicate rooms are not counted twice. */
export function roomIdentity(p: Page): string | undefined {
  if (!entityKey(p.url)?.startsWith("suumo:")) return;
  const name = p.title.replace(/^【SUUMO】/, "").split(/ - |／|（/)[0];
  const text = p.text.slice(0, 5500);
  const address = text.match(/所在地\s*\n([^\n]+)/)?.[1];
  const area = text.match(/専有面積\s*(\d+(?:\.\d+)?)\s*m2/)?.[1];
  const layout = text.match(/間取り\s*([1-9][LDKRS]+)/)?.[1];
  const rent = text.match(/(?:^|\n)(\d+(?:\.\d+)?)万円/)?.[1];
  return name && address && area && layout && rent
    ? [name, address, area, layout, rent].map(clean).join("|")
    : undefined;
}
export function roomConflicts(task: Task) {
  const byIdentity = new Map<string, Page[]>();
  for (const p of task.pages) {
    const key = roomIdentity(p);
    if (!key) continue;
    const group = byIdentity.get(key) ?? [];
    group.push(p);
    byIdentity.set(key, group);
  }
  const duplicateUrls = new Set<string>(),
    stationConflicts = new Map<string, string[]>();
  for (const pages of byIdentity.values()) {
    const candidates = (task.answer?.candidates ?? []).filter((c) =>
      pages.some((p) => p.url === c.url),
    );
    if (new Set(candidates.map((c) => entityKey(c.url))).size > 1)
      candidates.forEach((c) => duplicateUrls.add(c.url));
    for (const c of candidates) {
      for (const criterion of task.criteria.filter((c) => c.required)) {
        const station =
          criterion.description.match(/[一-龯ぁ-んァ-ヶー]{2,12}駅/)?.[0];
        if (!station) continue;
        const minutes = new Set(
          pages.flatMap((p) =>
            [
              ...p.text
                .slice(0, 5500)
                .matchAll(
                  new RegExp(
                    station + "[^\\n]{0,40}?(?:徒歩|歩)\\s*(\\d+)分",
                    "g",
                  ),
                ),
            ].map((m) => m[1]),
          ),
        );
        if (minutes.size > 1) {
          const fields = stationConflicts.get(c.url) ?? [];
          fields.push(criterion.id);
          stationConflicts.set(c.url, fields);
        }
      }
    }
  }
  return { duplicateUrls, stationConflicts };
}
