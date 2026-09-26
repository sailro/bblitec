import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("dynamic fetch discovery excludes the substituted physics module loader", () => {
    const result = compileSource(
        `import HavokPhysics from "@babylonjs/havok";
        import {moduleAssetUrl} from "./fixtures/compiler-modules/asset-url-helper.js";
        const tone=moduleAssetUrl("./fixtures/compiler-modules/dynamic-audio/tone.wav",import.meta.url);
        async function load(url:string):Promise<ArrayBuffer>{const response=await fetch(url);return response.arrayBuffer();}
        async function main():Promise<void>{
            await HavokPhysics({locateFile:()=>moduleAssetUrl("./fixtures/compiler-modules/asset-url-helper.ts",import.meta.url)});
            const urls=new Set([tone]);for(const url of urls) await load(url);
        }void main();`,
        { fileName: "test/compiler-physics-module-assets-entry.ts" },
    );
    assert.deepEqual(
        result.manifest.assets.map(({ source }) => source),
        ["fixtures/compiler-modules/dynamic-audio/tone.wav"],
    );
});
