import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

// The nest-aware unroll budget (`MAX_STATIC_UNROLL_PRODUCT`) and the two
// capture-and-fold arms over it: the static handle table for a
// generation-known tuple `for...of`, and the identical-body repeat loop for
// a nested static index loop. Both arms run every iteration exactly as the
// unrolled emission does — the generation-time effects are the AOT model —
// and fold only the emitted text, so the fallback in every test here is
// byte-for-byte today's unrolled output.

/** A scene growing a tuple of bound box handles, with a caller-shaped tail. */
function meshTupleScene(count: number, tail: string): string {
    return `
        import {
            createBox,
            createEngine,
            createSceneContext,
            onBeforeRender,
            addToScene,
        } from "@babylonjs/lite";
        import type { Mesh } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const meshes: Mesh[] = [];
            for (let i = 0; i < ${count}; i++) {
                const box = createBox(engine);
                meshes.push(box);
            }
            ${tail}
        }
    `;
}

test("folds a large handle-tuple for...of into a static table and one native loop", () => {
    const result = compileSource(
        meshTupleScene(
            300,
            `onBeforeRender(scene, () => {
                for (const m of meshes) {
                    m.rotation.y += 0.01;
                }
            });`,
        ),
    );

    // One body, not three hundred.
    assert.equal(
        result.cpp.match(/\.rotation\.y \+= 0\.01f;/g)?.length,
        1,
    );
    assert.equal(
        result.cpp.match(/mark_mesh_runtime_transform/g)?.length,
        1,
    );
    // The table holds the bound handle locals and the loop walks it.
    assert.match(
        result.cpp,
        /const bbl::MeshHandle v_bblite_handle_table_\d+\[300\] = \{/,
    );
    assert.match(
        result.cpp,
        /\{\n\s*v_block\d+_box, v_block\d+_box, /,
    );
    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle v_bblite_handle_table_member_\d+ : v_bblite_handle_table_\d+\) \{/,
    );
    // The folded body reads the loop binding, not any unrolled spelling.
    assert.match(
        result.cpp,
        /v_engine\.meshes\[v_bblite_handle_table_member_\d+\.value\]\.rotation\.y \+= 0\.01f;/,
    );
});

test("regenerating the folded scene twice is deterministic", () => {
    const source = meshTupleScene(
        300,
        `onBeforeRender(scene, () => {
            for (const m of meshes) {
                m.rotation.y += 0.01;
            }
        });`,
    );
    assert.equal(
        compileSource(source).cpp,
        compileSource(source).cpp,
    );
});

test("an element spelled as its creation call keeps the unrolled bytes", () => {
    // `meshes.push(createBox(engine))` compiles each element's spelling as
    // the creation CALL itself. A table repeating that spelling would
    // re-create every mesh per execution, so the fold must decline on
    // non-identifier elements and leave today's unrolled emission.
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createSceneContext,
            onBeforeRender,
        } from "@babylonjs/lite";
        import type { Mesh } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const meshes: Mesh[] = [];
            for (let i = 0; i < 300; i++) {
                meshes.push(createBox(engine));
            }
            onBeforeRender(scene, () => {
                for (const m of meshes) {
                    m.rotation.y += 0.01;
                }
            });
        }
    `);

    assert.doesNotMatch(result.cpp, /v_bblite_handle_table_/);
    assert.equal(
        result.cpp.match(/\.rotation\.y \+= 0\.01f;/g)?.length,
        300,
    );
});

test("a body doing generation-time scene work keeps the unrolled AOT walk", () => {
    const result = compileSource(
        meshTupleScene(
            300,
            `for (const m of meshes) {
                addToScene(scene, m);
            }`,
        ),
    );

    assert.doesNotMatch(result.cpp, /v_bblite_handle_table_/);
    assert.equal(
        result.cpp.match(/bbl::add_to_scene\(v_scene, /g)?.length,
        300,
    );
});

test("a body whose emission differs per element keeps its unrolled bytes", () => {
    const result = compileSource(
        meshTupleScene(
            300,
            `onBeforeRender(scene, () => {
                for (const m of meshes) {
                    let spin = 0.01;
                    spin += 0.02;
                    m.rotation.y += spin;
                }
            });`,
        ),
    );

    // The per-iteration block-prefixed local makes every capture distinct,
    // so the fold declines and the captured lines re-emit verbatim.
    assert.doesNotMatch(result.cpp, /v_bblite_handle_table_/);
    assert.doesNotMatch(result.cpp, /v_bblite_repeat_index_/);
    assert.equal(
        result.cpp.match(/\.rotation\.y \+= /g)?.length,
        300,
    );
});

test("a nested static index loop past the product budget folds an identical body", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const data: number[] = [];
            for (let i = 0; i < 16; i++) {
                for (let j = 0; j < 16; j++) {
                    for (let k = 0; k < 4; k++) {
                        data.push(1);
                    }
                }
            }
            if (data.length === 0) {
                throw new Error("empty");
            }
        }
    `);

    // 16 x 16 outer unrolls survive (each within the product budget); the
    // innermost 4 iterations of an index-independent body collapse to one
    // repeat loop per enclosing cell: 256 emitted pushes, not 1024.
    assert.match(
        result.cpp,
        /for \(int v_bblite_repeat_index_\d+ = 0; v_bblite_repeat_index_\d+ < 4; \+\+v_bblite_repeat_index_\d+\) \{/,
    );
    assert.equal(
        result.cpp.match(/push_back\(1\.0\);/g)?.length,
        256,
    );
});

