'use strict';

/**
 * Webhook / HTTP server
 *
 * Routes:
 *   GET  /webhooks/health                          – liveness probe
 *   GET  /checkout?invoice_name=...                – Stripe Checkout Session (card + ACH)
 *   POST /webhooks/erpnext/invoice-overdue         – ERPNext webhook → rent.overdue
 *   POST /webhooks/erpnext/payment-received        – ERPNext webhook → payment.received
 *   POST /webhooks/erpnext/ticket-created          – ERPNext webhook → workorder.created
 *   POST /webhooks/erpnext/contract-submitted      – ERPNext webhook → lease.created
 *   POST /webhooks/erpnext/contract-cancelled      – ERPNext webhook → lease.expired
 *   POST /webhooks/erpnext/application-submitted   – ERPNext Web Form submit → application.submitted
 *   POST /webhooks/dropbox-sign/completed          – (removed — replaced by BoldSign)
 *   POST /webhooks/boldsign/completed              – BoldSign "all signed" event → lease.signed
 *   POST /webhooks/smartmove/completed             – SmartMove screening done → notify landlord
 *   POST /webhooks/twilio/inbound                  – Twilio inbound SMS → forward to Telegram
 */

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const logger  = require('../logger');
const { config } = require('../config');
const { getTenantContextFromRequest } = require('../platform/runtime');
const { makePlatformRouter } = require('../platform/router');
const apiRoot = require('../api/index');

function getTenantApi(tenantContext) {
  if (process.env.PLATFORM_MULTI_TENANT !== '1') {
    return apiRoot;
  }
  if (tenantContext && typeof apiRoot.forTenant === 'function') {
    return apiRoot.forTenant(tenantContext);
  }
  return apiRoot;
}

function getIntegration(req, name) {
  if (process.env.PLATFORM_MULTI_TENANT !== '1') return {};
  return req.tenantContext?.integrations?.[name] || {};
}

function notifyLandlordScoped(notifyLandlord, text, tenantContext) {
  if (process.env.PLATFORM_MULTI_TENANT === '1' && tenantContext) {
    return notifyLandlord(text, { tenantContext });
  }
  return notifyLandlord(text);
}

// ── HMAC-SHA256 signature validation for ERPNext webhooks ─────────────────────

function validateSignature(req, res, next) {
  const tenantSecret = getIntegration(req, 'erpnext').webhookSecret || '';
  const secret = tenantSecret || config.webhook?.secret || process.env.WEBHOOK_SECRET || '';
  if (!secret) return next(); // skip when no secret is configured (dev mode)

  const sig  = req.headers['x-frappe-webhook-signature'] || '';
  const body = req.rawBody !== undefined ? req.rawBody
             : req.body    !== undefined ? JSON.stringify(req.body) : '';

  // Accept two signature formats:
  //   hex    – used by our own tests and direct API callers
  //   base64 – used by Frappe Cloud webhooks (base64(hmac_sha256(secret, body)))
  const hmacHex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const hmacB64 = crypto.createHmac('sha256', secret).update(body).digest('base64');

  const matchesHex = sig.length === hmacHex.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmacHex));
  const matchesB64 = sig.length === hmacB64.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmacB64));

  if (!matchesHex && !matchesB64) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

// Middleware to capture raw request body for signature validation
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString();
}

// Fallback middleware: captures the raw body for requests whose Content-Type doesn't
// match json or urlencoded (e.g. Frappe webhooks sent without a recognised header).
// Runs AFTER body parsers so the stream is still available when they skip.
function ensureRawBody(req, _res, next) {
  if (req.rawBody !== undefined) return next(); // already captured by a body-parser verify cb
  if (req._body) {
    // A body parser consumed the stream but didn't set rawBody (shouldn't happen, but safe)
    req.rawBody = req.body !== undefined ? JSON.stringify(req.body) : '';
    return next();
  }
  // Neither parser ran – read the raw stream ourselves
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString();
    if (req.body === undefined) {
      try { req.body = JSON.parse(req.rawBody); } catch (_) { req.body = {}; }
    }
    next();
  });
  req.on('error', next);
}

// ── BoldSign completion handler ────────────────────────────────────────────────
//
// Called after all parties have signed.  Downloads the PDF, attaches it to the
// Lease record in ERPNext, marks signed_agreement_received = 1, then fires
// a Telegram alert and SMS to the tenant.
//
// BoldSign webhook payload shape (eventType === "Completed"):
//   {
//     eventType: "Completed",
//     data: {
//       documentId: "...",
//       signerDetails: [
//         { signerRole: "Tenant",   signerEmail: "...", signerName: "..." },
//         { signerRole: "Landlord", signerEmail: "...", signerName: "..." }
//       ]
//     }
//   }

