"use strict";

import {
  enlacePaciente,
  generarToken,
  siguienteNumeroDeCaso,
} from "../utils/identidad-caso";
import { notificarCasoNuevo } from "../utils/notificar-caso";

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

// utm_source que identifican un tipo de origen. Convención para los enlaces y
// QR que se reparten: ?utm_source=empresa&utm_campaign=<nombre de la empresa>.
const ORIGEN_POR_UTM_SOURCE: Record<string, string> = {
  empresa: "company",
  comunidad: "community",
  nodo: "node",
  medico: "doctor",
};

/**
 * Origen del caso a partir de los utm ya limpios. Sin utm queda "pending": no
 * se inventa una atribución, coordinación la completa.
 */
function origenDesdeUtm(utm: Record<string, string> | null) {
  const fuente = utm?.utm_source?.toLowerCase();
  const campana = utm?.utm_campaign?.slice(0, MAX_CAMPO_CORTO);
  if (fuente && ORIGEN_POR_UTM_SOURCE[fuente]) {
    return { originType: ORIGEN_POR_UTM_SOURCE[fuente], originDetail: campana || undefined };
  }
  if (campana) return { originType: "campaign", originDetail: campana };
  return { originType: "pending" };
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

  async function buscarPorToken(token: unknown) {
    if (typeof token !== "string" || !FORMATO_TOKEN.test(token)) return null;
    return strapi.documents("api::case.case").findFirst({
      filters: { accessToken: { $eq: token } },
      // `case` no tiene borradores, pero doctor, hospital y medical-service sí.
      // Sin esto el populate trae la versión borrador del relacionado y las
      // relaciones guardadas (que apuntan a la publicada) salen en null.
      status: "published",
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

  type DoctorAsignado = { documentId: string; doctorName: string };

  /**
   * Doctor ligado al usuario del JWT (campo `doctor` del user). Si existe, el
   * usuario es un especialista y solo opera sus casos; si no, es coordinación
   * y ve todo. No depende del nombre del rol.
   */
  async function doctorDelUsuario(ctx): Promise<DoctorAsignado | null> {
    const userId = ctx.state.user?.id;
    if (!userId) return null;
    const usuario = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: userId },
      populate: { doctor: { select: ["documentId", "doctorName"] } },
    });
    return usuario?.doctor ?? null;
  }

  // Por documentId y no por id: doctor tiene borrador y publicado, y la
  // relación puede apuntar a cualquiera de las dos filas.
  function filtroDeDoctor(doctor: DoctorAsignado) {
    return { selected_doctor: { documentId: { $eq: doctor.documentId } } };
  }

  async function esCasoDelDoctor(documentId: unknown, doctor: DoctorAsignado) {
    if (typeof documentId !== "string") return false;
    const caso = await strapi.documents("api::case.case").findFirst({
      filters: { documentId: { $eq: documentId }, ...filtroDeDoctor(doctor) },
      fields: ["id"],
    });
    return Boolean(caso);
  }

  // ── Equipo: coordinador y responsable ──────────────────────────────────────
  // `coordinator` y `nextActionOwner` apuntan a users-permissions user. El core
  // REST rechaza escribirlas o filtrarlas ("Invalid key") y las quita del
  // populate si el rol no tiene `user.find`, que no se da porque expondría a
  // todos los usuarios. Por eso entran, salen y se filtran por aquí.

  type MiembroEquipo = { documentId: string; nombre: string };

  const RELACIONES_DE_EQUIPO = ["coordinator", "nextActionOwner"] as const;
  const CAMPOS_USUARIO = ["documentId", "firstName", "lastName", "username"];

  function nombreDeUsuario(u): string {
    const completo = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    return completo || u.username;
  }

  /** Usuarios activos cuyo rol puede ver casos (coordinación y especialistas). */
  async function miembrosDelEquipo(): Promise<MiembroEquipo[]> {
    const permisos = await strapi.db.query("plugin::users-permissions.permission").findMany({
      where: { action: "api::case.case.find" },
      populate: { role: { select: ["id"] } },
    });
    const roles = permisos.map((p) => p.role?.id).filter(Boolean);
    if (roles.length === 0) return [];
    const usuarios = await strapi.db.query("plugin::users-permissions.user").findMany({
      where: { role: { id: { $in: roles } }, blocked: { $ne: true } },
      select: CAMPOS_USUARIO,
    });
    return usuarios
      .map((u) => ({ documentId: u.documentId, nombre: nombreDeUsuario(u) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  /**
   * Saca del body las relaciones de equipo (el frontend manda el documentId del
   * usuario o null) y las valida contra el equipo. Se aplican después con
   * `aplicarRelaciones`, ya fuera del core.
   */
  async function tomarRelacionesDeEquipo(
    data,
    doctor: DoctorAsignado | null
  ): Promise<{ relaciones: Record<string, { set: string[] }> } | { error: string }> {
    const relaciones: Record<string, { set: string[] }> = {};
    if (!data || typeof data !== "object") return { relaciones };
    let equipo: MiembroEquipo[] | null = null;

    for (const campo of RELACIONES_DE_EQUIPO) {
      if (!(campo in data)) continue;
      const valor = data[campo];
      delete data[campo];
      // El coordinador del caso lo decide coordinación, no el especialista.
      if (doctor && campo === "coordinator") continue;
      if (valor === null || valor === "") {
        relaciones[campo] = { set: [] };
        continue;
      }
      equipo ??= await miembrosDelEquipo();
      if (typeof valor !== "string" || !equipo.some((m) => m.documentId === valor)) {
        return { error: "El usuario elegido no es parte del equipo." };
      }
      relaciones[campo] = { set: [valor] };
    }
    return { relaciones };
  }

  async function aplicarRelaciones(documentId: unknown, relaciones: Record<string, unknown>) {
    if (typeof documentId !== "string" || Object.keys(relaciones).length === 0) return;
    await strapi.documents("api::case.case").update({ documentId, data: relaciones as any });
  }

  // Lo económico y las notas internas no son para el especialista.
  const CAMPOS_RESERVADOS = ["internalNotes", "quoteAmount", "quoteValidUntil", "quotePresented"];

  function quitarReservados(objeto) {
    if (!objeto || typeof objeto !== "object") return;
    for (const campo of CAMPOS_RESERVADOS) delete objeto[campo];
  }

  /**
   * Prepara la salida para el equipo: anexa coordinador y responsable como
   * `{ documentId, nombre }` y, si es especialista, quita los campos reservados.
   */
  async function completarParaEquipo(datos, doctor: DoctorAsignado | null) {
    const casos = (Array.isArray(datos) ? datos : [datos]).filter(
      (c) => c && typeof c.documentId === "string"
    );
    if (casos.length === 0) return;
    if (doctor) casos.forEach(quitarReservados);

    const filas = await strapi.db.query("api::case.case").findMany({
      where: { documentId: { $in: casos.map((c) => c.documentId) } },
      select: ["documentId"],
      populate: {
        coordinator: { select: CAMPOS_USUARIO },
        nextActionOwner: { select: CAMPOS_USUARIO },
      },
    });
    const porId = new Map<string, any>(filas.map((f) => [f.documentId, f]));
    const miembro = (u) => (u ? { documentId: u.documentId, nombre: nombreDeUsuario(u) } : null);
    for (const caso of casos) {
      const fila = porId.get(caso.documentId);
      caso.coordinator = miembro(fila?.coordinator);
      caso.nextActionOwner = miembro(fila?.nextActionOwner);
    }
  }

  /**
   * Filtros de equipo que Strapi no acepta en `filters`: `?coordinador=` y
   * `?responsable=` con `yo`, `ninguno` o el documentId de un usuario. Se
   * quitan del query antes de validarlo.
   */
  function tomarFiltrosDeEquipo(ctx) {
    const filtros = [];
    const parametros = { coordinador: "coordinator", responsable: "nextActionOwner" };
    for (const [parametro, campo] of Object.entries(parametros)) {
      const valor = ctx.query?.[parametro];
      if (valor === undefined) continue;
      delete ctx.query[parametro];
      if (valor === "yo") filtros.push({ [campo]: { id: { $eq: ctx.state.user.id } } });
      else if (valor === "ninguno") filtros.push({ [campo]: { id: { $null: true } } });
      else if (typeof valor === "string") filtros.push({ [campo]: { documentId: { $eq: valor } } });
    }
    return filtros;
  }

  return {
    // ── Core REST (/dashboard/operations del frontend) ──────────────────────
    // El permiso del rol decide quién entra; estos overrides deciden qué casos
    // ve un especialista. Strapi ya validó el JWT antes de llegar aquí.

    // GET /cases — al especialista se le fuerza el filtro por su doctor. En
    // `meta.doctorAsignado` va su doctor para que el frontend ajuste la vista.
    // `this: any`: el factory viene de require() y sus helpers no están tipados.
    async find(this: any, ctx) {
      const doctor = await doctorDelUsuario(ctx);
      const extra = tomarFiltrosDeEquipo(ctx);
      if (doctor) extra.push(filtroDeDoctor(doctor));

      await this.validateQuery(ctx);
      const query = await this.sanitizeQuery(ctx);
      const { results, pagination } = await strapi.service("api::case.case").find({
        ...query,
        filters: extra.length ? { $and: [query.filters ?? {}, ...extra] } : query.filters,
      });
      const datos = await this.sanitizeOutput(results, ctx);
      await completarParaEquipo(datos, doctor);
      // transformResponse es async en Strapi 5: sin await, el spread de abajo
      // copia una Promise y la respuesta sale sin `data` ni `pagination`.
      const respuesta = await this.transformResponse(datos, { pagination });
      if (!doctor) return respuesta;
      return { ...respuesta, meta: { ...respuesta.meta, doctorAsignado: doctor } };
    },

    // GET /cases/:id — un caso ajeno responde 404, igual que uno inexistente.
    async findOne(ctx) {
      const doctor = await doctorDelUsuario(ctx);
      if (doctor && !(await esCasoDelDoctor(ctx.params.id, doctor))) {
        return ctx.notFound("Caso no encontrado.");
      }
      const respuesta = await super.findOne(ctx);
      await completarParaEquipo(respuesta?.data, doctor);
      return respuesta;
    },

    // POST /cases — alta manual del equipo. Sin coordinador explícito queda
    // quien lo crea; el de un especialista queda asignado a él.
    async create(ctx) {
      const doctor = await doctorDelUsuario(ctx);
      const data = ctx.request.body?.data;
      const tomadas = await tomarRelacionesDeEquipo(data, doctor);
      if ("error" in tomadas) return ctx.badRequest(tomadas.error);
      const { relaciones } = tomadas;

      if (data && typeof data === "object") {
        if (doctor) {
          data.selected_doctor = { set: [doctor.documentId] };
          quitarReservados(data);
        } else if (!relaciones.coordinator) {
          relaciones.coordinator = { set: [ctx.state.user.documentId] };
        }
        data.originType ??= "pending";
      }

      const respuesta = await super.create(ctx);
      await aplicarRelaciones(respuesta?.data?.documentId, relaciones);
      await completarParaEquipo(respuesta?.data, doctor);
      return respuesta;
    },

    // PUT /cases/:id — el especialista no reasigna: se descarta `selected_doctor`
    // (si lo cambiara, el caso saldría de su bandeja).
    async update(ctx) {
      const doctor = await doctorDelUsuario(ctx);
      const data = ctx.request.body?.data;
      if (doctor) {
        if (!(await esCasoDelDoctor(ctx.params.id, doctor))) {
          return ctx.notFound("Caso no encontrado.");
        }
        if (data && typeof data === "object") {
          delete data.selected_doctor;
          quitarReservados(data);
        }
      }
      const tomadas = await tomarRelacionesDeEquipo(data, doctor);
      if ("error" in tomadas) return ctx.badRequest(tomadas.error);

      const respuesta = await super.update(ctx);
      await aplicarRelaciones(respuesta?.data?.documentId, tomadas.relaciones);
      await completarParaEquipo(respuesta?.data, doctor);
      return respuesta;
    },

    // GET /cases/equipo/miembros — opciones de coordinador y responsable.
    async equipo(ctx) {
      ctx.body = { data: await miembrosDelEquipo() };
    },

    async delete(ctx) {
      const doctor = await doctorDelUsuario(ctx);
      if (doctor && !(await esCasoDelDoctor(ctx.params.id, doctor))) {
        return ctx.notFound("Caso no encontrado.");
      }
      return super.delete(ctx);
    },

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
      let procedimiento: string | null = null;
      const slug = textoCorto(body.medicalServiceSlug);
      if (slug) {
        const servicio = await strapi
          .documents("api::medical-service.medical-service")
          .findFirst({
            filters: { slug: { $eq: slug } },
            fields: ["id", "name"],
            status: "published",
          });
        if (!servicio) {
          return ctx.badRequest("El procedimiento indicado no existe.");
        }
        medicalServiceId = servicio.id;
        procedimiento = servicio.name;
      }

      const userId = await usuarioOpcional(ctx);
      const accessToken = generarToken();
      const utm = limpiarUtm(body.utm);

      const data = {
        accessToken,
        patientLink: enlacePaciente(accessToken),
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
        utm,
        channel: "web",
        ...origenDesdeUtm(utm),
        ...(medicalServiceId && { medical_service: medicalServiceId }),
        ...(userId && { user: userId }),
      };

      // Dos intakes simultáneos pueden calcular el mismo consecutivo; el unique
      // de caseNumber hace fallar al segundo y aquí se reintenta.
      for (let intento = 0; intento < 3; intento++) {
        const caseNumber = await siguienteNumeroDeCaso(strapi);
        try {
          const creado = await strapi.documents("api::case.case").create({
            data: { ...data, caseNumber } as any,
          });
          ctx.body = { caseNumber, token: accessToken };

          // Sin await: el paciente no espera a que salga el correo.
          void notificarCasoNuevo(strapi, {
            documentId: creado.documentId,
            caseNumber,
            fullName,
            procedimiento,
            emergencyFlag: data.emergencyFlag,
          });
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
