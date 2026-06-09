import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase.js";
import { classify, unified, fmt, INDEXES, CYCLE_LABEL, SIGNALS } from "./lib/scoring.js";
import Ring from "./components/Ring.jsx";
import Quadrant from "./components/Quadrant.jsx";

function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return 50;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const SignalPill = ({ sig }) => (
  <span className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
    style={{ color: sig.color, background: sig.color + "1a" }}>{sig.label}</span>
);

export default function App() {
  const [rows, setRows] = useState([]);
  const [regime, setRegime] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState("sp500");
  const [sector, setSector] = useState("All");
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    (async () => {
      const [wl, qs, vs, rg, us, im] = await Promise.all([
        supabase.from("watchlist").select("ticker,name,sector"),
        supabase.from("quality_scores").select("ticker,composite_score,confidence,piotroski_score,altman_z,altman_zone"),
        supabase.from("value_scores").select("ticker,composite_score,price,dcf_intrinsic,pe_ratio,margin_of_safety"),
        supabase.from("regime").select("*").maybeSingle(),
        supabase.from("universe_stats").select("*").maybeSingle(),
        supabase.from("index_membership").select("ticker,index_name"),
      ]);
      const qm = new Map((qs.data || []).map((r) => [r.ticker, r]));
      const vm = new Map((vs.data || []).map((r) => [r.ticker, r]));
      const members = new Map();
      (im.data || []).forEach((m) => {
        if (!members.has(m.ticker)) members.set(m.ticker, new Set());
        members.get(m.ticker).add(m.index_name);
      });
      const merged = (wl.data || []).map((w) => {
        const q = qm.get(w.ticker), v = vm.get(w.ticker);
        return {
          ...w,
          q: q?.composite_score != null ? Number(q.composite_score) : null,
          v: v?.composite_score != null ? Number(v.composite_score) : null,
          confidence: q?.confidence, pio: q?.piotroski_score, altman: q?.altman_z, zone: q?.altman_zone,
          price: v?.price, dcf: v?.dcf_intrinsic, pe: v?.pe_ratio, mos: v?.margin_of_safety,
          indexes: members.get(w.ticker) || new Set(),
        };
      });
      setRows(merged);
      setRegime(rg.data || null);
      setStats(us.data || null);
      setLoading(false);
    })();
  }, []);

  const sectors = useMemo(
    () => ["All", ...Array.from(new Set(rows.map((r) => r.sector).filter(Boolean))).sort()],
    [rows],
  );

  const qMed = stats?.quality_median != null ? Number(stats.quality_median) : median(rows.map((r) => r.q));
  const vMed = stats?.value_median != null ? Number(stats.value_median) : median(rows.map((r) => r.v));

  const filtered = useMemo(() => rows.filter((r) =>
    (idx === "all" || r.indexes.has(idx)) && (sector === "All" || r.sector === sector),
  ), [rows, idx, sector]);

  const ranked = useMemo(() =>
    [...filtered].sort((a, b) => (unified(b.q, b.v) ?? -1) - (unified(a.q, a.v) ?? -1)),
    [filtered]);

  const sel = rows.find((r) => r.ticker === selected) || ranked.find((r) => r.q != null) || ranked[0];
  const selSig = sel ? classify(sel.q, sel.v, qMed, vMed) : SIGNALS.NA;
  const scoredCount = filtered.filter((r) => r.q != null).length;

  return (
    <div className="min-h-screen px-4 py-5 sm:px-8 max-w-[1180px] mx-auto">
      <header className="mb-5 flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-sans text-2xl font-bold tracking-tight">
            NEW<span className="text-quality">NFL</span>
          </h1>
          <p className="text-white/40 text-xs font-mono mt-0.5">Numbers · Fundamentals · Logic — show the work</p>
        </div>
        <RegimeBanner regime={regime} />
      </header>

      {/* Toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1 card p-1">
          {INDEXES.map((i) => (
            <button key={i.id} onClick={() => setIdx(i.id)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                idx === i.id ? "bg-white/10 text-white" : "text-white/45 hover:text-white/80"}`}>
              {i.label}
            </button>
          ))}
        </div>
        <select value={sector} onChange={(e) => setSector(e.target.value)}
          className="card px-2.5 py-1.5 text-xs bg-transparent text-white/80 outline-none">
          {sectors.map((s) => <option key={s} value={s} className="bg-ink">{s === "All" ? "All sectors" : s}</option>)}
        </select>
        <span className="text-white/35 text-xs font-mono ml-auto">
          {loading ? "loading…" : `${scoredCount}/${filtered.length} scored`}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Scatter */}
        <div className="card p-3">
          {loading
            ? <div className="h-[380px] grid place-items-center text-white/30 text-sm">loading the map…</div>
            : <Quadrant rows={filtered} qMed={qMed} vMed={vMed} selected={sel?.ticker} onSelect={setSelected} />}
        </div>

        {/* Selected stock */}
        {sel && (
          <div className="card p-4 flex flex-col">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-mono text-xl font-semibold">{sel.ticker}</div>
                <div className="text-white/45 text-xs">{sel.name}</div>
                <div className="text-white/35 text-[11px] mt-0.5">{sel.sector}</div>
              </div>
              <div className="text-right">
                <SignalPill sig={selSig} />
                <div className="text-white/40 text-[11px] mt-1">{selSig.quadrant}</div>
              </div>
            </div>

            <div className="flex justify-around my-4">
              <Ring value={sel.q} color="#5eead4" label="Quality" />
              <Ring value={sel.v} color="#818cf8" label="Value" />
              <Ring value={unified(sel.q, sel.v)} color="#e8e8f0" label="Q×V" />
            </div>

            <dl className="grid grid-cols-2 gap-y-1.5 text-xs font-mono tabular">
              <Stat k="Price" v={sel.price != null ? `$${fmt(sel.price, 2)}` : "—"} />
              <Stat k="DCF" v={sel.dcf != null ? `$${fmt(sel.dcf, 0)}` : "n/a"} />
              <Stat k="Piotroski" v={sel.pio != null ? `${sel.pio}/9` : "—"} />
              <Stat k={`Altman${sel.zone ? ` (${sel.zone})` : ""}`} v={sel.altman != null ? fmt(sel.altman, 1) : "n/a"} />
              <Stat k="P/E" v={fmt(sel.pe, 1)} />
              <Stat k="Confidence" v={sel.confidence || "—"} />
            </dl>
            <p className="text-white/30 text-[10px] mt-3 leading-snug">
              Boundaries are universe medians (Q {fmt(qMed, 0)} · V {fmt(vMed, 0)}), recomputed as the watchlist changes.
            </p>
          </div>
        )}
      </div>

      {/* Ranked table */}
      <div className="card mt-4 overflow-hidden">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-white/40 text-[11px] uppercase tracking-wide">
              <tr>
                {["#", "Ticker", "Sector", "Q", "V", "Pio", "Altman", "P/E", "Signal", "Q×V"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {ranked.map((r, i) => {
                const sig = classify(r.q, r.v, qMed, vMed);
                return (
                  <tr key={r.ticker} onClick={() => setSelected(r.ticker)}
                    className={`border-t border-white/5 cursor-pointer hover:bg-white/[0.03] ${
                      sel?.ticker === r.ticker ? "bg-white/[0.05]" : ""}`}>
                    <td className="px-3 py-1.5 text-white/30">{i + 1}</td>
                    <td className="px-3 py-1.5 font-semibold">{r.ticker}</td>
                    <td className="px-3 py-1.5 text-white/45 text-xs font-sans whitespace-nowrap">{r.sector}</td>
                    <td className="px-3 py-1.5" style={{ color: "#5eead4" }}>{r.q == null ? "—" : Math.round(r.q)}</td>
                    <td className="px-3 py-1.5" style={{ color: "#818cf8" }}>{r.v == null ? "—" : Math.round(r.v)}</td>
                    <td className="px-3 py-1.5 text-white/60">{r.pio ?? "—"}</td>
                    <td className="px-3 py-1.5 text-white/60">{r.altman == null ? "—" : fmt(r.altman, 1)}</td>
                    <td className="px-3 py-1.5 text-white/60">{fmt(r.pe, 1)}</td>
                    <td className="px-3 py-1.5"><SignalPill sig={sig} /></td>
                    <td className="px-3 py-1.5 font-semibold">{unified(r.q, r.v) == null ? "—" : Math.round(unified(r.q, r.v))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="text-white/25 text-[11px] mt-6 leading-relaxed">
        Quality is price-independent (is it a great business?); Value is price-dependent (what am I paying per unit of quality?).
        Regime describes the macro environment — it does not predict turns. Scores are decomposable and for research, not investment advice.
      </footer>
    </div>
  );
}

const Stat = ({ k, v }) => (
  <>
    <dt className="text-white/35">{k}</dt>
    <dd className="text-right text-white/85">{v}</dd>
  </>
);

function RegimeBanner({ regime }) {
  if (!regime) return <div className="text-white/30 text-xs font-mono">regime: pending</div>;
  return (
    <div className="card px-3 py-2 flex items-center gap-3">
      <Ring value={regime.composite_score != null ? Number(regime.composite_score) : null} size={42} stroke={4} color="#f59e0b" />
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wider text-white/40">Market regime</div>
        <div className="text-sm font-medium">{CYCLE_LABEL[regime.cycle_phase] || "—"}</div>
        <div className="text-[10px] text-white/40 font-mono">
          recession prob {regime.recession_probability != null ? Math.round(regime.recession_probability * 100) + "%" : "—"}
        </div>
      </div>
    </div>
  );
}
