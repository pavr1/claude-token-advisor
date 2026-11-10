# Guion para grabar el video de la demo

Duración objetivo: **5 a 6 minutos**, sin contar la espera del ping (escena 7, opcional). Todo se graba desde la herramienta real con **dos repos a la vez**, cada uno en su ventana de VS Code.
Cada escena dice **Hacer** (los pasos exactos) y **Esperar** (lo que debe verse). Si algo no se ve como dice, ese es el problema a resolver antes de seguir grabando. Guardar el resultado como `demo/video/demo.mp4` y dejar una copia local (no depender de un enlace).

Este guion es para el **video**. El de la demo en vivo está en `demo/script/guion-demo.md`.

---

## 0. Preparación (hacerlo antes de darle a grabar)

1. **Instalar la última versión y recargar TODAS las ventanas.** La ventana que posee el proxy sigue ejecutando el código viejo hasta que se recarga (`Ctrl+Shift+P` → **Developer: Reload Window**, en cada una). En el log de la extensión (Output → *Claude Token Improver*) aparece `extension X was installed from another window; this one still runs Y` cuando una ventana se quedó atrás.
2. **Dos repos, dos ventanas.**
   - Ventana A: repo A (por ejemplo `claude-budget-advisor`).
   - Ventana B: repo B, otro proyecto. Si es `core-banking`, decidir antes si se anonimiza: el nombre aparece en el filtro de Repo y bajo cada fila.
   - La primera ventana que arranca el proxy lo posee; la segunda se une a él. Las dos escriben en el mismo ledger y el dashboard muestra los dos repos.
3. **Terminales nuevos, abiertos después de que arranque la extensión.** La extensión solo pone `ANTHROPIC_BASE_URL` en terminales nuevos; un `claude` abierto antes corre sin proxy. En cada ventana abra un terminal nuevo y compruebe que apunta al proxy:
   - PowerShell: `echo $env:ANTHROPIC_BASE_URL` debe mostrar `http://127.0.0.1:4000/w/<nombre-del-repo>`.
4. **Caché caliente.** Uno o dos minutos antes de grabar, haga una pregunta corta en cada repo (`claude` → "hola"). Si la primera petición del video cae en caché fría, escribe todo el contexto y sale cara (CW grande y rojo). Es real, pero distrae.
5. **Que la PC no se suspenda.** Con su plan de energía se suspende a los 10 minutos sin tocar teclado ni ratón (3 con batería). Conectar a la corriente y mover el ratón entre escenas.
6. **Pantalla:** zoom de VS Code al 125 %, cerrar notificaciones y paneles que no se usan, grabar en 1080p, micrófono probado.
7. **Prompts listos** en un archivo de notas. Cortos y baratos:
   - Repo A: `Explica qué hace src/proxy/keepAlive.ts en tres frases.`
   - Repo B: `Resume en cuatro líneas la estructura de carpetas de este proyecto.`
8. **Rango del dashboard en "Today"** para ver solo lo de la grabación (o "Last 7 days" si hoy está vacío).

---

## Escenas

### 1. Abrir el dashboard (0:00 – 0:30)
**Hacer:** en la ventana A, `Ctrl+Shift+P` → **Claude: Show Dashboard (Token Improver tab)**.
**Esperar:**
- Una pantalla de carga con el título *Welcome to Claude Budget Advisor*, un icono animado y el texto *Loading data…*.
- En pocos segundos aparece el panel: la cabecera con dos gráficas de tendencia (*Today · all repos* y *This month · all repos*) y debajo la tabla **Turns**.
- En una cuenta Enterprise solo existe la pestaña *Token Improver* (la de Budget se oculta).

**Decir:** el proxy ya está corriendo; quien trabaja solo usa Claude Code como siempre.

### 2. La cifra de ahorro y la tabla (0:30 – 1:15)
**Hacer:** señalar con el ratón la cifra de ahorro de la cabecera, las dos tendencias y los encabezados de la tabla. Pasar el ratón por un `?` de un encabezado.
**Esperar:**
- Los encabezados, de izquierda a derecha: Date, Repo, Status, Turns, Hits, Raw request, Cleanup, Summarized, Estimate, Received, CR, CW, RI, Billed. Los `?` son blancos sobre el encabezado amarillo.
- Un tooltip con la explicación de cada columna.
- La fila de totales fija bajo los encabezados (se queda visible al hacer scroll).

**Decir:** la tabla va de lo que Claude Code quería enviar (Raw) a lo que Anthropic cobró (Billed), en el mismo orden del diagrama.

### 3. Dos repos a la vez, en vivo (1:15 – 3:15)
**Hacer:**
1. Ventana A, terminal: `claude` → pegar el prompt A → Enter.
2. Sin esperar, ventana B, terminal: `claude` → pegar el prompt B → Enter.
3. Volver al dashboard (en cualquiera de las dos ventanas).

