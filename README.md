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

## Bandeja con distribución de WhatsApp Web (28-oct-2026)

La sección CRM ocupa la ventana: lista de chats y filtros a la izquierda,
conversación al centro y respuesta fija abajo. En pantallas pequeñas se alternan
lista y conversación con la flecha de regreso. El encabezado del contacto abre
su panel de nombre, etiquetas, anuncio de origen y registro de venta.
El menú de Chats conserva la carga de Messenger/Instagram, la exportación según
el rol y la salida. El botón + del mensaje abre archivos y el acceso a WhatsApp;
los límites y las rutas de envío se mantienen. Las marcas de entrega/lectura se
muestran únicamente cuando el estado guardado de Meta las acredita.

## Videos grandes y nombres de WhatsApp (28-oct-2026)

Al seleccionar un video de WhatsApp de más de 16 MiB (hasta 100 MiB), el CRM
prepara una copia MP4 H.264/AAC en el dispositivo, antes de la subida. Conserva
el original, muestra progreso, permite cancelar y ofrece guardar la copia.
La herramienta se descarga sólo cuando hace falta. Los adjuntos de más de 2 MiB
y hasta 50 MiB se suben en partes privadas de 1 MiB, con progreso y reintentos.
El servidor comprueba todas las partes antes de aceptar el archivo, elimina las
partes temporales y reutiliza el resultado de una finalización ya completada al reintentar. Para reconstruir sus archivos:
`npm ci && npm run build:video && npm run build:static`.
Las licencias y los enlaces al código fuente están en `vendor/`.

El receptor admite el formato oficial `state_sync[].contact` y distingue el nombre
de la agenda comercial del perfil público. Los mensajes numéricos o ecos no
reemplazan el nombre guardado. Los cambios de contacto no alteran la última
actividad, las etiquetas ni los no leídos. La recepción real de esos eventos
depende de la conexión Coexistence; no se da por probada por las pruebas locales.

La conexión oficial no sincroniza las etiquetas/listas ni los grupos existentes
de la app WhatsApp Business. No se copiaron listas manualmente. Se mantiene la API oficial por instrucción del propietario; no se activa
un conector de sesión alternativo.
Referencia: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users

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
El webhook acepta únicamente el ID comercial configurado para cada canal;
ignora eventos de otras páginas o cuentas, aunque tengan acceso a la app.

Para tokens de WhatsApp que exigen `appsecret_proof`, configure el secreto de
la misma app en `WHATSAPP_SEND_APP_SECRET`. La prueba de envío queda separada
del secreto global de firmas y del par de lectura de archivos. No activar
`META_APP_SECRET` para resolver el envío: puede bloquear webhooks de otro emisor.
Si el propietario selecciona expresamente el par de medios ya verificado,
`WHATSAPP_SEND_CREDENTIALS_SOURCE=paired_media` usa conjuntamente
`WHATSAPP_MEDIA_ACCESS_TOKEN` y `WHATSAPP_MEDIA_APP_SECRET`; falla si falta uno.
Para Messenger/Instagram, use `MESSENGER_APP_SECRET`/`INSTAGRAM_APP_SECRET`.
Solo si sus tokens pertenecen a la misma app del par de medios verificado,
`META_MESSAGING_APP_SECRET_SOURCE=paired_whatsapp_media` permite reutilizar
ese secreto para sus pruebas. La firma global del webhook sigue independiente.

`GET /api/meta/credentials/status` permite al administrador comprobar vigencia,
app emisora, permisos e identidad comercial sin devolver las credenciales.
La comprobación de las credenciales existentes se hace con la identidad ya
verificada de la app; nunca se elige otra credencial automáticamente por tener
un permiso en su lista. Cada envío incluye `messaging_account_id` con el
`WHATSAPP_BUSINESS_ACCOUNT_ID` configurado para resolver expresamente la cuenta
de Bormex, según la [referencia de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/messaging/).
El rechazo `100/33` indica que la credencial no pudo acceder al objeto emisor;
se presenta como un problema de acceso y conserva el borrador.

Cuando el número ya está conectado mediante Dualhook, el servidor también admite
su [Runtime API oficial](https://dualhook.com/docs/runtime-api-reference).
Este transporte permanece desactivado hasta configurar
`WHATSAPP_SEND_TRANSPORT=dualhook` y `DUALHOOK_RUNTIME_API_KEY` en los secretos del
servidor. La clave debe pertenecer a la conexión del mismo número y WABA; no
sirve un token de Meta. No crear otra cuenta ni volver a dar de alta el número
para resolver un fallo de permisos.

El transporte usa exclusivamente `api.dualhook.com/v25.0` para enviar, subir y
descargar archivos; Dualhook aporta internamente su token y prueba de Meta.
La clave nunca se manda a Graph, a un enlace de medios ni al navegador. Los
archivos guardados con la app anterior se envían mediante un enlace temporal
del almacenamiento privado, en lugar de reutilizar su ID entre aplicaciones.
Si falta la clave, el envío falla sin cambiar automáticamente a otro token.
La recepción conserva sus webhooks actuales. Una respuesta de envío con ID
confirma aceptación; comprobar también el estado de entrega antes de declarar
reparada una prueba real.

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
