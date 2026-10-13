/**
 * The WGSL the pinned splat-stream library hands WebGPU at run time: each
 * `?raw` module text one of its lowered modules imports, the C++ string the
 * lowered `createShaderModule` passes, and on SDL_GPU the stages generation
 * compiles for it. A stage is named by the module's own text and entry
 * point (`wgslStageStem`, native `wgsl_stage_stem`), so the device finds
 * the stage the run-time `createComputePipeline`/`createRenderPipeline`
 * names; Dawn compiles the same text itself.
 */
import ts from "typescript";
import { posix } from "node:path";
import { readPinnedRawShader } from "../pinned-shader-composer.js";
import { reflectWgslModule, wgslEntryPoints } from "../shader-ir.js";
import { wgslStageStem, type WgslStageKind } from "../wgsl-artifacts.js";
import type { LoweringContext } from "./context.js";

/** One `import NAME from "./x.wgsl?raw"` of a lowered module. */
export interface PinnedRawShaderImport {
    /** The importing pinned module (`src/.../x.ts`). */
    readonly module: string;
    /** The binding the module reads the text through. */
    readonly name: string;
    /** The imported WGSL file (`src/.../x.wgsl`). */
    readonly source: string;
    /** The module text, byte for byte. */
    readonly code: string;
}

/** The library modules that import run-time WGSL. */
export const SPLAT_STREAM_SHADER_MODULES = [
    "src/loader-splat-stream/splat-stream-gpu.ts",
    "src/loader-splat-stream/splat-stream-material.ts",
] as const;

/** Every `?raw` WGSL import of `modules`, in module and source order. */
export function pinnedRawShaderImports(
    context: LoweringContext,
    modules: readonly string[],
): PinnedRawShaderImport[] {
    const imports: PinnedRawShaderImport[] = [];
    for (const module of modules) {
        const file = ts.createSourceFile(
            module,
            context.store.getSource(module),
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS,
        );
        for (const statement of file.statements) {
            if (
                !ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                !statement.moduleSpecifier.text.endsWith(".wgsl?raw")
            )
                continue;
            const name = statement.importClause?.name?.text;
            if (!name || statement.importClause?.namedBindings)
                throw new Error(
                    `${module}: a raw WGSL import binds its text as one default import.`,
                );
            const source = posix.normalize(
                posix.join(
                    posix.dirname(module),
                    statement.moduleSpecifier.text.slice(0, -"?raw".length),
                ),
            );
            const packaged = `${module.slice("src/".length, -".ts".length)}.js`;
            imports.push({
                module,
                name,
                source,
                code: readPinnedRawShader(packaged, source),
            });
        }
    }
    return imports;
}

/** A module deployed under its first stage's stem, compiling every other stage beside it. */
export interface RuntimeWgslModule {
    readonly output: string;
    readonly data: string;
    readonly entryPoint: string;
    readonly alsoStages: readonly { stem: string; entryPoint: string }[];
}

const STAGES: readonly (readonly [
    "compute" | "vertex" | "fragment",
    WgslStageKind,
])[] = [
    ["compute", "comp"],
    ["vertex", "vert"],
    ["fragment", "frag"],
];

/**
 * The SDL_GPU stages of each run-time module text: every entry point the
 * text declares, under the stem its text and entry point name.
 */
export function runtimeWgslModules(
    shaders: readonly PinnedRawShaderImport[],
): RuntimeWgslModule[] {
    const modules = new Map<string, RuntimeWgslModule>();
    for (const { code, source } of shaders) {
        if (modules.has(code)) continue;
        const reflected = reflectWgslModule(code);
        const stages = STAGES.flatMap(([stage, kind]) =>
            wgslEntryPoints(reflected, stage).map((entry) => ({
                stem: wgslStageStem(code, entry.name, kind),
                entryPoint: entry.name,
            })),
        );
        const [first, ...rest] = stages;
        if (!first) throw new Error(`${source} declares no entry point.`);
        modules.set(code, {
            output: `upstream/shaders/${first.stem}.native.wgsl`,
            data: code,
            entryPoint: first.entryPoint,
            alsoStages: rest,
        });
    }
    return [...modules.values()];
}
