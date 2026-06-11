import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase.js";
import { classify, unified, fmt, INDEXES, CYCLE_LABEL, SIGNALS } from "./lib/scoring.js";
import Ring from "./components/Ring.jsx";
import Quadrant from "./components/Quadrant.jsx";
import StockDetail from "./components/StockDetail.jsx";
import MacroDashboard from "./components/MacroDashboard.jsx";

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
  const [sigFilter, setSigFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showRegime, setShowRegime] = useState(false);
  const [view, setView] = useState("stocks"); // "stocks" | "sectors"

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
    (idx === "all" || r.indexes.has(idx)) &&
    (sector === "All" || r.sector === sector) &&
    (sigFilter === "ALL" || classify(r.q, r.v, qMed, vMed).label === sigFilter),
  ), [rows, idx, sector, sigFilter, qMed, vMed]);

  const ranked = useMemo(() =>
    [...filtered].sort((a, b) => (unified(b.q, b.v) ?? -1) - (unified(a.q, a.v) ?? -1)),
    [filtered]);

  // Sector view: median Q/V per sector across the current index universe (the
  // sector dropdown is ignored here — the point is to compare all sectors).
  const idxFiltered = useMemo(
    () => rows.filter((r) => idx === "all" || r.indexes.has(idx)),
    [rows, idx]);
  const sectorRows = useMemo(() => {
    const groups = new Map();
    idxFiltered.forEach((r) => {
      if (!r.sector) return;
      if (!groups.has(r.sector)) groups.set(r.sector, []);
      groups.get(r.sector).push(r);
    });
    return Array.from(groups.entries()).map(([sector, members]) => {
      const scored = members.filter((m) => m.q != null && m.v != null);
      const mq = median(scored.map((m) => m.q));
      const mv = median(scored.map((m) => m.v));
      return { sector, n: scored.length, total: members.length, mq, mv,
        u: scored.length ? unified(mq, mv) : null };
    }).sort((a, b) => (b.u ?? -1) - (a.u ?? -1));
  }, [idxFiltered]);

  const sel = rows.find((r) => r.ticker === selected) || ranked.find((r) => r.q != null) || ranked[0];
  const selSig = sel ? classify(sel.q, sel.v, qMed, vMed) : SIGNALS.NA;
  const scoredCount = filtered.filter((r) => r.q != null).length;

  // Ticker / company search across the whole universe (ignores the active filters).
  const matches = useMemo(() => {
    const t = query.trim().toUpperCase();
    if (!t) return [];
    const starts = [], contains = [];
    for (const r of rows) {
      const tk = r.ticker, nm = (r.name || "").toUpperCase();
      if (tk === t) { starts.unshift(r); continue; }
      if (tk.startsWith(t)) starts.push(r);
      else if (tk.includes(t) || nm.includes(t)) contains.push(r);
    }
    return [...starts, ...contains].slice(0, 8);
  }, [query, rows]);

  // Lazy-load the full decomposition for one stock when its detail modal opens,
  // so the initial map stays light. Header data comes from the row we already have.
  async function openDetail(r) {
    setDetailLoading(true);
    setDetail({
      ticker: r.ticker, name: r.name, sector: r.sector, q: r.q, v: r.v,
      sig: classify(r.q, r.v, qMed, vMed),
    });
    const [qd, vd] = await Promise.all([
      supabase.from("quality_scores").select("component_detail,piotroski_sub,history_10yr").eq("ticker", r.ticker).maybeSingle(),
      supabase.from("value_scores").select("component_detail,history_10yr").eq("ticker", r.ticker).maybeSingle(),
    ]);
    setDetail((d) => d && d.ticker === r.ticker ? {
      ...d,
      qDetail: qd.data?.component_detail, vDetail: vd.data?.component_detail,
      piotroskiSub: qd.data?.piotroski_sub, qHist: qd.data?.history_10yr, vHist: vd.data?.history_10yr,
    } : d);
    setDetailLoading(false);
  }

  // Deep-linkable detail: opening a stock pushes /stock/TICKER so the breakdown
  // is shareable and the browser back button closes it. SPA fallback in
  // netlify.toml serves index.html for these paths on a cold load.
  function openStock(ticker, push = true) {
    const r = rows.find((x) => x.ticker === ticker);
    if (!r) return;
    setSelected(ticker);
    openDetail(r);
    if (push) window.history.pushState({ ticker }, "", `/stock/${encodeURIComponent(ticker)}`);
  }
  function closeStock(push = true) {
    setDetail(null);
    if (push && window.location.pathname !== "/") window.history.pushState({}, "", "/");
  }
  // Keep a live reference so the once-bound popstate listener always sees fresh state.
  const navRef = useRef();
  navRef.current = { openStock, closeStock };

  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/stock\/([^/]+)$/);
      if (m) navRef.current.openStock(decodeURIComponent(m[1]).toUpperCase(), false);
      else navRef.current.closeStock(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Honor /stock/TICKER on first load, once the universe has loaded.
  useEffect(() => {
    if (loading) return;
    const m = window.location.pathname.match(/^\/stock\/([^/]+)$/);
    if (m) navRef.current.openStock(decodeURIComponent(m[1]).toUpperCase(), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <div className="min-h-screen px-4 py-5 sm:px-8 max-w-[1180px] mx-auto">
      <header className="mb-5 flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-sans text-2xl font-bold tracking-tight">
            NEW<span className="text-quality">NFL</span>
          </h1>
          <p className="text-white/40 text-xs font-mono mt-0.5">Numbers · Fundamentals · Logic — show the work</p>
        </div>
        <RegimeBanner regime={regime} onClick={() => setShowRegime(true)} />
      </header>

      {/* Toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) { openStock(matches[0].ticker); setQuery(""); setSearchOpen(false); e.currentTarget.blur(); }
              if (e.key === "Escape") { setQuery(""); setSearchOpen(false); }
            }}
            placeholder="🔍 Search ticker or company…"
            className="card px-3 py-1.5 text-xs bg-transparent text-white/85 outline-none w-52 placeholder:text-white/30" />
          {searchOpen && matches.length > 0 && (
            <div className="absolute z-30 mt-1 w-72 card p-1 max-h-72 overflow-y-auto">
              {matches.map((r) => {
                const sig = classify(r.q, r.v, qMed, vMed);
                return (
                  <button key={r.ticker} onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { openStock(r.ticker); setQuery(""); setSearchOpen(false); }}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/[0.06] text-left">
                    <span className="min-w-0 flex items-baseline gap-2">
                      <span className="font-mono font-semibold text-sm text-white/90">{r.ticker}</span>
                      <span className="text-white/45 text-[11px] truncate">{r.name}</span>
                    </span>
                    {r.q != null ? <SignalPill sig={sig} /> : <span className="text-white/25 text-[10px] whitespace-nowrap">unscored</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
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
        <button onClick={() => setShowRegime(true)}
          className="card px-2.5 py-1.5 text-xs font-medium text-white/70 hover:text-white hover:bg-white/[0.06] transition">
          🌐 Macro
        </button>
        <span className="text-white/35 text-xs font-mono ml-auto">
          {loading ? "loading…" : `${scoredCount}/${filtered.length} scored`}
        </span>
      </div>

      {/* Signal filter */}
      <div className="flex gap-1 card p-1 mb-4 w-fit">
        {["ALL", ...Object.keys(SIGNALS).filter((k) => k !== "NA")].map((k) => {
          const active = sigFilter === k;
          const c = k === "ALL" ? "#e8e8f0" : SIGNALS[k].color;
          return (
            <button key={k} onClick={() => setSigFilter(k)} title={k === "ALL" ? "All signals" : SIGNALS[k].quadrant}
              className="px-2.5 py-1 rounded text-xs font-bold tracking-wide transition"
              style={active
                ? { color: c, background: c + "22" }
                : { color: "rgba(255,255,255,0.4)" }}>
              {k === "ALL" ? "All" : k}
            </button>
          );
        })}
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
            <button onClick={() => openStock(sel.ticker)} disabled={sel.q == null}
              className="mt-4 w-full rounded-md bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 disabled:hover:bg-white/[0.06]
                text-xs font-medium py-2 transition text-white/85">
              Show the work →
            </button>
            <p className="text-white/30 text-[10px] mt-3 leading-snug">
              Boundaries are universe medians (Q {fmt(qMed, 0)} · V {fmt(vMed, 0)}), recomputed as the watchlist changes.
            </p>
          </div>
        )}
      </div>

      {/* Bottom table: stocks ranked, or sector medians */}
      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center gap-1 p-1 border-b border-white/5">
          {[["stocks", "Stocks"], ["sectors", "Sectors"]].map(([id, label]) => (
            <button key={id} onClick={() => setView(id)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${
                view === id ? "bg-white/10 text-white" : "text-white/45 hover:text-white/80"}`}>
              {label}
            </button>
          ))}
          <span className="text-white/30 text-[11px] font-mono ml-auto pr-2">
            {view === "stocks" ? `${ranked.length} names` : `${sectorRows.length} sectors`}
          </span>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {view === "stocks" && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-white/40 text-[11px] uppercase tracking-wide">
              <tr>
                {["#", "Ticker", "Sector", "Q", "V", "Pio", "Altman", "P/E", "Signal", "Q×V", ""].map((h, hi) => (
                  <th key={hi} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
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
                    <td className="px-2 py-1.5 text-right">
                      {r.q != null && (
                        <button onClick={(e) => { e.stopPropagation(); openStock(r.ticker); }}
                          aria-label={`Show the work for ${r.ticker}`}
                          className="text-white/30 hover:text-white px-1 text-base leading-none">›</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}

          {view === "sectors" && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-white/40 text-[11px] uppercase tracking-wide">
              <tr>
                {["Sector", "Scored", "Q", "V", "Signal", "Q×V"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {sectorRows.map((s) => {
                const sig = s.n ? classify(s.mq, s.mv, qMed, vMed) : SIGNALS.NA;
                return (
                  <tr key={s.sector} onClick={() => { setSector(s.sector); setView("stocks"); }}
                    title={`Filter the map to ${s.sector}`}
                    className="border-t border-white/5 cursor-pointer hover:bg-white/[0.03]">
                    <td className="px-3 py-1.5 font-sans text-white/85 whitespace-nowrap">{s.sector}</td>
                    <td className="px-3 py-1.5 text-white/45">{s.n}/{s.total}</td>
                    <td className="px-3 py-1.5" style={{ color: "#5eead4" }}>{s.n ? Math.round(s.mq) : "—"}</td>
                    <td className="px-3 py-1.5" style={{ color: "#818cf8" }}>{s.n ? Math.round(s.mv) : "—"}</td>
                    <td className="px-3 py-1.5"><SignalPill sig={sig} /></td>
                    <td className="px-3 py-1.5 font-semibold">{s.u == null ? "—" : Math.round(s.u)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      </div>

      <footer className="text-white/25 text-[11px] mt-6 leading-relaxed">
        Quality is price-independent (is it a great business?); Value is price-dependent (what am I paying per unit of quality?).
        Regime describes the macro environment — it does not predict turns. Scores are decomposable and for research, not investment advice.
      </footer>

      {detail && <StockDetail data={detail} loading={detailLoading} onClose={() => closeStock(true)} />}
      {showRegime && <MacroDashboard regime={regime} onClose={() => setShowRegime(false)} />}
    </div>
  );
}

const Stat = ({ k, v }) => (
  <>
    <dt className="text-white/35">{k}</dt>
    <dd className="text-right text-white/85">{v}</dd>
  </>
);

function RegimeBanner({ regime, onClick }) {
  if (!regime) return <div className="text-white/30 text-xs font-mono">regime: pending</div>;
  return (
    <button onClick={onClick} title="See the macro indicators"
      className="card px-3 py-2 flex items-center gap-3 text-left hover:bg-white/[0.04] transition">
      <Ring value={regime.composite_score != null ? Number(regime.composite_score) : null} size={42} stroke={4} color="#f59e0b" />
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wider text-white/40">Market regime</div>
        <div className="text-sm font-medium">{CYCLE_LABEL[regime.cycle_phase] || "—"}</div>
        <div className="text-[10px] text-white/40 font-mono">
          recession prob {regime.recession_probability != null ? Math.round(regime.recession_probability * 100) + "%" : "—"}
        </div>
      </div>
      <span className="text-white/25 text-sm self-center ml-0.5">›</span>
    </button>
  );
}
