# Bormex Ads CRM

Dashboard para registrar ventas de WhatsApp y atribuirlas a anuncios por numero de telefono.

## Produccion

- Panel publico: https://bormex-edergustavo.github.io/bormex-ads-crm/
- Backend Supabase Edge Function: https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm
- El panel pide solo un codigo. En produccion se configura con `PANEL_PASSWORD`.
- La sincronizacion de Meta Ads corre cada 15 minutos con `pg_cron` en Supabase.
- Las ventas, leads, mensajes, anuncios y gasto se guardan en tablas `bormex_*` dentro de Supabase.

## Desarrollo local

Para abrirlo en la Mac:

```bash
npm run check
npm run build:static
node server.mjs
```

Luego abre `http://127.0.0.1:4173`.

## Flujo

1. Los leads deben entrar automaticamente desde WhatsApp Cloud API.
2. Los anuncios y el gasto deben entrar automaticamente desde Meta Marketing API.
3. Cuando el vendedor cierre una venta, captura numero, productos vendidos y monto.
4. El panel cruza la venta contra los leads por numero normalizado y calcula CPA, ROAS y recomendaciones.

## Variables principales

- `META_ACCESS_TOKEN`: token con permisos de lectura/administracion de anuncios.
- `META_AD_ACCOUNT_ID`: cuenta publicitaria, por ejemplo `act_...`.
- `WHATSAPP_VERIFY_TOKEN`: token privado para verificar el webhook de Meta.
- `WHATSAPP_PHONE_NUMBER_ID`: numero de WhatsApp Business Platform.
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: cuenta de WhatsApp Business.
- `PANEL_PASSWORD`: codigo del panel.
- `CRON_SECRET`: secreto privado que protege la ruta programada `/api/cron/sync`.

## Pendiente pro

- Reemplazar el token temporal de Graph Explorer por un token permanente de System User en Meta Business Manager.
- Activar Conversions API cuando ya haya volumen suficiente de ventas registradas.
