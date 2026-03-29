'use strict';

/**
 * ERPNext REST API client for PropMS (Property Management System).
 *
 * PropMS DocType map (confirmed against live lutra.k.frappe.cloud):
 *   Property         – each rentable unit / property (status: Available | On Lease | ...)
 *   Lease            – lease agreement
 *                      key fields: property, lease_customer, lease_status,
 *                                  start_date, end_date, frequency, notice_period
 *                      lease_status values: Draft | Active | Closed | Vacating |
 *                                           Not Materialized | Renewal to Previous Lease
 *   Customer         – tenant contacts (customer_group = "Tenant")
 *   Sales Invoice    – rent charges / outstanding balances
 *                      custom fields: custom_unit, custom_property, custom_lease
 *   Payment Entry    – recorded payments
 *                      custom fields: custom_unit, custom_lease
 *   GL Entry         – general ledger rows
 *   HD Ticket        – maintenance / work orders (Helpdesk module)
 *                      Status (Link): Open | Replied | Resolved | Closed
 *                      Priority (Link): Urgent | High | Medium | Low
 *
 * Auth: "token {apiKey}:{apiSecret}" via Authorization header.
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

// Honour system proxy env-vars (HTTPS_PROXY / https_proxy) so Node.js
// requests go through the same egress gateway that curl uses.
function buildHttpsAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (_) {
    return undefined;
  }
}

class ERPNextClient {
  constructor({ baseUrl, apiKey, apiSecret } = {}) {
    const base = (baseUrl || config.pms.erpnext.baseUrl).replace(/\/$/, '');
    const key = apiKey || config.pms.erpnext.apiKey;
    const secret = apiSecret || config.pms.erpnext.apiSecret;

    this.http = axios.create({
      baseURL: base,
      headers: {
        Authorization: `token ${key}:${secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20_000,
      httpsAgent: buildHttpsAgent(),
      proxy: false,  // disable axios's built-in proxy so the agent handles it
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const detail =
          err.response?.data?.exception ||
          err.response?.data?.message ||
          err.message;
        logger.error('ERPNext API error', { status, detail, url: err.config?.url });
        return Promise.reject(err);
      }
    );
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  _resourcePath(doctype, name) {
    const dt = encodeURIComponent(doctype);
    return name
      ? `/api/resource/${dt}/${encodeURIComponent(name)}`
      : `/api/resource/${dt}`;
  }

  async _list(doctype, { fields = ['*'], filters = [], limit = 500, orderBy } = {}) {
    const params = {
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_page_length: limit,
    };
    if (orderBy) params.order_by = orderBy;

    const { data } = await this.http.get(this._resourcePath(doctype), { params });
    return data.data || [];
  }

  async _get(doctype, name) {
    const { data } = await this.http.get(this._resourcePath(doctype, name));
    return data.data;
  }

  async _put(doctype, name, payload) {
    const { data } = await this.http.put(this._resourcePath(doctype, name), payload);
    return data.data;
  }

  async _post(doctype, payload) {
    const { data } = await this.http.post(this._resourcePath(doctype), payload);
    return data.data;
  }

  // ─── Properties ───────────────────────────────────────────────────────────
  // In PropMS each Property record IS the rentable unit.

  /** List all properties (units) in the portfolio. */
  async getProperties() {
    return this._list('Property', {
      fields: ['name', 'name1', 'status', 'rent', 'bedroom', 'company', 'cost_center'],
      orderBy: 'name1 asc',
    });
  }

  /** Get a single Property by its ERPNext name. */
  async getProperty(name) {
    return this._get('Property', name);
  }

  /**
   * List properties/units, optionally under a parent property.
   * @param {Object} [params]
   * @param {string} [params.propertyId]  – parent_property filter
   */
  async getUnits({ propertyId } = {}) {
    const filters = propertyId ? [['parent_property', '=', propertyId]] : [];
    return this._list('Property', {
      fields: ['name', 'name1', 'status', 'rent', 'bedroom'],
      filters,
      orderBy: 'name1 asc',
    });
  }

  /** Return all properties with status "Available" (vacant). */
  async getVacantUnits() {
    return this._list('Property', {
      fields: ['name', 'name1', 'status', 'rent', 'bedroom'],
      filters: [['status', '=', 'Available']],
      orderBy: 'name1 asc',
    });
  }

  /** Get a single property by name – alias for getProperty. */
  async getUnit(name) {
    return this._get('Property', name);
  }

  // ─── Leases ───────────────────────────────────────────────────────────────

  /**
   * List Leases with optional client-side filtering.
   * @param {Object} [params]
   * @param {string} [params.status]  – "active"|"expired"|"future"|"all"
   * @param {string} [params.unit]    – partial property name match
   */
  async getLeases({ status, unit } = {}) {
    // Frappe v15 restricts fields in list-query filters on Lease → filter client-side.
    const leases = await this._list('Lease', {
      fields: ['*'],
      orderBy: 'start_date desc',
    });

    const statusMap = { active: 'Active', expired: 'Closed', future: 'Draft' };
    const wantedStatus = statusMap[status] || status;

    return leases.filter(l => {
      if (status && status !== 'all' && l.lease_status !== wantedStatus) return false;
      if (unit) {
        const prop = (l.property || '').toLowerCase();
        if (!prop.includes(unit.toLowerCase())) return false;
      }
      return true;
    });
  }

  /** Get a single Lease by name. */
  async getLease(name) {
    return this._get('Lease', name);
  }

  /**
   * Return Active leases whose end_date falls within `daysAhead` days from today.
   * @param {number} [daysAhead=90]
   */
  async getExpiringLeases(daysAhead = 90) {
    const leases = await this._list('Lease', {
      fields: ['*'],
      orderBy: 'end_date asc',
    });

    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today.getTime() + daysAhead * 86_400_000);

    return leases.filter(l => {
      if (l.lease_status !== 'Active') return false;
      if (!l.end_date) return false;
      const end = new Date(l.end_date);
      return end >= today && end <= horizon;
    });
  }

  /**
   * Update a Lease field (e.g. custom_renewal_notice_sent, custom_renewal_action).
   * @param {string} name    – Lease document name
   * @param {Object} payload – fields to update
   */
  async updateLease(name, payload) {
    return this._put('Lease', name, payload);
  }

  /**
   * Return file attachments on a Lease record (signed PDFs, addenda, etc.).
   * @param {string} leaseName – ERPNext Lease document name
   */
  async getLeaseFiles(leaseName) {
    return this._list('File', {
      fields: ['name', 'file_name', 'file_url', 'creation'],
      filters: [
        ['attached_to_doctype', '=', 'Lease'],
        ['attached_to_name',    '=', leaseName],
      ],
      orderBy: 'creation desc',
    });
  }

  // ─── Vendors (Supplier doctype) ────────────────────────────────────────────

  /**
   * List vendors (Suppliers), optionally filtered by trade.
   * @param {Object} [params]
   * @param {string} [params.trade]  – e.g. "Plumbing", "Electrical"
   */
  async getVendors({ trade } = {}) {
    const all = await this._list('Supplier', {
      fields: ['name', 'supplier_name', 'custom_trade', 'custom_rating', 'custom_sms_number', 'custom_license_number'],
      orderBy: 'supplier_name asc',
    });

    return all.filter(v => {
      if (trade && (v.custom_trade || '').toLowerCase() !== trade.toLowerCase()) return false;
      return true;
    });
  }

  /** Get a single Supplier (vendor) by ERPNext name. */
  async getVendor(name) {
    return this._get('Supplier', name);
  }

  /**
   * Assign a vendor to an HD Ticket maintenance work order.
   * @param {string} ticketName  – HD Ticket document name
   * @param {string} vendorName  – Supplier document name
   */
  async assignVendor(ticketName, vendorName) {
    return this._put('HD Ticket', ticketName, { custom_assigned_vendor: vendorName });
  }

  // ─── Leads (rental applicants) ────────────────────────────────────────────

  /**
   * List Leads that came from the rental application form.
   * @param {Object} [params]
   * @param {string} [params.status]  – Lead status (e.g. "New Application")
   */
  async getCRMLeads({ status } = {}) {
    const filters = [['lead_source', '=', 'Online Application']];
    if (status) filters.push(['status', '=', status]);

    return this._list('Lead', {
      fields: ['name', 'first_name', 'last_name', 'email_id', 'mobile_no', 'status', 'creation'],
      filters,
      orderBy: 'creation desc',
    });
  }

  /** Get a single Lead by name. */
  async getCRMLead(name) {
    return this._get('Lead', name);
  }

  /**
   * Update a Lead (e.g. change status after screening).
   * @param {string} name
   * @param {Object} payload
   */
  async updateCRMLead(name, payload) {
    return this._put('Lead', name, payload);
  }

  // ─── Late Fee Invoices ─────────────────────────────────────────────────────

  /**
   * Check whether a late fee invoice has already been created for the given
   * original rent invoice on the given calendar date (daily dedup guard).
   *
   * @param {string} originalInvoiceName  – e.g. "ACC-SINV-2026-00009"
   * @param {string} date                 – YYYY-MM-DD (today)
   * @returns {Promise<boolean>}          – true if a late fee invoice already exists
   */
  async getTodayLateFeeForInvoice(originalInvoiceName, date) {
    const results = await this._list('Sales Invoice', {
      fields: ['name'],
      filters: [
        ['custom_is_late_fee',       '=', 1],
        ['custom_original_invoice',  '=', originalInvoiceName],
        ['custom_late_fee_date',     '=', date],
      ],
    });
    return results.length > 0;
  }

  /**
   * Check whether ANY late fee invoice has ever been created for the given
   * original rent invoice (used to decide if this is the "first day" for SMS).
   *
   * @param {string} originalInvoiceName
   * @returns {Promise<boolean>}
   */
  async hasAnyLateFeeForInvoice(originalInvoiceName) {
    const results = await this._list('Sales Invoice', {
      fields: ['name'],
      filters: [
        ['custom_is_late_fee',      '=', 1],
        ['custom_original_invoice', '=', originalInvoiceName],
      ],
    });
    return results.length > 0;
  }

  /**
   * Create a late fee Sales Invoice against a tenant.
   *
   * @param {Object} p
   * @param {string} p.customer             – ERPNext Customer name
   * @param {string} p.company              – ERPNext Company name
   * @param {number} p.feeAmount            – Dollar amount of the late fee
   * @param {string} p.today                – YYYY-MM-DD
   * @param {string} p.originalInvoiceName  – Rent invoice this fee belongs to
   * @param {string} [p.customUnit]         – Propagated from the rent invoice
   * @param {string} [p.customProperty]     – Propagated from the rent invoice
   * @param {string} [p.customLease]        – Propagated from the rent invoice
   * @param {boolean} [p.autoSubmit]        – If true, docstatus=1 (submitted); else draft
   * @returns {Promise<{ name: string, submitted: boolean }>}
   */
  async createLateFeeInvoice({
    customer, company, feeAmount, today,
    originalInvoiceName, customUnit, customProperty, customLease,
    autoSubmit = false,
  }) {
    const payload = {
      customer,
      company,
      posting_date:            today,
      due_date:                today,
      items: [{
        item_code: 'Late Fee',
        qty:       1,
        rate:      feeAmount,
      }],
      custom_is_late_fee:       1,
      custom_original_invoice:  originalInvoiceName,
      custom_late_fee_date:     today,
      ...(customUnit     ? { custom_unit:     customUnit }     : {}),
      ...(customProperty ? { custom_property: customProperty } : {}),
      ...(customLease    ? { custom_lease:    customLease }    : {}),
      docstatus: autoSubmit ? 1 : 0,
    };

    const { data } = await this.http.post(
      '/api/resource/Sales%20Invoice',
      payload
    );

    return { name: data.data.name, submitted: autoSubmit };
  }

  // ─── Tenants ──────────────────────────────────────────────────────────────

  /**
   * List Customers in the "Tenant" customer group.
   * @param {Object} [params]
   * @param {string} [params.name]  – partial customer_name match
   * @param {string} [params.unit]  – filter by custom_unit
   */
  async getTenants({ name, unit } = {}) {
    // Frappe v15 rejects custom and restricted fields in list-query filters/fields.
    // Fetch all customers with wildcard fields and filter client-side.
    const all = await this._list('Customer', {
      fields: ['*'],
      orderBy: 'customer_name asc',
    });

    return all.filter(t => {
      if ((t.customer_group || '').toLowerCase() !== 'tenant') return false;
      if (name && !t.customer_name.toLowerCase().includes(name.toLowerCase())) return false;
      if (unit && !(t.custom_unit || '').toLowerCase().includes(unit.toLowerCase())) return false;
      return true;
    });
  }

  /** Get a single Customer (tenant) by ERPNext name. */
  async getTenant(name) {
    return this._get('Customer', name);
  }

  // ─── Financials ───────────────────────────────────────────────────────────

  /**
   * Return submitted Sales Invoices with outstanding balance past due.
   * @param {Object} [params]
   * @param {string} [params.propertyId]  – filter by custom_property
   */
  async getOutstandingBalances({ propertyId } = {}) {
    const today = new Date().toISOString().split('T')[0];
    const filters = [
      ['docstatus', '=', 1],
      ['outstanding_amount', '>', 0],
      ['due_date', '<', today],
    ];
    if (propertyId) filters.push(['custom_property', '=', propertyId]);

    return this._list('Sales Invoice', {
      fields: [
        'name', 'customer', 'customer_name', 'company',
        'grand_total', 'outstanding_amount', 'due_date',
        'custom_unit', 'custom_property', 'custom_lease',
      ],
      filters,
      orderBy: 'due_date asc',
    });
  }

  /** Get all submitted Sales Invoices for a specific Lease. */
  async getLeaseLedger(leaseId) {
    return this._list('Sales Invoice', {
      fields: ['name', 'posting_date', 'grand_total', 'outstanding_amount', 'status'],
      filters: [
        ['custom_lease', '=', leaseId],
        ['docstatus', '=', 1],
      ],
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Retrieve GL Entry rows for a date range.
   * @param {Object} [params]
   * @param {string} [params.startDate]  – YYYY-MM-DD
   * @param {string} [params.endDate]    – YYYY-MM-DD
   */
  async getGeneralLedger({ startDate, endDate } = {}) {
    const filters = [];
    if (startDate) filters.push(['posting_date', '>=', startDate]);
    if (endDate) filters.push(['posting_date', '<=', endDate]);

    return this._list('GL Entry', {
      fields: [
        'name', 'posting_date', 'account',
        'debit', 'credit', 'voucher_type', 'voucher_no', 'remarks',
      ],
      filters,
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Retrieve submitted Payment Entries for a date range.
   * @param {Object} [params]
   * @param {string} [params.startDate]  – YYYY-MM-DD
   * @param {string} [params.endDate]    – YYYY-MM-DD
   */
  async getPayments({ startDate, endDate } = {}) {
    const filters = [['docstatus', '=', 1]];
    if (startDate) filters.push(['posting_date', '>=', startDate]);
    if (endDate) filters.push(['posting_date', '<=', endDate]);

    return this._list('Payment Entry', {
      fields: [
        'name', 'posting_date', 'party', 'party_name',
        'paid_amount', 'payment_type', 'mode_of_payment',
        'custom_unit', 'custom_lease',
      ],
      filters,
      orderBy: 'posting_date desc',
    });
  }

  // ─── Maintenance / Work Orders (HD Ticket) ────────────────────────────────

  /**
   * List maintenance tickets.
   * @param {Object} [params]
   * @param {string} [params.status]     – "open"|"in_progress"|"completed"|"all"
   * @param {string} [params.propertyId] – filter by customer field (property/tenant)
   * @param {string} [params.unitId]     – partial subject match
   */
  async getWorkOrders({ status, propertyId, unitId } = {}) {
    // Frappe v15 rejects status/customer/subject as filter fields on HD Ticket.
    // Fetch all tickets and filter client-side.
    const all = await this._list('HD Ticket', {
      fields: [
        'name', 'subject', 'status', 'priority',
        'customer', 'raised_by',
        'description', 'creation', 'modified',
      ],
      orderBy: 'creation desc',
    });

    const statusMap = { open: 'Open', in_progress: 'Replied', completed: 'Resolved' };
    const wantedStatus = statusMap[status] || status;

    return all.filter(t => {
      if (status && status !== 'all' && t.status !== wantedStatus) return false;
      if (propertyId && t.customer !== propertyId) return false;
      if (unitId && !(t.subject || '').toLowerCase().includes(unitId.toLowerCase())) return false;
      return true;
    });
  }

  /** Get a single HD Ticket by name. */
  async getWorkOrder(name) {
    return this._get('HD Ticket', name);
  }

  /**
   * Return open/in-progress tickets older than `ageHours` hours.
   * @param {number} [ageHours=48]
   */
  async getStaleWorkOrders(ageHours = 48) {
    const cutoffMs = Date.now() - ageHours * 60 * 60 * 1000;

    // Frappe v15 rejects status/creation as filter fields on HD Ticket.
    // Fetch all tickets and filter client-side by age and open status.
    const all = await this._list('HD Ticket', {
      fields: [
        'name', 'subject', 'status', 'priority',
        'customer', 'raised_by',
        'description', 'creation',
      ],
      orderBy: 'creation asc',
    });

    return all.filter(t => {
      if (!['Open', 'Replied'].includes(t.status)) return false;
      const createdMs = new Date(t.creation).getTime();
      return createdMs < cutoffMs;
    });
  }

  /**
   * Update an HD Ticket.
   * @param {string} name
   * @param {Object} payload
   */
  async updateWorkOrder(name, payload) {
    return this._put('HD Ticket', name, payload);
  }

  // ─── Tenant portal data ───────────────────────────────────────────────────
  // Scoped queries used by the tenant self-service portal.
  // ERPNext's portal layer enforces customer-level visibility automatically;
  // these methods are used by the Node.js side for Telegram / reporting.

  /**
   * Return submitted Sales Invoices for a specific Customer (tenant).
   * @param {string} customerId  – ERPNext Customer name
   * @param {Object} [params]
   * @param {string} [params.status]  – "unpaid" | "paid" | omit for all
   */
  async getTenantInvoices(customerId, { status } = {}) {
    const filters = [
      ['customer', '=', customerId],
      ['docstatus', '=', 1],
    ];
    if (status === 'unpaid') filters.push(['outstanding_amount', '>', 0]);
    if (status === 'paid')   filters.push(['outstanding_amount', '=', 0]);

    return this._list('Sales Invoice', {
      fields: [
        'name', 'posting_date', 'due_date',
        'grand_total', 'outstanding_amount', 'status',
        'custom_unit', 'custom_lease',
      ],
      filters,
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Return submitted Payment Entries for a specific Customer (tenant).
   * @param {string} customerId  – ERPNext Customer name
   */
  async getTenantPayments(customerId) {
    return this._list('Payment Entry', {
      fields: [
        'name', 'posting_date', 'paid_amount',
        'mode_of_payment', 'custom_unit', 'custom_lease',
      ],
      filters: [
        ['party_type', '=', 'Customer'],
        ['party', '=', customerId],
        ['docstatus', '=', 1],
      ],
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Return HD Tickets raised by or linked to a specific Customer.
   * Frappe v15 rejects 'customer' as a server-side filter on HD Ticket,
   * so we fetch all and filter client-side.
   * @param {string} customerId  – ERPNext Customer name
   */
  async getTenantTickets(customerId) {
    const all = await this._list('HD Ticket', {
      fields: [
        'name', 'subject', 'status', 'priority',
        'customer', 'raised_by', 'creation', 'modified',
      ],
      orderBy: 'creation desc',
    });
    return all.filter(t => t.customer === customerId);
  }

  /**
   * Create a tenant maintenance ticket linked to the tenant's customer record.
   * @param {string} customerId
   * @param {Object} payload
   * @param {string} payload.subject
   * @param {string} [payload.description]
   * @param {string} [payload.priority]
   * @param {string} [payload.raisedBy]
   */
  async createTenantTicket(customerId, { subject, description, priority, raisedBy } = {}) {
    const cleanSubject = String(subject || '').trim();
    if (!cleanSubject) throw new Error('subject is required');

    const cleanPriority = String(priority || 'Medium').trim() || 'Medium';
    const cleanDescription = String(description || '').trim();

    return this._post('HD Ticket', {
      customer: customerId,
      subject: cleanSubject,
      description: cleanDescription,
      priority: cleanPriority,
      ...(raisedBy ? { raised_by: String(raisedBy).trim() } : {}),
    });
  }
}

module.exports = ERPNextClient;
