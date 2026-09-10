/**
 * What a pinned factory's config interface declares for each option a scene
 * may write, read from the pin rather than guessed from the literal a scene
 * happened to spell.
 *
 * A factory such as `createBlurPostProcessTask(config, engine, scene)` takes
 * its config first, and the interface that parameter names (own members
 * plus everything it `extends`, followed through the pin's own imports) is
 * the only description of what the factory reads. A literal `{ x, y }` is a
 * vector because the pin declares `direction?: PostProcessVec2`, not because
 * it has two fields; a key the pin does not declare is refused by name, the
 * way `LoweringContext.assertSuppliedOptions` refuses one for a pinned body,
 * because the factory would take its default for it silently.
 */
import { EmissionMap, EmissionSet } from "../emission-transaction.js";
import ts from "typescript";
import { LoweringContext } from "../../lowering/context.js";
import { sharedUpstreamStore } from "../../upstream-source.js";

/** The value shape one declared option takes. */
export type PinnedOptionKind =
    | { readonly kind: "number" }
    | { readonly kind: "boolean" }
    | { readonly kind: "string" }
    /** `{ x, y }`, the pin's own two-component vector interfaces. */
    | { readonly kind: "vector" }
    /** `{ x, y, width, height }`, the pin's normalized viewport. */
    | { readonly kind: "viewport" }
    /** A fixed-length tuple of numbers, forwarded whole. */
    | { readonly kind: "triple" }
    /** A member of one of the pin's own enums, by the enum's name. */
    | { readonly kind: "enum"; readonly name: string };

/** One pinned factory, by the module it lives in and its exported name. */
export interface PinnedFactory {
    readonly module: string;
    readonly factory: string;
}

/** A declared member: where it was declared decides how its type resolves. */
interface DeclaredMember {
    readonly module: string;
    readonly file: ts.SourceFile;
    readonly type: ts.TypeNode;
}

let shared: LoweringContext | undefined;
function pinnedSource(): LoweringContext {
    if (!shared) shared = new LoweringContext(sharedUpstreamStore());
    return shared;
}

const memberCache = new EmissionMap<string, ReadonlyMap<string, DeclaredMember>>();

/** The declared option names of a factory's config, own and inherited. */
export function pinnedOptionNames(factory: PinnedFactory): readonly string[] {
    return [...configMembers(factory).keys()];
}

/**
 * The shape one declared option takes, or undefined when the config does
 * not declare it at all. A declared member whose type is outside the shapes
 * a scene may write (a render target, a task, a camera) is not an option
 * value and is reported as such, because the caller consumes those itself.
 */
export function pinnedOptionKind(
    factory: PinnedFactory,
    key: string,
): PinnedOptionKind | undefined {
    const member = configMembers(factory).get(key);
    if (!member) return undefined;
    return classify(member, key, factory);
}

function configMembers(
    factory: PinnedFactory,
): ReadonlyMap<string, DeclaredMember> {
    const cacheKey = `${factory.module}#${factory.factory}`;
    const cached = memberCache.get(cacheKey);
    if (cached) return cached;
    const source = pinnedSource();
    const { declaration } = source.functionDeclaration(
        factory.module,
        factory.factory,
    );
    const config = declaration.parameters[0]?.type;
    if (
        !config ||
        !ts.isTypeReferenceNode(config) ||
        !ts.isIdentifier(config.typeName)
    ) {
        return source.contractError(
            declaration,
            `Expected ${factory.factory} to take its config interface first.`,
        );
    }
    const members = new EmissionMap<string, DeclaredMember>();
    collectInterfaceMembers(
        source,
        factory.module,
        config.typeName.text,
        members,
        new EmissionSet(),
    );
    memberCache.set(cacheKey, members);
    return members;
}

/**
 * The members an interface declares, own members first so a redeclaration
 * shadows the base, then each `extends` — `Omit<Base, "_shader">` reads as
 * `Base` — followed into the module the pin imports it from.
 */
