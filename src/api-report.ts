import { type ApiSnapshot } from "./api-surface.js";
import { type ApiUsage } from "./api-usage.js";
import { assessApiCases } from "./api-evidence.js";
import { type ApiBaseline } from "./api-baseline.js";
import { type ApiBinding } from "./api-bindings.js";

export function apiCoverageReport(snapshot: ApiSnapshot, usage: ApiUsage,
    cases: ReturnType<typeof assessApiCases>, filter = "", baseline?: ApiBaseline, bindings: readonly ApiBinding[] = []) {
    const uses = new Map<string, ApiUsage["uses"]>();
    for (const use of usage.uses) {
        const sites = uses.get(use.id) ?? [];
        sites.push(use);
        uses.set(use.id, sites);
    }
    const byTarget = new Map<string, typeof cases>();
    const generated = new Map<string, ApiBaseline["uses"]>();
    const byOwner = new Map<string, ApiBinding[]>();
    for (const binding of bindings) byOwner.set(binding.owner, [...(byOwner.get(binding.owner) ?? []), binding]);
    const bodies = new Map<string, ApiBaseline["translations"]>();
    for (const translation of baseline?.translations ?? []) for (const owner of translation.owners) {
        bodies.set(owner, [...(bodies.get(owner) ?? []), translation]);
    }
    for (const use of baseline?.uses ?? []) {
        if (use.operation === "reference") continue;
        const sites = generated.get(use.id) ?? [];
        sites.push(use);
        generated.set(use.id, sites);
    }
    for (const entry of cases) for (const target of entry.targets) {
        const entries = byTarget.get(target.id) ?? [];
        entries.push(entry);
        byTarget.set(target.id, entries);
    }
    const rows = snapshot.items.filter(item => !filter || item.id.toLowerCase().includes(filter.toLowerCase())).map(item => {
        const evidence = byTarget.get(item.id) ?? [];
        const sites = uses.get(item.id) ?? [];
        const generation = generated.get(item.id) ?? [];
        const passing = evidence.filter(entry => entry.status === "passed");
        const refusal = passing.some(entry => entry.level === "refusal");
        const supported = generation.length > 0 || passing.some(entry => entry.level !== "refusal");
        const status = refusal && supported ? "partial" : passing.some(entry => entry.level === "parity") ? "parity-tested" :
            passing.some(entry => entry.level === "native") ? "native-tested" :
            generation.length || passing.some(entry => entry.level === "generation") ? "generation-tested" :
            refusal ? "known-refusal" : sites.length ? "observed" : "unassessed";
        return { ...item, status, supported, sites, generation, bindings: item.kind === "function" ? byOwner.get(item.owner) ?? [] : [],
            translations: item.kind === "function" ? bodies.get(item.owner) ?? [] : [], cases: evidence.map(entry => entry.id) };
    });
    const counts = Object.fromEntries(["parity-tested", "native-tested", "generation-tested", "partial", "known-refusal", "observed", "unassessed"]
        .map(status => [status, rows.filter(row => row.status === status).length]));
    const groups = { callables: ["function", "method", "constructor", "construct"],
        fields: ["property", "get", "set", "index"], constants: ["variable", "enum-member"], callbacks: ["call"] };
    const metric = (kinds: readonly string[]) => {
        const entries = rows.filter(row => kinds.includes(row.kind));
        const covered = entries.filter(row => row.supported).length;
        return { covered, total: entries.length, percent: entries.length ? 100 * covered / entries.length : 0 };
    };
    const metrics = { surface: metric(Object.values(groups).flat()),
        ...Object.fromEntries(Object.entries(groups).map(([name, kinds]) => [name, metric(kinds)])) };
    const exercisedOwners = new Set(rows.filter(row => row.kind === "function" && row.supported).map(row => row.owner));
    const selectedBindings = bindings.filter(binding => !filter || rows.some(row => row.owner === binding.owner));
    const present = selectedBindings.filter(binding => binding.status === "route-found" || exercisedOwners.has(binding.owner)).length;
    const exercised = selectedBindings.filter(binding => exercisedOwners.has(binding.owner)).length;
    const adapters = { scope: "Exported function entry adapters identified by live dispatch probes or passing source forms. A hook can refuse overloads. Probe fallthrough is unclassified because routing can depend on argument types.",
        total: selectedBindings.length, routed: present, exercised,
        unclassified: selectedBindings.filter(binding => binding.status === "no-route-observed" && !exercisedOwners.has(binding.owner)).length,
        unresolved: selectedBindings.filter(binding => binding.status === "probe-error").length,
        routedPercent: selectedBindings.length ? 100 * present / selectedBindings.length : 0,
        exercisedPercent: selectedBindings.length ? 100 * exercised / selectedBindings.length : 0 };
    const automatic = { scope: "Successful pinned AST translation. Includes internal helpers, configured adapter bindings and specializations. Requests identify call, method, expression and statement adapters actually dispatched by the numeric translator. Other translation paths remain unclassified.",
        bodies: new Set((baseline?.translations ?? []).map(body => `${body.modulePath}#${body.symbolName}`)).size,
        publicFunctions: bodies.size,
        completeFunctionTranslations: [...bodies.values()].filter(entries => entries.some(entry => entry.extent === "function")).length };
    return { schemaVersion: 2, pin: snapshot.pin,
        scope: "Implementation and validation are separate. Pinned source translation supplies Babylon behavior; entry and member adapters connect supported forms to native/PAL storage and services. Exercise percentages are validation coverage, not the amount of PAL implementation completed.",
        adapters, automatic, metrics, baseline: baseline ? { compilations: baseline.compilations, testsPassed: baseline.testsPassed, suites: baseline.suites } : undefined,
        counts, total: rows.length, exports: snapshot.exports, cases, usage: { ...usage, uses: undefined }, rows };
}

