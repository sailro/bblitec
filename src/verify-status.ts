#!/usr/bin/env node

// Check the published parity table against the reports the matrix wrote.
//
// `docs/status.md` carries two measured columns per scene, a coverage
// cell, and for the UI-dominated applications a canvas-only pair. A
// number only changes when someone edits the table by hand, so a row can
// keep claiming a value the code does not produce. This turns the table
// into data the pipeline checks rather than prose it trusts:
//
//   * every measured cell against the newest parity report, except the
//     cells of the scenes `scene-neutrality.ts` measures as wobbling —
//     those are printed with their newest value instead, so the owner can
//     mark them, and only their severity colour is checked (the wobble is
//     one level, never a band);
//   * every numbered row's coverage cell against the registry `name`,
//     which is how a reader finds a scene; a cell may carry commentary
//     after the name, separated by `;` or `.`;
//   * every published "canvas-only MAD" pair against the canvas lane's
//     own report (`artifacts/parity-canvas/<id>/report-canvas.json`).
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
    DifferentialReportSummary,
    ParityReportSummary,
} from "./parity-scene.js";
import { isWobblingCell } from "./scene-neutrality.js";
import { scenes } from "./scene-registry.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { parityCanvasReportPath } from "./tooling/artifacts.js";
import { readReport } from "./tooling/reports.js";

export interface PublishedRow {
    sceneId: string;
    line: number;
    values: string[];
    colors: string[];
    /** The coverage cell, verbatim. */
    coverage: string;
    /** The published canvas-only pair per backend, when the cell carries one. */
    canvas?: Record<"sdl_gpu" | "dawn", [string, string]>;
}

const GREEN = "#1a7f37";
const YELLOW = "#9a6700";
const RED = "#cf222e";

/** The severity bands documented above the table. */
export function severityColor(value: number): string {
    if (value >= 1) return RED;
    if (value >= 0.5) return YELLOW;
    return GREEN;
}

/**
 * The canvas-only pair a coverage cell publishes, in either of the two
 * forms the table uses: one pair per backend, or one pair "on both
 * backends".
 */
export function parseCanvasCell(
    coverage: string,
): PublishedRow["canvas"] | undefined {
    const perBackend =
        /canvas-only MAD: SDL_GPU ([0-9.]+) \/ ([0-9.]+), Dawn ([0-9.]+) \/ ([0-9.]+)/.exec(
            coverage,
        );
    if (perBackend) {
        return {
            sdl_gpu: [perBackend[1]!, perBackend[2]!],
            dawn: [perBackend[3]!, perBackend[4]!],
        };
    }
    const both = /canvas-only MAD: ([0-9.]+) \/ ([0-9.]+) on both backends/.exec(
        coverage,
    );
    if (both) {
        const pair: [string, string] = [both[1]!, both[2]!];
        return { sdl_gpu: pair, dawn: pair };
    }
    return undefined;
}

