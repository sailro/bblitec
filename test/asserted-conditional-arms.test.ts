/**
 * A conditional's arm the program asserts present (`cell!`) reads its
 * optional storage as present, as the same read outside a selection does.
 */
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "an asserted conditional arm selects the present object",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(
            `
            function make(capacity: number) {
                let fallback: Float32Array | null = null;
                let header: Int32Array | null = null;
                let pages: Float32Array[] | null = null;
                return {
                    start(paged: boolean): void {
                        fallback = new Float32Array(capacity);
                        fallback[0] = 3;
                        if (paged) {
                            header = new Int32Array(1);
                            pages = [new Float32Array(capacity), new Float32Array(capacity)];
                            pages[1]![0] = 5;
                            header[0] = 1;
                        }
                    },
                    read(): number {
                        const source = header && pages ? pages[Atomics.load(header, 0)]! : fallback!;
                        return source[0]!;
                    },
                };
            }
            const plain = make(4);
            plain.start(false);
            if (plain.read() !== 3) throw new Error("fallback arm");
            const paged = make(4);
            paged.start(true);
            if (paged.read() !== 5) throw new Error("paged arm");
            `,
            { fileName: "asserted-arms.ts" },
        );
        runGeneratedProgram(tools!, "asserted-conditional-arms", cpp);
    },
);