export function apiReportHtml(report: ReturnType<typeof apiCoverageReport>): string {
    const data = JSON.stringify(report).replaceAll("<", "\\u003c");
    return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Babylon Lite API coverage</title>
<style>
body{font:15px system-ui;margin:40px auto;max-width:1450px;padding:0 24px;color:#182a32;background:#f6f8f9}
h1{letter-spacing:-1px}p{max-width:1000px;line-height:1.6}.counts{display:flex;gap:12px;flex-wrap:wrap}
.counts span{background:white;padding:12px 18px;border:1px solid #d3dde2;border-radius:6px}
input,select,button{font:inherit;padding:10px;border:1px solid #aabcc5;border-radius:4px;background:white}
input{min-width:350px}nav{display:flex;gap:12px;margin:24px 0;flex-wrap:wrap}
table{border-collapse:collapse;width:100%;background:white;table-layout:fixed}td,th{padding:12px;border-bottom:1px solid #dce3e7;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#e7eef1}code,pre{font:12px ui-monospace,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
summary{cursor:pointer}small{color:#476170}details p{margin:8px 0}.tag{white-space:nowrap}button{cursor:pointer}
</style>
<h1>Babylon Lite API integration</h1><p id="pin"></p>
<p>Pinned source translation supplies Babylon behavior. Adapters connect public calls and fields to native
storage and PAL services. The report tracks implementation routes separately from validation coverage.
An existing routing hook can still refuse overloads; source translation can still require adapter bindings.</p>
<h2>Entry adapters and source translation</h2><p id="implementation"></p>
<h2>Declarations exercised by tests and scenes</h2>
<p>These percentages measure exercised forms. They do not measure completed PAL work. Type containers are excluded.</p>
<div class="counts" id="metrics"></div>
<div class="counts" id="counts"></div>
<nav><input id="query" type="search" placeholder="Search API, type, declaration, or source file" aria-label="Search API">
<select id="status" aria-label="Coverage status"><option value="">All statuses</option></select>
<button id="previous">Previous</button><button id="next">Next</button><span id="page"></span></nav>
<p id="evidence"></p><table><thead><tr><th>API / declaration</th><th>Implementation and evidence</th><th>Source references</th></tr></thead><tbody id="rows"></tbody></table>
<script type="application/json" id="data">${data}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent);
const search=data.rows.map(row=>({row,text:(row.id+' '+row.declaration+' '+row.bindings.map(b=>b.status+' '+b.lowerer).join(' ')+' '+row.generation.map(g=>g.suite).join(' ')+' '+row.sites.map(s=>s.file).join(' ')).toLowerCase()}));
const cases=new Map(data.cases.map(c=>[c.id,c]));
const el=id=>document.getElementById(id), make=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n};
el('pin').textContent=data.pin.package+' '+data.pin.version+' · '+data.pin.sourceVersion;
el('implementation').textContent=data.adapters.routed+'/'+data.adapters.total+' exported function names have identified routing hooks ('+data.adapters.routedPercent.toFixed(2)+'%); '+data.adapters.exercised+' have passing source-form evidence; '+data.adapters.unclassified+' need classification; '+data.adapters.unresolved+' probe errors. '+data.automatic.bodies+' pinned function/helper bodies were translated, including '+data.automatic.publicFunctions+' public functions. Method and field adapters remain visible by declaration; there is no combined PAL completion percentage.';
for(const [name,m] of Object.entries(data.metrics))el('metrics').append(make('span',name+': '+m.percent.toFixed(2)+'% ('+m.covered+'/'+m.total+')'));
for(const [status,count] of Object.entries(data.counts)){el('counts').append(make('span',status+': '+count));const o=make('option',status);o.value=status;el('status').append(o)}
el('evidence').textContent=(data.baseline?data.baseline.compilations+' successful compilations across '+data.baseline.suites.length+' test files and registered scenes. ':'Full-suite baseline is missing or stale. ')+data.cases.filter(c=>c.status==='passed').length+'/'+data.cases.length+' scoped semantic cases passed with current inputs. '+data.usage.diagnostics.length+' TypeScript diagnostics in the discovery scan (includes negative fixtures).';
let page=0;const size=100;
function render(){const q=el('query').value.toLowerCase(), status=el('status').value;
const rows=search.filter(entry=>(!status||entry.row.status===status)&&(!q||entry.text.includes(q))).map(entry=>entry.row);
page=Math.max(0,Math.min(page,Math.ceil(rows.length/size)-1));el('rows').replaceChildren();
el('page').textContent=rows.length+' entries · page '+(page+1)+' / '+Math.max(1,Math.ceil(rows.length/size));
for(const row of rows.slice(page*size,(page+1)*size)){const tr=make('tr',''), api=make('td',''), evidence=make('td',''), sites=make('td','');
const details=make('details','');details.append(make('summary',row.id),make('pre',row.declaration));api.append(details);
for(const binding of row.bindings){const d=make('details','');d.append(make('summary',binding.name+' · '+binding.status),make('code',binding.lowerer||''),make('p',binding.diagnostic||'No-argument generation probe accepted.'));evidence.append(d)}
for(const body of row.translations.slice(0,6)){const d=make('details','');d.append(make('summary','Source translated · '+body.extent),make('code',body.modulePath+'#'+body.symbolName),make('p','Configured bindings: '+(body.adapters.join(', ')||'generic parameter/return contracts')),make('p','Observed adapter requests: '+(body.requests.join(', ')||'none recorded')),make('p',body.suite));evidence.append(d)}
evidence.append(make('strong',row.status));for(const id of row.cases){const c=cases.get(id);const d=make('details','');d.append(make('summary',c.id+' · '+c.level+' · '+c.status),make('p',c.scope),make('p','Limits: '+c.limitations),make('code',c.test.file+' — '+c.test.name));evidence.append(d)}
for(const g of row.generation.slice(0,12)){const d=make('details','');d.append(make('summary',g.suite+' · '+g.operation),make('code',g.file+':'+g.line+' · input '+g.source.slice(0,12)),make('code',g.shape));evidence.append(d)}
sites.append(make('small',row.sites.length+' references'));for(const s of row.sites.slice(0,12)){const d=make('details','');d.append(make('summary',s.file+':'+s.line+' · '+s.operation),make('code',s.shape));sites.append(d)}
if(row.sites.length>12)sites.append(make('p','All locations are in report.json.'));tr.append(api,evidence,sites);el('rows').append(tr)}}
el('query').oninput=el('status').onchange=()=>{page=0;render()};el('previous').onclick=()=>{page--;render()};el('next').onclick=()=>{page++;render()};render();
</script></html>`;
}
