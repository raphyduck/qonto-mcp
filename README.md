# qonto-mcp

Multi-organization MCP server (stdio) for the Qonto Business API. **Read-only.**

- One Qonto API key pair (login/secret) per organization, declared in `.env` → `QONTO_ORGS` (JSON array).
- Every tool takes an `organization` parameter (the `key` field of the entry).
- `qonto_consolidated_balances` aggregates balances across all organizations in one call.

Deployed on hobbitton.at behind the shared `mcp-oauth-proxy` (see `~/docker_images/qontomcp/compose.yml`),
exposed at `https://qontomcp.hobbitton.at` via Caddy (mcp_edge) + Nginx wildcard.

Tools: list_organizations, get_organization, consolidated_balances, list_transactions,
get_transaction, get_attachment, list_client_invoices, list_supplier_invoices,
list_statements, list_labels, list_memberships.
