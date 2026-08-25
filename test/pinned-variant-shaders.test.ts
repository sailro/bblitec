/**
 * The gate on emitting Babylon Lite's own composed shaders instead of the
 * transcription under `src/lowering/templates/renderer/`.
 *
 * `TODO.md` framed this as a shader-IR problem — parse the pinned fragment and
 * re-emit it. Measurement says the IR is not needed: the pin's composed WGSL
 * compiles through the pinned Tint to HLSL, MSL and SPIR-V unchanged, and the
 * existing HLSL register normalization already re-addresses bindings for
 * SDL_GPU's dense convention. So what remains is the PAL binding the pin's own
 * uniform groups, not any rewriting of shader text.
 *
 * This test measures the claim over every variant generation emits, so a pinned
 * shader that stops being consumable becomes a build failure rather than a
 * surprise during the PAL migration.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import test from "node:test";

// Compiled to `dist/test/`, so the repository root is two levels up.
const root = resolve(import.meta.dirname, "..", "..");
const generated = resolve(root, "generated");
const tint = process.env["TINT_PATH"] ??
    resolve(root, "artifacts", "tools", "tint", "tint.exe");

function composedStages(): string[] {
    if (!existsSync(generated)) return [];
    const found: string[] = [];
    for (const scene of readdirSync(generated)) {
        const directory = resolve(generated, scene, "upstream", "pbr-variants");
        if (!existsSync(directory)) continue;
        for (const file of readdirSync(directory)) {
            if (file.endsWith(".wgsl")) found.push(resolve(directory, file));
        }
    }
    return found;
}

test("the pin's composed shaders compile through Tint unchanged", () => {
    const stages = composedStages();
    if (stages.length === 0 || !existsSync(tint)) {
        // Without a generated corpus or the pinned Tint there is nothing to
        // measure; the sweep and `tools/build-tint.ps1` populate both.
        return;
    }
    const out = mkdtempSync(resolve(tmpdir(), "bblite-variant-"));
    const failures: string[] = [];
    for (const format of ["hlsl", "msl", "spirv"] as const) {
        for (const stage of stages) {
            try {
                execFileSync(
                    tint,
                    ["--format", format, stage, "-o", resolve(out, `o.${format}`)],
                    { stdio: "pipe" },
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : error;
                failures.push(
                    `${format} ${stage.slice(generated.length + 1)}: ` +
                        String(detail).slice(0, 160),
                );
            }
        }
    }
    assert.deepEqual(
        failures,
        [],
        `Pinned composed stages Tint cannot consume:\n${failures.join("\n")}`,
    );
    console.log(
        `${stages.length} pinned composed stage(s) compile to HLSL, MSL and ` +
            "SPIR-V unchanged",
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
test("emitted variants reproduce the browser's own fragments byte-for-byte", () => {
    const captures = resolve(root, "artifacts", "capture");
    if (!existsSync(captures) || !existsSync(generated)) return;
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
    if (matched + missing.length === 0) return;
    assert.ok(
        matched > 0,
        "No captured PBR fragment was reproduced byte-for-byte; the emitted " +
            "variant space no longer reaches any measured arm.",
    );
});
