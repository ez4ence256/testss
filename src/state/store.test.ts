import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../types";
import { emptyModeState, loadState, reducer, sanitizeState, type Action, type AppState, type ModeState } from "./store";
import { orphanDoneCount, tasksWithProgress } from "../lib/points";

// « Signal - Partie 3 » (« Signal - Part 3 ») : identifiants réels de l'API tarkov.dev,
// trois brouilleurs à placer sur Littoral.
const SHORELINE = "5704e554d2720bac5b8b456e";
const JAMMER_1 = "5ac7a7bf86f774132252a524";
const JAMMER_2 = "5ac7a83b86f774665012340b";
const JAMMER_3 = "5ac7a8d386f7741321499e3c";
const signal3: Task = {
  id: "5ac346cf86f7741d63233a02",
  name: "Signal - Partie 3",
  nameEn: "Signal - Part 3",
  normalizedName: "signal-part-3",
  traderId: "mechanic",
  mapId: SHORELINE,
  minPlayerLevel: null,
  kappaRequired: true,
  wikiLink: "https://escapefromtarkov.fandom.com/wiki/Signal_-_Part_3",
  objectives: [JAMMER_1, JAMMER_2, JAMMER_3].map((id, i) => ({
    id,
    type: "mark",
    description: `Placez le brouilleur ${i + 1} sur le littoral`,
    optional: false,
    mapIds: [SHORELINE],
    locations: [{ mapId: SHORELINE, position: { x: i, y: 0, z: i } }],
  })),
};
const otherTask: Task = { ...signal3, id: "autre", name: "Autre", nameEn: "Other", objectives: [{ ...signal3.objectives[0], id: "o-autre" }] };

function stateWith(regular: Partial<ModeState>, pve: Partial<ModeState>): AppState {
  return {
    version: 1,
    gameMode: "regular",
    showDone: false,
    modes: {
      regular: { ...emptyModeState(), ...regular },
      pve: { ...emptyModeState(), ...pve },
    },
  };
}

const customPoint = { id: "c1", mapId: SHORELINE, x: 1, z: 1, icon: "star" as const, label: "Planque", note: "", createdAt: 1 };

describe("réinitialisation de la progression", () => {
  const initial = stateWith(
    {
      // brouilleur 2 coché par erreur, brouilleur 1 vraiment fait, autre quête faite
      done: { [JAMMER_1]: 10, [JAMMER_2]: 20, "o-autre": 30 },
      notes: { [`${JAMMER_2}@1.0,1.0`]: "pas encore fait" },
      manual: { "sans-position": { mapId: SHORELINE, x: 5, z: 5 } },
      customPoints: [customPoint],
    },
    { done: { [JAMMER_1]: 99, [JAMMER_2]: 99 } },
  );

  it("annule un seul objectif coché par erreur (Signal - Partie 3, brouilleur 2)", () => {
    const next = reducer(initial, { type: "setDone", objectiveId: JAMMER_2, done: false });
    expect(next.modes.regular!.done).toEqual({ [JAMMER_1]: 10, "o-autre": 30 });
  });

  it("réinitialise une quête : tous ses objectifs redeviennent « pas faits »", () => {
    const next = reducer(initial, { type: "resetProgress", objectiveIds: signal3.objectives.map((o) => o.id) });
    expect(next.modes.regular!.done).toEqual({ "o-autre": 30 }); // l'autre quête n'est pas touchée
  });

  it("réinitialise tout le mode courant", () => {
    const next = reducer(initial, { type: "resetAllProgress" });
    expect(next.modes.regular!.done).toEqual({});
  });

  it("ne touche jamais aux autres modes", () => {
    const actions: Action[] = [
      { type: "resetProgress", objectiveIds: [JAMMER_1, JAMMER_2, JAMMER_3] },
      { type: "resetAllProgress" },
    ];
    for (const action of actions) {
      const next = reducer(initial, action);
      expect(next.modes.pve).toBe(initial.modes.pve);
      expect(next.modes.pve!.done).toEqual({ [JAMMER_1]: 99, [JAMMER_2]: 99 });
    }
  });

  it("garde les notes, les positions placées à la main et les points perso", () => {
    const next = reducer(initial, { type: "resetAllProgress" });
    const regular = next.modes.regular!;
    expect(regular.notes).toBe(initial.modes.regular!.notes);
    expect(regular.manual).toBe(initial.modes.regular!.manual);
    expect(regular.customPoints).toEqual([customPoint]);
  });

  it("ne fait rien sans mode de jeu choisi", () => {
    const noMode = { ...initial, gameMode: null };
    expect(reducer(noMode, { type: "resetAllProgress" })).toBe(noMode);
  });

  it("import par capture : ajoute sans retirer, ou remplace la sélection ; progression intacte", () => {
    const base = stateWith({ selected: [{ taskId: "deja", color: 0 }], done: { [JAMMER_1]: 10 } }, {});
    const added = reducer(base, { type: "selectTasks", taskIds: ["a", "deja", "b"], replace: false });
    expect(added.modes.regular!.selected.map((s) => s.taskId)).toEqual(["deja", "a", "b"]);
    expect(new Set(added.modes.regular!.selected.map((s) => s.color)).size).toBe(3); // couleurs distinctes
    const replaced = reducer(base, { type: "selectTasks", taskIds: ["a"], replace: true });
    expect(replaced.modes.regular!.selected).toEqual([{ taskId: "a", color: 0 }]);
    expect(replaced.modes.regular!.done).toBe(base.modes.regular!.done);
    expect(replaced.modes.pve).toBe(base.modes.pve);
  });

  it("liste les quêtes qui ont de la progression, et les objectifs orphelins", () => {
    const done = initial.modes.regular!.done;
    expect(tasksWithProgress([otherTask, signal3], done).map((t) => t.name)).toEqual(["Autre", "Signal - Partie 3"]);
    expect(tasksWithProgress([signal3], {})).toEqual([]);
    expect(orphanDoneCount([signal3], done)).toBe(1); // "o-autre" n'est pas dans la liste fournie
  });
});

