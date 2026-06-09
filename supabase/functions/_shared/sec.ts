// SEC EDGAR adapter — pulls annual (10-K) financial line items from the free,
// official XBRL `companyfacts` API and normalizes them into per-fiscal-year
// records. This is the raw material for the scores FMP used to hand us
// pre-computed (Piotroski, Altman, DCF, ROIC) — see fundamentals.ts.
import { isFiniteNum } from "./math.ts";

const SEC = "https://data.sec.gov";
const UA = "NEWNFL research contact@newnfl.com"; // SEC requires a descriptive UA

// XBRL tag names vary by filer, so each logical concept has a fallback list.
const TAGS: Record<string, string[]> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  netIncome: ["NetIncomeLoss"],
  grossProfit: ["GrossProfit"],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  operatingIncome: ["OperatingIncomeLoss"],
  incomeTax: ["IncomeTaxExpenseBenefit"],
  pretaxIncome: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  assets: ["Assets"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  retainedEarnings: ["RetainedEarningsAccumulatedDeficit"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  goodwill: ["Goodwill"],
  shares: ["CommonStockSharesOutstanding", "CommonStockSharesIssued"],
};

interface Unit { start?: string; end: string; val: number; form?: string }
// deno-lint-ignore no-explicit-any
type Gaap = Record<string, any>;

const days = (a: string, b: string) => Math.abs((+new Date(b) - +new Date(a)) / 86_400_000);

function rawUnits(gaap: Gaap, tags: string[]): Unit[] {
  for (const t of tags) {
    const u = gaap[t]?.units;
    if (u?.USD) return u.USD as Unit[];
    if (u?.shares) return u.shares as Unit[];
  }
  return [];
}

// Full-year flow values (10-K, ~365-day period), keyed by period-end. Later
// array entries (amendments / restatements) overwrite earlier ones.
function annualFlow(units: Unit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of units) {
    if (u.form !== "10-K" || !u.start) continue;
    const d = days(u.start, u.end);
    if (d < 300 || d > 400) continue;
    m.set(u.end, u.val);
  }
  return m;
}

// Point-in-time balance values, keyed by instant date.
function instant(units: Unit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of units) {
    if (u.form !== "10-K") continue;
    if (u.start && days(u.start, u.end) > 5) continue;
    m.set(u.end, u.val);
  }
  return m;
}

export interface AnnualRecord {
  fyEnd: string;
  revenue?: number; netIncome?: number; grossProfit?: number; costOfRevenue?: number;
  operatingIncome?: number; incomeTax?: number; pretaxIncome?: number;
  ocf?: number; capex?: number;
  assets?: number; currentAssets?: number; currentLiabilities?: number;
  liabilities?: number; equity?: number; retainedEarnings?: number;
  longTermDebt?: number; goodwill?: number; shares?: number;
}

/** Fetch + normalize up to 6 most-recent fiscal years for a zero-padded CIK. */
export async function getSecFundamentals(cik: string): Promise<AnnualRecord[]> {
  const res = await fetch(`${SEC}/api/xbrl/companyfacts/${cik}.json`, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const gaap: Gaap = (await res.json())?.facts?.["us-gaap"];
  if (!gaap) return [];

  const flow = (k: string) => annualFlow(rawUnits(gaap, TAGS[k]));
  const inst = (k: string) => instant(rawUnits(gaap, TAGS[k]));
  const flows = {
    revenue: flow("revenue"), netIncome: flow("netIncome"), grossProfit: flow("grossProfit"),
    costOfRevenue: flow("costOfRevenue"), operatingIncome: flow("operatingIncome"),
    incomeTax: flow("incomeTax"), pretaxIncome: flow("pretaxIncome"), ocf: flow("ocf"), capex: flow("capex"),
  };
  const insts = {
    assets: inst("assets"), currentAssets: inst("currentAssets"), currentLiabilities: inst("currentLiabilities"),
    liabilities: inst("liabilities"), equity: inst("equity"), retainedEarnings: inst("retainedEarnings"),
    longTermDebt: inst("longTermDebt"), goodwill: inst("goodwill"), shares: inst("shares"),
  };

  const fyEnds = [...(flows.revenue.size ? flows.revenue.keys() : flows.netIncome.keys())]
    .sort().reverse().slice(0, 6);
  if (!fyEnds.length) return [];

  const at = (map: Map<string, number>, end: string): number | undefined => {
    if (map.has(end)) return map.get(end);
    for (const [k, v] of map) if (days(k, end) <= 5) return v; // tolerate off-by-a-few-days
    return undefined;
  };

  return fyEnds.map((end) => ({
    fyEnd: end,
    revenue: at(flows.revenue, end), netIncome: at(flows.netIncome, end),
    grossProfit: at(flows.grossProfit, end), costOfRevenue: at(flows.costOfRevenue, end),
    operatingIncome: at(flows.operatingIncome, end), incomeTax: at(flows.incomeTax, end),
    pretaxIncome: at(flows.pretaxIncome, end), ocf: at(flows.ocf, end), capex: at(flows.capex, end),
    assets: at(insts.assets, end), currentAssets: at(insts.currentAssets, end),
    currentLiabilities: at(insts.currentLiabilities, end), liabilities: at(insts.liabilities, end),
    equity: at(insts.equity, end), retainedEarnings: at(insts.retainedEarnings, end),
    longTermDebt: at(insts.longTermDebt, end), goodwill: at(insts.goodwill, end),
    shares: at(insts.shares, end),
  })).filter((r) => isFiniteNum(r.revenue as number) || isFiniteNum(r.netIncome as number));
}
