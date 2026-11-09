# UnifiedReporting
Cross-Platform Abuse Reporting and Reputation Database. WA-TG-ETC

Base de reportes federada por LID/ID, pensada para bots de WhatsApp (y a futuro otras plataformas).

## Cómo funciona
`reportados.db` (SQLite) vive como asset de la Release con tag `data`, no en el repo git. Un workflow (`report-sync.yml`) corre cada hora, procesa los issues abiertos con título `[report] sync`, valida y actualiza ese archivo. Cada bot lo descarga cada hora (ETag + verificación de hash), y avisa cuando alguien reportado escribe o pide entrar a un grupo — nunca rechaza ni expulsa solo, eso lo decide el admin.

## Reportar
`.report <emoji>` citando un mensaje, o `.report +numero <emoji>` sin citar. Una sola vez hace falta `.report login <token>` con un token de GitHub propio (scope mínimo, solo para abrir issues).

## Instalar plugins de investigación (opcionales)
Son solo informativos, nunca bloquean la aprobación automática. Copiar el `.js` o `.bundled.js` desde `plugins/` a `media/report/plugins/` en el bot — ver `plugins/README.md` para notas de cada uno.

Levanter necesita este plugin: https://gist.github.com/weskerty/fa4dec51ffb404a82f246e42a837af4d
