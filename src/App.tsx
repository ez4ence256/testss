// Composant racine : choix du mode, chargement des données, panneau + carte.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameMap, GameMode, Objective, TarkovData, Task } from "./types";
import { GAME_MODES } from "./types";
import { loadTarkovData } from "./api/cache";
import { BUNDLED_CALIBRATION, loadCalibration } from "./map/calibration";
import { MapView, type Placing } from "./map/MapView";
import type { ItemSpotMarker } from "./map/ItemSpotsLayer";
import { exportState, getLastMode, useAppState, type CustomPoint } from "./state/store";
import { QUEST_COLORS } from "./lib/objectiveTypes";
import { buildObjectivePoints, isTaskFinished, manualPointKey, questsUnlockedBy, shownObjectives, spawnGroups, taskMapIds } from "./lib/points";
import { ModePicker } from "./components/ModePicker";
import { UiIcon } from "./components/UiIcon";
import { QuestList } from "./components/QuestList";
import { SelectedQuests } from "./components/SelectedQuests";
import { CustomPointsTab } from "./components/CustomPointsTab";
import { SettingsTab } from "./components/SettingsTab";
import { HideoutTab } from "./components/HideoutTab";
import { PhotosTab, type ExitPhotosTarget, type StoryPhotosTarget } from "./components/PhotosTab";
import { ResetProgressSection } from "./components/ResetProgressSection";
import { QuestTab } from "./components/QuestTab";
import { CaptureTab } from "./components/CaptureTab";
import { dominantMap } from "./lib/ocrMatch";
import { PanelResizer } from "./components/PanelResizer";
import { getLang, setLang as applyLang, tr, type Lang } from "./lib/i18n";
import { clampPanelWidth, readPanelWidth } from "./lib/panelWidth";
import { storyIdOf, storyStepId } from "./lib/story";
import { chaptersWithPositions, currentStoryPoints, pointsOnMap } from "./lib/storyPoints";
import { chapterName, useStoryItems } from "./components/StoryView";
import { useRoom } from "./api/room";
import { maskCode, useMonitor, type MonitorEvent } from "./api/monitor";
import { type PlayerPosition } from "./map/PlayerMarker";
import { planMonitorBatch } from "./lib/monitorQuests";
import { branchFailures, prerequisiteChanges } from "./lib/questChain";
import { computeNeeds } from "./lib/itemNeeds";
import { loadHideout, type HideoutStation } from "./api/itemList";
import { buildEventTasks, knownQuestKeys, loadEventEntries, eventSlug, vanishedWikiIds, removedFromGame, wikiMigration, type EventEntry } from "./api/eventQuests";
import { RoomControl } from "./components/RoomControl";
import { LegacyRoomPrompt } from "./components/LegacyRoomPrompt";
import { TeammatePanel } from "./components/TeammatePanel";
import { viewModeOf, teammateTasks } from "./lib/roomView";
import { STORY_COLOR } from "./map/StoryLayer";
import type { TeamMarker, TeamPlayer } from "./map/TeamLayer";
import { MapPicker } from "./components/MapPicker";
import { Rail, type RailGroup } from "./components/Rail";
import { RaidCard } from "./components/RaidCard";
import { FirstVisitHelp, helpWanted, resetHelp } from "./components/FirstVisitHelp";
import { ItemFinder } from "./components/ItemFinder";
import { TraderWindow } from "./components/TraderWindow";
import { Lightbox } from "./components/Lightbox";
import { UnlockToast } from "./components/UnlockToast";

type Tab = "selection" | "quests" | "capture" | "quest" | "photos" | "custom" | "hideout" | "settings";

const TABS: Tab[] = ["selection", "quests", "capture", "quest", "photos", "custom", "hideout", "settings"];
/** Groupe de la barre latérale auquel appartient chaque vue du panneau. */
const TAB_GROUP: Record<Tab, RailGroup> = { selection: "selection", quests: "add", capture: "add", quest: "detail", photos: "detail", custom: "custom", hideout: "hideout", settings: "settings" };
const GROUP_FIRST: Record<RailGroup, Tab> = { selection: "selection", add: "quests", detail: "quest", custom: "custom", hideout: "hideout", settings: "settings" };
/** Groupes à deux vues : petit sélecteur en haut du panneau. */
const SUBS: Partial<Record<RailGroup, [Tab, [string, string]][]>> = {
  add: [["quests", ["Rechercher", "Search"]], ["capture", ["Capture (Ctrl+V)", "Capture (Ctrl+V)"]]],
  detail: [["quest", ["Infos", "Info"]], ["photos", ["Photos", "Photos"]]],
};
const readTab = (): Tab => {
  try {
    const t = localStorage.getItem("tqp:tab");
    return TABS.find((x) => x === t) ?? "selection";
  } catch {
    return "selection";
  }
};
type LoadState =
  | { status: "loading"; data: TarkovData | null }
  | { status: "ready"; data: TarkovData; source: "cache" | "network" | "stale"; error?: string }
  | { status: "error"; data: null; error: string };

