// Rapprochement OCR ↔ quêtes, sur des textes d'OCR simulés (l'OCR elle-même n'est pas
// lancée). Noms réels de l'API tarkov.dev (français et anglais).
import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { UNCERTAIN_MIN, dominantMap, matchItemLines, matchOcrLines, normalizeOcr, looksLikeName, nameColumn, numbersOf, offColumnLines, unknownNames, similarity } from "./ocrMatch";

const t = (id: string, name: string, nameEn: string): Pick<Task, "id" | "name" | "nameEn"> => ({ id, name, nameEn });
const TASKS = [
  t("sig2", "Signal - Partie 2", "Signal - Part 2"),
  t("sig3", "Signal - Partie 3", "Signal - Part 3"),
  t("sig4", "Signal - Partie 4", "Signal - Part 4"),
  t("chum", "Appâtage", "Chumming"),
  t("fil", "En tête de file", "First in Line"),
  t("hcp2", "Soins privés - Partie 2", "Health Care Privacy - Part 2"),
  t("em2", "Argent facile - Partie 2", "Easy Money - Part 2"),
  t("em2pvp", "Argent facile - Partie 2 [JcJ]", "Easy Money - Part 2 [PVP ZONE]"),
  t("gun1", "Armurier - Partie 1", "Gunsmith - Part 1"),
  t("gun11", "Armurier - Partie 11", "Gunsmith - Part 11"),
  t("tough", "La voie du survivaliste - Dur à cuire", "The Survivalist Path - Tough Guy"),
  t("debut", "Debut", "Debut"),
];
const ids = (ms: { taskId: string }[]) => ms.map((m) => m.taskId);

describe("normalisation", () => {
  it("accents, casse, ponctuation", () => {
    expect(normalizeOcr("Soins privés – Partie 2")).toBe("soins prives partie 2");
    expect(normalizeOcr("  En tête  de file ")).toBe("en tete de file");
    expect(numbersOf("gunsmith part 11")).toEqual(["11"]);
    expect(similarity("signal partie 3", "signal partie 3")).toBe(1);
  });
});

