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
     */
    kind: "number" | "boolean" | "mat4";
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
};

/** A pinned function of scalars (and at most a Mat4Storage target), as C++. */
export function lowerPinnedFunction(
    context: LoweringContext,
    modulePath: string,
    symbolName: string,
    parameters: readonly PinnedFunctionParameter[],
    options: {
        cppName: string;
        /** `void` emits no return contract; `double` wires `returnValue`. */
        returns: "void" | "double";
        /** Emit `inline` — for a function landing in a generated header. */
        inline?: boolean;
        /** Calls the body may make. The caller owns the whole map. */
        calls?: ReadonlyMap<string, (args: readonly string[]) => string>;
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
            type: spec.kind === "mat4"
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
        ...(options.returns === "double"
            ? {
                  returnValue: (
                      expression: ts.Expression | undefined,
                  ): string => {
                      if (!expression) {
                          return context.contractError(
                              declaration,
                              `Expected pinned ${symbolName} to return a ` +
                                  "value.",
                          );
                      }
                      return lowerer.expression(expression);
                  },
              }
            : {}),
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return (
        `// ${context.provenance(modulePath, symbolName)}\n` +
        `${options.inline ? "inline " : ""}${options.returns} ` +
        `${options.cppName}(\n    ${signature.join(",\n    ")}) {\n` +
        `${body}\n}`
    );
}
