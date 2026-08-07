require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createCanvas, loadImage } = require('canvas');
const FormData = require('form-data');

// Initialize Gemini client and model
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

// Category ID mapping for WordPress REST API
const CATEGORY_MAP = {
  sports: 2,
  entertainment: 3
};

// Global in-memory cache for taxonomies
const wpCategoriesMap = new Map(); // name (lowercase) -> id
const wpTagsMap = new Map(); // name (lowercase) -> id

/**
 * Preloads all existing categories and tags from WordPress into local memory.
 */
async function preloadWordPressTaxonomies() {
  console.log('[Info] Preloading WordPress taxonomies into memory...');
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }
    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = { 'Authorization': `Basic ${token}` };
    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    const [catResp, tagResp] = await Promise.all([
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/categories?per_page=100`, { headers }),
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/tags?per_page=100`, { headers })
    ]);

    const categories = catResp.data || [];
    categories.forEach(cat => wpCategoriesMap.set(cat.name.toLowerCase(), cat.id));

    const tags = tagResp.data || [];
    tags.forEach(tag => wpTagsMap.set(tag.name.toLowerCase(), tag.id));

    console.log(`[Info] Preloaded ${wpCategoriesMap.size} categories and ${wpTagsMap.size} tags.`);
  } catch (error) {
    console.error(`[Error] Failed to preload taxonomies: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Helper function to pause execution for a given number of milliseconds
 * @param {number} ms - Milliseconds to delay
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Scrapes the text content of a single news article URL using axios and cheerio.
 * Selects all <p> (paragraph) tags and returns the clean text and word count.
 * @param {string} url - The article URL to visit
 * @returns {Promise<{text: string, wordCount: number, status: string, image1: string, image2: string}>}
 */
async function scrapeArticleText(url) {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const $ = cheerio.load(response.data);

    // Extract main Open Graph image BEFORE removing DOM elements
    const image1 = $('meta[property="og:image"]').attr('content') || '';
    
    // Extract body images (up to 4 valid distinct images)
    const bodyImages = [];
    $('img').each((_, element) => {
      let src = $(element).attr('src');
      if (src && !src.startsWith('data:image') && !src.includes('pixel') && !src.includes('icon') && !bodyImages.includes(src)) {
        bodyImages.push(src);
      }
    });
    
    // Keep at most 4 body images
    const finalBodyImages = bodyImages.slice(0, 4);

    // Remove irrelevant elements before extracting paragraph text
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extract text from all <p> tags
    const paragraphs = [];
    $('p').each((_, element) => {
      const text = $(element).text().trim();
      if (text.length > 20) {
        paragraphs.push(text);
      }
    });

    const fullText = paragraphs.join('\n\n');
    const wordCount = fullText ? fullText.split(/\s+/).filter(Boolean).length : 0;
    
    const status = wordCount >= 500 
      ? `Meets requirement (${wordCount} words >= 500)` 
      : `Under 500 words (${wordCount} words)`;

    return { text: fullText, wordCount, status, image1, bodyImages: finalBodyImages };
  } catch (error) {
    const errMsg = error.response 
      ? `HTTP Status ${error.response.status} (${error.response.statusText})` 
      : error.message;
    return { 
      text: `[Failed to scrape article from ${url}: ${errMsg}]`, 
      wordCount: 0, 
      status: `Error: ${errMsg}`,
      image1: '',
      bodyImages: []
    };
  }
}

/**
 * Sends combined scraped text to Gemini to generate 2 distinct SEO-optimized articles with category names.
 * @param {string} topicTitle - The name/title of the trending topic
 * @param {string} scrapedText - Combined text scraped from associated articles
 * @returns {Promise<string>} The generated response text from Gemini
 */
async function generateArticles(topicTitle, scrapedText) {
  const prompt = `You are an elite Copywriter and Senior Editor. Your goal is to maximize traffic, reader retention, and search engine rankings using psychological triggers and the 7 C's of communication.
I have scraped news about the trending topic: "${topicTitle}". Extracted text:
${scrapedText}

Write a high-quality news article based on the provided text.

STRICT INSTRUCTIONS:
- Keyword Generation First: Generate a strict 1-2 word focus_keyword.
- Forced Exact String Match (Zero Tolerance): You MUST use this EXACT 1-2 word string, character-for-character, in:
  1. title: MUST contain a Number (e.g., 5, 7) and a Power Word (e.g., Shocking, Massive, Ultimate). The title MUST strictly start with the exact focus_keyword, followed by a colon (:). Example Format: '[Focus Keyword]: 7 [Power Word] Secrets Behind This [Sentiment Word] Event'.
  2. seo_description: The very first words of this description MUST be the exact focus_keyword. The description MUST be strictly between 120 and 160 characters long.
  3. slug: The URL slug MUST contain the exact focus_keyword (lowercase, hyphenated).
  4. content: Ensure the exact focus_keyword appears naturally in the very first sentence of the HTML content (First 10% rule).
- Content Expansion Blueprint (To force 1500+ words): CRITICAL SEO RULE: You MUST write a comprehensive, highly detailed article that is strictly OVER 1500 words long. Expand on sections with deep analysis, trivia, and background information to ensure the word count is met. To achieve this, you MUST structure the HTML with exactly 5 to 6 distinct <h2> headings. Under EACH <h2> heading, you MUST write at least 6 detailed paragraphs or use <h3> sub-sections.
- Keyword Density Enforcer: Maintain a natural keyword density of strictly 1% to 1.5%. Do not repeat the focus keyword more than 15 times in the entire article. Overusing the keyword will result in a penalty.
- SEO Linking & Formatting Rules: Embed exactly one EXTERNAL link to a high-authority site (like Wikipedia, Reuters, or a major news outlet) in the content using proper <a> tags. The generated HTML must contain exactly one internal link to https://brightcelebrity.com/ using descriptive anchor text (not 'click here') embedded within the body paragraphs. Ensure the focus keyword is bolded <strong> at least twice in the article.
- HEADING STRUCTURE (CRITICAL): NEVER use an <h1> tag. Your main headings MUST be <h2>, and sub-sections MUST be <h3>. All <h2> and <h3> headings MUST be extremely concise, punchy, and engaging (maximum 3 to 6 words). NEVER write full sentences as headings. Naturally include the exact focus keyword in exactly 1 or 2 of the <h2> headings. Do not stuff the keyword into every single heading.
- THE ENGAGEMENT HOOK: Start the very first paragraph with a strong 'hook'—a shocking fact, a provocative question, or a bold statement to immediately grab the reader's attention. Address the reader directly using 'You' more than 'I' or 'We'.
- RICH MICRO-FORMATTING: Break up the text to make it highly scannable. Use the <strong> tag generously to bold celebrity names, important dates, financial figures, and key locations within the paragraphs. Keep paragraphs strictly to 2-3 sentences max. Ensure zero fluff and remove filler words.
- STRICT ANTI-AI TONE: You are strictly forbidden from using robotic AI transition words. NEVER use phrases like 'In conclusion', 'Moreover', 'Furthermore', 'Delving into', 'It is important to note', or 'A tapestry of'. Write in a punchy, journalistic, and conversational tone typical of top-tier US entertainment magazines.
- Concreteness & Correctness: Use specific data, clear facts, and sensory words. Ensure flawless grammar and a highly readable layout.
- PREMIUM TABLE STYLING: Whenever you generate an HTML table, you MUST NOT output a plain <table> tag. You must inject premium inline CSS exactly like this: <table style="width: 100%; border-collapse: collapse; margin: 25px 0; font-size: 1em; font-family: sans-serif; box-shadow: 0 0 20px rgba(0, 0, 0, 0.15);">. The table header must be styled like this: <thead style="background-color: #2c3e50; color: #ffffff; text-align: left;">. And add this inline style to all <th> and <td> tags: style="padding: 12px 15px; border-bottom: 1px solid #dddddd;".
- STRICT ARTICLE TEMPLATE: To maintain a consistent 95+ SEO score, you MUST follow this exact HTML structure for EVERY article:
  Introduction: 2-3 short paragraphs containing the exact focus keyword in the first sentence.
  H2: [Catchy Section Title with Focus Keyword] -> Followed by detailed paragraphs.
  H3: [Sub-topic] -> Followed by bullet points.
  H2: [Data/Stats Section Title] -> Followed by the newly styled premium HTML table.
  H2: [Final Thoughts / Conclusion] -> Summarize and naturally include the focus keyword one last time.
- Meaningful Lists: Use bullet points (<ul>) or numbered lists (<ol>) ONLY when breaking down complex ideas, itemizing facts, or listing achievements. Do not use them just for the sake of having a list.
- Smart Image Placement & MULTI-IMAGE ALT TAGS: You must dynamically and organically insert multiple image placeholders: [INJECT_IMAGE_2_HERE], [INJECT_IMAGE_3_HERE], [INJECT_IMAGE_4_HERE], and [INJECT_IMAGE_5_HERE] throughout the HTML content. Place them where visual breaks make editorial sense (e.g. after a major H2 tag). Do NOT use generic <img> tags, ONLY use the exact string placeholders.
- Alt Tags generation: You must generate a JSON array named body_image_alt_tags containing 4 strings. These strings must be highly descriptive, long-tail variations of the focus keyword to be used as alt text for the images.
- Courtesy (Tone): Maintain a highly helpful, engaging, and welcoming tone.
- Tags: Generate a JSON array named tags containing exactly 15 to 20 highly specific, long-tail SEO tags relevant to the article. Mix entity names, trending search queries (like 'Net Worth 2026'), associated people, and specific events. Do NOT use generic one-word tags. Integrate these naturally into the body text.
- Category: Analyze the article and return TWO category fields: parent_category (string, e.g., 'Sports', 'Entertainment') and sub_categories (An ARRAY of strings). You MUST dynamically decide how many sub-categories are relevant.
- Slug: Generate a slug (URL-friendly string, lowercase, hyphen-separated) that MUST contain the exact focus_keyword.
- Thumbnail Text: Generate a short, highly engaging text specifically for an image overlay. It MUST be extremely short: Maximum 3 to 5 words. It MUST be highly engaging, clickbaity, and use a power word (e.g., 'Shocking Truth Revealed!', 'Must See Details!', 'Hidden Secrets!'). It should summarize the core emotion or shock-value of the article.

CRITICAL OUTPUT REQUIREMENT: You MUST return ONLY valid JSON formatted strictly as follows, without any markdown backticks, explanations, or extra text. NEVER use literal \n or \r characters in the content string. Use proper HTML tags like <p> and <br> for spacing:
{
  "title": "Simple direct headline",
  "content": "Full HTML article body text following the formatting rules...",
  "parent_category": "Broad Category (e.g., Sports, Entertainment)",
  "sub_categories": ["Sub-category 1", "Sub-category 2"],
  "focus_keyword": "single-strong-keyword",
  "slug": "url-friendly-slug-with-keyword",
  "tags": ["Highly Specific Tag 1", "Person Net Worth 2026", "Associated Event 2026", "Trending Search Query 4"],
  "seo_description": "A compelling meta description",
  "thumbnail_text": "Shocking Truth Revealed!",
  "body_image_alt_tags": ["long-tail-alt-1", "long-tail-alt-2", "long-tail-alt-3", "long-tail-alt-4"]
}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error(`[Gemini Error] Primary model failed for "${topicTitle}": ${error.message || error}`);
    
    // Autonomous problem solving: retry across active fallback models with backoff
    const fallbackModels = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'];
    
    for (const modelName of fallbackModels) {
      console.log(`[Gemini Fallback] Retrying generation with model '${modelName}'...`);
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fallbackModel = genAI.getGenerativeModel({ model: modelName });
          const fallbackResult = await fallbackModel.generateContent(prompt);
          return fallbackResult.response.text();
        } catch (err) {
          if (err.message && (err.message.includes('503') || err.message.includes('429') || err.message.includes('high demand'))) {
            if (attempt < maxRetries) {
              const waitTime = 2000 * Math.pow(2, attempt - 1);
              await delay(waitTime);
              continue;
            }
          } else if (err.message && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('not supported'))) {
            break;
          }
          if (attempt === maxRetries) {
            break;
          }
        }
      }
    }
    throw new Error(`Failed to generate articles after retrying all fallback models: ${error.message || error}`);
  }
}

