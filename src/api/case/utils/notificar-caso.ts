/**
 * Aviso por correo a coordinación cuando un paciente envía un caso.
 *
 * Se activa con SMTP_HOST (ver config/plugins.ts) y CASE_NOTIFY_EMAILS
 * (destinatarios separados por coma). Sin ellas no envía nada.
 *
 * Lleva lo mínimo a propósito: número, nombre, procedimiento y si es posible
 * emergencia. El relato, el teléfono y las respuestas solo se ven en
 * /dashboard/operations, con sesión: un correo se reenvía y se queda en buzones.
 *
 * Nunca lanza: si el correo falla, el caso ya quedó guardado.
 */

export type CasoParaAviso = {
  documentId: string;
  caseNumber: string;
  fullName: string;
  procedimiento: string | null;
  emergencyFlag: boolean;
};

function escapar(texto: string) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function notificarCasoNuevo(strapi, caso: CasoParaAviso) {
  const para = (process.env.CASE_NOTIFY_EMAILS ?? "")
    .split(",")
    .map((correo) => correo.trim())
    .filter(Boolean);
  if (!process.env.SMTP_HOST || para.length === 0) return;

  const procedimiento = caso.procedimiento?.trim() || "Sin procedimiento";
  const url = `${(process.env.CLIENT_URL ?? "").replace(/\/$/, "")}/dashboard/operations/${caso.documentId}`;
  const asunto = `${caso.emergencyFlag ? "[URGENTE] " : ""}Nuevo caso ${caso.caseNumber} · ${caso.fullName} · ${procedimiento}`;

  const alerta = caso.emergencyFlag
    ? `<p style="background:#fee2e2;color:#991b1b;padding:12px;border-radius:8px;margin:0 0 16px"><strong>Posible emergencia:</strong> el relato menciona palabras de alarma. Revisarlo hoy.</p>`
    : "";

  const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:520px">
  <h2 style="margin:0 0 4px">Nuevo caso ${escapar(caso.caseNumber)}</h2>
  <p style="margin:0 0 16px;color:#555">${escapar(caso.fullName)} · ${escapar(procedimiento)}</p>
  ${alerta}
  <p style="margin:0 0 20px">Los detalles del caso están en Operación.</p>
  <a href="${url}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Abrir el caso</a>
  <p style="margin:20px 0 0;color:#888;font-size:12px">Para abrirlo necesitas iniciar sesión con un usuario con acceso a Operación.</p>
</div>`;

  const texto = [
    asunto,
    "",
    caso.emergencyFlag ? "Posible emergencia: el relato menciona palabras de alarma. Revisarlo hoy.\n" : "",
    `Abrir el caso: ${url}`,
  ].join("\n");

  try {
    await strapi.plugin("email").service("email").send({ to: para, subject: asunto, text: texto, html });
    strapi.log.info(`[case.aviso] ${caso.caseNumber}: correo enviado a ${para.length} destinatario(s)`);
  } catch (error) {
    strapi.log.error(`[case.aviso] ${caso.caseNumber}: no se pudo enviar el correo`, error);
  }
}
