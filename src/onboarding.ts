import { listAccountIds, resolveAccount } from './config.js';

const DEFAULT_ACCOUNT_ID = 'main';

export const eclawOnboardingAdapter = {
  channel: 'eclaw',

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStatus: async ({ cfg }: { cfg: any }) => {
    const ids = listAccountIds(cfg);
    const configured = ids.some((id: string) => {
      const acc = resolveAccount(cfg, id);
      return Boolean(acc.apiKey && acc.apiSecret);
    });
    return {
      channel: 'eclaw',
      configured,
      statusLines: [`E-Claw: ${configured ? 'configured ✓' : 'not configured'}`],
      selectionHint: configured ? 'configured' : 'E-Claw (AI Live Wallpaper Chat)',
      quickstartScore: configured ? 1 : 3,
    };
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configure: async ({ cfg, prompter }: { cfg: any; prompter: any }) => {
    const accountId = DEFAULT_ACCOUNT_ID;
    const resolved = resolveAccount(cfg, accountId);

    await prompter.note(
      [
        '前往 https://eclawbot.com 登入',
        '進入 Portal → 設定 → Channel API',
        '建立 API Key 和 API Secret，填入下方',
      ].join('\n'),
      'E-Claw 設定說明',
    );

    const apiKey = await prompter.text({
      message: 'Channel API Key',
      placeholder: 'eck_...',
      initialValue: resolved.apiKey || '',
      validate: (v: string) => (String(v ?? '').trim() ? undefined : '必填'),
    });

    const apiSecret = await prompter.text({
      message: 'Channel API Secret',
      placeholder: 'ecs_...',
      initialValue: resolved.apiSecret || '',
      validate: (v: string) => (String(v ?? '').trim() ? undefined : '必填'),
    });

    const entityIdStr = await prompter.text({
      message: 'Entity ID (0–3)',
      placeholder: '0',
      initialValue: String(resolved.entityId ?? 0),
      validate: (v: string) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 3 ? undefined : '請輸入 0–3';
      },
    });

    const botName = await prompter.text({
      message: 'Bot 顯示名稱（選填）',
      placeholder: 'My Bot',
      initialValue: resolved.botName ?? '',
    });

    const nextCfg = {
      ...cfg,
      channels: {
        ...(cfg.channels ?? {}),
        eclaw: {
          ...(cfg.channels?.eclaw ?? {}),
          accounts: {
            ...((cfg.channels?.eclaw as any)?.accounts ?? {}),  // eslint-disable-line @typescript-eslint/no-explicit-any
            [accountId]: {
              apiKey: String(apiKey).trim(),
              apiSecret: String(apiSecret).trim(),
              apiBase: resolved.apiBase || 'https://eclawbot.com',
              entityId: Number(entityIdStr),
              botName: String(botName).trim() || undefined,
              enabled: true,
            },
          },
        },
      },
    };

    return { cfg: nextCfg, accountId };
  },
};
