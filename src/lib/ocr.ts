// Lecture du texte d'une capture d'écran, entièrement dans le navigateur (aucune image
// n'est envoyée nulle part). Moteur : Tesseract.js (Apache-2.0), chargé seulement à la
// première capture (import dynamique : fichier séparé, l'app ne s'alourdit pas).
//  - worker et moteur WebAssembly : servis par l'app (copiés au build, pas de code de CDN) ;
//  - données de langue fra + eng (~0,7 + ~3 Mo) : téléchargées depuis le CDN jsdelivr la
//    première fois, puis gardées par Tesseract.js dans IndexedDB.
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import type { Worker } from "tesseract.js";

export interface OcrLine {
  text: string;
  /** Confiance de Tesseract, de 0 à 100. */
  confidence: number;
  /** Fond de la ligne dans la liste des tâches d'un marchand : bleu = terminée, brun = en cours, gris = ratée. */
  tone?: Tone;
  /** Bord gauche et hauteur du texte, en pixels de l'image lue : situent sa colonne dans un tableau. */
  x?: number;
  h?: number;
}

export type Tone = "blue" | "brown" | "grey";

/**
 * Couleur du fond sous une ligne (pixels RGBA) : les lettres claires sont écartées. Mesuré sur le menu
 * Tâches d'un marchand : bleu (14, 24, 29), brun (32, 23, 9) sur capture ; filmés au téléphone, bien plus vifs
 * (bleu clair, orange). Gris (21, 23, 22) : quête ratée, mais aussi fond du menu Personnage (voir CaptureTab) ;
 * noir (titres de section) : rien. Fond clair (quête sélectionnée, blanc-beige, texte sombre) : rien non plus.
 */
export function toneOf(px: Uint8ClampedArray): Tone | undefined {
  let diff = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.min(px[i], px[i + 1], px[i + 2]) > 150) continue; // lettres blanches
    diff += px[i + 2] - px[i];
    sum += px[i] + px[i + 1] + px[i + 2];
    n++;
  }
  // plus de la moitié de pixels clairs : c'est le fond, pas des lettres (quête sélectionnée)
  if (n * 2 < px.length / 4) return undefined;
  return diff / n > 8 ? "blue" : diff / n < -8 ? "brown" : sum / n / 3 >= 10 ? "grey" : undefined;
}

export interface OcrProgress {
  status: string;
  /** 0 à 1. */
  progress: number;
}

export type Preprocess = "none" | "upscale" | "full";

let workerPromise: Promise<Worker> | null = null;
let onProgress: ((p: OcrProgress) => void) | null = null;

function createTessWorker(): Promise<Worker> {
  return import("tesseract.js").then(({ createWorker }) =>
    // 1 = OEM.LSTM_ONLY (réseau de neurones, le plus précis)
    createWorker(["fra", "eng"], 1, {
      workerPath: workerUrl,
      corePath: coreUrl,
      logger: (m: { status: string; progress: number }) => onProgress?.({ status: m.status, progress: m.progress }),
    }),
  );
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createTessWorker().catch((error) => {
      workerPromise = null; // nouvel essai possible (ex. connexion revenue)
      throw error;
    });
  }
  return workerPromise;
}

/**
 * Prépare l'image pour l'OCR :
 *  - "upscale" : agrandit les petites captures (texte plus gros = mieux lu) ;
 *  - "full" : agrandit, passe en niveaux de gris, étire le contraste et inverse si le
 *    fond est sombre. Gardé pour les essais : sur fond très sombre, l'étirement se cale
 *    sur le fond et écrase le texte (mesuré : 1/8 contre 7/8 pour "upscale").
 */
export async function preprocess(image: Blob, mode: Preprocess = "upscale"): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(image);
  const scale = mode === "none" ? 1 : Math.min(3, Math.max(1, 2200 / bitmap.width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  if (mode !== "full") return canvas;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const gray = new Uint8ClampedArray(d.length / 4);
  const histogram = new Array(256).fill(0);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[j] = g;
    histogram[g]++;
  }
  // bornes à 2 % et 98 % de l'histogramme pour étirer le contraste
  const total = gray.length;
  let low = 0;
  let high = 255;
  for (let acc = 0; low < 255 && (acc += histogram[low]) < total * 0.02; low++);
  for (let acc = 0; high > 0 && (acc += histogram[high]) < total * 0.02; high--);
  const mean = gray.reduce((s, g) => s + g, 0) / total;
  const invert = mean < 128;
  const range = Math.max(1, high - low);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = ((gray[j] - low) * 255) / range;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export interface OcrOptions {
  preprocess?: Preprocess;
  /**
   * Découpage de page de Tesseract : "auto" (3, paragraphes) ou "sparse" (11, texte
   * épars : adapté aux interfaces, chaque morceau de texte est trouvé séparément).
   */
  layout?: "auto" | "sparse";
  /** Coupe une ligne là où l'espace entre deux mots dépasse ce multiple de la hauteur du texte (colonnes). */
  columnGap?: number;
  /**
   * Lire le canal le plus sombre de chaque pixel : le texte blanc reste blanc, les fonds colorés (bleu, orange
   * des tâches d'un marchand filmées au téléphone) deviennent sombres.
   */
  whiteText?: boolean;
}

/** Copie de l'image où chaque pixel prend son canal le plus sombre (voir OcrOptions.whiteText). */
function darkestChannel(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const img = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.min(d[i], d[i + 1], d[i + 2]);
  out.getContext("2d")!.putImageData(img, 0, 0);
  return out;
}

/**
 * Réglages retenus après mesure sur une image de synthèse du menu Tâches (session 5,
 * voir JOURNAL.md) : agrandir seulement, texte épars, colonnes séparées -> 7/7 quêtes,
 * aucune fausse. Le prétraitement "full" (contraste + inversion) faisait tomber à 1/8.
 */
export const DEFAULT_OCR_OPTIONS: Required<OcrOptions> = { preprocess: "upscale", layout: "sparse", columnGap: 1.6, whiteText: false };

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
interface Word {
  text: string;
  confidence: number;
  bbox: Box;
}

/** Sépare les colonnes d'une ligne (nom | marchand | lieu) d'après les grands espaces entre mots. */
export function splitByGaps(words: Word[], gapFactor: number): Word[][] {
  if (words.length === 0) return [];
  const height = Math.max(1, ...words.map((w) => w.bbox.y1 - w.bbox.y0));
  const groups: Word[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > height * gapFactor) groups.push([words[i]]);
    else groups[groups.length - 1].push(words[i]);
  }
  return groups;
}

