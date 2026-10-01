import { writable } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
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
import { argumentAt } from "../syntax.js";
import type { ClusteredContainerState, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { validateObjectProperties } from "../option-helpers.js";
import { clusteredOptionFields } from "../../lowering/clustered-light-lowerer.js";
import { sharedPinnedContext } from "../../lowering/context.js";

export interface ClusteredLightIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "fail"
            | "propertyName"
            | "expectObjectLiteral"
            | "objectProperty"
            | "compileVec3"
            | "compileNumber"
            | "requireDefaultEngine"
            | "sceneManifest"
        > {}

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

/**
 * One factory's options as the native struct the lowered factory takes:
 * each option the scene named, in the pin's own interface order, and the
 * rest absent so the factory's own `??` resolves them. An option the
 * interface does not declare refuses, and a required one left out refuses.
 */
function optionsCpp(
    context: ClusteredLightIntrinsicContext,
    literal: ts.ObjectLiteralExpression | undefined,
    interfaceName: string,
    what: string,
    at: ts.Node,
): string {
    const fields = clusteredOptionFields(sharedPinnedContext(), interfaceName);
    if (literal) {
        validateOptions(
            context,
            literal,
            fields.map((field) => field.name),
            what,
        );
    }
    const named = fields.flatMap((field) => {
        const property = literal
            ? context.objectProperty(literal, field.name)
            : undefined;
        if (!property) {
            if (!field.optional) {
                context.fail(literal ?? at, `${what} requires ${field.name}.`);
            }
            return [];
        }
        return [
            `.${field.name} = ${
                field.kind === "vec3"
                    ? context.compileVec3(property, "double")
                    : context.compileNumber(property, "double")
            }`,
        ];
    });
    return `bbl::${interfaceName}{${named.join(", ")}}`;
}

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
    const container = containerValue(context, argumentAt(call, 0));
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
    const literal = context.expectObjectLiteral(argumentAt(call, 1));
    // Each `??` is resolved by the lowered factory itself, from the pin's
    // own default, so the call site names only what the scene named.
    const options = spot
        ? optionsCpp(
              context,
              literal,
              "ClusteredSpotLightOptions",
              "createClusteredSpotLight",
              call,
          )
        : optionsCpp(
              context,
              literal,
              "ClusteredPointLightOptions",
              "createClusteredPointLight",
              call,
          );
    if (spot) {
        writable(container.state).hasSpots = true;
    }
    return {
        kind: "clustered-light",
        cpp:
            `bbl::create_clustered_${spot ? "spot" : "point"}_light(` +
            `${engine}, ${container.cpp}, ${options})`,
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
            // The pin's own `??` defaults resolve in the lowered factory,
            // and its `| 0` truncation and `Math.max(1, …)` clamp where it
            // applies them, in `buildClusteredLightGpuState`.
            const options = optionsCpp(
                context,
                call.arguments[0]
                    ? context.expectObjectLiteral(call.arguments[0])
                    : undefined,
                "ClusteredLightContainerOptions",
                "createClusteredLightContainer",
                call,
            );
            return {
                kind: "clustered-light-container",
                cpp:
                    `bbl::create_clustered_light_container(` +
                    `${engine}, ${options})`,
                clusteredContainerState: { hasSpots: false, frozen: false },
            };
        }

        case "createClusteredPointLight":
            return appendLight(context, call, false);

        case "createClusteredSpotLight":
            return appendLight(context, call, true);

        case "addClusteredLightContainer": {
            context.expectArgumentCount(call, 2, 2);
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
            const container = containerValue(context, argumentAt(call, 1));
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
            writable(container.state).frozen = true;
            context.reachFeature("light:clustered", call);
            context.reachFeature("renderer:scene", call);
            context.sceneManifest.reachClusteredContainer(
                container.state,
                call,
            );
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
