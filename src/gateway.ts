import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAccount } from './config.js';
import type { EClawAccountConfig } from './types.js';
import { EClawClient } from './client.js';
import { setClient } from './outbound.js';
import { createWebhookHandler } from './webhook-handler.js';

/**
 * Resolve account from ctx.
 *
 * OpenClaw may pass a pre-resolved account object in ctx.account,
 * or an empty config. Fall back to reading openclaw.json from disk.
 */
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
 * 2. Start a local HTTP server to receive webhook callbacks
 * 3. Register callback URL with E-Claw backend
 * 4. Auto-bind entity if not already bound
 * 5. Keep the promise alive until abort signal fires
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
  const webhookPort = parseInt(process.env.ECLAW_WEBHOOK_PORT || '0') || 0;
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

  // Create webhook handler
  const handler = createWebhookHandler(callbackToken, accountId);

  // Parse JSON body for incoming requests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestHandler = (req: IncomingMessage, res: ServerResponse & { end: any }) => {
    if (req.method === 'POST' && req.url?.startsWith('/eclaw-webhook')) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).body = JSON.parse(body);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).body = {};
        }
        handler(req, res);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };

  const server = createServer(requestHandler);

  return new Promise<void>((resolve) => {
    server.listen(webhookPort, async () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : webhookPort;
      const baseUrl = publicUrl || `http://localhost:${actualPort}`;
      const callbackUrl = `${baseUrl}/eclaw-webhook`;

      console.log(`[E-Claw] Webhook server listening on port ${actualPort}`);
      console.log(`[E-Claw] Callback URL: ${callbackUrl}`);

      try {
        // Register callback with E-Claw backend
        const regData = await client.registerCallback(callbackUrl, callbackToken);
        console.log(`[E-Claw] Registered with E-Claw. Device: ${regData.deviceId}, Entities: ${regData.entities.length}`);

        // Auto-bind entity if not already bound
        const entity = regData.entities.find(e => e.entityId === account.entityId);
        if (!entity?.isBound) {
          console.log(`[E-Claw] Entity ${account.entityId} not bound, binding...`);
          const bindData = await client.bindEntity(account.entityId, account.botName);
          console.log(`[E-Claw] Bound entity ${account.entityId}, publicCode: ${bindData.publicCode}`);
        } else {
          console.log(`[E-Claw] Entity ${account.entityId} already bound`);
          const bindData = await client.bindEntity(account.entityId, account.botName);
          console.log(`[E-Claw] Retrieved credentials for entity ${account.entityId}`);
          void bindData;
        }

        console.log(`[E-Claw] Account ${accountId} ready!`);
      } catch (err) {
        console.error(`[E-Claw] Setup failed for account ${accountId}:`, err);
      }
    });

    // Cleanup on abort
    const signal: AbortSignal | undefined = ctx.abortSignal;
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log(`[E-Claw] Shutting down account ${accountId}`);
        client.unregisterCallback().catch(() => {});
        server.close();
        resolve();
      });
    }
  });
}
