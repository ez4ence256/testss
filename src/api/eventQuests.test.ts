import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameMap, Task, Trader } from "../types";
import { buildEventTasks, eventSlug, knownQuestKeys, loadEventEntries, parseEventQuest, removedFromGame, vanishedWikiIds, wikiMigration } from "./eventQuests";

// Extrait réel (réduit) de la page « All-Inclusive Support » du wiki
const ALL_INCLUSIVE = `{{Event content}}
{{Infobox quest
|image         =All-Inclusive Support Banner.png
|location      =[[Lighthouse]]
|given by      =[[Prapor]]
|previous      =[[Number Temporarily Unavailable]]
|leads to      =[[A Familiar Face...]]<br/>[[Lose the Tail]]
|reqkappa      =<font color="green">No</font>
}}

'''{{PAGENAME}}''' is a [[Quests|Quest]] in ''[[Escape from Tarkov]]''.

==Dialogue==
{{quote|No, you gotta hear this!}}

==Objectives==
* Eliminate any 15 targets on [[Lighthouse]]
* Launch a red signal flare at the abandoned mountain lake cabin on [[Lighthouse]]
** Use the [[RSP-30 reactive signal cartridge (Red)|red flare]]
* Use the transit from [[Lighthouse]] to [[Reserve]]

==Rewards==
* +20,000 [[EXP]]
`;

const trader = (id: string, normalizedName: string): Trader => ({ id, name: normalizedName, normalizedName, imageLink: null });
const map = (id: string, nameEn: string): GameMap => ({ id, name: nameEn, nameEn, normalizedName: nameEn.toLowerCase() });
const dev = (nameEn: string): Task => ({
  id: `td-${nameEn}`, name: nameEn, nameEn, normalizedName: nameEn.toLowerCase(), traderId: "t1", mapId: null,
  minPlayerLevel: 1, kappaRequired: false, wikiLink: null, objectives: [],
});
const ctx = { traders: [trader("t1", "prapor")], maps: [map("m1", "Lighthouse")] };

describe("parseEventQuest", () => {
  it("lit marchand, lieu et objectifs (sous-puce ajoutée à l'objectif)", () => {
    expect(parseEventQuest("All-Inclusive Support", ALL_INCLUSIVE)).toEqual({
      title: "All-Inclusive Support",
      givenBy: "Prapor",
      locations: ["Lighthouse"],
      objectives: [
        "Eliminate any 15 targets on Lighthouse",
        "Launch a red signal flare at the abandoned mountain lake cabin on Lighthouse; Use the red flare",
        "Use the transit from Lighthouse to Reserve",
      ],
    });
  });
  it("page sans infobox ni objectif : ignorée", () => expect(parseEventQuest("X", "#REDIRECT [[Y]]")).toBeNull());
  it("objectifs sous un sous-titre (Halloween : branches Skier / Therapist) : le sous-titre les précède", () => {
    const text = `{{Infobox quest
|given by =[[Therapist]]
|location =[[Infected Factory]], [[Infected Lab]]
}}
==Objectives==
====[[Skier]] questline exclusive====
* Survive and extract from [[Factory|Infected Factory]]
====[[Therapist]] questline exclusive====
* Survive and extract from [[The Lab|Infected Lab]]
==Rewards==
`;
    expect(parseEventQuest("Halloween: A new Vaccine", text)?.objectives).toEqual([
      "(Skier questline exclusive) Survive and extract from Infected Factory",
      "(Therapist questline exclusive) Survive and extract from Infected Lab",
    ]);
  });
});

