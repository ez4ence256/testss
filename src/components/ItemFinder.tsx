// Item finder (barre du haut) : tous les objets du jeu avec leur photo ; l'objet choisi est cherché dans
// toutes les quêtes, le hideout, les barters et les crafts. Données chargées à la première ouverture.
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GameMap, GameMode, Task, Trader } from "../types";
import { tr } from "../lib/i18n";
import { UiIcon } from "./UiIcon";
import { scoreName } from "../lib/search";
import { RECOGNIZED_MIN, matchItemLines } from "../lib/ocrMatch";
import { iconSrc } from "../lib/itemIcons";
import { matchImage, type Rgba } from "../lib/itemImage";
import { looksLikeInspect, matchInspect } from "../lib/itemInspect";
import { buildUsageIndex, durationLabel, useLabel, type Exchange, type QuestUse } from "../lib/itemUsage";
import { loadExchanges, loadHideout, loadItemCategories, loadItemImages, loadItemInspect, loadItemList, loadItemWhere, type HideoutInfo, type ListedItem } from "../api/itemList";
import { loadItemLocation, type ItemLocation, type LocationSectionTitle } from "../api/itemLocation";
import type { Spot } from "../lib/itemSpots";
import type { ItemSpotMarker } from "../map/ItemSpotsLayer";
import { BlocksWithPhotos, splitAtHeadings } from "./StoryView";
import { Icon } from "./Icon";
import { CUSTOM_ICONS, ICON_LABELS, type IconId } from "../lib/objectiveTypes";
import { iconUrl } from "../api/tarkovJson";
import { buildCategoryTree, OTHER, type CategoryNode } from "../lib/itemCategories";
import { ItemThumb } from "./ItemThumb";
import { isTaskFinished } from "../lib/points";
import { isGreyed } from "../lib/questChain";
import { STATUS_LABELS } from "../lib/questWiki";
import { ObjectiveItems } from "./ObjectiveItems";
import { TaskRewardList } from "./QuestTab";
import type { ItemNeed, NeedSource } from "../lib/itemNeeds";
import { isStaleBuildError, staleBuildMessage } from "../lib/staleBuild";
import { ContainerScan, type ScanState } from "./ContainerScan";
import type { Found } from "../lib/containerGrid";

const PAGE = 100;

/** Lecture d'une capture collée (Ctrl+V) : null = recherche normale. */
/** Filtre « À garder pour » : la planque, à côté des identifiants de marchands. */
const HIDEOUT = "hideout";
const KAPPA = "kappa";

type OcrState = { step: "reading"; progress: number | null } | { step: "done"; text: ListedItem[]; image: ListedItem[] } | { step: "error"; stale?: boolean };