/**
 * Fetches top trending US Sports and Entertainment news from NewsData.io API using axios.
 * Filters to keep only articles where image_url is NOT null, extracting top 3 Sports and top 2 Entertainment.
 * @returns {Promise<Array<{title: string, link: string, snippet: string, image_url: string, category: string}>>}
 */
async function getCombinedEntertainmentAndSportsTrends() {
  console.log(`[Info] Fetching US Sports and Entertainment news from NewsData.io API...`);
  
  try {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
      throw new Error("NEWSDATA_API_KEY is not defined in process.env");
    }

    const sportsUrl = `https://newsdata.io/api/1/news?apikey=${apiKey}&country=us&category=sports`;
    const entUrl = `https://newsdata.io/api/1/news?apikey=${apiKey}&country=us&category=entertainment`;

    const [sportsResp, entResp] = await Promise.all([
      axios.get(sportsUrl, { timeout: 15000 }),
      axios.get(entUrl, { timeout: 15000 })
    ]);

    const sportsResults = sportsResp.data?.results || [];
    const entResults = entResp.data?.results || [];

    // Filter the results array to keep only articles where image_url is NOT null
    const sportsFiltered = sportsResults.filter(item => item && item.image_url !== null && item.image_url !== undefined && item.image_url !== '');
    const entFiltered = entResults.filter(item => item && item.image_url !== null && item.image_url !== undefined && item.image_url !== '');

    // Extract top 5 articles for Sports and top 5 for Entertainment
    const sportsTopics = sportsFiltered.slice(0, 5).map(item => ({
      title: item.title || 'Unknown Sports Topic',
      link: item.link || '',
      snippet: item.description || item.content || item.title,
      image_url: item.image_url,
      category: 'sports'
    }));

    const entTopics = entFiltered.slice(0, 5).map(item => ({
      title: item.title || 'Unknown Entertainment Topic',
      link: item.link || '',
      snippet: item.description || item.content || item.title,
      image_url: item.image_url,
      category: 'entertainment'
    }));

    const combined = [...sportsTopics, ...entTopics];
    console.log(`[Info] Successfully retrieved ${combined.length} valid topics (${sportsTopics.length} Sports, ${entTopics.length} Entertainment).`);
    return combined;
  } catch (error) {
    const errMsg = error.response?.data?.results?.message || error.response?.data?.message || error.message;
    console.error(`[Error] Failed to fetch NewsData.io API: ${errMsg}`);
    process.exit(1);
    return [];
  }
}

