import { enlacePaciente } from "./identidad-caso";

/**
 * Panel de Strapi para coordinación: etiquetas en español, columnas de la
 * lista, orden del formulario y campos de solo lectura de la colección Case.
 *
 * Strapi guarda esto en la base (no en el schema), y por defecto muestra los
 * nombres técnicos en el orden del schema. Se aplica desde código para que sea
 * igual en local y en producción.
 *
 * Solo se reaplica cuando cambia VERSION_PANEL: si alguien ajusta la vista a
 * mano desde "Configurar la vista", su cambio se respeta hasta el siguiente
 * cambio de versión aquí. Para publicar un ajuste nuevo, súbele la versión.
 */
const VERSION_PANEL = 1;

const UID = "api::case.case";
const UID_TAREA = "case.follow-up-task";

type Campo = {
  label: string;
  description?: string;
  /** false = el coordinador lo ve pero no lo puede cambiar (lo llenó el paciente). */
  editable?: boolean;
  visible?: boolean;
  mainField?: string;
};

const CAMPOS: Record<string, Campo> = {
  caseNumber: { label: "Número de caso", editable: false },
  estado: {
    label: "Estado",
    description:
      "new = Nuevo · in_coordination = En coordinación · in_assessment = Valoración, estudios o cotización · in_decision = El paciente está decidiendo · scheduled = Programado · in_surgery = En cirugía · in_follow_up = Seguimiento · closed_won = Cerrado con cirugía · closed_lost = Cerrado sin cirugía. El paciente ve una frase en español según el estado.",
  },
  priority: {
    label: "Prioridad",
    description: "Interna. El paciente no la ve.",
  },
  patientLink: {
    label: "Enlace de Mi caso",
    description:
      "Cópialo y mándaselo al paciente por WhatsApp si perdió su enlace. Es privado: quien lo tenga ve el avance del caso.",
    editable: false,
  },
  patientNextStep: {
    label: "Siguiente paso (lo ve el paciente)",
    description:
      "Opcional. Si lo dejas vacío, el paciente ve el texto automático de su estado.",
  },
  internalNotes: {
    label: "Notas internas",
    description: "Solo para el equipo. El paciente no las ve.",
  },
  fullName: { label: "Nombre del paciente" },
  phone: { label: "WhatsApp / teléfono" },
  city: { label: "Ciudad" },
  medical_service: { label: "Procedimiento", mainField: "name" },
  emergencyFlag: {
    label: "Posible emergencia",
    description: "Se marca sola si el relato menciona palabras de alarma.",
  },
  narrative: { label: "Lo que escribió el paciente", editable: false },
  reviewedByDoctor: {
    label: "¿Ya lo revisó un médico?",
    description: "yes = Sí · no = No · unsure = No está seguro",
    editable: false,
  },
  surgeryIndicated: {
    label: "¿Le indicaron cirugía?",
    description: "yes = Sí · no = No · unsure = No está seguro",
    editable: false,
  },
  documentsStatus: {
    label: "Estudios",
    description:
      "upload_now = Los subió · send_later = Los enviará después · none = No tiene",
    editable: false,
  },
  intent: {
    label: "Quiere resolver primero",
    description:
      "options = Sus opciones · cost = Cuánto cuesta · assessment = Agendar valoración · second_opinion = Segunda opinión · schedule = Ya quiere programar · unsure = Necesita orientación",
    editable: false,
  },
  documents: {
    label: "Documentos y estudios",
    description: "El paciente ve el nombre de cada archivo en Mi caso.",
  },
  selected_doctor: {
    label: "Especialista asignado",
    description: "El paciente lo ve en Mi caso.",
    mainField: "doctorName",
  },
  hospital: {
    label: "Hospital",
    description: "El paciente lo ve en Mi caso.",
    mainField: "hospitalName",
  },
  service_rate: { label: "Tarifa / paquete", mainField: "package_label" },
  quoteAmount: { label: "Cotización (MXN)" },
  quoteValidUntil: { label: "Cotización vigente hasta" },
  quotePresented: {
    label: "Mostrar cotización al paciente",
    description: "Mientras esté apagado, el paciente no ve la cotización.",
  },
  surgeryDate: { label: "Fecha de cirugía" },
  surgeryDateConfirmed: {
    label: "Fecha confirmada",
    description: "Apagado = el paciente la ve como fecha tentativa.",
  },
  followUpTasks: {
    label: "Tareas de seguimiento",
    description: "El paciente ve la lista y cuáles están hechas.",
  },
  user: {
    label: "Cuenta del paciente",
    description: "Solo si envió el caso con sesión iniciada.",
    mainField: "email",
    editable: false,
  },
  source: { label: "Origen", editable: false },
  landingPath: { label: "Página de origen", editable: false },
  utm: { label: "Campaña (UTM)", editable: false },
  consent: { label: "Aceptó ser contactado", editable: false },
  consentAt: { label: "Fecha de aceptación", editable: false },
  accessToken: { label: "Token", visible: false, editable: false },
  createdAt: { label: "Recibido" },
  updatedAt: { label: "Última actualización" },
};

