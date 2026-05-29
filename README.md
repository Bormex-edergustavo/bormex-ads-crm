# Ventas Ads

Dashboard local para registrar ventas de WhatsApp y atribuirlas a anuncios por numero de telefono.

## Abrir

Para usar la conexion automatica, ejecuta:

```bash
node server.mjs
```

Luego abre `http://127.0.0.1:4173`. La captura manual de ventas se guarda en el navegador; leads y anuncios automaticos se guardan en `data/db.json`.

## Flujo actual

1. Los leads deben entrar automaticamente desde WhatsApp Cloud API.
2. Los anuncios y el gasto deben entrar automaticamente desde Meta Marketing API.
3. Cuando el vendedor cierre una venta, captura numero, productos vendidos y monto.
4. El panel cruza la venta contra los leads por numero normalizado y calcula CPA, ROAS y recomendaciones.

## Siguiente etapa

Para activar la deteccion automatica faltan credenciales y configuracion de Meta:

- Meta Marketing API para traer gasto, campanas, conjuntos y anuncios.
- WhatsApp Cloud API para guardar automaticamente el lead y el anuncio de origen.
- Meta Conversions API para enviar eventos de venta y ayudar a optimizar campañas por ventas reales.
