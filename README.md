# Unified Landlord Center SF
## AI-Augmented Property Management System

A Node.js backend that replaces Hemlane and similar property management SaaS
tools by integrating ERPNext (open-source PMS) with a Telegram AI assistant,
automated SMS, e-signatures, tenant screening, and a self-service tenant
portal — for approximately **$30–$80/month** in total operating costs.

---

## What It Does

| Feature | How |
|---|---|
| **Telegram AI assistant** | Ask anything in plain English — the bot queries ERPNext and replies with structured data |
| **Automated rent reminders** | Daily sweep: overdue tenants get SMS, landlord gets Telegram summary |
| **Lease renewal workflow** | Automated notices at 90/60/30/14 days; send for e-signature from Telegram |
| **Daily late fee charging** | Configurable grace period + percentage or flat fee; auto-posts to ledger |
| **Vendor management** | Vendor directory with trade, rating, SMS; assign to work orders from Telegram |
| **Rental applications** | Public `/apply` form → Lead → Telegram alert → SmartMove screening |
| **Lease e-signatures** | BoldSign integration; signed PDF auto-attached to Lease record |
| **Tenant portal** | Self-service invoices, payments (Stripe ACH/card), lease, documents, helpdesk |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LANDLORD (Telegram)                                            │
│       │                                                         │
│  ┌────▼─────────────────────────────────────┐                   │
│  │  OpenAI GPT-4o — 12 function-call tools  │                   │
│  └────┬─────────────────────────────────────┘                   │
│       │                                                         │
│  ┌────▼─────────────────────────────────────┐                   │
│  │  ERPNext REST API (PropMS DocTypes)       │                   │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  SCHEDULER (node-cron)        WEBHOOK SERVER (Express :3000)    │
│  • Daily overdue rent sweep   • ERPNext events (HMAC verified)  │
│  • Stale work-order alerts    • BoldSign lease completion       │
│  • Lease renewal notices      • SmartMove screening results     │
│  • Late fee auto-charging     • Stripe payment events           │
│  • Weekly portfolio report                                      │
│                                                                 │
│  INTEGRATIONS                                                   │
│  Twilio SMS  │  BoldSign  │  TransUnion SmartMove  │  Stripe    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Monthly Cost

| Component | Technology | Est. Cost/Month |
|---|---|---|
| PMS database | ERPNext + PropMS (self-hosted VPS) | ~$10–15 |
| *(alternative)* | Frappe Cloud managed ERPNext | ~$50 |
| AI queries | OpenAI GPT-4o API | ~$5–10 |
| Messaging | Telegram (free) + Twilio SMS | ~$1–5 |
| E-signatures | BoldSign (free tier: 25 docs/mo) | $0–9 |
| Tenant screening | TransUnion SmartMove | $0 (paid by applicant) |
| Payments | Stripe (per-transaction) | ~$0–5 |
| This codebase | Self-hosted, same VPS | $0 |
| **Total (self-hosted)** | | **~$30–50** |
| **Total (Frappe Cloud)** | | **~$75–85** |

*Replaces Hemlane at $40–140/month.*

---

## Repository Structure

```
src/
├── index.js                  Entry point — starts webhook server, bot, scheduler
├── config.js                 Centralised env-var configuration and validation
├── logger.js                 Winston logger (logs/ directory)
├── api/
│   ├── erpnext.js            ERPNext REST client — all DocType operations
│   ├── boldsign.js           BoldSign e-signature API client
│   └── smartmove.js          TransUnion SmartMove screening API client
├── ai/
│   ├── openai.js             OpenAI agentic loop (function-calling, 12 tools)
│   └── functions.js          Tool schema definitions
├── automation/
│   └── scheduler.js          node-cron — 5 scheduled jobs
├── sms/
│   └── dispatcher.js         Twilio SMS templates and dispatch
├── telegram/
│   ├── bot.js                Bot lifecycle + landlord notification methods
│   ├── handlers.js           /start, /help, /clear, NLP routing
│   └── security.js           Telegram user ID allowlist enforcement
└── webhook/
    ├── server.js             Express server — all incoming webhook routes
    └── handlers.js           Event routing → SMS + Telegram

scripts/
├── setup-erpnext-fields.js   Create custom fields on ERPNext DocTypes
├── run-erpnext-setup.js      Create "Late Fee" item and other ERPNext objects
├── setup-tenant-portal.js    Configure portal pages, Web Form, Stripe, users
└── seed-erpnext.js           Create sample data for development

docs/
├── landlord-guide.md         How to use the system as the landlord
├── tenant-guide.md           Tenant portal user manual
├── applicant-guide.md        How to apply for a unit
└── operations.md             System setup, deployment, and operations guide

tests/
├── api.test.js               ERPNext API client tests
├── webhook.test.js           Webhook server and handler tests
├── telegram.test.js          Telegram security and message handler tests
├── scheduler.test.js         Scheduler job logic tests
└── portal.test.js            Portal setup script tests
```