export function parsePublishedRows(
    status: string,
): PublishedRow[] {
    const rows: PublishedRow[] = [];
    const lines = status.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line.startsWith("|")) continue;
        const sceneId = /images\/scenes\/([A-Za-z0-9-]+)\.png/.exec(
            line,
        )?.[1];
        if (!sceneId) continue;
        // Two cell forms: a value in the green band prints plain, and a
        // cell holding any yellow/red value keeps the colored math span.
        // (GitHub stops rendering math expressions after a few hundred
        // per page, so the table cannot colour its default state.)
        const colors: string[] = [];
        const values: string[] = [];
        for (const cell of line.matchAll(
            /\| (?:([0-9.]+) \/ ([0-9.]+)|\$\\color\{(#[0-9a-f]{6})\}\{\\textsf\{([0-9.]+)\}\} \/ \\color\{(#[0-9a-f]{6})\}\{\\textsf\{([0-9.]+)\}\}\$)(?= \|)/g,
        )) {
            if (cell[1] !== undefined) {
                colors.push(GREEN, GREEN);
                values.push(cell[1]!, cell[2]!);
            } else {
                colors.push(cell[3]!, cell[5]!);
                values.push(cell[4]!, cell[6]!);
            }
        }
        if (values.length !== 4) continue;
        const cells = line.split("|").map((cell) => cell.trim());
        const coverage = cells[cells.length - 2] ?? "";
        const canvas = parseCanvasCell(coverage);
        rows.push({
            sceneId,
            line: index + 1,
            colors,
            values,
            coverage,
            ...(canvas !== undefined ? { canvas } : {}),
        });
    }
    return rows;
}

/**
 * The curated table reads in scene order, and a row inserted in the wrong
 * place is the mistake this catches. It is invisible in review — hundreds
 * of rows of identical shape, and the diff of an integration shows only
 * the row being added — but the number is how a reader finds a scene, so
 * a stray one costs every later lookup. The project-owned gates below the
 * curated table carry names rather than numbers and keep their own order.
 */
export function outOfOrderRows(
    rows: readonly PublishedRow[],
    statusPath = "docs/status.md",
): string[] {
    const problems: string[] = [];
    const numbered = rows.flatMap((row) => {
        const id = /^scene([0-9]+)$/.exec(row.sceneId)?.[1];
        return id === undefined
            ? []
            : [{ row, id: Number(id) }];
    });
    for (let index = 1; index < numbered.length; index++) {
        const previous = numbered[index - 1]!;
        const current = numbered[index]!;
        if (current.id === previous.id) {
            problems.push(
                `${statusPath}:${current.row.line} scene ${current.id} is published twice.`,
            );
        } else if (current.id < previous.id) {
            problems.push(
                `${statusPath}:${current.row.line} scene ${current.id} is published after scene ${previous.id}; the curated table reads in scene order.`,
            );
        }
    }
    return problems;
}

/** The registry name a numbered row's coverage cell is derived from:
 *  the entry's `name` without its `Scene N - ` prefix. */
export function expectedCoverage(name: string): string {
    return name.replace(/^Scene [0-9]+ - /, "");
}

/**
 * Whether a numbered row's coverage cell carries the registry name: the
 * name itself, or the name followed by `;` or `.` and commentary.
 */
export function coverageMatches(cell: string, name: string): boolean {
    const expected = expectedCoverage(name);
    return (
        cell === expected ||
        cell.startsWith(`${expected};`) ||
        cell.startsWith(`${expected}.`)
    );
}

/**
 * The numbered rows whose coverage cell does not carry the registry
 * name, with the text the cell should start with.
 */
export function coverageProblems(
    rows: readonly PublishedRow[],
    statusPath = "docs/status.md",
    registry: ReadonlyMap<string, string> = new Map(
        scenes.map((scene) => [scene.id, scene.name]),
    ),
): string[] {
    const problems: string[] = [];
    for (const row of rows) {
        if (!/^scene[0-9]+$/.test(row.sceneId)) continue;
        const name = registry.get(row.sceneId);
        if (name === undefined) continue;
        if (!coverageMatches(row.coverage, name)) {
            problems.push(
                `${statusPath}:${row.line} ${row.sceneId} coverage: published '${row.coverage}', registry name '${expectedCoverage(name)}' (the cell must be the name, or the name followed by ';' or '.' and commentary)`,
            );
        }
    }
    return problems;
}

function measured(
    parityRoot: string,
    sceneId: string,
): { values: number[]; source: string } | undefined {
    const differentialPath = resolve(
        parityRoot,
        sceneId,
        "report-differential.json",
    );
    const gpuPath = resolve(parityRoot, sceneId, "report-gpu.json");
    const dawnPath = resolve(parityRoot, sceneId, "report-dawn.json");
    // A differential report is preferred only while it is at least as fresh
    // as the single-backend reports: a fresh single-backend rerun must not
    // be shadowed by a stale differential from an earlier sweep.
    const mtime = (path: string): number =>
        existsSync(path) ? statSync(path).mtimeMs : -1;
    const singlesFresh =
        existsSync(gpuPath) &&
        existsSync(dawnPath) &&
        Math.max(mtime(gpuPath), mtime(dawnPath)) > mtime(differentialPath);
    if (existsSync(differentialPath) && !singlesFresh) {
        const report = JSON.parse(
            readFileSync(differentialPath, "utf8"),
        ) as DifferentialReportSummary;
        return {
            source: differentialPath,
            values: [
                report.goldenVersusSdlGpu.fullMad,
                report.goldenVersusSdlGpu.foregroundMad,
                report.goldenVersusDawn.fullMad,
                report.goldenVersusDawn.foregroundMad,
            ],
        };
    }
    // Without a differential report the two columns come from the two
    // single-backend runs, and a missing Dawn report is a gap rather than
    // a pass: the column is published, so it has to be measured.
    if (!existsSync(gpuPath) || !existsSync(dawnPath)) {
        return undefined;
    }
    const gpu = JSON.parse(
        readFileSync(gpuPath, "utf8"),
    ) as ParityReportSummary;
    const dawn = JSON.parse(
        readFileSync(dawnPath, "utf8"),
    ) as ParityReportSummary;
    return {
        source: `${gpuPath} + ${dawnPath}`,
        values: [
            gpu.full.mad,
            gpu.region.mad,
            dawn.full.mad,
            dawn.region.mad,
        ],
    };
}

/** The canvas lane's report shape, per backend. */
interface CanvasReport {
    backends?: Record<string, { fullMad?: number; foregroundMad?: number }>;
}

/**
 * The published canvas-only pairs against the canvas lane's own report.
 */
export function canvasProblems(
    rows: readonly PublishedRow[],
    canvasRoot: string,
    statusPath = "docs/status.md",
): string[] {
    const problems: string[] = [];
    for (const row of rows) {
        if (row.canvas === undefined) continue;
        const reportPath = parityCanvasReportPath(
            resolve(canvasRoot, row.sceneId),
        );
        const report = readReport<CanvasReport>(reportPath);
        if (report === undefined) {
            problems.push(
                `${statusPath}:${row.line} ${row.sceneId} canvas-only: no canvas report at ${reportPath}; run 'scene -- parity ${row.sceneId} --differential' before verifying.`,
            );
            continue;
        }
        for (const backend of ["sdl_gpu", "dawn"] as const) {
            const label = backend === "dawn" ? "Dawn" : "SDL_GPU";
            const measuredPair = report.backends?.[backend];
            if (
                measuredPair?.fullMad === undefined ||
                measuredPair.foregroundMad === undefined
            ) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} canvas-only ${label}: the canvas report carries no ${backend} measurement.`,
                );
                continue;
            }
            const rendered: [string, string] = [
                measuredPair.fullMad.toFixed(3),
                measuredPair.foregroundMad.toFixed(3),
            ];
            const published = row.canvas[backend];
            if (
                rendered[0] !== published[0] ||
                rendered[1] !== published[1]
            ) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} canvas-only ${label}: published ${published.join(" / ")}, measured ${rendered.join(" / ")}`,
                );
            }
        }
    }
    return problems;
}

