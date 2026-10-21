/**
 * The members of a streamed Gaussian-splat cloud the application reads and
 * writes: the lowered `GaussianSplatStream` record and its stats
 * (`bblite/upstream_splat_stream.hpp`), read off the pin's own interfaces.
 * A public member is one the interface declares without `@internal`; its
 * native field is the record lowerer's (the pinned name in snake case). The
 * stats are the pin's getters over the stream's mutable snapshot; `rotation`
 * is the stream node's Euler proxy (scene-node.ts `createEulerProxy`), whose
 * writes update the quaternion the world matrix composes.
 */
import ts from "typescript";
import { cppIdentifier, snakeCase } from "../cpp-literals.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { isPinnedType } from "./data-types.js";
import { resolvedSymbol, libraryName } from "./symbols.js";
import { valueKindOf, holdsOnly } from "./type-facts.js";

interface SplatStreamSurfaceContext extends Pick<
    LoweringServices,
    | "checker"
    | "compileValue"
    | "compileNumber"
    | "dataLowerer"
    | "bindings"
    | "emit"
    | "fail"
> {}

/** A public member of a pinned interface, as the record lowerer stores it. */
interface PublicMember {
    readonly name: string;
    readonly field: string;
    readonly type: ts.Type;
    readonly readonly: boolean;
}

/** The member `access` names on `owner`, when the pinned interface declares it publicly. */
function publicMember(
    context: SplatStreamSurfaceContext,
    access: ts.PropertyAccessExpression,
    owner: string,
): PublicMember | undefined {
    const declaration = resolvedSymbol(
        context.checker,
        access,
    )?.declarations?.find(ts.isPropertySignature);
    if (
        !declaration ||
        !ts.isInterfaceDeclaration(declaration.parent) ||
        declaration.parent.name.text !== owner ||
        ts
            .getJSDocTags(declaration)
            .some((tag) => tag.tagName.text === "internal")
    )
        return undefined;
    return {
        name: access.name.text,
        field: cppIdentifier(snakeCase(access.name.text)),
        // The declared type: a read inside a null check narrows its own.
        type: context.checker.getTypeAtLocation(declaration),
        readonly:
            ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
                ) === true,
    };
}

const isNumber = (type: ts.Type): boolean => valueKindOf(type) === "number";

/** A stats value's data type: a number, a phase string, or a nullable number or error. */
function statsValue(
    context: SplatStreamSurfaceContext,
    type: ts.Type,
    read: string,
    site: ts.Node,
): Value {
    if (isNumber(type))
        return context.dataLowerer.leafValue(read, { kind: "number" });
    const members = type.isUnion() ? type.types : [type];
    if (holdsOnly(type, ["string"]))
        return context.dataLowerer.leafValue(read, { kind: "string" });
    const present = members.filter(
        (member) => !(member.flags & ts.TypeFlags.Null),
    );
    if (present.length === 1 && present.length < members.length) {
        if (isNumber(present[0]!))
            return context.dataLowerer.leafValue(read, {
                kind: "optional",
                inner: { kind: "number" },
            });
        // The record stores `Error | null` as an empty js::Error for null.
        if (libraryName(present[0]!) === "Error")
            return context.dataLowerer.leafValue(
                `bbl::splat_stream::stats_error(${read})`,
                { kind: "optional", inner: { kind: "error" } },
            );
    }
    return context.fail(
        site,
        `A stats value of type ${context.checker.typeToString(type)} has no native read.`,
    );
}

/** `stream.<member>` and `stream.stats.<member>`. */
export function readSplatStreamProperty(
    context: SplatStreamSurfaceContext,
    owner: Value,
    name: string,
    site: ts.Node,
): Value | undefined {
    if (
        owner.kind !== "gaussian-splat-stream" &&
        owner.kind !== "splat-stream-stats"
    )
        return undefined;
    const pinned =
        owner.kind === "gaussian-splat-stream"
            ? "GaussianSplatStream"
            : "GaussianSplatStreamStats";
    const member = ts.isPropertyAccessExpression(site)
        ? publicMember(context, site, pinned)
        : undefined;
    if (!member)
        return context.fail(
            site,
            `${pinned}.${name} is not a public member the native stream reads.`,
        );
    if (owner.kind === "splat-stream-stats")
        return statsValue(
            context,
            member.type,
            `(${owner.cpp})->get_${member.field}()`,
            site,
        );
    if (isPinnedType(member.type, ["GaussianSplatStreamStats"]))
        return {
            kind: "splat-stream-stats",
            cpp: `(${owner.cpp})->${member.field}`,
            dataType: { kind: "handle", handle: "splat-stream-stats" },
        };
    if (isNumber(member.type))
        return { kind: "number", cpp: `(${owner.cpp})->${member.field}` };
    const promised = libraryName(member.type) === "Promise";
    if (promised)
        return {
            kind: "promise",
            cpp: `(${owner.cpp})->${member.field}`,
            promiseType: "bbl::js::PromiseVoid",
            promiseResult: { kind: "void", cpp: "" },
        };
    return context.fail(
        site,
        `GaussianSplatStream.${name} of type ${context.checker.typeToString(member.type)} has no native read.`,
    );
}

/** The Euler proxy's axes, in its setter's lane order. */
const EULER_AXES = ["x", "y", "z"];

/**
 * `stream.<member> = v` of a public number the pin lets the application
 * write, and `stream.rotation.<axis> = v`: a plain write of the record's
 * field, and the Euler proxy's setter.
 */
export function emitSplatStreamAssignment(
    context: SplatStreamSurfaceContext,
    expression: ts.BinaryExpression,
): boolean {
    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) return false;
    const streamOwner = (node: ts.Expression): boolean =>
        isPinnedType(context.checker.getTypeAtLocation(node), [
            "GaussianSplatStream",
        ]);
    const rotation =
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "rotation" &&
        streamOwner(left.expression.expression);
    if (!rotation && !streamOwner(left.expression)) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        context.fail(
            expression.operatorToken,
            "A stream member takes a simple assignment natively.",
        );
    if (rotation) {
        const axis = EULER_AXES.indexOf(left.name.text);
        if (axis < 0)
            context.fail(
                left.name,
                `GaussianSplatStream.rotation has no axis '${left.name.text}'.`,
            );
        const stream = context.bindings.pinValueToTemporary(
            context.compileValue(left.expression.expression),
            "stream",
            left.expression,
        );
        context.emit({
            kind: "expression",
            code: `bbl::splat_stream::node_euler_write(*${stream.cpp}, ${axis}, ${context.compileNumber(expression.right, "double")});`,
        });
        return true;
    }
    const member = publicMember(context, left, "GaussianSplatStream");
    if (!member || member.readonly || !isNumber(member.type))
        return context.fail(
            left.name,
            `GaussianSplatStream.${left.name.text} is not a writable stream member.`,
        );
    const stream = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "stream",
        left.expression,
    );
    context.emit({
        kind: "expression",
        code: `(${stream.cpp})->${member.field} = ${context.compileNumber(expression.right, "double")};`,
    });
    return true;
}
