# Depósito NIVIKO

App interna para depósito y oficina:

- **Documentación**: legajos de ingreso (compra local, courier internacional, contenedor) con sus PDF y fotos. La oficina los marca como recibidos.
- **Compras**: tabla de productos (SKU, cantidad, precio unitario) por compra, vinculable a un legajo. Los empleados cargan precios pero **no pueden leerlos**: los montos viven en una colección aparte que solo administración puede leer.
- **SKUs ML**: lista de SKUs a publicar en Mercado Libre con tilde de "cargado en sistema".
- **Resumen** (solo admin): totales del mes en ARS y USD, últimos 12 meses, por proveedor y stock comprado por SKU. Exporta CSV.
- **Usuarios** (solo admin): alta de empleados con email y clave, rol empleado/admin, desactivar.

Stack: Vite + Firebase (Auth, Firestore, Storage), deploy en Vercel.

## Seguridad

La privacidad de los montos la hacen cumplir las **reglas de Firestore** (`firestore.rules`), no la interfaz:

| Colección | Empleado | Admin |
|---|---|---|
| `legajos`, `skus` | leer, crear, editar | todo |
| `compras` (sin precios) | leer, crear | todo |
| `comprasMontos` (precios y totales) | **solo crear** | todo |
| `usuarios` | leer su propio perfil | todo |

El administrador principal es el email definido en las reglas (`alexgoldenstein@hotmail.com`). Cualquier cuenta sin perfil activo en `usuarios` no puede leer nada.

## Puesta en marcha

1. Firebase: proyecto con Authentication (email/contraseña), Firestore y Storage.
2. Authentication › Usuarios › **Agregar usuario** con el email del admin principal (hacerlo primero).
3. Firestore › Reglas: pegar `firestore.rules` y **Publicar**.
4. Storage › Reglas: pegar `storage.rules` y **Publicar** (aceptar el permiso para leer Firestore).
5. Variables de entorno (ver `.env.example`) en Vercel → Redeploy.
6. Authentication › Configuración › Dominios autorizados: agregar el dominio de Vercel.

## Desarrollo local

```bash
cp .env.example .env.local   # completar
npm install
npm run dev
```
