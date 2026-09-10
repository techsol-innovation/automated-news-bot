require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

async function diagnoseIndexing() {
  console.log('--- Phase 4c: GSC URL Inspection Diagnostic ---');
  if (!process.env.WP_URL || !process.env.GSC_CREDENTIALS) {
    console.error('❌ Missing WP_URL or GSC_CREDENTIALS in .env file.');
    process.exit(1);
  }

  const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');
  const gscSiteUrl = process.env.WP_URL; // GSC expects exact domain match (usually with trailing slash)

  // 1. Fetch the 10 most recent post URLs from WordPress
  console.log('\n🔍 Fetching the 10 most recent published posts from WordPress...');
  let recentUrls = [];
  try {
    const getHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
    };
    const resp = await axios.get(`${wpBaseUrl}/wp-json/wp/v2/posts?per_page=10&_fields=id,link,title&_nocache=${Date.now()}`, { 
      headers: getHeaders, 
      timeout: 15000 
    });
    
    recentUrls = resp.data.map(post => post.link);
    console.log(`✅ Found ${recentUrls.length} recent URLs.`);
  } catch (error) {
    console.error(`❌ Failed to fetch from WordPress: ${error.message}`);
    process.exit(1);
  }

  if (recentUrls.length === 0) {
    console.log('⚠️ No posts found to inspect.');
    process.exit(0);
  }

  // 2. Authenticate with GSC
  console.log('\n🔑 Authenticating with Google Search Console API...');
  let authClient;
  try {
    const credentials = JSON.parse(process.env.GSC_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/webmasters.readonly']
    });
    authClient = await auth.getClient();
    google.options({ auth: authClient });
    console.log('✅ Successfully authenticated.');
  } catch (error) {
    console.error(`❌ Authentication failed: ${error.message}`);
    process.exit(1);
  }

  const searchconsole = google.searchconsole('v1');

  // 3. Inspect URLs
  console.log('\n📡 Inspecting URLs via GSC URL Inspection API...');
  console.log('-------------------------------------------------------------------------');
  
  for (let i = 0; i < recentUrls.length; i++) {
    const url = recentUrls[i];
    try {
      const response = await searchconsole.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: url,
          siteUrl: gscSiteUrl,
          languageCode: 'en-US'
        }
      });

      const result = response.data.inspectionResult.indexStatusResult;
      const coverageState = result.coverageState || 'Unknown Coverage State';
      const lastCrawlTime = result.lastCrawlTime || 'Never Crawled';
      const verdict = result.verdict || 'Unknown';

      console.log(`URL ${i + 1}: ${url}`);
      console.log(`  ↳ Verdict       : ${verdict}`);
      console.log(`  ↳ Coverage      : ${coverageState}`);
      console.log(`  ↳ Last Crawled  : ${lastCrawlTime}`);
      console.log('-------------------------------------------------------------------------');
    } catch (error) {
      console.error(`URL ${i + 1}: ${url}`);
      // GSC API errors are often nested in error.response.data
      const apiErr = error.response?.data?.error?.message || error.message;
      console.error(`  ❌ API Error: ${apiErr}`);
      console.log('-------------------------------------------------------------------------');
    }
    
    // GSC URL Inspection API has a quota limit (usually ~2000 per day, but rate limits per minute can apply). 
    // Wait 1.5s between requests to be safe.
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n✅ Diagnostic complete.');
}

diagnoseIndexing().catch(console.error);
