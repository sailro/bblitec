/**
 * Translates one pinned function declaration to a whole C++ function.
 *
 * This is the skeleton every "lower a pinned function whole" site shares:
 * fetch the declaration, check the parameter list against an ordered spec,
 * bind each parameter, run the shared `PinnedNumericLowerer` over the body,
 * and assemble provenance + signature + body. The first two lowerings to
 * take this shape (`inverseImageProcessedChannel` and the projection matrix
 * writers) each hand-rolled it one commit apart and immediately diverged in
 * contract strength — one asserted every parameter's type annotation, the
 * other only the target's — which is exactly the drift the shared skeleton
 * exists to prevent, since TODO's re-derivation backlog will mint many more
 * of these.
 *
 * The parameter spec is exhaustive both ways and ordered: a pinned
 * parameter the spec does not name, a spec entry the pin no longer takes,
 * a reordered list, or a retyped annotation each fail generation as a named
 * contract error instead of binding positionally or failing later in C++.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

/** One pinned parameter: its pinned name, its annotation, its C++ name. */
export interface PinnedFunctionParameter {
    pinned: string;
    /**
     * `number`/`boolean` are JavaScript scalars and become `double`/`bool`;
     * `mat4` is the pin's `Mat4Storage` and becomes an f32 array reference,
     * so every store through it rounds where the pin's store does.
     * `matrix` is a `Float32Array` the body only reads — the fixed matrix
     * by const reference, which is what the shadow family's own
     * `Float32Array` parameters are.
     */
    kind:
        | "number"
        | "boolean"
        | "mat4"
        | "matrix"
        | "mat4Const"
        | "numberArray";
    /**
     * The emitted C++ parameter name. Usually the pinned name; different
     * where C++ forbids it (`near`/`far` are Windows macro names).
     */
    cpp: string;
}

const parameterKinds: Readonly<
    Record<
        PinnedFunctionParameter["kind"],
        { annotation: string; declare: (cpp: string) => string }
    >
> = {
    number: { annotation: "number", declare: (cpp) => `double ${cpp}` },
    boolean: { annotation: "boolean", declare: (cpp) => `bool ${cpp}` },
    mat4: {
        annotation: "Mat4Storage",
        declare: (cpp) => `std::array<float, 16>& ${cpp}`,
    },
    matrix: {
        annotation: "Float32Array",
        declare: (cpp) => `const std::array<float, 16>& ${cpp}`,
    },
    // `Mat4` is the pin's own alias for the same storage, and
    // `ArrayLike<number>` is how `mat4Determinant3` spells "a matrix or a
    // raw glTF `node.matrix`". Both are read-only here, so both land on the
    // const reference `matrix` does -- they are separate kinds because the
    // annotation is what gets checked, and checking the wrong one would
    // accept a pin that swapped them.
    mat4Const: {
        annotation: "Mat4",
        declare: (cpp) => `const std::array<float, 16>& ${cpp}`,
    },
    numberArray: {
        annotation: "ArrayLike<number>",
        declare: (cpp) => `const std::array<float, 16>& ${cpp}`,
    },
};

/**
 * The kinds that bind a matrix: every one of them is 16 floats the body
 * indexes, so they share the translator's fixed-matrix binding and differ
 * only in the annotation each checks.
 */
const matrixKinds: ReadonlySet<PinnedFunctionParameter["kind"]> = new Set([
    "mat4",
    "matrix",
    "mat4Const",
    "numberArray",
]);

/**
 * The elements of a pinned tuple return, lowered through the caller's
 * translator.
 *
 * The array-literal twin of `lowerObjectComponents`: unwrap, assert the
 * literal, assert the arity, lower each element. `insideF32` takes the
 * `new F32([...])` the matrix writers return; the callers keep their own
 * `std::array<...>{...}` wrapper, because the two spell their braces
 * differently and the components are what they share.
 */
