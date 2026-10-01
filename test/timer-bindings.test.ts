import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("callbacks observe completed lexical initializers and preserve failed initialization", (t) => {
    const directory = resolve("artifacts/timer-bindings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        let early=0,failed=0,count=0,nested=0,repeated=0,named=0;
        try{const value:number=(()=>value)();throw new Error("early read accepted");}
        catch(error){if(!error.message.includes("before initialization"))throw error;early++;}
        let escaped:()=>number=()=>0;
        try{
            const value:number=((read:()=>number):number=>{escaped=read;throw new Error("initializer failed");})(()=>value);
        }catch(error){if(error.message!=="initializer failed")throw error;}
        try{escaped();throw new Error("failed binding initialized");}
        catch(error){if(!error.message.includes("before initialization"))throw error;failed++;}
        const absent:number|null=(()=>{queueMicrotask(()=>{if(absent!==null)throw new Error("initialized absence");});return null;})();
        const timers=new Set<number>();
        function schedule(action:()=>void){
            const ticket=setTimeout(()=>{timers.delete(ticket);action();clearTimeout(ticket);},0);
            timers.add(ticket);
        }
        for(const value of [1,2,3])schedule(()=>{count+=value;});
        const interval=setInterval(()=>{repeated++;if(repeated===2)clearInterval(interval);},1);
        const namedCallback=()=>{named++;clearTimeout(namedTicket);};
        const namedTicket=setTimeout(namedCallback,0);
        function namedLocal(){
            const callback=()=>{named++;clearTimeout(ticket);};
            const ticket=setTimeout(callback,0);
        }
        namedLocal();
        const outer=setTimeout(()=>{
            clearTimeout(outer);
            const inner=setTimeout(()=>{nested++;clearTimeout(inner);},0);
        },0);
        let mutable=setTimeout(()=>{if(mutable!==23)throw new Error("mutable binding capture");},0);mutable=23;
        let earlyFunctionReads = 0;
        function forwardFunction(seed: number): number {
            let calls = 0;
            const inspect = (): void => {
                const alias = action;
                if (alias !== action) throw new Error("forward function identity");
                alias();
            };
            const run = (remaining: number): void => {
                if (remaining > 0) { run(remaining - 1); return; }
                inspect();
            };
            try { run(1); throw new Error("early function read accepted"); }
            catch (error) {
                if (!error.message.includes("before initialization")) throw error;
                earlyFunctionReads++;
            }
            const action = (): void => { calls += seed; };
            run(1);
            return calls;
        }
        if (forwardFunction(2) !== 2 || forwardFunction(5) !== 5 || earlyFunctionReads !== 2)
            throw new Error("forward function declaration initialization");
        let cycleCalls = 0, completedCycles = 0, completedLabels = 0;
        const cycleListeners: Array<() => void> = [];
        interface Scheduler {
            setTimer(callback: () => void, delay: number): number;
            clearTimer(id: number): void;
            on(callback: () => void): void;
            off(callback: () => void): void;
        }
        function cycleScheduler(): Scheduler {
            return {
                setTimer: (callback, delay) => setTimeout(callback, delay),
                clearTimer: id => clearTimeout(id),
                on: callback => { cycleListeners.push(callback); },
                off: callback => {
                    const index = cycleListeners.indexOf(callback);
                    if (index >= 0) cycleListeners.splice(index, 1);
                },
            };
        }
        function startCycle(label: number, limit: number, scheduler: Scheduler = cycleScheduler()): () => void {
            let ticket: number | null = null;
            let turns = 0;
            const cancel = (): void => {
                if (ticket !== null) { scheduler.clearTimer(ticket); ticket = null; }
            };
            const finish = (): void => {
                cancel();
                scheduler.off(change);
                completedCycles++;
                completedLabels += label;
            };
            const arm = (): void => {
                cancel();
                if (turns >= limit) { finish(); return; }
                ticket = scheduler.setTimer(() => {
                    ticket = null;
                    cycleCalls += label;
                    if (++turns >= limit) finish();
                    else arm();
                }, 0);
            };
            const change = (): void => { arm(); };
            scheduler.on(change);
            arm();
            return () => { cancel(); scheduler.off(change); };
        }
        startCycle(1, 2);
        startCycle(10, 3);
        const cancelledCycle = startCycle(100, 1);
        cancelledCycle();
        if (cycleCalls !== 0 || cycleListeners.length !== 2)
            throw new Error("deferred cycles and cancellation");
        for (const listener of [...cycleListeners]) listener();
        function complete(): void {
            if(count<6||nested<1||repeated<2||named<2||timers.size!==0||completedCycles<2) {
                setTimeout(complete, 1);
                return;
            }
            if(early!==1||failed!==1||count!==6||nested!==1||repeated!==2||named!==2||timers.size!==0)throw new Error("timer results");
            if (cycleCalls !== 32 || completedCycles !== 2 || completedLabels !== 11 || cycleListeners.length !== 0)
                throw new Error("deferred cycle results: " + cycleCalls + "," + completedCycles + "," + completedLabels + "," + cycleListeners.length);
            globalThis.close();
        }
        setTimeout(complete, 0);
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    const execution = spawnSync(exe, { encoding: "utf8", timeout: 10000 });
    assert.equal(execution.error, undefined, execution.stderr);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
});
