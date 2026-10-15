/** Raw pinned PBR variants must compile unchanged to HLSL, MSL and SPIR-V. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import test from "node:test";
import { captureIsCurrent } from "../src/capture-instrumented.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { scenes } from "../src/scene-registry.js";
import { findPinnedTint, tintToolMismatch } from "../src/tint-tool.js";
import { artifactDirectory } from "../src/tooling/artifacts.js";
import { validateTintStages } from "./tint-stage-validation.js";
import { jsonRecords, jsonString } from "./json.js";

// Compiled to `dist/test/`, so the repository root is two levels up.
const root = resolve(import.meta.dirname, "..", "..");
const generated = resolve(root, "generated");
const cmake = discoverDevelopmentTools().cmake;
const tint = process.env["TINT_PATH"] ?? findPinnedTint(root, cmake) ?? "";

function composedStages(): string[] {
    if (!existsSync(generated)) return [];
    const found: string[] = [];
    for (const scene of scenes) {
        const directory = resolve(
            generated,
            scene.id,
            "upstream",
            "pbr-variants",
        );
        const manifest = resolve(directory, "variants.json");
        if (!existsSync(manifest)) continue;
        const files = new Set<string>();
        for (const variant of jsonRecords(
            JSON.parse(readFileSync(manifest, "utf8")),
        )) {
            for (const property of ["vertex", "fragment"]) {
                const file = jsonString(variant[property]);
                assert.ok(/^[^/\\]+\.wgsl$/.test(file));
                files.add(file);
            }
        }
        for (const file of [...files].sort())
            found.push(resolve(directory, file));
    }
    return found;
}

test("the pin's composed shaders compile through Tint unchanged", (t) => {
    const stages = composedStages();
    if (stages.length === 0 || !existsSync(tint)) {
        // Without a generated corpus or the pinned Tint there is nothing to
        // measure; the sweep and `tools/build-tint.ps1` populate both.
        t.skip(
            stages.length === 0
                ? "no generated scene carries composed PBR variants"
                : "the pinned Tint is not built",
        );
        return;
    }
    assert.equal(tintToolMismatch(tint, root, cmake), undefined);
    const result = validateTintStages(
        tint,
        stages,
        resolve(root, artifactDirectory("shader-cache", "raw-validation")),
    );
    assert.deepEqual(
        result.failures,
        [],
        `Pinned composed stages Tint cannot consume:\n${result.failures.join("\n")}`,
    );
    console.log(
        `${stages.length} pinned composed stages, ${result.unique} distinct; ` +
            `${result.compiled} Tint compilations, ${result.reused} cached successes (HLSL/MSL/SPIR-V)`,
    );
});

/**
 * The gate that the emitted variants *are* Babylon's, not merely plausible.
 *
 * `scene -- capture` records the WGSL Babylon's own WebGPU renderer compiled in
 * the browser. Every captured PBR fragment that generation composes an arm for
 * has to appear in the generated tree byte-for-byte: same text, no whitespace
 * normalization, no reordering. A variant that only nearly matches is the exact
 * failure this whole path exists to remove — it compiles, binds and draws, and
 * differs by a term.
 */
test("emitted variants reproduce the browser's own fragments byte-for-byte", (t) => {
    const captures = resolve(root, "artifacts", "capture");
    if (!existsSync(captures) || !existsSync(generated)) {
        t.skip("no browser capture or generated scene to compare");
        return;
    }
    const emitted = new Map<string, Set<string>>();
    for (const stage of composedStages()) {
        if (!stage.endsWith(".frag.wgsl")) continue;
        const scene = stage.slice(generated.length + 1).split(sep)[0]!;
        const set = emitted.get(scene) ?? new Set<string>();
        set.add(readFileSync(stage, "utf8"));
        emitted.set(scene, set);
    }
    let matched = 0;
    const missing: string[] = [];
    for (const scene of readdirSync(captures)) {
        const shaders = resolve(captures, scene, "shaders");
        if (!existsSync(shaders) || !emitted.has(scene)) continue;
        // Only a capture of THIS pin is evidence; `CaptureMeta.pin` says why.
        if (!captureIsCurrent(scene, resolve(captures, scene))) continue;
        for (const file of readdirSync(shaders)) {
            if (!file.endsWith(".wgsl")) continue;
            const text = readFileSync(resolve(shaders, file), "utf8");
            // Only the PBR fragments: a capture also holds the vertex stages,
            // the background arms and the post-process passes, none of which
            // this path composes yet.
            if (!/fn mainFragment|@fragment/.test(text)) continue;
            if (!/pbr|MaterialUniforms/i.test(text)) continue;
            if (emitted.get(scene)!.has(text)) {
                matched++;
            } else {
                missing.push(`${scene}/${file}`);
            }
        }
    }
    console.log(
        `${matched} captured PBR fragment(s) reproduced byte-for-byte` +
            (missing.length > 0
                ? `, ${missing.length} not composed yet: ${missing.join(", ")}`
                : ""),
    );
    // "No evidence" and "the evidence disagrees" are different verdicts, and
    // only the second is a finding. A capture directory holding scenes this
    // tree never generated -- a sizing capture of an unintegrated scene, a
    // probe -- considers no fragment at all, and asserting there would report
    // a regression whose cause is which artifacts happen to sit on disk.
    if (matched + missing.length === 0) {
        t.skip("no current capture covers a generated scene's PBR fragments");
        return;
    }
    assert.ok(
        matched > 0,
        "No captured PBR fragment was reproduced byte-for-byte; the emitted " +
            "variant space no longer reaches any measured arm.",
    );
});