/** Image collée -> pixels, à sa taille d'origine (la réduction se fait dans lib/itemImage). */
async function blobPixels(blob: Blob): Promise<Rgba> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Données téléchargées à la demande quand un objet est choisi (gardées en mémoire par api/itemList). */
function useLazy<T>(wanted: boolean, load: () => Promise<T>, deps: unknown[]): { data: T | null; error: boolean } {
  const [state, setState] = useState<{ data: T | null; error: boolean }>({ data: null, error: false });
  const has = state.data !== null;
  useEffect(() => {
    if (!wanted || has) return;
    let cancelled = false;
    setState({ data: null, error: false });
    load().then((data) => !cancelled && setState({ data, error: false }), () => !cancelled && setState({ data: null, error: true }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, has, ...deps]);
  return state;
}

interface Props {
  gameMode: GameMode;
  lang: string;
  tasks: Task[];
  traders: Trader[];
  maps: GameMap[];
  itemNames: Record<string, string>;
  itemIcons: Record<string, string>;
  onShowQuest: (taskId: string) => void;
  /** « Voir sur la carte » : tous les spots de l'objet, et celui à centrer. */
  onShowSpots: (spots: ItemSpotMarker[], focus: ItemSpotMarker) => void;
  /** « Ajouter un point perso » à l'emplacement d'un spot. */
  onAddPoint: (point: NewPoint) => void;
  /** Objectifs cochés (objectiveId -> date) : quêtes terminées grisées dans l'onglet Quêtes. */
  done: Record<string, number>;
  /** Quêtes échouées : grisées comme les terminées. */
  failed?: Record<string, true>;
  /** Objets à garder (quêtes pas faites, planque si incluse) : badges À GARDER / VENDABLE et bloc « À garder ». */
  needs: Map<string, ItemNeed>;
  /** La planque compte-t-elle dans les objets à garder ? (sinon le filtre « Planque » propose de l'inclure) */
  hideoutIncluded?: boolean;
  onIncludeHideout?: () => void;
  /** Niveaux construits de la planque (stationId -> niveau, -1 = ignorée) : niveaux déjà faits grisés. */
  hideoutLevels?: Record<string, number>;
  /** « rail » : bouton de la barre latérale (icône au-dessus du libellé). */
  variant?: "rail";
}

export interface NewPoint {
  mapId: string;
  x: number;
  z: number;
  icon: IconId;
  label: string;
  note: string;
}

export function ItemFinder(props: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <>
      <button ref={toggle} className={props.variant === "rail" ? "rail-item" : "btn btn-small item-finder-btn"} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={tr("Item finder : chercher un objet", "Item finder: search an item")} title={tr("Chercher où sert un objet", "Find where an item is used")}>
        <UiIcon id="search" size={props.variant === "rail" ? 22 : 18} />
        <span className={props.variant === "rail" ? "rail-label" : "item-finder-label"}>{tr("Objets", "Items")}</span>
      </button>
      {open && <FinderDialog {...props} onClose={close} />}
    </>
  );
}

function FinderDialog({ gameMode, lang, tasks, traders, maps, itemNames, itemIcons, onShowQuest, onShowSpots, onAddPoint, done, failed, needs, hideoutIncluded, onIncludeHideout, hideoutLevels, onClose }: Props & { onClose: () => void }) {
  const [list, setList] = useState<ListedItem[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<ListedItem | null>(null);
  const [ocr, setOcr] = useState<OcrState | null>(null);
  // onglet « Conteneur » : capture d'une junk box / d'un sac, objets à vendre ou à garder
  const [mode, setMode] = useState<"search" | "container">("search");
  const [scan, setScan] = useState<ScanState | null>(null);
  // catégories du flea : arbre, catégorie choisie (filtre la grille), catégories ouvertes
  const [tree, setTree] = useState<CategoryNode[] | null>(null);
  const [cat, setCat] = useState<CategoryNode | null>(null);
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  // « Kappa seulement » : objets à remettre pour les quêtes demandées pour la Kappa
  const [kappaOnly, setKappaOnly] = useState(false);
  // « Planque » : objets de la planque ; cochée avec « Kappa seulement », les deux à la fois
  const [hideoutOnly, setHideoutOnly] = useState(false);
  // marchand choisi sous les catégories : objets qui restent à remettre pour ses quêtes (aucun au départ)
  const [trader, setTrader] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const search = useRef<HTMLInputElement>(null);
  const run = useRef(0); // numéro de la dernière lecture : un résultat périmé est ignoré
  const pasteRef = useRef<(blob: Blob) => void>(() => {});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    loadItemList(gameMode, lang).then((l) => !cancelled && setList(l), () => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [gameMode, lang]);

  // téléchargés en parallèle quand un objet est choisi (les crafts ont besoin des noms de stations du hideout)
  const picked = Boolean(selected);
  const hideout = useLazy(picked, () => loadHideout(gameMode, lang), [gameMode, lang]);
  const barters = useLazy(picked, () => loadExchanges(gameMode, "barters"), [gameMode]);
  const crafts = useLazy(picked, () => loadExchanges(gameMode, "crafts"), [gameMode]);

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    // image collée : lue ici, et jamais envoyée à la capture de quêtes de App (écouteur window, plus haut dans la propagation)
    const onPaste = (e: ClipboardEvent) => {
      const blob = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
      if (!blob) return; // collage de texte normal dans la recherche
      e.preventDefault();
      e.stopPropagation();
      pasteRef.current(blob);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      run.current++; // fermeture : le résultat en cours est ignoré
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  // objets du jeu + objets de quête (absents des fichiers d'objets) connus de l'app
  const all = useMemo(() => {
    if (!list) return null;
    const known = new Set(list.map((i) => i.id));
    const extra = Object.entries(itemNames)
      .filter(([id]) => !known.has(id))
      .map(([id, name]): ListedItem => ({ id, name, alts: [name], nameEn: name }));
    return extra.length ? [...list, ...extra].sort((a, b) => a.name.localeCompare(b.name, lang)) : list;
  }, [list, itemNames, lang]);

  useEffect(() => {
    if (!all) return;
    let cancelled = false;
    loadItemCategories(gameMode, lang)
      .then(({ file, names }) => !cancelled && setTree(buildCategoryTree(file, names, all.map((i) => i.id), tr("Autres", "Other"))))
      .catch(() => undefined); // sans catégories : la recherche seule
    return () => {
      cancelled = true;
    };
  }, [all, gameMode, lang]);

  // image de la capture affichée sous le résultat : libérée à la suivante et à la fermeture
  const shotUrl = useRef<string | null>(null);
  useEffect(() => () => void (shotUrl.current && URL.revokeObjectURL(shotUrl.current)), []);
  // capture collée avant que la liste des objets soit là : lue dès son arrivée
  const pendingShot = useRef<Blob | null>(null);
  const scanContainer = async (blob: Blob) => {
    const id = ++run.current;
    setSelected(null);
    setScan({ step: "reading", progress: null });
    if (!all) {
      pendingShot.current = blob;
      return;
    }
    try {
      const [pixels, grid, { readStripWords }] = await Promise.all([blobPixels(blob), import("../lib/containerGrid"), import("../lib/ocr")]);
      const g = grid.detectGrid(pixels);
      if (!g) {
        if (id === run.current)
          setScan({ step: "error", message: tr("Pas de grille de cases dans cette image : colle une capture du conteneur ouvert, cases visibles.", "No grid of cells in this image: paste a screenshot of the open container, cells visible.") });
        return;
      }
      const tops = grid.rowTops(g, pixels.height);
      const canvasOf = (s: { width: number; height: number; data: ArrayLike<number> }) => {
        const canvas = document.createElement("canvas");
        canvas.width = s.width;
        canvas.height = s.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(s.data), s.width, s.height), 0, 0);
        return canvas;
      };
      const strips = tops.map((top) => grid.nameStrip(pixels, g, top));
      const words = await readStripWords(strips.map(canvasOf), (done) => id === run.current && setScan({ step: "reading", progress: done * 0.7 }));
      if (id !== run.current) return;
      const index = grid.buildShortIndex(all);
      const read: Found[] = [];
      const weak: Found[] = []; // noms de 2 lettres mal assurés, gardés si deux lectures concordent
      const add = (found: Found[]) => found.forEach((f) => (f.weak ? weak : read).push(f));
      add(words.flatMap((w, row) => grid.matchStrip(grid.tightWords(strips[row], w, g), g, row, index)));
      // cases restées sans nom mais avec des lettres : relues une par une, en noir et blanc, en gris, puis en gris sans les bouts de bord autour du nom
      const grays = tops.map((top) => grid.nameStrip(pixels, g, top, true));
      for (const [n, [pass, band]] of ([[strips, false], [grays, false], [grays, true]] as const).entries()) {
        const retry = strips.flatMap((s, row) => grid.unreadCells(s, g, read.filter((f) => f.row === row)).map((col) => ({ row, col, ...grid.cellStrip(pass[row], g, col, band) })));
        const again = await readStripWords(retry.map((r) => canvasOf(r.img)), (done) => id === run.current && setScan({ step: "reading", progress: 0.7 + (n + done) * 0.1 }));
        if (id !== run.current) return;
        retry.forEach((r, i) => {
          const moved = grid.tightWords(strips[r.row], again[i].map((w) => ({ ...w, x0: w.x0 + r.shift, x1: w.x1 + r.shift })), g);
          add(grid.matchStrip(moved, g, r.row, index).filter((f) => f.col === r.col && grid.retryRead(f, index, band)).map((f) => ({ ...f, retry: true as const })));
        });
      }
      read.push(...grid.agreed(weak, read));
      read.sort((a, b) => a.row - b.row || a.col - b.col);
      const sizes = grid.itemSizes(pixels, g, read, tops);
      const found = read.flatMap((f, i) => (sizes[i] ? [{ ...f, ...sizes[i], x: g.ox + f.col * g.pitch, y: tops[f.row] }] : []));
      // nom porté par plusieurs objets : leur image départage (balle ou boîte, figurine ou masque) ; sans les
      // images (hors ligne), tous restent
      if (found.some((f) => f.ids.length > 1)) {
        const images = await loadItemImages().catch(() => null);
        if (id !== run.current) return;
        if (images) {
          const thumbOf = new Map(images.ids.map((k, i) => [k, images.thumbs[i]]));
          for (const f of found)
            if (f.ids.length > 1) f.ids = grid.narrowByIcon(f.ids, grid.iconScores(pixels, g, f.y, f, f.ids.flatMap((k) => (thumbOf.has(k) ? [{ id: k, thumb: thumbOf.get(k)! }] : []))));
        }
      }
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
      shotUrl.current = URL.createObjectURL(blob);
      setScan({ step: "done", url: shotUrl.current, width: pixels.width, height: pixels.height, pitch: g.pitch, found });
    } catch (error) {
      if (id === run.current)
        setScan({ step: "error", message: isStaleBuildError(error) ? staleBuildMessage() : tr("Lecture impossible. La première utilisation demande une connexion (données de langue).", "Could not read the image. The first use needs a connection (language data).") });
    }
  };

  useEffect(() => {
    if (!all || !pendingShot.current) return;
    const blob = pendingShot.current;
    pendingShot.current = null;
    void scanContainer(blob);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seulement à l'arrivée de la liste
  }, [all]);

  pasteRef.current = async (blob) => {
    if (mode === "container") return scanContainer(blob);
    const id = ++run.current;
    if (!all) return setOcr({ step: "error" });
    setOcr({ step: "reading", progress: null });
    // texte (OCR) et image en même temps ; l'un peut échouer sans l'autre
    const [text, image] = await Promise.allSettled([
      import("../lib/ocr").then(({ readImageLines }) => readImageLines(blob, (p) => id === run.current && setOcr({ step: "reading", progress: p.progress }))),
      // fenêtre d'inspection (objet entier sur fond rayé) ou case d'inventaire : deux méthodes, deux fichiers
      blobPixels(blob).then(async (pixels) =>
        looksLikeInspect(pixels) ? matchInspect(pixels, await loadItemInspect()) : matchImage(pixels, await loadItemImages(), () => id !== run.current),
      ),
    ]);
    if (id !== run.current) return;
    if (text.status === "rejected" && image.status === "rejected") return setOcr({ step: "error", stale: isStaleBuildError(text.reason) });
    const byText = text.status === "fulfilled" ? matchItemLines(text.value.map((l) => l.text), all) : [];
    const byImage = image.status === "fulfilled" ? image.value.map((m) => byId.get(m.id)).filter((i): i is ListedItem => Boolean(i)) : [];
    const sure = byText.filter((m) => m.score >= RECOGNIZED_MIN);
    // lecture sûre : elle seule ; sinon 3 lectures incertaines au plus, et les ressemblances d'image (sans doublon)
    const textItems = (sure.length ? sure : byText.slice(0, 3)).map((m) => m.item);
    setQuery("");
    setSelected(sure.length === 1 ? sure[0].item : null);
    setOcr({ step: "done", text: textItems, image: sure.length ? [] : byImage.filter((i) => !textItems.includes(i)) });
  };

  const q = useDeferredValue(query);
  const results = useMemo(() => {
    if (!all) return [];
    if (!q.trim()) return all;
    return all
      .map((item) => ({ item, score: Math.max(...item.alts.map((a) => scoreName(q, a))) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [all, q]);
  // marchand -> objets à lui remettre (quêtes pas grisées, mêmes sources que les badges « À garder »)
  const traderItems = useMemo(() => {
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    const out = new Map<string, Set<string>>();
    const add = (id: string, itemId: string) => out.set(id, (out.get(id) ?? new Set()).add(itemId));
    for (const [itemId, need] of needs)
      for (const s of need.sources) {
        // la planque est rangée sous la clé HIDEOUT, la Kappa sous KAPPA, à côté des marchands
        if (s.kind !== "quest") add(HIDEOUT, itemId);
        else {
          const t = byTask.get(s.taskId);
          if (t) add(t.traderId, itemId);
          if (t?.kappaRequired) add(KAPPA, itemId);
        }
      }
    return out;
  }, [needs, tasks]);
  const pools = useMemo(() => [...(kappaOnly ? [KAPPA] : []), ...(hideoutOnly ? [HIDEOUT] : [])], [kappaOnly, hideoutOnly]);
  const filtered = useMemo(
    () =>
      results.filter(
        (i) => (!cat || cat.items.has(i.id)) && (!onlyNeeded || needs.has(i.id)) && (!trader || Boolean(traderItems.get(trader)?.has(i.id))) &&
          (!pools.length || pools.some((k) => traderItems.get(k)?.has(i.id))),
      ),
    [results, cat, onlyNeeded, needs, trader, traderItems, pools],
  );
  useEffect(() => setShown(PAGE), [q, cat, onlyNeeded, trader, pools]);
  const pickCategory = (node: CategoryNode) => {
    setCat((c) => (c?.id === node.id ? null : node));
    setOpen((o) => new Set(o).add(node.id));
  };
  const toggleCategory = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const tiles = (items: ListedItem[]) => (
    <ul className="finder-grid">
      {items.map((item) => (
        <li key={item.id}>
          <button className="finder-tile" title={item.name} onClick={() => setSelected(item)}>
            <span className="finder-icon">
              <ItemThumb src={iconSrc(item.id, itemIcons)} name="" size={56} />
            </span>
            <span className="finder-tile-name">{item.name}</span>
            <NeedBadge need={needs.get(item.id)} />
          </button>
        </li>
      ))}
    </ul>
  );

  const usage = useMemo(() => buildUsageIndex(tasks), [tasks]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  /** Pourquoi garder un objet du conteneur, avec les filtres actuels (mêmes règles que les tuiles et « Kappa seulement » / « Planque »). */
  const keepReasons = (itemId: string): string[] => {
    const need = needs.get(itemId);
    if (!need || (pools.length && !pools.some((k) => traderItems.get(k)?.has(itemId)))) return [];
    return [
      ...new Set(
        need.sources
          .filter((s) => (s.kind === "quest" ? !pools.length || (kappaOnly && tasksById.get(s.taskId)?.kappaRequired) : !pools.length || hideoutOnly))
          .map((s) => (s.kind === "quest" ? (tasksById.get(s.taskId)?.name ?? s.taskId) : tr("Planque", "Hideout"))),
      ),
    ];
  };
  const byId = useMemo(() => new Map((all ?? []).map((i) => [i.id, i])), [all]);

  const banner = (
    <>
          {ocr && (
            <div className="finder-ocr" role="status">
              <span>
                {ocr.step === "reading"
                  ? ocr.progress === null
                    ? tr("Lecture de la capture…", "Reading the screenshot…")
                    : tr(`Lecture de la capture… ${Math.round(ocr.progress * 100)} %`, `Reading the screenshot… ${Math.round(ocr.progress * 100)}%`)
                  : ocr.step === "error"
                    ? !all
                      ? tr("Liste des objets pas encore chargée.", "Item list not loaded yet.")
                      : ocr.stale
                        ? staleBuildMessage()
                        : tr("Lecture impossible. La première utilisation demande une connexion (données de langue).", "Could not read the image. The first use needs a connection (language data).")
                    : ocr.text.length + ocr.image.length
                      ? tr("Capture lue : choisis l'objet ci-dessous.", "Screenshot read: pick the item below.")
                      : tr("Aucun objet reconnu dans la capture.", "No item recognized in the screenshot.")}
              </span>
              {ocr.step !== "reading" && (
                <button className="btn btn-small" onClick={() => setOcr(null)}>
                  {tr("Effacer", "Clear")}
                </button>
              )}
            </div>
          )}
    </>
  );

  return (
    <div className="finder-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-modal="true" aria-label="Item finder">
        <div role="tablist" className="finder-tabs finder-modes" aria-label={tr("Mode", "Mode")}>
          {(
            [
              ["search", tr("Recherche", "Search")],
              ["container", tr("Conteneur (vendre)", "Container (sell)")],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`finder-tab${mode === m ? " active" : ""}`}
              onClick={() => {
                setMode(m);
                setSelected(null);
                run.current++;
                setOcr(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="finder-head">
          {mode === "container" ? (
            <p className="finder-container-hint">{tr("Ctrl+V n'importe quel conteneur ou inventaire : vois tout de suite quoi vendre ou garder", "Ctrl+V any container or inventory: instantly see what to sell or keep")}</p>
          ) : (
          <div className="finder-search-wrap">
            <span className="finder-search-icon" aria-hidden="true"><UiIcon id="search" /></span>
            <input
              ref={search}
              className="input finder-search"
              type="search"
              value={query}
              placeholder={tr("Nom d'un objet (FR ou EN) ou Ctrl+V d'une capture…", "Item name (FR or EN) or Ctrl+V a screenshot…")}
              aria-label={tr("Chercher un objet", "Search an item")}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(null);
                run.current++;
                setOcr(null);
              }}
            />
          </div>
          )}
          {mode === "search" && (
            <label className="check finder-only-need">
              <input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} />
              {tr("Afficher seulement les objets nécessaires", "Show only the needed items")}
            </label>
          )}
          <label className="check finder-only-need">
            <input type="checkbox" checked={kappaOnly} onChange={(e) => setKappaOnly(e.target.checked)} />
            {tr("Kappa seulement", "Kappa only")}
          </label>
          <label className="check finder-only-need" title={hideoutIncluded ? undefined : tr("Ajoute les objets de la planque aux objets à garder", "Adds the hideout items to the items to keep")}>
            <input
              type="checkbox"
              checked={hideoutOnly}
              onChange={(e) => {
                if (e.target.checked && !hideoutIncluded) onIncludeHideout?.();
                setHideoutOnly(e.target.checked);
              }}
            />
            {tr("Planque", "Hideout")}
          </label>
          <button className="btn btn-small" onClick={onClose} aria-label={tr("Fermer", "Close")}>
            <UiIcon id="x" />
          </button>
        </div>

        <div className={`finder-body${all && !selected && !error && mode === "search" ? " finder-split" : ""}`}>
          {error ? (
            <>
              {banner}
              <p className="muted">{tr("Liste des objets indisponible (réseau ?).", "Item list unavailable (network?).")}</p>
            </>
          ) : !all ? (
            <>
              {banner}
              <p className="muted" role="status">{tr("Chargement des objets…", "Loading items…")}</p>
            </>
          ) : selected ? (
            <>
              {banner}
              <Usage
                key={selected.id}
                item={selected}
                src={iconSrc(selected.id, itemIcons)}
                quests={usage.get(selected.id) ?? []}
                tasksById={tasksById}
                traders={traders}
                maps={maps}
                hideout={hideout}
                barters={barters}
                crafts={crafts}
                byId={byId}
                itemIcons={itemIcons}
                itemNames={itemNames}
                onBack={() => setSelected(null)}
                onShowQuest={(id) => {
                  onShowQuest(id);
                  onClose();
                }}
                onShowSpots={(spots, focus) => {
                  onShowSpots(spots, focus);
                  onClose();
                }}
                onAddPoint={onAddPoint}
                done={done}
                failed={failed}
                hideoutLevels={hideoutLevels}
                need={needs.get(selected.id)}
                kappaOnly={kappaOnly}
              />
            </>
          ) : mode === "container" ? (
            <ContainerScan
              scan={scan}
              byId={byId}
              iconSrc={(id) => iconSrc(id, itemIcons)}
              keepReasons={keepReasons}
              filterLabel={pools.length ? [kappaOnly && tr("quêtes Kappa", "Kappa quests"), hideoutOnly && tr("planque", "hideout")].filter(Boolean).join(" + ") : null}
              onPick={setSelected}
              onFile={(file) => scanContainer(file)}
            />
          ) : (
            <>
              <div className="finder-main">
                {banner}
                {!ocr && (
                  <p className="muted finder-count" role="status">
                    {tr(`${filtered.length} objet(s)`, `${filtered.length} item(s)`)}
                    {cat && ` · ${cat.name}`}
                  </p>
                )}
                {ocr?.step === "done" ? (
                  <>
                    {ocr.text.length > 0 && <h3 className="finder-sub">{tr("Lu dans le texte", "Read from the text")}</h3>}
                    {ocr.text.length > 0 && tiles(ocr.text)}
                    {ocr.image.length > 0 && <h3 className="finder-sub">{tr("Ressemble à l'image", "Looks like the image")}</h3>}
                    {ocr.image.length > 0 && tiles(ocr.image)}
                  </>
                ) : ocr?.step === "reading" ? null : (
                  tiles(filtered.slice(0, shown))
                )}
                {!ocr && filtered.length > shown && (
                  <div className="finder-more">
                    <button className="btn btn-small" onClick={() => setShown((n) => n + PAGE)}>
                      {tr("Afficher plus", "Show more")}
                    </button>
                  </div>
                )}
              </div>
              {tree && !ocr && (
                <nav className="finder-cats" aria-label={tr("Catégories", "Categories")}>
                  <button className={`finder-cat finder-cat-all${cat ? "" : " is-selected"}`} aria-pressed={!cat} onClick={() => setCat(null)}>
                    {tr("Tous les objets", "All items")} <span className="finder-cat-count">({all.length})</span>
                  </button>
                  <CategoryTree nodes={tree} depth={0} selected={cat?.id ?? null} open={open} onPick={pickCategory} onToggle={toggleCategory} />
                  <div className="subhead finder-traders-head">{tr("À garder pour", "To keep for")}</div>
                  <button className={`finder-cat finder-cat-all${trader ? "" : " is-selected"}`} aria-pressed={!trader} onClick={() => setTrader(null)}>
                    {tr("Tout le monde", "Everyone")}
                  </button>
                  <button
                    className={`finder-cat finder-trader${trader === HIDEOUT ? " is-selected" : ""}`}
                    aria-pressed={trader === HIDEOUT}
                    title={hideoutIncluded ? undefined : tr("Ajoute les objets de la planque aux objets à garder", "Adds the hideout items to the items to keep")}
                    onClick={() => {
                      if (!hideoutIncluded) onIncludeHideout?.();
                      setTrader((x) => (x === HIDEOUT ? null : HIDEOUT));
                    }}
                  >
                    <span className="finder-cat-name">{tr("Planque", "Hideout")}</span>{" "}
                    <span className="finder-cat-count">
                      {hideoutIncluded ? `(${traderItems.get(HIDEOUT)?.size ?? 0})` : tr("(l'inclure)", "(include it)")}
                    </span>
                  </button>
                  {traders
                    .filter((t) => traderItems.has(t.id))
                    .map((t) => (
                      <button
                        key={t.id}
                        className={`finder-cat finder-trader${trader === t.id ? " is-selected" : ""}`}
                        aria-pressed={trader === t.id}
                        onClick={() => setTrader((x) => (x === t.id ? null : t.id))}
                      >
                        {t.imageLink && <img className="finder-trader-img" src={t.imageLink} alt="" width={22} height={22} loading="lazy" />}
                        <span className="finder-cat-name">{t.name}</span> <span className="finder-cat-count">({traderItems.get(t.id)!.size})</span>
                      </button>
                    ))}
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pastille d'une tuile : À GARDER (en évidence) ou VENDABLE (discret). */
function NeedBadge({ need }: { need?: ItemNeed }) {
  if (!need) return <span className="finder-need">{tr("VENDABLE", "SELLABLE")}</span>;
  const parts = [need.count > 0 ? tr(`À GARDER ×${need.count}`, `KEEP ×${need.count}`) : tr("À GARDER", "KEEP")];
  if (need.firCount > 0) parts.push("FIR");
  if (need.anyOf) parts.push(tr("au choix", "any of"));
  return <span className="finder-need is-need">{parts.join(" · ")}</span>;
}

type Tab = "quests" | "hideout" | "barters" | "crafts" | "where";

/** Titres des sections d'emplacement du wiki (pages d'objets et de clés). */
const LOCATION_TITLE: Record<LocationSectionTitle, [string, string]> = {
  Location: ["Emplacements connus", "Known locations"],
  "Key Location": ["Où trouver la clé", "Where to find the key"],
  "Lock Location": ["Où est la serrure", "Where the lock is"],
  "Behind the Lock": ["Derrière la serrure", "Behind the lock"],
};
type Lazy<T> = { data: T | null; error: boolean };

function Usage(p: {
  item: ListedItem;
  src: string;
  quests: QuestUse[];
  tasksById: Map<string, Task>;
  traders: Trader[];
  maps: GameMap[];
  hideout: Lazy<HideoutInfo>;
  barters: Lazy<Map<string, Exchange[]>>;
  crafts: Lazy<Map<string, Exchange[]>>;
  byId: Map<string, ListedItem>;
  itemIcons: Record<string, string>;
  itemNames: Record<string, string>;
  onBack: () => void;
  onShowQuest: (taskId: string) => void;
  onShowSpots: (spots: ItemSpotMarker[], focus: ItemSpotMarker) => void;
  onAddPoint: (point: NewPoint) => void;
  done: Record<string, number>;
  failed?: Record<string, true>;
  hideoutLevels?: Record<string, number>;
  need?: ItemNeed;
  /** « Kappa seulement » : les quêtes non demandées pour la Kappa passent dans un bloc à part. */
  kappaOnly?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("quests");
  // quête dépliée sur place (on reste dans la fiche de l'objet au lieu d'aller à la fiche quête)
  const [openQuest, setOpenQuest] = useState<string | null>(null);
  const [wikiTitles, setWikiTitles] = useState<Record<string, string>>({});
  // « Où le trouver » : meilleurs spots (fichier généré) puis la page wiki de l'objet
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [location, setLocation] = useState<ItemLocation | "!" | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadItemWhere()
      .then((where) => {
        if (cancelled) return;
        setSpots(where.spots[p.item.id] ?? []);
        setWikiTitles(where.wiki);
        return loadItemLocation(where.wiki[p.item.id] ?? p.item.nameEn).then((loc) => !cancelled && setLocation(loc));
      })
      .catch(() => !cancelled && setLocation("!"));
    return () => {
      cancelled = true;
    };
    // la fiche est recréée pour chaque objet (key)
  }, []);
  const wikiSections = location && location !== "!" ? location.sections : [];
  const wikiCount = wikiSections.reduce((n, s) => n + s.blocks.reduce((m, b) => m + (b.type === "list" ? b.items.length : 0), 0), 0);
  const linked = new Set(location && location !== "!" ? location.links.map((l) => l.toLowerCase()) : []);
  // spots dont la map n'a pas de sous-titre dans la section Location : ils montreraient tous le même texte
  // (« Key Location » d'une clé…) ; il n'est affiché que dans le premier
  const mapHeadings = new Set(
    wikiSections.find((s) => s.title === "Location")?.blocks.flatMap((b) => (b.type === "heading" ? [b.text.toLowerCase()] : [])) ?? [],
  );
  const sharedAt = (spots ?? []).findIndex(([mapName]) => {
    const map = p.maps.find((m) => m.normalizedName === mapName);
    return !mapHeadings.has((map?.nameEn ?? map?.name ?? mapName).toLowerCase());
  });
  const markers: ItemSpotMarker[] = (spots ?? []).flatMap(([mapName, x, y, z, n, , keyId], i) => {
    const map = p.maps.find((m) => m.normalizedName === mapName);
    if (!map) return [];
    const key = keyId ? p.byId.get(keyId) : undefined;
    return [{ key: `spot:${i}`, mapId: map.id, x, y, z, rank: i + 1, item: p.item.name, details: [tr(`${n} point(s) d'apparition regroupés`, `${n} spawn point(s) grouped`), ...(!key ? [] : linked.has(key.nameEn.toLowerCase()) ? [tr(`Derrière la porte : ${key.name} (confirmé par le wiki)`, `Behind the door: ${key.name} (confirmed by the wiki)`)] : [tr(`Porte fermée à proximité : ${key.name}`, `Locked door nearby: ${key.name}`)])] }];
  });
  const rows = p.quests
    .map((u) => ({ ...u, task: p.tasksById.get(u.taskId) }))
    .filter((r): r is typeof r & { task: Task } => Boolean(r.task))
    .sort((a, b) => a.task.name.localeCompare(b.task.name));
  const hideoutRows = (p.hideout.data?.uses.get(p.item.id) ?? [])
    .map((h) => ({ ...h, name: p.hideout.data?.stationName[h.stationId] ?? h.stationId }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level);
  const barterRows = p.barters.data?.get(p.item.id) ?? [];
  const craftRows = p.crafts.data?.get(p.item.id) ?? [];

  // nombre par onglet : null = en chargement, "!" = indisponible (les crafts ont aussi besoin du hideout)
  const counts: Record<Tab, number | "!" | null> = {
    quests: rows.length,
    hideout: p.hideout.error ? "!" : p.hideout.data ? hideoutRows.length : null,
    barters: p.barters.error ? "!" : p.barters.data ? barterRows.length : null,
    crafts: p.crafts.error || p.hideout.error ? "!" : p.crafts.data && p.hideout.data ? craftRows.length : null,
    where: spots === null || location === null ? null : (spots.length || 0) + wikiCount || (location === "!" ? "!" : 0),
  };
  const tabs: [Tab, string][] = [
    ["quests", tr("Quêtes", "Quests")],
    ["hideout", "Hideout"],
    ["barters", "Barters"],
    ["crafts", "Crafts"],
    ["where", tr("Où le trouver", "Where to find")],
  ];

  /** Contenu d'un onglet dont les données sont chargées à la demande. */
  const gate = (t: Tab, body: () => ReactNode) => {
    const c = counts[t];
    if (c === null) return <p className="muted finder-empty" role="status">{tr("Chargement…", "Loading…")}</p>;
    if (c === "!") return <p className="muted finder-empty">{tr("Données indisponibles (réseau ?).", "Data unavailable (network?).")}</p>;
    return body();
  };
  const exchanges = (list: Exchange[], source: (e: Exchange) => string) =>
    list.length === 0 ? (
      <p className="muted finder-empty">{tr("Aucun résultat.", "None.")}</p>
    ) : (
      <>
        {(["in", "out"] as const).map((side) => {
          const part = list.filter((e) => e.side === side);
          if (part.length === 0) return null;
          return (
            <section key={side}>
              {part.length < list.length && <h3 className="finder-sub">{side === "in" ? tr("Utilisé dans", "Used in") : tr("Obtenu via", "Obtained from")}</h3>}
              <ul className="finder-cards">
                {part.map((e, i) => (
                  <Recipe key={i} e={e} source={source(e)} item={p.item} byId={p.byId} itemIcons={p.itemIcons} />
                ))}
              </ul>
            </section>
          );
        })}
      </>
    );

  return (
    <div className="finder-usage">
      <div className="finder-hero">
        <button className="btn btn-small" onClick={p.onBack} aria-label={tr("Retour à la liste", "Back to the list")} title={tr("Retour à la liste", "Back to the list")}>
          ←
        </button>
        <span className="finder-icon big">
          <ItemThumb src={p.src} name="" size={72} />
        </span>
        <h2 className="finder-name">{p.item.name}</h2>
      </div>
      <section className="finder-keep" aria-label={tr("À garder", "To keep")}>
        <h3 className="finder-sub">{tr("À garder", "To keep")}</h3>
        {!p.need ? (
          <p className="muted small">{tr("Aucune quête ni station ne le demande : vendable.", "No quest or station needs it: sellable.")}</p>
        ) : (
          (() => {
            const isNonKappa = (s: NeedSource) => p.kappaOnly === true && s.kind === "quest" && !p.tasksById.get(s.taskId)?.kappaRequired;
            const keep = p.need.sources.filter((s) => !isNonKappa(s));
            const nonKappa = p.need.sources.filter(isNonKappa);
            const list = (sources: NeedSource[]) => (
              <ul className="finder-keep-list">
                {sources.map((s, i) => (
                  <li key={i}>
                    {s.kind === "quest" ? (
                      <button className="link" onClick={() => p.onShowQuest(s.taskId)}>
                        {p.tasksById.get(s.taskId)?.name ?? s.taskId}
                      </button>
                    ) : (
                      <>
                        {p.hideout.data?.stationName[s.stationId] ?? s.stationId} · {tr("niv.", "lvl")} {s.level}
                      </>
                    )}{" "}
                    ×{s.count}
                    {s.fir && " FIR"}
                    {s.kind === "quest" && s.anyOf && ` · ${tr("au choix", "any of")}`}
                  </li>
                ))}
              </ul>
            );
            return (
              <>
                {keep.length > 0 ? list(keep) : <p className="muted small">{tr("Rien pour la Kappa ni la planque.", "Nothing for the Kappa or the hideout.")}</p>}
                {nonKappa.length > 0 && (
                  <div className="finder-keep-other">
                    <h4 className="finder-sub">{tr("Non Kappa", "Not Kappa")}</h4>
                    {list(nonKappa)}
                  </div>
                )}
              </>
            );
          })()
        )}
      </section>
      <div role="tablist" className="finder-tabs" aria-label={tr("Utilisations", "Uses")}>
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" id={`finder-tab-${t}`} aria-selected={tab === t} aria-controls={`finder-panel-${t}`} className={`finder-tab${tab === t ? " active" : ""}${counts[t] === 0 ? " dim" : ""}`} onClick={() => setTab(t)}>
            {label}
            <span className="finder-badge">{counts[t] ?? "…"}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`finder-panel-${tab}`} aria-labelledby={`finder-tab-${tab}`}>
        {tab === "where" &&
          gate("where", () => {
            // clé : ce qu'elle ouvre, toujours en tête (usage de l'infobox, serrure, ce qu'il y a derrière)
            const lockSections = wikiSections.filter((sec) => sec.title === "Lock Location" || sec.title === "Behind the Lock");
            const usageText = location && location !== "!" ? location.usage : undefined;
            const opens =
              usageText || lockSections.length ? (
                <section className="finder-opens">
                  <h3 className="finder-sub"><UiIcon id="key-round" /> {tr("Ce qu'elle ouvre", "What it opens")}</h3>
                  {usageText && <p>{usageText}</p>}
                  {lockSections.map((sec) => (
                    <section key={sec.title}>
                      <h4 className="finder-sub">{tr(...LOCATION_TITLE[sec.title])}</h4>
                      <BlocksWithPhotos blocks={sec.blocks} photos={sec.photos} itemNames={{}} itemIcons={p.itemIcons} showCaptions />
                    </section>
                  ))}
                </section>
              ) : null;
            const wiki = (
              <>
                {wikiSections.filter((sec) => !lockSections.includes(sec)).map((sec) => (
                  <section key={sec.title} className="finder-where-wiki">
                    <h3 className="finder-sub">{tr(...LOCATION_TITLE[sec.title])}</h3>
                    <BlocksWithPhotos blocks={sec.blocks} photos={sec.photos} itemNames={{}} itemIcons={p.itemIcons} showCaptions />
                  </section>
                ))}
                {location === "!" && <p className="muted finder-empty">{tr("Le wiki ne répond pas (réseau ?).", "The wiki is not responding (network?).")}</p>}
                {location !== "!" && location && wikiSections.length === 0 && (
                  <p className="muted finder-empty">{location.exists ? tr("Le wiki ne donne pas d'emplacement pour cet objet.", "The wiki gives no location for this item.") : tr("Pas de page pour cet objet sur le wiki.", "No page for this item on the wiki.")}</p>
                )}
                {location && location !== "!" && location.exists && (
                  <p className="muted small">
                    {tr("Texte : ", "Text: ")}
                    <a href={location.pageUrl} target="_blank" rel="noreferrer">
                      {tr("wiki Escape from Tarkov (en anglais)", "Escape from Tarkov wiki")}
                    </a>{" "}
                    (CC BY-NC-SA)
                  </p>
                )}
              </>
            );
            if (!spots?.length)
              return (
                <>
                  {opens}
                  {wiki}
                </>
              );
            return (
              <>
                {opens}
                <h3 className="finder-sub">{tr("Meilleurs spots", "Best spots")}</h3>
                <p className="muted small">
                  {tr(
                    "Du plus prometteur au moins prometteur : points d'apparition au sol regroupés au même endroit (tarkov.dev). Un ordre, pas une probabilité.",
                    "Most promising first: loose loot spawn points grouped in one place (tarkov.dev). An order, not a probability.",
                  )}
                </p>
                <ul className="finder-cards">
                  {spots.map(([mapName, x, y, z, n, , keyId], i) => {
                    const map = p.maps.find((m) => m.normalizedName === mapName);
                    const mapEn = map?.nameEn ?? map?.name ?? mapName;
                    const key = keyId ? p.byId.get(keyId) : undefined;
                    return (
                      <SpotCard
                        key={i}
                        rank={i + 1}
                        mapLabel={map?.name ?? mapName}
                        mapEn={mapEn}
                        sharedAt={sharedAt + 1}
                        n={n}
                        keyItem={key}
                        keyTitle={key ? (wikiTitles[key.id] ?? key.nameEn) : undefined}
                        confirmed={Boolean(key && linked.has(key.nameEn.toLowerCase()))}
                        itemLocation={location && location !== "!" ? location : null}
                        itemIcons={p.itemIcons}
                        marker={markers.find((m) => m.key === `spot:${i}`)}
                        onShowMap={(marker) => p.onShowSpots(markers, marker)}
                        onAddPoint={
                          map
                            ? (icon) =>
                                p.onAddPoint({
                                  mapId: map.id,
                                  x,
                                  z,
                                  icon,
                                  label: key ? `${p.item.name} — ${key.name}` : p.item.name,
                                  note: tr(`Spot ${i + 1} de « ${p.item.name} » : ${n} point(s) d'apparition (y ≈ ${y})`, `Spot ${i + 1} for "${p.item.name}": ${n} spawn point(s) (y ≈ ${y})`),
                                })
                            : undefined
                        }
                      />
                    );
                  })}
                </ul>
                <details className="finder-where-more">
                  <summary>{tr("Tous les emplacements connus (wiki)", "All known locations (wiki)")}</summary>
                  {wiki}
                </details>
              </>
            );
          })}
        {tab === "quests" &&
          (rows.length === 0 ? (
            <p className="muted finder-empty">{tr("Aucune quête ne l'utilise.", "No quest uses it.")}</p>
          ) : (
            <ul className="finder-cards">
              {rows.map((r) => {
                const trader = p.traders.find((t) => t.id === r.task.traderId);
                const map = p.maps.find((m) => m.id === r.task.mapId)?.name;
                // quête terminée ou échouée (comme « Masquer les quêtes terminées ») : grisée, toujours cliquable
                const finished = isGreyed(r.task, p.done, p.failed);
                const expanded = openQuest === r.taskId;
                return (
                  <li key={r.taskId}>
                    <button
                      className={`finder-card finder-quest${finished ? " is-done" : ""}${expanded ? " is-open" : ""}`}
                      aria-expanded={expanded}
                      onClick={() => setOpenQuest(expanded ? null : r.taskId)}
                    >
                      <span className="finder-avatar">{trader?.imageLink && <img src={trader.imageLink} alt="" width={36} height={36} loading="lazy" referrerPolicy="no-referrer" />}</span>
                      <span className="finder-quest-main">
                        <strong>
                          {r.task.name}
                          {finished && <span className="tag finder-done-tag"><UiIcon id="check" size={12} /> {isTaskFinished(r.task, p.done) ? tr("Terminée", "Completed") : tr("Échouée", "Failed")}</span>}
                        </strong>
                        <span className="muted finder-quest-meta">{[trader?.name, map].filter(Boolean).join(" · ")}</span>
                        <span className="finder-pills">
                          {r.uses.map((u, i) => (
                            <span key={i} className={`finder-pill${u.fir ? " fir" : ""}`}>
                              {useLabel(u)}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="muted finder-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    </button>
                    {expanded && (
                      <div className="finder-quest-detail">
                        <div className="finder-quest-tags">
                          {r.task.minPlayerLevel ? <span className="tag">{tr(`Niveau ${r.task.minPlayerLevel}`, `Level ${r.task.minPlayerLevel}`)}</span> : null}
                          {r.task.kappaRequired && <span className="tag">Kappa</span>}
                          {map && <span className="tag">{map}</span>}
                        </div>
                        <div className="subhead">{tr("Prérequis", "Prerequisites")}</div>
                        {(() => {
                          const reqs = r.task.details?.taskRequirements ?? [];
                          const traderReqs = r.task.details?.traderRequirements ?? [];
                          if (reqs.length === 0 && traderReqs.length === 0 && !r.task.minPlayerLevel) return <p className="muted small">{tr("Aucun prérequis", "No prerequisites")}</p>;
                          return (
                            <ul className="finder-quest-reqs">
                              {r.task.minPlayerLevel ? <li><UiIcon id="chevron-right" size={14} /> {tr(`Niveau ${r.task.minPlayerLevel} minimum`, `Level ${r.task.minPlayerLevel} minimum`)}</li> : null}
                              {reqs.map((q) => {
                                const t = p.tasksById.get(q.taskId);
                                const ok = t ? isGreyed(t, p.done, p.failed) : false;
                                return (
                                  <li key={q.taskId} className={ok ? "is-done" : undefined}>
                                    <UiIcon id={ok ? "circle-check" : "chevron-right"} size={14} /> {t?.name ?? q.taskId}
                                    {q.status.length > 0 && <span className="muted"> ({q.status.map((s) => STATUS_LABELS[s] ?? s).join(tr(" ou ", " or "))})</span>}
                                  </li>
                                );
                              })}
                              {traderReqs.map((q, i) => (
                                <li key={`t${i}`}>
                                  <UiIcon id="chevron-right" size={14} /> {p.traders.find((t) => t.id === q.traderId)?.name ?? "?"}{" "}
                                  {q.type === "level" ? tr("niv.", "lvl") : tr("réputation", "standing")} {q.compare} {q.value}
                                </li>
                              ))}
                            </ul>
                          );
                        })()}
                        <div className="subhead">{tr("Objectifs", "Objectives")}</div>
                        <ul className="finder-quest-objectives">
                          {r.task.objectives.map((o) => (
                            <li key={o.id} className={p.done[o.id] ? "is-done" : undefined}>
                              <UiIcon id={p.done[o.id] ? "circle-check" : "chevron-right"} size={14} />
                              <span className="finder-quest-obj-body">
                                <span className="finder-quest-obj-text">
                                  {o.description || tr("(sans description)", "(no description)")}
                                  {o.optional && <span className="tag">{tr("optionnel", "optional")}</span>}
                                </span>
                                <ObjectiveItems objective={o} itemIcons={p.itemIcons} itemNames={p.itemNames} />
                              </span>
                            </li>
                          ))}
                        </ul>
                        {(() => {
                          const rw = r.task.details?.rewards;
                          if (!rw || (rw.experience <= 0 && !rw.items.length && !rw.standing.length && !rw.offerUnlocks.length && !rw.skills.length)) return null;
                          return (
                            <details className="finder-quest-rewards">
                              <summary>{tr("Récompenses", "Rewards")}</summary>
                              <TaskRewardList rewards={rw} traders={p.traders} itemNames={p.itemNames} itemIcons={p.itemIcons} />
                            </details>
                          );
                        })()}
                        <button className="btn btn-small" onClick={() => p.onShowQuest(r.taskId)}>
                          <UiIcon id="scroll-text" size={14} /> {tr("Ouvrir la fiche complète", "Open the full quest page")}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
        {tab === "hideout" &&
          gate("hideout", () =>
            hideoutRows.length === 0 ? (
              <p className="muted finder-empty">{tr("Aucune amélioration du hideout ne l'exige.", "No hideout upgrade needs it.")}</p>
            ) : (
              <ul className="finder-cards">
                {hideoutRows.map((h) => {
                  // niveau déjà construit (ou station ignorée dans l'onglet Planque) : plus besoin de le donner
                  const built = p.hideoutLevels?.[h.stationId] ?? 0;
                  const finished = built < 0 || h.level <= built;
                  return (
                    <li key={`${h.stationId}-${h.level}`} className={`finder-card finder-row${finished ? " is-done" : ""}`}>
                      <strong>
                        {h.name}
                        {finished && <span className="tag finder-done-tag"><UiIcon id="check" size={12} /> {built < 0 ? tr("Ignorée", "Ignored") : tr("Construit", "Built")}</span>}
                      </strong>
                      <span className="finder-pill">{`${tr("niv.", "lvl")} ${h.level}`}</span>
                      <span className="finder-right">
                        <strong>×{h.count}</strong>
                        {h.fir && <span className="finder-pill fir">FIR</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ),
          )}
        {tab === "barters" && gate("barters", () => exchanges(barterRows, (e) => p.traders.find((t) => t.id === e.sourceId)?.name ?? "?"))}
        {tab === "crafts" && gate("crafts", () => exchanges(craftRows, (e) => p.hideout.data?.stationName[e.sourceId] ?? "?"))}
      </div>
    </div>
  );
}

/** Un barter ou un craft : ingrédients → produits, l'objet cherché en surbrillance. */
function Recipe(p: { e: Exchange; source: string; item: ListedItem; byId: Map<string, ListedItem>; itemIcons: Record<string, string> }) {
  const { e } = p;
  const self = { id: p.item.id, count: e.count, fir: e.fir, self: true };
  const plain = (l: { id: string; count: number }[]) => l.map((x) => ({ ...x, fir: false, self: false }));
  const inputs = e.side === "in" ? [self, ...plain(e.with ?? [])] : plain(e.others);
  const outputs = e.side === "in" ? plain(e.others) : [self];
  const chip = (c: typeof self, i: number) => (
    <span key={`${c.id}-${i}`} className={`finder-chip${c.self ? " self" : ""}`}>
      <ItemThumb src={iconSrc(c.id, p.itemIcons)} name="" size={24} />
      <span>
        {p.byId.get(c.id)?.name ?? c.id}
        {c.count > 1 ? ` ×${c.count}` : ""}
      </span>
      {c.fir && <small className="finder-fir">FIR</small>}
    </span>
  );
  return (
    <li className="finder-card">
      <div className="finder-recipe-head">
        <strong>{p.source}</strong>
        <span className="finder-pill">{`${tr("niv.", "lvl")} ${e.level}`}</span>
        {e.duration ? <span className="muted finder-right"><UiIcon id="timer" size={14} /> {durationLabel(e.duration)}</span> : null}
      </div>
      <div className="finder-recipe">
        {inputs.map(chip)}
        <span className="finder-arrow" aria-hidden="true">→</span>
        {outputs.map(chip)}
      </div>
    </li>
  );
}

/** Arbre des catégories du flea : ▸ ouvre ou ferme, le nom choisit la catégorie (un second clic la retire). */
export function CategoryTree(p: { nodes: CategoryNode[]; depth: number; selected: string | null; open: Set<string>; onPick: (n: CategoryNode) => void; onToggle: (id: string) => void }) {
  return (
    <ul className="finder-cat-list">
      {p.nodes.map((n) => {
        const expanded = p.open.has(n.id);
        return (
          <li key={n.id}>
            <div className={`finder-cat${p.selected === n.id ? " is-selected" : ""}`} style={{ paddingLeft: `${0.25 + p.depth * 1}rem` }}>
              {n.children.length > 0 ? (
                <button className="finder-cat-toggle" aria-expanded={expanded} aria-label={`${expanded ? tr("Replier", "Collapse") : tr("Déplier", "Expand")} ${n.name}`} onClick={() => p.onToggle(n.id)}>
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="finder-cat-toggle" aria-hidden="true" />
              )}
              <button className="finder-cat-name" aria-pressed={p.selected === n.id} onClick={() => p.onPick(n)}>
                {n.id !== OTHER && <img src={iconUrl(`handbook-category-${n.id}-icon.webp`)} alt="" width={18} height={18} loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
                <span>{n.name}</span> <span className="finder-cat-count">({n.count ?? n.items.size})</span>
              </button>
            </div>
            {expanded && n.children.length > 0 && <CategoryTree {...p} nodes={n.children} depth={p.depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Un spot de l'onglet « Où le trouver » : en-tête (map, points, carte) ; déplié : la clé de la porte
 * proche (icône, photos de sa serrure et de ce qu'il y a derrière, sur sa page wiki, chargée au
 * dépliage), ce que la page de l'objet dit et montre pour cette map, et l'ajout d'un point perso.
 */
function SpotCard(p: {
  rank: number;
  /** Rang du spot qui affiche le texte commun (« Key Location »…) ; 0 : aucun. */
  sharedAt: number;
  mapLabel: string;
  mapEn: string;
  n: number;
  keyItem?: ListedItem;
  keyTitle?: string;
  confirmed: boolean;
  itemLocation: ItemLocation | null;
  itemIcons: Record<string, string>;
  marker?: ItemSpotMarker;
  onShowMap: (marker: ItemSpotMarker) => void;
  onAddPoint?: (icon: IconId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keyLoc, setKeyLoc] = useState<ItemLocation | "!" | null>(null);
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<IconId | null>(null);
  useEffect(() => {
    if (!open || !p.keyTitle || keyLoc) return;
    loadItemLocation(p.keyTitle).then(setKeyLoc, () => setKeyLoc("!"));
  }, [open]);

  // ce que la page de l'objet dit pour cette map (sous-titre « Streets of Tarkov »…), photos comprises
  const location = p.itemLocation?.sections.find((s) => s.title === "Location");
  const parts = location ? splitAtHeadings(location.blocks) : [];
  const idx = parts.findIndex((part, i) => i > 0 && part[0]?.type === "heading" && part[0].text.toLowerCase() === p.mapEn.toLowerCase());
  // photos de cette map, affichées sous son texte (sous-titre retiré)
  const mapPhotos = idx > 0 ? location!.photos.filter((ph) => ph.section === idx).map((ph) => ({ ...ph, section: 0 })) : [];
  const keySections = keyLoc && keyLoc !== "!" ? keyLoc.sections.filter((s) => s.title === "Lock Location" || s.title === "Behind the Lock") : [];
  // pas de sous-titre pour cette map : la section « Key Location » (pages de clés : aile, étage, chambre…)
  // ou une section Location qui n'est pas découpée par map
  const shared = idx > 0 ? null : (p.itemLocation?.sections.find((s) => s.title === "Key Location") ?? (location && parts.length === 1 ? location : null));
  const fallback = p.sharedAt === p.rank ? shared : null;

  return (
    <li className="finder-card finder-spot">
      {/* tout l'en-tête déplie / replie (le clic du bouton ▸ remonte jusqu'ici) */}
      <div className="finder-spot-summary" onClick={() => setOpen((o) => !o)}>
        <div className="finder-recipe-head">
          <button className="finder-spot-toggle" aria-expanded={open} aria-label={open ? tr("Replier le spot", "Collapse the spot") : tr("Déplier le spot", "Expand the spot")}>
            {open ? "▾" : "▸"}
          </button>
          <span className="finder-badge">{p.rank}</span>
          <strong>{p.mapLabel}</strong>
          <span className="finder-pill">{tr(`${p.n} point(s)`, `${p.n} point(s)`)}</span>
          {p.marker && (
            <button
              className="btn btn-small finder-spot-map"
              onClick={(e) => {
                e.stopPropagation();
                p.onShowMap(p.marker!);
              }}
            >
              <UiIcon id="map-pin" /> {tr("Voir sur la carte", "Show on map")}
            </button>
          )}
        </div>
        {p.keyItem && (
          <p className="finder-spot-key">
            <UiIcon id="key-round" /> {p.confirmed ? tr("Derrière la porte : ", "Behind the door: ") : tr("Porte fermée à proximité : ", "Locked door nearby: ")}
            <strong>{p.keyItem.name}</strong>
            {p.confirmed && <span className="muted"> {tr("(confirmé par le wiki)", "(confirmed by the wiki)")}</span>}
          </p>
        )}
      </div>
      {open && (
        <div className="finder-spot-body">
          {p.keyItem && (
            <div className="finder-spot-keycard">
              <span className="finder-icon">
                <ItemThumb src={iconSrc(p.keyItem.id, p.itemIcons)} name="" size={56} />
              </span>
              <div>
                <strong>{p.keyItem.name}</strong>
                <p className="muted small">{tr("Clé de la porte la plus proche du spot.", "Key of the door closest to the spot.")}</p>
              </div>
            </div>
          )}
          {p.keyItem && keyLoc === null && <p className="muted small" role="status">{tr("Chargement des photos de la clé…", "Loading the key's photos…")}</p>}
          {keySections.map((sec) => (
            <section key={sec.title}>
              <h4 className="finder-sub">{tr(...LOCATION_TITLE[sec.title])}</h4>
              <BlocksWithPhotos blocks={sec.blocks} photos={sec.photos} itemNames={{}} itemIcons={p.itemIcons} showCaptions />
            </section>
          ))}
          {idx > 0 && (
            <section>
              <h4 className="finder-sub">{tr(`Ce que dit le wiki pour ${p.mapLabel}`, `What the wiki says for ${p.mapLabel}`)}</h4>
              <BlocksWithPhotos blocks={parts[idx].slice(1)} photos={mapPhotos} itemNames={{}} itemIcons={p.itemIcons} showCaptions />
            </section>
          )}
          {fallback && (
            <section>
              <h4 className="finder-sub">{tr(...LOCATION_TITLE[fallback.title])}</h4>
              <BlocksWithPhotos blocks={fallback.blocks} photos={fallback.photos} itemNames={{}} itemIcons={p.itemIcons} showCaptions />
            </section>
          )}
          {shared && !fallback && <p className="muted small">{tr(`Emplacements du wiki : voir le spot ${p.sharedAt}.`, `Wiki locations: see spot ${p.sharedAt}.`)}</p>}
          {!p.keyItem && idx <= 0 && !shared && <p className="muted small">{tr("Pas de photo du wiki pour ce spot.", "No wiki photo for this spot.")}</p>}
          {p.onAddPoint && (
            <div className="finder-spot-add">
              {added ? (
                <p className="finder-spot-added" role="status">
                  <UiIcon id="check" /> {tr("Point perso ajouté sur la carte (onglet Mes points).", "Personal point added to the map (My points tab).")}
                </p>
              ) : !picking ? (
                <button className="btn btn-small" onClick={() => setPicking(true)}>
                  <UiIcon id="pin" /> {tr("Ajouter un point perso", "Add a personal point")}
                </button>
              ) : (
                <>
                  <span className="small">{tr("Choisis l'icône :", "Pick the icon:")}</span>
                  <div className="icon-grid">
                    {CUSTOM_ICONS.map((id) => (
                      <button
                        key={id}
                        className="icon-choice"
                        title={ICON_LABELS[id]}
                        aria-label={ICON_LABELS[id]}
                        onClick={() => {
                          p.onAddPoint!(id);
                          setAdded(id);
                        }}
                      >
                        <Icon id={id} />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
