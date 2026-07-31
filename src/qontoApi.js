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
  return request(org, '/client_invoices', { 'filter[status]': status, current_page: page, per_page });
}

export async function listSupplierInvoices(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const { status, page = 1, per_page = 25 } = opts;
  return request(org, '/supplier_invoices', { 'filter[status]': status, current_page: page, per_page });
}

export async function listStatements(orgKey, opts = {}) {
  const org = getOrg(orgKey);
  const { bank_account_id, page = 1, per_page = 25 } = opts;
  return request(org, '/statements', { 'bank_account_ids[]': bank_account_id, current_page: page, per_page });
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
        balance_cents: a.balance_cents,
        authorized_balance: a.authorized_balance,
        status: a.status,
      }));
      const totalCents = accounts.reduce((s, a) => s + (a.balance_cents || 0), 0);
      out.push({
        key,
        label,
        legal_name: organization.legal_name,
        currency: accounts[0]?.currency || 'EUR',
        total_balance: totalCents / 100,
        total_balance_cents: totalCents,
        note: 'balance is in major units (e.g. euros); balance_cents is the integer cents value',
        accounts,
      });
    } catch (e) {
      out.push({ key, label, error: e.message });
    }
  }
  return out;
}

// ---------- Write: attachments ----------

const ATTACHMENT_MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};
const ALLOWED_ATTACHMENT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function resolveAttachmentType(fileName, contentType) {
  if (contentType) return contentType;
  const ext = (String(fileName).split('.').pop() || '').toLowerCase();
  return ATTACHMENT_MIME_BY_EXT[ext] || null;
}

// Upload a receipt/justificatif and attach it to a transaction.
// POST /transactions/{id}/attachments — multipart/form-data, field "file".
// Requires the X-Qonto-Idempotency-Key header. PDF / JPEG / PNG only.
export async function uploadAttachmentToTransaction(
  orgKey,
  transactionId,
  { fileBase64, fileName, contentType, idempotencyKey } = {}
) {
  const org = getOrg(orgKey);
  if (!transactionId) throw new Error('transactionId is required');
  if (!fileBase64) throw new Error('fileBase64 (the file content, base64-encoded) is required');
  if (!fileName) throw new Error('fileName is required, e.g. "receipt.pdf"');

  const type = resolveAttachmentType(fileName, contentType);
  if (!type) {
    throw new Error(
      `Cannot determine the file type of "${fileName}". Qonto accepts PDF, JPEG or PNG only; pass contentType explicitly when the extension is missing.`
    );
  }
  if (!ALLOWED_ATTACHMENT_MIME.has(type)) {
    throw new Error(`Unsupported type "${type}". Qonto accepts application/pdf, image/jpeg or image/png only.`);
  }

  const buffer = Buffer.from(fileBase64, 'base64');
  if (!buffer.length) throw new Error('Decoded file is empty — check that fileBase64 is valid base64');

  const idem = idempotencyKey || globalThis.crypto.randomUUID();

  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), fileName);

  const url = `${BASE_URL}/transactions/${transactionId}/attachments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `${org.login}:${org.secret}`,
      Accept: 'application/json',
      'X-Qonto-Idempotency-Key': idem,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Qonto API ${res.status} on POST /transactions/${transactionId}/attachments (org=${org.key}): ${body.slice(0, 500)}`
    );
  }

  const text = await res.text().catch(() => '');
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    ok: true,
    status: res.status,
    organization: org.key,
    transaction_id: transactionId,
    file_name: fileName,
    content_type: type,
    size_bytes: buffer.length,
    idempotency_key: idem,
    note: 'The file is processed in the background; it may take a few seconds to appear. Confirm with qonto_get_transaction (include_details: true).',
    response: payload,
  };
}


// ---------- Write: attachment from a file path (no inline base64) ----------
// Reads the file server-side from the shared bridge volume and delegates to
// uploadAttachmentToTransaction. Avoids routing large base64 through the model
// layer (which silently truncated big PDFs). Confined to ATTACHMENT_FILE_ROOT.
const ATTACHMENT_FILE_ROOT = process.env.QONTO_ATTACHMENT_ROOT || '/srv/filemcp';

export async function uploadAttachmentFromPath(
  orgKey,
  transactionId,
  { filePath, fileName, contentType, idempotencyKey, dryRun = false } = {}
) {
  if (!transactionId) throw new Error('transactionId is required');
  if (!filePath) throw new Error('filePath is required (absolute path under ' + ATTACHMENT_FILE_ROOT + ')');

  const { readFileSync, realpathSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');

  let realRoot;
  try {
    realRoot = realpathSync(ATTACHMENT_FILE_ROOT);
  } catch (e) {
    throw new Error('Attachment root ' + ATTACHMENT_FILE_ROOT + ' is not accessible in this container: ' + e.message);
  }
  let real;
  try {
    real = realpathSync(filePath);
  } catch (e) {
    throw new Error('Cannot access filePath "' + filePath + '": ' + e.message);
  }
  if (real !== realRoot && !real.startsWith(realRoot + '/')) {
    throw new Error('filePath must resolve inside ' + realRoot + ' (got "' + real + '")');
  }

  const buffer = readFileSync(real);
  if (!buffer.length) throw new Error('File is empty - nothing to upload');

  const name = fileName || real.split('/').pop();
  const type = resolveAttachmentType(name, contentType);
  if (!type) {
    throw new Error('Cannot determine the file type of "' + name + '". Pass content_type explicitly (application/pdf, image/jpeg, image/png).');
  }
  if (!ALLOWED_ATTACHMENT_MIME.has(type)) {
    throw new Error('Unsupported type "' + type + '". Qonto accepts application/pdf, image/jpeg or image/png only.');
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      organization: orgKey,
      transaction_id: transactionId,
      source_path: real,
      file_name: name,
      content_type: type,
      size_bytes: buffer.length,
      sha256,
      note: 'Dry run: file read and validated server-side; nothing was uploaded to Qonto.',
    };
  }

  const result = await uploadAttachmentToTransaction(orgKey, transactionId, {
    fileBase64: buffer.toString('base64'),
    fileName: name,
    contentType: type,
    idempotencyKey,
  });

  return { ...result, source_path: real, sha256, size_bytes: buffer.length };
}
