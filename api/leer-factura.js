// Función serverless (Vercel): recibe una factura (imagen o PDF en base64),
// verifica que quien llama sea un usuario activo de la app y le pide a Claude
// que extraiga los datos. La API key nunca llega al navegador.
import { createRemoteJWKSet, jwtVerify } from "jose";

const PROJECT = process.env.VITE_FB_PROJECT_ID;
const SUPERADMIN = (process.env.VITE_SUPERADMIN || "alexgoldenstein@hotmail.com").toLowerCase();
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const TIPOS_OK = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const SCHEMA = {
  type: "object",
  properties: {
    proveedor: { type: "string", description: "Razón social o nombre del emisor de la factura" },
    cuit: { type: "string", description: "CUIT / Tax ID del emisor, si figura" },
    tipo_comprobante: { type: "string", description: "Ej: Factura A, Factura B, Commercial Invoice, Proforma, Guía, Despacho" },
    numero: { type: "string", description: "Número de comprobante tal como figura (ej: 0003-00012345)" },
    fecha: { type: "string", description: "Fecha de emisión en formato YYYY-MM-DD" },
    moneda: { type: "string", enum: ["ARS", "USD", "OTRA"], description: "Moneda de los importes" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          codigo: { type: "string", description: "Código, SKU, modelo o artículo del renglón; vacío si no hay" },
          descripcion: { type: "string" },
          cantidad: { type: "number" },
          precio_unitario: { type: "number", description: "Precio unitario NETO (sin IVA) después de descuentos del renglón; si la factura no discrimina IVA (B/C o exterior), el precio tal como figura" },
          alicuota_iva: { type: "number", description: "Alícuota de IVA del renglón en % (21, 10.5, 27, 0). Si la factura tiene una sola alícuota, usá esa para todos. Si no discrimina IVA, 0" },
        },
        required: ["descripcion", "cantidad", "precio_unitario"],
      },
    },
    subtotal_neto: { type: "number", description: "Subtotal sin impuestos, si figura" },
    bonificaciones: { type: "number", description: "Bonificaciones o descuentos generales de la factura (positivo), si figuran" },
    impuestos: {
      type: "array",
      description: "Cada impuesto o percepción discriminado al pie: IVA por alícuota, percepciones de IIBB (por jurisdicción), percepción de IVA, impuestos internos, etc.",
      items: {
        type: "object",
        properties: {
          concepto: { type: "string", description: "Ej: IVA 21%, IVA 10,5%, Perc. IIBB CABA, Perc. IIBB Bs.As., Perc. IVA, Imp. internos" },
          alicuota: { type: "number", description: "Alícuota en % si figura" },
          importe: { type: "number" },
        },
        required: ["concepto", "importe"],
      },
    },
    total: { type: "number", description: "Importe total final del comprobante, con impuestos (aunque la factura lo rotule TOTAL NETO)" },
    observaciones: { type: "string", description: "Cualquier cosa ilegible, dudosa o importante (bonificaciones, flete, renglones cortados)" },
  },
  required: ["proveedor", "numero", "fecha", "moneda", "items", "total"],
};

async function usuarioActivo(idToken) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${PROJECT}`,
    audience: PROJECT,
  });
  if ((payload.email || "").toLowerCase() === SUPERADMIN) return true;
  // Lee el perfil con el propio token del usuario: las reglas le permiten leer el suyo.
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/usuarios/${payload.sub}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!r.ok) return false;
  const d = await r.json();
  return d?.fields?.activo?.booleanValue === true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });

  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  try { if (!token || !(await usuarioActivo(token))) return res.status(401).json({ error: "Usuario no habilitado." }); }
  catch { return res.status(401).json({ error: "Sesión vencida. Volvé a entrar." }); }

  const { data, mime } = req.body || {};
  if (!data || !TIPOS_OK.includes(mime)) return res.status(400).json({ error: "Mandá una foto (JPG/PNG) o un PDF." });

  const archivo = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mime, data } }
    : { type: "image", source: { type: "base64", media_type: mime, data } };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: "Sos un asistente de administración de una importadora argentina. Leés facturas de compra (locales A/B/C, commercial invoices en inglés o chino, facturas de courier y de despacho de aduana) y extraés los datos con exactitud. Copiá números y códigos tal cual figuran; no inventes renglones ni completes datos que no se ven. Los números van como números (sin separadores de miles). Si algo no se lee bien, decilo en observaciones.",
        tools: [{ name: "registrar_factura", description: "Registra los datos extraídos de la factura", input_schema: SCHEMA }],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: [archivo, { type: "text", text: "Extraé los datos de esta factura de compra, incluyendo todos los renglones de productos, y registralos llamando a la herramienta registrar_factura. Respondé solo con esa llamada." }] }],
      }),
    });
    const out = await r.json();
    if (!r.ok) {
      console.error("anthropic", r.status, out?.error);
      const msg = r.status === 400 ? "Error de configuración del lector (" + (out?.error?.message || "400") + ")." : r.status === 401 ? "La API key de Anthropic no es válida." : r.status === 429 ? "Demasiadas lecturas seguidas. Esperá un minuto." : out?.error?.message?.includes("credit") ? "No hay crédito en la cuenta de Anthropic." : "No se pudo leer la factura.";
      return res.status(502).json({ error: msg });
    }
    const tool = (out.content || []).find((c) => c.type === "tool_use");
    if (tool) return res.status(200).json({ factura: tool.input });
    // Respaldo: si respondió en texto, buscar un JSON
    const txt = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { return res.status(200).json({ factura: JSON.parse(m[0]) }); } catch {} }
    console.error("sin tool_use", out.stop_reason, txt.slice(0, 300));
    return res.status(502).json({ error: "No se pudo interpretar la factura. Probá con una foto más nítida." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al leer la factura. Probá de nuevo." });
  }
}
