import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("CustomEvent dispatch shares detail identity through Event helpers and honors listener lifetime", (t) => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const point = {x: 1, y: 2, z: 3};
            const detail = {point, score: 4};
            const event = new CustomEvent("score", {detail, bubbles: true, cancelable: true});
            const retained: CustomEvent[] = [event];
            if (retained[0] !== event) throw new Error("owned event identity");
            if (event.target !== null || event.currentTarget !== null || event.isTrusted)
                throw new Error("fresh event state");
            point.x = 7;
            let order = "";
            function receive(event: Event): void {
                const received = (event as CustomEvent<{point:{x:number,y:number,z:number},score:number}>).detail;
                if (received.point.x !== 7 || received.score !== 4 || received.point !== point)
                    throw new Error("live detail identity");
                if (event.target === null || event.currentTarget === null || event.eventPhase !== 2)
                    throw new Error("dispatch targets");
                order += "D";
                event.preventDefault();
                if (!event.defaultPrevented) throw new Error("base cancellation");
            }
            const removed = () => { throw new Error("removed listener"); };
            document.addEventListener("score", removed);
            document.removeEventListener("score", removed);
            window.addEventListener("score", () => {order += "C";}, true);
            const listeners: Array<(event:Event)=>void> = [receive];
            document.addEventListener("score", listeners[0]!, {once:true});
            window.addEventListener("score", () => {order += "B";});
            if (document.dispatchEvent(event) || order !== "CDB" || !event.defaultPrevented)
                throw new Error("synchronous canceled dispatch");
            if (event.target === null || event.currentTarget !== null || event.eventPhase !== 0)
                throw new Error("post dispatch state");
            order = "";
            if (document.dispatchEvent(event) || order !== "CB") throw new Error("once and redispatch");
            const passive = new CustomEvent("passive", {cancelable:true});
            document.addEventListener("passive", event => event.preventDefault(), {passive:true});
            if (!document.dispatchEvent(passive) || passive.defaultPrevented) throw new Error("passive cancellation");
            const defaultEvent = new CustomEvent("defaults");
            if (defaultEvent.detail !== null || defaultEvent.detail === undefined || defaultEvent.bubbles || defaultEvent.cancelable || defaultEvent.composed)
                throw new Error("default options");
        }
        main();
    `);
    assert(result.manifest.features.includes("input:dom"));
    assert(result.manifest.features.includes("data:json"));
    assert.match(result.cpp, /as<bbl::PlatformCustomEvent>/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/custom-events-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        directory,
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/custom-events-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

test("custom dispatch reports listener errors without interleaving microtasks and retains mutation semantics", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/custom-event-loop-check");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/custom-event-loop-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
