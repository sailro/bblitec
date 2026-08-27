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
 * This one does. Three scenes are not bit-stable from run to run, and the
 * mover is multisampling rather than a backend: at one sample every one of
 * them is byte-identical across runs. Their wobbling cells are reported as
 * expected rather than as movement and the exit status ignores them; every
 * other moved cell is a finding.
 *
 * A scene earns a place here per backend and by measurement, never by one
 * surprising neutrality run: `scene -- stability <id> --backend <b>` has to
 * show the re-runs differing, and `--single-sample` has to show them stop.
 * The table below is that pair for each entry. What it costs is real -- an
 * entry excuses those cells permanently, and scene 120's Dawn foreground
 * sits at 0.004 with the wobble spanning 0.002, so a regression smaller than
 * the wobble would hide here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The backends whose cells move between runs with no code change at all,
 * per scene, each measured with `stability` at 4x and again at one sample.
 *
 * | Scene | Backend | 4x re-runs vs run 1 | at one sample |
 * | --- | --- | --- | --- |
 * | 9 | Dawn | differ | byte-identical |
 * | 37 | Dawn | differ | byte-identical |
 * | 37 | SDL_GPU | differ, worst MAD 0.000059, max 1 | byte-identical |
 * | 120 | Dawn | differ | byte-identical |
 * | 120 | SDL_GPU | differ, worst MAD 0.000250, max 2 | byte-identical |
 * | 126 | Dawn | differ, worst MAD 0.001657, max 18 | byte-identical |
 * | 126 | SDL_GPU | differ, worst MAD 0.000081, max 2 | byte-identical |
 *
 * Scene 9 is measured bit-stable on SDL_GPU across four runs and is
 * deliberately absent from that column: the wobble is per scene AND per
 * backend, not a property of either alone.
 */
export const wobbleScenes: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["scene9", new Set(["dawn"])],
    ["scene37", new Set(["dawn", "sdl_gpu"])],
    ["scene120", new Set(["dawn", "sdl_gpu"])],
    ["scene126", new Set(["dawn", "sdl_gpu"])],
]);

/**
 * The backends a cell's measurement involves.
 *
 * Takes both spellings the two callers hold: a report's dotted path
 * (`goldenVersusSdlGpu`, `sdlGpuVersusDawn`) and the published table's own
 * column label (`SDL_GPU full`). `sdlGpuVersusDawn` names both backends and
 * its value moves when EITHER side does, so one wobbling backend excuses it;
 * scene 9 is the case -- its Dawn side wobbles, its SDL_GPU side is measured
 * bit-stable, and the cross-backend cell moves anyway. Nothing is lost by
 * excusing it, because that scene's own `goldenVersusSdlGpu` cells stay
 * compared and are where an SDL_GPU regression would show.
 */
export function cellBackends(path: string): string[] {
    const backends: string[] = [];
    if (/sdl_?gpu/i.test(path)) backends.push("sdl_gpu");
    if (/dawn/i.test(path)) backends.push("dawn");
    return backends;
}

/**
 * Whether one cell's movement is the measured wobble rather than a finding.
 *
 * Both the neutrality run and the published-table check ask this, so they ask
 * it once: this module exists because the comparison kept being retyped, and
 * a predicate spelled twice is the same failure one level down.
 */
export function isWobblingCell(scene: string, path: string): boolean {
    const wobbling = wobbleScenes.get(scene);
    if (!wobbling) return false;
    return cellBackends(path).some((backend) => wobbling.has(backend));
}

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
            `No differential reports under ${baselineDirectory}. The ` +
                "comparison covers report-differential.json only — a " +
                "single-backend sweep produces nothing comparable, so run " +
                "the matrix with 'scene -- parity all --differential'. " +
                "Snapshot artifacts/parity before the change, then run it again after.",
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
            if (isWobblingCell(scene, path)) {
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
            wobbled.push(
                `  ${scene}: ${expected} cell(s) on ${
                    [...(wobbleScenes.get(scene) ?? [])].join(", ")
                }, known wobble`,
            );
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
            "\nExpected multisampling wobble (not a regression — scenes" +
                " 9, 37, 120 and 126 are not bit-stable between runs at 4x;" +
                " every one is byte-identical at a single sample):",
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
