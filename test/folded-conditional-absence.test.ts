/**
 * A conditional whose test generation settles selects one arm; when that arm
 * is itself absent (an omitted argument), the selection stays absent.
 */
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "a settled selection of an omitted argument stays absent",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(
            `
            interface Snapshot {
                readonly scale: number;
            }
            interface Origin {
                readonly parent: number;
            }
            interface Seed {
                snapshot?: Snapshot;
            }
            function seed(out: Float32Array, restored: Seed = {}): void {
                out[0] = 1;
                const snapshot = restored.snapshot;
                if (snapshot) out[1] = snapshot.scale;
            }
            function spawn(out: Float32Array, origin?: Origin, restore?: Snapshot): void {
                if (origin ? undefined : restore) out[2] = 1;
                seed(out, { snapshot: origin ? undefined : restore });
            }
            const out = new Float32Array(3);
            spawn(out);
            if (out[0] !== 1 || out[1] !== 0 || out[2] !== 0) throw new Error("absent selection " + out.join(","));
            `,
            { fileName: "folded-conditional-absence.ts" },
        );
        runGeneratedProgram(tools!, "folded-conditional-absence", cpp, {
            expectedOutput: "",
        });
    },
);
