// Finnhub `financials-reported` adapter — the edge-reachable replacement for
// SEC EDGAR (which is blocked from the Supabase edge egress). Finnhub returns
// each 10-K as one annual period using the same us-gaap concept names as XBRL
// (just `us-gaap_`-prefixed), so we normalize into the same AnnualRecord shape.
import { isFiniteNum } from "./math.ts";
import type { AnnualRecord } from "./sec.ts";

const TAGS: Record<string, string[]> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense"],
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
  shares: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic", "CommonStockSharesOutstanding"],
  // ---- bank / lender line items (financial-sector quality scorer) ----
  netInterestIncome: ["InterestIncomeExpenseNet", "InterestIncomeExpenseAfterProvisionForLoanLoss"],
  interestIncome: ["InterestIncomeOperating", "InterestAndDividendIncomeOperating", "InterestAndFeeIncomeLoansAndLeases"],
  noninterestExpense: ["NoninterestExpense"],
  noninterestIncome: ["NoninterestIncome"],
  // Total net revenue for a bank (net interest income + noninterest income). Its
  // own tag so the efficiency ratio uses the right denominator — the generic
  // `revenue` field can match a small fee-revenue line on some banks (e.g. WFC).
  bankRevenue: ["RevenuesNetOfInterestExpense"],
  allowanceForLoanLoss: ["FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest", "FinancingReceivableAllowanceForCreditLosses", "LoansAndLeasesReceivableAllowance", "AllowanceForDoubtfulAccountsReceivable"],
  loansNetOfAllowance: ["FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss", "LoansAndLeasesReceivableNetReportedAmount", "NotesReceivableNet"],
  provisionForCreditLoss: ["ProvisionForLoanLeaseAndOtherLosses", "ProvisionForLoanAndLeaseLosses", "ProvisionForDoubtfulAccounts"],
  nonaccrualLoans: ["FinancingReceivableRecordedInvestmentNonaccrualStatus"],
};

// deno-lint-ignore no-explicit-any
type Any = any;

// Find the first matching concept across all report sections (ic / bs / cf).
// Finnhub is inconsistent about the taxonomy prefix: most filings tag concepts
// as `us-gaap_NetIncomeLoss`, but some (often older filings, e.g. Brown-Forman's)
// drop it entirely and report a bare `NetIncomeLoss`. Match either form — and any
// other taxonomy prefix — by comparing the bare concept or its `_`-suffix. The
// tag names are long and distinctive, so suffix matching is unambiguous.
function pick(report: Any, tags: string[]): number | undefined {
  for (const section of ["ic", "bs", "cf"]) {
    const arr: Any[] = report?.[section] ?? [];
    for (const tag of tags) {
      const hit = arr.find((e) => {
        const c = String(e?.concept ?? "");
        return c === tag || c === `us-gaap_${tag}` || c.endsWith(`_${tag}`);
      });
      const v = hit ? Number(hit.value) : NaN;
      if (isFiniteNum(v)) return v;
    }
  }
  return undefined;
}

/** Parse Finnhub financials-reported into newest-first annual records (max 6). */
export function parseFinnhubStatements(resp: unknown): AnnualRecord[] {
  const filings: Any[] = ((resp as { data?: Any[] })?.data ?? [])
    .filter((f) => f?.form === "10-K");
  const seenYears = new Set<number>();
  const recs: AnnualRecord[] = [];
  for (const f of filings) {
    if (seenYears.has(f.year)) continue;
    seenYears.add(f.year);
    const r = f.report ?? {};
    recs.push({
      fyEnd: String(f.endDate ?? "").slice(0, 10),
      revenue: pick(r, TAGS.revenue), netIncome: pick(r, TAGS.netIncome),
      grossProfit: pick(r, TAGS.grossProfit), costOfRevenue: pick(r, TAGS.costOfRevenue),
      operatingIncome: pick(r, TAGS.operatingIncome), incomeTax: pick(r, TAGS.incomeTax),
      pretaxIncome: pick(r, TAGS.pretaxIncome), ocf: pick(r, TAGS.ocf), capex: pick(r, TAGS.capex),
      assets: pick(r, TAGS.assets), currentAssets: pick(r, TAGS.currentAssets),
      currentLiabilities: pick(r, TAGS.currentLiabilities), liabilities: pick(r, TAGS.liabilities),
      equity: pick(r, TAGS.equity), retainedEarnings: pick(r, TAGS.retainedEarnings),
      longTermDebt: pick(r, TAGS.longTermDebt), goodwill: pick(r, TAGS.goodwill),
      shares: pick(r, TAGS.shares),
      netInterestIncome: pick(r, TAGS.netInterestIncome), interestIncome: pick(r, TAGS.interestIncome),
      noninterestExpense: pick(r, TAGS.noninterestExpense), noninterestIncome: pick(r, TAGS.noninterestIncome),
      bankRevenue: pick(r, TAGS.bankRevenue), allowanceForLoanLoss: pick(r, TAGS.allowanceForLoanLoss),
      loansNetOfAllowance: pick(r, TAGS.loansNetOfAllowance), provisionForCreditLoss: pick(r, TAGS.provisionForCreditLoss),
      nonaccrualLoans: pick(r, TAGS.nonaccrualLoans),
    });
    if (recs.length >= 6) break;
  }
  return recs.filter((r) => isFiniteNum(r.revenue as number) || isFiniteNum(r.netIncome as number));
}
