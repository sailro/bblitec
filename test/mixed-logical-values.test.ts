import test from "node:test";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a logical value whose operands differ in kind selects an operand, not a number", (t) => {
    // `name || index` yields the string when it is non-empty: a numeric
    // lowering turned "a" into NaN. The left runs once and the right only
    // where the left does not select itself.
    const source = `"use strict";
const parsed = JSON.parse('["a", ""]') as string[];
const typed: string[] = ["b", ""];
const labels: string[] = [];
let rights = 0;
function index(): number { rights++; return labels.length; }
for (const name of parsed) labels.push(\`p-\${name || index()}\`);
for (const name of typed) labels.push(\`t-\${name || index()}\`);
const optional: (string | undefined)[] = ["c", undefined];
for (const name of optional) labels.push(\`o-\${name || index()}\`);
for (const name of typed) labels.push(\`a-\${name && index()}\`);
const joined = labels.join(",");
if (joined !== "p-a,p-1,t-b,t-3,o-c,o-5,a-6,a-") throw new Error(joined);
if (rights !== 4) throw new Error("rights " + rights);
`;
    return runSelfCheckingProgram(t, "mixed-logical-values", source, {
        expectedOutput: "",
    });
});
