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
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";

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
    const generated = pinnedMatrixHeader(new LoweringContext());
    assert.doesNotMatch(header, /(?:shader|draw)_matrix_product\(/);
    assert.match(header, /#include <bblite\/upstream\/pinned_matrix.hpp>/);
    assert.match(generated, /const double a0 = static_cast<double>/);
    assert.match(generated, /dst\[[^\n]+static_cast<float>\(/);
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
        /world_view_projection\(\s*upstream::matrix_product\(pass\.view_projection, world\)\),/,
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

test("PBR capture uses the resolved draw world including late root transforms", () => {
    const capture = consumers()["pal_render_capture.hpp"];
    const blocks = capture.slice(capture.indexOf('json.key("pinnedMeshBlocks")'));
    assert.match(blocks, /pinned_variant_for_draw\(scene, engine, draw\)/);
    assert.match(blocks, /if \(variant == npos\) continue;/);
    const builder = shared().slice(shared().indexOf("inline upstream::MeshUniforms pinned_draw_mesh_block("));
    assert.match(blocks, /pinned_draw_conventions\(variant, record\)/);
    assert.match(builder, /const PinnedDrawConventions& conventions/);
    assert.match(builder, /pinned_draw_world\(\s*conventions.identity_world,\s*conventions.world_from_palette,\s*upstream::pbr_variants\[variant\].uses_local_position,/);
    for (const [name, source] of Object.entries(consumers())) {
        assert.ok(source.includes("pinned_draw_mesh_block("), `${name} bypasses the shared PBR draw block`);
        assert.doesNotMatch(source, /pinned_draw_world\(/, `${name} reconstructs the PBR draw world`);
    }
    assert.doesNotMatch(blocks, /pinned_mesh_world\(\)/);
    assert.match(blocks, /"worldSource", "effective-draw"/);
});
