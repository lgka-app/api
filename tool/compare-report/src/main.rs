//! Parity comparator: parser outputs (the API, or any port) vs the Dart goldens in test/goldens.
//!
//! Usage: compare-report [<api-out-dir>] [--api DIR] [--kotlin DIR] [--swift DIR]
//!                       [--out report.html]
//!
//! Run once, get an HTML scoreboard. Exit code 0 only on full parity —
//! usable as a CI gate.

use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const CSS: &str = r#"
:root {
  --bg: #FAFBFC; --ink: #1B2530; --muted: #5B6875; --line: #D8DEE4;
  --accent: #0E7C7B; --card: #FFFFFF;
  --pass-bg: #E4F2E9; --pass-ink: #22643A; --fail-bg: #F9E4E4; --fail-ink: #A33232;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #14181D; --ink: #E6EBF0; --muted: #8B98A5; --line: #2A323B;
  --accent: #3FB5B4; --card: #1B2129;
  --pass-bg: #1C3627; --pass-ink: #7DD09A; --fail-bg: #402124; --fail-ink: #E58A8A;
} }
:root[data-theme="light"] {
  --bg: #FAFBFC; --ink: #1B2530; --muted: #5B6875; --line: #D8DEE4;
  --accent: #0E7C7B; --card: #FFFFFF;
  --pass-bg: #E4F2E9; --pass-ink: #22643A; --fail-bg: #F9E4E4; --fail-ink: #A33232;
}
:root[data-theme="dark"] {
  --bg: #14181D; --ink: #E6EBF0; --muted: #8B98A5; --line: #2A323B;
  --accent: #3FB5B4; --card: #1B2129;
  --pass-bg: #1C3627; --pass-ink: #7DD09A; --fail-bg: #402124; --fail-ink: #E58A8A;
}
body { background: var(--bg); color: var(--ink); margin: 0;
  font: 15px/1.55 system-ui, -apple-system, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h1 em { color: var(--accent); font-style: normal; }
.meta { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .8rem; margin-bottom: 2rem; }
.chip { display: inline-block; padding: .1rem .55rem; border-radius: 999px;
  font: 600 .72rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em; vertical-align: middle; }
.chip.big { font-size: .85rem; padding: .25rem .8rem; }
.pass { background: var(--pass-bg); color: var(--pass-ink); }
.fail { background: var(--fail-bg); color: var(--fail-ink); }
table { border-collapse: collapse; width: 100%; }
.summary td, .summary th { padding: .5rem .75rem; border-bottom: 1px solid var(--line);
  text-align: left; }
.summary th { color: var(--muted); font-size: .72rem; text-transform: uppercase;
  letter-spacing: .08em; }
.fx a { color: var(--accent); text-decoration: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
section { margin-top: 3rem; border-top: 2px solid var(--accent); padding-top: 1rem; }
section h3 { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .95rem; margin: 0 0 1rem; }
.impl h4 { margin: 1.25rem 0 .5rem; font-size: .9rem; }
.tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
.diffs td, .diffs th { padding: .35rem .6rem; border-bottom: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem;
  text-align: left; vertical-align: top; white-space: pre-wrap; }
.diffs th { color: var(--muted); text-transform: uppercase; font-size: .68rem;
  letter-spacing: .08em; }
.diffs tr:last-child td { border-bottom: none; }
.path { color: var(--accent); }
.want { color: var(--pass-ink); }
.got { color: var(--fail-ink); }
details { margin: .75rem 0; }
summary { cursor: pointer; color: var(--muted); font-size: .8rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 6px;
  padding: 1rem; overflow-x: auto; font-size: .75rem; line-height: 1.5; }
.more { color: var(--muted); font-size: .8rem; }
"#;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn jshow(v: &Value) -> String {
    esc(&serde_json::to_string(v).unwrap_or_default())
}

/// Recursive semantic diff; collects (path, golden, actual) display rows.
fn diff(path: &str, golden: &Value, actual: &Value, out: &mut Vec<(String, String, String)>) {
    match (golden, actual) {
        (Value::Object(g), Value::Object(a)) => {
            let keys: BTreeSet<_> = g.keys().chain(a.keys()).collect();
            for k in keys {
                let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                match (g.get(k), a.get(k)) {
                    (Some(gv), Some(av)) => diff(&p, gv, av, out),
                    (Some(gv), None) => out.push((p, jshow(gv), "&lt;missing&gt;".into())),
                    (None, Some(av)) => out.push((p, "&lt;missing&gt;".into(), jshow(av))),
                    (None, None) => unreachable!(),
                }
            }
        }
        (Value::Array(g), Value::Array(a)) => {
            if g.len() != a.len() {
                out.push((format!("{path}.length"), g.len().to_string(), a.len().to_string()));
            }
            for (i, (gv, av)) in g.iter().zip(a.iter()).enumerate() {
                diff(&format!("{path}[{i}]"), gv, av, out);
            }
        }
        // Numbers compare as f64: Dart/Kotlin serialize 37240.0, Swift's
        // JSONSerialization emits 37240 — semantically identical.
        (Value::Number(g), Value::Number(a)) => {
            if g.as_f64() != a.as_f64() {
                out.push((path.to_string(), jshow(golden), jshow(actual)));
            }
        }
        _ => {
            if golden != actual {
                out.push((path.to_string(), jshow(golden), jshow(actual)));
            }
        }
    }
}

struct ImplResult {
    ok: bool,
    diffs: Vec<(String, String, String)>,
    actual: Option<Value>,
}

fn main() {
    // ---- args ------------------------------------------------------------
    let mut api: Option<PathBuf> = None;
    let mut kotlin: Option<PathBuf> = None;
    let mut swift: Option<PathBuf> = None;
    let mut out_path = PathBuf::from("report.html");
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--api" => api = args.next().map(PathBuf::from),
            "--kotlin" => kotlin = args.next().map(PathBuf::from),
            "--swift" => swift = args.next().map(PathBuf::from),
            "--out" => out_path = args.next().map(PathBuf::from).unwrap_or(out_path),
            _ if api.is_none() && !a.starts_with("--") => api = Some(PathBuf::from(a)),
            _ => {
                eprintln!("usage: compare-report [<api-out-dir>] [--api DIR] [--kotlin DIR] [--swift DIR] [--out report.html]");
                exit(2);
            }
        }
    }
    let impls: Vec<(&str, PathBuf)> = [("API", api), ("Kotlin", kotlin), ("Swift", swift)]
        .into_iter()
        .filter_map(|(n, p)| p.map(|p| (n, p)))
        .collect();
    if impls.is_empty() {
        eprintln!("provide at least one of: <api-out-dir>, --api, --kotlin, --swift");
        exit(2);
    }

    // ---- load goldens ----------------------------------------------------
    // Two golden families share one namespace: substitution plans
    // (goldens/substitution/<fx>.v2.json -> impl <fx>.json) and schedule
    // class indexes (goldens/schedule/class_index_<pdf>.json -> impl
    // class_index_<pdf>.json).
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("test");
    let mut fixture_files: Vec<(String, PathBuf)> = Vec::new();
    for e in fs::read_dir(repo.join("goldens").join("substitution"))
        .expect("goldens/substitution not found")
        .filter_map(|e| e.ok())
    {
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(id) = n.strip_suffix(".v2.json") {
            fixture_files.push((id.to_string(), e.path()));
        }
    }
    for e in fs::read_dir(repo.join("goldens").join("schedule"))
        .expect("goldens/schedule not found")
        .filter_map(|e| e.ok())
    {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with("class_index_") || n.starts_with("stundenplan_page_") {
            if let Some(id) = n.strip_suffix(".json") {
                fixture_files.push((id.to_string(), e.path()));
            }
        }
    }
    // Web-scraper families: goldens/<family>/<family>_<stamp>.json
    for family in ["news", "events", "weather"] {
        let dir = repo.join("goldens").join(family);
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.filter_map(|e| e.ok()) {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with(&format!("{family}_")) {
                    if let Some(id) = n.strip_suffix(".json") {
                        fixture_files.push((id.to_string(), e.path()));
                    }
                }
            }
        }
    }
    fixture_files.sort();
    let fixtures: Vec<String> = fixture_files.iter().map(|(id, _)| id.clone()).collect();

    // ---- compare ---------------------------------------------------------
    let mut results: Vec<(String, Value, Vec<(&str, ImplResult)>)> = Vec::new();
    for (fx, golden_file) in &fixture_files {
        let golden_doc: Value =
            serde_json::from_str(&fs::read_to_string(golden_file).unwrap()).unwrap();
        let golden = golden_doc["expected"].clone();
        let mut per_impl = Vec::new();
        for (name, dir) in &impls {
            let f = dir.join(format!("{fx}.json"));
            let res = match fs::read_to_string(&f) {
                Ok(text) => {
                    let actual: Value = serde_json::from_str(&text)
                        .unwrap_or(Value::String("<unparseable json>".into()));
                    let mut diffs = Vec::new();
                    diff("", &golden, &actual, &mut diffs);
                    ImplResult { ok: diffs.is_empty(), diffs, actual: Some(actual) }
                }
                Err(_) => ImplResult {
                    ok: false,
                    diffs: vec![("<output>".into(), "file".into(), "missing".into())],
                    actual: None,
                },
            };
            per_impl.push((*name, res));
        }
        results.push((fx.clone(), golden, per_impl));
    }

    let totals: Vec<(&str, usize)> = impls
        .iter()
        .enumerate()
        .map(|(i, (name, _))| {
            (*name, results.iter().filter(|(_, _, per)| per[i].1.ok).count())
        })
        .collect();
    let all_green = totals.iter().all(|(_, n)| *n == fixtures.len());

    // ---- render ----------------------------------------------------------
    let commit = Command::new("git")
        .args(["-C", &repo.to_string_lossy(), "rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "?".into());
    let now = Command::new("date")
        .args(["-u", "+%Y-%m-%d %H:%M UTC"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let chip = |ok: bool, text: &str| {
        format!("<span class=\"chip {}\">{}</span>", if ok { "pass" } else { "fail" }, text)
    };

    let mut summary_rows = String::new();
    for (fx, _, per) in &results {
        let cells: String = per
            .iter()
            .map(|(_, r)| {
                let label = if r.ok { "MATCH".into() } else { format!("{} diffs", r.diffs.len()) };
                format!("<td>{}</td>", chip(r.ok, &label))
            })
            .collect();
        let _ = write!(summary_rows,
            "<tr><td class=\"fx\"><a href=\"#{fx}\">{fx}</a></td>{cells}</tr>");
    }

    let mut sections = String::new();
    for (fx, golden, per) in &results {
        let _ = write!(sections, "<section id=\"{fx}\"><h3>{fx}</h3>");
        for (name, r) in per {
            if r.ok {
                let _ = write!(sections,
                    "<div class=\"impl\"><h4>{name} {}</h4></div>", chip(true, "MATCH"));
                continue;
            }
            let _ = write!(sections,
                "<div class=\"impl\"><h4>{name} {}</h4><div class=\"tablewrap\">\
                 <table class=\"diffs\"><thead><tr><th>path</th><th>golden</th><th>{}</th></tr></thead><tbody>",
                chip(false, &format!("{} diffs", r.diffs.len())), name.to_lowercase());
            for (p, g, a) in r.diffs.iter().take(60) {
                let _ = write!(sections,
                    "<tr><td class=\"path\">{}</td><td class=\"want\">{g}</td><td class=\"got\">{a}</td></tr>",
                    esc(p));
            }
            let _ = write!(sections, "</tbody></table></div>");
            if r.diffs.len() > 60 {
                let _ = write!(sections, "<p class=\"more\">… {} more</p>", r.diffs.len() - 60);
            }
            let actual_json = r.actual.as_ref()
                .map(|v| esc(&serde_json::to_string_pretty(v).unwrap_or_default()))
                .unwrap_or_else(|| "&lt;no output&gt;".into());
            let _ = write!(sections,
                "<details><summary>full {name} output</summary><pre>{actual_json}</pre></details></div>");
        }
        let golden_json = esc(&serde_json::to_string_pretty(golden).unwrap_or_default());
        let _ = write!(sections,
            "<details><summary>golden (Dart reference)</summary><pre>{golden_json}</pre></details></section>");
    }

    let verdict = if all_green {
        "<span class=\"chip pass big\">ALL GREEN — FULL PARITY</span>"
    } else {
        "<span class=\"chip fail big\">DIFFS REMAIN</span>"
    };
    let impl_headers: String = totals
        .iter()
        .map(|(name, n)| format!("<th>{name} ({n}/{})</th>", fixtures.len()))
        .collect();

    let html = format!(
        "<title>LGKA Extractor Parity</title>\n<style>{CSS}</style>\n<main>\n\
         <h1>LGKA <em>parser parity</em> — api.lgka.app parsers vs the Dart goldens</h1>\n\
         <p class=\"meta\">generated {now} · goldens @ {commit} · {} fixtures (substitution + class index)</p>\n\
         <p>{verdict}</p>\n\
         <div class=\"tablewrap\"><table class=\"summary\">\
         <thead><tr><th>fixture</th>{impl_headers}</tr></thead>\
         <tbody>{summary_rows}</tbody></table></div>\n{sections}\n</main>\n",
        fixtures.len());

    fs::write(&out_path, html).expect("failed to write report");
    println!("report: {}", out_path.display());
    for (name, n) in &totals {
        println!("{name}: {n}/{} fixtures match", fixtures.len());
    }
    exit(if all_green { 0 } else { 1 });
}
