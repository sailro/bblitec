/** Compound selector chains admitted by the retained CSS projection. The same
 * parsed terms drive native matching, serialization and conservative proofs. */
export const UI_SELECTOR_STATES = {
    hover: "Hover", active: "Active", focus: "Focus", "focus-visible": "FocusVisible",
    "focus-within": "FocusWithin", disabled: "Disabled", checked: "Checked",
} as const;
export const UI_SELECTOR_TESTS = {
    tag: "Tag", id: "Id", class: "Class", attribute: "Attribute", equals: "Equals",
    ...UI_SELECTOR_STATES,
    "nth-child": "NthChild", "nth-last-child": "NthLastChild",
    "nth-of-type": "NthOfType", "nth-last-of-type": "NthLastOfType",
    "only-child": "OnlyChild", "only-of-type": "OnlyOfType", empty: "Empty", not: "Not",
} as const;
export type UiSelectorTestKind = keyof typeof UI_SELECTOR_TESTS;
export interface UiSelectorTest {
    kind: UiSelectorTestKind; name: string; value: string;
    alternatives?: UiSelectorStep[][];
    a?: number; b?: number;
}
export const UI_SELECTOR_RELATIONS = { self: "Self", descendant: "Descendant", child: "Child", next: "Next", following: "Following" } as const;
export interface UiSelectorStep { relation: keyof typeof UI_SELECTOR_RELATIONS; tests: UiSelectorTest[]; }

export function parseUiSelectorSequence(source: string, depth = 0): UiSelectorStep[] | undefined {
    if (depth > 64) return undefined;
    const steps: UiSelectorStep[] = [];
    let rest = source.trim();
    let relation: UiSelectorStep["relation"] = "self";
    while (rest) {
        const tests: UiSelectorTest[] = [];
        const tag = /^(\*|[A-Za-z][A-Za-z0-9-]*)/.exec(rest);
        if (tag) {
            if (tag[1]!.toLowerCase().startsWith("bbl-")) return undefined;
            if (tag[1] !== "*") tests.push({kind:"tag", name:tag[1]!.toLowerCase(), value:""});
            rest = rest.slice(tag[0].length);
        }
        while (rest && !/^[\s>+~]/.test(rest)) {
            const simple = /^([.#])([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
            const attribute = /^\[\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:=\s*(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z0-9_-]+))\s*)?\]/.exec(rest);
            const state = /^:([a-z][a-z-]*)/.exec(rest);
            if (simple) {
                if (simple[1] === "#" && tests.some(test => test.kind === "id")) return undefined;
                tests.push({kind:simple[1] === "." ? "class" : "id", name:simple[2]!, value:""});
                rest = rest.slice(simple[0].length);
            } else if (attribute) {
                const value = attribute[2] ?? attribute[3] ?? attribute[4];
                if (value !== undefined && /[\r\n\t\0]/.test(value)) return undefined;
                tests.push({kind:value === undefined ? "attribute" : "equals", name:attribute[1]!.toLowerCase(), value:value ?? ""});
                rest = rest.slice(attribute[0].length);
            } else if (state) {
                const name = state[1]!;
                rest = rest.slice(state[0].length);
                if (isUiSelectorState(name)) {
                    if (tests.some(test => test.kind === name)) return undefined;
                    tests.push({kind:name, name:"", value:""});
                } else if (name === "empty" || name === "only-child" || name === "only-of-type") {
                    tests.push({kind:name, name:"", value:""});
                } else if (name === "first-child" || name === "last-child" || name === "first-of-type" || name === "last-of-type") {
                    const kind = name === "first-child" ? "nth-child" : name === "last-child" ? "nth-last-child" :
                        name === "first-of-type" ? "nth-of-type" : "nth-last-of-type";
                    tests.push({kind, name:"", value:"", a:0, b:1});
                } else if (name === "not" || isUiNthSelector(name)) {
                    const parameter = uiSelectorFunction(rest);
                    if (!parameter) return undefined;
                    rest = parameter.rest;
                    if (name === "not") {
                        const alternatives: UiSelectorStep[][] = [];
                        for (const part of splitUiSelectorList(parameter.body)) {
                            const sequence = parseUiSelectorSequence(part, depth + 1);
                            if (!sequence) return undefined;
                            alternatives.push(sequence);
                        }
                        tests.push({kind:"not", name:"", value:"", alternatives});
                    } else {
                        const formula = uiNthFormula(parameter.body);
                        if (!formula) return undefined;
                        tests.push({kind:name, name:"", value:"", ...formula});
                    }
                } else return undefined;
            } else return undefined;
        }
        if (!tag && !tests.length) return undefined;
        steps.push({relation, tests});
        const whitespace = /^\s+/.exec(rest);
        if (whitespace) rest = rest.slice(whitespace[0].length);
        if (!rest) break;
        const combinator = rest[0];
        if (combinator === ">" || combinator === "+" || combinator === "~") {
            relation = combinator === ">" ? "child" : combinator === "+" ? "next" : "following";
            rest = rest.slice(1).trimStart();
            if (!rest) return undefined;
        } else if (whitespace) relation = "descendant";
        else return undefined;
    }
    return steps.length ? steps : undefined;
}

export function isUiSelectorState(value: string): value is keyof typeof UI_SELECTOR_STATES {
    return Object.hasOwn(UI_SELECTOR_STATES, value);
}

