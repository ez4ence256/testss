// Onglet « Capture » : importer des quêtes depuis une capture du menu Personnage > Tâches.
// Ctrl+V (géré par App), bouton « Choisir une image » ou glisser-déposer. L'OCR tourne dans
// le navigateur (lib/ocr.ts) ; le rapprochement avec les noms est strict (lib/ocrMatch.ts).
// Rien n'est jamais ajouté sans passer par l'écran de vérification.
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { Task } from "../types";
import { PhoneCapture } from "./PhoneCapture";
import { isStaleBuildError, staleBuildMessage } from "../lib/staleBuild";
import { mergeOcrResults } from "../lib/phoneCapture";
import { matchOcrLines, type OcrMatch, type OcrMatchResult } from "../lib/ocrMatch";
import type { OcrProgress, Tone } from "../lib/ocr";
import { tr } from "../lib/i18n";
import { UiIcon } from "./UiIcon";
import { filterQuests } from "../lib/questFilter";

interface Props {
  /** Quêtes du mode actuel (seules candidates). */
  tasks: Task[];
  /** Image reçue par Ctrl+V ailleurs dans l'app ; `n` change à chaque collage. */
  pasted: { blob: Blob; n: number } | null;
  /** Ajoute les quêtes cochées ; renvoie le message à afficher (map affichée ou non). */
  onApply: (taskIds: string[], replace: boolean) => string;
  /** Liste des tâches d'un marchand : quêtes bleues terminées, brunes en cours, grises ratées (comme les événements du Monitor). */
  onStatus: (finished: string[], started: string[], failed: string[]) => void;
}

type State =
  | { step: "idle" }
  | { step: "reading"; progress: OcrProgress | null; photo?: [number, number] }
  | { step: "review"; result: OcrMatchResult }
  | { step: "error"; message: string };

const TONE_LABELS: Record<Tone, [string, string]> = { blue: ["terminée", "completed"], brown: ["en cours", "in progress"], grey: ["ratée ?", "failed?"] };

/** Étapes de Tesseract.js : [français, anglais], résolu au rendu (la langue peut changer). */
const STATUS_LABELS: Record<string, [string, string]> = {
  "loading tesseract core": ["Chargement du moteur de lecture…", "Loading the reading engine…"],
  "initializing tesseract": ["Démarrage du moteur…", "Starting the engine…"],
  "loading language traineddata": ["Données de langue (téléchargées la première fois)…", "Language data (downloaded the first time)…"],
  "loading language traineddata (from cache)": ["Données de langue (cache)…", "Language data (cache)…"],
  "initializing api": ["Démarrage du moteur…", "Starting the engine…"],
  "recognizing text": ["Lecture du texte…", "Reading the text…"],
};