/**
 * Helper function to get an existing WordPress category ID by name, or create it if not found.
 * Uses global wpCategoriesMap for in-memory caching to optimize performance.
 * @param {string} categoryName - The name of the category (e.g., 'Football', 'Hollywood')
 * @param {number} parentId - The parent category ID (0 for no parent)
 * @returns {Promise<number|null>} The WordPress category ID
 */
async function getOrCreateCategory(categoryName, parentId = 0) {
  try {
    if (!categoryName) return null;
    const cleanName = categoryName.trim();
    if (!cleanName) return null;

    const lowerName = cleanName.toLowerCase();
    
    // Check in-memory cache first
    if (wpCategoriesMap.has(lowerName)) {
      return wpCategoriesMap.get(lowerName);
    }

    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json'
    };

    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    // If no match found, make POST request to create it
    console.log(`  ↳ Category "${cleanName}" not found on WordPress. Creating new category...`);
    const createUrl = `${wpBaseUrl}/wp-json/wp/v2/categories`;
    const postResp = await axios.post(createUrl, { name: cleanName, parent: parentId }, { headers });
    
    if (postResp.data && postResp.data.id) {
      console.log(`  ↳ ✅ Created new category "${cleanName}" (ID: ${postResp.data.id})`);
      // Immediately update local memory
      wpCategoriesMap.set(lowerName, postResp.data.id);
      return postResp.data.id;
    }

    return null;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Category Error] Failed getOrCreateCategory for "${categoryName}": ${errDetail}`);
    return null;
  }
}

/**
 * Processes a single topic: scrapes, generates article, and publishes to WordPress.
 * Designed to be run in parallel.
 * @param {Object} item - The topic object from NewsData
 * @param {number} index - Index for logging
 * @returns {Promise<Object|null>} The structured result or null on failure
 */
async function processAndPublishArticle(item, index) {
  console.log(`[Topic Process ${index}] Processing: "${item.title}"`);
  
  try {
    if (!item.link) {
      console.log(`  ↳ [Topic ${index}] Skipped: No valid source URL.`);
      return null;
    }

    console.log(`  ↳ [Topic ${index}] Scraping source URL via Cheerio...`);
    const scraped = await scrapeArticleText(item.link);
    console.log(`  ↳ [Topic ${index}] Scraped ${scraped.wordCount} words (${scraped.status}).`);

    const rawText = (scraped.wordCount > 0 && scraped.text) ? scraped.text : (item.snippet || item.title);
    const combinedText = `--- ARTICLE: ${item.title} (${item.link}) ---\n${rawText}`;
    
    console.log(`  ↳ [Topic ${index}] Generating SEO article via Gemini AI...`);
    console.log("Step 3: Generating Article with Gemini AI...");
    const generatedOutput = await generateArticles(item.title, combinedText);

    // Parse Gemini JSON output
    let parsedGemini = {};
    try {
      let cleanedJsonStr = generatedOutput.replace(/```json/gi, '').replace(/```/gi, '').trim();
      // Safely replace unescaped control characters with spaces to prevent JSON.parse from failing
      cleanedJsonStr = cleanedJsonStr.replace(/[\n\r\t]/g, ' ');
      const firstBrace = cleanedJsonStr.indexOf('{');
      const lastBrace = cleanedJsonStr.lastIndexOf('}');
      const jsonSubstring = (firstBrace !== -1 && lastBrace !== -1) 
        ? cleanedJsonStr.slice(firstBrace, lastBrace + 1) 
        : cleanedJsonStr;
      parsedGemini = JSON.parse(jsonSubstring);
    } catch (err) {
      console.warn(`  ↳ [Topic ${index}] [Warning] Could not parse Gemini output as JSON directly. Attempting fallback text parsing...`);
      parsedGemini = { 
        title: `${item.title}`, 
        content: generatedOutput, 
        parent_category: item.category || 'General', 
        sub_categories: ['News'], 
        focus_keyword: item.title, 
        tags: [item.title],
        thumbnail_text: 'Must See Details!' 
      };
    }

    const parentCategory = parsedGemini?.parent_category || item.category || 'General';
    const subCategories = Array.isArray(parsedGemini?.sub_categories) ? parsedGemini.sub_categories : ['News'];

    // Structure into the final result object using NewsData.io original image_url
    const topicResult = {
      topic: item.title,
      title: parsedGemini?.title || `${item.title}`,
      content: parsedGemini?.content || '',
      image1: item.image_url || '',
      bodyImages: (scraped.wordCount > 0 && Array.isArray(scraped.bodyImages) && scraped.bodyImages.length > 0) ? scraped.bodyImages : [item.image_url],
      bodyImageAltTags: Array.isArray(parsedGemini?.body_image_alt_tags) ? parsedGemini.body_image_alt_tags : [],
      parent_category: parentCategory,
      sub_categories: subCategories,
      topicType: item.category || 'sports',
      focus_keyword: parsedGemini?.focus_keyword || item.title,
      slug: parsedGemini?.slug || '',
      tags: Array.isArray(parsedGemini?.tags) ? parsedGemini.tags : [item.title],
      seo_description: parsedGemini?.seo_description || '',
      thumbnail_text: parsedGemini?.thumbnail_text || ''
    };

    console.log(`  ↳ [Topic ${index}] ✅ Successfully structured Article ("${topicResult.title}" | Category: ${topicResult.parent_category} > [${topicResult.sub_categories.join(', ')}])`);

    // Publish Article directly to WordPress as draft
    console.log(`  ↳ [Topic ${index}] Pushing Article to WordPress as draft...`);
    console.log("Step 4: Publishing Article to WordPress...");
    try {
      await publishToWordPress(topicResult);
    } catch (wpErr) {
      console.error(`  ↳ [Topic ${index}] [WordPress Error] Article publishing threw exception: ${wpErr.message}`);
      process.exit(1);
    }

    return topicResult;
  } catch (topicError) {
    // Robust error handling: log and return null without crashing the batch
    console.error(`  ↳ [Topic ${index}] [Error] Failed processing topic "${item.title}": ${topicError.message}`);
    process.exit(1);
    return null;
  }
}

/**
 * Fetches combined Sports and Entertainment trends, selects top 10 topics,
 * and processes them in parallel batches for extreme speed.
 */
async function fetchAndScrapeTrends() {
  try {
    // 1. Preload global state to avoid redundant API hits for categories/tags
    console.log("Step 1: Preloading WordPress Taxonomies...");
    await preloadWordPressTaxonomies();

    console.log("Step 2: Fetching Trends from NewsData API...");
    const combinedTopics = await getCombinedEntertainmentAndSportsTrends();
    
    // Shuffle the topics to ensure variety and prevent duplicate hourly posts
    const shuffledTopics = combinedTopics.sort(() => 0.5 - Math.random());
    // Randomly select 5 topics instead of always picking index 0
    const topTopics = shuffledTopics.slice(0, 5);

    if (topTopics.length === 0) {
      console.log('[Info] No trending topics found. Exiting.');
      return;
    }

    console.log(`\n[Info] Starting ultra-fast parallel generation pipeline for ${topTopics.length} topics...\n`);
    const allResults = [];
    const BATCH_SIZE = 3;

    for (let i = 0; i < topTopics.length; i += BATCH_SIZE) {
      const batch = topTopics.slice(i, i + BATCH_SIZE);
      console.log(`\n[Batch] Processing topics ${i + 1} to ${Math.min(i + BATCH_SIZE, topTopics.length)} in parallel...`);
      
      const batchPromises = batch.map((item, localIndex) => 
        processAndPublishArticle(item, i + localIndex + 1)
      );
      
      const batchResults = await Promise.all(batchPromises);
      const successfulResults = batchResults.filter(Boolean);
      allResults.push(...successfulResults);

      if (i + BATCH_SIZE < topTopics.length) {
        console.log(`[Batch] Waiting 3 seconds before next batch to respect API limits...`);
        await delay(3000);
      }
    }

    // Write final audit files to disk
    fs.writeFileSync('final_audit.json', JSON.stringify(allResults, null, 2), 'utf8');
    fs.writeFileSync('audit_data.json', JSON.stringify(allResults, null, 2), 'utf8');
    console.log(`\n[Success] Pipeline complete. Generated ${allResults.length} articles across ${topTopics.length} topics.`);
    console.log(`[Success] Audit files saved: final_audit.json and audit_data.json.`);

  } catch (error) {
    console.error('[Fatal Error] Unhandled exception in pipeline execution:');
    if (error.response) {
      console.error(`HTTP Status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(error.message || error);
    }
  }
}

