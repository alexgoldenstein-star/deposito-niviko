import "./style.css";
import { auth, db, storage, secondaryAuth, SUPERADMIN, configOk } from "./firebase.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, writeBatch, arrayUnion } from "firebase/firestore";
import { ref as sref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

/* ================= constantes y utilidades ================= */
const TIPOS = {
  local: { label: "Compra local", corto: "Local", req: ["factura"], mon: "ARS" },
  courier: { label: "Courier internacional", corto: "Courier", req: ["factura", "guia", "despacho"], mon: "USD" },
  contenedor: { label: "Contenedor", corto: "Contenedor", req: ["factura_despacho", "despacho"], mon: "USD" },
};
const DOCS = { factura: "Factura", guia: "Guía / AWB", despacho: "Despacho", factura_despacho: "Factura de despacho", remito: "Remito", packing: "Packing list", foto: "Foto mercadería", otro: "Otro" };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const mesDe = (f) => (f || hoy()).slice(0, 7);
const fmtFecha = (iso) => { if (!iso) return "—"; const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso); return isNaN(d) ? iso : d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }); };
const fmtFH = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }); };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtMes = (m) => { const [y, mm] = m.split("-"); return `${MESES[+mm - 1]} ${y}`; };
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const fmtNum = (n, d = 0) => (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtCant = (n) => fmtNum(n, n % 1 ? 2 : 0);
const fmtMon = (n, mon = "ARS") => (mon === "USD" ? "US$ " : "$ ") + fmtNum(n, 2);
function parseNum(s) {
  if (typeof s === "number") return s;
  s = String(s ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
const nowISO = () => new Date().toISOString();
// Montos: total con impuestos y neto (compatibles con registros viejos que solo tenían "total" = neto)
const totF = (m) => (m ? (m.totalFactura ?? m.total ?? 0) : 0);
const netoDe = (m) => (m ? (m.neto ?? m.total ?? 0) : 0);
const CONCEPTOS = ["IVA 21%", "IVA 10,5%", "IVA 27%", "Perc. IIBB CABA", "Perc. IIBB Bs.As.", "Perc. IVA", "Imp. internos", "Flete", "Otros"];

/* ================= estado ================= */
const S = {
  user: null, perfil: null, admin: false,
  legajos: [], compras: [], montos: {}, skus: [], usuarios: [],
  loaded: { legajos: false, compras: false, skus: false, montos: false, usuarios: false },
  unsubs: [],
};
const app = $("#app");
const compraDe = (l) => S.compras.find((c) => c.id === l.id) || S.compras.find((c) => c.legajoId === l.id);

/* ================= arranque / login ================= */
if (!configOk) {
  app.innerHTML = `<div class="login"><div class="panel" style="max-width:460px"><h2>Falta configurar Firebase</h2><p class="hint">Cargá las variables <span class="mono">VITE_FB_*</span> en Vercel y volvé a desplegar.</p></div></div>`;
} else {
  onAuthStateChanged(auth, async (u) => {
    S.unsubs.forEach((f) => f()); S.unsubs = [];
    if (!u) return renderLogin();
    S.user = u;
    try {
      const pref = doc(db, "usuarios", u.uid);
      let snap = await getDoc(pref);
      const esSuper = (u.email || "").toLowerCase() === SUPERADMIN;
      if (!snap.exists() && esSuper) {
        await setDoc(pref, { nombre: "Alex", email: u.email, rol: "admin", activo: true, creadoEn: nowISO() });
        snap = await getDoc(pref);
      }
      const p = snap.exists() ? snap.data() : null;
      if (!esSuper && (!p || p.activo !== true)) return renderBloqueado();
      S.perfil = p || { nombre: u.email, rol: "admin", activo: true };
      S.admin = esSuper || S.perfil.rol === "admin";
      renderShell();
    } catch (e) {
      console.error(e);
      renderBloqueado("No se pudo leer tu perfil. Revisá que las reglas de Firestore estén publicadas.");
    }
  });
}

function renderLogin(msg = "") {
  app.innerHTML = `<div class="login"><form id="fLogin" autocomplete="on">
    <h1><span class="tag">NIVIKO</span> Depósito</h1>
    <label class="f">Email<input type="email" id="lEmail" autocomplete="username" required></label>
    <label class="f">Contraseña<input type="password" id="lPass" autocomplete="current-password" required></label>
    <div class="note err" id="lErr"${msg ? "" : " hidden"}>${esc(msg)}</div>
    <button class="btn primary" type="submit" id="lBtn" style="justify-content:center">Entrar</button>
    <button class="btn small" type="button" id="lReset" style="justify-self:start;border:0;padding:0;color:var(--muted);background:none">Olvidé mi contraseña</button>
  </form></div>`;
  $("#fLogin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("#lBtn"); b.disabled = true; $("#lErr").hidden = true;
    try { await signInWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); }
    catch (err) {
      const c = err.code || "";
      $("#lErr").textContent = c.includes("too-many") ? "Demasiados intentos. Esperá unos minutos." : c.includes("network") ? "Sin conexión. Revisá internet." : "Email o contraseña incorrectos.";
      $("#lErr").hidden = false; b.disabled = false;
    }
  });
  $("#lReset").addEventListener("click", async () => {
    const em = $("#lEmail").value.trim();
    if (!em) { $("#lErr").textContent = "Escribí tu email arriba y tocá de nuevo."; $("#lErr").hidden = false; return; }
    try { await sendPasswordResetEmail(auth, em); } catch (_) {}
    $("#lErr").textContent = "Si el email está dado de alta, te llega un correo para cambiar la clave."; $("#lErr").hidden = false;
  });
}

function renderBloqueado(msg) {
  app.innerHTML = `<div class="login"><div class="panel" style="max-width:420px"><h2>Usuario no habilitado</h2>
    <p class="hint">${esc(msg || "Tu usuario todavía no tiene acceso o fue desactivado. Pedile a un administrador que te habilite.")}</p>
    <button class="btn" id="bOut">Salir</button></div></div>`;
  $("#bOut").onclick = () => signOut(auth);
}

/* ================= shell ================= */
const TABS = [
  { id: "ingresos", label: "Ingresos" },
  { id: "skus", label: "SKUs ML" },
  { id: "resumen", label: "Resumen", admin: true },
  { id: "usuarios", label: "Usuarios", admin: true },
];
function renderShell() {
  const tabs = TABS.filter((t) => !t.admin || S.admin);
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="brand"><h1><span class="tag">NIVIKO</span> Depósito</h1>
      <div class="who"><span>${esc(S.perfil.nombre || S.user.email)}${S.admin ? ' <span class="chip lock">Admin</span>' : ""}</span><button class="btn small" id="bSalir">Salir</button></div></div>
    <nav class="tabs" aria-label="Secciones">${tabs.map((t) => `<a href="#${t.id}" data-tab="${t.id}"${t.admin ? ' class="adm"' : ""}>${t.label}<span class="count" id="cnt-${t.id}" hidden></span></a>`).join("")}</nav>
  </div></header>
  <div class="wrap"><main>
    <div class="note err" id="gNote" hidden></div>
    <section id="v-ingresos"></section>
    <section id="v-skus" hidden></section>
    ${S.admin ? `<section id="v-resumen" hidden></section><section id="v-usuarios" hidden></section>` : ""}
  </main></div>
  <datalist id="dlSkus"></datalist>
  <div class="ov" id="ov" hidden><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>`;
  $("#bSalir").onclick = () => signOut(auth);
  $("#ov").addEventListener("click", (e) => { if (e.target.id === "ov") closeSheet(); });
  initIngresos(); initSkus();
  if (S.admin) { initResumen(); initUsuarios(); }
  window.onhashchange = route; route();
  subscribeAll();
}
function route() {
  const ids = TABS.filter((t) => !t.admin || S.admin).map((t) => t.id);
  const v = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "ingresos";
  ids.forEach((id) => { $("#v-" + id).hidden = id !== v; });
  $$("nav.tabs a").forEach((a) => a.dataset.tab === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "resumen") renderResumen();
}
function setCount(id, n) { const el = $("#cnt-" + id); if (el) { el.textContent = n; el.hidden = !n; } }
function gNote(t) { const n = $("#gNote"); if (n) { n.textContent = t || ""; n.hidden = !t; } }
let sheetRender = null;
function openSheet(fn) { sheetRender = fn; fn(); $("#ov").hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet() { sheetRender = null; $("#ov").hidden = true; $("#sheet").innerHTML = ""; $("#sheet").onclick = null; document.body.style.overflow = ""; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#ov") && !$("#ov").hidden) closeSheet(); });
const firmar = () => ({ por: S.user.uid, porNombre: S.perfil.nombre || S.user.email });

function subscribeAll() {
  const sub = (key, q, fn) => {
    S.unsubs.push(onSnapshot(q, (snap) => { S.loaded[key] = true; fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); },
      (err) => { console.error(key, err); S.loaded[key] = true; gNote("No se pudieron leer algunos datos (" + key + "). Revisá que las reglas de Firebase estén publicadas."); fn(null); }));
  };
  const redraw = () => { renderIngresos(); renderResumen(); if (sheetRender) sheetRender(); };
  sub("legajos", query(collection(db, "legajos"), orderBy("creadoEn", "desc"), limit(1500)), (r) => { if (r) S.legajos = r; redraw(); });
  sub("compras", query(collection(db, "compras"), orderBy("fecha", "desc"), limit(2000)), (r) => { if (r) S.compras = r; redraw(); });
  sub("skus", query(collection(db, "skus"), orderBy("creadoEn", "desc"), limit(2000)), (r) => { if (r) S.skus = r; renderSkus(); const dl = $("#dlSkus"); if (dl) dl.innerHTML = S.skus.slice(0, 1500).map((s) => `<option value="${esc(s.sku)}">${esc(s.desc || "")}</option>`).join(""); });
  if (S.admin) {
    sub("montos", query(collection(db, "comprasMontos"), limit(3000)), (r) => { if (r) S.montos = Object.fromEntries(r.map((m) => [m.id, m])); redraw(); });
    sub("usuarios", query(collection(db, "usuarios")), (r) => { if (r) S.usuarios = r; renderUsuarios(); });
  }
}

/* ================= editor de productos (reutilizable) ================= */
// host: contenedor; getMon: () => "ARS"|"USD". Productos con precio NETO + impuestos al pie.
function itemsEditor(host, getMon) {
  const ed = { items: [], imp: [] };
  const nuevo = () => ({ sku: "", desc: "", cant: "", pu: "", iva: "21" });
  ed.set = (arr, imp) => {
    ed.items = arr && arr.length ? arr.map((x) => ({ iva: "21", ...x })) : [nuevo(), nuevo(), nuevo()];
    ed.imp = (imp || []).map((x) => ({ ...x }));
    ed.render();
  };
  ed.render = () => {
    host.innerHTML = `<div class="tablewrap"><table class="items wide"><thead><tr><th class="c-sku">SKU / código</th><th>Descripción</th><th class="c-cant num">Cant.</th><th class="c-pu num">Unit. neto</th><th class="c-iva num">IVA %</th>${S.admin ? '<th class="c-sub num">Subtotal neto</th>' : ""}<th></th></tr></thead>
      <tbody>${ed.items.map((it, i) => `<tr>
        <td><input type="text" class="mono" list="dlSkus" data-i="${i}" data-k="sku" value="${esc(it.sku)}" aria-label="SKU fila ${i + 1}"></td>
        <td><input type="text" data-i="${i}" data-k="desc" value="${esc(it.desc)}" aria-label="Descripción fila ${i + 1}"></td>
        <td><input type="text" inputmode="decimal" class="num" data-i="${i}" data-k="cant" value="${esc(it.cant)}" aria-label="Cantidad fila ${i + 1}"></td>
        <td><input type="text" inputmode="decimal" class="num" data-i="${i}" data-k="pu" value="${esc(it.pu)}" aria-label="Precio unitario neto fila ${i + 1}"></td>
        <td><input type="text" inputmode="decimal" class="num" data-i="${i}" data-k="iva" value="${esc(it.iva)}" aria-label="IVA fila ${i + 1}"></td>
        ${S.admin ? `<td class="num" data-sub="${i}">—</td>` : ""}
        <td><button type="button" class="btn small" data-rm="${i}" aria-label="Quitar fila">✕</button></td></tr>`).join("")}</tbody></table></div>
      <div class="bar" style="margin-top:8px"><button class="btn small" type="button" data-add>+ Agregar fila</button><span class="hint">Podés pegar desde Excel en la columna SKU: SKU · Descripción · Cantidad · Precio neto</span></div>
      <div class="imp">
        <div class="bar" style="justify-content:space-between"><b>Impuestos y percepciones</b><span class="bar"><button class="btn small" type="button" data-calciva>Calcular IVA</button><button class="btn small" type="button" data-addimp>+ Agregar</button></span></div>
        ${ed.imp.length ? `<div class="improws">${ed.imp.map((t, j) => `<div class="improw">
          <input type="text" list="dlConceptos" data-j="${j}" data-k="concepto" value="${esc(t.concepto)}" aria-label="Concepto">
          <input type="text" inputmode="decimal" class="num" data-j="${j}" data-k="alicuota" value="${esc(t.alicuota ?? "")}" placeholder="%" aria-label="Alícuota">
          <input type="text" inputmode="decimal" class="num" data-j="${j}" data-k="importe" value="${esc(t.importe ?? "")}" placeholder="Importe" aria-label="Importe">
          <button type="button" class="btn small" data-rmimp="${j}" aria-label="Quitar impuesto">✕</button></div>`).join("")}</div>` : `<div class="hint">Sin impuestos cargados. "Calcular IVA" los arma con la alícuota de cada producto; las percepciones se agregan a mano o vienen del escaneo.</div>`}
        <datalist id="dlConceptos">${CONCEPTOS.map((c) => `<option value="${c}">`).join("")}</datalist>
        <div class="totbox">
          <div><span>Unidades</span><b data-tot="u">0</b></div>
          ${S.admin ? `<div><span>Neto</span><b data-tot="n">0</b></div><div><span>Impuestos</span><b data-tot="i">0</b></div><div class="big"><span>Total factura</span><b data-tot="t">0</b></div>` : ""}
        </div>
        ${S.admin ? "" : '<span class="chip lock">Precios y totales solo los ve administración</span>'}
      </div>`;
    ed.totales();
  };
  ed.calc = () => {
    let u = 0, n = 0;
    ed.items.forEach((it) => { const c = parseNum(it.cant), p = parseNum(it.pu); u += c; n += c * p; });
    const i = ed.imp.reduce((a, t) => a + parseNum(t.importe), 0);
    return { u, n, i, t: n + i };
  };
  ed.totales = () => {
    ed.items.forEach((it, i) => { const c = parseNum(it.cant), p = parseNum(it.pu); const s = host.querySelector(`[data-sub="${i}"]`); if (s) s.textContent = c && p ? fmtNum(c * p, 2) : "—"; });
    const r = ed.calc(), mon = getMon(); const put = (k, v) => { const el = host.querySelector(`[data-tot="${k}"]`); if (el) el.textContent = v; };
    put("u", fmtCant(r.u)); put("n", fmtMon(r.n, mon)); put("i", fmtMon(r.i, mon)); put("t", fmtMon(r.t, mon));
  };
  ed.valid = () => ed.items.map((it) => ({ sku: String(it.sku).trim(), desc: String(it.desc).trim(), cant: parseNum(it.cant), pu: parseNum(it.pu), iva: String(it.iva).trim() === "" ? 21 : parseNum(it.iva) })).filter((it) => it.sku || it.desc);
  ed.validImp = () => ed.imp.map((t) => ({ concepto: String(t.concepto || "").trim() || "Impuesto", alicuota: String(t.alicuota ?? "").trim() === "" ? null : parseNum(t.alicuota), importe: +parseNum(t.importe).toFixed(2) })).filter((t) => t.importe);
  host.addEventListener("input", (e) => {
    const { i, j, k } = e.target.dataset;
    if (j != null) { ed.imp[j][k] = e.target.value; return ed.totales(); }
    if (i == null) return;
    ed.items[i][k] = e.target.value;
    if (k === "sku") { const s = S.skus.find((x) => x.sku.toUpperCase() === e.target.value.trim().toUpperCase()); if (s && !ed.items[i].desc) { ed.items[i].desc = s.desc || ""; const d = host.querySelector(`input[data-i="${i}"][data-k=desc]`); if (d) d.value = ed.items[i].desc; } }
    ed.totales();
  });
  host.addEventListener("click", (e) => {
    if (e.target.closest("[data-add]")) { ed.items.push(nuevo()); ed.render(); [...host.querySelectorAll("input[data-k=sku]")].pop()?.focus(); return; }
    if (e.target.closest("[data-addimp]")) { ed.imp.push({ concepto: "", alicuota: "", importe: "" }); ed.render(); return; }
    if (e.target.closest("[data-calciva]")) {
      // reemplaza las líneas de IVA por las calculadas según la alícuota de cada producto
      const porAlic = {};
      ed.items.forEach((it) => { const a = String(it.iva).trim() === "" ? 21 : parseNum(it.iva); if (!a) return; porAlic[a] = (porAlic[a] || 0) + parseNum(it.cant) * parseNum(it.pu) * a / 100; });
      ed.imp = ed.imp.filter((t) => !/^iva\b/i.test(String(t.concepto).trim()));
      Object.entries(porAlic).sort((a, b) => b[0] - a[0]).forEach(([a, v]) => ed.imp.unshift({ concepto: `IVA ${String(a).replace(".", ",")}%`, alicuota: a, importe: fmtNum(v, 2) }));
      ed.render(); return;
    }
    const j = e.target.dataset.rmimp; if (j != null) { ed.imp.splice(+j, 1); ed.render(); return; }
    const i = e.target.dataset.rm; if (i != null) { ed.items.splice(+i, 1); if (!ed.items.length) ed.items.push(nuevo()); ed.render(); }
  });
  host.addEventListener("paste", (e) => {
    const t = e.target; if (t.dataset.k !== "sku") return;
    const txt = (e.clipboardData || window.clipboardData).getData("text");
    if (!/[\t\n]/.test(txt.trim())) return;
    e.preventDefault();
    let i = +t.dataset.i;
    for (const line of txt.replace(/\r/g, "").split("\n").filter((l) => l.trim())) {
      const c = line.split("\t");
      ed.items[i] = { sku: (c[0] || "").trim(), desc: (c[1] || "").trim(), cant: (c[2] || "").trim(), pu: (c[3] || "").trim(), iva: (c[4] || "21").trim() };
      i++;
    }
    ed.render();
  });
  ed.set([]);
  return ed;
}

/* ================= lectura de facturas con Claude ================= */
async function achicarImagen(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 2200 / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}
const aBase64 = (blob) => new Promise((ok, mal) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1]); fr.onerror = mal; fr.readAsDataURL(blob); });
// Devuelve {fa, blob, mime, nombre} o lanza Error con mensaje para el usuario
async function leerFactura(file, progreso) {
  const mime0 = mimeOf(file);
  if (!mime0) throw new Error("Formato no admitido. Usá una foto JPG/PNG o un PDF.");
  let blob = file, mime = mime0;
  if (mime0.startsWith("image/")) { progreso("Preparando la foto…"); blob = await achicarImagen(file); mime = "image/jpeg"; }
  else if (file.size > 3.2 * 1048576) throw new Error("El PDF pesa más de 3 MB. Sacale una foto a la factura o mandá un PDF más liviano.");
  progreso("Leyendo la factura… puede tardar unos 20 segundos.");
  const token = await auth.currentUser.getIdToken();
  const r = await fetch("/api/leer-factura", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ mime, data: await aBase64(blob) }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || (r.status === 504 ? "La lectura tardó demasiado. Probá de nuevo." : "No se pudo leer la factura."));
  const nombre = (file.name || "factura").replace(/\.[^.]+$/, "") + (mime === "application/pdf" ? ".pdf" : ".jpg");
  return { fa: out.factura || {}, blob, mime, nombre };
}
// Convierte lo leído en filas del editor e impuestos, y arma el mensaje de control
function itemsDeFactura(fa, mon) {
  const skuSet = new Map(S.skus.map((x) => [x.sku.toUpperCase(), x]));
  const items = (fa.items || []).map((it) => {
    const cod = String(it.codigo || "").trim(); const known = skuSet.get(cod.toUpperCase());
    return { sku: known ? known.sku : cod, desc: it.descripcion || known?.desc || "", cant: it.cantidad ? fmtCant(it.cantidad) : "", pu: it.precio_unitario ? fmtNum(it.precio_unitario, 2) : "", iva: it.alicuota_iva != null ? String(it.alicuota_iva).replace(".", ",") : "21" };
  });
  const imp = (Array.isArray(fa.impuestos) ? fa.impuestos : []).filter((t) => t && t.importe).map((t) => ({ concepto: t.concepto || "Impuesto", alicuota: t.alicuota != null ? String(t.alicuota).replace(".", ",") : "", importe: fmtNum(t.importe, 2) }));
  const neto = (fa.items || []).reduce((a, it) => a + (it.cantidad || 0) * (it.precio_unitario || 0), 0) - (fa.bonificaciones || 0);
  const impT = (Array.isArray(fa.impuestos) ? fa.impuestos : []).reduce((a, t) => a + (t?.importe || 0), 0);
  const cerca = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.01);
  const okNeto = !fa.subtotal_neto || cerca(neto, fa.subtotal_neto);
  const okTot = !fa.total || cerca(neto + impT, fa.total);
  const avisos = [];
  if (!okNeto) avisos.push(S.admin ? `La suma de los renglones (${fmtMon(neto, mon)}) no coincide con el subtotal neto de la factura (${fmtMon(fa.subtotal_neto, mon)}).` : "La suma de los renglones no coincide con el subtotal de la factura.");
  if (okNeto && !okTot) avisos.push(S.admin ? `Neto + impuestos (${fmtMon(neto + impT, mon)}) no da el total de la factura (${fmtMon(fa.total, mon)}): revisá los impuestos.` : "Neto más impuestos no da el total de la factura: revisá los impuestos.");
  if (fa.bonificaciones) avisos.push(`La factura tiene bonificación general de ${fmtMon(fa.bonificaciones, mon)}: cargala como renglón negativo o ajustá los precios.`);
  if (fa.moneda === "OTRA") avisos.push("La factura está en otra moneda: elegí la moneda correcta.");
  if (fa.observaciones) avisos.push("Nota: " + fa.observaciones);
  const nuevos = items.filter((i) => i.sku && !skuSet.has(i.sku.toUpperCase())).length;
  const msg = `Leí ${items.length} renglón${items.length === 1 ? "" : "es"} y ${imp.length} impuesto${imp.length === 1 ? "" : "s"}${nuevos ? ` (${nuevos} código${nuevos === 1 ? "" : "s"} que no están en la lista de SKUs)` : ""}. ${okNeto && okTot ? "Los totales cierran con la factura. " : ""}Revisá y guardá. ${avisos.join(" ")}`;
  return { items, imp, msg, alerta: !okNeto || !okTot || fa.moneda === "OTRA" };
}
const scanBox = (id) => `<div class="scan">
  <div style="display:grid;gap:2px;min-width:0"><b>Escanear factura</b><span class="hint">Foto o PDF de la factura: completa proveedor, número, fecha y productos. Después revisás y guardás.</span></div>
  <label class="btn primary" for="${id}">📷 Escanear</label>
  <input type="file" id="${id}" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></div>`;

/* ================= INGRESOS (documentación + compra en uno) ================= */
let staged = [], edForm = null;
function initIngresos() {
  $("#v-ingresos").innerHTML = `<div class="list">
    <div class="bar">
      <button class="btn primary" id="bNuevo" type="button">+ Nuevo ingreso</button>
      <input class="grow" type="search" id="qL" placeholder="Buscar proveedor, factura, guía, despacho o SKU…" aria-label="Buscar ingresos">
      <select id="fEstado" style="width:auto" aria-label="Estado"><option value="pendiente">Pendientes</option><option value="recibido">Recibidos</option><option value="">Todos</option></select>
      <select id="fTipo" style="width:auto" aria-label="Tipo"><option value="">Todos los tipos</option><option value="local">Compra local</option><option value="courier">Courier</option><option value="contenedor">Contenedor</option></select>
      <input type="month" id="fMes" style="width:auto" aria-label="Mes" title="Filtrar por mes (vacío = todos)">
    </div>
    <form class="panel" id="formL" hidden autocomplete="off">
      <h2>Nuevo ingreso</h2>
      ${scanBox("scanNuevo")}
      <div class="note" id="scanMsg" hidden></div>
      <div class="tipos" role="radiogroup" aria-label="Tipo de ingreso">
        <label class="tipo"><input type="radio" name="tipo" value="local" checked><b>Compra local</b><span>Factura de proveedor + remito</span></label>
        <label class="tipo"><input type="radio" name="tipo" value="courier"><b>Courier internacional</b><span>Factura, guía y despacho</span></label>
        <label class="tipo"><input type="radio" name="tipo" value="contenedor"><b>Contenedor</b><span>Factura de despacho + despacho</span></label>
      </div>
      <div class="grid2">
        <label class="f">Proveedor / origen<input type="text" id="inProv" placeholder="Ej: Centro Estant S.A."></label>
        <label class="f">N° de factura<input type="text" id="inFact" class="mono" placeholder="Ej: A 0012-00008441"></label>
        <label class="f">Fecha<input type="date" id="inFecha"></label>
        <label class="f">Moneda<select id="inMon"><option value="ARS">Pesos (ARS)</option><option value="USD">Dólares (USD)</option></select></label>
        <label class="f" data-show="courier">Empresa courier<input type="text" id="inCourier" placeholder="DHL, FedEx, UPS…"></label>
        <label class="f" data-show="courier">N° de guía (AWB)<input type="text" id="inGuia" class="mono" placeholder="Ej: 123-45678901"></label>
        <label class="f" data-show="courier contenedor">N° de despacho<input type="text" id="inDesp" class="mono" placeholder="Ej: 26001IC04012345K"></label>
        <label class="f" data-show="contenedor">N° de contenedor<input type="text" id="inCont" class="mono" placeholder="Ej: MSCU1234567"></label>
        <label class="f" data-show="contenedor">Despachante<input type="text" id="inDespachante"></label>
      </div>
      <div style="display:grid;gap:6px"><div class="f">Productos <span class="hint">Opcional: si no los tenés ahora, se cargan después desde el ingreso.</span></div><div id="edNuevo"></div></div>
      <div style="display:grid;gap:8px">
        <div class="f" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">Documentos <span class="req" id="reqChips"></span></div>
        <div class="drop" id="drop"><div>Arrastrá archivos acá o</div>
          <label class="btn" for="inFiles">Elegir / sacar foto</label>
          <input type="file" id="inFiles" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden>
          <div class="hint">PDF, JPG, PNG o WEBP · hasta 20 MB cada uno</div></div>
        <div class="staged" id="staged"></div>
      </div>
      <label class="f">Observaciones<textarea id="inNotas" rows="2" placeholder="Bultos, faltantes, mercadería dañada…"></textarea></label>
      <div class="note err" id="formLErr" hidden></div>
      <div class="bar"><button class="btn primary" type="submit" id="bGuardarL">Guardar ingreso</button><button class="btn" type="button" id="bCancL">Cancelar</button><span class="hint" id="progL"></span></div>
    </form>
    <div id="mesStats"></div>
    <div id="listL" class="list"></div>
  </div>`;
  const f = $("#formL");
  edForm = itemsEditor($("#edNuevo"), () => $("#inMon").value);
  $("#inMon").addEventListener("change", () => edForm.totales());
  $$("input[name=tipo]", f).forEach((r) => r.addEventListener("change", () => { syncTipo(); $("#inMon").value = TIPOS[tipoSel()].mon; edForm.totales(); }));
  $("#bNuevo").onclick = () => { resetFormL(); f.hidden = false; $("#bNuevo").hidden = true; f.scrollIntoView({ block: "start" }); };
  $("#bCancL").onclick = () => { resetFormL(); f.hidden = true; $("#bNuevo").hidden = false; };
  $("#inFiles").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles([...(e.dataTransfer.files || [])]));
  $("#staged").addEventListener("change", (e) => { const i = e.target.dataset.i; if (i != null) { staged[i].tipoDoc = e.target.value; renderReq(); } });
  $("#staged").addEventListener("click", (e) => { const i = e.target.dataset.rm; if (i != null) { const s = staged.splice(+i, 1)[0]; if (s?.url) URL.revokeObjectURL(s.url); renderStaged(); } });
  $("#scanNuevo").onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    const lbl = $('label[for="scanNuevo"]'); lbl.classList.add("busy");
    try {
      const r = await leerFactura(file, (t) => scanMsg(t));
      const fa = r.fa;
      if (fa.proveedor) $("#inProv").value = fa.proveedor;
      if (fa.numero) $("#inFact").value = [String(fa.tipo_comprobante || "").replace(/^Factura\s*/i, ""), fa.numero].filter(Boolean).join(" ");
      if (/^\d{4}-\d{2}-\d{2}$/.test(fa.fecha || "")) $("#inFecha").value = fa.fecha;
      if (fa.moneda === "USD" || fa.moneda === "ARS") $("#inMon").value = fa.moneda;
      const x = itemsDeFactura(fa, $("#inMon").value);
      edForm.set(x.items, x.imp);
      // la factura escaneada queda como documento del ingreso
      staged = staged.filter((s) => !s.escaneada);
      staged.unshift({ file: new File([r.blob], r.nombre, { type: r.mime }), mime: r.mime, tipoDoc: tipoSel() === "contenedor" ? "factura_despacho" : "factura", url: r.mime.startsWith("image/") ? URL.createObjectURL(r.blob) : null, escaneada: true });
      renderStaged();
      scanMsg(x.msg, x.alerta ? "err" : "");
    } catch (err) { console.error(err); scanMsg(err.message || "No se pudo leer la factura.", "err"); }
    finally { lbl.classList.remove("busy"); }
  };
  f.addEventListener("submit", guardarIngreso);
  ["input", "change"].forEach((ev) => ["#qL", "#fEstado", "#fTipo", "#fMes"].forEach((s) => $(s).addEventListener(ev, renderIngresos)));
  $("#listL").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openIngreso(b.dataset.open); });
  resetFormL(); renderIngresos();
}
function scanMsg(t, tipo = "") { const n = $("#scanMsg"); n.textContent = t || ""; n.className = "note" + (tipo ? " " + tipo : ""); n.hidden = !t; }
const tipoSel = () => $("input[name=tipo]:checked").value;
function syncTipo() { const t = tipoSel(); $$("#formL [data-show]").forEach((el) => { el.hidden = !el.dataset.show.split(" ").includes(t); }); renderReq(); }
function renderReq() {
  const have = new Set(staged.map((s) => s.tipoDoc));
  $("#reqChips").innerHTML = TIPOS[tipoSel()].req.map((k) => `<span class="chip ${have.has(k) ? "ok" : "warn"}">${have.has(k) ? "✓" : "Falta"} ${esc(DOCS[k])}</span>`).join("");
}
function guessTipoDoc() { const t = tipoSel(); const have = new Set(staged.map((s) => s.tipoDoc)); return TIPOS[t].req.find((k) => !have.has(k)) || (t === "local" ? "remito" : "otro"); }
function mimeOf(f) {
  if (["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type)) return f.type;
  const ext = (String(f.name || "").split(".").pop() || "").toLowerCase();
  return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || null;
}
function addFiles(list) {
  const errs = [];
  for (const f of list) {
    const m = mimeOf(f);
    if (!m) { errs.push(`${f.name}: formato no admitido (usá PDF, JPG o PNG${/heic|heif/i.test(f.name) ? "; en iPhone: Ajustes › Cámara › Formatos › Más compatible" : ""}).`); continue; }
    if (f.size > 20 * 1048576) { errs.push(`${f.name}: pesa más de 20 MB.`); continue; }
    staged.push({ file: f, mime: m, tipoDoc: guessTipoDoc(), url: m.startsWith("image/") ? URL.createObjectURL(f) : null });
  }
  errL(errs.join(" ")); renderStaged();
}
const docOptions = (sel) => Object.entries(DOCS).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
const ficon = (mime, url, lg) => `<span class="ficon${lg ? " lg" : ""}">${url ? `<img src="${esc(url)}" alt="">` : mime === "application/pdf" ? "PDF" : "IMG"}</span>`;
function renderStaged() {
  $("#staged").innerHTML = staged.map((s, i) => `<div class="srow">${ficon(s.mime, s.url)}<span class="nm" title="${esc(s.file.name)}">${s.escaneada ? "📷 " : ""}${esc(s.file.name)} <small class="hint">· ${kb(s.file.size)}</small></span><select data-i="${i}" aria-label="Tipo de documento">${docOptions(s.tipoDoc)}</select><button type="button" class="btn small" data-rm="${i}" aria-label="Quitar">✕</button></div>`).join("");
  renderReq();
}
function errL(t) { $("#formLErr").textContent = t || ""; $("#formLErr").hidden = !t; }
function resetFormL() {
  $("#formL").reset(); $("input[name=tipo][value=local]").checked = true; $("#inFecha").value = hoy(); $("#inMon").value = "ARS";
  staged.forEach((s) => s.url && URL.revokeObjectURL(s.url)); staged = []; renderStaged(); syncTipo(); errL(""); scanMsg(""); $("#progL").textContent = "";
  edForm?.set([]);
}
const safeName = (n) => String(n).normalize("NFD").replace(/[^\w.\-]+/g, "_").slice(-80);
async function subirArchivo(legajoId, file, mime, tipoDoc) {
  const nombre = file.name || `factura.${mime === "application/pdf" ? "pdf" : "jpg"}`;
  const path = `legajos/${legajoId}/${Date.now()}-${safeName(nombre)}`;
  const r = await uploadBytes(sref(storage, path), file, { contentType: mime });
  return { path, nombre, tipoDoc, mime, size: r.metadata.size || file.size, ...firmar(), en: nowISO() };
}
// Crea compras/{id} + comprasMontos/{id}. items: [{sku,desc,cant,pu,iva}], impuestos: [{concepto,alicuota,importe}]
function batchCompra(bt, id, { fecha, proveedor, factura, moneda, items, impuestos = [] }, existente) {
  const f = firmar();
  const unidades = items.reduce((a, it) => a + it.cant, 0);
  const montos = items.map((it) => ({ pu: it.pu, iva: it.iva ?? 21, subtotal: +(it.cant * it.pu).toFixed(2) }));
  const neto = +montos.reduce((a, x) => a + x.subtotal, 0).toFixed(2);
  const impTotal = +impuestos.reduce((a, t) => a + t.importe, 0).toFixed(2);
  bt.set(doc(db, "compras", id), {
    fecha, mes: mesDe(fecha), proveedor, factura, moneda, legajoId: id,
    items: items.map(({ sku, desc, cant }) => ({ sku, desc, cant })), unidades,
    creadoPor: existente?.creadoPor || f.por, creadoPorNombre: existente?.creadoPorNombre || f.porNombre, creadoEn: existente?.creadoEn || nowISO(),
    ...(existente ? { editadoPorNombre: f.porNombre, editadoEn: nowISO() } : {}),
  });
  bt.set(doc(db, "comprasMontos", id), {
    mes: mesDe(fecha), moneda, items: montos, neto, total: neto, impuestos, impTotal, totalFactura: +(neto + impTotal).toFixed(2),
    sinPrecio: items.filter((it) => !it.pu).length, creadoEn: nowISO(),
  });
}
async function guardarIngreso(e) {
  e.preventDefault();
  const t = tipoSel(); const prov = $("#inProv").value.trim(), fact = $("#inFact").value.trim();
  if (!prov && !fact) return errL("Completá al menos el proveedor o el número de factura.");
  const items = edForm.valid();
  const sinCant = items.filter((it) => !it.cant); if (sinCant.length) return errL(`Falta la cantidad en ${sinCant.length} producto${sinCant.length > 1 ? "s" : ""}.`);
  errL(""); const b = $("#bGuardarL"); b.disabled = true;
  const id = doc(collection(db, "legajos")).id; const archivos = [];
  try {
    for (let i = 0; i < staged.length; i++) {
      $("#progL").textContent = `Subiendo ${i + 1} de ${staged.length}…`;
      const s = staged[i];
      try { archivos.push(await subirArchivo(id, s.file, s.mime, s.tipoDoc)); }
      catch (err) { console.error(err); throw new Error(`No se pudo subir ${s.file.name}. Revisá la conexión y probá de nuevo.`); }
    }
    $("#progL").textContent = "Guardando…";
    const f = firmar(); const fecha = $("#inFecha").value || hoy(); const moneda = $("#inMon").value;
    const bt = writeBatch(db);
    bt.set(doc(db, "legajos", id), {
      tipo: t, proveedor: prov, factura: fact, fecha, moneda,
      courier: t === "courier" ? $("#inCourier").value.trim() : "", guia: t === "courier" ? $("#inGuia").value.trim() : "",
      despacho: t !== "local" ? $("#inDesp").value.trim() : "", contenedor: t === "contenedor" ? $("#inCont").value.trim() : "",
      despachante: t === "contenedor" ? $("#inDespachante").value.trim() : "", notas: $("#inNotas").value.trim(), notasOficina: "",
      estado: "pendiente", archivos, creadoPor: f.por, creadoPorNombre: f.porNombre, creadoEn: nowISO(), recibidoPor: null, recibidoPorNombre: null, recibidoEn: null,
    });
    if (items.length) batchCompra(bt, id, { fecha, proveedor: prov, factura: fact, moneda, items, impuestos: edForm.validImp() });
    await bt.commit();
    resetFormL(); $("#formL").hidden = true; $("#bNuevo").hidden = false; $("#fEstado").value = "pendiente"; renderIngresos();
  } catch (err) { console.error(err); errL(err.message && !err.code ? err.message : "No se pudo guardar. Probá de nuevo."); $("#progL").textContent = ""; }
  finally { b.disabled = false; }
}
const faltan = (l) => { const have = new Set((l.archivos || []).map((a) => a.tipoDoc)); return (TIPOS[l.tipo] || TIPOS.local).req.filter((k) => !have.has(k)); };
function renderIngresos() {
  const el = $("#listL"); if (!el) return;
  const q = $("#qL").value.trim().toLowerCase(), fe = $("#fEstado").value, ft = $("#fTipo").value, fm = $("#fMes").value;
  setCount("ingresos", S.legajos.filter((l) => l.estado !== "recibido").length);
  // franja del mes
  const mes = fm || mesDe(hoy()); const delMes = S.legajos.filter((l) => mesDe(l.fecha) === mes);
  let unid = 0; const tot = {};
  delMes.forEach((l) => { const c = compraDe(l); if (c) { unid += c.unidades || 0; const m = S.admin && S.montos[c.id]; if (m) tot[m.moneda] = (tot[m.moneda] || 0) + totF(m); } });
  $("#mesStats").innerHTML = S.loaded.legajos && delMes.length ? `<div class="stats"><div class="stat"><b>${delMes.length}</b><span>Ingresos ${fmtMes(mes)}</span></div><div class="stat"><b>${fmtNum(unid)}</b><span>Unidades</span></div>${S.admin ? Object.entries(tot).map(([mon, v]) => `<div class="stat"><b>${fmtMon(v, mon)}</b><span>Facturado ${mon} c/imp. · 🔒</span></div>`).join("") : ""}</div>` : "";
  if (!S.loaded.legajos) { el.innerHTML = `<div class="empty"><b>Cargando ingresos…</b></div>`; return; }
  if (!S.legajos.length) { el.innerHTML = `<div class="empty"><b>Todavía no hay ingresos</b><span>Tocá <b>+ Nuevo ingreso</b> y escaneá la factura: se completan los datos y los productos, y la factura queda guardada.</span></div>`; return; }
  const rows = S.legajos.filter((l) => {
    if (fe && l.estado !== fe) return false; if (ft && l.tipo !== ft) return false; if (fm && mesDe(l.fecha) !== fm) return false;
    if (!q) return true; const c = compraDe(l);
    return [l.proveedor, l.factura, l.guia, l.despacho, l.contenedor, l.courier, l.despachante, l.notas, ...(c?.items || []).map((i) => i.sku + " " + i.desc)].join(" ").toLowerCase().includes(q);
  });
  if (!rows.length) { el.innerHTML = `<div class="empty"><b>Nada con ese filtro</b><span>Probá con "Todos", otro mes o borrá la búsqueda.</span></div>`; return; }
  el.innerHTML = rows.map((l) => {
    const f = faltan(l), T = TIPOS[l.tipo] || TIPOS.local, rec = l.estado === "recibido", n = (l.archivos || []).length;
    const c = compraDe(l); const m = c && S.admin ? S.montos[c.id] : null;
    const ident = [l.factura && `Fact. <span class="mono">${esc(l.factura)}</span>`, l.guia && `Guía <span class="mono">${esc(l.guia)}</span>`, l.despacho && `Desp. <span class="mono">${esc(l.despacho)}</span>`, l.contenedor && `Cont. <span class="mono">${esc(l.contenedor)}</span>`].filter(Boolean).join(" · ");
    return `<button type="button" class="card${rec ? " recibido" : ""}" data-open="${esc(l.id)}">
      <div class="row1"><span style="display:flex;gap:8px;align-items:center;min-width:0;flex-wrap:wrap"><span class="chip type">${esc(T.corto)}</span><span class="ttl">${esc(l.proveedor || "Sin proveedor")}</span></span>
      <span style="display:flex;gap:8px;align-items:center">${m ? `<span class="mono" style="font-weight:600" title="Neto ${fmtMon(netoDe(m), m.moneda)}">${fmtMon(totF(m), m.moneda)}</span>` : ""}<span class="chip ${rec ? "ok" : "warn"}">${rec ? "Recibido" : "Pendiente oficina"}</span></span></div>
      ${ident ? `<div class="meta">${ident}</div>` : ""}
      <div class="meta"><span>${fmtFecha(l.fecha)}</span><span>${n} archivo${n === 1 ? "" : "s"}</span>
      ${c ? `<span>${(c.items || []).length} producto${(c.items || []).length === 1 ? "" : "s"} · ${fmtNum(c.unidades)} u.</span>` : `<span class="chip warn">Sin productos</span>`}
      <span>Cargó ${esc(l.creadoPorNombre || "—")}</span>
      ${f.length ? `<span class="chip warn">Falta: ${f.map((k) => esc(DOCS[k])).join(", ")}</span>` : `<span class="chip ok">Docs completos</span>`}
      ${m && m.sinPrecio ? `<span class="chip warn">${m.sinPrecio} sin precio</span>` : ""}</div></button>`;
  }).join("");
}
function openIngreso(id) {
  const st = { confirmDel: false, confirmFile: null, msg: "", edit: false, ed: null, scanMsg: "" };
  const urls = {};
  const draw = () => {
    const l = S.legajos.find((x) => x.id === id); const sh = $("#sheet");
    if (!l) { sh.innerHTML = `<div class="hd"><h2>Ingreso eliminado</h2><button class="btn small" data-act="close">Cerrar</button></div>`; return; }
    if (st.edit) return; // mientras se editan productos no se redibuja (no perder lo tipeado)
    const T = TIPOS[l.tipo] || TIPOS.local, rec = l.estado === "recibido", f = faltan(l);
    const c = compraDe(l); const m = c && S.admin ? S.montos[c.id] : null; const mon = c?.moneda || l.moneda || T.mon;
    const kv = [["Tipo", T.label], ["Proveedor", l.proveedor], ["N° factura", l.factura, 1], ["Fecha", fmtFecha(l.fecha)], ["Courier", l.courier], ["Guía / AWB", l.guia, 1], ["Despacho", l.despacho, 1], ["Contenedor", l.contenedor, 1], ["Despachante", l.despachante], ["Cargado por", `${l.creadoPorNombre || "—"} · ${fmtFH(l.creadoEn)}`]]
      .filter((r) => r[1]).map((r) => `<div><dt>${r[0]}</dt><dd${r[2] ? ' class="mono"' : ""}>${esc(r[1])}</dd></div>`).join("");
    const files = (l.archivos || []).map((a, i) => {
      const img = (a.mime || "").startsWith("image/");
      return `<div class="frow">${ficon(a.mime, img && urls[a.path] && urls[a.path] !== "pending" ? urls[a.path] : null, true)}
        <span class="txt"><a data-act="ver" data-i="${i}">${esc(DOCS[a.tipoDoc] || a.tipoDoc)}</a><small>${esc(a.nombre)} · ${kb(a.size || 0)}</small></span>
        ${S.admin ? (st.confirmFile === i ? `<button class="btn small danger" data-act="rmfile-ok" data-i="${i}">Quitar</button><button class="btn small" data-act="rmfile-no">No</button>` : `<button class="btn small" data-act="rmfile" data-i="${i}" aria-label="Quitar archivo">✕</button>`) : ""}</div>`;
    }).join("") || `<div class="hint">Sin archivos todavía.</div>`;
    const prodRows = (c?.items || []).map((it, i) => { const p = m?.items?.[i]; const iva = p?.iva ?? 21; return `<tr><td class="sku">${esc(it.sku)}</td><td>${esc(it.desc)}</td><td class="num">${fmtCant(it.cant)}</td>${S.admin ? `<td class="num">${p ? fmtNum(p.pu, 2) : "—"}</td><td class="num">${p ? fmtNum(p.pu * (1 + iva / 100), 2) : "—"}</td><td class="num">${p ? fmtNum(p.subtotal, 2) : "—"}</td>` : ""}</tr>`; }).join("");
    const pie = m ? [["Subtotal neto", netoDe(m)], ...(m.impuestos || []).map((t) => [t.concepto + (t.alicuota != null && !/%/.test(t.concepto) ? ` ${String(t.alicuota).replace(".", ",")}%` : ""), t.importe])].map(([k, v]) => `<tr><td colspan="5" class="num" style="font-weight:500">${esc(k)}</td><td class="num">${fmtNum(v, 2)}</td></tr>`).join("") + `<tr class="grand"><td colspan="5" class="num">Total factura</td><td class="num">${fmtMon(totF(m), m.moneda)}</td></tr>` : "";
    sh.innerHTML = `
      <div class="hd"><div style="display:grid;gap:6px;min-width:0"><span style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip type">${esc(T.corto)}</span><span class="chip type">${esc(mon)}</span><span class="chip ${rec ? "ok" : "warn"}">${rec ? "Recibido en oficina" : "Pendiente oficina"}</span></span><h2>${esc(l.proveedor || "Sin proveedor")}</h2></div>
      <button class="btn small" data-act="close">Cerrar</button></div>
      ${rec ? `<div class="note">Recibido por ${esc(l.recibidoPorNombre || "—")} · ${fmtFH(l.recibidoEn)}</div>` : ""}
      <dl class="kv">${kv}</dl>
      ${l.notas ? `<div><div class="hint" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Observaciones</div><div style="white-space:pre-wrap">${esc(l.notas)}</div></div>` : ""}
      <div class="sep"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>Productos</b>
        ${c ? (S.admin ? `<button class="btn small" data-act="editprod">Editar productos y precios</button>` : "") : `<button class="btn small primary" data-act="editprod">+ Cargar productos</button>`}</div>
      ${c ? `<div class="tablewrap"><table class="${S.admin ? "wide" : ""}"><thead><tr><th>SKU</th><th>Descripción</th><th class="num">Cant.</th>${S.admin ? '<th class="num">Unit. neto</th><th class="num">Unit. c/IVA</th><th class="num">Subtotal neto</th>' : ""}</tr></thead><tbody>${prodRows}</tbody>
        <tfoot><tr><td colspan="2">Unidades</td><td class="num">${fmtNum(c.unidades)}</td>${S.admin ? `<td colspan="3"></td>` : ""}</tr>${S.admin ? pie : ""}</tfoot></table></div>
        ${S.admin && m && !(m.impuestos || []).length ? `<div class="note err">Este ingreso no tiene impuestos cargados: el total es solo neto. Tocá "Editar productos y precios" › "Calcular IVA".</div>` : ""}
        ${S.admin && !m ? `<div class="note err">Este ingreso no tiene precios registrados.</div>` : ""}${!S.admin ? `<div class="note lock">Los precios de este ingreso solo los ve administración.</div>` : ""}`
        : `<div class="hint">Todavía no se cargaron los productos de este ingreso.</div>`}
      <div class="sep"></div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center"><b>Documentos</b>${f.length ? `<span class="chip warn">Falta: ${f.map((k) => esc(DOCS[k])).join(", ")}</span>` : `<span class="chip ok">Completo</span>`}</div>
      <div class="files">${files}</div>
      <div class="bar"><select id="addTipo" style="width:auto" aria-label="Tipo del documento a agregar">${docOptions(f[0] || "otro")}</select><label class="btn" for="addFile">+ Agregar archivos</label><input type="file" id="addFile" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden></div>
      ${st.msg ? `<div class="note${st.msg.startsWith("!") ? " err" : ""}">${esc(st.msg.replace(/^!/, ""))}</div>` : ""}
      <div class="sep"></div>
      <label class="f">Notas de oficina<textarea id="notasOf" placeholder="Ej: Ingresado en el sistema, falta NC del proveedor…">${esc(l.notasOficina || "")}</textarea></label>
      <div class="bar">
        <button class="btn primary" data-act="estado">${rec ? "Volver a pendiente" : "✓ Marcar recibido en oficina"}</button>
        <button class="btn" data-act="notas">Guardar notas</button>
        ${S.admin ? (st.confirmDel ? `<span class="confirm">¿Eliminar ingreso, productos y archivos? <button class="btn small danger" data-act="del-ok">Eliminar</button><button class="btn small" data-act="del-no">Cancelar</button></span>` : `<button class="btn small danger" data-act="del" style="margin-left:auto">Eliminar</button>`) : ""}
      </div>`;
    (l.archivos || []).forEach((a) => {
      if ((a.mime || "").startsWith("image/") && !urls[a.path]) {
        urls[a.path] = "pending";
        getDownloadURL(sref(storage, a.path)).then((u) => { urls[a.path] = u; if (sheetRender === draw) draw(); }).catch(() => {});
      }
    });
    $("#addFile").onchange = async (e) => {
      const list = [...e.target.files]; e.target.value = ""; const tipoDoc = $("#addTipo").value; const nuevos = [];
      for (const fl of list) {
        const mm = mimeOf(fl); if (!mm) { st.msg = `!${fl.name}: formato no admitido.`; continue; }
        if (fl.size > 20 * 1048576) { st.msg = `!${fl.name}: pesa más de 20 MB.`; continue; }
        st.msg = `Subiendo ${fl.name}…`; draw();
        try { nuevos.push(await subirArchivo(l.id, fl, mm, tipoDoc)); } catch (err) { st.msg = `!No se pudo subir ${fl.name}.`; }
      }
      if (nuevos.length) {
        try { await updateDoc(doc(db, "legajos", l.id), { archivos: arrayUnion(...nuevos) }); if (!st.msg.startsWith("!")) st.msg = `${nuevos.length} archivo${nuevos.length > 1 ? "s" : ""} agregado${nuevos.length > 1 ? "s" : ""}.`; }
        catch (err) { st.msg = "!No se pudo guardar el archivo en el ingreso."; }
      }
      draw();
    };
  };
  // modo edición de productos dentro del ingreso
  const drawEdit = () => {
    const l = S.legajos.find((x) => x.id === id); const c = compraDe(l); const m = c && S.admin ? S.montos[c.id] : null;
    const sh = $("#sheet");
    sh.innerHTML = `<div class="hd"><div style="min-width:0"><span class="chip type">${esc((TIPOS[l.tipo] || TIPOS.local).corto)}</span><h2>${c ? "Editar productos" : "Cargar productos"} · ${esc(l.proveedor || "")}</h2></div><button class="btn small" data-act="canceledit">Cancelar</button></div>
      ${c ? "" : scanBox("scanDet")}
      <div class="note" id="scanMsgDet"${st.scanMsg ? "" : " hidden"}></div>
      <label class="f" style="max-width:240px">Moneda<select id="edMon"><option value="ARS">Pesos (ARS)</option><option value="USD">Dólares (USD)</option></select></label>
      <div id="edDet"></div>
      <div class="note err" id="edErr" hidden></div>
      <div class="bar"><button class="btn primary" data-act="saveprod">Guardar productos</button><button class="btn" data-act="canceledit">Cancelar</button></div>`;
    $("#edMon").value = c?.moneda || l.moneda || (TIPOS[l.tipo] || TIPOS.local).mon;
    st.ed = itemsEditor($("#edDet"), () => $("#edMon").value);
    $("#edMon").onchange = () => st.ed.totales();
    st.ed.set(c ? c.items.map((it, i) => ({ sku: it.sku, desc: it.desc, cant: fmtCant(it.cant), pu: m?.items?.[i]?.pu ? fmtNum(m.items[i].pu, 2) : "", iva: String(m?.items?.[i]?.iva ?? 21).replace(".", ",") })) : [], (m?.impuestos || []).map((t) => ({ concepto: t.concepto, alicuota: t.alicuota != null ? String(t.alicuota).replace(".", ",") : "", importe: fmtNum(t.importe, 2) })));
    const sm = (t, tipo = "") => { const n = $("#scanMsgDet"); n.textContent = t; n.className = "note" + (tipo ? " " + tipo : ""); n.hidden = !t; };
    const sc = $("#scanDet");
    if (sc) sc.onchange = async (e) => {
      const file = e.target.files[0]; e.target.value = ""; if (!file) return;
      const lbl = $('label[for="scanDet"]'); lbl.classList.add("busy");
      try {
        const r = await leerFactura(file, (t) => sm(t));
        if (r.fa.moneda === "USD" || r.fa.moneda === "ARS") $("#edMon").value = r.fa.moneda;
        const x = itemsDeFactura(r.fa, $("#edMon").value); st.ed.set(x.items, x.imp); sm(x.msg, x.alerta ? "err" : "");
        // guardar la factura escaneada en los documentos del ingreso
        try { const arch = await subirArchivo(l.id, new File([r.blob], r.nombre, { type: r.mime }), r.mime, l.tipo === "contenedor" ? "factura_despacho" : "factura"); await updateDoc(doc(db, "legajos", l.id), { archivos: arrayUnion(arch) }); } catch (_) {}
      } catch (err) { sm(err.message || "No se pudo leer la factura.", "err"); }
      finally { lbl.classList.remove("busy"); }
    };
  };
  $("#sheet").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return; const act = b.dataset.act;
    if (act === "close") return closeSheet();
    const l = S.legajos.find((x) => x.id === id); if (!l) return;
    const r = doc(db, "legajos", l.id); const c = compraDe(l);
    try {
      if (act === "ver") {
        const a = l.archivos[+b.dataset.i]; const w = window.open("", "_blank");
        const u = urls[a.path] && urls[a.path] !== "pending" ? urls[a.path] : await getDownloadURL(sref(storage, a.path));
        if (w) w.location = u; else location.href = u; return;
      }
      if (act === "editprod") { st.edit = true; st.msg = ""; return drawEdit(); }
      if (act === "canceledit") { st.edit = false; return draw(); }
      if (act === "saveprod") {
        const items = st.ed.valid(); const err = $("#edErr");
        if (!items.length) { err.textContent = "Agregá al menos un producto."; err.hidden = false; return; }
        const sinCant = items.filter((it) => !it.cant).length; if (sinCant) { err.textContent = `Falta la cantidad en ${sinCant} producto${sinCant > 1 ? "s" : ""}.`; err.hidden = false; return; }
        b.disabled = true;
        const cid = c ? c.id : l.id; const bt = writeBatch(db);
        batchCompra(bt, cid, { fecha: l.fecha, proveedor: l.proveedor, factura: l.factura, moneda: $("#edMon").value, items, impuestos: st.ed.validImp() }, c);
        if (cid !== l.id) bt.update(doc(db, "compras", cid), { legajoId: l.id });
        await bt.commit(); st.edit = false; st.msg = "Productos guardados.";
      }
      else if (act === "estado") { b.disabled = true; const f = firmar(); const aRecibir = l.estado !== "recibido"; await updateDoc(r, aRecibir ? { estado: "recibido", recibidoPor: f.por, recibidoPorNombre: f.porNombre, recibidoEn: nowISO(), notasOficina: $("#notasOf").value.trim() } : { estado: "pendiente", recibidoPor: null, recibidoPorNombre: null, recibidoEn: null }); st.msg = aRecibir ? "Marcado como recibido." : "Volvió a pendiente."; }
      else if (act === "notas") { b.disabled = true; await updateDoc(r, { notasOficina: $("#notasOf").value.trim() }); st.msg = "Notas guardadas."; }
      else if (act === "del") st.confirmDel = true;
      else if (act === "del-no") st.confirmDel = false;
      else if (act === "del-ok") {
        b.disabled = true; const bt = writeBatch(db); bt.delete(r);
        if (c) { bt.delete(doc(db, "compras", c.id)); bt.delete(doc(db, "comprasMontos", c.id)); }
        await bt.commit();
        for (const a of l.archivos || []) try { await deleteObject(sref(storage, a.path)); } catch (_) {}
        return closeSheet();
      }
      else if (act === "rmfile") st.confirmFile = +b.dataset.i;
      else if (act === "rmfile-no") st.confirmFile = null;
      else if (act === "rmfile-ok") { const i = +b.dataset.i, a = l.archivos[i]; await updateDoc(r, { archivos: l.archivos.filter((_, j) => j !== i) }); st.confirmFile = null; try { await deleteObject(sref(storage, a.path)); } catch (_) {} st.msg = "Archivo quitado."; }
    } catch (err) {
      console.error(err);
      if (st.edit) { const er = $("#edErr"); if (er) { er.textContent = "No se pudo guardar. Probá de nuevo."; er.hidden = false; } b.disabled = false; return; }
      st.msg = "!No se pudo guardar el cambio. Probá de nuevo.";
    }
    draw();
  };
  openSheet(draw);
}

/* ================= SKUs ML ================= */
let skuFilter = "pend", confirmSku = null;
function initSkus() {
  $("#v-skus").innerHTML = `<div style="display:grid;gap:14px">
    <form class="panel" id="formSku" autocomplete="off">
      <h2>Agregar SKUs para publicar en Mercado Libre</h2>
      <label class="f">SKUs<textarea id="inSkus" class="mono" rows="4" placeholder="Uno por línea. Descripción opcional después de ; o tab:&#10;L9BL; Biblioteca L9 Blanco&#10;SC80BL"></textarea>
        <span class="hint">Pegá directo desde Excel: primera columna SKU, segunda descripción. Los repetidos se saltean.</span></label>
      <div class="bar"><button class="btn primary" type="submit" id="bAddSku">Agregar</button><span class="hint" id="skuMsg"></span></div>
    </form>
    <div class="stats"><div class="stat"><b id="stPend">0</b><span>Sin cargar</span></div><div class="stat"><b id="stDone">0</b><span>Cargados en sistema</span></div></div>
    <div class="bar">
      <div class="seg" role="group" aria-label="Filtro"><button type="button" data-f="pend" aria-pressed="true">Sin cargar</button><button type="button" data-f="done" aria-pressed="false">Cargados</button><button type="button" data-f="all" aria-pressed="false">Todos</button></div>
      <input class="grow" type="search" id="qS" placeholder="Buscar SKU o descripción" aria-label="Buscar SKU">
      <button class="btn" type="button" id="bCsvS">Exportar CSV</button>
    </div>
    <div id="skuWrap"></div></div>`;
  $$("#v-skus .seg button").forEach((b) => b.onclick = () => { skuFilter = b.dataset.f; $$("#v-skus .seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderSkus(); });
  $("#qS").oninput = renderSkus;
  $("#skuWrap").addEventListener("change", async (e) => {
    const id = e.target.dataset.sku; if (!id) return; const on = e.target.checked; e.target.disabled = true; const f = firmar();
    try { await updateDoc(doc(db, "skus", id), on ? { cargado: true, cargadoPor: f.por, cargadoPorNombre: f.porNombre, cargadoEn: nowISO() } : { cargado: false, cargadoPor: null, cargadoPorNombre: null, cargadoEn: null }); }
    catch (_) { e.target.checked = !on; $("#skuMsg").textContent = "No se pudo guardar el tilde."; }
    finally { e.target.disabled = false; }
  });
  $("#skuWrap").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.delsku) { confirmSku = t.dataset.delsku; renderSkus(); }
    else if ("delskuNo" in t.dataset) { confirmSku = null; renderSkus(); }
    else if (t.dataset.delskuOk) { try { await deleteDoc(doc(db, "skus", t.dataset.delskuOk)); } catch (_) { $("#skuMsg").textContent = "No se pudo borrar."; } confirmSku = null; renderSkus(); }
  });
  $("#formSku").addEventListener("submit", async (e) => {
    e.preventDefault();
    const exist = new Set(S.skus.map((s) => s.sku.toUpperCase())); const nuevos = []; let rep = 0;
    for (const line of $("#inSkus").value.split(/\r?\n/)) {
      const p = line.split(/\t|;/); const sku = (p[0] || "").trim(); if (!sku) continue;
      if (exist.has(sku.toUpperCase())) { rep++; continue; } exist.add(sku.toUpperCase());
      nuevos.push({ sku: sku.slice(0, 80), desc: p.slice(1).join(" ").trim().slice(0, 200) });
    }
    if (!nuevos.length) { $("#skuMsg").textContent = rep ? `Ya estaban cargados (${rep}).` : "Escribí al menos un SKU."; return; }
    const b = $("#bAddSku"); b.disabled = true; let ok = 0; const f = firmar();
    try {
      for (let i = 0; i < nuevos.length; i += 400) {
        const bt = writeBatch(db);
        nuevos.slice(i, i + 400).forEach((n) => bt.set(doc(collection(db, "skus")), { ...n, cargado: false, creadoPor: f.por, creadoPorNombre: f.porNombre, creadoEn: nowISO(), cargadoPor: null, cargadoPorNombre: null, cargadoEn: null }));
        await bt.commit(); ok += Math.min(400, nuevos.length - i);
      }
      $("#inSkus").value = "";
    } catch (_) {}
    $("#skuMsg").textContent = `${ok} agregado${ok === 1 ? "" : "s"}${rep ? ` · ${rep} repetido${rep === 1 ? "" : "s"} salteado${rep === 1 ? "" : "s"}` : ""}${ok < nuevos.length ? ` · ${nuevos.length - ok} no se pudieron guardar` : ""}.`;
    b.disabled = false;
  });
  $("#bCsvS").onclick = () => descargarCSV(`skus-mercadolibre-${hoy()}.csv`, [["SKU", "Descripcion", "Cargado en sistema", "Agregado"], ...S.skus.map((s) => [s.sku, s.desc, s.cargado ? "SI" : "NO", fmtFH(s.creadoEn)])]);
  renderSkus();
}
function renderSkus() {
  const w = $("#skuWrap"); if (!w) return;
  const pend = S.skus.filter((s) => !s.cargado).length; $("#stPend").textContent = pend; $("#stDone").textContent = S.skus.length - pend; setCount("skus", pend);
  if (!S.loaded.skus) { w.innerHTML = `<div class="empty"><b>Cargando SKUs…</b></div>`; return; }
  if (!S.skus.length) { w.innerHTML = `<div class="empty"><b>Sin SKUs todavía</b><span>Pegá arriba los SKUs que van a publicar. La oficina los tilda cuando quedan cargados en el sistema.</span></div>`; return; }
  const q = $("#qS").value.trim().toLowerCase();
  const rows = S.skus.filter((s) => (skuFilter === "all" || (skuFilter === "pend" ? !s.cargado : s.cargado)) && (!q || (s.sku + " " + (s.desc || "")).toLowerCase().includes(q)));
  if (!rows.length) { w.innerHTML = `<div class="empty"><b>${skuFilter === "pend" && !q ? "Todo cargado ✓" : "Nada con ese filtro"}</b></div>`; return; }
  w.innerHTML = `<div class="tablewrap"><table class="wide"><thead><tr><th>En sistema</th><th>SKU</th><th>Descripción</th><th>Agregado</th>${S.admin ? "<th></th>" : ""}</tr></thead><tbody>${rows.map((s) => `
    <tr class="${s.cargado ? "done" : ""}"><td><label class="check"><input type="checkbox" data-sku="${esc(s.id)}"${s.cargado ? " checked" : ""}>${s.cargado ? "Cargado" : "No"}</label></td>
    <td class="sku">${esc(s.sku)}</td><td>${esc(s.desc || "")}${s.cargado ? `<br><small>Cargó ${esc(s.cargadoPorNombre || "—")} · ${fmtFH(s.cargadoEn)}</small>` : ""}</td>
    <td><small>${fmtFH(s.creadoEn)}<br>${esc(s.creadoPorNombre || "")}</small></td>
    ${S.admin ? `<td style="white-space:nowrap">${confirmSku === s.id ? `<button class="btn small danger" data-delsku-ok="${esc(s.id)}">Borrar</button> <button class="btn small" data-delsku-no>No</button>` : `<button class="btn small" data-delsku="${esc(s.id)}" aria-label="Borrar SKU">✕</button>`}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

/* ================= RESUMEN (admin) ================= */
function initResumen() {
  $("#v-resumen").innerHTML = `<div style="display:grid;gap:16px">
    <div class="bar"><span class="h2">Resumen mensual de compras</span><span class="chip lock">Solo administración</span><span style="flex:1"></span>
      <input type="month" id="mR" style="width:auto" aria-label="Mes"><button class="btn" id="bCsvR" type="button">Exportar mes (CSV)</button></div>
    <div id="rStats"></div>
    <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">
      <div class="panel"><h2>Últimos 12 meses</h2><div id="rBars"></div></div>
      <div class="panel"><h2>Por proveedor</h2><div id="rProv"></div></div>
    </div>
    <div class="panel"><h2>Stock comprado por SKU</h2><div id="rSku"></div></div>
  </div>`;
  $("#mR").value = mesDe(hoy());
  $("#mR").onchange = renderResumen;
  $("#bCsvR").onclick = () => {
    const m = $("#mR").value; const rows = [["Fecha", "Proveedor", "Factura", "Moneda", "SKU", "Descripcion", "Cantidad", "Unit. neto", "IVA %", "Unit. c/IVA", "Subtotal neto", "Neto factura", "Impuestos factura", "Total factura", "Cargado por"]];
    S.compras.filter((c) => c.mes === m).forEach((c) => { const mm = S.montos[c.id]; (c.items || []).forEach((it, i) => { const p = mm?.items?.[i]; const iva = p?.iva ?? 21; rows.push([c.fecha, c.proveedor, c.factura, c.moneda, it.sku, it.desc, it.cant, p?.pu ?? "", iva, p ? +(p.pu * (1 + iva / 100)).toFixed(2) : "", p?.subtotal ?? "", i === 0 && mm ? netoDe(mm) : "", i === 0 && mm ? mm.impTotal ?? 0 : "", i === 0 && mm ? totF(mm) : "", c.creadoPorNombre]); }); });
    descargarCSV(`compras-${m}.csv`, rows);
  };
}
function renderResumen() {
  if (!S.admin || !$("#rStats") || $("#v-resumen").hidden) return;
  if (!S.loaded.compras || !S.loaded.montos) { $("#rStats").innerHTML = `<div class="empty"><b>Cargando…</b></div>`; return; }
  const m = $("#mR").value; const del = S.compras.filter((c) => c.mes === m);
  const z = () => ({ neto: 0, iva: 0, perc: 0, tot: 0 }); const tot = { ARS: z(), USD: z() }; const conceptos = {}; let unid = 0, sinP = 0, sinImp = 0;
  del.forEach((c) => {
    unid += c.unidades || 0; const mm = S.montos[c.id]; if (!mm) return;
    const t = (tot[mm.moneda] ??= z()); t.neto += netoDe(mm); t.tot += totF(mm); sinP += mm.sinPrecio || 0; if (!(mm.impuestos || []).length) sinImp++;
    (mm.impuestos || []).forEach((x) => { if (/^iva\b/i.test(x.concepto)) t.iva += x.importe; else t.perc += x.importe; const k = mm.moneda + "|" + x.concepto; conceptos[k] = (conceptos[k] || 0) + x.importe; });
  });
  $("#rStats").innerHTML = `<div class="stats">
    ${["ARS", "USD"].map((mon) => `<div class="stat"><b>${fmtMon(tot[mon].tot, mon)}</b><span>Facturado ${mon} · ${fmtMes(m)}</span><small class="hint">Neto ${fmtMon(tot[mon].neto, mon)} · IVA ${fmtNum(tot[mon].iva)} · Perc./otros ${fmtNum(tot[mon].perc)}</small></div>`).join("")}
    <div class="stat"><b>${del.length}</b><span>Compras</span></div><div class="stat"><b>${fmtNum(unid)}</b><span>Unidades compradas</span></div></div>
    ${sinP ? `<div class="note err" style="margin-top:10px">${sinP} producto${sinP > 1 ? "s" : ""} de este mes no tienen precio cargado.</div>` : ""}
    ${sinImp ? `<div class="note err" style="margin-top:10px">${sinImp} compra${sinImp > 1 ? "s" : ""} de este mes no tienen impuestos cargados (su total es solo neto).</div>` : ""}
    ${Object.keys(conceptos).length ? `<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Impuesto / percepción</th><th>Moneda</th><th class="num">Importe del mes</th></tr></thead><tbody>${Object.entries(conceptos).sort().map(([k, v]) => { const [mon, con] = k.split("|"); return `<tr><td>${esc(con)}</td><td>${mon}</td><td class="num">${fmtNum(v, 2)}</td></tr>`; }).join("")}</tbody></table></div>` : ""}`;
  const [y, mm0] = m.split("-").map(Number); const meses = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(y, mm0 - 1 - i, 1); meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
  const porMes = (mon) => meses.map((k) => S.compras.filter((c) => c.mes === k).reduce((a, c) => a + (S.montos[c.id]?.moneda === mon ? totF(S.montos[c.id]) : 0), 0));
  $("#rBars").innerHTML = `<div class="hint">Total facturado con impuestos.</div>` + ["USD", "ARS"].map((mon) => {
    const v = porMes(mon); const max = Math.max(...v, 0); if (!max) return `<div class="hint">Sin compras en ${mon} en los últimos 12 meses.</div>`;
    return `<div style="display:grid;gap:6px"><b class="hint" style="font-weight:600">${mon}</b><div class="bars">${meses.map((k, i) => `<div class="b${k === m ? " cur" : ""}"><span class="mono">${fmtMes(k)}</span><span class="track"><span class="fill" style="display:block;width:${(v[i] / max) * 100}%"></span></span><span class="num">${v[i] ? fmtNum(v[i]) : "—"}</span></div>`).join("")}</div></div>`;
  }).join('<div class="sep" style="margin:10px 0"></div>');
  const pv = {}; del.forEach((c) => { const k = c.proveedor || "—"; const mm = S.montos[c.id]; pv[k] ??= { n: 0, u: 0, ARS: 0, USD: 0 }; pv[k].n++; pv[k].u += c.unidades || 0; if (mm) pv[k][mm.moneda] += totF(mm); });
  const pvs = Object.entries(pv).sort((a, b) => b[1].USD - a[1].USD || b[1].ARS - a[1].ARS);
  $("#rProv").innerHTML = pvs.length ? `<div class="tablewrap"><table><thead><tr><th>Proveedor</th><th class="num">Compras</th><th class="num">Unid.</th><th class="num">ARS c/imp.</th><th class="num">USD c/imp.</th></tr></thead><tbody>${pvs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${fmtNum(v.u)}</td><td class="num">${v.ARS ? fmtNum(v.ARS) : "—"}</td><td class="num">${v.USD ? fmtNum(v.USD) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="hint">Sin compras en ${fmtMes(m)}.</div>`;
  const sk = {}; del.forEach((c) => { const mm = S.montos[c.id]; (c.items || []).forEach((it, i) => { const k = it.sku || it.desc || "—"; sk[k] ??= { desc: it.desc, u: 0, mon: mm?.moneda || c.moneda, neto: 0, civa: 0 }; sk[k].u += it.cant || 0; const p = mm?.items?.[i]; if (p) { sk[k].neto += p.subtotal || 0; sk[k].civa += (p.subtotal || 0) * (1 + (p.iva ?? 21) / 100); } }); });
  const sks = Object.entries(sk).sort((a, b) => b[1].u - a[1].u);
  const sym = (mon) => (mon === "USD" ? "US$ " : "$ ");
  $("#rSku").innerHTML = sks.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>SKU</th><th>Descripción</th><th class="num">Unidades</th><th class="num">Costo prom. neto</th><th class="num">Costo prom. c/IVA</th><th class="num">Total neto</th></tr></thead><tbody>${sks.map(([k, v]) => `<tr><td class="sku">${esc(k)}</td><td>${esc(v.desc || "")}</td><td class="num">${fmtNum(v.u)}</td><td class="num">${v.u && v.neto ? sym(v.mon) + fmtNum(v.neto / v.u, 2) : "—"}</td><td class="num">${v.u && v.civa ? sym(v.mon) + fmtNum(v.civa / v.u, 2) : "—"}</td><td class="num">${v.neto ? sym(v.mon) + fmtNum(v.neto) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="hint">Sin productos comprados en ${fmtMes(m)}.</div>`;
}

/* ================= USUARIOS (admin) ================= */
function initUsuarios() {
  $("#v-usuarios").innerHTML = `<div style="display:grid;gap:16px">
    <form class="panel" id="formU" autocomplete="off">
      <h2>Dar de alta un usuario</h2>
      <div class="grid2">
        <label class="f">Nombre<input type="text" id="uNom" required placeholder="Ej: Juan (depósito)"></label>
        <label class="f">Email<input type="email" id="uEmail" required autocomplete="off"></label>
        <label class="f">Contraseña inicial<input type="text" id="uPass" required minlength="6" autocomplete="off" placeholder="Mínimo 6 caracteres"></label>
        <label class="f">Rol<select id="uRol"><option value="empleado">Empleado (no ve montos)</option><option value="admin">Administrador (ve todo)</option></select></label>
      </div>
      <div class="note err" id="uErr" hidden></div>
      <div class="bar"><button class="btn primary" type="submit" id="bU">Crear usuario</button><span class="hint">Pasale el email y la clave. Puede cambiarla con "Olvidé mi contraseña".</span></div>
    </form>
    <div id="listU"></div></div>`;
  $("#formU").addEventListener("submit", async (e) => {
    e.preventDefault(); const err = (t) => { $("#uErr").textContent = t; $("#uErr").hidden = !t; }; err("");
    const b = $("#bU"); b.disabled = true; const sa = secondaryAuth();
    try {
      const cred = await createUserWithEmailAndPassword(sa, $("#uEmail").value.trim(), $("#uPass").value);
      await setDoc(doc(db, "usuarios", cred.user.uid), { nombre: $("#uNom").value.trim(), email: cred.user.email, rol: $("#uRol").value, activo: true, creadoEn: nowISO() });
      await signOut(sa); $("#formU").reset();
    } catch (x) {
      const c = x.code || ""; err(c.includes("email-already") ? "Ese email ya tiene cuenta. Si lo desactivaste, reactivalo en la lista." : c.includes("weak-password") ? "La contraseña es muy corta (mínimo 6)." : c.includes("invalid-email") ? "El email no es válido." : "No se pudo crear el usuario.");
    } finally { b.disabled = false; }
  });
  $("#listU").addEventListener("change", async (e) => {
    const id = e.target.dataset.u; if (!id) return;
    const patch = e.target.dataset.k === "rol" ? { rol: e.target.value } : { activo: e.target.checked };
    try { await updateDoc(doc(db, "usuarios", id), patch); } catch (_) { renderUsuarios(); }
  });
  renderUsuarios();
}
function renderUsuarios() {
  const el = $("#listU"); if (!el) return;
  if (!S.loaded.usuarios) { el.innerHTML = `<div class="empty"><b>Cargando usuarios…</b></div>`; return; }
  const us = [...S.usuarios].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
  el.innerHTML = `<div class="tablewrap"><table class="wide"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Activo</th></tr></thead><tbody>${us.map((u) => {
    const yo = u.id === S.user.uid;
    return `<tr><td>${esc(u.nombre)}${yo ? " <small>(vos)</small>" : ""}</td><td class="mono" style="font-size:.85rem">${esc(u.email)}</td>
    <td><select data-u="${esc(u.id)}" data-k="rol" style="width:auto"${yo ? " disabled" : ""}><option value="empleado"${u.rol !== "admin" ? " selected" : ""}>Empleado</option><option value="admin"${u.rol === "admin" ? " selected" : ""}>Admin</option></select></td>
    <td><label class="check"><input type="checkbox" data-u="${esc(u.id)}" data-k="activo"${u.activo ? " checked" : ""}${yo ? " disabled" : ""}>${u.activo ? "Sí" : "No"}</label></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

/* ================= util CSV ================= */
function descargarCSV(nombre, rows) {
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const csv = "﻿" + rows.map((r) => r.map(q).join(";")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = nombre;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
