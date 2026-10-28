// The forms the pinned MeshLoD core uses, lowered by the record model in
// test/pinned-record-forms.test.ts and run against this module under Node:
// an Error interface filled through a mutable view and `Object.assign`, a
// type guard over an `unknown` reading a literal-union code, a module
// `const` aliasing `Math.fround`, tuple patterns in `for...of`, element reads
// of a `Uint32Array | number[]`, a lazy `Uint16Array` cache returned through
// an assignment, `|=` through `!` on a typed element, a Set's first iterated
// value, BigInt reads of a DataView, `toString(16)` with `padStart`/`padEnd`,
// and `?.` over a value its type never makes absent.
export type FailureCode = "FX_ONE" | "FX_TWO";
export interface Failure extends Error {
    readonly code: FailureCode;
    readonly detail?: number;
}
export interface FailureContext {
    detail?: number;
}
type FailureMutable = { -readonly [K in keyof Failure]: Failure[K] };
export interface Box {
    readonly size: number;
}

function failure(code: FailureCode, message: string, context?: FailureContext): Failure {
    const error = new Error(message) as FailureMutable;
    error.name = "Failure";
    error.code = code;
    if (context) {
        Object.assign(error, context);
    }
    return error;
}

function isFailure(error: unknown): error is Failure {
    return error instanceof Error && typeof (error as Partial<Failure>).code === "string" && (error as Failure).code.startsWith("FX_");
}

const f32 = Math.fround;
const fadd = (a: number, b: number): number => f32(a + b);

function at(values: Uint32Array | readonly number[], index: number): number {
    return values[index]!;
}

let cache: Uint16Array | null = null;
function table(): Uint16Array {
    if (cache) {
        return cache;
    }
    const built = new Uint16Array(3);
    built[0] = 70000;
    return (cache = built);
}

function limit(box: Box | undefined, fallback: number): number {
    return box ? (box?.size ?? fallback) : fallback;
}

export function run(): string {
    const lines: string[] = [];
    try {
        throw failure("FX_TWO", "boom", { detail: 3 });
    } catch (caught) {
        lines.push(`caught ${isFailure(caught)}`);
    }
    const made = failure("FX_ONE", "made", { detail: 9 });
    lines.push(`${made.name} ${made.code} ${made.message} ${made.detail}`);
    lines.push(`fadd ${fadd(0.1, 0.2)}`);
    let sum = 0;
    const points: readonly (readonly [number, number])[] = [
        [1, 2],
        [3, 4],
    ];
    for (const [x, y] of points) {
        sum += x * 10 + y;
    }
    lines.push(`points ${sum}`);
    lines.push(`at ${at(new Uint32Array([5, 6]), 1)} ${at([7, 8], 0)}`);
    lines.push(`table ${table()[0]} ${table() === table()}`);
    const bits = new Uint32Array(2);
    for (const index of [1, 33, 34]) {
        bits[index >>> 5]! |= 1 << (index & 31);
    }
    lines.push(`bits ${bits[0]} ${bits[1]}`);
    // Each iteration's binding, held by the closure that captured it.
    const reads: (() => number)[] = [];
    for (const index of [5, 6, 7]) {
        reads.push(() => index * 2);
    }
    lines.push(`captured ${reads.map((read) => read()).join(",")}`);
    const pending = new Set<number>([4, 2, 9]);
    pending.delete(4);
    lines.push(`first ${pending.values().next().value!}`);
    const bytes = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 1]);
    const view = new DataView(bytes.buffer);
    const big = view.getBigUint64(0, true);
    lines.push(`big ${big > BigInt(Number.MAX_SAFE_INTEGER)} ${Number(view.getBigUint64(0, false))}`);
    lines.push(`hex ${(255).toString(16).padStart(4, "0")} ${"7".padEnd(3)}|`);
    lines.push(`limit ${limit({ size: 4 }, 1)} ${limit(undefined, 1)}`);
    return `${lines.join("\n")}\n`;
}