---

## Quick Start

### Multi-tenant SaaS mode (new)

Set `PLATFORM_MULTI_TENANT=1` and configure:

- `DATABASE_URL` (recommended) or `PLATFORM_STORE_PATH`
- `PLATFORM_ENCRYPTION_KEY` (for encrypted tenant credentials)
- `PLATFORM_OWNER_EMAIL` and `PLATFORM_OWNER_PASSWORD`

SaaS admin/auth API base path:

- `POST /api/v2/auth/login`
- `POST /api/v2/auth/verify-otp`
- `GET /api/v2/me`
- `GET/POST /api/v2/tenants`
- `GET/PUT /api/v2/tenants/:tenantId/settings`
- `GET/PUT /api/v2/tenants/:tenantId/integrations/:provider`
- `GET/PUT /api/v2/tenants/:tenantId/automations`

Tenant self-service API (tenant role only):

- `GET /api/v2/tenant/me`
- `GET /api/v2/tenant/lease`
- `GET /api/v2/tenant/documents[?leaseId=<LEASE_ID>]`
- `GET /api/v2/tenant/invoices?status=all|unpaid|paid`
- `GET /api/v2/tenant/payments`
- `GET /api/v2/tenant/tickets`
- `POST /api/v2/tenant/tickets`

Tenant-scoped machine webhook pattern:

- `/webhooks/t/:tenantKey/...` (in addition to legacy `/webhooks/...`)

Role model in multi-tenant mode:

- `saas_admin`: global platform operator (cross-company control)
- `company_admin`: admin inside one property-management company
- `company_user`: staff user inside one company (for day-to-day operations)
- `tenant`: renter account (not a back-office staff/admin account)

Admin UIs:

- `/admin` → SaaS admin console when `PLATFORM_MULTI_TENANT=1`
- `/admin/legacy` → legacy scheduler admin page

### 1. Prerequisites

