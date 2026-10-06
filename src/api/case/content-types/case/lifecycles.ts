import {
  enlacePaciente,
  generarToken,
  siguienteNumeroDeCaso,
} from "../../utils/identidad-caso";

/**
 * Completa la identidad de un caso creado desde el panel de Strapi, donde el
 * coordinador no ve el token ni escribe el número. El intake del paciente ya
 * los manda resueltos y aquí no se tocan.
 */
export default {
  async beforeCreate(event) {
    const data = event.params.data;
    if (!data.accessToken) data.accessToken = generarToken();
    if (!data.patientLink) data.patientLink = enlacePaciente(data.accessToken);
    if (!data.caseNumber) data.caseNumber = await siguienteNumeroDeCaso(strapi);
    if (!data.source) data.source = "coordinacion";
  },
};
