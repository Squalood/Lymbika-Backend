"use strict";

import crypto from "node:crypto";

const { createCoreController } = require("@strapi/strapi").factories;

// ── Configuración ────────────────────────────────────────────────────────────

const MAX_NARRATIVA = 2000;
const MAX_CAMPO_CORTO = 120;
const MAX_ARCHIVOS_POR_ENVIO = 5;
const MAX_DOCUMENTOS_POR_CASO = 10;
const MAX_BYTES_POR_ARCHIVO = 10 * 1024 * 1024;

// Límite suave contra spam: el intake es público. Vive en memoria, así que se
// reinicia con cada deploy y no se comparte entre instancias — suficiente para
// una sola instancia en Render.
const VENTANA_RATE_MS = 10 * 60 * 1000;
const MAX_INTAKES_POR_VENTANA = 10;
const intakesPorIp = new Map<string, number[]>();

const RESPUESTAS_SI_NO = ["yes", "no", "unsure"] as const;
const ESTADOS_DOCUMENTOS = ["upload_now", "send_later", "none"] as const;
const INTENCIONES = [
  "options",
  "cost",
  "assessment",
  "second_opinion",
  "schedule",
  "unsure",
] as const;

// Espeja frontend: lib/case/emergency-detection.ts. Se recalcula aquí para que
// el flag no dependa de lo que diga el cliente.
const PALABRAS_EMERGENCIA = [
  "dolor de pecho",
  "dolor en el pecho",
  "no puedo respirar",
  "no puede respirar",
  "dificultad para respirar",
  "falta de aire",
  "hemorragia",
  "sangrado abundante",
  "sangra mucho",
  "no responde",
  "inconsciente",
  "desmayo",
  "se desmayo",
  "convulsion",
  "infarto",
  "derrame",
  "paralisis",
  "perdida de conocimiento",
  "suicid",
  "sobredosis",
  "envenenamiento",
  "accidente grave",
];

const FORMATO_TOKEN = /^[A-Za-z0-9_-]{32}$/;

// ── Utilidades ───────────────────────────────────────────────────────────────

function normalizarTexto(texto: string) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function detectarEmergencia(texto: string) {
  const normalizado = normalizarTexto(texto);
  return PALABRAS_EMERGENCIA.some((palabra) => normalizado.includes(palabra));
}

function textoCorto(valor: unknown, max = MAX_CAMPO_CORTO) {
  if (typeof valor !== "string") return "";
  return valor.trim().slice(0, max);
}

function enumOpcional<T extends readonly string[]>(valor: unknown, opciones: T) {
  return typeof valor === "string" && (opciones as readonly string[]).includes(valor)
    ? (valor as T[number])
    : undefined;
}

function excedeRateLimit(ip: string) {
  const ahora = Date.now();
  const recientes = (intakesPorIp.get(ip) ?? []).filter(
    (t) => ahora - t < VENTANA_RATE_MS
  );
  if (recientes.length >= MAX_INTAKES_POR_VENTANA) {
    intakesPorIp.set(ip, recientes);
    return true;
  }
  recientes.push(ahora);
  intakesPorIp.set(ip, recientes);
  return false;
}

/** Solo deja pasar strings cortos con claves utm_*. */
function limpiarUtm(utm: unknown) {
  if (!utm || typeof utm !== "object" || Array.isArray(utm)) return null;
  const limpio: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(utm)) {
    if (/^utm_[a-z]{1,20}$/.test(clave) && typeof valor === "string") {
      limpio[clave] = valor.slice(0, 200);
    }
  }
  return Object.keys(limpio).length > 0 ? limpio : null;
}

// ── Controller ───────────────────────────────────────────────────────────────

