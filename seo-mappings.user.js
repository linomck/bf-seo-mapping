// ==UserScript==
// @name         ShopSwitcher Copy All
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Adds a "Show URLs" and "Copy All" button with dynamic SEO filter translation via slug JSON and value CSV
// @match        *://www.bergfreunde.de/*
// @match        *://bergfreunde.de.localhost/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==
(function () {
  'use strict';
  const log = (...args) => console.log('[ShopSwitcher]', ...args);
  const warn = (...args) => console.warn('[ShopSwitcher]', ...args);

  // --- Config ---
  const SEO_JSON_URL = 'https://gist.githubusercontent.com/linomck/3014fac858576c36923cc8e35034971f/raw/e99b11de4b055aeea088f300c8a432cca8ba6c84/seomappings.json';
  const FILTER_VALUES_CSV_URL = 'https://raw.githubusercontent.com/linomck/bf-seo-mapping/main/filter-values.csv';
  const CACHE_KEY = 'bf_seo_mapping_v4';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 Tage

  const ALLOWED_DOMAINS = new Set([
    'alpinetrek.co.uk',
    'bergfreunde.nl',
    'bergfreunde.eu',
    'alpiniste.fr',
    'berg-freunde.at',
    'berg-freunde.ch',
    'bergfreunde.de',
  ]);

  // Locale -> JSON field name in bfseomapping
  const LOCALE_SEO_FIELD = {
    'de_DE': 'BFSEO',
    'en_GB': 'BFSEO_1',
    'nl_NL': 'BFSEO_2',
    'da_DK': 'BFSEO_3',
    'sv_SE': 'BFSEO_4',
    'nb_NO': 'BFSEO_5',
    'fi_FI': 'BFSEO_6',
    'fr_FR': 'BFSEO_7',
    'it_IT': 'BFSEO_8',
    'es_ES': 'BFSEO_9',
    'eu':    'BFSEO_10',
    'de_AT': 'BFSEO_11',
    'de_CH': 'BFSEO_12',
  };

  const LOCALE_VALUE_FIELD = {
    'de_DE': 'OXVALUE',
    'en_GB': 'OXVALUE_1',
    'nl_NL': 'OXVALUE_2',
    'da_DK': 'OXVALUE_3',
    'sv_SE': 'OXVALUE_4',
    'nb_NO': 'OXVALUE_5',
    'fi_FI': 'OXVALUE_6',
    'fr_FR': 'OXVALUE_7',
    'it_IT': 'OXVALUE_8',
    'es_ES': 'OXVALUE_9',
    'eu': 'OXVALUE_10',
    'de_AT': 'OXVALUE_11',
    'de_CH': 'OXVALUE_12',
  };

  // --- SEO Translation Engine ---
  const htmlDecoder = document.createElement('textarea');
  let slugTranslationMap = null;
  let valueTranslationMap = null;
  let seoDataReady = false;

  function decodeHtmlEntities(value) {
    if (!value) return '';
    htmlDecoder.innerHTML = value;
    return htmlDecoder.value;
  }

  function normalizeWhitespace(value) {
    return value
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeLookupValue(value) {
    return normalizeWhitespace(decodeHtmlEntities(String(value || ''))).toLowerCase();
  }

  function normalizeOutputValue(value) {
    return normalizeWhitespace(decodeHtmlEntities(String(value || '')));
  }

  function addSlugMapping(map, sourceValue, entry) {
    const sourceSlug = normalizeLookupValue(sourceValue);
    if (!sourceSlug) return;

    if (!map[sourceSlug]) {
      map[sourceSlug] = {};
    }

    for (const [locale, field] of Object.entries(LOCALE_SEO_FIELD)) {
      if (locale === 'de_DE') continue;
      const targetSlug = normalizeOutputValue(entry[field]).toLowerCase();
      if (targetSlug) {
        map[sourceSlug][locale] = targetSlug;
      }
    }
  }

  function buildSlugTranslationMap(entries) {
    const map = {};
    for (const entry of entries) {
      addSlugMapping(map, entry[LOCALE_SEO_FIELD['de_DE']], entry);
      addSlugMapping(map, entry.BFSTRING, entry);
    }
    return map;
  }

  function parseCsvRows(text, onRow) {
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && char === ',') {
        row.push(field);
        field = '';
        continue;
      }

      if (!inQuotes && (char === '\n' || char === '\r')) {
        if (char === '\r' && nextChar === '\n') {
          i += 1;
        }
        row.push(field);
        onRow(row);
        row = [];
        field = '';
        continue;
      }

      field += char;
    }

    if (field || row.length) {
      row.push(field);
      onRow(row);
    }
  }

  function buildValueTranslationMap(csvText) {
    const map = {};
    let headers = null;

    parseCsvRows(csvText, (row) => {
      if (!headers) {
        headers = row;
        return;
      }

      if (!row.length) return;

      const entry = {};
      headers.forEach((header, index) => {
        entry[header] = row[index] || '';
      });

      const sourceValue = normalizeLookupValue(entry[LOCALE_VALUE_FIELD['de_DE']]);
      if (!sourceValue) return;

      if (!map[sourceValue]) {
        map[sourceValue] = {};
      }

      for (const [locale, field] of Object.entries(LOCALE_VALUE_FIELD)) {
        if (locale === 'de_DE') continue;
        const targetValue = normalizeOutputValue(entry[field]);
        if (targetValue) {
          map[sourceValue][locale] = targetValue;
        }
      }
    });

    return map;
  }

  function translateSlug(slug, targetLocale) {
    if (!slugTranslationMap || !slug) return slug;
    const key = slug.toLowerCase().trim();
    const entry = slugTranslationMap[key];
    if (!entry) return slug;
    return entry[targetLocale] || slug;
  }

  function translateValue(value, targetLocale) {
    if (!value) return value;
    const key = normalizeLookupValue(value);
    const entry = valueTranslationMap && key ? valueTranslationMap[key] : null;
    if (entry && entry[targetLocale]) {
      return entry[targetLocale];
    }
    return translateSlug(value, targetLocale);
  }

  function fetchText(url, label, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => resolve(res.responseText),
        onerror: () => reject(new Error(`${label} laden fehlgeschlagen`)),
        ontimeout: () => reject(new Error(`${label} laden Timeout`)),
        timeout,
      });
    });
  }

  async function loadSeoData() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { slugData, valueData, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL && slugData && valueData) {
          slugTranslationMap = slugData;
          valueTranslationMap = valueData;
          seoDataReady = true;
          log(`SEO-Daten aus Cache geladen (${Object.keys(slugData).length} Slugs, ${Object.keys(valueData).length} Werte)`);
          return;
        }
      }
    } catch (e) {
      warn('Cache-Lesen fehlgeschlagen:', e);
    }

    log('Lade SEO-Slugs und Filterwerte...');

    try {
      const [seoJsonText, valueCsvText] = await Promise.all([
        fetchText(SEO_JSON_URL, 'SEO-JSON', 15000),
        fetchText(FILTER_VALUES_CSV_URL, 'Filterwerte-CSV', 30000),
      ]);

      const entries = JSON.parse(seoJsonText);
      slugTranslationMap = buildSlugTranslationMap(entries);
      valueTranslationMap = buildValueTranslationMap(valueCsvText);
      seoDataReady = true;

      log(`SEO-Daten geladen (${Object.keys(slugTranslationMap).length} Slugs, ${Object.keys(valueTranslationMap).length} Werte)`);

      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          slugData: slugTranslationMap,
          valueData: valueTranslationMap,
          timestamp: Date.now()
        }));
      } catch (e) {
        warn('Cache-Schreiben fehlgeschlagen:', e);
      }
    } catch (e) {
      warn('SEO-Daten laden fehlgeschlagen:', e);
    }
  }

  // --- hreflang -> Locale ---
  const BARE_LOCALE_MAP = {
    'nl': 'nl_NL',
    'da': 'da_DK',
    'sv': 'sv_SE',
    'nb': 'nb_NO',
    'fi': 'fi_FI',
    'fr': 'fr_FR',
    'it': 'it_IT',
    'es': 'es_ES',
  };

  function hreflangToLocale(hreflang) {
    if (!hreflang || hreflang === 'x-default') return null;
    if (hreflang === 'en' || hreflang === 'eu') return 'eu';
    if (BARE_LOCALE_MAP[hreflang]) return BARE_LOCALE_MAP[hreflang];
    return hreflang.replace('-', '_');
  }

  /**
   * Get shop URLs from <link rel="alternate" hreflang="..."> tags.
   */
  function getHreflangLinks() {
    const links = document.querySelectorAll('link[rel="alternate"][hreflang]');
    const results = [];
    for (const link of links) {
      const href = link.getAttribute('href');
      const locale = hreflangToLocale(link.getAttribute('hreflang'));
      if (!href || !locale) continue;
      if (!LOCALE_SEO_FIELD[locale]) {
        log(`Unbekanntes Locale uebersprungen: ${locale}`);
        continue;
      }
      results.push({ href, locale });
    }
    return results;
  }

  // --- bfc-* Query Param Handling ---
  function extractFilterParams(search) {
    if (!search) return { bfcFilters: [], otherParams: new URLSearchParams() };
    const params = new URLSearchParams(search);
    const bfcMap = {};
    const otherParams = new URLSearchParams();

    for (const [key, value] of params) {
      const match = key.match(/^bfc-(.+?)(\[\])?$/);
      if (match) {
        const attr = match[1];
        if (!bfcMap[attr]) bfcMap[attr] = [];
        bfcMap[attr].push(value);
      } else {
        otherParams.append(key, value);
      }
    }

    const bfcFilters = Object.entries(bfcMap).map(([attribute, values]) => ({
      attribute,
      values,
    }));

    return { bfcFilters, otherParams };
  }

  function applyFilterParams(href, bfcFilters, targetLocale) {
    if (!bfcFilters.length) return href;
    const url = new URL(href);

    for (const { attribute, values } of bfcFilters) {
      const translatedAttr = translateSlug(attribute, targetLocale);
      const paramKey = `bfc-${translatedAttr}[]`;
      for (const val of values) {
        const translatedVal = translateValue(val, targetLocale);
        url.searchParams.append(paramKey, translatedVal);
      }
    }

    return url.toString();
  }

  // --- Link Building ---
  function buildLinks() {
    const hreflangLinks = getHreflangLinks();
    const { bfcFilters, otherParams } = extractFilterParams(window.location.search);

    if (bfcFilters.length) log('BFC-Filter:', bfcFilters);
    log(`${hreflangLinks.length} hreflang-Links gefunden`);

    return hreflangLinks
      .map(({ href, locale }) => {
        if (locale === 'de_DE') return null;

        let targetUrl = href;

        if ([...otherParams].length) {
          const url = new URL(targetUrl);
          otherParams.forEach((value, key) => url.searchParams.append(key, value));
          targetUrl = url.toString();
        }

        targetUrl = applyFilterParams(targetUrl, bfcFilters, locale);

        return targetUrl;
      })
      .filter(href => {
        if (!href) return false;
        try {
          const url = new URL(href);
          if (url.pathname === '/' || url.pathname === '') return false;
          const hostname = url.hostname.replace('www.', '');
          return ALLOWED_DOMAINS.has(hostname);
        } catch {
          return false;
        }
      });
  }

  // --- URL Checking ---
  function checkUrl(href) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: href,
        onload: (res) => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(res.responseText, 'text/html');
          const el = doc.querySelector('.product-amount');
          const amount = el ? el.textContent.trim() : 'N/A';
          resolve({ href, amount });
        },
        onerror:   () => resolve({ href, amount: 'ERR' }),
        ontimeout: () => resolve({ href, amount: 'TIMEOUT' }),
        timeout: 10000,
      });
    });
  }

  // --- UI ---
  function btnStyle(bg) {
    return `
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      background: ${bg};
      color: #fff;
      border: none;
      border-radius: 4px;
    `;
  }

  function addCopyButton() {
    const switcher = document.getElementById('bfTrustedShop');
    if (!switcher) return;
    if (document.getElementById('bf-show-btn')) return;

    log('shopswitcher gefunden');

    const overlay = document.createElement('div');
    overlay.id = 'bf-modal-overlay';
    overlay.style.cssText = `
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 99999;
      align-items: center;
      justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #1e1e1e;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 16px;
      width: max-content;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-family: monospace;
      font-size: 12px;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #fff;
      font-weight: bold;
    `;

    const statusSpan = document.createElement('span');
    statusSpan.id = 'bf-seo-status';
    statusSpan.style.cssText = 'font-size: 10px; color: #888; font-weight: normal; margin-left: 8px;';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Shop URLs';
    titleSpan.appendChild(statusSpan);
    header.appendChild(titleSpan);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;padding:0 4px;';
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    header.appendChild(closeBtn);

    const listBox = document.createElement('div');
    listBox.style.cssText = 'overflow-y: auto; display: flex; flex-direction: column; gap: 2px;';

    const footer = document.createElement('div');
    footer.style.cssText = 'display: flex; gap: 6px;';

    const checkBtn = document.createElement('button');
    checkBtn.textContent = 'Check URLs';
    checkBtn.style.cssText = btnStyle('#555');
    checkBtn.addEventListener('click', async () => {
      checkBtn.textContent = 'Checking...';
      checkBtn.disabled = true;
      const rows = [...listBox.querySelectorAll('[data-href]')];
      await Promise.all(rows.map(async (row) => {
        const badge = row.querySelector('.bf-status');
        badge.textContent = '...';
        badge.style.color = '#aaa';
        const { amount } = await checkUrl(row.dataset.href);
        badge.textContent = amount;
        badge.style.color = '#fff';
      }));
      checkBtn.textContent = 'Check URLs';
      checkBtn.disabled = false;
    });

    const copyBtn = document.createElement('button');
    copyBtn.id = 'bf-copy-all-btn';
    copyBtn.textContent = 'Copy All';
    copyBtn.style.cssText = btnStyle('#333');
    copyBtn.addEventListener('click', () => {
      const links = buildLinks();
      if (!links.length) { warn('Keine Links'); return; }
      GM_setClipboard(links.join('\n'));
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy All'), 2000);
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Reload SEO';
    reloadBtn.style.cssText = btnStyle('#663');
    reloadBtn.addEventListener('click', async () => {
      localStorage.removeItem(CACHE_KEY);
      reloadBtn.textContent = 'Loading...';
      await loadSeoData();
      reloadBtn.textContent = 'Reload SEO';
      updateStatus();
    });

    footer.appendChild(checkBtn);
    footer.appendChild(copyBtn);
    footer.appendChild(reloadBtn);
    modal.appendChild(header);
    modal.appendChild(listBox);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });

    function updateStatus() {
      const el = document.getElementById('bf-seo-status');
      if (!el) return;
      if (seoDataReady) {
        el.textContent = `[${Object.keys(slugTranslationMap || {}).length} slugs, ${Object.keys(valueTranslationMap || {}).length} values]`;
        el.style.color = '#6a6';
      } else {
        el.textContent = '[no SEO data]';
        el.style.color = '#a66';
      }
    }

    const showBtn = document.createElement('button');
    showBtn.id = 'bf-show-btn';
    showBtn.textContent = 'Show URLs';
    showBtn.style.cssText = btnStyle('#555');
    showBtn.addEventListener('click', () => {
      if (!seoDataReady) {
        warn('SEO-Daten noch nicht geladen!');
      }
      const links = buildLinks();
      log(`${links.length} Links generiert`);
      listBox.innerHTML = '';
      links.forEach(href => {
        const row = document.createElement('div');
        row.dataset.href = href;
        row.style.cssText = `
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 4px 6px;
          border-bottom: 1px solid #2a2a2a;
        `;
        const badge = document.createElement('span');
        badge.className = 'bf-status';
        badge.textContent = '-';
        badge.style.cssText = 'min-width: 80px; color: #aaa; white-space: nowrap;';
        const text = document.createElement('a');
        text.href = href;
        text.target = '_blank';
        text.rel = 'noopener';
        text.style.cssText = 'word-break: break-all; color: #7ec8e3; text-decoration: none;';
        text.addEventListener('mouseenter', () => { text.style.textDecoration = 'underline'; });
        text.addEventListener('mouseleave', () => { text.style.textDecoration = 'none'; });
        text.textContent = href;
        row.appendChild(badge);
        row.appendChild(text);
        listBox.appendChild(row);
      });
      updateStatus();
      overlay.style.display = 'flex';
    });

    switcher.appendChild(showBtn);
    updateStatus();
    log('Buttons hinzugefuegt');
  }

  // --- Init ---
  async function init() {
    await loadSeoData();
    addCopyButton();
    const observer = new MutationObserver(() => addCopyButton());
    observer.observe(document.body, { childList: true, subtree: true });
    log('Initialisiert');
  }

  init();
})();