describe("rapprochement des lignes OCR", () => {
  it("reconnaît les noms français et anglais, et ignore le reste de la capture", () => {
    const r = matchOcrLines(
      [
        "TÂCHES",
        "Signal - Partie 3",
        "Le Mécano",
        "Placez le premier brouilleur à l'endroit spécifié",
        "First in Line",
        "Thérapeute",
        "ACCEPTER",
        "Appâtage",
      ],
      TASKS,
    );
    expect(ids(r.recognized)).toEqual(["sig3", "fil", "chum"]);
    expect(r.uncertain).toEqual([]);
    expect(r.unmatched).toEqual(["TÂCHES", "Le Mécano", "Placez le premier brouilleur à l'endroit spécifié", "Thérapeute", "ACCEPTER"]);
  });

  it("tolère le bruit et les petites fautes de l'OCR", () => {
    const r = matchOcrLines(["Signa1 - Partie 3", "Soins prlvés — Partie 2", "Appatage."], TASKS);
    // « Signa1 » : « 1 » lu à la place de « l », collé au mot : ce n'est pas un numéro
    expect(ids(r.recognized)).toEqual(["sig3", "hcp2", "chum"]);
    expect(r.unmatched).toEqual([]);
    expect(numbersOf(normalizeOcr("Signa1 - Partie 3"))).toEqual(["3"]);
  });

  it("les numéros doivent correspondre exactement : Partie 2 n'est jamais Partie 3", () => {
    const r = matchOcrLines(["Signal - Partie 2", "Gunsmith - Part 1"], TASKS);
    expect(ids(r.recognized)).toEqual(["sig2", "gun1"]);
    // un numéro mal lu ne bascule pas vers la quête voisine
    const wrong = matchOcrLines(["Signal - Partie 5", "Gunsmith - Part 111"], TASKS);
    expect(wrong.recognized).toEqual([]);
    expect(wrong.uncertain).toEqual([]);
  });

  it("nom coupé sur deux lignes", () => {
    const r = matchOcrLines(["La voie du survivaliste -", "Dur à cuire", "Soins privés -", "Partie 2"], TASKS);
    expect(ids(r.recognized)).toEqual(["tough", "hcp2"]);
    expect(r.recognized[0].lineIndexes).toEqual([0, 1]);
    expect(r.unmatched).toEqual([]);
  });

  it("[PVP ZONE] / [JcJ] : jamais confondue avec la quête normale", () => {
    expect(ids(matchOcrLines(["Argent facile - Partie 2 [JcJ]"], TASKS).recognized)).toEqual(["em2pvp"]);
    expect(ids(matchOcrLines(["Easy Money - Part 2 [PVP ZONE]"], TASKS).recognized)).toEqual(["em2pvp"]);
    expect(ids(matchOcrLines(["Argent facile - Partie 2"], TASKS).recognized)).toEqual(["em2"]);
  });

  it("ligne qui contient le nom mais beaucoup plus longue : pas reconnue", () => {
    const r = matchOcrLines(["Signal - Partie 3 : placez les brouilleurs sur le littoral"], TASKS);
    expect(r.recognized).toEqual([]);
  });

  it("correspondance approximative : classée « incertaine », jamais cochée d'office", () => {
    const r2 = matchOcrLines(["En tete dc flle"], TASKS);
    expect(ids(r2.uncertain)).toEqual(["fil"]);
    expect(r2.uncertain[0].score).toBeLessThan(0.88);
  });

  it("une quête n'est proposée qu'une fois, et seulement parmi les quêtes fournies (mode actuel)", () => {
    const r = matchOcrLines(["Appâtage", "Chumming"], TASKS);
    expect(ids(r.recognized)).toEqual(["chum"]);
    expect(r.unmatched).toEqual(["Chumming"]);
    expect(matchOcrLines(["Signal - Partie 3"], TASKS.filter((x) => x.id !== "sig3")).recognized).toEqual([]);
  });

  it("rien de reconnu", () => {
    const r = matchOcrLines(["", "Inventaire", "12:45"], TASKS);
    expect(r.recognized).toEqual([]);
    expect(r.uncertain).toEqual([]);
    expect(r.unmatched).toEqual(["Inventaire", "12:45"]);
  });

  it("colonne Lieu : la map « Reserve » n'est pas la quête « Reserve », relue sans elle", () => {
    const tasks = [...TASKS, t("res", "Réserve", "Reserve")];
    // tableau : nom (x = 257) | lieu (x = 790)
    const lines = [
      { text: "Chumming", x: 257, h: 16 },
      { text: "Reserve", x: 790, h: 16 },
      { text: "Debut", x: 257, h: 16 },
      { text: "First in Line", x: 250, h: 16 },
      { text: "Reserve", x: 790, h: 16 },
    ];
    const r = matchOcrLines(lines.map((l) => l.text), tasks);
    expect(ids(r.recognized)).toContain("res");
    const off = offColumnLines(r, lines);
    expect([...off]).toEqual([1, 4]);
    const again = matchOcrLines(lines.map((l, i) => (off.has(i) ? "" : l.text)), tasks);
    expect(ids(again.recognized)).toEqual(["chum", "debut", "fil"]);
    // la quête « Reserve » dans la colonne des noms reste
    const own = [...lines, { text: "Reserve", x: 257, h: 16 }];
    expect(offColumnLines(matchOcrLines(own.map((l) => l.text), tasks), own).has(5)).toBe(false);
  });

  it("colonne : rien d'écarté sans tableau net (moins de 3 quêtes ou pas alignées)", () => {
    const two = [{ text: "Chumming", x: 10, h: 16 }, { text: "Reserve", x: 900, h: 16 }];
    expect(offColumnLines(matchOcrLines(two.map((l) => l.text), [...TASKS, t("res", "Réserve", "Reserve")]), two).size).toBe(0);
    const scattered = [{ text: "Chumming", x: 10, h: 16 }, { text: "Debut", x: 500, h: 16 }, { text: "First in Line", x: 990, h: 16 }];
    expect(offColumnLines(matchOcrLines(scattered.map((l) => l.text), TASKS), scattered).size).toBe(0);
  });
});

