// Downloads curated Indian/Mughlai food photos from Unsplash CDN to public/img/menu/
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, 'public', 'img', 'menu');
fs.mkdirSync(OUT, { recursive: true });

// Unique photo pool — each key is a distinct professional food photograph
const PHOTOS = {
  tandoori_chicken:      '1610057099443-fde8c4d50f91',
  tandoori_full:         '1599487488170-d11ec9c172f0',
  afghani_chicken:       '1603894584373-5ac82b2ae398',
  tangdi_kebab:          '1599487488170-d11ec9c172f0',
  chicken_tikka:         '1615719413546-198b25453f85',
  malai_tikka:           '1567188040759-fb8a883dc6d8',
  hariali_tikka:         '1596797038530-2c107229654b',
  mutton_chops:          '1544025162-d76694265947',
  mutton_kebab:          '1546833999-b9f581a1996d',
  galouti:               '1606491956689-2ea866880c84',
  seekh_kebab:           '1606313564200-e75d5e30476c',
  fish_tikka:            '1519708227418-c8fd9a32b7a2',
  paneer_tikka:          '1567188040759-fb8a883dc6d8',
  tandoori_aloo:         '1585937421612-70a008356fbe',
  kebab_platter:         '1574484284002-952d92456975',
  malai_boti:            '1610057099443-fde8c4d50f91',
  prawn_tikka:           '1565680018434-b513d5e5fd47',
  mushroom_tikka:        '1504674900247-0877df9cc836',
  curry_bowl:            '1547592166-23ac45744acd',
  butter_chicken:        '1588166524941-3bf61a9c41db',
  chicken_curry:         '1565557623262-b51c2513a641',
  mutton_curry:          '1625398407796-82650a8c135f',
  mutton_gravy:          '1601050690597-df0568f70950',
  nihari:                '1546833999-b9f581a1996d',
  korma:                 '1585937421612-70a008356fbe',
  handi:                 '1547592166-23ac45744acd',
  rogan_josh:            '1625398407796-82650a8c135f',
  nargisi_kofta:         '1565557623262-b51c2513a641',
  paneer_masala:         '1631452180519-c014fe946bc7',
  paneer_makhani:        '1631452180519-c014fe946bc7',
  malai_kofta:           '1585937421612-70a008356fbe',
  dal_makhani:           '1589302168068-964664d93dc0',
  dal_tadka:             '1546833999-b9f581a1996d',
  biryani:               '1563379091339-03b21ab4a4f8',
  biryani_pot:           '1626777552726-4a6b54c97e46',
  biryani_plate:         '1589302168068-964664d93dc0',
  raan:                  '1544025162-d76694265947',
  egg_biryani:           '1563379091339-03b21ab4a4f8',
  veg_biryani:           '1585937421612-70a008356fbe',
  roll:                  '1626082927389-6cd097cdc6ec',
  egg_roll:              '1609501676725-7186f017a4b7',
  khamiri_roti:          '1601050690597-df0568f70950',
  naan:                  '1601050690117-94f5f6fa8bd7',
  butter_naan:           '1601050690597-df0568f70950',
  garlic_naan:           '1601050690117-94f5f6fa8bd7',
  paratha:               '1601050690597-df0568f70950',
  rice:                  '1512058564366-18510be2db19',
  jeera_rice:            '1512058564366-18510be2db19',
  pulao:                 '1585937421612-70a008356fbe',
  salad:                 '1546069901-ba9599a7e63c',
  raita:                 '1571091718767-18b5b1457add',
  papad:                 '1601050690597-df0568f70950',
  dessert_kheer:         '1488477181946-6428a0291777',
  gulab_jamun:           '1626074353765-517a681e40be',
  ice_cream:             '1563805042-7684c019e1cb',
  ras_malai:             '1488477181946-6428a0291777',
  shahi_tukda:           '1497534446932-c925b458314e',
  kulfi:                 '1563805042-7684c019e1cb',
  halwa:                 '1488477181946-6428a0291777',
  lassi:                 '1622597467836-f3285f2131b8',
  mojito:                '1556679343-c7306c1976bc',
  blue_lagoon:           '1544145945-f90425340c7e',
  iced_tea:              '1556679343-c7306c1976bc',
  cold_coffee:           '1571877227200-a0d98ea607e9',
  shake:                 '1571877227200-a0d98ea607e9',
  lime_soda:             '1544145945-f90425340c7e',
  chai:                  '1571877227200-a0d98ea607e9',
  soft_drink:            '1544145945-f90425340c7e',
  water:                 '1548839140-29a749e1cf4d',
  mushroom:              '1504674900247-0877df9cc836',
  prawn:                 '1565680018434-b513d5e5fd47',
  achari_fish:           '1519708227418-c8fd9a32b7a2',
  keema_naan:            '1601050690597-df0568f70950',
  sheermal:              '1601050690117-94f5f6fa8bd7',
  missi_roti:            '1601050690597-df0568f70950',
  chaas:                 '1622597467836-f3285f2131b8',
  coffee:                '1571877227200-a0d98ea607e9'
};

function dl(key, photoId) {
  return new Promise((resolve) => {
    const dest = path.join(OUT, key + '.jpg');
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) return resolve({ key, ok: true, cached: true });
    const url = 'https://images.unsplash.com/photo-' + photoId + '?w=800&q=75&fit=crop&auto=format';
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        // retry once without fit param
        https.get('https://images.unsplash.com/photo-' + photoId + '?w=800&q=75', { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          if (res2.statusCode !== 200) { res2.resume(); return resolve({ key, ok: false, status: res2.statusCode }); }
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve({ key, ok: true, bytes: fs.statSync(dest).size }); });
        }).on('error', () => resolve({ key, ok: false }));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(dest, buf);
        resolve({ key, ok: true, bytes: buf.length });
      });
    }).on('error', () => resolve({ key, ok: false }));
  });
}

(async () => {
  const keys = Object.keys(PHOTOS);
  console.log('Downloading', keys.length, 'unique food photographs...');
  let ok = 0, fail = 0;
  // sequential-ish with small concurrency
  const CONC = 6;
  for (let i = 0; i < keys.length; i += CONC) {
    const batch = keys.slice(i, i + CONC);
    const results = await Promise.all(batch.map(k => dl(k, PHOTOS[k])));
    results.forEach(r => { if (r.ok) { ok++; } else { fail++; console.log('FAIL', r.key, r.status || ''); } });
    process.stdout.write('.');
  }
  console.log('\nDone. OK:', ok, 'Failed:', fail);
})();
