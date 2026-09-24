import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const payloadTypes = `
export interface Graph {
    name: string;
    links: Map<string, Graph>;
    members: Set<Graph>;
}
export interface Payload {
    when: Date;
    again: Date;
    scores: Map<string, number>;
    sameScores: Map<string, number>;
    groups: Map<number, Set<string>>;
    tags: Set<string>;
    graph: Graph;
    point: [number, number, number];
    bytes: Uint8Array;
    tail: Float32Array;
    floats: Float32Array;
    doubles: Float64Array;
    signed: Int32Array;
    unsigned: Uint32Array;
    shorts: Int16Array;
    words: Uint16Array;
    tiny: Int8Array;
    view: DataView;
    buffer: ArrayBuffer;
    window: Uint8Array;
}
export function verify(copy: Payload): void {
    if (copy.when.getTime() !== 1700000000000) throw new Error("Date value");
    if (copy.again !== copy.when) throw new Error("Date identity");
    if (copy.scores.size !== 2 || copy.scores.get("a") !== 1 || copy.scores.get("b") !== -0.5)
        throw new Error("Map entries");
    if (copy.scores.has("late") || copy.sameScores !== copy.scores) throw new Error("Map snapshot or identity");
    const group = copy.groups.get(7);
    if (!group || group.size !== 2 || !group.has("x") || !group.has("y")) throw new Error("nested Set");
    const order: string[] = [];
    copy.tags.forEach((tag) => order.push(tag));
    if (order.join(",") !== "red,blue") throw new Error("Set order");
    if (copy.graph.links.get("self") !== copy.graph || !copy.graph.members.has(copy.graph))
        throw new Error("graph cycle");
    if (copy.point[0] !== 1 || copy.point[2] !== 3) throw new Error("tuple");
    if (copy.floats.length !== 4 || copy.floats[0] !== 1.5 || copy.floats[1] !== -2.25)
        throw new Error("Float32Array");
    if (copy.tail.byteOffset !== 8 || copy.tail.length !== 2 || copy.tail[1] !== 4) throw new Error("typed-array window");
    if (copy.buffer !== copy.floats.buffer || copy.window.buffer !== copy.buffer || copy.tail.buffer !== copy.buffer)
        throw new Error("buffer aliasing");
    if (copy.window.byteOffset !== 4 || copy.window.length !== 8) throw new Error("Uint8Array window");
    if (copy.view.buffer !== copy.bytes.buffer || copy.view.byteOffset !== 1 || copy.view.getUint8(1) !== 3)
        throw new Error("DataView");
    if (copy.doubles[0] !== Math.PI || 1 / copy.doubles[1]! !== -Infinity) throw new Error("Float64Array");
    if (copy.signed[0] !== -5 || copy.unsigned[0] !== 4000000000 || copy.shorts[0] !== -300)
        throw new Error("integer arrays");
    if (copy.words[0] !== 65000 || copy.tiny[0] !== -100 || copy.bytes[3] !== 250)
        throw new Error("byte arrays");
}
`;

const echoWorker = `
import { verify, type Payload } from "./types";
self.addEventListener("message", (event: MessageEvent<Payload>) => {
    const copy = event.data;
    verify(copy);
    copy.graph.name = "worker";
    self.postMessage(copy);
});
`;

const roundTrip = `
import { verify, type Graph, type Payload } from "./types";
const worker = new Worker(new URL("./echo.ts", import.meta.url), { type: "module" });
const floats = new Float32Array([1.5, -2.25, 3, 4]);
const bytes = new Uint8Array([1, 2, 3, 250]);
const graph: Graph = { name: "root", links: new Map<string, Graph>(), members: new Set<Graph>() };
graph.links.set("self", graph);
graph.members.add(graph);
const when = new Date(1700000000000);
const scores = new Map<string, number>([["a", 1], ["b", -0.5]]);
const payload: Payload = {
    when,
    again: when,
    scores,
    sameScores: scores,
    groups: new Map<number, Set<string>>([[7, new Set<string>(["x", "y"])]]),
    tags: new Set<string>(["red", "blue"]),
    graph,
    point: [1, 2, 3],
    bytes,
    tail: new Float32Array(floats.buffer, 8, 2),
    floats,
    doubles: new Float64Array([Math.PI, -0]),
    signed: new Int32Array([-5, 6]),
    unsigned: new Uint32Array([4000000000]),
    shorts: new Int16Array([-300]),
    words: new Uint16Array([65000]),
    tiny: new Int8Array([-100]),
    view: new DataView(bytes.buffer, 1, 2),
    buffer: floats.buffer,
    window: new Uint8Array(floats.buffer, 4, 8),
};
worker.addEventListener("message", (event: MessageEvent<Payload>) => {
    const copy = event.data;
    verify(copy);
    if (copy.graph.name !== "worker" || graph.name !== "root") throw new Error("Round trip shared a record");
    if (copy.floats === floats || copy.graph === graph || copy.when === when) throw new Error("Round trip kept sender identity");
    globalThis.close();
});
worker.postMessage(payload);
floats[0] = 99;
scores.set("late", 1);
when.setTime(0);
`;

function buildAndRun(directory: string, cpp: string): void {
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    const source = resolve(directory, "main.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/MD",
        "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { timeout: 15000, stdio: "pipe" });
}

test("worker messages clone Date, Map, Set, numeric tuples and buffer views with their aliases", (t) => {
    const directory = resolve("artifacts/worker-clone-types");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "types.ts"), payloadTypes);
    writeFileSync(resolve(directory, "echo.ts"), echoWorker);
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, roundTrip);
    const result = compileSource(roundTrip, { fileName: entry });
    assert.ok(result.manifest.features.includes("platform:workers"));
    if (!optionalNativeFixtureTools(false)) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    buildAndRun(directory, result.cpp);
});

test("worker message shapes without a native clone codec refuse at generation", () => {
    const directory = resolve("artifacts/worker-clone-refusals");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const entry = resolve(directory, "entry.ts");
    const refuses = (body: string, expected: RegExp): void => {
        const source = `const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n${body}`;
        writeFileSync(entry, source);
        assert.throws(
            () => compileSource(source, { fileName: entry }),
            expected,
        );
    };
    refuses(
        `worker.postMessage({ failure: new Error("lost") });`,
        /Worker message value 'message\.failure' is an Error, which has no native structured-clone codec\./,
    );
    refuses(
        `const failures = new Map<string, Error>(); worker.postMessage(failures);`,
        /'message\.values\(\)' is an Error/,
    );
    refuses(
        `worker.postMessage({ format: new Intl.DateTimeFormat() });`,
        /'message\.format' is an Intl\.DateTimeFormat/,
    );
    refuses(
        `worker.addEventListener("message", (event: MessageEvent<{ pair: [string, number] }>) => { if (event.data.pair[1] === 1) worker.terminate(); });`,
        /'event\.data\.pair\[\]' is a mixed union/,
    );
});

test("buffer-view clone codecs share received buffers and validate views", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/worker-clone-types-check");
    mkdirSync(directory, { recursive: true });
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/MD",
        `/I${resolve("native/include")}`,
        resolve("test/fixtures/worker-clone-types-check.cpp"),
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 15000 });
});
