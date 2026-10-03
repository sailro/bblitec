import ts from "typescript";
import { declarationInDefaultLibrary, libraryGlobal } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

const writingLibraryCalls: ReadonlySet<string> = new Set([
    "Object.assign",
    "Object.defineProperty",
    "Object.defineProperties",
    "Object.setPrototypeOf",
    "Reflect.set",
    "Reflect.defineProperty",
    "Reflect.deleteProperty",
    "Reflect.setPrototypeOf",
]);

/** Default-library calls write only the first argument of these mutators. */
export function libraryArgumentIsReadOnly(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
): boolean {
    const called = checker.getResolvedSignature(call)?.declaration;
    if (!called || !declarationInDefaultLibrary(called)) return false;
    const callee = unwrapExpression(call.expression);
    const name = ts.isPropertyAccessExpression(callee)
        ? `${libraryGlobal(checker, callee.expression) ?? ""}.${callee.name.text}`
        : undefined;
    return index > 0 || name === undefined || !writingLibraryCalls.has(name);
}
