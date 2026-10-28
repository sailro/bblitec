/**
 * The lowered libraries a program calls (`LOWERED_LIBRARIES`), and the
 * members of their records an application reads and writes, read off the
 * pin's own interfaces: a public member is one the interface declares
 * without `@internal`, and its native field is the record lowerer's (the
 * pinned name in snake case).
 */
import ts from "typescript";
import { cppIdentifier, snakeCase } from "../cpp-literals.js";
import { sharedPinnedContext } from "../lowering/context.js";
import type { LoweredLibrary } from "../lowering/library-runtime.js";
import { MESH_LOD_LIBRARY } from "../lowering/mesh-lod-library.js";
import type { PinnedRecordModel } from "../lowering/pinned-record-lowerer.js";
import {
    isPrimitiveShape,
    type RecordShape,
} from "../lowering/record-shapes.js";
import { SPLAT_STREAM_LIBRARY } from "../lowering/splat-stream-library.js";
import { isPinnedType, pinnedRecordHandleKind } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { resolvedSymbol } from "./symbols.js";
import { inheritsFrom } from "./type-facts.js";
import type { Feature, Value } from "./types.js";

/** A public member of a pinned interface, as the record lowerer stores it. */
export interface PublicMember {
    readonly name: string;
    readonly field: string;
    readonly type: ts.Type;
    readonly readonly: boolean;
}

/**
 * The interfaces a member read off `owner` may be declared in: the record's
 * own, and the one the program reads it as (`type`, an interface the record
 * extends) with every interface that one extends.
 */
function declaringInterfaces(
    type: ts.Type,
    owner: string,
): ReadonlySet<string> {
    const names = new Set([owner]);
    inheritsFrom(type, (current) => {
        if (current.isClassOrInterface()) names.add(current.symbol.name);
        return false;
    });
    return names;
}

/** A pinned member the library keeps to itself (`@internal`), which no program reads or sets. */
export function internalMember(declaration: ts.Declaration): boolean {
    return ts
        .getJSDocTags(declaration)
        .some((tag) => tag.tagName.text === "internal");
}

/**
 * The member `access` names on `owner`, when the pinned interface or one it
 * extends declares it publicly.
 */
export function publicMember(
    checker: ts.TypeChecker,
    access: ts.PropertyAccessExpression,
    owner: string,
): PublicMember | undefined {
    return publicMemberNamed(
        checker,
        resolvedSymbol(checker, access),
        checker.getTypeAtLocation(access.expression),
        access.name.text,
        owner,
    );
}

/** The member `name` of `symbol` on a value of `ownerType`, when declared publicly. */
function publicMemberNamed(
    checker: ts.TypeChecker,
    symbol: ts.Symbol | undefined,
    ownerType: ts.Type,
    name: string,
    owner: string,
): PublicMember | undefined {
    const declaration = symbol?.declarations?.find(ts.isPropertySignature);
    if (
        !declaration ||
        !ts.isInterfaceDeclaration(declaration.parent) ||
        !declaringInterfaces(ownerType, owner).has(
            declaration.parent.name.text,
        ) ||
        internalMember(declaration)
    )
        return undefined;
    return {
        name,
        field: cppIdentifier(snakeCase(name)),
        // The declared type: a read inside a null check narrows its own.
        type: checker.getTypeAtLocation(declaration),
        readonly:
            ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
                ) === true,
    };
}

/**
 * The lowered libraries a program calls, each with the feature its calls
 * reach and what a scene argument reaches (the library draws in the
 * scene's own pass).
 */
export const LOWERED_LIBRARIES: readonly {
    readonly library: LoweredLibrary;
    readonly feature: Feature;
    readonly sceneFeatures: readonly Feature[];
}[] = [
    {
        library: SPLAT_STREAM_LIBRARY,
        feature: "loader:splat-stream",
        sceneFeatures: ["renderer:scene", "renderer:geometry-output"],
    },
    {
        library: MESH_LOD_LIBRARY,
        feature: "loader:mesh-lod",
        sceneFeatures: ["renderer:scene"],
    },
];

/** The record model of the lowered library a public record of this name belongs to. */
export function loweredRecordModel(
    record: string,
): PinnedRecordModel | undefined {
    return LOWERED_LIBRARIES.find(({ library }) =>
        library.records.includes(record),
    )?.library.model(sharedPinnedContext());
}

