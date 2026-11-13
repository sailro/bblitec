/**
 * `setPbrParallaxOcclusion` and `setStandardParallaxOcclusion`: the props a
 * call passes, member by member, as the native `ParallaxOcclusionProps` the
 * lowered setter validates and stores (`lowering/parallax-occlusion.ts`).
 * Both register their family's extension, which composes at generation.
 */
import ts from "typescript";
import { argumentAt, conditionalExpression, selectionArms } from "../syntax.js";
import type { Value } from "../types.js";
import { absenceOf, knownCondition } from "../values/model.js";
import type { LoweringServices } from "../lowering-services.js";

/** What the setters read and emit through. */
export type ParallaxIntrinsicContext = Pick<
    LoweringServices,
    | "expectArgumentCount"
    | "compileValue"
    | "expectKind"
    | "reachFeature"
    | "sceneManifest"
    | "checker"
    | "dataLowerer"
    | "fail"
    | "unwrap"
    | "allocateTemporaryCppName"
    | "emit"
    | "expectSameEngine"
    | "requireEngine"
    | "propertyAccess"
    | "conditions"
    | "enterRuntimeControlFlow"
    | "leaveRuntimeControlFlow"
    | "captureEmittedLines"
>;

/** The props members, the native field each lands in, and its kind. */
const PROPS_MEMBERS = [
    ["heightScale", "height_scale", "number"],
    ["heightCenter", "height_center", "number"],
    ["heightChannel", "height_channel", "string"],
    ["minSteps", "min_steps", "number"],
    ["maxSteps", "max_steps", "number"],
    ["refinementSteps", "refinement_steps", "number"],
] as const;

/** One member read off the props value, or undefined where it is absent. */
function propsMember(
    context: ParallaxIntrinsicContext,
    owner: Value,
    expression: ts.Expression,
    name: string,
): Value | undefined {
    const type = context.checker.getNonNullableType(
        context.checker.getTypeAtLocation(expression),
    );
    // A literal or helper result without the member leaves it out.
    if (!context.checker.getPropertyOfType(type, name)) return undefined;
    const access = ts.factory.createPropertyAccessChain(
        expression,
        ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
        name,
    );
    const read =
        context.propertyAccess.readResolvedProperty(owner, access) ??
        context.dataLowerer.compilePropertyFromValue(owner, access);
    if (!read)
        return context.fail(
            expression,
            `Parallax occlusion props must be a represented record; '${name}' is not read.`,
        );
    return absenceOf(read) === "undefined" ? undefined : read;
}

/** The props as `std::optional<bbl::ParallaxOcclusionProps>`. */
function compileProps(
    context: ParallaxIntrinsicContext,
    expression: ts.Expression,
    material: Value,
): string {
    const unwrapped = context.unwrap(expression);
    if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return "std::nullopt";
    // `cond ? null : props`: each arm compiles on its own, and only the
    // selected one runs.
    const selection = conditionalExpression(unwrapped);
    if (selection) {
        const [whenTrue, whenFalse] = selectionArms(selection);
        const condition = context.conditions.compileCondition(
            selection.condition,
        );
        const known = knownCondition(condition);
        if (known !== undefined)
            return compileProps(
                context,
                known ? whenTrue : whenFalse,
                material,
            );
        const arm = (node: ts.Expression): string => {
            let cpp = "";
            context.enterRuntimeControlFlow();
            try {
                const lines = context.captureEmittedLines(() => {
                    cpp = compileProps(context, node, material);
                });
                return context.dataLowerer.armExpression(node, lines, cpp);
            } finally {
                context.leaveRuntimeControlFlow();
            }
        };
        return `(${condition} ? ${arm(whenTrue)} : ${arm(whenFalse)})`;
    }
    const owner = context.compileValue(expression);
    // A record the members read twice is held once; a literal generation
    // folded has no run-time value to hold.
    const held: Value =
        owner.cpp === "" || /^[A-Za-z_]\w*$/.test(owner.cpp)
            ? owner
            : {
                  ...owner,
                  cpp: context.allocateTemporaryCppName("parallax_props"),
              };
    if (held !== owner)
        context.emit({
            kind: "declaration",
            type: "const auto&",
            name: held.cpp,
            initializer: owner.cpp,
        });
    const texture = propsMember(context, held, expression, "heightTexture");
    if (!texture)
        return context.fail(
            expression,
            "Parallax occlusion props must name a heightTexture.",
        );
    // A loaded image is its own data; any other texture a program holds is
    // a stored one (`bbl::StoredTexture`).
    const data =
        texture.kind === "texture" &&
        (texture.textureFile !== undefined || texture.textureStorage === "file")
            ? `${texture.cpp}.data`
            : `bbl::stored_texture_data(${context.dataLowerer.compileKnownValueForSink(
                  texture,
                  { kind: "handle", handle: "texture" },
                  expression,
              )})`;
    if (texture.kind === "texture")
        context.expectSameEngine(material, texture, expression);
    const fields = [`.height_texture = ${data}`];
    for (const [name, field, kind] of PROPS_MEMBERS) {
        const member = propsMember(context, held, expression, name);
        if (!member) continue;
        const value =
            kind === "number"
                ? context.dataLowerer.compileKnownValueForSink(
                      member,
                      { kind: "optional", inner: { kind: "number" } },
                      expression,
                  )
                : context.dataLowerer.compileKnownValueForSink(
                      member,
                      { kind: "optional", inner: { kind: "string" } },
                      expression,
                  );
        fields.push(`.${field} = (${value}).to_optional()`);
    }
    return `std::optional<bbl::ParallaxOcclusionProps>{bbl::ParallaxOcclusionProps{${fields.join(", ")}}}`;
}

export function compileSetParallaxOcclusion(
    context: ParallaxIntrinsicContext,
    call: ts.CallExpression,
    family: "pbr" | "standard",
): Value {
    context.expectArgumentCount(call, 2, 2);
    const material = context.compileValue(argumentAt(call, 0));
    context.expectKind(material, "material", argumentAt(call, 0));
    const props = compileProps(context, argumentAt(call, 1), material);
    context.reachFeature("material:parallax-occlusion", call);
    context.reachFeature(
        family === "pbr" ? "material:pbr" : "material:standard",
        call,
    );
    // A PBR material composes from what it holds when first drawn, and a
    // write can set or clear it: both states compose.
    if (family === "pbr")
        context.sceneManifest.recordPbrStateWrite(material, {
            parallaxOcclusion: true,
        });
    return {
        kind: "void",
        cpp: `bbl::set_parallax_occlusion(${context.requireEngine(material, call)}, ${material.cpp}, ${props})`,
    };
}
