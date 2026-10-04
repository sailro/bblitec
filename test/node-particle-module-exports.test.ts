import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { compileSource } from "../src/compiler.js";
import { nodeParticleGraphExpression } from "../src/pinned-node-particle.js";

test("particle graph module documents retain export reads and authored factory calls", () => {
    const directory = resolve("artifacts/node-particle-module-exports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "graphs.ts"),
        `const name="document";
         export const graphDocument={name,blocks:[]};
         export function empty(){return {name:"empty",blocks:[]};}
         export function create(name:string){return {name,blocks:[]};}`,
    );
    const source = `
        import {createEngine,createSceneContext,parseNodeParticleSource,buildNodeParticleSet} from "@babylonjs/lite";
        import {graphDocument,empty,create} from "./graphs.js";
        async function main():Promise<void> {
            const engine=await createEngine({});
            const scene=createSceneContext(engine);
            await buildNodeParticleSet(engine,scene,parseNodeParticleSource(graphDocument));
            await buildNodeParticleSet(engine,scene,parseNodeParticleSource(empty()));
            await buildNodeParticleSet(engine,scene,parseNodeParticleSource(create("called")));
        }
        main();
    `;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    const graphs = result.nodeParticles?.sets.map((set) => set.graph);
    assert.ok(graphs);
    assert.equal(graphs.length, 3);
    let calls = 0;
    const document = { name: "document", blocks: [] };
    const values = {
        graphDocument: document,
        empty: () => {
            calls++;
            return { name: "empty", blocks: [] };
        },
        create: (name: string) => {
            calls++;
            return { name, blocks: [] };
        },
    };
    for (const graph of graphs) assert.equal(graph.kind, "module");
    assert.deepEqual(
        graphs.map((graph) => (graph.kind === "module" ? graph.args : null)),
        [undefined, [], ["called"]],
    );
    assert.equal(
        runInNewContext(nodeParticleGraphExpression(graphs[0]!, 0), values),
        document,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
        runInNewContext(nodeParticleGraphExpression(graphs[1]!, 1), values),
        { name: "empty", blocks: [] },
    );
    assert.deepEqual(
        runInNewContext(nodeParticleGraphExpression(graphs[2]!, 2), values),
        { name: "called", blocks: [] },
    );
    assert.equal(calls, 2);
});
