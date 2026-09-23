import { importPinnedModule } from "./pinned-shader-composer.js";
import { runGenerationChild } from "./compiler/generation-child.js";

export interface ComputeUniformField {
    name: string;
    type: string;
}
export interface ComputeUniformFieldSlot {
    type: string;
    offset: number;
    byteLength: number;
    elementCount: number;
    rowCount: number;
    columnStride: number;
    scalar: number;
    kind: number;
}
export interface ComputeUniformLayoutData {
    byteLength: number;
    fields: readonly (readonly [string, ComputeUniformFieldSlot])[];
}
type LayoutResult = { layout: ComputeUniformLayoutData } | { error: string };

/** Execute source WGSL layout rules; generation supplies only closed field declarations. */
export async function executeComputeUniformLayout(
    fields: readonly ComputeUniformField[],
): Promise<LayoutResult> {
    const pin = await importPinnedModule<{
        createComputeUniformLayout(fields: readonly ComputeUniformField[]): {
            byteLength: number;
            _fields: ReadonlyMap<string, ComputeUniformFieldSlot>;
        };
    }>("compute/compute-uniform-writer.js");
    try {
        const layout = pin.createComputeUniformLayout(fields);
        return {
            layout: {
                byteLength: layout.byteLength,
                fields: [...layout._fields],
            },
        };
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { error: error.message };
    }
}

const layouts = new Map<string, LayoutResult>();
export function computeUniformLayout(
    fields: readonly ComputeUniformField[],
): LayoutResult {
    const key = JSON.stringify(fields),
        cached = layouts.get(key);
    if (cached) return cached;
    const json: unknown = JSON.parse(
        runGenerationChild({
            label: "Pinned compute uniform layout",
            input: key,
            script: `import {readFileSync} from 'node:fs';
import {executeComputeUniformLayout} from ${JSON.stringify(import.meta.url)};
process.stdout.write(JSON.stringify(await executeComputeUniformLayout(JSON.parse(readFileSync(0,'utf8')))));`,
        }),
    );
    if (!json || typeof json !== "object")
        throw new Error("Invalid pinned compute layout result.");
    if ("error" in json && typeof json.error === "string") {
        const result = { error: json.error };
        layouts.set(key, result);
        return result;
    }
    if (
        !("layout" in json) ||
        !json.layout ||
        typeof json.layout !== "object" ||
        !("byteLength" in json.layout) ||
        typeof json.layout.byteLength !== "number" ||
        !("fields" in json.layout) ||
        !Array.isArray(json.layout.fields)
    )
        throw new Error("Invalid pinned compute layout fields.");
    const entries: unknown[] = json.layout.fields;
    const slots: [string, ComputeUniformFieldSlot][] = [];
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2)
            throw new Error("Invalid pinned compute field entry.");
        const name: unknown = entry[0],
            slot: unknown = entry[1];
        if (
            typeof name !== "string" ||
            !slot ||
            typeof slot !== "object" ||
            !("type" in slot) ||
            typeof slot.type !== "string"
        )
            throw new Error("Invalid pinned compute field slot.");
        const number = (
            key: keyof Omit<ComputeUniformFieldSlot, "type">,
        ): number => {
            if (!(key in slot))
                throw new Error(`Missing compute field ${key}.`);
            const value: unknown = Reflect.get(slot, key);
            if (typeof value !== "number" || !Number.isFinite(value))
                throw new Error(`Invalid compute field ${key}.`);
            return value;
        };
        slots.push([
            name,
            {
                type: slot.type,
                offset: number("offset"),
                byteLength: number("byteLength"),
                elementCount: number("elementCount"),
                rowCount: number("rowCount"),
                columnStride: number("columnStride"),
                scalar: number("scalar"),
                kind: number("kind"),
            },
        ]);
    }
    const result = {
        layout: { byteLength: json.layout.byteLength, fields: slots },
    };
    layouts.set(key, result);
    return result;
}
