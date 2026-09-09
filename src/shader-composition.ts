import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ShaderStageConstant } from "./shader-ir.js";

export interface ShaderStageDeclaration {
    entryPoint: string;
    constants?: readonly ShaderStageConstant[];
}

export interface ShaderModuleDeclaration extends ShaderStageDeclaration {
    output: string;
    pinnedBindings: boolean;
    alsoStages?: readonly (ShaderStageDeclaration & { stem: string })[];
}

export interface OfflineShaderStage extends ShaderStageDeclaration {
    stem: string;
    sourceName: string;
    pinnedBindings: boolean;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string.`);
    return value;
}

function stageDeclaration(value: Record<string, unknown>): ShaderStageDeclaration {
    const entryPoint = text(value.entryPoint, "Shader entryPoint");
    if (!/^[A-Za-z_]\w*$/.test(entryPoint)) throw new Error(`Invalid shader entryPoint '${entryPoint}'.`);
    if (value.constants === undefined || value.constants === null) return { entryPoint };
    if (!Array.isArray(value.constants)) throw new Error("Shader constants must be an array.");
    const constants: ShaderStageConstant[] = [];
    const ids = new Set<number>();
    for (const item of value.constants) {
        const constant = object(item, "Shader constant");
        const id = constant.id;
        const amount = constant.value;
        if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 65535) {
            throw new Error("Shader constant id must be an integer in 0..65535.");
        }
        if (typeof amount !== "number" || !Number.isFinite(amount)) throw new Error("Shader constant value must be a finite JSON number.");
        if (ids.has(id)) throw new Error(`Duplicate shader constant id ${id}.`);
        ids.add(id);
        constants.push({ id, value: amount });
    }
    return { entryPoint, constants: constants.sort((left, right) => left.id - right.id) };
}

export function shaderStageConstants(stage: ShaderStageDeclaration): string {
    return [...(stage.constants ?? [])].sort((left, right) => left.id - right.id)
        .map(({ id, value }) => `${id}=${Object.is(value, -0) ? "-0" : value}`).join(",");
}

/** A module may deploy once and declare multiple compiled stage stems. */
export function readShaderComposition(directory: string): Map<string, OfflineShaderStage> {
    const path = join(directory, "composition.json");
    const stages = new Map<string, OfflineShaderStage>();
    if (!existsSync(path)) return stages;
    const parsed = object(JSON.parse(readFileSync(path, "utf8")), path);
    if (!Array.isArray(parsed.modules)) throw new Error(`${path} must declare a modules array.`);
    const add = (stage: OfflineShaderStage): void => {
        if (!/^[\w.-]+\.(?:vert|frag)$/.test(stage.stem)) throw new Error(`Invalid shader stage stem '${stage.stem}'.`);
        if (stages.has(stage.stem)) throw new Error(`Duplicate shader stage stem '${stage.stem}' in ${path}.`);
        stages.set(stage.stem, stage);
    };
    for (const item of parsed.modules) {
        const module = object(item, "Shader module");
        const output = text(module.output, "Shader module output");
        const sourceName = basename(output.replaceAll("\\", "/"));
        if (!sourceName.endsWith(".native.wgsl")) continue;
        if (typeof module.pinnedBindings !== "boolean") throw new Error(`Shader module '${output}' must declare pinnedBindings.`);
        const shared = { sourceName, pinnedBindings: module.pinnedBindings };
        add({ ...stageDeclaration(module), ...shared, stem: sourceName.slice(0, -".native.wgsl".length) });
        if (module.alsoStages !== undefined && module.alsoStages !== null) {
            if (!Array.isArray(module.alsoStages)) throw new Error(`Shader module '${output}' alsoStages must be an array.`);
            for (const item of module.alsoStages) {
                const extra = object(item, "Additional shader stage");
                add({ ...stageDeclaration(extra), ...shared, stem: text(extra.stem, "Shader stage stem") });
            }
        }
    }
    return stages;
}
