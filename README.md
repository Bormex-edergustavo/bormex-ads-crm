# Bormex Ads CRM

Dashboard para registrar ventas de WhatsApp y atribuirlas a anuncios por numero de telefono.

## Produccion

- Panel publico: https://bormex-edergustavo.github.io/bormex-ads-crm/
- Backend Supabase Edge Function: https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm
- Webhook WhatsApp: https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm/webhooks/whatsapp
- Webhook Messenger/Instagram: https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm/webhooks/meta
- Token extra para proveedores COEX: `POST /api/meta/webhook-token` guarda un verify token adicional en `bormex_settings` para que un Tech Provider como Dualhook pueda verificar el webhook sin exponer secretos en el repo.
- El panel pide un codigo configurado en los secretos del backend.
- La sincronizacion de Meta Ads corre cada 15 minutos con `pg_cron` en Supabase.
- Las ventas, leads, mensajes, anuncios y gasto se guardan en tablas `bormex_*` dentro de Supabase.

## Desarrollo local

## Fotos, videos y bandejas de Meta (28-oct-2026)

El formulario admite archivos del dispositivo en WhatsApp, Messenger e Instagram.
Los originales enviados se conservan en el bucket privado `bormex-crm-media`,
que se prepara en la primera subida. El acceso desde la conversación exige el
código del CRM; Meta recibe un enlace temporal de una hora para enviar adjuntos.
Las descargas admiten Range para reproducir videos. Los enlaces de archivos
recibidos por Messenger/Instagram se actualizan con Meta si han vencido.

El botón **Cargar Messenger e Instagram** importa una página de 15 conversaciones,
hasta 100 mensajes por conversación. Ofrece continuar cuando hay más páginas y
avisa cuando una conversación tiene más historial en Meta. No representa una
recuperación completa de todos los mensajes históricos. El filtro de canal
consulta el servidor para incluir conversaciones fuera de las 300 más recientes.

Para habilitar canales se necesitan los casos de uso correspondientes en Meta,
el webhook `/webhooks/meta`, su suscripción y los permisos aprobados de la página
y cuenta. Configure `MESSENGER_PAGE_ID`, `MESSENGER_PAGE_ACCESS_TOKEN`,
`INSTAGRAM_ACCOUNT_ID` y `INSTAGRAM_ACCESS_TOKEN` en el servidor. Para Instagram
con Facebook Login, configure también la página vinculada. Solo para tokens de
Instagram Login configure `INSTAGRAM_LOGIN_MODE=instagram`. No se selecciona una
página ajena automáticamente. El token de anuncios no acredita acceso a mensajes.

Para tokens de WhatsApp que exigen `appsecret_proof`, configure el secreto de
la misma app en `WHATSAPP_SEND_APP_SECRET`. La prueba de envío queda separada
del secreto global de firmas y del par de lectura de archivos. No activar
`META_APP_SECRET` para resolver el envío: puede bloquear webhooks de otro emisor.

Validación: `npm test`. Las pruebas simulan Meta y Storage; no envían mensajes
a clientes. La función del servidor es la implementación productiva de Supabase.

### Servidor local

Para abrirlo en la Mac:

```bash
npm run check
npm run build:static
node server.mjs
```

Luego abre `http://127.0.0.1:4173`.

## Flujo

1. Los leads deben entrar automaticamente desde WhatsApp Cloud API en modo Coexistence cuando se use el mismo numero de WhatsApp Business App.
2. Los anuncios y el gasto deben entrar automaticamente desde Meta Marketing API.
3. Messenger e Instagram entran por el webhook general de Meta y el CRM responde con los identificadores PSID/IGSID.
4. Cuando el vendedor cierre una venta, captura numero, productos vendidos y monto.
5. El panel cruza la venta contra los leads por numero normalizado y calcula CPA, ROAS y recomendaciones.

## WhatsApp mixto sin desconectar app/web

Para conservar WhatsApp Business App y WhatsApp Web, no registres el numero con el alta normal de Cloud API. Usa el flujo oficial de Coexistence (`whatsapp_business_app_onboarding`) y suscribe tambien los campos `history`, `smb_app_state_sync` y `smb_message_echoes`. El CRM ya procesa esos eventos para reflejar mensajes enviados desde la app.

Despues de completar Coexistence, ejecuta `POST /api/meta/coexistence/sync` desde el panel Ads o presiona **Revisar Meta**. Esa ruta llama a `/<WHATSAPP_PHONE_NUMBER_ID>/smb_app_data` con `sync_type=smb_app_state_sync` y `sync_type=history`; el backend guarda el ultimo intento para evitar repetir una sincronizacion que Meta documenta como de una sola vez.

## Variables principales

- `META_ADS_ACCESS_TOKEN`: token permanente con permisos de lectura/administracion de anuncios.
- `WHATSAPP_ACCESS_TOKEN`: token permanente con permisos de WhatsApp Business Platform para mensajes/webhooks.
- `META_PAGE_ACCESS_TOKEN`: token de pagina opcional para Messenger/Instagram si se comparte.
- `MESSENGER_PAGE_ACCESS_TOKEN`: token de pagina con permiso `pages_messaging`.
- `MESSENGER_PAGE_ID`: pagina de Facebook conectada a Messenger.
- `INSTAGRAM_ACCESS_TOKEN`: token de cuenta profesional de Instagram con permiso de mensajes.
- `INSTAGRAM_ACCOUNT_ID`: cuenta profesional de Instagram que recibe/responde DMs.
- `META_ACCESS_TOKEN`: token heredado opcional; se usa como respaldo si no existen los dos tokens separados.
- `META_APP_ID`: app de Meta usada para abrir el flujo de Coexistence.
- `META_EMBEDDED_SIGNUP_CONFIG_ID`: configuracion de Facebook Login for Business para `whatsapp_business_app_onboarding`.
- `META_AD_ACCOUNT_ID`: cuenta publicitaria, por ejemplo `act_...`.
- `META_WEBHOOK_VERIFY_TOKEN`: token privado opcional para verificar webhooks de Meta; si no existe usa `WHATSAPP_VERIFY_TOKEN`.
- `META_APP_SECRET`: secreto de la app de Meta para validar `X-Hub-Signature-256` en webhooks entrantes.
- `WHATSAPP_VERIFY_TOKEN`: token privado para verificar el webhook de Meta.
- `WHATSAPP_PHONE_NUMBER_ID`: numero de WhatsApp Business Platform.
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: cuenta de WhatsApp Business.
- `PANEL_PASSWORD`: codigo del panel.
- `SALES_PANEL_PASSWORD`: codigo opcional para el acceso de ventas; si no existe usa `1234`.
- `CRON_SECRET`: secreto privado que protege la ruta programada `/api/cron/sync`.

## Pendiente pro

- Reemplazar el token temporal de Graph Explorer por un token permanente de System User en Meta Business Manager.
- Activar Conversions API cuando ya haya volumen suficiente de ventas registradas.
