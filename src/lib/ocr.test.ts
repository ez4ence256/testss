// Séparation des colonnes d'une ligne lue par l'OCR (l'OCR elle-même n'est pas lancée).
import { describe, expect, it } from "vitest";
import { splitByGaps, toneOf } from "./ocr";

const word = (text: string, x0: number, x1: number) => ({ text, confidence: 90, bbox: { x0, x1, y0: 0, y1: 20 } });

describe("colonnes d'une ligne", () => {
  it("coupe aux grands espaces (nom | marchand | lieu), garde les mots d'un même nom ensemble", () => {
    const line = [
      word("Signal", 0, 60),
      word("-", 68, 74),
      word("Partie", 82, 140),
      word("3", 148, 158),
      word("Mécano", 400, 470), // grand espace : autre colonne
      word("Littoral", 560, 640),
    ];
    expect(splitByGaps(line, 1.6).map((g) => g.map((w) => w.text).join(" "))).toEqual(["Signal - Partie 3", "Mécano", "Littoral"]);
  });

  it("ligne vide", () => {
    expect(splitByGaps([], 1.6)).toEqual([]);
  });
});

describe("fond d'une ligne (tâches d'un marchand)", () => {
  // fond mesuré sur des captures, plus une lettre claire qui ne compte pas
  const px = (bg: number[]) => new Uint8ClampedArray([...bg, 255, ...bg, 255, 220, 220, 210, 255]);
  it("bleu = terminée, brun = en cours, gris = ratée, noir = rien", () => {
    expect(toneOf(px([14, 24, 29]))).toBe("blue");
    expect(toneOf(px([32, 23, 9]))).toBe("brown");
    expect(toneOf(px([21, 23, 22]))).toBe("grey");
    expect(toneOf(px([1, 2, 1]))).toBeUndefined();
    // quête sélectionnée : fond blanc-beige, lettres sombres
    expect(toneOf(new Uint8ClampedArray([225, 218, 200, 255, 225, 218, 200, 255, 30, 30, 30, 255]))).toBeUndefined();
    // filmé au téléphone
    expect(toneOf(px([40, 140, 200]))).toBe("blue");
    expect(toneOf(px([220, 130, 40]))).toBe("brown");
  });
});
