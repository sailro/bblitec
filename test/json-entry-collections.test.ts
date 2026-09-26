import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("mapped JSON entries preserve pair types and nested object identity", (t) => {
    const result = compileSource(`
        interface Joint { name: string; point: [number, number, number]; }
        const rig = JSON.parse('{"joints":[{"name":"root","point":[1,2,3]},{"name":"child","point":[4,5,6]}]}') as {joints: Joint[]};
        const indices = new Map(rig.joints.map((joint, index) => [joint.name, index]));
        const records = rig.joints.map((joint, index) => ({value: index + 1}));
        const byName = new Map(rig.joints.map((joint, index) => [joint.name, {joint, record: records[index]!}]));
        const names = Object.fromEntries(rig.joints.map((joint, index) => [joint.name, index + 4]));
        if (indices.get("child") !== 1 || names["root"] !== 4) throw new Error("entry context");
        const root = byName.get("root")!;
        if (root.joint !== rig.joints[0] || root.record !== records[0]) throw new Error("nested identity");
        root.joint.name = "changed";
        root.record.value = 9;
        if (rig.joints[0]!.name !== "changed" || records[0]!.value !== 9) throw new Error("shared mutation");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "json-entry-collections", result.cpp);
});
