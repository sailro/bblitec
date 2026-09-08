/**
 * Readers over what generation writes per scene, for `scene -- show
 * <id> --activation|--adaptations|--provenance` and `scene -- status
 * <id>`: the feature census (`upstream/feature-activation.json`), the
 * adaptation record (`fidelity.json`), the lowered pinned symbols
 * (`upstream/provenance.json`), and the build identity the tree, the
 * deployed payload and the binary carry.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    comparePayload,
    computeBuildStamp,
    deployedPayloads,
    readCacheConfiguration,
} from "../build-stamp.js";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string, what: string, sceneId: string): unknown {
    if (!existsSync(path)) {
        throw new Error(
            `${what} for ${sceneId} does not exist (${path}); run 'scene -- compile ${sceneId}' first.`,
        );
    }
    return JSON.parse(readFileSync(path, "utf8"));
}

const text = (value: unknown): string =>
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);

export interface FeatureActivationRow {
    name: string;
    mechanism: string;
    active: boolean;
    activatedBy: string;
    consumers: string[];
    upstreamProvenance: string;
}

/** The feature census rows, active first. */
export function readFeatureActivation(
    outputDirectory: string,
    sceneId: string,
): FeatureActivationRow[] {
    const value = readJsonFile(
        resolve(outputDirectory, "upstream", "feature-activation.json"),
        "The feature activation census",
        sceneId,
    );
    if (!Array.isArray(value)) throw new Error("feature-activation.json is not an array");
    return value.map((entry): FeatureActivationRow => {
        if (!isRecord(entry)) throw new Error("feature-activation.json holds a non-object row");
        return {
            name: text(entry.name),
            mechanism: text(entry.mechanism),
            active: entry.active === true,
            activatedBy: text(entry.activatedBy),
            consumers: Array.isArray(entry.consumers) ? entry.consumers.map(text) : [],
            upstreamProvenance: text(entry.upstreamProvenance),
        };
    });
}

export function formatFeatureActivation(rows: readonly FeatureActivationRow[]): string {
    const active = rows.filter((row) => row.active);
    const lines = [
        `${active.length} of ${rows.length} feature(s) active:`,
        ...active.map(
            (row) =>
                `  ${row.name} [${row.mechanism}] <- ${row.activatedBy}` +
                (row.consumers.length > 0 ? ` -> ${row.consumers.join(", ")}` : "") +
                (row.upstreamProvenance ? `\n      pin: ${row.upstreamProvenance}` : ""),
        ),
    ];
    const refused = rows.filter((row) => !row.active && row.activatedBy !== "not reached");
    if (refused.length > 0) {
        lines.push(`${refused.length} inactive feature(s) with a stated reason:`);
        for (const row of refused) lines.push(`  ${row.name}: ${row.activatedBy}`);
    }
    return lines.join("\n");
}

export interface AdaptationRow {
    id: string;
    category: string;
    risk: string;
    sourceSemantics: string;
    nativeSemantics: string;
    validation: string[];
}

export function readAdaptations(
    outputDirectory: string,
    sceneId: string,
): AdaptationRow[] {
    const value = readJsonFile(
        resolve(outputDirectory, "fidelity.json"),
        "The adaptation record",
        sceneId,
    );
    if (!isRecord(value) || !Array.isArray(value.adaptations)) {
        throw new Error("fidelity.json carries no adaptations array");
    }
    return value.adaptations.map((entry): AdaptationRow => {
        if (!isRecord(entry)) throw new Error("fidelity.json holds a non-object adaptation");
        return {
            id: text(entry.id),
            category: text(entry.category),
            risk: text(entry.risk),
            sourceSemantics: text(entry.sourceSemantics),
            nativeSemantics: text(entry.nativeSemantics),
            validation: Array.isArray(entry.validation) ? entry.validation.map(text) : [],
        };
    });
}

export function formatAdaptations(rows: readonly AdaptationRow[]): string {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const sorted = [...rows].sort(
        (left, right) => (order[left.risk] ?? 3) - (order[right.risk] ?? 3),
    );
    return [
        `${rows.length} adaptation(s), by risk:`,
        ...sorted.map(
            (row) =>
                `  [${row.risk}] ${row.id} (${row.category})\n` +
                `      source: ${row.sourceSemantics}\n` +
                `      native: ${row.nativeSemantics}` +
                (row.validation.length > 0 ? `\n      validated by: ${row.validation.join("; ")}` : ""),
        ),
    ].join("\n");
}

export interface ProvenanceReport {
    package: { package: string; version: string; sourceVersion: string };
    generated: Array<{ modulePath: string; symbolName: string }>;
}

