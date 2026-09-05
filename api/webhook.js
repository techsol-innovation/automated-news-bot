const axios = require('axios');

/**
 * Vercel Serverless Function: Telegram Webhook Handler
 * Intercepts inline keyboard button clicks and triggers GitHub Actions workflow.
 */
module.exports = async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'Telegram Webhook active. Awaiting POST requests.' });
  }

  try {
    const body = req.body || {};
    const callbackQuery = body.callback_query;

    if (callbackQuery && callbackQuery.data === 'trigger_fix') {
      const callbackQueryId = callbackQuery.id;
      const githubPat = process.env.GITHUB_PAT;
      const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

      console.log(`[Webhook] Received trigger_fix callback query (ID: ${callbackQueryId})`);

      if (!githubPat) {
        console.error('[Webhook Error] GITHUB_PAT environment variable is missing.');
        if (telegramBotToken) {
          await axios.post(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: '❌ Error: GITHUB_PAT is not configured in environment.',
            show_alert: true
          });
        }
        return res.status(200).json({ ok: false, error: 'GITHUB_PAT missing' });
      }

      // 1. Dispatch GitHub Actions workflow
      const githubDispatchUrl = 'https://api.github.com/repos/techsol-innovation/automated-news-bot/actions/workflows/seo-fixer.yml/dispatches';

      await axios.post(
        githubDispatchUrl,
        { ref: 'main' },
        {
          headers: {
            'Authorization': `Bearer ${githubPat}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Telegram-Bot'
          },
          timeout: 15000
        }
      );

      console.log('[Webhook] Successfully dispatched seo-fixer.yml on GitHub Actions.');

      // 2. Answer callback query to stop spinner and display toast
      if (telegramBotToken) {
        await axios.post(
          `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`,
          {
            callback_query_id: callbackQueryId,
            text: '✅ SEO Fixer Started in Background!',
            show_alert: false
          },
          { timeout: 10000 }
        );
      }

      return res.status(200).json({ ok: true, message: 'Workflow dispatched successfully.' });
    }

    // Acknowledge other updates from Telegram cleanly
    return res.status(200).json({ ok: true, message: 'Update received and ignored.' });
  } catch (error) {
    const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`[Webhook Error] ${errorDetails}`);

    // If possible, alert user via Telegram toast that execution failed
    try {
      const callbackQueryId = req.body?.callback_query?.id;
      const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
      if (callbackQueryId && telegramBotToken) {
        await axios.post(
          `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`,
          {
            callback_query_id: callbackQueryId,
            text: '⚠️ Failed to trigger fixer workflow. Check GitHub PAT permissions.',
            show_alert: true
          },
          { timeout: 5000 }
        );
      }
    } catch (e) {
      console.warn('[Webhook Warning] Could not send error callback response:', e.message);
    }

    return res.status(200).json({ ok: false, error: errorDetails });
  }
};
