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
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