export function readProvenance(
    outputDirectory: string,
    sceneId: string,
): ProvenanceReport {
    const value = readJsonFile(
        resolve(outputDirectory, "upstream", "provenance.json"),
        "The pinned-symbol provenance",
        sceneId,
    );
    if (!isRecord(value) || !isRecord(value.package) || !Array.isArray(value.generated)) {
        throw new Error("provenance.json carries no package/generated fields");
    }
    return {
        package: {
            package: text(value.package.package),
            version: text(value.package.version),
            sourceVersion: text(value.package.sourceVersion),
        },
        generated: value.generated.map((entry) => {
            if (!isRecord(entry)) throw new Error("provenance.json holds a non-object row");
            return { modulePath: text(entry.modulePath), symbolName: text(entry.symbolName) };
        }),
    };
}

export function formatProvenance(report: ProvenanceReport): string {
    const symbols = report.generated.reduce(
        (count, row) => count + row.symbolName.split(",").length,
        0,
    );
    return [
        `${report.package.package} ${report.package.version} @ ${report.package.sourceVersion}`,
        `${symbols} pinned symbol(s) lowered from ${report.generated.length} module(s):`,
        ...report.generated.map((row) => `  ${row.modulePath}: ${row.symbolName}`),
    ].join("\n");
}

export interface SceneStatus {
    generatedTreeExists: boolean;
    generationCurrent: boolean;
    expectedStamp?: string;
    executable: string;
    executableExists: boolean;
    /** Payload mismatches beside the executable, per label. */
    payload: Array<{ label: string; mismatches: number }>;
    /** Whether the binary's bytes carry the tree's stamp. */
    binaryCarriesStamp: boolean | undefined;
    configuredBackend?: string;
    current: boolean;
}

/**
 * The three identities a measurement depends on, without a run: the
 * generation record, the deployed payload, and the build stamp compiled
 * into the executable (`build_stamp.hpp` defines it as a string literal,
 * so the current tree's stamp is present in the binary's bytes when the
 * binary was built from it).
 */
export function readSceneStatus(
    outputDirectory: string,
    buildDirectory: string,
    executable: string,
    generationCurrent: boolean,
): SceneStatus {
    const output = resolve(outputDirectory);
    const generatedTreeExists = existsSync(resolve(output, "main.cpp"));
    const expectedStamp = generatedTreeExists ? computeBuildStamp(output).stamp : undefined;
    const executableExists = existsSync(executable);
    const payload = executableExists
        ? deployedPayloads(resolve(executable, ".."), output).map(({ label, source, deployed }) => ({
              label,
              mismatches: comparePayload(source, deployed).length,
          }))
        : [];
    const binaryCarriesStamp =
        executableExists && expectedStamp !== undefined
            ? readFileSync(executable).includes(expectedStamp)
            : undefined;
    const configuredBackend = readCacheConfiguration(buildDirectory)?.BBLITE_BACKEND;
    return {
        generatedTreeExists,
        generationCurrent,
        ...(expectedStamp !== undefined ? { expectedStamp } : {}),
        executable,
        executableExists,
        payload,
        binaryCarriesStamp,
        ...(configuredBackend !== undefined ? { configuredBackend } : {}),
        current:
            generatedTreeExists &&
            generationCurrent &&
            executableExists &&
            payload.every((entry) => entry.mismatches === 0) &&
            binaryCarriesStamp === true,
    };
}

export function formatSceneStatus(sceneId: string, status: SceneStatus): string {
    const mark = (ok: boolean | undefined): string => (ok === undefined ? "?" : ok ? "ok" : "STALE");
    const lines = [
        `status ${sceneId}: ${status.current ? "current" : "NOT current"}`,
        `  generated tree: ${status.generatedTreeExists ? "present" : "MISSING (scene -- compile)"}` +
            (status.expectedStamp !== undefined ? `, stamp ${status.expectedStamp.slice(0, 12)}` : ""),
        `  generation record: ${mark(status.generationCurrent)}` +
            (status.generationCurrent ? "" : " (inputs moved since the tree was generated; scene -- compile)"),
        `  executable: ${status.executableExists ? status.executable : `MISSING ${status.executable} (scene -- process)`}` +
            (status.configuredBackend !== undefined ? ` [BBLITE_BACKEND=${status.configuredBackend}]` : ""),
    ];
    for (const entry of status.payload) {
        lines.push(
            `  deployed ${entry.label}: ${entry.mismatches === 0 ? "ok" : `${entry.mismatches} file(s) differ from the generated tree (scene -- build)`}`,
        );
    }
    lines.push(
        `  binary carries the tree's stamp: ${mark(status.binaryCarriesStamp)}` +
            (status.binaryCarriesStamp === false ? " (built from other sources; scene -- process)" : ""),
    );
    return lines.join("\n");
}