describe("quêtes échouées, planque, faction", () => {
  const extra: Partial<ModeState> = { failed: { q1: true }, hideout: { s1: 2 }, faction: "BEAR", done: { o1: 1 } };
  it("aller-retour JSON : mêmes valeurs", () => {
    const s = { ...stateWith(extra, {}), includeHideout: true };
    const back = sanitizeState(JSON.parse(JSON.stringify(s)));
    expect(back.modes.regular).toMatchObject({ failed: { q1: true }, hideout: { s1: 2 }, faction: "BEAR" });
    expect(back.includeHideout).toBe(true);
  });
  it("valeurs invalides écartées", () => {
    const bad = { modes: { regular: { failed: { a: 1, "": true, b: true }, hideout: { s1: 99, s2: 1.5, s3: "x", s4: -2, s5: 3, s6: -1 }, faction: "scav" } }, includeHideout: "oui" };
    const m = sanitizeState(bad).modes.regular!;
    expect(m.failed).toEqual({ b: true });
    expect(m.hideout).toEqual({ s5: 3, s6: -1 }); // -1 = station ignorée
    expect(m.faction).toBeUndefined();
    expect(sanitizeState(bad).includeHideout).toBe(false);
  });
  it("« Tout réinitialiser » vide les échouées mais garde planque et faction", () => {
    const m = reducer(stateWith(extra, {}), { type: "resetAllProgress" }).modes.regular!;
    expect(m.failed).toEqual({});
    expect(m.hideout).toEqual({ s1: 2 });
    expect(m.faction).toBe("BEAR");
  });
  it("applyQuestStatus : coche, échoue, désélectionne puis annule", () => {
    const s = stateWith({ selected: [{ taskId: "q1", color: 0 }] }, {});
    const a = reducer(s, { type: "applyQuestStatus", done: ["o1"], failed: ["q2"], deselect: ["q1"] }).modes.regular!;
    expect(a.done.o1).toBeTypeOf("number");
    expect(a.failed).toEqual({ q2: true });
    expect(a.selected).toEqual([]);
    const b = reducer({ ...s, modes: { ...s.modes, regular: a } }, { type: "applyQuestStatus", done: [], undone: ["o1"], failed: [], unfailed: ["q2"], select: ["q1"] }).modes.regular!;
    expect(b.done).toEqual({});
    expect(b.failed).toEqual({});
    expect(b.selected.map((x) => x.taskId)).toEqual(["q1"]);
  });
  it("resetProgress d'une quête la retire des échouées", () => {
    const m = reducer(stateWith(extra, {}), { type: "resetProgress", objectiveIds: ["o1"], taskId: "q1" }).modes.regular!;
    expect(m.failed).toEqual({});
    expect(m.done).toEqual({});
  });
  it("setHideoutLevel / setFaction", () => {
    let s = reducer(stateWith({}, {}), { type: "setHideoutLevel", stationId: "s1", level: 3 });
    s = reducer(s, { type: "setFaction", faction: "USEC" });
    expect(s.modes.regular).toMatchObject({ hideout: { s1: 3 }, faction: "USEC" });
    expect(reducer(s, { type: "setFaction", faction: null }).modes.regular!.faction).toBeUndefined();
  });
});