export interface VerifyStatusOptions {
    statusPath?: string;
    /** The parity reports root (`artifacts/parity`). */
    parityRoot?: string;
    /** The canvas lane root (`artifacts/parity-canvas`). */
    canvasRoot?: string;
}

export interface StatusVerdict {
    problems: string[];
    /**
     * The wobble-exempt cells, one line each with the published and the
     * newest measured value, so the owner can mark them in the table.
     */
    exempt: string[];
}

export function verifyStatus(
    options: VerifyStatusOptions = {},
): StatusVerdict {
    const statusPath = options.statusPath ?? "docs/status.md";
    const parityRoot = options.parityRoot ?? "artifacts/parity";
    const canvasRoot = options.canvasRoot ?? "artifacts/parity-canvas";
    const problems: string[] = [];
    const exempt: string[] = [];
    const rows = parsePublishedRows(
        readFileSync(statusPath, "utf8"),
    );
    if (rows.length === 0) {
        problems.push(
            `${statusPath}: no measured rows found; the table format changed.`,
        );
        return { problems, exempt };
    }
    problems.push(...outOfOrderRows(rows, statusPath));
    problems.push(...coverageProblems(rows, statusPath));
    problems.push(...canvasProblems(rows, canvasRoot, statusPath));
    const columns = [
        "SDL_GPU full",
        "SDL_GPU foreground",
        "Dawn full",
        "Dawn foreground",
    ];
    for (const row of rows) {
        const result = measured(parityRoot, row.sceneId);
        if (!result) {
            problems.push(
                `${statusPath}:${row.line} ${row.sceneId}: no parity report; run 'npm run scenes:parity' before verifying.`,
            );
            continue;
        }
        result.values.forEach((value, index) => {
            const rendered = value.toFixed(3);
            const column = columns[index]!;
            if (isWobblingCell(row.sceneId, column)) {
                exempt.push(
                    `${statusPath}:${row.line} ${row.sceneId} ${column}: wobble-exempt, published ${row.values[index]}, newest ${rendered}` +
                        (rendered !== row.values[index] ? " (differs)" : ""),
                );
            } else if (rendered !== row.values[index]) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} ${column}: published ${row.values[index]}, measured ${rendered}`,
                );
            }
            const color = severityColor(value);
            if (color !== row.colors[index]) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} ${column}: severity colour ${row.colors[index]} does not match ${rendered}`,
                );
            }
        });
    }
    return { problems, exempt };
}

function main(): void {
    const parsed = parseFlags(
        process.argv.slice(2),
        { value: ["--status", "--artifacts", "--canvas"] },
        "verify-status",
    );
    const artifacts = parsed.values.get("--artifacts");
    const status = parsed.values.get("--status");
    const canvas = parsed.values.get("--canvas");
    const { problems, exempt } = verifyStatus({
        ...(status !== undefined ? { statusPath: status } : {}),
        ...(artifacts !== undefined
            ? {
                  parityRoot: resolve(artifacts, "parity"),
                  canvasRoot: resolve(canvas ?? resolve(artifacts, "parity-canvas")),
              }
            : canvas !== undefined
              ? { canvasRoot: canvas }
              : {}),
    });
    if (exempt.length > 0) {
        console.log(
            `${exempt.length} wobble-exempt cell(s) (value not compared; see scene-neutrality.ts):`,
        );
        for (const line of exempt) console.log(`  ${line}`);
    }
    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error(
            `\n${problems.length} published value(s) disagree with the measured reports or the registry.`,
        );
        process.exitCode = 1;
        return;
    }
    console.log(
        "docs/status.md matches every measured parity report and the registry.",
    );
}

if (isMainModule(import.meta.url)) {
    main();
}
