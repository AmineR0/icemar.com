#!/usr/bin/env node
/**
 * 🇲🇦 OMPIC / Charika.ma Company Scraper
 * Zero dependencies — pure Node.js (v18+)
 * 
 * Scrapes company data from charika.ma (OMPIC/Inforisk portal)
 * and outputs it in the format used by your ICE Facture app.
 *
 * Usage:
 *   node scraper.js                        → scrape first 5 pages (~50 companies)
 *   node scraper.js --pages 20             → scrape 20 pages (~200 companies)
 *   node scraper.js --search "Maroc Telecom" → search for specific company
 *   node scraper.js --search "banque"      → search by keyword
 *   node scraper.js --company "https://www.charika.ma/societe-ocp-57215" → scrape one company
 *   node scraper.js --merge                → merge scraped data into data.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────
const CONFIG = {
  baseUrl: 'https://www.charika.ma',
  delayMs: 1200,
  maxPages: 5,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  outputFile: path.join(__dirname, 'scraped_data.js'),
  outputJson: path.join(__dirname, 'scraped_data.json'),
  dataFile: path.join(__dirname, 'data.js'),
};

// ─── Helpers ──────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const strip = html => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
  .replace(/\s+/g, ' ').trim();

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': CONFIG.userAgent,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : CONFIG.baseUrl + res.headers.location;
        return fetch(loc).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Parse listing page ───────────────────────────────────────
function parseList(html) {
  const companies = [];
  const re = /\/societe-([a-z0-9-]+)-(\d+)/g;
  const seen = new Set();
  let m;
  
  // Find all company links in listing area
  const listStart = html.indexOf('résultat(s) trouvé(s)');
  const listEnd = html.lastIndexOf('résultat(s) trouvé(s)') > listStart 
    ? html.lastIndexOf('résultat(s) trouvé(s)') : html.length;
  const listHtml = listStart > -1 ? html.substring(listStart, listEnd) : html;
  
  while ((m = re.exec(listHtml)) !== null) {
    const slug = m[1];
    const id = m[2];
    const url = `${CONFIG.baseUrl}/societe-${slug}-${id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    
    // Skip well-known sidebar companies (they appear on every page)
    if (['ocp-57215','societe-afriquia-marocaine','total-energies-marketing','vivo-energy-maroc-2833'].some(s => slug.includes(s))) continue;
    
    // Extract name from nearby text  
    const linkPos = html.indexOf(`/societe-${slug}-${id}`);
    const before = html.substring(Math.max(0, linkPos - 300), linkPos);
    const nameMatch = before.match(/<h[2-5][^>]*>(?:<a[^>]*>)?\s*\[?([^\]<]+)/i) || 
                      before.match(/##### \[([^\]]+)\]/);
    
    // Extract activity
    const after = html.substring(linkPos, linkPos + 500);
    const actMatch = after.match(/Secteur d'activit[ée]\s*:\s*([^<\n]+)/i);
    
    // Check dissolution status
    const isDissolved = after.substring(0, 200).toLowerCase().includes('dissolution');
    
    companies.push({
      slug, id: parseInt(id),
      url,
      name: nameMatch ? strip(nameMatch[1]) : slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      act: actMatch ? strip(actMatch[1]) : '',
      statut: isDissolved ? 'Dissous' : 'Actif',
    });
  }
  
  return companies;
}

// ─── Parse company detail page ────────────────────────────────
function parseCompany(html, basic) {
  const c = {
    name: basic.name, type: '', ice: '', if_: '', rc: '', pat: '',
    cap: '', addr: '', ville: '', act: basic.act || '', date: '',
    statut: basic.statut || 'Actif', tel: '', fax: '', email: '', website: '',
  };
  
  // Name from title
  const titleM = html.match(/<title[^>]*>Fiche d'Identité Société\s*:\s*([^<-]+)/i);
  if (titleM) c.name = strip(titleM[1]).trim();
  
  // OG description often has abbreviation
  const ogM = html.match(/og:description[^>]*content="[^"]*-\s*([A-Z][A-Z0-9 ]+)"/i);
  
  // Phones
  const phones = [], faxes = [];
  const phoneRe = /0[5-7]\d{8}/g;
  let pm;
  while ((pm = phoneRe.exec(html)) !== null) {
    const num = pm[0];
    const ctx = html.substring(Math.max(0, pm.index - 150), pm.index);
    if (/fax/i.test(ctx)) { if (!faxes.includes(num)) faxes.push(num); }
    else { if (!phones.includes(num)) phones.push(num); }
  }
  c.tel = phones.filter(p => !p.startsWith('0522233')).slice(0, 3).join(' / '); // skip charika's own phone
  c.fax = faxes.slice(0, 2).join(' / ');
  
  // Email
  const emails = [];
  const emailRe = /mailto:([^"'\s]+@[^"'\s]+)/gi;
  let em;
  while ((em = emailRe.exec(html)) !== null) {
    const e = em[1].toLowerCase();
    if (!e.includes('charika') && !e.includes('contact@charika') && !e.includes('inforisk')) {
      if (!emails.includes(e)) emails.push(e);
    }
  }
  c.email = emails.slice(0, 2).join(' / ');
  
  // Website
  const webRe = /href="(https?:\/\/(?:www\.)?[^"]+)"[^>]*>\s*(?:www\.|https?:\/\/)/gi;
  let wm;
  while ((wm = webRe.exec(html)) !== null) {
    const s = wm[1];
    if (!['charika','inforisk','facebook','twitter','google','linkedin','youtube','instagram']
        .some(x => s.includes(x))) {
      c.website = s.replace(/^https?:\/\//, '');
      break;
    }
  }
  
  // Directors
  const dirRe = /(?:M\.|Mme|Mlle)\s+([^:]+?)\s*:\s*([^<\n]+)/gi;
  const dirs = [];
  let dm;
  while ((dm = dirRe.exec(html)) !== null) {
    const name = strip(dm[1]), role = strip(dm[2]);
    if (name.length > 2 && name.length < 60) dirs.push(`${name} (${role})`);
  }
  
  // Legal type from name
  const types = [
    [/\bSARL\s*AU\b/i, 'SARL AU'], [/\bSARL\b/i, 'SARL'], [/\bSAS\b/, 'SAS'],
    [/\bSA\b(?!\s*RL)/, 'SA'], [/\bSNC\b/, 'SNC'], [/\bSCS\b/, 'SCS'],
  ];
  for (const [re, t] of types) { if (re.test(c.name)) { c.type = t; break; } }
  
  // City
  const cities = ['Casablanca','Rabat','Marrakech','Fès','Tanger','Agadir','Meknès','Oujda',
    'Kénitra','Tétouan','Salé','Nador','Mohammedia','El Jadida','Béni Mellal','Khouribga',
    'Settat','Berrechid','Safi','Laâyoune','Ouarzazate','Errachidia','Taza','Khémisset',
    'Guelmim','Dakhla','Essaouira','Larache','Al Hoceima','Tiznit','Taroudant'];
  for (const city of cities) {
    if (html.toLowerCase().includes(city.toLowerCase())) { c.ville = city; break; }
  }
  
  // ICE (sometimes visible in comments or hidden elements)
  const iceM = html.match(/(?:ice|ICE)\s*[:=]?\s*(\d{15})/);
  if (iceM) c.ice = iceM[1];
  
  return c;
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let maxPages = CONFIG.maxPages, searchQuery = '', singleUrl = '', doMerge = false;
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pages': maxPages = parseInt(args[++i]) || 5; break;
      case '--search': searchQuery = args[++i]; break;
      case '--company': singleUrl = args[++i]; break;
      case '--merge': doMerge = true; break;
      case '--help':
        log(`
🇲🇦 OMPIC / Charika.ma Scraper

Usage:
  node scraper.js                            Scrape directory (default: 5 pages)
  node scraper.js --pages 20                 Scrape 20 pages (~200 companies)
  node scraper.js --search "banque"          Search for companies
  node scraper.js --company <charika_url>    Scrape one company
  node scraper.js --merge                    Merge scraped_data.js into data.js
        `);
        return;
    }
  }

  if (doMerge) return mergeData();
  
  log('\n╔═══════════════════════════════════════════════════╗');
  log('║  🇲🇦 OMPIC / Charika.ma Company Scraper           ║');
  log('╚═══════════════════════════════════════════════════╝\n');

  let companyLinks = [];
  
  if (singleUrl) {
    // Single company mode
    log(`🔍 Scraping: ${singleUrl}\n`);
    try {
      const html = await fetch(singleUrl);
      const company = parseCompany(html, { name: '', act: '', statut: 'Actif' });
      company.sourceUrl = singleUrl;
      log(`✅ ${company.name}`);
      log(`   Tel: ${company.tel || '-'} | Email: ${company.email || '-'}`);
      log(`   City: ${company.ville || '-'} | Website: ${company.website || '-'}`);
      fs.writeFileSync(CONFIG.outputJson, JSON.stringify([company], null, 2));
      log(`\n💾 Saved → ${CONFIG.outputJson}`);
    } catch (e) { log(`❌ ${e.message}`); }
    return;
  }
  
  // Get company URLs from directory/search
  if (searchQuery) {
    const url = `${CONFIG.baseUrl}/recherche?q=${encodeURIComponent(searchQuery)}`;
    log(`🔍 Searching: "${searchQuery}"...\n`);
    try {
      const html = await fetch(url);
      companyLinks = parseList(html);
      log(`   Found ${companyLinks.length} companies\n`);
    } catch (e) { log(`❌ Search failed: ${e.message}`); return; }
  } else {
    log(`📄 Scraping ${maxPages} directory pages...\n`);
    for (let p = 1; p <= maxPages; p++) {
      const url = p === 1 ? `${CONFIG.baseUrl}/annuaire` : `${CONFIG.baseUrl}/societes-${p}`;
      process.stdout.write(`  Page ${p}/${maxPages}... `);
      try {
        const html = await fetch(url);
        const found = parseList(html);
        companyLinks.push(...found);
        log(`✅ ${found.length} companies`);
      } catch (e) { log(`❌ ${e.message}`); }
      if (p < maxPages) await delay(CONFIG.delayMs);
    }
  }
  
  // Deduplicate
  const seen = new Set();
  companyLinks = companyLinks.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
  
  log(`\n📊 ${companyLinks.length} unique companies to scrape\n`);
  log('─'.repeat(55));
  
  // Scrape detail pages
  const results = [];
  for (let i = 0; i < companyLinks.length; i++) {
    const link = companyLinks[i];
    const tag = `[${i+1}/${companyLinks.length}]`;
    process.stdout.write(`  ${tag} ${link.name.substring(0, 35).padEnd(37)}... `);
    try {
      const html = await fetch(link.url);
      const co = parseCompany(html, link);
      co.id = 100 + i + 1;
      co.sourceUrl = link.url;
      results.push(co);
      log(`✅ ${[co.tel?'📞':'',co.email?'📧':'',co.website?'🌐':''].filter(Boolean).join(' ') || 'basic'}`);
    } catch (e) { log(`❌ ${e.message}`); }
    if (i < companyLinks.length - 1) await delay(CONFIG.delayMs);
  }
  
  if (!results.length) { log('\n⚠️ No data collected.'); return; }
  
  // Save
  const jsLines = results.map((c, i) => {
    c.id = i + 101;
    return '  ' + JSON.stringify(c);
  });
  const jsOut = `/**\n * Scraped from charika.ma on ${new Date().toISOString().split('T')[0]}\n */\nconst SCRAPED_DB = [\n${jsLines.join(',\n')}\n];\n`;
  
  fs.writeFileSync(CONFIG.outputFile, jsOut, 'utf8');
  fs.writeFileSync(CONFIG.outputJson, JSON.stringify(results, null, 2), 'utf8');
  
  // Summary
  log('\n' + '═'.repeat(55));
  log('📊 RESULTS');
  log('═'.repeat(55));
  log(`  Companies: ${results.length}`);
  log(`  With phone:   ${results.filter(c=>c.tel).length}`);
  log(`  With email:   ${results.filter(c=>c.email).length}`);
  log(`  With website: ${results.filter(c=>c.website).length}`);
  
  const byCity = {};
  results.forEach(c => { const k = c.ville || '?'; byCity[k] = (byCity[k]||0) + 1; });
  log('\n  📍 By city:');
  Object.entries(byCity).sort((a,b) => b[1]-a[1]).slice(0,8)
    .forEach(([c,n]) => log(`     ${c.padEnd(18)} ${n}`));
  
  log('═'.repeat(55));
  log(`\n💾 Saved:`);
  log(`   ${CONFIG.outputFile}`);
  log(`   ${CONFIG.outputJson}`);
  log(`\n💡 Run: node scraper.js --merge  to add to your data.js\n`);
}

// ─── Merge scraped data into data.js ──────────────────────────
function mergeData() {
  log('\n🔄 Merging scraped data into data.js...\n');
  
  if (!fs.existsSync(CONFIG.outputFile)) {
    log('❌ No scraped_data.js found. Run the scraper first.');
    return;
  }
  
  // Read existing data.js
  const existingContent = fs.readFileSync(CONFIG.dataFile, 'utf8');
  const existingMatch = existingContent.match(/const\s+DB\s*=\s*\[([\s\S]*?)\];/);
  if (!existingMatch) { log('❌ Could not parse data.js'); return; }
  
  // Read scraped data
  const scrapedContent = fs.readFileSync(CONFIG.outputFile, 'utf8');
  const scrapedMatch = scrapedContent.match(/const\s+SCRAPED_DB\s*=\s*\[([\s\S]*?)\];/);
  if (!scrapedMatch) { log('❌ Could not parse scraped_data.js'); return; }
  
  // Count existing entries
  const existingCount = (existingMatch[1].match(/\{/g) || []).length;
  
  // Append scraped entries (with new IDs starting from existing count + 1)
  const newEntries = scrapedMatch[1].trim();
  if (!newEntries) { log('⚠️ No scraped entries to merge.'); return; }
  
  // Re-index scraped entries
  let idx = existingCount;
  const reindexed = newEntries.replace(/"id":\d+/g, () => `"id":${++idx}`);
  
  const merged = existingContent.replace(
    /const\s+DB\s*=\s*\[([\s\S]*?)\];/,
    `const DB=[\n${existingMatch[1].trim()},\n${reindexed}\n];`
  );
  
  // Backup
  const backup = CONFIG.dataFile + '.bak';
  fs.copyFileSync(CONFIG.dataFile, backup);
  log(`  📋 Backup → ${backup}`);
  
  fs.writeFileSync(CONFIG.dataFile, merged, 'utf8');
  log(`  ✅ Merged ${idx - existingCount} companies into data.js`);
  log(`  📊 Total: ${idx} companies\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