module.exports = createCoreController("api::case.case", ({ strapi }) => {
  /** Usuario del JWT si viene uno válido; si no, null. Nunca rechaza. */
  async function usuarioOpcional(ctx): Promise<number | null> {
    const header = ctx.request.header.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    try {
      const payload = await strapi
        .plugin("users-permissions")
        .service("jwt")
        .verify(header.slice("Bearer ".length));
      const id = Number(payload?.id);
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }

  /** LYM-<año>-<consecutivo de 6 dígitos>, reiniciando cada año. */
  async function siguienteNumeroDeCaso() {
    const anio = new Date().getFullYear();
    const prefijo = `LYM-${anio}-`;
    const ultimo = await strapi.documents("api::case.case").findFirst({
      filters: { caseNumber: { $startsWith: prefijo } },
      sort: "caseNumber:desc",
      fields: ["caseNumber"],
    });
    const consecutivo = ultimo
      ? Number(String(ultimo.caseNumber).slice(prefijo.length)) + 1
      : 1;
    return `${prefijo}${String(consecutivo).padStart(6, "0")}`;
  }

  async function buscarPorToken(token: unknown) {
    if (typeof token !== "string" || !FORMATO_TOKEN.test(token)) return null;
    return strapi.documents("api::case.case").findFirst({
      filters: { accessToken: { $eq: token } },
      populate: {
        medical_service: { fields: ["name", "slug"] },
        selected_doctor: {
          fields: ["doctorName", "slug"],
          populate: { image: { fields: ["url", "formats"] } },
        },
        hospital: { fields: ["hospitalName", "slug"] },
        documents: { fields: ["name", "mime", "createdAt"] },
        followUpTasks: true,
      },
    });
  }

  return {
    // POST /cases/intake — crea el caso desde el guided intake (sin archivos).
    async intake(ctx) {
      if (excedeRateLimit(ctx.request.ip)) {
        ctx.status = 429;
        ctx.body = {
          error: {
            status: 429,
            message:
              "Recibimos varias solicitudes seguidas. Intenta de nuevo en unos minutos.",
          },
        };
        return;
      }

      const body = (ctx.request.body ?? {}) as Record<string, unknown>;

      // Honeypot: un humano nunca llena este campo oculto.
      if (textoCorto(body.website)) {
        return ctx.badRequest("Solicitud inválida.");
      }

      const narrative =
        typeof body.narrative === "string" ? body.narrative.trim() : "";
      const fullName = textoCorto(body.fullName);
      const phone = textoCorto(body.phone, 30);
      const city = textoCorto(body.city);

      if (narrative.length < 3 || narrative.length > MAX_NARRATIVA) {
        return ctx.badRequest("Cuéntanos brevemente qué necesitas resolver.");
      }
      if (fullName.length < 2) {
        return ctx.badRequest("Escribe tu nombre completo.");
      }
      if (phone.replace(/\D/g, "").length < 10) {
        return ctx.badRequest("Escribe un teléfono o WhatsApp válido.");
      }
      if (body.consent !== true) {
        return ctx.badRequest("Necesitamos tu autorización para contactarte.");
      }

      let medicalServiceId: number | undefined;
      const slug = textoCorto(body.medicalServiceSlug);
      if (slug) {
        const servicio = await strapi
          .documents("api::medical-service.medical-service")
          .findFirst({
            filters: { slug: { $eq: slug } },
            fields: ["id"],
            status: "published",
          });
        if (!servicio) {
          return ctx.badRequest("El procedimiento indicado no existe.");
        }
        medicalServiceId = servicio.id;
      }

      const userId = await usuarioOpcional(ctx);
      const accessToken = crypto.randomBytes(24).toString("base64url");

      const data = {
        accessToken,
        estado: "new",
        narrative,
        reviewedByDoctor: enumOpcional(body.reviewedByDoctor, RESPUESTAS_SI_NO),
        surgeryIndicated: enumOpcional(body.surgeryIndicated, RESPUESTAS_SI_NO),
        documentsStatus: enumOpcional(body.documentsStatus, ESTADOS_DOCUMENTOS),
        intent: enumOpcional(body.intent, INTENCIONES),
        emergencyFlag: detectarEmergencia(narrative),
        fullName,
        phone,
        city: city || undefined,
        consent: true,
        consentAt: new Date().toISOString(),
        source: textoCorto(body.source, 40) || "procedure_page",
        landingPath: textoCorto(body.landingPath, 300) || undefined,
        utm: limpiarUtm(body.utm),
        ...(medicalServiceId && { medical_service: medicalServiceId }),
        ...(userId && { user: userId }),
      };

      // Dos intakes simultáneos pueden calcular el mismo consecutivo; el unique
      // de caseNumber hace fallar al segundo y aquí se reintenta.
      for (let intento = 0; intento < 3; intento++) {
        const caseNumber = await siguienteNumeroDeCaso();
        try {
          await strapi.documents("api::case.case").create({
            data: { ...data, caseNumber } as any,
          });
          ctx.body = { caseNumber, token: accessToken };
          return;
        } catch (error) {
          strapi.log.warn(
            `[case.intake] intento ${intento + 1} falló con ${caseNumber}`,
            error
          );
        }
      }

      strapi.log.error("[case.intake] no se pudo crear el caso");
      return ctx.internalServerError("No pudimos registrar tu caso. Intenta de nuevo.");
    },

    // GET /cases/by-token/:token — vista "Mi caso" del paciente.
    async porToken(ctx) {
      const caso: any = await buscarPorToken(ctx.params.token);
      if (!caso) return ctx.notFound("Caso no encontrado.");

      // DTO armado a mano: nada de prioridad, notas internas, teléfono, utm,
      // usuario ni token. Si se agrega un campo al schema, no se filtra solo.
      ctx.body = {
        caseNumber: caso.caseNumber,
        estado: caso.estado,
        patientNextStep: caso.patientNextStep ?? null,
        createdAt: caso.createdAt,
        medicalService: caso.medical_service
          ? { name: caso.medical_service.name, slug: caso.medical_service.slug }
          : null,
        doctor: caso.selected_doctor
          ? {
              doctorName: caso.selected_doctor.doctorName,
              slug: caso.selected_doctor.slug,
              image: caso.selected_doctor.image?.url ?? null,
            }
          : null,
        hospital: caso.hospital
          ? { hospitalName: caso.hospital.hospitalName, slug: caso.hospital.slug }
          : null,
        documents: (caso.documents ?? []).map((d) => ({
          name: d.name,
          mime: d.mime,
          createdAt: d.createdAt,
        })),
        quote: caso.quotePresented
          ? {
              amount: caso.quoteAmount != null ? Number(caso.quoteAmount) : null,
              validUntil: caso.quoteValidUntil ?? null,
            }
          : null,
        surgery: caso.surgeryDate
          ? {
              date: caso.surgeryDate,
              confirmed: Boolean(caso.surgeryDateConfirmed),
            }
          : null,
        followUpTasks: (caso.followUpTasks ?? []).map((t) => ({
          title: t.title,
          done: Boolean(t.done),
        })),
      };
    },

    // POST /cases/by-token/:token/documents — estudios del paciente (multipart).
    async subirDocumentos(ctx) {
      const caso: any = await buscarPorToken(ctx.params.token);
      if (!caso) return ctx.notFound("Caso no encontrado.");

      const recibidos = ctx.request.files?.files;
      const archivos = (Array.isArray(recibidos) ? recibidos : [recibidos]).filter(
        Boolean
      );

      if (archivos.length === 0) {
        return ctx.badRequest("No se recibió ningún archivo.");
      }
      if (archivos.length > MAX_ARCHIVOS_POR_ENVIO) {
        return ctx.badRequest(`Máximo ${MAX_ARCHIVOS_POR_ENVIO} archivos por envío.`);
      }

      const existentes = caso.documents ?? [];
      if (existentes.length + archivos.length > MAX_DOCUMENTOS_POR_CASO) {
        return ctx.badRequest("Este caso ya tiene el máximo de documentos.");
      }

      for (const archivo of archivos) {
        const mime = String(archivo.mimetype ?? archivo.type ?? "");
        const esValido = mime.startsWith("image/") || mime === "application/pdf";
        if (!esValido) {
          return ctx.badRequest("Solo se aceptan imágenes o PDF.");
        }
        if (Number(archivo.size) > MAX_BYTES_POR_ARCHIVO) {
          return ctx.badRequest("Cada archivo debe pesar máximo 10 MB.");
        }
      }

      try {
        const subidos = await strapi
          .plugin("upload")
          .service("upload")
          .upload({ data: {}, files: archivos });

        const ids = [
          ...existentes.map((d) => d.id),
          ...(Array.isArray(subidos) ? subidos : [subidos]).map((f) => f.id),
        ];

        await strapi.documents("api::case.case").update({
          documentId: caso.documentId,
          data: { documents: ids } as any,
        });

        ctx.body = { uploaded: archivos.length };
      } catch (error) {
        strapi.log.error("[case.subirDocumentos] fallo al subir", error);
        return ctx.internalServerError("No pudimos subir tus archivos.");
      }
    },
  };
});
