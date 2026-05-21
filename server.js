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
    .replace(/\b(ste|societe|sarl|sa|au|snc|maroc|ma)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function searchTokens(value = '') {
  return normalizeCompanyName(value)
    .split(/\s+/)
    .filter(token => token.length > 1 && !['ste', 'societe', 'sarl', 'sa', 'au', 'snc', 'maroc', 'ma'].includes(token));
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

function keepUsefulSearchResult(company = {}, query = '', allResults = []) {
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
  merged.date = formatCompanyDate(merged.date);
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

function renderSeoLayout({ title, description, canonical, h1, lead, body = '', schema = [] }) {
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
  <nav class="seo-breadcrumb"><a href="/">Recherche ICE Maroc</a> / ${escapeHtml(h1)}</nav>
  <header class="seo-static-head">
    <a class="seo-logo-link" href="/"><img src="/logo.png" alt="IceMorocco" width="254" height="47"/></a>
    <h1>${escapeHtml(h1)}</h1>
    <p>${escapeHtml(lead)}</p>
    <form action="/" method="get" class="seo-search-form">
      <input name="q" placeholder="Nom société ou numéro ICE" aria-label="Recherche ICE Maroc"/>
      <input type="hidden" name="mode" value="nom"/>
      <button type="submit">Rechercher</button>
    </form>
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
    description: 'À propos d’IceMorocco, plateforme marocaine de recherche ICE, annuaire entreprises et outils professionnels pour facture, salaire et chiffres en lettres.',
    body: `
      <h2>Notre mission</h2>
      <p>IceMorocco rassemble un moteur de recherche ICE Maroc et des outils pratiques pour les entrepreneurs, freelances, comptables et petites entreprises. Le service vise à rendre la vérification d’une société plus simple avant un devis, une facture, un partenariat ou une démarche administrative.</p>
      <h2>Ce que le site propose</h2>
      <p>La plateforme permet de rechercher une entreprise par nom ou numéro ICE, consulter les informations disponibles, vérifier le format d’un ICE, générer une facture conforme, convertir des montants en lettres et utiliser des calculateurs utiles pour la gestion quotidienne.</p>
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
    cta: 'Ouvrir le vérificateur ICE',
    body: `
      <h2>Contrôler un numéro ICE marocain</h2>
      <p>Le vérificateur ICE aide à vérifier le format d’un numéro ICE avant une facture, un devis ou une recherche administrative. Un ICE marocain contient généralement 15 chiffres.</p>
      <h2>Recherche associée</h2>
      <p>Après le contrôle du format, vous pouvez lancer une recherche dans IceMorocco afin de consulter les informations disponibles sur la société : raison sociale, ville, RC, forme juridique, activité et date de création lorsque ces données existent.</p>
    `,
  },
  'simulation-salaire': {
    title: 'Simulation Salaire Maroc - Calcul net estimatif | IceMorocco',
    h1: 'Simulation Salaire Maroc',
    lead: 'Estimez rapidement un salaire net à partir du brut avec des paramètres sociaux et fiscaux indicatifs.',
    description: 'Simulation salaire Maroc pour estimer le net, les retenues et le coût employeur à partir du salaire brut mensuel.',
    appHash: 'salary',
    cta: 'Ouvrir la simulation salaire',
    body: `
      <h2>Estimer un salaire net au Maroc</h2>
      <p>La simulation salaire permet d’obtenir une estimation rapide du net mensuel, des retenues et du coût employeur. Elle sert d’aide pratique pour comparer un brut, préparer une offre ou faire une première lecture RH.</p>
      <h2>Calcul indicatif</h2>
      <p>Les résultats restent indicatifs et doivent être validés par un comptable, un service RH ou un professionnel qualifié, surtout lorsque les règles fiscales ou sociales évoluent.</p>
    `,
  },
  'generateur-facture': {
    title: 'Générateur Facture Maroc - Facture conforme simple | IceMorocco',
    h1: 'Générateur Facture Maroc',
    lead: 'Créez une facture claire et professionnelle pour vos clients avec les informations essentielles de l’entreprise.',
    description: 'Générateur facture Maroc gratuit pour créer une facture professionnelle avec client, articles, TVA, total et montant en lettres.',
    appHash: 'invoice',
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
    cta: 'Ouvrir les outils société',
    body: `
      <h2>Outils pratiques pour entreprise</h2>
      <p>IceMorocco rassemble des outils simples pour gagner du temps : calcul TVA Maroc, calcul marge commerciale, date d’échéance, cachet entreprise, check-list création société, recherche ICE Maroc, génération de facture et conversion des montants en lettres.</p>
      <h2>Un espace centralisé</h2>
      <p>L’objectif est d’offrir une plateforme claire pour les professionnels qui veulent vérifier une société, préparer un document commercial ou effectuer un calcul rapide.</p>
    `,
  },
};

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
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*"\/>/, `<link rel="canonical" href="${escapeHtml(canonical)}"/>`)
    .replace(/<body class="[^"]*">/, `<body class="is-${escapeHtml(page.appHash)}-page">`);
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
  const urls = [
    sitemapEntry(`${SITE_URL}/`, '1.0'),
    sitemapEntry(`${SITE_URL}/recherche-ice-maroc`, '0.95'),
    sitemapEntry(`${SITE_URL}/annuaire-entreprises-marocaines`, '0.9'),
    sitemapEntry(`${SITE_URL}/top-recherches-ice`, '0.85'),
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
      date: formatCompanyDate(company.dateCreation || company.anneeCreation || ''),
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
          const tokenResults = [...tokenCharikaResults, ...tokenIceMarocResults];
          if (tokenResults.length) {
            results = dedupeCompanies([...results, ...tokenResults]);
          }
        }
      }

      results = await enrichMissingIceFromIcemaroc(results);
      rememberCompanies(results);

      if (mode === 'ice') {
        const ice = normalizeIce(q);
        const exactLiveResults = results.filter(company => normalizeIce(company.ice) === ice);
        const cachedResults = searchDiscoveredByIce(q);
        const seen = new Set();
        results = dedupeCompanies([...exactLiveResults, ...cachedResults]).filter(company => {
          const key = companyCacheKey(company);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } else {
        results = dedupeCompanies([...results, ...searchDiscoveredByName(q)]);
        results = await enrichMissingIceFromIcemaroc(results);
        const closeResults = results.filter(company => isCloseCompanyMatch(company, q));
        if (closeResults.length) results = closeResults;
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