function isUiNthSelector(value: string): value is "nth-child" | "nth-last-child" | "nth-of-type" | "nth-last-of-type" {
    return value === "nth-child" || value === "nth-last-child" || value === "nth-of-type" || value === "nth-last-of-type";
}

function uiSelectorFunction(source: string): {body:string; rest:string} | undefined {
    if (!source.startsWith("(")) return undefined;
    let depth = 0, quote = "";
    for (let index = 0; index < source.length; index++) {
        const token = source[index]!;
        if (token === "\\") { index++; continue; }
        if (quote) { if (token === quote) quote = ""; }
        else if (token === '"' || token === "'") quote = token;
        else if (token === "(") depth++;
        else if (token === ")" && --depth === 0) return {body:source.slice(1,index), rest:source.slice(index+1)};
    }
    return undefined;
}

function uiNthFormula(source: string): {a:number; b:number} | undefined {
    const value = source.trim().toLowerCase();
    if (value === "even" || value === "odd") return {a:2,b:Number(value === "odd")};
    const match = /^([+-]?(?:\d+)?)n(?:\s*([+-])\s*(\d+))?$/.exec(value);
    const a = match ? match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]) : 0;
    const b = match ? Number(match[3] ?? 0) * (match[2] === "-" ? -1 : 1) : /^[+-]?\d+$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(a) && Number.isInteger(b) && Math.abs(a) <= 0x7fffffff && Math.abs(b) <= 0x7fffffff ? {a,b} : undefined;
}

export function uiSelectorSequenceCss(steps: readonly UiSelectorStep[]): string {
    return steps.map(step => {
        const prefix = {self:"", descendant:" ", child:" > ", next:" + ", following:" ~ "}[step.relation];
        const compound = step.tests.map(test => {
            switch (test.kind) {
                case "tag": return test.name;
                case "id": return `#${test.name}`;
                case "class": return `.${test.name}`;
                case "attribute": return `[${test.name}]`;
                case "equals": return `[${test.name}=${test.value.includes('"') ? `'${test.value}'` : `"${test.value}"`}]`;
                case "not": return `:not(${test.alternatives!.map(uiSelectorSequenceCss).join(", ")})`;
                case "nth-child": case "nth-last-child": case "nth-of-type": case "nth-last-of-type":
                    return `:${test.kind}(${test.a === 0 ? test.b : `${test.a}n${test.b! < 0 ? test.b : `+${test.b}`}`})`;
                default: return `:${test.kind}`;
            }
        }).join("");
        return prefix + (compound || "*");
    }).join("");
}

export function uiSelectorSequenceSpecificity(steps: readonly UiSelectorStep[]): number {
    return steps.reduce((sum, step) => sum + step.tests.reduce((value, test) =>
        value + (test.kind === "id" ? 0x10000 : test.kind === "tag" ? 1 : test.kind === "not" ?
            Math.max(...test.alternatives!.map(uiSelectorSequenceSpecificity)) : 0x100), 0), 0);
}

export function* uiSelectorSequenceTests(steps: readonly UiSelectorStep[]): Generator<UiSelectorTest> {
    for (const step of steps) for (const test of step.tests) {
        yield test;
        for (const alternative of test.alternatives ?? []) yield* uiSelectorSequenceTests(alternative);
    }
}

export function uiSelectorSequenceNeedsAuthoredTree(steps: readonly UiSelectorStep[]): boolean {
    return steps.some(step => step.relation === "child" || step.relation === "next" || step.relation === "following" || step.tests.length === 0 ||
        step.tests.some(test => isUiNthSelector(test.kind) || test.kind === "only-child" || test.kind === "only-of-type" || test.kind === "empty" ||
            test.alternatives?.some(uiSelectorSequenceNeedsAuthoredTree)));
}

/** Attribute/state conditions and relationships are not unconditional static facts. */
export function uiSelectorSequenceIsConditional(steps: readonly UiSelectorStep[]): boolean {
    return steps.length > 1 || steps.some(step => step.tests.some(test => !["tag", "id", "class"].includes(test.kind)));
}

export function uiSelectorSequenceCpp(steps: readonly UiSelectorStep[], quote: (value: string) => string): string {
    return `{${steps.map(step => `{bbl::UiSelectorRelation::${UI_SELECTOR_RELATIONS[step.relation]}, {${step.tests.map(test =>
        `{bbl::UiSelectorTestKind::${UI_SELECTOR_TESTS[test.kind]}, ${quote(test.name)}, ${quote(test.value)}` +
        `${test.alternatives || test.a !== undefined ? `, {${test.alternatives?.map(alternative => uiSelectorSequenceCpp(alternative,quote)).join(", ") ?? ""}}, ${test.a ?? 0}, ${test.b ?? 0}` : ""}}`).join(", ")}}}`).join(", ")}}`;
}

/** Commas inside quoted attributes or functional selectors do not split a list. */
export function splitUiSelectorList(source: string): string[] {
    const result: string[] = [];
    let start = 0, depth = 0, quote = "";
    for (let index = 0; index < source.length; index++) {
        const token = source[index]!;
        if (token === "\\") { index++; continue; }
        if (quote) { if (token === quote) quote = ""; }
        else if (token === '"' || token === "'") quote = token;
        else if (token === "[" || token === "(") depth++;
        else if (token === "]" || token === ")") depth--;
        else if (token === "," && depth === 0) { result.push(source.slice(start,index).trim()); start = index + 1; }
    }
    result.push(source.slice(start).trim());
    return result;
}
