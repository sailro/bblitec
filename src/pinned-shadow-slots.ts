import ts from "typescript";
import { sharedUpstreamStore } from "./upstream-source.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
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
    // The cascaded generator, whose `_shadowType: "csm" as const` is what
    // sends `createStdShadowFragment`/`createPbrShadowFragment` down their
    // cascaded arm instead of the shared ESM/PCF core.
    "csm-directional": "src/shadow/csm-directional-shadow-generator.ts",
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

/**
 * Reach the cascaded receiver factories the way the pin reaches them.
 *
 * `createStdShadowFragment` and `createPbrShadowFragment` send a `"csm"`
 * slot to `getCsmStdReceiverFactory()!` / `getCsmPbrReceiverFactory()!`,
 * and the registry those read is populated by one call:
 * `createCsmDirectionalShadowGenerator` sets both factories before it
 * touches the device, so that the cascade WGSL only enters a bundle whose
 * scene created a generator. That factory call IS the opt-in trigger, so
 * this executes it rather than importing the two fragment modules and
 * registering them here — a second detector would decide reachability
 * differently from the pin's own.
 *
 * The device it is handed records nothing: what generation wants from this
 * call is the registration side effect alone. The map's extent, its layer
 * count and its format are the record's and the emitted constants', and the
 * receiver block is written by `_writeCsmUbo`, whose float order generation
 * asserts.
 */
let csmReceiverFactories: Promise<void> | undefined;

export function reachCsmReceiverFactories(
    slots: readonly ShadowLightSlot[],
): Promise<void> {
    if (!slots.some((slot) => slot.shadowType === "csm")) {
        return Promise.resolve();
    }
    csmReceiverFactories ??= (async () => {
        const module = await importPinnedModule<{
            createCsmDirectionalShadowGenerator: (
                engine: unknown,
                light: unknown,
                cfg: Record<string, never>,
            ) => unknown;
        }>("shadow/csm-directional-shadow-generator.js");
        module.createCsmDirectionalShadowGenerator(
            {
                _device: {
                    createTexture: () => ({ createView: () => ({}) }),
                    createSampler: () => ({}),
                    createBuffer: () => ({}),
                    queue: { writeBuffer: () => undefined },
                },
            },
            // The factory stores the light and reads nothing off it.
            { direction: { x: 0, y: -1, z: 0 }, worldMatrixVersion: 0 },
            {},
        );
    })();
    return csmReceiverFactories;
}
