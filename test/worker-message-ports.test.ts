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
        "runtime transfer list",
        "const channel=new MessageChannel();const list:Transferable[]=[];channel.port1.postMessage(1,list);",
        /Worker transfer lists currently require an explicit array/,
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
