import type { LoweredRecordFamily } from "../src/lowering/library-record-schema.js";
import { pinnedRawShaderText } from "../src/lowering/library-shaders.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";

/** One pinned module's CommonJS exports under Node. */
export type Exports = Record<string, unknown>;

/** Each pinned module's CommonJS text, transpiled once per test process. */
const transpiled = new Map<string, string>();

/**
 * The pinned modules `roots` reach, as CommonJS under Node, each evaluated
 * once: `globals` are the free names their code reads (the test's own
 * platform), `stubs` stand for modules the scenario never runs.
 */
export function pinnedModules(
    roots: readonly string[],
    options: {
        readonly globals?: Readonly<Record<string, unknown>>;
        readonly stubs?: ReadonlyMap<string, Exports>;
    } = {},
): Map<string, Exports> {
    const store = sharedUpstreamStore();
    const loaded = new Map<string, Exports>();
    const globals = options.globals ?? {};
    const names = Object.keys(globals);
    const load = (module: string): Exports => {
        const known = loaded.get(module) ?? options.stubs?.get(module);
        if (known) return known;
        const exports: Exports = {};
        loaded.set(module, exports);
        const require = (specifier: string): Exports => {
            // `?raw`: the WGSL text as the bundler gives it.
            if (specifier.endsWith("?raw"))
                return { default: pinnedRawShaderText(module, specifier).code };
            const target = store.resolveImport(module, specifier);
            if (!target)
                throw new Error(`${module} imports unresolved ${specifier}.`);
            return load(target);
        };
        let code = transpiled.get(module);
        if (code === undefined) {
            code = transpileCommonJs(store.getSource(module), module);
            transpiled.set(module, code);
        }
        createJavaScriptFunction(
            "exports",
            "require",
            ...names,
            code,
        )(exports, require, ...names.map((name) => globals[name]));
        return exports;
    };
    for (const module of roots) load(module);
    return loaded;
}

/** A lowered record family as the header a fixture includes. */
export function recordFamilyHeader(family: LoweredRecordFamily): string {
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/gpu.hpp",
        "bblite/web_platform.hpp",
        ...family.includes,
    ];
    return `#pragma once
${includes.map((header) => `#include <${header}>`).join("\n")}
namespace bbl {
${family.structs}
${family.declarations}
${family.definitions}
} // namespace bbl
`;
}

// ── Camera ─────────────────────────────────────────────────────────────

export type Vector = readonly [number, number, number];

const subtract = (a: Vector, b: Vector): Vector => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
];
const cross = (a: Vector, b: Vector): Vector => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vector, b: Vector): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vector): Vector => {
    const length = Math.sqrt(dot(a, a));
    return [a[0] / length, a[1] / length, a[2] / length];
};

/** A left-handed look-at view times a WebGPU (z in 0..w) perspective, as float32. */
export function viewProjection(
    eye: Vector,
    target: Vector,
    up: Vector,
): { matrix: number[]; p11: number } {
    const z = normalize(subtract(target, eye));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    const view = [
        x[0],
        y[0],
        z[0],
        0,
        x[1],
        y[1],
        z[1],
        0,
        x[2],
        y[2],
        z[2],
        0,
        -dot(x, eye),
        -dot(y, eye),
        -dot(z, eye),
        1,
    ];
    const near = 0.1;
    const far = 1000;
    const f = 1 / Math.tan(0.4);
    const projection = [
        f / (16 / 9),
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        far / (far - near),
        1,
        0,
        0,
        (-near * far) / (far - near),
        0,
    ];
    const product = new Float32Array(16);
    for (let column = 0; column < 4; column++)
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++)
                sum += projection[k * 4 + row]! * view[column * 4 + k]!;
            product[column * 4 + row] = sum;
        }
    return { matrix: [...product], p11: Math.fround(f) };
}
