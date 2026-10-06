import crypto from "node:crypto";

/**
 * Número, token y enlace de un caso. Los usa el intake del paciente y también
 * el lifecycle `beforeCreate`, para que un caso creado a mano desde el panel
 * (p. ej. un paciente que llegó solo por WhatsApp) nazca igual de completo.
 */

/** Token secreto de "Mi caso": 24 bytes en base64url = 32 caracteres. */
export function generarToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Link de "Mi caso" para que coordinación se lo reenvíe al paciente desde el
 * panel. CLIENT_URL es la URL pública del frontend (la misma que usa Stripe).
 */
export function enlacePaciente(token: string) {
  return `${(process.env.CLIENT_URL ?? "").replace(/\/$/, "")}/case/${token}`;
}

/** LYM-<año>-<consecutivo de 6 dígitos>, reiniciando cada año. */
export async function siguienteNumeroDeCaso(strapi) {
  const anio = new Date().getFullYear();
  const prefijo = `LYM-${anio}-`;
  const ultimo = await strapi.db.query("api::case.case").findOne({
    where: { caseNumber: { $startsWith: prefijo } },
    orderBy: { caseNumber: "desc" },
    select: ["caseNumber"],
  });
  const consecutivo = ultimo
    ? Number(String(ultimo.caseNumber).slice(prefijo.length)) + 1
    : 1;
  return `${prefijo}${String(consecutivo).padStart(6, "0")}`;
}