type LoweredRecordContext = Pick<LoweringServices, "checker" | "fail"> & {
    readonly dataLowerer: Pick<LoweringServices["dataLowerer"], "leafValue">;
};

/**
 * A member's value as the application holds it, from the record model's
 * shape of it and its native read.
 */
function loweredMemberValue(
    context: LoweredRecordContext,
    shape: RecordShape,
    read: string,
): Value | undefined {
    switch (shape.kind) {
        case "number":
        case "boolean":
        case "string":
            return context.dataLowerer.leafValue(read, { kind: shape.kind });
        case "optional": {
            const inner = shape.value.kind;
            if (inner === "number" || inner === "boolean" || inner === "string")
                return context.dataLowerer.leafValue(read, {
                    kind: "optional",
                    inner: { kind: inner },
                });
            // A record the program holds, or none: the record stores none
            // as a null handle.
            if (inner === "record") {
                const handle = pinnedRecordHandleKind(shape.value.name);
                return handle
                    ? context.dataLowerer.leafValue(
                          `bbl::library::nullable_handle(${read})`,
                          {
                              kind: "optional",
                              inner: { kind: "handle", handle },
                          },
                      )
                    : undefined;
            }
            // The record stores `Error | null` as an empty js::Error for null.
            if (inner === "error")
                return context.dataLowerer.leafValue(
                    `bbl::library::nullable_error(${read})`,
                    { kind: "optional", inner: { kind: "error" } },
                );
            return undefined;
        }
        case "record": {
            const handle = pinnedRecordHandleKind(shape.name);
            return handle
                ? context.dataLowerer.leafValue(read, {
                      kind: "handle",
                      handle,
                  })
                : undefined;
        }
        case "tuple":
            return shape.elements.every((element) => element.kind === "number")
                ? context.dataLowerer.leafValue(read, {
                      kind: "tuple",
                      arity: shape.elements.length,
                  })
                : undefined;
        case "typed":
            return context.dataLowerer.leafValue(read, { kind: shape.element });
        case "promise":
            return shape.value.kind === "void"
                ? {
                      kind: "promise",
                      cpp: read,
                      promiseType: "bbl::js::PromiseVoid",
                      promiseResult: { kind: "void", cpp: "" },
                  }
                : undefined;
        default:
            return undefined;
    }
}

/**
 * `record.<member>` of a lowered library's public record: the record model's
 * own read of the member (a field, an accessor's getter), held as the
 * application holds its shape.
 */
export function readLoweredRecordProperty(
    context: LoweredRecordContext,
    owner: Value,
    access: ts.PropertyAccessExpression,
): Value | undefined {
    // The value is the record its handle names, whichever declared type
    // (an interface it extends) the program reads it as.
    const held = heldRecord(owner);
    if (!held) return undefined;
    const { library, record } = held;
    if (!publicMember(context.checker, access, record))
        return context.fail(
            access,
            `${record}.${access.name.text} is not a public member the native library reads.`,
        );
    const model = library.model(sharedPinnedContext());
    const name = access.name.text;
    const shape = model.memberShape(record, name);
    return (
        loweredMemberValue(
            context,
            shape,
            model.memberRead(`(${owner.cpp})`, record, name),
        ) ??
        context.fail(
            access,
            `${record}.${name} of type ${context.checker.typeToString(context.checker.getTypeAtLocation(access))} has no native read.`,
        )
    );
}

type LoweredRecordStoreContext = Pick<
    LoweringServices,
    "checker" | "fail" | "emit"
> & {
    readonly dataLowerer: Pick<
        LoweringServices["dataLowerer"],
        "compileKnownValueForSink"
    >;
};

/**
 * The lowered library record a value holds, with its library: the record its
 * handle kind names, typed or not.
 */
export function heldRecord(
    owner: Value,
): { library: LoweredLibrary; record: string } | undefined {
    const handle =
        owner.dataType?.kind === "handle" ? owner.dataType.handle : owner.kind;
    for (const { library } of LOWERED_LIBRARIES) {
        const record = library.records.find(
            (name) => pinnedRecordHandleKind(name) === handle,
        );
        if (record) return { library, record };
    }
    return undefined;
}