**Esperar:**
- **Dos filas nuevas arriba**, una por repo. Cada Enter es una fila. Cada fila tiene su repo y, debajo, una etiqueta `chat xxxx`.
- En la columna **Status**, el icono animado de "Processing". En la barra de estado, el contador de peticiones en vuelo.
- Cuando el proxy ya conoce el tamaño optimizado, una **flecha azul viaja** en la columna de la flecha hasta que Anthropic responde. Mientras, se llenan Raw, Cleanup, Summarized y Estimate.
- Al terminar, el icono pasa a ✔ y se llenan Received, CR / CW / RI y Billed. **Hits** crece si Claude usa herramientas: son más peticiones dentro de la misma fila.
- Si el prompt es corto, Summarized puede mostrar un punto (·): no hizo falta resumir. Eso es normal.

**Decir:** son dos repos distintos, cada uno con su fila, todo a la vez.

### 4. Abrir una fila (3:15 – 4:15)
**Hacer:** en la fila del repo A, clic en la flecha ▸ de la columna Date. Pasar el ratón por Summarized y por las celdas CR, CW y RI.
**Esperar:**
- Debajo aparece una sub-fila por hit (`↳ hit 1`, `↳ hit 2`…), cada una con sus propios números. La suma de los hits es la fila.
- **Colores de CR / CW / RI** (se juzgan aparte para tokens `t` y para unidades `u`):
  - **Verde:** lo leído de la caché supera a lo escrito.
  - **Rojo:** se escribió más de lo que se leyó (una escritura cara).
  - **Ámbar** (solo en la fila del turn): el turn tiene hits rojos y verdes. Ver cuál es el rojo abriendo la fila.
- En Summarized: `✓ new` (resumen nuevo con Haiku), `↻ reused` (resumen guardado) o `·` (ninguno), con el motivo en el tooltip.

### 5. Filtrar por repo (4:15 – 4:45)
**Hacer:** en el encabezado, cambiar **Repo** al repo A, luego al B, luego a *All repos*. Probar **Status** → *Processing* / *Done*.
**Esperar:** la tabla, los totales y las gráficas siguen el filtro. Con un repo seleccionado solo quedan sus filas.

### 6. Comprobar un número (4:45 – 5:30)
**Hacer:** pasar el ratón por la cifra de ahorro de la cabecera, y luego por **Raw**, **Sent**, **Received** y **Billed** de una fila.
**Esperar:**
- La cifra de ahorro abre una fórmula: `Saving = 1 − Billed ÷ Without proxy`, con el desglose de Billed y de "Sin proxy".
- Cada columna muestra su aritmética con cifras completas, por ejemplo `Received = RI + CW + CR`.

**Decir:** lo facturado sale de lo que Anthropic reporta; "sin proxy" es una estimación y el panel lo dice.

### 7. (Opcional) El ping del keep-alive (≈ 5 min de espera)
**Hacer:** dejar los dos terminales sin tocar unos 5 minutos, con la PC conectada y sin suspenderse.
**Esperar:**
- Pasados unos 4,5 minutos desde la última petición de un chat aparece una **fila aparte**, marcada `keep-alive ping`, con un punto con halo en la columna Status, 1 turn y 1 hit. No se mezcla con ningún Enter.
- Lee casi todo de la caché (CR alto, CW cero) y cuesta poco.
- Si la PC se suspende, el ping **no** sale (por diseño: la caché ya habría vencido).

**Para el video:** grabar la espera aparte y cortarla al editar.

### Cierre (5:30 – 5:50)
**Hacer:** volver a la parte superior del panel (totales y gráficas).
**Decir:** el proxy trabaja solo y el panel permite revisar cada petición y cada cifra; vuelvo a las diapositivas para el impacto.

---

## Si algo falla durante la grabación
| Problema | Qué hacer |
|---|---|
| No aparece la fila de un repo | Ese terminal se abrió antes de la extensión y no usa el proxy: abrir uno nuevo y repetir (`echo $env:ANTHROPIC_BASE_URL`). |
| Una ventana se comporta distinto | Está con una versión vieja: recargar la ventana. |
| La primera petición sale con CW grande y rojo | Caché fría: esperar a que suba la segunda, o repetir la toma tras "calentarla" (paso 0.4). |
| El panel sale vacío | Cambiar el rango a *Last 7 days*. |
| Aparece el nombre de un repo que no debe verse | Parar, cambiar de repo o anonimizar, y repetir la toma. |

## Qué no debe verse en el video
- Nombres de repos privados o de clientes.
- Claves, tokens o el contenido de los prompts de trabajo real: usar los prompts de prueba de arriba.
