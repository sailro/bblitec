import type { ValueMetadataPayloads } from "./metadata.js";
import type { TextFontSource } from "../../pinned-text-data.js";
import type { CsgSolidPlan } from "../../pinned-csg.js";
import type { Csg2SolidPlan } from "../../pinned-csg2.js";
import type { Value } from "./model.js";

interface GenerationValuePayloads {
    promise: { promiseResult?: Value; promiseType?: string };
    "text-font": { textFont?: { source: TextFontSource; bytes: Uint8Array } };
    "csg-solid": { csgSolid?: CsgSolidPlan };
    "csg2-solid": { csg2Solid?: { readonly plan: Csg2SolidPlan; disposed: boolean } };
    "executed-url": { executedUrl?: { module: string; exportName: string } };
    "animation-group-mask": { animationGroupMask?: { readonly names: readonly string[]; readonly include: boolean } };
}

export type ValuePayloads = GenerationValuePayloads & ValueMetadataPayloads;

export const generationPayloadFields = {
    promise: ["promiseResult", "promiseType"],
    "text-font": ["textFont"],
    "csg-solid": ["csgSolid"],
    "csg2-solid": ["csg2Solid"],
    "executed-url": ["executedUrl"],
    "animation-group-mask": ["animationGroupMask"],
} as const satisfies { [K in keyof GenerationValuePayloads]: readonly (keyof GenerationValuePayloads[K])[] };

export type GenerationPayloadKey = {
    [K in keyof GenerationValuePayloads]: keyof GenerationValuePayloads[K];
}[keyof GenerationValuePayloads];
