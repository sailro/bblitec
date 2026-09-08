/**
 * The one JSON report writer the scene tools share, and the reader that
 * pairs with it.
 *
 * Every report carries the same provenance: which tool wrote it, for
 * which backend, from which generated tree, and when. Fields are added,
 * never renamed — existing readers parse by key — and every added field
 * is a string, because `scene -- neutrality` flattens the numeric leaves
 * of these reports and a numeric timestamp would register as a moved
 * cell. Payload keys win a collision so a report's own fields never
 * change.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeBuildStamp } from "../build-stamp.js";

export interface ReportMeta {
    tool: string;
    backend?: string;
    generatedDirectory?: string;
}

/** The provenance every report written here carries. */
export interface ReportProvenance {
    tool: string;
    backend?: string;
    generatedStamp?: string;
    writtenAt: string;
}

export function writeReport(
    path: string,
    meta: ReportMeta,
    payload: object,
    indent = 2,
): void {
    const generatedStamp = ((): string | undefined => {
        if (!meta.generatedDirectory) return undefined;
        try {
            return computeBuildStamp(meta.generatedDirectory).stamp;
        } catch {
            return undefined;
        }
    })();
    writeFileSync(
        path,
        `${JSON.stringify(
            {
                tool: meta.tool,
                ...(meta.backend !== undefined
                    ? { backend: meta.backend }
                    : {}),
                ...(generatedStamp !== undefined
                    ? { generatedStamp }
                    : {}),
                writtenAt: new Date().toISOString(),
                ...payload,
            },
            null,
            indent,
        )}\n`,
    );
}

/**
 * A report written by `writeReport`, or `undefined` when there is none
 * or it does not parse. The caller narrows the payload; the provenance
 * fields are the only ones this reader vouches for.
 */
export function readReport<T extends object>(
    path: string,
): (ReportProvenance & T) | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
            typeof value !== "object" ||
            value === null ||
            typeof (value as { tool?: unknown }).tool !== "string"
        ) {
            return undefined;
        }
        return value as ReportProvenance & T;
    } catch {
        return undefined;
    }
}
