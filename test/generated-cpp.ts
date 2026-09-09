import type { CppModule } from "../src/cpp-definitions.js";

/** Native fixtures compile one translation unit containing both module parts. */
export function inlineCpp(module: CppModule): string {
    return module.header + module.definitions;
}
