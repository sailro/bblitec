import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    featureMacroHeaders,
    featureMacroInclude,
    featureMacros,
} from "../src/feature-macros.js";
import { shadowGeneratorFeatures } from "../src/shadow-capabilities.js";
import { listFiles } from "../src/tooling/records.js";

/** The value each generated header defines, by macro. */
function values(
    features: readonly string[],
    imageCodecs: readonly string[] = [],
): Map<string, number> {
    const result = new Map<string, number>();
    for (const [include, text] of featureMacroHeaders({
        features,
        imageCodecs,
    })) {
        const definition = /^#define (BBLITE_\w+) ([01])$/m.exec(text);
        assert.ok(definition, `${include} defines no 0/1 macro`);
        assert.equal(include, featureMacroInclude(definition[1]!));
        assert.match(text, /^#pragma once$/m);
        result.set(definition[1]!, Number(definition[2]));
    }
    return result;
}

test("every feature macro is a header of its own, 0 until its row is reached", () => {
    const none = values([]);
    assert.equal(none.size, featureMacros.length);
    assert.deepEqual([...new Set(none.values())], [0]);
    // Equal facts are equal bytes: a header does not depend on anything
    // else the scene reaches.
    assert.equal(
        featureMacroHeaders({ features: ["ui:rml"], imageCodecs: [] }).get(
            featureMacroInclude("BBLITE_WORKERS"),
        ),
        featureMacroHeaders({ features: [], imageCodecs: [] }).get(
            featureMacroInclude("BBLITE_WORKERS"),
        ),
    );
});

test("each macro follows the features its row names", () => {
    for (const [features, macro] of [
        [["input:gamepad"], "BBLITE_HAS_GAMEPAD"],
        [["renderer:scene"], "BBLITE_HAS_PBR_RENDERER"],
        [["physics:character-controller"], "BBLITE_HAS_PHYSICS_CHARACTER"],
        [["navigation:tile-cache"], "BBLITE_HAS_NAV_TILE_CACHE"],
        [["platform:window"], "BBLITE_OFFSCREEN_SURFACES"],
        [["audio:decode-ogg", "audio:engine"], "BBLITE_AUDIO_DECODE_OGG"],
        [["compute:uniform-buffer"], "BBLITE_COMPUTE_BUFFERS"],
    ] as const) {
        const reached = values(features);
        assert.equal(reached.get(macro), 1, macro);
    }
    // Either text feature compiles the text records.
    assert.equal(values(["text:renderable"]).get("BBLITE_HAS_TEXT"), 1);
    assert.equal(values(["renderer:text"]).get("BBLITE_HAS_TEXT"), 1);
    assert.equal(
        values(["renderer:text"]).get("BBLITE_HAS_TEXT_RENDERABLE"),
        0,
    );
    // A generator's records exist exactly where a shadow generator is
    // reached; scheduling a shadow task owns none.
    for (const feature of shadowGeneratorFeatures)
        assert.equal(values([feature]).get("BBLITE_HAS_SHADOWS"), 1);
    assert.equal(values(["shadow:task"]).get("BBLITE_HAS_SHADOWS"), 0);
    // Plugin textures bind only through the opted-in bridges.
    assert.equal(
        values(["material:plugin-textures"]).get(
            "BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES",
        ),
        0,
    );
    assert.equal(
        values(["material:plugin-textures", "material:plugins"]).get(
            "BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES",
        ),
        1,
    );
    // The image decoder follows the packaged assets' codecs.
    assert.equal(values([]).get("BBLITE_HAS_IMAGE_DECODER"), 0);
    assert.equal(values([], ["jpeg"]).get("BBLITE_HAS_IMAGE_DECODER"), 1);
});

test("each native file includes exactly the macro headers it tests", () => {
    // A unit's inputs are the macros its include closure names, so a file
    // naming a macro includes its header (the undefined-macro diagnostic
    // otherwise depends on include order) and includes no header it does
    // not read (every includer would rebuild and miss on a fact it ignores).
    const table = new Set(featureMacros.map((row) => row.macro));
    const wrong: string[] = [];
    let readers = 0;
    for (const file of [
        ...listFiles("native/include"),
        ...listFiles("native/src"),
    ]) {
        if (!/\.(?:hpp|cpp|h|mm)$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        const code = text
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const named = new Set(
            [...code.matchAll(/\bBBLITE_[A-Z0-9_]+\b/g)]
                .map((match) => match[0])
                .filter((name) => table.has(name)),
        );
        const included = new Set(
            [...text.matchAll(/^#include <(bblite\/features\/[^>]+)>$/gm)].map(
                (match) => match[1]!,
            ),
        );
        if (named.size > 0) ++readers;
        for (const macro of named)
            if (!included.has(featureMacroInclude(macro)))
                wrong.push(`${file} tests ${macro} without its header`);
        for (const include of included)
            if (
                ![...named].some(
                    (macro) => featureMacroInclude(macro) === include,
                )
            )
                wrong.push(`${file} includes ${include} and never tests it`);
    }
    assert.ok(readers > 40, "the scan found the native readers");
    assert.deepEqual(wrong, []);
});

test("every feature macro has a reader", () => {
    // A macro nothing tests gates nothing. The readers are the native
    // sources and the emitters' preprocessor tests in generated code.
    const tests = [
        ...listFiles("native/include"),
        ...listFiles("native/src"),
        ...listFiles("src").filter((file) => file.endsWith(".ts")),
    ].flatMap((file) =>
        readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => /#\s*(?:if|elif)\b/.test(line)),
    );
    const unread = featureMacros
        .map((row) => row.macro)
        .filter(
            (macro) =>
                !tests.some((line) => new RegExp(`\\b${macro}\\b`).test(line)),
        );
    assert.deepEqual(unread, []);
});