export function lowerTupleComponents(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression | undefined,
    options: {
        arity: number;
        at: ts.Node;
        insideF32?: boolean;
        cast?: string;
    },
): string[] {
    let returned = expression
        ? context.unwrapExpression(expression)
        : undefined;
    if (options.insideF32) {
        if (
            !returned ||
            !ts.isNewExpression(returned) ||
            !ts.isIdentifier(returned.expression) ||
            returned.expression.text !== "F32" ||
            returned.arguments?.length !== 1
        ) {
            return context.contractError(
                options.at,
                "Expected the pinned body to return `new F32([...])`.",
            );
        }
        returned = context.unwrapExpression(returned.arguments[0]!);
    }
    if (!returned || !ts.isArrayLiteralExpression(returned)) {
        return context.contractError(
            options.at,
            "Expected the pinned body to return an array literal.",
        );
    }
    if (returned.elements.length !== options.arity) {
        return context.contractError(
            options.at,
            `Expected ${options.arity} element(s), found ` +
                `${returned.elements.length}.`,
        );
    }
    return returned.elements.map((element) => {
        const lowered = lowerer.expression(element);
        return options.cast ? `${options.cast}(${lowered})` : lowered;
    });
}

/**
 * The named components of a pinned vector object literal, each lowered
 * through the caller's translator, in the caller's field order. A field the
 * pin stops writing fails by name instead of leaving a default-constructed
 * member behind. (The splat lowerer keeps its own stricter walk, which also
 * refuses fields outside the order.)
 */
export function lowerObjectComponents(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    argument: ts.Expression,
    names: readonly string[],
): string[] {
    const literal = context.unwrapExpression(argument);
    if (!ts.isObjectLiteralExpression(literal)) {
        context.contractError(
            argument,
            "Expected a pinned vector object literal.",
        );
    }
    return names.map((name) =>
        lowerer.expression(context.propertyInitializer(literal, name)),
    );
}

/**
 * The pinned matrix multiply translated whole, shared by the render plan
 * and the glTF loader so one pinned declaration has one translation. Its
 * `Mat4Storage` parameters accept F32- or F64-backed storage upstream;
 * every consumer's target and left operand is an f32 array while the right
 * operand is f32 (the view chain, the loader's node matrices) or f64 (the
 * composed instance TRS), and the body's reads widen to double identically
 * for both — so the one axis that varies is the right operand's container,
 * emitted as the template parameter. `lowerPinnedFunction` deliberately
 * does not grow a template concept for this one signature; the parameter
 * contract below carries the same name-and-annotation strength.
 */
export function lowerMat4MultiplyWriterCpp(context: LoweringContext): string {
    const module = "src/math/mat4-multiply-into.ts";
    const symbol = "mat4MultiplyInto";
    const { file, declaration } = context.functionDeclaration(
        module,
        symbol,
    );
    const expected: readonly (readonly [string, string, PinnedBinding])[] = [
        ["dst", "Mat4Storage", { cpp: "dst", type: "f32" }],
        ["d", "number", { cpp: "d", type: "index" }],
        ["a", "Mat4Storage", { cpp: "a", type: "f32" }],
        ["i", "number", { cpp: "i", type: "index" }],
        ["b", "Mat4Storage", { cpp: "b", type: "f32" }],
        ["j", "number", { cpp: "j", type: "index" }],
    ];
    if (declaration.parameters.length !== expected.length) {
        context.contractError(
            declaration,
            "Expected pinned mat4MultiplyInto to take (dst, d, a, i, b, j).",
        );
    }
    declaration.parameters.forEach((parameter, index) => {
        const [pinned, annotation] = expected[index]!;
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== pinned ||
            parameter.type?.getText(file) !== annotation
        ) {
            context.contractError(
                parameter,
                `Expected pinned ${symbol} parameter ${index} to be ` +
                    `'${pinned}: ${annotation}'.`,
            );
        }
    });
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map(
            expected.map(([pinned, , binding]) => [pinned, binding]),
        ),
        calls: new Map(),
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return `// ${context.provenance(module, symbol)}
template <typename MatB>
void mat4_multiply_into(
    std::array<float, 16>& dst,
    std::int64_t d,
    const std::array<float, 16>& a,
    std::int64_t i,
    const MatB& b,
    std::int64_t j) {
${body}
}`;
}

