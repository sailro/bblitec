import assert from "node:assert/strict";

/** @import { PluginContext } from "../../dist/src/tooling/check-run.js" */

/** @param {PluginContext} context */
export function check(context) {
    const details = [];
    for (const result of context.phase("watching")) {
        // The SDL output reports the PCM samples it successfully submitted for playback.
        const playback = [
            ...result.log.matchAll(
                /\[bblite trace\] audio playback frames=(\d+) peak=([\d.eE+-]+)/g,
            ),
        ].map((entry) => ({
            frames: Number(entry[1]),
            peak: Number(entry[2]),
        }));
        assert(
            playback.some(({ frames, peak }) => frames > 0 && peak > 0),
            `${result.backend}: no non-silent PCM reached the playback device`,
        );
        details.push({ backend: result.backend, playback });
    }
    assert(details.length > 0, "No audio phases ran");
    return { details };
}
