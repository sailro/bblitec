/**
 * `scene -- neutrality <baseline>`: the cell-by-cell comparison the
 * neutrality proof asks for, as a command.
 *
 * `docs/development.md` prescribes the procedure — snapshot every
 * `report-differential.json`, run the matrix, compare cell by cell — and that
 * is exactly right, because a change to the compiler that is meant to be
 * image-neutral either moves a number or it does not. What it did not have
 * was a command, so the comparison kept being retyped as a throwaway script,
 * and a throwaway script does not know which movement is already understood.
 *
 * This one does. Scenes 9 and 37 are not bit-stable on Dawn from run to run
 * (see the TODO entry: SDL_GPU and single-sampled Dawn both are, only 4x Dawn
 * is not), so their Dawn cells are reported as expected wobble rather than as
 * movement, and the exit status ignores them. Every other moved cell is a
 * finding.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Scenes whose Dawn cells move between runs with no code change at all. */
export const dawnWobbleScenes = new Set(["scene9", "scene37"]);

/** A cell that names a Dawn measurement, which is the wobbling half. */
export const isDawnCell = (path: string): boolean => /dawn/i.test(path);

type Json = Record<string, unknown>;

/** Every numeric leaf of a report, by dotted path. */
function cells(value: unknown, prefix = ""): Map<string, number> {
    const flat = new Map<string, number>();
    if (typeof value !== "object" || value === null) return flat;
    for (const [key, entry] of Object.entries(value as Json)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof entry === "number") {
            flat.set(path, entry);
        } else if (typeof entry === "object" && entry !== null) {
            for (const [nested, number] of cells(entry, path)) {
                flat.set(nested, number);
            }
        }
    }
    return flat;
}

function reportsIn(directory: string): Map<string, Map<string, number>> {
    const reports = new Map<string, Map<string, number>>();
    if (!existsSync(directory)) return reports;
    for (const scene of readdirSync(directory)) {
        const path = join(directory, scene, "report-differential.json");
        if (!existsSync(path)) continue;
        try {
            reports.set(
                scene,
                cells(JSON.parse(readFileSync(path, "utf8")) as unknown),
            );
        } catch {
            // A half-written report from an interrupted run is not a finding.
        }
    }
    return reports;
}

export function runNeutralityReport(baselineDirectory: string): void {
    const baseline = reportsIn(baselineDirectory);
    const current = reportsIn(join("artifacts", "parity"));
    if (baseline.size === 0) {
        throw new Error(
            `No differential reports under ${baselineDirectory}. Snapshot ` +
                "artifacts/parity before the change, then run the matrix.",
        );
    }

    let unchanged = 0;
    const moved: string[] = [];
    const wobbled: string[] = [];
    const missing: string[] = [];

    for (const [scene, before] of baseline) {
        const after = current.get(scene);
        if (!after) {
            missing.push(scene);
            continue;
        }
        const differences: string[] = [];
        let expected = 0;
        for (const [path, value] of after) {
            const previous = before.get(path);
            if (previous === undefined || previous === value) continue;
            if (dawnWobbleScenes.has(scene) && isDawnCell(path)) {
                expected++;
                continue;
            }
            differences.push(
                `    ${path}: ${previous} -> ${value}`,
            );
        }
        if (differences.length > 0) {
            moved.push(`  ${scene}\n${differences.join("\n")}`);
        } else if (expected > 0) {
            wobbled.push(`  ${scene}: ${expected} Dawn cell(s), known wobble`);
        } else {
            unchanged++;
        }
    }

    console.log(
        `${unchanged} scene(s) bit-identical across every cell, ` +
            `${moved.length} moved.`,
    );
    if (wobbled.length > 0) {
        console.log(
            "\nExpected Dawn wobble (not a regression — scenes 9 and 37 are " +
                "not bit-stable on Dawn between runs):",
        );
        for (const line of wobbled) console.log(line);
    }
    if (missing.length > 0) {
        console.log(
            `\nIn the baseline but not measured now: ${missing.join(", ")}`,
        );
    }
    if (moved.length > 0) {
        console.log("\nMoved:");
        for (const line of moved) console.log(line);
        console.log(
            "\nA change meant to be image-neutral moved a measured cell. " +
                "Re-run the matrix before concluding — but if it moves again, " +
                "it is not neutral.",
        );
        process.exitCode = 1;
        return;
    }
    console.log("\nNeutral: no measured cell moved.");
}
