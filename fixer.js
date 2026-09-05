require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Environment Configuration ──
const WP_URL = process.env.WP_URL || 'https://brightcelebrity.com/';
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const GSC_CREDENTIALS = process.env.GSC_CREDENTIALS;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Parses Google Service Account credentials safely from process.env.
 */
function getGscCredentials() {
  if (!GSC_CREDENTIALS) {
    console.warn('[Fixer Warning] GSC_CREDENTIALS is not set.');
    return null;
  }
  try {
    return JSON.parse(GSC_CREDENTIALS);
  } catch (err) {
    console.warn('[Fixer Warning] Failed to parse GSC_CREDENTIALS JSON:', err.message);
    return null;
  }
}

/**
 * Extracts high-level universal SEO lessons from audit issues and fixes using Gemini.
 * @param {Array} fixes - Array of audit issue objects
 * @returns {Promise<string[]>} List of concise SEO rules
 */
async function extractSeoLessons(fixes) {
  console.log('[Step 3/4] Extracting general SEO lessons for Self-Learning Memory...');

  if (!GEMINI_API_KEY) {
    console.log('  ↳ GEMINI_API_KEY not set. Using rule-based lesson extraction.');
    return fixes.map(f => `Optimize titles and metadata: ${f.seoIssue}`);
  }

  const prompt = `You are a Principal SEO Architect. Below is a set of SEO issues and suggested fixes diagnosed from an automated audit on our articles:

${JSON.stringify(fixes, null, 2)}

TASK:
Extract 3 to 5 universal, high-impact SEO rules that our automated content generation engine must strictly obey for all future articles to permanently avoid these issues.

CRITICAL RULES:
1. Each rule must be a single, direct, imperative sentence (e.g., 'Always front-load the current year into headlines for annual or time-sensitive events').
2. Make each rule universally applicable (do NOT refer to specific article IDs or specific article titles).
3. Focus on title structure, search intent, CTR power words, entity clarity, and schema markup.
4. Output STRICTLY a JSON array of strings: ["Rule 1", "Rule 2", ...] without markdown code blocks, backticks, or any other text.`;

  const fallbackModels = [
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-2.0-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-pro'
  ];

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  for (const modelName of fallbackModels) {
    try {
      console.log(`  ↳ Requesting lesson extraction with '${modelName}'...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();

      if (text.startsWith('```json')) text = text.replace(/^```json\s*/i, '');
      if (text.startsWith('```')) text = text.replace(/^```\s*/i, '');
      if (text.endsWith('```')) text = text.replace(/\s*```$/i, '');
      text = text.trim();

      const startIdx = text.indexOf('[');
      const endIdx = text.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) {
        text = text.substring(startIdx, endIdx + 1);
      }

      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`  ↳ Successfully extracted ${parsed.length} learned SEO rules.`);
        return parsed;
      }
    } catch (err) {
      console.warn(`  ↳ Model '${modelName}' failed: ${err.message}. Trying next fallback...`);
    }
  }

  // Fallback to deterministic extraction if Gemini call fails
  return fixes.map(f => `SEO Directive: ${f.suggestedFix.split('.')[0]}.`);
}

/**
 * Appends new rules into seo_memory.txt without duplicating existing entries.
 * @param {string[]} newRules - Array of rule strings
 */
function updateSeoMemory(newRules) {
  const memoryFile = 'seo_memory.txt';
  let existingLines = [];

  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, 'utf8');
    existingLines = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  }

  const existingSet = new Set(existingLines.map(l => l.toLowerCase()));
  const addedRules = [];

  for (const rule of newRules) {
    const cleaned = rule.trim().replace(/^[\*\-\d\.]+\s*/, '');
    if (cleaned && !existingSet.has(cleaned.toLowerCase())) {
      existingLines.push(cleaned);
      existingSet.add(cleaned.toLowerCase());
      addedRules.push(cleaned);
    }
  }

  const header = `# ========================================================\n# CONTINUOUS SEO MEMORY — LEARNED AUDIT DIRECTIVES\n# Automatically updated by fixer.js\n# ========================================================\n`;
  const fileContent = header + existingLines.join('\n') + '\n';

  fs.writeFileSync(memoryFile, fileContent, 'utf8');
  console.log(`  ↳ [SEO Memory] Saved ${existingLines.length} total rules (${addedRules.length} new rules added) to ${memoryFile}.`);
}

/**
 * Pings Google Search Console Indexing API with URL_UPDATED for updated articles.
 * @param {Array} fixes - Array of fixed items containing postLink
 */
