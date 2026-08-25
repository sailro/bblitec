import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pinnedDefaultNumber } from "../src/lowering/pinned-material-defaults.js";
import { findRepositoryRoot } from "../src/upstream-source.js";

// NA-22's surviving initializer set, drift-guarded. Wave 2 deleted the
// native member initializers generation always overrides; the iridescence
// trio stayed because it IS the extension-absent ground state — a scene
// whose material declares no iridescence still writes iridescenceParams
// from these members, so their values are pin semantics, not C++ hygiene.
// The pinned numbers live once in pinned-material-defaults.ts (anchored
// there against the pin's own `?? default` discard sites); this test pins
// the native record to the same row, so a pin bump that moves a default
// fails here naming both values instead of surfacing as a parity split.

test("runtime.hpp's iridescence ground state is the pinned defaults table's", () => {
    const header = readFileSync(
        join(
            findRepositoryRoot(),
            "native",
            "include",
            "bblite",
            "runtime.hpp",
        ),
        "utf8",
    );
    const memberInitializer = (name: string): number => {
        const match = new RegExp(
            `float\\s+${name}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)f?;`,
        ).exec(header);
        assert.ok(
            match,
            `runtime.hpp no longer carries an inline initializer for ` +
                `'${name}' — if the member moved or its default was deleted, ` +
                "re-point this anchor at wherever the extension-absent " +
                "ground state now lives.",
        );
        return Number(match[1]);
    };
    for (const [member, pinned] of [
        [
            "iridescence_index_of_refraction",
            "iridescenceIndexOfRefraction",
        ],
        ["iridescence_minimum_thickness", "iridescenceMinimumThickness"],
        ["iridescence_maximum_thickness", "iridescenceMaximumThickness"],
    ] as const) {
        assert.equal(
            memberInitializer(member),
            pinnedDefaultNumber(pinned),
            `native ground state '${member}' drifted from the pinned ` +
                `default '${pinned}'`,
        );
    }
});
