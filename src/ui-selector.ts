/** Compound selector chains admitted by the retained CSS projection. The same
 * parsed terms drive native matching, serialization and conservative proofs. */
export const UI_SELECTOR_TESTS = {
    tag: "Tag", id: "Id", class: "Class", attribute: "Attribute", equals: "Equals",
    hover: "Hover", active: "Active", focus: "Focus", "focus-visible": "FocusVisible",
    disabled: "Disabled", checked: "Checked",
} as const;
export type UiSelectorTestKind = keyof typeof UI_SELECTOR_TESTS;
export interface UiSelectorTest { kind: UiSelectorTestKind; name: string; value: string; }
export const UI_SELECTOR_RELATIONS = { self: "Self", descendant: "Descendant", child: "Child", next: "Next", following: "Following" } as const;
export interface UiSelectorStep { relation: keyof typeof UI_SELECTOR_RELATIONS; tests: UiSelectorTest[]; }

export function parseUiSelectorSequence(source: string): UiSelectorStep[] | undefined {
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
            const state = /^:(hover|active|focus-visible|focus|disabled|checked)(?![A-Za-z0-9_-])/.exec(rest);
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
                // Narrow the parser token through the shared descriptor table.
                if (!isUiSelectorState(name) || tests.some(test => test.kind === name)) return undefined;
                tests.push({kind:name, name:"", value:""});
                rest = rest.slice(state[0].length);
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

function isUiSelectorState(value: string): value is "hover" | "active" | "focus" | "focus-visible" | "disabled" | "checked" {
    return value === "hover" || value === "active" || value === "focus" || value === "focus-visible" || value === "disabled" || value === "checked";
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
                default: return `:${test.kind}`;
            }
        }).join("");
        return prefix + (compound || "*");
    }).join("");
}

export function uiSelectorSequenceSpecificity(steps: readonly UiSelectorStep[]): number {
    return steps.reduce((sum, step) => sum + step.tests.reduce((value, test) =>
        value + (test.kind === "id" ? 0x10000 : test.kind === "tag" ? 1 : 0x100), 0), 0);
}

/** Attribute/state conditions and relationships are not unconditional static facts. */
export function uiSelectorSequenceIsConditional(steps: readonly UiSelectorStep[]): boolean {
    return steps.length > 1 || steps.some(step => step.tests.some(test => !["tag", "id", "class"].includes(test.kind)));
}

export function uiSelectorSequenceCpp(steps: readonly UiSelectorStep[], quote: (value: string) => string): string {
    return `{${steps.map(step => `{bbl::UiSelectorRelation::${UI_SELECTOR_RELATIONS[step.relation]}, {${step.tests.map(test =>
        `{bbl::UiSelectorTestKind::${UI_SELECTOR_TESTS[test.kind]}, ${quote(test.name)}, ${quote(test.value)}}`).join(", ")}}}`).join(", ")}}`;
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
