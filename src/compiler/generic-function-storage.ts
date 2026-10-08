import ts from "typescript";
import { isTypeReference } from "./type-facts.js";

/** One reached instantiation of a stored generic function. */
export interface GenericFunctionDemand {
    family: string;
    arguments: readonly ts.Type[];
    parameters: readonly (ts.Type | undefined)[];
    /** Concrete element types supplied to an unknown[] rest parameter. */
    restArguments?: readonly ts.Type[];
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    ancestors: readonly string[];
    /** The call is inside a checked recursive dynamic-value boundary. */
    dynamicJsonStorage?: true;
    /** The source call, or the operation supplying the call's values. */
    site: ts.Node;
}

type SameType = (left: ts.Type, right: ts.Type) => boolean;

/**
 * Equivalent type-level binders may share storage. Executable declarations
 * keep source-specific families, which also bound recursive specialization.
 */
function samePolymorphicSignature(
    checker: ts.TypeChecker,
    left: ts.Signature,
    right: ts.Signature,
): boolean {
    const typeLevel = (signature: ts.Signature): boolean => {
        const declaration = signature.declaration;
        return (
            declaration !== undefined &&
            (ts.isMethodSignature(declaration) ||
                ts.isCallSignatureDeclaration(declaration) ||
                ts.isFunctionTypeNode(declaration))
        );
    };
    if (
        !left.typeParameters?.length ||
        !right.typeParameters?.length ||
        !typeLevel(left) ||
        !typeLevel(right)
    )
        return false;
    const active = new Map<ts.Type, Set<ts.Type>>();
    const sameType = (
        a: ts.Type | undefined,
        b: ts.Type | undefined,
        bindings: ReadonlyMap<ts.Type, ts.Type>,
    ): boolean => {
        if (!a || !b) return a === b;
        if (bindings.has(a)) return bindings.get(a) === b;
        if ([...bindings.values()].includes(b)) return false;
        if (a === b) return true;
        if (a.flags !== b.flags || active.get(a)?.has(b)) return false;
        const pairs = active.get(a) ?? new Set<ts.Type>();
        active.set(a, pairs);
        pairs.add(b);
        try {
            if (a.isUnionOrIntersection() && b.isUnionOrIntersection())
                return (
                    a.types.length === b.types.length &&
                    a.types.every((type, index) =>
                        sameType(type, b.types[index], bindings),
                    )
                );
            if (isTypeReference(a) && isTypeReference(b)) {
                if (a.target !== b.target) return false;
                const aArguments = checker.getTypeArguments(a),
                    bArguments = checker.getTypeArguments(b);
                return (
                    aArguments.length === bArguments.length &&
                    aArguments.every((type, index) =>
                        sameType(type, bArguments[index], bindings),
                    )
                );
            }
            const aCalls = a.getCallSignatures(),
                bCalls = b.getCallSignatures();
            return (
                aCalls.length === 1 &&
                bCalls.length === 1 &&
                [a, b].every(
                    (type) =>
                        !type.getProperties().length &&
                        !type.getConstructSignatures().length &&
                        !checker.getIndexInfosOfType(type).length,
                ) &&
                sameSignature(aCalls[0]!, bCalls[0]!, bindings)
            );
        } finally {
            pairs.delete(b);
        }
    };
    const sameSignature = (
        a: ts.Signature,
        b: ts.Signature,
        outer: ReadonlyMap<ts.Type, ts.Type>,
    ): boolean => {
        const aTypes = a.typeParameters ?? [],
            bTypes = b.typeParameters ?? [];
        if (
            aTypes.length !== bTypes.length ||
            a.parameters.length !== b.parameters.length ||
            !!a.thisParameter !== !!b.thisParameter ||
            checker.getTypePredicateOfSignature(a) ||
            checker.getTypePredicateOfSignature(b)
        )
            return false;
        const bindings = new Map(outer);
        aTypes.forEach((type, index) => bindings.set(type, bTypes[index]!));
        const modifiers = (type: ts.TypeParameter): string =>
            (type.symbol.declarations ?? [])
                .filter(ts.isTypeParameterDeclaration)
                .flatMap((node) => node.modifiers ?? [])
                .map((modifier) => modifier.kind)
                .join(",");
        if (
            !aTypes.every(
                (type, index) =>
                    modifiers(type) === modifiers(bTypes[index]!) &&
                    sameType(
                        type.getConstraint(),
                        bTypes[index]!.getConstraint(),
                        bindings,
                    ) &&
                    sameType(
                        type.getDefault(),
                        bTypes[index]!.getDefault(),
                        bindings,
                    ),
            )
        )
            return false;
        const sameParameter = (x: ts.Symbol, y: ts.Symbol): boolean => {
            const xNode = x.valueDeclaration,
                yNode = y.valueDeclaration;
            return (
                !!xNode &&
                !!yNode &&
                ts.isParameter(xNode) &&
                ts.isParameter(yNode) &&
                !!(x.flags & ts.SymbolFlags.Optional) ===
                    !!(y.flags & ts.SymbolFlags.Optional) &&
                !!(xNode.questionToken || xNode.initializer) ===
                    !!(yNode.questionToken || yNode.initializer) &&
                !!xNode.dotDotDotToken === !!yNode.dotDotDotToken &&
                sameType(
                    checker.getTypeOfSymbolAtLocation(x, xNode),
                    checker.getTypeOfSymbolAtLocation(y, yNode),
                    bindings,
                )
            );
        };
        return (
            (!a.thisParameter ||
                sameParameter(a.thisParameter, b.thisParameter!)) &&
            a.parameters.every((parameter, index) =>
                sameParameter(parameter, b.parameters[index]!),
            ) &&
            sameType(a.getReturnType(), b.getReturnType(), bindings)
        );
    };
    return sameSignature(left, right, new Map());
}

