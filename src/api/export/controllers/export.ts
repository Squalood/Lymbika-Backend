// ── CSV helpers ──────────────────────────────────────────────────────────────

const CSV_FIELDS = [
  'documentId', 'productName', 'sku', 'barCode',
  'price', 'priceMember', 'stock',
  'active', 'isFeatured', 'conReceta',
  'tipo', 'sal', 'category', 'status',
];

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(products: any[]): string {
  const header = CSV_FIELDS.join(',');
  const rows = products.map((p) =>
    CSV_FIELDS.map((field) => {
      if (field === 'category') return escapeCsv(p.category?.categoryName ?? '');
      if (field === 'status') return escapeCsv(p.publishedAt ? 'published' : 'draft');
      return escapeCsv(p[field]);
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    return headers.reduce(
      (obj, header, i) => ({ ...obj, [header]: values[i] ?? '' }),
      {} as Record<string, string>
    );
  });
}

// Enum values exactos del schema (incluyendo espacios originales)
const TIPO_ENUM = [
  'Pildora', 'Antigripal', 'Dolor y Fiebre', 'Gripe y Tos',
  'Alergias y Respiratorios', 'Salud Digestiva', 'Vitaminas y Suplementos',
  'Salud de la Piel', 'Cuidado Femenino', 'Salud Sexual y Reproductiva',
  ' Salud Mental y Sueño', ' Diabetes y Control de Glucosa',
  ' Hipertensión y Salud del Corazón', ' Enfermedades Crónicas',
  ' Medicamentos Especializados', ' Antibióticos y Antivirales',
  ' Cuidado Infantil y Pediátrico',
];

// Busca el valor exacto del enum aunque el CSV venga sin espacios al inicio
function normalizeTipo(val: string): string | null {
  if (!val) return null;
  const match = TIPO_ENUM.find((e) => e.trim() === val.trim());
  return match ?? null;
}

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // GET /api/export/products
  async exportProducts(ctx: any) {
    const products = await strapi.documents('api::product.product').findMany({
      populate: { category: true },
      status: 'draft', // returns both draft and published in Strapi 5
    });

    const csv = toCSV(products);

    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', 'attachment; filename="productos.csv"');
    ctx.body = csv;
  },

  // POST /api/export/products/import
  // Acepta multipart/form-data con campo "file" (archivo .csv)
  // O JSON con campo "csv" (string con el contenido del CSV)
  async importProducts(ctx: any) {
    let csvContent: string = '';

    const file = ctx.request.files?.file;
    if (file) {
      // Archivo subido via multipart/form-data
      const fs = require('fs');
      csvContent = fs.readFileSync(file.filepath ?? file.path, 'utf-8');
    } else {
      // JSON body con campo "csv"
      const { csv } = ctx.request.body as { csv?: string };
      if (!csv || typeof csv !== 'string') {
        return ctx.badRequest('Envía un archivo CSV en el campo "file" o un JSON con el campo "csv"');
      }
      csvContent = csv;
    }

    const rows = parseCSV(csvContent);

    if (rows.length === 0) {
      return ctx.badRequest('El CSV está vacío o no tiene filas válidas');
    }

    const results = { created: 0, updated: 0, errors: [] as string[] };

    for (const row of rows) {
      try {
        // Buscar category por nombre si se proporcionó
        let categoryConnect: any = undefined;
        if (row.category) {
          const found = await strapi.documents('api::category.category').findFirst({
            filters: { categoryName: { $eq: row.category } } as any,
          });
          if (found) {
            categoryConnect = { connect: [{ documentId: found.documentId }] };
          }
        }

        const data: any = {
          ...(row.productName && { productName: row.productName }),
          ...(row.sku !== undefined && { sku: row.sku || null }),
          ...(row.barCode !== undefined && { barCode: row.barCode || null }),
          ...(row.price !== '' && { price: parseFloat(row.price) || null }),
          ...(row.priceMember !== '' && { priceMember: parseFloat(row.priceMember) || null }),
          ...(row.stock !== '' && { stock: parseInt(row.stock) || 0 }),
          ...(row.active !== '' && { active: row.active === 'true' }),
          ...(row.isFeatured !== '' && { isFeatured: row.isFeatured === 'true' }),
          ...(row.conReceta !== '' && { conReceta: row.conReceta === 'true' }),
          ...(row.tipo !== '' && { tipo: normalizeTipo(row.tipo) }),
          ...(row.sal !== undefined && { sal: row.sal || null }),
          ...categoryConnect,
        };

        const status = row.status === 'published' ? 'published' : 'draft';

        if (row.documentId) {
          // Actualizar existente
          await strapi.documents('api::product.product').update({
            documentId: row.documentId,
            data,
            status,
          });
          results.updated++;
        } else {
          // Crear nuevo
          await strapi.documents('api::product.product').create({ data, status });
          results.created++;
        }
      } catch (err: any) {
        results.errors.push(`Fila "${row.productName || row.documentId}": ${err.message}`);
      }
    }

    ctx.body = {
      message: `Importación completada`,
      created: results.created,
      updated: results.updated,
      errors: results.errors,
    };
  },
};