describe("buildEventTasks", () => {
  const entries = [parseEventQuest("All-Inclusive Support", ALL_INCLUSIVE)!];

  it("tâche synthétique : marchand, map, positions relevées seulement là où le wiki en montre", () => {
    const [t] = buildEventTasks(entries, { ...ctx, tasks: [] });
    expect(t).toMatchObject({ id: "wiki-All-Inclusive-Support", source: "wiki", traderId: "t1", mapId: "m1", kappaRequired: false });
    expect(t.wikiLink).toBe("https://escapefromtarkov.fandom.com/wiki/All-Inclusive_Support");
    expect(t.objectives.map((o) => o.id)).toEqual(["wiki-All-Inclusive-Support-1", "wiki-All-Inclusive-Support-2", "wiki-All-Inclusive-Support-3"]);
    expect(t.objectives.every((o) => o.mapIds[0] === "m1")).toBe(true);
    // « éliminer 15 cibles » : nulle part ; fusée à la cabane et transit vers Reserve : un point chacun
    expect(t.objectives.map((o) => o.locations.length)).toEqual([0, 1, 1]);
  });

  it("retirée quand tarkov.dev a la quête (nom, même avec suffixe PVP ZONE)", () => {
    expect(buildEventTasks(entries, { ...ctx, tasks: [dev("All Inclusive Support [PVP ZONE]")] })).toEqual([]);
  });

  it("positions relevées à la main (Fog of War, Phare)", () => {
    const fog = { title: "Fog of War", givenBy: null, locations: ["Lighthouse"], objectives: ["a", "b", "c"] };
    const maps = [{ ...ctx.maps[0], id: "lh", name: "Phare", nameEn: "Lighthouse", normalizedName: "lighthouse" }];
    const [t] = buildEventTasks([fog], { ...ctx, maps, tasks: [] });
    expect(t.objectives.map((o) => o.locations.length)).toEqual([1, 1, 3]);
    expect(t.objectives[0].locations[0]).toMatchObject({ mapId: "lh", position: { x: -65.1, z: -692.4 } });
    expect(t.objectives[2].locations.every((l) => l.possible)).toBe(true);
  });

  it("Halloween : maps « Infected » rattachées à leur map de base, chambre 105 sur Douanes", () => {
    const maps = [map("fa", "Factory"), map("lab", "The Lab"), { ...map("cu", "Customs"), normalizedName: "customs" }];
    const help = { title: "Halloween: Unexpected Help", givenBy: null, locations: ["Lighthouse", "Customs"], objectives: ["get", "stash"] };
    const exam = { title: "Halloween: Rumors", givenBy: null, locations: ["Infected Factory", "Infected Lab"], objectives: ["x"] };
    const [h, r] = buildEventTasks([help, exam], { ...ctx, maps, tasks: [] });
    expect(r.objectives[0].mapIds).toEqual(["fa", "lab"]);
    expect(h.objectives[1].locations[0]).toMatchObject({ mapId: "cu", position: { x: 227.88, z: 135.61 } });
  });

  it("ids valides pour les rooms", () => {
    const re = /^[A-Za-z0-9_\-:.]{1,100}$/;
    const t = buildEventTasks([{ title: "A Familiar Face...", givenBy: null, locations: [], objectives: ["x"] }], { ...ctx, tasks: [] })[0];
    expect(eventSlug("A Familiar Face...")).toBe("A-Familiar-Face");
    expect([t.id, ...t.objectives.map((o) => o.id)].every((id) => re.test(id))).toBe(true);
    expect(t.traderId).toBe("");
  });
});

