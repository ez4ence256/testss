// Quêtes d'événement présentes sur le wiki mais pas (encore) dans tarkov.dev.
// Tout passe par src/api/wiki.ts (file à 1 requête par seconde, cache de 7 jours). Requêtes :
//  - la liste : « Category:Event_content » (articles) avec, pour chaque page, ses catégories
//    « Quests » / « Historical content » : 1 requête, +1 si l'API continue la liste ;
//  - le wikitext de toutes les pages retenues : 1 requête (50 titres au plus par lot).
// Ce qui est gardé en cache : les quêtes lues (objectifs en texte brut), pas le wikitext.
// Les objectifs viennent du wiki : aucune position sur la carte n'est inventée.

import type { GameMap, TarkovData, Task, Trader } from "../types";
import type { ModeState } from "../state/store";
import { baseQuestName } from "../lib/questWiki";
import { cleanInline, findSection, parseBlocks, parseInfobox, splitSections } from "../lib/wikiText";
import { pageUrlFor, readCache, wikiRequest, wikiTitleFromLink, writeCache } from "./wiki";
import eventPositions from "../data/event-positions.json";

/** Positions relevées à la main sur les images du wiki (« Titre::n° d'objectif »), voir event-positions.json. */
const POSITIONS = eventPositions as Record<string, { map: string; positions: { x: number; y?: number; z: number }[] }>;

/** Une quête d'événement lue sur le wiki (indépendante de la langue et des données tarkov.dev). */
export interface EventEntry {
  title: string;
  givenBy: string | null;
  locations: string[];
  objectives: string[];
}

interface EventCache {
  entries: EventEntry[];
  fetchedAt: number;
}

// v3 : relit la liste tout de suite (quêtes hors événement ci-dessous)
const CACHE_KEY = "events:v3";
/**
 * Quêtes ordinaires du jeu absentes de tarkov.dev (novembre 2026) et hors « Event_content » sur le wiki.
 * Lues comme les quêtes d'événement ; buildEventTasks les retire dès que tarkov.dev les a.
 */
const EXTRA_QUESTS = [
  "A Familiar Face...",
  "Scope the Clearing",
  "To the Light - Getting Acquainted",
  "To the Light - Trust but Verify",
  "To the Light - False Call",
  "To the Light - Someone Called?",
  "To the Light - The Other Side",
  "To the Light - Fallen Bird",
  "To the Light - Clip Their Wings",
  "To the Light - Bite the Dust",
  "To the Light - Dangerous Ambitions",
  "To the Light - A Time to Gather Stones",
  "To the Light - A Time to Throw Stones",
];
const BATCH = 50;
const MAX_CONTINUATIONS = 5;

/** Lecture du wikitext d'une page : infobox (marchand, lieux) + puces de « Objectives ». Null sans objectif ni infobox. */
export function parseEventQuest(title: string, wikitext: string): EventEntry | null {
  const infobox = parseInfobox(wikitext);
  const { sections } = splitSections(wikitext);
  const blocks = parseBlocks(findSection(sections, "Objectives")?.body ?? "", title);
  const objectives: string[] = [];
  // sous-titre (« Skier questline exclusive ») : il précède ses objectifs, sinon ceux des deux branches se mélangent
  let group = "";
  for (const b of blocks) {
    if (b.type === "heading") group = `(${b.text}) `;
    if (b.type === "paragraph") objectives.push(group + b.text);
    if (b.type !== "list") continue;
    // une sous-puce détaille l'objectif au-dessus : elle s'y ajoute au lieu de devenir une case à cocher
    for (const item of b.items) {
      if (item.depth > 1 && objectives.length > 0) objectives[objectives.length - 1] += `; ${item.text}`;
      else objectives.push(group + item.text);
    }
  }
  if (objectives.length === 0 && !infobox["given by"]) return null;
  return {
    title,
    givenBy: cleanInline(infobox["given by"] ?? "") || null,
    locations: cleanInline(infobox.location ?? "")
      .split(/[\n,]/)
      .map((l) => l.trim())
      .filter(Boolean),
    objectives,
  };
}

/** [A-Za-z0-9_-] seulement, stable : sert d'identifiant (validé par le serveur des rooms : [A-Za-z0-9_\-:.]{1,100}). */
export const eventSlug = (title: string) => title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "quest";

const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Tâches de l'app pour les quêtes du wiki, sans celles que tarkov.dev a déjà (nom anglais ou page wiki identique).
 * Une quête que tarkov.dev ajoute plus tard disparaît donc d'elle-même.
 */