describe("Main story (chapitres du wiki)", () => {
  const TICKET = "The Ticket";
  const STEP = "talk to mr kerman#1";
  const base = stateWith({ selected: [{ taskId: "deja", color: 0 }], done: { [JAMMER_1]: 10 } }, {});
  const withStory = (s: AppState) => reducer(reducer(s, { type: "toggleStory", chapter: TICKET }), { type: "setStoryStep", chapter: TICKET, stepKey: STEP, done: true });

  it("choisit un chapitre sans toucher aux quêtes sélectionnées ni à la progression", () => {
    const next = reducer(base, { type: "toggleStory", chapter: TICKET });
    const regular = next.modes.regular!;
    expect(regular.story).toEqual({ selected: [TICKET], done: {} });
    expect(regular.selected).toBe(base.modes.regular!.selected);
    expect(regular.done).toBe(base.modes.regular!.done);
    expect(reducer(next, { type: "toggleStory", chapter: TICKET }).modes.regular!.story!.selected).toEqual([]);
  });

  it("coche et décoche une étape, par chapitre", () => {
    const ticked = withStory(base).modes.regular!.story!;
    expect(ticked.done).toEqual({ [`${TICKET}::${STEP}`]: true });
    const other = reducer(withStory(base), { type: "setStoryStep", chapter: "Tour", stepKey: STEP, done: true }).modes.regular!.story!;
    expect(Object.keys(other.done)).toHaveLength(2); // même clé d'étape, autre chapitre : autre case
    const unticked = reducer(withStory(base), { type: "setStoryStep", chapter: TICKET, stepKey: STEP, done: false });
    expect(unticked.modes.regular!.story!.done).toEqual({});
  });

  it("réinitialise un chapitre sans toucher aux autres", () => {
    const both = reducer(withStory(base), { type: "setStoryStep", chapter: "Tour", stepKey: "a#0", done: true });
    const next = reducer(both, { type: "resetStory", chapter: TICKET }).modes.regular!.story!;
    expect(next.done).toEqual({ "Tour::a#0": true });
    expect(next.selected).toEqual([TICKET]);
  });

  it("« Tout réinitialiser » décoche aussi les étapes, mais garde les chapitres choisis", () => {
    const next = reducer(withStory(base), { type: "resetAllProgress" }).modes.regular!;
    expect(next.done).toEqual({});
    expect(next.story).toEqual({ selected: [TICKET], done: {} });
  });

  it("n'ajoute pas de champ story quand il n'y en avait pas", () => {
    expect("story" in reducer(base, { type: "resetAllProgress" }).modes.regular!).toBe(false);
  });

  it("ne touche jamais aux autres modes", () => {
    const next = withStory(base);
    expect(next.modes.pve).toBe(base.modes.pve);
    expect(reducer(next, { type: "resetAllProgress" }).modes.pve).toBe(base.modes.pve);
  });

  it("isolation : la progression de la Main story n'apparaît pas parmi les objectifs", () => {
    expect(withStory(base).modes.regular!.done).toBe(base.modes.regular!.done);
  });

  it("l'import (JSON) garde la Main story et écarte les valeurs invalides", () => {
    const saved = JSON.parse(JSON.stringify(withStory(base)));
    expect(sanitizeState(saved).modes.regular!.story).toEqual({ selected: [TICKET], done: { [`${TICKET}::${STEP}`]: true } });
    saved.modes.regular.story = { selected: [TICKET, 3, TICKET, null], done: { ok: true, no: false, bad: "oui" } };
    expect(sanitizeState(saved).modes.regular!.story).toEqual({ selected: [TICKET], done: { ok: true } });
    saved.modes.regular.story = "n'importe quoi";
    expect("story" in sanitizeState(saved).modes.regular!).toBe(false);
    delete saved.modes.regular.story; // sauvegarde d'avant la Main story
    expect("story" in sanitizeState(saved).modes.regular!).toBe(false);
  });
});

describe("reprise du dernier mode de jeu", () => {
  afterEach(() => localStorage.clear());

  it("rouvre le dernier mode joué", () => {
    localStorage.setItem("tqp:lastMode", "pve");
    expect(loadState().gameMode).toBe("pve");
  });

  it("ignore une valeur inconnue", () => {
    localStorage.setItem("tqp:lastMode", "n'importe quoi");
    expect(loadState().gameMode).toBeNull();
  });

  it("sanitizeState (import) ne choisit jamais de mode", () => {
    localStorage.setItem("tqp:lastMode", "pve");
    expect(sanitizeState({ gameMode: "regular", modes: {} }).gameMode).toBeNull();
  });
});

describe("renameIds", () => {
  it("reprend sélection (couleur), échecs, cases et positions ; supprime les objectifs sans équivalent", () => {
    const m = { ...emptyModeState(), selected: [{ taskId: "w", color: 3 }, { taskId: "real", color: 1 }], done: { "w-1": 7, "w-3": 8, x: 1 }, failed: { w: true as const }, manual: { "w-1": { mapId: "m", x: 1, z: 2 } as never } };
    const s = reducer({ gameMode: "pve", modes: { pve: m } } as unknown as AppState, { type: "renameIds", tasks: { w: "real" }, objectives: { "w-1": "r1", "w-3": "" } });
    expect(s.modes.pve).toMatchObject({ selected: [{ taskId: "real", color: 1 }], done: { r1: 7, x: 1 }, failed: { real: true }, manual: { r1: expect.anything() } });
    const t = reducer({ gameMode: "pve", modes: { pve: m } } as unknown as AppState, { type: "renameIds", tasks: { w: "real" }, objectives: { "w-1": "" }, tick: { r1: 7, r2: 7 } });
    expect(t.modes.pve?.done).toMatchObject({ r1: 7, r2: 7 });
  });
});