async function pingIndexingApiForFixes(fixes) {
  console.log('[Step 2/4] Pinging Google Search Console Indexing API (URL_UPDATED)...');
  const credentials = getGscCredentials();
  if (!credentials) {
    console.warn('  ↳ Skipping Indexing API pings: Missing GSC credentials.');
    return;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/webmasters',
        'https://www.googleapis.com/auth/indexing'
      ]
    });

    const indexing = google.indexing({ version: 'v3', auth });

    for (const fix of fixes) {
      if (!fix.postLink) continue;

      try {
        await indexing.urlNotifications.publish({
          requestBody: {
            url: fix.postLink,
            type: 'URL_UPDATED'
          }
        });
        console.log(`  ↳ [Indexing API] ✅ Submitted URL_UPDATED for: ${fix.postLink}`);
      } catch (err) {
        console.error(`  ↳ [Indexing API Error] Failed for ${fix.postLink}: ${err.message}`);
      }
    }
  } catch (error) {
    console.error(`  ↳ [Indexing API Error] Auth failure: ${error.message}`);
  }
}

/**
 * Updates WordPress posts with the suggested titles and SEO metadata.
 * @param {Array} fixes - Array of fix objects from audit_data.json
 */
async function applyWordPressFixes(fixes) {
  console.log('[Step 1/4] Applying SEO fixes to WordPress posts...');

  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    throw new Error('Missing WordPress credentials (WP_USERNAME or WP_APP_PASSWORD).');
  }

  const wpBaseUrl = WP_URL.replace(/\/$/, '');
  const credentials = `${WP_USERNAME}:${WP_APP_PASSWORD}`;
  const token = Buffer.from(credentials).toString('base64');
  const headers = {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json'
  };

  let successCount = 0;

  for (const fix of fixes) {
    if (!fix.postId || !fix.suggestedTitle) {
      console.warn(`  ↳ Skipping invalid item: ${JSON.stringify(fix)}`);
      continue;
    }

    const endpoint = `${wpBaseUrl}/wp-json/wp/v2/posts/${fix.postId}`;
    const payload = {
      title: fix.suggestedTitle,
      meta: {
        rank_math_title: fix.suggestedTitle
      }
    };

    console.log(`\n  ↳ [Post ID: ${fix.postId}]`);
    console.log(`     Original:  "${fix.currentTitle || 'N/A'}"`);
    console.log(`     Optimized: "${fix.suggestedTitle}"`);

    try {
      await axios.post(endpoint, payload, { headers, timeout: 15000 });
      console.log(`     Status:    ✅ Updated successfully.`);
      successCount++;
    } catch (err) {
      // If meta update fails (some WP setups restrict meta schema), fallback to title-only
      try {
        await axios.post(endpoint, { title: fix.suggestedTitle }, { headers, timeout: 15000 });
        console.log(`     Status:    ✅ Updated successfully (title only fallback).`);
        successCount++;
      } catch (retryErr) {
        const detail = retryErr.response ? JSON.stringify(retryErr.response.data) : retryErr.message;
        console.error(`     Status:    ❌ Failed to update on WordPress: ${detail}`);
      }
    }
  }

  console.log(`\n  ↳ Completed: ${successCount}/${fixes.length} posts updated on WordPress.`);
}

/**
 * Main execution flow
 */
async function runFixer() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('       🚀 STARTING AI SEO FIXER & LEARNING PIPELINE     ');
  console.log('═══════════════════════════════════════════════════════');

  const auditFile = 'audit_data.json';

  if (!fs.existsSync(auditFile)) {
    console.log(`[Fixer] "${auditFile}" not found. No pending fixes to apply. Exiting.`);
    return;
  }

  let fixes = [];
  try {
    const rawData = fs.readFileSync(auditFile, 'utf8');
    const parsed = JSON.parse(rawData);
    fixes = Array.isArray(parsed) ? parsed : (parsed.auditResults || []);
  } catch (err) {
    console.error(`[Fixer Error] Could not parse "${auditFile}": ${err.message}`);
    process.exit(1);
  }

  if (fixes.length === 0) {
    console.log(`[Fixer] No actionable fixes found in "${auditFile}". Exiting.`);
    return;
  }

  console.log(`[Fixer] Loaded ${fixes.length} actionable fixes from ${auditFile}.`);

  try {
    // 1. Update posts in WordPress
    await applyWordPressFixes(fixes);

    // 2. Ping Google Indexing API
    await pingIndexingApiForFixes(fixes);

    // 3. Extract universal lessons & update seo_memory.txt
    const lessons = await extractSeoLessons(fixes);
    updateSeoMemory(lessons);

    // 4. Delete audit_data.json after successful execution
    fs.unlinkSync(auditFile);
    console.log(`[Step 4/4] ✅ Cleaned up "${auditFile}". Pipeline cycle complete.`);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('       🎉 AI SEO FIXER & SELF-LEARNING CYCLE COMPLETE   ');
    console.log('═══════════════════════════════════════════════════════');
  } catch (fatalError) {
    console.error(`[Fixer Fatal Error] ${fatalError.message}`);
    process.exit(1);
  }
}

runFixer();
