# UnifiedReporting
Cross-Platform Abuse Reporting and Reputation Database. WA-TG-ETC

Base de reportes federada por LID/ID, pensada para bots de WhatsApp (y a futuro otras plataformas).

## Cómo funciona
`reportados.db` (SQLite) vive como asset de la Release. Un workflow actualiza los reportes cada hora, procesa los issues abiertos con título `[report] sync`, valida y actualiza ese archivo. Cada bot comprueba actualizacion cada hora, y avisa cuando alguien reportado escribe o pide entrar a un grupo. Nunca rechaza ni expulsa solo, eso lo decide el admin.

## Reportar
`.report <emoji>` citando un mensaje, o `.report +numero <emoji>` sin citar. Una sola vez hace falta `.report login <token>` con un token de GitHub propio (scope mínimo, necesario solo permiso lectura y escritura de Issue).

## Instalar plugins de investigación (opcional)
Son solo informativos, nunca bloquean la aprobación automática. Copiar lo que necesites desde [`plugins/`](https://github.com/weskerty/UnifiedReporting/tree/main/plugins) a `media/report/plugins/` en el bot. Ver `plugins/README.md` para entender cada uno.

# [LevanterBOT ↗️](https://levanter.site/)
necesita este plugin: https://gist.github.com/weskerty/fa4dec51ffb404a82f246e42a837af4d

## Categorias

`🧸` [pdf](https://es.wikipedia.org/wiki/Pederastia)

`🧃` [VendePatria]()

`⚡` [nazi](https://es.wikipedia.org/wiki/Nazismo)

`📩` [spamer](https://es.wikipedia.org/wiki/Wikipedia:Spam) o AcosadorAlPrivado

`🎰` CryptoEstafa, Ruleta o Spamer Juegos Azar

