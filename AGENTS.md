# Repository Guidelines

## Project Structure & Module Organization
Core runtime code lives in `src/`:
- `src/index.js` bootstraps webhook server, Telegram bot, and cron jobs.
- `src/api/`, `src/webhook/`, `src/telegram/`, `src/automation/`, `src/sms/`, and `src/ai/` hold integration and feature modules.
- `src/admin.html` is the lightweight admin UI.

Tests are in `tests/` and follow `*.test.js` naming. Operational and user docs are in `docs/`. Automation/setup scripts are in `scripts/`. Integration flow JSON files are in `make-flows/`.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run dev` starts local development with `nodemon`.
- `npm start` runs the production entrypoint (`node src/index.js`).
- `npm test` runs Jest with coverage output in `coverage/`.
- `npm run test:watch` runs tests in watch mode.
- `npm run lint` runs ESLint on `src/**/*.js` and `tests/**/*.js`.
- `npm run setup:erpnext`, `npm run setup:scripts`, `npm run setup:portal` configure ERPNext and portal resources.

## Coding Style & Naming Conventions
Use CommonJS (`require/module.exports`), `'use strict';`, semicolons, and 2-space indentation. Prefer small, focused modules by domain folder (`webhook`, `telegram`, etc.).

Use:
- `camelCase` for variables/functions
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for environment constants
- Descriptive filenames by responsibility (for example, `dispatcher.js`, `handlers.js`)

Run `npm run lint` before opening a PR.

## Testing Guidelines
Framework: Jest (`tests/setup.js` is preloaded). Place tests under `tests/` with `*.test.js` suffix. Keep unit tests close to behavior boundaries (API clients, webhook handlers, scheduler logic) and add integration coverage for external-service flows when touched.

No enforced coverage threshold is configured; maintain or improve coverage for changed modules.

## Commit & Pull Request Guidelines
Recent history uses concise, imperative commits and frequent Conventional Commit prefixes (for example, `feat:`, `fix:`, `test:`). Follow that style.

PRs should include:
- Clear summary of behavior changes
- Linked issue/PR context when applicable
- Test evidence (`npm test`, `npm run lint`)
- Screenshots or sample payloads for UI/webhook/API behavior changes

Keep PR scope focused and avoid unrelated refactors.