async function handleBoldSignCompleted(body, tenantContext) {
  const { handle } = require('./handlers');
  const boldSign = require('../api/boldsign');
  const api = getTenantApi(tenantContext);

  const documentId = body?.data?.documentId;
  if (!documentId) return;

  // Extract tenant email from signerDetails
  const signerDetails   = body?.data?.signerDetails || [];
  const tenantSignerObj = signerDetails.find(s =>
    (s.signerRole || '').toLowerCase() === 'tenant'
  );
  const tenantEmail = tenantSignerObj?.signerEmail || '';

  let lease      = null;
  let tenantDoc  = null;

  if (tenantEmail) {
    try {
      const allTenants = await api.getTenants({});
      tenantDoc = allTenants.find(t => (t.email_id || '').toLowerCase() === tenantEmail.toLowerCase());
      if (tenantDoc) {
        const leases = await api.getLeases({ status: 'active' });
        lease = leases.find(l => l.lease_customer === tenantDoc.name);
      }
    } catch (err) {
      logger.error('BoldSign: could not resolve tenant/lease', { error: err.message });
    }
  }

  // Download signed PDF
  let pdfBuffer;
  try {
    pdfBuffer = await boldSign.downloadSignedDocument(documentId);
  } catch (err) {
    logger.error('BoldSign: PDF download failed', { documentId, error: err.message });
    pdfBuffer = null;
  }

  // Attach PDF to the Lease record and mark signed
  if (lease && pdfBuffer && pdfBuffer.length > 0) {
    const erpCfg = process.env.PLATFORM_MULTI_TENANT === '1'
      ? (tenantContext?.integrations?.erpnext || {})
      : {};
    const erpnextBase = (erpCfg.baseUrl || process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
    const erpnextKey  = erpCfg.apiKey || process.env.ERPNEXT_API_KEY;
    const erpnextSec  = erpCfg.apiSecret || process.env.ERPNEXT_API_SECRET;

    if (erpnextBase && erpnextKey && erpnextSec) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
      const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

      const erpHttp = axios.create({
        baseURL: erpnextBase,
        headers: {
          Authorization: `token ${erpnextKey}:${erpnextSec}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 30_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      // ERPNext accepts base64-encoded files via upload_file JSON endpoint
      const fileName = `lease-signed-${documentId}.pdf`;
      try {
        await erpHttp.post('/api/method/upload_file', {
          filename:   fileName,
          filedata:   pdfBuffer.toString('base64'),
          doctype:    'Lease',
          docname:    lease.name,
          is_private: 1,
          folder:     'Home/Attachments',
        });
        logger.info('BoldSign: signed PDF attached to Lease', { lease: lease.name });
      } catch (err) {
        logger.error('BoldSign: could not attach PDF to Lease', { lease: lease.name, error: err.message });
      }

      // Mark lease as signed
      try {
        await api.updateLease(lease.name, { signed_agreement_received: 1 });
      } catch (err) {
        logger.error('BoldSign: could not update signed_agreement_received', { error: err.message });
      }
    }
  }

  // Fire lease.signed event (Telegram + tenant SMS)
  await handle({
    type: 'lease.signed',
    tenantContext,
    data: {
      documentId,
      tenantName:  tenantDoc?.customer_name || tenantEmail,
      tenantPhone: tenantDoc?.mobile_no     || '',
      unitName:    lease?.property          || '',
      startDate:   lease?.start_date        || '',
    },
  });
}

// ── SmartMove screening completed handler ─────────────────────────────────────

async function handleSmartMoveCompleted(body, tenantContext) {
  const notifyLandlord = require('../telegram/bot').notifyLandlord;
  const api = getTenantApi(tenantContext);

  const applicantEmail = body?.applicant_email || '';
  const reportType     = body?.report_type     || 'Standard';
  const result         = body?.result          || {};  // credit / criminal / eviction
  const invitationId   = body?.invitation_id   || '';

  // Update Lead status to "Screened"
  if (applicantEmail) {
    try {
      const leads = await api.getCRMLeads({});
      const lead  = leads.find(l => (l.email_id || '').toLowerCase() === applicantEmail.toLowerCase());
      if (lead) {
        await api.updateCRMLead(lead.name, { status: 'Screened' });
      }
    } catch (err) {
      logger.error('SmartMove: could not update Lead status', { error: err.message });
    }
  }

  const creditSummary   = result.credit_score_range  || 'See report';
  const criminalSummary = result.criminal_records > 0 ? 'See report' : 'Clear';
  const evictionSummary = result.eviction_records > 0 ? 'See report' : 'Clear';
  const dashboardUrl    = 'https://www.mysmartmove.com/SmartMove/login.go';

  await notifyLandlordScoped(notifyLandlord,
    `✅ Screening complete: ${applicantEmail}\n` +
    `  Credit:   ${creditSummary}\n` +
    `  Criminal: ${criminalSummary}\n` +
    `  Eviction: ${evictionSummary}\n` +
    `  Report type: ${reportType}\n` +
    `  View full report: ${dashboardUrl}`,
    tenantContext
  );
}

// ── Health check ──────────────────────────────────────────────────────────────

function makeWebhookRouter() {
  const router = express.Router();

  router.use(async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── ERPNext webhook endpoints ───────────────────────────────────────────────

  const { handle } = require('./handlers');

  router.post('/erpnext/invoice-overdue', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'rent.overdue',
      tenantContext: req.tenantContext,
      data: {
        invoiceId:   d.name,
        tenantId:    d.customer,
        tenantName:  d.customer_name,
        unitName:    d.custom_unit    || d.custom_property || '',
        amountDue:   d.outstanding_amount,
        dueDate:     d.due_date,
        leaseId:     d.custom_lease,
      },
    }).catch(err => logger.error('rent.overdue handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/payment-received', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'payment.received',
      tenantContext: req.tenantContext,
      data: {
        paymentId:     d.name,
        tenantId:      d.party,
        tenantName:    d.party_name,
        amountPaid:    d.paid_amount,
        paymentMethod: d.mode_of_payment,
        leaseId:       d.custom_lease,
      },
    }).catch(err => logger.error('payment.received handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/ticket-created', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'workorder.created',
      tenantContext: req.tenantContext,
      data: {
        ticketId:   d.name,
        subject:    d.subject,
        priority:   d.priority,
        tenantName: d.customer_name || d.raised_by_name || '',
        description: d.description,
      },
    }).catch(err => logger.error('workorder.created handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/contract-submitted', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'lease.created',
      tenantContext: req.tenantContext,
      data: {
        leaseId:     d.name,
        tenantName:  d.tenant_name,
        unitName:    d.property_unit,
        startDate:   d.start_date,
        endDate:     d.end_date,
        monthlyRent: d.monthly_rent,
      },
    }).catch(err => logger.error('lease.created handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/contract-cancelled', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'lease.expired',
      tenantContext: req.tenantContext,
      data: {
        leaseId:    d.name,
        tenantName: d.tenant_name,
        unitName:   d.property_unit,
      },
    }).catch(err => logger.error('lease.expired handler error', { error: err.message }));
    res.json({ received: true });
  });

  // ── Rental application submitted (ERPNext Web Form) ─────────────────────────
  router.post('/erpnext/application-submitted', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'application.submitted',
      tenantContext: req.tenantContext,
      data: {
        leadName:           d.name,
        firstName:          d.first_name  || '',
        lastName:           d.last_name   || '',
        email:              d.email_id    || '',
        phone:              d.mobile_no   || '',
        monthlyIncome:      d.custom_monthly_gross_income    || '',
        occupants:          d.custom_number_of_occupants     || '',
        hasEviction:        d.custom_eviction_history        || 'No',
        interestedProperty: d.custom_interested_property     || '',
      },
    }).catch(err => logger.error('application.submitted handler error', { error: err.message, stack: err.stack }));
    res.json({ received: true });
  });

  // ── BoldSign: all parties have signed ───────────────────────────────────────
  // Validation uses the X-BoldSign-Signature header:
  //   Format:  "t=<unix-timestamp>, s0=<hex-hmac>"
  //   Payload: "<timestamp>.<rawJsonBody>"
  //   Secret:  BOLDSIGN_WEBHOOK_SECRET
  router.post('/boldsign/completed', async (req, res) => {
    const webhookSecret = (process.env.PLATFORM_MULTI_TENANT === '1'
      ? req.tenantContext?.settings?.boldsignWebhookSecret
      : '') ||
      process.env.BOLDSIGN_WEBHOOK_SECRET || '';
    const sigHeader     = req.headers['x-boldsign-signature'] || '';
    const rawBody       = req.rawBody || JSON.stringify(req.body);

    if (webhookSecret && sigHeader) {
      // Parse "t=123456, s0=abc123"
      const parts = {};
      for (const chunk of sigHeader.split(',')) {
        const eq = chunk.indexOf('=');
        if (eq === -1) continue;
        parts[chunk.slice(0, eq).trim()] = chunk.slice(eq + 1).trim();
      }
      const timestamp  = parts['t'];
      const receivedSig = parts['s0'] || '';

      if (!timestamp || !receivedSig) {
        logger.warn('BoldSign webhook: malformed signature header');
        return res.status(401).json({ error: 'Invalid signature header' });
      }

      // Reject events older than 5 minutes (replay protection)
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
        logger.warn('BoldSign webhook: timestamp too old');
        return res.status(401).json({ error: 'Webhook timestamp expired' });
      }

      const signedPayload = `${timestamp}.${rawBody}`;
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(signedPayload)
        .digest('hex');

      if (receivedSig.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(receivedSig, 'hex'), Buffer.from(expected, 'hex'))) {
        logger.warn('BoldSign webhook: invalid HMAC signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Acknowledge immediately
    res.status(200).json({ received: true });

    if (req.body?.eventType !== 'Completed') return;

    setImmediate(() => handleBoldSignCompleted(req.body, req.tenantContext).catch(err =>
      logger.error('BoldSign completed handler error', { error: err.message })
    ));
  });

  // ── SmartMove: screening report ready ───────────────────────────────────────
  router.post('/smartmove/completed', async (req, res) => {
    res.json({ received: true });
    const d = req.body || {};
    setImmediate(() => handleSmartMoveCompleted(d, req.tenantContext).catch(err =>
      logger.error('SmartMove completed handler error', { error: err.message })
    ));
  });

  // ── Twilio: inbound SMS from a tenant ────────────────────────────────────────
  //
  // Twilio POSTs URL-encoded fields when a tenant sends an SMS to our number:
  //   From   – sender's E.164 phone number
  //   To     – our Twilio number
  //   Body   – the message text
  //   MessageSid, AccountSid, etc. (also provided)
  //
  // Signature validation:
  //   X-Twilio-Signature: base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + sortedParams))
  //
  // On success the route returns an empty TwiML <Response/> so Twilio does not
  // send an automatic reply.
  router.post('/twilio/inbound', async (req, res) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN || '';

    // ── Validate Twilio signature ─────────────────────────────────────────────
    if (authToken) {
      const twilioSig = req.headers['x-twilio-signature'] || '';
      if (!twilioSig) {
        logger.warn('Twilio inbound: missing X-Twilio-Signature header');
        return res.status(403).send('Forbidden');
      }

      // Reconstruct the full URL Twilio signed (honour X-Forwarded-Proto for proxies)
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host  = req.headers['x-forwarded-host']  || req.get('host') || '';
      const fullUrl = `${proto}://${host}${req.originalUrl}`;

      // Build the string-to-sign: URL followed by sorted param key+value pairs
      const params     = req.body || {};
      const sortedKeys = Object.keys(params).sort();
      const paramStr   = sortedKeys.map(k => `${k}${params[k]}`).join('');
      const sigInput   = fullUrl + paramStr;

      const expected = crypto
        .createHmac('sha1', authToken)
        .update(Buffer.from(sigInput, 'utf-8'))
        .digest('base64');

      if (twilioSig !== expected) {
        logger.warn('Twilio inbound: invalid signature', { fullUrl });
        return res.status(403).send('Forbidden');
      }
    }

    const from = (req.body?.From || '').trim();
    const body = (req.body?.Body || '').trim();

    logger.info('Twilio inbound SMS received', { from });

    if (!from || !body) {
      res.set('Content-Type', 'text/xml');
      return res.send('<Response/>');
    }

    // ── Identify tenant by phone number ──────────────────────────────────────
    setImmediate(async () => {
      try {
        const api = getTenantApi(req.tenantContext);
        const { notifyLandlord } = require('../telegram/bot');

        // Normalise both numbers to digits-only for comparison
        const normalise = n => n.replace(/\D/g, '');
        const fromNorm  = normalise(from);

        let tenantLabel = from; // fallback: just show the phone number
        let unitLabel   = '';

        try {
          const tenants = await api.getTenants({});
          const match   = tenants.find(t => t.mobile_no && normalise(t.mobile_no) === fromNorm);
          if (match) {
            tenantLabel = match.customer_name || from;
            unitLabel   = match.custom_unit   || '';
            logger.info('Twilio inbound: matched tenant', { tenant: tenantLabel, unit: unitLabel });
          } else {
            logger.warn('Twilio inbound: no tenant matched phone number', { from });
          }
        } catch (err) {
          logger.error('Twilio inbound: ERPNext lookup failed', { error: err.message });
        }

        const unitSuffix = unitLabel ? ` (${unitLabel})` : '';
        const message    = `📱 SMS from ${tenantLabel}${unitSuffix}:\n"${body}"`;

        await notifyLandlordScoped(notifyLandlord, message, req.tenantContext);
        logger.info('Twilio inbound: forwarded to Telegram', { from, tenant: tenantLabel });
      } catch (err) {
        logger.error('Twilio inbound: failed to forward to Telegram', { error: err.message });
      }
    });

    // Respond immediately with empty TwiML to suppress Twilio auto-reply
    res.set('Content-Type', 'text/xml');
    res.send('<Response/>');
  });

  return router;
}

// ── Stripe Checkout with card + ACH ───────────────────────────────────────────

function makeCheckoutRouter() {
  const router = express.Router();

  router.use(async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /checkout?invoice_name=ACC-SINV-2026-00009[&method=ach|card]
   *
   * method=ach  (default) → us_bank_account only, original amount
   * method=card           → card only, amount + CARD_SURCHARGE_PCT (default 3%)
   *
   * Creates a Stripe-hosted Checkout Session and redirects the tenant.
   */
  router.get('/checkout', async (req, res) => {
    const invoiceName = (req.query.invoice_name || '').trim();
    if (!invoiceName) return res.status(400).send('invoice_name is required');

    const method = (req.query.method || 'ach').toLowerCase();
    if (method !== 'ach' && method !== 'card') {
      return res.status(400).send('method must be "ach" or "card"');
    }

    const stripeCfg = getIntegration(req, 'stripe');
    const erpCfg = getIntegration(req, 'erpnext');

    const stripeSecretKey = stripeCfg.secretKey || config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
    const erpnextBase     = (erpCfg.baseUrl || process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
    const erpnextKey      = erpCfg.apiKey || process.env.ERPNEXT_API_KEY;
    const erpnextSec      = erpCfg.apiSecret || process.env.ERPNEXT_API_SECRET;

    if (!stripeSecretKey) {
      logger.error('STRIPE_SECRET_KEY not configured');
      return res.status(500).send('Payment gateway not configured');
    }

    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
      const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

      const erpHttp = axios.create({
        baseURL: erpnextBase,
        headers: {
          Authorization: `token ${erpnextKey}:${erpnextSec}`,
          Accept: 'application/json',
        },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      const { data: invData } = await erpHttp.get(
        `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceName)}`
      );
      const inv = invData.data;

      if (inv.docstatus !== 1 || !(inv.outstanding_amount > 0)) {
        return res.status(400).send('Invoice is not payable');
      }

      const { data: custData } = await erpHttp.get(
        `/api/resource/Customer/${encodeURIComponent(inv.customer)}`
      );
      const customerEmail = custData.data.email_id || '';

      // Apply credit-card surcharge when method=card
      const CARD_SURCHARGE_PCT = parseFloat(req.tenantContext?.settings?.cardSurchargePct || process.env.CARD_SURCHARGE_PCT || '3') / 100;
      const baseAmount  = inv.outstanding_amount;
      const isCard      = method === 'card';
      const finalAmount = isCard
        ? Math.round(baseAmount * (1 + CARD_SURCHARGE_PCT) * 100) // cents, rounded
        : Math.round(baseAmount * 100);

      const stripeHttp = axios.create({
        baseURL: 'https://api.stripe.com',
        auth: { username: stripeSecretKey, password: '' },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      const surchargeLabel = isCard
        ? ` (includes ${Math.round(CARD_SURCHARGE_PCT * 100)}% card processing fee)`
        : '';

      const params = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Rent – ${invoiceName}${surchargeLabel}`,
        'line_items[0][price_data][unit_amount]': String(finalAmount),
        'line_items[0][quantity]': '1',
        'success_url': `${erpnextBase}/invoices?payment=success`,
        'cancel_url':  `${erpnextBase}/invoices`,
        'metadata[invoice]': invoiceName,
        'metadata[tenant]':  inv.customer_name || '',
        'metadata[tenant_id]': req.tenantContext?.tenantId || '',
        'metadata[method]':  method,
      });

      if (isCard) {
        params.append('payment_method_types[]', 'card');
      } else {
        params.append('payment_method_types[]', 'us_bank_account');
        params.set('payment_method_options[us_bank_account][financial_connections][permissions][]', 'payment_method');
      }

      if (customerEmail) params.set('customer_email', customerEmail);

      const { data: session } = await stripeHttp.post(
        '/v1/checkout/sessions',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      if (session.error) {
        logger.error('Stripe session creation failed', { error: session.error });
        return res.status(502).send('Could not create payment session: ' + session.error.message);
      }

      logger.info('Stripe checkout session created', {
        invoice: invoiceName,
        session: session.id,
        amount: inv.outstanding_amount,
      });

      return res.redirect(302, session.url);

    } catch (err) {
      logger.error('Checkout endpoint error', {
        invoice: invoiceName,
        error: err.response?.data || err.message,
      });
      return res.status(500).send('Payment session error – please try again');
    }
  });

  return router;
}

// ── Stripe webhook: ACH async payment confirmation ───────────────────────────
//
// ACH (us_bank_account) payments take 1-5 business days to settle.
// Stripe fires these events:
//   checkout.session.completed            – always fires; payment_status='unpaid' for ACH
//   checkout.session.async_payment_succeeded – ACH cleared   ← record payment here
//   checkout.session.async_payment_failed   – ACH bounced    ← alert landlord
//   (for card payments checkout.session.completed fires with payment_status='paid')
//
// On success we create a Payment Entry (draft or submitted) in ERPNext so the
// invoice outstanding_amount is zeroed out.  A Telegram alert is also sent.

/**
 * Validate a Stripe webhook signature.
 * Stripe header format: "t=TIMESTAMP,v1=SIG[,v1=SIG2]"
 * Signed payload:        "{timestamp}.{rawBody}"
 */
function validateStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;

  const parts = {};
  for (const chunk of header.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const k = chunk.slice(0, eq);
    const v = chunk.slice(eq + 1);
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }

  const timestamp  = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;

  // Reject events older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const payload  = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expBuf   = Buffer.from(expected, 'hex');

  return signatures.some(sig => {
    if (sig.length !== expected.length) return false;
    const sigBuf = Buffer.from(sig, 'hex');
    return crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

/**
 * Create a Payment Entry in ERPNext to mark the invoice as paid.
 * docstatus=1 (submitted) when STRIPE_BANK_ACCOUNT is configured,
 * docstatus=0 (draft)     otherwise — accountant reviews before posting.
 */
async function recordStripePaymentInERPNext(erpHttp, { invoiceName, amountCents, paymentMethod, stripeSessionId, tenantContext }) {
  const amount      = amountCents / 100;
  const stripeCfg = process.env.PLATFORM_MULTI_TENANT === '1'
    ? (tenantContext?.integrations?.stripe || {})
    : {};
  const arAccount   = stripeCfg.paymentAccount || config.stripe?.paymentAccount || 'Debtors - LD';
  const bankAccount = stripeCfg.bankAccount || config.stripe?.bankAccount || '';
  const modeOfPayment = paymentMethod === 'us_bank_account' ? 'Wire Transfer' : 'Credit Card';

  // Fetch invoice to get customer / company context
  const { data: invData } = await erpHttp.get(
    `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceName)}`
  );
  const inv = invData.data;
  const company = inv.company;

  // Resolve cost center for the company (required when any P&L account appears in GL entries)
  let costCenter = '';
  try {
    const { data: ccData } = await erpHttp.get(
      `/api/resource/Cost%20Center?filters=${encodeURIComponent(JSON.stringify([['company','=',company],['is_group','=',0]]))}&fields=${encodeURIComponent('["name"]')}&limit=1`
    );
    costCenter = ccData.data?.[0]?.name || '';
  } catch (_) { /* proceed without – ERPNext will error only if the account is P&L */ }

  const pePayload = {
    payment_type:      'Receive',
    mode_of_payment:   modeOfPayment,
    party_type:        'Customer',
    party:             inv.customer,
    party_name:        inv.customer_name,
    paid_amount:       amount,
    received_amount:   amount,
    paid_from:         arAccount,
    references: [{
      reference_doctype: 'Sales Invoice',
      reference_name:    invoiceName,
      allocated_amount:  amount,
    }],
    remarks: `Stripe ${paymentMethod === 'us_bank_account' ? 'ACH' : 'card'} payment — session ${stripeSessionId}`,
    docstatus: bankAccount ? 1 : 0,
    ...(costCenter ? { cost_center: costCenter } : {}),
    ...(bankAccount ? { paid_to: bankAccount } : {}),
  };

  const { data: result } = await erpHttp.post('/api/resource/Payment%20Entry', pePayload);
  return { name: result.data.name, submitted: !!bankAccount };
}

function makeStripeWebhookRouter() {
  const router = express.Router();

  router.use(async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.post('/stripe', async (req, res) => {
    const webhookSecret = getIntegration(req, 'stripe').webhookSecret ||
      config.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '';
    const sigHeader     = req.headers['stripe-signature'] || '';
    const rawBody       = req.rawBody || JSON.stringify(req.body);

    if (webhookSecret) {
      if (!validateStripeSignature(rawBody, sigHeader, webhookSecret)) {
        logger.warn('Stripe webhook: invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } else {
      logger.warn('STRIPE_WEBHOOK_SECRET not set — skipping signature validation');
    }

    let event;
    try {
      event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Acknowledge immediately — Stripe retries on non-2xx
    res.json({ received: true });

    // Process asynchronously so a slow ERPNext call doesn't delay the 200
    setImmediate(() => handleStripeEvent(event, req.tenantContext).catch(err =>
      logger.error('Stripe webhook handler error', { type: event?.type, error: err.message })
    ));
  });

  return router;
}

async function handleStripeEvent(event, tenantContext) {
  const { handle: handleErpEvent } = require('./handlers');
  const type    = event.type;
  const session = event.data?.object;

  logger.info('Stripe webhook event', { type, session: session?.id });

  // ── Card payment: confirmed synchronously at checkout ──────────────────────
  if (type === 'checkout.session.completed' && session?.payment_status === 'paid') {
    await onPaymentConfirmed(session, 'card', handleErpEvent, tenantContext);
    return;
  }

  // ── ACH: payment cleared (1-5 business days after checkout) ───────────────
  if (type === 'checkout.session.async_payment_succeeded') {
    await onPaymentConfirmed(session, 'us_bank_account', handleErpEvent, tenantContext);
    return;
  }

  // ── ACH: payment bounced ───────────────────────────────────────────────────
  if (type === 'checkout.session.async_payment_failed') {
    const invoiceName = session?.metadata?.invoice || 'unknown';
    const tenantName  = session?.metadata?.tenant  || 'unknown';
    const amount      = session?.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : '';
    logger.warn('ACH payment failed', { invoice: invoiceName, tenant: tenantName });
    await handleErpEvent({
      type: 'payment.failed',
      tenantContext,
      data: { invoiceName, tenantName, amount },
    }).catch(() => {});
    return;
  }

  // ── ACH: session completed but payment still pending (normal ACH flow) ─────
  if (type === 'checkout.session.completed' && session?.payment_status === 'unpaid') {
    const invoiceName = session?.metadata?.invoice || 'unknown';
    const tenantName  = session?.metadata?.tenant  || 'unknown';
    const amount      = session?.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : '';
    logger.info('ACH payment initiated — awaiting bank confirmation', { invoice: invoiceName });
    await handleErpEvent({
      type: 'payment.pending',
      tenantContext,
      data: { invoiceName, tenantName, amount },
    }).catch(() => {});
    return;
  }
}

async function onPaymentConfirmed(session, paymentMethod, handleErpEvent, tenantContext) {
  const invoiceName = session?.metadata?.invoice;
  const tenantName  = session?.metadata?.tenant || 'unknown';
  const amountCents = session?.amount_total || 0;
  const amount      = `$${(amountCents / 100).toFixed(2)}`;

  if (!invoiceName) {
    logger.error('Stripe webhook: no invoice in session metadata', { session: session?.id });
    return;
  }

  const erpCfg = process.env.PLATFORM_MULTI_TENANT === '1'
    ? (tenantContext?.integrations?.erpnext || {})
    : {};
  const erpnextBase = (erpCfg.baseUrl || process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
  const erpnextKey  = erpCfg.apiKey || process.env.ERPNEXT_API_KEY;
  const erpnextSec  = erpCfg.apiSecret || process.env.ERPNEXT_API_SECRET;

  let peResult = null;
  if (erpnextBase && erpnextKey && erpnextSec) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const erpHttp = axios.create({
      baseURL: erpnextBase,
      headers: { Authorization: `token ${erpnextKey}:${erpnextSec}`, Accept: 'application/json' },
      timeout: 20_000,
      ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
    });

    try {
      peResult = await recordStripePaymentInERPNext(erpHttp, {
        invoiceName,
        amountCents,
        paymentMethod,
        stripeSessionId: session.id,
        tenantContext,
      });
      logger.info('Payment Entry created', { name: peResult.name, submitted: peResult.submitted, invoice: invoiceName });
    } catch (err) {
      logger.error('Failed to create Payment Entry', {
        invoice: invoiceName,
        error: err.response?.data?.exception || err.message,
      });
    }
  }

  const methodLabel = paymentMethod === 'us_bank_account' ? 'ACH bank transfer' : 'card';
  const peNote = peResult
    ? peResult.submitted
      ? ` — Payment Entry ${peResult.name} posted in ERPNext`
      : ` — Draft Payment Entry ${peResult.name} created in ERPNext (needs review)`
    : ' — ⚠️ ERPNext payment entry creation failed, record manually';

  await handleErpEvent({
    type: 'payment.received',
    tenantContext,
    data: {
      invoiceId:     invoiceName,
      tenantName,
      amountPaid:    amountCents / 100,
      paymentMethod: methodLabel,
    },
  }).catch(() => {});

  logger.info('Stripe payment confirmed', { invoice: invoiceName, amount, method: methodLabel, peNote });
}

// ── Payment History page ──────────────────────────────────────────────────────
//
// GET /payment-history?email=<tenant-email>
//
// Looks up the Stripe customer by email, fetches their succeeded PaymentIntents
// (expanding latest_charge for the Stripe-hosted receipt URL), and renders a
// self-contained Bootstrap HTML page the tenant can view in a new tab.

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPaymentHistoryHtml(tenantName, payments) {
  const rows = payments.length === 0
    ? '<tr><td colspan="5" class="text-center py-5 text-muted">No payment records found.</td></tr>'
    : payments.map(p => `
      <tr>
        <td class="pl-4">${escHtml(p.date)}</td>
        <td class="text-muted small">${escHtml(p.description)}</td>
        <td><strong>${escHtml(p.amount)}</strong></td>
        <td><span class="badge badge-light border">${escHtml(p.method)}</span></td>
        <td>
          <span class="badge badge-success">Paid</span>
          ${p.receiptUrl
            ? ` <a href="${escHtml(p.receiptUrl)}" target="_blank" rel="noopener"
                   class="btn btn-sm btn-outline-secondary ml-1"
                   style="font-size:11px;padding:1px 8px;">Receipt ↗</a>`
            : ''}
        </td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment History – ${escHtml(tenantName)}</title>
  <link rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/css/bootstrap.min.css"
        integrity="sha384-xOolHFLEh07PJGoPkLv1IbcEPTNtaed2xpHsD9ESMhqIYd0nLMwNLD69Npy4HI+N"
        crossorigin="anonymous">
  <style>
    body { background: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .page-card { background: #fff; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.08); overflow: hidden; }
    thead th { background: #f8f9fa; font-size: 11px; font-weight: 600; text-transform: uppercase;
               letter-spacing: .6px; color: #868e96; border-top: none; }
    td { vertical-align: middle !important; }
    .badge-success { background: #28a745; }
  </style>
</head>
<body>
<div class="container" style="max-width:820px;padding:40px 15px 60px">
  <div class="mb-4">
    <a href="javascript:history.back()" class="text-secondary small">← Back</a>
  </div>
  <div class="page-card">
    <div class="px-4 pt-4 pb-3 border-bottom">
      <h5 class="mb-0 font-weight-bold">Payment History</h5>
      <div class="text-muted small mt-1">${escHtml(tenantName)}</div>
    </div>
    <div class="table-responsive">
      <table class="table table-hover mb-0">
        <thead>
          <tr>
            <th class="pl-4">Date</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Method</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="text-center text-muted mt-4" style="font-size:12px;">
    Payment records secured &amp; verified by Stripe &nbsp;·&nbsp;
    Questions? Contact your property manager.
  </p>
</div>
</body>
</html>`;
}

function makePaymentHistoryRouter() {
  const router = express.Router();

  router.use(async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/payment-history', async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).send('Valid email query parameter is required');
    }

    const stripeSecretKey = getIntegration(req, 'stripe').secretKey ||
      config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      return res.status(500).send('Payment gateway not configured');
    }

    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
      const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

      const stripeHttp = axios.create({
        baseURL: 'https://api.stripe.com',
        auth:    { username: stripeSecretKey, password: '' },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      // Find Stripe customer by email
      const { data: custList } = await stripeHttp.get(
        `/v1/customers?email=${encodeURIComponent(email)}&limit=1`
      );

      const payments = [];
      let displayName = email;

      if (custList.data && custList.data.length > 0) {
        const customer = custList.data[0];
        displayName = customer.name || customer.email || email;

        // Fetch PaymentIntents with latest_charge expanded (for receipt_url)
        const { data: piList } = await stripeHttp.get(
          `/v1/payment_intents?customer=${customer.id}&limit=100&expand[]=data.latest_charge`
        );

        for (const pi of (piList.data || [])) {
          if (pi.status !== 'succeeded') continue;
          const charge = pi.latest_charge;
          const brand  = charge?.payment_method_details?.card?.brand || '';
          const method = pi.metadata?.method === 'us_bank_account'
            ? 'ACH Bank Transfer'
            : `Card${brand ? ` (${brand.charAt(0).toUpperCase() + brand.slice(1)})` : ''}`;

          payments.push({
            date: new Date(pi.created * 1000).toLocaleDateString('en-US', {
              year: 'numeric', month: 'long', day: 'numeric',
            }),
            description: pi.description || pi.metadata?.invoice || '',
            amount:      `$${(pi.amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
            method,
            receiptUrl: charge?.receipt_url || null,
          });
        }
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPaymentHistoryHtml(displayName, payments));

    } catch (err) {
      logger.error('Payment history error', {
        email,
        error: err.response?.data || err.message,
      });
      res.status(500).send('Could not load payment history – please try again');
    }
  });

  return router;
}

// ── App factories ─────────────────────────────────────────────────────────────

/**
 * createWebhookApp() — used by tests and directly by src/index.js.
 * Mounts:
 *   /webhooks/…              ERPNext webhook endpoints + health
 *   /api/properties-for-apply  Public property list for the /apply Web Form dropdown
 *   /checkout                Stripe Checkout Session endpoint
 */

// ── GET /api/properties-for-apply ─────────────────────────────────────────────
// Public endpoint (no auth). Returns properties sorted: vacant first, then by
// active lease end_date ascending (soonest vacancy first).
// Called by the ERPNext /apply Web Form client_script to populate the property
// interest dropdown for prospective tenants.
function makePublicApiRouter() {
  const router = express.Router();

  router.use(async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/properties-for-apply', async (req, res) => {
    try {
      const api = getTenantApi(req.tenantContext);
      const [properties, leases] = await Promise.all([
        api.getProperties(),
        api.getLeases({ status: 'active' }),
      ]);

      // Build map: property.name → earliest active lease end_date
      const leaseEndByProperty = {};
      for (const l of leases) {
        if (l.property && l.end_date) {
          const existing = leaseEndByProperty[l.property];
          if (!existing || l.end_date < existing) leaseEndByProperty[l.property] = l.end_date;
        }
      }

      const vacant = [], occupied = [];
      for (const p of properties) {
        const endDate = leaseEndByProperty[p.name];
        if (p.status === 'Available' || !endDate) vacant.push(p);
        else occupied.push({ ...p, _endDate: endDate });
      }

      vacant.sort((a, b) => (a.name1 || a.name).localeCompare(b.name1 || b.name));
      occupied.sort((a, b) => (a._endDate < b._endDate ? -1 : a._endDate > b._endDate ? 1 : 0));

      const fmtDate = d =>
        new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const suffix = p =>
        (p.rent    ? ` ($${Number(p.rent).toLocaleString()}/mo)` : '') +
        (p.bedroom ? `, ${p.bedroom}br` : '');

      const result = [
        ...vacant.map(p => ({
          value: p.name1 || p.name,
          label: `${p.name1 || p.name} — Available Now${suffix(p)}`,
        })),
        ...occupied.map(p => ({
          value: p.name1 || p.name,
          label: `${p.name1 || p.name} — Available after ${fmtDate(p._endDate)}${suffix(p)}`,
        })),
      ];

      res.set('Access-Control-Allow-Origin', '*');
      res.json(result);
    } catch (err) {
      logger.error('properties-for-apply error', { error: err.message });
      res.status(500).json({ error: 'Could not load properties' });
    }
  });

  return router;
}

// ── Admin UI router (automation settings) ─────────────────────────────────────

function makeAdminRouter() {
  const path   = require('path');
  const cron   = require('../automation/cron');
  const router = express.Router();
  const multiTenant = process.env.PLATFORM_MULTI_TENANT === '1';

  // Serve admin UI:
  // - Multi-tenant mode: SaaS control center at /admin, legacy scheduler at /admin/legacy
  // - Single-tenant mode: legacy scheduler at /admin
  router.get('/', (_req, res) => {
    const fileName = multiTenant ? '../admin-saas.html' : '../admin.html';
    res.sendFile(path.resolve(__dirname, fileName));
  });

  router.get('/legacy', (_req, res) => {
    if (!multiTenant) {
      return res.redirect(302, '/admin');
    }
    return res.sendFile(path.resolve(__dirname, '../admin.html'));
  });

  // GET /admin/api/scheduler-status – returns all job statuses
  router.get('/api/scheduler-status', (_req, res) => {
    try {
      res.json(cron.getStatus());
    } catch (err) {
      logger.error('Admin: getStatus failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /admin/api/run-job/:id – run a job immediately
  router.post('/api/run-job/:id', async (req, res) => {
    const { id } = req.params;
    try {
      logger.info('Admin: manual job trigger', { job: id });
      const result = await cron.runJobNow(id);
      res.json(result || { success: true });
    } catch (err) {
      logger.error('Admin: runJobNow failed', { job: id, error: err.message });
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // POST /admin/api/scheduler-settings – save settings and reload cron
  router.post('/api/scheduler-settings', (req, res) => {
    const settings = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const ok = cron.saveSettings(settings);
    if (!ok) return res.status(500).json({ error: 'Failed to write settings file' });
    cron.reloadScheduler();
    res.json({ success: true });
  });

  return router;
}

function createWebhookApp() {
  const app = express();

  const tenantContextMiddleware = async (req, _res, next) => {
    try {
      req.tenantContext = req.tenantContext || await getTenantContextFromRequest(req);
      next();
    } catch (err) {
      next(err);
    }
  };

  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
  app.use(ensureRawBody); // fallback: capture raw body for unrecognised Content-Types
  app.use('/api/v2', makePlatformRouter());

  app.use('/webhooks', tenantContextMiddleware, makeWebhookRouter());
  app.use('/webhooks', tenantContextMiddleware, makeStripeWebhookRouter());
  app.use('/webhooks/t/:tenantKey', tenantContextMiddleware, makeWebhookRouter());
  app.use('/webhooks/t/:tenantKey', tenantContextMiddleware, makeStripeWebhookRouter());

  app.use('/admin', makeAdminRouter());
  app.use('/', tenantContextMiddleware, makePublicApiRouter());
  app.use('/', tenantContextMiddleware, makeCheckoutRouter());
  app.use('/', tenantContextMiddleware, makePaymentHistoryRouter());

  app.use('/t/:tenantKey', tenantContextMiddleware, makePublicApiRouter());
  app.use('/t/:tenantKey', tenantContextMiddleware, makeCheckoutRouter());
  app.use('/t/:tenantKey', tenantContextMiddleware, makePaymentHistoryRouter());

  return app;
}

/** Alias kept for backward compatibility with src/index.js */
const createServer = createWebhookApp;

module.exports = { createWebhookApp, createServer };