describe("noms inconnus dans la colonne", () => {
  const lines = [
    { text: "Chumming", x: 100, h: 16 },
    { text: "Debut", x: 102, h: 16 },
    { text: "First in Line", x: 98, h: 16 },
    { text: "A Brand New Quest", x: 101, h: 16 },
    { text: "42 %", x: 100, h: 16 },
    { text: "Reserve", x: 900, h: 16 },
  ];
  it("lignes de la colonne non utilisées qui ressemblent à un nom", () => {
    const texts = lines.map((l) => l.text);
    const r = matchOcrLines(texts, TASKS);
    const col = nameColumn(r, lines)!;
    expect([...col.inside]).toEqual([0, 1, 2, 3, 4]);
    expect([...col.off]).toEqual([5]);
    expect(unknownNames(r, texts, col.inside)).toEqual(["A Brand New Quest"]);
  });
  it("pas de colonne : null", () => {
    expect(nameColumn(matchOcrLines(["Chumming"], TASKS), [{ x: 1, h: 16 }])).toBeNull();
  });
  it("forme d'un nom", () => {
    expect([looksLikeName("A Familiar Face"), looksLikeName("Chumming"), looksLikeName("Go"), looksLikeName("12 345"), looksLikeName("42 %"), looksLikeName("ES"), looksLikeName("Type Class"), looksLikeName("Al BR"), looksLikeName("Swift Debtor")]).toEqual([true, true, false, false, false, false, false, false, true]);
  });
});

describe("objets lus par l'OCR", () => {
  const ITEMS = [
    { id: "a", alts: ["Analyseur de gaz", "Gas analyzer"] },
    { id: "b", alts: ["Fusil AK", "AK"] },
  ];
  it("nom exact : score 1 en premier", () => {
    const r = matchItemLines(["Analyseur de gaz"], ITEMS);
    expect(r[0].item.id).toBe("a");
    expect(r[0].score).toBe(1);
  });
  it("faute d'OCR tolérée", () => {
    const r = matchItemLines(["Analyseur de gax"], ITEMS);
    expect(r[0].item.id).toBe("a");
    expect(r[0].score).toBeGreaterThanOrEqual(UNCERTAIN_MIN);
  });
  it("nom court ignoré", () => {
    expect(matchItemLines(["AK"], ITEMS)).toEqual([]);
  });
  it("bruit : rien", () => {
    expect(matchItemLines(["12 345 ₽"], ITEMS)).toEqual([]);
  });
  it("nom sur deux lignes", () => {
    const r = matchItemLines(["Analyseur", "de gaz"], ITEMS);
    expect(r[0].item.id).toBe("a");
    expect(r[0].score).toBe(1);
  });
});

describe("map à afficher après l'import", () => {
  const loc = (mapId: string) => ({ mapId, position: { x: 0, y: 0, z: 0 } });
  const quest = (...maps: string[]) => ({
    objectives: [{ id: "o", type: "mark", description: "", optional: false, mapIds: [], locations: maps.map(loc) }],
  });
  it("la map qui a la majorité des points", () => {
    expect(dominantMap([quest("shoreline", "shoreline"), quest("shoreline", "customs")])).toBe("shoreline");
  });
  it("points répartis sur plusieurs maps, ou aucun point : on ne change pas de map", () => {
    expect(dominantMap([quest("shoreline"), quest("customs")])).toBeNull();
    expect(dominantMap([quest()])).toBeNull();
  });
});
