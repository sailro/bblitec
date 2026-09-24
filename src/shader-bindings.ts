/**
 * SDL_GPU's binding constraints over one compiled stage. bblite-tint
 * (tools/tint-sdl) emits every artifact already addressed at SDL's slots and
 * records the stage's layout; this module adapts the WGSL a stage is compiled
 * from and checks that record. Babylon shader expressions stay intact.
 */
import { shadowBindingSlotOrNull } from "./pinned-pbr-variant-cpp.js";
import {
    reflectWgslBindings,
    reflectWgslModule,
    type WgslVariableDeclaration,
} from "./shader-ir.js";

/** A resource binding Tint reflects, by WGSL group, binding and name. */
export interface ReflectedBinding {
    group: number;
    binding: number;
    name: string;
}

/** What bblite-tint's `--layout-json` records of one compiled stage. */
export interface StageLayoutRecord {
    /** The uniform blocks the stage binds, by WGSL name, in SDL slot order. */
    uniformBuffers: string[];
    /** Every binding any entry point of the module reaches. */
    bindings: ReflectedBinding[];
}

function list(value: unknown, label: string): readonly unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    return value;
}

function record(value: unknown, label: string): object {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    return value;
}

function name(value: unknown, label: string): string {
    if (typeof value !== "string")
        throw new Error(`${label} must be a string.`);
    return value;
}

function index(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new Error(`${label} must be a nonnegative integer.`);
    return value;
}

/** Reads bblite-tint's layout record for `stage`. */
export function parseStageLayoutRecord(
    text: string,
    stage: string,
): StageLayoutRecord {
    const label = `The bblite-tint layout record of ${stage}`;
    const parsed = record(JSON.parse(text), label);
    if (!("uniformBuffers" in parsed) || !("bindings" in parsed))
        throw new Error(`${label} lacks uniformBuffers or bindings.`);
    return {
        uniformBuffers: list(
            parsed.uniformBuffers,
            `${label} uniformBuffers`,
        ).map((item) => name(item, `${label} uniform buffer`)),
        bindings: list(parsed.bindings, `${label} bindings`).map((item) => {
            const binding = record(item, `${label} binding`);
            if (
                !("group" in binding) ||
                !("binding" in binding) ||
                !("name" in binding)
            )
                throw new Error(`${label} has an incomplete binding.`);
            return {
                group: index(binding.group, `${label} group`),
                binding: index(binding.binding, `${label} binding`),
                name: name(binding.name, `${label} name`),
            };
        }),
    };
}

/** SDL_GPU binds at most four uniform buffers per stage. */
export const sdlUniformBufferCap = 4;

export function assertUniformBufferCap(
    uniformBuffers: readonly string[],
    stage: string,
): void {
    if (uniformBuffers.length > sdlUniformBufferCap) {
        throw new Error(
            `${stage} binds ${uniformBuffers.length} uniform buffers (${uniformBuffers.join(", ")}); SDL_GPU caps a stage at ${sdlUniformBufferCap}.`,
        );
    }
}

/** The module-scope `var<uniform>` blocks a module declares, in source order. */
function uniformBlocks(wgsl: string): WgslVariableDeclaration[] {
    return reflectWgslModule(wgsl).declarations.filter(
        (declaration): declaration is WgslVariableDeclaration =>
            declaration.kind === "var" &&
            declaration.addressSpace === "uniform" &&
            declaration.type !== undefined,
    );
}

/** These read-only blocks retain their layout when moved from uniform to storage. */
export function demotableUniformBlocks(wgsl: string): string[] {
    const blocks = uniformBlocks(wgsl).map(({ name }) => name);
    return [
        ...["localProbeData", "gp", "nmeShadowParams"].filter((name) =>
            blocks.includes(name),
        ),
        // The shadow receivers' per-light blocks: `shadowInfo_<light>` and
        // `csmInfo_<light>`, as `createShadowFragment` names them.
        ...blocks.filter(
            (name) => shadowBindingSlotOrNull(name)?.role === "info",
        ),
    ];
}

/** Moves the named uniform blocks to read-only storage, keeping every other byte. */
export function demoteUniformBlocks(
    wgsl: string,
    blocks: readonly string[],
): string {
    let demoted = wgsl;
    for (const block of uniformBlocks(wgsl)
        .filter(({ name }) => blocks.includes(name))
        .reverse()) {
        demoted =
            demoted.slice(0, block.head.start) +
            `var<storage, read> ${block.name}:` +
            demoted.slice(block.head.end);
    }
    return demoted;
}

export interface SdlUniformAdaptation {
    source: string;
    required: boolean;
}

/** The local-probe block exceeds SDL's push limit independently of slot count. */
export function prepareSdlUniformAdaptation(
    wgsl: string,
): SdlUniformAdaptation | undefined {
    const blocks = demotableUniformBlocks(wgsl);
    return blocks.length === 0
        ? undefined
        : {
              source: demoteUniformBlocks(wgsl, blocks),
              required: blocks.includes("localProbeData"),
          };
}

/** The WGSL a stage binding `uniformBuffers` compiles from on SDL_GPU, when it is not its own. */
export function sdlUniformSource(
    plan: SdlUniformAdaptation | undefined,
    uniformBuffers: readonly string[],
    stage: string,
): string | undefined {
    if (uniformBuffers.length <= sdlUniformBufferCap && !plan?.required)
        return undefined;
    if (plan) return plan.source;
    assertUniformBufferCap(uniformBuffers, stage);
    return undefined;
}

/** Every binding Tint reflects is one the module declares. */
export function assertReflectedBindings(
    wgsl: string,
    reflected: readonly ReflectedBinding[],
    source: string,
): void {
    const declared = new Set(
        reflectWgslBindings(wgsl).map(
            ({ group, binding }) => `${group}:${binding}`,
        ),
    );
    const undeclared = [
        ...new Set(
            reflected.map(({ group, binding }) => `${group}:${binding}`),
        ),
    ].filter((binding) => !declared.has(binding));
    if (undeclared.length)
        throw new Error(
            `Tint reports binding(s) ${undeclared.join(", ")} that ${source} does not declare.`,
        );
}
