export interface CppModule {
    header: string;
    definitions: string;
}

/** Separates scene data from the declarations consumed by native backends. */
export class CppDefinitions {
    private readonly definitions: string[] = [];

    table(type: string, name: string, count: number, rows: string): string {
        this.definitions.push(
            `namespace {\nconstexpr std::array<${type}, ${count}> ${name}_data{{\n${rows}\n}};\n}\n` +
            `const TableView<${type}> ${name}{${name}_data};`,
        );
        return `extern const TableView<${type}> ${name};`;
    }

    constant(type: string, name: string, value: string | number): string {
        this.definitions.push(`const ${type} ${name} = ${value};`);
        return `extern const ${type} ${name};`;
    }

    privateCode(code: string): string {
        this.definitions.push(code);
        return "";
    }

    function(signature: string, body: string, declaration = signature): string {
        this.definitions.push(`${signature} {\n${body}\n}`);
        return `${declaration};`;
    }

    finish(header: string): CppModule {
        return {
            header: `#include <bblite/table_view.hpp>\n${header}`,
            definitions: `#include <array>\nnamespace bbl::upstream {\n${this.definitions.join("\n\n")}\n}\n`,
        };
    }
}