export function buildEventTasks(entries: EventEntry[], data: Pick<TarkovData, "tasks" | "maps" | "traders">): Task[] {
  const known = new Set(data.tasks.map((t) => norm(baseQuestName(t.nameEn))));
  const knownPages = new Set(data.tasks.map((t) => wikiTitleFromLink(t.wikiLink)?.toLowerCase()).filter(Boolean));
  const trader = (name: string | null): Trader | undefined => {
    const n = name ? norm(name) : "";
    return n ? data.traders.find((t) => norm(t.normalizedName) === n || norm(t.name) === n) : undefined;
  };
  // « Infected Factory » / « Infected Lab » (Halloween) : la map de base, seule à avoir une image
  const mapOf = (name: string): GameMap | undefined => {
    const n = norm(name).replace(/^infected /, "");
    return data.maps.find((m) => [m.nameEn, m.name, m.normalizedName].some((x) => x && norm(x) === n));
  };

  return entries
    .filter((e) => !known.has(norm(e.title)) && !knownPages.has(e.title.toLowerCase()))
    .map((e): Task => {
      const slug = eventSlug(e.title);
      const mapIds = [...new Set(e.locations.map((l) => mapOf(l)?.id).filter((id): id is string => Boolean(id)))];
      const texts = e.objectives.length > 0 ? e.objectives : [e.title];
      return {
        id: `wiki-${slug}`,
        name: e.title,
        nameEn: e.title,
        normalizedName: slug.toLowerCase(),
        traderId: trader(e.givenBy)?.id ?? "",
        mapId: mapIds[0] ?? null,
        minPlayerLevel: null,
        kappaRequired: false,
        wikiLink: pageUrlFor(e.title),
        source: "wiki",
        objectives: texts.map((description, i) => {
          const pos = POSITIONS[`${e.title}::${i}`];
          const mapId = pos && data.maps.find((m) => m.normalizedName === pos.map)?.id;
          return {
            id: `wiki-${slug}-${i + 1}`,
            type: "wiki",
            description,
            optional: false,
            mapIds,
            // plusieurs positions : l'une OU l'autre (n'importe quel toit…), affichées comme emplacements possibles
            locations: mapId
              ? pos.positions.map((p) => ({ mapId, position: { x: p.x, y: p.y ?? 0, z: p.z }, ...(pos.positions.length > 1 ? { possible: true as const } : {}) }))
              : [],
          };
        }),
      };
    });
}

/**
 * Quête du wiki que tarkov.dev vient d'ajouter : l'ancien id `wiki-…` (sélection, échec, cases cochées, positions à la main)
 * est repris par le vrai id. Objectifs repris par rang (n -> n-ième objectif de tarkov.dev) ; sans équivalent : "" = à supprimer.
 * Null si rien à migrer (donc rejouable sans effet).
 */
export function wikiMigration(
  mode: Pick<ModeState, "selected" | "done" | "failed" | "manual">,
  tasks: Task[],
): { tasks: Record<string, string>; objectives: Record<string, string> } | null {
  const byOld = new Map<string, Task>();
  for (const t of tasks) {
    for (const x of [t.nameEn, baseQuestName(t.nameEn), wikiTitleFromLink(t.wikiLink)]) {
      if (x && !byOld.has(`wiki-${eventSlug(x)}`)) byOld.set(`wiki-${eventSlug(x)}`, t);
    }
  }
  const out = { tasks: {} as Record<string, string>, objectives: {} as Record<string, string> };
  const note = (id: string) => {
    const t = byOld.get(id);
    if (t) out.tasks[id] = t.id;
  };
  mode.selected.forEach((s) => note(s.taskId));
  Object.keys(mode.failed ?? {}).forEach(note);
  for (const key of [...Object.keys(mode.done), ...Object.keys(mode.manual)]) {
    const m = /^(.+)-(\d+)$/.exec(key);
    const t = m && byOld.get(m[1]);
    if (!m || !t) continue;
    out.tasks[m[1]] = t.id;
    out.objectives[key] = t.objectives[Number(m[2]) - 1]?.id ?? "";
  }
  return Object.keys(out.tasks).length ? out : null;
}

/** Pages d'événement classées « Quests », hors « Historical content » (1 requête, +1 si l'API continue). */
async function listEventPages(): Promise<string[]> {
  const pages = new Map<number, { title: string; cats: Set<string> }>();
  let cont: Record<string, string> = {};
  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const json = await wikiRequest({
      action: "query",
      generator: "categorymembers",
      gcmtitle: "Category:Event_content",
      gcmnamespace: "0",
      gcmlimit: "500",
      prop: "categories",
      cllimit: "max",
      clcategories: "Category:Quests|Category:Historical_content",
      ...cont,
    });
    const query = (json.query ?? {}) as { pages?: { pageid: number; title: string; redirect?: boolean; categories?: { title: string }[] }[] };
    for (const p of query.pages ?? []) {
      const e = pages.get(p.pageid) ?? { title: p.title, cats: new Set<string>() };
      for (const c of p.categories ?? []) e.cats.add(c.title.replace(/^Category:/, "").replace(/_/g, " ").toLowerCase());
      pages.set(p.pageid, e);
    }
    if (!json.continue) {
      return [...pages.values()].filter((p) => p.cats.has("quests") && !p.cats.has("historical content")).map((p) => p.title);
    }
    cont = json.continue as Record<string, string>;
  }
  throw new Error("wiki: liste des quêtes d'événement trop longue");
}

async function fetchEventEntries(): Promise<EventEntry[]> {
  const titles = [...new Set([...(await listEventPages()), ...EXTRA_QUESTS])];
  const entries: EventEntry[] = [];
  for (let i = 0; i < titles.length; i += BATCH) {
    const json = await wikiRequest({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: titles.slice(i, i + BATCH).join("|"),
    });
    const pages = ((json.query ?? {}) as { pages?: { title: string; revisions?: { slots?: { main?: { content?: string } } }[] }[] }).pages ?? [];
    for (const p of pages) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      const entry = content && !/^\s*#redirect/i.test(content) ? parseEventQuest(p.title, content) : null;
      if (entry) entries.push(entry);
    }
  }
  entries.sort((a, b) => a.title.localeCompare(b.title, "en"));
  writeCache(CACHE_KEY, { entries, fetchedAt: Date.now() } satisfies EventCache);
  return entries;
}

let inFlight: Promise<EventEntry[]> | null = null;

/** Quêtes d'événement du wiki : cache 7 jours, sinon 2 à 3 requêtes. */
export function loadEventEntries(): Promise<EventEntry[]> {
  const cached = readCache<EventCache>(CACHE_KEY);
  if (cached) return Promise.resolve(cached.entries);
  inFlight ??= fetchEventEntries().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
