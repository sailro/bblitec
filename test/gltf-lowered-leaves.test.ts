/** Emission contracts and source-mutation checks for glTF lowering families. */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import {
    GltfLowerer,
    lowerAnimationInterpolationCpp,
    lowerMatrixComposeCpp,
    lowerMatrixNativeCpp,
    lowerShPrescaleCpp,
} from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import {lowerGltfAnimationEvaluator} from "../src/lowering/gltf/animation-evaluator.js";

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

const evaluateModule = "src/animation/evaluate.ts";
const parserModule = "src/loader-gltf/gltf-parser.ts";
const multiplyModule = "src/math/mat4-multiply-into.ts";
const composeModule = "src/math/mat4-compose-into.ts";
const assemblyModule = "src/loader-gltf/ibl-env-assembly.ts";
const loadEnvModule = "src/loader-env/load-env.ts";

/** What the loader template carried by hand before the lowering. */
const expectedAnimationInterpolation = `Vec4 normalize_quaternion(Vec4 value) {
    // Pinned normalizeQuat4: double length over float32 components,
    // a multiply by the inverse square root, one rounding at the
    // Float32Array store, no epsilon, and the input kept verbatim on
    // zero length.
    const double x = value.x;
    const double y = value.y;
    const double z = value.z;
    const double w = value.w;
    const double length_squared =
        x * x + y * y + z * z + w * w;
    if (length_squared > 0.0) {
        const double inverse =
            1.0 / std::sqrt(length_squared);
        return Vec4{
            static_cast<float>(x * inverse),
            static_cast<float>(y * inverse),
            static_cast<float>(z * inverse),
            static_cast<float>(w * inverse),
        };
    }
    return value;
}

Vec4 interpolate_quaternion(Vec4 left, Vec4 right, double amount) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double lx = left.x;
    const double ly = left.y;
    const double lz = left.z;
    const double lw = left.w;
    double rx = right.x;
    double ry = right.y;
    double rz = right.z;
    double rw = right.w;
    double dot = lx * rx + ly * ry + lz * rz + lw * rw;
    if (dot < 0.0) {
        rx = -rx;
        ry = -ry;
        rz = -rz;
        rw = -rw;
        dot = -dot;
    }
    if (dot > 0.9995) {
        // The pinned near-parallel path stores the double lerp into a
        // Float32Array scratch before normalizing it in place, so the
        // components round to float32 between the two steps.
        const Vec4 lerped{
            static_cast<float>(lx + amount * (rx - lx)),
            static_cast<float>(ly + amount * (ry - ly)),
            static_cast<float>(lz + amount * (rz - lz)),
            static_cast<float>(lw + amount * (rw - lw)),
        };
        return normalize_quaternion(lerped);
    }
    const double theta = std::acos(dot);
    const double sin_theta = std::sin(theta);
    const double left_weight =
        std::sin((1.0 - amount) * theta) / sin_theta;
    const double right_weight =
        std::sin(amount * theta) / sin_theta;
    return Vec4{
        static_cast<float>(left_weight * lx + right_weight * rx),
        static_cast<float>(left_weight * ly + right_weight * ry),
        static_cast<float>(left_weight * lz + right_weight * rz),
        static_cast<float>(left_weight * lw + right_weight * rw),
    };
}

Vec4 cubic_quaternion(
    Vec4 left,
    Vec4 left_tangent,
    Vec4 right,
    Vec4 right_tangent,
    double amount,
    double span) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double amount2 = amount * amount;
    const double amount3 = amount2 * amount;
    const double h00 = 2.0 * amount3 - 3.0 * amount2 + 1.0;
    const double h10 = amount3 - 2.0 * amount2 + amount;
    const double h01 = -2.0 * amount3 + 3.0 * amount2;
    const double h11 = amount3 - amount2;
    // The pinned evaluator scales tangents by the key delta before
    // weighting, stores the Hermite sum into a Float32Array, and then
    // normalizes the rounded components in place.
    const Vec4 combined{
        static_cast<float>(
            h00 * left.x + h10 * (left_tangent.x * span) +
            h01 * right.x + h11 * (right_tangent.x * span)),
        static_cast<float>(
            h00 * left.y + h10 * (left_tangent.y * span) +
            h01 * right.y + h11 * (right_tangent.y * span)),
        static_cast<float>(
            h00 * left.z + h10 * (left_tangent.z * span) +
            h01 * right.z + h11 * (right_tangent.z * span)),
        static_cast<float>(
            h00 * left.w + h10 * (left_tangent.w * span) +
            h01 * right.w + h11 * (right_tangent.w * span)),
    };
    return normalize_quaternion(combined);
}

Vec3 cubic_vec3(
    Vec3 left,
    Vec3 left_tangent,
    Vec3 right,
    Vec3 right_tangent,
    double amount,
    double span) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double amount2 = amount * amount;
    const double amount3 = amount2 * amount;
    const double h00 = 2.0 * amount3 - 3.0 * amount2 + 1.0;
    const double h10 = amount3 - 2.0 * amount2 + amount;
    const double h01 = -2.0 * amount3 + 3.0 * amount2;
    const double h11 = amount3 - amount2;
    // The pinned evaluator scales tangents by the key delta before
    // weighting and rounds once at the Float32Array store.
    return Vec3{
        static_cast<float>(
            h00 * left.x + h10 * (left_tangent.x * span) +
            h01 * right.x + h11 * (right_tangent.x * span)),
        static_cast<float>(
            h00 * left.y + h10 * (left_tangent.y * span) +
            h01 * right.y + h11 * (right_tangent.y * span)),
        static_cast<float>(
            h00 * left.z + h10 * (left_tangent.z * span) +
            h01 * right.z + h11 * (right_tangent.z * span)),
    };
}`;

