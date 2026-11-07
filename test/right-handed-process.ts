import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildConditionsEnvironment } from "../src/compiler-node-flags.js";
import type { ProbeOutcome, ProbeRequest } from "./right-handed-probes.js";

/**
 * Probes (`right-handed-probes.ts`) run in one child process started under
 * `babylon-lite-rh`, each probe's value or the message it threw, in order.
 */
export function rightHandedProbes(
    requests: readonly ProbeRequest[],
): ProbeOutcome[] {
    const result = spawnSync(
        process.execPath,
        [
            fileURLToPath(new URL("./right-handed-probes.js", import.meta.url)),
            JSON.stringify(requests),
        ],
        {
            encoding: "utf8",
            env: buildConditionsEnvironment(["babylon-lite-rh"]),
            maxBuffer: 1 << 26,
        },
    );
    if (result.status !== 0)
        throw new Error(
            `The right-handed probe process exited ${result.status}: ${result.stderr}`,
        );
    return JSON.parse(result.stdout) as ProbeOutcome[];
}

/** A probe's value, or a failure naming what it threw. */
export function probeValue(outcome: ProbeOutcome | undefined): unknown {
    if (!outcome || "error" in outcome)
        throw new Error(
            `The right-handed probe threw: ${outcome?.error ?? "no outcome"}`,
        );
    return outcome.value;
}

/** What a probe threw, or a failure when it returned. */
export function probeError(outcome: ProbeOutcome | undefined): string {
    if (!outcome || !("error" in outcome))
        throw new Error("The right-handed probe returned instead of refusing.");
    return outcome.error;
}
