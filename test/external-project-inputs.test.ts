import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { deploymentAssetSource, deploymentEnvironment, deploymentUrl } from "../src/compiler/deployment.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("module namespace records enumerate value exports and retain live bindings", t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native compiler required"); return; }
    const directory = mkdtempSync(join(tmpdir(), "bblitec-namespace-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "values.ts"), `
        export interface Hidden { value: number; }
        export const Z = 3;
        export const A = 1;
        export let counter = 0;
        export function bump(): void { counter++; }
    `);
    writeFileSync(join(directory, "exports.ts"), `export * from "./values"; export {A as alias} from "./values";`);
    writeFileSync(join(directory, "cache.ts"), `
        let cached: {value: number} | null = null;
        function retrieve(): {value: number} {
            if (!cached) cached = {value: 4};
            return cached;
        }
        function read(): number { return retrieve().value; }
        export function next(): number {
            const value = read();
            retrieve().value++;
            return value;
        }
    `);
    const result = compileSource(`import * as api from "./exports";
        import * as cache from "./cache";
        if (cache.next() !== 4 || cache.next() !== 5) throw new Error("private helper state");
        const namespace = api;
        const labels = Object.entries(namespace).filter(([, value]) => typeof value === "number")
            .map(([name, value]) => name + "=" + value).join(",");
        if (labels !== "A=1,Z=3,alias=1,counter=0") throw new Error("namespace exports");
        const snapshot = Object.entries(namespace);
        api.bump();
        if (namespace.counter !== 1) throw new Error("live namespace binding");
        const entry = snapshot.find(([name]) => name === "counter");
        if (!entry || entry[1] !== 0) throw new Error("entry snapshot");
    `, { fileName: join(directory, "entry.ts") });
    const output = resolve("artifacts/module-namespace");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});

test("external project modules and raw files remain generation inputs", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-inputs-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.ts");
    const helper = join(directory, "helper.ts");
    const raw = join(directory, "shader.wgsl");
    writeFileSync(helper, 'export const count = 2;');
    writeFileSync(raw, 'example shader text');
    const source = `import { count } from "./helper";
        import text from "./shader.wgsl?raw";
        if (count !== 2 || text.length !== 19) throw new Error("external source");`;
    writeFileSync(entry, source);
    const inputs = compileSource(source, { fileName: entry }).manifest.inputs.map(file => resolve(file));
    assert.deepEqual(inputs.sort(), [entry, helper, raw].sort());
});

test("local JavaScript modules supply executable definitions beside declarations", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-js-inputs-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const module = join(directory, "layout.mjs");
    writeFileSync(module, `export const layout = {width: 3, slots: [{x: 1}, {x: 2}]};
        /** @param {number} value */
        export function twice(value) { return value * 2; }`);
    writeFileSync(join(directory, "layout.d.mts"), `export declare const layout: {readonly width: number; readonly slots: readonly {x: number}[]};
        export declare function twice(value: number): number;`);
    const result = compileSource(`import {layout, twice} from "./layout.mjs";
        if (layout.width !== 3 || layout.slots.length !== 2 || twice(4) !== 8) throw new Error("JavaScript implementation");`,
        {fileName: join(directory, "entry.ts")});
    assert.ok(result.manifest.inputs.map(file => resolve(file)).includes(module));
    assert.match(result.cpp, /return \(v_\w+_value \* 2\.0\);/);
});

test("deployment URLs resolve external public assets and browser base values", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-public-"));
    t.after(() => rmSync(directory, {recursive:true, force:true}));
    const publicDir = join(directory, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "settings.json"), '{"count":3}');
    const options = {fileName:join(directory,"entry.ts"), publicDir, siteUrl:"https://example.invalid/project/", search:"mode=preview"};
    const result = compileSource(`
        const base = import.meta.env.BASE_URL;
        const root = location.origin + base;
        const response = await fetch(root + "settings.json");
        const settings = await response.json();
        if (settings.count !== 3) throw new Error("external asset bytes");
        if (base !== "/project/" || location.origin !== "https://example.invalid") throw new Error("deployment values");
        if (location.search !== "?mode=preview" || location.hostname !== "example.invalid" || location.protocol !== "https:") throw new Error("deployment location");
        if (import.meta.env.DEV || import.meta.env.SSR || !import.meta.env.PROD || import.meta.env.MODE !== "production") throw new Error("production environment");
    `, options);
    assert.doesNotMatch(result.cpp, /deployment values/);
    assert.doesNotMatch(result.cpp, /deployment location/);
    assert.doesNotMatch(result.cpp, /production environment/);
    for (const source of ["settings.json", "/project/settings.json", "https://example.invalid/project/settings.json?rev=2"]) {
        assert.equal(deploymentAssetSource(source, options), join(publicDir, "settings.json"));
    }
    assert.equal(deploymentAssetSource("https://elsewhere.invalid/settings.json", options), undefined);
    assert.throws(() => deploymentAssetSource("%2e%2e%2fsecret.txt", options), /escapes/);
    assert.equal(deploymentUrl({siteUrl:"https://example.invalid/project"}).pathname, "/project/");
    assert.throws(() => deploymentUrl({siteUrl:"https://example.invalid/?token=hidden"}), /base URL/);
});

test("explicit build environment preserves strings, empty values and missing defaults", () => {
    const result = compileSource(`
        function configured(value: string | undefined): string {
            return (value === undefined ? "fallback" : value).trim();
        }
        if (import.meta.env.VITE_LABEL !== "label=value" || import.meta.env.VITE_EMPTY !== "") eval("incorrect build strings");
        if (import.meta.env.VITE_MISSING !== undefined || typeof import.meta.env.VITE_MISSING !== "undefined") eval("incorrect missing input");
        localStorage.setItem("configured", configured(import.meta.env.VITE_LABEL));
        localStorage.setItem("missing", configured(import.meta.env.VITE_MISSING));
        localStorage.setItem("empty", configured(import.meta.env.VITE_EMPTY));
    `, {environment:{VITE_LABEL:"label=value", VITE_EMPTY:""}});
    assert.doesNotMatch(result.cpp, /incorrect build strings|incorrect missing input/);
    assert.match(result.cpp, /label=value/);
    assert.match(result.cpp, /fallback/);
    assert.throws(() => deploymentEnvironment({environment:{DEV:"true"}}), /built-in/);
    assert.throws(() => deploymentEnvironment({environment:{"invalid-name":"value"}}), /identifier/);
});

test("CLI build environment accepts repeated and empty values", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-environment-"));
    t.after(() => rmSync(directory, {recursive:true, force:true}));
    const entry = join(directory, "entry.ts"), output = join(directory, "output");
    writeFileSync(entry, `
        if (import.meta.env.VITE_LABEL !== "label=value" || import.meta.env.VITE_EMPTY !== "") eval("incorrect CLI inputs");
        localStorage.setItem("label", import.meta.env.VITE_LABEL);
    `);
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), entry, "--out", output,
        "--env", "VITE_LABEL=old", "--env", "VITE_LABEL=label=value", "--env", "VITE_EMPTY="], {stdio:"pipe"});
    const generated = readFileSync(join(output, "main.cpp"), "utf8");
    assert.match(generated, /label=value/);
    assert.doesNotMatch(generated, /incorrect CLI inputs/);
});

test("runtime initialization ignores type-only cycles and type-only side effects", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-modules-"));
    t.after(() => rmSync(directory, {recursive:true, force:true}));
    writeFileSync(join(directory, "state.ts"), `
        import type { Derived } from "./derived";
        export const values: number[] = [];
        values.push(4);
        export function snapshot(): number[] { return values; }
    `);
    writeFileSync(join(directory, "derived.ts"), `
        import { snapshot } from "./state";
        export interface Derived { value: number; }
        export const doubled: number[] = [];
        doubled.push(snapshot()[0]! * 2);
        export function result(): number { return doubled[0]!; }
    `);
    writeFileSync(join(directory, "types.ts"), `
        export interface Unused { tag: string; }
        throw new Error("type-only module executed");
    `);
    writeFileSync(join(directory, "bridge.ts"), `export {result} from "./derived"; export {type Unused} from "./types";`);
    const result = compileSource(`
        import {result, type Unused} from "./bridge";
        const answer = result();
        if (answer !== 8) throw new Error("module order");
    `, {fileName:join(directory,"entry.ts")});
    assert.doesNotMatch(result.cpp, /type-only module executed/);
    const state = result.cpp.indexOf("_values =");
    const derived = result.cpp.indexOf("_doubled =");
    assert.ok(state >= 0 && derived > state, "state storage precedes dependent initialization");
});

test("runtime asset names select files beneath the deployment base", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        async function load(ctx: BaseAudioContext, name: string) {
            const response = await fetch(location.origin + import.meta.env.BASE_URL + name);
            return ctx.decodeAudioData(await response.arrayBuffer());
        }
        const audio = await createAudioEngineAsync();
        const name = Math.random() < 0.5 ? "tone.wav" : "tone.wav";
        await load(audio.audioContext, name);
    `, {
        fileName: "test/deployment-audio-entry.ts",
        publicDir: resolve("test/fixtures/compiler-modules/dynamic-audio"),
        siteUrl: "https://example.invalid/assets/",
    });
    assert.equal(result.manifest.assets.length, 1);
    assert.match(result.cpp, /Unknown packaged asset/);
    assert.match(result.cpp, /audio_decode_buffer/);
});
