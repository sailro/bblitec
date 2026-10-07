import ts from "typescript";
import { declaredInDefaultLibrary, resolvedSymbol } from "./symbols.js";
import { isTypeReference, presentMembers } from "./type-facts.js";
import { unwrapExpression } from "./syntax.js";
import type { DataType, TypedArrayKind } from "./data-types/model.js";
import { isTypedArrayType } from "./data-types/typed-arrays.js";

/**
 * What a numeric array an `ArrayLike<number>` slot stores is: one typed-array
 * kind, a number array (a numeric tuple included) or a numeric view of any
 * of them.
 */
export type NumericSlotKind = TypedArrayKind | "array" | "view";

/**
 * A source storage declared with an `ArrayLike<number>` position: a record
 * property, a variable, or a property or function whose result (or that
 * result's elements) is one.
 */
export type NumericSlotDeclaration =
    | ts.VariableDeclaration
    | ts.PropertySignature
    | ts.PropertyDeclaration
    | ts.MethodSignature;

/**
 * A slot declared `ArrayLike<number>` is handed a numeric array of a kind its
 * storage cannot hold without a copy: the compile replays with storage for
 * every kind the program stores there. One typed-array kind is stored as
 * itself; several kinds share one numeric view (`NumericArrayView`). Either
 * keeps the stored array's identity.
 */
export class NumericSlotStorageRequired extends Error {
    constructor(
        readonly declaration: NumericSlotDeclaration,
        readonly kind: NumericSlotKind,
    ) {
        super("An ArrayLike slot must store the numeric arrays it holds.");
    }
}

/** The kinds each demanded slot stores. */
export type NumericSlots = ReadonlyMap<
    ts.Declaration,
    ReadonlySet<NumericSlotKind>
>;

/** The numeric array kind a stored value is, or undefined for any other value. */
export function numericSlotKind(
    dataType: DataType | undefined,
): NumericSlotKind | undefined {
    const inner = dataType?.kind === "optional" ? dataType.inner : dataType;
    if (!inner) return undefined;
    if (isTypedArrayType(inner)) return inner.kind;
    if (inner.kind === "numberindex") return "view";
    if (
        inner.kind === "tuple" ||
        (inner.kind === "vector" && inner.element.kind === "number")
    )
        return "array";
    return undefined;
}

/** The storage of a slot holding `kinds`. */
export function numericSlotStorage(
    kinds: ReadonlySet<NumericSlotKind>,
): DataType {
    const [only, ...others] = kinds;
    if (only === undefined || only === "view" || others.length > 0)
        return { kind: "numberindex" };
    return only === "array"
        ? { kind: "vector", element: { kind: "number" } }
        : { kind: only };
}

/** Whether `type` is the library's `ArrayLike<number>`. */
function isNumberArrayLike(checker: ts.TypeChecker, type: ts.Type): boolean {
    if (
        type.symbol?.name !== "ArrayLike" ||
        !declaredInDefaultLibrary(type.symbol) ||
        !isTypeReference(type)
    )
        return false;
    const [element] = checker.getTypeArguments(type);
    return element !== undefined && (element.flags & ts.TypeFlags.Number) !== 0;
}

/** The one present member of `type`, or undefined for none or several. */
function presentType(type: ts.Type): ts.Type | undefined {
    const members = presentMembers(type);
    return members.length === 1 ? members[0] : undefined;
}

/** The element type of an Array or ReadonlyArray type. */
function arrayElement(
    checker: ts.TypeChecker,
    type: ts.Type,
): ts.Type | undefined {
    if (
        (type.symbol?.name !== "Array" &&
            type.symbol?.name !== "ReadonlyArray") ||
        !declaredInDefaultLibrary(type.symbol) ||
        !isTypeReference(type)
    )
        return undefined;
    return checker.getTypeArguments(type)[0];
}

/** One step from a slot's declared type to the position a value is stored in. */
type SlotStep = "result" | "element";

/**
 * The `ArrayLike<number>` position `steps` reach from a declared type
 * through nullable members, a call result and array elements, if any.
 */
function arrayLikeAt(
    checker: ts.TypeChecker,
    type: ts.Type,
    steps: readonly SlotStep[],
): boolean {
    let current = presentType(type);
    for (const step of steps) {
        if (!current) return false;
        if (step === "result") {
            const signatures = current.getCallSignatures();
            if (signatures.length !== 1) return false;
            current = presentType(
                checker.getReturnTypeOfSignature(signatures[0]!),
            );
        } else {
            const element = arrayElement(checker, current);
            current = element && presentType(element);
        }
    }
    return current !== undefined && isNumberArrayLike(checker, current);
}

/** The outermost wrapper around an expression that keeps its value. */
function climb(node: ts.Node): ts.Node {
    let current = node;
    while (
        // A source file has no parent.
        current.parent !== undefined &&
        (ts.isParenthesizedExpression(current.parent) ||
            ts.isNonNullExpression(current.parent) ||
            ts.isAsExpression(current.parent) ||
            ts.isTypeAssertionExpression(current.parent) ||
            ts.isSatisfiesExpression(current.parent) ||
            (ts.isConditionalExpression(current.parent) &&
                current.parent.condition !== current))
    )
        current = current.parent;
    return current;
}

