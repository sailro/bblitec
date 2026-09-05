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
import { doubleLiteral } from "../cpp-literals.js";
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
        | "index"
        | "boolean"
        | "mat4"
        | "matrix"
        | "mat4Const"
        | "numberArray"
        | "u32Buffer"
        | "record";
    /**
     * The emitted C++ parameter name. Usually the pinned name; different
     * where C++ forbids it (`near`/`far` are Windows macro names).
     */
    cpp: string;
    /**
     * The annotation to check, where the kind's own is not what the pin
     * spells. `Uint32Array` and `Float32Array` both bind a typed buffer the
     * body stores through, and the kind is what decides the store's width;
     * the annotation is what proves the pin still spells it that way.
     */
    annotation?: string;
    /**
     * The binding to give the body, where the kind's default is not it.
     *
     * A record parameter is the case: the translator reads scalars, and a
     * pinned body that takes a whole object reads named members off it. The
     * caller owns those spellings because it owns the native record they
     * land on.
     */
    binding?: PinnedBinding;
    /**
     * Override the C++ reference type while retaining the kind's numeric
     * binding. Required for records; also supports templated matrix storage.
     */
    cppType?: string;
    /**
     * Bind a `record` parameter by MUTABLE reference. A pinned body that
     * writes its own parameter's members -- a stepper advancing the
     * animation it was handed -- needs the storage it writes to be the
     * caller's, which a const binding would refuse at the store.
     */
    mutableRecord?: boolean;
    /**
     * Carry the pin's OWN default initializer through as the C++ default
     * argument.
     *
     * A defaulted pinned parameter is a value every caller that omits it
     * supplies, so a port that dropped the default would either refuse
     * those callers or restate the number beside them --
     * `normalizeVec3(x, y, z)` is the pin's own three-argument spelling in
     * `detailed-picking.ts` and `picking-helpers.ts`, and `1e-10` is not
     * this port's to retype. Only a numeric literal is accepted, because a
     * defaulted expression is a body the translator has not been given.
     */
    pinnedDefault?: true;
    /**
     * A pinned OPTIONAL parameter the reached slice never supplies.
     *
     * It contributes no C++ parameter and binds statically absent, so the
     * arm the pin guards on it does not translate -- which is the whole
     * reason: `populateDetailedMeshInfo`'s `deformTriangle` reaches the
     * deformed-vertex module behind it, and no scene composes a detailed
     * pick of a skinned or morphed mesh. The pinned parameter's name,
     * annotation and `?` are all still asserted, so the pin cannot move
     * the seam silently; only what is behind the guard goes untranslated.
     */
    absent?: true;
}

const parameterKinds: Readonly<
    Record<
        PinnedFunctionParameter["kind"],
        {
            annotation: string;
            bindingType: PinnedBinding["type"];
            declare: (cpp: string) => string;
        }
    >
> = {
    number: {
        annotation: "number", bindingType: "scalar",
        declare: (cpp) => `double ${cpp}`,
    },
    index: {
        annotation: "number", bindingType: "index",
        declare: (cpp) => `std::int64_t ${cpp}`,
    },
    boolean: {
        annotation: "boolean", bindingType: "bool",
        declare: (cpp) => `bool ${cpp}`,
    },
    mat4: {
        annotation: "Mat4Storage",
        bindingType: "f32",
        declare: (cpp) => `std::array<float, 16>& ${cpp}`,
    },
    matrix: {
        annotation: "Float32Array",
        bindingType: "f32",
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
        bindingType: "f32",
        declare: (cpp) => `const std::array<float, 16>& ${cpp}`,
    },
    numberArray: {
        annotation: "ArrayLike<number>",
        bindingType: "f32",
        declare: (cpp) => `const std::array<float, 16>& ${cpp}`,
    },
    // A typed buffer the body indexes and stores through, sized by its
    // caller rather than fixed at sixteen. The store's width is the kind's:
    // `u32Buffer` rounds where the pin's `Uint32Array` store rounds.
    u32Buffer: {
        annotation: "Uint32Array",
        bindingType: "u32",
        declare: (cpp) => `std::vector<std::uint32_t>& ${cpp}`,
    },
    // A record the body reads named members off. The caller supplies both
    // the annotation and the C++ type, because it owns the native record the
    // members land on -- this table stays free of any one feature's names.
    record: {
        annotation: "",
        bindingType: "scalar",
        declare: (cpp) => `const auto& ${cpp}`,
    },
};

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
 * the output is an f32 array while the input storage can be an array or a
 * PAL uniform pointer, containing f32 or f64 lanes. The body's reads widen
 * to double for both, so the operand containers are template parameters.
 * Signature adaptation uses the same parameter contracts and body lowering
 * as other pinned functions.
 */
