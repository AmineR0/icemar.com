#!/usr/bin/env node
/**
 * IceMar — Local Server with Live Company Search Proxy
 * Serves your app + proxies search requests to charika.ma
 * 
 * Usage: node server.js
 * Then open: http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');

const PORT = 3000;
const STATIC_DIR = __dirname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const discoveredCompanies = new Map();

// ─── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
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
    const activity =
      decodeHtml(company.activite || company.objetSocial || '')
        .replace(/\s*-\s*(Autres|Commerce|Conseil|Entretien).*/i, match => match.startsWith(' - ') ? '' : match);

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
      date: company.dateCreation || company.anneeCreation || '',
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

  // ── API: Server health check ──
  if (url.pathname === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── API: Search companies on charika.ma ──
// --- IceMaroc Search ---
async function searchIcemaroc(query) {
  try {
    const url = `https://www.icemaroc.com/api/search.php?query=${encodeURIComponent(query)}`;
    const text = await fetchUrl(url, { headers: { 'Referer': 'https://www.icemaroc.com/' } });
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    
    return data.map(item => ({
      name: decodeHtml(item.raison_sociale || ''),
      type: decodeHtml(item.forme || ''),
      ice: item.ice || '',
      rc: item.num_rc ? `${item.num_rc} (${decodeHtml(item.ville_rc || '')})` : '',
      date: item.dateCreation || '',
      cap: formatCapital(item.capital),
      act: decodeHtml(item.activite || ''),
      statut: (item.statut || '').toUpperCase() === 'EN ACTIVITE' ? 'Actif' : 'Dissous',
      ville: decodeHtml(item.ville_rc || ''),
      url: '',
      slug: ''
    }));
  } catch (err) {
    console.error('IceMaroc error:', err);
    return [];
  }
}

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
      const [charikaResults, iceMarocResults] = await Promise.all([
        searchCharikaAutocomplete(q).catch(() => []),
        searchIcemaroc(q).catch(() => [])
      ]);

      let results = [];
      const seen = new Set();
      const normalize = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

      [...charikaResults, ...iceMarocResults].forEach(c => {
        if (!c.name) return;
        // Use name + ville as the key to avoid merging different branches/companies with the same name
        const key = normalize(c.name) + '-' + normalize(c.ville || '');
        
        if (!seen.has(key)) {
          seen.add(key);
          results.push(c);
        } else {
          // Merge rich data (like ICE) from IceMaroc into Charika result
          const existing = results.find(r => (normalize(r.name) + '-' + normalize(r.ville || '')) === key);
          if (existing) {
            existing.ice = existing.ice || c.ice || '';
            existing.rc = existing.rc || c.rc || '';
            existing.date = existing.date || c.date || '';
            existing.cap = existing.cap || c.cap || '';
          }
        }
      });

      // Also append any leftover charika/icemaroc results that might have slightly different names but share the same ICE
      // Actually, name+ville is enough to show all distinct branches!

      rememberCompanies(results);

      if (mode === 'ice') {
        const ice = normalizeIce(q);
        const exactLiveResults = results.filter(company => normalizeIce(company.ice) === ice);
        const cachedResults = searchDiscoveredByIce(q);
        const seen = new Set();
        results = [...exactLiveResults, ...cachedResults].filter(company => {
          const key = companyCacheKey(company);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } else {
        const lowered = q.toLowerCase();
        results.sort((a, b) => {
          const aScore = Number(a.name.toLowerCase().startsWith(lowered)) * 3 + Number((a.act || '').toLowerCase().includes(lowered));
          const bScore = Number(b.name.toLowerCase().startsWith(lowered)) * 3 + Number((b.act || '').toLowerCase().includes(lowered));
          return bScore - aScore;
        });
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
║  IceMar — Server Running                              ║
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
