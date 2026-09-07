import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

// The nest-aware unroll budget (`MAX_STATIC_UNROLL_PRODUCT`) and the
// handle-table capture-and-fold arm retain generation-owned effects. Plain
// numeric data nests can instead execute entirely at runtime; the same
// body-cost policy serves counted and for-of loops. These fixtures stay below
// the separate compilation-wide hard limit and observe every resulting value.

function countedDataNest(bounds: readonly [number, number, number], element: string, expected: readonly number[]): string {
    return `
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const data: number[] = [];
            for (let x = 0; x < ${bounds[0]}; x++) {
                for (let y = 0; y < ${bounds[1]}; y++) {
                    for (let z = 0; z < ${bounds[2]}; z++) {
                        data.push(${element});
                    }
                }
            }
            const expected: number[] = ${JSON.stringify(expected)};
            if (data.length !== expected.length) {
                throw new Error("Numeric nest changed its result count or order");
            }
            for (let index = 0; index < expected.length; index++) {
                if (data[index] !== expected[index]) throw new Error("Numeric nest changed an ordered result");
            }
        }
    `;
}

const uniformNest = countedDataNest([16, 16, 4], "1", Array<number>(1024).fill(1));
const indexedNest = countedDataNest([8, 8, 8], "x * 100 + y * 10 + z",
    Array.from({ length: 512 }, (_, index) =>
        Math.floor(index / 64) * 100 + (Math.floor(index / 8) % 8) * 10 + index % 8));

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
            ${Array.from({ length: count }, (_, index) =>
                `const box${index} = createBox(engine); meshes.push(box${index});`,
            ).join("\n")}
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
        /\{\n\s*v_box0, v_box1, /,
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
            ${"meshes.push(createBox(engine));\n".repeat(300)}
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

test("a uniform numeric nest uses one native body before static expansion", () => {
    const result = compileSource(uniformNest);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 4); // three construction loops and the result observer
    assert.equal(result.cpp.match(/push_back\(1\.0\);/g)?.length, 1);
    assert.doesNotMatch(result.cpp, /v_bblite_repeat_index_/);
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

test("a numeric nest computes each ordered index value in its native loops", () => {
    const result = compileSource(indexedNest);
    assert.doesNotMatch(result.cpp, /v_bblite_repeat_index_/);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 4); // three construction loops and the result observer
    assert.equal(result.cpp.match(/push_back\(/g)?.length, 1);
});

const nativeTools = optionalNativeFixtureTools(false);
test("native numeric nests preserve all 1024 uniform and 512 indexed values in order", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/static-unroll-data-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, `
        #define main uniform_nest
        ${compileSource(uniformNest).cpp}
        #undef main
        #define main indexed_nest
        ${compileSource(indexedNest).cpp}
        #undef main
        namespace bbl { Engine create_engine(EngineOptions options) { Engine engine; engine.options = options; return engine; } }
        int main() { return uniform_nest() || indexed_nest(); }
    `);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, source, "/link", "/OPT:REF"]);
    execFileSync(executable, { stdio: "pipe" });
});