function collectInterfaceMembers(
    source: LoweringContext,
    module: string,
    name: string,
    members: Map<string, DeclaredMember>,
    visited: Set<string>,
): void {
    const key = `${module}#${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const { file, declaration } = source.interfaceDeclaration(module, name);
    for (const member of declaration.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const memberName = member.name
            ? propertyNameText(member.name)
            : undefined;
        if (memberName === undefined || members.has(memberName)) continue;
        members.set(memberName, { module, file, type: member.type });
    }
    for (const clause of declaration.heritageClauses ?? []) {
        for (const base of clause.types) {
            const baseName = heritageBaseName(source, base);
            const baseModule = declaringModule(source, module, baseName);
            if (baseModule === undefined) {
                source.contractError(
                    base,
                    `${module} neither declares nor imports '${baseName}', which ${name} extends.`,
                );
            }
            collectInterfaceMembers(source, baseModule, baseName, members, visited);
        }
    }
}

/** `Omit<Base, ...>` names `Base`; anything else names itself. */
function heritageBaseName(
    source: LoweringContext,
    base: ts.ExpressionWithTypeArguments,
): string {
    if (!ts.isIdentifier(base.expression)) {
        source.contractError(base, "Expected a named base interface.");
    }
    if (base.expression.text === "Omit") {
        const first = base.typeArguments?.[0];
        if (first && ts.isTypeReferenceNode(first) && ts.isIdentifier(first.typeName)) {
            return first.typeName.text;
        }
        source.contractError(base, "Expected Omit<Base, ...> over a named base.");
    }
    return base.expression.text;
}

/** The module declaring a name: this one, or the one it imports it from. */
function declaringModule(
    source: LoweringContext,
    module: string,
    name: string,
): string | undefined {
    const file = source.sourceFile(module);
    const declaredHere = file.statements.some(
        (statement) =>
            (ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)) &&
            statement.name.text === name,
    );
    return declaredHere ? module : source.moduleOfImport(module, name);
}

function propertyNameText(name: ts.PropertyName): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? name.text
        : undefined;
}

/** The shape a declared type takes, resolving the pin's own type names. */
function classify(
    member: DeclaredMember,
    key: string,
    factory: PinnedFactory,
): PinnedOptionKind {
    const source = pinnedSource();
    const refuse = (node: ts.Node, why: string): never =>
        source.contractError(
            node,
            `${factory.factory} option '${key}' ${why}, which is not a shape a scene may write.`,
        );
    const visit = (type: ts.TypeNode, module: string): PinnedOptionKind => {
        switch (type.kind) {
            case ts.SyntaxKind.NumberKeyword:
                return { kind: "number" };
            case ts.SyntaxKind.BooleanKeyword:
                return { kind: "boolean" };
            case ts.SyntaxKind.StringKeyword:
                return { kind: "string" };
            default:
                break;
        }
        if (ts.isLiteralTypeNode(type)) {
            if (ts.isStringLiteral(type.literal)) return { kind: "string" };
            if (ts.isNumericLiteral(type.literal)) return { kind: "number" };
            return refuse(type, `is the literal type ${type.getText(member.file)}`);
        }
        if (ts.isUnionTypeNode(type)) {
            const present = type.types.filter(
                (option) =>
                    !(ts.isLiteralTypeNode(option) && option.literal.kind === ts.SyntaxKind.NullKeyword) &&
                    option.kind !== ts.SyntaxKind.UndefinedKeyword,
            );
            const kinds = present.map((option) => visit(option, module));
            const first = kinds[0];
            if (first && kinds.every((kind) => kind.kind === first.kind)) return first;
            return refuse(type, "is a union of different shapes");
        }
        if (ts.isTypeOperatorNode(type)) {
            return visit(type.type, module);
        }
        if (ts.isTupleTypeNode(type)) {
            const numbers = type.elements.every(
                (element) => element.kind === ts.SyntaxKind.NumberKeyword,
            );
            if (numbers && type.elements.length === 3) return { kind: "triple" };
            return refuse(type, "is a tuple that is not three numbers");
        }
        if (ts.isTypeLiteralNode(type)) {
            return literalShape(type.members, type);
        }
        if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
            const name = type.typeName.text;
            const declaredIn = declaringModule(source, module, name);
            if (declaredIn === undefined) {
                return refuse(type, `names '${name}', which the pin neither declares nor imports`);
            }
            const file = source.sourceFile(declaredIn);
            for (const statement of file.statements) {
                if (ts.isEnumDeclaration(statement) && statement.name.text === name) {
                    return { kind: "enum", name };
                }
                if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
                    return visit(statement.type, declaredIn);
                }
                if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
                    return literalShape(statement.members, statement);
                }
            }
            return refuse(type, `names '${name}', which ${declaredIn} does not declare`);
        }
        return refuse(type, `is declared as ${type.getText(member.file)}`);
    };
    const literalShape = (
        members: ts.NodeArray<ts.TypeElement>,
        node: ts.Node,
    ): PinnedOptionKind => {
        const names = members.flatMap((element) =>
            ts.isPropertySignature(element) &&
            element.type?.kind === ts.SyntaxKind.NumberKeyword &&
            element.name
                ? [propertyNameText(element.name)]
                : [],
        );
        const exactly = (expected: readonly string[]): boolean =>
            names.length === expected.length &&
            members.length === expected.length &&
            expected.every((field) => names.includes(field));
        if (exactly(["x", "y"])) return { kind: "vector" };
        if (exactly(["x", "y", "width", "height"])) return { kind: "viewport" };
        return refuse(node, "is an object the scene cannot spell as a vector or a viewport");
    };
    return visit(member.type, member.module);
}
