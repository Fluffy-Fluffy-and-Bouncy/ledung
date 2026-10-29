// Searching Settings (issue #367, mockup F): one box above every tab's side menu finds a setting on any tab (Ledung,
// Chats and each project) by its name, its explanation, its group's name or a keyword ("phone" finds Remote access).
// Pure, over the lists in settingsGroups.ts, so the matching is tested against a fixed list.
import type { ProjectInfo } from '../../src/shared/protocol.ts';
import { CHATS_GROUPS, LEDUNG_GROUPS, PROJECT_GROUPS, groupView, tabGroupView, type SettingsGroup, type StoredIn } from './settingsGroups.ts';

/** A tab as search reads it: its groups, and the view that opens one of them. */
export interface SearchTab {
  /** As tabOf gives it: "ledung", "chats", "ps:<project>". */
  id: string;
  label: string;
  groups: SettingsGroup[];
  viewOf: (group: string) => string;
}

export interface SettingHit {
  tab: string;
  tabLabel: string;
  group: string;
  groupLabel: string;
  label: string;
  about?: string;
  storedIn?: StoredIn;
  /** The view that opens its group. */
  view: string;
}

/** The tabs search reads, in the tabs' order: Ledung, Chats, then each project. */
export function searchTabs(projects: Pick<ProjectInfo, 'name'>[]): SearchTab[] {
  return [
    { id: 'ledung', label: 'Ledung', groups: LEDUNG_GROUPS, viewOf: groupView },
    { id: 'chats', label: 'Chats', groups: CHATS_GROUPS, viewOf: (g) => tabGroupView(null, g) },
    ...projects.map((p) => ({ id: `ps:${p.name}`, label: p.name, groups: PROJECT_GROUPS, viewOf: (g: string) => tabGroupView(p.name, g) })),
  ];
}

/** Lower case, accents off, anything but letters and digits a space: "Chats' names" and "chats names" are alike. */
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const words = (s: string): string[] => normalize(s).split(' ').filter(Boolean);

/** How much a word found in each place counts: the name most, its explanation least. */
const WEIGHT = { label: 4, keyword: 3, group: 2, about: 1 } as const;

/**
 * The settings every word of `query` begins a word of (in the name, a keyword, the group's name or the explanation),
 * best first: the name before a keyword, a keyword before the explanation, and the whole query inside the name before
 * that. Ties keep the tabs' order, with the `current` tab first. Empty for an empty query.
 */
export function matchSettings(query: string, tabs: SearchTab[], current: string | null = null): SettingHit[] {
  const want = words(query);
  if (!want.length) return [];
  const phrase = want.join(' ');
  const found: { hit: SettingHit; score: number; order: number }[] = [];
  const ordered = [...tabs.filter((t) => t.id === current), ...tabs.filter((t) => t.id !== current)];
  let order = 0;
  for (const tab of ordered) {
    for (const g of tab.groups) {
      const groupWords = words(g.label);
      for (const s of g.settings) {
        order++;
        const places: [number, string[]][] = [
          [WEIGHT.label, words(s.label)], [WEIGHT.keyword, (s.keywords ?? []).flatMap(words)], [WEIGHT.group, groupWords], [WEIGHT.about, words(s.about ?? '')],
        ];
        let score = 0;
        for (const w of want) {
          const best = Math.max(0, ...places.filter(([, ws]) => ws.some((x) => x.startsWith(w))).map(([weight]) => weight));
          if (!best) { score = 0; break; }
          score += best;
        }
        if (!score) continue;
        const name = normalize(s.label);
        if (name === phrase) score += 10;
        else if (` ${name} `.includes(` ${phrase}`)) score += 5;
        found.push({
          hit: { tab: tab.id, tabLabel: tab.label, group: g.id, groupLabel: g.label, label: s.label, about: s.about, storedIn: s.storedIn, view: tab.viewOf(g.id) },
          score, order,
        });
      }
    }
  }
  return found.sort((a, b) => b.score - a.score || a.order - b.order).map((f) => f.hit);
}

/** Search every tab of Settings: Ledung, Chats and each project. */
export const searchSettings = (query: string, projects: Pick<ProjectInfo, 'name'>[], current: string | null): SettingHit[] =>
  matchSettings(query, searchTabs(projects), current);
