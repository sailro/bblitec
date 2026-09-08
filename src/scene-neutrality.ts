/**
 * `scene -- neutrality <baseline>`: the cell-by-cell comparison the
 * neutrality proof asks for, as a command.
 *
 * `docs/development.md` prescribes the procedure — snapshot every
 * `report-differential.json`, run the matrix, compare cell by cell — and
 * a change to the compiler that is meant to be image-neutral either moves
 * a number or it does not. The command knows which movement is already
 * understood: some scenes are not bit-stable from run to run, and the
 * mover is multisampling rather than a backend — at one sample every one
 * of them is byte-identical across runs. Their wobbling cells are reported
 * as expected rather than as movement and the verdict ignores them; every
 * other moved cell is a finding.
 *
 * A scene earns a place in the table per backend and by measurement,
 * never by one surprising neutrality run: `scene -- stability <id>
 * --backend <b>` has to show the re-runs differing, and `--single-sample`
 * has to show them stop. What an entry costs is real: it excuses those
 * cells permanently, so a regression smaller than the wobble hides there.
 * The published `docs/status.md` cells of these scenes are likewise
 * exempt from the value check (`verify-status` prints them so the owner
 * can mark them); the severity colour is still checked, because a wobble
 * is one level, never a band.
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
 * | 14 | SDL_GPU | differ, worst MAD 0.000002, max 1 | byte-identical |
 * | 37 | Dawn | differ | byte-identical |
 * | 37 | SDL_GPU | differ, worst MAD 0.000059, max 1 | byte-identical |
 * | 44 | both | the 2000 ms drop is a wall-clock timer (TODO.md, physics): the collapse pose rolls 0.005--0.006 / 0.033--0.037 | n/a |
 * | 120 | Dawn | differ | byte-identical |
 * | 120 | SDL_GPU | differ, worst MAD 0.000250, max 2 | byte-identical |
 * | 121 | SDL_GPU | differ, worst MAD 0.000636, max 2 | byte-identical |
 * | 121 | Dawn | differ, worst MAD 0.000642, max 2 | byte-identical |
 * | 122 | Dawn | differ, worst MAD 0.000155, max 1 | byte-identical |
 * | 122 | SDL_GPU | differ, worst MAD 0.000274, max 1 | byte-identical |
 * | 123 | Dawn | differ, worst MAD 0.000856, max 1 | byte-identical |
 * | 123 | SDL_GPU | differ, worst MAD 0.000760, max 2 | byte-identical |
 * | 124 | SDL_GPU | differ, worst MAD 0.000042, max 1 | byte-identical |
 * | 124 | Dawn | differ, worst MAD 0.000146, max 1 | byte-identical |
 * | 125 | Dawn | differ, worst MAD 0.000001, max 1; serial differential runs span 2.8e-5..1.8e-4 | byte-identical |
 * | 125 | SDL_GPU | differ, worst MAD 0.000051, max 1 | byte-identical |
 * | 126 | Dawn | differ, worst MAD 0.001657, max 18 | byte-identical |
 * | 126 | SDL_GPU | differ, worst MAD 0.000081, max 2 | byte-identical |
 * | 128 | Dawn | differ, worst MAD 0.000035, max 1 | byte-identical |
 * | 128 | SDL_GPU | differ, worst MAD 0.000007, max 1 | byte-identical |
 * | 129 | Dawn | differ, worst MAD 0.000772, max 3 | byte-identical |
 * | 129 | SDL_GPU | differ, worst MAD 0.000118, max 2 | byte-identical |
 * | 226 | SDL_GPU | differ, worst MAD 0.000260, max 1 | byte-identical |
 * | 226 | Dawn | differ, worst MAD 0.000210, max 1 | byte-identical |
 * | 231 | SDL_GPU | differ, worst MAD 0.000005, max 1 | byte-identical |
 * | 231 | Dawn | differ under concurrent captures, worst MAD 0.000004, max 1 | byte-identical |
 * | 302 | Dawn | differ under mixed GPU load, worst MAD 0.000004, max 1 | byte-identical |
 * | 302 | SDL_GPU | differ under mixed GPU load, worst MAD 0.000012, max 1 | byte-identical |
 *
 * The wobble is per scene AND per backend, not a property of either
 * alone: scene 9 is measured bit-stable on SDL_GPU and scene 14 on Dawn.
 * The splat family (120-129, 226) shares one band, the per-pixel coverage
 * wobble averaged over each cloud's footprint: scene 123's 786,233 splats
 * cover 99.6% of the frame, scene 124's cloud a 59,973-px mask, and scene
 * 126's Dawn band is the family's widest at 1.7e-3 with max 18. Every band
 * sits at least an order of magnitude under the scene's thresholds.
 */
