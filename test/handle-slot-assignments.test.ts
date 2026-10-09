import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored resource fields and array slots retain replacement identity and receiver order", (t) => {
    const result = compileSource(`
        import {createEngine,createStorageBuffer,type StorageBuffer} from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const first = createStorageBuffer(engine, new Float32Array([1]));
            const second = createStorageBuffer(engine, new Float32Array([2]));
            const third = createStorageBuffer(engine, new Float32Array([3]));
            interface Store { buffer:StorageBuffer; }
            const store:Store = {buffer:first};
            const alias = store;
            const writers:Array<(target:Store,value:StorageBuffer) => void> = [(target,value) => { target.buffer = value; }];
            writers[0]!(store, second);
            if (alias.buffer !== second || first === second) throw new Error("record handle replacement");
            let selected:Store = store;
            function changeReceiver():StorageBuffer { selected = {buffer:third}; return first; }
            selected.buffer = changeReceiver();
            if (alias.buffer !== first || selected.buffer !== third) throw new Error("record receiver snapshot");
            let buffers:StorageBuffer[] = [first];
            const original = buffers;
            function changeArray():StorageBuffer { buffers = [third]; return second; }
            buffers[0] = changeArray();
            if (original[0] !== second || buffers[0] !== third) throw new Error("array receiver snapshot");
            function growArray():StorageBuffer { for (let i=0;i<30;i++) buffers.push(first); return second; }
            buffers[0] = growArray();
            if (buffers[0] !== second || buffers.length !== 31) throw new Error("resized array handle slot");
        }
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(
        tools,
        "handle-slot-assignments",
        result.cpp +
            `
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
    `,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

test("stored engine fields assign through their owner wrapper", (t) => {
    const result = compileSource(`
        import {createEngine,type EngineContext} from "@babylonjs/lite";
        async function main() {
            const first = await createEngine({});
            const second = first;
            interface Store { engine:EngineContext; }
            const store:Store = {engine:first};
            store.engine = second;
            if (store.engine !== second) throw new Error("engine slot identity");
        }
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(
        tools,
        "engine-slot-assignments",
        result.cpp +
            `
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
    `,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});
