#!/usr/bin/env node
/**
 * Genera expresiones de búsqueda para el Media Explorer de Cloudinary a partir de
 * scripts/orphans.json, y las valida contra la Search API antes de dártelas.
 *
 * Se trocean por presupuesto de caracteres porque la barra de búsqueda no traga
 * una expresión con 194 public_id.
 *
 * SOLO LECTURA. Corré antes: node scripts/find-orphans.js
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const BUDGET = 1600; // caracteres por consulta
const OUT = path.join(__dirname, 'orphan-queries.txt');
const orphans = require('./orphans.json');

const isSample = (p) => /^samples\//.test(p) || /^(sample|main-sample|cld-sample)(-\d+)?$/.test(p);
const isVariant = (p) => /^(large_|medium_|small_|thumbnail_)/.test(p);

const groups = { samples: [], variantes: [], subidas: [] };
for (const a of orphans) {
  const bucket = isSample(a.public_id) ? 'samples' : isVariant(a.public_id) ? 'variantes' : 'subidas';
  groups[bucket].push(a.public_id);
}

/** public_id:("a" OR "b" ...) troceado para que entre en la barra de búsqueda. */
function buildQueries(ids) {
  const queries = [];
  let chunk = [];
  let length = 0;

  for (const id of ids) {
    const cost = id.length + 6;
    if (chunk.length && length + cost > BUDGET) {
      queries.push(`public_id:(${chunk.map((i) => `"${i}"`).join(' OR ')})`);
      chunk = [];
      length = 0;
    }
    chunk.push(id);
    length += cost;
  }
  if (chunk.length) queries.push(`public_id:(${chunk.map((i) => `"${i}"`).join(' OR ')})`);
  return queries;
}

(async () => {
  const lines = [];
  let allOk = true;

  for (const [name, ids] of Object.entries(groups)) {
    if (!ids.length) continue;
    const queries = buildQueries(ids);
    console.log(`\n=== ${name}: ${ids.length} assets en ${queries.length} consulta(s) ===`);
    lines.push(`### ${name.toUpperCase()} — ${ids.length} assets`, '');

    for (let i = 0; i < queries.length; i++) {
      const expr = queries[i];
      let found;
      try {
        found = (await cloudinary.search.expression(expr).max_results(1).execute()).total_count;
      } catch (err) {
        found = 'ERROR: ' + err.message;
      }
      const expected = (expr.match(/ OR /g) || []).length + 1;
      const ok = found === expected;
      if (!ok) allOk = false;
      console.log(`  consulta ${i + 1}: espera ${expected}, devuelve ${found}  ${ok ? 'OK' : '<-- REVISAR'}`);
      lines.push(`# consulta ${i + 1}/${queries.length} — devuelve ${found} assets`, expr, '');
    }
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf-8');
  console.log(`\n${allOk ? 'Todas las consultas validadas.' : 'ALGUNA CONSULTA NO CUADRA, revisala.'}`);
  console.log(`Guardadas en ${OUT}`);
})().catch((err) => { console.error(err); process.exit(1); });
