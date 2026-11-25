/**
 * A dictionary (`Record<string, number>`, `Record<number, number>`) is a
 * plain object in JavaScript: a message clones it as one wherever it sits (a
 * record member, an array element, a Map value, the whole message), its own
 * properties in property order (array-index names first, a number key as its
 * string). A typed receiver reads it back into its dictionary storage; one
 * reading `unknown` gets a document object.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const types = `
export interface Tally {
    label: string;
    counts: Record<string, number>;
    extra?: Record<string, number>;
    rows: Record<string, number>[];
    byId: Record<number, number>;
}
export function tally(): Tally {
    const counts: Record<string, number> = {};
    counts["b"] = 1;
    counts["a"] = 2;
    counts["10"] = 3;
    counts["2"] = 4;
    const row: Record<string, number> = {};
    row["z"] = 7;
    const byId: Record<number, number> = {};
    byId[9] = 90;
    byId[1] = 10;
    return { label: "t", counts, rows: [row, row], byId };
}
export function verifyTyped(copy: Tally, added: boolean): void {
    if (copy.label !== "t") throw new Error("label");
    const keys = Object.keys(copy.counts).join(",");
    if (keys !== (added ? "2,10,b,a,c" : "2,10,b,a")) throw new Error("typed keys " + keys);
    if (copy.counts["a"] !== 2 || copy.counts["2"] !== 4) throw new Error("typed values");
    if (copy.extra !== undefined) throw new Error("typed extra");
    if (copy.rows.length !== 2 || copy.rows[0] !== copy.rows[1] || copy.rows[0]!["z"] !== 7)
        throw new Error("typed rows");
    if (Object.keys(copy.byId).join(",") !== "1,9" || copy.byId[9] !== 90) throw new Error("typed byId");
}
export function bare(): Record<string, number> {
    const entries: Record<string, number> = {};
    entries["k"] = 1;
    entries["0"] = 2;
    return entries;
}
export function verifyBare(copy: Record<string, number>): void {
    if (Object.keys(copy).join(",") !== "0,k" || copy["k"] !== 1 || copy["0"] !== 2) throw new Error("bare");
}
export function verifyNested(copy: Map<string, Record<string, number>>): void {
    if (copy.size !== 2 || copy.get("x") !== copy.get("y")) throw new Error("nested identity");
    verifyBare(copy.get("x")!);
}
export function verifyBareDocument(copy: unknown): void {
    const entries = copy as Record<string, unknown>;
    if (Object.keys(entries).join(",") !== "0,k" || entries["k"] !== 1) throw new Error("bare document");
}
export function verifyDocument(copy: unknown): void {
    const record = copy as { label?: unknown; counts?: unknown; extra?: unknown };
    if (record.label !== "t") throw new Error("document label");
    const counts = record.counts as Record<string, unknown> | undefined;
    if (typeof counts !== "object" || counts === null) throw new Error("document counts");
    const keys = Object.keys(counts).join(",");
    if (keys !== "2,10,b,a") throw new Error("document keys " + keys);
    if (counts["a"] !== 2 || counts["10"] !== 3) throw new Error("document values");
    if (record.extra !== undefined) throw new Error("document extra");
    const rows = (copy as { rows: Record<string, unknown>[] }).rows;
    if (rows.length !== 2 || rows[0] !== rows[1] || rows[0]!["z"] !== 7) throw new Error("document rows");
    const byId = (copy as { byId: Record<string, unknown> }).byId;
    if (Object.keys(byId).join(",") !== "1,9" || byId["9"] !== 90) throw new Error("document byId");
}
`;

const typedWorker = `
import { verifyTyped, type Tally } from "./types";
self.addEventListener("message", (event: MessageEvent<Tally>) => {
    const copy = event.data;
    verifyTyped(copy, false);
    copy.counts["c"] = 5;
    self.postMessage(copy);
});
`;

const documentWorker = `
import { verifyDocument } from "./types";
self.addEventListener("message", (event: MessageEvent<unknown>) => {
    verifyDocument(event.data);
    self.postMessage(event.data);
});
`;

const bareWorker = `
import { verifyBare } from "./types";
self.addEventListener("message", (event: MessageEvent<Record<string, number>>) => {
    const copy = event.data;
    verifyBare(copy);
    const nested = new Map<string, Record<string, number>>();
    nested.set("x", copy);
    nested.set("y", copy);
    self.postMessage(nested);
});
`;

const bareDocumentWorker = `
import { verifyBareDocument } from "./types";
self.addEventListener("message", (event: MessageEvent<unknown>) => {
    verifyBareDocument(event.data);
    self.postMessage(event.data);
});
`;

const entry = `
import { bare, tally, verifyBare, verifyNested, verifyTyped, type Tally } from "./types";
const typed = new Worker(new URL("./typed.ts", import.meta.url), { type: "module" });
const documents = new Worker(new URL("./document.ts", import.meta.url), { type: "module" });
const bareTyped = new Worker(new URL("./bare.ts", import.meta.url), { type: "module" });
const bareDocuments = new Worker(new URL("./bare-document.ts", import.meta.url), { type: "module" });
let answers = 0;
const done = (): void => {
    if (++answers === 4) globalThis.close();
};
typed.addEventListener("message", (event: MessageEvent<Tally>) => {
    verifyTyped(event.data, true);
    if (event.data.counts["c"] !== 5) throw new Error("typed reply");
    done();
});
documents.addEventListener("message", (event: MessageEvent<Tally>) => {
    verifyTyped(event.data, false);
    done();
});
bareTyped.addEventListener("message", (event: MessageEvent<Map<string, Record<string, number>>>) => {
    verifyNested(event.data);
    done();
});
bareDocuments.addEventListener("message", (event: MessageEvent<Record<string, number>>) => {
    verifyBare(event.data);
    done();
});
typed.postMessage(tally());
documents.postMessage(tally());
bareTyped.postMessage(bare());
bareDocuments.postMessage(bare());
`;

test("a dictionary clones as a plain object in JavaScript", () => {
    const { outputText } = ts.transpileModule(types, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    });
    const exports: Record<string, unknown> = {};
    runInNewContext(outputText, { exports, structuredClone });
    const api = exports as {
        tally(): object;
        bare(): object;
        verifyTyped(copy: object, added: boolean): void;
        verifyDocument(copy: unknown): void;
        verifyBare(copy: object): void;
        verifyNested(copy: Map<string, object>): void;
        verifyBareDocument(copy: unknown): void;
    };
    const copy = structuredClone(api.tally()) as { counts: object };
    assert.ok(!(copy.counts instanceof Map));
    api.verifyTyped(copy, false);
    api.verifyDocument(copy);
    const entries = api.bare();
    api.verifyBare(structuredClone(entries));
    api.verifyBareDocument(structuredClone(entries));
    api.verifyNested(
        structuredClone(
            new Map([
                ["x", entries],
                ["y", entries],
            ]),
        ),
    );
});

test("a dictionary round-trips in every position to typed and unknown worker reads", (t) => {
    const directory = resolve("artifacts/worker-dictionary-clone");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "types.ts"), types);
    writeFileSync(resolve(directory, "typed.ts"), typedWorker);
    writeFileSync(resolve(directory, "document.ts"), documentWorker);
    writeFileSync(resolve(directory, "bare.ts"), bareWorker);
    writeFileSync(resolve(directory, "bare-document.ts"), bareDocumentWorker);
    const entryFile = resolve(directory, "entry.ts");
    writeFileSync(entryFile, entry);
    const { cpp } = compileSource(entry, { fileName: entryFile });
    assert.match(cpp, /bbl::js::Dictionary<std::string, double> counts;/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const source = resolve(directory, "main.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        source,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { timeout: 15000, stdio: "pipe" });
});
