const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.charika.ma/',
        'Origin': 'https://www.charika.ma',
        ...(options.headers || {}),
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location : `https://www.charika.ma${res.headers.location}`;
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

function decodeHtml(s = '') {
  return s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ').trim();
}

function normalizeIce(v = '') { return String(v).replace(/\D/g, ''); }

function formatCapital(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return `${amount.toLocaleString('fr-FR')} DHS`;
}

function buildCharikaUrl(company = {}) {
  if (company.url) return company.url;
  if (company.enseigne && company.idBil) return `https://www.charika.ma/societe-${company.enseigne}-${company.idBil}`;
  if (company.slug) return `https://www.charika.ma/societe-${company.slug}`;
  return '';
}

module.exports = async function handler(req, res) {
  const q = req.query.q;
  const mode = req.query.mode || 'nom';
  if (!q || q.length < 2) return res.status(400).json({ error: 'Query too short' });

  try {
    const url = `https://www.charika.ma/societe-loadlistsociete?denomination=${encodeURIComponent(q)}`;
    const text = await fetchUrl(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.charika.ma/accueil',
      },
    });

    let payload;
    try { payload = JSON.parse(text); } catch { return res.status(500).json({ error: 'Invalid response' }); }

    const list = Array.isArray(payload.listSociete) ? payload.listSociete : [];
    let results = list.map(c => ({
      name: decodeHtml(c.denomination || ''),
      slug: c.enseigne && c.idBil ? `${c.enseigne}-${c.idBil}` : '',
      url: buildCharikaUrl(c),
      type: decodeHtml(c.formeJuridique || ''),
      ice: c.ice || '',
      rc: c.rc ? `${c.rc}${c.nomTribunal ? ` (${decodeHtml(c.nomTribunal)})` : ''}` : '',
      addr: decodeHtml(c.adresse || ''),
      ville: decodeHtml(c.ville || c.province || ''),
      act: decodeHtml(c.activite || c.objetSocial || ''),
      cap: formatCapital(c.capital),
      tel: [c.tel1, c.tel2, c.tel3, c.tel4].filter(Boolean).join(' / '),
      fax: [c.fax1, c.fax2].filter(Boolean).join(' / '),
      email: [c.email1, c.email2].filter(Boolean).join(' / '),
      website: decodeHtml(c.siteWeb || '').replace(/^https?:\/\//, ''),
      statut: c.entStatut === 'RAD' ? 'Dissous' : 'Actif',
    })).filter(c => c.name);

    if (mode === 'ice') {
      const ice = normalizeIce(q);
      results = results.filter(c => normalizeIce(c.ice) === ice);
    } else {
      const low = q.toLowerCase();
      results.sort((a, b) => {
        const as = Number(a.name.toLowerCase().startsWith(low)) * 3;
        const bs = Number(b.name.toLowerCase().startsWith(low)) * 3;
        return bs - as;
      });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ query: q, mode, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
