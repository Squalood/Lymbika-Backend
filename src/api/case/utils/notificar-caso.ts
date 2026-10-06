/**
 * Aviso por correo a coordinación cuando entra un caso nuevo.
 *
 * Se activa con dos variables: SMTP_HOST (ver config/plugins.ts) y
 * CASE_NOTIFY_EMAILS (destinatarios separados por coma). Sin ellas no envía y
 * solo lo registra en el log.
 *
 * Nunca lanza: un correo que no sale no debe tumbar el registro del caso — el
 * caso ya está en Strapi y coordinación lo ve en el panel de todos modos.
 */

const RESPUESTA: Record<string, string> = {
  yes: "Sí",
  no: "No",
  unsure: "No está seguro",
};

const DOCUMENTOS: Record<string, string> = {
  upload_now: "Los subió en el formulario",
  send_later: "Los enviará después",
  none: "No tiene estudios",
};

const INTENCION: Record<string, string> = {
  options: "Saber sus opciones",
  cost: "Saber cuánto cuesta",
  assessment: "Agendar una valoración",
  second_opinion: "Una segunda opinión",
  schedule: "Ya quiere programar",
  unsure: "No está seguro, necesita orientación",
};

export type CasoParaAviso = {
  documentId: string;
  caseNumber: string;
  fullName: string;
  phone: string;
  city?: string;
  narrative: string;
  emergencyFlag: boolean;
  reviewedByDoctor?: string;
  surgeryIndicated?: string;
  documentsStatus?: string;
  intent?: string;
  procedimiento?: string | null;
};

function escapar(texto: string) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function destinatarios() {
  return (process.env.CASE_NOTIFY_EMAILS ?? "")
    .split(",")
    .map((correo) => correo.trim())
    .filter(Boolean);
}

export async function notificarCasoNuevo(strapi, caso: CasoParaAviso) {
  const para = destinatarios();
  if (!process.env.SMTP_HOST || para.length === 0) {
    strapi.log.warn(
      `[case.aviso] ${caso.caseNumber}: sin SMTP_HOST o CASE_NOTIFY_EMAILS, no se envió correo`
    );
    return;
  }

  // El caso se abre en el admin de la página (/operacion), no en el de Strapi.
  const urlPanel = `${(process.env.CLIENT_URL ?? "").replace(/\/$/, "")}/operacion/${caso.documentId}`;
  const urlWhatsApp = `https://wa.me/${caso.phone.replace(/\D/g, "")}`;
  const procedimiento = caso.procedimiento?.trim() || "Sin procedimiento (entró desde la portada)";

  const asunto = `${caso.emergencyFlag ? "[URGENTE] " : ""}Nuevo caso ${caso.caseNumber} · ${caso.fullName} · ${procedimiento}`;

  const filas: [string, string | undefined][] = [
    ["Procedimiento", procedimiento],
    ["WhatsApp", caso.phone],
    ["Ciudad", caso.city],
    ["¿Ya lo revisó un médico?", RESPUESTA[caso.reviewedByDoctor ?? ""]],
    ["¿Le indicaron cirugía?", RESPUESTA[caso.surgeryIndicated ?? ""]],
    ["Estudios", DOCUMENTOS[caso.documentsStatus ?? ""]],
    ["Quiere resolver primero", INTENCION[caso.intent ?? ""]],
  ];

  const filasHtml = filas
    .filter(([, valor]) => valor)
    .map(
      ([etiqueta, valor]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapar(etiqueta)}</td><td style="padding:4px 0"><strong>${escapar(valor!)}</strong></td></tr>`
    )
    .join("");

  const alerta = caso.emergencyFlag
    ? `<p style="background:#fee2e2;color:#991b1b;padding:12px;border-radius:8px"><strong>Posible emergencia:</strong> el relato menciona palabras de alarma. Contactar hoy.</p>`
    : "";

  const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:560px">
  <h2 style="margin:0 0 4px">Nuevo caso ${escapar(caso.caseNumber)}</h2>
  <p style="margin:0 0 16px;color:#666">${escapar(caso.fullName)}</p>
  ${alerta}
  <table style="border-collapse:collapse;margin-bottom:16px">${filasHtml}</table>
  <p style="margin:0 0 4px;color:#666">Lo que escribió el paciente:</p>
  <blockquote style="margin:0 0 20px;padding:12px;background:#f5f5f5;border-radius:8px;white-space:pre-wrap">${escapar(caso.narrative)}</blockquote>
  <p>
    <a href="${urlPanel}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir el caso</a>
    &nbsp;
    <a href="${urlWhatsApp}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Escribirle por WhatsApp</a>
  </p>
</div>`;

  const texto = [
    asunto,
    "",
    ...filas.filter(([, v]) => v).map(([e, v]) => `${e}: ${v}`),
    "",
    "Lo que escribió el paciente:",
    caso.narrative,
    "",
    `Abrir el caso: ${urlPanel}`,
    `WhatsApp: ${urlWhatsApp}`,
  ].join("\n");

  try {
    await strapi.plugin("email").service("email").send({
      to: para,
      subject: asunto,
      text: texto,
      html,
    });
    strapi.log.info(`[case.aviso] ${caso.caseNumber}: correo enviado a ${para.length} destinatario(s)`);
  } catch (error) {
    strapi.log.error(`[case.aviso] ${caso.caseNumber}: no se pudo enviar el correo`, error);
  }
}
