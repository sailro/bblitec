import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const workerSource = `
interface Attach { type: "attach"; port: MessagePort; }
interface Request { values: Float32Array; reply?: MessagePort; }
function serve(port: MessagePort): void {
    port.onmessage = (event: MessageEvent) => {
        const request = event.data as Request;
        let sum = 0;
        for (const value of request.values) sum += value;
        const echo = request.values;
        port.postMessage({ sum, echo }, [echo.buffer]);
        if (echo.length !== 0) throw new Error("worker buffer detach");
        const reply = request.reply;
        if (reply) {
            reply.postMessage({ sum: sum * 2, echo: new Float32Array(0) });
            reply.close();
        }
    };
    port.onmessageerror = () => {
        throw new Error("message deserialization");
    };
    port.start?.();
}
addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Attach;
    if (data.type === "attach") serve(data.port);
});
`;

const entrySource = `
interface Attach { type: "attach"; port: MessagePort; }
interface Reply { sum: number; echo: Float32Array; }
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const ports = new Set<MessagePort>();
const channel = new MessageChannel();
const attach: Attach = { type: "attach", port: channel.port2 };
worker.postMessage(attach, [channel.port2]);
ports.add(channel.port1);
const host = channel.port1;
const local = new MessageChannel();
const localLog: string[] = [];
const workerLog: string[] = [];
let pending = 2;
const finish = (): void => {
    if (--pending !== 0) return;
    for (const port of ports) port.close();
    ports.clear();
    worker.terminate();
    const closed = new MessageChannel();
    closed.port1.onmessage = () => {
        throw new Error("closed port delivery");
    };
    closed.port1.close();
    closed.port2.postMessage(1);
    setTimeout(() => {
        const observed = localLog.join(",") + "|" + workerLog.join(",");
        if (observed !== "local:7,back:8|sum:6:3:1,sum:2:2:1,reply:4,sum:4:1:4")
            throw new Error("observed " + observed);
        globalThis.close();
    }, 20);
};
local.port1.addEventListener("message", (event: MessageEvent<number>) => {
    localLog.push("local:" + event.data);
    local.port1.postMessage(event.data + 1);
});
local.port1.start();
local.port2.onmessage = (event: MessageEvent<number>) => {
    localLog.push("back:" + event.data);
    finish();
};
local.port2.postMessage(7);
host.onmessage = (event: MessageEvent) => {
    const reply = event.data as Reply;
    workerLog.push("sum:" + reply.sum + ":" + reply.echo.length + ":" + reply.echo[0]);
    if (workerLog.length === 4) finish();
};
const values = new Float32Array([1, 2, 3]);
const buffer = values.buffer;
host.postMessage({ values }, [values.buffer]);
if (values.length !== 0 || buffer.byteLength !== 0) throw new Error("buffer detach");
const answer = new MessageChannel();
answer.port1.onmessage = (event: MessageEvent) => {
    const reply = event.data as Reply;
    workerLog.push("reply:" + reply.sum);
    answer.port1.close();
    host.postMessage({ values: new Float32Array([4]) });
};
host.postMessage({ values: new Float32Array([1, 1]), reply: answer.port2 }, [answer.port2]);
`;

test("message channels cross realms with transferred ports and buffers", (t) => {
    const directory = resolve("artifacts/worker-message-ports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), workerSource);
    const result = compileSource(entrySource, {
        fileName: resolve(directory, "entry.ts"),
    });
    assert.match(result.cpp, /bbl::pal::create_message_channel\(\)/);
    assert.match(result.cpp, /bbl::js::BufferTransfer/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "worker-message-ports/run", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 20000,
        expectedOutput: "",
    });
});

for (const [name, source, message] of [
    [
        "absent run-time transfer list",
        "const channel=new MessageChannel();const list:Transferable[]|undefined=undefined;channel.port1.postMessage(1,list);",
        /A run-time transfer list must be present/,
    ],
    [
        "handler read",
        "const channel=new MessageChannel();const handler=channel.port1.onmessage;",
        /MessagePort.onmessage is written natively, not read/,
    ],
    [
        "channel in a message",
        "const channel=new MessageChannel();channel.port1.postMessage({channel});",
        /'message.channel' is a native message-channel handle/,
    ],
] as const) {
    test(`message ports refuse ${name}`, () => {
        const directory = resolve("artifacts/worker-message-ports/refusals");
        mkdirSync(directory, { recursive: true });
        writeFileSync(resolve(directory, "worker.ts"), "self.close();");
        assert.throws(
            () =>
                compileSource(
                    `const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();${source}`,
                    { fileName: resolve(directory, "entry.ts") },
                ),
            message,
        );
    });
}

const targetWorkerSource = `
type Constant = number | readonly number[];
interface Request { constants: Record<string, Constant>; values: Float32Array[]; }
function handle(port: MessagePort, data: Request | null | undefined): void {
    if (!data) return;
    let total = 0;
    for (const key in data.constants) {
        const constant = data.constants[key]!;
        total += typeof constant === "number" ? constant : constant.length;
    }
    for (const values of data.values) total += values.length;
    port.postMessage({ type: "sum", value: total });
    throw new Error("worker failure");
}
addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type: "attach"; port: MessagePort } | null | undefined;
    if (!data || data.type !== "attach") return;
    const port = data.port;
    port.onmessage = (ev: MessageEvent) => handle(port, ev.data as Request | null | undefined);
});
`;

