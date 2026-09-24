import assert from "node:assert/strict";
import {
    shaderMaterialPrograms,
    type ShaderMaterialProgramSource,
} from "../src/shader-material-programs.js";

/** The predeclared shader program `name`, refusing a name the table lacks. */
export function predeclaredProgram(name: string): ShaderMaterialProgramSource {
    const program = shaderMaterialPrograms.find(
        (candidate) => candidate.name === name,
    );
    assert.ok(program, `predeclared shader program '${name}'`);
    return program;
}
