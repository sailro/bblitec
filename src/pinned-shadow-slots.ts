import ts from "typescript";
import { sharedUpstreamStore } from "./upstream-source.js";
import { unwrapPin } from "./lowering/gltf/shared.js";

/**
 * Which lights a shadow-receiving mesh samples, and with which filter.
 *
 * The pin's own `ShadowLightSlot` (`shader/fragments/shadow-fragment-core.ts`)
 * is shared by both receiver families: `createStdShadowFragment` and
 * `createPbrShadowFragment` are thin wrappers around one core that names every
 * varying and binding after the light's index in `scene.lights` and picks each
 * binding's TYPE from that light's own filter. So the slot list belongs to the
 * shadow family rather than to either material family, and both compositions
 * read it from here.
 */
export interface ShadowLightSlot {
    lightIndex: number;
    shadowType: "esm" | "pcf" | "csm";
}

/**
 * Which receiver fragment a generator family's slots compose, read off the
 * pinned factory rather than mapped here.
 *
 * Every pinned generator states its own filter as a literal on the object it
 * returns (`_shadowType: "pcf"`), and `pbr-renderable.ts` builds its slot list
 * by reading exactly that field — so the string is the pin's, and a family
 * whose factory renamed or re-valued it fails here instead of composing a
 * neighbour's fragment. The map this takes is factory identity, which is the
 * one fact the manifest genuinely owns.
 */
const shadowGeneratorModules: Readonly<Record<string, string>> = {
    "pcf-spot": "src/shadow/pcf-spotlight-shadow-generator.ts",
    // Its own factory, and its own `_shadowType` literal to read: the two
    // PCF generators agree on that string, and this map exists so the
    // agreement is the PIN's rather than an assumption here.
    "pcf-directional": "src/shadow/pcf-directional-shadow-generator.ts",
    "esm-directional": "src/shadow/esm-directional-shadow-generator.ts",
};

/** One answer per family; the pin cannot move under a generation. */
const filtersByKind = new Map<string, ShadowLightSlot["shadowType"]>();

export function pinnedShadowFilter(
    kind: string,
): ShadowLightSlot["shadowType"] {
    const memoised = filtersByKind.get(kind);
    if (memoised) return memoised;
    const modulePath = shadowGeneratorModules[kind];
    if (modulePath === undefined) {
        throw new Error(
            `No pinned shadow generator module is named for '${kind}'.`,
        );
    }
    const file = sharedUpstreamStore().getSourceFile(modulePath);
    let filter: string | undefined;
    const visit = (node: ts.Node): void => {
        if (filter !== undefined) return;
        if (
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "_shadowType"
        ) {
            // The three factories do not spell it identically: two write a
            // bare literal and the directional PCF writes `"pcf" as const`.
            // The assertion is a type-level narrowing with no value in it,
            // so it is unwrapped rather than being a second shape to accept.
            const value = unwrapPin(node.initializer);
            if (ts.isStringLiteral(value)) filter = value.text;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (filter !== "esm" && filter !== "pcf" && filter !== "csm") {
        throw new Error(
            `${modulePath} states no '_shadowType' this port composes for; ` +
                `read '${filter ?? "nothing"}'.`,
        );
    }
    filtersByKind.set(kind, filter);
    return filter;
}