test("lowers the pinned interpolation functions byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerAnimationInterpolationCpp(pinnedFile(evaluateModule)),
        expectedAnimationInterpolation,
    );
});

test("the emitted loader carries the complete source sampler evaluator", () => {
    const context = new LoweringContext(store);
    const adapter = new GltfLowerer(context)
        .lowerLoaderAdapter();
    assert.ok(adapter.source.includes(lowerGltfAnimationEvaluator(context)));
});

test("a changed slerp threshold flows into the emitted bytes", () => {
    const lowered = lowerAnimationInterpolationCpp(
        mutatedFile(evaluateModule, "dot > 0.9995", "dot > 0.4995"),
    );
    assert.notEqual(lowered, expectedAnimationInterpolation);
    assert.match(lowered, /if \(dot > 0\.4995\)/);
});

test("a changed Hermite coefficient flows into both cubic variants", () => {
    const lowered = lowerAnimationInterpolationCpp(
        mutatedFile(
            evaluateModule,
            "const h00 = 2 * f3 - 3 * f2 + 1;",
            "const h00 = 2 * f3 - 3 * f2 + 7;",
        ),
    );
    const occurrences = lowered.split(
        "const double h00 = 2.0 * amount3 - 3.0 * amount2 + 7.0;",
    ).length - 1;
    assert.equal(occurrences, 2);
});

test("a math intrinsic without a lowering refuses generation", () => {
    assert.throws(
        () =>
            lowerAnimationInterpolationCpp(
                mutatedFile(
                    evaluateModule,
                    "Math.acos(dot)",
                    "Math.atan(dot)",
                ),
            ),
        /Math\.atan, which has no lowering/,
    );
});

test("a moved tangent-triplet layout refuses generation", () => {
    assert.throws(
        () =>
            lowerAnimationInterpolationCpp(
                mutatedFile(
                    evaluateModule,
                    "output[k1 + c]!",
                    "output[k1 + 2 * stride + c]!",
                ),
            ),
        /triplet slot outside the pinned/,
    );
});

const expectedShPrescale = `std::array<Color3, 9> pre_scale_harmonics(
    const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = 0.3333338747897695f;
    constexpr float c00z = 0.33333298856284405f;
    constexpr float c1 = 1.4999984284682104f;
    constexpr float c2 = 3.999982863580422f;
    constexpr float c20zz = 1.3333326611423701f;
    constexpr float c20xy = 0.6666653397393608f;
    constexpr float c22 = 1.999991431790211f;
    std::array<Color3, 9> result{};
    for (int channel = 0; channel < 3; ++channel) {
        const float x =
            color_channel(polynomial[0], channel);
        const float y =
            color_channel(polynomial[1], channel);
        const float z =
            color_channel(polynomial[2], channel);
        const float xx =
            color_channel(polynomial[3], channel);
        const float yy =
            color_channel(polynomial[4], channel);
        const float zz =
            color_channel(polynomial[5], channel);
        const float yz =
            color_channel(polynomial[6], channel);
        const float zx =
            color_channel(polynomial[7], channel);
        const float xy =
            color_channel(polynomial[8], channel);
        set_color_channel(
            result[0],
            channel,
            (xx + yy) * c00xy + zz * c00z);
        set_color_channel(
            result[1], channel, y * c1);
        set_color_channel(
            result[2], channel, z * c1);
        set_color_channel(
            result[3], channel, x * c1);
        set_color_channel(
            result[4], channel, xy * c2);
        set_color_channel(
            result[5], channel, yz * c2);
        set_color_channel(
            result[6],
            channel,
            zz * c20zz - (xx + yy) * c20xy);
        set_color_channel(
            result[7], channel, zx * c2);
        set_color_channel(
            result[8],
            channel,
            (xx - yy) * c22);
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
    assert.match(lowered, /constexpr float c1 = 1\.25f;/);
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
    // Pinned mat4ComposeInto runs in JavaScript double precision and
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
        assert.ok(
            header.includes(line),
            `multiply emission lost: ${line}`,
        );
    }
    assert.match(header, /mat4-multiply-into\.ts#mat4MultiplyInto\./);
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
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
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
        emitted.includes("((((a4 * b1) + (a0 * b0)) + (a8 * b2)) + (a12 * b3))"),
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