export function lowerMat4MultiplyWriterCpp(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        "src/math/mat4-multiply-into.ts",
        "mat4MultiplyInto",
        [
            { pinned: "dst", kind: "mat4", cpp: "dst" },
            { pinned: "d", kind: "index", cpp: "d" },
            { pinned: "a", kind: "mat4", cpp: "a", cppType: "MatA" },
            { pinned: "i", kind: "index", cpp: "i" },
            { pinned: "b", kind: "mat4", cpp: "b", cppType: "MatB" },
            { pinned: "j", kind: "index", cpp: "j" },
        ],
        {
            cppName: "mat4_multiply_into",
            returns: "void",
            templateParameters: ["typename MatA", "typename MatB"],
        },
    );
}

/** The pinned full 4x4 inverse, including its f32 allocation boundary. */
export function lowerMat4InvertCpp(context: LoweringContext): string {
    const module = "src/math/mat4-invert.ts";
    const symbol = "mat4Invert";
    const { file, declaration } = context.functionDeclaration(
        module,
        symbol,
    );
    if (
        declaration.parameters.length !== 1 ||
        !ts.isIdentifier(declaration.parameters[0]!.name) ||
        declaration.parameters[0]!.name.text !== "input" ||
        declaration.parameters[0]!.type?.getText(file) !== "Mat4"
    ) {
        context.contractError(
            declaration,
            "Expected pinned mat4Invert to take (input: Mat4).",
        );
    }
    const outDeclaration = declaration.body!.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => [
            ...statement.declarationList.declarations,
        ])
        .find(
            (candidate) =>
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === "out",
        );
    const outInitializer = outDeclaration?.initializer
        ? context.unwrapExpression(outDeclaration.initializer)
        : undefined;
    if (
        !outInitializer ||
        !ts.isCallExpression(outInitializer) ||
        !ts.isIdentifier(outInitializer.expression) ||
        outInitializer.expression.text !== "allocateMat4" ||
        outInitializer.arguments.length !== 0
    ) {
        context.contractError(
            outDeclaration ?? declaration,
            "Expected pinned mat4Invert to allocate `out` with allocateMat4().",
        );
    }
    const lowerer = new PinnedNumericLowerer(file, {
        // `out` is supplied as caller storage so the translator skips the
        // pin's const OBJECT binding while preserving writes to its typed
        // array contents. The storage is f32 because allocateMat4() is.
        bindings: new Map([
            ["input", { cpp: "input", type: "f32" as const }],
            ["m", { cpp: "input", type: "f32" as const }],
            ["out", { cpp: "out", type: "f32" as const }],
        ]),
        calls: new Map([
            [
                "Math.abs",
                (args: readonly string[]) => {
                    if (args.length !== 1) {
                        return context.contractError(
                            declaration,
                            "Expected pinned mat4Invert Math.abs to take one argument.",
                        );
                    }
                    return `std::abs(${args[0]})`;
                },
            ],
        ]),
        returnValue: (expression) => {
            const returned = expression
                ? context.unwrapExpression(expression)
                : undefined;
            if (returned?.kind === ts.SyntaxKind.NullKeyword) {
                return "std::nullopt";
            }
            if (
                returned &&
                ts.isIdentifier(returned) &&
                returned.text === "out"
            ) {
                return "out";
            }
            return context.contractError(
                returned ?? declaration,
                "Expected pinned mat4Invert to return null or out.",
            );
        },
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return `// ${context.provenance(module, symbol)}
std::optional<std::array<float, 16>> mat4_invert(
    const std::array<float, 16>& input) {
    std::array<float, 16> out{};
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
        /** C++ template parameter declarations; numeric bindings stay explicit. */
        templateParameters?: readonly string[];
        /** Calls the body may make. The caller owns the whole map. */
        calls?: ReadonlyMap<string, (args: readonly string[]) => string>;
        /** See `PinnedNumericScope.matrixCalls`. */
        matrixCalls?: ReadonlySet<string>;
        /** See `PinnedNumericScope.recordCalls`. */
        recordCalls?: ReadonlyMap<string, readonly string[]>;
        /** See `PinnedNumericScope.tupleCalls`. */
        tupleCalls?: ReadonlyMap<string, number>;
        /** See `PinnedNumericScope.fixedTupleCalls`. */
        fixedTupleCalls?: ReadonlyMap<string, number>;
        /** See `PinnedNumericScope.booleanAnd`. */
        booleanAnd?: boolean;
        /** See `PinnedNumericScope.booleanOr`. */
        booleanOr?: boolean;
        /**
         * Bindings keyed by the SOURCE TEXT the body reads them through,
         * for a member of a record parameter: the translator resolves
         * `light.position` by that text, so binding it is what lets the
         * body index it. The caller owns the spelling because it owns the
         * native record the member lands on.
         */
        memberBindings?: ReadonlyMap<string, PinnedBinding>;
        /**
         * Parameters the EMISSION needs that the pin does not name, ahead
         * of its own: state a pinned body reaches through a closure and a
         * free C++ function has to be handed. They take no binding, so the
         * body cannot read them -- only the `calls` the caller bound can.
         */
        leadingParameters?: readonly string[];
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
    const signature: string[] = [...(options.leadingParameters ?? [])];
    declaration.parameters.forEach((parameter, index) => {
        const spec = parameters[index]!;
        const kind = parameterKinds[spec.kind];
        const annotation = spec.annotation ?? kind.annotation;
        // A defaulted pinned parameter is usually left unannotated, and
        // its type is then its own initializer's -- `epsilon = 1e-10` is
        // a `number` as surely as `epsilon: number` would be. Read that
        // way rather than exempted, so a default that stopped being a
        // number still fails the annotation check by name.
        const defaulted = parameter.initializer
            ? context.unwrapExpression(parameter.initializer)
            : undefined;
        const defaultAnnotation = !defaulted
            ? undefined
            : ts.isNumericLiteral(defaulted)
              ? "number"
              : defaulted.kind === ts.SyntaxKind.TrueKeyword ||
                  defaulted.kind === ts.SyntaxKind.FalseKeyword
                ? "boolean"
                : undefined;
        const pinnedAnnotation =
            parameter.type?.getText(file) ?? defaultAnnotation;
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== spec.pinned ||
            pinnedAnnotation !== annotation
        ) {
            context.contractError(
                parameter,
                `Expected pinned ${symbolName} parameter ${index} to be ` +
                    `'${spec.pinned}: ${annotation}'.`,
            );
        }
        if (spec.absent) {
            if (!parameter.questionToken) {
                context.contractError(
                    parameter,
                    `Expected pinned ${symbolName} parameter ` +
                        `'${spec.pinned}' to stay optional; the reached ` +
                        "slice supplies none.",
                );
            }
            bindings.set(spec.pinned, {
                cpp: "false",
                type: "bool",
                staticallyAbsent: true,
            });
            return;
        }
        bindings.set(
            spec.pinned,
            spec.binding ?? {
                cpp: spec.cpp,
                type: kind.bindingType,
            },
        );
        const declared = spec.cppType
            ? `${spec.mutableRecord ? "" : "const "}${spec.cppType}& ` +
              `${spec.cpp}`
            : kind.declare(spec.cpp);
        if (spec.pinnedDefault && defaultAnnotation !== "number") {
            context.contractError(
                parameter,
                `Expected pinned ${symbolName} parameter ` +
                    `'${spec.pinned}' to carry a numeric default.`,
            );
        }
        signature.push(
            spec.pinnedDefault && defaulted
                ? `${declared} = ${doubleLiteral(
                      context.numericValue(defaulted, file),
                  )}`
                : declared,
        );
        if (spec.kind === "record" && !spec.cppType) {
            context.contractError(
                parameter,
                `A record parameter needs its C++ type: '${spec.pinned}'.`,
            );
        }
    });
    for (const [text, binding] of options.memberBindings ?? []) {
        bindings.set(text, binding);
    }
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: options.calls ?? new Map(),
        ...(options.matrixCalls ? { matrixCalls: options.matrixCalls } : {}),
        ...(options.recordCalls ? { recordCalls: options.recordCalls } : {}),
        ...(options.tupleCalls ? { tupleCalls: options.tupleCalls } : {}),
        ...(options.fixedTupleCalls
            ? { fixedTupleCalls: options.fixedTupleCalls }
            : {}),
        ...(options.booleanAnd ? { booleanAnd: true } : {}),
        ...(options.booleanOr ? { booleanOr: true } : {}),
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
        (options.templateParameters
            ? `template <${options.templateParameters.join(", ")}>\n`
            : "") +
        `${options.inline ? "inline " : ""}${returnType} ` +
        `${options.cppName}(\n    ${signature.join(",\n    ")}) {\n` +
        `${body}\n}`
    );
}
