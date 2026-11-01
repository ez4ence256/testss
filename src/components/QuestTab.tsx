// Onglet "Quête" : tout ce qu'il faut savoir et faire pour une quête.
//  - en haut : progression, objectifs tarkov.dev à cocher, réinitialisation ;
//  - dessous, sections repliables dans l'ordre de lib/questSections.ts : Objectifs,
//    À emporter, Guide (ouvertes, texte du wiki mis en avant), puis Récompenses,
//    Prérequis, Équipement initial et Résumé (repliées).
// Reste atteignable même quand tous les points sont faits (donc absents de la carte) :
// depuis la popup d'un autre point de la quête, ou depuis la quête dans le panneau.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { GameMap, Task, Trader } from "../types";
import { ICON_LABELS, categoryOf } from "../lib/objectiveTypes";
import { taskProgress } from "../lib/points";
import { isGreyed } from "../lib/questChain";
import { iconUrl } from "../api/tarkovJson";
import { loadQuestPhotos, loadWikiPage, type WikiPage, type WikiPhoto } from "../api/wiki";
import {
  acceptWikiPage,
  compareRewards,
  comparePrerequisites,
  failConditionText,
  isPvpZone,
  packingList,
  readWikiQuest,
  STATUS_LABELS,
  type PackItem,
  type QuestLink,
  type WikiQuest,
} from "../lib/questWiki";
import { Icon } from "./Icon";
import { ConfirmButton } from "./ConfirmButton";
import { ObjectiveItems } from "./ObjectiveItems";
import { ItemThumb, useItemIcons } from "./ItemThumb";
import { WikiBlocks } from "./WikiBlocks";
import { QUEST_SECTIONS, type QuestSectionId } from "../lib/questSections";
import { getLang, tr } from "../lib/i18n";
import { UiIcon } from "./UiIcon";
import { chapterOf, isStoryId } from "../lib/story";
import { StoryChapterView, chapterName, useStoryChapters } from "./StoryView";

interface Props {
  tasks: Task[];
  traders: Trader[];
  maps: GameMap[];
  itemNames: Record<string, string>;
  /** Images des objets (id -> URL) ; un objet sans image est affiché par son nom seul. */
  itemIcons: Record<string, string>;
  /** Quêtes sélectionnées (proposées dans la liste). */
  selectedIds: string[];
  /** Quête affichée. */
  taskId: string | null;
  /** Change la quête affichée (liste, ou quête préalable / suivante cliquée). */
  onTaskChange: (taskId: string) => void;
  done: Record<string, number>;
  /** Quêtes marquées échouées. */
  failed: Record<string, true>;
  /** « Activer » : je fais cette quête (ajoutée à la sélection, prérequis grisés). */
  onActivate: (task: Task) => void;
  /** « ✓ Active » : retire de la sélection (ne dégrise rien). */
  onDeactivate: (task: Task) => void;
  /** « Marquer échouée ». */
  onFail: (task: Task) => void;
  onSetDone: (objectiveId: string, done: boolean) => void;
  /** Remet les objectifs à faire et retire des échouées (aussi « Dé-griser »). */
  onReset: (task: Task) => void;
  /** « Quête terminée » : coche tous ses objectifs et la retire de la sélection. */
  onComplete: (task: Task) => void;
  onPhotos: (taskId: string) => void;
  /** Étapes cochées de la Main story (voir StoryState). */
  storyDone: Record<string, true>;
  onStoryStep: (chapter: string, stepKey: string, done: boolean) => void;
  onStoryReset: (chapter: string) => void;
  /** Quête d'un coéquipier de la room : sa progression, en lecture seule (ni « Fait », ni « Activer »). */
  owner?: string;
}

/** Quêtes proposées dans un onglet (Quête, Photos) : la quête demandée, puis la sélection. */
export function tabTaskOptions(taskId: string | null, selectedIds: string[]) {
  return [...new Set([...(taskId ? [taskId] : []), ...selectedIds])];
}