/** A pinned function of scalars (and at most a Mat4Storage target), as C++. */
export function lowerPinnedFunction(
    context: LoweringContext,
    modulePath: string,
    symbolName: string,
    parameters: readonly PinnedFunctionParameter[],
    options: {
        cppName: string;
        /**
         * `void` emits no return contract and `double` wires the value
         * through unchanged; a `{ type, value }` pair is a caller-owned
         * return — the emitted C++ type, and how a returned expression
         * becomes it (a `new F32([...])` literal, an object literal the
         * caller mirrors as a struct). The lowerer is passed in so the
         * hook can translate the returned expression's own parts.
         */
        returns:
            | "void"
            | "double"
            | {
                  type: string;
                  value: (
                      lowerer: PinnedNumericLowerer,
                      expression: ts.Expression | undefined,
                  ) => string;
              };
        /** Emit `inline` — for a function landing in a generated header. */
        inline?: boolean;
        /** Calls the body may make. The caller owns the whole map. */
        calls?: ReadonlyMap<string, (args: readonly string[]) => string>;
        /** See `PinnedNumericScope.matrixCalls`. */
        matrixCalls?: ReadonlySet<string>;
        /** See `PinnedNumericScope.recordCalls`. */
        recordCalls?: ReadonlyMap<string, readonly string[]>;
        /** See `PinnedNumericScope.tupleCalls`. */
        tupleCalls?: ReadonlyMap<string, number>;
        /** See `PinnedNumericScope.booleanAnd`. */
        booleanAnd?: boolean;
    },
): string {
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        symbolName,
    );
    if (declaration.parameters.length !== parameters.length) {
        context.contractError(
            declaration,
            `Expected pinned ${symbolName} to take ` +
                `${parameters.length} parameter(s).`,
        );
    }
    const bindings = new Map<string, PinnedBinding>();
    const signature: string[] = [];
    declaration.parameters.forEach((parameter, index) => {
        const spec = parameters[index]!;
        const kind = parameterKinds[spec.kind];
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== spec.pinned ||
            parameter.type?.getText(file) !== kind.annotation
        ) {
            context.contractError(
                parameter,
                `Expected pinned ${symbolName} parameter ${index} to be ` +
                    `'${spec.pinned}: ${kind.annotation}'.`,
            );
        }
        bindings.set(spec.pinned, {
            cpp: spec.cpp,
            type: matrixKinds.has(spec.kind)
                ? "f32"
                : spec.kind === "boolean"
                  ? "bool"
                  : "scalar",
        });
        signature.push(kind.declare(spec.cpp));
    });
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: options.calls ?? new Map(),
        ...(options.matrixCalls ? { matrixCalls: options.matrixCalls } : {}),
        ...(options.recordCalls ? { recordCalls: options.recordCalls } : {}),
        ...(options.tupleCalls ? { tupleCalls: options.tupleCalls } : {}),
        ...(options.booleanAnd ? { booleanAnd: true } : {}),
        ...(options.returns === "void"
            ? {}
            : {
                  returnValue: (
                      expression: ts.Expression | undefined,
                  ): string => {
                      const returns = options.returns;
                      if (typeof returns !== "string") {
                          return returns.value(lowerer, expression);
                      }
                      if (!expression) {
                          return context.contractError(
                              declaration,
                              `Expected pinned ${symbolName} to return a ` +
                                  "value.",
                          );
                      }
                      return lowerer.expression(expression);
                  },
              }),
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    const returnType = typeof options.returns === "string"
        ? options.returns
        : options.returns.type;
    return (
        `// ${context.provenance(modulePath, symbolName)}\n` +
        `${options.inline ? "inline " : ""}${returnType} ` +
        `${options.cppName}(\n    ${signature.join(",\n    ")}) {\n` +
        `${body}\n}`
    );
}
