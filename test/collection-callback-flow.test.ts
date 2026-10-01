import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("catalogue selections route parsed records through queued callbacks", (t) => {
    const result = compileSource(`
        const catalogue = [
            {id: "later", rank: 2},
            {id: "first", rank: 1, quiet: true},
        ] as const satisfies readonly {id: string; rank: number; quiet?: true}[];
        type Id = (typeof catalogue)[number]["id"];
        interface Row { count: number; }
        function read(text: string): Record<string, Row> {
            const document = JSON.parse(text) as Record<string, Row>;
            if (!document.first) throw new Error("missing first record");
            return document;
        }
        class Queue<T> {
            private active: T | null = null;
            private pending: T[] = [];
            push(value: T): T | null {
                if (this.active !== null) {
                    this.pending.push(value);
                    return null;
                }
                this.active = value;
                return value;
            }
            finish(): T | null {
                const value = this.active;
                this.active = this.pending.shift() ?? null;
                return value;
            }
        }
        function route(id: Id): (typeof catalogue)[number] & {quiet?: true} {
            return catalogue.find(item => item.id === id)!;
        }
        const source = read('{"first":{"count":3},"later":{"count":7}}');
        const queue = new Queue<Id>();
        const ordered = [...catalogue].sort((a, b) => a.rank - b.rank);
        for (const item of ordered) {
            const selected = route(item.id);
            const started = queue.push(selected.id);
            if (selected.quiet && started !== "first")
                throw new Error("selected queue entry");
        }
        let effects = "";
        const update = (id: Id): void => { effects += "U"; source[id].count++; };
        const callbacks: {update: (id: Id) => void} = {update};
        if (callbacks.update !== update) throw new Error("stored callback identity");
        function receiver(): number {
            effects += "R";
            callbacks.update = () => { throw new Error("rebound callback selected"); };
            return 0;
        }
        const first = queue.finish();
        if (first !== "first") throw new Error("queue return value");
        callbacks.update.call(receiver(), first!);
        update(queue.finish()!);
        if (effects !== "RUU" || source.first.count !== 4 || source.later.count !== 8 || queue.finish() !== null)
            throw new Error("combined data and callback flow");
    `);
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "collection-callback-flow", result.cpp);
});
