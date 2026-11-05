import "./style.css";
import { auth, db, storage, secondaryAuth, SUPERADMIN, configOk } from "./firebase.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, writeBatch, addDoc, arrayUnion } from "firebase/firestore";
import { ref as sref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

/* ================= constantes y utilidades ================= */
const TIPOS = {
  local: { label: "Compra local", corto: "Local", req: ["factura"] },
  courier: { label: "Courier internacional", corto: "Courier", req: ["factura", "guia", "despacho"] },
  contenedor: { label: "Contenedor", corto: "Contenedor", req: ["factura_despacho", "despacho"] },
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
const fmtMon = (n, mon = "ARS") => (mon === "USD" ? "US$ " : "$ ") + fmtNum(n, 2);
// "1.234,56" / "1234.56" / "1,5" → número
function parseNum(s) {
  s = String(s ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
const nowISO = () => new Date().toISOString();

/* ================= estado ================= */
const S = {
  user: null, perfil: null, admin: false,
  legajos: [], compras: [], montos: {}, skus: [], usuarios: [],
  loaded: { legajos: false, compras: false, skus: false, montos: false, usuarios: false },
  unsubs: [],
};
const app = $("#app");

/* ================= arranque / login ================= */
if (!configOk) {
  app.innerHTML = `<div class="login"><div class="panel" style="max-width:460px"><h2>Falta configurar Firebase</h2><p class="hint">Cargá las variables <span class="mono">VITE_FB_*</span> en Vercel (o en <span class="mono">.env.local</span>) y volvé a desplegar.</p></div></div>`;
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
  { id: "legajos", label: "Documentación" },
  { id: "compras", label: "Compras" },
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
    <section id="v-legajos"></section>
    <section id="v-compras" hidden></section>
    <section id="v-skus" hidden></section>
    ${S.admin ? `<section id="v-resumen" hidden></section><section id="v-usuarios" hidden></section>` : ""}
  </main></div>
  <div class="ov" id="ov" hidden><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>`;
  $("#bSalir").onclick = () => signOut(auth);
  $("#ov").addEventListener("click", (e) => { if (e.target.id === "ov") closeSheet(); });
  initLegajos(); initCompras(); initSkus();
  if (S.admin) { initResumen(); initUsuarios(); }
  window.onhashchange = route; route();
  subscribeAll();
}
function route() {
  const ids = TABS.filter((t) => !t.admin || S.admin).map((t) => t.id);
  const v = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "legajos";
  ids.forEach((id) => { $("#v-" + id).hidden = id !== v; });
  $$("nav.tabs a").forEach((a) => a.dataset.tab === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "resumen") renderResumen();
}
function setCount(id, n) { const el = $("#cnt-" + id); if (el) { el.textContent = n; el.hidden = !n; } }
function gNote(t) { const n = $("#gNote"); if (n) { n.textContent = t || ""; n.hidden = !t; } }
let sheetRender = null;
function openSheet(fn) { sheetRender = fn; fn(); $("#ov").hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet() { sheetRender = null; $("#ov").hidden = true; $("#sheet").innerHTML = ""; document.body.style.overflow = ""; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#ov") && !$("#ov").hidden) closeSheet(); });
const firmar = () => ({ por: S.user.uid, porNombre: S.perfil.nombre || S.user.email });

function subscribeAll() {
  const sub = (key, q, fn) => {
    S.unsubs.push(onSnapshot(q, (snap) => { S.loaded[key] = true; fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); },
      (err) => { console.error(key, err); S.loaded[key] = true; gNote("No se pudieron leer algunos datos (" + key + "). Si recién configuraste Firebase, revisá que las reglas estén publicadas."); fn(null); }));
  };
  sub("legajos", query(collection(db, "legajos"), orderBy("creadoEn", "desc"), limit(1000)), (r) => { if (r) S.legajos = r; renderLegajos(); refreshLegajoSelect(); if (sheetRender) sheetRender(); });
  sub("compras", query(collection(db, "compras"), orderBy("fecha", "desc"), limit(2000)), (r) => { if (r) S.compras = r; renderCompras(); renderResumen(); if (sheetRender) sheetRender(); });
  sub("skus", query(collection(db, "skus"), orderBy("creadoEn", "desc"), limit(2000)), (r) => { if (r) S.skus = r; renderSkus(); refreshSkuList(); });
  if (S.admin) {
    sub("montos", query(collection(db, "comprasMontos"), limit(3000)), (r) => { if (r) S.montos = Object.fromEntries(r.map((m) => [m.id, m])); renderCompras(); renderResumen(); if (sheetRender) sheetRender(); });
    sub("usuarios", query(collection(db, "usuarios")), (r) => { if (r) S.usuarios = r; renderUsuarios(); });
  }
}

/* ================= LEGAJOS (documentación) ================= */
let staged = [];
function initLegajos() {
  $("#v-legajos").innerHTML = `<div class="list">
    <div class="bar">
      <button class="btn primary" id="bNuevoL" type="button">+ Nuevo legajo</button>
      <input class="grow" type="search" id="qL" placeholder="Buscar proveedor, factura, guía, despacho…" aria-label="Buscar legajos">
      <select id="fEstado" style="width:auto" aria-label="Estado"><option value="pendiente">Pendientes</option><option value="recibido">Recibidos</option><option value="">Todos</option></select>
      <select id="fTipo" style="width:auto" aria-label="Tipo"><option value="">Todos los tipos</option><option value="local">Compra local</option><option value="courier">Courier</option><option value="contenedor">Contenedor</option></select>
    </div>
    <form class="panel" id="formL" hidden autocomplete="off">
      <h2>Nuevo legajo de ingreso</h2>
      <div class="tipos" role="radiogroup" aria-label="Tipo de ingreso">
        <label class="tipo"><input type="radio" name="tipo" value="local" checked><b>Compra local</b><span>Factura de proveedor + remito</span></label>
        <label class="tipo"><input type="radio" name="tipo" value="courier"><b>Courier internacional</b><span>Factura, guía y despacho</span></label>
        <label class="tipo"><input type="radio" name="tipo" value="contenedor"><b>Contenedor</b><span>Factura de despacho + despacho</span></label>
      </div>
      <div class="grid2">
        <label class="f">Proveedor / origen<input type="text" id="inProv" placeholder="Ej: Ningbo Home Co."></label>
        <label class="f">N° de factura<input type="text" id="inFact" class="mono" placeholder="Ej: A-0003-00012345"></label>
        <label class="f">Fecha de ingreso<input type="date" id="inFecha"></label>
        <label class="f" data-show="courier">Empresa courier<input type="text" id="inCourier" placeholder="DHL, FedEx, UPS…"></label>
        <label class="f" data-show="courier">N° de guía (AWB)<input type="text" id="inGuia" class="mono" placeholder="Ej: 123-45678901"></label>
        <label class="f" data-show="courier contenedor">N° de despacho<input type="text" id="inDesp" class="mono" placeholder="Ej: 26001IC04012345K"></label>
        <label class="f" data-show="contenedor">N° de contenedor<input type="text" id="inCont" class="mono" placeholder="Ej: MSCU1234567"></label>
        <label class="f" data-show="contenedor">Despachante<input type="text" id="inDespachante"></label>
      </div>
      <label class="f">Observaciones<textarea id="inNotas" placeholder="Bultos, faltantes, mercadería dañada…"></textarea></label>
      <div style="display:grid;gap:8px">
        <div class="f" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">Documentos <span class="req" id="reqChips"></span></div>
        <div class="drop" id="drop"><div>Arrastrá archivos acá o</div>
          <label class="btn" for="inFiles">Elegir / sacar foto</label>
          <input type="file" id="inFiles" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden>
          <div class="hint">PDF, JPG, PNG o WEBP · hasta 20 MB cada uno</div></div>
        <div class="staged" id="staged"></div>
      </div>
      <div class="note err" id="formLErr" hidden></div>
      <div class="bar"><button class="btn primary" type="submit" id="bGuardarL">Guardar legajo</button><button class="btn" type="button" id="bCancL">Cancelar</button><span class="hint" id="progL"></span></div>
    </form>
    <div id="listL" class="list"></div>
  </div>`;
  const f = $("#formL");
  $$("input[name=tipo]", f).forEach((r) => r.addEventListener("change", syncTipo));
  $("#bNuevoL").onclick = () => { resetFormL(); f.hidden = false; $("#bNuevoL").hidden = true; $("#inProv").focus(); };
  $("#bCancL").onclick = () => { resetFormL(); f.hidden = true; $("#bNuevoL").hidden = false; };
  $("#inFiles").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles([...(e.dataTransfer.files || [])]));
  $("#staged").addEventListener("change", (e) => { const i = e.target.dataset.i; if (i != null) { staged[i].tipoDoc = e.target.value; renderReq(); } });
  $("#staged").addEventListener("click", (e) => { const i = e.target.dataset.rm; if (i != null) { const s = staged.splice(+i, 1)[0]; if (s?.url) URL.revokeObjectURL(s.url); renderStaged(); } });
  f.addEventListener("submit", guardarLegajo);
  ["input", "change"].forEach((ev) => ["#qL", "#fEstado", "#fTipo"].forEach((s) => $(s).addEventListener(ev, renderLegajos)));
  $("#listL").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openLegajo(b.dataset.open); });
  resetFormL(); renderLegajos();
}
const tipoSel = () => $("input[name=tipo]:checked").value;
function syncTipo() { const t = tipoSel(); $$("#formL [data-show]").forEach((el) => { el.hidden = !el.dataset.show.split(" ").includes(t); }); renderReq(); }
function renderReq() {
  const have = new Set(staged.map((s) => s.tipoDoc));
  $("#reqChips").innerHTML = TIPOS[tipoSel()].req.map((k) => `<span class="chip ${have.has(k) ? "ok" : "warn"}">${have.has(k) ? "✓" : "Falta"} ${esc(DOCS[k])}</span>`).join("");
}
function guessTipoDoc() { const t = tipoSel(); const have = new Set(staged.map((s) => s.tipoDoc)); return TIPOS[t].req.find((k) => !have.has(k)) || (t === "local" ? "remito" : "otro"); }
function mimeOf(f) {
  if (["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type)) return f.type;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
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
  $("#staged").innerHTML = staged.map((s, i) => `<div class="srow">${ficon(s.mime, s.url)}<span class="nm" title="${esc(s.file.name)}">${esc(s.file.name)} <small class="hint">· ${kb(s.file.size)}</small></span><select data-i="${i}" aria-label="Tipo de documento">${docOptions(s.tipoDoc)}</select><button type="button" class="btn small" data-rm="${i}" aria-label="Quitar">✕</button></div>`).join("");
  renderReq();
}
function errL(t) { $("#formLErr").textContent = t || ""; $("#formLErr").hidden = !t; }
function resetFormL() {
  $("#formL").reset(); $("input[name=tipo][value=local]").checked = true; $("#inFecha").value = hoy();
  staged.forEach((s) => s.url && URL.revokeObjectURL(s.url)); staged = []; renderStaged(); syncTipo(); errL(""); $("#progL").textContent = "";
}
const safeName = (n) => n.normalize("NFD").replace(/[^\w.\-]+/g, "_").slice(-80);
async function subirArchivo(legajoId, file, mime, tipoDoc) {
  const path = `legajos/${legajoId}/${Date.now()}-${safeName(file.name)}`;
  const r = await uploadBytes(sref(storage, path), file, { contentType: mime });
  return { path, nombre: file.name, tipoDoc, mime, size: r.metadata.size || file.size, ...firmar(), en: nowISO() };
}
async function guardarLegajo(e) {
  e.preventDefault();
  const t = tipoSel(); const prov = $("#inProv").value.trim(), fact = $("#inFact").value.trim();
  if (!prov && !fact) return errL("Completá al menos el proveedor o el número de factura.");
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
    const f = firmar();
    await setDoc(doc(db, "legajos", id), {
      tipo: t, proveedor: prov, factura: fact, fecha: $("#inFecha").value || hoy(),
      courier: t === "courier" ? $("#inCourier").value.trim() : "", guia: t === "courier" ? $("#inGuia").value.trim() : "",
      despacho: t !== "local" ? $("#inDesp").value.trim() : "", contenedor: t === "contenedor" ? $("#inCont").value.trim() : "",
      despachante: t === "contenedor" ? $("#inDespachante").value.trim() : "", notas: $("#inNotas").value.trim(), notasOficina: "",
      estado: "pendiente", archivos, creadoPor: f.por, creadoPorNombre: f.porNombre, creadoEn: nowISO(), recibidoPor: null, recibidoPorNombre: null, recibidoEn: null,
    });
    resetFormL(); $("#formL").hidden = true; $("#bNuevoL").hidden = false; $("#fEstado").value = "pendiente"; renderLegajos();
  } catch (err) { errL(err.message || "No se pudo guardar. Probá de nuevo."); $("#progL").textContent = ""; }
  finally { b.disabled = false; }
}
const faltan = (l) => { const have = new Set((l.archivos || []).map((a) => a.tipoDoc)); return (TIPOS[l.tipo] || TIPOS.local).req.filter((k) => !have.has(k)); };
function renderLegajos() {
  const el = $("#listL"); if (!el) return;
  const q = $("#qL").value.trim().toLowerCase(), fe = $("#fEstado").value, ft = $("#fTipo").value;
  setCount("legajos", S.legajos.filter((l) => l.estado !== "recibido").length);
  if (!S.loaded.legajos) { el.innerHTML = `<div class="empty"><b>Cargando legajos…</b></div>`; return; }
  if (!S.legajos.length) { el.innerHTML = `<div class="empty"><b>Todavía no hay legajos</b><span>Cuando llegue mercadería, tocá <b>+ Nuevo legajo</b>, elegí el tipo de ingreso y subí las fotos o PDF. La oficina lo ve al instante.</span></div>`; return; }
  const rows = S.legajos.filter((l) => (!fe || l.estado === fe) && (!ft || l.tipo === ft) && (!q || [l.proveedor, l.factura, l.guia, l.despacho, l.contenedor, l.courier, l.despachante, l.notas].join(" ").toLowerCase().includes(q)));
  if (!rows.length) { el.innerHTML = `<div class="empty"><b>Nada con ese filtro</b><span>Probá con "Todos" o borrá la búsqueda.</span></div>`; return; }
  el.innerHTML = rows.map((l) => {
    const f = faltan(l), T = TIPOS[l.tipo] || TIPOS.local, rec = l.estado === "recibido", n = (l.archivos || []).length;
    const ncomp = S.compras.filter((c) => c.legajoId === l.id).length;
    const ident = [l.factura && `Fact. <span class="mono">${esc(l.factura)}</span>`, l.guia && `Guía <span class="mono">${esc(l.guia)}</span>`, l.despacho && `Desp. <span class="mono">${esc(l.despacho)}</span>`, l.contenedor && `Cont. <span class="mono">${esc(l.contenedor)}</span>`].filter(Boolean).join(" · ");
    return `<button type="button" class="card${rec ? " recibido" : ""}" data-open="${esc(l.id)}">
      <div class="row1"><span style="display:flex;gap:8px;align-items:center;min-width:0;flex-wrap:wrap"><span class="chip type">${esc(T.corto)}</span><span class="ttl">${esc(l.proveedor || "Sin proveedor")}</span></span>
      <span class="chip ${rec ? "ok" : "warn"}">${rec ? "Recibido en oficina" : "Pendiente oficina"}</span></div>
      ${ident ? `<div class="meta">${ident}</div>` : ""}
      <div class="meta"><span>${fmtFecha(l.fecha)}</span><span>${n} archivo${n === 1 ? "" : "s"}</span><span>Cargó ${esc(l.creadoPorNombre || "—")}</span>
      ${ncomp ? `<span class="chip info">${ncomp} compra${ncomp > 1 ? "s" : ""} vinculada${ncomp > 1 ? "s" : ""}</span>` : ""}
      ${f.length ? `<span class="chip warn">Falta: ${f.map((k) => esc(DOCS[k])).join(", ")}</span>` : `<span class="chip ok">Documentación completa</span>`}</div></button>`;
  }).join("");
}
function openLegajo(id) {
  const st = { confirmDel: false, confirmFile: null, msg: "" };
  const urls = {};
  const draw = () => {
    const l = S.legajos.find((x) => x.id === id); const sh = $("#sheet");
    if (!l) { sh.innerHTML = `<div class="hd"><h2>Legajo eliminado</h2><button class="btn small" data-act="close">Cerrar</button></div>`; return; }
    const T = TIPOS[l.tipo] || TIPOS.local, rec = l.estado === "recibido", f = faltan(l);
    const kv = [["Tipo", T.label], ["Proveedor", l.proveedor], ["N° factura", l.factura, 1], ["Fecha ingreso", fmtFecha(l.fecha)], ["Courier", l.courier], ["Guía / AWB", l.guia, 1], ["Despacho", l.despacho, 1], ["Contenedor", l.contenedor, 1], ["Despachante", l.despachante], ["Cargado por", `${l.creadoPorNombre || "—"} · ${fmtFH(l.creadoEn)}`]]
      .filter((r) => r[1]).map((r) => `<div><dt>${r[0]}</dt><dd${r[2] ? ' class="mono"' : ""}>${esc(r[1])}</dd></div>`).join("");
    const files = (l.archivos || []).map((a, i) => {
      const img = (a.mime || "").startsWith("image/");
      return `<div class="frow">${ficon(a.mime, img && urls[a.path] !== "pending" ? urls[a.path] : null, true)}
        <span class="txt"><a data-act="ver" data-i="${i}">${esc(DOCS[a.tipoDoc] || a.tipoDoc)}</a><small>${esc(a.nombre)} · ${kb(a.size || 0)}</small></span>
        ${S.admin ? (st.confirmFile === i ? `<button class="btn small danger" data-act="rmfile-ok" data-i="${i}">Quitar</button><button class="btn small" data-act="rmfile-no">No</button>` : `<button class="btn small" data-act="rmfile" data-i="${i}" aria-label="Quitar archivo">✕</button>`) : ""}</div>`;
    }).join("") || `<div class="hint">Sin archivos todavía.</div>`;
    const compras = S.compras.filter((c) => c.legajoId === l.id);
    sh.innerHTML = `
      <div class="hd"><div style="display:grid;gap:6px;min-width:0"><span style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip type">${esc(T.corto)}</span><span class="chip ${rec ? "ok" : "warn"}">${rec ? "Recibido en oficina" : "Pendiente oficina"}</span></span><h2>${esc(l.proveedor || "Sin proveedor")}</h2></div>
      <button class="btn small" data-act="close">Cerrar</button></div>
      ${rec ? `<div class="note">Recibido por ${esc(l.recibidoPorNombre || "—")} · ${fmtFH(l.recibidoEn)}</div>` : ""}
      <dl class="kv">${kv}</dl>
      ${l.notas ? `<div><div class="hint" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Observaciones de depósito</div><div style="white-space:pre-wrap">${esc(l.notas)}</div></div>` : ""}
      <div class="sep"></div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center"><b>Documentos</b>${f.length ? `<span class="chip warn">Falta: ${f.map((k) => esc(DOCS[k])).join(", ")}</span>` : `<span class="chip ok">Completo</span>`}</div>
      <div class="files">${files}</div>
      <div class="bar"><select id="addTipo" style="width:auto" aria-label="Tipo del documento a agregar">${docOptions(f[0] || "otro")}</select><label class="btn" for="addFile">+ Agregar archivos</label><input type="file" id="addFile" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden></div>
      <div class="sep"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>Compras vinculadas</b><button class="btn small" data-act="nuevacompra">+ Cargar compra de este legajo</button></div>
      ${compras.length ? `<div class="files">${compras.map((c) => `<div class="frow"><span class="txt"><a data-act="vercompra" data-id="${esc(c.id)}">${esc(c.proveedor || "Compra")} · ${fmtFecha(c.fecha)}</a><small>${(c.items || []).length} ítems · ${fmtNum(c.unidades)} unidades${S.admin && S.montos[c.id] ? " · " + fmtMon(S.montos[c.id].total, S.montos[c.id].moneda) : ""}</small></span></div>`).join("")}</div>` : `<div class="hint">Todavía no se cargó el detalle de productos de este ingreso.</div>`}
      ${st.msg ? `<div class="note${st.msg.startsWith("!") ? " err" : ""}">${esc(st.msg.replace(/^!/, ""))}</div>` : ""}
      <div class="sep"></div>
      <label class="f">Notas de oficina<textarea id="notasOf" placeholder="Ej: Ingresado en el sistema, falta NC del proveedor…">${esc(l.notasOficina || "")}</textarea></label>
      <div class="bar">
        <button class="btn primary" data-act="estado">${rec ? "Volver a pendiente" : "✓ Marcar recibido en oficina"}</button>
        <button class="btn" data-act="notas">Guardar notas</button>
        ${S.admin ? (st.confirmDel ? `<span class="confirm">¿Eliminar legajo y sus archivos? <button class="btn small danger" data-act="del-ok">Eliminar</button><button class="btn small" data-act="del-no">Cancelar</button></span>` : `<button class="btn small danger" data-act="del" style="margin-left:auto">Eliminar</button>`) : ""}
      </div>`;
    // miniaturas
    (l.archivos || []).forEach((a) => {
      if ((a.mime || "").startsWith("image/") && !urls[a.path]) {
        urls[a.path] = "pending";
        getDownloadURL(sref(storage, a.path)).then((u) => { urls[a.path] = u; if (sheetRender === draw) draw(); }).catch(() => {});
      }
    });
    $("#addFile").onchange = async (e) => {
      const list = [...e.target.files]; e.target.value = ""; const tipoDoc = $("#addTipo").value; const nuevos = [];
      for (const fl of list) {
        const m = mimeOf(fl); if (!m) { st.msg = `!${fl.name}: formato no admitido.`; continue; }
        if (fl.size > 20 * 1048576) { st.msg = `!${fl.name}: pesa más de 20 MB.`; continue; }
        st.msg = `Subiendo ${fl.name}…`; draw();
        try { nuevos.push(await subirArchivo(l.id, fl, m, tipoDoc)); } catch (err) { st.msg = `!No se pudo subir ${fl.name}.`; }
      }
      if (nuevos.length) {
        try { await updateDoc(doc(db, "legajos", l.id), { archivos: arrayUnion(...nuevos) }); if (!st.msg.startsWith("!")) st.msg = `${nuevos.length} archivo${nuevos.length > 1 ? "s" : ""} agregado${nuevos.length > 1 ? "s" : ""}.`; }
        catch (err) { st.msg = "!No se pudo guardar el archivo en el legajo."; }
      }
      draw();
    };
  };
  $("#sheet").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return; const act = b.dataset.act;
    if (act === "close") return closeSheet();
    const l = S.legajos.find((x) => x.id === id); if (!l) return;
    const r = doc(db, "legajos", l.id);
    try {
      if (act === "ver") {
        const a = l.archivos[+b.dataset.i]; const w = window.open("", "_blank");
        const u = urls[a.path] && urls[a.path] !== "pending" ? urls[a.path] : await getDownloadURL(sref(storage, a.path));
        if (w) w.location = u; else location.href = u; return;
      }
      if (act === "vercompra") return openCompra(b.dataset.id);
      if (act === "nuevacompra") { closeSheet(); location.hash = "#compras"; abrirFormCompra(l); return; }
      if (act === "estado") { b.disabled = true; const f = firmar(); const aRecibir = l.estado !== "recibido"; await updateDoc(r, aRecibir ? { estado: "recibido", recibidoPor: f.por, recibidoPorNombre: f.porNombre, recibidoEn: nowISO(), notasOficina: $("#notasOf").value.trim() } : { estado: "pendiente", recibidoPor: null, recibidoPorNombre: null, recibidoEn: null }); st.msg = aRecibir ? "Marcado como recibido." : "Volvió a pendiente."; }
      else if (act === "notas") { b.disabled = true; await updateDoc(r, { notasOficina: $("#notasOf").value.trim() }); st.msg = "Notas guardadas."; }
      else if (act === "del") st.confirmDel = true;
      else if (act === "del-no") st.confirmDel = false;
      else if (act === "del-ok") { b.disabled = true; await deleteDoc(r); for (const a of l.archivos || []) try { await deleteObject(sref(storage, a.path)); } catch (_) {} return closeSheet(); }
      else if (act === "rmfile") st.confirmFile = +b.dataset.i;
      else if (act === "rmfile-no") st.confirmFile = null;
      else if (act === "rmfile-ok") { const i = +b.dataset.i, a = l.archivos[i]; await updateDoc(r, { archivos: l.archivos.filter((_, j) => j !== i) }); st.confirmFile = null; try { await deleteObject(sref(storage, a.path)); } catch (_) {} st.msg = "Archivo quitado."; }
    } catch (err) { console.error(err); st.msg = "!No se pudo guardar el cambio. Probá de nuevo."; }
    draw();
  };
  openSheet(draw);
}

/* ================= COMPRAS ================= */
let itemsF = [];
function initCompras() {
  $("#v-compras").innerHTML = `<div class="list">
    <div class="bar">
      <button class="btn primary" id="bNuevaC" type="button">+ Nueva compra</button>
      <input class="grow" type="search" id="qC" placeholder="Buscar proveedor, factura o SKU" aria-label="Buscar compras">
      <input type="month" id="mC" style="width:auto" aria-label="Mes">
    </div>
    <form class="panel" id="formC" hidden autocomplete="off">
      <h2>Cargar compra</h2>
      <div class="grid2">
        <label class="f">Fecha<input type="date" id="cFecha" required></label>
        <label class="f">Proveedor<input type="text" id="cProv" required placeholder="Ej: Ningbo Home Co."></label>
        <label class="f">N° de factura<input type="text" id="cFact" class="mono"></label>
        <label class="f">Moneda<select id="cMon"><option value="ARS">Pesos (ARS)</option><option value="USD">Dólares (USD)</option></select></label>
        <label class="f">Legajo de documentación<select id="cLeg"><option value="">— Sin vincular —</option></select></label>
      </div>
      <div style="display:grid;gap:6px">
        <div class="f">Productos <span class="hint">Podés pegar desde Excel en la columna SKU: SKU · Descripción · Cantidad · Precio unitario</span></div>
        <div class="tablewrap"><table class="items wide"><thead><tr><th class="c-sku">SKU</th><th>Descripción</th><th class="c-cant num">Cant.</th><th class="c-pu num">Precio unit.</th>${S.admin ? '<th class="c-sub num">Subtotal</th>' : ""}<th></th></tr></thead><tbody id="itemsBody"></tbody>
        ${S.admin ? `<tfoot><tr><td colspan="2">Total</td><td class="num" id="totU">0</td><td></td><td class="num" id="totM">0</td><td></td></tr></tfoot>` : `<tfoot><tr><td colspan="2">Unidades</td><td class="num" id="totU">0</td><td colspan="2"></td></tr></tfoot>`}
        </table></div>
        <div class="bar"><button class="btn small" type="button" id="bAddItem">+ Agregar fila</button>${S.admin ? "" : '<span class="chip lock">Los precios quedan visibles solo para administración</span>'}</div>
        <datalist id="dlSkus"></datalist>
      </div>
      <label class="f">Notas<textarea id="cNotas" rows="2"></textarea></label>
      <div class="note err" id="formCErr" hidden></div>
      <div class="bar"><button class="btn primary" type="submit" id="bGuardarC">Guardar compra</button><button class="btn" type="button" id="bCancC">Cancelar</button></div>
    </form>
    <div id="cResumenMes"></div>
    <div id="listC" class="list"></div>
  </div>`;
  $("#mC").value = mesDe(hoy());
  $("#bNuevaC").onclick = () => abrirFormCompra();
  $("#bCancC").onclick = () => { $("#formC").hidden = true; $("#bNuevaC").hidden = false; };
  $("#bAddItem").onclick = () => { itemsF.push(nuevoItem()); renderItems(); $$("#itemsBody input[data-k=sku]").pop()?.focus(); };
  const body = $("#itemsBody");
  body.addEventListener("input", (e) => {
    const i = e.target.dataset.i, k = e.target.dataset.k; if (i == null) return;
    itemsF[i][k] = e.target.value;
    if (k === "sku") { const s = S.skus.find((x) => x.sku.toUpperCase() === e.target.value.trim().toUpperCase()); if (s && !itemsF[i].desc) { itemsF[i].desc = s.desc || ""; const d = $(`#itemsBody input[data-i="${i}"][data-k=desc]`); if (d) d.value = itemsF[i].desc; } }
    totalesForm();
  });
  body.addEventListener("click", (e) => { const i = e.target.dataset.rm; if (i != null) { itemsF.splice(+i, 1); if (!itemsF.length) itemsF.push(nuevoItem()); renderItems(); } });
  body.addEventListener("paste", (e) => {
    const t = e.target; if (t.dataset.k !== "sku") return;
    const txt = (e.clipboardData || window.clipboardData).getData("text");
    if (!/[\t\n]/.test(txt.trim())) return;
    e.preventDefault();
    const lines = txt.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    let i = +t.dataset.i;
    for (const line of lines) {
      const c = line.split("\t");
      if (!itemsF[i]) itemsF.push(nuevoItem());
      itemsF[i] = { sku: (c[0] || "").trim(), desc: (c[1] || "").trim(), cant: (c[2] || "").trim(), pu: (c[3] || "").trim() };
      i++;
    }
    renderItems();
  });
  $("#formC").addEventListener("submit", guardarCompra);
  ["input", "change"].forEach((ev) => { $("#qC").addEventListener(ev, renderCompras); $("#mC").addEventListener(ev, renderCompras); });
  $("#listC").addEventListener("click", (e) => { const b = e.target.closest("[data-openc]"); if (b) openCompra(b.dataset.openc); });
  renderCompras();
}
const nuevoItem = () => ({ sku: "", desc: "", cant: "", pu: "" });
function refreshLegajoSelect() {
  const sel = $("#cLeg"); if (!sel) return; const v = sel.value;
  sel.innerHTML = `<option value="">— Sin vincular —</option>` + S.legajos.slice(0, 200).map((l) => `<option value="${esc(l.id)}">${esc(fmtFecha(l.fecha))} · ${esc(TIPOS[l.tipo]?.corto || "")} · ${esc(l.proveedor || l.factura || "Sin proveedor")}</option>`).join("");
  sel.value = v;
}
function refreshSkuList() { const dl = $("#dlSkus"); if (dl) dl.innerHTML = S.skus.slice(0, 1500).map((s) => `<option value="${esc(s.sku)}">${esc(s.desc || "")}</option>`).join(""); }
function abrirFormCompra(legajo) {
  const f = $("#formC"); f.reset(); itemsF = [nuevoItem(), nuevoItem(), nuevoItem()];
  $("#cFecha").value = legajo?.fecha || hoy(); refreshLegajoSelect();
  if (legajo) { $("#cLeg").value = legajo.id; $("#cProv").value = legajo.proveedor || ""; $("#cFact").value = legajo.factura || ""; if (legajo.tipo !== "local") $("#cMon").value = "USD"; }
  $("#formCErr").hidden = true; renderItems(); f.hidden = false; $("#bNuevaC").hidden = true; $("#cProv").focus();
}
function renderItems() {
  $("#itemsBody").innerHTML = itemsF.map((it, i) => `<tr>
    <td><input type="text" class="mono" list="dlSkus" data-i="${i}" data-k="sku" value="${esc(it.sku)}" aria-label="SKU fila ${i + 1}"></td>
    <td><input type="text" data-i="${i}" data-k="desc" value="${esc(it.desc)}" aria-label="Descripción fila ${i + 1}"></td>
    <td><input type="text" inputmode="decimal" class="num" data-i="${i}" data-k="cant" value="${esc(it.cant)}" aria-label="Cantidad fila ${i + 1}"></td>
    <td><input type="text" inputmode="decimal" class="num" data-i="${i}" data-k="pu" value="${esc(it.pu)}" aria-label="Precio unitario fila ${i + 1}"></td>
    ${S.admin ? `<td class="num" id="sub-${i}">—</td>` : ""}
    <td><button type="button" class="btn small" data-rm="${i}" aria-label="Quitar fila">✕</button></td></tr>`).join("");
  totalesForm();
}
function totalesForm() {
  let u = 0, m = 0;
  itemsF.forEach((it, i) => { const c = parseNum(it.cant), p = parseNum(it.pu); u += c; m += c * p; const s = $("#sub-" + i); if (s) s.textContent = c && p ? fmtNum(c * p, 2) : "—"; });
  $("#totU").textContent = fmtNum(u, u % 1 ? 2 : 0); const tm = $("#totM"); if (tm) tm.textContent = fmtMon(m, $("#cMon").value);
}
async function guardarCompra(e) {
  e.preventDefault();
  const err = (t) => { $("#formCErr").textContent = t; $("#formCErr").hidden = !t; };
  const items = itemsF.map((it) => ({ sku: it.sku.trim(), desc: it.desc.trim(), cant: parseNum(it.cant), pu: parseNum(it.pu) })).filter((it) => it.sku || it.desc);
  if (!$("#cProv").value.trim()) return err("Completá el proveedor.");
  if (!items.length) return err("Agregá al menos un producto.");
  const sinCant = items.filter((it) => !it.cant); if (sinCant.length) return err(`Falta la cantidad en ${sinCant.length} fila${sinCant.length > 1 ? "s" : ""}.`);
  err(""); const b = $("#bGuardarC"); b.disabled = true;
  try {
    const id = doc(collection(db, "compras")).id; const f = firmar(); const fecha = $("#cFecha").value || hoy(); const moneda = $("#cMon").value;
    const unidades = items.reduce((a, it) => a + it.cant, 0);
    const total = items.reduce((a, it) => a + it.cant * it.pu, 0);
    const batch = writeBatch(db);
    batch.set(doc(db, "compras", id), {
      fecha, mes: mesDe(fecha), proveedor: $("#cProv").value.trim(), factura: $("#cFact").value.trim(), moneda,
      legajoId: $("#cLeg").value || null, notas: $("#cNotas").value.trim(),
      items: items.map(({ sku, desc, cant }) => ({ sku, desc, cant })), unidades,
      creadoPor: f.por, creadoPorNombre: f.porNombre, creadoEn: nowISO(),
    });
    batch.set(doc(db, "comprasMontos", id), {
      mes: mesDe(fecha), moneda, items: items.map((it) => ({ pu: it.pu, subtotal: +(it.cant * it.pu).toFixed(2) })),
      total: +total.toFixed(2), sinPrecio: items.filter((it) => !it.pu).length, creadoEn: nowISO(),
    });
    await batch.commit();
    $("#formC").hidden = true; $("#bNuevaC").hidden = false; $("#mC").value = mesDe(fecha); renderCompras();
  } catch (e2) { console.error(e2); err("No se pudo guardar la compra. Probá de nuevo."); }
  finally { b.disabled = false; }
}
function renderCompras() {
  const el = $("#listC"); if (!el) return;
  const q = $("#qC").value.trim().toLowerCase(), m = $("#mC").value;
  if (!S.loaded.compras) { el.innerHTML = `<div class="empty"><b>Cargando compras…</b></div>`; return; }
  const delMes = S.compras.filter((c) => !m || c.mes === m);
  const rows = delMes.filter((c) => !q || [c.proveedor, c.factura, ...(c.items || []).map((i) => i.sku + " " + i.desc)].join(" ").toLowerCase().includes(q));
  // resumen corto del mes
  const r = $("#cResumenMes");
  const unid = delMes.reduce((a, c) => a + (c.unidades || 0), 0);
  let tot = "";
  if (S.admin) {
    const pm = {}; delMes.forEach((c) => { const mm = S.montos[c.id]; if (mm) pm[mm.moneda] = (pm[mm.moneda] || 0) + mm.total; });
    tot = Object.entries(pm).map(([mon, v]) => `<div class="stat"><b>${fmtMon(v, mon)}</b><span>Total ${mon} · 🔒</span></div>`).join("");
  }
  r.innerHTML = delMes.length ? `<div class="stats"><div class="stat"><b>${delMes.length}</b><span>Compras ${m ? fmtMes(m) : ""}</span></div><div class="stat"><b>${fmtNum(unid)}</b><span>Unidades</span></div>${tot}</div>` : "";
  if (!S.compras.length) { el.innerHTML = `<div class="empty"><b>Todavía no hay compras cargadas</b><span>Tocá <b>+ Nueva compra</b> y cargá los productos con cantidad y precio. Podés pegar la tabla directo desde Excel.</span></div>`; return; }
  if (!rows.length) { el.innerHTML = `<div class="empty"><b>Sin compras en ${m ? fmtMes(m) : "este filtro"}</b><span>Cambiá el mes o borrá la búsqueda.</span></div>`; return; }
  el.innerHTML = rows.map((c) => {
    const mm = S.admin ? S.montos[c.id] : null; const leg = c.legajoId && S.legajos.find((l) => l.id === c.legajoId);
    return `<button type="button" class="card neutral" data-openc="${esc(c.id)}">
      <div class="row1"><span class="ttl">${esc(c.proveedor)}</span>${mm ? `<span class="mono" style="font-weight:600">${fmtMon(mm.total, mm.moneda)}</span>` : `<span class="chip type">${esc(c.moneda)}</span>`}</div>
      <div class="meta"><span>${fmtFecha(c.fecha)}</span>${c.factura ? `<span>Fact. <span class="mono">${esc(c.factura)}</span></span>` : ""}<span>${(c.items || []).length} ítem${(c.items || []).length === 1 ? "" : "s"} · ${fmtNum(c.unidades)} u.</span><span>Cargó ${esc(c.creadoPorNombre || "—")}</span>
      ${leg ? `<span class="chip info">Legajo ${esc(TIPOS[leg.tipo]?.corto || "")}</span>` : ""}${mm && mm.sinPrecio ? `<span class="chip warn">${mm.sinPrecio} sin precio</span>` : ""}</div></button>`;
  }).join("");
}
function openCompra(id) {
  const st = { confirmDel: false, edit: false, msg: "" };
  const draw = () => {
    const c = S.compras.find((x) => x.id === id); const sh = $("#sheet");
    if (!c) { sh.innerHTML = `<div class="hd"><h2>Compra eliminada</h2><button class="btn small" data-act="close">Cerrar</button></div>`; return; }
    const mm = S.admin ? S.montos[c.id] : null; const leg = c.legajoId && S.legajos.find((l) => l.id === c.legajoId);
    const rows = (c.items || []).map((it, i) => {
      const p = mm?.items?.[i];
      return `<tr><td class="sku">${esc(it.sku)}</td><td>${esc(it.desc)}</td><td class="num">${fmtNum(it.cant, it.cant % 1 ? 2 : 0)}</td>
      ${S.admin ? (st.edit ? `<td class="num"><input type="text" inputmode="decimal" class="num" data-pu="${i}" value="${p ? fmtNum(p.pu, 2) : ""}" style="max-width:120px"></td>` : `<td class="num">${p ? fmtNum(p.pu, 2) : "—"}</td>`) + `<td class="num">${p ? fmtNum(p.subtotal, 2) : "—"}</td>` : ""}</tr>`;
    }).join("");
    sh.innerHTML = `<div class="hd"><div style="min-width:0"><span class="chip type">${esc(c.moneda)}</span><h2>${esc(c.proveedor)}</h2></div><button class="btn small" data-act="close">Cerrar</button></div>
      <dl class="kv"><div><dt>Fecha</dt><dd>${fmtFecha(c.fecha)}</dd></div>${c.factura ? `<div><dt>Factura</dt><dd class="mono">${esc(c.factura)}</dd></div>` : ""}<div><dt>Unidades</dt><dd class="mono">${fmtNum(c.unidades)}</dd></div><div><dt>Cargó</dt><dd>${esc(c.creadoPorNombre || "—")} · ${fmtFH(c.creadoEn)}</dd></div>${leg ? `<div><dt>Legajo</dt><dd><a href="#" data-act="leg">${esc(TIPOS[leg.tipo]?.corto || "")} · ${esc(leg.proveedor || leg.factura || "")}</a></dd></div>` : ""}</dl>
      ${c.notas ? `<div style="white-space:pre-wrap">${esc(c.notas)}</div>` : ""}
      <div class="tablewrap"><table class="${S.admin ? "wide" : ""}"><thead><tr><th>SKU</th><th>Descripción</th><th class="num">Cant.</th>${S.admin ? '<th class="num">Precio unit.</th><th class="num">Subtotal</th>' : ""}</tr></thead><tbody>${rows}</tbody>
      ${S.admin && mm ? `<tfoot><tr><td colspan="4">Total</td><td class="num">${fmtMon(mm.total, mm.moneda)}</td></tr></tfoot>` : ""}</table></div>
      ${!S.admin ? `<div class="note lock">Los precios de esta compra solo los ve administración.</div>` : !mm ? `<div class="note err">Esta compra no tiene montos registrados.</div>` : ""}
      ${st.msg ? `<div class="note${st.msg.startsWith("!") ? " err" : ""}">${esc(st.msg.replace(/^!/, ""))}</div>` : ""}
      ${S.admin ? `<div class="bar">${st.edit ? `<button class="btn primary" data-act="savepu">Guardar precios</button><button class="btn" data-act="canceledit">Cancelar</button>` : `<button class="btn" data-act="edit">Editar precios</button>`}
        ${st.confirmDel ? `<span class="confirm">¿Eliminar esta compra? <button class="btn small danger" data-act="del-ok">Eliminar</button><button class="btn small" data-act="del-no">No</button></span>` : `<button class="btn small danger" data-act="del" style="margin-left:auto">Eliminar compra</button>`}</div>` : ""}`;
  };
  $("#sheet").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return; e.preventDefault(); const act = b.dataset.act;
    if (act === "close") return closeSheet();
    const c = S.compras.find((x) => x.id === id); if (!c) return;
    try {
      if (act === "leg") return openLegajo(c.legajoId);
      if (act === "edit") st.edit = true;
      else if (act === "canceledit") st.edit = false;
      else if (act === "savepu") {
        const items = (c.items || []).map((it, i) => { const pu = parseNum($(`[data-pu="${i}"]`).value); return { pu, subtotal: +(it.cant * pu).toFixed(2) }; });
        const total = +items.reduce((a, x) => a + x.subtotal, 0).toFixed(2);
        await setDoc(doc(db, "comprasMontos", c.id), { mes: c.mes, moneda: c.moneda, items, total, sinPrecio: items.filter((x) => !x.pu).length, editadoEn: nowISO(), creadoEn: S.montos[c.id]?.creadoEn || nowISO() });
        st.edit = false; st.msg = "Precios guardados.";
      } else if (act === "del") st.confirmDel = true;
      else if (act === "del-no") st.confirmDel = false;
      else if (act === "del-ok") { const bt = writeBatch(db); bt.delete(doc(db, "compras", c.id)); bt.delete(doc(db, "comprasMontos", c.id)); await bt.commit(); return closeSheet(); }
    } catch (err) { console.error(err); st.msg = "!No se pudo guardar el cambio."; }
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
      <label class="f">SKUs<textarea id="inSkus" class="mono" rows="4" placeholder="Uno por línea. Descripción opcional después de ; o tab:&#10;NVK-SILLA-ERG-01; Silla ergonómica negra&#10;NVK-MESA-ELV-120"></textarea>
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
    const m = $("#mR").value; const rows = [["Fecha", "Proveedor", "Factura", "Moneda", "SKU", "Descripcion", "Cantidad", "Precio unitario", "Subtotal", "Cargado por"]];
    S.compras.filter((c) => c.mes === m).forEach((c) => { const mm = S.montos[c.id]; (c.items || []).forEach((it, i) => rows.push([c.fecha, c.proveedor, c.factura, c.moneda, it.sku, it.desc, it.cant, mm?.items?.[i]?.pu ?? "", mm?.items?.[i]?.subtotal ?? "", c.creadoPorNombre])); });
    descargarCSV(`compras-${m}.csv`, rows);
  };
}
function renderResumen() {
  if (!S.admin || !$("#rStats") || $("#v-resumen").hidden) return;
  if (!S.loaded.compras || !S.loaded.montos) { $("#rStats").innerHTML = `<div class="empty"><b>Cargando…</b></div>`; return; }
  const m = $("#mR").value; const del = S.compras.filter((c) => c.mes === m);
  const tot = {}; let unid = 0, sinP = 0;
  del.forEach((c) => { unid += c.unidades || 0; const mm = S.montos[c.id]; if (mm) { tot[mm.moneda] = (tot[mm.moneda] || 0) + mm.total; sinP += mm.sinPrecio || 0; } });
  $("#rStats").innerHTML = `<div class="stats">
    ${["ARS", "USD"].map((mon) => `<div class="stat"><b>${fmtMon(tot[mon] || 0, mon)}</b><span>Total ${mon} · ${fmtMes(m)}</span></div>`).join("")}
    <div class="stat"><b>${del.length}</b><span>Compras</span></div><div class="stat"><b>${fmtNum(unid)}</b><span>Unidades compradas</span></div></div>
    ${sinP ? `<div class="note err" style="margin-top:10px">${sinP} ítem${sinP > 1 ? "s" : ""} de este mes no tienen precio cargado.</div>` : ""}`;
  // barras 12 meses
  const [y, mm0] = m.split("-").map(Number); const meses = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(y, mm0 - 1 - i, 1); meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
  const porMes = (mon) => meses.map((k) => S.compras.filter((c) => c.mes === k).reduce((a, c) => a + (S.montos[c.id]?.moneda === mon ? S.montos[c.id].total : 0), 0));
  $("#rBars").innerHTML = ["USD", "ARS"].map((mon) => {
    const v = porMes(mon); const max = Math.max(...v, 0); if (!max) return `<div class="hint">Sin compras en ${mon} en los últimos 12 meses.</div>`;
    return `<div style="display:grid;gap:6px"><b class="hint" style="font-weight:600">${mon}</b><div class="bars">${meses.map((k, i) => `<div class="b${k === m ? " cur" : ""}"><span class="mono">${fmtMes(k)}</span><span class="track"><span class="fill" style="display:block;width:${(v[i] / max) * 100}%"></span></span><span class="num">${v[i] ? fmtNum(v[i]) : "—"}</span></div>`).join("")}</div></div>`;
  }).join('<div class="sep" style="margin:10px 0"></div>');
  // proveedores
  const pv = {}; del.forEach((c) => { const k = c.proveedor || "—"; const mm = S.montos[c.id]; pv[k] ??= { n: 0, u: 0, ARS: 0, USD: 0 }; pv[k].n++; pv[k].u += c.unidades || 0; if (mm) pv[k][mm.moneda] += mm.total; });
  const pvs = Object.entries(pv).sort((a, b) => b[1].USD - a[1].USD || b[1].ARS - a[1].ARS);
  $("#rProv").innerHTML = pvs.length ? `<div class="tablewrap"><table><thead><tr><th>Proveedor</th><th class="num">Compras</th><th class="num">Unid.</th><th class="num">ARS</th><th class="num">USD</th></tr></thead><tbody>${pvs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${fmtNum(v.u)}</td><td class="num">${v.ARS ? fmtNum(v.ARS) : "—"}</td><td class="num">${v.USD ? fmtNum(v.USD) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="hint">Sin compras en ${fmtMes(m)}.</div>`;
  // SKUs
  const sk = {}; del.forEach((c) => { const mm = S.montos[c.id]; (c.items || []).forEach((it, i) => { const k = it.sku || it.desc || "—"; sk[k] ??= { desc: it.desc, u: 0, ARS: 0, USD: 0 }; sk[k].u += it.cant || 0; if (mm?.items?.[i]) sk[k][mm.moneda] += mm.items[i].subtotal || 0; }); });
  const sks = Object.entries(sk).sort((a, b) => b[1].u - a[1].u);
  $("#rSku").innerHTML = sks.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>SKU</th><th>Descripción</th><th class="num">Unidades</th><th class="num">Costo prom.</th><th class="num">ARS</th><th class="num">USD</th></tr></thead><tbody>${sks.map(([k, v]) => { const mon = v.USD ? "USD" : "ARS"; const cp = v.u ? (v.USD || v.ARS) / v.u : 0; return `<tr><td class="sku">${esc(k)}</td><td>${esc(v.desc || "")}</td><td class="num">${fmtNum(v.u)}</td><td class="num">${cp ? (mon === "USD" ? "US$ " : "$ ") + fmtNum(cp, 2) : "—"}</td><td class="num">${v.ARS ? fmtNum(v.ARS) : "—"}</td><td class="num">${v.USD ? fmtNum(v.USD) : "—"}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="hint">Sin productos comprados en ${fmtMes(m)}.</div>`;
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
