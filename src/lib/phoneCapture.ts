// Capture par téléphone : aides pures (code, adresse du PC, taille des photos, fusion des lectures OCR).
// Le relais serveur est dans server/phone.mjs.
import { RECOGNIZED_MIN, normalizeOcr, type OcrMatch, type OcrMatchResult } from "./ocrMatch";

export const PHONE_CODE = /^[A-Za-z0-9]{24}$/;
export const PHONE_ORIGIN_KEY = "tqp:phoneOrigin";
/** Côté le plus long des photos envoyées (assez net pour l'OCR, bien sous les 3 Mo du serveur). */
export const PHOTO_MAX_SIDE = 1600;

/** Code de session lu dans `?phone=CODE`, ou null (absent ou mal formé). */
export function phoneCodeFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get("phone");
  return code && PHONE_CODE.test(code) ? code : null;
}

/** Taille d'une photo réduite pour que son plus grand côté ne dépasse pas `max` (jamais agrandie). */
export function downscaleSize(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Un téléphone ne peut pas joindre localhost : il faut l'adresse du PC sur le réseau. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return true;
  }
}

/** Adresse saisie → origine http(s) propre (sans chemin), ou null. « 192.168.1.20:5174 » est complété en http://. */
export function normalizeOrigin(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return url.origin;
  } catch {
    return null;
  }
}

export const phoneUrl = (origin: string, code: string) => `${origin}/?phone=${code}`;

/**
 * Fusionne les lectures de plusieurs photos : une quête vue sur plusieurs photos n'apparaît qu'une fois
 * (meilleur score), classée reconnue ou incertaine selon ce meilleur score. Les lignes non reconnues s'ajoutent.
 * Son fond est pris sur la meilleure lecture qui en a un : sélectionnée (fond clair) sur une image, elle a
 * sa couleur sur une autre.
 */
export function mergeOcrResults(results: OcrMatchResult[]): OcrMatchResult {
  // noms inconnus : sans doublon (casse ignorée), sans ceux qui sont (ou contiennent) le texte d'une quête reconnue
  const known = results.flatMap((r) => [...r.recognized, ...r.uncertain]).map((m) => normalizeOcr(m.text)).filter(Boolean);
  const seen = new Set<string>();
  const unknown = results.flatMap((r) => r.unknown ?? []).filter((u) => {
    const n = normalizeOcr(u);
    if (!n || seen.has(n) || known.some((k) => n.includes(k) || k.includes(n))) return false;
    seen.add(n);
    return true;
  });
  if (results.length === 1) return { ...results[0], unknown };
  const best = new Map<string, OcrMatch>();
  const toned = new Map<string, OcrMatch>();
  for (const m of results.flatMap((r) => [...r.recognized, ...r.uncertain])) {
    const old = best.get(m.taskId);
    if (!old || m.score > old.score) best.set(m.taskId, m);
    const oldTone = toned.get(m.taskId);
    if (m.tone && (!oldTone || m.score > oldTone.score)) toned.set(m.taskId, m);
  }
  const all = [...best.values()].map((m) => ({ ...m, tone: toned.get(m.taskId)?.tone }));
  return {
    recognized: all.filter((m) => m.score >= RECOGNIZED_MIN),
    uncertain: all.filter((m) => m.score < RECOGNIZED_MIN),
    unmatched: results.flatMap((r) => r.unmatched),
    unknown,
  };
}

/** Photos gardées par le relais pour une session (LIMITS.maxPhotos de server/phone.mjs). */
export const PHONE_MAX_PHOTOS = 100;
/** Images tirées d'une vidéo, au plus : 1 min 30 à une image par seconde. */
export const VIDEO_MAX_FRAMES = 90;
/** Écart entre deux images candidates d'une vidéo (s). */
export const VIDEO_STEP = 0.2;

/** Image candidate : instant, netteté, petite version en gris (pour comparer deux images). */
export interface FrameSample {
  t: number;
  sharp: number;
  gray: Uint8ClampedArray;
}

/** Netteté d'une image en gris : écart moyen d'un pixel à ses voisins (le flou de bougé l'écrase). */
export function sharpness(gray: Uint8ClampedArray, width: number, height: number): number {
  let s = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      s += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width]);
    }
  return s / Math.max(1, (width - 2) * (height - 2));
}

const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / Math.max(1, a.length);
};

/**
 * Instants à garder d'une vidéo de la liste qui défile : la plus nette de chaque tranche (0,6 s jusqu'à 15 s de
 * vidéo, 1 s au-delà, plus si la vidéo dépasse `max` secondes), sauf si elle ressemble à la précédente gardée
 * (liste arrêtée : même écran).
 */
export function pickFrames(samples: FrameSample[], duration: number, max = VIDEO_MAX_FRAMES, minDiff = 4): number[] {
  const slot = Math.max(duration <= 15 ? 0.6 : 1, duration / max);
  const best = new Map<number, FrameSample>();
  for (const f of samples) {
    const k = Math.floor(f.t / slot);
    if (!best.has(k) || f.sharp > best.get(k)!.sharp) best.set(k, f);
  }
  const kept: FrameSample[] = [];
  for (const [, f] of [...best].sort((a, b) => a[0] - b[0])) if (!kept.length || meanDiff(f.gray, kept[kept.length - 1].gray) >= minDiff) kept.push(f);
  return kept.slice(0, max).map((f) => f.t);
}

