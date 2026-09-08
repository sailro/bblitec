/**
 * The .babylon loader leaves lowered from their pinned ASTs -- byte gate.
 *
 * `bake_local_matrix` is the pinned `bakeLocalMatrix` translated whole,
 * and the node TRS reaches the vertices through the shared pinned
 * composition. The expected text below is the fixed presentation the
 * loader template carries, so a changed pinned formula changes these
 * bytes, and a construct the translation cannot carry refuses generation
 * instead of shipping stale C++.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";

const BAKE_MODULE = "src/loader-babylon/bake-local-matrix.ts";
const LOADER_MODULE = "src/loader-babylon/load-babylon.ts";
const CAMERA_MODULE = "src/loader-babylon/parse-camera.ts";

const lm = (index: number): string =>
    `static_cast<double>(lm[static_cast<std::size_t>(${index}.0)])`;
const lane = (buffer: string, offset: number): string =>
    offset === 0
        ? `${buffer}[static_cast<std::size_t>(i)]`
        : `${buffer}[static_cast<std::size_t>((i + ${offset}.0))]`;

const expectedBakeLocalMatrix = `// Generated from @babylonjs/lite@1.27.0 (64710b56f9dfe175d919c635812f84c8872d467c) ${BAKE_MODULE}#bakeLocalMatrix.
void bake_local_matrix(
    std::vector<float>& positions,
    std::vector<float>& normals,
    const std::array<double, 16>& lm) {
    const double isIdentity = ((((((((((((${lm(0)} == 1.0) && (${lm(1)} == 0.0)) && (${lm(2)} == 0.0)) && (${lm(4)} == 0.0)) && (${lm(5)} == 1.0)) && (${lm(6)} == 0.0)) && (${lm(8)} == 0.0)) && (${lm(9)} == 0.0)) && (${lm(10)} == 1.0)) && (${lm(12)} == 0.0)) && (${lm(13)} == 0.0)) && (${lm(14)} == 0.0));
    if (isIdentity) {
        return;
    }
    for (std::int64_t i = static_cast<std::int64_t>(0.0); i < static_cast<double>(positions.size()); i += static_cast<std::int64_t>(3.0)) {
        const double x = static_cast<double>(${lane("positions", 0)});
        const double y = static_cast<double>(${lane("positions", 1)});
        const double z = static_cast<double>(${lane("positions", 2)});
        ${lane("positions", 0)} = static_cast<float>(((((x * ${lm(0)}) + (y * ${lm(4)})) + (z * ${lm(8)})) + ${lm(12)}));
        ${lane("positions", 1)} = static_cast<float>(((((x * ${lm(1)}) + (y * ${lm(5)})) + (z * ${lm(9)})) + ${lm(13)}));
        ${lane("positions", 2)} = static_cast<float>(((((x * ${lm(2)}) + (y * ${lm(6)})) + (z * ${lm(10)})) + ${lm(14)}));
    }
    for (std::int64_t i = static_cast<std::int64_t>(0.0); i < static_cast<double>(normals.size()); i += static_cast<std::int64_t>(3.0)) {
        const double nx = static_cast<double>(${lane("normals", 0)});
        const double ny = static_cast<double>(${lane("normals", 1)});
        const double nz = static_cast<double>(${lane("normals", 2)});
        const double rx = (((nx * ${lm(0)}) + (ny * ${lm(4)})) + (nz * ${lm(8)}));
        const double ry = (((nx * ${lm(1)}) + (ny * ${lm(5)})) + (nz * ${lm(9)}));
        const double rz = (((nx * ${lm(2)}) + (ny * ${lm(6)})) + (nz * ${lm(10)}));
        const double len = std::sqrt((((rx * rx) + (ry * ry)) + (rz * rz)));
        if (len > 1e-10) {
            ${lane("normals", 0)} = static_cast<float>((rx / len));
            ${lane("normals", 1)} = static_cast<float>((ry / len));
            ${lane("normals", 2)} = static_cast<float>((rz / len));
        }
    }
}`;

function loaderSource(context = new LoweringContext()): string {
    return new BabylonLowerer(context).lowerLoaderAdapter().source;
}

test("lowers the pinned pivot bake byte-identically to the loader's fixed presentation", () => {
    assert.ok(loaderSource().includes(expectedBakeLocalMatrix));
});

test("the loader composes each node's TRS through the pinned writers and bakes only pivoted nodes", () => {
    const source = loaderSource();
    // The Euler triple goes through eulerToQuat's half-angle products and
    // mat4ComposeInto's basis stores, never a per-axis rotator.
    assert.match(source, /qx = \(\(\(sx \* cy\) \* cz\) \+ \(\(cx \* sy\) \* sz\)\);/);
    assert.match(source, /local\[0\] = \(\(1\.0 - \(2\.0 \* \(yy \+ zz\)\)\) \* scale_x\);/);
    assert.doesNotMatch(source, /cosine_x|sine_x|Vec3 rotate\(/);
    // The bake runs on the pin's own predicate: a node carrying a
    // localMatrix, refused rather than padded when it is malformed.
    assert.match(
        source,
        /if \(const auto local_matrix = local_matrix_or_absent\(source\)\) \{\n\s*bake_local_matrix\(/,
    );
    assert.match(source, /A \.babylon localMatrix must carry sixteen numbers\./);
});

test("a changed pivot renormalization threshold flows into the emitted bytes", () => {
    const source = loaderSource(
        doctoredContext(BAKE_MODULE, "if (len > 1e-10) {", "if (len > 1e-7) {"),
    );
    assert.ok(!source.includes(expectedBakeLocalMatrix));
    assert.match(source, /if \(len > 1e-7\) \{/);
});

test("a pivot bake the loader stops guarding refuses generation", () => {
    assert.throws(
        () =>
            loaderSource(
                doctoredContext(
                    LOADER_MODULE,
                    "if (md.localMatrix && bakeLocalMatrix) {",
                    "if (bakeLocalMatrix) {",
                ),
            ),
        /Babylon pivot-bake guard/,
    );
});

test("a mesh TRS argument that stops defaulting the pinned way refuses generation", () => {
    assert.throws(
        () =>
            loaderSource(
                doctoredContext(
                    LOADER_MODULE,
                    "md.scaling?.[2] ?? 1\n                    );",
                    "md.scaling?.[2] ?? 2\n                    );",
                ),
            ),
        /Babylon mesh TRS argument 8/,
    );
});

test("a camera store the pin stops guarding refuses generation", () => {
    assert.throws(
        () =>
            loaderSource(
                doctoredContext(
                    CAMERA_MODULE,
                    "if (cd.fov != null) {",
                    "if (cd.fov !== undefined) {",
                ),
            ),
        /Pinned camera fov guard/,
    );
});
