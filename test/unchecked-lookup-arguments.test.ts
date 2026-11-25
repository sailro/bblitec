/**
 * A dictionary read under a run-time key may miss whatever the checker says
 * of it (`Record<string, T>` reads `T`): passed to a parameter that admits
 * `undefined`, the miss arrives as `undefined`, as in JavaScript.
 */
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "a missed lookup passed to a parameter that admits undefined arrives undefined",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(
            `
            type Group = "red" | "blue";
            type Admission = (group: string) => boolean;
            const TABLE = Object.freeze({
                members: Object.freeze<Record<string, readonly Group[]>>({
                    alpha: ["red"],
                    beta: ["blue", "red"],
                }),
            });
            function excluded(groups: readonly Group[] | undefined, admits: Admission): boolean {
                return groups !== undefined && groups.length > 0 && groups.every((group) => !admits(group));
            }
            function optionalExcluded(admits: Admission, groups?: readonly Group[]): boolean {
                return groups === undefined ? false : groups.every((group) => !admits(group));
            }
            const scoped = (name: string, admits: Admission): boolean => excluded(TABLE.members[name], admits);
            const noRed: Admission = (group) => group !== "red";
            let count = 0;
            for (const name of ["gamma", "alpha", "beta", "delta"]) {
                if (scoped(name, noRed)) count++;
                if (optionalExcluded(noRed, TABLE.members[name])) count += 10;
            }
            if (count !== 11) throw new Error("excluded " + count);
            `,
            { fileName: "unchecked-lookup-arguments.ts" },
        );
        runGeneratedProgram(tools!, "unchecked-lookup-arguments", cpp, {
            expectedOutput: "",
        });
    },
);
