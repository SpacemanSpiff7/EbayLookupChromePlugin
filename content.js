// eBay Sold Price Lookup for Craigslist
// Content script - runs on Craigslist listing detail pages

(function() {
  'use strict';

  // ============================================================
  // CONFIGURATION
  // ============================================================
  const CONFIG = {
    CACHE_TTL_MS: 14 * 24 * 60 * 60 * 1000, // 14 days
    CACHE_KEY_PREFIX: 'ebay_lookup_',
    RAPIDAPI_URL: 'https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems',
    RAPIDAPI_HOST: 'ebay-average-selling-price.p.rapidapi.com',
    OPENAI_URL: 'https://api.openai.com/v1/chat/completions',
    OPENAI_MODEL: 'gpt-4o-mini',
    OPENAI_MAX_TOKENS: 600,
    DESCRIPTION_MAX_LENGTH: 1500,
    CONFIDENCE_THRESHOLD: 0.65,
    MAX_IMAGES: 3,
    ASPECTS_WHITELIST: [
      // General
      'Model', 'Brand', 'LH_ItemCondition',
      // Electronics
      'Storage Capacity', 'Network',
      // Bicycles
      'Frame Size', 'Wheel Size', 'Type', 'Suspension Type', 'Number of Gears',
      'Frame Material', 'Brake Type', 'Gender'
    ],
    FLUFF_TOKENS: [
      'obo', 'o.b.o', 'or best offer', 'firm', 'like new', 'mint', 'must sell',
      'need gone', 'moving', 'negotiable', 'cash only', 'no trades', 'pick up only',
      'local only', 'serious buyers', 'serious inquiries', 'price drop', 'reduced',
      'priced to sell', 'great deal', 'steal', 'rare', 'hard to find', 'htf'
    ]
  };

  // ============================================================
  // CACHE MODULE
  // ============================================================
  const Cache = {
    getKey: function(url) {
      return CONFIG.CACHE_KEY_PREFIX + url;
    },

    get: function(url) {
      return new Promise(function(resolve) {
        const key = Cache.getKey(url);
        chrome.storage.local.get([key], function(result) {
          const entry = result[key];
          if (entry && Cache.isValid(entry)) {
            resolve(entry);
          } else {
            resolve(null);
          }
        });
      });
    },

    set: function(url, data) {
      return new Promise(function(resolve) {
        const key = Cache.getKey(url);
        const entry = {
          timestamp_ms: Date.now(),
          listing_title: data.listing_title || '',
          request_body_used: data.request_body_used || {},
          rapidapi_response_slim: data.rapidapi_response_slim || {},
          used_openai: data.used_openai || false,
          image_count: data.image_count || 0,
          // Debug info for cached loads
          confidence: data.confidence,
          baseline_reason: data.baseline_reason || null,
          openai_debug: data.openai_debug || null
        };
        const obj = {};
        obj[key] = entry;
        chrome.storage.local.set(obj, resolve);
      });
    },

    isValid: function(entry) {
      if (!entry || !entry.timestamp_ms) return false;
      const age = Date.now() - entry.timestamp_ms;
      return age < CONFIG.CACHE_TTL_MS;
    },

    clear: function(url) {
      return new Promise(function(resolve) {
        const key = Cache.getKey(url);
        chrome.storage.local.remove([key], resolve);
      });
    }
  };

  // ============================================================
  // CRAIGSLIST EXTRACTOR MODULE
  // ============================================================
  const Extractor = {
    extractListing: function() {
      return {
        title: Extractor.getTitle(),
        price: Extractor.getPrice(),
        description: Extractor.getDescription(),
        category: Extractor.getCategory(),
        location: Extractor.getLocation(),
        images: Extractor.getImages()
      };
    },

    getImages: function() {
      const images = [];

      // Method 1: Look for gallery thumbs (most common on Craigslist)
      const thumbs = document.querySelectorAll('.gallery .thumb, #thumbs a');
      thumbs.forEach(function(thumb) {
        const href = thumb.href || thumb.getAttribute('data-imgid');
        if (href && href.includes('craigslist')) {
          // Convert thumbnail URL to full-size image URL
          const fullUrl = href.replace(/50x50c/, '600x450').replace(/300x300/, '600x450');
          if (!images.includes(fullUrl)) {
            images.push(fullUrl);
          }
        }
      });

      // Method 2: Look for main gallery image
      const mainImg = document.querySelector('.gallery .slide img, .swipe img');
      if (mainImg && mainImg.src) {
        const src = mainImg.src.replace(/50x50c/, '600x450').replace(/300x300/, '600x450');
        if (!images.includes(src)) {
          images.unshift(src); // Add main image first
        }
      }

      // Method 3: Check for images in iids (image IDs) data attribute
      const galleryEl = document.querySelector('.gallery');
      if (galleryEl) {
        const iidsAttr = galleryEl.getAttribute('data-imgids') || galleryEl.getAttribute('data-imgs');
        if (iidsAttr) {
          try {
            const imgData = JSON.parse(iidsAttr);
            if (Array.isArray(imgData)) {
              imgData.forEach(function(img) {
                const url = img.url || img;
                if (url && typeof url === 'string' && !images.includes(url)) {
                  images.push(url);
                }
              });
            }
          } catch (e) {
            // Ignore JSON parse errors
          }
        }
      }

      // Method 4: Fallback - look for any large images in posting body
      if (images.length === 0) {
        const postingImgs = document.querySelectorAll('#postingbody img, .posting img');
        postingImgs.forEach(function(img) {
          if (img.src && img.naturalWidth > 100) {
            images.push(img.src);
          }
        });
      }

      // Limit to configured max images
      return images.slice(0, CONFIG.MAX_IMAGES);
    },

    getTitle: function() {
      // Prefer #titletextonly, fallback to h1
      const titleEl = document.getElementById('titletextonly');
      if (titleEl && titleEl.textContent.trim()) {
        return Extractor.normalize(titleEl.textContent);
      }
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim()) {
        return Extractor.normalize(h1.textContent);
      }
      return null;
    },

    getPrice: function() {
      // Prefer .price, fallback to regex match
      const priceEl = document.querySelector('.price');
      if (priceEl && priceEl.textContent.trim()) {
        const match = priceEl.textContent.match(/\$[\d,]+/);
        if (match) return match[0];
      }
      // Fallback: search page for $<number> pattern
      const bodyText = document.body.innerText;
      const priceMatch = bodyText.match(/\$[\d,]+/);
      if (priceMatch) return priceMatch[0];
      return null;
    },

    getDescription: function() {
      const postingBody = document.getElementById('postingbody');
      if (!postingBody) return null;

      let text = postingBody.textContent || '';
      // Strip "QR Code Link to This Post"
      text = text.replace(/QR Code Link to This Post/gi, '');
      text = Extractor.normalizeWhitespace(text);

      // Truncate to max length
      if (text.length > CONFIG.DESCRIPTION_MAX_LENGTH) {
        text = text.substring(0, CONFIG.DESCRIPTION_MAX_LENGTH) + '...';
      }
      return text || null;
    },

    getCategory: function() {
      // Try breadcrumbs
      const breadcrumbs = document.querySelector('.breadcrumbs');
      if (breadcrumbs) {
        const links = breadcrumbs.querySelectorAll('a');
        if (links.length > 0) {
          // Get the deepest category (last link before current page)
          const categories = Array.from(links).map(function(a) {
            return a.textContent.trim();
          }).filter(function(t) {
            return t && t !== '>' && t.toLowerCase() !== 'craigslist';
          });
          if (categories.length > 0) {
            return categories.join(' > ');
          }
        }
      }
      return null;
    },

    getLocation: function() {
      // Try to find location from posting info
      const postingInfos = document.querySelectorAll('.postingtitletext small, .postingtitle small');
      for (let i = 0; i < postingInfos.length; i++) {
        const text = postingInfos[i].textContent.trim();
        if (text && text.length > 0) {
          // Remove parentheses
          return text.replace(/[()]/g, '').trim();
        }
      }
      // Also try attrgroup for location
      const attrGroups = document.querySelectorAll('.attrgroup span');
      for (let i = 0; i < attrGroups.length; i++) {
        const text = attrGroups[i].textContent.trim().toLowerCase();
        if (text.includes('location')) {
          return attrGroups[i].textContent.trim();
        }
      }
      return null;
    },

    normalize: function(text) {
      if (!text) return '';
      text = Extractor.normalizeWhitespace(text);
      // Remove fluff tokens
      const lower = text.toLowerCase();
      CONFIG.FLUFF_TOKENS.forEach(function(token) {
        const regex = new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
        text = text.replace(regex, '');
      });
      // Remove extra whitespace created by removals
      text = Extractor.normalizeWhitespace(text);
      // Remove price patterns from title
      text = text.replace(/\$[\d,]+/g, '');
      text = Extractor.normalizeWhitespace(text);
      return text;
    },

    normalizeWhitespace: function(text) {
      if (!text) return '';
      return text.replace(/\s+/g, ' ').trim();
    }
  };

  // ============================================================
  // OPENAI MODULE
  // ============================================================
  const OpenAI = {
    generateRequest: async function(listing, apiKey) {
      // Debug info to return regardless of success/failure
      const debugInfo = {
        model: CONFIG.OPENAI_MODEL,
        imageCount: listing.images ? listing.images.length : 0,
        promptPreview: '',
        error: null,
        rawResponse: null,
        parsedResponse: null
      };

      const systemPrompt = `You are a product identification expert. Analyze the provided Craigslist listing (text and images) to create accurate eBay search parameters.

Your task:
1. Identify the EXACT product: brand, model, variant, size, condition
2. Use images to verify/extract details not in the text (brand logos, model numbers, size labels)
3. Return JSON matching the provided schema

Be conservative: only include filters you're confident about. Better to match broadly than miss the item.`;

      const hasImages = listing.images && listing.images.length > 0;

      const userPromptText = `Create parameters for an eBay sold-items query based on this Craigslist listing.

${hasImages ? 'IMAGES ARE PROVIDED - Use them to identify brand, model, size, and condition details that may not be in the text.' : 'No images available - rely on text only.'}

Rules:
- IMPORTANT: Extract brand and model from images if visible (logos, labels, stickers)
- For bicycles: look for brand name on frame, components (Shimano, SRAM), wheel size
- For electronics: look for brand logos, model numbers, storage capacity labels
- keywords should include: brand + model + key identifying features
- excluded_keywords: common irrelevant matches (e.g., "parts" "manual" "case" for phones)
- category_id: use eBay category ID if confident (e.g., "177831" for road bikes, "9355" for cell phones)
- aspects: include brand, model, size attributes when identifiable
- Prioritize recall over precision: prefer broader matching over restrictive filters
- Do not include the Craigslist asking price in keywords

Craigslist data:
Title: ${listing.title || 'N/A'}
Price: ${listing.price || 'N/A'}
Category: ${listing.category || 'N/A'}
Location: ${listing.location || 'N/A'}
Description: ${listing.description || 'N/A'}`;

      // Store prompt preview for debugging
      debugInfo.promptPreview = userPromptText.substring(0, 800);

      // Build user message content (multimodal if images present)
      const userContent = [];

      // Add text content first
      userContent.push({
        type: 'text',
        text: userPromptText
      });

      // Add images if available
      if (hasImages) {
        listing.images.forEach(function(imageUrl) {
          userContent.push({
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: 'low' // Use low detail to save tokens, still good for brand/model ID
            }
          });
        });
      }

      // OpenAI strict mode requires ALL properties in 'required' array
      // Optional fields use type: ['string', 'null'] to allow null values
      const jsonSchema = {
        name: 'ebay_query_params',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            keywords: { type: 'string' },
            excluded_keywords: { type: ['string', 'null'] },
            category_id: { type: ['string', 'null'] },
            max_search_results: { type: 'string', enum: ['60', '120', '240'] },
            remove_outliers: { type: 'boolean' },
            site_id: { type: 'string' },
            aspects: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  value: { type: 'string' }
                },
                required: ['name', 'value'],
                additionalProperties: false
              }
            },
            confidence: { type: 'number' }
          },
          required: ['keywords', 'excluded_keywords', 'category_id', 'max_search_results', 'remove_outliers', 'site_id', 'aspects', 'confidence'],
          additionalProperties: false
        }
      };

      try {
        const response = await fetch(CONFIG.OPENAI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: CONFIG.OPENAI_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent }
            ],
            temperature: 0,
            max_tokens: CONFIG.OPENAI_MAX_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: jsonSchema
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          debugInfo.error = 'HTTP ' + response.status + ': ' + errorText.substring(0, 500);
          console.error('OpenAI API error:', response.status, errorText);
          return { result: null, debug: debugInfo };
        }

        const data = await response.json();
        debugInfo.rawResponse = data;

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const content = data.choices[0].message.content;
          try {
            const parsed = JSON.parse(content);
            debugInfo.parsedResponse = parsed;
            return { result: parsed, debug: debugInfo };
          } catch (parseError) {
            debugInfo.error = 'JSON parse error: ' + parseError.message;
            return { result: null, debug: debugInfo };
          }
        }

        debugInfo.error = 'No valid response in API data';
        return { result: null, debug: debugInfo };
      } catch (error) {
        debugInfo.error = 'Request failed: ' + error.message;
        console.error('OpenAI request failed:', error);
        return { result: null, debug: debugInfo };
      }
    }
  };

  // ============================================================
  // SANITIZATION / VALIDATION MODULE
  // ============================================================
  const Sanitizer = {
    // openAiResponse is now { result, debug } object from OpenAI.generateRequest()
    sanitize: function(openAiResponse, normalizedTitle) {
      const baseline = Sanitizer.getBaseline(normalizedTitle);

      // If OpenAI failed completely (no response object)
      if (!openAiResponse) {
        return {
          body: baseline,
          usedBaseline: true,
          baselineReason: 'openai_no_response',
          confidence: null,
          openAiDebug: null
        };
      }

      const openAiResult = openAiResponse.result;
      const openAiDebug = openAiResponse.debug;

      // If OpenAI returned an error
      if (!openAiResult) {
        return {
          body: baseline,
          usedBaseline: true,
          baselineReason: 'openai_error: ' + (openAiDebug?.error || 'unknown'),
          confidence: null,
          openAiDebug: openAiDebug
        };
      }

      try {
        // Validate keywords
        if (!openAiResult.keywords || typeof openAiResult.keywords !== 'string') {
          return {
            body: baseline,
            usedBaseline: true,
            baselineReason: 'invalid_keywords: missing or not string',
            confidence: openAiResult.confidence,
            openAiDebug: openAiDebug
          };
        }
        if (openAiResult.keywords.length < 1 || openAiResult.keywords.length > 120) {
          return {
            body: baseline,
            usedBaseline: true,
            baselineReason: 'invalid_keywords: length ' + openAiResult.keywords.length,
            confidence: openAiResult.confidence,
            openAiDebug: openAiDebug
          };
        }

        const confidence = typeof openAiResult.confidence === 'number' ? openAiResult.confidence : 0;
        const lowConfidence = confidence < CONFIG.CONFIDENCE_THRESHOLD;

        // Build sanitized request body
        const body = {
          keywords: openAiResult.keywords.substring(0, 120),
          max_search_results: '240',
          remove_outliers: 'true',
          site_id: '0'
        };

        // max_search_results validation
        if (['60', '120', '240'].includes(openAiResult.max_search_results)) {
          body.max_search_results = openAiResult.max_search_results;
        }

        // remove_outliers validation
        if (typeof openAiResult.remove_outliers === 'boolean') {
          body.remove_outliers = openAiResult.remove_outliers ? 'true' : 'false';
        }

        // excluded_keywords - only include if present and valid
        if (openAiResult.excluded_keywords && typeof openAiResult.excluded_keywords === 'string') {
          const excluded = openAiResult.excluded_keywords.substring(0, 200);
          if (excluded.trim()) {
            body.excluded_keywords = excluded;
          }
        }

        // If low confidence, skip category_id and aspects
        if (!lowConfidence) {
          // category_id - only if digits only
          if (openAiResult.category_id && typeof openAiResult.category_id === 'string') {
            if (/^\d+$/.test(openAiResult.category_id)) {
              body.category_id = openAiResult.category_id;
            }
          }

          // aspects - filter by whitelist
          if (Array.isArray(openAiResult.aspects) && openAiResult.aspects.length > 0) {
            const validAspects = openAiResult.aspects.filter(function(aspect) {
              return aspect &&
                     typeof aspect.name === 'string' &&
                     typeof aspect.value === 'string' &&
                     CONFIG.ASPECTS_WHITELIST.includes(aspect.name);
            });
            if (validAspects.length > 0) {
              body.aspects = validAspects;
            }
          }
        }

        return {
          body: body,
          usedBaseline: false,
          baselineReason: null,
          confidence: confidence,
          openAiDebug: openAiDebug
        };
      } catch (error) {
        console.error('Sanitization error:', error);
        return {
          body: baseline,
          usedBaseline: true,
          baselineReason: 'sanitization_error: ' + error.message,
          confidence: null,
          openAiDebug: openAiDebug
        };
      }
    },

    getBaseline: function(normalizedTitle) {
      return {
        keywords: normalizedTitle || 'item',
        max_search_results: '240',
        remove_outliers: 'true',
        site_id: '0'
      };
    }
  };

  // ============================================================
  // RAPIDAPI MODULE
  // ============================================================
  const RapidAPI = {
    search: async function(requestBody, apiKey) {
      try {
        const response = await fetch(CONFIG.RAPIDAPI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-host': CONFIG.RAPIDAPI_HOST,
            'x-rapidapi-key': apiKey
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('RapidAPI error:', response.status, errorText);
          return { error: true, message: 'API error: ' + response.status, data: null };
        }

        const data = await response.json();
        return { error: false, message: null, data: data };
      } catch (error) {
        console.error('RapidAPI request failed:', error);
        return { error: true, message: error.message, data: null };
      }
    },

    parseResponse: function(response) {
      if (!response || !response.data) {
        return {
          stats: null,
          comps: [],
          resultsCount: 0
        };
      }

      const data = response.data;
      const stats = {
        average: data.average_price || data.averagePrice || null,
        median: data.median_price || data.medianPrice || null,
        min: data.min_price || data.minPrice || null,
        max: data.max_price || data.maxPrice || null
      };

      // Parse comps (sold items list)
      let comps = [];
      const products = data.products || data.items || data.results || [];
      if (Array.isArray(products)) {
        comps = products.slice(0, 10).map(function(item) {
          return {
            title: item.title || item.name || 'Unknown',
            price: item.sale_price || item.salePrice || item.price || 'N/A',
            dateSold: item.date_sold || item.dateSold || item.soldDate || 'N/A',
            link: item.url || item.link || item.itemUrl || '#'
          };
        });
      }

      return {
        stats: stats,
        comps: comps,
        resultsCount: data.results_count || data.resultsCount || data.total || products.length
      };
    }
  };

  // ============================================================
  // PANEL UI MODULE
  // ============================================================
  const Panel = {
    panelId: 'ebay-lookup-panel',

    create: function() {
      // Remove existing panel if any
      Panel.remove();

      const panel = document.createElement('div');
      panel.id = Panel.panelId;
      panel.innerHTML = `
        <div class="ebay-panel-header">
          <span class="ebay-panel-title">eBay Sold Price Lookup</span>
          <button class="ebay-panel-close" title="Close">&times;</button>
        </div>
        <div class="ebay-panel-content">
          <div class="ebay-panel-status">Loading...</div>
          <div class="ebay-panel-stats"></div>
          <div class="ebay-panel-comps"></div>
          <div class="ebay-panel-actions">
            <button class="ebay-btn ebay-refresh-btn">Refresh</button>
            <button class="ebay-btn ebay-debug-btn">Show Debug</button>
          </div>
          <div class="ebay-panel-debug" hidden></div>
        </div>
      `;

      document.body.appendChild(panel);

      // Attach event handlers
      panel.querySelector('.ebay-panel-close').addEventListener('click', Panel.remove);
      panel.querySelector('.ebay-refresh-btn').addEventListener('click', function() {
        App.run(true);
      });
      panel.querySelector('.ebay-debug-btn').addEventListener('click', Panel.toggleDebug);

      return panel;
    },

    remove: function() {
      const existing = document.getElementById(Panel.panelId);
      if (existing) {
        existing.remove();
      }
    },

    setStatus: function(message, type) {
      const statusEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-status');
      if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = 'ebay-panel-status' + (type ? ' ebay-status-' + type : '');
      }
    },

    renderStats: function(stats, resultsCount) {
      const statsEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-stats');
      if (!statsEl) return;

      if (!stats || (stats.average === null && stats.median === null)) {
        statsEl.innerHTML = '<div class="ebay-no-results">No pricing data available</div>';
        return;
      }

      const formatPrice = function(val) {
        if (val === null || val === undefined) return 'N/A';
        if (typeof val === 'number') return '$' + val.toFixed(2);
        return val;
      };

      statsEl.innerHTML = `
        <div class="ebay-stats-grid">
          <div class="ebay-stat">
            <span class="ebay-stat-label">Average</span>
            <span class="ebay-stat-value">${formatPrice(stats.average)}</span>
          </div>
          <div class="ebay-stat">
            <span class="ebay-stat-label">Median</span>
            <span class="ebay-stat-value">${formatPrice(stats.median)}</span>
          </div>
          <div class="ebay-stat">
            <span class="ebay-stat-label">Min</span>
            <span class="ebay-stat-value">${formatPrice(stats.min)}</span>
          </div>
          <div class="ebay-stat">
            <span class="ebay-stat-label">Max</span>
            <span class="ebay-stat-value">${formatPrice(stats.max)}</span>
          </div>
          <div class="ebay-stat ebay-stat-count">
            <span class="ebay-stat-label">Results</span>
            <span class="ebay-stat-value">${resultsCount || 0}</span>
          </div>
        </div>
      `;
    },

    renderComps: function(comps) {
      const compsEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-comps');
      if (!compsEl) return;

      if (!comps || comps.length === 0) {
        compsEl.innerHTML = '<div class="ebay-no-results">No comparable sales found</div>';
        return;
      }

      const formatPrice = function(val) {
        if (val === null || val === undefined || val === 'N/A') return 'N/A';
        if (typeof val === 'number') return '$' + val.toFixed(2);
        return val;
      };

      const compsHtml = comps.map(function(comp) {
        const title = comp.title.length > 60 ? comp.title.substring(0, 60) + '...' : comp.title;
        return `
          <div class="ebay-comp">
            <a href="${comp.link}" target="_blank" class="ebay-comp-title">${title}</a>
            <span class="ebay-comp-price">${formatPrice(comp.price)}</span>
            <span class="ebay-comp-date">${comp.dateSold}</span>
          </div>
        `;
      }).join('');

      compsEl.innerHTML = `
        <div class="ebay-comps-header">Recent Sold Items</div>
        <div class="ebay-comps-list">${compsHtml}</div>
      `;
    },

    renderError: function(message) {
      const statsEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-stats');
      const compsEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-comps');

      if (statsEl) {
        statsEl.innerHTML = `<div class="ebay-error">${message}</div>`;
      }
      if (compsEl) {
        compsEl.innerHTML = '';
      }
    },

    // info = { requestBody, usedOpenAI, imageCount, openAiDebug, baselineReason, confidence }
    setDebugInfo: function(info) {
      const debugEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-debug');
      if (!debugEl) return;

      const imgCount = info.imageCount || 0;
      const openAiDebug = info.openAiDebug || {};
      const hasError = openAiDebug.error;

      // Format OpenAI status
      let openAiStatus;
      if (hasError) {
        openAiStatus = '<span style="color:#dc3545">ERROR: ' + openAiDebug.error + '</span>';
      } else if (info.usedOpenAI) {
        openAiStatus = '<span style="color:#28a745">Success</span>';
      } else {
        openAiStatus = '<span style="color:#ffc107">Baseline used</span>';
      }

      // Build debug HTML
      let html = '<div class="ebay-debug-content">';

      // OpenAI Status
      html += '<div class="ebay-debug-row"><strong>OpenAI Status:</strong> ' + openAiStatus + '</div>';

      // Model used
      if (openAiDebug.model) {
        html += '<div class="ebay-debug-row"><strong>Model:</strong> ' + openAiDebug.model + '</div>';
      }

      // Confidence
      if (info.confidence !== null && info.confidence !== undefined) {
        const confColor = info.confidence >= 0.65 ? '#28a745' : '#ffc107';
        html += '<div class="ebay-debug-row"><strong>Confidence:</strong> <span style="color:' + confColor + '">' + info.confidence.toFixed(2) + '</span></div>';
      }

      // Baseline reason
      if (info.baselineReason) {
        html += '<div class="ebay-debug-row"><strong>Baseline Reason:</strong> <span style="color:#dc3545">' + info.baselineReason + '</span></div>';
      }

      // Images
      html += '<div class="ebay-debug-row"><strong>Images Analyzed:</strong> ' + imgCount + '</div>';

      // OpenAI Parsed Response (if available)
      if (openAiDebug.parsedResponse) {
        html += '<div class="ebay-debug-row"><strong>OpenAI Response:</strong><pre style="max-height:200px;overflow:auto">' + JSON.stringify(openAiDebug.parsedResponse, null, 2) + '</pre></div>';
      }

      // Prompt preview (if no successful response)
      if (hasError && openAiDebug.promptPreview) {
        html += '<div class="ebay-debug-row"><strong>Prompt Sent:</strong><pre style="max-height:150px;overflow:auto;font-size:11px">' + openAiDebug.promptPreview + '</pre></div>';
      }

      // Final RapidAPI Request
      html += '<div class="ebay-debug-row"><strong>Final RapidAPI Request:</strong><pre>' + JSON.stringify(info.requestBody, null, 2) + '</pre></div>';

      html += '</div>';
      debugEl.innerHTML = html;
    },

    toggleDebug: function() {
      const debugEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-debug');
      const btn = document.querySelector('#' + Panel.panelId + ' .ebay-debug-btn');
      if (!debugEl || !btn) return;

      const isHidden = debugEl.hidden;
      debugEl.hidden = !isHidden;
      btn.textContent = isHidden ? 'Hide Debug' : 'Show Debug';
    },

    showMissingKeys: function() {
      const statusEl = document.querySelector('#' + Panel.panelId + ' .ebay-panel-status');
      if (statusEl) {
        statusEl.innerHTML = `
          <span class="ebay-status-error">API keys not configured.</span><br>
          <small>Right-click the extension icon and select "Options" to add your API keys.</small>
        `;
      }
    }
  };

  // ============================================================
  // MAIN APP ORCHESTRATOR
  // ============================================================
  const App = {
    apiKeys: null,
    currentListing: null,

    init: async function() {
      // Create panel immediately with loading state
      Panel.create();

      // Load API keys
      App.apiKeys = await App.loadApiKeys();
      if (!App.apiKeys.rapidApiKey || !App.apiKeys.openAiKey) {
        Panel.showMissingKeys();
        return;
      }

      // Run the lookup
      await App.run(false);
    },

    loadApiKeys: function() {
      return new Promise(function(resolve) {
        chrome.storage.sync.get(['rapidApiKey', 'openAiKey'], function(result) {
          resolve({
            rapidApiKey: result.rapidApiKey || null,
            openAiKey: result.openAiKey || null
          });
        });
      });
    },

    run: async function(forceRefresh) {
      const pageUrl = window.location.href;

      Panel.setStatus('Loading...', 'loading');

      // Extract listing data
      App.currentListing = Extractor.extractListing();

      if (!App.currentListing.title) {
        Panel.setStatus('Could not extract listing title', 'error');
        return;
      }

      // Get image count for debug display
      const imageCount = App.currentListing.images ? App.currentListing.images.length : 0;

      // Check cache (unless forcing refresh)
      if (!forceRefresh) {
        const cached = await Cache.get(pageUrl);
        if (cached) {
          Panel.setStatus('Cached (' + App.formatAge(cached.timestamp_ms) + ' ago)', 'cached');
          const parsed = RapidAPI.parseResponse({ data: cached.rapidapi_response_slim });
          Panel.renderStats(parsed.stats, parsed.resultsCount);
          Panel.renderComps(parsed.comps);
          Panel.setDebugInfo({
            requestBody: cached.request_body_used,
            usedOpenAI: cached.used_openai,
            imageCount: cached.image_count || 0,
            confidence: cached.confidence,
            baselineReason: cached.baseline_reason,
            openAiDebug: cached.openai_debug
          });
          return;
        }
      }

      // Generate request via OpenAI
      Panel.setStatus('Analyzing listing' + (imageCount > 0 ? ' + ' + imageCount + ' image(s)' : '') + '...', 'loading');
      const normalizedTitle = Extractor.normalize(App.currentListing.title);
      const openAiResponse = await OpenAI.generateRequest(App.currentListing, App.apiKeys.openAiKey);

      // Sanitize the result (now receives { result, debug } object)
      const sanitized = Sanitizer.sanitize(openAiResponse, normalizedTitle);
      const requestBody = sanitized.body;
      const usedOpenAI = !sanitized.usedBaseline;

      // Build debug info object
      const debugInfo = {
        requestBody: requestBody,
        usedOpenAI: usedOpenAI,
        imageCount: imageCount,
        confidence: sanitized.confidence,
        baselineReason: sanitized.baselineReason,
        openAiDebug: sanitized.openAiDebug
      };

      // Call RapidAPI
      Panel.setStatus('Fetching eBay data...', 'loading');
      const rapidResponse = await RapidAPI.search(requestBody, App.apiKeys.rapidApiKey);

      if (rapidResponse.error) {
        Panel.setStatus('Error: ' + rapidResponse.message, 'error');
        Panel.renderError(rapidResponse.message);
        Panel.setDebugInfo(debugInfo);
        return;
      }

      // Parse and render
      const parsed = RapidAPI.parseResponse(rapidResponse);

      if (parsed.resultsCount === 0) {
        Panel.setStatus('No matching sold items found', 'warning');
      } else {
        Panel.setStatus('Fresh results', 'success');
      }

      Panel.renderStats(parsed.stats, parsed.resultsCount);
      Panel.renderComps(parsed.comps);
      Panel.setDebugInfo(debugInfo);

      // Cache the result with debug info
      await Cache.set(pageUrl, {
        listing_title: App.currentListing.title,
        request_body_used: requestBody,
        rapidapi_response_slim: rapidResponse.data,
        used_openai: usedOpenAI,
        image_count: imageCount,
        confidence: sanitized.confidence,
        baseline_reason: sanitized.baselineReason,
        openai_debug: sanitized.openAiDebug
      });
    },

    formatAge: function(timestamp) {
      const ageMs = Date.now() - timestamp;
      const ageMinutes = Math.floor(ageMs / (1000 * 60));
      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      if (ageDays > 0) return ageDays + ' day' + (ageDays > 1 ? 's' : '');
      if (ageHours > 0) return ageHours + ' hour' + (ageHours > 1 ? 's' : '');
      if (ageMinutes > 0) return ageMinutes + ' minute' + (ageMinutes > 1 ? 's' : '');
      return 'just now';
    }
  };

  // ============================================================
  // INITIALIZE
  // ============================================================
  App.init();

})();