/**
 * Signature identity survives several demands collected from one emission
 * attempt. `same` relates the call's own types; frames compare by identity.
 */
export function sameGenericFunctionSignature(
    left: GenericFunctionDemand,
    right: GenericFunctionDemand,
    same: SameType = (a, b) => a === b,
): boolean {
    const sameTypes = (
        a: readonly (ts.Type | undefined)[],
        b: readonly (ts.Type | undefined)[],
    ): boolean =>
        a.length === b.length &&
        a.every((type, index) => {
            const other = b[index];
            return type && other ? same(type, other) : type === other;
        });
    return (
        left.family === right.family &&
        sameTypes(left.arguments, right.arguments) &&
        sameTypes(left.parameters, right.parameters) &&
        (left.restArguments?.length ?? 0) ===
            (right.restArguments?.length ?? 0) &&
        (left.restArguments ?? []).every((type) =>
            right.restArguments!.some((other) => same(type, other)),
        ) &&
        left.dynamicJsonStorage === right.dynamicJsonStorage &&
        sameTypeFrames(left.frames, right.frames)
    );
}

/**
 * Whether a site already holds a signature `demand` matches only up to type
 * identity: the site's types change identity at every emission, so each
 * replay would add another signature without end.
 */
export function divergentGenericFunctionDemand(
    checker: ts.TypeChecker,
    represented: readonly GenericFunctionDemand[],
    demand: GenericFunctionDemand,
): boolean {
    return represented.some(
        (known) =>
            known.site === demand.site &&
            sameGenericFunctionSignature(
                known,
                demand,
                (left, right) =>
                    left === right ||
                    (checker.isTypeAssignableTo(left, right) &&
                        checker.isTypeAssignableTo(right, left)),
            ),
    );
}

export function sameTypeFrames(
    left: GenericFunctionDemand["frames"],
    right: GenericFunctionDemand["frames"],
): boolean {
    if (
        left.length === right.length &&
        left.every(
            (frame, index) =>
                frame.size === right[index]!.size &&
                [...frame].every(
                    ([symbol, type]) => right[index]!.get(symbol) === type,
                ),
        )
    )
        return true;
    const bindings = (
        frames: GenericFunctionDemand["frames"],
    ): Map<ts.Symbol, ts.Type> => {
        const visible = new Map<ts.Symbol, ts.Type>();
        for (const frame of frames)
            for (const [symbol, type] of frame) visible.set(symbol, type);
        return visible;
    };
    const a = bindings(left),
        b = bindings(right);
    return (
        a.size === b.size &&
        [...a].every(([symbol, type]) => b.get(symbol) === type)
    );
}

/** Source identities and reached signatures persist while emission replays one Program. */
export class GenericFunctionStorage {
    /** @unjournaled Source identities must remain stable across discarded probes and emission replays. */
    private readonly families = new Map<
        ts.Signature,
        Array<{ key: string; frames: GenericFunctionDemand["frames"] }>
    >();
    /** @unjournaled Reached signatures accumulate between whole-program emission attempts. */
    private readonly demands = new Map<string, GenericFunctionDemand[]>();
    /** @unjournaled Allocates identities retained by families across emission replays. */
    private nextFamily = 0;
    /**
     * @unjournaled The checker builds a fresh type for an object literal at
     * every request; a source expression keeps its first one across replays.
     */
    private readonly expressionTypes = new WeakMap<ts.Expression, ts.Type>();

    /** The type of a call's argument, one identity across emission replays. */
    public expressionType(
        checker: ts.TypeChecker,
        expression: ts.Expression,
    ): ts.Type {
        let type = this.expressionTypes.get(expression);
        if (!type) {
            type = checker.getTypeAtLocation(expression);
            this.expressionTypes.set(expression, type);
        }
        return type;
    }

    public family(
        checker: ts.TypeChecker,
        signature: ts.Signature,
        frames: GenericFunctionDemand["frames"],
    ): string {
        let families = this.families.get(signature);
        if (!families) {
            families = signature.typeParameters?.length
                ? [...this.families].find(([known]) =>
                      samePolymorphicSignature(checker, signature, known),
                  )?.[1]
                : undefined;
            families ??= [];
            this.families.set(signature, families);
        }
        const found = families.find((family) =>
            sameTypeFrames(family.frames, frames),
        );
        if (found) return found.key;
        const key = String(this.nextFamily++);
        families.push({ key, frames: frames.map((frame) => new Map(frame)) });
        return key;
    }

    public get(family: string): readonly GenericFunctionDemand[] {
        return [...(this.demands.get(family) ?? [])];
    }

    public add(demand: GenericFunctionDemand): boolean {
        const family = this.demands.get(demand.family) ?? [];
        if (family.some((known) => sameGenericFunctionSignature(known, demand)))
            return false;
        family.push(demand);
        this.demands.set(demand.family, family);
        return true;
    }
}

/** Earlier callback storage must contain every reached concrete signature. */
export class GenericFunctionStorageRequired extends Error {
    constructor(readonly demand: GenericFunctionDemand) {
        super("A stored generic function requires a concrete signature.");
    }

    /** The source call, or the operation supplying the call's values. */
    get call(): ts.Node {
        return this.demand.site;
    }
}
