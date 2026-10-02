import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [name, workerSource, send, expected] of [
    [
        "inline-record-result",
        `
        type Packet={kind:'value';value:number}|{kind:'done'};
        self.addEventListener('message',(event:MessageEvent<Packet>)=>{
            const message=event.data;
            const alias=message;
            if(message.kind==='value'&&alias.kind==='value'){
                alias.value=message.value+3;
                if(message.value!==10)throw new Error('inline result alias');
                self.postMessage(message.value);
            }else{throw new Error('unexpected tag');}
        });
        `,
        "worker.postMessage({kind:'value',value:7});",
        10,
    ],
    [
        "reference-record-result",
        `
        interface Packet{value:number;next?:Packet;}
        self.addEventListener('message',(event:MessageEvent<Packet>)=>{
            const first=event.data;
            const again=event.data;
            if(first!==again||first.next!==first)throw new Error('message identity');
            again.value+=3;
            queueMicrotask(()=>{
                if(first.value!==10||first.next!==first)throw new Error('retained result lifetime');
                self.postMessage(first.value);
            });
        });
        self.addEventListener('message',(event:MessageEvent<Packet>)=>{
            const same=event.data;
            if(same.value!==10||same.next!==same)throw new Error('listener payload identity');
        });
        `,
        `
        interface Packet{value:number;next?:Packet;}
        const message:Packet={value:7};message.next=message;
        worker.postMessage(message);
        message.value=99;
        `,
        10,
    ],
] as const) {
    test(`worker message property reads own ${name}`, (t) => {
        const listeners: Array<(event: { data: unknown }) => void> = [];
        const deferred: Array<() => void> = [];
        const observed: unknown[] = [];
        runInNewContext(
            ts.transpileModule(workerSource, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
            {
                self: {
                    addEventListener: (
                        _type: string,
                        listener: (event: { data: unknown }) => void,
                    ) => listeners.push(listener),
                    postMessage: (value: unknown) => observed.push(value),
                },
                queueMicrotask: (callback: () => void) =>
                    deferred.push(callback),
            },
        );
        const packet: { value: number; kind?: string; next?: unknown } = {
            value: 7,
        };
        if (name === "inline-record-result") packet.kind = "value";
        else packet.next = packet;
        const event = { data: structuredClone(packet) };
        packet.value = 99;
        for (const listener of listeners) listener(event);
        for (const callback of deferred) callback();
        assert.deepEqual(observed, [expected]);
        const directory = resolve("artifacts/worker-message-results", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(resolve(directory, "worker.ts"), workerSource);
        const source = `
            const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
            worker.addEventListener('message',(event:MessageEvent<number>)=>{
                if(event.data!==${expected})throw new Error('worker result');
                globalThis.close();
            });
            ${send}
        `;
        const result = compileSource(source, {
            fileName: resolve(directory, "entry.ts"),
        });
        if (name === "inline-record-result")
            assert.match(result.cpp, /struct Packet\s*\{/);
        else
            assert.match(result.cpp, /using Packet = bbl::js::Ref<PacketData>/);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `worker-message-results/${name}`,
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
}