type WikiState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; page: WikiPage }
  | { status: "error"; error: string };

function useWikiPage(wikiLink: string | null): WikiState {
  const [state, setState] = useState<WikiState>({ status: "none" });
  useEffect(() => {
    if (!wikiLink) {
      setState({ status: "none" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadWikiPage(wikiLink)
      .then((page) => !cancelled && setState({ status: "ready", page }))
      .catch((error: Error) => !cancelled && setState({ status: "error", error: error.message }));
    return () => {
      cancelled = true;
    };
  }, [wikiLink]);
  return state;
}

/** Section repliable ; non affichée si elle n'a rien à montrer. */
function Section({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="quest-section" open={open}>
      <summary>{title}</summary>
      <div className="quest-section-body">{children}</div>
    </details>
  );
}

/** Photos de la section Guide du wiki (même chargeur et même cache que l'onglet Photos), en bandeau de vignettes. */
function GuidePhotos({ wikiLink }: { wikiLink: string }) {
  const [state, setState] = useState<{ photos: WikiPhoto[] } | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    loadQuestPhotos(wikiLink)
      .then((g) => !cancelled && setState({ photos: g.photos }))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [wikiLink]);
  if (state === "loading") return <p className="muted small">{tr("Chargement des photos du wiki…", "Loading wiki photos…")}</p>;
  if (state === "error") return <p className="muted small">{tr("Photos du wiki indisponibles.", "Wiki photos unavailable.")}</p>;
  if (state.photos.length === 0) return null;
  return (
    <div className="story-photos">
      {state.photos.map((p) => (
        <a key={p.file} className="story-photo" data-lightbox href={p.fullUrl} target="_blank" rel="noopener noreferrer" title={p.caption || tr("Voir en grand", "View full size")}>
          <img src={p.thumbUrl} alt={p.caption || p.file} width={120} height={68} loading="lazy" referrerPolicy="no-referrer" />
        </a>
      ))}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="warn-box" role="note">
      <strong>{tr("Les sources ne sont pas d'accord :", "The sources disagree:")}</strong>
      <ul>
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Liste de quêtes, cliquables quand elles existent dans l'app. `displayName` donne le nom
 * affiché (nom de l'app, en français) ; sans lui, le nom anglais du wiki est gardé.
 */
function QuestLinks({
  links,
  onOpen,
  suffix,
  displayName,
}: {
  links: QuestLink[];
  onOpen: (id: string) => void;
  suffix?: (l: QuestLink) => string;
  displayName?: (l: QuestLink) => string;
}) {
  return (
    <ul className="plain-list">
      {links.map((l) => (
        <li key={l.name}>
          {l.taskId ? (
            <button className="link" onClick={() => onOpen(l.taskId!)} title={l.name}>
              {displayName?.(l) ?? l.name}
            </button>
          ) : (
            l.name
          )}
          {suffix?.(l)}
        </li>
      ))}
    </ul>
  );
}

// title : [français, anglais], résolu au rendu (la langue peut changer)
const PACK_GROUPS: { kinds: PackItem["kind"][]; title: [string, string] }[] = [
  { kinds: ["key"], title: ["Clés", "Keys"] },
  { kinds: ["handover", "find", "sell"], title: ["Objets à trouver ou à rendre", "Items to find or hand over"] },
  { kinds: ["questItem"], title: ["Objets de quête à trouver en raid", "Quest items to find in raid"] },
  { kinds: ["place", "marker"], title: ["À placer ou à marquer", "To place or mark"] },
];

// seulement si la source le précise
const firLabel = (fir: boolean | null | undefined) =>
  fir === true ? tr("Found in raid : oui", "Found in raid: yes") : fir === false ? tr("Found in raid : non", "Found in raid: no") : null;

/** Image d'un objet, à taille fixe (pas de saut de page) ; rien si l'URL est inconnue. */
function ItemIcon({ url, name }: { url?: string; name: string }) {
  return url ? <img className="item-icon" src={iconUrl(url)} alt={name} width={32} height={32} loading="lazy" /> : null;
}

const fmt = (n: number) => n.toLocaleString(getLang() === "en" ? "en-US" : "fr-FR");

export function QuestTab(p: Props) {
  const tasksById = useMemo(() => new Map(p.tasks.map((t) => [t.id, t])), [p.tasks]);
  // chapitres de la Main story : identifiants « story:<titre> », absents de tasksById
  const optionIds = tabTaskOptions(p.taskId, p.selectedIds).filter((id) => tasksById.has(id) || isStoryId(id));
  const storyId = isStoryId(optionIds[0]) ? chapterOf(optionIds[0]) : null;
  const task = optionIds.length > 0 && !storyId ? tasksById.get(optionIds[0]) : undefined;
  const [chaptersRetry, setChaptersRetry] = useState(0);
  const chapters = useStoryChapters(optionIds.some(isStoryId), chaptersRetry);
  const wikiState = useWikiPage(task?.wikiLink ?? null);

  const wiki: WikiQuest | null = useMemo(
    () => (wikiState.status === "ready" && acceptWikiPage(wikiState.page) ? readWikiQuest(wikiState.page) : null),
    [wikiState],
  );

  const relatedIcon = useItemIcons(wiki?.relatedItems.map((r) => r.name) ?? [], p.itemNames, p.itemIcons);

  const optionLabel = (id: string) => (isStoryId(id) ? `Main story · ${chapterName(chapters.chapters, chapterOf(id))}` : tasksById.get(id)!.name);
  const picker =
    optionIds.length > 1 ? (
      <select className="input" value={optionIds[0]} onChange={(e) => p.onTaskChange(e.target.value)} aria-label={tr("Quête affichée", "Displayed quest")}>
        {optionIds.map((id) => (
          <option key={id} value={id}>
            {optionLabel(id)}
          </option>
        ))}
      </select>
    ) : null;

  if (storyId) {
    return (
      <div className="tab-body quest-tab">
        <div className="subhead">{tr("Quête sélectionnée", "Selected quest")}</div>
        {picker}
        <StoryChapterView
          key={storyId}
          chapterId={storyId}
          itemNames={p.itemNames}
          itemIcons={p.itemIcons}
          chapters={chapters}
          done={p.storyDone}
          onSetStep={(stepKey, value) => p.onStoryStep(storyId, stepKey, value)}
          onReset={() => p.onStoryReset(storyId)}
          onRetryChapters={() => setChaptersRetry((n) => n + 1)}
        />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="tab-body empty">
        <p>{tr("Sélectionnez une quête, ou ouvrez-la depuis un point de la carte (bouton « Quête »).", "Select a quest, or open it from a map point (“Quest” button).")}</p>
      </div>
    );
  }

  const ctx = { tasks: p.tasks, traders: p.traders };
  const progress = taskProgress(task, p.done);
  const checked = task.objectives.filter((o) => p.done[o.id]).length;
  const greyed = isGreyed(task, p.done, p.failed);
  const active = p.selectedIds.includes(task.id);
  const traderName = (id: string) => p.traders.find((t) => t.id === id)?.name ?? "?";
  const prereq = comparePrerequisites(task, wiki, ctx);
  const pack = packingList(task, p.itemNames, p.maps);
  const rewardDiffs = compareRewards(task, wiki, p.traders);
  const rewards = task.details?.rewards ?? null;
  const showTarkovRewards = rewards !== null && (rewardDiffs.length > 0 || !wiki || wiki.rewards.length === 0);
  const pvp = isPvpZone(task) && wiki !== null;
  const itemName = (id: string) => p.itemNames[id] ?? tr(`objet inconnu (${id})`, `unknown item (${id})`);
  const icon = (id: string) => <ItemIcon url={p.itemIcons[id]} name={itemName(id)} />;
  const statusText = (l: QuestLink & { status?: string[] }) =>
    l.status?.length ? ` (${l.status.map((s) => STATUS_LABELS[s] ?? s).join(tr(" ou ", " or "))})` : "";
  // niveau et marchand de la quête préalable, quand tarkov.dev les donne
  const requirementText = (l: QuestLink) => {
    const t = l.taskId ? tasksById.get(l.taskId) : undefined;
    const parts = [t?.minPlayerLevel ? tr(`niveau ${t.minPlayerLevel}`, `level ${t.minPlayerLevel}`) : "", t ? traderName(t.traderId) : ""].filter(Boolean);
    return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  };
  // quêtes de tarkov.dev : nom de l'app (français) ; celles du wiki gardent leur nom anglais
  const appName = (l: QuestLink) => (l.taskId ? tasksById.get(l.taskId)?.name : undefined) ?? l.name;
  const traderReqs = task.details?.traderRequirements ?? [];
  const failConditions = task.details?.failConditions ?? [];

  const hasPrereq =
    prereq.tarkovTasks.length > 0 ||
    prereq.wikiTasks.length > 0 ||
    prereq.tarkovNext.length > 0 ||
    prereq.wikiNext.length > 0 ||
    traderReqs.length > 0 ||
    Boolean(task.minPlayerLevel) ||
    (wiki?.requirements.length ?? 0) > 0 ||
    prereq.warnings.length > 0;
  const hasPack = pack.length > 0 || (wiki?.relatedItems.length ?? 0) > 0;
  const hasRewards = (wiki?.rewards.length ?? 0) > 0 || showTarkovRewards || (rewards?.items.length ?? 0) > 0;
  const hasGuide = (wiki?.guide.length ?? 0) > 0 || failConditions.length > 0 || task.details?.restartable === true;

  /** Mention de la source, en tête des sections où le texte du wiki est mis en avant. */
  const wikiSource = wiki && (
    <div className="wiki-source small">
      {tr("Texte du wiki, en anglais :", "Wiki text, in English:")}{" "}
      <a href={wiki.pageUrl} target="_blank" rel="noreferrer">
        {wiki.pageTitle}
      </a>
    </div>
  );

  // contenu de chaque section ; null = pas de données, section masquée
  const sections: Record<QuestSectionId, ReactNode | null> = {
    objectives:
      wiki && wiki.objectives.length > 0 ? (
        <div className="wiki-highlight">
          {wikiSource}
          <WikiBlocks blocks={wiki.objectives} itemNames={p.itemNames} itemIcons={p.itemIcons} />
        </div>
      ) : null,

    pack: hasPack ? (
      <>
        {wiki && wiki.relatedItems.length > 0 && (
          <div className="wiki-highlight">
            {wikiSource}
            <div className="wiki-heading wiki-heading-4">{tr("Tableau « Related Quest Items »", "\"Related Quest Items\" table")}</div>
            <ul className="plain-list pack-list">
              {wiki.relatedItems.map((r, k) => (
                <li key={k}>
                  <ItemThumb src={relatedIcon(r.name)} name={r.name} />
                  {r.amount && r.amount !== "1" ? `${r.amount} × ` : ""}
                  {r.name}
                  {r.requirement && <span className="muted small"> · {r.requirement}</span>}
                  {firLabel(r.foundInRaid) && <span className={`fir-tag ${r.foundInRaid ? "is-fir" : ""}`}>{firLabel(r.foundInRaid)}</span>}
                  {r.notes && <div className="muted small pre-line">{r.notes}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {pack.length > 0 && (
          <>
            <div className="muted small">{tr("Pour toute la quête, d'après tarkov.dev (à reprendre après une mort) :", "For the whole quest, per tarkov.dev (to pick up again after a death):")}</div>
            {PACK_GROUPS.map((g) => {
              const items = pack.filter((i) => g.kinds.includes(i.kind));
              if (items.length === 0) return null;
              return (
                <div key={g.title[0]}>
                  <div className="wiki-heading wiki-heading-4">{tr(...g.title)}</div>
                  <ul className="plain-list pack-list">
                    {items.map((i, k) => (
                      <li key={k}>
                        {i.itemIds?.map((id) => <span key={id}>{icon(id)}</span>)}
                        {!i.countInLabel && i.count && i.count > 1 ? `${i.count} × ` : ""}
                        {i.label}
                        {i.kind === "sell" && tr(" (à vendre)", " (to sell)")}
                        {firLabel(i.foundInRaid) && <span className={`fir-tag ${i.foundInRaid ? "is-fir" : ""}`}>{firLabel(i.foundInRaid)}</span>}
                        {i.detail && <span className="muted small"> · {i.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        )}
      </>
    ) : null,

    guide: hasGuide ? (
      <>
        {wiki && wiki.guide.length > 0 && (
          <div className="wiki-highlight">
            {wikiSource}
            <WikiBlocks blocks={wiki.guide} itemNames={p.itemNames} itemIcons={p.itemIcons} />
            {task.wikiLink && <GuidePhotos wikiLink={task.wikiLink} />}
          </div>
        )}
        {(failConditions.length > 0 || task.details?.restartable) && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Selon tarkov.dev", "According to tarkov.dev")}</div>
            <ul className="plain-list">
              {failConditions.map((f, i) => (
                <li key={i}>{failConditionText(f, tasksById)}</li>
              ))}
              {task.details && failConditions.length > 0 && (
                <li>{tr("Refaisable après un échec : ", "Can be redone after failing: ")}{task.details.restartable ? tr("oui", "yes") : tr("non", "no")}</li>
              )}
              {task.details?.restartable && failConditions.length === 0 && <li>{tr("Refaisable après un échec : oui", "Can be redone after failing: yes")}</li>}
            </ul>
          </>
        )}
      </>
    ) : null,

    rewards: hasRewards ? (
      <>
        {wiki && wiki.rewards.length > 0 && <WikiBlocks blocks={wiki.rewards} itemNames={p.itemNames} itemIcons={p.itemIcons} />}
        <Warnings items={rewardDiffs} />
        {rewards && rewards.items.length > 0 && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Objets reçus (tarkov.dev)", "Items received (tarkov.dev)")}</div>
            <ul className="plain-list">
              {rewards.items.map((r, i) => (
                <li key={i}>
                  {icon(r.itemId)}
                  {fmt(r.count)} × {itemName(r.itemId)}
                </li>
              ))}
            </ul>
          </>
        )}
        {showTarkovRewards && rewards && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Selon tarkov.dev", "According to tarkov.dev")}</div>
            <ul className="plain-list">
              {rewards.experience > 0 && <li>+{fmt(rewards.experience)} EXP</li>}
              {rewards.standing.map((s, i) => (
                <li key={`s${i}`}>
                  {tr("Réputation", "Reputation")} {traderName(s.traderId)} {s.value > 0 ? "+" : ""}
                  {s.value}
                </li>
              ))}
              {rewards.offerUnlocks.map((u, i) => (
                <li key={`o${i}`}>
                  {icon(u.itemId)}
                  {tr(`Débloque l'achat de ${itemName(u.itemId)} chez ${traderName(u.traderId)} (niveau ${u.level})`, `Unlocks purchase of ${itemName(u.itemId)} at ${traderName(u.traderId)} (level ${u.level})`)}
                </li>
              ))}
              {rewards.skills.map((s, i) => (
                <li key={`k${i}`}>
                  {tr(`Compétence « ${s.skill} » : niveau ${s.level}`, `Skill "${s.skill}": level ${s.level}`)}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    ) : null,

    prereq: hasPrereq ? (
      <>
        <Warnings items={prereq.warnings} />
        <div className="wiki-heading wiki-heading-3">{tr("Selon tarkov.dev", "According to tarkov.dev")}</div>
        <ul className="plain-list">
          {task.minPlayerLevel ? <li>{tr("Niveau", "Level")} {task.minPlayerLevel}</li> : null}
          {traderReqs.map((r, i) => (
            <li key={i}>
              {traderName(r.traderId)}{tr(" : ", ": ")}{r.type === "level" ? tr("niveau de fidélité", "loyalty level") : tr("réputation", "reputation")} {r.compare} {r.value}
            </li>
          ))}
          {prereq.tarkovTasks.length === 0 && <li>{tr("Aucune quête préalable", "No prerequisite quest")}</li>}
        </ul>
        {prereq.tarkovTasks.length > 0 && (
          <>
            <div className="muted small">{tr("Quêtes préalables :", "Prerequisite quests:")}</div>
            <QuestLinks links={prereq.tarkovTasks} onOpen={p.onTaskChange} suffix={(l) => statusText(l) + requirementText(l)} displayName={appName} />
          </>
        )}
        {wiki && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Selon le wiki (en anglais)", "According to the wiki (in English)")}</div>
            {wiki.loyaltyLevel !== null && <div className="small">LL requirement : {wiki.loyaltyLevel}</div>}
            {wiki.requirements.length > 0 && <WikiBlocks blocks={wiki.requirements} itemNames={p.itemNames} itemIcons={p.itemIcons} />}
            {prereq.wikiTasks.length > 0 && (
              <>
                <div className="muted small">{tr("Quêtes précédentes (previous) :", "Previous quests:")}</div>
                <QuestLinks links={prereq.wikiTasks} onOpen={p.onTaskChange} />
              </>
            )}
            {wiki.requirements.length === 0 && prereq.wikiTasks.length === 0 && wiki.loyaltyLevel === null && (
              <div className="muted small">{tr("Le wiki ne donne pas de prérequis.", "The wiki gives no prerequisites.")}</div>
            )}
          </>
        )}
        {(prereq.tarkovNext.length > 0 || prereq.wikiNext.length > 0) && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Quêtes suivantes", "Next quests")}</div>
            {prereq.tarkovNext.length > 0 && (
              <QuestLinks links={prereq.tarkovNext} onOpen={p.onTaskChange} suffix={() => " (tarkov.dev)"} displayName={appName} />
            )}
            {prereq.wikiNext.length > 0 && <QuestLinks links={prereq.wikiNext} onOpen={p.onTaskChange} suffix={() => " (wiki)"} />}
          </>
        )}
      </>
    ) : null,

    equipment: wiki && wiki.initialEquipment.length > 0 ? <WikiBlocks blocks={wiki.initialEquipment} itemNames={p.itemNames} itemIcons={p.itemIcons} /> : null,

    summary: (
      <>
        {wiki?.briefing && <blockquote className="wiki-quote">{wiki.briefing}</blockquote>}
        <ul className="plain-list">
          <li>
            {tr("Marchand", "Trader")}{tr(" : ", ": ")}{traderName(task.traderId)}
            {wiki?.givenBy && wiki.givenBy.toLowerCase() !== p.traders.find((t) => t.id === task.traderId)?.normalizedName
              ? ` (wiki${tr(" : ", ": ")}${wiki.givenBy})`
              : ""}
          </li>
          {wiki?.location && <li>{tr("Lieu (wiki) : ", "Location (wiki): ")}{wiki.location}</li>}
          {task.minPlayerLevel ? <li>{tr("Niveau requis : ", "Required level: ")}{task.minPlayerLevel}</li> : null}
          <li>
            Kappa{tr(" : ", ": ")}
            {/* quête absente de tarkov.dev : seul l'avis du wiki compte */}
            {/* kappaRequired réunit tarkov.dev et la liste du wiki (src/data/kappa-wiki.json) */}
            {task.source !== "wiki" && <>{task.kappaRequired ? tr("requise", "required") : tr("non requise", "not required")} (tarkov.dev + wiki)</>}
            {wiki && wiki.kappa !== null ? `${task.source !== "wiki" ? " · " : ""}${wiki.kappa ? tr("requise", "required") : tr("non requise", "not required")} (wiki)` : ""}
          </li>
          {task.details?.lightkeeperRequired && <li>{tr("Requise pour Lightkeeper (tarkov.dev)", "Required for Lightkeeper (tarkov.dev)")}</li>}
        </ul>
        {wiki?.failureDialogue && (
          <>
            <div className="wiki-heading wiki-heading-3">{tr("Réplique en cas d'échec", "Failure dialogue")}</div>
            <blockquote className="wiki-quote">{wiki.failureDialogue}</blockquote>
          </>
        )}
      </>
    ),
  };

  return (
    <div className="tab-body quest-tab">
      <div className="subhead">{tr("Quête sélectionnée", "Selected quest")}</div>
      {picker}

      {pvp && (
        <div className="pvp-banner" role="note">
          {tr(
            `Cette quête PVP ZONE n'a pas de page propre sur le wiki : le texte affiché est celui de la quête normale « ${wiki!.pageTitle} » et peut différer (objectifs, récompenses).`,
            `This PVP ZONE quest has no page of its own on the wiki: the text shown is from the regular quest "${wiki!.pageTitle}" and may differ (objectives, rewards).`,
          )}
        </div>
      )}
      {wiki?.historical && (
        <div className="warn-box" role="note">
          {tr(
            "Page historique : d'après le wiki, cette quête n'est plus dans le jeu (catégorie « Historical content »).",
            "Historical page: according to the wiki, this quest is no longer in the game (category \"Historical content\").",
          )}
        </div>
      )}

      {p.owner && (
        <div className="warn-box" role="note">
          {tr(`Quête de ${p.owner} : sa progression, en lecture seule.`, `${p.owner}'s quest: their progress, read-only.`)}
        </div>
      )}
      <div className="quest-tab-head">
        <h2 className="quest-tab-title">{task.name}</h2>
        <span
          className={`progress-badge ${progress.done === progress.total && progress.total > 0 ? "is-complete" : ""}`}
          title={tr("Objectifs faits / objectifs obligatoires", "Objectives done / required objectives")}
        >
          {progress.done}/{progress.total}
        </span>
      </div>
      <div className="muted small">
        {traderName(task.traderId)}
        {task.minPlayerLevel ? tr(` · niveau ${task.minPlayerLevel}`, ` · level ${task.minPlayerLevel}`) : ""}
        {task.kappaRequired ? " · Kappa" : ""}
        {task.source === "wiki" ? " · wiki" : ""}
        {task.nameEn !== task.name ? ` · EN${tr(" : ", ": ")}${task.nameEn}` : ""}
      </div>

      <div className="subhead">{task.source === "wiki" ? tr("Objectifs à cocher (wiki)", "Objectives to check off (wiki)") : tr("Objectifs à cocher (tarkov.dev)", "Objectives to check off (tarkov.dev)")}</div>
      <ul className="objectives">
        {task.objectives.map((o) => {
          const isDone = Boolean(p.done[o.id]);
          const cat = categoryOf(o.type);
          const spawns = o.locations.filter((l) => l.possible).length;
          return (
            <li key={o.id} className={`objective ${isDone ? "is-done" : ""}`}>
              <label className="objective-check">
                <input
                  type="checkbox"
                  checked={isDone}
                  disabled={Boolean(p.owner)}
                  onChange={(e) => p.onSetDone(o.id, e.target.checked)}
                  aria-label={isDone ? tr("Marquer comme non fait", "Mark as not done") : tr("Marquer comme fait", "Mark as done")}
                />
              </label>
              <div className="objective-body">
                <div className="objective-desc">
                  <span className="objective-icon" title={ICON_LABELS[cat]}>
                    <Icon id={cat} size={14} />
                  </span>
                  {o.description || <em className="muted">{tr("(sans description)", "(no description)")}</em>}
                  {o.optional && <span className="tag">{tr("optionnel", "optional")}</span>}
                </div>
                <ObjectiveItems objective={o} itemIcons={p.itemIcons} itemNames={p.itemNames} />
                {spawns > 1 && <div className="objective-note">{tr(`${spawns} emplacements possibles sur la carte`, `${spawns} possible locations on the map`)}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted small">{tr("Décocher un objectif fait réapparaître ses points sur la carte.", "Unchecking an objective makes its points reappear on the map.")}</p>
      <div className="btn-row">
        {checked > 0 && !p.owner && (
          <ConfirmButton
            label={tr("Réinitialiser cette quête", "Reset this quest")}
            question={tr(`Décocher ${checked} objectif${checked > 1 ? "s" : ""} ?`, `Uncheck ${checked} objective${checked > 1 ? "s" : ""}?`)}
            confirmLabel={tr("Oui", "Yes")}
            onConfirm={() => p.onReset(task)}
          />
        )}
        {task.wikiLink && (
          <button className="btn btn-small" onClick={() => p.onPhotos(task.id)}>
            <UiIcon id="image" /> Photos
          </button>
        )}
        {!p.owner && (!greyed || active) && (
          <button
            className={`btn btn-small${active ? " btn-primary" : ""}`}
            aria-pressed={active}
            onClick={() => (active ? p.onDeactivate(task) : p.onActivate(task))}
            title={tr("Activer : je fais cette quête", "Activate: I'm doing this quest")}
          >
            {active ? tr("✓ Active", "✓ Active") : tr("Activer", "Activate")}
          </button>
        )}
        {p.owner ? null : !greyed ? (
          <>
            <button className="btn btn-small btn-primary" onClick={() => p.onComplete(task)}>
              <UiIcon id="circle-check" /> {tr("Quête terminée", "Quest done")}
            </button>
            <button className="btn btn-small" onClick={() => p.onFail(task)}>
              {tr("Marquer échouée", "Mark as failed")}
            </button>
          </>
        ) : (
          <>
            <span className="tag quest-done-tag">
              {p.failed[task.id] && checked < task.objectives.length ? tr("✗ Échouée", "✗ Failed") : tr("✓ Terminée", "✓ Completed")}
            </span>
            <button className="btn btn-small" onClick={() => p.onReset(task)}>
              {tr("Dé-griser", "Un-grey")}
            </button>
          </>
        )}
      </div>

      <div className="wiki-status small">
        {wikiState.status === "loading" && <span className="muted">{tr("Chargement du wiki…", "Loading the wiki…")}</span>}
        {wikiState.status === "error" && (
          <span className="error">
            {tr(
              `Le wiki ne répond pas (${wikiState.error}). Les informations ci-dessous viennent seulement de tarkov.dev.`,
              `The wiki is not responding (${wikiState.error}). The information below comes only from tarkov.dev.`,
            )}
          </span>
        )}
        {wikiState.status === "ready" && !wiki && (
          <span className="muted">{tr("Pas de page de quête sur le wiki : seules les données tarkov.dev sont affichées.", "No quest page on the wiki: only tarkov.dev data is shown.")}</span>
        )}
        {wiki && (
          <span className="muted">
            {tr("Texte du wiki, en anglais :", "Wiki text, in English:")}{" "}
            <a href={wiki.pageUrl} target="_blank" rel="noreferrer">
              {wiki.pageTitle}
            </a>{" "}
            (Escape from Tarkov Wiki, CC BY-NC-SA).
          </span>
        )}
      </div>

      {QUEST_SECTIONS.map((s) => {
        const content = sections[s.id];
        if (!content) return null; // section sans données : masquée
        const title = s.id === "prereq" && prereq.warnings.length > 0 ? `${s.title} ⚠ ${tr("désaccord", "mismatch")}` : s.title;
        return (
          <Section key={`${task.id}:${s.id}`} title={title} open={s.open}>
            {content}
          </Section>
        );
      })}
    </div>
  );
}
