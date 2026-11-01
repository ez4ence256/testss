import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { planMonitorBatch } from "./monitorQuests";

const ev = (taskId: string, status: "started" | "finished" | "failed", gameMode = "pve" as const) => ({ type: "task" as const, taskId, status, gameMode, at: 1 });
const task = (id: string, reqs: string[] = [], failedBy?: string[]) =>
  ({ id, name: id, objectives: [{ id: id + "o1" }, { id: id + "o2" }], failedBy, details: { taskRequirements: reqs.map((r) => ({ taskId: r, status: ["complete"] })) } }) as unknown as Task;
const tasks = [task("a"), task("b", ["a"]), task("c", [], ["b"]), task("d")];
const ctx = { gameMode: "pve" as const, tasks, done: {}, failed: {}, selected: [] as string[] };

describe("planMonitorBatch", () => {
  it("started : sélectionne et grise les prérequis", () => {
    const p = planMonitorBatch([ev("b", "started")], ctx);
    expect(p.action).toMatchObject({ select: ["b"], done: ["ao1", "ao2"] });
    expect(p.counts).toMatchObject({ started: 1, prereq: 1 });
    expect(p.undo?.undone).toEqual(["ao1", "ao2"]);
  });
  it("finished : coche, grise les prérequis, désélectionne et échoue les branches ; le dernier statut gagne", () => {
    const p = planMonitorBatch([ev("b", "started"), ev("b", "finished")], { ...ctx, selected: ["a", "b"] });
    expect(p.action).toEqual({ done: ["bo1", "bo2", "ao1", "ao2"], undone: [], failed: ["c"], unfailed: [], deselect: ["b", "a"], select: [] });
    expect(p.counts).toMatchObject({ finished: 1, prereq: 1 });
  });
  it("failed : marque échouée et désélectionne", () => {
    expect(planMonitorBatch([ev("d", "failed")], { ...ctx, selected: ["d"] }).action).toMatchObject({ failed: ["d"], deselect: ["d"] });
  });
  it("gros lot mixte d'une même chaîne : plan cohérent", () => {
    const chain = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d", ["c"], ["e"]), task("e"), task("f")];
    const p = planMonitorBatch(
      [ev("a", "started"), ev("a", "finished"), ev("b", "finished"), ev("c", "started"), ev("d", "started"), ev("e", "failed"), ev("f", "finished"), ev("zz", "finished")],
      { ...ctx, tasks: chain },
    );
    // a, b, f terminées ; c et d commencées ; e échouée ; zz inconnue
    expect(p.counts).toMatchObject({ finished: 3, failed: 1 });
    expect(p.action?.done).toEqual(expect.arrayContaining(["ao1", "ao2", "bo1", "bo2", "fo1", "fo2"]));
    expect(p.action?.failed).toContain("e");
    expect(p.action?.select).toContain("c");
    expect(new Set(p.action?.done).size).toBe(p.action?.done.length);
    expect(p.action?.select.filter((id) => p.action?.failed.includes(id))).toEqual([]);
  });
  it("reopen : une quête terminée ou ratée vue en cours est rouverte et resélectionnée (capture seulement)", () => {
    const greyed = { ...ctx, done: { ao1: 1, ao2: 1 }, failed: { d: true as const } };
    expect(planMonitorBatch([ev("a", "started"), ev("d", "started")], greyed).action).toBeNull();
    const p = planMonitorBatch([ev("a", "started"), ev("d", "started")], { ...greyed, reopen: true });
    expect(p.action).toMatchObject({ undone: ["ao1", "ao2"], unfailed: ["d"], select: ["a", "d"] });
    expect(p.undo).toMatchObject({ done: ["ao1", "ao2"], failed: ["d"], deselect: ["a", "d"] });
    expect(p.counts).toMatchObject({ started: 0, reopened: 2 });
  });
  it("ignore autre mode et quêtes inconnues", () => {
    const p = planMonitorBatch([ev("d", "started", "regular" as never), ev("zz", "started")], ctx);
    expect(p.action).toBeNull();
    expect(p.counts.ignored).toBe(1);
  });
});
