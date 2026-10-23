require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

async function testTwitter() {
  if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET || !process.env.TWITTER_ACCESS_TOKEN || !process.env.TWITTER_ACCESS_SECRET) {
    console.error('❌ Missing Twitter API credentials in .env file');
    process.exit(1);
  }

  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });

  try {
    console.log('Attempting to post to Twitter...');
    const response = await client.v2.tweet("🚀 Test tweet from BrightCelebrity Automated Bot!");
    console.log('✅ Tweet posted successfully!');
    console.log('Response:', response);
  } catch (err) {
    console.error('❌ Twitter API Error:');
    if (err.response && err.response.data) {
      console.error(JSON.stringify(err.response.data, null, 2));
    } else if (err.data) {
      console.error(JSON.stringify(err.data, null, 2));
    } else {
      console.error(err);
    }
  }
}

testTwitter();
