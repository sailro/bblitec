/**
 * Scene-code factories' own option defaults, read from the pin.
 *
 * An intrinsic that seeds a native options record states every member --
 * the records carry no member defaults of their own -- and a member the
 * scene left out takes the factory's own `?? <default>`, read here from
 * that operator through the shared readers in `pinned-option-defaults.ts`.
 * A pin that retunes one regenerates; one that stops defaulting it fails
 * naming the option.
 */
import ts from "typescript";
import { sharedUpstreamStore } from "../upstream-source.js";
import { LoweringContext } from "./context.js";
import {
    nullishFallback,
    pinnedOptionFallback,
    pinnedOptionFlag,
    pinnedOptionNumber,
    pinnedOptionTuple,
    type PinnedOptionSite,
} from "./pinned-option-defaults.js";

let shared: LoweringContext | undefined;

/** The one reader every factory's defaults are folded through. */
function pinnedSource(): LoweringContext {
    shared ??= new LoweringContext(sharedUpstreamStore());
    return shared;
}

/** Memoize one factory's defaults per process, as the pin is fixed. */
function once<T>(read: () => T): () => T {
    let value: T | undefined;
    return () => (value ??= read());
}

/** One pinned factory's declaration and the typed readers over its `??`s. */
function factory(module: string, symbol: string) {
    const context = pinnedSource();
    const { file, declaration } = context.functionDeclaration(module, symbol);
    return {
        context,
        file,
        declaration,
        number: (site: PinnedOptionSite): number =>
            pinnedOptionNumber(context, declaration, site, file),
        flag: (site: PinnedOptionSite): boolean =>
            pinnedOptionFlag(context, declaration, site),
        color: (site: PinnedOptionSite): [number, number, number] =>
            pinnedOptionTuple(context, declaration, site, file),
        string: (site: PinnedOptionSite): string =>
            context.stringValue(
                pinnedOptionFallback(context, declaration, site),
                file,
            ),
        /** A two-lane default (`?? [x, y]`). */
        pair: (site: PinnedOptionSite): readonly [number, number] => {
            const fallback = pinnedOptionFallback(context, declaration, site);
            if (
                !ts.isArrayLiteralExpression(fallback) ||
                fallback.elements.length !== 2
            ) {
                return context.contractError(
                    fallback,
                    "Expected a pinned two-lane default.",
                );
            }
            return [
                context.numericValue(fallback.elements[0]!, file),
                context.numericValue(fallback.elements[1]!, file),
            ];
        },
        /** A default that names one of the pin's own exports. */
        export: (site: PinnedOptionSite): string => {
            const fallback = pinnedOptionFallback(context, declaration, site);
            return ts.isIdentifier(fallback)
                ? fallback.text
                : context.contractError(
                      fallback,
                      "Expected a pinned default naming an export.",
                  );
        },
    };
}

/** `createGridMaterial`'s defaults, one `const <option> = options.<option> ?? <default>` each. */
export const gridMaterialDefaults = once(() => {
    const grid = factory(
        "src/material/grid/grid-material.ts",
        "createGridMaterial",
    );
    return {
        mainColor: grid.color({ local: "mainColor" }),
        lineColor: grid.color({ local: "lineColor" }),
        gridRatio: grid.number({ local: "gridRatio" }),
        gridOffset: grid.color({ local: "gridOffset" }),
        majorUnitFrequency: grid.number({ local: "majorUnitFrequency" }),
        minorUnitVisibility: grid.number({ local: "minorUnitVisibility" }),
        opacity: grid.number({ local: "opacity" }),
        visibility: grid.number({ local: "visibility" }),
        antialias: grid.flag({ local: "antialias" }),
        preMultiplyAlpha: grid.flag({ local: "preMultiplyAlpha" }),
        useMaxLine: grid.flag({ local: "useMaxLine" }),
        backFaceCulling: grid.flag({ local: "backFaceCulling" }),
    };
});

/**
 * `createSprite2DLayer`'s defaults. The pivot is two lanes the pin
 * defaults one at a time (`opts.pivot?.[i] ?? <lane>`), read lane by lane
 * off the layer literal that writes them.
 */
