// Quêtes du wiki absentes de tarkov.dev (événements, Arena exclue, chaîne Lightkeeper…).
// Tout passe par src/api/wiki.ts (file à 1 requête par seconde). Requêtes, au plus toutes les 6 h :
//  - la liste : « Category:Quests » (articles) avec le drapeau « Historical content » : 2 requêtes (500 pages max chacune) ;
//  - le wikitext des seules pages listées que tarkov.dev n'a pas et qu'on n'a pas déjà lues (lots de 50 titres).
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
  listed: string[];
  /** pages « Historical content » (retirées du jeu) ; absent des caches d'avant v5 */
  historical?: string[];
  listedAt: number;
  /** nombre de pages de la liste précédente (garde-fou de vanishedWikiIds) */
  prevCount: number | null;
  /** lues par titre, cumulées d'une fois sur l'autre ; null = lue sans résultat (redirection, Arena…), pas relue */
  entries: Record<string, EventEntry | null>;
  fetchedAt: number;
}

// v5 : liste « Category:Quests », entrées cumulées par titre, + titres historiques
const CACHE_KEY = "events:v5";
const LIST_TTL_MS = 6 * 3600_000;
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

/** Clés (`norm`) des quêtes que tarkov.dev a déjà : nom de base, nom anglais, page wiki. Même appariement que wikiMigration. */
export function knownQuestKeys(tasks: Pick<Task, "nameEn" | "wikiLink">[]): Set<string> {
  const keys = new Set<string>();
  for (const t of tasks) for (const x of [baseQuestName(t.nameEn), t.nameEn, wikiTitleFromLink(t.wikiLink)]) if (x) keys.add(norm(x));
  return keys;
}

/**
 * Tâches de l'app pour les quêtes du wiki, sans celles que tarkov.dev a déjà (nom anglais ou page wiki identique).
 * Une quête que tarkov.dev ajoute plus tard disparaît donc d'elle-même.
 */
