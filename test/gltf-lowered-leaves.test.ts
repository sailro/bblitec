/** Emission contracts and source-mutation checks for glTF lowering families. */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import {
    GltfLowerer,
    lowerMatrixComposeCpp,
    lowerMatrixNativeCpp,
    lowerShPrescaleCpp,
} from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { lowerGltfAnimationEvaluator } from "../src/lowering/gltf/animation-evaluator.js";

const store = new UpstreamSourceStore();

function pinnedFile(modulePath: string): ts.SourceFile {
    return store.getSourceFile(modulePath);
}

/** A doctored pin: the module's source with one exact edit applied. */
function mutatedFile(
    modulePath: string,
    needle: string,
    replacement: string,
): ts.SourceFile {
    const source = store.getSource(modulePath);
    assert.ok(
        source.includes(needle),
        `the pinned source no longer contains '${needle}'`,
    );
    return ts.createSourceFile(
        modulePath,
        source.replace(needle, replacement),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

/**
 * A store serving one doctored module and the real pin for everything
 * else, for lowerings that take a `LoweringContext` rather than a file.
 */
function mutatedStore(
    modulePath: string,
    needle: string,
    replacement: string,
): UpstreamSourceStore {
    const doctored = mutatedFile(modulePath, needle, replacement);
    const patched = new UpstreamSourceStore();
    const original = patched.getSourceFile.bind(patched);
    patched.getSourceFile = (path: string): ts.SourceFile =>
        path === modulePath ? doctored : original(path);
    return patched;
}

const parserModule = "src/loader-gltf/gltf-parser.ts";
const multiplyModule = "src/math/multiply-mat4-into-buffer.ts";
const composeModule = "src/math/compose-mat4-into-buffer.ts";
const assemblyModule = "src/loader-gltf/ibl-env-assembly.ts";
const loadEnvModule = "src/loader-env/load-env.ts";

test("the emitted loader carries the complete source sampler evaluator", () => {
    const context = new LoweringContext(store);
    const adapter = new GltfLowerer(context).lowerLoaderAdapter();
    assert.ok(adapter.source.includes(lowerGltfAnimationEvaluator(context)));
});

const expectedShPrescale = `std::array<Color3, 9> pre_scale_harmonics(
    const std::array<Color3, 9>& polynomial) {
    constexpr double c00xy = 0.3333338747897695;
    constexpr double c00z = 0.33333298856284405;
    constexpr double c1 = 1.4999984284682104;
    constexpr double c2 = 3.999982863580422;
    constexpr double c20zz = 1.3333326611423701;
    constexpr double c20xy = 0.6666653397393608;
    constexpr double c22 = 1.999991431790211;
    std::array<Color3, 9> result{};
    for (int channel = 0; channel < 3; ++channel) {
        const double x =
            color_channel(polynomial[0], channel);
        const double y =
            color_channel(polynomial[1], channel);
        const double z =
            color_channel(polynomial[2], channel);
        const double xx =
            color_channel(polynomial[3], channel);
        const double yy =
            color_channel(polynomial[4], channel);
        const double zz =
            color_channel(polynomial[5], channel);
        const double yz =
            color_channel(polynomial[6], channel);
        const double zx =
            color_channel(polynomial[7], channel);
        const double xy =
            color_channel(polynomial[8], channel);
        set_color_channel(
            result[0],
            channel,
            static_cast<float>((xx + yy) * c00xy + zz * c00z));
        set_color_channel(
            result[1],
            channel,
            static_cast<float>(y * c1));
        set_color_channel(
            result[2],
            channel,
            static_cast<float>(z * c1));
        set_color_channel(
            result[3],
            channel,
            static_cast<float>(x * c1));
        set_color_channel(
            result[4],
            channel,
            static_cast<float>(xy * c2));
        set_color_channel(
            result[5],
            channel,
            static_cast<float>(yz * c2));
        set_color_channel(
            result[6],
            channel,
            static_cast<float>(zz * c20zz - (xx + yy) * c20xy));
        set_color_channel(
            result[7],
            channel,
            static_cast<float>(zx * c2));
        set_color_channel(
            result[8],
            channel,
            static_cast<float>((xx - yy) * c22));
    }
    return result;
}`;

test("lowers the pinned SH prescale byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerShPrescaleCpp(
            pinnedFile(assemblyModule),
            pinnedFile(loadEnvModule),
        ),
        expectedShPrescale,
    );
});