/** A program's own declaration whose storage a demand can retype. */
function isNumericSlotDeclaration(
    declaration: ts.Declaration | undefined,
): declaration is NumericSlotDeclaration {
    return (
        declaration !== undefined &&
        !declaration.getSourceFile().isDeclarationFile &&
        ((ts.isVariableDeclaration(declaration) &&
            ts.isIdentifier(declaration.name)) ||
            ts.isPropertySignature(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isMethodSignature(declaration))
    );
}

/** The declaration of the one property `name` of the type an object literal is stored as. */
function contextualProperty(
    checker: ts.TypeChecker,
    literal: ts.ObjectLiteralExpression,
    name: string,
): ts.Declaration | undefined {
    const owner = checker.getContextualType(literal);
    const property = owner && presentType(owner)?.getProperty(name);
    const declarations = property?.declarations ?? [];
    return declarations.length === 1 ? declarations[0] : undefined;
}

/** The declaration of the storage a value written at `node` is stored in. */
function storageDeclaration(
    checker: ts.TypeChecker,
    node: ts.Node,
): ts.Declaration | undefined {
    const parent = node.parent;
    if (parent === undefined) return undefined;
    if (ts.isPropertyAssignment(parent) && parent.initializer === node)
        return ts.isObjectLiteralExpression(parent.parent) &&
            !ts.isComputedPropertyName(parent.name)
            ? contextualProperty(checker, parent.parent, parent.name.text)
            : undefined;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        return contextualProperty(checker, parent.parent, parent.name.text);
    if (ts.isVariableDeclaration(parent) && parent.initializer === node)
        return parent;
    if (
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const target = ts.isIdentifier(parent.left)
            ? parent.left
            : ts.isPropertyAccessExpression(parent.left)
              ? parent.left.name
              : undefined;
        if (!target) return undefined;
        const declarations =
            resolvedSymbol(checker, target)?.declarations ?? [];
        return declarations.length === 1 ? declarations[0] : undefined;
    }
    return undefined;
}

/**
 * The declared storage a value written at `node` lands in when that storage
 * has an `ArrayLike<number>` position there: a record property or a
 * binding, a function stored in one returning it, or an element of an
 * array literal stored or returned that way.
 */
export function numericSlotDeclaration(
    checker: ts.TypeChecker,
    node: ts.Node,
): NumericSlotDeclaration | undefined {
    const steps: SlotStep[] = [];
    let current = climb(node);
    if (current.parent && ts.isArrayLiteralExpression(current.parent)) {
        steps.unshift("element");
        current = climb(current.parent);
    }
    const parent = current.parent;
    if (parent === undefined) return undefined;
    const returned =
        ts.isReturnStatement(parent) && parent.expression === current
            ? ts.findAncestor(parent, ts.isFunctionLike)
            : ts.isArrowFunction(parent) && parent.body === current
              ? parent
              : undefined;
    if (returned) {
        if (!ts.isArrowFunction(returned) && !ts.isFunctionExpression(returned))
            return undefined;
        steps.unshift("result");
        current = climb(returned);
    }
    const declaration = storageDeclaration(checker, current);
    if (!isNumericSlotDeclaration(declaration)) return undefined;
    const declared = checker.getTypeAtLocation(declaration);
    return arrayLikeAt(checker, declared, steps) ? declaration : undefined;
}

/**
 * The declared storage `expression` reads its value from, when that storage
 * has an `ArrayLike<number>` position there: a binding or record property it
 * names, or the result of a function stored in one that it calls.
 */
export function numericSlotRead(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): NumericSlotDeclaration | undefined {
    let node = unwrapExpression(expression);
    const steps: SlotStep[] = [];
    if (ts.isCallExpression(node)) {
        steps.push("result");
        node = unwrapExpression(node.expression);
    }
    const name = ts.isIdentifier(node)
        ? node
        : ts.isPropertyAccessExpression(node)
          ? node.name
          : undefined;
    const declarations =
        (name && resolvedSymbol(checker, name)?.declarations) ?? [];
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    return isNumericSlotDeclaration(declaration) &&
        arrayLikeAt(checker, checker.getTypeAtLocation(declaration), steps)
        ? declaration
        : undefined;
}

/**
 * `mapped`, the storage `type` maps to, with the `ArrayLike<number>`
 * position a demanded slot declares stored as `storage`; undefined when the
 * two do not line up.
 */
export function withNumericSlotStorage(
    checker: ts.TypeChecker,
    type: ts.Type,
    mapped: DataType,
    storage: DataType,
): DataType | undefined {
    if (mapped.kind === "optional" || mapped.kind === "tagged") {
        const inner = withNumericSlotStorage(
            checker,
            type,
            mapped.inner,
            storage,
        );
        return inner && { ...mapped, inner };
    }
    const present = presentType(type);
    if (!present) return undefined;
    if (isNumberArrayLike(checker, present))
        return mapped.kind === "vector" || mapped.kind === "span"
            ? storage
            : undefined;
    if (mapped.kind === "function") {
        const signatures = present.getCallSignatures();
        if (signatures.length !== 1 || !mapped.result) return undefined;
        const result = withNumericSlotStorage(
            checker,
            checker.getReturnTypeOfSignature(signatures[0]!),
            mapped.result,
            storage,
        );
        return result && { ...mapped, result };
    }
    const element = arrayElement(checker, present);
    if (element && (mapped.kind === "vector" || mapped.kind === "span")) {
        const stored = withNumericSlotStorage(
            checker,
            element,
            mapped.element,
            storage,
        );
        return stored && { ...mapped, element: stored };
    }
    return undefined;
}
