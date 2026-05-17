const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.charika.ma/',
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
    req.end();
  });
}

function strip(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseCompanyDetail(html) {
  const c = { name:'',type:'',ice:'',if_:'',rc:'',pat:'',cap:'',addr:'',ville:'',act:'',date:'',statut:'Actif',tel:'',fax:'',email:'',website:'',directors:[] };
  const titleM = html.match(/<title[^>]*>Fiche d['']Identit(?:é|&eacute;)\s*Soci(?:é|&eacute;)t(?:é|&eacute;)\s*:\s*([^<]+)/i);
  if (titleM) c.name = strip(titleM[1]).replace(/\s*-\s*CHARIKA$/i, '');
  if (!c.name) { const h1M = html.match(/<h1[^>]*class="[^"]*society-name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i); if (h1M) c.name = strip(h1M[1]); }
  const actM = html.match(/<b>\s*Activit(?:&eacute;|é)\s*:\s*<\/b>\s*<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (actM) c.act = strip(actM[1]);
  const addrM = html.match(/<b[^>]*>\s*Adresse\s*<\/b>\s*<\/span>\s*<span>\s*<label>([\s\S]*?)<\/label>/i);
  if (addrM) c.addr = strip(addrM[1]);
  const typeM = html.match(/Forme juridique\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (typeM) c.type = strip(typeM[1]);
  const capM = html.match(/Capital\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (capM) c.cap = strip(capM[1]);

  const phones = [], faxes = [];
  const phoneRe = /0[5-7]\d{8}/g; let pm;
  while ((pm = phoneRe.exec(html)) !== null) {
    const num = pm[0];
    if (num.startsWith('0522233') || num.startsWith('0522276')) continue;
    const ctx = html.substring(Math.max(0, pm.index - 150), pm.index);
    if (/fax/i.test(ctx)) { if (!faxes.includes(num)) faxes.push(num); }
    else { if (!phones.includes(num)) phones.push(num); }
  }
  c.tel = phones.slice(0, 3).join(' / ');
  c.fax = faxes.slice(0, 2).join(' / ');

  const emails = []; const emailRe = /mailto:([^"'\s]+@[^"'\s]+)/gi; let em;
  while ((em = emailRe.exec(html)) !== null) {
    const e = em[1].toLowerCase();
    if (!e.includes('charika') && !e.includes('inforisk')) { if (!emails.includes(e)) emails.push(e); }
  }
  c.email = emails.slice(0, 2).join(' / ');

  const webRe = /href="(https?:\/\/(?:www\.)?[^"]+)"[^>]*>.*?(?:www\.|https?:\/\/)/gi; let wm;
  while ((wm = webRe.exec(html)) !== null) {
    const s = wm[1];
    if (!['charika','inforisk','facebook','twitter','google','linkedin','youtube','instagram','javascript'].some(x => s.includes(x))) { c.website = s.replace(/^https?:\/\//, ''); break; }
  }

  if (!c.type) { const types = [[/\bSARL\s*AU\b/i,'SARL AU'],[/\bSARL\b/i,'SARL'],[/\bSAS\b/i,'SAS'],[/\bSA\b(?!\s*RL)/i,'SA'],[/\bSNC\b/i,'SNC']]; for (const [re,t] of types) { if (re.test(c.name)) { c.type = t; break; } } }

  const cities = ['Casablanca','Rabat','Marrakech','Fès','Tanger','Agadir','Meknès','Oujda','Kénitra','Tétouan','Salé','Nador','Mohammedia','El Jadida','Béni Mellal','Khouribga','Settat','Berrechid','Safi','Laâyoune','Ouarzazate'];
  if (c.addr.includes(' - ')) c.ville = c.addr.split(' - ').pop().trim();
  for (const city of cities) { if (!c.ville && html.toLowerCase().includes(city.toLowerCase())) { c.ville = city; break; } }

  const iceM = html.match(/(?:ice|ICE)\s*[:=]?\s*(\d{15})/);
  if (iceM) c.ice = iceM[1];
  return c;
}

module.exports = async function handler(req, res) {
  const slug = req.query.slug;
  const directUrl = req.query.url;
  if (!slug && !directUrl) return res.status(400).json({ error: 'Missing slug or url' });

  try {
    const companyUrl = directUrl || `https://www.charika.ma/societe-${slug}`;
    const html = await fetchUrl(companyUrl);
    const company = parseCompanyDetail(html);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(company);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
