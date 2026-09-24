import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { floatLiteral } from "../src/cpp-literals.js";
import {
    pbrMaterialRecordSeedCpp,
    pinnedDefaultNumber,
    type PinnedMaterialDefaultName,
} from "../src/lowering/pinned-material-defaults.js";
import { findRepositoryRoot } from "../src/upstream-source.js";

// A PBR record's extension-absent ground state is pin semantics: a layer
// the material declares nothing for still reads these lanes' writer
// defaults. They live once, in the seed generation writes from the pinned
// defaults table; runtime.hpp carries no value of its own for them.

const seeded: readonly [string, PinnedMaterialDefaultName][] = [
    ["iridescence_index_of_refraction", "iridescenceIndexOfRefraction"],
    ["iridescence_minimum_thickness", "iridescenceMinimumThickness"],
    ["iridescence_maximum_thickness", "iridescenceMaximumThickness"],
    ["clearcoat_index_of_refraction", "clearcoatIndexOfRefraction"],
    ["clearcoat_normal_scale", "clearcoatBumpTextureScale"],
    ["sheen_intensity", "sheenIntensity"],
    ["reflectance", "pbrReflectance"],
    ["normal_texture_scale", "pbrNormalTextureScale"],
];

test("the PBR record seed writes the ground state from the pinned defaults table", () => {
    const seed = pbrMaterialRecordSeedCpp("material", "");
    for (const [member, pinned] of seeded) {
        assert.ok(
            seed
                .split("\n")
                .includes(
                    `material.${member} = ${floatLiteral(pinnedDefaultNumber(pinned))};`,
                ),
            `the seed does not write '${member}' from '${pinned}'`,
        );
    }
});

test("runtime.hpp leaves the seeded PBR lanes without a value of their own", () => {
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
    for (const [member] of seeded) {
        assert.match(
            header,
            new RegExp(`\\bfloat\\s+${member}\\{\\};`),
            `runtime.hpp gives '${member}' a value the seed owns`,
        );
    }
});
