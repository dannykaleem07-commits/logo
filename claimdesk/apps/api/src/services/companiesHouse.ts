/**
 * Companies House public data API client (documented API, key in COMPANIES_HOUSE_API_KEY). Used by the watch poll
 * (lesson k: CARFLEX LTD in strike-off). Without a key nothing is called and the watch row is marked unverified.
 */
import type { CompanyWatch, ISODate } from '@ccguk/domain';

export const COMPANIES_HOUSE_BASE = 'https://api.company-information.service.gov.uk';

export interface CompanyProfile {
  companyNumber: string;
  companyName?: string;
  status?: string;
  statusDetail?: string;
  accountsOverdue?: boolean;
  confirmationStatementOverdue?: boolean;
  dateOfCreation?: ISODate;
  dateOfCessation?: ISODate;
  hasInsolvencyHistory?: boolean;
  raw: unknown;
}

export interface GazetteNotice {
  date: ISODate;
  type: string;
  note: string;
}

export interface CompaniesHouseClient {
  profile(companyNumber: string): Promise<CompanyProfile>;
  gazetteFilings(companyNumber: string): Promise<GazetteNotice[]>;
}

export interface ClientOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

async function getJson(url: string, apiKey: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, Accept: 'application/json' }, signal: controller.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Companies House ${res.status} for ${url}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export function createCompaniesHouseClient(opts: ClientOptions): CompaniesHouseClient {
  const base = opts.baseUrl ?? COMPANIES_HOUSE_BASE;
  const timeout = opts.timeoutMs ?? 10_000;
  const f = opts.fetchImpl ?? fetch;
  return {
    async profile(companyNumber) {
      const raw = (await getJson(`${base}/company/${encodeURIComponent(companyNumber)}`, opts.apiKey, timeout, f)) as Record<string, unknown> | undefined;
      if (!raw) throw new Error(`Company ${companyNumber} not found at Companies House`);
      const accounts = raw.accounts as { overdue?: boolean } | undefined;
      const cs = raw.confirmation_statement as { overdue?: boolean } | undefined;
      return {
        companyNumber: String(raw.company_number ?? companyNumber),
        companyName: typeof raw.company_name === 'string' ? raw.company_name : undefined,
        status: typeof raw.company_status === 'string' ? raw.company_status : undefined,
        statusDetail: typeof raw.company_status_detail === 'string' ? raw.company_status_detail : undefined,
        accountsOverdue: accounts?.overdue,
        confirmationStatementOverdue: cs?.overdue,
        dateOfCreation: typeof raw.date_of_creation === 'string' ? raw.date_of_creation : undefined,
        dateOfCessation: typeof raw.date_of_cessation === 'string' ? raw.date_of_cessation : undefined,
        hasInsolvencyHistory: raw.has_insolvency_history === true,
        raw,
      };
    },
    async gazetteFilings(companyNumber) {
      const raw = (await getJson(`${base}/company/${encodeURIComponent(companyNumber)}/filing-history?category=gazette&items_per_page=50`, opts.apiKey, timeout, f)) as { items?: Array<Record<string, unknown>> } | undefined;
      return (raw?.items ?? []).map((i) => ({
        date: typeof i.date === 'string' ? i.date : '',
        type: typeof i.type === 'string' ? i.type : 'gazette',
        note: typeof i.description === 'string' ? i.description : String(i.category ?? 'gazette notice'),
      })).filter((n) => n.date);
    },
  };
}

export interface RiskAssessment {
  riskLevel: CompanyWatch['riskLevel'];
  riskReasons: string[];
}

const HIGH_STATUS = /dissolved|liquidation|administration|receivership|insolvency|strike|struck|voluntary-arrangement|converted-closed/i;

/** dissolved / liquidation / strike-off / gazette notice / overdue accounts → high; CS overdue → medium. */
export function assessCompanyRisk(input: { status?: string; statusDetail?: string; accountsOverdue?: boolean; confirmationStatementOverdue?: boolean; gazetteNotices: GazetteNotice[]; hasInsolvencyHistory?: boolean; verified: boolean }): RiskAssessment {
  const reasons: string[] = [];
  let level: CompanyWatch['riskLevel'] = 'low';
  const bump = (to: CompanyWatch['riskLevel']) => {
    const order = { low: 0, medium: 1, high: 2 };
    if (order[to] > order[level]) level = to;
  };
  if (input.status && HIGH_STATUS.test(`${input.status} ${input.statusDetail ?? ''}`)) {
    reasons.push(`Companies House status: ${input.status}${input.statusDetail ? ` (${input.statusDetail})` : ''}`);
    bump('high');
  }
  if (input.accountsOverdue) {
    reasons.push('Accounts overdue');
    bump('high');
  }
  if (input.gazetteNotices.length) {
    reasons.push(`${input.gazetteNotices.length} Gazette notice(s): ${input.gazetteNotices.slice(0, 3).map((g) => `${g.date} ${g.note}`).join('; ')}`);
    bump('high');
  }
  if (input.confirmationStatementOverdue) {
    reasons.push('Confirmation statement overdue');
    bump('medium');
  }
  if (input.hasInsolvencyHistory) {
    reasons.push('Insolvency history on the register');
    bump('medium');
  }
  if (!input.verified) reasons.push('Not polled against Companies House (no API key) — status unverified');
  return { riskLevel: level, riskReasons: reasons };
}
