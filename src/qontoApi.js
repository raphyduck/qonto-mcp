// Qonto Business API client — multi-organization, read-only.
// Auth: header "Authorization: <login>:<secret-key>" per organization.
// Docs: https://docs.qonto.com

const BASE_URL = process.env.QONTO_BASE_URL || 'https://thirdparty.qonto.com/v2';

const log = (...args) => console.error('[qonto-api]', ...args);

// Organizations are declared in QONTO_ORGS (JSON array):
// [{"key":"noc","label":"Nicolle Objectif Capital","login":"...","secret":"..."}]
let ORGS = null;

export function loadOrgs() {
  if (ORGS) return ORGS;
  const raw = process.env.QONTO_ORGS;
  if (!raw) throw new Error('QONTO_ORGS is not set in the environment');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`QONTO_ORGS is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QONTO_ORGS must be a non-empty JSON array');
  }
  ORGS = new Map();
  for (const o of parsed) {
    if (!o.key || !o.login || !o.secret) {
      throw new Error('Each QONTO_ORGS entry needs key, login and secret');
    }
    ORGS.set(o.key, { key: o.key, label: o.label || o.key, login: o.login, secret: o.secret });
  }
  return ORGS;
}

export function getOrg(key) {
  const orgs = loadOrgs();
  const org = orgs.get(key);
  if (!org) {
    const known = [...orgs.keys()].join(', ');
    throw new Error(`Unknown organization "${key}". Configured organizations: ${known}`);
  }
  return org;
}

export function listOrgKeys() {
  return [...loadOrgs().values()].map(({ key, label }) => ({ key, label }));
}

async function request(org, path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `${org.login}:${org.secret}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Qonto API ${res.status} on ${path} (org=${org.key}): ${body.slice(0, 500)}`);
  }
  return res.json();
}

// ---------- Endpoints (read-only) ----------

export async function getOrganization(orgKey) {
  const org = getOrg(orgKey);
  const data = await request(org, '/organization');
  return data.organization;
}

export async function listTransactions(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const {
    bank_account_id,
    iban,
    status,
    side,
    settled_at_from,
    settled_at_to,
    sort_by = 'settled_at:desc',
    page = 1,
    per_page = 25,
  } = opts;

  const baseParams = {
    status,
    side,
    'settled_at_from': settled_at_from,
    'settled_at_to': settled_at_to,
    sort_by,
    current_page: page,
    per_page,
  };

  // Qonto requires targeting one bank account per call.
  // If none specified, aggregate first page across all accounts of the org.
  if (bank_account_id || iban) {
    const data = await request(org, '/transactions', {
      ...baseParams,
      bank_account_id,
      iban,
    });
    return { transactions: data.transactions, meta: data.meta };
  }

  const organization = await getOrganization(orgKey);
  const accounts = organization.bank_accounts || [];
  const results = [];
  for (const account of accounts) {
    const data = await request(org, '/transactions', {
      ...baseParams,
      bank_account_id: account.id,
    });
    for (const t of data.transactions) {
      results.push({ ...t, _bank_account_name: account.name, _bank_account_iban: account.iban });
    }
  }
  results.sort((a, b) => new Date(b.settled_at || b.emitted_at) - new Date(a.settled_at || a.emitted_at));
  return {
    transactions: results.slice(0, per_page),
    meta: { aggregated_accounts: accounts.length, note: 'first page of each account merged; pass bank_account_id for full pagination' },
  };
}

export async function getTransaction(orgKey, id, includes = []) {
  const org = getOrg(orgKey);
  const data = await request(org, `/transactions/${id}`, includes.length ? { includes } : {});
  return data.transaction;
}

export async function listLabels(orgKey, page = 1) {
  const org = getOrg(orgKey);
  return request(org, '/labels', { current_page: page });
}

export async function listMemberships(orgKey, page = 1) {
  const org = getOrg(orgKey);
  return request(org, '/memberships', { current_page: page });
}

export async function getAttachment(orgKey, id) {
  const org = getOrg(orgKey);
  const data = await request(org, `/attachments/${id}`);
  return data.attachment;
}

export async function listClientInvoices(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const { status, page = 1, per_page = 25 } = opts;
  return request(org, '/client_invoices', { 'filter[status]': status, 'page[number]': page, 'page[size]': per_page });
}

export async function listSupplierInvoices(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const { status, page = 1, per_page = 25 } = opts;
  return request(org, '/supplier_invoices', { 'filter[status]': status, 'page[number]': page, 'page[size]': per_page });
}

export async function listStatements(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const { bank_account_id, page = 1, per_page = 25 } = opts;
  return request(org, '/statements', { 'bank_account_ids[]': bank_account_id, 'page[number]': page, 'page[size]': per_page });
}

export async function consolidatedBalances() {
  const orgs = listOrgKeys();
  const out = [];
  for (const { key, label } of orgs) {
    try {
      const organization = await getOrganization(key);
      const accounts = (organization.bank_accounts || []).map((a) => ({
        name: a.name,
        iban: a.iban,
        currency: a.currency,
        balance: a.balance,
        authorized_balance: a.authorized_balance,
        status: a.status,
      }));
      const total = accounts.reduce((s, a) => s + (a.balance || 0), 0);
      out.push({ key, label, legal_name: organization.legal_name, total_balance: total, accounts });
    } catch (e) {
      out.push({ key, label, error: e.message });
    }
  }
  return out;
}
