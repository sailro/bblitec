import ts from "typescript";
import { declaredSymbol, resolvedSymbol } from "../compiler/symbols.js";
import { doubleLiteral } from "../cpp-literals.js";
import { cppCondition } from "../cpp-expressions.js";
import { moduleScopeVariable } from "../pinned-program.js";
import type { LoweringContext } from "./context.js";
import { CPP_SCALAR } from "./cpp-types.js";
import {
    PinnedNumericLowerer,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/**
 * A value of the character controller's reference kernel: its C++ spelling
 * and representation. A representation is `number`, `boolean`, `string`,
 * `void`, `object` (a weak identity), a record name (`js::Ref<Record>`),
 * `T[]` (`js::Array<T>`), `optional:T`, `tuple:[...]`, `map:[K, V]`,
 * `weakmap:V` or `function:R` (a closure returning R).
 */
export interface KernelValue {
    cpp: string;
    type: string;
    /** Where a read aliases storage another owner can change. */
    borrowed?: "mutable" | "stable";
}

/** A callee the kernel lowers a call of: a pinned helper or method, or a native. */
export interface KernelFunction {
    cpp: string;
    parameters: readonly string[];
    requiredParameters: number;
    returns: string;
    borrowedParameters?: ReadonlySet<number>;
}

export interface KernelSchema {
    /** Every record the kernel stores, with its fields' representations. */
    records: ReadonlyMap<string, ReadonlyMap<string, string>>;
    /** Callees, by the declaration the typed program resolves a call to. */
    functions: ReadonlyMap<ts.Declaration, KernelFunction>;
    /** What a declaration holds when a body starts: fields, parameters, constants. */
    values: Map<ts.Declaration, KernelValue>;
    /**
     * Representations of declarations the pin types `any`, which only the
     * transport knows.
     */
    declared: ReadonlyMap<ts.Declaration, string>;
    /** The representation of the pin's `unknown` (a body identity). */
    unknown?: string;
    returnType: string;
    /** Fields whose owned assignment stays the stable source for later reads. */
    ownedAssignments?: ReadonlySet<ts.Declaration>;
    /** Native transport the caller lowers before the kernel does. */
    expression?: (
        node: ts.Expression,
        expected: string | undefined,
        lowerer: CharacterKernelLowerer,
    ) => KernelValue | undefined;
    statement?: (
        node: ts.Statement,
        lowerer: CharacterKernelLowerer,
        indent: string,
    ) => string | undefined;
}

export const kernelTuple = (types: readonly string[]): string =>
    `tuple:${JSON.stringify(types)}`;

function typeList(type: string, prefix: string): string[] | undefined {
    if (!type.startsWith(prefix)) return undefined;
    const types: unknown = JSON.parse(type.slice(prefix.length));
    if (
        !Array.isArray(types) ||
        !types.every(
            (value: unknown): value is string => typeof value === "string",
        )
    ) {
        throw new Error(`Kernel types must be a string array: ${type}.`);
    }
    return types;
}

const tupleTypes = (type: string): string[] | undefined =>
    typeList(type, "tuple:");

function mapTypes(type: string): readonly [string, string] | undefined {
    if (type.startsWith("weakmap:")) return ["object", type.slice(8)];
    const types = typeList(type, "map:");
    if (!types) return undefined;
    if (types.length !== 2) {
        throw new Error("Kernel map storage requires key and value types.");
    }
    return [types[0]!, types[1]!];
}

const isScalar = (type: string): boolean =>
    type === "number" || type === "boolean";

/** The storage of a kernel representation. */
export function kernelStorage(
    type: string,
    records: ReadonlyMap<string, unknown>,
): string {
    if (type === "number") return CPP_SCALAR.number;
    if (type === "boolean") return CPP_SCALAR.boolean;
    if (type === "string") return CPP_SCALAR.string;
    if (type === "void") return "void";
    if (type === "object") return "js::WeakIdentity";
    if (type.startsWith("weakmap:"))
        return `js::WeakMap<${kernelStorage(type.slice(8), records)}>`;
    if (type.startsWith("optional:"))
        return `std::optional<${kernelStorage(type.slice(9), records)}>`;
    const tuple = tupleTypes(type);
    if (tuple)
        return `std::tuple<${tuple.map((type) => kernelStorage(type, records)).join(", ")}>`;
    if (type.startsWith("map:"))
        return `js::Map<${mapTypes(type)!
            .map((type) => kernelStorage(type, records))
            .join(", ")}>`;
    if (type.endsWith("[]"))
        return `js::Array<${kernelStorage(type.slice(0, -2), records)}>`;
    if (records.has(type)) return `js::Ref<${type}>`;
    throw new Error(`Kernel storage is not represented: ${type}.`);
}

/**
 * The character controller's reference-bearing bodies, lowered by the
 * shared numeric translator. Control flow, scalar locals, loops, switches,
 * arithmetic and stores are PinnedNumericLowerer's; this seam owns only the
 * representation of reference values -- records behind `js::Ref`, arrays,
 * maps, tuples, optionals and closures -- and resolves every name, member
 * and callee through the typed pinned program rather than its spelling.
 */
export class CharacterKernelLowerer extends PinnedNumericLowerer {
    private temporary = 0;
    private readonly checker: ts.TypeChecker;
    private readonly numeric: PinnedNumericScope;

    public constructor(
        private readonly context: LoweringContext,
        file: ts.SourceFile,
        private readonly schema: KernelSchema,
    ) {
        const numeric: PinnedNumericScope = {
            bindings: new Map(),
            calls: pinnedNumericMathCalls(),
            booleanAnd: true,
            booleanOr: true,
            localPrefix: "local_",
        };
        super(file, numeric);
        this.numeric = numeric;
        this.checker = context.program.checkerFor(file);
        if (schema.returnType !== "void")
            numeric.returnValue = (expression) =>
                expression
                    ? this.value(expression, schema.returnType).cpp
                    : this.refuse(
                          file,
                          "A pinned kernel function with a value returns one.",
                      );
    }

    // ── Representation ────────────────────────────────────────────────────

    public storage(type: string): string {
        return kernelStorage(type, this.schema.records);
    }

    private refuse(node: ts.Node, message: string): never {
        return this.context.contractError(node, message);
    }

    private isLibrary(symbol: ts.Symbol | undefined, name: string): boolean {
        return (
            symbol?.getName() === name &&
            (symbol.declarations ?? []).some((declaration) =>
                this.context.program.program.isSourceFileDefaultLibrary(
                    declaration.getSourceFile(),
                ),
            )
        );
    }

    /** The kernel representation of a checker type. */
    public representation(type: ts.Type, at: ts.Node): string {
        const flags = type.flags;
        if (flags & ts.TypeFlags.NumberLike) return "number";
        if (flags & ts.TypeFlags.BooleanLike) return "boolean";
        if (flags & ts.TypeFlags.StringLike) return "string";
        if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return "void";
        if (flags & ts.TypeFlags.NonPrimitive) return "object";
        if (flags & ts.TypeFlags.Unknown && this.schema.unknown)
            return this.schema.unknown;
        if (type.isUnion()) {
            const present = type.types.filter(
                (member) =>
                    !(
                        member.flags &
                        (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                    ),
            );
            if (
                present.length === type.types.length &&
                present.every(
                    (member) => member.flags & ts.TypeFlags.NumberLike,
                )
            )
                return "number";
            if (present.length === 1) {
                const value = this.representation(present[0]!, at);
                return this.schema.records.has(value) ||
                    present.length === type.types.length
                    ? value
                    : `optional:${value}`;
            }
        }
        const symbol = type.getSymbol();
        if (this.checker.isTupleType(type))
            return kernelTuple(
                this.checker
                    .getTypeArguments(type as ts.TypeReference)
                    .map((element) => this.representation(element, at)),
            );
        // An array, or anything the pin indexes by number as one: a typed
        // array, `ArrayLike<number>`, the `Mat4` brand.
        const indexed = type.getNumberIndexType();
        if (indexed) return `${this.representation(indexed, at)}[]`;
        if (
            this.isLibrary(symbol, "Map") ||
            this.isLibrary(symbol, "WeakMap")
        ) {
            const [key, value] = this.checker
                .getTypeArguments(type as ts.TypeReference)
                .map((argument) => this.representation(argument, at));
            return symbol!.getName() === "WeakMap" && key === "object"
                ? `weakmap:${value}`
                : `map:${JSON.stringify([key, value])}`;
        }
        const signatures = type.getCallSignatures();
        if (signatures.length === 1 && signatures[0]!.parameters.length === 0)
            return `function:${this.representation(
                this.checker.getReturnTypeOfSignature(signatures[0]!),
                at,
            )}`;
        const name = type.aliasSymbol?.getName() ?? symbol?.getName();
        if (name && this.schema.records.has(name)) return name;
        if (type.flags & ts.TypeFlags.Object) {
            // An object literal's own type: the one record declaring exactly
            // its members.
            const members = this.checker
                .getPropertiesOfType(type)
                .map((property) => property.getName())
                .sort();
            const matches = [...this.schema.records].filter(
                ([, fields]) =>
                    fields.size > 0 &&
                    fields.size === members.length &&
                    members.every((member) => fields.has(member)),
            );
            if (matches.length === 1) return matches[0]![0];
        }
        return this.refuse(
            at,
            `Pinned kernel type '${this.checker.typeToString(type)}' has no native representation.`,
        );
    }

    /** What a declaration of the pin is represented as. */
    public declarationType(declaration: ts.Declaration): string {
        const declared = this.schema.declared.get(declaration);
        if (declared) return declared;
        // A record named by an alias (`TransformNode` for the scene node)
        // is the record the annotation resolves to.
        const annotation =
            ts.isPropertyDeclaration(declaration) ||
            ts.isParameter(declaration) ||
            ts.isVariableDeclaration(declaration) ||
            ts.isPropertySignature(declaration)
                ? declaration.type
                : undefined;
        const named =
            annotation && ts.isTypeReferenceNode(annotation)
                ? declaredSymbol(this.checker, annotation.typeName)?.getName()
                : undefined;
        if (named && this.schema.records.has(named)) return named;
        const name = ts.getNameOfDeclaration(declaration) ?? declaration;
        return this.representation(
            this.checker.getTypeAtLocation(name),
            declaration,
        );
    }

    /** A signature's parameter and return representations. */
    public signature(declaration: ts.SignatureDeclaration): {
        parameters: string[];
        returns: string;
    } {
        const signature = this.checker.getSignatureFromDeclaration(declaration);
        if (!signature)
            return this.refuse(declaration, "Pinned kernel signature.");
        return {
            parameters: declaration.parameters.map((parameter) =>
                this.declarationType(parameter),
            ),
            returns:
                this.schema.declared.get(declaration) ??
                this.representation(
                    this.checker.getReturnTypeOfSignature(signature),
                    declaration,
                ),
        };
    }

    /** The declaration a pinned name resolves to. */
    public declaration(identifier: ts.Identifier): ts.Declaration | undefined {
        return this.context.declarationOf(identifier);
    }

    private member(
        node: ts.PropertyAccessExpression,
    ): ts.Declaration | undefined {
        const symbol = resolvedSymbol(this.checker, node);
        return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    }

    /** A representation the checker gives a scalar expression, where it does. */
    private scalarType(node: ts.Expression): string | undefined {
        if (ts.isIdentifier(node)) {
            const binding = this.numeric.bindings.get(node.text);
            if (binding) return binding.type === "bool" ? "boolean" : "number";
        }
        const type = this.checker.getTypeAtLocation(node);
        if (type.flags & ts.TypeFlags.Any) return undefined;
        if (type.flags & ts.TypeFlags.NumberLike) return "number";
        if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
        if (
            type.isUnion() &&
            type.types.every((member) => member.flags & ts.TypeFlags.NumberLike)
        )
            return "number";
        return undefined;
    }

    private owned(value: KernelValue): string {
        return isScalar(value.type) ||
            value.type === "void" ||
            value.type.startsWith("function:") ||
            !value.borrowed
            ? value.cpp
            : `js::snapshot_value(${value.cpp})`;
    }

    // ── Statements ────────────────────────────────────────────────────────

    public override statement(
        statement: ts.Statement,
        indent: string,
    ): string[] {
        const adapted = this.schema.statement?.(statement, this, indent);
        if (adapted !== undefined) return [adapted];
        if (ts.isVariableStatement(statement))
            return statement.declarationList.declarations.flatMap(
                (declaration) =>
                    this.declarationLines(statement, declaration, indent),
            );
        if (ts.isExpressionStatement(statement)) {
            const lines = this.referenceStatement(statement, indent);
            if (lines) return lines;
        }
        if (ts.isForOfStatement(statement))
            return this.forOf(statement, indent);
        return super.statement(statement, indent);
    }

    /** Statements over a list of pinned statements, in a scope of their own. */
    public body(statements: readonly ts.Statement[], indent: string): string {
        return this.withBindings(() =>
            this.statements(statements, indent),
        ).join("\n");
    }

    private declarationLines(
        statement: ts.VariableStatement,
        declaration: ts.VariableDeclaration,
        indent: string,
    ): string[] {
        const stable =
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        if (!declaration.initializer)
            return this.refuse(
                declaration,
                "Pinned kernel local requires an initializer.",
            );
        if (ts.isArrayBindingPattern(declaration.name))
            return this.destructuring(
                declaration.name,
                declaration.initializer,
                stable,
                indent,
            );
        if (!ts.isIdentifier(declaration.name))
            return this.refuse(
                declaration,
                "Pinned kernel local must be named.",
            );
        const expected = declaration.type
            ? this.declarationType(declaration)
            : undefined;
        if (
            isScalar(expected ?? this.scalarType(declaration.initializer) ?? "")
        ) {
            // A number or boolean is the numeric translator's own local.
            return super.statement(
                ts.factory.updateVariableStatement(
                    statement,
                    statement.modifiers,
                    ts.factory.updateVariableDeclarationList(
                        statement.declarationList,
                        [declaration],
                    ),
                ),
                indent,
            );
        }
        const value = this.value(declaration.initializer, expected);
        const cpp = this.localName(declaration.name.text);
        this.schema.values.set(declaration, {
            cpp,
            type: value.type,
            ...(isScalar(value.type)
                ? {}
                : { borrowed: stable ? "stable" : "mutable" }),
        });
        return [
            `${indent}${value.type.startsWith("function:") ? "auto" : this.storage(value.type)} ${cpp} = ${this.owned(value)};`,
        ];
    }

    private destructuring(
        pattern: ts.ArrayBindingPattern,
        initializer: ts.Expression,
        stable: boolean,
        indent: string,
    ): string[] {
        const value = this.value(initializer);
        const fields = tupleTypes(value.type);
        if (!fields || pattern.elements.length > fields.length)
            return this.refuse(
                pattern,
                "Pinned tuple destructuring requires represented fields.",
            );
        const temporary = `tuple_${this.temporary++}`;
        const lines = [`${indent}auto ${temporary} = ${this.owned(value)};`];
        pattern.elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element)) return;
            if (
                !ts.isIdentifier(element.name) ||
                element.initializer ||
                element.dotDotDotToken
            )
                this.refuse(
                    element,
                    "Pinned tuple binding must be an ordinary name.",
                );
            const cpp = this.localName(element.name.text);
            this.schema.values.set(element, {
                cpp,
                type: fields[index]!,
                borrowed: stable ? "stable" : "mutable",
            });
            const selected: KernelValue = {
                cpp: `std::get<${index}>(${temporary})`,
                type: fields[index]!,
                borrowed: "mutable",
            };
            lines.push(`${indent}auto ${cpp} = ${this.owned(selected)};`);
        });
        return lines;
    }

    /** The statements whose store is a reference operation of its own. */
    private referenceStatement(
        statement: ts.ExpressionStatement,
        indent: string,
    ): string[] | undefined {
        const expression = this.context.unwrapExpression(statement.expression);
        if (!ts.isBinaryExpression(expression)) return undefined;
        const kind = expression.operatorToken.kind;
        if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
            return [`${indent}${this.value(expression).cpp};`];
        if (kind !== ts.SyntaxKind.EqualsToken) return undefined;
        const left = this.context.unwrapExpression(expression.left);
        if (
            ts.isPropertyAccessExpression(left) &&
            left.name.text === "length"
        ) {
            const array = this.value(left.expression);
            if (array.type.endsWith("[]"))
                return [
                    `${indent}js::array_truncate(${array.cpp}, ${this.value(expression.right, "number").cpp});`,
                ];
        }
        const field = ts.isPropertyAccessExpression(left)
            ? this.member(left)
            : undefined;
        if (!field || !this.schema.ownedAssignments?.has(field))
            return undefined;
        const target = this.value(left);
        const value = this.value(expression.right, target.type);
        if (value.type !== target.type)
            return this.refuse(
                expression.right,
                "Pinned owned assignment requires one represented type.",
            );
        const owner = `assignment_owner_${this.temporary++}`;
        this.schema.values.set(field, {
            cpp: owner,
            type: target.type,
            borrowed: "stable",
        });
        return [
            `${indent}${this.storage(target.type)} ${owner} = ${this.owned(value)};`,
            `${indent}${target.cpp} = ${owner};`,
        ];
    }

    private forOf(statement: ts.ForOfStatement, indent: string): string[] {
        const list = statement.initializer;
        const element =
            ts.isVariableDeclarationList(list) && list.declarations.length === 1
                ? list.declarations[0]!
                : undefined;
        if (
            statement.awaitModifier ||
            !element ||
            !ts.isIdentifier(element.name)
        )
            return this.refuse(
                statement,
                "Pinned for-of loop requires one ordinary binding.",
            );
        const values = this.value(statement.expression);
        if (!values.type.endsWith("[]"))
            return this.refuse(
                statement.expression,
                "Pinned for-of requires an array.",
            );
        const array = `iterable_${this.temporary++}`,
            index = `index_${this.temporary++}`,
            item = this.localName(element.name.text);
        const type = values.type.slice(0, -2);
        this.schema.values.set(element, {
            cpp: item,
            type,
            borrowed: "mutable",
        });
        const selected: KernelValue = {
            cpp: `${array}.at(${index})`,
            type,
            borrowed: "mutable",
        };
        const body = ts.isBlock(statement.statement)
            ? statement.statement.statements
            : [statement.statement];
        return [
            `${indent}{ auto ${array} = ${this.owned(values)};`,
            `${indent}for (std::size_t ${index} = 0; ${index} < ${array}.size(); ++${index}) {`,
            `${indent}    auto ${item} = ${this.owned(selected)};`,
            this.body(body, indent + "    "),
            `${indent}}`,
            `${indent}}`,
        ];
    }

    protected override assignmentDomain(
        target: ts.Expression,
    ): string | undefined {
        if (ts.isIdentifier(target)) {
            const declaration = this.declaration(target);
            return declaration && this.schema.values.get(declaration)?.cpp;
        }
        if (
            ts.isPropertyAccessExpression(target) ||
            ts.isElementAccessExpression(target)
        )
            return this.value(target).cpp;
        return undefined;
    }

    // ── Expressions ───────────────────────────────────────────────────────

    protected override expressionDomain(node: ts.Expression) {
        return this.reference(node)?.cpp ?? super.expressionDomain(node);
    }

    /** A pinned expression, typed; a scalar the numeric translator spells. */
    public value(input: ts.Expression, expected?: string): KernelValue {
        const node = this.context.unwrapExpression(input);
        const reference = this.reference(node, expected);
        if (reference) return reference;
        if (
            (node.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(node) && node.text === "undefined")) &&
            expected &&
            (this.schema.records.has(expected) ||
                expected.startsWith("optional:"))
        )
            return { cpp: `${this.storage(expected)}{}`, type: expected };
        const type = this.scalarType(node);
        if (!type)
            return this.refuse(
                node,
                "Pinned kernel expression has no native representation.",
            );
        const binding = ts.isIdentifier(node)
            ? this.numeric.bindings.get(node.text)
            : undefined;
        const cpp = this.expression(node);
        // A counted loop's index is an integer; everywhere else a JS number is.
        return {
            cpp:
                binding?.type === "index" ? `static_cast<double>(${cpp})` : cpp,
            type,
        };
    }

    /**
     * The expressions this seam represents, or undefined for a scalar form
     * the numeric translator spells.
     */
    private reference(
        node: ts.Expression,
        expected?: string,
    ): KernelValue | undefined {
        const adapted = this.schema.expression?.(node, expected, this);
        if (adapted) return adapted;
        if (ts.isStringLiteral(node))
            return { cpp: JSON.stringify(node.text), type: "string" };
        if (ts.isIdentifier(node)) return this.identifier(node, expected);
        if (ts.isPropertyAccessExpression(node)) return this.property(node);
        if (ts.isElementAccessExpression(node)) return this.element(node);
        if (ts.isObjectLiteralExpression(node))
            return this.record(node, expected ?? this.contextual(node));
        if (ts.isArrayLiteralExpression(node))
            return this.array(node, expected ?? this.contextual(node));
        if (ts.isNewExpression(node)) return this.construct(node, expected);
        if (ts.isArrowFunction(node)) return this.closure(node);
        if (ts.isCallExpression(node)) return this.referenceCall(node);
        if (ts.isConditionalExpression(node))
            return this.conditional(node, expected);
        if (ts.isBinaryExpression(node)) return this.referenceBinary(node);
        return undefined;
    }

    private contextual(node: ts.Expression): string {
        return this.representation(
            this.checker.getContextualType(node) ??
                this.checker.getTypeAtLocation(node),
            node,
        );
    }

    private identifier(
        node: ts.Identifier,
        expected: string | undefined,
    ): KernelValue | undefined {
        const declaration = this.declaration(node);
        if (!declaration) return undefined;
        let bound = this.schema.values.get(declaration);
        const constant = moduleScopeVariable(declaration);
        if (
            !bound &&
            constant?.initializer &&
            (constant.parent.flags & ts.NodeFlags.Const) !== 0 &&
            constant.getSourceFile() === node.getSourceFile() &&
            !isScalar(this.declarationType(constant))
        ) {
            // A module constant of the kernel's own module, spelled where
            // it is read.
            bound = this.value(
                constant.initializer,
                this.declarationType(constant),
            );
            this.schema.values.set(constant, bound);
        }
        if (!bound) return undefined;
        if (expected === "object" && this.schema.records.has(bound.type))
            return { cpp: `${bound.cpp}.weak_identity()`, type: "object" };
        return bound.type === `optional:${expected}`
            ? {
                  cpp: `${bound.cpp}.value()`,
                  type: expected!,
                  borrowed: bound.borrowed ?? "mutable",
              }
            : bound;
    }

    private property(
        node: ts.PropertyAccessExpression,
    ): KernelValue | undefined {
        const declaration = this.member(node);
        if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const bound = declaration && this.schema.values.get(declaration);
            if (!bound)
                return this.refuse(
                    node,
                    "Pinned kernel member is not represented.",
                );
            return bound;
        }
        // An enum member or a constant record's member: the number the pin
        // declares it as.
        const constantOwner = this.context.unwrapExpression(node.expression);
        const initializer =
            declaration &&
            (ts.isEnumMember(declaration) ||
                (ts.isPropertyAssignment(declaration) &&
                    ts.isIdentifier(constantOwner) &&
                    moduleScopeVariable(this.declaration(constantOwner)) !==
                        undefined))
                ? declaration.initializer
                : undefined;
        if (initializer)
            return {
                cpp: doubleLiteral(
                    this.context.numericValue(
                        initializer,
                        initializer.getSourceFile(),
                    ),
                ),
                type: "number",
            };
        const owner = this.value(node.expression);
        if (node.name.text === "length" && owner.type.endsWith("[]"))
            return {
                cpp: `static_cast<double>(${owner.cpp}.size())`,
                type: "number",
            };
        const type = this.schema.records.get(owner.type)?.get(node.name.text);
        if (!type)
            return this.refuse(
                node,
                "Pinned reference member has no declared field.",
            );
        if (node.questionDotToken)
            return {
                cpp: `(${owner.cpp} ? std::optional<${this.storage(type)}>{${owner.cpp}->${node.name.text}} : std::nullopt)`,
                type: `optional:${type}`,
            };
        return {
            cpp: `${owner.cpp}->${node.name.text}`,
            type,
            borrowed: "mutable",
        };
    }

    private element(node: ts.ElementAccessExpression): KernelValue {
        const value = this.value(node.expression);
        const owner = value.type.startsWith("optional:")
            ? { cpp: `${value.cpp}.value()`, type: value.type.slice(9) }
            : value;
        const tuple = tupleTypes(owner.type);
        if (tuple) {
            const index = this.context.numericValue(
                node.argumentExpression,
                node.getSourceFile(),
            );
            if (!Number.isInteger(index) || !tuple[index])
                return this.refuse(
                    node,
                    "Pinned tuple index has no represented field.",
                );
            return {
                cpp: `std::get<${index}>(${owner.cpp})`,
                type: tuple[index],
                borrowed: "mutable",
            };
        }
        if (!owner.type.endsWith("[]"))
            return this.refuse(
                node,
                "Pinned reference indexing requires an array.",
            );
        return {
            cpp: `${owner.cpp}.at(js::array_index(${this.value(node.argumentExpression, "number").cpp}))`,
            type: owner.type.slice(0, -2),
            borrowed: "mutable",
        };
    }

    private record(
        node: ts.ObjectLiteralExpression,
        type: string,
    ): KernelValue {
        const fields = this.schema.records.get(type);
        if (!fields || fields.size !== node.properties.length)
            return this.refuse(
                node,
                "Pinned record literal has no complete declared shape.",
            );
        const cpp = `record_${this.temporary++}`;
        const writes = node.properties.map((property) => {
            const name =
                property.name && ts.isIdentifier(property.name)
                    ? property.name.text
                    : this.refuse(
                          property,
                          "Pinned record field requires an identifier.",
                      );
            const value = ts.isPropertyAssignment(property)
                ? property.initializer
                : ts.isShorthandPropertyAssignment(property)
                  ? property.name
                  : this.refuse(
                        property,
                        "Pinned record member must store a value.",
                    );
            const field = fields.get(name);
            if (!field)
                return this.refuse(
                    property,
                    "Pinned record literal added an undeclared field.",
                );
            return `${cpp}->${name} = ${this.value(value, field).cpp};`;
        });
        return {
            cpp: `([&]() { auto ${cpp} = js::make_ref<${type}>(); ${writes.join(" ")} return ${cpp}; }())`,
            type,
        };
    }

    private array(node: ts.ArrayLiteralExpression, type: string): KernelValue {
        const tuple = tupleTypes(type);
        if (!type.endsWith("[]") && !tuple)
            return this.refuse(
                node,
                "Pinned array literal requires an array or tuple type.",
            );
        const values = node.elements.map((value, index) =>
            this.value(
                value,
                type.endsWith("[]") ? type.slice(0, -2) : tuple![index],
            ),
        );
        return {
            cpp: `${this.storage(type)}{${values.map((value) => value.cpp).join(", ")}}`,
            type,
        };
    }

    private construct(
        node: ts.NewExpression,
        expected: string | undefined,
    ): KernelValue {
        const type =
            expected ??
            this.representation(this.checker.getTypeAtLocation(node), node);
        const [argument] = node.arguments ?? [];
        if (type.endsWith("[]") && node.arguments?.length === 1)
            return {
                cpp: `${this.storage(type)}(js::array_index(${this.value(argument!, "number").cpp}))`,
                type,
            };
        if (
            (type.startsWith("map:") || type.startsWith("weakmap:")) &&
            !node.arguments?.length
        )
            return { cpp: `${this.storage(type)}{}`, type };
        return this.refuse(
            node,
            "Pinned kernel construction is not represented.",
        );
    }

    private closure(node: ts.ArrowFunction): KernelValue {
        if (node.parameters.length !== 0 || ts.isBlock(node.body))
            return this.refuse(
                node,
                "Pinned kernel closure must be a parameterless expression.",
            );
        const type = this.representation(
            this.checker.getTypeAtLocation(node),
            node,
        );
        const returns = type.slice("function:".length);
        return {
            cpp: `[&]() { return ${this.value(node.body, returns).cpp}; }`,
            type,
        };
    }

    private conditional(
        node: ts.ConditionalExpression,
        expected: string | undefined,
    ): KernelValue | undefined {
        if (!expected && this.scalarType(node)) return undefined;
        const yes = this.value(node.whenTrue, expected);
        const no = this.value(node.whenFalse, yes.type);
        if (yes.type !== no.type)
            return this.refuse(
                node,
                "Pinned conditional branches require one represented type.",
            );
        return {
            cpp: `(${cppCondition(this.expression(node.condition))} ? ${yes.cpp} : ${no.cpp})`,
            type: yes.type,
        };
    }

    private referenceBinary(
        node: ts.BinaryExpression,
    ): KernelValue | undefined {
        const kind = node.operatorToken.kind;
        if (
            kind === ts.SyntaxKind.QuestionQuestionToken ||
            kind === ts.SyntaxKind.QuestionQuestionEqualsToken
        ) {
            const left = this.value(node.left);
            if (this.schema.records.has(left.type)) {
                const right = this.value(node.right, left.type);
                return {
                    cpp:
                        kind === ts.SyntaxKind.QuestionQuestionToken
                            ? `([&]() { auto value = ${this.owned(left)}; return value ? value : ${right.cpp}; }())`
                            : `([&]() { auto& value = ${left.cpp}; if (!value) value = ${right.cpp}; return value; }())`,
                    type: left.type,
                };
            }
            if (
                kind === ts.SyntaxKind.QuestionQuestionToken &&
                left.type.startsWith("optional:")
            ) {
                const type = left.type.slice(9),
                    right = this.value(node.right, type);
                return {
                    cpp: `([&]() { const auto& optional = ${left.cpp}; return optional ? *optional : ${right.cpp}; }())`,
                    type,
                };
            }
            return this.refuse(
                node,
                "Pinned '??' requires a nullable reference.",
            );
        }
        const equality =
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (
            !equality ||
            (this.scalarType(node.left) !== undefined &&
                this.scalarType(node.right) !== undefined)
        )
            return undefined;
        const left = this.value(node.left);
        const right = this.value(node.right, left.type);
        return {
            cpp: `(${left.cpp} ${kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!="} ${right.cpp})`,
            type: "boolean",
        };
    }

    // ── Calls ─────────────────────────────────────────────────────────────

    private referenceCall(node: ts.CallExpression): KernelValue | undefined {
        const callee = this.context.unwrapExpression(node.expression);
        const name = ts.isIdentifier(callee)
            ? callee
            : ts.isPropertyAccessExpression(callee)
              ? callee.name
              : undefined;
        if (!name) return undefined;
        const declaration = ts.isIdentifier(callee)
            ? this.declaration(callee)
            : this.member(callee as ts.PropertyAccessExpression);
        const fn = declaration && this.schema.functions.get(declaration);
        if (fn) return this.invoke(node, fn);
        const closure = declaration && this.schema.values.get(declaration);
        if (
            closure?.type.startsWith("function:") &&
            node.arguments.length === 0
        )
            return { cpp: `${closure.cpp}()`, type: closure.type.slice(9) };
        if (ts.isPropertyAccessExpression(callee))
            return this.method(node, callee);
        return undefined;
    }

    private invoke(node: ts.CallExpression, fn: KernelFunction): KernelValue {
        if (
            node.arguments.length < fn.requiredParameters ||
            node.arguments.length > fn.parameters.length
        )
            return this.refuse(
                node,
                "Pinned reference call does not match its declared argument count.",
            );
        const compiled = node.arguments.map((argument, index) => {
            const value = this.value(argument, fn.parameters[index]);
            if (!fn.borrowedParameters?.has(index)) return value.cpp;
            if (!this.schema.records.has(value.type))
                return this.refuse(
                    argument,
                    "Pinned borrowed parameters require reference records.",
                );
            return value.borrowed === "stable"
                ? value.cpp
                : `js::snapshot_value(${value.cpp})`;
        });
        return { cpp: `${fn.cpp}(${compiled.join(", ")})`, type: fn.returns };
    }

    /** A library method on a kernel array or map. */
    private method(
        node: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): KernelValue | undefined {
        // A receiver this seam does not represent (`Math`) is the numeric
        // translator's call.
        const owner = this.reference(
            this.context.unwrapExpression(callee.expression),
        );
        if (!owner) return undefined;
        const method = callee.name.text;
        const types = mapTypes(owner.type);
        if (types) {
            const [key, value] = types;
            if (
                method === "get" &&
                node.arguments.length === 1 &&
                this.schema.records.has(value)
            )
                return {
                    cpp: `${owner.cpp}.get(${this.value(node.arguments[0]!, key).cpp})`,
                    type: value,
                    borrowed: "mutable",
                };
            if (method === "set" && node.arguments.length === 2)
                return {
                    cpp: `${owner.cpp}.set(${this.value(node.arguments[0]!, key).cpp}, ${this.value(node.arguments[1]!, value).cpp})`,
                    type: owner.type,
                };
        }
        if (!owner.type.endsWith("[]"))
            return this.refuse(
                node,
                "Pinned reference call has no declared native target.",
            );
        const element = owner.type.slice(0, -2);
        if (
            method === "splice" &&
            node.arguments.length === 2 &&
            this.context.numericValue(
                node.arguments[1]!,
                node.getSourceFile(),
            ) === 1
        )
            return {
                cpp: `js::array_splice_one(${owner.cpp}, ${this.value(node.arguments[0]!, "number").cpp})`,
                type: "void",
            };
        if (
            (method === "filter" || method === "findIndex") &&
            node.arguments.length === 1 &&
            ts.isArrowFunction(node.arguments[0]!)
        )
            return this.predicate(owner, method, node.arguments[0]);
        if (node.arguments.length === 1) {
            const argument = this.value(node.arguments[0]!, element);
            if (method === "push")
                return {
                    cpp: `${owner.cpp}.push_back(${argument.cpp})`,
                    type: "void",
                };
            if (method === "indexOf")
                return {
                    cpp: `js::array_index_of(${owner.cpp}, ${argument.cpp})`,
                    type: "number",
                };
        }
        return this.refuse(
            node,
            "Pinned reference call has no declared native target.",
        );
    }

    private predicate(
        owner: KernelValue,
        method: "filter" | "findIndex",
        callback: ts.ArrowFunction,
    ): KernelValue {
        const parameter = callback.parameters[0];
        if (
            callback.parameters.length !== 1 ||
            !parameter ||
            !ts.isIdentifier(parameter.name) ||
            ts.isBlock(callback.body)
        )
            return this.refuse(
                callback,
                "Pinned array predicate requires one named argument and expression.",
            );
        const item = `predicate_${this.temporary++}`,
            array = `values_${this.temporary++}`,
            index = `index_${this.temporary++}`;
        const element = owner.type.slice(0, -2);
        this.schema.values.set(parameter, {
            cpp: item,
            type: element,
            borrowed: "mutable",
        });
        const predicate = cppCondition(this.expression(callback.body));
        const output = method === "filter" ? "filtered" : "found";
        const initial =
            method === "filter"
                ? `${this.storage(owner.type)} filtered;`
                : "double found = -1;";
        const accept =
            method === "filter"
                ? `filtered.push_back(${item});`
                : `found = static_cast<double>(${index}); break;`;
        return {
            cpp: `([&]() { auto ${array} = ${this.owned(owner)}; ${initial} const auto length = ${array}.size(); for (std::size_t ${index} = 0; ${index} < length; ++${index}) { auto ${item} = ${this.owned({ cpp: `${array}.at(${index})`, type: element, borrowed: "mutable" })}; if (${predicate}) { ${accept} } } return ${output}; }())`,
            type: method === "filter" ? owner.type : "number",
        };
    }
}