export function buildEventTasks(entries: EventEntry[], data: Pick<TarkovData, "tasks" | "maps" | "traders">): Task[] {
  const known = knownQuestKeys(data.tasks);
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
    .filter((e) => !known.has(norm(e.title)))
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
 * est repris par le vrai id. Appariement par `norm` comme le dédoublonnage de buildEventTasks (tout ce qu'il masque est migré).
 * Objectifs repris par rang (n -> n-ième objectif de tarkov.dev) ; sans équivalent : "" = à supprimer.
 * Quête wiki entièrement faite (`wikiObjectiveCounts` : id -> nb d'objectifs wiki) : tous les vrais objectifs sont cochés (`tick`).
 * Null si rien à migrer (donc rejouable sans effet).
 */
export function wikiMigration(
  mode: Pick<ModeState, "selected" | "done" | "failed" | "manual">,
  tasks: Task[],
  wikiObjectiveCounts?: Record<string, number>,
): { tasks: Record<string, string>; objectives: Record<string, string>; tick: Record<string, number> } | null {
  const byName = new Map<string, Task>();
  for (const t of tasks) {
    for (const x of [baseQuestName(t.nameEn), t.nameEn, wikiTitleFromLink(t.wikiLink)]) {
      const k = x ? norm(x) : "";
      if (k && !byName.has(k)) byName.set(k, t);
    }
  }
  const find = (id: string) => (id.startsWith("wiki-") ? byName.get(norm(id.slice(5).replace(/-/g, " "))) : undefined);
  const out = { tasks: {} as Record<string, string>, objectives: {} as Record<string, string>, tick: {} as Record<string, number> };
  const note = (id: string) => {
    const t = find(id);
    if (t) out.tasks[id] = t.id;
  };
  mode.selected.forEach((s) => note(s.taskId));
  Object.keys(mode.failed ?? {}).forEach(note);
  for (const key of [...Object.keys(mode.done), ...Object.keys(mode.manual)]) {
    const m = /^(.+)-(\d+)$/.exec(key);
    const t = m && find(m[1]);
    if (!m || !t) continue;
    out.tasks[m[1]] = t.id;
    out.objectives[key] = t.objectives[Number(m[2]) - 1]?.id ?? "";
  }
  for (const [oldId, newId] of Object.entries(out.tasks)) {
    const n = wikiObjectiveCounts?.[oldId];
    const stamps = n ? Array.from({ length: n }, (_, i) => mode.done[`${oldId}-${i + 1}`]) : [];
    if (!n || stamps.some((v) => !v)) continue;
    const t = tasks.find((x) => x.id === newId)!;
    for (const o of t.objectives) out.tick[o.id] = Math.min(...stamps);
  }
  return Object.keys(out.tasks).length ? out : null;
}

const slugKey = (slug: string) => norm(slug.replace(/-/g, " "));

/**
 * Ids `wiki-…` sélectionnés dont la page n'est plus listée (supprimée ou passée en « Historical content »).
 * À n'appeler qu'avec une liste fraîche ; `migratable` : ids que wikiMigration reprend (tarkov.dev l'a maintenant).
 * Garde-fou : une liste qui rétrécit de plus de 20 % est suspecte (réponse tronquée) -> rien n'est retiré.
 */
export function vanishedWikiIds(selectedIds: string[], listedTitles: string[], previousListedCount: number | null, migratable: Set<string>): string[] {
  // liste tronquée par un raté du wiki : rien retiré (sans liste précédente, ~800 titres attendus : 300 au moins)
  if (listedTitles.length < (previousListedCount === null ? 300 : 0.8 * previousListedCount)) return [];
  const listed = new Set(listedTitles.map((t) => slugKey(eventSlug(t))));
  return selectedIds.filter((id) => id.startsWith("wiki-") && !migratable.has(id) && !listed.has(slugKey(id.slice(5))));
}

/**
 * Ids des quêtes tarkov.dev dont la page wiki (ou le nom anglais) est une page « Historical content » : retirées du jeu.
 * Comparaison stricte (casse seule ignorée) pour éviter les faux positifs.
 */
export function removedFromGame(tasks: Pick<Task, "id" | "nameEn" | "wikiLink">[], historical: string[]): Set<string> {
  const h = new Set(historical.map((t) => t.toLowerCase()));
  const ids = new Set<string>();
  for (const t of tasks) if ([wikiTitleFromLink(t.wikiLink), t.nameEn].some((x) => x && h.has(x.toLowerCase()))) ids.add(t.id);
  return ids;
}

/** Titres de « Category:Quests » (hors la page d'aperçu « Quests » et les « (Prestige n) » PvP), séparés en listés et « Historical content ». */
async function listQuestPages(): Promise<{ listed: string[]; historical: string[] }> {
  const pages = new Map<number, { title: string; historical: boolean }>();
  let cont: Record<string, string> = {};
  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const json = await wikiRequest({
      action: "query",
      generator: "categorymembers",
      gcmtitle: "Category:Quests",
      gcmnamespace: "0",
      gcmlimit: "500",
      prop: "categories",
      cllimit: "max",
      clcategories: "Category:Historical_content",
      ...cont,
    });
    const query = (json.query ?? {}) as { pages?: { pageid: number; title: string; categories?: { title: string }[] }[] };
    for (const p of query.pages ?? []) {
      const e = pages.get(p.pageid) ?? { title: p.title, historical: false };
      if (p.categories?.length) e.historical = true;
      pages.set(p.pageid, e);
    }
    if (!json.continue) {
      // shortcut: « (Prestige n) » ignoré : tarkov.dev n'a que Prestige 1-4 en PvP, à revoir s'il les ajoute en PvE
      const all = [...pages.values()].filter((p) => p.title !== "Quests");
      return {
        listed: all.filter((p) => !p.historical && !/\(Prestige \d+\)/.test(p.title)).map((p) => p.title),
        historical: all.filter((p) => p.historical).map((p) => p.title),
      };
    }
    cont = json.continue as Record<string, string>;
  }
  throw new Error("wiki: liste des quêtes trop longue");
}

export interface LoadedEvents {
  entries: EventEntry[];
  /** titres listés (non historiques) */
  listed: string[];
  /** titres « Historical content » : quêtes retirées du jeu */
  historical: string[];
  listedAt: number;
  /** « fresh » : liste relue à l'instant ; « cached » : liste de moins de 6 h ; « stale » : wiki en échec, ancienne liste */
  status: "fresh" | "cached" | "stale";
  /** taille de la liste précédente (null si aucune), pour vanishedWikiIds */
  previousCount: number | null;
}

function result(c: Pick<EventCache, "listed" | "historical" | "listedAt" | "prevCount" | "entries">, status: LoadedEvents["status"]): LoadedEvents {
  const entries = c.listed.map((t) => c.entries[t]).filter((e): e is EventEntry => Boolean(e));
  entries.sort((a, b) => a.title.localeCompare(b.title, "en"));
  return { entries, listed: c.listed, historical: c.historical ?? [], listedAt: c.listedAt, status, previousCount: c.prevCount };
}

async function fetchEventEntries(known: Set<string>, cached: EventCache | null): Promise<LoadedEvents> {
  const { listed, historical } = await listQuestPages();
  const entries = { ...(cached?.entries ?? {}) };
  const todo = listed.filter((t) => !known.has(norm(t)) && !(t in entries));
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const json = await wikiRequest({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: batch.join("|") });
    for (const t of batch) entries[t] = null;
    const pages = ((json.query ?? {}) as { pages?: { title: string; revisions?: { slots?: { main?: { content?: string } } }[] }[] }).pages ?? [];
    for (const p of pages) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      const entry = content && !/^\s*#redirect/i.test(content) ? parseEventQuest(p.title, content) : null;
      // quêtes Arena : hors du jeu PvE suivi par l'app
      entries[p.title] = entry && !entry.locations.some((l) => /^arena$/i.test(l)) ? entry : null;
    }
  }
  const next = { listed, historical, listedAt: Date.now(), prevCount: cached ? cached.listed.length : null, entries };
  writeCache(CACHE_KEY, { ...next, fetchedAt: next.listedAt } satisfies EventCache);
  return result(next, "fresh");
}

let inFlight: Promise<LoadedEvents> | null = null;

/**
 * Quêtes du wiki absentes de tarkov.dev (`known` = knownQuestKeys). Liste relue toutes les 6 h (2 requêtes),
 * + 1 requête par lot de 50 pages jamais lues. Wiki en échec avec un cache : l'ancienne liste (« stale »), jamais [].
 */
export function loadEventEntries(known: Set<string>): Promise<LoadedEvents> {
  const cached = readCache<EventCache>(CACHE_KEY);
  if (cached && Date.now() - cached.listedAt < LIST_TTL_MS) return Promise.resolve(result(cached, "cached"));
  inFlight ??= fetchEventEntries(known, cached)
    .catch((e) => {
      if (cached) return result(cached, "stale");
      throw e;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