test("a large data-only static nest keeps its outer loop native", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const data: number[] = [];
            for (let x = 0; x < 16; x++) {
                for (let y = 0; y < 16; y++) {
                    for (let z = 0; z < 96; z++) {
                        data.push(1);
                    }
                }
            }
            if (data.length === 0) {
                throw new Error("empty");
            }
        }
    `);

    // The 24,576-cell Cartesian walk exceeds the static-nest ceiling, so
    // its outer layers stay native instead of duplicating their generated
    // body; the 96-iteration leaf already exceeds the per-loop ceiling.
    assert.match(
        result.cpp,
        /for \(; v_block\d+_x < 16\.0; v_block\d+_x\+\+\) \{/,
    );
    assert.equal(result.cpp.match(/push_back\(1\.0\);/g)?.length, 1);
});

test("small data loops nested under a native loop remain native", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const data: number[] = [];
            for (let y = 0; y < 96; y++) {
                for (let z = 0; z < 16; z++) {
                    for (let x = 0; x < 16; x++) {
                        data.push(1);
                    }
                }
            }
            if (data.length === 0) {
                throw new Error("empty");
            }
        }
    `);

    // The 96-iteration outer loop is native by the per-loop ceiling. Its
    // smaller children execute under runtime control and remain native too,
    // leaving one body rather than 256 generated copies.
    assert.equal(result.cpp.match(/for \(;/g)?.length, 3);
    assert.equal(result.cpp.match(/push_back\(1\.0\);/g)?.length, 1);
});

test("a nested index body folding its indices into constants stays unrolled", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const data: number[] = [];
            for (let x = 0; x < 8; x++) {
                for (let y = 0; y < 8; y++) {
                    for (let z = 0; z < 8; z++) {
                        data.push(x * 100 + y * 10 + z);
                    }
                }
            }
            if (data.length === 0) {
                throw new Error("empty");
            }
        }
    `);

    // scene165's shape: the innermost product (512) exceeds the budget but
    // every capture carries its own per-iteration constants, so nothing
    // folds and the 512 unrolled bodies emit exactly as before.
    assert.doesNotMatch(result.cpp, /v_bblite_repeat_index_/);
    assert.equal(result.cpp.match(/push_back\(/g)?.length, 512);
    assert.match(
        result.cpp,
        /push_back\(\(\(\(0\.0 \* 100\.0\) \+ \(0\.0 \* 10\.0\)\) \+ 0\.0\)\);/,
    );
    assert.match(
        result.cpp,
        /push_back\(\(\(\(7\.0 \* 100\.0\) \+ \(7\.0 \* 10\.0\)\) \+ 7\.0\)\);/,
    );
});