test("a changed SH band constant flows through both pinned copies", () => {
    const needle = "const C1 = 1.4999984284682104;";
    const replacement = "const C1 = 1.25;";
    const lowered = lowerShPrescaleCpp(
        mutatedFile(assemblyModule, needle, replacement),
        mutatedFile(loadEnvModule, needle, replacement),
    );
    assert.notEqual(lowered, expectedShPrescale);
    assert.match(lowered, /constexpr double c1 = 1\.25;/);
});

test("SH prescale copies that diverge refuse generation", () => {
    // The glTF loader executes ibl-env-assembly's private copy and the
    // .env path lowers load-env's canonical; a value moved in only one
    // is a pin defect to surface, never a value to pick.
    assert.throws(
        () =>
            lowerShPrescaleCpp(
                mutatedFile(
                    assemblyModule,
                    "const C1 = 1.4999984284682104;",
                    "const C1 = 1.25;",
                ),
                pinnedFile(loadEnvModule),
            ),
        /diverged between/,
    );
});

/* ───────────────────────────── round 3 ───────────────────────────── */

// The loader and render plan consume the same generated matrix header.
// Check its signature and accumulation without duplicating the full body.
const expectedMultiplyWriterLines = [
    "template <typename MatA, typename MatB>\nvoid mat4_multiply_into(",
    "const double a0 = static_cast<double>(a[static_cast<std::size_t>(i)]);",
    "((((a0 * b0) + (a4 * b1)) + (a8 * b2)) + (a12 * b3))",
];

const expectedMatrixCompose = `Matrix trs_matrix(
    Vec3 translation,
    Vec4 rotation,
    Vec3 scale) {
    // Pinned composeMat4IntoBuffer runs in JavaScript double precision and
    // rounds once at the Float32Array store; mirror its products and
    // association exactly.
    const double x = rotation.x;
    const double y = rotation.y;
    const double z = rotation.z;
    const double w = rotation.w;
    const double xx = x * x;
    const double yy = y * y;
    const double zz = z * z;
    const double xy = x * y;
    const double xz = x * z;
    const double yz = y * z;
    const double wx = w * x;
    const double wy = w * y;
    const double wz = w * z;
    const double sx = scale.x;
    const double sy = scale.y;
    const double sz = scale.z;
    Matrix result = identity_matrix();
    result[0] = static_cast<float>((1.0 - 2.0 * (yy + zz)) * sx);
    result[1] = static_cast<float>(2.0 * (xy + wz) * sx);
    result[2] = static_cast<float>(2.0 * (xz - wy) * sx);
    result[4] = static_cast<float>(2.0 * (xy - wz) * sy);
    result[5] = static_cast<float>((1.0 - 2.0 * (xx + zz)) * sy);
    result[6] = static_cast<float>(2.0 * (yz + wx) * sy);
    result[8] = static_cast<float>(2.0 * (xz + wy) * sz);
    result[9] = static_cast<float>(2.0 * (yz - wx) * sz);
    result[10] = static_cast<float>((1.0 - 2.0 * (xx + yy)) * sz);
    result[12] = static_cast<float>(translation.x);
    result[13] = static_cast<float>(translation.y);
    result[14] = static_cast<float>(translation.z);
    return result;
}`;