/** Lit les lignes d'une image avec le worker donné (page seg. posée à chaque lecture : le worker partagé sert aussi aux bandes). */
async function readWith(worker: Worker, image: Blob, o: Required<OcrOptions>, canvasPromise = preprocess(image, o.preprocess)): Promise<OcrLine[]> {
  const canvas = await canvasPromise;
  await worker.setParameters({ tessedit_pageseg_mode: (o.layout === "sparse" ? "11" : "3") as never });
  const { data } = await worker.recognize(o.whiteText ? darkestChannel(canvas) : canvas, {}, { blocks: true, text: true });
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const group of splitByGaps(line.words as Word[], o.columnGap)) {
          const text = group.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
          const confidence = group.reduce((s, w) => s + w.confidence, 0) / group.length;
          const x0 = Math.min(...group.map((w) => w.bbox.x0));
          const y0 = Math.min(...group.map((w) => w.bbox.y0));
          const box = [x0, y0, Math.max(1, Math.max(...group.map((w) => w.bbox.x1)) - x0), Math.max(1, Math.max(...group.map((w) => w.bbox.y1)) - y0)] as const;
          if (text) lines.push({ text, confidence, tone: toneOf(ctx.getImageData(...box).data), x: x0, h: box[3] });
        }
      }
    }
  }
  return lines;
}

/** Lit les lignes de texte d'une image (capture collée ou choisie). */
export async function readImageLines(
  image: Blob,
  progress?: (p: OcrProgress) => void,
  options: OcrOptions = {},
): Promise<OcrLine[]> {
  const o = { ...DEFAULT_OCR_OPTIONS, ...options };
  onProgress = progress ?? null;
  try {
    const [worker, canvas] = await Promise.all([getWorker(), preprocess(image, o.preprocess)]);
    return await readWith(worker, image, o, Promise.resolve(canvas));
  } finally {
    onProgress = null;
  }
}

/** Nombre de workers pour un lot : au plus 3 (chacun charge les données de langue), un cœur laissé à la page. */
export function poolSize(images: number, cores: number): number {
  return Math.max(1, Math.min(3, cores - 1, images));
}

/** Lit plusieurs images en parallèle (petit lot de workers) ; lignes de chaque image DANS L'ORDRE d'entrée. */
export async function readImagesLines(
  images: Blob[],
  options: OcrOptions = {},
  onDone?: (done: number, total: number) => void,
): Promise<OcrLine[][]> {
  if (images.length === 1) {
    const lines = await readImageLines(images[0], undefined, options);
    onDone?.(1, 1);
    return [lines];
  }
  const o = { ...DEFAULT_OCR_OPTIONS, ...options };
  const n = poolSize(images.length, navigator.hardwareConcurrency || 2);
  const workers = await Promise.all(Array.from({ length: n }, (_, i) => (i === 0 ? getWorker() : createTessWorker())));
  const out: OcrLine[][] = new Array(images.length);
  let next = 0;
  let done = 0;
  try {
    await Promise.all(
      workers.map(async (worker) => {
        while (next < images.length) {
          const i = next++;
          out[i] = await readWith(worker, images[i], o);
          onDone?.(++done, images.length);
        }
      }),
    );
    return out;
  } finally {
    // le premier est le worker partagé : gardé
    await Promise.allSettled(workers.slice(1).map((w) => w.terminate()));
  }
}

/** Caractères des noms courts (lettres, chiffres, quelques signes) : le bruit des icônes ne donne plus de symboles. */
const SHORT_NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÂÇÉÈÊËÎÏÔÙÛÜàâçéèêëîïôùûü0123456789-.#'/_ ";

/**
 * Lit des bandes d'une seule ligne (noms courts d'une capture de conteneur, voir lib/containerGrid).
 * Le worker est partagé : la liste de caractères est remise à vide ensuite (la page seg. est
 * redonnée par readImageLines à chaque lecture).
 */
export async function readStripWords(
  strips: HTMLCanvasElement[],
  progress?: (done: number) => void,
): Promise<{ text: string; confidence: number; x0: number; x1: number }[][]> {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: "7" as never, tessedit_char_whitelist: SHORT_NAME_CHARS });
  try {
    const out: { text: string; confidence: number; x0: number; x1: number }[][] = [];
    for (const strip of strips) {
      const { data } = await worker.recognize(strip, {}, { blocks: true });
      const words: { text: string; confidence: number; x0: number; x1: number }[] = [];
      for (const block of data.blocks ?? [])
        for (const paragraph of block.paragraphs)
          for (const line of paragraph.lines) for (const w of line.words) words.push({ text: w.text, confidence: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1 });
      out.push(words);
      progress?.(out.length / strips.length);
    }
    return out;
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: "" });
  }
}
