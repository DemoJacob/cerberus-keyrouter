import { getSetting } from './config-db.js';

function getTelegramConfig(): { botToken: string | null; chatId: string | null } {
  return {
    botToken: getSetting('telegram_bot_token') || null,
    chatId: getSetting('telegram_chat_id') || null,
  };
}

async function sendMessage(text: string): Promise<boolean> {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      console.warn('[telegram] Failed to send message:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[telegram] Send error:', (err as Error).message);
    return false;
  }
}

export async function notifyUnlockNeeded(accountEmail: string): Promise<void> {
  await sendMessage(
    `🔐 <b>Cerberus: Vault Unlock Needed</b>\n\n` +
    `Account <code>${escapeHtml(accountEmail)}</code> needs to be unlocked.\n\n` +
    `Please open the Approve page and enter the master password.`
  );
}

export async function notifySystemRestarted(accountCount: number): Promise<void> {
  if (accountCount === 0) return;
  await sendMessage(
    `🔄 <b>Cerberus Restarted</b>\n\n` +
    `${accountCount} advanced-mode account(s) need unlocking.\n\n` +
    `Please open the Approve page to unlock.`
  );
}

export async function notifyLoginApproval(vaultItem: string, code: string, accountEmail: string): Promise<void> {
  await sendMessage(
    `🔑 <b>Cerberus: Login Approval</b>\n\n` +
    `Account: <code>${escapeHtml(accountEmail)}</code>\n` +
    `Vault item: <b>${escapeHtml(vaultItem)}</b>\n` +
    `Approval code: <code>${code}</code>\n\n` +
    `⏱ You have <b>50 seconds</b> to enter this code in the Approve page.`
  );
}

export async function notifyLoginResult(vaultItem: string, approved: boolean): Promise<void> {
  const emoji = approved ? '✅' : '❌';
  const status = approved ? 'Approved' : 'Denied/Expired';
  await sendMessage(`${emoji} Login for <b>${escapeHtml(vaultItem)}</b>: ${status}`);
}

export async function testNotification(): Promise<{ ok: boolean; message: string }> {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) {
    return { ok: false, message: 'Telegram bot token or chat ID not configured' };
  }
  const sent = await sendMessage('✅ <b>Cerberus: Test Notification</b>\n\nTelegram integration is working!');
  return sent
    ? { ok: true, message: 'Test message sent successfully' }
    : { ok: false, message: 'Failed to send message. Check bot token and chat ID.' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
