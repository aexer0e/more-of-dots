"""Create a searchable HTML report from an inventory and compatibility audit."""
import argparse
import collections
import html
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--inventory", type=Path, required=True)
parser.add_argument("--results", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--load-checks", type=Path)
parser.add_argument("--numbered-results", type=Path)
args = parser.parse_args()
original = json.loads(args.inventory.read_text(encoding="utf-8"))
audit = json.loads(args.results.read_text(encoding="utf-8"))
numbered_note = ""
if args.numbered_results:
    numbered = json.loads(args.numbered_results.read_text(encoding="utf-8"))
    audit["files"] += numbered["files"]
    numbered_note = f'<p>The numbered-map run used the new deployment catalog, engine SHA-256 <code>{numbered["engine_sha256"]}</code>. <a href="{html.escape(args.numbered_results.name)}">Numbered-map results</a></p>'
updated = {r["sha256"]: r for r in audit["files"]}
rows = []
for previous in original["files"]:
    r = updated.get(previous["sha256"], previous)
    status = r.get("compatibility_status")
    label = "Missing map layout" if r["schema"] == "map ID only" else "Pending"
    if status == "completed":
        label = "Completed with deferred orders" if r.get("deferred_orders") else "Completed"
    elif status == "failed":
        label = "Missing map layout" if "player has no layout" in r.get("compatibility_error", "") else "Failed"
    rows.append(dict(file=r["file"], matchup=r.get("matchup", ""), version=r.get("version", "unknown"),
                     schema=r["schema"], category=label, end=r.get("final_frame", r.get("end")),
                     deferred=r.get("deferred_orders", 0), pending=r.get("pending_orders", 0),
                     error=r.get("compatibility_error", ""), sha256=r["sha256"]))
counts = collections.Counter(r["category"] for r in rows)
legacy = [r for r in audit["files"] if r.get("category") in ("legacy-object", "legacy-custom")]
legacy_done = sum(r.get("compatibility_status") == "completed" for r in legacy)
compared = [r for r in audit["files"] if "matches_previous_final_state" in r]
matched = sum(r["matches_previous_final_state"] for r in compared)
version_rows = []
for version in sorted({r.get("version", "unknown") for r in audit["files"]}):
    subset = [r for r in audit["files"] if r.get("version", "unknown") == version]
    version_rows.append(f'<tr><td>{html.escape(version)}</td><td>{len(subset)}</td><td>{sum(r.get("compatibility_status") == "completed" for r in subset)}</td><td>{sum(bool(r.get("deferred_orders")) for r in subset)}</td><td>{sum(bool(r.get("pending_orders")) for r in subset)}</td></tr>')
payload = json.dumps(rows, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
page = r"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replay compatibility results</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f7;color:#17212b;font:15px/1.55 system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:32px}h1{font-size:32px;margin:0 0 12px}h2{font-size:21px;margin-top:28px}p{max-width:1100px;color:#4b5865}.cards{display:flex;gap:15px;flex-wrap:wrap;margin:24px 0}.card{padding:16px 22px;background:white;border:1px solid #dce2e7;border-radius:8px}.card b{display:block;font-size:30px}table{border-collapse:collapse;background:white;width:100%}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid #dce2e7;vertical-align:top}th{background:#e8edf1;font-size:13px}td{font-size:14px}.wrap{overflow:auto;border:1px solid #dce2e7;border-radius:8px}.filters{display:flex;gap:10px;margin:16px 0;flex-wrap:wrap}input,select,button{font:inherit;padding:9px 12px;background:white;border:1px solid #b9c6d0;border-radius:5px}input{flex:1;min-width:200px}button{cursor:pointer}button:disabled{opacity:.4}code{font-size:12px;overflow-wrap:anywhere}small{color:#687789}.note{background:#e8edf1;padding:14px 18px;border-left:4px solid #647d92}.pager{display:flex;gap:12px;align-items:center;margin:14px 0}#records td:first-child{min-width:300px;max-width:430px}.tag{font-weight:600}a{color:#145fa0}@media(max-width:700px){main{padding:20px 12px}h1{font-size:26px}}
</style><main><small>LOCAL REPLAY AUDIT</small><h1>Replay compatibility results</h1>
<p>The permissive reader accepts legacy map objects, separate <code>custom_map</code> data, nested mode labels and string player names. Known map numbers resolve through a catalog with separate layouts for each mode. The reader preserves the old fractional infantry/tank slider and attempts unknown versions with the available rules.</p>
<div class="cards">CARDS</div>
<p class="note"><strong>Playback completion is not historical parity.</strong> Legacy production is reconstructed; movement, combat and supply still use the shared 1.4.1 implementation. When an order arrives before a simulated unit exists, its latest order waits for that ID. The converter creates no substitute units. The counts below show affected files and unresolved orders.</p>
<p>BASELINE Original archive and replay files were not modified. MISSING numbered files still need a matching starting layout. A terrain image can be present even when the player lacks that mode's units and cities. External PNG references were checked with the installed game available.</p>
<h2>Results by source version</h2><div class="wrap"><table><thead><tr><th>Version</th><th>Files tested</th><th>Completed</th><th>Files with deferred orders</th><th>Files with unresolved orders</th></tr></thead><tbody>VERSIONS</tbody></table></div>
<h2>Every archive replay</h2><div class="filters"><input id="search" placeholder="Search filename, player or hash"><select id="category"><option value="">All results</option></select><select id="version"><option value="">All versions</option></select></div>
<div class="pager"><button id="prev">Previous</button><span id="count"></span><button id="next">Next</button></div>
<div class="wrap"><table><thead><tr><th>File / matchup</th><th>Version / schema</th><th>Result</th><th>Last frame</th><th>Deferred / unresolved orders</th></tr></thead><tbody id="records"></tbody></table></div>
<h2>Method</h2><p>METHOD</p><p>Original simulation engine SHA-256: <code>HASH</code>. <a href="compatibility-results.json">Original per-file results</a></p>NUMBEREDCHECKS LOADCHECKS</main>
<script>const data=PAYLOAD;let page=0;const $=id=>document.getElementById(id);for(const id of ['category','version'])for(const value of [...new Set(data.map(r=>r[id]))].sort()){$(id).add(new Option(value,value));}
function render(){const query=$('search').value.toLowerCase();const rows=data.filter(r=>(!$('category').value||r.category===$('category').value)&&(!$('version').value||r.version===$('version').value)&&(!query||(r.file+' '+r.matchup+' '+r.sha256).toLowerCase().includes(query)));const start=page*100;$('records').replaceChildren();for(const r of rows.slice(start,start+100)){const tr=document.createElement('tr');for(const text of [r.file+'\n'+r.matchup,r.version+' / '+r.schema,r.category+(r.error?'\n'+r.error:''),String(r.end??''),r.category.startsWith('Completed')?r.deferred+' / '+r.pending:'']){const td=document.createElement('td');td.textContent=text;td.style.whiteSpace='pre-line';tr.append(td);}$('records').append(tr);}$('count').textContent=rows.length?`${start+1}–${Math.min(start+100,rows.length)} of ${rows.length}`:'No matches';$('prev').disabled=page===0;$('next').disabled=start+100>=rows.length;}
for(const id of ['search','category','version'])$(id).addEventListener('input',()=>{page=0;render();});$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};render();</script></html>"""
cards = [(f"{legacy_done:,} / {len(legacy):,}", "Legacy files with saved maps"),
         (f"{sum(r.get('compatibility_status') == 'completed' for r in audit['files']):,}", "Total files completed"),
         (f"{counts['Completed with deferred orders']:,}", "Files with deferred orders"),
         (f"{counts['Missing map layout']:,}", "Missing map layout")]
page = page.replace("CARDS", "".join(f'<div class="card"><b>{number}</b>{label}</div>' for number, label in cards))
page = page.replace("BASELINE", f"{matched} of {len(compared)} modern replay final states match the previous engine after excluding new diagnostic fields.")
page = page.replace("MISSING", str(counts['Missing map layout']))
page = page.replace("NUMBEREDCHECKS", numbered_note)
page = page.replace("VERSIONS", "".join(version_rows)).replace("METHOD", html.escape(audit["method"]))
page = page.replace("HASH", audit["engine_sha256"]).replace("PAYLOAD", payload)
load_note = ""
if args.load_checks:
    loads = json.loads(args.load_checks.read_text(encoding="utf-8"))
    load_note = f'<p>The final reader build also passed a load check of all {len(loads["files"]):,} archive files: {loads["accepted"]:,} accepted, {loads["missing_map"]:,} missing map data. Final engine SHA-256: <code>{loads["engine_sha256"]}</code>. This build adds source-mode metadata and support for flat or absent player labels; the simulated rules are unchanged from the full-run audit.</p>'
page = page.replace("LOADCHECKS", load_note)
args.output.write_text(page, encoding="utf-8")
print(args.output.resolve())