/**
 * A value the program writes as the record model stores a member of
 * `shape`: a primitive, or the arm of a primitive union it is
 * (`renderScale: number | "auto"`).
 */
function loweredMemberStore(
    context: LoweredRecordStoreContext,
    model: PinnedRecordModel,
    shape: RecordShape,
    value: Value,
    site: ts.Node,
): string | undefined {
    if (isPrimitiveShape(shape))
        return context.dataLowerer.compileKnownValueForSink(
            value,
            { kind: shape.kind },
            site,
        );
    if (shape.kind !== "variant") return undefined;
    // A union the program holds (`std::variant` of its members): the arm it
    // holds, in the record's union.
    if (value.dataType?.kind === "union")
        return `bbl::pinned::variant_cast<${model.cppType(shape)}>(${value.cpp})`;
    const held = value.dataType?.kind ?? value.kind;
    const arm = shape.members.find(
        (member) => isPrimitiveShape(member) && member.kind === held,
    );
    return arm && isPrimitiveShape(arm)
        ? `${model.cppType(shape)}(${context.dataLowerer.compileKnownValueForSink(value, { kind: arm.kind }, site)})`
        : undefined;
}

/**
 * `record.<name> = value` of a lowered library's public record the program
 * holds (`owner`, of `ownerType`): the record model's own store of the
 * member, the value as its shape takes it.
 */
export function storeLoweredRecordProperty(
    context: LoweredRecordStoreContext,
    owner: Value,
    ownerType: ts.Type,
    name: string,
    value: Value,
    site: ts.Node,
): void {
    const held = heldRecord(owner);
    if (!held)
        return context.fail(
            site,
            `.${name} is written on a value no native library record holds.`,
        );
    const { library, record } = held;
    const member = publicMemberNamed(
        context.checker,
        ownerType.getProperty(name),
        ownerType,
        name,
        record,
    );
    if (!member || member.readonly)
        return context.fail(
            site,
            `${record}.${name} is not a public member the program writes.`,
        );
    const model = library.model(sharedPinnedContext());
    const stored =
        loweredMemberStore(
            context,
            model,
            model.memberShape(record, name),
            value,
            site,
        ) ??
        context.fail(
            site,
            `${record}.${name} takes no ${value.dataType?.kind ?? value.kind} natively.`,
        );
    context.emit({
        kind: "expression",
        code: `${model.memberWrite(`(${owner.cpp})`, record, name, stored)};`,
    });
}

/** The lowered libraries' scene nodes a program holds (`library::SceneNode`). */
const LIBRARY_NODES = LOWERED_LIBRARIES.map(({ library }) => library.node);

/**
 * `node.parent = mesh` or `= null` on a lowered library's scene node: the
 * node composes its world under the native mesh's
 * (`library::set_node_parent`), read when the node's world is.
 */
export function emitLibraryNodeParent(
    context: Pick<
        LoweringServices,
        | "bindings"
        | "checker"
        | "compileValue"
        | "emit"
        | "fail"
        | "reachFeature"
        | "requireEngine"
    >,
    expression: ts.BinaryExpression,
): boolean {
    const left = expression.left;
    if (
        !ts.isPropertyAccessExpression(left) ||
        left.name.text !== "parent" ||
        !isPinnedType(
            context.checker.getTypeAtLocation(left.expression),
            LIBRARY_NODES,
        )
    )
        return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return context.fail(
            expression.operatorToken,
            "A library node's parent takes a simple assignment natively.",
        );
    const node = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "library_node",
        left.expression,
    );
    if (expression.right.kind === ts.SyntaxKind.NullKeyword) {
        context.emit({
            kind: "expression",
            code: `bbl::library::clear_node_parent(*${node.cpp});`,
        });
        return true;
    }
    const parent = context.compileValue(expression.right);
    if (parent.kind !== "mesh")
        return context.fail(
            expression.right,
            "A library node's parent is a mesh natively.",
        );
    context.reachFeature("mesh:geometry-access", expression);
    context.emit({
        kind: "expression",
        code: `bbl::library::set_node_parent(*${node.cpp}, bbl::StoredEngine(${context.requireEngine(parent, expression.right)}), ${parent.cpp});`,
    });
    return true;
}
