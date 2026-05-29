#!/usr/bin/env node
/**
 * IceMorocco — Local Server with Live Company Search Proxy
 * Serves your app + proxies search requests to charika.ma
 * 
 * Usage: node server.js
 * Then open: http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { URLSearchParams } = require('url');

const PORT = 3000;
const STATIC_DIR = __dirname;
const SITE_URL = (process.env.SITE_URL || 'https://icemorocco.com').replace(/\/$/, '');
const GOOGLE_SITE_VERIFICATION = '-DzBmmXyacpHImfKdEVQaXZphg_b5cbYlbIbLcOGrZQ';
const ADSENSE_CLIENT = 'ca-pub-1097439023725884';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const discoveredCompanies = new Map();
const FAST_SOURCE_TIMEOUT = 1200;
const ENRICH_SOURCE_TIMEOUT = 700;
const FALLBACK_SOURCE_TIMEOUT = 2600;

// ─── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.xml': 'application/xml', '.txt': 'text/plain',
};

// ─── Fetch external URL (GET or POST) ─────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.charika.ma/',
        'Origin': 'https://www.charika.ma',
        ...(process.env.CHARIKA_COOKIE ? { 'Cookie': process.env.CHARIKA_COOKIE } : {}),
        ...(options.headers || {}),
      },
      timeout: 15000,
    };

    const req = https.request(reqOptions, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.charika.ma${res.headers.location}`;
        return fetchUrl(loc).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function withTimeout(promise, ms, fallback = []) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ─── Parse charika.ma search results ──────────────────────────
function strip(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
}

function decodeHtml(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIce(value = '') {
  return String(value).replace(/\D/g, '');
}

function companyCacheKey(company = {}) {
  const ice = normalizeIce(company.ice);
  if (ice) return `ice:${ice}`;
  const name = String(company.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return name ? `name:${name}` : '';
}

function normalizeCompanyName(value = '') {
  return decodeHtml(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(ste|societe|sarl|sa|au|snc|ltd)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function searchTokens(value = '') {
  return normalizeCompanyName(value)
    .split(/\s+/)
    .filter(token => token.length > 1 && !['ste', 'societe', 'sarl', 'sa', 'au', 'snc', 'ltd'].includes(token));
}

function editDistance(a = '', b = '') {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function isCloseToken(queryToken = '', targetToken = '') {
  if (!queryToken || !targetToken) return false;
  if (targetToken.includes(queryToken) || queryToken.includes(targetToken)) return true;
  if (queryToken.length < 4 || targetToken.length < 4) return false;
  const maxDistance = queryToken.length >= 8 ? 3 : queryToken.length >= 6 ? 3 : queryToken.length >= 5 ? 2 : 1;
  return editDistance(queryToken, targetToken) <= maxDistance;
}

function countFuzzyTokenMatches(text = '', tokens = []) {
  const textTokens = normalizeCompanyName(text).split(/\s+/).filter(Boolean);
  if (!textTokens.length || !tokens.length) return 0;
  return tokens.filter(token => textTokens.some(part => isCloseToken(token, part))).length;
}

function companySearchScore(company = {}, query = '') {
  const queryKey = normalizeCompanyName(query);
  const nameKey = normalizeCompanyName(company.name);
  const tokens = searchTokens(query);
  const hay = normalizeCompanyName([company.name, company.ville, company.act, company.type, company.rc, company.addr].join(' '));
  const nameFuzzyMatches = countFuzzyTokenMatches(company.name, tokens);
  let score = 0;
  if (queryKey && nameKey === queryKey) score += 40;
  if (queryKey && nameKey.startsWith(queryKey)) score += 20;
  if (queryKey && nameKey.includes(queryKey)) score += 16;
  score += tokens.filter(token => hay.includes(token)).length * 4;
  score += nameFuzzyMatches * 5;
  if (tokens.length && nameFuzzyMatches >= tokens.length) score += 32;
  else if (tokens.length > 2 && nameFuzzyMatches >= Math.ceil(tokens.length * 0.65)) score += 16;
  if (normalizeIce(company.ice).length === 15) score += 10;
  score += Math.min(companyCompleteness(company), 8);
  return score;
}

function isCloseCompanyMatch(company = {}, query = '') {
  const tokens = searchTokens(query);
  if (!tokens.length) return true;
  const nameMatches = countFuzzyTokenMatches(company.name, tokens);
  const allMatches = countFuzzyTokenMatches([company.name, company.ville, company.act, company.type, company.rc, company.addr].join(' '), tokens);
  if (tokens.length <= 2) return nameMatches >= 1 || allMatches >= tokens.length;
  return nameMatches >= 2 || allMatches >= Math.ceil(tokens.length * 0.65);
}

function matchesSearchIntent(company = {}, query = '') {
  const queryKey = normalizeCompanyName(query);
  const nameKey = normalizeCompanyName(company.name);
  const tokens = searchTokens(query);
  if (!queryKey || !nameKey || !tokens.length) return false;
  if (nameKey === queryKey || nameKey.includes(queryKey) || nameKey.startsWith(queryKey)) return true;

  const nameMatches = countFuzzyTokenMatches(company.name, tokens);
  if (tokens.length === 1) return nameMatches >= 1;
  if (tokens.length === 2) return nameMatches >= 2;
  return nameMatches >= Math.max(3, Math.ceil(tokens.length * 0.75));
}

function keepUsefulSearchResult(company = {}, query = '', allResults = []) {
  if (!matchesSearchIntent(company, query)) return false;
  if (normalizeIce(company.ice)) return true;
  const queryKey = normalizeCompanyName(query);
  const nameKey = normalizeCompanyName(company.name);
  if (queryKey && nameKey && queryKey === nameKey) return true;
  const withIceCount = allResults.filter(item => normalizeIce(item.ice)).length;
  return withIceCount < 5;
}

function sameCompany(a = {}, b = {}) {
  const aIce = normalizeIce(a.ice);
  const bIce = normalizeIce(b.ice);
  if (aIce && bIce) return aIce === bIce;

  const aName = normalizeCompanyName(a.name);
  const bName = normalizeCompanyName(b.name);
  if (!aName || !bName) return false;

  const nameMatch = aName === bName || aName.includes(bName) || bName.includes(aName);
  if (!nameMatch) return false;
  if (aName === bName) return true;

  const aCity = normalizeCompanyName(a.ville);
  const bCity = normalizeCompanyName(b.ville);
  return !aCity || !bCity || aCity === bCity || aCity.includes(bCity) || bCity.includes(aCity);
}

function mergeCompanyRecords(primary = {}, secondary = {}) {
  const merged = { ...secondary, ...primary };
  ['type', 'ice', 'if_', 'rc', 'pat', 'date', 'cap', 'act', 'addr', 'ville', 'url', 'slug', 'tel', 'fax', 'email', 'website', 'statut']
    .forEach(key => {
      merged[key] = primary[key] || secondary[key] || '';
    });
  merged.date = pickCreationDate(primary.date, secondary.date);
  return merged;
}

function companyCompleteness(company = {}) {
  return ['ice', 'if_', 'rc', 'pat', 'date', 'cap', 'act', 'addr', 'ville', 'url', 'tel', 'email', 'website']
    .reduce((count, key) => count + (company[key] ? 1 : 0), 0);
}

function preferCompanyRecord(a = {}, b = {}) {
  const aHasIce = normalizeIce(a.ice).length === 15;
  const bHasIce = normalizeIce(b.ice).length === 15;
  if (aHasIce !== bHasIce) return aHasIce ? a : b;
  return companyCompleteness(a) >= companyCompleteness(b) ? a : b;
}

function dedupeCompanies(companies = []) {
  const results = [];
  companies.forEach(company => {
    if (!company || !company.name) return;
    const incoming = { ...company, date: formatCompanyDate(company.date || '') };
    const existingIndex = results.findIndex(existing => sameCompany(existing, incoming));
    if (existingIndex === -1) {
      results.push(incoming);
      return;
    }
    const preferred = preferCompanyRecord(incoming, results[existingIndex]);
    const fallback = preferred === incoming ? results[existingIndex] : incoming;
    results[existingIndex] = mergeCompanyRecords(preferred, fallback);
  });
  return results;
}

function loadCompaniesFromScript(fileName, variableName) {
  try {
    const code = fs.readFileSync(path.join(STATIC_DIR, fileName), 'utf8');
    const companies = vm.runInNewContext(`${code}\n${variableName};`, {});
    return Array.isArray(companies) ? companies : [];
  } catch (err) {
    console.warn(`SEO data load skipped for ${fileName}: ${err.message}`);
    return [];
  }
}

const LOCAL_COMPANIES = dedupeCompanies([
  ...loadCompaniesFromScript('data.js', 'DB'),
  ...loadCompaniesFromScript('scraped_data.js', 'SCRAPED_DB'),
]);

function slugify(value = '') {
  return decodeHtml(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 90) || 'entreprise';
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeXml(value = '') {
  return escapeHtml(value).replace(/&apos;/g, '&#039;');
}

function companySlug(company = {}) {
  return slugify(company.name);
}

function companySeoUrl(company = {}) {
  return `${SITE_URL}/entreprise/${companySlug(company)}`;
}

function iceSeoUrl(company = {}) {
  const ice = normalizeIce(company.ice);
  return ice ? `${SITE_URL}/ice/${ice}` : companySeoUrl(company);
}

function findCompanyBySlug(slug = '') {
  const sources = dedupeCompanies([...LOCAL_COMPANIES, ...discoveredCompanies.values()]);
  return sources.find(company => companySlug(company) === slug)
    || sources.find(company => companySlug(company).startsWith(slug) || slug.startsWith(companySlug(company)));
}

function findCompanyByIce(ice = '') {
  const needle = normalizeIce(ice);
  const sources = dedupeCompanies([...LOCAL_COMPANIES, ...discoveredCompanies.values()]);
  return sources.find(company => normalizeIce(company.ice) === needle);
}

function inferCategory(company = {}) {
  const text = `${company.name || ''} ${company.act || ''}`.toLowerCase();
  if (/informatique|logiciel|digital|web|telecom|télécom/.test(text)) return 'informatique';
  if (/btp|construction|b[aâ]timent|travaux|g[eé]nie civil/.test(text)) return 'btp';
  if (/transport|logistique|douane/.test(text)) return 'transport';
  if (/banque|cr[eé]dit|assurance|finance/.test(text)) return 'finance';
  if (/commerce|distribution|import|export|vente/.test(text)) return 'commerce';
  return 'entreprises';
}

const SEO_CATEGORIES = {
  entreprises: { label: 'Entreprises marocaines', title: 'Entreprises marocaines' },
  informatique: { label: 'Sociétés informatiques Maroc', title: 'Sociétés informatiques au Maroc' },
  btp: { label: 'Entreprises BTP Maroc', title: 'Entreprises BTP au Maroc' },
  transport: { label: 'Entreprises de transport Maroc', title: 'Entreprises de transport au Maroc' },
  finance: { label: 'Banques et assurances Maroc', title: 'Entreprises finance au Maroc' },
  commerce: { label: 'Sociétés de commerce Maroc', title: 'Sociétés de commerce au Maroc' },
};

const SEO_CITIES = ['Casablanca', 'Rabat', 'Tanger', 'Marrakech', 'Agadir', 'Fès', 'Berrechid'];

function relatedCompanies(company = {}, limit = 6) {
  const category = inferCategory(company);
  return LOCAL_COMPANIES
    .filter(other => other.name !== company.name && (other.ville === company.ville || inferCategory(other) === category))
    .slice(0, limit);
}

function renderSeoLayout({ title, description, canonical, h1, lead, body = '', schema = [], showSearch = true, breadcrumbRoot = 'Recherche ICE Maroc' }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeCanonical = escapeHtml(canonical);
  const jsonLd = JSON.stringify(Array.isArray(schema) ? schema : [schema]).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="fr-MA">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title>
<meta name="description" content="${safeDescription}"/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
<meta name="google-site-verification" content="${GOOGLE_SITE_VERIFICATION}"/>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>
<link rel="canonical" href="${safeCanonical}"/>
<meta property="og:type" content="website"/>
<meta property="og:locale" content="fr_MA"/>
<meta property="og:site_name" content="IceMorocco"/>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:description" content="${safeDescription}"/>
<meta property="og:url" content="${safeCanonical}"/>
<meta property="og:image" content="${SITE_URL}/logo.png"/>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"/>
<link rel="stylesheet" href="/style.css"/>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body class="seo-static-body">
<main class="seo-static">
  <nav class="seo-breadcrumb"><a href="/">${escapeHtml(breadcrumbRoot)}</a> / ${escapeHtml(h1)}</nav>
  <header class="seo-static-head">
    <a class="seo-logo-link" href="/"><img src="/logo.png" alt="IceMorocco" width="254" height="47"/></a>
    <h1>${escapeHtml(h1)}</h1>
    <p>${escapeHtml(lead)}</p>
    ${showSearch ? `<form action="/" method="get" class="seo-search-form">
      <input name="q" placeholder="Nom société ou numéro ICE" aria-label="Recherche ICE Maroc"/>
      <input type="hidden" name="mode" value="nom"/>
      <button type="submit">Rechercher</button>
    </form>` : ''}
  </header>
  ${body}
</main>
</body>
</html>`;
}

function companyCard(company = {}) {
  const ice = normalizeIce(company.ice);
  return `<article class="seo-card">
    <h2><a href="/entreprise/${companySlug(company)}">${escapeHtml(company.name)}</a></h2>
    <p>${escapeHtml([company.type, company.ville, company.rc].filter(Boolean).join(' · '))}</p>
    ${ice ? `<a class="seo-pill" href="/ice/${ice}">ICE ${ice}</a>` : '<span class="seo-pill muted">ICE non disponible</span>'}
  </article>`;
}

function companySchema(company = {}, canonical = companySeoUrl(company)) {
  const ice = normalizeIce(company.ice);
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: company.name,
    url: canonical,
    identifier: ice ? [{ '@type': 'PropertyValue', name: 'ICE', value: ice }] : undefined,
    address: company.ville || company.addr ? {
      '@type': 'PostalAddress',
      streetAddress: company.addr || undefined,
      addressLocality: company.ville || undefined,
      addressCountry: 'MA',
    } : undefined,
    foundingDate: company.date || undefined,
    legalName: company.name,
    description: company.act || undefined,
  };
}

function renderCompanyPage(company = {}, canonical = companySeoUrl(company)) {
  const ice = normalizeIce(company.ice);
  const title = `${company.name} - ICE ${ice || 'Maroc'} | Fiche entreprise`;
  const description = `${company.name} : recherche ICE Maroc, forme juridique ${company.type || 'non disponible'}, ville ${company.ville || 'Maroc'}, RC ${company.rc || 'non disponible'}.`;
  const rows = [
    ['Nom société', company.name],
    ['ICE', ice],
    ['Ville', company.ville],
    ['Forme juridique', company.type],
    ['RC', company.rc],
    ['Date création', company.date],
    ['Activité', company.act],
    ['Adresse', company.addr],
  ].filter(([, value]) => value);
  const related = relatedCompanies(company);
  const body = `
    <section class="seo-panel"><h2>Informations entreprise</h2><dl class="seo-dl">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl></section>
    <section class="seo-panel"><h2>Description SEO</h2><p>${escapeHtml(company.name)} est une entreprise marocaine${company.ville ? ` basée à ${company.ville}` : ''}. Cette page permet de consulter les informations disponibles pour la recherche ICE Maroc, la vérification d'entreprise et l'identification de société.</p></section>
    <section class="seo-panel"><h2>Liens utiles</h2><div class="seo-links">${ice ? `<a href="/ice/${ice}">Page ICE ${ice}</a>` : ''}${company.ville ? `<a href="/ville/${slugify(company.ville)}">Entreprises à ${escapeHtml(company.ville)}</a>` : ''}<a href="/categorie/${inferCategory(company)}">${escapeHtml(SEO_CATEGORIES[inferCategory(company)]?.label || 'Entreprises marocaines')}</a></div></section>
    ${related.length ? `<section class="seo-panel"><h2>Entreprises similaires</h2><div class="seo-card-grid">${related.map(companyCard).join('')}</div></section>` : ''}`;
  return renderSeoLayout({
    title,
    description,
    canonical,
    h1: `${company.name}${ice ? ` - ICE ${ice}` : ''}`,
    lead: `Fiche indexable pour rechercher et vérifier cette entreprise marocaine par ICE, nom, ville et activité.`,
    body,
    schema: [
      companySchema(company, canonical),
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Recherche ICE Maroc', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: company.name, item: canonical },
      ] },
    ],
  });
}

function renderListingPage({ slug, title, h1, lead, description, companies }) {
  const canonical = `${SITE_URL}/${slug}`;
  const body = `<section class="seo-panel"><h2>Entreprises référencées</h2><div class="seo-card-grid">${companies.map(companyCard).join('')}</div></section>
    <section class="seo-panel"><h2>Recherches populaires</h2><div class="seo-links"><a href="/top-recherches-ice">Top recherches ICE</a><a href="/ville/casablanca">Entreprises à Casablanca</a><a href="/categorie/btp">Entreprises BTP Maroc</a><a href="/categorie/informatique">Sociétés informatiques Maroc</a></div></section>`;
  return renderSeoLayout({
    title,
    description,
    canonical,
    h1,
    lead,
    body,
    schema: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: h1, url: canonical, description },
  });
}

const STATIC_INFO_PAGES = {
  about: {
    title: 'À propos - IceMorocco',
    h1: 'À propos d’IceMorocco',
    lead: 'IceMorocco aide les professionnels au Maroc à rechercher une société par ICE ou par nom, puis à préparer leurs documents commerciaux plus rapidement.',
    description: 'À propos d’IceMorocco, plateforme marocaine de recherche ICE, annuaire entreprises et outils professionnels pour facture, cachet entreprise et chiffres en lettres.',
    body: `
      <h2>Notre mission</h2>
      <p>IceMorocco rassemble un moteur de recherche ICE Maroc et des outils pratiques pour les entrepreneurs, freelances, comptables et petites entreprises. Le service vise à rendre la vérification d’une société plus simple avant un devis, une facture, un partenariat ou une démarche administrative.</p>
      <h2>Ce que le site propose</h2>
      <p>La plateforme permet de rechercher une entreprise par nom ou numéro ICE, consulter les informations disponibles, vérifier le format d’un ICE, générer une facture conforme, créer une maquette de cachet entreprise, convertir des montants en lettres et utiliser des calculateurs utiles pour la gestion quotidienne.</p>
      <h2>Important</h2>
      <p>IceMorocco n’est pas un site gouvernemental et ne remplace pas les organismes officiels. Les informations sont fournies à titre indicatif et doivent être vérifiées auprès des administrations ou professionnels compétents avant toute décision importante.</p>
    `,
  },
  contact: {
    title: 'Contact - IceMorocco',
    h1: 'Contact',
    lead: 'Une erreur à signaler, une amélioration à proposer ou une question sur IceMorocco ? Vous pouvez nous contacter directement.',
    description: 'Contact IceMorocco pour signaler une erreur de donnée entreprise, demander une correction, proposer une amélioration ou une collaboration.',
    body: `
      <h2>Nous contacter</h2>
      <p>Pour toute demande liée au site, envoyez un message à <strong>contact@icemorocco.com</strong>.</p>
      <h2>Demandes fréquentes</h2>
      <p>Vous pouvez nous écrire pour signaler une information incorrecte, demander une correction, proposer une fonctionnalité, signaler un problème technique ou discuter d’une collaboration professionnelle.</p>
      <h2>Données entreprises</h2>
      <p>Si votre demande concerne une fiche entreprise, indiquez le nom de la société, le numéro ICE si disponible et la correction souhaitée afin de faciliter la vérification.</p>
    `,
  },
  privacy: {
    title: 'Politique de Confidentialité - IceMorocco',
    h1: 'Politique de Confidentialité',
    lead: 'Cette politique explique comment IceMorocco traite les recherches, le stockage local, les cookies et les services publicitaires éventuels.',
    description: 'Politique de confidentialité IceMorocco : données saisies, stockage local, cookies, publicité Google AdSense et contact confidentialité.',
    body: `
      <h2>Données saisies</h2>
      <p>Les informations saisies dans le moteur de recherche ou dans les outils servent à fournir la fonctionnalité demandée. Les recherches peuvent être utilisées pour interroger les sources disponibles et afficher des résultats pertinents.</p>
      <h2>Stockage local</h2>
      <p>IceMorocco peut utiliser le stockage local du navigateur pour améliorer l’expérience, par exemple conserver temporairement des préférences, des résultats déjà consultés ou des informations de facture saisies par l’utilisateur.</p>
      <h2>Cookies, mesure et publicité</h2>
      <p>Le site peut utiliser des cookies ou technologies similaires pour le fonctionnement, la mesure d’audience et la publicité. Si Google AdSense est activé, Google et ses partenaires peuvent utiliser des cookies pour diffuser des annonces, mesurer leur performance et, lorsque permis, personnaliser les annonces selon les visites sur ce site ou d’autres sites.</p>
      <h2>Choix de l’utilisateur</h2>
      <p>Les visiteurs peuvent gérer les cookies dans les paramètres de leur navigateur et peuvent consulter les paramètres de publicité Google à l’adresse <a href="https://adssettings.google.com/" rel="nofollow noopener">adssettings.google.com</a>.</p>
      <h2>Partage des données</h2>
      <p>IceMorocco ne vend pas volontairement les informations saisies dans ses outils. Certaines requêtes peuvent toutefois être transmises à des services externes afin de fournir la recherche live ou la mesure technique du site.</p>
      <h2>Contact confidentialité</h2>
      <p>Pour toute question liée à la confidentialité ou à une demande de correction, contactez <strong>contact@icemorocco.com</strong>.</p>
    `,
  },
  terms: {
    title: 'Conditions d’Utilisation - IceMorocco',
    h1: 'Conditions d’Utilisation',
    lead: 'Ces conditions encadrent l’utilisation du moteur de recherche ICE Maroc et des outils proposés sur IceMorocco.',
    description: 'Conditions d’utilisation IceMorocco : règles du service, données indicatives, responsabilité, disponibilité et usage autorisé.',
    body: `
      <h2>Acceptation</h2>
      <p>En utilisant IceMorocco, vous acceptez d’utiliser les informations et les outils sous votre propre responsabilité.</p>
      <h2>Usage autorisé</h2>
      <p>Le site est destiné à la recherche d’informations d’entreprise, à la préparation de documents commerciaux et à des calculs indicatifs utiles aux professionnels.</p>
      <h2>Exactitude des informations</h2>
      <p>Nous faisons des efforts pour afficher des informations utiles, mais aucune garantie n’est donnée sur l’exhaustivité, l’actualité ou l’exactitude des données affichées.</p>
      <h2>Responsabilité</h2>
      <p>IceMorocco ne remplace pas un conseil juridique, fiscal, comptable ou administratif. Toute décision importante doit être validée auprès d’une source officielle ou d’un professionnel qualifié.</p>
      <h2>Disponibilité</h2>
      <p>Le service peut évoluer, être interrompu ou modifié à tout moment pour maintenance, amélioration ou contrainte technique.</p>
    `,
  },
  faq: {
    title: 'FAQ Recherche ICE Maroc - IceMorocco',
    h1: 'Questions fréquentes',
    lead: 'Réponses rapides sur la recherche ICE Maroc, la vérification d’entreprise et l’utilisation des données disponibles.',
    description: 'FAQ IceMorocco : comment rechercher une entreprise par ICE, trouver une société par nom et comprendre les données affichées.',
    body: `
      <h2>Comment rechercher une société par ICE ?</h2>
      <p>Choisissez le mode ICE, saisissez le numéro à 15 chiffres, puis lancez la recherche. Si une fiche correspondante est disponible, les informations associées seront affichées.</p>
      <h2>Comment trouver l’ICE avec le nom d’une entreprise ?</h2>
      <p>Choisissez le mode Nom et saisissez la raison sociale ou une partie du nom. Les résultats peuvent afficher l’ICE, la ville, le RC, la forme juridique, l’activité et la date de création lorsque ces données existent.</p>
      <h2>Pourquoi vérifier une entreprise marocaine ?</h2>
      <p>La vérification aide à limiter les erreurs de facturation, identifier un client ou fournisseur, préparer un devis et mieux comprendre une société avant une collaboration.</p>
      <h2>Les données sont-elles officielles ?</h2>
      <p>Les données sont affichées à titre indicatif. Pour un usage juridique, fiscal ou administratif, vérifiez toujours auprès des organismes officiels compétents.</p>
    `,
  },
};

const STATIC_TOOL_PAGES = {
  'verificateur-ice': {
    title: 'Vérificateur ICE Maroc - Contrôler un numéro ICE | IceMorocco',
    h1: 'Vérificateur ICE Maroc',
    lead: 'Contrôlez rapidement le format d’un numéro ICE marocain et lancez une recherche entreprise depuis IceMorocco.',
    description: 'Vérificateur ICE Maroc gratuit pour contrôler un numéro ICE à 15 chiffres et retrouver une entreprise marocaine par ICE ou nom.',
    appHash: 'ice-check',
    appTitlePattern: '<h2>Vérificateur ICE</h2>',
    cta: 'Ouvrir le vérificateur ICE',
    body: `
      <h2>Contrôler un numéro ICE marocain</h2>
      <p>Le vérificateur ICE aide à vérifier le format d’un numéro ICE avant une facture, un devis ou une recherche administrative. Un ICE marocain contient généralement 15 chiffres.</p>
      <h2>Recherche associée</h2>
      <p>Après le contrôle du format, vous pouvez lancer une recherche dans IceMorocco afin de consulter les informations disponibles sur la société : raison sociale, ville, RC, forme juridique, activité et date de création lorsque ces données existent.</p>
    `,
  },
  'cachet-entreprise': {
    title: 'Cachet Entreprise Maroc - Simulation et impression | IceMorocco',
    h1: 'Cachet Entreprise Maroc',
    lead: 'Créez une simulation professionnelle de cachet société rond ou rectangulaire, prête à imprimer.',
    description: 'Cachet entreprise Maroc avec aperçu en direct, mentions ICE, RC, ville, adresse et impression propre pour société marocaine.',
    appHash: 'stamp',
    appTitlePattern: '<h2>Cachet Entreprise</h2>',
    cta: 'Ouvrir le cachet entreprise',
    body: `
      <h2>Créer une maquette de cachet société</h2>
      <p>L’outil Cachet Entreprise permet de préparer rapidement un aperçu rond ou rectangulaire avec nom de société, ICE, RC, ville et adresse courte.</p>
      <h2>Aperçu imprimable</h2>
      <p>Le rendu peut être imprimé ou exporté en PDF afin de le transmettre à un imprimeur ou de valider les informations avant fabrication.</p>
    `,
  },
  'generateur-facture': {
    title: 'Générateur Facture Maroc - Facture conforme simple | IceMorocco',
    h1: 'Générateur Facture Maroc',
    lead: 'Créez une facture claire et professionnelle pour vos clients avec les informations essentielles de l’entreprise.',
    description: 'Générateur facture Maroc gratuit pour créer une facture professionnelle avec client, articles, TVA, total et montant en lettres.',
    appHash: 'invoice',
    appTitlePattern: '<h2 class="inv-h2">Facture</h2>',
    appTitleReplacement: '<h1 class="inv-h2">Générateur Facture Maroc</h1>',
    cta: 'Ouvrir le générateur facture',
    body: `
      <h2>Créer une facture professionnelle</h2>
      <p>Le générateur de facture IceMorocco aide les entrepreneurs, freelances et petites entreprises à préparer une facture lisible avec client, articles, quantités, TVA, totaux et montant en lettres.</p>
      <h2>Utilisation simple</h2>
      <p>L’outil est conçu pour rester rapide : saisissez votre entreprise, votre client, les lignes de facturation et imprimez un document propre. Les informations doivent être vérifiées avant émission officielle.</p>
    `,
  },
  'chiffres-en-lettres': {
    title: 'Chiffres en Lettres Maroc - Convertir un montant | IceMorocco',
    h1: 'Chiffres en Lettres',
    lead: 'Convertissez rapidement un montant en lettres pour facture, reçu, devis ou document commercial.',
    description: 'Outil chiffres en lettres pour convertir un montant en dirhams ou autre devise et l’utiliser dans une facture ou un document.',
    appHash: 'words',
    appTitlePattern: '<h2>Chiffres en Lettres</h2>',
    cta: 'Ouvrir chiffres en lettres',
    body: `
      <h2>Convertir un montant en lettres</h2>
      <p>L’outil chiffres en lettres transforme un montant numérique en texte afin de l’intégrer facilement dans une facture, un reçu, un devis ou une attestation.</p>
      <h2>Pour les documents commerciaux</h2>
      <p>La conversion aide à éviter les erreurs de rédaction et à produire des documents plus clairs pour les clients, fournisseurs et partenaires.</p>
    `,
  },
  'outils-societe': {
    title: 'Outils Société Maroc - Calculs et documents utiles | IceMorocco',
    h1: 'Outils Société Maroc',
    lead: 'Un espace pratique pour les calculs et documents utilisés par les entreprises marocaines au quotidien.',
    description: 'Outils société Maroc pour entrepreneurs : calcul TVA, marge commerciale, échéance, cachet entreprise, check-list création société et outils professionnels utiles.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    cta: 'Ouvrir les outils société',
    body: `
      <h2>Outils pratiques pour entreprise</h2>
      <p>IceMorocco rassemble des outils simples pour gagner du temps : calcul TVA Maroc, calcul marge commerciale, date d’échéance, cachet entreprise, check-list création société, recherche ICE Maroc, génération de facture et conversion des montants en lettres.</p>
      <h2>Un espace centralisé</h2>
      <p>L’objectif est d’offrir une plateforme claire pour les professionnels qui veulent vérifier une société, préparer un document commercial ou effectuer un calcul rapide.</p>
    `,
  },
  'calculateur-tva': {
    title: 'Calculateur TVA Maroc - HT TTC et taxe | IceMorocco',
    h1: 'Calculateur TVA Maroc',
    lead: 'Calculez rapidement un montant HT, TTC et la TVA selon les taux courants.',
    description: 'Calculateur TVA Maroc gratuit pour convertir un montant HT en TTC ou TTC en HT avec taux 20%, 14%, 10%, 7% ou 0%.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur TVA Maroc</h1>',
    cta: 'Ouvrir le calculateur TVA',
    body: `<h2>Calcul TVA HT TTC</h2><p>Utilisez le calculateur TVA pour estimer rapidement le montant hors taxe, la taxe et le total TTC. Les résultats sont indicatifs et doivent être vérifiés avant déclaration ou facturation officielle.</p>`,
  },
  'calculateur-salaire-net-brut': {
    title: 'Calculateur Salaire Net Brut Maroc | IceMorocco',
    h1: 'Calculateur Salaire Net Brut Maroc',
    lead: 'Estimez le passage du salaire brut au net ou du net vers un brut approximatif.',
    description: 'Calculateur salaire net brut Maroc gratuit avec estimation des cotisations et de l’IR mensuel.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur Salaire Net Brut Maroc</h1>',
    cta: 'Ouvrir le calculateur salaire',
    body: `<h2>Estimation salaire Maroc</h2><p>Le calculateur donne une estimation rapide du salaire net, des cotisations et de l’IR. Les résultats ne remplacent pas une paie officielle ou un conseil comptable.</p>`,
  },
  'calculateur-ir-maroc': {
    title: 'Calculateur IR Maroc - Impôt sur le revenu | IceMorocco',
    h1: 'Calculateur IR Maroc',
    lead: 'Estimez l’impôt sur le revenu mensuel à partir d’un revenu net imposable.',
    description: 'Calculateur IR Maroc gratuit pour estimer l’impôt sur le revenu mensuel et annuel.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur IR Maroc</h1>',
    cta: 'Ouvrir le calculateur IR',
    body: `<h2>Estimation IR mensuel</h2><p>L’outil applique un barème estimatif pour donner un ordre de grandeur. Vérifiez toujours le calcul final avec un professionnel ou les textes fiscaux applicables.</p>`,
  },
  'calculateur-auto-entrepreneur': {
    title: 'Calculateur Auto-Entrepreneur Maroc | IceMorocco',
    h1: 'Calculateur Auto-Entrepreneur Maroc',
    lead: 'Estimez la taxe auto-entrepreneur selon le chiffre d’affaires et le type d’activité.',
    description: 'Calculateur auto-entrepreneur Maroc gratuit pour estimer la taxe sur chiffre d’affaires de service ou commerce.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur Auto-Entrepreneur Maroc</h1>',
    cta: 'Ouvrir le calculateur auto-entrepreneur',
    body: `<h2>Taxe auto-entrepreneur</h2><p>Le calculateur estime la taxe selon un taux de service ou de commerce. Les plafonds et règles doivent être vérifiés avant déclaration.</p>`,
  },
  'calculateur-vignette-maroc': {
    title: 'Calculateur Vignette Maroc | IceMorocco',
    h1: 'Calculateur Vignette Maroc',
    lead: 'Estimez la vignette automobile selon carburant et puissance fiscale.',
    description: 'Calculateur vignette Maroc gratuit pour estimer le montant selon la puissance fiscale et le carburant.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur Vignette Maroc</h1>',
    cta: 'Ouvrir le calculateur vignette',
    body: `<h2>Estimation vignette</h2><p>Le calculateur donne une estimation selon des tranches courantes de puissance fiscale. Vérifiez le montant officiel avant paiement.</p>`,
  },
  'calculateur-credit': {
    title: 'Calculateur Crédit Maroc - Mensualité prêt | IceMorocco',
    h1: 'Calculateur Crédit Maroc',
    lead: 'Estimez une mensualité de prêt à partir du montant, du taux annuel et de la durée.',
    description: 'Calculateur crédit Maroc gratuit pour estimer la mensualité, le coût total et la durée d’un prêt.',
    appHash: 'tools',
    appTitlePattern: '<h2>Outils Société</h2>',
    appTitleReplacement: '<h1>Calculateur Crédit Maroc</h1>',
    cta: 'Ouvrir le calculateur crédit',
    body: `<h2>Simulation de mensualité</h2><p>Le calculateur de crédit donne une estimation simple de mensualité. Il ne tient pas compte de tous les frais bancaires ou assurances.</p>`,
  },
};

const GUIDE_CATEGORIES = {
  entreprise: {
    label: 'Entreprise',
    title: 'Guide entreprise Maroc',
    description: 'Guides administratifs pour créer, gérer et déclarer une entreprise au Maroc : SARL, ICE, CNSS, TVA, patente et auto-entrepreneur.',
    lead: 'Les démarches clés pour les entrepreneurs, freelances, comptables et petites sociétés au Maroc.',
  },
  citoyen: {
    label: 'Citoyen',
    title: 'Guide citoyen Maroc',
    description: 'Guides pratiques pour les démarches citoyennes au Maroc : passeport, CNIE, casier judiciaire, acte de naissance et légalisation.',
    lead: 'Documents, étapes, délais indicatifs et points à vérifier avant une démarche administrative.',
  },
  vehicules: {
    label: 'Véhicules',
    title: 'Guide véhicules Maroc',
    description: 'Guides pratiques pour les démarches liées aux véhicules au Maroc : vignette, carte grise, vente et changement de propriétaire.',
    lead: 'Les démarches courantes pour gérer un véhicule, préparer les documents et éviter les oublis.',
  },
  voyage: {
    label: 'Voyage',
    title: 'Guide visa et voyage',
    description: 'Guides de préparation pour les demandes de visa depuis le Maroc : Espagne, France, Italie et Canada étudiant.',
    lead: 'Préparer un dossier de voyage avec documents, frais indicatifs, délais et questions fréquentes.',
  },
  famille: {
    label: 'Famille',
    title: 'Guide famille Maroc',
    description: 'Guides pratiques pour les démarches familiales au Maroc : mariage, divorce, livret de famille, kafala et documents d’état civil.',
    lead: 'Les documents familiaux les plus demandés, expliqués simplement étape par étape.',
  },
  logement: {
    label: 'Logement',
    title: 'Guide logement Maroc',
    description: 'Guides pratiques pour acheter, louer ou gérer un logement au Maroc : contrat de bail, certificat de propriété, taxe et services.',
    lead: 'Préparer un dossier logement clair, éviter les oublis et comprendre les frais à vérifier.',
  },
  education: {
    label: 'Éducation',
    title: 'Guide éducation Maroc',
    description: 'Guides pour les démarches scolaires et universitaires au Maroc : bourse, bac, Massar, inscription et équivalence.',
    lead: 'Les démarches fréquentes pour élèves, étudiants et parents, avec documents et étapes.',
  },
  emploi: {
    label: 'Emploi',
    title: 'Guide emploi Maroc',
    description: 'Guides pour chercher un emploi, préparer un dossier professionnel et comprendre les démarches ANAPEC, CNSS et assurance maladie.',
    lead: 'Des repères utiles pour les salariés, chercheurs d’emploi et jeunes diplômés au Maroc.',
  },
};

const GUIDE_TOPICS = [
  {
    category: 'entreprise',
    slug: 'creer-sarl-maroc',
    title: 'Comment créer une SARL au Maroc',
    keyword: 'créer une SARL au Maroc',
    summary: 'Les étapes pour préparer une SARL au Maroc : dénomination, statuts, registre de commerce, identifiants fiscaux et dossier administratif.',
    price: 'Les frais dépendent du prestataire, des copies légalisées, de l’enregistrement et des formalités choisies. Demandez toujours un devis actualisé avant dépôt.',
    docs: ['Pièce d’identité des associés', 'Certificat négatif ou dénomination retenue', 'Statuts signés', 'Justificatif de siège social', 'Formulaires de création', 'Copies légalisées selon le dossier'],
    steps: ['Choisir la forme juridique et la dénomination', 'Préparer les statuts et le siège social', 'Signer et légaliser les documents requis', 'Déposer le dossier auprès des services compétents', 'Récupérer les identifiants de l’entreprise'],
  },
  {
    category: 'entreprise',
    slug: 'obtenir-ice-maroc',
    title: 'Comment obtenir un ICE au Maroc',
    keyword: 'obtenir un ICE',
    summary: 'L’ICE identifie une entreprise marocaine dans les échanges commerciaux et les documents comme les factures, devis et contrats.',
    price: 'L’obtention ou l’activation de l’ICE dépend du parcours de création et des services utilisés. Vérifiez le coût auprès du guichet ou du professionnel qui accompagne la démarche.',
    docs: ['Informations de l’entreprise', 'Registre de commerce si applicable', 'Identifiant fiscal si disponible', 'Adresse du siège', 'Pièce d’identité du représentant'],
    steps: ['Créer ou identifier l’entreprise', 'Rassembler les informations légales', 'Vérifier les identifiants existants', 'Demander ou confirmer l’ICE dans les services compétents', 'Utiliser l’ICE sur les documents commerciaux'],
  },
  {
    category: 'entreprise',
    slug: 'inscription-cnss-maroc',
    title: 'Comment s’inscrire à la CNSS',
    keyword: 'inscription CNSS Maroc',
    summary: 'L’inscription CNSS concerne les employeurs qui déclarent leurs salariés et respectent leurs obligations sociales.',
    price: 'Les frais et cotisations varient selon la situation de l’entreprise, les salariés déclarés et la réglementation en vigueur.',
    docs: ['Identifiants de l’entreprise', 'Registre de commerce ou justificatif d’activité', 'ICE et identifiant fiscal', 'RIB', 'Informations des salariés', 'Pièce d’identité du représentant'],
    steps: ['Préparer les informations de l’employeur', 'Créer ou compléter le dossier CNSS', 'Déclarer les salariés concernés', 'Vérifier les taux et échéances', 'Conserver les accusés et justificatifs'],
  },
  {
    category: 'entreprise',
    slug: 'auto-entrepreneur-maroc',
    title: 'Comment devenir Auto-Entrepreneur',
    keyword: 'auto-entrepreneur Maroc',
    summary: 'Le statut auto-entrepreneur aide à démarrer une activité simple avec des démarches allégées, sous conditions d’éligibilité.',
    price: 'Les frais peuvent dépendre des démarches, services et obligations déclaratives. Vérifiez les plafonds et conditions officiels avant inscription.',
    docs: ['CNIE', 'Coordonnées personnelles', 'Adresse', 'Activité choisie', 'RIB si demandé', 'Déclarations ou formulaires requis'],
    steps: ['Vérifier l’éligibilité de l’activité', 'Créer la demande d’inscription', 'Choisir l’activité principale', 'Finaliser l’identification', 'Respecter les déclarations périodiques'],
  },
  {
    category: 'entreprise',
    slug: 'declarer-tva-maroc',
    title: 'Comment déclarer la TVA',
    keyword: 'déclarer la TVA Maroc',
    summary: 'La déclaration TVA concerne les entreprises assujetties qui doivent suivre leurs ventes, achats, taux et échéances fiscales.',
    price: 'Le montant dépend de la TVA collectée, de la TVA déductible, du régime applicable et des déclarations déposées.',
    docs: ['Factures de vente', 'Factures d’achat', 'Identifiant fiscal', 'ICE', 'Livre ou état de TVA', 'Accès au portail fiscal si applicable'],
    steps: ['Classer les factures', 'Calculer TVA collectée et déductible', 'Vérifier les taux applicables', 'Préparer la déclaration', 'Déposer et conserver le justificatif'],
  },
  {
    category: 'entreprise',
    slug: 'obtenir-patente-maroc',
    title: 'Comment obtenir une patente',
    keyword: 'patente Maroc',
    summary: 'La patente, souvent liée à l’identification fiscale professionnelle, fait partie des informations importantes d’une entreprise.',
    price: 'Les montants et obligations dépendent de l’activité, de la commune, du régime fiscal et de la situation de l’entreprise.',
    docs: ['Identifiants de l’entreprise', 'Adresse du siège ou local', 'Registre de commerce si applicable', 'Contrat de bail ou justificatif de local', 'Pièce d’identité du représentant'],
    steps: ['Identifier l’activité exercée', 'Préparer le justificatif de local', 'Déposer ou mettre à jour le dossier fiscal', 'Récupérer les informations de patente', 'Vérifier les obligations annuelles'],
  },
  {
    category: 'citoyen',
    slug: 'passeport-maroc',
    title: 'Passeport Maroc',
    keyword: 'passeport Maroc',
    summary: 'Guide pour préparer une demande ou un renouvellement de passeport marocain avec les documents et étapes à vérifier.',
    price: 'Les droits et timbres peuvent changer. Vérifiez toujours le montant officiel avant paiement.',
    docs: ['CNIE', 'Photo d’identité conforme', 'Formulaire ou pré-demande', 'Justificatif de paiement si requis', 'Ancien passeport en cas de renouvellement', 'Documents complémentaires pour mineur'],
    steps: ['Vérifier la situation du demandeur', 'Préparer les documents', 'Payer les droits si applicable', 'Déposer la demande', 'Suivre le traitement et récupérer le passeport'],
  },
  {
    category: 'citoyen',
    slug: 'cnie-maroc',
    title: 'CNIE Maroc',
    keyword: 'CNIE Maroc',
    summary: 'Guide pour préparer une demande, un renouvellement ou une mise à jour de la carte nationale d’identité électronique.',
    price: 'Les frais dépendent du type de demande et peuvent changer. Consultez les informations officielles avant dépôt.',
    docs: ['Acte de naissance ou document requis', 'Photos d’identité', 'Justificatif de résidence si demandé', 'Ancienne CNIE en cas de renouvellement', 'Documents complémentaires selon la situation'],
    steps: ['Vérifier le type de demande', 'Préparer les pièces', 'Prendre rendez-vous si nécessaire', 'Déposer le dossier', 'Récupérer la CNIE'],
  },
  {
    category: 'citoyen',
    slug: 'casier-judiciaire-maroc',
    title: 'Casier judiciaire Maroc',
    keyword: 'casier judiciaire Maroc',
    summary: 'Guide pour demander un extrait de casier judiciaire ou document équivalent selon l’usage administratif.',
    price: 'Les frais peuvent varier selon la demande, le canal utilisé et les exigences administratives.',
    docs: ['CNIE ou passeport', 'Informations personnelles', 'Acte de naissance si demandé', 'Justificatif de demande selon le cas'],
    steps: ['Identifier le type d’extrait nécessaire', 'Préparer l’identité du demandeur', 'Déposer ou effectuer la demande en ligne si disponible', 'Vérifier les délais', 'Récupérer le document'],
  },
  {
    category: 'citoyen',
    slug: 'acte-naissance-maroc',
    title: 'Acte de naissance Maroc',
    keyword: 'acte de naissance Maroc',
    summary: 'Guide pour obtenir une copie intégrale ou un extrait d’acte de naissance au Maroc.',
    price: 'Les frais administratifs peuvent changer selon le canal et la commune concernée.',
    docs: ['Nom complet', 'Date et lieu de naissance', 'Informations des parents si demandées', 'CNIE du demandeur', 'Livret de famille si utile'],
    steps: ['Identifier le bureau d’état civil', 'Préparer les informations de naissance', 'Choisir le type d’acte', 'Déposer la demande', 'Vérifier les informations reçues'],
  },
  {
    category: 'citoyen',
    slug: 'legalisation-signature-maroc',
    title: 'Légalisation de signature Maroc',
    keyword: 'légalisation de signature Maroc',
    summary: 'Guide pour légaliser une signature sur un document administratif ou commercial.',
    price: 'Les frais varient selon la commune, le document et les règles locales applicables.',
    docs: ['CNIE', 'Document à signer', 'Copies éventuelles', 'Présence du signataire', 'Justificatifs complémentaires selon le document'],
    steps: ['Préparer le document sans le signer à l’avance si demandé', 'Présenter la CNIE', 'Signer devant l’agent habilité', 'Payer les frais si applicables', 'Vérifier le cachet de légalisation'],
  },
  {
    category: 'vehicules',
    slug: 'vignette-maroc',
    title: 'Vignette Maroc',
    keyword: 'vignette Maroc',
    summary: 'Guide pour comprendre la vignette automobile au Maroc, les informations à vérifier et les délais de paiement.',
    price: 'Le montant dépend notamment du véhicule, de la puissance fiscale, du carburant et de la réglementation en vigueur.',
    docs: ['Carte grise', 'Informations du véhicule', 'Identité du propriétaire', 'Moyen de paiement', 'Reçu précédent si utile'],
    steps: ['Identifier le véhicule', 'Vérifier la catégorie et puissance fiscale', 'Calculer ou consulter le montant', 'Payer dans les délais', 'Conserver le justificatif'],
  },
  {
    category: 'vehicules',
    slug: 'carte-grise-maroc',
    title: 'Carte grise Maroc',
    keyword: 'carte grise Maroc',
    summary: 'Guide pour préparer une demande de carte grise, duplicata ou modification liée au véhicule.',
    price: 'Les frais varient selon la démarche, le véhicule, les droits et les services utilisés.',
    docs: ['CNIE', 'Contrat ou justificatif du véhicule', 'Ancienne carte grise si disponible', 'Contrôle technique si demandé', 'Assurance ou documents complémentaires'],
    steps: ['Identifier la démarche exacte', 'Préparer les documents véhicule', 'Remplir les formulaires', 'Déposer le dossier', 'Suivre et récupérer la carte grise'],
  },
  {
    category: 'vehicules',
    slug: 'vente-vehicule-maroc',
    title: 'Vente d’un véhicule au Maroc',
    keyword: 'vente véhicule Maroc',
    summary: 'Guide pour préparer la vente d’un véhicule, les documents de cession et les points à vérifier avant signature.',
    price: 'Les frais dépendent des légalisations, mutations, taxes éventuelles et services utilisés.',
    docs: ['CNIE vendeur et acheteur', 'Carte grise', 'Contrat de vente', 'Contrôle technique si nécessaire', 'Quitus ou documents fiscaux si demandés'],
    steps: ['Vérifier l’identité des parties', 'Préparer le contrat de vente', 'Légaliser les signatures si requis', 'Remettre les documents du véhicule', 'Effectuer le changement de propriétaire'],
  },
  {
    category: 'vehicules',
    slug: 'changement-proprietaire-vehicule-maroc',
    title: 'Changement de propriétaire véhicule Maroc',
    keyword: 'changement propriétaire véhicule Maroc',
    summary: 'Guide pour transférer la propriété d’un véhicule après vente, donation ou autre changement.',
    price: 'Les frais changent selon le véhicule, la situation et les droits applicables.',
    docs: ['Contrat de vente ou justificatif de transfert', 'Carte grise', 'CNIE des parties', 'Documents fiscaux ou techniques demandés', 'Formulaires officiels'],
    steps: ['Rassembler les documents de cession', 'Vérifier les signatures', 'Préparer le dossier de mutation', 'Déposer la demande', 'Récupérer le nouveau document'],
  },
  {
    category: 'voyage',
    slug: 'visa-espagne-maroc',
    title: 'Visa Espagne depuis le Maroc',
    keyword: 'visa Espagne Maroc',
    summary: 'Guide pour préparer une demande de visa Espagne depuis le Maroc : documents, rendez-vous, assurance et justificatifs.',
    price: 'Les frais de visa et de service changent selon le type de visa, l’âge du demandeur et le centre de dépôt.',
    docs: ['Passeport valide', 'Photos', 'Formulaire de visa', 'Assurance voyage', 'Réservation ou invitation', 'Justificatifs financiers', 'Justificatif professionnel ou scolaire'],
    steps: ['Identifier le type de visa', 'Préparer le dossier', 'Prendre rendez-vous', 'Déposer les documents et biométrie', 'Suivre la décision'],
  },
  {
    category: 'voyage',
    slug: 'visa-france-maroc',
    title: 'Visa France depuis le Maroc',
    keyword: 'visa France Maroc',
    summary: 'Guide pour préparer une demande de visa France depuis le Maroc avec documents, étapes et points de vigilance.',
    price: 'Les frais varient selon la catégorie de visa, l’âge et les frais de service du centre de dépôt.',
    docs: ['Passeport valide', 'Formulaire de demande', 'Photos', 'Assurance voyage', 'Justificatifs de séjour', 'Ressources financières', 'Situation professionnelle ou scolaire'],
    steps: ['Choisir le type de visa', 'Remplir la demande', 'Réunir les justificatifs', 'Prendre rendez-vous', 'Déposer et suivre le dossier'],
  },
  {
    category: 'voyage',
    slug: 'visa-italie-maroc',
    title: 'Visa Italie depuis le Maroc',
    keyword: 'visa Italie Maroc',
    summary: 'Guide pour préparer un dossier de visa Italie depuis le Maroc selon le motif de voyage.',
    price: 'Les frais dépendent du visa, du centre et des services éventuels. Vérifiez les montants officiels avant paiement.',
    docs: ['Passeport valide', 'Formulaire', 'Photo', 'Assurance voyage', 'Réservation ou hébergement', 'Justificatifs financiers', 'Documents professionnels ou scolaires'],
    steps: ['Définir le motif du voyage', 'Préparer les documents', 'Réserver le rendez-vous', 'Déposer le dossier', 'Attendre la réponse'],
  },
  {
    category: 'voyage',
    slug: 'visa-canada-etudiant-maroc',
    title: 'Visa Canada étudiant depuis le Maroc',
    keyword: 'visa Canada étudiant Maroc',
    summary: 'Guide pour préparer un dossier d’études au Canada depuis le Maroc : admission, preuves financières, identité et étapes.',
    price: 'Les frais dépendent du permis, de la biométrie, des services et des exigences en vigueur au moment de la demande.',
    docs: ['Passeport valide', 'Lettre d’acceptation', 'Preuves financières', 'Documents scolaires', 'Photos ou biométrie', 'Formulaires demandés', 'Lettre explicative si utile'],
    steps: ['Obtenir une admission', 'Préparer les preuves financières', 'Créer ou compléter la demande', 'Payer les frais applicables', 'Suivre la décision et les instructions'],
  },
  {
    category: 'famille',
    slug: 'mariage-maroc',
    title: 'Mariage au Maroc',
    keyword: 'mariage Maroc',
    summary: 'Guide pour préparer un dossier de mariage au Maroc, comprendre les documents demandés et organiser les étapes avant l’acte.',
    price: 'Les frais varient selon les copies, traductions, légalisations, certificats médicaux et services utilisés.',
    docs: ['CNIE des futurs époux', 'Actes de naissance', 'Certificat médical', 'Photos si demandées', 'Autorisation ou documents complémentaires selon la situation', 'Justificatifs de résidence si requis'],
    steps: ['Vérifier la situation des deux époux', 'Rassembler les pièces d’état civil', 'Préparer les certificats demandés', 'Déposer le dossier auprès de l’autorité compétente', 'Signer l’acte et conserver des copies'],
  },
  {
    category: 'famille',
    slug: 'livret-famille-maroc',
    title: 'Livret de famille Maroc',
    keyword: 'livret de famille Maroc',
    summary: 'Guide pour demander, mettre à jour ou remplacer un livret de famille au Maroc après mariage, naissance ou perte.',
    price: 'Les frais dépendent de la commune, des copies demandées et du type de demande.',
    docs: ['CNIE', 'Acte de mariage', 'Actes de naissance des enfants si applicable', 'Ancien livret en cas de mise à jour', 'Déclaration de perte en cas de duplicata'],
    steps: ['Identifier le bureau compétent', 'Préparer les actes nécessaires', 'Remplir ou déposer la demande', 'Vérifier les informations inscrites', 'Récupérer le livret ou duplicata'],
  },
  {
    category: 'famille',
    slug: 'certificat-celibat-maroc',
    title: 'Certificat de célibat Maroc',
    keyword: 'certificat de célibat Maroc',
    summary: 'Guide pour préparer une demande de certificat de célibat ou document équivalent selon l’usage administratif.',
    price: 'Les frais peuvent varier selon la commune, les timbres, copies et légalisations demandées.',
    docs: ['CNIE', 'Acte de naissance récent si demandé', 'Déclaration sur l’honneur si requise', 'Justificatif de résidence', 'Copies légalisées selon la commune'],
    steps: ['Vérifier le document exact demandé', 'Préparer l’identité et l’état civil', 'Déposer la demande', 'Signer les déclarations requises', 'Contrôler la validité du document'],
  },
  {
    category: 'famille',
    slug: 'divorce-maroc-documents',
    title: 'Divorce au Maroc : documents et étapes',
    keyword: 'divorce Maroc documents',
    summary: 'Guide d’orientation pour comprendre les documents souvent demandés dans une procédure de divorce au Maroc.',
    price: 'Les coûts dépendent de la procédure, des copies, des notifications et de l’accompagnement juridique choisi.',
    docs: ['CNIE', 'Acte de mariage', 'Livret de famille', 'Actes de naissance des enfants si applicable', 'Adresse des parties', 'Documents judiciaires demandés'],
    steps: ['Identifier le type de procédure', 'Préparer les documents familiaux', 'Consulter un professionnel si nécessaire', 'Déposer ou suivre le dossier', 'Conserver les décisions et copies exécutoires'],
  },
  {
    category: 'logement',
    slug: 'contrat-bail-maroc',
    title: 'Contrat de bail Maroc',
    keyword: 'contrat de bail Maroc',
    summary: 'Guide pour préparer un contrat de location au Maroc, vérifier les clauses importantes et réunir les documents avant signature.',
    price: 'Les frais peuvent inclure copies, légalisation, avance, caution, agence et taxes selon le contrat.',
    docs: ['CNIE du bailleur et du locataire', 'Titre ou justificatif du logement si demandé', 'Contrat écrit', 'Reçu de paiement', 'État des lieux si possible'],
    steps: ['Vérifier l’identité des parties', 'Lire les clauses de durée, loyer et charges', 'Préparer les copies', 'Signer et légaliser si nécessaire', 'Conserver contrat et reçus'],
  },
  {
    category: 'logement',
    slug: 'certificat-propriete-maroc',
    title: 'Certificat de propriété Maroc',
    keyword: 'certificat de propriété Maroc',
    summary: 'Guide pour demander un certificat de propriété et comprendre les informations utiles avant achat, vente ou dossier bancaire.',
    price: 'Les frais dépendent du canal de demande, du titre foncier et des services utilisés.',
    docs: ['Numéro du titre foncier', 'Identité du demandeur', 'Justificatif d’intérêt si demandé', 'Moyen de paiement', 'Référence du bien'],
    steps: ['Récupérer la référence foncière', 'Choisir le canal de demande', 'Payer les frais applicables', 'Télécharger ou retirer le certificat', 'Vérifier propriétaire, charges et informations du bien'],
  },
  {
    category: 'logement',
    slug: 'acheter-appartement-maroc',
    title: 'Acheter un appartement au Maroc',
    keyword: 'acheter appartement Maroc',
    summary: 'Guide pour préparer l’achat d’un appartement au Maroc : vérifications, documents, frais et étapes avant signature.',
    price: 'Les frais peuvent inclure acompte, notaire, droits, taxes, conservation foncière, crédit et assurance.',
    docs: ['CNIE', 'Compromis ou promesse de vente', 'Certificat de propriété', 'Plan ou descriptif', 'Documents bancaires si crédit', 'Reçus et justificatifs de paiement'],
    steps: ['Vérifier le bien et le vendeur', 'Comparer prix et charges', 'Consulter notaire ou professionnel', 'Préparer financement et documents', 'Signer et suivre l’enregistrement'],
  },
  {
    category: 'logement',
    slug: 'taxe-habitation-maroc',
    title: 'Taxe d’habitation Maroc',
    keyword: 'taxe habitation Maroc',
    summary: 'Guide pour comprendre la taxe d’habitation au Maroc, les informations à vérifier et les documents utiles.',
    price: 'Le montant dépend de la valeur locative, de la commune, de la situation du bien et des règles applicables.',
    docs: ['Référence du bien', 'Identité du propriétaire ou occupant', 'Avis d’imposition si disponible', 'Justificatifs de paiement précédents', 'Documents de propriété ou bail'],
    steps: ['Identifier la taxe concernée', 'Vérifier l’avis ou la référence', 'Contrôler les informations du bien', 'Payer dans les délais', 'Conserver le reçu'],
  },
  {
    category: 'education',
    slug: 'bourse-etudiant-maroc',
    title: 'Bourse étudiant Maroc',
    keyword: 'bourse étudiant Maroc',
    summary: 'Guide pour préparer une demande de bourse au Maroc, suivre les documents demandés et éviter les oublis fréquents.',
    price: 'La demande peut nécessiter des copies, certificats ou documents scolaires. Les montants de bourse dépendent des critères officiels.',
    docs: ['CNIE ou identité de l’étudiant', 'Informations Massar si demandées', 'Baccalauréat ou inscription', 'Documents familiaux', 'RIB si requis', 'Justificatifs sociaux selon le dossier'],
    steps: ['Vérifier l’éligibilité', 'Préparer les informations scolaires', 'Rassembler les pièces familiales', 'Déposer la demande dans les délais', 'Suivre la réponse et le paiement'],
  },
  {
    category: 'education',
    slug: 'massar-maroc',
    title: 'Massar Maroc',
    keyword: 'Massar Maroc',
    summary: 'Guide pour utiliser Massar, récupérer les informations scolaires et suivre notes, orientation ou documents liés à l’élève.',
    price: 'L’accès au service est généralement lié au parcours scolaire. Certains documents imprimés ou copies peuvent avoir des frais selon le besoin.',
    docs: ['Code Massar', 'Mot de passe ou accès établissement', 'CNIE du tuteur si demandé', 'Informations de l’élève', 'Numéro de téléphone ou email'],
    steps: ['Récupérer les identifiants', 'Se connecter au service', 'Vérifier les notes et informations', 'Télécharger ou imprimer les documents utiles', 'Contacter l’établissement en cas d’erreur'],
  },
  {
    category: 'education',
    slug: 'inscription-bac-libre-maroc',
    title: 'Bac libre Maroc',
    keyword: 'bac libre Maroc',
    summary: 'Guide pour préparer une inscription au bac libre au Maroc, comprendre les conditions et organiser les documents.',
    price: 'Les frais et documents varient selon l’année, l’académie, les copies, photos et certificats demandés.',
    docs: ['CNIE', 'Photo d’identité', 'Justificatif de scolarité ou niveau si demandé', 'Adresse et coordonnées', 'Reçu ou formulaire d’inscription', 'Documents académiques selon la filière'],
    steps: ['Vérifier les conditions de candidature', 'Choisir la filière', 'Préparer les pièces', 'Déposer l’inscription dans les délais', 'Suivre convocation et examens'],
  },
  {
    category: 'education',
    slug: 'equivalence-diplome-maroc',
    title: 'Équivalence diplôme Maroc',
    keyword: 'équivalence diplôme Maroc',
    summary: 'Guide pour préparer une demande d’équivalence de diplôme au Maroc avec les pièces scolaires et administratives courantes.',
    price: 'Les frais peuvent inclure copies certifiées, traduction, légalisation et frais administratifs selon le dossier.',
    docs: ['Diplôme', 'Relevés de notes', 'CNIE ou passeport', 'Traduction si nécessaire', 'Attestation de scolarité ou programme', 'Formulaire de demande'],
    steps: ['Identifier l’autorité compétente', 'Préparer diplôme et relevés', 'Faire traduire ou certifier si demandé', 'Déposer le dossier', 'Suivre la décision'],
  },
  {
    category: 'emploi',
    slug: 'anapec-maroc',
    title: 'ANAPEC Maroc',
    keyword: 'ANAPEC Maroc',
    summary: 'Guide pour utiliser l’ANAPEC, préparer un profil candidat et organiser les documents utiles pour la recherche d’emploi.',
    price: 'L’inscription peut être gratuite selon les services, mais prévoyez copies, CV, attestations et déplacements.',
    docs: ['CNIE', 'CV', 'Diplômes ou attestations', 'Expériences professionnelles', 'Coordonnées', 'Photo si demandée'],
    steps: ['Créer ou mettre à jour le profil', 'Préparer CV et diplômes', 'Chercher les offres adaptées', 'Postuler et suivre les réponses', 'Préparer les entretiens'],
  },
  {
    category: 'emploi',
    slug: 'amo-maroc',
    title: 'AMO Maroc',
    keyword: 'AMO Maroc',
    summary: 'Guide pour comprendre l’assurance maladie obligatoire au Maroc, les documents souvent demandés et les étapes de suivi.',
    price: 'Les cotisations et remboursements dépendent du régime, de la situation professionnelle et des règles en vigueur.',
    docs: ['CNIE', 'Identifiant ou immatriculation', 'Documents professionnels ou sociaux', 'RIB si demandé', 'Formulaires ou justificatifs médicaux selon la demande'],
    steps: ['Identifier le régime concerné', 'Préparer les pièces personnelles', 'Compléter la demande ou affiliation', 'Suivre l’activation', 'Conserver les reçus et justificatifs'],
  },
  {
    category: 'emploi',
    slug: 'salaire-net-brut-maroc',
    title: 'Salaire net brut Maroc',
    keyword: 'salaire net brut Maroc',
    summary: 'Guide pour comprendre la différence entre salaire brut et salaire net au Maroc, avec les éléments à vérifier sur une fiche de paie.',
    price: 'Le net dépend du salaire brut, des cotisations sociales, de l’impôt sur le revenu, des avantages et de la situation du salarié.',
    docs: ['Contrat de travail', 'Bulletin de paie', 'Identifiant CNSS si disponible', 'Situation familiale si utile', 'Avantages ou primes'],
    steps: ['Identifier le salaire brut', 'Repérer cotisations et retenues', 'Vérifier les primes et avantages', 'Calculer le net estimatif', 'Comparer avec le bulletin de paie'],
  },
  {
    category: 'emploi',
    slug: 'attestation-travail-maroc',
    title: 'Attestation de travail Maroc',
    keyword: 'attestation de travail Maroc',
    summary: 'Guide pour demander une attestation de travail au Maroc et savoir quelles informations vérifier avant de l’utiliser.',
    price: 'La délivrance dépend de l’employeur. Des frais peuvent seulement concerner copies, légalisation ou traduction si demandées.',
    docs: ['CNIE', 'Informations salarié', 'Nom de l’employeur', 'Poste occupé', 'Dates de travail', 'Motif ou destinataire si demandé'],
    steps: ['Demander l’attestation au service concerné', 'Vérifier identité et poste', 'Contrôler dates et signature', 'Faire légaliser ou traduire si nécessaire', 'Conserver une copie'],
  },
  {
    category: 'citoyen',
    slug: 'permis-conduire-maroc',
    title: 'Permis de conduire Maroc',
    keyword: 'permis de conduire Maroc',
    summary: 'Guide pour préparer une demande de permis de conduire au Maroc, suivre les documents et comprendre les étapes de l’examen.',
    price: 'Les frais dépendent de l’auto-école, des examens, timbres, visites médicales et services utilisés.',
    docs: ['CNIE', 'Photos', 'Certificat médical', 'Formulaire de demande', 'Justificatif de paiement', 'Documents auto-école'],
    steps: ['Choisir une auto-école', 'Préparer le dossier', 'Suivre la formation', 'Passer les examens', 'Récupérer le permis ou le document provisoire'],
  },
  {
    category: 'citoyen',
    slug: 'renouvellement-permis-maroc',
    title: 'Renouvellement permis de conduire Maroc',
    keyword: 'renouvellement permis Maroc',
    summary: 'Guide pour renouveler un permis de conduire au Maroc, préparer les pièces et anticiper les délais.',
    price: 'Les frais varient selon la démarche, le support, les timbres, photos et éventuelle visite médicale.',
    docs: ['CNIE', 'Ancien permis', 'Photos', 'Certificat médical si demandé', 'Justificatif de paiement', 'Formulaire de renouvellement'],
    steps: ['Vérifier la validité du permis', 'Préparer les pièces', 'Payer les frais applicables', 'Déposer la demande', 'Suivre la production du nouveau permis'],
  },
  {
    category: 'citoyen',
    slug: 'rendez-vous-administration-maroc',
    title: 'Rendez-vous administration Maroc',
    keyword: 'rendez-vous administration Maroc',
    summary: 'Guide pour préparer un rendez-vous administratif au Maroc, organiser les documents et éviter un déplacement inutile.',
    price: 'Le rendez-vous peut être gratuit selon le service, mais les documents, timbres ou copies peuvent être payants.',
    docs: ['CNIE', 'Convocation ou confirmation', 'Formulaire de demande', 'Documents originaux', 'Copies', 'Reçus de paiement si applicables'],
    steps: ['Identifier le service compétent', 'Prendre rendez-vous si nécessaire', 'Préparer originaux et copies', 'Arriver avec la confirmation', 'Conserver les reçus et numéros de suivi'],
  },
  {
    category: 'voyage',
    slug: 'visa-usa-maroc',
    title: 'Visa USA depuis le Maroc',
    keyword: 'visa USA Maroc',
    summary: 'Guide pour préparer une demande de visa États-Unis depuis le Maroc avec formulaire, rendez-vous et justificatifs.',
    price: 'Les frais dépendent du type de visa et des règles consulaires. Vérifiez le montant officiel avant paiement.',
    docs: ['Passeport valide', 'Formulaire de demande', 'Photo conforme', 'Confirmation de rendez-vous', 'Justificatifs financiers', 'Documents professionnels ou scolaires'],
    steps: ['Choisir le type de visa', 'Remplir le formulaire', 'Payer les frais', 'Planifier le rendez-vous', 'Préparer l’entretien et les documents'],
  },
  {
    category: 'voyage',
    slug: 'visa-allemagne-maroc',
    title: 'Visa Allemagne depuis le Maroc',
    keyword: 'visa Allemagne Maroc',
    summary: 'Guide pour préparer une demande de visa Allemagne depuis le Maroc selon le motif de voyage.',
    price: 'Les frais varient selon le visa, le centre de dépôt, l’assurance, les traductions et les documents demandés.',
    docs: ['Passeport valide', 'Formulaire', 'Photos', 'Assurance voyage', 'Justificatifs de séjour', 'Preuves financières', 'Documents professionnels ou scolaires'],
    steps: ['Identifier le motif', 'Réunir les justificatifs', 'Réserver le rendez-vous', 'Déposer le dossier', 'Suivre la décision'],
  },
];

const GUIDE_TOPIC_MAP = new Map(GUIDE_TOPICS.map(topic => [topic.slug, topic]));
const GUIDE_VARIANTS = ['guide', 'faq', 'prix', 'documents'];
const GUIDE_LAST_UPDATED = '29 mai 2026';
const RICH_GUIDE_SLUGS = new Set([
  'passeport-maroc',
  'cnie-maroc',
  'casier-judiciaire-maroc',
  'auto-entrepreneur-maroc',
  'creer-sarl-maroc',
  'declarer-tva-maroc',
  'vignette-maroc',
  'carte-grise-maroc',
  'visa-france-maroc',
  'visa-espagne-maroc',
]);

const GUIDE_RICH_CONTENT = {
  'passeport-maroc': {
    audience: 'Marocains majeurs, mineurs avec représentant légal, renouvellement de passeport ou première demande.',
    delay: 'Le délai varie selon la ville, la période et la complétude du dossier. Prévoyez une marge avant tout voyage.',
    fees: [['Droits et timbre', 'À vérifier sur le portail officiel avant paiement'], ['Photos et copies', 'Selon le photographe et les copies demandées']],
    tips: ['Vérifiez la validité de la CNIE avant de préparer le dossier.', 'Pour un mineur, préparez les documents du représentant légal.', 'Gardez une copie du reçu ou justificatif de paiement.'],
  },
  'cnie-maroc': {
    audience: 'Citoyens marocains qui demandent une première CNIE, un renouvellement, une correction ou un duplicata.',
    delay: 'Le délai dépend du centre, du rendez-vous, de la demande et de la validation des données.',
    fees: [['Première demande ou renouvellement', 'Montant officiel à confirmer avant dépôt'], ['Duplicata ou correction', 'Selon le type de demande']],
    tips: ['Contrôlez l’orthographe du nom, prénom et date de naissance.', 'Préparez les photos au format demandé.', 'Conservez le récépissé jusqu’au retrait.'],
  },
  'casier-judiciaire-maroc': {
    audience: 'Candidats à un emploi, dossiers administratifs, concours, visa ou formalités demandant un extrait.',
    delay: 'Peut varier selon la juridiction, le canal de demande et la disponibilité des informations.',
    fees: [['Demande d’extrait', 'Frais administratifs à vérifier selon le canal'], ['Copies ou légalisation', 'Selon la demande']],
    tips: ['Vérifiez quel type d’extrait est demandé par l’organisme.', 'Préparez une pièce d’identité valide.', 'Contrôlez la durée de validité acceptée par le destinataire.'],
  },
  'auto-entrepreneur-maroc': {
    audience: 'Freelances, petits prestataires, commerçants et personnes qui veulent tester une activité simple.',
    delay: 'L’inscription dépend de la validation du dossier, de l’activité choisie et du parcours utilisé.',
    fees: [['Inscription', 'À confirmer sur le portail officiel ou auprès du point de dépôt'], ['Déclarations fiscales', 'Selon chiffre d’affaires, activité et régime en vigueur']],
    tips: ['Vérifiez les activités éligibles et les plafonds applicables.', 'Gardez une trace de vos encaissements.', 'Séparez compte personnel et suivi professionnel autant que possible.'],
  },
  'creer-sarl-maroc': {
    audience: 'Associés, entrepreneurs et porteurs de projet qui veulent créer une société commerciale au Maroc.',
    delay: 'La durée dépend de la préparation des statuts, du siège, des signatures, du dépôt et des validations.',
    fees: [['Certificat négatif, copies, légalisation', 'Variables selon prestataire et administration'], ['Accompagnement comptable ou juridique', 'Sur devis'], ['Formalités de création', 'À confirmer avant dépôt']],
    tips: ['Choisissez une activité cohérente avec le projet.', 'Vérifiez le siège social avant signature.', 'Préparez les informations des associés dès le départ.'],
  },
  'declarer-tva-maroc': {
    audience: 'Entreprises assujetties à la TVA, comptables, gérants et freelances soumis à déclaration.',
    delay: 'La déclaration suit les échéances fiscales applicables au régime de l’entreprise.',
    fees: [['TVA à payer', 'TVA collectée moins TVA déductible selon justificatifs'], ['Pénalités', 'Possibles en cas de retard ou erreur']],
    tips: ['Classez les factures par période.', 'Vérifiez le taux applicable avant calcul.', 'Conservez les justificatifs de dépôt et paiement.'],
  },
  'vignette-maroc': {
    audience: 'Propriétaires de véhicules particuliers ou professionnels qui doivent payer la taxe annuelle.',
    delay: 'La période et les pénalités éventuelles dépendent du calendrier fiscal en vigueur.',
    fees: [['Montant de vignette', 'Selon puissance fiscale, carburant et type de véhicule'], ['Retard', 'Pénalités possibles selon réglementation']],
    tips: ['Vérifiez la puissance fiscale sur la carte grise.', 'Conservez le reçu de paiement.', 'Contrôlez la catégorie du véhicule avant calcul.'],
  },
  'carte-grise-maroc': {
    audience: 'Acheteurs, vendeurs ou propriétaires demandant une carte grise, duplicata ou changement.',
    delay: 'Le délai varie selon le centre, le type de demande et la complétude du dossier.',
    fees: [['Mutation ou nouvelle carte', 'Selon véhicule et droits applicables'], ['Duplicata', 'Selon motif et justificatifs']],
    tips: ['Vérifiez que les informations du véhicule correspondent au contrat.', 'Gardez copies des pièces remises.', 'Ne retardez pas le changement après la vente.'],
  },
  'visa-france-maroc': {
    audience: 'Demandeurs de visa court séjour, visite familiale, tourisme, affaires ou autre motif depuis le Maroc.',
    delay: 'Les délais dépendent des rendez-vous, de la saison, du consulat et de la complétude du dossier.',
    fees: [['Frais de visa', 'Montant officiel à vérifier avant rendez-vous'], ['Frais de service', 'Selon le centre de dépôt'], ['Assurance et justificatifs', 'Selon dossier']],
    tips: ['Le motif du voyage doit être cohérent avec les justificatifs.', 'Préparez les preuves financières et professionnelles.', 'Ne réservez pas de dépenses non remboursables sans prudence.'],
  },
  'visa-espagne-maroc': {
    audience: 'Demandeurs de visa Espagne depuis le Maroc pour tourisme, visite familiale, affaires ou court séjour.',
    delay: 'Les délais peuvent augmenter pendant les périodes de forte demande ou selon le centre de dépôt.',
    fees: [['Frais de visa', 'Montant officiel à vérifier avant dépôt'], ['Frais de service', 'Selon le centre'], ['Assurance et documents', 'Selon le dossier']],
    tips: ['Vérifiez la cohérence entre dates, hébergement, assurance et ressources.', 'Préparez un dossier lisible et complet.', 'Conservez les reçus et numéro de suivi.'],
  },
};

const GUIDE_OFFICIAL_LINKS = {
  'creer-sarl-maroc': [
    ['Créer ou gérer une entreprise en ligne', 'DirectEntreprise', 'https://www.directentreprise.ma/'],
    ['Réserver un nom commercial', 'DirectInfo / OMPIC', 'https://www.directinfo.ma/'],
  ],
  'obtenir-ice-maroc': [
    ['Consulter ou vérifier un ICE', 'ICE Maroc', 'https://www.ice.gov.ma/'],
    ['Démarches fiscales entreprise', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'inscription-cnss-maroc': [
    ['Services CNSS', 'CNSS Maroc', 'https://www.cnss.ma/'],
    ['Portail employeurs', 'Damancom', 'https://www.damancom.ma/'],
  ],
  'auto-entrepreneur-maroc': [
    ['S’inscrire comme auto-entrepreneur', 'Registre National Auto-Entrepreneur', 'https://rn.ae.gov.ma/'],
    ['Informations auto-entrepreneur', 'Portail Auto-Entrepreneur', 'https://www.ae.gov.ma/'],
  ],
  'declarer-tva-maroc': [
    ['Déclarer et payer les impôts', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'obtenir-patente-maroc': [
    ['Démarches fiscales professionnelles', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'passeport-maroc': [
    ['Remplir une demande de passeport', 'Passeport.ma', 'https://www.passeport.ma/'],
    ['Suivre une demande de passeport', 'Passeport.ma', 'https://www.passeport.ma/SuiviDemande/SuiviDemande'],
  ],
  'cnie-maroc': [
    ['Pré-demande, rendez-vous et suivi CNIE', 'Portail CNIE', 'https://www.cnie.ma/'],
  ],
  'casier-judiciaire-maroc': [
    ['Demander un extrait de casier judiciaire', 'Ministère de la Justice', 'https://casierjudiciaire.justice.gov.ma/'],
  ],
  'acte-naissance-maroc': [
    ['Commander un acte de naissance', 'Watiqa', 'https://www.watiqa.gov.ma/'],
  ],
  'legalisation-signature-maroc': [
    ['Services de légalisation et copies conformes', 'Wraqi', 'https://www.wraqi.ma/'],
    ['Services consulaires pour MRE', 'Consulat.ma', 'https://www.consulat.ma/'],
  ],
  'vignette-maroc': [
    ['Payer la vignette automobile', 'Ma Vignette', 'https://www.mavignette.ma/mv/'],
    ['Informations fiscales', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'carte-grise-maroc': [
    ['Démarches carte grise', 'NARSA Khadamat', 'https://khadamatnarsa.ma/fr/services/carte-grise'],
    ['Informations carte grise', 'NARSA', 'https://narsa.ltc.ma/fr/cartes-grises'],
  ],
  'vente-vehicule-maroc': [
    ['Mutation de véhicule', 'NARSA', 'https://www.narsa-securiteroutiere.ma/fr/mutation-de-vehicules/'],
    ['Services carte grise', 'NARSA Khadamat', 'https://khadamatnarsa.ma/fr/services/carte-grise'],
  ],
  'changement-proprietaire-vehicule-maroc': [
    ['Mutation de véhicule', 'NARSA', 'https://www.narsa-securiteroutiere.ma/fr/mutation-de-vehicules/'],
    ['Services carte grise', 'NARSA Khadamat', 'https://khadamatnarsa.ma/fr/services/carte-grise'],
  ],
  'visa-espagne-maroc': [
    ['Demander un visa Espagne', 'BLS Spain Visa Morocco', 'https://morocco.blsspainvisa.com/'],
  ],
  'visa-france-maroc': [
    ['S’informer et commencer la demande', 'France-Visas Maroc', 'https://www.france-visas.gouv.fr/maroc'],
    ['Prendre rendez-vous visa France', 'TLScontact Maroc', 'https://visas-fr.tlscontact.com/visa/ma'],
  ],
  'visa-italie-maroc': [
    ['Centre visa Italie', 'TLScontact Italie', 'https://it.tlscontact.com/en/'],
  ],
  'visa-canada-etudiant-maroc': [
    ['Demander un permis d’études', 'IRCC Canada', 'https://www.canada.ca/fr/immigration-refugies-citoyennete/services/etudier-canada/permis-etudes/presenter-demande.html'],
    ['Trousse de demande étudiant', 'IRCC Canada', 'https://ircc.canada.ca/francais/information/demandes/etudiant.asp'],
  ],
  'mariage-maroc': [
    ['Services et informations judiciaires', 'Ministère de la Justice', 'https://adala.justice.gov.ma/'],
    ['Services consulaires pour MRE', 'Consulat.ma', 'https://www.consulat.ma/'],
  ],
  'livret-famille-maroc': [
    ['Documents d’état civil', 'Watiqa', 'https://www.watiqa.gov.ma/'],
  ],
  'certificat-celibat-maroc': [
    ['Attestation de célibat pour MRE', 'Consulat.ma', 'https://consulat.ma/index.php/fr/attestation-de-celibat'],
    ['Services consulaires', 'Consulat.ma', 'https://www.consulat.ma/'],
  ],
  'divorce-maroc-documents': [
    ['Services et informations judiciaires', 'Ministère de la Justice', 'https://adala.justice.gov.ma/'],
  ],
  'contrat-bail-maroc': [
    ['Services de légalisation et copies conformes', 'Wraqi', 'https://www.wraqi.ma/'],
    ['Informations fiscales', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'certificat-propriete-maroc': [
    ['Conservation foncière et cadastre', 'ANCFCC', 'https://www.ancfcc.gov.ma/'],
  ],
  'acheter-appartement-maroc': [
    ['Vérifier les informations foncières', 'ANCFCC', 'https://www.ancfcc.gov.ma/'],
    ['Impôts et taxes', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'taxe-habitation-maroc': [
    ['Payer ou vérifier les taxes', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'bourse-etudiant-maroc': [
    ['Demande de bourse', 'Minhaty', 'https://www.minhaty.ma/'],
    ['Suivi e-bourse', 'ONOUSC', 'https://e-bourse-maroc.onousc.ma/'],
  ],
  'massar-maroc': [
    ['Accéder à Massar', 'Massar Service', 'https://massarservice.men.gov.ma/'],
  ],
  'inscription-bac-libre-maroc': [
    ['Candidature bac libre', 'Ministère de l’Éducation Nationale', 'https://candidaturesbac.men.gov.ma/'],
  ],
  'equivalence-diplome-maroc': [
    ['Demande d’équivalence', 'Ministère de l’Éducation Nationale', 'https://equivalence.men.gov.ma/'],
  ],
  'anapec-maroc': [
    ['Chercher un emploi et gérer son profil', 'ANAPEC', 'https://www.anapec.org/'],
  ],
  'amo-maroc': [
    ['Services AMO et CNSS', 'CNSS Maroc', 'https://www.cnss.ma/'],
  ],
  'salaire-net-brut-maroc': [
    ['Cotisations sociales', 'CNSS Maroc', 'https://www.cnss.ma/'],
    ['Impôt sur le revenu', 'Direction Générale des Impôts', 'https://www.tax.gov.ma/'],
  ],
  'attestation-travail-maroc': [
    ['Droit du travail et emploi', 'Ministère de l’Inclusion économique', 'https://miepeec.gov.ma/'],
  ],
  'permis-conduire-maroc': [
    ['Obtenir le permis de conduire', 'NARSA Khadamat', 'https://khadamatnarsa.ma/fr/services/obtention-de-mon-permis-de-conduire-1ere-fois'],
  ],
  'renouvellement-permis-maroc': [
    ['Renouveler le permis de conduire', 'NARSA', 'https://www.narsa-securiteroutiere.ma/fr/echange-du-permis-de-conduire/'],
    ['Services NARSA', 'NARSA Khadamat', 'https://khadamatnarsa.ma/'],
  ],
  'rendez-vous-administration-maroc': [
    ['Services électroniques publics', 'Maroc.ma', 'https://www.maroc.ma/fr/services-electroniques'],
  ],
  'visa-usa-maroc': [
    ['Demander un visa États-Unis', 'U.S. Travel Docs', 'https://www.ustraveldocs.com/ma/'],
    ['Formulaire DS-160', 'U.S. Department of State', 'https://ceac.state.gov/genniv/'],
  ],
  'visa-allemagne-maroc': [
    ['Informations visa Allemagne', 'Ambassade d’Allemagne à Rabat', 'https://rabat.diplo.de/ma-fr'],
    ['Prendre rendez-vous visa Allemagne', 'TLScontact', 'https://de.tlscontact.com/ma/'],
  ],
};

function renderOfficialLinksBlock(topic) {
  const links = GUIDE_OFFICIAL_LINKS[topic.slug] || [];
  if (!links.length) return '';
  return `<section class="seo-panel official-links">
    <h2>Site officiel pour faire la demande</h2>
    <p>Utilisez uniquement les portails officiels ou les administrations compétentes pour remplir une demande, payer des frais ou prendre rendez-vous.</p>
    <div class="official-link-grid">
      ${links.map(([label, source, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(source)}</span>
      </a>`).join('')}
    </div>
  </section>`;
}

function renderRichGuideBlocks(topic) {
  const rich = GUIDE_RICH_CONTENT[topic.slug];
  if (!rich) return '';
  return `<section class="seo-panel rich-guide">
    <div class="last-updated">Dernière mise à jour : ${GUIDE_LAST_UPDATED}</div>
    <h2>Informations pratiques</h2>
    <p><strong>Pour qui ?</strong> ${escapeHtml(rich.audience)}</p>
    <p><strong>Délais indicatifs :</strong> ${escapeHtml(rich.delay)}</p>
    <p>Cette page sert de checklist de préparation. Les prix, formulaires et exigences peuvent évoluer : vérifiez toujours auprès de l’administration, du centre de dépôt ou du portail officiel concerné avant paiement ou dépôt.</p>
  </section>
  <section class="seo-panel">
    <h2>Tableau des frais à vérifier</h2>
    <table class="seo-table"><tbody>${rich.fees.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>
  </section>
  <section class="seo-panel">
    <h2>Conseils avant dépôt</h2>
    <ul class="seo-checklist">${rich.tips.map(tip => `<li>${escapeHtml(tip)}</li>`).join('')}</ul>
  </section>`;
}

function renderArticleIntro(topic) {
  const category = GUIDE_CATEGORIES[topic.category];
  return `<article class="guide-article">
    <div class="article-meta">
      <span>${escapeHtml(category.label)}</span>
      <span>Mis à jour le ${GUIDE_LAST_UPDATED}</span>
      <span>Lecture rapide</span>
    </div>
    <p class="article-lead">${escapeHtml(topic.summary)}</p>
    <p>Cette page est conçue comme un article pratique : elle explique quoi préparer, quels documents vérifier, quels frais anticiper et quelles erreurs éviter avant de commencer la démarche. L’objectif est de vous aider à arriver avec un dossier clair, complet et facile à contrôler.</p>
    <div class="article-highlights">
      <div><strong>${topic.docs.length} documents</strong><span>Liste de pièces à préparer avant le dépôt.</span></div>
      <div><strong>${topic.steps.length} étapes</strong><span>Parcours simple pour comprendre l’ordre de la démarche.</span></div>
      <div><strong>Frais à vérifier</strong><span>Les montants peuvent changer selon la ville et le service.</span></div>
    </div>
  </article>`;
}

function renderBeforeStartBlock(topic) {
  return `<section class="seo-panel article-section">
    <h2>Avant de commencer</h2>
    <p>Avant de déposer une demande pour ${escapeHtml(topic.keyword)}, prenez quelques minutes pour vérifier votre situation exacte. Une première demande, un renouvellement, une correction, une perte ou un dossier pour mineur ne demandent pas toujours les mêmes pièces.</p>
    <p>Préparez les originaux et les copies, vérifiez les dates de validité, et gardez une version numérique ou une photo des documents importants. Cette simple organisation évite souvent un deuxième déplacement.</p>
  </section>`;
}

function guideTopicUrl(topic, variant = 'guide') {
  if (variant === 'guide') return `/guide/${topic.slug}`;
  if (variant === 'faq') return `/faq/${topic.slug}`;
  return `/${variant}-${topic.slug}`;
}

function guideRelatedLinks(topic) {
  return GUIDE_VARIANTS
    .map(variant => `<a href="${guideTopicUrl(topic, variant)}">${variant === 'guide' ? topic.title : `${variant === 'faq' ? 'FAQ' : variant === 'prix' ? 'Prix' : 'Documents'} - ${topic.title}`}</a>`)
    .join('');
}

function renderGuideCards(topics) {
  return topics.map(topic => `<article class="seo-card">
    <h2><a href="${guideTopicUrl(topic)}">${escapeHtml(topic.title)}</a></h2>
    <p>${escapeHtml(topic.summary)}</p>
    <div class="seo-links compact">${guideRelatedLinks(topic)}</div>
  </article>`).join('');
}

function guideSchema(topic, canonical, variant = 'guide') {
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      ['Quel est le prix ?', topic.price],
      ['Quels documents préparer ?', `Préparez notamment : ${topic.docs.join(', ')}.`],
      ['Quelles sont les étapes ?', `Les étapes habituelles sont : ${topic.steps.join(', ')}.`],
      ['Quels délais prévoir ?', 'Les délais varient selon la ville, l’administration, la saison et la complétude du dossier.'],
    ].map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })),
  };
  const base = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: topic.title,
    name: topic.title,
    url: canonical,
    description: topic.summary,
    inLanguage: 'fr-MA',
    publisher: { '@type': 'Organization', name: 'IceMorocco', url: SITE_URL },
    dateModified: '2026-05-29',
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Guide administratif Maroc', item: `${SITE_URL}/guide` },
      { '@type': 'ListItem', position: 2, name: GUIDE_CATEGORIES[topic.category].title, item: `${SITE_URL}/guide/${topic.category}` },
      { '@type': 'ListItem', position: 3, name: topic.title, item: canonical },
    ],
  };
  return [base, faqSchema, breadcrumb];
}

function renderGuideLandingPage() {
  const body = `<section class="seo-panel"><h2>Catégories du guide administratif</h2><div class="seo-card-grid">${Object.entries(GUIDE_CATEGORIES)
    .map(([slug, category]) => `<article class="seo-card"><h2><a href="/guide/${slug}">${escapeHtml(category.title)}</a></h2><p>${escapeHtml(category.lead)}</p></article>`)
    .join('')}</div></section>
    <section class="seo-panel"><h2>Guides populaires</h2><div class="seo-card-grid">${renderGuideCards(GUIDE_TOPICS.slice(0, 8))}</div></section>`;
  return renderSeoLayout({
    title: 'Guide administratif Maroc - Entreprise, citoyen, véhicule et voyage | IceMorocco',
    description: 'Guide administratif Maroc par IceMorocco : démarches entreprise, citoyen, véhicules et voyage avec prix indicatifs, documents, étapes et FAQ.',
    canonical: `${SITE_URL}/guide`,
    h1: 'Guide administratif Maroc',
    lead: 'Un espace pratique pour préparer les démarches courantes au Maroc avec documents, prix indicatifs, délais et questions fréquentes.',
    body,
    schema: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Guide administratif Maroc', url: `${SITE_URL}/guide` },
    showSearch: false,
    breadcrumbRoot: 'Guide administratif Maroc',
  });
}

function renderGuideCategoryPage(categorySlug) {
  const category = GUIDE_CATEGORIES[categorySlug];
  if (!category) return null;
  const topics = GUIDE_TOPICS.filter(topic => topic.category === categorySlug);
  const body = `<section class="seo-panel"><h2>Démarches ${escapeHtml(category.label.toLowerCase())}</h2><div class="seo-card-grid">${renderGuideCards(topics)}</div></section>`;
  return renderSeoLayout({
    title: `${category.title} - Démarches et documents | IceMorocco`,
    description: category.description,
    canonical: `${SITE_URL}/guide/${categorySlug}`,
    h1: category.title,
    lead: category.lead,
    body,
    schema: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: category.title, url: `${SITE_URL}/guide/${categorySlug}`, description: category.description },
    showSearch: false,
    breadcrumbRoot: 'Guide administratif Maroc',
  });
}

function renderGuideTopicPage(topic, variant = 'guide') {
  const canonical = `${SITE_URL}${guideTopicUrl(topic, variant)}`;
  const variantLabel = variant === 'guide' ? topic.title : `${variant === 'faq' ? 'FAQ' : variant === 'prix' ? 'Prix' : 'Documents'} - ${topic.title}`;
  const priceBlock = `<section class="seo-panel"><h2>Prix et frais indicatifs</h2><p>${escapeHtml(topic.price)}</p><p>Les montants administratifs peuvent changer. Vérifiez toujours les informations auprès du service officiel ou du centre de dépôt avant paiement.</p></section>`;
  const docsBlock = `<section class="seo-panel"><h2>Documents nécessaires</h2><ul class="seo-checklist">${topic.docs.map(doc => `<li>${escapeHtml(doc)}</li>`).join('')}</ul></section>`;
  const stepsBlock = `<section class="seo-panel"><h2>Étapes de la démarche</h2><ol class="seo-steps">${topic.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section>`;
  const articleIntro = renderArticleIntro(topic);
  const beforeStartBlock = renderBeforeStartBlock(topic);
  const officialLinksBlock = renderOfficialLinksBlock(topic);
  const richBlocks = renderRichGuideBlocks(topic);
  const faqBlock = `<section class="seo-panel"><h2>Questions fréquentes</h2>
    <details open><summary>Combien coûte cette démarche ?</summary><p>${escapeHtml(topic.price)}</p></details>
    <details><summary>Quels documents préparer ?</summary><p>${escapeHtml(topic.docs.join(', '))}.</p></details>
    <details><summary>Quels délais prévoir ?</summary><p>Les délais varient selon la ville, l’administration, la période et la complétude du dossier. Préparez une marge et vérifiez le suivi auprès du service concerné.</p></details>
    <details><summary>Où vérifier l’information officielle ?</summary><p>Consultez toujours le portail officiel, l’administration concernée ou le centre de dépôt avant de payer ou de déposer un dossier.</p></details>
  </section>`;
  const variantsBlock = `<section class="seo-panel"><h2>Pages liées</h2><div class="seo-links">${guideRelatedLinks(topic)}<a href="/guide/${topic.category}">${escapeHtml(GUIDE_CATEGORIES[topic.category].title)}</a></div></section>`;
  const bodyByVariant = {
    guide: `${articleIntro}${officialLinksBlock}${beforeStartBlock}${richBlocks}${docsBlock}${priceBlock}${stepsBlock}${faqBlock}${variantsBlock}`,
    faq: articleIntro + officialLinksBlock + richBlocks + faqBlock + docsBlock + priceBlock + variantsBlock,
    prix: articleIntro + officialLinksBlock + richBlocks + priceBlock + docsBlock + stepsBlock + variantsBlock,
    documents: articleIntro + officialLinksBlock + richBlocks + docsBlock + stepsBlock + priceBlock + variantsBlock,
  };
  return renderSeoLayout({
    title: `${variantLabel} | IceMorocco`,
    description: `${variantLabel} : documents nécessaires, prix indicatifs, étapes et questions fréquentes pour préparer la démarche au Maroc.`,
    canonical,
    h1: variantLabel,
    lead: topic.summary,
    body: bodyByVariant[variant] || bodyByVariant.guide,
    schema: guideSchema(topic, canonical, variant),
    showSearch: false,
    breadcrumbRoot: 'Guide administratif Maroc',
  });
}

function renderInfoPage(slug, page) {
  const canonical = `${SITE_URL}/${slug}`;
  return renderSeoLayout({
    title: page.title,
    description: page.description,
    canonical,
    h1: page.h1,
    lead: page.lead,
    body: `<section class="seo-panel info-card legal-copy">${page.body}</section>`,
    schema: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: page.h1,
      url: canonical,
      description: page.description,
    },
  });
}

function renderToolPage(slug, page) {
  const canonical = `${SITE_URL}/${slug}`;
  const body = `<section class="seo-panel info-card legal-copy">${page.body}<p><a class="seo-cta" href="/#${escapeHtml(page.appHash)}">${escapeHtml(page.cta)}</a></p></section>
    <section class="seo-panel"><h2>Autres outils utiles</h2><div class="seo-links">${Object.entries(STATIC_TOOL_PAGES)
      .filter(([key]) => key !== slug)
      .map(([key, item]) => `<a href="/${key}">${escapeHtml(item.h1)}</a>`)
      .join('')}<a href="/">Recherche ICE Maroc</a></div></section>`;
  return renderSeoLayout({
    title: page.title,
    description: page.description,
    canonical,
    h1: page.h1,
    lead: page.lead,
    body,
    schema: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: page.h1,
      url: canonical,
      description: page.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
    },
  });
}

function replaceMetaContent(html, name, content) {
  const safeContent = escapeHtml(content);
  const re = new RegExp(`<meta name="${name}" content="[^"]*"\\/>`);
  return html.replace(re, `<meta name="${name}" content="${safeContent}"/>`);
}

function replaceOgContent(html, property, content) {
  const safeContent = escapeHtml(content);
  const re = new RegExp(`<meta property="${property}" content="[^"]*"\\/>`);
  return html.replace(re, `<meta property="${property}" content="${safeContent}"/>`);
}

function renderToolAppPage(slug, page) {
  const canonical = `${SITE_URL}/${slug}`;
  let html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  const pageId = `page-${page.appHash}`;
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*"\/>/, `<link rel="canonical" href="${escapeHtml(canonical)}"/>`)
    .replace(/<body class="[^"]*">/, `<body class="is-${escapeHtml(page.appHash)}-page">`)
    .replace('id="page-search" class="page active"', 'id="page-search" class="page"')
    .replace(`id="${pageId}" class="page"`, `id="${pageId}" class="page active"`)
    .replace('<h1>Recherche ICE Maroc</h1>', '<div class="search-page-title">Recherche ICE Maroc</div>');
  if (page.appTitlePattern) {
    html = html.replace(page.appTitlePattern, page.appTitleReplacement || `<h1>${escapeHtml(page.h1)}</h1>`);
  }
  html = replaceMetaContent(html, 'description', page.description);
  html = replaceOgContent(html, 'og:title', page.title);
  html = replaceOgContent(html, 'og:description', page.description);
  html = replaceOgContent(html, 'og:url', canonical);
  html = replaceMetaContent(html, 'twitter:title', page.title.replace(' | IceMorocco', ''));
  html = replaceMetaContent(html, 'twitter:description', page.description);
  return html.replace('</head>', `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: page.h1,
    url: canonical,
    description: page.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
  }).replace(/</g, '\\u003c')}</script>\n</head>`);
}

function renderRobots() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

function sitemapEntry(loc, priority = '0.7') {
  return `<url><loc>${escapeXml(loc)}</loc><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
}

function renderSitemap() {
  const guideUrls = [
    sitemapEntry(`${SITE_URL}/guide`, '0.92'),
    ...Object.keys(GUIDE_CATEGORIES).map(slug => sitemapEntry(`${SITE_URL}/guide/${slug}`, '0.88')),
    ...GUIDE_TOPICS.flatMap(topic => GUIDE_VARIANTS.map(variant => sitemapEntry(`${SITE_URL}${guideTopicUrl(topic, variant)}`, variant === 'guide' ? '0.86' : '0.78'))),
  ];
  const urls = [
    sitemapEntry(`${SITE_URL}/`, '1.0'),
    sitemapEntry(`${SITE_URL}/recherche-ice-maroc`, '0.95'),
    sitemapEntry(`${SITE_URL}/annuaire-entreprises-marocaines`, '0.9'),
    sitemapEntry(`${SITE_URL}/top-recherches-ice`, '0.85'),
    ...guideUrls,
    ...Object.keys(STATIC_INFO_PAGES).map(slug => sitemapEntry(`${SITE_URL}/${slug}`, '0.75')),
    ...Object.keys(STATIC_TOOL_PAGES).map(slug => sitemapEntry(`${SITE_URL}/${slug}`, '0.86')),
    ...SEO_CITIES.map(city => sitemapEntry(`${SITE_URL}/ville/${slugify(city)}`, '0.8')),
    ...Object.keys(SEO_CATEGORIES).map(cat => sitemapEntry(`${SITE_URL}/categorie/${cat}`, '0.8')),
    ...LOCAL_COMPANIES.filter(company => company.name).slice(0, 500).flatMap(company => {
      const entries = [sitemapEntry(companySeoUrl(company), '0.7')];
      if (normalizeIce(company.ice)) entries.push(sitemapEntry(iceSeoUrl(company), '0.7'));
      return entries;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

function rememberCompanies(companies = []) {
  companies.forEach(company => {
    const key = companyCacheKey(company);
    if (!key) return;
    const previous = discoveredCompanies.get(key) || {};
    discoveredCompanies.set(key, { ...previous, ...company });
  });
}

function searchDiscoveredByIce(query) {
  const needle = normalizeIce(query);
  if (!needle) return [];
  return [...discoveredCompanies.values()].filter(company => {
    const ice = normalizeIce(company.ice);
    return ice && (ice === needle || ice.startsWith(needle));
  });
}

function searchDiscoveredByName(query) {
  const sources = [...discoveredCompanies.values(), ...LOCAL_COMPANIES];
  return dedupeCompanies(sources.filter(company => isCloseCompanyMatch(company, query)));
}

async function enrichMissingIceFromIcemaroc(companies = []) {
  const missing = companies
    .filter(company => company && company.name && !normalizeIce(company.ice))
    .slice(0, 6);
  if (!missing.length) return companies;

  const enrichments = await Promise.all(missing.map(async company => {
    const matches = await withTimeout(searchIcemarocSource(company.name).catch(() => []), 1200, []);
    const exact = dedupeCompanies(matches).find(match => sameCompany(company, match) && normalizeIce(match.ice));
    return exact ? mergeCompanyRecords(exact, company) : company;
  }));

  const byName = new Map(enrichments.map(company => [normalizeCompanyName(company.name), company]));
  return dedupeCompanies(companies.map(company => {
    if (!company || normalizeIce(company.ice)) return company;
    return byName.get(normalizeCompanyName(company.name)) || company;
  }));
}

function parseSearchResults(html) {
  const results = [];
  const seen = new Set();

  // Real HTML pattern: <a href="/societe-slug-123" ...>Company Name</a>
  // Also matches: <a href="https://www.charika.ma/societe-slug-123">
  const linkRe = /<a[^>]+href=["'](?:https?:\/\/www\.charika\.ma)?\/societe-([a-z0-9][a-z0-9-]*?-(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[1];
    const id = m[2];
    const rawName = strip(m[3]);

    // Skip junk
    if (seen.has(id)) continue;
    if (!rawName || rawName.length < 2 || rawName.length > 200) continue;
    if (/^(consulter|voir|cliquer|éditer|soyez|ajouter|donner)/i.test(rawName)) continue;
    // Skip top companies sidebar (OCP, Afriquia, etc appear on every page)
    if (/^(OCP|SOCIETE AFRIQUIA|TOTAL ENERGIES|VIVO ENERGY)$/i.test(rawName)) continue;
    seen.add(id);

    // Look for activity in the nearby HTML (within 800 chars after the link)
    const afterPos = m.index + m[0].length;
    const after = html.substring(afterPos, afterPos + 800);
    const actMatch = after.match(/Secteur d[''']activit[ée]\s*:\s*([^<]+)/i);
    const isDissolved = after.substring(0, 300).toLowerCase().includes('dissolution');

    results.push({
      name: rawName,
      slug,
      url: `https://www.charika.ma/societe-${slug}`,
      act: actMatch ? strip(actMatch[1]).substring(0, 300) : '',
      statut: isDissolved ? 'Dissous' : 'Actif',
    });
  }

  return results;
}

function formatCapital(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return `${amount.toLocaleString('fr-FR')} DHS`;
}

function formatCompanyDate(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const clean = raw.replace(/[T\s].*$/, '').replace(/\./g, '/').replace(/-/g, '/');
  let m = clean.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = clean.match(/^(\d{4})\/(\d{1,2})$/);
  if (m) return `${m[2].padStart(2, '0')}/${m[1]}`;
  m = clean.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2]}`;
  m = clean.match(/^(\d{4})$/);
  if (m) return m[1];
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  }
  return raw;
}

function dateSortValue(value = '') {
  const formatted = formatCompanyDate(value);
  if (!formatted) return Number.POSITIVE_INFINITY;
  let m = formatted.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return Number(`${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`);
  m = formatted.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return Number(`${m[2]}${m[1].padStart(2, '0')}01`);
  m = formatted.match(/^(\d{4})$/);
  if (m) return Number(`${m[1]}0101`);
  return Number.POSITIVE_INFINITY;
}

function pickCreationDate(...values) {
  const dates = values.map(formatCompanyDate).filter(Boolean);
  if (!dates.length) return '';
  return dates.sort((a, b) => dateSortValue(a) - dateSortValue(b))[0];
}

async function searchIcemarocSource(query) {
  try {
    const apiUrl = `https://www.icemaroc.com/api/search.php?query=${encodeURIComponent(query)}`;
    const text = await fetchUrl(apiUrl, { headers: { 'Referer': 'https://www.icemaroc.com/' } });
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];

    return data.map(item => ({
      name: decodeHtml(item.raison_sociale || ''),
      type: decodeHtml(item.forme || ''),
      ice: item.ice || '',
      rc: item.num_rc ? `${item.num_rc} (${decodeHtml(item.ville_rc || '')})` : '',
      date: formatCompanyDate(item.dateCreation || ''),
      cap: formatCapital(item.capital),
      act: decodeHtml(item.activite || ''),
      statut: (item.statut || '').toUpperCase() === 'EN ACTIVITE' ? 'Actif' : 'Dissous',
      ville: decodeHtml(item.ville_rc || ''),
      url: '',
      slug: '',
    })).filter(company => company.name);
  } catch (err) {
    console.error('IceMaroc error:', err.message);
    return [];
  }
}

function buildCharikaUrl(company = {}) {
  if (company.url) return company.url;
  if (company.enseigne && company.idBil) {
    return `https://www.charika.ma/societe-${company.enseigne}-${company.idBil}`;
  }
  if (company.slug) {
    return `https://www.charika.ma/societe-${company.slug}`;
  }
  return '';
}

async function searchCharikaAutocomplete(query) {
  const url = `https://www.charika.ma/societe-loadlistsociete?denomination=${encodeURIComponent(query)}`;
  const text = await fetchUrl(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.charika.ma/accueil',
    },
  });

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON response from charika autocomplete');
  }

  const results = Array.isArray(payload.listSociete) ? payload.listSociete : [];
  return results.map(company => {
    const legalType = decodeHtml(company.formeJuridique || '');
    const city = decodeHtml(company.ville || company.province || '');
    const address = decodeHtml(company.adresse || '');
    const activity = decodeHtml(company.activite || company.objetSocial || '');

    return {
      name: decodeHtml(company.denomination || ''),
      slug: company.enseigne && company.idBil ? `${company.enseigne}-${company.idBil}` : '',
      enseigne: company.enseigne || '',
      idBil: company.idBil || '',
      idEntreprise: company.idEntreprise || '',
      url: buildCharikaUrl(company),
      type: legalType,
      ice: company.ice || '',
      if_: company.identifiantFiscal || company.if || '',
      pat: company.patente || company.taxeProfessionnelle || '',
      date: formatCompanyDate(company.dateImmatriculation || company.dateCreation || company.anneeCreation || ''),
      rc: company.rc ? `${company.rc}${company.nomTribunal ? ` (${decodeHtml(company.nomTribunal)})` : ''}` : '',
      addr: address,
      ville: city,
      act: activity,
      cap: formatCapital(company.capital),
      tel: [company.tel1, company.tel2, company.tel3, company.tel4].filter(Boolean).join(' / '),
      fax: [company.fax1, company.fax2].filter(Boolean).join(' / '),
      email: [company.email1, company.email2].filter(Boolean).join(' / '),
      website: decodeHtml(company.siteWeb || '').replace(/^https?:\/\//, ''),
      statut: company.entStatut === 'RAD' ? 'Dissous' : 'Actif',
    };
  }).filter(company => company.name);
}

// ─── Parse company detail page ────────────────────────────────
function parseCompanyDetail(html) {
  const c = {
    name: '', type: '', ice: '', if_: '', rc: '', pat: '', cap: '',
    addr: '', ville: '', act: '', date: '', statut: 'Actif',
    tel: '', fax: '', email: '', website: '', directors: [],
  };

  // Name from title
  const titleM = html.match(/<title[^>]*>Fiche d['']Identit(?:é|&eacute;)\s*Soci(?:é|&eacute;)t(?:é|&eacute;)\s*:\s*([^<]+)/i);
  if (titleM) c.name = strip(titleM[1]).replace(/\s*-\s*CHARIKA$/i, '');
  if (!c.name) {
    const h1M = html.match(/<h1[^>]*class="[^"]*society-name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    if (h1M) c.name = strip(h1M[1]);
  }

  const actM = html.match(/<b>\s*Activit(?:&eacute;|é)\s*:\s*<\/b>\s*<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (actM) c.act = strip(actM[1]);

  const addrM = html.match(/<b[^>]*>\s*Adresse\s*<\/b>\s*<\/span>\s*<span>\s*<label>([\s\S]*?)<\/label>/i);
  if (addrM) c.addr = strip(addrM[1]);

  const typeM = html.match(/Forme juridique\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (typeM) c.type = strip(typeM[1]);

  const capM = html.match(/Capital\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (capM) c.cap = strip(capM[1]);

  // Phones
  const phones = [], faxes = [];
  const phoneRe = /0[5-7]\d{8}/g;
  let pm;
  while ((pm = phoneRe.exec(html)) !== null) {
    const num = pm[0];
    // Skip charika's own number
    if (num.startsWith('0522233') || num.startsWith('0522276')) continue;
    const ctx = html.substring(Math.max(0, pm.index - 150), pm.index);
    if (/fax/i.test(ctx)) { if (!faxes.includes(num)) faxes.push(num); }
    else { if (!phones.includes(num)) phones.push(num); }
  }
  c.tel = phones.slice(0, 3).join(' / ');
  c.fax = faxes.slice(0, 2).join(' / ');

  // Email
  const emails = [];
  const emailRe = /mailto:([^"'\s]+@[^"'\s]+)/gi;
  let em;
  while ((em = emailRe.exec(html)) !== null) {
    const e = em[1].toLowerCase();
    if (!e.includes('charika') && !e.includes('inforisk') && !e.includes('contact@charika')) {
      if (!emails.includes(e)) emails.push(e);
    }
  }
  c.email = emails.slice(0, 2).join(' / ');

  // Website
  const webRe = /href="(https?:\/\/(?:www\.)?[^"]+)"[^>]*>.*?(?:www\.|https?:\/\/)/gi;
  let wm;
  while ((wm = webRe.exec(html)) !== null) {
    const s = wm[1];
    if (!['charika','inforisk','facebook','twitter','google','linkedin','youtube','instagram','javascript']
        .some(x => s.includes(x))) {
      c.website = s.replace(/^https?:\/\//, '');
      break;
    }
  }

  // Legal type
  if (!c.type) {
    const types = [
      [/\bSARL\s*AU\b/i, 'SARL AU'], [/\bSARL\b/i, 'SARL'], [/\bSAS\b/i, 'SAS'],
      [/\bSA\b(?!\s*RL)/i, 'SA'], [/\bSNC\b/i, 'SNC'],
    ];
    for (const [re, t] of types) { if (re.test(c.name)) { c.type = t; break; } }
  }

  // City
  const cities = ['Casablanca','Rabat','Marrakech','Fès','Tanger','Agadir','Meknès','Oujda',
    'Kénitra','Tétouan','Salé','Nador','Mohammedia','El Jadida','Béni Mellal','Khouribga',
    'Settat','Berrechid','Safi','Laâyoune','Ouarzazate','Errachidia','Taza','Khémisset',
    'Guelmim','Dakhla','Essaouira','Larache','Al Hoceima','Tiznit','Taroudant'];
  if (c.addr.includes(' - ')) {
    c.ville = c.addr.split(' - ').pop().trim();
  }
  const addressText = `${c.addr} ${html}`.toLowerCase();
  for (const city of cities) {
    if (!c.ville && addressText.includes(city.toLowerCase())) { c.ville = city; break; }
  }

  // --- Extract Identifiers from stripped HTML ---
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

  // ICE
  const iceM = text.match(/(?:ICE|Identifiant Commun d['’]Entreprise)\s*[:=]?\s*([\d\s]{15,20})/i);
  if (iceM) {
    const cleaned = iceM[1].replace(/\D/g, '');
    if (cleaned.length === 15) c.ice = cleaned;
  }

  // IF
  const ifM = text.match(/(?:IF|I\.F\.|Identifiant Fiscal)\s*[:=]?\s*(\d{7,10})/i);
  if (ifM) c.if_ = ifM[1];

  // RC
  const rcM = text.match(/(?:RC|R\.C\.|Registre de commerce)\s*[:=]?\s*([a-zA-Z0-9\s-]+)/i);
  if (rcM) {
    const rcVal = strip(rcM[1]).trim();
    if (rcVal.toLowerCase() !== 'ss' && rcVal.toLowerCase() !== 'n a') {
      c.rc = rcVal.substring(0, 30);
    }
  }

  // Patente
  const patM = text.match(/(?:Patente|Taxe professionnelle)\s*[:=]?\s*(\d{8,15})/i);
  if (patM) c.pat = patM[1];

  return c;
}

// ─── HTTP Server ──────────────────────────────────────────────
const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTS[0]}`);
  const pathname = decodeURIComponent(url.pathname);

  // ── SEO: robots, sitemap, and crawlable landing pages ──
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(renderRobots());
  }

  if (pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(renderSitemap());
  }

  if (pathname === '/guide' || pathname === '/guide/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderGuideLandingPage());
  }

  if (pathname.startsWith('/guide/')) {
    const slug = pathname.replace('/guide/', '').replace(/\/$/, '');
    if (GUIDE_CATEGORIES[slug]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderGuideCategoryPage(slug));
    }
    const topic = GUIDE_TOPIC_MAP.get(slug);
    if (topic) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderGuideTopicPage(topic, 'guide'));
    }
  }

  if (pathname.startsWith('/faq/')) {
    const slug = pathname.replace('/faq/', '').replace(/\/$/, '');
    const topic = GUIDE_TOPIC_MAP.get(slug);
    if (topic) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderGuideTopicPage(topic, 'faq'));
    }
  }

  for (const variant of ['prix', 'documents']) {
    const prefix = `/${variant}-`;
    if (pathname.startsWith(prefix)) {
      const slug = pathname.slice(prefix.length).replace(/\/$/, '');
      const topic = GUIDE_TOPIC_MAP.get(slug);
      if (topic) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderGuideTopicPage(topic, variant));
      }
    }
  }

  if (pathname === '/simulation-salaire') {
    res.writeHead(301, { Location: '/cachet-entreprise' });
    return res.end();
  }

  const infoPageSlug = pathname.replace(/^\/|\/$/g, '');
  if (STATIC_INFO_PAGES[infoPageSlug]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderInfoPage(infoPageSlug, STATIC_INFO_PAGES[infoPageSlug]));
  }

  if (STATIC_TOOL_PAGES[infoPageSlug]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderToolAppPage(infoPageSlug, STATIC_TOOL_PAGES[infoPageSlug]));
  }

  if (pathname === '/recherche-ice-maroc' || pathname === '/annuaire-entreprises-marocaines') {
    const companies = LOCAL_COMPANIES.filter(company => normalizeIce(company.ice)).slice(0, 24);
    const html = renderListingPage({
      slug: pathname.slice(1),
      title: pathname === '/recherche-ice-maroc'
        ? 'Recherche ICE Maroc - Trouver une entreprise par ICE | IceMorocco'
        : 'Annuaire entreprises marocaines - Recherche société Maroc | IceMorocco',
      h1: pathname === '/recherche-ice-maroc' ? 'Recherche ICE Maroc' : 'Annuaire entreprises marocaines',
      lead: 'Consultez les entreprises marocaines par nom, numéro ICE, ville, forme juridique et activité.',
      description: 'Moteur de recherche ICE Maroc et annuaire des entreprises marocaines pour vérifier une société par ICE, nom ou ville.',
      companies,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (pathname === '/top-recherches-ice') {
    const companies = LOCAL_COMPANIES
      .filter(company => normalizeIce(company.ice))
      .sort((a, b) => companyCompleteness(b) - companyCompleteness(a))
      .slice(0, 30);
    const html = renderListingPage({
      slug: 'top-recherches-ice',
      title: 'Top recherches ICE Maroc - Sociétés les plus recherchées | IceMorocco',
      h1: 'Top recherches ICE Maroc',
      lead: 'Une sélection de recherches populaires pour trouver rapidement une société marocaine par ICE ou nom.',
      description: 'Top recherches ICE Maroc : liste de sociétés marocaines indexables avec ICE, ville, activité et forme juridique.',
      companies,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (pathname.startsWith('/entreprise/')) {
    const slug = pathname.replace('/entreprise/', '').replace(/\/$/, '');
    const company = findCompanyBySlug(slug);
    if (company) {
      const html = renderCompanyPage(company, `${SITE_URL}/entreprise/${companySlug(company)}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(302, { Location: `/?q=${encodeURIComponent(slug.replace(/-/g, ' '))}&mode=nom` });
    return res.end();
  }

  if (pathname.startsWith('/ice/')) {
    const ice = normalizeIce(pathname.replace('/ice/', ''));
    const company = findCompanyByIce(ice);
    if (company) {
      const html = renderCompanyPage(company, `${SITE_URL}/ice/${normalizeIce(company.ice)}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(302, { Location: `/?q=${encodeURIComponent(ice)}&mode=ice` });
    return res.end();
  }

  if (pathname.startsWith('/ville/')) {
    const citySlug = pathname.replace('/ville/', '').replace(/\/$/, '');
    const city = SEO_CITIES.find(item => slugify(item) === citySlug) || citySlug.replace(/-/g, ' ');
    const companies = LOCAL_COMPANIES
      .filter(company => slugify(company.ville || '') === slugify(city))
      .slice(0, 30);
    const html = renderListingPage({
      slug: `ville/${citySlug}`,
      title: `Entreprises à ${city} - Recherche ICE Maroc | IceMorocco`,
      h1: `Entreprises à ${city}`,
      lead: `Recherchez les sociétés basées à ${city} par ICE, nom, activité ou forme juridique.`,
      description: `Liste d'entreprises à ${city} avec recherche ICE Maroc, numéro ICE, RC, activité et forme juridique disponibles.`,
      companies: companies.length ? companies : LOCAL_COMPANIES.filter(company => company.ville).slice(0, 12),
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (pathname.startsWith('/categorie/')) {
    const category = pathname.replace('/categorie/', '').replace(/\/$/, '');
    const meta = SEO_CATEGORIES[category] || { label: 'Entreprises marocaines', title: 'Entreprises marocaines' };
    const companies = LOCAL_COMPANIES
      .filter(company => inferCategory(company) === category)
      .slice(0, 30);
    const html = renderListingPage({
      slug: `categorie/${category}`,
      title: `${meta.label} - Recherche ICE Maroc | IceMorocco`,
      h1: meta.title,
      lead: `Trouvez des ${meta.label.toLowerCase()} et consultez les informations disponibles par ICE, nom et ville.`,
      description: `${meta.label} : recherche ICE Maroc, annuaire sociétés, forme juridique, ville et activité des entreprises.`,
      companies: companies.length ? companies : LOCAL_COMPANIES.slice(0, 12),
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── API: Server health check ──
  if (url.pathname === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── API: Search companies on charika.ma ──
  // Handle incoming HTTP requests
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q');
    const mode = url.searchParams.get('mode') || 'nom';
    if (!q || q.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Query too short (min 2 chars)' }));
    }

    try {
      console.log(`🔍 Searching APIs (${mode}): "${q}"`);
      const charikaPromise = searchCharikaAutocomplete(q).catch(() => []);
      const iceMarocResults = await withTimeout(
        searchIcemarocSource(q).catch(() => []),
        FAST_SOURCE_TIMEOUT,
        []
      );
      const charikaResults = await withTimeout(
        charikaPromise,
        iceMarocResults.length ? ENRICH_SOURCE_TIMEOUT : FALLBACK_SOURCE_TIMEOUT,
        []
      );

      let results = dedupeCompanies([...charikaResults, ...iceMarocResults]);

      if (mode !== 'ice' && results.length < 3) {
        const fallbackQueries = searchTokens(q)
          .sort((a, b) => b.length - a.length)
          .filter(token => token.length >= 4 && token !== normalizeCompanyName(q))
          .slice(0, 3);
        for (const token of fallbackQueries) {
          const [tokenCharikaResults, tokenIceMarocResults] = await Promise.all([
            withTimeout(searchCharikaAutocomplete(token).catch(() => []), 1600, []),
            withTimeout(searchIcemarocSource(token).catch(() => []), 1600, []),
          ]);
          const tokenResults = [...tokenCharikaResults, ...tokenIceMarocResults]
            .filter(company => matchesSearchIntent(company, q));
          if (tokenResults.length) {
            results = dedupeCompanies([...results, ...tokenResults]);
          }
        }
      }

      results = await enrichMissingIceFromIcemaroc(results);
      rememberCompanies(results);

      if (mode === 'ice') {
        const ice = normalizeIce(q);
        results = results.filter(company => normalizeIce(company.ice) === ice);
      } else {
        results = await enrichMissingIceFromIcemaroc(results);
        const queryTokens = searchTokens(q);
        const strictNameResults = queryTokens.length > 1
          ? results.filter(company => {
            const name = normalizeCompanyName(company.name);
            return queryTokens.every(token => name.includes(token));
          })
          : [];
        if (strictNameResults.length) {
          results = strictNameResults;
        } else {
          const closeResults = results.filter(company => matchesSearchIntent(company, q));
          if (closeResults.length) results = closeResults;
        }
        results.sort((a, b) => companySearchScore(b, q) - companySearchScore(a, q));
        results = results.filter(company => keepUsefulSearchResult(company, q, results));
      }

      console.log(`   → ${results.length} autocomplete results`);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ query: q, mode, count: results.length, results }));
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: Get company details ──
  if (url.pathname === '/api/company') {
    const slug = url.searchParams.get('slug');
    const directUrl = url.searchParams.get('url');
    if (!slug && directUrl === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing slug or url parameter' }));
    }

    try {
      const companyUrl = directUrl || `https://www.charika.ma/societe-${slug}`;
      console.log(`🏢 Fetching: ${directUrl ? companyUrl : slug}`);
      const html = await fetchUrl(companyUrl);
      if (url.searchParams.get('debug') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const company = parseCompanyDetail(html);
      rememberCompanies([company]);
      console.log(`   → ${company.name} | ${company.tel || 'no phone'} | ${company.email || 'no email'}`);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(company));
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static files ──
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(STATIC_DIR, filePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html' || path.basename(filePath) === 'app.js') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
      headers.Pragma = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
};

const PORTS = process.env.PORT ? [process.env.PORT] : [3000, 8080, 8888, 9000, 5500];

// Only start the server if run directly (local)
if (require.main === module) {
  const server = http.createServer(requestHandler);
  function tryListen(i) {
    if (i >= PORTS.length) { console.error('❌ Could not bind to any port.'); process.exit(1); }
    const port = PORTS[i];
    server.listen(port, '0.0.0.0', () => {
      console.log(`
╔═══════════════════════════════════════════════════════╗
║  IceMorocco — Server Running                          ║
║                                                       ║
║  Local:  http://localhost:${String(port).padEnd(24)}║
║                                                       ║
║  Features:                                            ║
║  • Local DB + Live search (999,000+ via charika.ma)   ║
║  • Company details with phone, email, directors       ║
║                                                       ║
║  Press Ctrl+C to stop                                 ║
╚═══════════════════════════════════════════════════════╝
      `);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EPERM' || err.code === 'EACCES') {
        console.log(`⚠️  Port ${port} unavailable, trying next...`);
        server.removeAllListeners('error');
        tryListen(i + 1);
      } else { throw err; }
    });
  }
  tryListen(0);
}

// Export for Vercel
module.exports = requestHandler;