- Node.js ≥ 18
- ERPNext instance with the [PropMS](https://github.com/aakvatech/PropMS) app installed
- ERPNext API key + secret (ERPNext → User → API Access → Generate Keys)
- Telegram Bot token from [BotFather](https://core.telegram.org/bots/tutorial)
- OpenAI API key
- Twilio account with a phone number
- Publicly reachable HTTPS URL ([ngrok](https://ngrok.com) for local dev)

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env — see docs/operations.md for all variables
```

Minimum required variables:

| Variable | Description |
|---|---|
| `ERPNEXT_BASE_URL` | Your ERPNext URL, e.g. `https://erp.example.com` |
| `ERPNEXT_API_KEY` | ERPNext API key |
| `ERPNEXT_API_SECRET` | ERPNext API secret |
| `OPENAI_API_KEY` | OpenAI secret key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Your Telegram user ID(s), comma-separated |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number (`+1...`) |
| `WEBHOOK_SECRET` | Shared secret for ERPNext webhook HMAC verification |
| `WEBHOOK_BASE_URL` | Public HTTPS URL of this server |

### 4. Set up ERPNext

```bash
# Create all custom fields (idempotent — safe to run multiple times)
npm run setup:erpnext

# Create supporting ERPNext objects (Late Fee item, etc.)
npm run setup:scripts

# Configure tenant portal, Web Form, Stripe, user accounts
npm run setup:portal
```

### 5. Configure ERPNext webhooks

In ERPNext → Integrations → Webhooks, create these webhooks with your
`WEBHOOK_SECRET` as the shared secret:

| DocType | Trigger | URL |
|---|---|---|
| Sales Invoice | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/invoice-overdue` |
| Payment Entry | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/payment-received` |
| HD Ticket | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-created` |
| HD Ticket | `on_update` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-updated` |
| Lease | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-submitted` |
| Lease | `on_update` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-cancelled` |
| Lead | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/application-submitted` |

> Set condition on Lead webhook: `doc.lead_source == "Online Application"`

### 6. Run

```bash
npm run dev    # Development (auto-restart)
npm start      # Production
```

### 7. Test

```bash
npm test
```

---

## Telegram Bot Usage

Message the bot from any whitelisted Telegram account. It understands plain
English — no commands required for most tasks.

### Built-in commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/help` | Example queries for every capability |
| `/clear` | Reset conversation memory |

### Example queries

**Rent & finances**
- "Which tenants are overdue on rent?"
- "Give me a financial summary for this week"
- "Who paid rent this month?"

**Leases & renewals**
- "Which leases expire in the next 60 days?"
- "When does the lease for Unit 3A expire?"
- "Send the lease to Rotem Porat for signing"

**Maintenance & vendors**
- "What maintenance requests are open?"
- "Show me all plumbers in our vendor directory"
- "Assign Mike's Plumbing to HD-0023"

**Applicants & screening**
- "Show me all rental applications"
- "What's the status of David Chen's application?"
- "Send a screening invite to David Chen"

---

## Automated Scheduler Jobs

| Job | Schedule | Description |
|---|---|---|
| Overdue rent sweep | Daily 08:00 PST | SMS to overdue tenants + Telegram summary |
| Stale work-order alert | Daily 09:00 PST | Tickets open > 48h → Telegram alert |
| Lease renewal check | Daily 10:00 PST | 90/60/30/14-day notices → SMS + Telegram |
| Late fee charging | Daily 10:30 PST | Charge daily late fees after grace period |
| Weekly portfolio report | Friday 17:00 PST | Full portfolio summary via Telegram |

---

## Tenant Portal

Tenants log in at `{ERPNEXT_BASE_URL}/login` and see:

| Page | URL | Description |
|---|---|---|
| My Invoices | `/my-invoices` | Outstanding rent with Stripe pay button (ACH + card) |
| Paid Invoices | `/paid-invoices` | Payment history |
| My Lease | `/my-lease` | Lease dates, rent, days remaining, renewal request button |
| My Documents | `/my-docs` | Signed lease PDF and attached documents |
| Maintenance | `/helpdesk` | Submit and track work orders |
| Apply | `/apply` | Public rental application form (no login required) |

---

## Security

- All ERPNext webhook endpoints verify **HMAC-SHA256** via `X-Frappe-Webhook-Signature`
- BoldSign webhook verified via `X-BoldSign-Signature` (`t=timestamp, s0=hex`)
- Telegram bot enforces a **static user ID allowlist** — all other messages are silently dropped
- API credentials are loaded from environment variables only — never hard-coded
- ERPNext uses **token-based auth over TLS** (`Authorization: token key:secret`)
- Tenant portal uses **ERPNext User Permission** to scope each tenant's view to
  only their own records (no cross-tenant data leakage)

---

## Documentation

| Document | Audience | Description |
|---|---|---|
| [Landlord Guide](docs/landlord-guide.md) | Property owner | Telegram bot, leases, vendors, late fees, screening |
| [Tenant Guide](docs/tenant-guide.md) | Current tenants | Portal login, paying rent, lease, documents, maintenance |
| [Applicant Guide](docs/applicant-guide.md) | Prospective tenants | How to apply, screening process, lease signing |
| [Operations Guide](docs/operations.md) | System administrator | Setup, deployment, env vars, webhook config, troubleshooting |
| [Azure CI/CD Guide](docs/azure-cicd.md) | DevOps | Terraform + AKS + GitHub Actions deployment pipeline |

---

## License

MIT
