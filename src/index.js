// Qonto MCP server (stdio) — multi-organization, read-only.
// stdout is reserved for the MCP protocol — every log goes to stderr.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as qonto from './qontoApi.js';

const log = (...args) => console.error('[mcp]', ...args);

function ok(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  log('tool error:', err?.message || err);
  return {
    content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'qonto-mcp',
  version: '1.0.0',
});

const orgParam = z
  .string()
  .describe('Organization key as configured (see qonto_list_organizations)');

// ---------- Organizations & balances ----------

server.tool(
  'qonto_list_organizations',
  'List the configured Qonto organizations (companies) and their keys',
  {},
  async () => {
    try {
      return ok(qonto.listOrgKeys());
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_get_organization',
  'Get organization details incl. its bank accounts, IBANs and balances',
  { organization: orgParam },
  async ({ organization }) => {
    try {
      return ok(await qonto.getOrganization(organization));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_consolidated_balances',
  'Aggregated view: balances of every bank account across ALL configured organizations',
  {},
  async () => {
    try {
      return ok(await qonto.consolidatedBalances());
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- Transactions ----------

server.tool(
  'qonto_list_transactions',
  'List transactions of an organization. Without bank_account_id, merges the latest transactions of all its accounts.',
  {
    organization: orgParam,
    bank_account_id: z.string().optional().describe('Target one bank account (full pagination)'),
    status: z.enum(['pending', 'completed', 'declined']).optional(),
    side: z.enum(['credit', 'debit']).optional(),
    settled_at_from: z.string().optional().describe('ISO 8601 date, e.g. 2026-01-01'),
    settled_at_to: z.string().optional().describe('ISO 8601 date'),
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async ({ organization, ...opts }) => {
    try {
      return ok(await qonto.listTransactions(organization, opts));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_get_transaction',
  'Get one transaction by ID, optionally with attachments, labels and VAT details',
  {
    organization: orgParam,
    transaction_id: z.string(),
    include_details: z.boolean().optional().describe('Include attachments, labels and vat_details'),
  },
  async ({ organization, transaction_id, include_details }) => {
    try {
      const includes = include_details ? ['attachments', 'labels', 'vat_details'] : [];
      return ok(await qonto.getTransaction(organization, transaction_id, includes));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_get_attachment',
  'Get an attachment (receipt/invoice file) by ID — returns metadata and a temporary download URL',
  { organization: orgParam, attachment_id: z.string() },
  async ({ organization, attachment_id }) => {
    try {
      return ok(await qonto.getAttachment(organization, attachment_id));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- Invoices ----------

server.tool(
  'qonto_list_client_invoices',
  'List client (outgoing) invoices of an organization',
  {
    organization: orgParam,
    status: z.enum(['draft', 'unpaid', 'paid', 'canceled']).optional(),
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async ({ organization, ...opts }) => {
    try {
      return ok(await qonto.listClientInvoices(organization, opts));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_list_supplier_invoices',
  'List supplier (incoming) invoices of an organization',
  {
    organization: orgParam,
    status: z.enum(['to_review', 'pending', 'scheduled', 'paid']).optional(),
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async ({ organization, ...opts }) => {
    try {
      return ok(await qonto.listSupplierInvoices(organization, opts));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- Misc ----------

server.tool(
  'qonto_list_statements',
  'List monthly account statements (PDF) of an organization',
  {
    organization: orgParam,
    bank_account_id: z.string().optional(),
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async ({ organization, ...opts }) => {
    try {
      return ok(await qonto.listStatements(organization, opts));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_list_labels',
  'List analytic labels of an organization',
  { organization: orgParam, page: z.number().int().min(1).optional() },
  async ({ organization, page }) => {
    try {
      return ok(await qonto.listLabels(organization, page));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_list_memberships',
  'List members (users) of an organization',
  { organization: orgParam, page: z.number().int().min(1).optional() },
  async ({ organization, page }) => {
    try {
      return ok(await qonto.listMemberships(organization, page));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- Write: attachments ----------

server.tool(
  'qonto_upload_attachment',
  'Upload a receipt/justificatif (PDF, JPEG or PNG) and attach it to a transaction. The file is passed base64-encoded. This is a WRITE operation.',
  {
    organization: orgParam,
    transaction_id: z.string().describe('The Qonto transaction UUID to attach the file to'),
    file_base64: z.string().describe('The file content, base64-encoded (PDF, JPEG or PNG)'),
    file_name: z.string().describe('File name with extension, e.g. "receipt.pdf" — used to infer the MIME type'),
    content_type: z
      .enum(['application/pdf', 'image/jpeg', 'image/png'])
      .optional()
      .describe('Override the MIME type when the file name has no clear extension'),
    idempotency_key: z
      .string()
      .optional()
      .describe('Optional; auto-generated if omitted. Reuse the same value to safely retry without duplicating the attachment.'),
  },
  async ({ organization, transaction_id, file_base64, file_name, content_type, idempotency_key }) => {
    try {
      return ok(
        await qonto.uploadAttachmentToTransaction(organization, transaction_id, {
          fileBase64: file_base64,
          fileName: file_name,
          contentType: content_type,
          idempotencyKey: idempotency_key,
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'qonto_upload_attachment_from_file',
  'Attach a receipt/justificatif to a transaction by reading it from a file already written on the shared bridge volume (default /srv/filemcp), instead of passing base64 inline. RELIABLE for any size: the bytes are read server-side and never transit the model, so large PDFs are not truncated. Typical flow: imap_download_attachment with savePath=/srv/filemcp/qonto-inbox/<name>.pdf, then call this tool with the same path. Returns size_bytes and sha256 for verification. Set dry_run=true to validate the file without uploading. WRITE operation.',
  {
    organization: orgParam,
    transaction_id: z.string().describe('The Qonto transaction UUID to attach the file to'),
    file_path: z.string().describe('Absolute path of the PDF/JPEG/PNG under the shared volume (e.g. /srv/filemcp/qonto-inbox/2026-07-31_legalplace.pdf)'),
    file_name: z.string().optional().describe('Override the stored file name; defaults to the basename of file_path'),
    content_type: z
      .enum(['application/pdf', 'image/jpeg', 'image/png'])
      .optional()
      .describe('Override the MIME type when the file name has no clear extension'),
    idempotency_key: z
      .string()
      .optional()
      .describe('Optional; auto-generated if omitted. Reuse the same value to safely retry without duplicating the attachment.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('If true, read and validate the file server-side (returns size_bytes + sha256) but do NOT upload to Qonto.'),
  },
  async ({ organization, transaction_id, file_path, file_name, content_type, idempotency_key, dry_run }) => {
    try {
      return ok(
        await qonto.uploadAttachmentFromPath(organization, transaction_id, {
          filePath: file_path,
          fileName: file_name,
          contentType: content_type,
          idempotencyKey: idempotency_key,
          dryRun: dry_run,
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- Startup ----------

async function main() {
  // Fail fast on bad config, with a clear stderr message.
  try {
    const orgs = qonto.listOrgKeys();
    log(`configured organizations: ${orgs.map((o) => o.key).join(', ')}`);
  } catch (e) {
    log('CONFIG ERROR:', e.message);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('qonto-mcp connected on stdio');
}

main().catch((e) => {
  log('fatal:', e);
  process.exit(1);
});
