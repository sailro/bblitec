import {
    renderNativeDeclaration,
    type NativeDeclaration,
} from "./native-declarations.js";

/** Statement facts supplied by the lowering operation, before C++ rendering. */
export type NativeStatement =
    | NativeDeclaration
    | { readonly kind: "expression"; readonly code: string }
    /** A generator-owned complete scope with no transfer to its enclosing scope. */
    | {
          readonly kind: "region";
          readonly code: string;
          readonly captures: readonly NativeLocal[];
      }
    | {
          readonly kind: "control";
          readonly code: string;
          readonly transfer:
              "return" | "break" | "continue" | "goto" | "suspend" | "throw";
      }
    | { readonly kind: "verbatim"; readonly code: string }
    | { readonly kind: "comment"; readonly code: string }
    | {
          readonly kind: "open";
          readonly code: string;
          /** A loop moves as a whole; its iterations never gain outline calls. */
          readonly iteration?: true;
          /** Names introduced by a loop, condition or exception header. */
          readonly locals?: readonly NativeLocal[];
          readonly outlineInterior?: false;
          readonly breaks?: true;
      }
    | {
          readonly kind: "branch";
          readonly code: string;
          readonly locals?: readonly NativeLocal[];
          readonly outlineInterior?: false;
      }
    | { readonly kind: "close"; readonly code: string };

export interface NativeLocal {
    readonly name: string;
    readonly type: string | undefined;
}

/** One emission event; indentation is presentation, never a scope boundary. */
export interface NativeEmission {
    readonly statement: NativeStatement;
    readonly indent: string;
    readonly source?: string;
}

export function nativeStatementCode(statement: NativeStatement): string {
    return statement.kind === "declaration"
        ? renderNativeDeclaration(statement)
        : statement.code;
}

export function renderNativeEmission(emission: NativeEmission): string {
    return emission.indent + nativeStatementCode(emission.statement);
}

export function verbatimEmission(code: string): NativeEmission {
    return { statement: { kind: "verbatim", code }, indent: "" };
}
