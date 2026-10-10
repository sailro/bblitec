import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test(
    "mapped class method views retain their receivers and observe later mutations",
    { skip: !nativeTools },
    () => {
        const result = compileSource(`
        class Service {
            constructor(private active: boolean) {}
            isReady(code: number): boolean { return this.active && code === 3; }
            createReader(): () => boolean { return () => this.active; }
            stop(): void { this.active = false; }
            start(): void { this.active = true; }
        }
        type Query = Pick<Service, "isReady" | "createReader">;
        interface Client {
            test(query: Query): boolean;
            same(left: Query, right: Query): boolean;
            create(query: Query): () => boolean;
            sameReader(left: () => boolean, right: () => boolean): boolean;
        }
        const clients: Client[] = [{
            test(query) { return query.isReady(3); },
            same(left, right) { return left.isReady === right.isReady; },
            create(query) { return query.createReader(); },
            sameReader(left, right) { return left === right; },
        }];
        const services: Service[] = [new Service(true), new Service(false)];
        const queries: Query[] = [services[0]!, services[1]!, services[0]!];
        if (!clients[0]!.same(queries[0]!, queries[1]!) || !clients[0]!.same(queries[0]!, queries[2]!))
            throw new Error("prototype callback identity");
        if (!clients[0]!.test(queries[0]!) || clients[0]!.test(queries[1]!))
            throw new Error("distinct method receivers");
        const readers: (() => boolean)[] = [
            clients[0]!.create(queries[0]!),
            clients[0]!.create(queries[0]!),
            clients[0]!.create(queries[1]!),
        ];
        if (clients[0]!.sameReader(readers[0]!, readers[1]!) || clients[0]!.sameReader(readers[0]!, readers[2]!))
            throw new Error("fresh nested callback identity");
        if (!readers[0]!() || !readers[1]!() || readers[2]!())
            throw new Error("nested callback receivers");
        const retained = services[0]!;
        services[0]!.stop();
        services.splice(0);
        if (clients[0]!.test(queries[0]!)) throw new Error("retained receiver state");
        if (readers[0]!() || readers[1]!() || readers[2]!())
            throw new Error("nested callback observes receiver mutation");
        retained.start();
        if (!clients[0]!.test(queries[0]!) || !clients[0]!.test(queries[2]!) || clients[0]!.test(queries[1]!))
            throw new Error("live receiver after collection removal");
    `);
        runGeneratedProgram(
            nativeTools!,
            "structural-class-methods",
            result.cpp,
        );
    },
);

test("structural method views refuse unrepresented prototype evaluation identity", () => {
    assert.throws(
        () =>
            compileSource(`
            function createView(): {read(): number} {
                class Local { read(): number { return 1; } }
                const instances: Local[] = [new Local()];
                const views: {read(): number}[] = [instances[0]!];
                return views[0]!;
            }
            const view = createView();
            view.read();
        `),
        /structural method view requires a module-level class prototype identity/,
    );
});