/**
 * Helper function to loop through string tags, get existing WP tag ID or create if not found.
 * Uses global wpTagsMap for in-memory caching and WP REST API GET search to optimize performance.
 * @param {string[]} tagArray - Array of tag strings generated by Gemini
 * @returns {Promise<number[]>} Array of integer Tag IDs
 */
async function resolveTags(tagArray) {
  if (!Array.isArray(tagArray) || tagArray.length === 0) {
    return [];
  }

  const tagIds = [];
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json'
    };

    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    for (const rawTag of tagArray) {
      if (!rawTag || typeof rawTag !== 'string') continue;
      const tagName = rawTag.trim();
      if (!tagName) continue;

      const lowerName = tagName.toLowerCase();

      try {
        if (wpTagsMap.has(lowerName)) {
          tagIds.push(wpTagsMap.get(lowerName));
        } else {
          // Check WordPress via GET request if it exists
          const searchUrl = `${wpBaseUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`;
          const searchResp = await axios.get(searchUrl, { headers });
          
          if (searchResp.data && searchResp.data.length > 0) {
            // Grab the ID if it exists
            const existingTagId = searchResp.data[0].id;
            console.log(`  ↳ Found existing tag "${tagName}" via search (ID: ${existingTagId})`);
            wpTagsMap.set(lowerName, existingTagId);
            tagIds.push(existingTagId);
          } else {
            // Create the tag if not found
            console.log(`  ↳ Tag "${tagName}" not found. Creating new WordPress tag...`);
            const createUrl = `${wpBaseUrl}/wp-json/wp/v2/tags`;
            const postResp = await axios.post(createUrl, { name: tagName }, { headers });
            if (postResp.data && postResp.data.id) {
              console.log(`  ↳ ✅ Created tag "${tagName}" (ID: ${postResp.data.id})`);
              wpTagsMap.set(lowerName, postResp.data.id);
              tagIds.push(postResp.data.id);
            }
          }
        }
      } catch (tagErr) {
        const errDetail = tagErr.response
          ? `HTTP ${tagErr.response.status} - ${JSON.stringify(tagErr.response.data)}`
          : tagErr.message;
        console.warn(`  ↳ [Tag Error] Could not get or create tag "${tagName}": ${errDetail}`);
      }
    }
  } catch (error) {
    console.error(`  ↳ [WordPress Tag Helper Error] ${error.message}`);
  }

  return tagIds;
}

