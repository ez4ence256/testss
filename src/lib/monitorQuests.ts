// Événements de quêtes du Monitor regroupés en UNE action (applyQuestStatus). Fonction pure : l'appelant dispatche.
// started -> sélection + prérequis grisés ; finished -> comme « terminer » (cases cochées, branches échouées) et prérequis
// grisés (The Punisher - Partie 6 terminée : parties 1 à 5 aussi) ; failed -> échouée.

import type { GameMode, Task } from "../types";
import type { MonitorEvent } from "../api/monitor";
import { branchFailures, isGreyed, prerequisiteChanges } from "./questChain";

type TaskEvent = Extract<MonitorEvent, { type: "task" }>;

export interface MonitorPlan {
  /** Arguments de applyQuestStatus ; undo = l'action inverse. */
  action: { done: string[]; failed: string[]; deselect: string[]; select: string[] } | null;
  undo: { done: string[]; undone: string[]; failed: string[]; unfailed: string[]; select: string[]; deselect: string[] } | null;
  counts: { started: number; finished: number; failed: number; prereq: number; branch: number; ignored: number };
}

export function planMonitorBatch(
  events: TaskEvent[],
  ctx: { gameMode: GameMode; tasks: Task[]; done: Record<string, number>; failed: Record<string, true>; selected: string[] },
): MonitorPlan {
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const sel = new Set(ctx.selected);
  const last = new Map<string, TaskEvent["status"]>(); // dernier statut par quête
  let ignored = 0;
  for (const e of events) {
    if (e.gameMode !== ctx.gameMode) ignored++;
    else if (byId.has(e.taskId)) last.set(e.taskId, e.status);
  }
  const ids = (status: TaskEvent["status"]) => [...last].filter(([, s]) => s === status).map(([id]) => id);
  const S = ids("started").filter((id) => !sel.has(id) && !isGreyed(byId.get(id)!, ctx.done, ctx.failed));
  const F = ids("finished");
  const ticks = new Set<string>();
  const tick = (id: string) => byId.get(id)!.objectives.forEach((o) => !ctx.done[o.id] && ticks.add(o.id));
  F.forEach(tick);
  const Fx = F.filter((id) => sel.has(id) || byId.get(id)!.objectives.some((o) => !ctx.done[o.id]));
  const X = ids("failed").filter((id) => !ctx.failed[id]);
  const branch = branchFailures(F, ctx.tasks, ctx.done, ctx.failed, new Set(F));
  const pc = new Set<string>();
  const pf = new Set<string>();
  for (const id of [...S, ...F]) {
    const c = prerequisiteChanges(id, ctx.tasks, ctx.done, ctx.failed);
    c.complete.forEach((r) => pc.add(r));
    c.failed.forEach((r) => pf.add(r));
  }
  for (const id of [...S, ...F, ...X, ...pc]) pf.delete(id);
  for (const id of [...S, ...F, ...X]) pc.delete(id);
  pc.forEach(tick);
  const newFail = [...new Set([...X, ...branch, ...pf])].filter((id) => !ctx.failed[id]);
  const startSet = new Set(S);
  const deselect = [...new Set([...F, ...X, ...branch, ...pc, ...pf])].filter((id) => sel.has(id) && !startSet.has(id));
  const counts = { started: S.length, finished: Fx.length, failed: X.length, prereq: pc.size + pf.size, branch: branch.length, ignored };
  if (!S.length && !ticks.size && !newFail.length && !deselect.length) return { action: null, undo: null, counts };
  const done = [...ticks];
  return {
    action: { done, failed: newFail, deselect, select: S },
    undo: { done: [], undone: done, failed: [], unfailed: newFail, select: deselect, deselect: S },
    counts,
  };
}
