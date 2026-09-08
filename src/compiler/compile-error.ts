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

    public constructor(
        fileName: string,
        line: number,
        column: number,
        message: string,
    ) {
        super(`${fileName}:${line}:${column}: ${message}`);
        this.name = "CompileError";
        this.fileName = fileName;
        this.line = line;
        this.column = column;
    }
}