const expectedMatrixNative = `Matrix native_matrix(const Matrix& matrix) {
    Matrix result{};
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            const float row_sign = row == 0 ? -1.0f : 1.0f;
            const float column_sign =
                column == 0 ? -1.0f : 1.0f;
            result[column * 4 + row] =
                matrix[column * 4 + row] *
                row_sign *
                column_sign;
        }
    }
    return result;
}`;

test("lowers the pinned matrix multiply through the shared translation", () => {
    const header = pinnedMatrixHeader(new LoweringContext(store));
    for (const line of expectedMultiplyWriterLines) {
        assert.ok(header.includes(line), `multiply emission lost: ${line}`);
    }
    assert.match(
        header,
        /multiply-mat4-into-buffer\.ts#multiplyMat4IntoBuffer\./,
    );
});

test("lowers the pinned TRS compose byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerMatrixComposeCpp(pinnedFile(composeModule)),
        expectedMatrixCompose,
    );
});

test("lowers the native change of basis byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerMatrixNativeCpp(pinnedFile(parserModule)),
        expectedMatrixNative,
    );
});

test("the emitted loader carries the source matrix helpers", () => {
    const adapter = new GltfLowerer(
        new LoweringContext(store),
    ).lowerLoaderAdapter();
    for (const segment of [
        lowerMatrixComposeCpp(pinnedFile(composeModule), true),
        expectedMatrixNative,
    ]) {
        assert.ok(
            adapter.source.includes(segment),
            "the emitted loader no longer carries a source matrix helper",
        );
    }
});

test("a re-associated pinned matrix product flows into the translation", () => {
    // The canonical-form walk used to refuse this; the whole translation
    // instead carries whatever the pin says, into the loader and the
    // render plan from one emission — drift is visible as changed bytes
    // in both TUs together, never as one TU refusing while the other
    // silently adopts the new order.
    const emitted = pinnedMatrixHeader(
        new LoweringContext(
            mutatedStore(
                multiplyModule,
                "dst[d] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;",
                "dst[d] = a4 * b1 + a0 * b0 + a8 * b2 + a12 * b3;",
            ),
        ),
    );
    assert.ok(
        emitted.includes(
            "((((a4 * b1) + (a0 * b0)) + (a8 * b2)) + (a12 * b3))",
        ),
    );
});

test("a changed compose product flows into the emitted bytes", () => {
    const lowered = lowerMatrixComposeCpp(
        mutatedFile(
            composeModule,
            "dst[off + 1] = 2 * (xy + wz) * sx;",
            "dst[off + 1] = 2 * (xy - wz) * sx;",
        ),
    );
    assert.notEqual(lowered, expectedMatrixCompose);
    assert.match(
        lowered,
        /result\[1\] = static_cast<float>\(2\.0 \* \(xy - wz\) \* sx\);/,
    );
});

test("a compose lane that stops being identity refuses", () => {
    assert.throws(
        () =>
            lowerMatrixComposeCpp(
                mutatedFile(
                    composeModule,
                    "dst[off + 3] = 0;",
                    "dst[off + 3] = 5;",
                ),
            ),
        /no longer keeps the identity value in lane 3/,
    );
});

test("a moved RH-to-LH flip axis flows into the matrix adapter", () => {
    const doctored = mutatedFile(
        parserModule,
        "new F32([-1, 0, 0, 0,  0, 1, 0, 0,",
        "new F32([1, 0, 0, 0,  0, -1, 0, 0,",
    );
    const native = lowerMatrixNativeCpp(doctored);
    assert.match(native, /row == 1 \? -1\.0f : 1\.0f;/);
});

test("a root that stops flipping exactly one axis refuses", () => {
    assert.throws(
        () =>
            lowerMatrixNativeCpp(
                mutatedFile(
                    parserModule,
                    "F32([-1, 0, 0, 0,  0, 1,",
                    "F32([1, 0, 0, 0,  0, 1,",
                ),
            ),
        /no longer flips exactly one axis/,
    );
});
