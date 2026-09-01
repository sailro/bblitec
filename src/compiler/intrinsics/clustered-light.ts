/**
 * The clustered light field's scene surface.
 *
 * `light/clustered.ts` holds a container as plain data — arrays of point and
 * spot records with a tile/slice configuration — and
 * `addClusteredLightContainer` builds its GPU state from them: three data
 * textures, a params block, and a per-frame `refresh` that re-bins every
 * light against the live camera.
 *
 * All of that is run time here, and measurably so: both reached scenes fill
 * a thousand lights from a seeded PRNG inside a counted loop, which lowers to
 * a native `for` rather than an unrolled table, so the container is a native
 * record filled by the emitted code exactly as the pin fills it.
 *
 * **One fact is compile-time, and it is the one that decides composition.**
 * `createClusteredSpotLight` calls `_enableClusteredSpotSupport`, which
 * installs the stride-3 data layout and registers the spot extension; that
 * extension's `detect` then takes a material over from the point one, so a
 * container that ever held a spot composes a different fragment. The pin
 * reaches that at the spot factory, and so does this.
 */
import ts from "typescript";
import type { ClusteredContainerState, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { validateObjectProperties } from "../option-helpers.js";

export interface ClusteredLightIntrinsicContext extends IntrinsicCallContext {
    fail(node: ts.Node, message: string): never;
    propertyName(name: ts.PropertyName): string | undefined;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        literal: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireDefaultEngine(node: ts.Node): string;
    /** Records that this scene composes the clustered fragment. */
    reachClusteredContainer(
        state: ClusteredContainerState,
        node: ts.Node,
    ): void;
}

/**
 * The two factories a large counted loop may call without being unrolled.
 *
 * Both reached scenes fill a thousand lights from a seeded PRNG inside such a
 * loop. Neither factory records generation-owned state: a light is appended
 * to a container the native side owns, and the only compile-time fact about
 * that container -- whether a spot was ever created, which decides which
 * extension composes the fragment -- follows from the call being REACHED, not
 * from how many times it runs. So the loop stays the `for` the pin itself
 * writes rather than a thousand copies of one statement.
 */
export const runtimeOnlyClusteredLightIntrinsics: readonly string[] = [
    "createClusteredPointLight",
    "createClusteredSpotLight",
];

/** The pinned option names each factory reads, refusing anything else. */
const containerOptions = ["horizontalTiles", "verticalTiles", "zSlices"];
const pointOptions = ["position", "diffuse", "range", "intensity"];
const spotOptions = [...pointOptions, "direction", "angle"];

/** The shared refusal, phrased the way every other factory phrases it. */
function validateOptions(
    context: ClusteredLightIntrinsicContext,
    literal: ts.ObjectLiteralExpression,
    allowed: readonly string[],
    what: string,
): void {
    validateObjectProperties(
        context,
        literal,
        allowed,
        `${what} takes only ${allowed.join(", ")}.`,
    );
}

function containerValue(
    context: ClusteredLightIntrinsicContext,
    expression: ts.Expression,
): { cpp: string; state: ClusteredContainerState } {
    const value = context.compileValue(expression);
    context.expectKind(value, "clustered-light-container", expression);
    const state = value.clusteredContainerState;
    if (!state) {
        context.fail(
            expression,
            "A clustered light container must be a " +
                "`createClusteredLightContainer` value.",
        );
    }
    return { cpp: value.cpp, state };
}

function appendLight(
    context: ClusteredLightIntrinsicContext,
    call: ts.CallExpression,
    spot: boolean,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const container = containerValue(context, call.arguments[0]!);
    if (container.state.frozen) {
        context.fail(
            call,
            "A clustered light created after `addClusteredLightContainer` " +
                "is refused: the pin bakes the light capacity and the " +
                "point-versus-spot data layout when the GPU state is built, " +
                "and its own refresh throws rather than growing either.",
        );
    }
    const engine = context.requireDefaultEngine(call);
    const literal = context.expectObjectLiteral(call.arguments[1]!);
    validateOptions(
        context,
        literal,
        spot ? spotOptions : pointOptions,
        spot ? "createClusteredSpotLight" : "createClusteredPointLight",
    );
    const required = (name: string): ts.Expression => {
        const property = context.objectProperty(literal, name);
        if (!property) {
            context.fail(literal, `A clustered light requires ${name}.`);
        }
        return property;
    };
    const range = context.objectProperty(literal, "range");
    const intensity = context.objectProperty(literal, "intensity");
    // Each `??` is resolved where the pin resolves it, so nothing downstream
    // restates a default: `range ?? 1`, `intensity ?? 1`, `angle ?? PI / 2`.
    const arguments_ = [
        engine,
        container.cpp,
        context.compileVec3(required("position"), "double"),
        context.compileVec3(required("diffuse"), "double"),
        range ? context.compileNumber(range, "double") : "1.0",
        intensity ? context.compileNumber(intensity, "double") : "1.0",
    ];
    if (spot) {
        const angle = context.objectProperty(literal, "angle");
        arguments_.push(
            context.compileVec3(required("direction"), "double"),
            angle
                ? context.compileNumber(angle, "double")
                : `${Math.PI / 2}`,
        );
        container.state.hasSpots = true;
    }
    return {
        kind: "clustered-light",
        cpp:
            `bbl::create_clustered_${spot ? "spot" : "point"}_light(` +
            `${arguments_.join(", ")})`,
        requiresExplicitDiscard: true,
    };
}

export function compileClusteredLightIntrinsic(
    context: ClusteredLightIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createClusteredLightContainer": {
            context.expectArgumentCount(call, 0, 1);
            const engine = context.requireDefaultEngine(call);
            // The pin's own `?? 64` / `?? 64` / `?? 16`; its `| 0` truncation
            // and `Math.max(1, …)` clamp happen where it applies them, in
            // `buildClusteredLightGpuState`, so the values travel unclamped.
            const tiles = ["64.0", "64.0", "16.0"];
            if (call.arguments[0]) {
                const literal = context.expectObjectLiteral(
                    call.arguments[0],
                );
                validateOptions(
                    context,
                    literal,
                    containerOptions,
                    "createClusteredLightContainer",
                );
                containerOptions.forEach((name, index) => {
                    const property = context.objectProperty(literal, name);
                    if (property) {
                        tiles[index] = context.compileNumber(
                            property,
                            "double",
                        );
                    }
                });
            }
            return {
                kind: "clustered-light-container",
                cpp:
                    `bbl::create_clustered_light_container(` +
                    `${engine}, ${tiles.join(", ")})`,
                clusteredContainerState: { hasSpots: false, frozen: false },
            };
        }

        case "createClusteredPointLight":
            return appendLight(context, call, false);

        case "createClusteredSpotLight":
            return appendLight(context, call, true);

        case "addClusteredLightContainer": {
            context.expectArgumentCount(call, 2, 2);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            const container = containerValue(context, call.arguments[1]!);
            if (container.state.frozen) {
                context.fail(
                    call,
                    "A clustered light container is added to one scene: the " +
                        "pin stores it on `scene._clusteredLightContainer` " +
                        "and stamps every material present, so a second call " +
                        "would leave the first scene's materials bound to " +
                        "another scene's textures.",
                );
            }
            container.state.frozen = true;
            context.reachFeature("light:clustered", call);
            context.reachFeature("renderer:scene", call);
            context.reachClusteredContainer(container.state, call);
            return {
                kind: "void",
                cpp:
                    `bbl::add_clustered_light_container(` +
                    `${context.requireDefaultEngine(call)}, ` +
                    `${scene.cpp}, ${container.cpp})`,
            };
        }

        case "markClusteredLightContainerDirty":
            context.fail(
                call,
                "`markClusteredLightContainerDirty` is unreached: no scene " +
                    "mutates a light after building it, so this port has no " +
                    "in-place edit for the call to publish.",
            );
            break;

        default:
            return undefined;
    }
    return undefined;
}
