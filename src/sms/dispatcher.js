'use strict';

/**
 * SMS dispatcher — thin wrapper around Twilio's REST API.
 *
 * Usage:
 *   const { send, templates } = require('./dispatcher');
 *   await send('+14155551234', templates.rentOverdue({ unit, amountDue }));
 */

const axios  = require('axios');
const logger = require('../logger');

const SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM  = process.env.TWILIO_FROM_NUMBER || '';

function getTwilioConfig(options = {}) {
  const tenantTwilio = options.tenantContext?.integrations?.twilio || {};
  return {
    sid: tenantTwilio.accountSid || SID,
    token: tenantTwilio.authToken || TOKEN,
    from: tenantTwilio.fromNumber || FROM,
  };
}

/**
 * Send an SMS message via Twilio.
 * @param {string} to      E.164 phone number
 * @param {string} body    Message text (≤320 chars for SMS, longer for MMS)
 * @returns {Promise<{ sid: string }>}
 */
async function send(to, body, options = {}) {
  const twilio = getTwilioConfig(options);

  if (!twilio.sid || !twilio.token || !twilio.from) {
    logger.warn('SMS send skipped — Twilio credentials not configured', { to });
    return { sid: 'SKIPPED' };
  }

  const { HttpsProxyAgent } = require('https-proxy-agent');
  const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const { data } = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`,
    new URLSearchParams({ To: to, From: twilio.from, Body: body }).toString(),
    {
      auth: { username: twilio.sid, password: twilio.token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
    }
  );

  logger.info('SMS sent', { to, sid: data.sid });
  return { sid: data.sid };
}

// ── Message templates ─────────────────────────────────────────────────────────

const templates = {
  /**
   * Outbound alert when rent is overdue.
   * @param {{ unit: string, propertyAddress: string, amountDue: number }} p
   */
  rentOverdue({ unit, propertyAddress, amountDue }) {
    return `Rent overdue notice: $${amountDue} is past due for ${unit || propertyAddress}. ` +
           'Please pay at your tenant portal or contact the office.';
  },

  /**
   * Friendly reminder a few days before the due date.
   * @param {{ unit: string, amountDue: number, dueDate: string }} p
   */
  rentReminder({ unit, amountDue, dueDate }) {
    return `Rent reminder: $${amountDue} is due ${dueDate} for ${unit}. ` +
           'Pay early via your tenant portal to avoid late fees.';
  },

  /**
   * Tenant notification when maintenance is scheduled.
   * @param {{ unit: string, description: string, scheduledDate: string }} p
   */
  maintenanceScheduled({ unit, description, scheduledDate }) {
    return `Maintenance scheduled: "${description}" at ${unit}` +
           (scheduledDate ? ` on ${scheduledDate}` : '') + '. ';
  },

  /**
   * Tenant notification when maintenance is complete.
   * @param {{ unit: string, description: string }} p
   */
  maintenanceComplete({ unit, description }) {
    return `Maintenance complete: "${description}" at ${unit} has been resolved. ` +
           'Please contact us if you have any concerns.';
  },

  /**
   * Lease renewal notice to tenant approaching end date.
   * @param {{ tenantName: string, unit: string, endDate: string, daysLeft: number }} p
   */
  leaseRenewalNotice({ tenantName, unit, endDate, daysLeft }) {
    return `Hi ${tenantName}, your lease at ${unit} ends on ${endDate} (${daysLeft} days). ` +
           'Please contact us to discuss renewal options. Reply STOP to opt out.';
  },

  /**
   * Confirmation to tenant once all parties have signed the lease.
   * @param {{ unit: string, startDate: string }} p
   */
  leaseSignedConfirmation({ unit, startDate }) {
    return `Your lease for ${unit} starting ${startDate} has been fully signed by all parties. ` +
           'Welcome! Contact us anytime at this number with questions.';
  },

  /**
   * Sent to the tenant on the FIRST day a late fee is charged for an invoice.
   * Subsequent daily fees do NOT trigger additional SMS (to avoid fatigue).
   * @param {{ unit: string, feeAmount: number, totalDue: number, dayNumber: number }} p
   */
  lateFeeCharged({ unit, feeAmount, totalDue, dayNumber }) {
    return `Late fee of $${feeAmount.toFixed(2)} added to your balance at ${unit} ` +
           `(day ${dayNumber} overdue). Total now due: $${totalDue.toFixed(2)}. ` +
           'Pay at your tenant portal to stop daily charges.';
  },

  /**
   * Work order notification sent to a vendor/contractor.
   * @param {{ ticketId: string, subject: string, unitAddress: string, tenantName: string, tenantPhone: string }} p
   */
  vendorWorkOrder({ ticketId, subject, unitAddress, tenantName, tenantPhone }) {
    return `New work order [${ticketId}]: "${subject}" at ${unitAddress}. ` +
           `Tenant: ${tenantName}${tenantPhone ? ' ' + tenantPhone : ''}. ` +
           'Please reply to confirm or call the office.';
  },
};

module.exports = { send, templates };
