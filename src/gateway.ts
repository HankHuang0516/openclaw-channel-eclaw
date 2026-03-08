import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAccount } from './config.js';
import type { EClawAccountConfig } from './types.js';
import { EClawClient } from './client.js';
import { setClient } from './outbound.js';
import { createWebhookHandler } from './webhook-handler.js';
import { registerWebhookToken, unregisterWebhookToken } from './webhook-registry.js';

// ── Reconnect / health-check constants ───────────────────────────────────────
const HEALTH_CHECK_INTERVAL_MS = 60_000;  // re-register every 60 s to stay live
const BACKOFF_INITIAL_MS       =  5_000;  // first retry after 5 s
const BACKOFF_MAX_MS           = 300_000; // cap at 5 min
const BACKOFF_MULTIPLIER       = 2;

/** Sleep ms, but resolve early if abortSignal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Add ±20 % random jitter to reduce thundering-herd on reconnect. */
function jitter(ms: number): number {
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

/**
 * Resolve account from ctx.
 *
 * OpenClaw may pass a pre-resolved account object in ctx.account,
 * or an empty config. Fall back to reading openclaw.json from disk.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveAccountFromCtx(ctx: any): EClawAccountConfig {
  // Preferred: OpenClaw passes the resolved account in ctx.account
  if (ctx.account?.apiKey) {
    return {
      enabled: ctx.account.enabled ?? true,
      apiKey: ctx.account.apiKey,
      apiSecret: ctx.account.apiSecret,
      apiBase: (ctx.account.apiBase ?? 'https://eclawbot.com').replace(/\/$/, ''),
      entityId: ctx.account.entityId ?? 0,
      botName: ctx.account.botName,
      webhookUrl: ctx.account.webhookUrl,
    };
  }

  // Fallback: read config from disk (OpenClaw passes empty config object)
  const configPath = process.env.OPENCLAW_CONFIG_PATH
    || join(homedir(), '.openclaw', 'openclaw.json');
  let fullConfig: unknown = {};
  try {
    fullConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { /* ignore */ }
  return resolveAccount(fullConfig, ctx.accountId ?? ctx.account?.accountId);
}