/**
 * Generates a dynamic thumbnail using Canvas by overlaying text and a gradient.
 * @param {string} imageUrl - Source image URL
 * @param {string} thumbnailText - Text to overlay
 * @returns {Promise<Buffer>} - Image buffer ready for upload
 */
async function generateThumbnail(imageUrl, thumbnailText) {
  try {
    const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const imgBuffer = Buffer.from(imgResponse.data, 'binary');
    
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    
    // 1. Full Image Background
    const image = await loadImage(imgBuffer);
    
    // Object-fit cover logic for full canvas (1280x720)
    const targetWidth = 1280;
    const targetHeight = 720;
    const scale = Math.max(targetWidth / image.width, targetHeight / image.height);
    const x = (targetWidth / 2) - (image.width / 2) * scale;
    const y = (targetHeight / 2) - (image.height / 2) * scale;
    
    ctx.drawImage(image, x, y, image.width * scale, image.height * scale);
    
    // 2. Cinematic Gradient Overlay
    const gradient = ctx.createLinearGradient(0, 0, 800, 0);
    gradient.addColorStop(0.0, 'rgba(0, 0, 0, 0.9)');
    gradient.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1280, 720);
    
    // 3. Typography (Left-Aligned & Premium)
    if (thumbnailText) {
      ctx.font = 'bold 75px sans-serif';
      
      // Basic word wrapping for max width 540
      const words = thumbnailText.trim().split(/\s+/);
      let line = '';
      const lines = [];
      const maxWidth = 540;
      
      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) {
          lines.push(line.trim());
          line = words[n] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line.trim());
      
      const lineHeight = 85;
      let startY = (canvas.height - (lines.length * lineHeight)) / 2 + (lineHeight / 1.5); // Vertically centered
      
      ctx.shadowColor = 'black';
      ctx.shadowBlur = 15;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 4;
      
      for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i];
        
        // Check if it's the very last line
        if (i === lines.length - 1) {
          const lineWords = currentLine.split(' ');
          const lastWord = lineWords.pop();
          const restOfLine = lineWords.join(' ') + (lineWords.length > 0 ? ' ' : '');
          
          // Draw rest of the line in white
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(restOfLine, 50, startY);
          
          // Draw the last word in yellow
          const restMetrics = ctx.measureText(restOfLine);
          ctx.fillStyle = '#FFD700';
          ctx.fillText(lastWord, 50 + restMetrics.width, startY);
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(currentLine, 50, startY);
        }
        
        startY += lineHeight;
      }
      
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    
    return canvas.toBuffer('image/jpeg', { quality: 0.95 });
  } catch (error) {
    console.error(`  ↳ [Thumbnail Gen Error] Failed to generate thumbnail: ${error.message}`);
    throw error;
  }
}

