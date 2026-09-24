import type ts from "typescript";

/**
 * A refusal the compiler raises at a scene-source location: what `fail`
 * throws, and therefore the one error a probe that tries a lowering may
 * catch and keep looking past. Anything else escaping a lowering is an
 * internal error and must propagate.
 */
export class CompileError extends Error {
    public readonly fileName: string;
    public readonly line: number;
    public readonly column: number;
    /** The refusal text without its location prefix. */
    public readonly detail: string;
    /** The node the refusal was raised at, when the raiser had one. */
    public readonly subject: ts.Node | undefined;

    public constructor(
        fileName: string,
        line: number,
        column: number,
        message: string,
        public readonly reason:
            | "unsupported"
            | "static-value-required"
            | "entry-scope-required" = "unsupported",
        subject?: ts.Node,
    ) {
        super(`${fileName}:${line}:${column}: ${message}`);
        this.name = "CompileError";
        this.fileName = fileName;
        this.line = line;
        this.column = column;
        this.detail = message;
        this.subject = subject;
    }
}