export const sprite2DLayerDefaults = once(() => {
    const layer = factory("src/sprite/sprite-2d.ts", "createSprite2DLayer");
    const pivot = layer.context.unwrapExpression(
        layer.context.propertyInitializer(
            layer.context.objectInitializer(layer.declaration, "layer"),
            "pivot",
        ),
    );
    if (!ts.isArrayLiteralExpression(pivot) || pivot.elements.length !== 2) {
        return layer.context.contractError(
            pivot,
            "Expected createSprite2DLayer to default a two-lane pivot.",
        );
    }
    const lane = (index: number): number =>
        layer.context.numericValue(
            nullishFallback(
                layer.context,
                pivot.elements[index]!,
                `pivot[${index}]`,
            ),
            layer.file,
        );
    return {
        /** The export `blendMode` falls back to (`spriteBlendAlpha`). */
        blendMode: layer.export({ local: "blendMode" }),
        /** `Math.max(1, opts.capacity ?? DEFAULT_CAPACITY)`'s default. */
        capacity: layer.number({ wrapped: "capacity" }),
        depth: layer.string({ local: "depth" }),
        opacity: layer.number({ member: "opacity" }),
        visible: layer.flag({ member: "visible" }),
        order: layer.number({ member: "order" }),
        layerZ: layer.number({ member: "layerZ" }),
        pivot: [lane(0), lane(1)] as const,
    };
});

/**
 * The billboard systems' defaults: `createBillboardSystem`'s own, the
 * opacity `resolveOpacity` resolves, and the axis the facing factory
 * hands it.
 */
export const billboardSystemDefaults = once(() => {
    const module = "src/sprite/billboard-sprite.ts";
    const system = factory(module, "createBillboardSystem");
    const facing = factory(module, "createFacingBillboardSystem");
    const call = facing.context.callExpression(
        facing.declaration,
        "createBillboardSystem",
    );
    const axis = call.arguments[2];
    if (!axis) {
        return facing.context.contractError(
            call,
            "Expected createFacingBillboardSystem to hand its axis on.",
        );
    }
    return {
        blendMode: system.export({ local: "blendMode" }),
        capacity: system.number({ wrapped: "capacity" }),
        visible: system.flag({ member: "visible" }),
        opacity: factory(module, "resolveOpacity").number({
            local: "opacity",
        }),
        facingAxis: facing.context.numericTuple(axis, facing.file),
    };
});

/**
 * `loadSpriteAtlas`'s two premultiplication flags, and the address mode its
 * texture options literal stamps before the caller's spread.
 */
export const loadSpriteAtlasDefaults = once(() => {
    const loader = factory(
        "src/sprite/shared/sprite-atlas.ts",
        "loadSpriteAtlas",
    );
    const texture = loader.context.objectInitializer(
        loader.declaration,
        "texOpts",
    );
    const addressMode = (name: string): string =>
        loader.context.stringValue(
            loader.context.propertyInitializer(texture, name),
            loader.file,
        );
    return {
        premultipliedAlpha: loader.flag({ member: "premultipliedAlpha" }),
        premultiplyOnLoad: loader.flag({ member: "premultiplyOnLoad" }),
        addressModeU: addressMode("addressModeU"),
        addressModeV: addressMode("addressModeV"),
    };
});

/** `createSpriteAtlasFromFrames`'s option and per-frame defaults. */
export const spriteAtlasPackDefaults = once(() => {
    const packer = factory(
        "src/sprite/shared/sprite-atlas-packer.ts",
        "createSpriteAtlasFromFrames",
    );
    return {
        paddingPx: packer.number({ local: "padding" }),
        maxWidthPx: packer.number({ local: "requestedMaxWidth" }),
        sampling: packer.string({ local: "sampling" }),
        premultipliedAlpha: packer.flag({ member: "premultipliedAlpha" }),
        srcX: packer.number({ member: "srcX" }),
        srcY: packer.number({ member: "srcY" }),
        pivot: packer.pair({ member: "pivot" }),
    };
});

/** The clustered light factories' defaults, each its own factory's. */
export const clusteredLightDefaults = once(() => {
    const module = "src/light/clustered.ts";
    const container = factory(module, "createClusteredLightContainer");
    const point = factory(module, "createClusteredPointLight");
    const spot = factory(module, "createClusteredSpotLight");
    return {
        horizontalTiles: container.number({ member: "horizontalTiles" }),
        verticalTiles: container.number({ member: "verticalTiles" }),
        zSlices: container.number({ member: "zSlices" }),
        point: {
            range: point.number({ member: "range" }),
            intensity: point.number({ member: "intensity" }),
        },
        spot: {
            range: spot.number({ member: "range" }),
            intensity: spot.number({ member: "intensity" }),
            angle: spot.number({ member: "angle" }),
        },
    };
});
