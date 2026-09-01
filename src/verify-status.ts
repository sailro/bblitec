#!/usr/bin/env node

// Check the published parity table against the reports the matrix wrote.
//
// `docs/status.md` carries two measured columns per scene, but a number
// only changes when someone edits the table by hand, so a row can keep
// claiming a value the code no longer produces -- scenes 248 and 249 did
// exactly that until a full differential run caught them. This turns the
// table into data the pipeline checks rather than prose it trusts.
//
// The severity colour is checked with the value, because a row that
// improves past a band boundary is as wrong when it keeps the old colour
// as when it keeps the old number.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
    DifferentialReportSummary,
    ParityReportSummary,
} from "./parity-scene.js";
import { isWobblingCell } from "./scene-neutrality.js";

export interface PublishedRow {
    sceneId: string;
    line: number;
    values: string[];
    colors: string[];
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
        rows.push({
            sceneId,
            line: index + 1,
            colors,
            values,
        });
    }
    return rows;
}

/**
 * The curated table reads in scene order, and a row inserted in the wrong
 * place is the mistake this catches. It is invisible in review — 137 rows
 * of identical shape, and the diff of an integration shows only the row
 * being added — but the number is how a reader finds a scene, so a stray
 * one costs every later lookup. The project-owned gates below the curated
 * table carry names rather than numbers and keep their own order.
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

function measured(
    sceneId: string,
): { values: number[]; source: string } | undefined {
    const differentialPath = resolve(
        "artifacts/parity",
        sceneId,
        "report-differential.json",
    );
    const gpuSinglePath = resolve(
        "artifacts/parity",
        sceneId,
        "report-gpu.json",
    );
    const dawnSinglePath = resolve(
        "artifacts/parity",
        sceneId,
        "report-dawn.json",
    );
    // A differential report is preferred only while it is at least as fresh
    // as the single-backend reports: a fresh single-backend rerun must not
    // be shadowed by a stale differential from an earlier sweep.
    const mtime = (path: string): number =>
        existsSync(path) ? statSync(path).mtimeMs : -1;
    const singlesFresh =
        existsSync(gpuSinglePath) &&
        existsSync(dawnSinglePath) &&
        Math.max(mtime(gpuSinglePath), mtime(dawnSinglePath)) >
            mtime(differentialPath);
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
    const gpuPath = resolve(
        "artifacts/parity",
        sceneId,
        "report-gpu.json",
    );
    const dawnPath = resolve(
        "artifacts/parity",
        sceneId,
        "report-dawn.json",
    );
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

export function verifyStatus(statusPath = "docs/status.md"): string[] {
    const problems: string[] = [];
    const rows = parsePublishedRows(
        readFileSync(statusPath, "utf8"),
    );
    if (rows.length === 0) {
        problems.push(
            `${statusPath}: no measured rows found; the table format changed.`,
        );
        return problems;
    }
    problems.push(...outOfOrderRows(rows, statusPath));
    const columns = [
        "SDL_GPU full",
        "SDL_GPU foreground",
        "Dawn full",
        "Dawn foreground",
    ];
    for (const row of rows) {
        const result = measured(row.sceneId);
        if (!result) {
            problems.push(
                `${statusPath}:${row.line} ${row.sceneId}: no parity report; run 'npm run scenes:parity' before verifying.`,
            );
            continue;
        }
        // Scenes 9, 37, 120, 125, 126, 128 and 129 are not bit-stable between runs at
        // 4x, by pixels of one level each, which is enough to move the
        // third decimal across a rounding boundary -- scene 126's Dawn
        // foreground alternates between 0.001 and 0.005. `scene -- neutrality`
        // already excludes those cells, per backend; repainting the table
        // per run would publish whichever side of the coin the last matrix
        // landed on, so the value is not compared there. The severity colour
        // still is: the wobble is one level, never a band.
        const wobblingCell = (index: number): boolean =>
            isWobblingCell(row.sceneId, columns[index]!);
        result.values.forEach((value, index) => {
            const rendered = value.toFixed(3);
            if (
                rendered !== row.values[index] &&
                !wobblingCell(index)
            ) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} ${columns[index]}: published ${row.values[index]}, measured ${rendered}`,
                );
            }
            const color = severityColor(value);
            if (color !== row.colors[index]) {
                problems.push(
                    `${statusPath}:${row.line} ${row.sceneId} ${columns[index]}: severity colour ${row.colors[index]} does not match ${rendered}`,
                );
            }
        });
    }
    return problems;
}

function main(): void {
    const problems = verifyStatus();
    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error(
            `\n${problems.length} published value(s) disagree with the measured reports.`,
        );
        process.exitCode = 1;
        return;
    }
    console.log(
        "docs/status.md matches every measured parity report.",
    );
}

if (
    process.argv[1] &&
    import.meta.url ===
        new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
    main();
}