/**
 * Gateway lifecycle: start an E-Claw account.
 *
 * 1. Resolve credentials from ctx.account or disk
 * 2. Register a per-session handler in the webhook-registry (served by the
 *    main OpenClaw gateway HTTP server at /eclaw-webhook — no separate port)
 * 3. Register callback URL with E-Claw backend (with exponential-backoff retry)
 * 4. Auto-bind entity if not already bound
 * 5. Periodically re-register to keep callback URL live (health check)
 * 6. On health-check failure, reconnect with exponential backoff
 * 7. Keep the promise alive until abort signal fires
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function startAccount(ctx: any): Promise<void> {
  const accountId: string = ctx.accountId ?? ctx.account?.accountId ?? 'default';
  const account = resolveAccountFromCtx(ctx);

  if (!account.enabled || !account.apiKey) {
    console.log(`[E-Claw] Account ${accountId} disabled or missing credentials, skipping`);
    return;
  }

  // Initialize HTTP client
  const client = new EClawClient(account);
  setClient(accountId, client);

  // Generate per-session callback token
  const callbackToken = randomBytes(32).toString('hex');

  // Webhook URL: account config > env var > warn
  const publicUrl = account.webhookUrl?.replace(/\/$/, '')
    || process.env.ECLAW_WEBHOOK_URL?.replace(/\/$/, '');

  if (!publicUrl) {
    console.warn(
      '[E-Claw] Webhook URL not configured. ' +
      'Run "openclaw configure" and enter your OpenClaw public URL, ' +
      'or set ECLAW_WEBHOOK_URL env var. ' +
      'Example: https://your-openclaw-domain.com'
    );
  }

  // The callback URL points to /eclaw-webhook on the main gateway HTTP server
  const callbackUrl = `${publicUrl || 'http://localhost'}/eclaw-webhook`;

  // Register handler in the per-token registry
  // Pass ctx.cfg so the handler can dispatch to the correct OpenClaw agent
  const handler = createWebhookHandler(callbackToken, accountId, ctx.cfg);
  registerWebhookToken(callbackToken, accountId, handler);
  console.log(`[E-Claw] Webhook registered at: ${callbackUrl}`);

  const signal: AbortSignal | undefined = ctx.abortSignal;

  // ── Core setup: register callback + bind entity ───────────────────────────
  /**
   * One full register+bind cycle. Returns true on success, false on failure.
   */
  async function attemptSetup(): Promise<boolean> {
    try {
      const regData = await client.registerCallback(callbackUrl, callbackToken);
      console.log(`[E-Claw][${accountId}] Registered. Device: ${regData.deviceId}, Entities: ${regData.entities.length}`);

      const entity = regData.entities.find(e => e.entityId === account.entityId);
      if (!entity?.isBound) {
        console.log(`[E-Claw][${accountId}] Entity ${account.entityId} not bound, binding...`);
        const bindData = await client.bindEntity(account.entityId, account.botName);
        console.log(`[E-Claw][${accountId}] Bound entity ${account.entityId}, publicCode: ${bindData.publicCode}`);
      } else {
        console.log(`[E-Claw][${accountId}] Entity ${account.entityId} already bound`);
        const bindData = await client.bindEntity(account.entityId, account.botName);
        console.log(`[E-Claw][${accountId}] Retrieved credentials for entity ${account.entityId}`);
        void bindData;
      }
      return true;
    } catch (err) {
      console.error(`[E-Claw][${accountId}] Setup attempt failed:`, err);
      return false;
    }
  }

  // ── Initial connect with exponential backoff ──────────────────────────────
  let backoffMs = BACKOFF_INITIAL_MS;
  let attempt = 0;

  while (!signal?.aborted) {
    attempt++;
    const ok = await attemptSetup();
    if (ok) {
      console.log(`[E-Claw][${accountId}] Account ready! (attempt #${attempt})`);
      break;
    }
    const delay = jitter(Math.min(backoffMs, BACKOFF_MAX_MS));
    console.warn(`[E-Claw][${accountId}] Retrying in ${Math.round(delay / 1000)}s (attempt #${attempt})...`);
    await sleep(delay, signal);
    backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
  }

  if (signal?.aborted) {
    unregisterWebhookToken(callbackToken);
    return;
  }

  // ── Periodic health check + auto-reconnect ────────────────────────────────
  // Re-register every 60 s. If it fails, enter a reconnect backoff loop.
  // Guard flag prevents concurrent reconnect loops from stacking.
  let isReconnecting = false;

  async function runHealthCheck(): Promise<void> {
    if (isReconnecting) return;

    try {
      await client.registerCallback(callbackUrl, callbackToken);
      // Silent success — no log spam when healthy
    } catch (err) {
      if (isReconnecting) return;
      isReconnecting = true;
      console.warn(`[E-Claw][${accountId}] Health check failed — starting reconnect loop:`, err);

      let reconnBackoff = BACKOFF_INITIAL_MS;
      let reconnAttempt = 0;

      while (!signal?.aborted) {
        reconnAttempt++;
        const delay = jitter(Math.min(reconnBackoff, BACKOFF_MAX_MS));
        console.warn(`[E-Claw][${accountId}] Reconnect attempt #${reconnAttempt} in ${Math.round(delay / 1000)}s...`);
        await sleep(delay, signal);
        if (signal?.aborted) break;

        const recovered = await attemptSetup();
        if (recovered) {
          console.log(`[E-Claw][${accountId}] Reconnected successfully after ${reconnAttempt} attempt(s)!`);
          break;
        }
        reconnBackoff = Math.min(reconnBackoff * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      }

      isReconnecting = false;
    }
  }

  const healthTimer = setInterval(() => { void runHealthCheck(); }, HEALTH_CHECK_INTERVAL_MS);

  // Keep the promise alive until abort signal fires
  return new Promise<void>((resolve) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log(`[E-Claw][${accountId}] Shutting down account`);
        clearInterval(healthTimer);
        client.unregisterCallback().catch(() => {});
        unregisterWebhookToken(callbackToken);
        resolve();
      });
    } else {
      // No abort signal — resolve immediately (should not happen in normal use)
      clearInterval(healthTimer);
      resolve();
    }
  });
}