export const wobbleScenes: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["scene9", new Set(["dawn"])],
    ["scene14", new Set(["sdl_gpu"])],
    ["scene37", new Set(["dawn", "sdl_gpu"])],
    ["scene44", new Set(["dawn", "sdl_gpu"])],
    ["scene120", new Set(["dawn", "sdl_gpu"])],
    ["scene121", new Set(["dawn", "sdl_gpu"])],
    ["scene122", new Set(["dawn", "sdl_gpu"])],
    ["scene123", new Set(["dawn", "sdl_gpu"])],
    ["scene124", new Set(["dawn", "sdl_gpu"])],
    ["scene125", new Set(["dawn", "sdl_gpu"])],
    ["scene126", new Set(["dawn", "sdl_gpu"])],
    ["scene128", new Set(["dawn", "sdl_gpu"])],
    ["scene129", new Set(["dawn", "sdl_gpu"])],
    ["scene226", new Set(["dawn", "sdl_gpu"])],
    ["scene231", new Set(["dawn", "sdl_gpu"])],
    ["scene302", new Set(["dawn", "sdl_gpu"])],
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
function cellBackends(path: string): string[] {
    const backends: string[] = [];
    if (/sdl_?gpu/i.test(path)) backends.push("sdl_gpu");
    if (/dawn/i.test(path)) backends.push("dawn");
    return backends;
}

/**
 * Whether one cell's movement is the measured wobble rather than a finding.
 *
 * Both the neutrality run and the published-table check ask this, so they
 * ask it once: a predicate spelled twice is the same failure one level
 * down.
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
            if (!Number.isFinite(entry)) throw new Error(`Non-finite measurement: ${path}`);
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
            const report: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (typeof report !== "object" || report === null || Array.isArray(report)) {
                throw new Error("Expected a report object");
            }
            const measurements = cells(report);
            if (measurements.size === 0) throw new Error("Report has no numeric measurements");
            reports.set(scene, measurements);
        } catch (error) {
            throw new Error(`Cannot compare ${path}: ${String(error)}`);
        }
    }
    return reports;
}

/** The verdict of one neutrality comparison; `neutral` when no measured
 *  cell moved and every baseline scene was measured again. */
export interface NeutralityVerdict {
    neutral: boolean;
    unchanged: number;
    moved: string[];
    wobbled: string[];
    missing: string[];
}

export function runNeutralityReport(
    baselineDirectory: string,
): NeutralityVerdict {
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
        for (const path of new Set([...before.keys(), ...after.keys()])) {
            const previous = before.get(path);
            const value = after.get(path);
            if (previous === undefined || value === undefined) {
                differences.push(`    ${path}: measurement ${previous === undefined ? "added" : "missing"}`);
                continue;
            }
            if (previous === value) continue;
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
            "\nKnown run-to-run variation (per scene/backend; see wobbleScenes):",
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
    }
    const neutral = moved.length === 0 && missing.length === 0;
    if (neutral) console.log("\nNeutral: no measured cell moved.");
    return { neutral, unchanged, moved, wobbled, missing };
}