const NO_NAMES: Record<string, string> = {};
const NO_DONE: Record<string, true> = {};
const raidSaved = () => {
  try {
    return localStorage.getItem("tqp:raid") === "1";
  } catch {
    return false;
  }
};
const isMobile = () => window.matchMedia("(max-width: 800px)").matches;
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function App() {
  const { state, modeState: mode, dispatch } = useAppState();
  const gameMode = state.gameMode;
  const [load, setLoad] = useState<LoadState>({ status: "loading", data: null });
  const [reloadToken, setReloadToken] = useState(0);
  const [lang, setLang] = useState<Lang>(getLang);
  // i18n d'abord, pour que le rendu suivant lise déjà la nouvelle langue
  const changeLang = (next: Lang) => {
    applyLang(next);
    setLang(next);
  };
  // sorties Scav affichées par défaut ; le choix est retenu dans le navigateur
  const [showScavExits, setShowScavExits] = useState(() => {
    try {
      return localStorage.getItem("tqp:showScavExits") !== "0";
    } catch {
      return true;
    }
  });
  const changeScavExits = (on: boolean) => {
    setShowScavExits(on);
    try {
      localStorage.setItem("tqp:showScavExits", on ? "1" : "0");
    } catch {
      /* préférence non retenue */
    }
  };
  const [calibration, setCalibration] = useState(BUNDLED_CALIBRATION);
  const [tab, setTab] = useState<Tab>(readTab);
  // dernière vue utilisée dans chaque groupe de la barre latérale ; la vue courante est retenue entre deux visites
  const lastTab = useRef<Partial<Record<RailGroup, Tab>>>({});
  useEffect(() => {
    lastTab.current[TAB_GROUP[tab]] = tab;
    try {
      localStorage.setItem("tqp:tab", tab);
    } catch {
      /* préférence non retenue */
    }
  }, [tab]);
  /** Quête affichée dans l'onglet Photos. */
  const [tabTaskId, setTabTaskId] = useState<string | null>(null);
  // coéquipier dont la quête est affichée dans Détails (sa progression, lecture seule) ; null = la mienne
  const [tabOwner, setTabOwner] = useState<string | null>(null);
  // sortie cliquée sur la carte : l'onglet Photos montre la sienne plutôt que celles d'une quête
  const [photoExit, setPhotoExit] = useState<ExitPhotosTarget | null>(null);
  const [photoStory, setPhotoStory] = useState<StoryPhotosTarget | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => !isMobile() && !raidSaved());
  /** Largeur du panneau sur ordinateur (poignée de redimensionnement, enregistrée). */
  const [panelWidth, setPanelWidth] = useState(() => readPanelWidth(window.innerWidth));
  // fenêtre réduite : la largeur reste dans les bornes (sans écraser la valeur enregistrée)
  useEffect(() => {
    const onResize = () => setPanelWidth((w) => clampPanelWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // mode raid : carte flottante des objectifs de la map, panneau fermé ; retenu dans le navigateur
  const [raid, setRaid] = useState(raidSaved);
  const changeRaid = (on: boolean) => {
    setRaid(on);
    if (on) setPanelOpen(false);
    try {
      localStorage.setItem("tqp:raid", on ? "1" : "0");
    } catch {
      /* préférence non retenue */
    }
  };
  const [placing, setPlacing] = useState<Placing>(null);
  const [focus, setFocus] = useState<{ key: string; n: number } | null>(null);
  // meilleurs spots d'un objet (item finder) affichés sur la carte, jusqu'à ce qu'on les retire
  const [itemSpots, setItemSpots] = useState<ItemSpotMarker[]>([]);

  // Calibrage des cartes (copie embarquée tout de suite, version en ligne ensuite)
  useEffect(() => {
    loadCalibration().then(setCalibration);
  }, []);

  // Données de l'API : au choix du mode (cache si frais), puis à chaque demande de rechargement (forcé)
  const lastReload = useRef(0);
  useEffect(() => {
    if (!gameMode) return;
    const force = reloadToken !== lastReload.current;
    lastReload.current = reloadToken;
    const controller = new AbortController();
    setLoad((prev) => ({ status: "loading", data: prev.data?.gameMode === gameMode ? prev.data : null }));
    loadTarkovData(gameMode, lang, { force, signal: controller.signal })
      .then((res) => setLoad({ status: "ready", ...res }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoad({ status: "error", data: null, error: error.message });
      });
    return () => controller.abort();
  }, [gameMode, reloadToken, lang]);

  const data = load.data;
  // Quêtes d'événement du wiki absentes de tarkov.dev : chargées une fois les données prêtes, sans bloquer l'app
  const [eventEntries, setEventEntries] = useState<EventEntry[]>([]);
  // la liste du wiki a fini de charger : avant, un id wiki-… sélectionné n'est pas encore un fantôme ;
  // en échec, les wiki-… ne le sont jamais (« Retirer » ferait perdre leur progression)
  const [eventsSettled, setEventsSettled] = useState<"ok" | "failed" | null>(null);
  // liste du wiki relue à l'instant (jamais depuis le cache) : seule base pour retirer les quêtes wiki disparues
  const [freshListing, setFreshListing] = useState<{ titles: string[]; previousCount: number | null; historical: string[] } | null>(null);
  // quêtes « Historical content » du wiki : tarkov.dev les liste encore, mais elles n'existent plus dans le jeu
  const [historical, setHistorical] = useState<string[]>([]);
  const dataReady = Boolean(data);
  const dataFetchedAt = data?.fetchedAt;
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    loadEventEntries(knownQuestKeys(data.tasks)).then(
      (r) => {
        // une liste fraîche reste valable même si l'effet a été relancé entre-temps (données tarkov.dev
        // rafraîchies au démarrage) : le passage suivant lit le cache et ne la redonnerait pas
        if (r.status === "fresh") setFreshListing({ titles: r.listed, previousCount: r.previousCount, historical: r.historical });
        if (cancelled) return;
        setEventEntries(r.entries);
        setHistorical(r.historical);
        setEventsSettled("ok");
      },
      (e) => {
        if (cancelled) return;
        console.warn("Quêtes du wiki indisponibles :", e);
        setEventsSettled("failed");
      },
    );
    return () => {
      cancelled = true;
    };
    // relancé quand tarkov.dev se rafraîchit (nouveau `known`), pas à chaque changement de `data`
  }, [dataReady, dataFetchedAt]);
  const tasks = useMemo(() => {
    if (!data) return [];
    const gone = removedFromGame(data.tasks, historical);
    return [...data.tasks.filter((t) => !gone.has(t.id)), ...buildEventTasks(eventEntries, data)];
  }, [data, eventEntries, historical]);
  const maps = useMemo(() => data?.maps ?? [], [data]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // une quête vient d'être terminée -> proposer celles qu'elle débloque (petite fenêtre en haut à droite)
  const finishedIds = useMemo(() => new Set(tasks.filter((t) => isTaskFinished(t, mode.done)).map((t) => t.id)), [tasks, mode.done]);
  const muteUnlock = useRef(false);
  const prevFinished = useRef<{ key: string; ids: Set<string> } | null>(null);
  const [unlockOffer, setUnlockOffer] = useState<{ done: Task; next: Task[] } | null>(null);
  useEffect(() => {
    const key = `${gameMode}|${tasks.length}`;
    const prev = prevFinished.current;
    prevFinished.current = { key, ids: finishedIds };
    // prérequis grisés par l'app (activation d'une quête) : jamais de proposition
    if (muteUnlock.current) {
      muteUnlock.current = false;
      return;
    }
    // premier calcul (chargement, autre mode) : rien à proposer ; plusieurs d'un coup (import) : non plus
    if (!prev || prev.key !== key) return;
    const newly = tasks.filter((t) => finishedIds.has(t.id) && !prev.ids.has(t.id));
    if (newly.length !== 1) return;
    const selected = new Set(mode.selected.map((s) => s.taskId));
    const next = questsUnlockedBy(newly[0], tasks, mode.done).filter((t) => !selected.has(t.id));
    setUnlockOffer(next.length ? { done: newly[0], next } : null);
  }, [finishedIds]);
  const objectivesById = useMemo(() => {
    const m = new Map<string, Objective>();
    for (const t of tasks) for (const o of t.objectives) m.set(o.id, o);
    return m;
  }, [tasks]);
  const selectedTasks = useMemo(
    () => mode.selected.map((s) => tasksById.get(s.taskId)).filter((t): t is Task => Boolean(t)),
    [mode.selected, tasksById],
  );
  const colorOf = useCallback(
    (taskId: string) => QUEST_COLORS[mode.selected.find((s) => s.taskId === taskId)?.color ?? 0],
    [mode.selected],
  );

  // Map affichée : choix mémorisé, sinon map de la première quête sélectionnée, sinon Customs.
  const currentMap: GameMap | undefined = useMemo(() => {
    const byId = (id: string | null | undefined) => maps.find((m) => m.id === id);
    const fromSelection = selectedTasks.map((t) => [...taskMapIds(t)][0]).find(Boolean);
    return byId(mode.mapId) ?? byId(fromSelection) ?? maps.find((m) => m.normalizedName === "customs") ?? maps[0];
  }, [maps, mode.mapId, selectedTasks]);

  const oneAtATime = state.oneAtATime !== false;
  // « Kappa seulement » (Ajouter, Mes quêtes) : la carte ne montre plus que les quêtes demandées pour la Kappa
  const [kappaOnly, setKappaOnly] = useState(false);
  const mapTasks = useMemo(() => (kappaOnly ? selectedTasks.filter((t) => t.kappaRequired) : selectedTasks), [kappaOnly, selectedTasks]);
  const points = useMemo(
    () => (currentMap ? buildObjectivePoints(mapTasks, mode, currentMap.id, state.showDone, oneAtATime) : []),
    [mapTasks, mode, currentMap, state.showDone, oneAtATime],
  );

  // Nombre de points restants par map (affiché dans le sélecteur de map), et quêtes qui y ont ces points
  const { pointsPerMap, questsPerMap } = useMemo(() => {
    const counts = new Map<string, number>();
    const quests = new Map<string, Set<string>>();
    const add = (mapId: string, taskId: string) => {
      counts.set(mapId, (counts.get(mapId) ?? 0) + 1);
      quests.set(mapId, (quests.get(mapId) ?? new Set()).add(taskId));
    };
    for (const t of mapTasks)
      for (const o of shownObjectives(t, mode.done, false, oneAtATime)) {
        for (const l of o.locations) add(l.mapId, t.id);
        const manual = mode.manual[o.id];
        if (o.locations.length === 0 && manual) add(manual.mapId, t.id);
      }
    return { pointsPerMap: counts, questsPerMap: quests };
  }, [mapTasks, mode.done, mode.manual, oneAtATime]);

  // Main story : case en cours des chapitres choisis qui ont une position relevée sur le wiki
  const storyIds = useMemo(() => (mode.story?.selected ?? []).filter((c) => chaptersWithPositions().includes(c)), [mode.story?.selected]);
  const { items: storyItems, chapters: storyChapters } = useStoryItems(storyIds, data?.itemNames ?? NO_NAMES);
  const storyDone = mode.story?.done ?? NO_DONE;
  const storyPointsAll = useMemo(() => storyIds.flatMap((c) => currentStoryPoints(c, storyItems[c] ?? [], storyDone)), [storyIds, storyItems, storyDone]);
  // la Main story ne fait pas partie de la Kappa : pas de points en « Kappa seulement »
  const storyPoints = useMemo(() => (kappaOnly ? [] : pointsOnMap(storyPointsAll, currentMap?.normalizedName)), [kappaOnly, storyPointsAll, currentMap]);
  // la case en cours de la Main story compte aussi dans le sélecteur de map
  // filtre « Mes maps » de la Sélection, partagé avec la colonne du coéquipier en room
  const [selectionMap, setSelectionMap] = useState<string | null>(null);
  // room : « Seulement mes quêtes » cache sur la carte les points des quêtes des coéquipiers (leurs positions restent)
  const [onlyMine, setOnlyMine] = useState(false);
  const { mapCounts, questsOnMap } = useMemo(() => {
    const counts = new Map(pointsPerMap);
    const onMap = new Map([...questsPerMap].map(([id, s]) => [id, new Set(s)]));
    for (const p of kappaOnly ? [] : storyPointsAll) {
      const id = maps.find((m) => m.normalizedName === p.map)?.id;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      onMap.set(id, (onMap.get(id) ?? new Set()).add(storyIdOf(p.chapter)));
    }
    return { mapCounts: counts, questsOnMap: onMap };
  }, [pointsPerMap, questsPerMap, storyPointsAll, maps, kappaOnly]);
  const storyName = useCallback((chapter: string) => chapterName(storyChapters, chapter), [storyChapters]);
  const setStoryStep = (chapter: string, stepKey: string, value: boolean) => dispatch({ type: "setStoryStep", chapter, stepKey, done: value });

  // chapitre qui vient d'être choisi ou dont une case vient d'être cochée : si sa case en cours est sur une autre map, on y va
  const pendingStory = useRef(new Set<string>());
  const prevStory = useRef<{ mode: string | null; selected: string[]; done: Record<string, true> } | null>(null);
  useEffect(() => {
    const cur = { mode: gameMode, selected: mode.story?.selected ?? [], done: storyDone };
    const prev = prevStory.current;
    prevStory.current = cur;
    if (!prev || prev.mode !== cur.mode) return; // premier rendu ou changement de mode : rien à suivre
    const count = (done: Record<string, true>, c: string) => Object.keys(done).filter((k) => k.startsWith(storyStepId(c, ""))).length;
    for (const c of cur.selected)
      if (chaptersWithPositions().includes(c) && (!prev.selected.includes(c) || count(prev.done, c) !== count(cur.done, c))) pendingStory.current.add(c);
  }, [gameMode, mode.story?.selected, storyDone]);
  useEffect(() => {
    if (pendingStory.current.size === 0 || !currentMap) return;
    for (const c of [...pendingStory.current]) {
      if (!storyIds.includes(c)) pendingStory.current.delete(c);
      else if (storyItems[c]) {
        pendingStory.current.delete(c);
        const mine = storyPointsAll.filter((p) => p.chapter === c);
        const target = mine.length > 0 && !mine.some((p) => p.map === currentMap.normalizedName) ? maps.find((m) => m.normalizedName === mine[0].map) : undefined;
        if (!target) continue;
        dispatch({ type: "setMap", mapId: target.id });
        setMapNotice(tr(`Map affichée : ${target.name} (le point de « ${storyName(c)} » s'y trouve).`, `Displayed map: ${target.name} (the point of "${storyName(c)}" is there).`));
      }
    }
  }, [storyIds, storyItems, storyPointsAll, currentMap, maps, storyName]);

  const customPoints = useMemo(
    () => mode.customPoints.filter((p) => p.mapId === currentMap?.id),
    [mode.customPoints, currentMap],
  );

  // ouvre l'onglet Quête ou Photos sur une quête (boutons de la liste, du panneau ou d'une popup)
  const showTaskTab = useCallback((taskId: string, which: "quest" | "photos") => {
    setTabTaskId(taskId);
    setTabOwner(null);
    if (which === "photos") {
      setPhotoExit(null);
      setPhotoStory(null);
    }
    setTab(which);
    setPanelOpen(true);
  }, []);
  const showExitPhotos = useCallback((target: ExitPhotosTarget) => {
    setPhotoExit(target);
    setPhotoStory(null);
    setTab("photos");
    setPanelOpen(true);
  }, []);
  // photos de la case en cours d'un chapitre (bulle d'un point de la Main story) : seulement la
  // sous-partie de l'étape où le wiki place la carte dont vient le point (ex. « Woods »), si on la trouve
  const showStoryPhotos = (chapter: string, stepKey: string, source?: string) => {
    const item = storyItems[chapter]?.find((i) => i.key === stepKey);
    const all = item?.photos ?? [];
    const sameFile = (a: string, b: string) => a.replace(/_/g, " ").toLowerCase() === b.replace(/_/g, " ").toLowerCase();
    const section = source ? all.find((p) => sameFile(p.file, source))?.section : undefined;
    const photos = section === undefined ? all : all.filter((p) => p.section === section);
    setPhotoStory({ title: `${storyName(chapter)} - ${item?.title ?? stepKey}`, photos, sections: item?.sections, pageUrl: item?.pageUrl, pageTitle: item?.pageTitle });
    setPhotoExit(null);
    setTab("photos");
    setPanelOpen(true);
  };
  const showPhotos = useCallback((taskId: string) => showTaskTab(taskId, "photos"), [showTaskTab]);
  const showQuest = useCallback((taskId: string) => showTaskTab(taskId, "quest"), [showTaskTab]);
  const showTeamQuest = useCallback((memberId: string, taskId: string) => {
    showTaskTab(taskId, "quest");
    setTabOwner(memberId);
  }, [showTaskTab]);

  // Ctrl+V d'une image n'importe où (sauf dans un champ de texte, et sauf quand l'item finder est ouvert : il lit la capture lui-même) : import par capture
  const [pastedImage, setPastedImage] = useState<{ blob: Blob; n: number } | null>(null);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el?.isContentEditable ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "file", "range"].includes(el.type));
      if (typing) return; // collage de texte normal dans les notes, la recherche…
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (!blob) return;
      e.preventDefault();
      setPastedImage({ blob, n: Date.now() });
      setTab("capture");
      setPanelOpen(true);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Sélection d'une quête : si rien d'elle n'est sur la map affichée mais qu'il y en a ailleurs, on y va.
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(helpWanted);
  const failed = mode.failed ?? NO_DONE;
  // objets à garder : quêtes pas faites (+ prochains niveaux de la planque si l'option est active)
  const includeHideout = state.includeHideout === true;
  const [stationsLoad, setStationsLoad] = useState<{ stations: HideoutStation[] | null; error: boolean }>({ stations: null, error: false });
  const [stationsRetry, setStationsRetry] = useState(0);
  const wantStations = includeHideout || tab === "hideout";
  useEffect(() => {
    if (!gameMode || !wantStations) return;
    let cancelled = false;
    setStationsLoad({ stations: null, error: false });
    loadHideout(gameMode, lang).then(
      (h) => !cancelled && setStationsLoad({ stations: h.stations, error: false }),
      () => !cancelled && setStationsLoad({ stations: null, error: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [gameMode, lang, wantStations, stationsRetry]);
  const needs = useMemo(
    () =>
      computeNeeds({
        tasks,
        done: mode.done,
        failed: mode.failed,
        faction: mode.faction,
        ...(includeHideout && stationsLoad.stations ? { stations: stationsLoad.stations, hideoutLevels: mode.hideout ?? {} } : {}),
      }),
    [tasks, mode.done, mode.failed, mode.faction, mode.hideout, includeHideout, stationsLoad.stations],
  );
  // information avec « Annuler » après un grisage automatique (prérequis, branches exclusives)
  const [chainNotice, setChainNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  useEffect(() => setChainNotice(null), [gameMode]);
  // tarkov.dev vient d'ajouter une quête qu'on lisait sur le wiki : sélection, échec et cases cochées passent au vrai id
  useEffect(() => {
    if (!data || !eventsSettled) return;
    // nb d'objectifs wiki (même règle que buildEventTasks), y compris des quêtes déjà masquées par le dédoublonnage
    const counts = eventsSettled === "ok" ? Object.fromEntries(eventEntries.map((e) => [`wiki-${eventSlug(e.title)}`, e.objectives.length || 1])) : undefined;
    const mig = wikiMigration(mode, data.tasks, counts);
    if (!mig) return;
    dispatch({ type: "renameIds", ...mig });
    const n = Object.keys(mig.tasks).length;
    setChainNotice({ text: tr(`${n} quête(s) du wiki maintenant dans tarkov.dev : progression reprise.`, `${n} wiki quest(s) now in tarkov.dev: progress carried over.`) });
  }, [data, gameMode, mode, eventsSettled, eventEntries]);
  // quête wiki disparue du wiki (page supprimée ou « Historical content »), ou quête tarkov.dev retirée du jeu : retirée de la sélection, sans « Annuler »
  useEffect(() => {
    if (!data || !freshListing) return;
    const migratable = new Set(Object.keys(wikiMigration(mode, data.tasks)?.tasks ?? {}));
    const selected = mode.selected.map((s) => s.taskId);
    const ids = vanishedWikiIds(selected, freshListing.titles, freshListing.previousCount, migratable);
    const gone = removedFromGame(data.tasks, freshListing.historical);
    const removed = selected.filter((id) => gone.has(id));
    if (!ids.length && !removed.length) return;
    dispatch({ type: "applyQuestStatus", done: [], failed: [], deselect: [...ids, ...removed] });
    const wikiNames = ids.map((id) => id.slice(5).replace(/-/g, " "));
    const goneNames = removed.map((id) => data.tasks.find((t) => t.id === id)?.name ?? id);
    const plural = ids.length + removed.length > 1;
    const why = [
      wikiNames.length && tr(`${wikiNames.join(", ")} : plus sur le wiki`, `${wikiNames.join(", ")}: no longer on the wiki`),
      goneNames.length && tr(`${goneNames.join(", ")} : n'existe plus dans le jeu`, `${goneNames.join(", ")}: no longer in the game`),
    ].filter(Boolean).join(" ; ");
    setChainNotice({
      text: tr(`${plural ? "Quêtes retirées" : "Quête retirée"} de ta sélection (${why}).`, `${plural ? "Quests" : "Quest"} removed from your selection (${why}).`),
    });
  }, [data, mode, freshListing]);
  // sélectionnées mais absentes des données (quête retirée du site) : proposées au retrait, jamais retirées seules
  const ghostIds = useMemo(
    () =>
      dataReady && eventsSettled
        ? mode.selected.map((s) => s.taskId).filter((id) => !tasksById.has(id) && (eventsSettled === "ok" || !id.startsWith("wiki-")))
        : [],
    [dataReady, eventsSettled, mode.selected, tasksById],
  );
  /**
   * Une seule action : coche les objectifs des quêtes `complete`, marque `fail` échouées, les sort de la sélection.
   * `replace` : la sélection est remplacée (rien à retirer ni à rétablir). `added` : quêtes qu'« Annuler » retire
   * aussi (cochée par mégarde dans la recherche). Retourne rien si rien ne change.
   */
  const applyGrey = (complete: string[], fail: string[], text: (k: number, f: number) => string, replace = false, added: string[] = []) => {
    const ticks = complete.flatMap((id) => (tasksById.get(id)?.objectives ?? []).filter((o) => !mode.done[o.id]).map((o) => o.id));
    const newFail = fail.filter((id) => !failed[id]);
    const sel = new Set(replace ? [] : mode.selected.map((s) => s.taskId));
    const deselect = [...new Set([...complete, ...newFail])].filter((id) => sel.has(id));
    if (!ticks.length && !newFail.length) return;
    if (ticks.length) muteUnlock.current = true;
    dispatch({ type: "applyQuestStatus", done: ticks, failed: newFail, deselect });
    setChainNotice({
      text: text(complete.length, newFail.length),
      undo: () => dispatch({ type: "applyQuestStatus", done: [], undone: ticks, failed: [], unfailed: newFail, select: deselect, deselect: added }),
    });
  };
  // Grise les prérequis des quêtes qu'on vient d'activer. Actions locales seulement (jamais au chargement,
  // à l'import ni à la réception d'un instantané de la room).
  const greyPrerequisites = (added: Task[], replace = false, removeOnUndo = false) => {
    const addedIds = new Set(added.map((t) => t.id));
    const complete = new Set<string>();
    const fail = new Set<string>();
    for (const t of added) {
      const c = prerequisiteChanges(t.id, tasks, mode.done, failed);
      c.complete.forEach((id) => complete.add(id));
      c.failed.forEach((id) => fail.add(id));
    }
    for (const id of [...addedIds, ...complete]) fail.delete(id);
    for (const id of addedIds) complete.delete(id);
    if (!complete.size && !fail.size) return;
    // on dit pourquoi : avoir accès à une quête veut dire que celles qui la débloquent sont finies
    const who = added.length === 1 ? `« ${added[0].name} »` : tr(`Ces ${added.length} quêtes`, `These ${added.length} quests`);
    const whoEn = added.length === 1 ? `"${added[0].name}"` : `These ${added.length} quests`;
    applyGrey(
      [...complete],
      [...fail],
      (k, f) =>
        tr(
          `${who} : tu y as accès, donc les ${k + f} quête(s) qui la débloquent sont grisée(s) automatiquement (${k} terminée(s)${f ? `, ${f} échouée(s)` : ""}). Une seule activation suffit pour toute la chaîne.${removeOnUndo ? " « Annuler » retire aussi la quête." : ""}`,
          `${whoEn}: you have access to it, so the ${k + f} quest(s) that unlock it are greyed out automatically (${k} completed${f ? `, ${f} failed` : ""}). One activation covers the whole chain.${removeOnUndo ? ' "Undo" also removes the quest.' : ""}`,
        ),
      replace,
      removeOnUndo ? added.map((t) => t.id) : [],
    );
  };
  const toggleTask = (taskId: string) => {
    const adding = !mode.selected.some((s) => s.taskId === taskId);
    dispatch({ type: "toggleTask", taskId });
    const task = tasksById.get(taskId);
    if (task && adding) greyPrerequisites([task], false, true);
    if (!task || !adding || !currentMap) return;
    const shown = { objectives: shownObjectives(task, mode.done, false, oneAtATime) };
    const target = dominantMap([shown], 0);
    if (!target || target === currentMap.id || shown.objectives.some((o) => o.locations.some((l) => l.mapId === currentMap.id))) return;
    dispatch({ type: "setMap", mapId: target });
    const name = maps.find((m) => m.id === target)?.name ?? "";
    setMapNotice(tr(`Map affichée : ${name} (les points de « ${task.name} » s'y trouvent).`, `Displayed map: ${name} (the points of "${task.name}" are there).`));
  };
  // marque tous les objectifs faits, puis retire la quête de la sélection (l'UnlockToast propose la suite)
  // (et fait échouer ses branches exclusives)
  const completeTask = (task: Task) => {
    const ticks = task.objectives.filter((o) => !mode.done[o.id]).map((o) => o.id);
    const branch = branchFailures([task.id], tasks, mode.done, failed, new Set([task.id]));
    const sel = new Set(mode.selected.map((s) => s.taskId));
    const deselect = [task.id, ...branch].filter((id) => sel.has(id));
    dispatch({ type: "applyQuestStatus", done: ticks, failed: branch, deselect });
    if (branch.length)
      setChainNotice({
        text: tr(`${branch.length} quête(s) de branche exclusive marquée(s) échouée(s).`, `${branch.length} quest(s) of an exclusive branch marked as failed.`),
        undo: () => dispatch({ type: "applyQuestStatus", done: [], undone: ticks, failed: [], unfailed: branch, select: deselect }),
      });
  };
  const failTask = (task: Task) =>
    dispatch({ type: "applyQuestStatus", done: [], failed: [task.id], deselect: mode.selected.some((s) => s.taskId === task.id) ? [task.id] : [] });
  // Monitor : les événements de quêtes sont regroupés ~1,5 s puis appliqués en UNE action avec UNE information « Annuler ».
  // (La proposition de quêtes débloquées reste muette pour ces lots.)
  const monitorQueue = useRef<Extract<MonitorEvent, { type: "task" }>[]>([]);
  const monitorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushMonitor = useRef(() => {});
  useEffect(() => () => clearTimeout(monitorTimer.current), []);
  const applyMonitor = (events: Extract<MonitorEvent, { type: "task" }>[], prefix: string, reopen = false, replace = false) => {
    if (!gameMode || !events.length) return;
    const plan = planMonitorBatch(events, { gameMode, tasks, done: mode.done, failed, selected: mode.selected.map((s) => s.taskId), reopen, replace });
    const c = plan.counts;
    const modeName = (m: string) => (m === "regular" ? "PvP" : m === "pve" ? "PvE" : tr("PvP Saison", "PvP Season"));
    const other = events.find((e) => e.gameMode !== gameMode);
    const parts = [
      c.started && tr(`${c.started} quête(s) commencée(s)`, `${c.started} quest(s) started`),
      c.reopened && tr(`${c.reopened} rouverte(s) (vue(s) en cours)`, `${c.reopened} reopened (seen in progress)`),
      c.finished && tr(`${c.finished} terminée(s)`, `${c.finished} completed`),
      c.failed && tr(`${c.failed} échouée(s)`, `${c.failed} failed`),
      c.prereq && tr(`${c.prereq} prérequis grisé(s)`, `${c.prereq} prerequisite(s) greyed out`),
      c.removed && tr(`${c.removed} retirée(s) de la sélection`, `${c.removed} removed from selection`),
      c.branch && tr(`${c.branch} branche(s) exclusive(s) échouée(s)`, `${c.branch} exclusive branch quest(s) failed`),
      other && tr(`événement ${modeName(other.gameMode)} ignoré (le site affiche ${modeName(gameMode)})`, `${modeName(other.gameMode)} event ignored (the site shows ${modeName(gameMode)})`),
    ].filter(Boolean);
    if (plan.action) {
      if (plan.action.done.length) muteUnlock.current = true;
      dispatch({ type: "applyQuestStatus", ...plan.action });
    }
    if (!parts.length) return;
    const undo = plan.undo;
    setChainNotice({ text: `${prefix} : ${parts.join(" · ")}`, undo: undo ? () => dispatch({ type: "applyQuestStatus", ...undo }) : undefined });
  };
  flushMonitor.current = () => {
    monitorTimer.current = undefined;
    applyMonitor(monitorQueue.current.splice(0), "Monitor");
  };
  const [player, setPlayer] = useState<(PlayerPosition & { mapId: string; gameMode: GameMode }) | null>(null);
  const room = useRoom(state, dispatch, { tasksById, position: player });

  // Coéquipiers (room) : leurs objectifs en cours et leurs positions, calculés comme les miens (même réglage « un raid à la fois »)
  // mais en lecture seule, hors de mes totaux (« Mes maps », sélecteur de map) et sans toucher à mon état.
  const [viewedId, setViewedId] = useState<string | null>(null);
  const teamLive = useMemo(
    () => room.members.filter((m) => m.connected && m.snapshot).map((m) => ({ m, view: viewModeOf(m.snapshot!, tasksById) })),
    [room.members, tasksById],
  );
  const teamStoryIds = useMemo(
    () => [...new Set(teamLive.flatMap(({ view }) => view.story?.selected ?? []))].filter((c) => chaptersWithPositions().includes(c)),
    [teamLive],
  );
  const { items: teamStoryItems } = useStoryItems(teamStoryIds, data?.itemNames ?? NO_NAMES);
  const ownerView = useMemo(() => {
    const m = tabOwner ? room.members.find((x) => x.id === tabOwner && x.snapshot) : undefined;
    return m ? { name: m.name, done: viewModeOf(m.snapshot!, tasksById).done } : undefined;
  }, [tabOwner, room.members, tasksById]);
  const team = useMemo(() => {
    if (!currentMap || teamLive.length === 0) return undefined;
    const markers: TeamMarker[] = [];
    const players: TeamPlayer[] = [];
    for (const { m, view } of teamLive) {
      const pts = buildObjectivePoints(teammateTasks(view, tasksById).filter((t) => !kappaOnly || t.kappaRequired), view, currentMap.id, state.showDone, oneAtATime);
      // ses emplacements possibles d'un même objet : un seul point aussi, déplié au clic (de mon côté)
      const groups = spawnGroups(pts);
      for (const pt of pts) {
        const task = pt.taskId ? tasksById.get(pt.taskId) : undefined;
        const objective = pt.objectiveId ? objectivesById.get(pt.objectiveId) : undefined;
        if (!task || !objective) continue;
        const color = QUEST_COLORS[(view.selected.find((s) => s.taskId === task.id)?.color ?? 0) % QUEST_COLORS.length];
        const g = groups.get(objective.id);
        markers.push({
          key: `${m.id}:${pt.key}`,
          owner: m.name,
          x: pt.x,
          z: pt.z,
          outline: pt.outline,
          color,
          text: `${task.name} — ${objective.description}`,
          taskId: task.id,
          info: { memberId: m.id, photos: Boolean(task.wikiLink) },
          ...(g ? { group: { id: `${m.id}:${objective.id}`, rep: g.rep === pt.key, count: g.keys.length } } : {}),
        });
      }
      for (const c of kappaOnly ? [] : (view.story?.selected ?? [])) {
        const mine = pointsOnMap(currentStoryPoints(c, teamStoryItems[c] ?? [], view.story?.done ?? NO_DONE), currentMap.normalizedName);
        for (const p of mine) markers.push({ key: `${m.id}:${p.id}`, owner: m.name, x: p.x, z: p.z, color: STORY_COLOR, text: `${storyName(c)} — ${p.stepTitle}`, taskId: storyIdOf(c) });
      }
      const pos = m.snapshot!.position;
      if (pos && pos.map === currentMap.id) players.push({ id: m.id, name: m.name, position: pos });
    }
    return { markers, players };
  }, [teamLive, teamStoryItems, currentMap, tasksById, objectivesById, state.showDone, oneAtATime, storyName, kappaOnly]);
  const monitorEvent = useRef((_e: MonitorEvent) => {});
  monitorEvent.current = (e) => {
    if (e.type === "task") {
      monitorQueue.current.push(e);
      monitorTimer.current ??= setTimeout(() => flushMonitor.current(), 1500);
    } else if (e.type === "tasks") {
      // anciens logs : même logique que les événements en direct, mais appliqués tout de suite, en un seul lot
      if (!gameMode) return;
      if (e.gameMode !== gameMode) {
        const name = (m: string) => (m === "regular" ? "PvP" : m === "pve" ? "PvE" : tr("PvP Saison", "PvP Season"));
        setChainNotice({ text: tr(`Monitor : anciens logs ${name(e.gameMode)} ignorés (le site affiche ${name(gameMode)})`, `Monitor: ${name(e.gameMode)} past logs ignored (the site shows ${name(gameMode)})`) });
        return;
      }
      applyMonitor(e.tasks.map((t) => ({ type: "task" as const, ...t, gameMode: e.gameMode, at: e.at })), tr("Monitor (anciens logs)", "Monitor (past logs)"));
    } else if ((e.type === "map" || e.type === "position") && e.gameMode === gameMode) {
      const target = maps.find((m) => m.normalizedName === e.map);
      if (target && target.id !== currentMap?.id) dispatch({ type: "setMap", mapId: target.id });
      if (target && e.type === "position") setPlayer({ mapId: target.id, gameMode: e.gameMode, x: e.x, y: e.y, z: e.z, rotation: e.rotation, at: Math.min(e.at, Date.now()) });
    }
  };
  const monitor = useMonitor((e) => monitorEvent.current(e));
  const showMap = (mapId: string) => {
    dispatch({ type: "setMap", mapId });
    if (isMobile()) setPanelOpen(false);
  };
  const focusPoint = (key: string, mapId: string) => {
    if (mapId !== currentMap?.id) dispatch({ type: "setMap", mapId });
    setFocus((f) => ({ key, n: (f?.n ?? 0) + 1 }));
    if (isMobile()) setPanelOpen(false);
  };
  const startPlacing = (p: Placing) => {
    setPlacing(p);
    if (isMobile()) setPanelOpen(false);
  };

  const onPlace = (pos: { x: number; z: number }) => {
    if (!placing || !currentMap) return;
    if (placing.kind === "manual") {
      dispatch({ type: "setManual", objectiveId: placing.objectiveId, position: { mapId: currentMap.id, ...pos } });
      setFocus((f) => ({ key: manualPointKey(placing.objectiveId), n: (f?.n ?? 0) + 1 }));
    } else {
      const point: CustomPoint = {
        id: newId(),
        mapId: currentMap.id,
        ...pos,
        icon: "star",
        label: "",
        note: "",
        createdAt: Date.now(),
      };
      dispatch({ type: "addCustom", point });
      setFocus((f) => ({ key: `custom:${point.id}`, n: (f?.n ?? 0) + 1 }));
    }
    setPlacing(null);
  };

  // Échap annule le placement en cours
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlacing(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  if (!gameMode) {
    return <ModePicker
        last={getLastMode()}
        onPick={(m) => dispatch({ type: "setGameMode", mode: m })}
        lang={lang}
        onLang={changeLang}
      />;
  }

  const modeLabel = GAME_MODES.find((m) => m.id === gameMode)?.label;
  const sourceLabel =
    load.status === "ready"
      ? load.source === "network"
        ? tr("Téléchargées à l'instant.", "Just downloaded.")
        : load.source === "cache"
          ? tr("Depuis le cache local (rafraîchi toutes les 6 h).", "From the local cache (refreshed every 6 h).")
          : tr(
              `API injoignable, dernière version en cache utilisée (${load.error}).`,
              `API unreachable, using the last cached version (${load.error}).`,
            )
      : "";

  // Mes quêtes (colonne de droite en room, seule colonne sinon)
  const mySelection = data ? (
    <SelectedQuests
      tasks={tasks}
      traders={data.traders}
      maps={maps}
      mode={mode}
      currentMapId={currentMap?.id ?? null}
      dispatch={dispatch}
      onShowMap={showMap}
      mapCounts={mapCounts}
      questsOnMap={questsOnMap}
      mapFilter={selectionMap}
      onMapFilter={setSelectionMap}
      onlyMine={room.members.length > 0 ? onlyMine : undefined}
      onOnlyMine={setOnlyMine}
      kappaOnly={kappaOnly}
      onKappaOnly={setKappaOnly}
      onComplete={completeTask}
      onFocus={focusPoint}
      onStartPlacing={(o) =>
        startPlacing({ kind: "manual", objectiveId: o.id, label: o.description || tr("objectif", "objective") })
      }
      onBrowse={() => setTab("quests")}
      onPhotos={showPhotos}
      onQuest={showQuest}
      onStory={(chapter) => showQuest(storyIdOf(chapter))}
      itemIcons={data.itemIcons ?? {}}
      itemNames={data.itemNames ?? {}}
    />
  ) : null;

  // En room, la sélection passe sur deux colonnes (coéquipier | moi) : le panneau s'élargit le temps de la vue,
  // sans toucher à la largeur enregistrée (tqp:panelWidth).
  const twoColumns = panelOpen && tab === "selection" && Boolean(data) && room.members.length > 0;
  const shownPanelWidth = twoColumns ? Math.max(panelWidth, clampPanelWidth(2 * 360, window.innerWidth)) : panelWidth;

  return (
    <div className="app" style={{ ["--panel-user-w" as string]: `${shownPanelWidth}px` }}>
      <Lightbox />
      <Rail
        modeLabel={modeLabel}
        onModeBadge={() => dispatch({ type: "setGameMode", mode: null })}
        active={panelOpen ? TAB_GROUP[tab] : null}
        selectedCount={mode.selected.length + (mode.story?.selected.length ?? 0)}
        onGroup={(g) => {
          if (panelOpen && TAB_GROUP[tab] === g) setPanelOpen(false); // comme VS Code : reclic = fermer
          else {
            setTab(lastTab.current[g] ?? GROUP_FIRST[g]);
            setPanelOpen(true);
          }
        }}
        raid={raid}
        onRaid={() => changeRaid(!raid)}
        lang={lang}
        onLang={changeLang}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        finder={
          <ItemFinder variant="rail" gameMode={gameMode} lang={lang} tasks={tasks} traders={data?.traders ?? []} maps={maps} itemNames={data?.itemNames ?? NO_NAMES} itemIcons={data?.itemIcons ?? NO_NAMES} onShowQuest={showQuest}
            done={mode.done}
            failed={failed}
            needs={needs}
            hideoutIncluded={includeHideout}
            onIncludeHideout={() => dispatch({ type: "setIncludeHideout", value: true })}
            onAddPoint={(pt) => {
              const point = { ...pt, id: newId(), createdAt: Date.now() };
              dispatch({ type: "addCustom", point });
              // en fond, la carte passe sur la map du point et le centre (le finder reste ouvert)
              focusPoint(`custom:${point.id}`, point.mapId);
            }}
            onShowSpots={(spots, spot) => {
              setItemSpots(spots);
              focusPoint(spot.key, spot.mapId);
            }}
          />
        }
        traders={<TraderWindow variant="rail" gameMode={gameMode} lang={lang} traders={data?.traders ?? []} tasks={tasks} itemIcons={data?.itemIcons ?? NO_NAMES} />}
        room={<RoomControl variant="rail" room={room} />}
      />

      {/* key : recrée tout l'arbre (popups Leaflet comprises) dans la nouvelle langue */}
      <div className="layout" key={lang}>
        <aside id="side-panel" className={`panel ${panelOpen ? "is-open" : ""}`}>
          {SUBS[TAB_GROUP[tab]] && (
            <div className="subswitch" role="tablist">
              {SUBS[TAB_GROUP[tab]]!.map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={`subswitch-btn${tab === id ? " is-active" : ""}`} onClick={() => setTab(id)}>
                  {tr(...label)}
                </button>
              ))}
            </div>
          )}

          {load.status === "loading" && !data && <div className="tab-body notice muted">{tr("Chargement des quêtes…", "Loading quests…")}</div>}
          {load.status === "error" && (
            <div className="tab-body notice">
              <p className="error">
                {tr("Impossible de charger les données de tarkov.dev : ", "Unable to load tarkov.dev data: ")}
                {load.error}
              </p>
              <button className="btn" onClick={() => setReloadToken((n) => n + 1)}>
                {tr("Réessayer", "Retry")}
              </button>
            </div>
          )}

          {data && tab === "quests" && (
            <QuestList
              tasks={tasks}
              traders={data.traders}
              maps={maps}
              mode={mode}
              onToggle={toggleTask}
              onOpen={showQuest}
              onPhotos={showPhotos}
              onClearSelection={() => dispatch({ type: "clearSelection" })}
              onShowMap={(mapId) => dispatch({ type: "setMap", mapId })}
              onToggleStory={(chapter) => dispatch({ type: "toggleStory", chapter })}
              onOpenStory={(chapter) => showQuest(storyIdOf(chapter))}
              onlyMine={room.members.length > 0 ? onlyMine : undefined}
              onOnlyMine={setOnlyMine}
              kappaOnly={kappaOnly}
              onKappaOnly={setKappaOnly}
              ghostIds={ghostIds}
              onRemoveGhosts={() => dispatch({ type: "applyQuestStatus", done: [], failed: [], deselect: ghostIds })}
            />
          )}
          {data && tab === "selection" && (
            room.members.length > 0 ? (
              <div className="room-cols">
                <TeammatePanel
                  members={room.members}
                  viewedId={viewedId}
                  onView={setViewedId}
                  tasks={tasks}
                  traders={data.traders}
                  maps={maps}
                  currentMapId={currentMap?.id ?? null}
                  onPhotos={showPhotos}
                  onQuest={(taskId) => {
                    const viewed = room.members.find((m) => m.id === viewedId) ?? room.members[0];
                    if (viewed) showTeamQuest(viewed.id, taskId);
                  }}
                  onStory={(chapter) => showQuest(storyIdOf(chapter))}
                  itemIcons={data.itemIcons ?? {}}
                  itemNames={data.itemNames ?? {}}
                  // le filtre ne vaut que si la map a encore de mes points (comme dans ma colonne)
                  mapFilter={selectionMap && (mapCounts.get(selectionMap) ?? 0) > 0 ? selectionMap : null}
                  oneAtATime={oneAtATime}
                  kappaOnly={kappaOnly}
                />
                <div className="room-col room-col-mine">{mySelection}</div>
              </div>
            ) : (
              mySelection
            )
          )}
          {data && tab === "quest" && (
            <QuestTab
              tasks={tasks}
              traders={data.traders}
              maps={maps}
              itemNames={data.itemNames ?? {}}
              itemIcons={data.itemIcons ?? {}}
              selectedIds={[...mode.selected.map((s) => s.taskId), ...(mode.story?.selected ?? []).map(storyIdOf)]}
              taskId={tabTaskId}
              onTaskChange={(id) => {
                setTabOwner(null);
                setTabTaskId(id);
              }}
              owner={ownerView?.name}
              storyDone={mode.story?.done ?? {}}
              onStoryStep={setStoryStep}
              onStoryReset={(chapter) => dispatch({ type: "resetStory", chapter })}
              done={ownerView?.done ?? mode.done}
              failed={ownerView ? NO_DONE : failed}
              onActivate={(task) => toggleTask(task.id)}
              onDeactivate={(task) => dispatch({ type: "toggleTask", taskId: task.id })}
              onFail={failTask}
              onSetDone={(objectiveId, value) => dispatch({ type: "setDone", objectiveId, done: value })}
              onReset={(task) => dispatch({ type: "resetProgress", objectiveIds: task.objectives.map((o) => o.id), taskId: task.id })}
              onComplete={completeTask}
              onPhotos={showPhotos}
            />
          )}
          {data && tab === "capture" && (
            <CaptureTab
              tasks={tasks}
              pasted={pastedImage}
              selectedIds={mode.selected.map((s) => s.taskId)}
              onApply={(finished, started, failed, replace) => {
                // nouvelles quêtes en cours seulement (les déjà sélectionnées ne bougent pas) : pour choisir la map
                const added = started.filter((id) => !mode.selected.some((s) => s.taskId === id)).map((id) => tasksById.get(id)).filter((t): t is Task => Boolean(t));
                applyMonitor(
                  [
                    ...finished.map((taskId) => ({ taskId, status: "finished" as const })),
                    ...started.map((taskId) => ({ taskId, status: "started" as const })),
                    ...failed.map((taskId) => ({ taskId, status: "failed" as const })),
                  ].map((t) => ({ type: "task" as const, ...t, gameMode: gameMode!, at: Date.now() })),
                  tr("Capture", "Screenshot"),
                  true,
                  replace,
                );
                const mapId = dominantMap(added);
                if (!mapId || !maps.some((m) => m.id === mapId)) return null;
                dispatch({ type: "setMap", mapId });
                const name = maps.find((m) => m.id === mapId)!.name;
                return tr(`Map affichée : ${name} (la plupart des points des nouvelles quêtes s'y trouvent).`, `Displayed map: ${name} (most points of the new quests are there).`);
              }}
            />
          )}
          {data && tab === "photos" && (
            <PhotosTab
              tasks={tasks}
              selectedIds={mode.selected.map((s) => s.taskId)}
              taskId={tabTaskId}
              onTaskChange={(id) => {
                setPhotoExit(null);
                setTabTaskId(id);
              }}
              exit={photoExit}
              story={photoStory}
            />
          )}
          {data && tab === "custom" && (
            <CustomPointsTab
              points={mode.customPoints}
              maps={maps}
              currentMapId={currentMap?.id ?? null}
              onAdd={() => startPlacing({ kind: "custom" })}
              onFocus={(p) => focusPoint(`custom:${p.id}`, p.mapId)}
            />
          )}
          {tab === "hideout" && (
            <HideoutTab
              gameMode={gameMode}
              lang={lang}
              stations={stationsLoad.stations}
              error={stationsLoad.error}
              onRetry={() => setStationsRetry((n) => n + 1)}
              levels={mode.hideout ?? {}}
              onLevel={(stationId, level) => dispatch({ type: "setHideoutLevel", stationId, level })}
              include={includeHideout}
              onInclude={(value) => dispatch({ type: "setIncludeHideout", value })}
              itemIcons={data?.itemIcons ?? NO_NAMES}
            />
          )}
          {tab === "settings" && (
            <SettingsTab
              gameMode={gameMode}
              data={data}
              dataSource={sourceLabel}
              showDone={state.showDone}
              onShowDone={(value) => dispatch({ type: "setShowDone", value })}
              oneAtATime={oneAtATime}
              onOneAtATime={(value) => dispatch({ type: "setOneAtATime", value })}
              faction={mode.faction}
              onFaction={(faction) => dispatch({ type: "setFaction", faction })}
              onChangeMode={() => dispatch({ type: "setGameMode", mode: null })}
              onShowHelp={() => {
                resetHelp();
                setShowHelp(true);
              }}
              onRefresh={() => setReloadToken((n) => n + 1)}
              onExport={() => exportState(state)}
              onImport={(imported) => dispatch({ type: "import", state: imported })}
              monitor={monitor}
              resetSection={
                <ResetProgressSection
                  tasks={tasks}
                  done={mode.done}
                  storyDone={Object.keys(mode.story?.done ?? {}).length}
                  modeLabel={modeLabel ?? ""}
                  onResetTask={(task) =>
                    dispatch({ type: "resetProgress", objectiveIds: task.objectives.map((o) => o.id), taskId: task.id })
                  }
                  onResetAll={() => dispatch({ type: "resetAllProgress" })}
                  onExport={() => exportState(state)}
                />
              }
            />
          )}
        </aside>
        {/* pas de poignée pendant l'affichage à deux colonnes : elle enregistrerait la largeur temporaire */}
        {panelOpen && !twoColumns && <PanelResizer width={shownPanelWidth} onChange={setPanelWidth} />}

<main className="map-area">
          <div className="map-floating">
            <MapPicker maps={maps} currentId={currentMap?.id ?? ""} counts={mapCounts} onPick={showMap} />
            <label className="scav-check">
              <input type="checkbox" checked={showScavExits} onChange={(e) => changeScavExits(e.target.checked)} />
              <span className="scav-check-long">{tr("Extracts Scav", "Scav extracts")}</span>
              <span className="scav-check-short" aria-hidden="true">Scav</span>
            </label>
            {currentMap?.normalizedName === "the-labyrinth" && (
              <a
                className="btn btn-small lab-tuto"
                href="https://www.youtube.com/watch?v=Ek7oB_AOVU4&t=28s"
                target="_blank"
                rel="noopener noreferrer"
                title={tr("Vidéo YouTube : comment résoudre les puzzles du Labyrinthe", "YouTube video: how to solve the Labyrinth puzzles")}
              >
                {tr("Tuto puzzles", "Puzzle guide")}
              </a>
            )}
            {kappaOnly && (
              <button
                className="btn btn-small kappa-chip"
                onClick={() => setKappaOnly(false)}
                title={tr("La carte ne montre que les quêtes demandées pour la Kappa. Cliquer pour tout montrer.", "The map only shows the quests required for the Kappa. Click to show everything.")}
              >
                <span className="kappa-chip-long">{tr("Kappa seulement", "Kappa only")}</span>
                <span className="kappa-chip-short">Kappa</span>
                <UiIcon id="x" size={12} />
              </button>
            )}
          </div>
          <div className="map-alerts">
          {unlockOffer && (
            <UnlockToast
              done={unlockOffer.done}
              next={unlockOffer.next}
              onYes={() => {
                dispatch({ type: "selectTasks", taskIds: unlockOffer.next.map((t) => t.id), replace: false });
                // la fiche quête montre la (première) quête débloquée
                setTabTaskId(unlockOffer.next[0].id);
                greyPrerequisites(unlockOffer.next);
                setUnlockOffer(null);
              }}
              onNo={() => setUnlockOffer(null)}
            />
          )}
          {chainNotice && (
            <div className="alert" role="status">
              {chainNotice.text}{" "}
              {chainNotice.undo && (
                <button
                  className="link"
                  onClick={() => {
                    chainNotice.undo!();
                    setChainNotice(null);
                  }}
                >
                  {tr("Annuler", "Undo")}
                </button>
              )}{" "}
              <button className="link" onClick={() => setChainNotice(null)}>
                OK
              </button>
            </div>
          )}
          {mapNotice && (
            <div className="alert" role="status">
              {mapNotice}{" "}
              <button className="link" onClick={() => setMapNotice(null)}>
                OK
              </button>
            </div>
          )}

          {monitor.pending && (
            <div className="alert" role="status">
              {tr(`Connecter ce Monitor ? Code ${maskCode(monitor.pending)}`, `Connect this Monitor? Code ${maskCode(monitor.pending)}`)}{" "}
              <button className="link" onClick={monitor.confirmPending}>
                {tr("Oui", "Yes")}
              </button>{" "}
              <button className="link" onClick={monitor.dismissPending}>
                {tr("Non", "No")}
              </button>
            </div>
          )}
          <LegacyRoomPrompt state={state} dispatch={dispatch} />
          {room.notice && (
            <div className="alert" role="status">
              {room.notice}{" "}
              <button className="link" onClick={room.dismissNotice}>
                OK
              </button>
            </div>
          )}

          {load.status === "ready" && load.source === "stale" && (
            <div className="alert">
              {tr(
                "L'API tarkov.dev ne répond pas : affichage de la dernière version en cache.",
                "The tarkov.dev API is not responding: showing the last cached version.",
              )}{" "}
              <button className="link" onClick={() => setReloadToken((n) => n + 1)}>
                {tr("Réessayer", "Retry")}
              </button>
            </div>
          )}
          </div>
          {currentMap ? (
            <MapView
              // une carte = un système de coordonnées : on recrée Leaflet à chaque changement
              key={`${currentMap.id}|${calibration[currentMap.normalizedName]?.key ?? "none"}`}
              map={currentMap}
              maps={maps}
              calibration={calibration[currentMap.normalizedName]}
              points={points}
              customPoints={customPoints}
              tasksById={tasksById}
              objectivesById={objectivesById}
              colorOf={colorOf}
              mode={mode}
              dispatch={dispatch}
              placing={placing}
              onPlace={onPlace}
              focus={focus}
              showScavExits={showScavExits}
              storyPoints={storyPoints}
              storyName={storyName}
              onStoryDone={(chapter, stepKey) => setStoryStep(chapter, stepKey, true)}
              onStoryOpen={(chapter) => showQuest(storyIdOf(chapter))}
              onStoryPhotos={showStoryPhotos}
              player={player && player.mapId === currentMap.id ? player : null}
              team={team && onlyMine ? { ...team, markers: [] } : team}
              itemSpots={itemSpots}
              onClearItemSpots={() => setItemSpots([])}
              onPhotos={showPhotos}
              onExit={showExitPhotos}
              onQuest={showQuest}
              onTeamQuest={showTeamQuest}
              focusTaskId={panelOpen && tab === "quest" ? tabTaskId : null}
            />
          ) : (
            <div className="map-empty muted">{load.status === "loading" ? tr("Chargement…", "Loading…") : tr("Aucune map.", "No map.")}</div>
          )}
          {raid && currentMap && (
            <RaidCard
              key={currentMap.id}
              mapName={currentMap.name}
              points={points}
              tasksById={tasksById}
              objectivesById={objectivesById}
              colorOf={colorOf}
              done={mode.done}
              onSetDone={(objectiveId, value) => dispatch({ type: "setDone", objectiveId, done: value })}
              storyPoints={storyPoints}
              storyName={storyName}
              onStoryDone={(chapter, stepKey) => setStoryStep(chapter, stepKey, true)}
              onQuit={() => changeRaid(false)}
            />
          )}
          {showHelp && !raid && <FirstVisitHelp onClose={() => setShowHelp(false)} />}
          {placing && (
            <button className="btn cancel-placing" onClick={() => setPlacing(null)}>
              {tr("Annuler le placement", "Cancel placement")}
            </button>
          )}
        </main>
      </div>
    </div>
  );
}
