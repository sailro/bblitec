import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored callbacks and lexical tuple arrays retain values, identity and guards", (t) => {
    const result = compileSource(`
        interface View { x: number; }
        interface Reader { read: () => number; }
        interface Driver { update: () => void; }
        const view: View = {x: 0};
        const views: View[] = [view];
        const reader: Reader = {read: () => view.x};
        const driver: Driver = {update: () => { view.x += 4; }};
        const saved = reader.read;
        driver.update();
        if (reader.read !== saved || saved() !== 4 || views[0]!.x !== 4)
            throw new Error("stored callback live record and identity");

        const TILE = 70;
        function launch(): number {
            const shots: readonly [number, number][] = [
                [-TILE * 2, -TILE * 7.5], [TILE * 2, -TILE * 7.5],
            ];
            let total = 0;
            for (const [vx, vy] of shots) {
                total += vy;
                if (vx > 0) break;
            }
            return total;
        }
        if (launch() !== -1050 || launch() !== -1050)
            throw new Error("tuple loop break");
        const WEIGHTS: readonly (readonly [number, number])[] = [[1, 2], [3, 4], [5, 6]];
        const sameRows: readonly (readonly [number, number])[] = [[1, 2], [3, 4], [5, 6]];
        const first = WEIGHTS[0];
        function pick(index: number): number { return WEIGHTS[index]![1]; }
        function otherRow(index: number): readonly [number, number] { return sameRows[index]!; }
        let total = pick(2);
        for (const [left, right] of WEIGHTS) total += left + right;
        if (WEIGHTS[1][0] !== 3 || total !== 27 || first !== WEIGHTS[0] || first === otherRow(0))
            throw new Error("tuple values and declaration identity");

        let predicateCalls = 0;
        class Filter {
            predicate: ((value: number) => boolean) | null = null;
            accepts(value: number): boolean { return !this.predicate || this.predicate(value); }
        }
        const filter = new Filter();
        if (!filter.accepts(3) || predicateCalls !== 0) throw new Error("absent predicate");
        filter.predicate = value => { predicateCalls++; return value > 2; };
        if (!filter.accepts(3) || filter.accepts(1) || predicateCalls !== 2)
            throw new Error("present predicate");

        interface Hud { banner: (text: string | null, sub?: string) => void; }
        let shown = "";
        const hud: Hud = {banner(text: string | null, sub = "") {
            if (text !== null) shown = text + sub;
        }};
        hud.banner("READY");
        if (shown !== "READY") throw new Error("omitted optional argument");
        hud.banner("READY", "!");
        hud.banner(null);
        if (shown !== "READY!") throw new Error("present and null arguments");

        interface Options { restart(): void; }
        let restarts = 0;
        function invoke(options: Options): void {
            restarts++;
            if (restarts < 3) options.restart();
        }
        function makeRestart(): () => void {
            const start = (): void => { invoke({restart: start}); };
            return start;
        }
        const restart = makeRestart();
        restart();
        if (restarts !== 3) throw new Error("self-referential callback record");
        restart();
        if (restarts !== 4) throw new Error("retained callback owner");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "stored-callback-tuple-semantics", result.cpp);
});