/**
 * Downloads an image, generates a thumbnail overlay, and uploads it to the WordPress Media Library.
 * @param {string} imageUrl - The URL of the image to download
 * @param {string} title - The title for the filename
 * @param {string} [altText] - Optional alt text to set on the media
 * @param {string} [thumbnailText] - Text to overlay on the image
 * @returns {Promise<number|null>} The WordPress Media ID, or null if it fails
 */
async function uploadImageToWordPress(imageUrl, title, altText, thumbnailText) {
  if (!imageUrl) return null;
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    // 1. Generate Thumbnail or Fallback
    let buffer;
    try {
      buffer = await generateThumbnail(imageUrl, thumbnailText || title);
    } catch (thumbError) {
      console.warn(`  ↳ [Warning] Thumbnail generation failed, falling back to raw image. Reason: ${thumbError.message}`);
      const fallbackResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      buffer = Buffer.from(fallbackResp.data, 'binary');
    }

    // 2. Upload to WP using FormData
    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const safeTitle = (title || 'image').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const wpEndpoint = `${process.env.WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/media`;

    const form = new FormData();
    const keywordSlug = (altText || title || 'image').replace(/[^a-z0-9]/gi, '-').replace(/(^-|-$)+/g, '').toLowerCase();
    const filename = `${keywordSlug}-${Date.now()}.jpg`;
    form.append('file', buffer, { filename: filename, contentType: 'image/jpeg' });
    
    const uploadResponse = await axios.post(wpEndpoint, form, {
      headers: {
        'Authorization': `Basic ${token}`,
        ...form.getHeaders()
      }
    });

    console.log(`  ↳ ✅ Uploaded generated thumbnail to WP Media Library (Media ID: ${uploadResponse.data.id})`);
    
    // 3. Update the media item with alt_text if provided
    if (altText) {
      try {
        await axios.post(`${wpEndpoint}/${uploadResponse.data.id}`, { alt_text: altText }, {
          headers: {
            'Authorization': `Basic ${token}`,
            'Content-Type': 'application/json'
          }
        });
        console.log(`  ↳ ✅ Set alt_text on WP Media Library (Media ID: ${uploadResponse.data.id})`);
      } catch (altError) {
        console.warn(`  ↳ [Warning] Failed to set alt_text on media ID ${uploadResponse.data.id}: ${altError.message}`);
      }
    }
    
    return uploadResponse.data.id;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Media Error] Failed to upload image: ${errDetail}`);
    return null;
  }
}

/**
 * Publishes a single article object to WordPress via REST API as a draft.
 * Uses HTTP Basic Auth with WP Application Password.
 * Embeds image1 cleanly at the very top of the content HTML string.
 * Maps category and tag IDs as integers and passes RankMath focus keyword in meta.
 * @param {{ title: string, content: string, image1: string, bodyImages?: string[], bodyImageAltTags?: string[], topicType?: string, focus_keyword?: string, seo_tags?: string[], parent_category?: string, sub_categories?: string[] }} article - Article data object
 */
async function publishToWordPress(article) {
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');

    // Get or create parent and sub category IDs
    const parentId = await getOrCreateCategory(article.parent_category);
    let finalCategoryIds = [parentId];

    if (Array.isArray(article.sub_categories)) {
      for (const subCatName of article.sub_categories) {
        if (!subCatName) continue;
        const subCategoryId = await getOrCreateCategory(subCatName, parentId);
        if (subCategoryId) {
          finalCategoryIds.push(subCategoryId);
        }
      }
    }

    // Filter out null IDs if category creation failed
    const categoryIds = finalCategoryIds.filter(id => id !== null);

    // Get or create tag integer IDs
    const tagIds = await resolveTags(article.tags);

    // Upload image to WordPress Media Library
    let mediaId = null;
    if (article.image1) {
      mediaId = await uploadImageToWordPress(article.image1, article.title, article.focus_keyword, article.thumbnail_text);
    }

    // Convert plain text newlines to HTML paragraphs for clean WordPress rendering
    let formattedBody = article.content
      .split('\n\n')
      .map(para => para.trim().startsWith('<') ? para.trim() : `<p>${para.trim()}</p>`)
      .join('\n');

    // Auto-inject internal link
    formattedBody += '\n\n<h3>More Like This</h3>\n<p>For more updates, check out our <a href="https://brightcelebrity.com/">latest entertainment and sports news</a>.</p>';

    // Inject in-content images dynamically
    const bodyImages = Array.isArray(article.bodyImages) ? article.bodyImages : [];
    const altTags = Array.isArray(article.bodyImageAltTags) ? article.bodyImageAltTags : [];
    
    for (let n = 2; n <= 5; n++) {
      const placeholder = `[INJECT_IMAGE_${n}_HERE]`;
      if (formattedBody.includes(placeholder)) {
        const imageUrl = bodyImages[n - 2];
        if (imageUrl) {
          const altTag = altTags[n - 2] || `${article.focus_keyword} details`;
          formattedBody = formattedBody.replace(
            placeholder,
            `<img src="${imageUrl}" alt="${altTag}" style="width:100%; height:auto; margin: 20px 0; border-radius: 8px;" />`
          );
        } else {
          formattedBody = formattedBody.replace(placeholder, '');
        }
      }
    }

    const postContent = formattedBody;
    const wpEndpoint = `${process.env.WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/posts`;

    // Create a clean, short slug from the focus keyword (e.g., 'Michelle Pfeiffer' -> 'michelle-pfeiffer')
    let seoSlug = article.focus_keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    if (seoSlug.length > 74) {
      seoSlug = seoSlug.substring(0, 74).replace(/-+$/, '');
    }

    const payload = {
      title: article.title || 'Untitled Article',
      content: postContent,
      status: 'publish',
      categories: categoryIds,
      tags: tagIds,
      slug: seoSlug,
      meta: {
        rank_math_focus_keyword: article.focus_keyword || '',
        rank_math_description: article.seo_description || '',
        rank_math_title: article.title || '',
        rank_math_content_ai_score: '100'
      }
    };

    if (mediaId) {
      payload.featured_media = mediaId;
    }

    console.log('IMPORTANT: Ensure rank_math_title is registered in your WP functions.php snippet to allow REST API updates.');

    console.log('🚀 DEBUG PAYLOAD:', JSON.stringify({ title: payload.title, meta: payload.meta, focus_keyword_from_ai: article.focus_keyword }, null, 2));

    const response = await axios.post(wpEndpoint, payload, {
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`  ↳ ✅ Published on WP | Post ID: ${response.data.id} | Title: ${article.title}`);
    return response.data;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Error] Failed publishing for "${article?.title}": ${errDetail}`);
    process.exit(1);
  }
}

// Execute the script
fetchAndScrapeTrends();