describe("loadEventEntries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  const ARENA = `{{Infobox quest\n|location = [[Arena]]\n|given by = [[Ref]]\n}}\n==Objectives==\n* Win`;
  const wikiPage = (title: string, content: string) => ({ title, revisions: [{ slots: { main: { content } } }] });
  /** wiki simulé : liste en 2 requêtes (continuation), puis wikitext des titres demandés */
  const mockWiki = (listFails = () => false) => {
    let n = 0;
    const requested: string[] = [];
    const fn = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get("generator")) {
        if (listFails()) throw new TypeError("réseau");
        n++;
        const cat = [{ title: "Category:Historical content" }];
        return new Response(
          JSON.stringify(
            n % 2 === 1
              ? { continue: { gcmcontinue: "x" }, query: { pages: [{ pageid: 1, title: "All-Inclusive Support" }, { pageid: 2, title: "Old One", categories: cat }, { pageid: 5, title: "Quests" }] } }
              : { query: { pages: [{ pageid: 3, title: "Arena Win" }, { pageid: 4, title: "Known Quest" }, { pageid: 6, title: "New Beginning (Prestige 5)" }, { pageid: 2, title: "Old One", categories: cat }] } },
          ),
        );
      }
      const titles = u.searchParams.get("titles")!.split("|");
      requested.push(...titles);
      return new Response(JSON.stringify({ query: { pages: titles.map((t) => wikiPage(t, t === "Arena Win" ? ARENA : ALL_INCLUSIVE)) } }));
    });
    vi.stubGlobal("fetch", fn);
    return { fn, requested };
  };
  const run = async (p: Promise<unknown>) => {
    await vi.runAllTimersAsync();
    return p;
  };
  const known = new Set([...knownQuestKeys([{ nameEn: "Known Quest", wikiLink: "" }])]);

  it("Category:Quests : historique, Arena, « Quests » et Prestige écartés ; seules les pages inconnues sont lues ; cache 6 h", async () => {
    const { fn, requested } = mockWiki();
    vi.useFakeTimers();
    const r = (await run(loadEventEntries(known))) as Awaited<ReturnType<typeof loadEventEntries>>;
    expect(requested).toEqual(["All-Inclusive Support", "Arena Win"]);
    expect(r.status).toBe("fresh");
    expect(r.previousCount).toBeNull();
    expect(r.listed).toEqual(["All-Inclusive Support", "Arena Win", "Known Quest"]);
    expect(r.historical).toEqual(["Old One"]);
    expect(r.entries.map((e) => e.title)).toEqual(["All-Inclusive Support"]);
    expect(fn).toHaveBeenCalledTimes(3);
    // dans les 6 h : aucune requête
    const c = await loadEventEntries(known);
    expect(c.status).toBe("cached");
    expect(c.historical).toEqual(["Old One"]);
    expect(c.entries.map((e) => e.title)).toEqual(["All-Inclusive Support"]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("après 6 h : liste relue, pages déjà lues (même Arena = null) non relues", async () => {
    const { fn, requested } = mockWiki();
    vi.useFakeTimers();
    await run(loadEventEntries(known));
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    const r = (await run(loadEventEntries(known))) as Awaited<ReturnType<typeof loadEventEntries>>;
    expect(r.status).toBe("fresh");
    expect(r.previousCount).toBe(3);
    expect(fn).toHaveBeenCalledTimes(5); // + 2 requêtes de liste seulement
    expect(requested).toHaveLength(2);
  });

  it("wiki en échec avec un cache : ancienne liste (stale), pas []", async () => {
    let fail = false;
    mockWiki(() => fail);
    vi.useFakeTimers();
    await run(loadEventEntries(known));
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    fail = true;
    const r = (await run(loadEventEntries(known))) as Awaited<ReturnType<typeof loadEventEntries>>;
    expect(r.status).toBe("stale");
    expect(r.historical).toEqual(["Old One"]);
    expect(r.entries.map((e) => e.title)).toEqual(["All-Inclusive Support"]);
  });

  it("wiki en échec sans cache : rejet", async () => {
    mockWiki(() => true);
    vi.useFakeTimers();
    const p = loadEventEntries(known);
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("removedFromGame", () => {
  const tasks = [
    { id: "a", nameEn: "Private Clinic", wikiLink: "https://escapefromtarkov.fandom.com/wiki/Private_Clinic" },
    { id: "b", nameEn: "Signal - Part 3", wikiLink: null },
    { id: "c", nameEn: "Debut", wikiLink: "https://escapefromtarkov.fandom.com/wiki/Debut" },
    { id: "d", nameEn: "Private Clinics", wikiLink: "" },
  ];
  it("masque la page historique (casse ignorée), garde le reste et les quasi-homonymes", () => {
    expect([...removedFromGame(tasks, ["private clinic", "Signal - Part 3"])].sort()).toEqual(["a", "b"]);
    expect(removedFromGame(tasks, []).size).toBe(0);
  });
});

describe("vanishedWikiIds", () => {
  // ~800 titres en vrai : 300 de remplissage pour passer le plancher sans liste précédente
  const listed = ["Fog of War", "To the Light - Fallen Bird", ...Array.from({ length: 300 }, (_, i) => `Filler ${i}`)];
  const sel = ["wiki-Fog-of-War", "wiki-Gone-Quest", "wiki-To-the-Light-Fallen-Bird", "tarkovdev-id"];
  it("seulement les wiki-… absents de la liste", () => {
    expect(vanishedWikiIds(sel, listed, null, new Set())).toEqual(["wiki-Gone-Quest"]);
    expect(vanishedWikiIds(sel, listed, 302, new Set())).toEqual(["wiki-Gone-Quest"]);
  });
  it("garde-fou : sans liste précédente, moins de 300 titres -> rien", () => {
    expect(vanishedWikiIds(sel, listed.slice(0, 2), null, new Set())).toEqual([]);
  });
  it("pas ceux que wikiMigration reprend", () => {
    expect(vanishedWikiIds(sel, listed, null, new Set(["wiki-Gone-Quest"]))).toEqual([]);
  });
  it("garde-fou : liste qui rétrécit de plus de 20 % -> rien", () => {
    expect(vanishedWikiIds(sel, listed, 1000, new Set())).toEqual([]);
    expect(vanishedWikiIds(sel, listed, 370, new Set())).toEqual(["wiki-Gone-Quest"]);
  });
});

describe("wikiMigration", () => {
  const real = { id: "real1", nameEn: "Debtor", wikiLink: "https://escapefromtarkov.fandom.com/wiki/Debtor", objectives: [{ id: "ro1" }, { id: "ro2" }] } as unknown as Task;
  const mode = { selected: [{ taskId: "wiki-Debtor", color: 2 }], done: { "wiki-Debtor-1": 5, "wiki-Debtor-3": 6, other: 1 }, failed: {}, manual: {} };
  it("mappe l'ancien id et les objectifs par rang (sans équivalent : supprimé), rejouable", () => {
    expect(wikiMigration(mode, [real])).toEqual({ tasks: { "wiki-Debtor": "real1" }, objectives: { "wiki-Debtor-1": "ro1", "wiki-Debtor-3": "" }, tick: {} });
    expect(wikiMigration({ ...mode, selected: [], done: {} }, [real])).toBeNull();
  });
  it("apparie comme le dédoublonnage (casse, « the »)", () => {
    const td = { id: "td1", nameEn: "To the Light - Trust But Verify", wikiLink: null, objectives: [{ id: "o1" }] } as unknown as Task;
    const m = { selected: [{ taskId: "wiki-To-the-Light-Trust-but-Verify", color: 1 }], done: { "wiki-To-the-Light-Trust-but-Verify-1": 5 }, failed: {}, manual: {} };
    expect(wikiMigration(m, [td])).toMatchObject({ tasks: { "wiki-To-the-Light-Trust-but-Verify": "td1" }, objectives: { "wiki-To-the-Light-Trust-but-Verify-1": "o1" } });
  });
  it("quête wiki finie : tous les vrais objectifs cochés ; incomplète : par rang", () => {
    const m = { selected: [], done: { "wiki-Debtor-1": 5 }, failed: {}, manual: {} };
    expect(wikiMigration(m, [real], { "wiki-Debtor": 1 })?.tick).toEqual({ ro1: 5, ro2: 5 });
    expect(wikiMigration(m, [real], { "wiki-Debtor": 2 })?.tick).toEqual({});
    expect(wikiMigration(m, [real])?.tick).toEqual({});
  });
});
