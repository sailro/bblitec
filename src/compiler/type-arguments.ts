import ts from "typescript";
import type { SupportedFunction } from "./user-functions.js";

type Fail = (node: ts.Node, message: string) => never;

/**
 * What a generic function's type parameters stand for at one call.
 *
 * The checker has already instantiated the call's signature; what this
 * recovers is the binding of each declared type parameter, read off by
 * matching the declaration's parameter and return types against the
 * resolved signature's. Explicit type arguments bind first. A parameter
 * that no argument determines refuses, because a body lowered under it
 * would have no type to give its values.
 */
export function callTypeArguments(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    declaration: SupportedFunction,
    fail: Fail,
): ReadonlyMap<ts.Symbol, ts.Type> | undefined {
    const parameters = declaration.typeParameters;
    if (!parameters || parameters.length === 0) {
        return undefined;
    }
    const parameterSymbols = parameters.map(
        (parameter) => checker.getTypeAtLocation(parameter).symbol,
    );
    const symbols = new Set(parameterSymbols);
    const bindings = new Map<ts.Symbol, ts.Type>();
    call.typeArguments?.forEach((node, index) => {
        const symbol = parameterSymbols[index];
        if (symbol) {
            bindings.set(symbol, checker.getTypeFromTypeNode(node));
        }
    });
    const unify = new TypeUnifier(checker, symbols, bindings);
    const resolved = checker.getResolvedSignature(call);
    const declared = checker.getSignatureFromDeclaration(declaration);
    if (resolved && declared) {
        declared.getParameters().forEach((parameter, index) => {
            const actual = resolved.getParameters()[index];
            if (actual) {
                unify.unify(
                    checker.getTypeOfSymbol(parameter),
                    checker.getTypeOfSymbol(actual),
                );
            }
        });
        unify.unify(declared.getReturnType(), resolved.getReturnType());
    }
    parameters.forEach((parameter, index) => {
        if (!bindings.has(parameterSymbols[index]!)) {
            fail(
                call,
                `Type parameter '${parameter.name.text}' is not determined by this call's arguments; spell it explicitly.`,
            );
        }
    });
    return bindings;
}

/**
 * Whether a type spells a type parameter anywhere in it: bare, as a union or
 * intersection member, as a reference's argument or as a function type's
 * parameter or result. Read off the checker's type alone.
 */
export function mentionsTypeParameter(
    checker: ts.TypeChecker,
    type: ts.Type,
    seen: Set<ts.Type> = new Set(),
): boolean {
    if (seen.has(type)) {
        return false;
    }
    seen.add(type);
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
        return true;
    }
    if (type.isUnionOrIntersection()) {
        return type.types.some((member) => mentionsTypeParameter(checker, member, seen));
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) {
        return false;
    }
    const reference = type as ts.TypeReference;
    if (
        (reference.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
        checker.getTypeArguments(reference).some((argument) => mentionsTypeParameter(checker, argument, seen))
    ) {
        return true;
    }
    return type.getCallSignatures().some(
        (signature) =>
            signature.getParameters().some((parameter) =>
                mentionsTypeParameter(checker, checker.getTypeOfSymbol(parameter), seen),
            ) || mentionsTypeParameter(checker, signature.getReturnType(), seen),
    );
}

/** Structural matching of a declared (parameterized) type against an instantiated one. */
class TypeUnifier {
    private readonly visited = new Set<string>();

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly symbols: ReadonlySet<ts.Symbol>,
        private readonly bindings: Map<ts.Symbol, ts.Type>,
    ) {}

    public unify(pattern: ts.Type, actual: ts.Type): void {
        if (pattern === actual) {
            return;
        }
        const key = `${(pattern as unknown as { id?: number }).id ?? this.checker.typeToString(pattern)}|${this.checker.typeToString(actual)}`;
        if (this.visited.has(key)) {
            return;
        }
        this.visited.add(key);
        if ((pattern.flags & ts.TypeFlags.TypeParameter) !== 0) {
            const symbol = pattern.symbol;
            if (
                symbol &&
                this.symbols.has(symbol) &&
                !this.bindings.has(symbol) &&
                !((actual.flags & ts.TypeFlags.TypeParameter) !== 0 && actual.symbol === symbol)
            ) {
                this.bindings.set(symbol, actual);
            }
            return;
        }
        if (pattern.isUnion()) {
            this.unifyUnion(pattern, actual);
            return;
        }
        if ((pattern.flags & ts.TypeFlags.Object) === 0 || (actual.flags & ts.TypeFlags.Object) === 0) {
            return;
        }
        const patternReference = pattern as ts.TypeReference;
        const actualReference = actual as ts.TypeReference;
        if (
            (patternReference.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
            (actualReference.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
            patternReference.target === actualReference.target
        ) {
            const patternArguments = this.checker.getTypeArguments(patternReference);
            const actualArguments = this.checker.getTypeArguments(actualReference);
            patternArguments.forEach((argument, index) => {
                const counterpart = actualArguments[index];
                if (counterpart) this.unify(argument, counterpart);
            });
            return;
        }
        const patternSignature = pattern.getCallSignatures()[0];
        const actualSignature = actual.getCallSignatures()[0];
        if (patternSignature && actualSignature) {
            patternSignature.getParameters().forEach((parameter, index) => {
                const counterpart = actualSignature.getParameters()[index];
                if (counterpart) {
                    this.unify(
                        this.checker.getTypeOfSymbol(parameter),
                        this.checker.getTypeOfSymbol(counterpart),
                    );
                }
            });
            this.unify(patternSignature.getReturnType(), actualSignature.getReturnType());
            return;
        }
        for (const property of this.checker.getPropertiesOfType(pattern)) {
            const counterpart = this.checker.getPropertyOfType(actual, property.name);
            if (counterpart) {
                this.unify(
                    this.checker.getTypeOfSymbol(property),
                    this.checker.getTypeOfSymbol(counterpart),
                );
            }
        }
    }

    /**
     * `T | undefined` against `number | undefined`: the members the pattern
     * spells concretely are matched away, and one remaining type parameter
     * binds to what is left.
     */
    private unifyUnion(pattern: ts.UnionType, actual: ts.Type): void {
        const actualMembers = actual.isUnion() ? [...actual.types] : [actual];
        const parameters: ts.Type[] = [];
        for (const member of pattern.types) {
            if ((member.flags & ts.TypeFlags.TypeParameter) !== 0) {
                parameters.push(member);
                continue;
            }
            const matched = actualMembers.findIndex(
                (candidate) =>
                    candidate === member ||
                    (this.checker.isTypeAssignableTo(candidate, member) &&
                        this.checker.isTypeAssignableTo(member, candidate)),
            );
            if (matched >= 0) {
                actualMembers.splice(matched, 1);
            }
        }
        if (parameters.length === 1 && actualMembers.length === 1) {
            this.unify(parameters[0]!, actualMembers[0]!);
        }
    }
}