const targetEntrySource = `
interface FailTarget {
    onerror?: ((event: ErrorEvent) => void) | null;
    onmessageerror?: ((event: MessageEvent) => void) | null;
}
type Constant = number | readonly number[];
type Reply = { type: "sum"; value: number } | { type: "none" };
type Post = (message: { constants: Record<string, Constant>; values: Float32Array[] }, transfer?: Transferable[]) => void;
const log: string[] = [];
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const channel = new MessageChannel();
function install(target: FailTarget, name: string): void {
    if ("onerror" in target) {
        target.onerror = (event: ErrorEvent) => {
            event.preventDefault();
            log.push(name + ":" + event.lineno + ":" + event.colno);
            const observed = log.join(",");
            if (observed !== "sum:8,worker:0:0") throw new Error("observed " + observed);
            channel.port1.close();
            worker.terminate();
            globalThis.close();
        };
    }
    target.onmessageerror = () => {
        throw new Error(name + " messageerror");
    };
}
install(worker, "worker");
install(channel.port1, "port");
channel.port1.onmessage = (event: MessageEvent) => {
    const reply = event.data as Reply;
    if (!reply) return;
    if (reply.type === "sum") log.push("sum:" + reply.value);
};
const post: Post = (message, transfer) => {
    channel.port1.postMessage(message, transfer ?? []);
};
worker.postMessage({ type: "attach", port: channel.port2 }, [channel.port2]);
const sources = [new Float32Array([1]), new Float32Array([2, 3])];
const buffers = sources.length > 0 ? sources.flatMap((source) => [source.buffer]) : [];
post({ constants: { a: 3, b: [5, 6] }, values: sources }, buffers);
if (sources[0]!.length !== 0 || sources[1]!.length !== 0) throw new Error("run-time transfer detach");
`;

test("message targets take handlers, membership tests, unions and run-time transfer lists", (t) => {
    const directory = resolve("artifacts/worker-message-ports/targets");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), targetWorkerSource);
    const result = compileSource(targetEntrySource, {
        fileName: resolve(directory, "entry.ts"),
    });
    assert.match(result.cpp, /bbl::js::transfer_list\(/);
    assert.match(result.cpp, /->set_error_handler\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "worker-message-ports/targets/run", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 20000,
        expectedOutput: "",
    });
});

test("a MessagePort refuses an error handler", () => {
    const directory = resolve("artifacts/worker-message-ports/refusals");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    assert.throws(
        () =>
            compileSource(
                `const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
                interface Target { onerror?: ((event: ErrorEvent) => void) | null; onmessageerror?: ((event: MessageEvent) => void) | null; }
                function install(target: Target): void { target.onerror = () => {}; }
                const channel = new MessageChannel(); install(channel.port1);`,
                { fileName: resolve(directory, "entry.ts") },
            ),
        /A MessagePort has no error event/,
    );
});

const documentWorkerSource = `
function count(values: Float32Array): number {
    let total = 0;
    for (const value of values) total += value;
    return total;
}
addEventListener("message", (event: MessageEvent) => {
    const data = event.data as unknown;
    const document = data as { name: string; values: Float32Array; list: number[] };
    const reply: unknown = { total: count(document.values) + document.list.length, name: document.name };
    self.postMessage(reply);
});
`;

const documentEntrySource = `
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.addEventListener("message", (event: MessageEvent) => {
    const reply = event.data as unknown;
    const document = reply as { total: number; name: string };
    if (document.total !== 8 || document.name !== "doc") throw new Error("document reply");
    worker.terminate();
    globalThis.close();
});
const payload: unknown = { name: "doc", values: new Float32Array([1, 2, 3]), list: [4, 5] };
worker.postMessage(payload);
`;

test("dynamic documents cross realms with the typed arrays they hold", (t) => {
    const directory = resolve("artifacts/worker-message-ports/documents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), documentWorkerSource);
    const result = compileSource(documentEntrySource, {
        fileName: resolve(directory, "entry.ts"),
    });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "worker-message-ports/documents/run",
        result.cpp,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 20000,
            expectedOutput: "",
        },
    );
});

const shapedWorkerSource = `
interface Digest { composed: number; parts: Readonly<Record<string, number>> }
function digest(table: Readonly<Record<string, unknown>>): number { return Object.keys(table).length; }
interface Init { type: "init"; digest: Digest; buffer: ArrayBuffer; sab?: SharedArrayBuffer; capacity: number }
interface Add { type: "add"; index: number }
type In = Init | Add;
let header: Int32Array | null = null;
function init(msg: Init): void {
    const { sab, capacity } = msg;
    if (sab) header = new Int32Array(sab, 0, capacity);
    const view = new Int32Array(msg.buffer, 4, capacity);
    self.postMessage(view[0]! + view[1]! + digest(msg.digest.parts) + (header ? 100 : 0));
}
function handle(data: In | null | undefined): void {
    if (!data) return;
    if (data.type === "init") init(data);
}
addEventListener("message", (ev: MessageEvent) => handle(ev.data as In | null | undefined));
`;

const shapedEntrySource = `
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.addEventListener("message", (event: MessageEvent<number>) => {
    if (event.data !== 7) throw new Error("view sum " + event.data);
    worker.terminate();
    globalThis.close();
});
const buffer = new ArrayBuffer(16);
new Int32Array(buffer).set([1, 2, 3, 4]);
worker.postMessage({ type: "init", digest: { composed: 1, parts: { a: 1, b: 2 } }, buffer, capacity: 2 });
`;

test("a message keeps its shape beside a document member and views its buffers", (t) => {
    const directory = resolve("artifacts/worker-message-ports/shaped");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), shapedWorkerSource);
    const result = compileSource(shapedEntrySource, {
        fileName: resolve(directory, "entry.ts"),
    });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "worker-message-ports/shaped/run", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 20000,
        expectedOutput: "",
    });
});
