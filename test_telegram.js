require('dotenv').config();
const axios = require('axios');

async function testTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHANNEL_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID in .env file');
    process.exit(1);
  }

  const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  console.log(`Attempting to post to Telegram channel: ${process.env.TELEGRAM_CHANNEL_ID}`);
  
  try {
    const response = await axios.post(telegramApiUrl, {
      chat_id: process.env.TELEGRAM_CHANNEL_ID,
      text: '🔔 <b>Test Message from Bot</b>',
      parse_mode: 'HTML'
    });
    
    console.log('✅ Successfully broadcasted test message!');
    console.log('Response ID:', response.data.result.message_id);
  } catch (err) {
    const apiErr = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
    console.error('❌ Telegram API Error:\n', apiErr);
  }
}

testTelegram();
