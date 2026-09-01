// The behavior guard behind giving the capture and draw paths one
// shader-matrix record (TODO: compiler/runtime consolidation).
//
// The render capture is only evidence while it derives a shader draw's
// matrices exactly as the draw itself does — same world fold, same
// product, same float32 store boundary. These anchors pin that the
// derivation exists once, in the shared header, and that the capture
// writer and both backends consume that one derivation rather than
// composing their own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { findRepositoryRoot } from "../src/upstream-source.js";

function nativeSource(name: string): string {
    return readFileSync(
        join(findRepositoryRoot(), "native", "src", name),
        "utf8",
    );
}

const shared = () => nativeSource("pal_gpu_shared.hpp");
const consumers = () => ({
    "pal_dawn.cpp": nativeSource("pal_dawn.cpp"),
    "pal_sdl_gpu.cpp": nativeSource("pal_sdl_gpu.cpp"),
    "pal_render_capture.hpp": nativeSource("pal_render_capture.hpp"),
});

test("defines the shader-matrix product once, double-accumulated", () => {
    const header = shared();

    // The pin's four-term accumulation in double with one float32 store,
    // defined in the shared header and nowhere else.
    assert.equal(
        (header.match(/std::array<float, 16> shader_matrix_product\(/g) ?? [])
            .length,
        1,
    );
    assert.match(
        header,
        /const double b0 = world\[column \* 4\];/,
    );
    assert.match(
        header,
        /result\[column \* 4 \+ row\] = static_cast<float>\(/,
    );
    for (const [name, source] of Object.entries(consumers())) {
        assert.ok(
            !source.includes("shader_matrix_product("),
            `${name} re-derives the shader-matrix product locally`,
        );
    }
});

test("capture and draw paths take their matrices from one record", () => {
    const header = shared();

    // The shared derivation: one record owning the mesh world fold and
    // both products, defined once beside the pass matrices it patches.
    assert.equal(
        (header.match(/struct ShaderDrawMatrices \{/g) ?? []).length,
        1,
    );
    assert.match(
        header,
        /world\(shader_draw_world\(engine, mesh\)\),/,
    );
    assert.match(
        header,
        /world_view_projection\(\s*shader_matrix_product\(pass\.view_projection, world\)\),/,
    );
    assert.match(
        header,
        /world_view\(shader_world_view\(pass\.view, world\)\) \{\}/,
    );
    for (const [name, source] of Object.entries(consumers())) {
        // Every consumer of a shader draw's matrices — the two backend
        // draw loops and the capture writer — constructs the one record
        // and patches through `apply`; none folds a world or a product
        // of its own.
        assert.ok(
            source.includes("ShaderDrawMatrices shader_matrices("),
            `${name} no longer derives its shader matrices through the shared record`,
        );
        assert.ok(
            source.includes(".apply("),
            `${name} patches its pass matrices outside the shared record`,
        );
        assert.ok(
            !source.includes("std::array<float, 16> shader_draw_world("),
            `${name} defines a local shader-world fold`,
        );
        assert.ok(
            !source.includes("shader_world_view_projection("),
            `${name} composes a product beside the shared record`,
        );
    }
    // The two SDL_GPU draw loops both construct it; the count also
    // catches a site quietly reverting to hand-patched matrices.
    assert.equal(
        (consumers()["pal_sdl_gpu.cpp"]!
            .match(/ShaderDrawMatrices shader_matrices\(/g) ?? []).length,
        2,
    );
});