export function CaptureTab({ tasks, pasted, onApply, onStatus }: Props) {
  const [state, setState] = useState<State>({ step: "idle" });
  const [preview, setPreview] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // quêtes ajoutées à la main sur l'écran de vérification (l'OCR rate parfois une ligne sur une photo)
  const [added, setAdded] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // une ou plusieurs images (photos du téléphone) : lecture une à une, puis un seul écran de vérification.
  // Au téléphone, les fonds des tâches d'un marchand sont vifs (bleu, orange) : lire le canal le plus sombre
  const handleImages = async (blobs: Blob[], phone = false) => {
    setMessage(null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return blobs.length === 1 ? URL.createObjectURL(blobs[0]) : null;
    });
    setState({ step: "reading", progress: null });
    try {
      const { readImageLines } = await import("../lib/ocr");
      const results: OcrMatchResult[] = [];
      for (const [i, blob] of blobs.entries()) {
        const photo: [number, number] | undefined = blobs.length > 1 ? [i + 1, blobs.length] : undefined;
        const lines = await readImageLines(blob, (progress) => setState({ step: "reading", progress, photo }), { whiteText: phone });
        const r = matchOcrLines(
          // liste d'un marchand : chaque ligne commence par l'icône de la quête (et la flèche des tâches
          // essentielles), lues « ES », « v @ »…
          lines.map((l) => (l.tone ? l.text.replace(/^(\S{1,2} ){1,2}/, "") : l.text)),
          tasks,
        );
        const matched = [...r.recognized, ...r.uncertain].map((m) => lines[m.lineIndexes[0]].tone);
        const colored = matched.filter((t) => t === "blue" || t === "brown").length;
        // les fonds ne disent rien hors de la liste d'un marchand (au moins 2 quêtes, la moitié, en bleu ou brun) :
        // le menu Personnage > Tâches a des fonds gris, et une photo d'écran teinte une ligne au hasard
        const trader = colored >= 2 && colored * 2 >= matched.length;
        const withTone = (m: OcrMatch) => ({ ...m, tone: trader ? lines[m.lineIndexes[0]].tone : undefined });
        results.push({ ...r, recognized: r.recognized.map(withTone), uncertain: r.uncertain.map(withTone) });
      }
      const result = mergeOcrResults(results);
      // gris : ratée ou pas encore acceptée, impossible à dire sur l'image : à cocher soi-même
      setChecked(new Set(result.recognized.filter((m) => m.tone !== "grey").map((m) => m.taskId)));
      setAdded([]);
      setSearch("");
      setState({ step: "review", result });
    } catch (error) {
      setState({
        step: "error",
        message: isStaleBuildError(error)
          ? staleBuildMessage()
          : tr(
              `Lecture impossible : ${(error as Error).message}. La première utilisation demande une connexion (données de langue).`,
              `Could not read the image: ${(error as Error).message}. The first use needs a connection (language data).`,
            ),
      });
    }
  };
  const handleImage = (blob: Blob) => handleImages([blob]);
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleImage(file);
    e.target.value = "";
  };

  // image collée ailleurs dans l'app (Ctrl+V)
  useEffect(() => {
    if (pasted) void handleImage(pasted.blob);
    // seulement à chaque nouveau collage
  }, [pasted?.n]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const toggle = (taskId: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const row = (m: OcrMatch, uncertain: boolean) => {
    const task = tasksById.get(m.taskId);
    if (!task) return null;
    return (
      <li key={m.taskId} className="capture-row">
        <label className="check">
          <input type="checkbox" checked={checked.has(m.taskId)} onChange={() => toggle(m.taskId)} />
          <span>
            <span className="capture-name">{task.name}</span>
            {m.tone && <span className={`capture-tone tone-${m.tone}`}>{tr(...TONE_LABELS[m.tone])}</span>}
            {task.nameEn !== task.name && <span className="muted small"> · {task.nameEn}</span>}
            <span className="muted small capture-read">
              {uncertain ? tr("Lu par l'OCR : ", "Read by OCR: ") : tr("Lu : ", "Read: ")}{tr(`« ${m.text} »`, `"${m.text}"`)}
              {uncertain ? tr(` · ressemblance ${Math.round(m.score * 100)} %`, ` · similarity ${Math.round(m.score * 100)}%`) : ""}
            </span>
          </span>
        </label>
      </li>
    );
  };

  const progress = state.step === "reading" ? state.progress : null;
  // lignes à fond coloré : capture de la liste des tâches d'un marchand
  const toned = state.step === "review" ? [...state.result.recognized, ...state.result.uncertain].filter((m) => m.tone) : [];
  const toneIds = (tone: Tone) => toned.filter((m) => m.tone === tone && checked.has(m.taskId)).map((m) => m.taskId);
  const [finished, started, failed] = [toneIds("blue"), toneIds("brown"), toneIds("grey")];

  return (
    <div
      className={`tab-body capture-tab ${dragging ? "is-dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
        if (file) void handleImage(file);
      }}
    >
      <div className="subhead">{tr("Importer des quêtes depuis une capture", "Import quests from a screenshot")}</div>
      <p className="small">
        {tr("Faites une capture du menu ", "Take a screenshot of the in-game ")}
        <strong>{tr("Personnage > Tâches", "Character > Tasks")}</strong>
        {tr(" du jeu (filtré par map si vous voulez), puis", " menu (filtered by map if you like), then")}{" "}
        <kbd>Ctrl</kbd>+<kbd>V</kbd>{tr(" n'importe où dans l'app (sauf dans un champ de texte), ou :", " anywhere in the app (except in a text field), or:")}
      </p>
      <p className="small">
        {tr(
          "Ou la liste des tâches d'un marchand, terminées affichées : les quêtes sur fond bleu sont marquées terminées d'un coup, celles sur fond brun ajoutées à vos quêtes. Celles sur fond gris (ratées, ou pas encore acceptées) restent décochées : cochez celles qui sont ratées.",
          "Or a trader's task list with completed ones shown: quests on a blue background are marked completed in one go, those on a brown background added to your quests. Those on a grey background (failed, or not accepted yet) stay unchecked: check the failed ones.",
        )}
      </p>
      <div className="btn-row">
        <button className="btn btn-primary btn-small" onClick={() => fileRef.current?.click()}>
          {tr("Choisir une image", "Choose an image")}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        {/* téléphone seulement (CSS) : ouvre directement l'appareil photo */}
        <button className="btn btn-primary btn-small mobile-only" onClick={() => cameraRef.current?.click()}>
          <UiIcon id="camera" /> {tr("Prendre une photo", "Take a photo")}
        </button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
        <span className="muted small">{tr("ou glissez-déposez l'image ici.", "or drag and drop the image here.")}</span>
      </div>
      <PhoneCapture onPhotos={(photos) => void handleImages(photos, true)} />
      <p className="muted small">
        {tr(
          "La lecture se fait dans votre navigateur : l'image n'est envoyée nulle part (avec le téléphone, les photos transitent par ce serveur, en mémoire, puis sont effacées). La première fois, environ 4 Mo de données de langue (français + anglais) sont téléchargés, puis gardés en cache.",
          "Reading happens in your browser: the image is not sent anywhere (with the phone, photos pass through this server, in memory only, then are deleted). The first time, about 4 MB of language data (French + English) is downloaded, then cached.",
        )}
      </p>

      {preview && <img className="capture-preview" src={preview} alt={tr("Capture importée", "Imported screenshot")} />}

      {state.step === "reading" && (
        <div className="capture-progress" role="status">
          <div>
            {state.photo && tr(`Photo ${state.photo[0]}/${state.photo[1]} : `, `Photo ${state.photo[0]}/${state.photo[1]}: `)}
            {tr(...(STATUS_LABELS[progress?.status ?? ""] ?? ["Préparation…", "Preparing…"]))}
          </div>
          <progress max={1} value={progress?.progress ?? 0} />
        </div>
      )}
      {state.step === "error" && <p className="error">{state.message}</p>}

      {state.step === "review" && (
        <>
          {state.result.recognized.length === 0 && state.result.uncertain.length === 0 ? (
            <p className="warn-box">
              {tr(
                "Aucune quête reconnue sur cette capture. Essayez une capture plus nette du menu Personnage > Tâches, recadrée sur la liste des quêtes, et vérifiez que le bon mode de jeu est choisi.",
                "No quest recognized in this screenshot. Try a sharper screenshot of the Character > Tasks menu, cropped to the quest list, and check that the right game mode is selected.",
              )}
            </p>
          ) : (
            <>
              {state.result.recognized.length > 0 && (
                <section>
                  <div className="subhead">{tr(`Reconnues (${state.result.recognized.length})`, `Recognized (${state.result.recognized.length})`)}</div>
                  <ul className="capture-list">{state.result.recognized.map((m) => row(m, false))}</ul>
                </section>
              )}
              {state.result.uncertain.length > 0 && (
                <section>
                  <div className="subhead">{tr(`Incertaines (${state.result.uncertain.length}) : à vérifier`, `Uncertain (${state.result.uncertain.length}): to check`)}</div>
                  <ul className="capture-list">{state.result.uncertain.map((m) => row(m, true))}</ul>
                </section>
              )}
            </>
          )}
          <section className="capture-add">
            <div className="subhead">{tr("Une quête manque ?", "A quest is missing?")}</div>
            {added.length > 0 && (
              <ul className="capture-list">
                {added.map((id) => (
                  <li key={id} className="capture-row">
                    <label className="check">
                      <input type="checkbox" checked={checked.has(id)} onChange={() => toggle(id)} />
                      <span className="capture-name">{tasksById.get(id)?.name ?? id}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <input className="input" type="search" value={search} placeholder={tr("Nom de la quête (FR ou EN)…", "Quest name (FR or EN)…")} aria-label={tr("Ajouter une quête à la main", "Add a quest by hand")} onChange={(e) => setSearch(e.target.value)} />
            {search.trim() && (
              <ul className="capture-suggest">
                {filterQuests(tasks, { query: search, traderId: "", mapId: "", hideCompleted: false }, {})
                  .filter((r) => !added.includes(r.task.id) && ![...state.result.recognized, ...state.result.uncertain].some((m) => m.taskId === r.task.id))
                  .slice(0, 5)
                  .map((r) => (
                    <li key={r.task.id}>
                      <button
                        className="btn btn-small"
                        onClick={() => {
                          setAdded((a) => [...a, r.task.id]);
                          setChecked((c) => new Set(c).add(r.task.id));
                          setSearch("");
                        }}
                      >
                        + {r.task.name}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>
          {finished.length + started.length + failed.length > 0 && (
            <div className="btn-row">
              <button
                className="btn btn-primary"
                onClick={() => {
                  onStatus(finished, started, failed);
                  setState({ step: "idle" });
                }}
              >
                {tr(
                  `Mettre à jour mes quêtes (${finished.length} terminées, ${started.length} en cours${failed.length ? `, ${failed.length} ratées` : ""})`,
                  `Update my quests (${finished.length} completed, ${started.length} in progress${failed.length ? `, ${failed.length} failed` : ""})`,
                )}
              </button>
            </div>
          )}
          {checked.size > 0 && (
            <>
              <label className="check">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                {tr("Remplacer ma sélection actuelle", "Replace my current selection")}
              </label>
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setMessage(onApply([...checked], replace));
                    setState({ step: "idle" });
                  }}
                >
                  {tr(`Ajouter à la sélection (${checked.size})`, `Add to selection (${checked.size})`)}
                </button>
              </div>
            </>
          )}
          {state.result.unmatched.length > 0 && (
            <details className="capture-unmatched">
              <summary>{tr(`Lignes non reconnues (${state.result.unmatched.length})`, `Unrecognized lines (${state.result.unmatched.length})`)}</summary>
              <ul className="plain-list small">
                {state.result.unmatched.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {message && (
        <p className="capture-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
