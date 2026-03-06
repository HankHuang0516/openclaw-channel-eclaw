import type { EClawInboundMessage } from './types.js';
import { getPluginRuntime } from './runtime.js';
import { getClient } from './outbound.js';

/**
 * Create an HTTP request handler for inbound messages from E-Claw.
 *
 * When a user sends a message on E-Claw, the backend POSTs structured JSON
 * to this webhook. We normalize it into OpenClaw's native PascalCase context
 * format and dispatch to the agent via dispatchReplyWithBufferedBlockDispatcher.
 *
 * The `deliver` callback sends the AI reply back to E-Claw via the API client.
 */
export function createWebhookHandler(
  expectedToken: string,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cfg: any    // full openclaw config (ctx.cfg from startAccount)
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (req: any, res: any): Promise<void> => {
    // Verify callback token
    const authHeader = req.headers?.authorization as string | undefined;
    if (expectedToken && (!authHeader || authHeader !== `Bearer ${expectedToken}`)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const msg: EClawInboundMessage = req.body;

    // ACK immediately so E-Claw doesn't time out
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // Dispatch to OpenClaw agent
    try {
      const rt = getPluginRuntime();
      const client = getClient(accountId);
      const conversationId = msg.conversationId || `${msg.deviceId}:${msg.entityId}`;

      // Map E-Claw media type to OpenClaw media type
      const ocMediaType = msg.mediaType === 'photo' ? 'image'
        : msg.mediaType === 'voice' ? 'audio'
        : msg.mediaType === 'video' ? 'video'
        : msg.mediaType ? 'file'
        : undefined;

      // Build context in OpenClaw's native PascalCase format
      // (same convention as Telegram/LINE/WhatsApp channels)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inboundCtx: any = {
        Surface: 'eclaw',
        Provider: 'eclaw',
        OriginatingChannel: 'eclaw',
        AccountId: accountId,
        From: msg.from,
        To: conversationId,
        OriginatingTo: msg.from,
        SessionKey: conversationId,
        Body: msg.text || '',
        RawBody: msg.text || '',
        CommandBody: msg.text || '',
        ChatType: 'direct',
        ...(ocMediaType && msg.mediaUrl ? {
          MediaType: ocMediaType,
          MediaUrl: msg.mediaUrl,
        } : {}),
      };

      const ctxPayload = rt.channel.reply.finalizeInboundContext(inboundCtx);

      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          deliver: async (payload: any) => {
            if (!client) return;
            const text = typeof payload.text === 'string' ? payload.text.trim() : '';
            if (text) {
              await client.sendMessage(text, 'IDLE');
            } else if (payload.mediaUrl) {
              const rawType = typeof payload.mediaType === 'string' ? payload.mediaType : '';
              const mediaType = rawType === 'image' ? 'photo'
                : rawType === 'audio' ? 'voice'
                : rawType === 'video' ? 'video'
                : 'file';
              await client.sendMessage('', 'IDLE', mediaType, payload.mediaUrl);
            }
          },
          onError: (err: unknown) => {
            console.error('[E-Claw] Reply delivery error:', err);
          },
        },
      });
    } catch (err) {
      console.error('[E-Claw] Webhook dispatch error:', err);
    }
  };
}