/** Filas del formulario: el ancho total de cada fila es 12. */
const FORMULARIO: [string, number][][] = [
  // Coordinación
  [["caseNumber", 4], ["estado", 4], ["priority", 4]],
  [["patientLink", 12]],
  [["patientNextStep", 12]],
  [["internalNotes", 12]],
  // Paciente
  [["fullName", 4], ["phone", 4], ["city", 4]],
  [["medical_service", 6], ["emergencyFlag", 4]],
  [["narrative", 12]],
  [["reviewedByDoctor", 6], ["surgeryIndicated", 6]],
  [["documentsStatus", 6], ["intent", 6]],
  [["documents", 12]],
  // Plan
  [["selected_doctor", 6], ["hospital", 6]],
  [["service_rate", 6]],
  [["quoteAmount", 4], ["quoteValidUntil", 4], ["quotePresented", 4]],
  [["surgeryDate", 6], ["surgeryDateConfirmed", 4]],
  [["followUpTasks", 12]],
  // Origen
  [["user", 6], ["source", 6]],
  [["landingPath", 6], ["consentAt", 6]],
  [["consent", 4]],
  [["utm", 12]],
];

const LISTA = [
  "caseNumber",
  "fullName",
  "phone",
  "medical_service",
  "estado",
  "priority",
  "emergencyFlag",
  "createdAt",
];

async function configurarCase(strapi) {
  const servicio = strapi.plugin("content-manager").service("content-types");
  const contentType = strapi.contentType(UID);
  const actual = await servicio.findConfiguration(contentType);

  const metadatas = { ...actual.metadatas };
  for (const [campo, conf] of Object.entries(CAMPOS)) {
    const previo = metadatas[campo];
    if (!previo) continue;
    metadatas[campo] = {
      edit: {
        ...previo.edit,
        label: conf.label,
        description: conf.description ?? "",
        ...(conf.editable !== undefined && { editable: conf.editable }),
        ...(conf.visible !== undefined && { visible: conf.visible }),
        ...(conf.mainField && { mainField: conf.mainField }),
      },
      list: { ...previo.list, label: conf.label },
    };
  }

  await servicio.updateConfiguration(contentType, {
    settings: {
      ...actual.settings,
      mainField: "caseNumber",
      defaultSortBy: "createdAt",
      defaultSortOrder: "DESC",
      pageSize: 20,
    },
    metadatas,
    layouts: {
      list: LISTA.filter((campo) => metadatas[campo]),
      edit: FORMULARIO.map((fila) =>
        fila
          .filter(([campo]) => metadatas[campo])
          .map(([name, size]) => ({ name, size }))
      ).filter((fila) => fila.length > 0),
    },
  });
}

async function configurarTarea(strapi) {
  const servicio = strapi.plugin("content-manager").service("components");
  const componente = strapi.components[UID_TAREA];
  if (!componente) return;
  const actual = await servicio.findConfiguration(componente);
  const etiquetas = { title: "Tarea", done: "Hecha" };

  const metadatas = { ...actual.metadatas };
  for (const [campo, label] of Object.entries(etiquetas)) {
    if (!metadatas[campo]) continue;
    metadatas[campo] = {
      edit: { ...metadatas[campo].edit, label },
      list: { ...metadatas[campo].list, label },
    };
  }
  await servicio.updateConfiguration(componente, { ...actual, metadatas });
}

/** Nunca lanza: un panel sin etiquetas es feo, pero no debe impedir el arranque. */
export async function configurarPanelDeCasos(strapi) {
  try {
    const store = { type: "core", name: "lymbika", key: "case-panel-version" };
    const aplicada = await strapi.store.get(store);
    if (aplicada === VERSION_PANEL) return;

    await configurarCase(strapi);
    await configurarTarea(strapi);
    await strapi.store.set({ ...store, value: VERSION_PANEL });
    strapi.log.info(`[case.panel] vista del panel de casos aplicada (v${VERSION_PANEL})`);
  } catch (error) {
    strapi.log.error(`[case.panel] no se pudo configurar el panel de casos: ${error.message}`);
  }
}

/**
 * Los casos creados antes de existir `patientLink` no lo tienen. Se completa
 * en cada arranque; cuando ya no quedan, es una consulta vacía.
 */
export async function completarEnlacesDePaciente(strapi) {
  try {
    const pendientes = await strapi.db.query(UID).findMany({
      where: { patientLink: { $null: true }, accessToken: { $notNull: true } },
      select: ["id", "accessToken"],
    });
    for (const caso of pendientes) {
      await strapi.db.query(UID).update({
        where: { id: caso.id },
        data: { patientLink: enlacePaciente(caso.accessToken) },
      });
    }
    if (pendientes.length > 0) {
      strapi.log.info(`[case.panel] enlace de Mi caso completado en ${pendientes.length} caso(s)`);
    }
  } catch (error) {
    strapi.log.error(`[case.panel] no se pudieron completar los enlaces: ${error.message}`);
  }
}
